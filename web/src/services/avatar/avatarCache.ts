import { isTauriRuntime } from '@/platform/runtime'
import { resolveApiBaseUrl } from '@/services/runtime/backendEndpoint'

const AVATAR_CACHE_NAME = 'msgnr-avatars-v1'
const MAX_MEMORY_CACHE_ENTRIES = 200

const memoryCache = new Map<string, string>()
const inflightLoads = new Map<string, Promise<string>>()
const invalidationVersions = new Map<string, number>()

export function resolveAvatarUrlForDisplay(rawUrl: string): string {
  const raw = rawUrl.trim()
  if (!raw) return ''
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(raw) || raw.startsWith('//')) return raw
  if (!isTauriRuntime()) return raw

  const base = resolveApiBaseUrl().trim()
  if (!base || base === '/') return raw

  try {
    return new URL(raw, `${base.replace(/\/+$/, '')}/`).toString()
  } catch {
    return raw
  }
}

export function getCachedAvatarObjectUrl(rawUrl: string): string {
  const url = resolveAvatarUrlForDisplay(rawUrl)
  if (!url) return ''
  const cached = memoryCache.get(url)
  if (!cached) return ''
  touchMemoryEntry(url, cached)
  return cached
}

export async function loadCachedAvatarUrl(rawUrl: string): Promise<string> {
  const url = resolveAvatarUrlForDisplay(rawUrl)
  if (!url) return ''

  const cached = memoryCache.get(url)
  if (cached) {
    touchMemoryEntry(url, cached)
    return cached
  }

  const inflight = inflightLoads.get(url)
  if (inflight) return inflight

  const version = invalidationVersions.get(url) ?? 0
  const load = loadAvatarBlob(url, version)
    .then((result) => {
      if (typeof result === 'string') return result
      if ((invalidationVersions.get(url) ?? 0) !== version) return url
      return cacheBlobUrl(url, result)
    })
    .catch(() => url)
    .finally(() => {
      inflightLoads.delete(url)
    })
  inflightLoads.set(url, load)
  return load
}

export async function invalidateAvatarUrl(rawUrl: string): Promise<void> {
  const url = resolveAvatarUrlForDisplay(rawUrl)
  if (!url) return

  const cached = memoryCache.get(url)
  if (cached) {
    revokeObjectUrl(cached)
    memoryCache.delete(url)
  }
  invalidationVersions.set(url, (invalidationVersions.get(url) ?? 0) + 1)
  inflightLoads.delete(url)

  const cache = await openAvatarCache()
  if (!cache) return

  const request = createCacheRequest(url)
  if (!request) return

  try {
    await cache.delete(request)
  } catch {
    // Best effort. A failed persistent delete must not break identity updates.
  }
}

export async function invalidateUserAvatar(previousUrl: string, nextUrl: string): Promise<void> {
  const previous = resolveAvatarUrlForDisplay(previousUrl)
  const next = resolveAvatarUrlForDisplay(nextUrl)
  if (!previous || previous === next) return
  await invalidateAvatarUrl(previousUrl)
}

export function clearAvatarMemoryCacheForTests(): void {
  for (const objectUrl of memoryCache.values()) {
    revokeObjectUrl(objectUrl)
  }
  memoryCache.clear()
  inflightLoads.clear()
  invalidationVersions.clear()
}

async function loadAvatarBlob(url: string, version: number): Promise<Blob | string> {
  if (!canLoadBlobUrl()) return url

  const request = createCacheRequest(url)
  const cache = await openAvatarCache()
  const cachedResponse = request ? await matchCachedResponse(cache, request) : null
  if (cachedResponse) {
    const blob = await cachedResponse.blob()
    return (invalidationVersions.get(url) ?? 0) === version ? blob : url
  }

  const response = await fetch(url, { credentials: 'same-origin' })
  if (!response.ok) return url
  if ((invalidationVersions.get(url) ?? 0) !== version) return url

  if (cache && request) {
    try {
      await cache.put(request, response.clone())
    } catch {
      // Cache storage can reject opaque, quota-limited, or interrupted writes.
    }
  }

  const blob = await response.blob()
  return (invalidationVersions.get(url) ?? 0) === version ? blob : url
}

function canLoadBlobUrl(): boolean {
  return typeof fetch === 'function'
    && typeof Request === 'function'
    && typeof Blob === 'function'
    && typeof URL.createObjectURL === 'function'
}

function createCacheRequest(url: string): Request | null {
  const requestUrl = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(url) || url.startsWith('//')
    ? url
    : new URL(url, globalThis.location?.href ?? 'http://localhost/').toString()
  try {
    return new Request(requestUrl)
  } catch {
    return null
  }
}

async function openAvatarCache(): Promise<Cache | null> {
  if (typeof caches === 'undefined' || typeof caches.open !== 'function') return null
  try {
    return await caches.open(AVATAR_CACHE_NAME)
  } catch {
    return null
  }
}

async function matchCachedResponse(cache: Cache | null, request: Request): Promise<Response | null> {
  if (!cache) return null
  try {
    const response = await cache.match(request)
    return response && response.ok ? response : null
  } catch {
    return null
  }
}

function cacheBlobUrl(url: string, blob: Blob): string {
  const objectUrl = URL.createObjectURL(blob)
  const previous = memoryCache.get(url)
  if (previous) {
    revokeObjectUrl(previous)
  }
  memoryCache.delete(url)
  memoryCache.set(url, objectUrl)
  while (memoryCache.size > MAX_MEMORY_CACHE_ENTRIES) {
    const oldest = memoryCache.entries().next().value as [string, string] | undefined
    if (!oldest) break
    memoryCache.delete(oldest[0])
    revokeObjectUrl(oldest[1])
  }
  return objectUrl
}

function touchMemoryEntry(url: string, objectUrl: string): void {
  memoryCache.delete(url)
  memoryCache.set(url, objectUrl)
}

function revokeObjectUrl(objectUrl: string): void {
  if (typeof URL.revokeObjectURL !== 'function') return
  try {
    URL.revokeObjectURL(objectUrl)
  } catch {
    // Best effort cleanup.
  }
}
