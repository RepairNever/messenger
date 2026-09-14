import axios, { AxiosError } from 'axios'
import { resolveApiBaseUrl } from '@/services/runtime/backendEndpoint'
import { storage } from '@/services/storage/storageAdapter'
import { AUTH_REQUEST_TIMEOUT_MS } from './timeouts'
import {
  clearAccessToken,
  clearRefreshToken,
  getAccessToken,
  getRefreshToken,
  setAccessToken,
  setRefreshToken,
} from '@/services/storage/tokenStorage'

export interface RefreshedSessionTokens {
  accessToken: string
  refreshToken: string
}

type RefreshLockCallback<T> = () => Promise<T>

type LockManagerLike = {
  request<T>(name: string, callback: RefreshLockCallback<T>): Promise<T>
}

interface RefreshLeaseRecord {
  ownerId: string
  expiresAt: number
}

const REFRESH_LOCK_NAME = 'msgnr:auth-refresh'
const REFRESH_LEASE_KEY = 'msgnr:auth-refresh:lease'
const REFRESH_LEASE_MS = 4_000
const REFRESH_LEASE_RENEW_MS = 1_000
const REFRESH_LEASE_RETRY_MS = 50

function getLockManagerOrNull(): LockManagerLike | null {
  const navigatorWithLocks = globalThis.navigator as Navigator & { locks?: LockManagerLike }
  if (!navigatorWithLocks?.locks || typeof navigatorWithLocks.locks.request !== 'function') {
    return null
  }
  return navigatorWithLocks.locks
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms)
  })
}

function generateLeaseOwnerId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return `${Date.now()}:${Math.random().toString(36).slice(2)}`
}

function readRefreshLease(): RefreshLeaseRecord | null {
  const raw = storage.getItem(REFRESH_LEASE_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<RefreshLeaseRecord>
    if (
      typeof parsed.ownerId !== 'string'
      || typeof parsed.expiresAt !== 'number'
      || !Number.isFinite(parsed.expiresAt)
    ) {
      return null
    }
    return {
      ownerId: parsed.ownerId,
      expiresAt: parsed.expiresAt,
    }
  } catch {
    return null
  }
}

function writeRefreshLease(lease: RefreshLeaseRecord): void {
  storage.setItem(REFRESH_LEASE_KEY, JSON.stringify(lease))
}

function releaseRefreshLease(ownerId: string): void {
  const current = readRefreshLease()
  if (!current || current.ownerId !== ownerId) return
  storage.removeItem(REFRESH_LEASE_KEY)
}

function tryAcquireRefreshLease(ownerId: string): boolean {
  const now = Date.now()
  const current = readRefreshLease()
  if (current && current.ownerId !== ownerId && current.expiresAt > now) {
    return false
  }

  writeRefreshLease({
    ownerId,
    expiresAt: now + REFRESH_LEASE_MS,
  })

  return readRefreshLease()?.ownerId === ownerId
}

function renewRefreshLease(ownerId: string): void {
  const current = readRefreshLease()
  if (!current || current.ownerId !== ownerId) return
  writeRefreshLease({
    ownerId,
    expiresAt: Date.now() + REFRESH_LEASE_MS,
  })
}

async function runWithRefreshLease<T>(callback: RefreshLockCallback<T>): Promise<T> {
  const ownerId = generateLeaseOwnerId()

  while (!tryAcquireRefreshLease(ownerId)) {
    await delay(REFRESH_LEASE_RETRY_MS)
  }

  const renewTimer = globalThis.setInterval(() => {
    renewRefreshLease(ownerId)
  }, REFRESH_LEASE_RENEW_MS)

  try {
    return await callback()
  } finally {
    globalThis.clearInterval(renewTimer)
    releaseRefreshLease(ownerId)
  }
}

async function runWithCrossTabRefreshLock<T>(callback: RefreshLockCallback<T>): Promise<T> {
  const lockManager = getLockManagerOrNull()
  if (lockManager) {
    return lockManager.request(REFRESH_LOCK_NAME, callback)
  }
  return runWithRefreshLease(callback)
}

function clearSharedSessionTokens(): void {
  clearAccessToken()
  clearRefreshToken()
}

function readStoredSessionTokens(): RefreshedSessionTokens | null {
  const accessToken = getAccessToken()
  const refreshToken = getRefreshToken()
  if (!accessToken || !refreshToken) {
    return null
  }
  return {
    accessToken,
    refreshToken,
  }
}

function readRotatedSharedSessionTokens(
  previousRefreshToken: string | null,
  previousAccessToken: string | null,
): RefreshedSessionTokens | null {
  const stored = readStoredSessionTokens()
  if (!stored) return null
  if (!previousRefreshToken || stored.refreshToken === previousRefreshToken) {
    return null
  }
  if (!previousAccessToken || stored.accessToken === previousAccessToken) {
    return null
  }
  return stored
}

function hasRejectedRefreshStatus(error: unknown): boolean {
  if (error instanceof AxiosError) {
    return error.response?.status === 401 || error.response?.status === 403
  }
  if (
    typeof error === 'object'
    && error !== null
    && 'status' in error
    && typeof (error as { status?: unknown }).status === 'number'
  ) {
    const status = (error as { status: number }).status
    return status === 401 || status === 403
  }
  return false
}

async function requestRefresh(refreshToken: string): Promise<RefreshedSessionTokens | null> {
  const { data } = await axios.post<{
    access_token?: string
    refresh_token?: string
  }>('/api/auth/refresh', {
    refresh_token: refreshToken,
  }, {
    baseURL: resolveApiBaseUrl(),
    timeout: AUTH_REQUEST_TIMEOUT_MS,
  })

  if (!data?.access_token || !data?.refresh_token) {
    return null
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
  }
}

export async function refreshSharedSessionTokens(
  request: ((refreshToken: string) => Promise<RefreshedSessionTokens | null>) = requestRefresh,
): Promise<RefreshedSessionTokens | null> {
  const startingRefreshToken = getRefreshToken()
  const startingAccessToken = getAccessToken()
  if (!startingRefreshToken) {
    clearSharedSessionTokens()
    return null
  }

  return runWithCrossTabRefreshLock(async () => {
    const adoptedTokens = readRotatedSharedSessionTokens(startingRefreshToken, startingAccessToken)
    if (adoptedTokens) {
      return adoptedTokens
    }

    const attempted = new Set<string>()
    let refreshToken = getRefreshToken()

    while (refreshToken && !attempted.has(refreshToken)) {
      attempted.add(refreshToken)
      const attemptAccessToken = getAccessToken()

      try {
        const nextTokens = await request(refreshToken)
        if (!nextTokens?.accessToken || !nextTokens.refreshToken) {
          break
        }

        setAccessToken(nextTokens.accessToken)
        setRefreshToken(nextTokens.refreshToken)
        return nextTokens
      } catch (error) {
        if (!hasRejectedRefreshStatus(error)) {
          throw error
        }

        const latestSharedTokens = readRotatedSharedSessionTokens(refreshToken, attemptAccessToken)
        if (latestSharedTokens) {
          return latestSharedTokens
        }

        const latestRefreshToken = getRefreshToken()
        if (!latestRefreshToken || latestRefreshToken === refreshToken) {
          clearSharedSessionTokens()
          return null
        }

        refreshToken = latestRefreshToken
      }
    }

    clearSharedSessionTokens()
    return null
  })
}
