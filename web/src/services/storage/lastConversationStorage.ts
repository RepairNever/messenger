import { storage } from '@/services/storage/storageAdapter'

const LAST_CONVERSATION_BY_USER_KEY = 'msgnr:last-conversation-by-user:v1'
const LAST_CONVERSATION_GLOBAL_KEY = 'msgnr:last-conversation:global:v1'

type LastConversationBucket = Record<string, string>

function scopeKey(workspaceId: string, userId: string): string {
  return `${workspaceId}:${userId}`
}

function getStoredValue(key: string): string | null {
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

function setStoredValue(key: string, value: string) {
  try {
    storage.setItem(key, value)
  } catch {
    // Last-opened conversation is an optional startup optimisation.
  }
}

function removeStoredValue(key: string) {
  try {
    storage.removeItem(key)
  } catch {
    // Last-opened conversation is an optional startup optimisation.
  }
}

function readBucket(): LastConversationBucket {
  const raw = getStoredValue(LAST_CONVERSATION_BY_USER_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const normalized: LastConversationBucket = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && v) normalized[k] = v
    }
    return normalized
  } catch {
    return {}
  }
}

function writeBucket(bucket: LastConversationBucket) {
  setStoredValue(LAST_CONVERSATION_BY_USER_KEY, JSON.stringify(bucket))
}

export function loadLastOpenedConversation(workspaceId: string, userId: string): string {
  const bucket = readBucket()
  if (workspaceId && userId) {
    const scoped = bucket[scopeKey(workspaceId, userId)] ?? ''
    if (scoped) return scoped
  }
  return getStoredValue(LAST_CONVERSATION_GLOBAL_KEY) ?? ''
}

export function saveLastOpenedConversation(workspaceId: string, userId: string, conversationId: string) {
  if (!conversationId) return
  if (workspaceId && userId) {
    const bucket = readBucket()
    bucket[scopeKey(workspaceId, userId)] = conversationId
    writeBucket(bucket)
  }
  setStoredValue(LAST_CONVERSATION_GLOBAL_KEY, conversationId)
}

export function clearLastOpenedConversation(workspaceId: string, userId: string) {
  if (workspaceId && userId) {
    const bucket = readBucket()
    delete bucket[scopeKey(workspaceId, userId)]
    writeBucket(bucket)
  }
  removeStoredValue(LAST_CONVERSATION_GLOBAL_KEY)
}

export function clearAllLastOpenedConversations() {
  removeStoredValue(LAST_CONVERSATION_BY_USER_KEY)
  removeStoredValue(LAST_CONVERSATION_GLOBAL_KEY)
}
