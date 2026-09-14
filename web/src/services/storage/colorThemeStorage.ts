import { DEFAULT_COLOR_THEME_ID, isThemeId, type ThemeId } from '@/services/theme/themes'
import { storage } from '@/services/storage/storageAdapter'

export const COLOR_THEME_STORAGE_KEY = 'msgnr:color-theme:v1'

export function loadColorThemeId(): ThemeId {
  try {
    const stored = storage.getItem(COLOR_THEME_STORAGE_KEY)
    return isThemeId(stored) ? stored : DEFAULT_COLOR_THEME_ID
  } catch {
    return DEFAULT_COLOR_THEME_ID
  }
}

export function saveColorThemeId(themeId: ThemeId): void {
  try {
    storage.setItem(COLOR_THEME_STORAGE_KEY, themeId)
  } catch {
    // Best-effort preference persistence.
  }
}
