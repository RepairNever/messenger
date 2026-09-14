import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  apiGetProfile,
  apiLogin,
  apiRefresh,
  apiLogout,
  apiUpdateProfile,
  apiChangePassword,
  apiUploadAvatar,
  apiRemoveAvatar,
  apiSetCustomStatus,
  apiClearCustomStatus,
  AuthApiError,
  type UserDto,
  type UpdateProfileRequest,
  type SetCustomStatusRequest,
} from '@/services/http/authApi'
import { refreshSharedSessionTokens } from '@/services/http/refreshSession'
import {
  getRefreshToken,
  getAccessToken,
  setRefreshToken,
  clearRefreshToken,
  setAccessToken,
  clearAccessToken,
} from '@/services/storage/tokenStorage'
import { clearLastAppliedEventSeq } from '@/services/storage/syncStateStorage'
import { clearClientInstanceId } from '@/services/storage/clientInstanceStorage'
import { clearManualPresencePreference } from '@/services/storage/manualPresenceStorage'
import { clearAllLastOpenedConversations } from '@/services/storage/lastConversationStorage'
import { clearStoredThreadSummaries } from '@/services/storage/threadSummaryStorage'
import { clearLastOpenedTaskPublicId } from '@/services/storage/lastTaskRouteStorage'
import { clearPushEndpoint } from '@/services/storage/pushStorage'
import { clearCollapsedDocumentsTeamspaceIds } from '@/services/storage/documentsTeamspaceCollapseStorage'
import { clearCollapsedDocumentsNodeIds } from '@/services/storage/documentsNodeCollapseStorage'
import { clearAllChatDrafts } from '@/services/storage/chatDraftStorage'
import { cacheUserProfile, loadCachedUserProfile, clearAllData as clearIndexedDb } from '@/services/db/cache'
import { clearAllPersistedClientDataPreservingBackendUrl } from '@/services/storage/hardReset'
import { useDayoffsStore } from '@/stores/dayoffs'
import { isUserCustomStatusActive, userCustomStatusFromDto, userCustomStatusFromStored, type UserCustomStatus } from '@/types/userStatus'

export type AuthState =
  | 'ANON'
  | 'LOGGING_IN'
  | 'AUTHENTICATED'
  | 'AUTH_DEGRADED'
  | 'REFRESHING'
  | 'LOGGING_OUT'
  | 'AUTH_ERROR'

export interface AuthUser {
  id: string
  email: string
  displayName: string
  avatarUrl?: string
  role: string
  customStatus?: UserCustomStatus | null
}

const AUTH_USER_STORAGE_KEY = 'auth.user'
const ACCESS_TOKEN_EXPIRY_BUFFER_SEC = 30

/**
 * Decode the payload of a JWT without verifying its signature.
 * Safe to use on the client side — the server already validated the token.
 */
function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return {}
    // Base64url → base64 → decode
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const json = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
        .join(''),
    )
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return {}
  }
}

function isAccessTokenUsable(token: string | null | undefined): boolean {
  if (!token) return false
  const payload = decodeJwtPayload(token)
  const exp = payload.exp
  if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    return true
  }

  // Treat tokens close to expiry as unusable so wake/resume recovery does not
  // keep the app on a token that will immediately fail downstream requests.
  const nowSeconds = Math.floor(Date.now() / 1000)
  return exp > nowSeconds + ACCESS_TOKEN_EXPIRY_BUFFER_SEC
}

function getErrorStatus(error: unknown): number | null {
  if (error instanceof AuthApiError) return error.status
  if (
    typeof error === 'object'
    && error !== null
    && 'response' in error
    && typeof (error as { response?: unknown }).response === 'object'
    && (error as { response?: { status?: unknown } }).response !== null
    && typeof (error as { response?: { status?: unknown } }).response?.status === 'number'
  ) {
    return (error as { response: { status: number } }).response.status
  }
  if (
    typeof error === 'object'
    && error !== null
    && 'status' in error
    && typeof (error as { status?: unknown }).status === 'number'
  ) {
    return (error as { status: number }).status
  }
  return null
}

function isServerUnavailableError(error: unknown): boolean {
  const status = getErrorStatus(error)
  return status === 0 || (status != null && status >= 500)
}

function toUser(dto: UserDto): AuthUser {
  return {
    id: dto.id,
    email: dto.email,
    displayName: dto.display_name,
    avatarUrl: dto.avatar_url ?? '',
    role: dto.role,
    customStatus: userCustomStatusFromDto(dto.custom_status),
  }
}

function saveUser(user: AuthUser | null) {
  try {
    if (!user) {
      globalThis.localStorage?.removeItem(AUTH_USER_STORAGE_KEY)
      return
    }
    globalThis.localStorage?.setItem(AUTH_USER_STORAGE_KEY, JSON.stringify(user))
    // Write-through to IndexedDB (fire-and-forget)
    void cacheUserProfile({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      role: user.role,
      customStatus: user.customStatus,
    })
  } catch {
    // best-effort persistence
  }
}

function loadUser(): AuthUser | null {
  try {
    const raw = globalThis.localStorage?.getItem(AUTH_USER_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<AuthUser>
    if (!parsed || typeof parsed !== 'object') return null
    if (!parsed.id || !parsed.email) return null
    return {
      id: String(parsed.id),
      email: String(parsed.email),
      displayName: String(parsed.displayName ?? ''),
      avatarUrl: String(parsed.avatarUrl ?? ''),
      role: String(parsed.role ?? ''),
      customStatus: userCustomStatusFromStored(parsed.customStatus),
    }
  } catch {
    return null
  }
}

export const useAuthStore = defineStore('auth', () => {
  const authState = ref<AuthState>('ANON')
  const user = ref<AuthUser | null>(loadUser())
  const accessToken = ref<string | null>(null)
  const lastAuthError = ref<string | null>(null)
  const sessionRole = ref<string | null>(null)
  const effectiveRole = computed(() => user.value?.role ?? sessionRole.value)
  const needChangePassword = ref<boolean>(false)

  function loadPersistedRefreshToken(): string | null {
    return getRefreshToken()
  }

  /**
   * If the synchronous localStorage read returned null (e.g. storage cleared
   * by the browser), attempt to recover the user profile from IndexedDB.
   * Called during cache-first startup before the auth token is refreshed.
   */
  async function hydrateUserFromCache(): Promise<void> {
    if (user.value) return // Already loaded from localStorage
    try {
      const cached = await loadCachedUserProfile()
      if (!cached) return
      user.value = {
        id: cached.id,
        email: cached.email,
        displayName: cached.displayName,
        avatarUrl: cached.avatarUrl,
        role: cached.role ?? '',
        customStatus: isUserCustomStatusActive(cached.customStatus) ? cached.customStatus : null,
      }
    } catch {
      // Non-fatal — auth.refresh() will set the user when it succeeds.
    }
  }

  async function login(email: string, password: string): Promise<void> {
    authState.value = 'LOGGING_IN'
    lastAuthError.value = null
    try {
      const res = await apiLogin(email, password)
      accessToken.value = res.access_token
      setRefreshToken(res.refresh_token)
      setAccessToken(res.access_token)
      user.value = toUser(res.user)
      saveUser(user.value)
      sessionRole.value = res.user.role
      // Read from both the response body and the JWT so the flag survives page refreshes.
      const loginClaims = decodeJwtPayload(res.access_token)
      needChangePassword.value =
        (loginClaims.need_change_password === true) || (res.user.need_change_password ?? false)
      authState.value = 'AUTHENTICATED'
    } catch (e) {
      lastAuthError.value = e instanceof AuthApiError ? e.message : 'Login failed'
      authState.value = 'AUTH_ERROR'
      throw e
    }
  }

  async function refresh(): Promise<string> {
    const stored = getRefreshToken()
    if (!stored) {
      clearSession()
      throw new AuthApiError('No refresh token', 401)
    }
    authState.value = 'REFRESHING'
    lastAuthError.value = null
    try {
      const res = await refreshSharedSessionTokens(async (refreshToken) => {
        const next = await apiRefresh(refreshToken)
        return {
          accessToken: next.access_token,
          refreshToken: next.refresh_token,
        }
      })
      if (!res) {
        throw new AuthApiError('Refresh failed', 401)
      }

      accessToken.value = res.accessToken
      setAccessToken(res.accessToken)
      // Restore need_change_password from the new JWT payload so a page refresh
      // doesn't bypass the mandatory password change dialog.
      const claims = decodeJwtPayload(res.accessToken)
      needChangePassword.value = claims.need_change_password === true
      authState.value = 'AUTHENTICATED'
      lastAuthError.value = null
      return res.accessToken
    } catch (e) {
      if (isServerUnavailableError(e)) {
        const persistedAccessToken = accessToken.value ?? getAccessToken()
        if (persistedAccessToken && isAccessTokenUsable(persistedAccessToken)) {
          accessToken.value = persistedAccessToken
          setAccessToken(persistedAccessToken)
          // Also restore from any persisted token when the server is temporarily unavailable.
          const fallbackClaims = decodeJwtPayload(persistedAccessToken)
          needChangePassword.value = fallbackClaims.need_change_password === true
          authState.value = 'AUTH_DEGRADED'
          lastAuthError.value = 'Server is unavailable'
          throw e
        }

        accessToken.value = null
        clearAccessToken()
        authState.value = 'AUTH_DEGRADED'
        lastAuthError.value = 'Server is unavailable'
        throw e
      }

      lastAuthError.value = e instanceof AuthApiError ? e.message : 'Refresh failed'
      clearSession()
      throw e
    }
  }

  async function logout(): Promise<void> {
    authState.value = 'LOGGING_OUT'
    const stored = getRefreshToken()
    if (stored) {
      try {
        await apiLogout(stored)
      } catch {
        // best-effort; always clear locally
      }
    }
    clearSession()
    await clearAllPersistedClientDataPreservingBackendUrl()
  }

  async function ensureUserLoaded(): Promise<AuthUser | null> {
    if (user.value) return user.value
    const token = accessToken.value ?? getAccessToken()
    if (!token) return null
    const profile = await apiGetProfile()
    user.value = toUser(profile)
    saveUser(user.value)
    return user.value
  }

  async function changePassword(newPassword: string): Promise<void> {
    await apiChangePassword(newPassword)
    needChangePassword.value = false
  }

  function assertAuthenticated() {
    const token = accessToken.value ?? getAccessToken()
    if (!token) {
      throw new AuthApiError('Not authenticated', 401)
    }
  }

  async function updateProfile(payload: UpdateProfileRequest): Promise<AuthUser> {
    assertAuthenticated()

    const request: UpdateProfileRequest = {
      display_name: payload.display_name?.trim(),
      email: payload.email?.trim(),
    }

    if (!request.display_name && !request.email) {
      throw new AuthApiError('No profile fields to update', 400)
    }

    const updated = await apiUpdateProfile(request)
    user.value = toUser(updated)
    saveUser(user.value)
    return user.value
  }

  async function uploadAvatar(file: File): Promise<AuthUser> {
    assertAuthenticated()
    const updated = await apiUploadAvatar(file)
    user.value = toUser(updated)
    saveUser(user.value)
    return user.value
  }

  async function removeAvatar(): Promise<AuthUser> {
    assertAuthenticated()
    const updated = await apiRemoveAvatar()
    user.value = toUser(updated)
    saveUser(user.value)
    return user.value
  }

  async function setCustomStatus(payload: SetCustomStatusRequest): Promise<AuthUser> {
    assertAuthenticated()
    const updated = await apiSetCustomStatus(payload)
    user.value = toUser(updated)
    saveUser(user.value)
    return user.value
  }

  async function clearCustomStatus(): Promise<AuthUser> {
    assertAuthenticated()
    const updated = await apiClearCustomStatus()
    user.value = toUser(updated)
    saveUser(user.value)
    return user.value
  }

  function clearSession(): void {
    // Dayoffs is a shared calendar and is never persisted locally. Clear it
    // synchronously at the auth boundary so switching accounts/workspaces
    // cannot briefly render the prior session's employee data.
    useDayoffsStore().reset()
    accessToken.value = null
    user.value = null
    saveUser(null)
    sessionRole.value = null
    needChangePassword.value = false
    clearRefreshToken()
    clearAccessToken()
    clearLastAppliedEventSeq()
    clearClientInstanceId()
    clearManualPresencePreference()
    clearAllLastOpenedConversations()
    clearStoredThreadSummaries()
    clearLastOpenedTaskPublicId()
    clearPushEndpoint()
    clearCollapsedDocumentsTeamspaceIds()
    clearCollapsedDocumentsNodeIds()
    clearAllChatDrafts()
    // Wipe all IndexedDB cached data (fire-and-forget)
    void clearIndexedDb()
    authState.value = 'ANON'
  }

  function setSessionRole(role: string | null) {
    sessionRole.value = role
  }

  function setNeedChangePassword(val: boolean) {
    needChangePassword.value = val
  }

  return {
    authState,
    user,
    accessToken,
    lastAuthError,
    sessionRole,
    effectiveRole,
    needChangePassword,
    loadPersistedRefreshToken,
    hydrateUserFromCache,
    login,
    refresh,
    logout,
    ensureUserLoaded,
    updateProfile,
    uploadAvatar,
    removeAvatar,
    setCustomStatus,
    clearCustomStatus,
    changePassword,
    setSessionRole,
    setNeedChangePassword,
    clearSession,
  }
})
