import { computed, ref } from 'vue'
import { colorThemes, getColorTheme, type ColorTheme, type ColorThemeTokenName, type ThemeId } from '@/services/theme/themes'
import { loadColorThemeId, saveColorThemeId } from '@/services/storage/colorThemeStorage'
import { hexToRgbTriplet } from '@/utils/color'

const currentThemeId = ref<ThemeId>(loadColorThemeId())

export const cssThemeTokenNames: Record<ColorThemeTokenName, string> = {
  bgPrimary: 'bg-primary',
  bgSecondary: 'bg-secondary',
  bgTertiary: 'bg-tertiary',
  surface: 'surface',
  surfaceHover: 'surface-hover',
  input: 'input',
  divider: 'divider',
  textPrimary: 'text-primary',
  textSecondary: 'text-secondary',
  textMuted: 'text-muted',
  textOnAccent: 'text-on-accent',
  accent: 'accent',
  accentHover: 'accent-hover',
  selectionBg: 'selection-bg',
  selectionText: 'selection-text',
  selectionBorder: 'selection-border',
  taskIdText: 'task-id',
  taskIdBg: 'task-id-bg',
  statusGreen: 'status-green',
  statusRed: 'status-red',
  statusAmber: 'status-amber',
  sidebarBg: 'sidebar-bg',
  sidebarHover: 'sidebar-hover',
  sidebarText: 'sidebar-text',
  sidebarTextMuted: 'sidebar-text-muted',
  sidebarHeading: 'sidebar-heading',
  sidebarUnreadBadge: 'sidebar-unread-badge',
  inlineCodeText: 'inline-code-text',
}

export function applyColorTheme(theme: ColorTheme): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset.colorTheme = theme.id
  root.dataset.colorScheme = theme.colorScheme
  root.style.colorScheme = theme.colorScheme
  for (const [tokenName, cssName] of Object.entries(cssThemeTokenNames) as Array<[ColorThemeTokenName, string]>) {
    root.style.setProperty(`--color-${cssName}`, hexToRgbTriplet(theme.tokens[tokenName]))
  }
}

export function applyStoredColorTheme(): void {
  applyColorTheme(getColorTheme(currentThemeId.value))
}

export function setColorTheme(themeId: ThemeId): void {
  currentThemeId.value = themeId
  saveColorThemeId(themeId)
  applyColorTheme(getColorTheme(themeId))
}

export function useColorTheme() {
  const currentTheme = computed(() => getColorTheme(currentThemeId.value))
  return {
    themes: colorThemes,
    currentTheme,
    currentThemeId,
    setTheme: setColorTheme,
  }
}
