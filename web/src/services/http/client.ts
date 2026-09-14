import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios'
import {
  clearAccessToken,
  clearRefreshToken,
  getAccessToken,
} from '@/services/storage/tokenStorage'
import { resolveApiBaseUrl } from '@/services/runtime/backendEndpoint'
import { refreshSharedSessionTokens } from './refreshSession'

interface RetriableRequestConfig extends InternalAxiosRequestConfig {
  _retryAuth?: boolean
}

let refreshInFlight: Promise<string | null> | null = null
export const AUTH_EXPIRED_EVENT = 'msgnr:auth-expired'

function notifyAuthExpired() {
  const target = globalThis as EventTarget
  if (typeof target.dispatchEvent !== 'function') return
  target.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))
}

function shouldSkipAuthRefresh(url: string | undefined) {
  if (!url) return false
  return (
    url.includes('/api/auth/login') ||
    url.includes('/api/auth/refresh') ||
    url.includes('/api/auth/logout')
  )
}

/**
 * Returns an Axios instance pre-configured with a Bearer token interceptor.
 * Each service module calls this once at module load time.
 */
export function createAuthenticatedClient() {
  const http = axios.create({ baseURL: resolveApiBaseUrl() })
  http.interceptors.request.use((config) => {
    config.baseURL = resolveApiBaseUrl()
    const token = getAccessToken()
    if (token) config.headers.Authorization = `Bearer ${token}`
    return config
  })

  http.interceptors.response.use(
    (response) => response,
    async (error: AxiosError) => {
      const config = error.config as RetriableRequestConfig | undefined
      if (!config) throw error
      if (error.response?.status !== 401) throw error
      if (config._retryAuth) throw error
      if (shouldSkipAuthRefresh(config.url)) throw error

      config._retryAuth = true
      try {
        if (!refreshInFlight) {
          refreshInFlight = refreshSharedSessionTokens()
            .then((tokens) => tokens?.accessToken ?? null)
            .finally(() => {
            refreshInFlight = null
          })
        }
        const nextToken = await refreshInFlight
        if (!nextToken) {
          clearAccessToken()
          clearRefreshToken()
          notifyAuthExpired()
          throw error
        }
        config.headers = config.headers ?? {}
        config.headers.Authorization = `Bearer ${nextToken}`
        return await http.request(config)
      } catch {
        throw error
      }
    },
  )

  return http
}
