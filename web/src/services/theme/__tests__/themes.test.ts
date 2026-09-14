import { describe, expect, it } from 'vitest'
import {
  COLOR_THEME_TOKEN_NAMES,
  colorThemes,
  getColorTheme,
  hasCompleteThemeTokens,
} from '@/services/theme/themes'

describe('themes', () => {
  it('ships complete token sets for every theme', () => {
    expect(colorThemes.map((theme) => theme.id)).toEqual(['dark', 'light', 'pink', 'rose'])
    for (const theme of colorThemes) {
      expect(hasCompleteThemeTokens(theme)).toBe(true)
      expect(Object.keys(theme.tokens).sort()).toEqual([...COLOR_THEME_TOKEN_NAMES].sort())
    }
  })

  it('falls back to dark for unknown ids', () => {
    expect(getColorTheme('unknown').id).toBe('dark')
  })

  it('uses the approved navy palette for dark', () => {
    expect(getColorTheme('dark').tokens).toEqual({
      bgPrimary: '#0D1118',
      bgSecondary: '#0A0D14',
      bgTertiary: '#181E29',
      surface: '#0D1118',
      surfaceHover: '#141A24',
      input: '#121720',
      divider: '#303A4C',
      textPrimary: '#EDF2FA',
      textSecondary: '#BFCBDD',
      textMuted: '#8696AD',
      textOnAccent: '#FFFFFF',
      accent: '#3B82F6',
      accentHover: '#60A5FA',
      selectionBg: '#2563EB',
      selectionText: '#FFFFFF',
      selectionBorder: '#60A5FA',
      taskIdText: '#E0A854',
      taskIdBg: '#2E2718',
      statusGreen: '#34D399',
      statusRed: '#F87171',
      statusAmber: '#FBBF24',
      sidebarBg: '#0A0D14',
      sidebarHover: '#181E29',
      sidebarText: '#CDD6E4',
      sidebarTextMuted: '#8291A8',
      sidebarHeading: '#606E86',
      sidebarUnreadBadge: '#FFBEBE',
      inlineCodeText: '#60A5FA',
    })
  })
})
