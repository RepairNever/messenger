import { storage } from '@/services/storage/storageAdapter'
import {
  isUuidTaskRouteValue,
  taskPublicIdFromSlug,
} from '@/services/taskRoute'

const LEGACY_LAST_TASK_ID_KEY = 'msgnr:last-task-id:global:v1'
const LAST_TASK_PUBLIC_ID_KEY = 'msgnr:last-task-public-id:global:v2'

function normalizeStoredPublicId(value: string | null): string {
  const normalized = value?.trim() ?? ''
  if (!normalized || isUuidTaskRouteValue(normalized)) return ''
  return taskPublicIdFromSlug(normalized)
}

function clearLegacyLastTaskId() {
  storage.removeItem(LEGACY_LAST_TASK_ID_KEY)
}

export function loadLastOpenedTaskPublicId(): string {
  const currentValue = normalizeStoredPublicId(storage.getItem(LAST_TASK_PUBLIC_ID_KEY))
  if (currentValue) {
    return currentValue
  }
  storage.removeItem(LAST_TASK_PUBLIC_ID_KEY)

  const legacyValue = normalizeStoredPublicId(storage.getItem(LEGACY_LAST_TASK_ID_KEY))
  clearLegacyLastTaskId()
  if (!legacyValue) return ''

  storage.setItem(LAST_TASK_PUBLIC_ID_KEY, legacyValue)
  return legacyValue
}

export function saveLastOpenedTaskPublicId(publicId: string) {
  const normalized = normalizeStoredPublicId(publicId)
  if (!normalized) return
  storage.setItem(LAST_TASK_PUBLIC_ID_KEY, normalized)
}

export function clearLastOpenedTaskPublicId() {
  storage.removeItem(LAST_TASK_PUBLIC_ID_KEY)
  clearLegacyLastTaskId()
}
