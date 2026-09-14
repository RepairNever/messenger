import { storage } from '@/services/storage/storageAdapter'
import { generateId } from '@/services/id'

const CLIENT_INSTANCE_ID_KEY = 'msgnr:client-instance-id'

export function getClientInstanceId(): string | null {
  return storage.getItem(CLIENT_INSTANCE_ID_KEY)
}

export function getOrCreateClientInstanceId(): string {
  const existing = getClientInstanceId()
  if (existing) return existing
  const generated = generateId()
  storage.setItem(CLIENT_INSTANCE_ID_KEY, generated)
  return generated
}

export function clearClientInstanceId() {
  storage.removeItem(CLIENT_INSTANCE_ID_KEY)
}
