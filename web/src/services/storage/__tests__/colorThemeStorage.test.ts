import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COLOR_THEME_STORAGE_KEY,
  loadColorThemeId,
  saveColorThemeId,
} from '@/services/storage/colorThemeStorage'
import { storage } from '@/services/storage/storageAdapter'

describe('colorThemeStorage', () => {
  beforeEach(() => {
    storage.clear()
  })

  it('falls back to dark when storage is empty', () => {
    expect(loadColorThemeId()).toBe('dark')
  })

  it('falls back to dark for invalid stored ids', () => {
    storage.setItem(COLOR_THEME_STORAGE_KEY, 'solarized')
    expect(loadColorThemeId()).toBe('dark')
  })

  it('loads and saves a valid theme id', () => {
    saveColorThemeId('pink')
    expect(storage.getItem(COLOR_THEME_STORAGE_KEY)).toBe('pink')
    expect(loadColorThemeId()).toBe('pink')
  })

  it('tolerates local storage failures', () => {
    const getSpy = vi.spyOn(storage, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(loadColorThemeId()).toBe('dark')
    getSpy.mockRestore()

    const setSpy = vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(() => saveColorThemeId('light')).not.toThrow()
    setSpy.mockRestore()
  })
})
