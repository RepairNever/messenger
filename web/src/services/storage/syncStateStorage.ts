import { storage } from '@/services/storage/storageAdapter'

const LAST_APPLIED_EVENT_SEQ_KEY = 'msgnr:last-applied-event-seq'

export function loadLastAppliedEventSeq(): bigint {
  let raw: string | null
  try {
    raw = storage.getItem(LAST_APPLIED_EVENT_SEQ_KEY)
  } catch {
    return 0n
  }
  if (!raw) return 0n
  try {
    return BigInt(raw)
  } catch {
    return 0n
  }
}

export function saveLastAppliedEventSeq(value: bigint): boolean {
  try {
    storage.setItem(LAST_APPLIED_EVENT_SEQ_KEY, value.toString())
    return true
  } catch {
    // Private-mode/quota failures must not escape websocket handlers. The
    // caller can withhold its matching ACK and retry persistence later.
    return false
  }
}

export function clearLastAppliedEventSeq() {
  try {
    storage.removeItem(LAST_APPLIED_EVENT_SEQ_KEY)
  } catch {
    // Non-fatal; the next authenticated bootstrap remains authoritative.
  }
}
