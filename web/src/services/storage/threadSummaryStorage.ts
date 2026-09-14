import { storage } from '@/services/storage/storageAdapter'

const THREAD_SUMMARIES_STORAGE_KEY = 'msgnr:thread-summaries:v1'

export function clearStoredThreadSummaries() {
  storage.removeItem(THREAD_SUMMARIES_STORAGE_KEY)
}
