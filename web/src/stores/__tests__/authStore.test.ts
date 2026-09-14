import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { useDayoffsStore } from '@/stores/dayoffs'
import * as authApi from '@/services/http/authApi'
import * as tokenStorage from '@/services/storage/tokenStorage'
import { saveLastAppliedEventSeq, loadLastAppliedEventSeq } from '@/services/storage/syncStateStorage'
import { getOrCreateClientInstanceId, getClientInstanceId } from '@/services/storage/clientInstanceStorage'
import { saveManualPresencePreference, loadManualPresencePreference } from '@/services/storage/manualPresenceStorage'
import { saveLastOpenedConversation, loadLastOpenedConversation } from '@/services/storage/lastConversationStorage'
import { saveLastOpenedTaskPublicId, loadLastOpenedTaskPublicId } from '@/services/storage/lastTaskRouteStorage'
import { setBackendBaseUrl, getBackendBaseUrl } from '@/services/runtime/backendEndpoint'
import { saveAudioPrefs, loadAudioPrefs } from '@/services/storage/audioPrefsStorage'
import { loadChatDraft, saveChatDraft } from '@/services/storage/chatDraftStorage'

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

function createJwtWithExp(expSecondsFromNow: number) {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = btoa(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + expSecondsFromNow,
  }))
  return `${header}.${payload}.signature`
}

function installQueuedRefreshLocks() {
  let locked = false
  const waiters: Array<() => void> = []
  const request = vi.fn(async <T>(_name: string, callback: () => Promise<T>) => {
    if (locked) {
      await new Promise<void>((resolve) => {
        waiters.push(resolve)
      })
    }
    locked = true
    try {
      return await callback()
    } finally {
      locked = false
      const next = waiters.shift()
      next?.()
    }
  })

  Object.defineProperty(globalThis.navigator, 'locks', {
    value: { request },
    configurable: true,
  })

  return request
}

const mockUser = {
  id: 'user-1',
  email: 'alice@example.com',
  display_name: 'Alice',
  role: 'member',
}

const mockLoginResponse = {
  access_token: 'access-abc',
  refresh_token: 'refresh-xyz',
  expires_in_sec: 3600,
  user: mockUser,
}

const mockRefreshResponse = {
  access_token: 'access-new',
  refresh_token: 'refresh-new',
  expires_in_sec: 3600,
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.restoreAllMocks()
  tokenStorage.clearRefreshToken()
  tokenStorage.clearAccessToken()
  localStorage.clear()
  Object.defineProperty(globalThis.navigator, 'locks', {
    value: undefined,
    configurable: true,
  })
})

describe('authStore.login', () => {
  it('transitions to AUTHENTICATED and stores tokens on success', async () => {
    vi.spyOn(authApi, 'apiLogin').mockResolvedValue(mockLoginResponse)

    const store = useAuthStore()
    await store.login('alice@example.com', 'pass')

    expect(store.authState).toBe('AUTHENTICATED')
    expect(store.accessToken).toBe('access-abc')
    expect(store.user?.email).toBe('alice@example.com')
    expect(store.user?.displayName).toBe('Alice')
    expect(tokenStorage.getRefreshToken()).toBe('refresh-xyz')
  })

  it('transitions to AUTH_ERROR on failure', async () => {
    vi.spyOn(authApi, 'apiLogin').mockRejectedValue(new authApi.AuthApiError('invalid credentials', 401))

    const store = useAuthStore()
    await expect(store.login('bad@example.com', 'wrong')).rejects.toThrow()

    expect(store.authState).toBe('AUTH_ERROR')
    expect(store.accessToken).toBeNull()
    expect(store.lastAuthError).toBe('invalid credentials')
  })
})

describe('authStore.updateProfile', () => {
  it('updates local user on success', async () => {
    const updateSpy = vi.spyOn(authApi, 'apiUpdateProfile').mockResolvedValue({
      id: 'user-1',
      email: 'alice-new@example.com',
      display_name: 'Alice New',
      role: 'member',
    })
    const store = useAuthStore()
    tokenStorage.setAccessToken('access-abc')
    store.accessToken = 'access-abc'
    store.user = {
      id: 'user-1',
      email: 'alice@example.com',
      displayName: 'Alice',
      role: 'member',
    }

    const result = await store.updateProfile({
      display_name: 'Alice New',
      email: 'alice-new@example.com',
    })

    expect(result.email).toBe('alice-new@example.com')
    expect(store.user?.displayName).toBe('Alice New')
    expect(store.user?.email).toBe('alice-new@example.com')
    expect(updateSpy).toHaveBeenCalledWith({
      display_name: 'Alice New',
      email: 'alice-new@example.com',
    })
  })

  it('throws for empty payload', async () => {
    const updateSpy = vi.spyOn(authApi, 'apiUpdateProfile').mockResolvedValue({
      id: 'user-1',
      email: 'alice@example.com',
      display_name: 'Alice',
      role: 'member',
    })
    const store = useAuthStore()
    tokenStorage.setAccessToken('access-abc')
    store.accessToken = 'access-abc'
    store.user = {
      id: 'user-1',
      email: 'alice@example.com',
      displayName: 'Alice',
      role: 'member',
    }

    await expect(store.updateProfile({ display_name: '   ', email: '   ' })).rejects.toThrow('No profile fields to update')
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('throws when not authenticated', async () => {
    const updateSpy = vi.spyOn(authApi, 'apiUpdateProfile').mockResolvedValue({
      id: 'user-1',
      email: 'alice@example.com',
      display_name: 'Alice',
      role: 'member',
    })
    const store = useAuthStore()
    await expect(store.updateProfile({ display_name: 'Nope' })).rejects.toThrow('Not authenticated')
    expect(updateSpy).not.toHaveBeenCalled()
  })
})

describe('authStore.ensureUserLoaded', () => {
  it('loads user profile when access token exists and user is missing', async () => {
    tokenStorage.setAccessToken('access-abc')
    const getProfileSpy = vi.spyOn(authApi, 'apiGetProfile').mockResolvedValue(mockUser)
    const store = useAuthStore()
    store.accessToken = 'access-abc'
    store.user = null

    const loaded = await store.ensureUserLoaded()

    expect(getProfileSpy).toHaveBeenCalledTimes(1)
    expect(loaded?.email).toBe('alice@example.com')
    expect(store.user).toMatchObject({ displayName: 'Alice' })
  })

  it('returns cached user without fetching profile', async () => {
    const getProfileSpy = vi.spyOn(authApi, 'apiGetProfile').mockResolvedValue(mockUser)
    const store = useAuthStore()
    store.user = {
      id: 'user-1',
      email: 'alice@example.com',
      displayName: 'Alice',
      role: 'member',
    }

    const loaded = await store.ensureUserLoaded()

    expect(loaded?.email).toBe('alice@example.com')
    expect(getProfileSpy).not.toHaveBeenCalled()
  })
})

describe('authStore.refresh', () => {
  it('rotates refresh token in storage and updates access token', async () => {
    tokenStorage.setRefreshToken('old-refresh')
    vi.spyOn(authApi, 'apiRefresh').mockResolvedValue(mockRefreshResponse)

    const store = useAuthStore()
    const token = await store.refresh()

    expect(token).toBe('access-new')
    expect(store.accessToken).toBe('access-new')
    expect(tokenStorage.getRefreshToken()).toBe('refresh-new')
    expect(store.authState).toBe('AUTHENTICATED')
  })

  it('clears session if no refresh token exists', async () => {
    const store = useAuthStore()
    await expect(store.refresh()).rejects.toThrow()
    expect(store.authState).toBe('ANON')
  })

  it('clears session on API failure', async () => {
    tokenStorage.setRefreshToken('expired-token')
    vi.spyOn(authApi, 'apiRefresh').mockRejectedValue(new authApi.AuthApiError('expired', 401))

    const store = useAuthStore()
    await expect(store.refresh()).rejects.toThrow()

    expect(store.authState).toBe('ANON')
    expect(store.accessToken).toBeNull()
    expect(tokenStorage.getRefreshToken()).toBeNull()
  })

  it('keeps session on refresh network failure when access token exists', async () => {
    tokenStorage.setRefreshToken('refresh-old')
    tokenStorage.setAccessToken('access-old')
    vi.spyOn(authApi, 'apiRefresh').mockRejectedValue(new authApi.AuthApiError('Network error', 0))

    const store = useAuthStore()
    store.accessToken = 'access-old'

    await expect(store.refresh()).rejects.toThrow()

    expect(store.authState).toBe('AUTH_DEGRADED')
    expect(store.accessToken).toBe('access-old')
    expect(tokenStorage.getRefreshToken()).toBe('refresh-old')
    expect(tokenStorage.getAccessToken()).toBe('access-old')
    expect(store.lastAuthError).toBe('Server is unavailable')
  })

  it('keeps session on refresh 5xx failure when access token exists', async () => {
    tokenStorage.setRefreshToken('refresh-old')
    tokenStorage.setAccessToken('access-old')
    vi.spyOn(authApi, 'apiRefresh').mockRejectedValue(new authApi.AuthApiError('server error', 503))

    const store = useAuthStore()
    store.accessToken = 'access-old'

    await expect(store.refresh()).rejects.toThrow()

    expect(store.authState).toBe('AUTH_DEGRADED')
    expect(store.accessToken).toBe('access-old')
    expect(tokenStorage.getRefreshToken()).toBe('refresh-old')
    expect(tokenStorage.getAccessToken()).toBe('access-old')
    expect(store.lastAuthError).toBe('Server is unavailable')
  })

  it('enters degraded auth state on refresh failure when no usable access token remains', async () => {
    tokenStorage.setRefreshToken('refresh-old')
    tokenStorage.setAccessToken(createJwtWithExp(-3600))
    vi.spyOn(authApi, 'apiRefresh').mockRejectedValue(new authApi.AuthApiError('server error', 503))

    const store = useAuthStore()
    store.accessToken = createJwtWithExp(-3600)
    store.user = {
      id: 'user-1',
      email: 'alice@example.com',
      displayName: 'Alice',
      role: 'member',
    }

    await expect(store.refresh()).rejects.toThrow()

    expect(store.authState).toBe('AUTH_DEGRADED')
    expect(store.accessToken).toBeNull()
    expect(tokenStorage.getAccessToken()).toBeNull()
    expect(tokenStorage.getRefreshToken()).toBe('refresh-old')
    expect(store.user?.email).toBe('alice@example.com')
    expect(store.lastAuthError).toBe('Server is unavailable')
  })

  it('retries refresh with the latest stored refresh token before clearing session', async () => {
    tokenStorage.setRefreshToken('refresh-old')
    vi.spyOn(authApi, 'apiRefresh').mockImplementation(async (refreshToken: string) => {
      if (refreshToken === 'refresh-old') {
        tokenStorage.setRefreshToken('refresh-newer')
        throw new authApi.AuthApiError('expired', 401)
      }
      expect(refreshToken).toBe('refresh-newer')
      return mockRefreshResponse
    })

    const store = useAuthStore()
    const token = await store.refresh()

    expect(token).toBe('access-new')
    expect(store.authState).toBe('AUTHENTICATED')
    expect(tokenStorage.getRefreshToken()).toBe('refresh-new')
    expect(tokenStorage.getAccessToken()).toBe('access-new')
  })

  it('serializes concurrent refresh calls and adopts the winning tab tokens', async () => {
    installQueuedRefreshLocks()
    tokenStorage.setRefreshToken('refresh-old')
    tokenStorage.setAccessToken('access-old')

    const deferredRefresh = createDeferred<typeof mockRefreshResponse>()
    const refreshSpy = vi.spyOn(authApi, 'apiRefresh').mockImplementation(async () => {
      return await deferredRefresh.promise
    })

    const store = useAuthStore()
    const first = store.refresh()
    await Promise.resolve()
    const second = store.refresh()

    expect(refreshSpy).toHaveBeenCalledTimes(1)

    deferredRefresh.resolve(mockRefreshResponse)

    await expect(first).resolves.toBe('access-new')
    await expect(second).resolves.toBe('access-new')
    expect(refreshSpy).toHaveBeenCalledTimes(1)
    expect(store.authState).toBe('AUTHENTICATED')
    expect(tokenStorage.getRefreshToken()).toBe('refresh-new')
    expect(tokenStorage.getAccessToken()).toBe('access-new')
  })

  it('exposes effectiveRole from ws auth hydration after refresh', async () => {
    tokenStorage.setRefreshToken('old-refresh')
    vi.spyOn(authApi, 'apiRefresh').mockResolvedValue(mockRefreshResponse)

    const store = useAuthStore()
    await store.refresh()
    store.setSessionRole('admin')

    expect(store.user).toBeNull()
    expect(store.effectiveRole).toBe('admin')
  })
})

describe('authStore.logout', () => {
  it('clears the in-memory Dayoffs calendar with the session', () => {
    const dayoffsStore = useDayoffsStore()
    dayoffsStore.employees = [{ id: 'other-user', displayName: 'Other User', avatarUrl: '' }]
    dayoffsStore.records = [{
      id: 'dayoff-1',
      userId: 'other-user',
      type: 'vacation',
      startDate: '2026-07-20',
      endDate: '2026-07-21',
      note: '',
      createdAt: '2026-07-01T00:00:00Z',
      updatedAt: '2026-07-01T00:00:00Z',
    }]
    dayoffsStore.selectedEmployeeId = 'other-user'

    const store = useAuthStore()
    store.clearSession()

    expect(dayoffsStore.employees).toEqual([])
    expect(dayoffsStore.records).toEqual([])
    expect(dayoffsStore.selectedEmployeeId).toBeNull()
  })

  it('clears state and storage, calls server revoke', async () => {
    tokenStorage.setRefreshToken('some-token')
    tokenStorage.setAccessToken('some-access')
    saveLastAppliedEventSeq(123n)
    const clientInstanceId = getOrCreateClientInstanceId()
    saveManualPresencePreference('away')
    saveLastOpenedConversation('workspace-1', 'user-1', 'conversation-1')
    localStorage.setItem('msgnr:thread-summaries:v1', JSON.stringify({ user1: {} }))
    saveLastOpenedTaskPublicId('TASK-1')
    saveChatDraft(
      { kind: 'conversation', conversationId: 'conversation-1' },
      { body: 'Draft message', entities: [] },
    )
    const logoutSpy = vi.spyOn(authApi, 'apiLogout').mockResolvedValue(undefined)

    const store = useAuthStore()
    await store.logout()

    expect(logoutSpy).toHaveBeenCalledWith('some-token')
    expect(store.authState).toBe('ANON')
    expect(store.accessToken).toBeNull()
    expect(tokenStorage.getRefreshToken()).toBeNull()
    expect(tokenStorage.getAccessToken()).toBeNull()
    expect(loadLastAppliedEventSeq()).toBe(0n)
    expect(getClientInstanceId()).toBeNull()
    expect(loadManualPresencePreference()).toBeNull()
    expect(loadLastOpenedConversation('workspace-1', 'user-1')).toBe('')
    expect(localStorage.getItem('msgnr:thread-summaries:v1')).toBeNull()
    expect(loadLastOpenedTaskPublicId()).toBe('')
    expect(loadChatDraft({ kind: 'conversation', conversationId: 'conversation-1' })).toEqual({
      body: '',
      entities: [],
    })
    expect(clientInstanceId).toBeTruthy()
  })

  it('preserves desktop backend URL but clears all other persisted client data', async () => {
    setBackendBaseUrl('http://localhost:8080')
    saveAudioPrefs({
      inputDeviceId: 'in-1',
      outputDeviceId: 'out-1',
      noiseSuppression: false,
      echoCancellation: false,
      autoGainControl: false,
      microphoneGain: 140,
      rnnoiseEnabled: false,
      muteMicOnJoinCall: true,
    })
    tokenStorage.setRefreshToken('some-token')
    tokenStorage.setAccessToken('some-access')
    vi.spyOn(authApi, 'apiLogout').mockResolvedValue(undefined)

    const store = useAuthStore()
    await store.logout()

    expect(getBackendBaseUrl()).toBe('http://localhost:8080')
    expect(tokenStorage.getRefreshToken()).toBeNull()
    expect(tokenStorage.getAccessToken()).toBeNull()
    expect(loadAudioPrefs()).toEqual({
      inputDeviceId: '',
      outputDeviceId: '',
      noiseSuppression: true,
      echoCancellation: true,
      autoGainControl: true,
      microphoneGain: 100,
      rnnoiseEnabled: true,
      muteMicOnJoinCall: false,
    })
  })

  it('still clears locally even if server revoke fails', async () => {
    tokenStorage.setRefreshToken('some-token')
    vi.spyOn(authApi, 'apiLogout').mockRejectedValue(new Error('network'))

    const store = useAuthStore()
    await store.logout()

    expect(store.authState).toBe('ANON')
    expect(tokenStorage.getRefreshToken()).toBeNull()
  })
})
