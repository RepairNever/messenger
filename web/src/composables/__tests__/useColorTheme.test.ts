import { describe, expect, it } from 'vitest'
import { COLOR_THEME_TOKEN_NAMES } from '@/services/theme/themes'
import { applyColorTheme, cssThemeTokenNames } from '@/composables/useColorTheme'
import { getColorTheme } from '@/services/theme/themes'

describe('useColorTheme', () => {
  it('maps every registry token to a css variable name', () => {
    expect(Object.keys(cssThemeTokenNames).sort()).toEqual([...COLOR_THEME_TOKEN_NAMES].sort())
    expect(cssThemeTokenNames.inlineCodeText).toBe('inline-code-text')
  })

  it('applies theme and color scheme datasets without unused hex variables', () => {
    applyColorTheme(getColorTheme('light'))

    expect(document.documentElement.dataset.colorTheme).toBe('light')
    expect(document.documentElement.dataset.colorScheme).toBe('light')
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toBe('37 99 235')
    expect(document.documentElement.style.getPropertyValue('--color-inline-code-text')).toBe('29 78 216')
    expect(document.documentElement.style.getPropertyValue('--color-accent-hex')).toBe('')
  })
})
