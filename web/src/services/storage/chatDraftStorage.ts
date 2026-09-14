import { storage } from '@/services/storage/storageAdapter'
import type { MessageEntity, MessageEntityKind } from '@/stores/chat'

export interface ChatDraft {
  body: string
  entities: MessageEntity[]
}

export type ChatDraftScope =
  | {
      kind: 'conversation'
      conversationId: string
    }
  | {
      kind: 'thread'
      conversationId: string
      rootMessageId: string
    }

type ChatDraftMap = Record<string, ChatDraft>

const CHAT_DRAFTS_STORAGE_KEY = 'msgnr:chat:drafts:v1'

const EMPTY_DRAFT: ChatDraft = {
  body: '',
  entities: [],
}

function isMessageEntityKind(value: unknown): value is MessageEntityKind {
  return value === 'user' || value === 'task' || value === 'document'
}

function normalizeEntity(raw: unknown, bodyLength: number): MessageEntity | null {
  if (!raw || typeof raw !== 'object') return null
  const entity = raw as Partial<MessageEntity>
  const start = Number.isFinite(entity.start) ? Math.trunc(entity.start as number) : NaN
  const end = Number.isFinite(entity.end) ? Math.trunc(entity.end as number) : NaN
  if (!isMessageEntityKind(entity.kind)) return null
  if (typeof entity.targetId !== 'string' || typeof entity.label !== 'string' || typeof entity.href !== 'string') return null
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start < 0 || end <= start || end > bodyLength) return null
  return {
    kind: entity.kind,
    targetId: entity.targetId,
    label: entity.label,
    href: entity.href,
    start,
    end,
  }
}

function normalizeDraft(raw: unknown): ChatDraft {
  if (!raw || typeof raw !== 'object') return EMPTY_DRAFT
  const value = raw as Partial<ChatDraft>
  const body = typeof value.body === 'string' ? value.body : ''
  const entities = Array.isArray(value.entities)
    ? value.entities
      .map(entity => normalizeEntity(entity, body.length))
      .filter((entity): entity is MessageEntity => entity !== null)
    : []
  return {
    body,
    entities,
  }
}

function loadDraftMap(): ChatDraftMap {
  const raw = storage.getItem(CHAT_DRAFTS_STORAGE_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const next: ChatDraftMap = {}
    for (const [key, value] of Object.entries(parsed)) {
      next[key] = normalizeDraft(value)
    }
    return next
  } catch {
    return {}
  }
}

function saveDraftMap(drafts: ChatDraftMap) {
  if (Object.keys(drafts).length === 0) {
    storage.removeItem(CHAT_DRAFTS_STORAGE_KEY)
    return
  }
  storage.setItem(CHAT_DRAFTS_STORAGE_KEY, JSON.stringify(drafts))
}

export function getChatDraftScopeKey(scope: ChatDraftScope): string {
  if (scope.kind === 'conversation') {
    return `conversation:${scope.conversationId}`
  }
  return `thread:${scope.conversationId}:${scope.rootMessageId}`
}

export function loadChatDraft(scope: ChatDraftScope): ChatDraft {
  const drafts = loadDraftMap()
  return drafts[getChatDraftScopeKey(scope)] ?? EMPTY_DRAFT
}

export function saveChatDraft(scope: ChatDraftScope, draft: ChatDraft) {
  const key = getChatDraftScopeKey(scope)
  const nextDraft = normalizeDraft(draft)
  const drafts = loadDraftMap()
  if (nextDraft.body.trim() === '' && nextDraft.entities.length === 0) {
    delete drafts[key]
    saveDraftMap(drafts)
    return
  }
  drafts[key] = nextDraft
  saveDraftMap(drafts)
}

export function clearChatDraft(scope: ChatDraftScope) {
  const key = getChatDraftScopeKey(scope)
  const drafts = loadDraftMap()
  delete drafts[key]
  saveDraftMap(drafts)
}

export function clearAllChatDrafts() {
  storage.removeItem(CHAT_DRAFTS_STORAGE_KEY)
}
