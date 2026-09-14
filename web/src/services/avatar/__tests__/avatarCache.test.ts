import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearAvatarMemoryCacheForTests,
  getCachedAvatarObjectUrl,
  invalidateAvatarUrl,
  loadCachedAvatarUrl,
  resolveAvatarUrlForDisplay,
} from '@/services/avatar/avatarCache'
import { storage } from '@/services/storage/storageAdapter'
import { ensureLocalStorageMock } from '@/__tests__/testUtils'

interface MockCache {
  entries: Map<string, Response>
  match: ReturnType<typeof vi.fn>
  put: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
}

let objectUrlCounter = 0
let mockCache: MockCache

beforeEach(() => {
  ensureLocalStorageMock()
  clearAvatarMemoryCacheForTests()
  objectUrlCounter = 0
  mockCache = createMockCache()

  ;(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = undefined
  storage.removeItem('msgnr.desktop.backend_base_url')

  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => `blob:avatar-${++objectUrlCounter}`),
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  })
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: {
      open: vi.fn(async () => mockCache as unknown as Cache),
    },
  })
  vi.stubGlobal('fetch', vi.fn(async () => new Response('avatar-bytes', { status: 200 })))
})

describe('avatarCache', () => {
  it('resolves relative avatar urls against the configured Tauri backend', () => {
    ;(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
    storage.setItem('msgnr.desktop.backend_base_url', 'http://localhost:8080')

    expect(resolveAvatarUrlForDisplay('/api/public/avatars/avatars/user-1/avatar.png'))
      .toBe('http://localhost:8080/api/public/avatars/avatars/user-1/avatar.png')
  })

  it('dedupes concurrent loads and reuses the in-memory object url', async () => {
    const first = loadCachedAvatarUrl('/api/public/avatars/avatars/user-1/avatar.png')
    const second = loadCachedAvatarUrl('/api/public/avatars/avatars/user-1/avatar.png')

    await expect(first).resolves.toBe('blob:avatar-1')
    await expect(second).resolves.toBe('blob:avatar-1')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(getCachedAvatarObjectUrl('/api/public/avatars/avatars/user-1/avatar.png')).toBe('blob:avatar-1')

    await expect(loadCachedAvatarUrl('/api/public/avatars/avatars/user-1/avatar.png')).resolves.toBe('blob:avatar-1')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('uses a persistent Cache Storage hit without fetching', async () => {
    mockCache.entries.set(
      new URL('/api/public/avatars/avatars/user-2/avatar.png', window.location.href).toString(),
      new Response('cached-avatar', { status: 200 }),
    )

    await expect(loadCachedAvatarUrl('/api/public/avatars/avatars/user-2/avatar.png')).resolves.toBe('blob:avatar-1')

    expect(mockCache.match).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('invalidates memory and persistent cache entries', async () => {
    await loadCachedAvatarUrl('/api/public/avatars/avatars/user-3/avatar.png')

    await invalidateAvatarUrl('/api/public/avatars/avatars/user-3/avatar.png')

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:avatar-1')
    expect(mockCache.delete).toHaveBeenCalledTimes(1)
    expect(getCachedAvatarObjectUrl('/api/public/avatars/avatars/user-3/avatar.png')).toBe('')
  })

  it('does not repopulate memory from an invalidated in-flight avatar load', async () => {
    let resolveFetch: (response: Response) => void = () => {}
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve
    }))

    const load = loadCachedAvatarUrl('/api/public/avatars/avatars/user-5/old.png')
    await Promise.resolve()

    await invalidateAvatarUrl('/api/public/avatars/avatars/user-5/old.png')
    resolveFetch(new Response('old-avatar', { status: 200 }))

    await expect(load).resolves.toBe('/api/public/avatars/avatars/user-5/old.png')
    expect(getCachedAvatarObjectUrl('/api/public/avatars/avatars/user-5/old.png')).toBe('')
    expect(mockCache.put).not.toHaveBeenCalled()
  })

  it('falls back to the direct url when the avatar fetch is not cacheable', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('missing', { status: 404 }))

    await expect(loadCachedAvatarUrl('/api/public/avatars/avatars/user-4/missing.png'))
      .resolves.toBe('/api/public/avatars/avatars/user-4/missing.png')

    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('evicts the least-recently-used object urls once the memory cache is bounded', async () => {
    for (let index = 0; index < 200; index += 1) {
      await loadCachedAvatarUrl(`/api/public/avatars/avatars/user-${index}/avatar.png`)
    }
    expect(getCachedAvatarObjectUrl('/api/public/avatars/avatars/user-0/avatar.png')).toBe('blob:avatar-1')
    await loadCachedAvatarUrl('/api/public/avatars/avatars/user-200/avatar.png')

    expect(getCachedAvatarObjectUrl('/api/public/avatars/avatars/user-0/avatar.png')).toBe('blob:avatar-1')
    expect(getCachedAvatarObjectUrl('/api/public/avatars/avatars/user-1/avatar.png')).toBe('')
    expect(getCachedAvatarObjectUrl('/api/public/avatars/avatars/user-200/avatar.png')).toBe('blob:avatar-201')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:avatar-2')
  })
})

function createMockCache(): MockCache {
  const entries = new Map<string, Response>()
  return {
    entries,
    match: vi.fn(async (request: Request) => entries.get(request.url) ?? null),
    put: vi.fn(async (request: Request, response: Response) => {
      entries.set(request.url, response)
    }),
    delete: vi.fn(async (request: Request) => entries.delete(request.url)),
  }
}
