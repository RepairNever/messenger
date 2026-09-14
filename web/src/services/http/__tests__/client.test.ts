import axios, { AxiosError } from 'axios'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTH_REQUEST_TIMEOUT_MS } from '@/services/http/timeouts'

describe('createAuthenticatedClient', () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    vi.resetModules()
    const tokenStorage = await import('@/services/storage/tokenStorage')
    tokenStorage.clearAccessToken()
    tokenStorage.clearRefreshToken()
  })

  it('refreshes access token on 401 and retries request once', async () => {
    const tokenStorage = await import('@/services/storage/tokenStorage')
    tokenStorage.setAccessToken('expired-token')
    tokenStorage.setRefreshToken('refresh-token-1')

    const { createAuthenticatedClient } = await import('@/services/http/client')
    const http = createAuthenticatedClient()

    const authHeaders: string[] = []
    let attempt = 0
    http.defaults.adapter = vi.fn(async (config) => {
      attempt += 1
      authHeaders.push(String((config.headers as Record<string, unknown> | undefined)?.Authorization ?? ''))
      if (attempt === 1) {
        throw new AxiosError(
          'Unauthorized',
          'ERR_BAD_REQUEST',
          config,
          undefined,
          {
            data: { error: 'unauthorized' },
            status: 401,
            statusText: 'Unauthorized',
            headers: {},
            config,
          },
        )
      }
      return {
        data: { ok: true },
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      }
    })

    vi.spyOn(axios, 'post').mockResolvedValue({
      data: {
        access_token: 'fresh-token',
        refresh_token: 'refresh-token-2',
        expires_in_sec: 3600,
      },
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {} as any,
    })

    const response = await http.get('/api/messages')

    expect(response.data).toEqual({ ok: true })
    expect(axios.post).toHaveBeenCalledTimes(1)
    expect(axios.post).toHaveBeenCalledWith(
      '/api/auth/refresh',
      { refresh_token: 'refresh-token-1' },
      expect.objectContaining({ timeout: AUTH_REQUEST_TIMEOUT_MS }),
    )
    expect(authHeaders).toEqual(['Bearer expired-token', 'Bearer fresh-token'])
    expect(tokenStorage.getAccessToken()).toBe('fresh-token')
    expect(tokenStorage.getRefreshToken()).toBe('refresh-token-2')
  })

  it('dispatches auth-expired event when refresh cannot recover 401', async () => {
    const tokenStorage = await import('@/services/storage/tokenStorage')
    tokenStorage.setAccessToken('expired-token')
    tokenStorage.setRefreshToken('expired-refresh-token')

    const { createAuthenticatedClient, AUTH_EXPIRED_EVENT } = await import('@/services/http/client')
    const http = createAuthenticatedClient()

    http.defaults.adapter = vi.fn(async (config) => {
      throw new AxiosError(
        'Unauthorized',
        'ERR_BAD_REQUEST',
        config,
        undefined,
        {
          data: { error: 'unauthorized' },
          status: 401,
          statusText: 'Unauthorized',
          headers: {},
          config,
        },
      )
    })

    const authExpiredListener = vi.fn()
    globalThis.addEventListener(AUTH_EXPIRED_EVENT, authExpiredListener as EventListener)

    vi.spyOn(axios, 'post').mockRejectedValue(new AxiosError(
      'Unauthorized',
      'ERR_BAD_REQUEST',
      undefined,
      undefined,
      {
        data: { error: 'unauthorized' },
        status: 401,
        statusText: 'Unauthorized',
        headers: {},
        config: {} as any,
      },
    ))

    await expect(http.get('/api/tasks')).rejects.toBeInstanceOf(AxiosError)

    expect(authExpiredListener).toHaveBeenCalledTimes(1)
    expect(tokenStorage.getAccessToken()).toBeNull()
    expect(tokenStorage.getRefreshToken()).toBeNull()

    globalThis.removeEventListener(AUTH_EXPIRED_EVENT, authExpiredListener as EventListener)
  })

  it('retries refresh with the newer shared refresh token instead of clearing auth', async () => {
    const tokenStorage = await import('@/services/storage/tokenStorage')
    tokenStorage.setAccessToken('expired-token')
    tokenStorage.setRefreshToken('refresh-token-1')

    const { createAuthenticatedClient } = await import('@/services/http/client')
    const http = createAuthenticatedClient()

    let attempt = 0
    http.defaults.adapter = vi.fn(async (config) => {
      attempt += 1
      if (attempt === 1) {
        throw new AxiosError(
          'Unauthorized',
          'ERR_BAD_REQUEST',
          config,
          undefined,
          {
            data: { error: 'unauthorized' },
            status: 401,
            statusText: 'Unauthorized',
            headers: {},
            config,
          },
        )
      }

      return {
        data: { ok: true },
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      }
    })

    vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
      const refreshToken = (body as { refresh_token: string }).refresh_token
      if (refreshToken === 'refresh-token-1') {
        tokenStorage.setRefreshToken('refresh-token-2')
        throw new AxiosError(
          'Unauthorized',
          'ERR_BAD_REQUEST',
          undefined,
          undefined,
          {
            data: { error: 'unauthorized' },
            status: 401,
            statusText: 'Unauthorized',
            headers: {},
            config: {} as any,
          },
        )
      }

      expect(refreshToken).toBe('refresh-token-2')
      return {
        data: {
          access_token: 'fresh-token-2',
          refresh_token: 'refresh-token-3',
          expires_in_sec: 3600,
        },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      }
    })

    const response = await http.get('/api/messages')

    expect(response.data).toEqual({ ok: true })
    expect(axios.post).toHaveBeenCalledTimes(2)
    expect(tokenStorage.getAccessToken()).toBe('fresh-token-2')
    expect(tokenStorage.getRefreshToken()).toBe('refresh-token-3')
  })
})
