import { beforeEach, describe, expect, it, vi } from 'vitest'

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
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

async function loadModules() {
  vi.resetModules()
  const [tokenStorage, refreshSession] = await Promise.all([
    import('@/services/storage/tokenStorage'),
    import('@/services/http/refreshSession'),
  ])
  return {
    tokenStorage,
    refreshSession,
  }
}

describe('refreshSharedSessionTokens', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    const ls = (globalThis as { localStorage?: { clear?: () => void } }).localStorage
    ls?.clear?.()
    Object.defineProperty(globalThis.navigator, 'locks', {
      value: undefined,
      configurable: true,
    })
  })

  it('adopts tokens refreshed by another tab after waiting for the cross-tab lock', async () => {
    const lockRequest = installQueuedRefreshLocks()
    const { tokenStorage, refreshSession } = await loadModules()
    tokenStorage.setAccessToken('access-old')
    tokenStorage.setRefreshToken('refresh-old')

    const deferredRefresh = createDeferred<{ accessToken: string; refreshToken: string }>()
    const refreshRequest = vi.fn(async () => {
      return await deferredRefresh.promise
    })

    const first = refreshSession.refreshSharedSessionTokens(refreshRequest)
    await Promise.resolve()
    const second = refreshSession.refreshSharedSessionTokens(refreshRequest)

    expect(refreshRequest).toHaveBeenCalledTimes(1)

    deferredRefresh.resolve({
      accessToken: 'access-new',
      refreshToken: 'refresh-new',
    })

    await expect(first).resolves.toEqual({
      accessToken: 'access-new',
      refreshToken: 'refresh-new',
    })
    await expect(second).resolves.toEqual({
      accessToken: 'access-new',
      refreshToken: 'refresh-new',
    })

    expect(lockRequest).toHaveBeenCalledTimes(2)
    expect(refreshRequest).toHaveBeenCalledTimes(1)
    expect(tokenStorage.getAccessToken()).toBe('access-new')
    expect(tokenStorage.getRefreshToken()).toBe('refresh-new')
  })
})
