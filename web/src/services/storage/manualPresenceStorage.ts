import { storage } from '@/services/storage/storageAdapter'

export type ManualPresence = 'online' | 'away'

const MANUAL_PRESENCE_KEY = 'msgnr:manual-presence'

export function loadManualPresencePreference(): ManualPresence | null {
  const raw = storage.getItem(MANUAL_PRESENCE_KEY)
  if (raw === 'online' || raw === 'away') return raw
  return null
}

export function saveManualPresencePreference(value: ManualPresence) {
  storage.setItem(MANUAL_PRESENCE_KEY, value)
}

export function clearManualPresencePreference() {
  storage.removeItem(MANUAL_PRESENCE_KEY)
}
