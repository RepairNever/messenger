import Dexie, { type EntityTable } from 'dexie'
import type { UserCustomStatus } from '@/types/userStatus'

// ── Cached entity types ───────────────────────────────────────────────────────
// BigInt is not supported by IndexedDB structured clone, so sequence numbers
// are stored as decimal strings and converted on read/write boundaries.

export interface CachedConversation {
  id: string
  type: 'channel' | 'dm'
  /** Channel name or DM display name */
  name: string
  visibility?: 'public' | 'private' | 'dm'
  /** DM peer user ID */
  userId?: string
  /** DM peer avatar URL */
  avatarUrl?: string
  /** DM peer presence */
  presence?: string
  /** DM peer custom status */
  customStatus?: UserCustomStatus | null
  /** DM encryption mode */
  encryptionMode?: 'none' | 'dm_pairwise_signal_v1'
  unread: number
  hasUnreadThreadReplies?: boolean
  /** bigint as decimal string */
  lastMessageSeq?: string
  lastActivityAt?: string
  /** 0=ALL, 1=MENTIONS_ONLY, 2=NOTHING */
  notificationLevel?: number
  updatedAt: string
}

export interface CachedMessage {
  id: string
  conversationId: string
  senderId: string
  senderName: string
  senderAvatarUrl?: string
  body: string
  forwardedFrom?: {
    messageId: string
    senderId: string
    senderName: string
    conversationKind?: string
    conversationTitle?: string
    threadTitle?: string
  }
  entities?: Array<{
    kind: 'user' | 'task' | 'document'
    targetId: string
    label: string
    href: string
    start: number
    end: number
  }>
  /** bigint as decimal string */
  channelSeq: string
  /** bigint as decimal string */
  threadSeq: string
  threadRootMessageId?: string
  mentionedUserIds: string[]
  mentionEveryone: boolean
  createdAt: string
  editedAt?: string
  reactions: Array<{ emoji: string; count: number }>
  myReactions: string[]
  attachments?: Array<{
    id: string
    fileName: string
    fileSize: number
    mimeType: string
    thumbnailMimeType?: string
    thumbnailFileSize?: number
    thumbnailVersion?: number
  }>
}

export interface CachedUserProfile {
  id: string
  email: string
  displayName: string
  avatarUrl?: string
  role?: string
  customStatus?: UserCustomStatus | null
}

export interface CachedDraft {
  conversationId: string
  body: string
  updatedAt: string
}

export interface QueuedOutboundAction {
  id?: number
  conversationId: string
  body: string
  entities?: Array<{
    kind: 'user' | 'task' | 'document'
    targetId: string
    label: string
    href: string
    start: number
    end: number
  }>
  clientMsgId: string
  threadRootMessageId?: string
  attachmentIds?: string[]
  attachments?: Array<{
    id: string
    fileName: string
    fileSize: number
    mimeType: string
    thumbnailMimeType?: string
    thumbnailFileSize?: number
    thumbnailVersion?: number
  }>
  createdAt: string
}

export interface CachedThreadSummary {
  /** Composite key: `${userId}:${rootMessageId}` */
  key: string
  userId: string
  rootMessageId: string
  replyCount: number
  /** bigint as decimal string */
  lastThreadSeq: string
  lastReplyAt?: string
  lastReplyUserId?: string
}

// ── Database definition ───────────────────────────────────────────────────────

class MsgnrDB extends Dexie {
  conversations!: EntityTable<CachedConversation, 'id'>
  messages!: EntityTable<CachedMessage, 'id'>
  userProfile!: EntityTable<CachedUserProfile, 'id'>
  drafts!: EntityTable<CachedDraft, 'conversationId'>
  outboundQueue!: EntityTable<QueuedOutboundAction, 'id'>
  threadSummaries!: EntityTable<CachedThreadSummary, 'key'>

  constructor() {
    super('msgnr')
    this.version(1).stores({
      conversations: 'id, lastActivityAt',
      messages: 'id, conversationId',
      userProfile: 'id',
      drafts: 'conversationId',
      outboundQueue: '++id, clientMsgId, createdAt',
      threadSummaries: 'key, userId',
    })
  }
}

/** Singleton database instance. */
export const db = new MsgnrDB()
