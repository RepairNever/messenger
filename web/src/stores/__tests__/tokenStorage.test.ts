import { beforeEach, describe, expect, it, vi } from 'vitest'

const platformMocks = vi.hoisted(() => ({
  getPlatformOrNull: vi.fn(),
}))

vi.mock('@/platform', () => ({
  getPlatformOrNull: platformMocks.getPlatformOrNull,
}))

type TokenStorageModule = typeof import('@/services/storage/tokenStorage')

async function loadTokenStorage(): Promise<TokenStorageModule> {
  vi.resetModules()
  return import('@/services/storage/tokenStorage')
}

describe('tokenStorage', () => {
  beforeEach(() => {
    platformMocks.getPlatformOrNull.mockReset()
    platformMocks.getPlatformOrNull.mockReturnValue(null)
    const ls = (globalThis as { localStorage?: { clear?: () => void } }).localStorage
    ls?.clear?.()
  })

  it('returns null when nothing stored', async () => {
    const tokenStorage = await loadTokenStorage()
    expect(tokenStorage.getRefreshToken()).toBeNull()
    expect(tokenStorage.getAccessToken()).toBeNull()
  })

  it('stores and retrieves tokens', async () => {
    const tokenStorage = await loadTokenStorage()

    tokenStorage.setRefreshToken('refresh-token')
    tokenStorage.setAccessToken('access-token')

    expect(tokenStorage.getRefreshToken()).toBe('refresh-token')
    expect(tokenStorage.getAccessToken()).toBe('access-token')
  })

  it('clears tokens', async () => {
    const tokenStorage = await loadTokenStorage()

    tokenStorage.setRefreshToken('refresh-token')
    tokenStorage.setAccessToken('access-token')
    tokenStorage.clearRefreshToken()
    tokenStorage.clearAccessToken()

    expect(tokenStorage.getRefreshToken()).toBeNull()
    expect(tokenStorage.getAccessToken()).toBeNull()
  })

  it('reconciles getters with shared localStorage updates', async () => {
    const tokenStorage = await loadTokenStorage()

    tokenStorage.setRefreshToken('refresh-token-1')
    tokenStorage.setAccessToken('access-token-1')

    localStorage.setItem('msgnr.refresh_token', 'refresh-token-2')
    localStorage.setItem('msgnr.access_token', 'access-token-2')

    expect(tokenStorage.getRefreshToken()).toBe('refresh-token-2')
    expect(tokenStorage.getAccessToken()).toBe('access-token-2')
  })

  it('hydrates in-memory tokens from secure storage when available', async () => {
    const secureStorage = {
      getSecureItem: vi.fn(async (key: string) => {
        if (key === 'msgnr.secure.access_token') return 'secure-access'
        if (key === 'msgnr.secure.refresh_token') return 'secure-refresh'
        return null
      }),
      setSecureItem: vi.fn(async () => {}),
      deleteSecureItem: vi.fn(async () => {}),
    }

    platformMocks.getPlatformOrNull.mockReturnValue({ storage: secureStorage })
    const tokenStorage = await loadTokenStorage()

    await tokenStorage.hydrateTokenStorageFromSecureStore()

    expect(tokenStorage.getAccessToken()).toBe('secure-access')
    expect(tokenStorage.getRefreshToken()).toBe('secure-refresh')
    expect(localStorage.getItem('msgnr.access_token')).toBe('secure-access')
    expect(localStorage.getItem('msgnr.refresh_token')).toBe('secure-refresh')
  })
})
