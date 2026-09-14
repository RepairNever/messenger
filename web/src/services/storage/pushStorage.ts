import { storage } from '@/services/storage/storageAdapter'

const PUSH_ENDPOINT_KEY = 'msgnr:push-endpoint'

/**
 * Persist the active push subscription endpoint so we can detect
 * subscription state synchronously (without async SW calls).
 */
export function savePushEndpoint(endpoint: string) {
  storage.setItem(PUSH_ENDPOINT_KEY, endpoint)
}

export function loadPushEndpoint(): string | null {
  return storage.getItem(PUSH_ENDPOINT_KEY)
}

export function clearPushEndpoint() {
  storage.removeItem(PUSH_ENDPOINT_KEY)
}
