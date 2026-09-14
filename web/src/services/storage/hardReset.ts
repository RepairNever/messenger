import { getBackendBaseUrl, setBackendBaseUrl } from '@/services/runtime/backendEndpoint'
import { clearAllData, deleteDatabase } from '@/services/db/cache'
import { storage } from '@/services/storage/storageAdapter'
import { clearStoredTokensAsync } from '@/services/storage/tokenStorage'
import { COLOR_THEME_STORAGE_KEY } from '@/services/storage/colorThemeStorage'

async function clearCacheStorage(): Promise<void> {
  if (typeof caches === 'undefined') return
  try {
    const names = await caches.keys()
    await Promise.all(names.map((name) => caches.delete(name)))
  } catch {
    // Best effort cleanup.
  }
}

function clearSessionStorage(): void {
  try {
    globalThis.sessionStorage?.clear()
  } catch {
    // Best effort cleanup.
  }
}

/**
 * Clears all persisted client data for the current origin.
 * The desktop backend URL is preserved and restored after the wipe.
 */
export async function clearAllPersistedClientDataPreservingBackendUrl(): Promise<void> {
  const preservedBackendUrl = getBackendBaseUrl()
  let preservedColorTheme: string | null = null
  try {
    preservedColorTheme = storage.getItem(COLOR_THEME_STORAGE_KEY)
  } catch {
    preservedColorTheme = null
  }

  await clearStoredTokensAsync()

  try {
    storage.clear()
  } catch {
    // Best effort cleanup.
  }

  clearSessionStorage()

  await Promise.allSettled([
    clearAllData(),
    deleteDatabase(),
    clearCacheStorage(),
  ])

  if (preservedBackendUrl) {
    try {
      setBackendBaseUrl(preservedBackendUrl)
    } catch {
      // Ignore invalid persisted value.
    }
  }

  if (preservedColorTheme) {
    try {
      storage.setItem(COLOR_THEME_STORAGE_KEY, preservedColorTheme)
    } catch {
      // Best-effort preference restore.
    }
  }
}
