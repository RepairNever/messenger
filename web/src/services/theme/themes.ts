export const COLOR_THEME_IDS = ['dark', 'light', 'pink', 'rose'] as const

export type ThemeId = typeof COLOR_THEME_IDS[number]

export const COLOR_THEME_TOKEN_NAMES = [
  'bgPrimary',
  'bgSecondary',
  'bgTertiary',
  'surface',
  'surfaceHover',
  'input',
  'divider',
  'textPrimary',
  'textSecondary',
  'textMuted',
  'textOnAccent',
  'accent',
  'accentHover',
  'accentText',
  'selectionBg',
  'selectionText',
  'selectionBorder',
  'taskIdText',
  'taskIdBg',
  'statusGreen',
  'statusRed',
  'statusAmber',
  'sidebarBg',
  'sidebarHover',
  'sidebarText',
  'sidebarTextMuted',
  'sidebarHeading',
  'sidebarUnreadBadge',
  'inlineCodeText',
] as const

export type ColorThemeTokenName = typeof COLOR_THEME_TOKEN_NAMES[number]
export type ColorThemeTokens = Record<ColorThemeTokenName, string>

export interface ColorTheme {
  id: ThemeId
  label: string
  swatches: readonly string[]
  tokens: ColorThemeTokens
  colorScheme: 'dark' | 'light'
}

export const colorThemes: readonly ColorTheme[] = [
  {
    id: 'dark',
    label: 'Dark',
    colorScheme: 'dark',
    swatches: ['#0E0F13', '#14161B', '#382D63', '#E0A854'],
    // Keep these defaults mirrored in style.css :root to avoid a flash before JS applies the stored theme.
    tokens: {
      bgPrimary: '#0E0F13',
      bgSecondary: '#14161B',
      bgTertiary: '#1A1D24',
      surface: '#14161B',
      surfaceHover: '#22252C',
      input: '#1A1D24',
      divider: '#262A33',
      textPrimary: '#E9EBF0',
      textSecondary: '#B4B8C2',
      textMuted: '#82868F',
      textOnAccent: '#FFFFFF',
      accent: '#382D63',
      accentHover: '#382B6B',
      accentText: '#607ccd',
      selectionBg: '#382D63',
      selectionText: '#FFFFFF',
      selectionBorder: '#382B6B',
      taskIdText: '#E0A854',
      taskIdBg: '#2E2718',
      statusGreen: '#4CD48A',
      statusRed: '#F26D6D',
      statusAmber: '#FBBF24',
      sidebarBg: '#14161B',
      sidebarHover: '#22252C',
      sidebarText: '#C4C8D0',
      sidebarTextMuted: '#82868F',
      sidebarHeading: '#6E737E',
      sidebarUnreadBadge: '#FFBEBE',
      inlineCodeText: '#C4B5FD',
    },
  },
  {
    id: 'light',
    label: 'Light',
    colorScheme: 'light',
    swatches: ['#FFFFFF', '#F8FAFC', '#2563EB', '#FEF3C7'],
    tokens: {
      bgPrimary: '#FFFFFF',
      bgSecondary: '#F8FAFC',
      bgTertiary: '#F1F5F9',
      surface: '#FFFFFF',
      surfaceHover: '#F1F5F9',
      input: '#FFFFFF',
      divider: '#E2E8F0',
      textPrimary: '#0F172A',
      textSecondary: '#64748B',
      textMuted: '#94A3B8',
      textOnAccent: '#FFFFFF',
      accent: '#2563EB',
      accentText: '#2563EB',
      accentHover: '#1D4ED8',
      selectionBg: '#EFF6FF',
      selectionText: '#0F172A',
      selectionBorder: '#2563EB',
      taskIdText: '#92400E',
      taskIdBg: '#FEF3C7',
      statusGreen: '#22C55E',
      statusRed: '#EF4444',
      statusAmber: '#D97706',
      sidebarBg: '#F8FAFC',
      sidebarHover: '#F1F5F9',
      sidebarText: '#334155',
      sidebarTextMuted: '#64748B',
      sidebarHeading: '#475569',
      sidebarUnreadBadge: '#FFFFFF',
      inlineCodeText: '#1D4ED8',
    },
  },
  {
    id: 'pink',
    label: 'Pink',
    colorScheme: 'light',
    swatches: ['#FFF7FB', '#FCE7F3', '#DB2777', '#FDF2F8'],
    tokens: {
      bgPrimary: '#FFF7FB',
      bgSecondary: '#FDF2F8',
      bgTertiary: '#FCE7F3',
      surface: '#FFFFFF',
      surfaceHover: '#FCE7F3',
      input: '#FFFFFF',
      divider: '#F3C4D9',
      textPrimary: '#20111A',
      textSecondary: '#735066',
      textMuted: '#9D7189',
      textOnAccent: '#FFFFFF',
      accent: '#DB2777',
      accentText: '#DB2777',
      accentHover: '#BE185D',
      selectionBg: '#FCE7F3',
      selectionText: '#20111A',
      selectionBorder: '#DB2777',
      taskIdText: '#8A3C0D',
      taskIdBg: '#FEF3C7',
      statusGreen: '#16A34A',
      statusRed: '#E11D48',
      statusAmber: '#C2410C',
      sidebarBg: '#FDF2F8',
      sidebarHover: '#FCE7F3',
      sidebarText: '#4A2438',
      sidebarTextMuted: '#87536F',
      sidebarHeading: '#A53D72',
      sidebarUnreadBadge: '#FFFFFF',
      inlineCodeText: '#BE185D',
    },
  },
  {
    id: 'rose',
    label: 'Rose',
    colorScheme: 'light',
    swatches: ['#FFF5F7', '#FFE9F4', '#F1B3BE', '#D598A3'],
    tokens: {
      bgPrimary: '#FFF5F7',
      bgSecondary: '#FFE9F4',
      bgTertiary: '#FFDBE6',
      surface: '#FFFFFF',
      surfaceHover: '#FFE9F4',
      input: '#FFFFFF',
      divider: '#FFDBE6',
      textPrimary: '#4A3539',
      textSecondary: '#8E767A',
      textMuted: '#A99095',
      textOnAccent: '#4A3539',
      accent: '#F1B3BE',
      accentText: '#F1B3BE',
      accentHover: '#E3A5B0',
      selectionBg: '#FFCED9',
      selectionText: '#4A3539',
      selectionBorder: '#D598A3',
      taskIdText: '#8E4F5A',
      taskIdBg: '#FFE9F4',
      statusGreen: '#2FBF7B',
      statusRed: '#E05268',
      statusAmber: '#B87838',
      sidebarBg: '#FFE9F4',
      sidebarHover: '#FFDBE6',
      sidebarText: '#5E4449',
      sidebarTextMuted: '#8E767A',
      sidebarHeading: '#B86F7C',
      sidebarUnreadBadge: '#FFFFFF',
      inlineCodeText: '#8E4F5A',
    },
  },
]

export const DEFAULT_COLOR_THEME_ID: ThemeId = 'dark'

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && COLOR_THEME_IDS.includes(value as ThemeId)
}

export function getColorTheme(id: unknown): ColorTheme {
  const safeId = isThemeId(id) ? id : DEFAULT_COLOR_THEME_ID
  return colorThemes.find((theme) => theme.id === safeId) ?? colorThemes[0]
}

export function hasCompleteThemeTokens(theme: ColorTheme): boolean {
  return COLOR_THEME_TOKEN_NAMES.every((tokenName) => typeof theme.tokens[tokenName] === 'string' && theme.tokens[tokenName].trim().length > 0)
}
