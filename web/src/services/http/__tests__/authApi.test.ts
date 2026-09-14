import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTH_REQUEST_TIMEOUT_MS } from '@/services/http/timeouts'

const mockHttp = vi.hoisted(() => ({
  post: vi.fn(),
}))

vi.mock('@/services/http/client', () => ({
  createAuthenticatedClient: () => mockHttp,
}))

describe('auth API timeouts', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('applies the bounded auth deadline to login and refresh', async () => {
    mockHttp.post
      .mockResolvedValueOnce({
        data: {
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in_sec: 3600,
          user: {
            id: 'user-1',
            email: 'user@example.com',
            display_name: 'User',
            role: 'member',
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          access_token: 'access-2',
          refresh_token: 'refresh-2',
          expires_in_sec: 3600,
        },
      })

    const { apiLogin, apiRefresh } = await import('@/services/http/authApi')

    await apiLogin('user@example.com', 'password')
    await apiRefresh('refresh-1')

    expect(mockHttp.post).toHaveBeenNthCalledWith(
      1,
      '/api/auth/login',
      { email: 'user@example.com', password: 'password' },
      { timeout: AUTH_REQUEST_TIMEOUT_MS },
    )
    expect(mockHttp.post).toHaveBeenNthCalledWith(
      2,
      '/api/auth/refresh',
      { refresh_token: 'refresh-1' },
      { timeout: AUTH_REQUEST_TIMEOUT_MS },
    )
  })
})
