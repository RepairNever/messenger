import { storage } from '@/services/storage/storageAdapter'
import { getPlatformOrNull } from '@/platform'

const REFRESH_KEY = 'msgnr.refresh_token'
const ACCESS_KEY = 'msgnr.access_token'
const SECURE_REFRESH_KEY = 'msgnr.secure.refresh_token'
const SECURE_ACCESS_KEY = 'msgnr.secure.access_token'

let refreshCache: string | null = storage.getItem(REFRESH_KEY)
let accessCache: string | null = storage.getItem(ACCESS_KEY)
let secureHydrated = false

export const TOKEN_STORAGE_KEYS = {
  refresh: REFRESH_KEY,
  access: ACCESS_KEY,
} as const

function syncCachedToken(key: string, cached: string | null): string | null {
  const stored = storage.getItem(key)
  return stored !== cached ? stored : cached
}

async function writeSecureItem(key: string, value: string): Promise<void> {
  const platform = getPlatformOrNull()
  if (!platform?.storage.setSecureItem) return
  try {
    await platform.storage.setSecureItem(key, value)
  } catch {
    // Best effort fallback to local storage only.
  }
}

async function deleteSecureItem(key: string): Promise<void> {
  const platform = getPlatformOrNull()
  if (!platform?.storage.deleteSecureItem) return
  try {
    await platform.storage.deleteSecureItem(key)
  } catch {
    // Best effort cleanup.
  }
}

export async function hydrateTokenStorageFromSecureStore(): Promise<void> {
  if (secureHydrated) return
  secureHydrated = true

  const platform = getPlatformOrNull()
  if (!platform?.storage.getSecureItem) return

  try {
    const [secureAccess, secureRefresh] = await Promise.all([
      platform.storage.getSecureItem(SECURE_ACCESS_KEY),
      platform.storage.getSecureItem(SECURE_REFRESH_KEY),
    ])

    if (secureAccess) {
      accessCache = secureAccess
      storage.setItem(ACCESS_KEY, secureAccess)
    }
    if (secureRefresh) {
      refreshCache = secureRefresh
      storage.setItem(REFRESH_KEY, secureRefresh)
    }
  } catch {
    // Non-fatal: keep local storage values.
  }
}

export function getRefreshToken(): string | null {
  refreshCache = syncCachedToken(REFRESH_KEY, refreshCache)
  return refreshCache
}

export function setRefreshToken(token: string): void {
  refreshCache = token
  storage.setItem(REFRESH_KEY, token)
  void writeSecureItem(SECURE_REFRESH_KEY, token)
}

export function clearRefreshToken(): void {
  void clearRefreshTokenAsync()
}

export async function clearRefreshTokenAsync(): Promise<void> {
  refreshCache = null
  storage.removeItem(REFRESH_KEY)
  await deleteSecureItem(SECURE_REFRESH_KEY)
}

export function getAccessToken(): string | null {
  accessCache = syncCachedToken(ACCESS_KEY, accessCache)
  return accessCache
}

export function setAccessToken(token: string): void {
  accessCache = token
  storage.setItem(ACCESS_KEY, token)
  void writeSecureItem(SECURE_ACCESS_KEY, token)
}

export function clearAccessToken(): void {
  void clearAccessTokenAsync()
}

export async function clearAccessTokenAsync(): Promise<void> {
  accessCache = null
  storage.removeItem(ACCESS_KEY)
  await deleteSecureItem(SECURE_ACCESS_KEY)
}

export async function clearStoredTokensAsync(): Promise<void> {
  await Promise.all([
    clearRefreshTokenAsync(),
    clearAccessTokenAsync(),
  ])
}
