import { storage } from '@/services/storage/storageAdapter'

export function loadSidebarWidth(key: string, fallback: number): number {
  const raw = storage.getItem(key)
  if (!raw) return fallback

  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback

  return Math.round(parsed)
}

export function saveSidebarWidth(key: string, width: number) {
  storage.setItem(key, String(Math.round(width)))
}

export function clearSidebarWidth(key: string) {
  storage.removeItem(key)
}
