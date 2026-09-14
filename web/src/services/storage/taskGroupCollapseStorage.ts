import { storage } from '@/services/storage/storageAdapter'

const TASK_GROUP_COLLAPSED_KEY = 'msgnr:tasks:group-collapsed:v1'

export function loadCollapsedTaskStatusIds(): string[] {
  const raw = storage.getItem(TASK_GROUP_COLLAPSED_KEY)
  if (!raw) return []
  try {
    const decoded = JSON.parse(raw)
    if (!Array.isArray(decoded)) return []
    return decoded.filter((value): value is string => typeof value === 'string' && value.trim() !== '')
  } catch {
    return []
  }
}

export function saveCollapsedTaskStatusIds(statusIds: string[]) {
  const unique = Array.from(new Set(statusIds.filter(id => id.trim() !== '')))
  storage.setItem(TASK_GROUP_COLLAPSED_KEY, JSON.stringify(unique))
}

export function clearCollapsedTaskStatusIds() {
  storage.removeItem(TASK_GROUP_COLLAPSED_KEY)
}
