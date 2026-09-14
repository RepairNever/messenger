type StorageLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  clear(): void
}

function normalizeStorage(raw: unknown): StorageLike {
  if (raw
    && typeof (raw as any).getItem === 'function'
    && typeof (raw as any).setItem === 'function'
    && typeof (raw as any).removeItem === 'function'
    && typeof (raw as any).clear === 'function') {
    return raw as StorageLike
  }

  const initialBag: Record<string, string> = {}
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'string') initialBag[key] = value
    }
  }

  const bag: Record<string, string> = { ...initialBag }
  const normalized: StorageLike = {
    getItem(key: string): string | null {
      const value = bag[key]
      return typeof value === 'string' ? value : null
    },
    setItem(key: string, value: string): void {
      bag[key] = String(value)
    },
    removeItem(key: string): void {
      delete bag[key]
    },
    clear(): void {
      for (const key of Object.keys(bag)) {
        delete bag[key]
      }
    },
  }
  return normalized
}

let rawStorage: unknown
try {
  rawStorage = (globalThis as { localStorage?: unknown }).localStorage
} catch {
  rawStorage = undefined
}

export const storage: StorageLike = normalizeStorage(rawStorage)
