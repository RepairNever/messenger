import type { PlatformType } from '@/platform/types'

export function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false
  const win = window as Window & {
    __TAURI__?: unknown
    __TAURI_INTERNALS__?: unknown
  }

  if (win.__TAURI__ || win.__TAURI_INTERNALS__) return true

  // Fallback for some packaged shells where globals are scoped but UA still carries Tauri marker.
  return typeof navigator !== 'undefined' && /\bTauri\b/i.test(navigator.userAgent)
}

export function getRuntimePlatformType(): PlatformType {
  return isTauriRuntime() ? 'tauri' : 'pwa'
}
