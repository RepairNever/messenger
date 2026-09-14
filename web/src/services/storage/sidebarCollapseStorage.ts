import { storage } from '@/services/storage/storageAdapter'

const SIDEBAR_COLLAPSED_KEY = 'msgnr:sidebar-collapsed:v1'

export function loadSidebarCollapsed(): boolean {
  const raw = storage.getItem(SIDEBAR_COLLAPSED_KEY)
  if (raw === 'true') return true
  if (raw === 'false') return false
  return false
}

export function saveSidebarCollapsed(collapsed: boolean) {
  storage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? 'true' : 'false')
}

export function clearSidebarCollapsed() {
  storage.removeItem(SIDEBAR_COLLAPSED_KEY)
}
