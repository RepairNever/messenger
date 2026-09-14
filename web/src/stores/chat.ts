import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import {
  CallStatus,
  ConversationEncryptionMode,
  ConversationType,
  MessageContentMode,
  NotificationLevel,
  NotificationType,
  PresenceStatus,
  WorkspaceRole,
} from '@/shared/proto/packets_pb'
import type {
  ServerEvent,
  SendMessageAck,
  ReactionAck,
  SubscribeThreadResponse,
  MessageEvent as ProtoMessageEvent,
  ThreadSummaryUpdatedEvent,
  ReactionUpdatedEvent,
  MessageUpdatedEvent,
  MessageDeletedEvent,
  DmHistoryClearedEvent,
  BootstrapResponse,
  SyncSinceResponse,
  AckResponse,
  ReadCursorAck,
  ConversationSummary,
  ReadCounterUpdatedEvent,
  NotificationAddedEvent,
  NotificationLevelChangedEvent,
  CallStateChangedEvent,
  CallRaisedHandsChangedEvent,
  CallRaisedHand,
  CallInviteCreatedEvent,
  CallInviteCancelledEvent,
  TaskStatusChangedEvent,
  NotificationResolvedEvent,
  NotificationSummary,
  ActiveCallSummary,
  CallInviteSummary,
  PresenceEvent,
  MessageAlertEvent,
  UserCallPresenceChangedEvent,
} from '@/shared/proto/packets_pb'
import { useWsStore } from '@/stores/ws'
import { useAuthStore } from '@/stores/auth'
import { loadLastAppliedEventSeq, saveLastAppliedEventSeq } from '@/services/storage/syncStateStorage'
import { storage } from '@/services/storage/storageAdapter'
import {
  loadLastOpenedConversation,
  saveLastOpenedConversation,
  clearLastOpenedConversation,
} from '@/services/storage/lastConversationStorage'
import { ChatApiError, clearDMConversationHistory as clearDMConversationHistoryApi, forwardMessage as forwardMessageApi, getMessageContext, listConversationMessages, listDmCandidates, listSavedMessages, listUnreadFeed, resolveUnreadFeedNotification, saveMessage as saveMessageApi, unsaveMessage as unsaveMessageApi } from '@/services/http/chatApi'
import type {
  ConversationMessageItem,
  MessageEntityItem,
  SavedMessageItem as HttpSavedMessageItem,
  UnreadFeedItem as HttpUnreadFeedItem,
} from '@/services/http/chatApi'
import { decryptDMMessage, localEncryptedDMDeviceId } from '@/services/e2ee/dmE2ee'
import type { MessageEntity as ProtoMessageEntity } from '@/shared/proto/packets_pb'
import { getOrCreateClientInstanceId } from '@/services/storage/clientInstanceStorage'
import { generateId } from '@/services/id'
import { decodeNotificationText } from '@/services/notificationText'
import { getPlatformOrNull } from '@/platform'
import {
  cacheConversations,
  loadCachedConversations,
  cacheMessages,
  clearCachedMessages,
  loadCachedMessages,
  cacheThreadSummaries,
  loadCachedThreadSummaries,
} from '@/services/db/cache'
import {
  isUserCustomStatusActive,
  userCustomStatusFromDto,
  userCustomStatusFromProto,
  type UserCustomStatus,
} from '@/types/userStatus'
import { invalidateUserAvatar } from '@/services/avatar/avatarCache'
import {
  OUTBOUND_PERSISTENCE_FAILURE_REASON,
  useOfflineQueue,
  type PendingOutboundMessage,
} from '@/composables/useOfflineQueue'

// ── Domain types ──────────────────────────────────────────────────────────────

export interface Channel {
  id: string
  name: string
  kind: 'channel' | 'dm'
  visibility: 'public' | 'private' | 'dm'
  unread: number
  hasUnreadThreadReplies?: boolean
  lastMessageSeq?: bigint
  lastActivityAt?: string
  notificationLevel: NotificationLevel
}

export interface DirectMessage {
  id: string
  userId: string
  displayName: string
  avatarUrl?: string
  customStatus?: UserCustomStatus | null
  presence: 'online' | 'away' | 'offline'
  encryptionMode?: 'none' | 'dm_pairwise_signal_v1'
  unread: number
  hasUnreadThreadReplies?: boolean
  lastMessageSeq?: bigint
  notificationLevel: NotificationLevel
}

export interface ActiveConversation {
  id: string
  title: string
  kind: 'channel' | 'dm'
  visibility: 'public' | 'private' | 'dm'
  encryptionMode?: 'none' | 'dm_pairwise_signal_v1'
  unread: number
}

export interface ReactionCount {
  emoji: string
  count: number
}

export interface MessageAttachment {
  id: string
  fileName: string
  fileSize: number
  mimeType: string
  thumbnailMimeType?: string
  thumbnailFileSize?: number
  thumbnailVersion?: number
}

export type MessageEntityKind = 'user' | 'task' | 'document'

export interface MessageEntity {
  kind: MessageEntityKind
  targetId: string
  label: string
  href: string
  start: number
  end: number
}

export interface ForwardedMessage {
  messageId: string
  senderId: string
  senderName: string
  conversationKind?: string
  conversationTitle?: string
  threadTitle?: string
}

export type SendStatus = 'sending' | 'queued' | 'failed'

export interface Message {
  id: string
  channelId: string
  senderId: string
  senderName: string
  senderAvatarUrl?: string
  body: string
  forwardedFrom?: ForwardedMessage
  entities?: MessageEntity[]
  channelSeq: bigint
  threadSeq: bigint
  threadRootMessageId?: string
  mentionedUserIds: string[]
  mentionEveryone: boolean
  createdAt: string
  editedAt?: string
  reactions: ReactionCount[]
  myReactions: string[]
  attachments?: MessageAttachment[]
  isSaved?: boolean
  contentMode?: 'plaintext' | 'dm_pairwise_signal_v1'
  senderDeviceId?: string
  encryptedDMPayloads?: Array<{
    recipient_device_id: string
    sender_device_id: string
    algorithm: string
    session_message: string
    metadata_aad: string
  }>
  clientMsgId?: string
  /** @deprecated Use sendStatus instead. Kept temporarily for migration. */
  pending?: boolean
  /** Delivery status: 'sending' | 'queued' | 'failed' | undefined (confirmed). */
  sendStatus?: SendStatus
  /** Human-readable reason when sendStatus is 'failed'. */
  failReason?: string
  /** Internal: true once a server event or replay confirmed this thread reply. */
  serverConfirmed?: boolean
}

interface PendingReactionOp {
  channelId: string
  messageId: string
  emoji: string
  op: 'add' | 'remove'
  timeout: ReturnType<typeof setTimeout>
}

interface ToastState {
  id: number
  message: string
}

export interface ThreadSummary {
  replyCount: number
  lastThreadSeq: bigint
  lastReplyAt?: string
  lastReplyUserId?: string
}

export interface WorkspaceShell {
  id: string
  name: string
  selfUserId: string
  selfDisplayName: string
  selfAvatarUrl?: string
  selfCustomStatus?: UserCustomStatus | null
  selfRole: string
}

export interface NotificationItem {
  id: string
  type: string
  title: string
  body: string
  conversationId: string
  messageId?: string
  threadRootMessageId?: string
  isRead: boolean
  createdAt: string
}

export type ChatViewMode = 'conversation' | 'unread' | 'saved'

export interface UnreadFeedItem {
  id: string
  kind: 'message' | 'mention' | 'thread'
  notificationId?: string
  conversationId: string
  conversationKind: 'channel' | 'dm'
  conversationVisibility: 'public' | 'private' | 'dm'
  conversationTitle: string
  messageId?: string
  threadRootMessageId?: string
  senderId?: string
  senderName: string
  body: string
  createdAt: string
}

export interface SavedMessageItem {
  id: string
  conversationId: string
  conversationKind: 'channel' | 'dm'
  conversationVisibility: 'public' | 'private' | 'dm'
  conversationTitle: string
  messageId: string
  threadRootMessageId?: string
  senderId: string
  senderName: string
  body: string
  forwardedFrom?: ForwardedMessage
  entities?: MessageEntity[]
  createdAt: string
  savedAt: string
}

export interface ActiveCallItem {
  id: string
  conversationId: string
  status: string
  participantCount: number
  raisedHands?: RaisedHand[]
}

export type RaisedHand = Pick<CallRaisedHand, 'userId' | 'position'>

export interface PendingInviteItem {
  id: string
  callId: string
  conversationId: string
  inviterUserId: string
  state: string
  createdAt: string
  expiresAt: string
}

export interface IncomingMessageNotification {
  reason: 'message_alert' | 'mention' | 'notification'
  conversationId: string
  messageId?: string
  threadRootMessageId?: string
  senderId: string
  senderName: string
  body: string
  attachmentCount: number
}

export type IncomingMessageNotificationHandler = (evt: IncomingMessageNotification) => void

export interface TaskStatusChangedNotification {
  taskId: string
  publicId: string
  fromStatusId: string
  toStatusId: string
  updatedBy: string
  updatedAt: string
}

export type TaskStatusChangedNotificationHandler = (evt: TaskStatusChangedNotification) => void

export interface TypingState {
  userId: string
  expiresAt?: string
}

interface StoredThreadSummary {
  replyCount: number
  lastThreadSeq: string
  lastReplyAt?: string
  lastReplyUserId?: string
}

type StoredThreadSummariesByUser = Record<string, Record<string, StoredThreadSummary>>

interface BootstrapStage {
  snapshotSeq: bigint
  workspace: WorkspaceShell | null
  conversations: ConversationSummary[]
  notifications: NotificationSummary[]
  activeCalls: ActiveCallSummary[]
  userCallPresence: Map<string, number>
  pendingInvites: CallInviteSummary[]
  unread: Map<string, { unreadMessages: number; unreadMentions: number; hasUnreadThreadReplies: boolean }>
  presence: Map<string, PresenceEvent>
}

function normalizeMessageEntities(raw: Array<MessageEntityItem | ProtoMessageEntity> | undefined | null): MessageEntity[] {
  return (raw ?? []).map(entity => ({
    kind: typeof entity.kind === 'string'
      ? entity.kind
      : entity.kind === 1
        ? 'user'
        : entity.kind === 2
          ? 'task'
          : 'document',
    targetId: 'target_id' in entity ? entity.target_id : entity.targetId,
    label: entity.label,
    href: entity.href,
    start: entity.start,
    end: entity.end,
  }))
}

function normalizeForwardedMessage(raw: ConversationMessageItem['forwarded_from'] | HttpSavedMessageItem['forwarded_from'] | undefined | null): ForwardedMessage | undefined {
  if (!raw?.message_id || !raw.sender_id || !raw.sender_name?.trim()) return undefined
  return {
    messageId: raw.message_id,
    senderId: raw.sender_id,
    senderName: decodeNotificationText(raw.sender_name),
    conversationKind: raw.conversation_kind?.trim() || undefined,
    conversationTitle: raw.conversation_title?.trim() ? decodeNotificationText(raw.conversation_title) : undefined,
    threadTitle: raw.thread_title?.trim() ? decodeNotificationText(raw.thread_title) : undefined,
  }
}

function forwardedMessageFromProto(evt: ProtoMessageEvent): ForwardedMessage | undefined {
  if (!evt.forwardedFromMessageId || !evt.forwardedFromSenderId || !evt.forwardedFromSenderName.trim()) return undefined
  return {
    messageId: evt.forwardedFromMessageId,
    senderId: evt.forwardedFromSenderId,
    senderName: decodeNotificationText(evt.forwardedFromSenderName),
    conversationKind: evt.forwardedFromConversationKind.trim() || undefined,
    conversationTitle: evt.forwardedFromConversationTitle.trim() ? decodeNotificationText(evt.forwardedFromConversationTitle) : undefined,
    threadTitle: evt.forwardedFromThreadTitle.trim() ? decodeNotificationText(evt.forwardedFromThreadTitle) : undefined,
  }
}

function encryptionModeFromSummary(summary: ConversationSummary): DirectMessage['encryptionMode'] {
  switch (summary.encryptionMode) {
    case ConversationEncryptionMode.DM_PAIRWISE_SIGNAL_V1:
      return 'dm_pairwise_signal_v1'
    default:
      return 'none'
  }
}

function contentModeFromProto(mode: MessageContentMode): Message['contentMode'] {
  return mode === MessageContentMode.DM_PAIRWISE_SIGNAL_V1 ? 'dm_pairwise_signal_v1' : 'plaintext'
}

function mentionedUserIdsFromEntities(entities: MessageEntity[]): string[] {
  return entities.filter(entity => entity.kind === 'user').map(entity => entity.targetId)
}

function mentionedUserIdsFromPayload(
  rawEntities: Array<MessageEntityItem | ProtoMessageEntity> | undefined | null,
  fallbackMentionedUserIds: readonly string[] | undefined | null,
): string[] {
  const entities = normalizeMessageEntities(rawEntities)
  if (entities.length > 0) {
    return mentionedUserIdsFromEntities(entities)
  }
  return [...(fallbackMentionedUserIds ?? [])]
}

function unreadFeedItemFromHttp(item: HttpUnreadFeedItem): UnreadFeedItem {
  return {
    id: item.id,
    kind: item.kind,
    notificationId: item.notification_id || undefined,
    conversationId: item.conversation_id,
    conversationKind: item.conversation_kind,
    conversationVisibility: item.conversation_visibility,
    conversationTitle: decodeNotificationText(item.conversation_title),
    messageId: item.message_id || undefined,
    threadRootMessageId: item.thread_root_message_id || undefined,
    senderId: item.sender_id || undefined,
    senderName: decodeNotificationText(item.sender_name),
    body: decodeNotificationText(item.body),
    createdAt: item.created_at,
  }
}

function savedMessageItemFromHttp(item: HttpSavedMessageItem): SavedMessageItem {
  return {
    id: item.id,
    conversationId: item.conversation_id,
    conversationKind: item.conversation_kind,
    conversationVisibility: item.conversation_visibility,
    conversationTitle: decodeNotificationText(item.conversation_title),
    messageId: item.message_id,
    threadRootMessageId: item.thread_root_message_id || undefined,
    senderId: item.sender_id,
    senderName: decodeNotificationText(item.sender_name),
    body: item.body,
    forwardedFrom: normalizeForwardedMessage(item.forwarded_from),
    entities: normalizeMessageEntities(item.entities),
    createdAt: item.created_at,
    savedAt: item.saved_at,
  }
}

const ACK_BATCH_SIZE = 20
const ACK_INTERVAL_MS = 2000
const ACK_RESPONSE_TIMEOUT_MS = 15_000
const SYNC_CURSOR_PERSIST_DELAY_MS = 250
const SYNC_CURSOR_PERSIST_RETRY_MS = 2000
const SYNC_EVENT_CHUNK_SIZE = 25
const DEFAULT_SYNC_BATCH = 200
const MAX_BUFFERED_SERVER_EVENTS = 512
const REACTION_OP_TIMEOUT_MS = 8000
const TOAST_DURATION_MS = 2800
const THREAD_SUMMARIES_STORAGE_KEY = 'msgnr:thread-summaries:v1'
const THREAD_SUMMARY_PERSIST_DELAY_MS = 250
const DEBUG_REACTIONS = false

interface ConversationHistoryState {
  initialized: boolean
  loading: boolean
  hasMore: boolean
  nextBeforeChannelSeq?: bigint
}

function readStoredThreadSummaryBuckets(): StoredThreadSummariesByUser {
  let raw: string | null
  try {
    raw = storage.getItem(THREAD_SUMMARIES_STORAGE_KEY)
  } catch {
    return {}
  }
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as StoredThreadSummariesByUser
  } catch {
    return {}
  }
}

function loadThreadSummariesForUser(userId: string): Record<string, ThreadSummary> {
  if (!userId) return {}
  const all = readStoredThreadSummaryBuckets()
  const bucket = all[userId]
  if (!bucket || typeof bucket !== 'object') return {}

  const summaries: Record<string, ThreadSummary> = {}
  for (const [rootId, stored] of Object.entries(bucket)) {
    if (!stored || typeof stored !== 'object') continue
    const replyCount = Number.isFinite(stored.replyCount) ? Math.max(0, Math.floor(stored.replyCount)) : 0
    let lastThreadSeq = 0n
    try {
      lastThreadSeq = BigInt(stored.lastThreadSeq ?? '0')
    } catch {
      lastThreadSeq = BigInt(replyCount)
    }
    if (lastThreadSeq < 0n) lastThreadSeq = 0n
    const normalizedReplyCount = Math.max(replyCount, Number(lastThreadSeq))
    summaries[rootId] = {
      replyCount: normalizedReplyCount,
      lastThreadSeq,
      lastReplyAt: stored.lastReplyAt,
      lastReplyUserId: stored.lastReplyUserId,
    }
  }
  return summaries
}

async function saveThreadSummariesForUser(userId: string, summaries: Record<string, ThreadSummary>) {
  if (!userId) return
  // Write to localStorage (synchronous fallback for bootstrap)
  const all = readStoredThreadSummaryBuckets()
  const nextBucket: Record<string, StoredThreadSummary> = {}
  for (const [rootId, summary] of Object.entries(summaries)) {
    nextBucket[rootId] = {
      replyCount: Math.max(0, Math.floor(summary.replyCount)),
      lastThreadSeq: summary.lastThreadSeq.toString(),
      lastReplyAt: summary.lastReplyAt,
      lastReplyUserId: summary.lastReplyUserId,
    }
  }
  all[userId] = nextBucket
  try {
    storage.setItem(THREAD_SUMMARIES_STORAGE_KEY, JSON.stringify(all))
  } catch {
    // The cache is an optimisation. A quota/privacy-mode failure must not
    // escape a websocket event handler and stall sync acknowledgement.
  }
  // Serialize IndexedDB replacements so an older async write cannot complete
  // after a newer summary snapshot.
  await cacheThreadSummaries(userId, summaries)
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useChatStore = defineStore('chat', () => {
  const channels = ref<Channel[]>([])
  const directMessages = ref<DirectMessage[]>([])
  const activeChannelId = ref<string>('')
  const chatViewMode = ref<ChatViewMode>('conversation')
  const workspace = ref<WorkspaceShell | null>(null)
  const notifications = ref<NotificationItem[]>([])
  const activeCalls = ref<ActiveCallItem[]>([])
  const userCallPresenceByUserId = ref<Record<string, number>>({})
  const pendingInvites = ref<PendingInviteItem[]>([])
  const presenceByUserId = ref<Record<string, PresenceEvent>>({})
  const typingByConversationId = ref<Record<string, TypingState[]>>({})
  const bootstrapped = ref(false)
  /** True when UI is showing data loaded from IndexedDB cache, before server bootstrap. */
  const cachedBootstrap = ref(false)

  const messages = ref<Record<string, Message[]>>({})
  const conversationHistoryState = new Map<string, ConversationHistoryState>()
  const conversationInitialLoadingById = ref<Record<string, boolean>>({})
  const threadMessages = ref<Record<string, Message[]>>({})
  const threadReplayVersionByRoot = ref<Record<string, number>>({})
  const threadReplayStatusByRoot = ref<Record<string, 'idle' | 'loading' | 'error'>>({})
  const threadSummaries = ref<Record<string, ThreadSummary>>({})
  const activeThreadRootId = ref('')
  const activeThreadConversationId = ref('')
  const focusedMessageId = ref('')
  const focusedThreadMessageId = ref('')
  const conversationComposerFocusToken = ref(0)
  const threadComposerFocusToken = ref(0)
  const unreadFeedItems = ref<UnreadFeedItem[]>([])
  const unreadFeedTotalCount = ref(0)
  const unreadFeedLoading = ref(false)
  const unreadFeedError = ref('')
  const unreadFeedLoaded = ref(false)
  const unreadFeedRefreshQueued = ref(false)
  const savedMessageItems = ref<SavedMessageItem[]>([])
  const savedMessageTotalCount = ref(0)
  const savedMessagesLoading = ref(false)
  const savedMessagesError = ref('')
  const savedMessagesLoaded = ref(false)
  const userNames = ref<Record<string, string>>({})
  const userEmails = ref<Record<string, string>>({})
  const userAvatars = ref<Record<string, string>>({})
  const userCustomStatuses = ref<Record<string, UserCustomStatus | null>>({})
  const pendingReactionOps = ref<Record<string, PendingReactionOp>>({})
  /** Tracks active send timeouts by clientMsgId. Cleared on ACK or discard. */
  const sendTimeouts = new Map<string, ReturnType<typeof setTimeout>>()
  const threadReplayResyncTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const threadReplayResponseWatchdogs = new Map<string, ReturnType<typeof setTimeout>>()
  const incompleteThreadReplayResponses = new Map<string, number>()
  const pendingThreadReadResolutions = new Map<string, Promise<void>>()
  const toast = ref<ToastState | null>(null)
  const lastAppliedEventSeq = ref<bigint>(loadLastAppliedEventSeq())
  const lastAckedEventSeq = ref<bigint>(0n)

  const activeChannel = computed(() =>
    channels.value.find(c => c.id === activeChannelId.value) ?? null
  )
  const activeConversation = computed<ActiveConversation | null>(() => {
    const channel = channels.value.find(c => c.id === activeChannelId.value)
    if (channel) {
      return {
        id: channel.id,
        title: channel.name,
        kind: channel.kind,
        visibility: channel.visibility,
        unread: channel.unread,
      }
    }
    const dm = directMessages.value.find(item => item.id === activeChannelId.value)
    if (!dm) return null
    return {
      id: dm.id,
      title: dm.displayName,
      kind: 'dm',
      visibility: 'dm',
      encryptionMode: dm.encryptionMode ?? 'none',
      unread: dm.unread,
    }
  })

  const activeMessages = computed(() =>
    messages.value[activeChannelId.value] ?? []
  )

  function getConversationById(conversationId: string): ActiveConversation | null {
    const channel = channels.value.find(c => c.id === conversationId)
    if (channel) {
      return {
        id: channel.id,
        title: channel.name,
        kind: channel.kind,
        visibility: channel.visibility,
        unread: channel.unread,
      }
    }
    const dm = directMessages.value.find(item => item.id === conversationId)
    if (!dm) return null
    return {
      id: dm.id,
      title: dm.displayName,
      kind: 'dm',
      visibility: 'dm',
      encryptionMode: dm.encryptionMode ?? 'none',
      unread: dm.unread,
    }
  }

  function getMessagesForConversation(conversationId: string): Message[] {
    return messages.value[conversationId] ?? []
  }

  function encryptedDMHistoryDeviceId(conversationId: string): string | undefined {
    const dm = directMessages.value.find(item => item.id === conversationId)
    if (dm?.encryptionMode !== 'dm_pairwise_signal_v1') return undefined
    return localEncryptedDMDeviceId()
  }

  function getTypingForConversation(conversationId: string): TypingState[] {
    return typingByConversationId.value[conversationId] ?? []
  }

  function getThreadRoot(conversationId: string, rootId: string): Message | null {
    if (!conversationId || !rootId) return null
    return messages.value[conversationId]?.find(item => item.id === rootId) ?? null
  }

  function getThreadReplies(rootId: string): Message[] {
    const list = [...(threadMessages.value[rootId] ?? [])]
    list.sort((a, b) => {
      if (a.threadSeq !== b.threadSeq) return Number(a.threadSeq - b.threadSeq)
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    })
    return list
  }
  const isThreadPanelOpen = computed(() =>
    activeThreadRootId.value !== '' && activeThreadConversationId.value !== ''
  )
  const activeThreadRootMessage = computed(() => {
    if (!isThreadPanelOpen.value) return null
    return messages.value[activeThreadConversationId.value]?.find(item => item.id === activeThreadRootId.value) ?? null
  })
  const activeThreadReplies = computed(() => {
    if (!isThreadPanelOpen.value) return []
    const root = activeThreadRootId.value
    const list = [...(threadMessages.value[root] ?? [])]
    list.sort((a, b) => {
      if (a.threadSeq !== b.threadSeq) return Number(a.threadSeq - b.threadSeq)
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    })
    return list
  })
  const activeThreadReplayVersion = computed(() => {
    if (!isThreadPanelOpen.value) return 0
    return threadReplayVersionByRoot.value[activeThreadRootId.value] ?? 0
  })

  let bootstrapStage: BootstrapStage | null = null
  let bootstrapPresenceOverlay = new Map<string, PresenceEvent>()
  let bufferedServerEvents: ServerEvent[] = []
  let seenEventIds = new Set<string>()
  // This intentionally survives runtime resets. A response started for a
  // previous account/session must never be able to match a newly created
  // request for the same conversation id after its per-conversation token map
  // has been cleared.
  let historyLoadToken = 0
  let messageStateGeneration = 0
  let decryptionSessionGeneration = 0
  const secretHistoryGeneration = new Map<string, number>()
  const historyLoadTokenByConversation = new Map<string, number>()
  let ackTimer: ReturnType<typeof setTimeout> | null = null
  let ackScheduleGeneration = 0
  let ackRetryPending = false
  let pendingAckEventCount = 0
  let ackInFlight = false
  let ackResponseTimer: ReturnType<typeof setTimeout> | null = null
  let syncCursorPersistTimer: ReturnType<typeof setTimeout> | null = null
  let syncCursorPersistDirty = false
  let lastPersistedSyncCursor = lastAppliedEventSeq.value
  let syncReplayGeneration = 0
  let syncReplayProcessing = false
  const pendingSyncResponses: SyncSinceResponse[] = []
  let threadSummaryPersistTimer: ReturnType<typeof setTimeout> | null = null
  let threadSummaryPersistInFlight = false
  let threadSummaryPersistDirty = false
  const messageCacheTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const pendingMessageCaches = new Map<string, Message[]>()
  const messageCacheInFlight = new Set<string>()
  const pendingReadByConversation = new Map<string, bigint>()
  let clientIsActive = true
  let clientInstanceId = getOrCreateClientInstanceId()
  let userDirectoryHydrated = false
  let userDirectoryPromise: Promise<void> | null = null
  let toastTimer: ReturnType<typeof setTimeout> | null = null
  let unreadFeedRefreshTimer: ReturnType<typeof setTimeout> | null = null
  const incomingMessageNotificationHandlers = new Set<IncomingMessageNotificationHandler>()
  const taskStatusChangedNotificationHandlers = new Set<TaskStatusChangedNotificationHandler>()
  const DEBUG_CONVERSATION_OPEN_PERF = import.meta.env.DEV

  function persistThreadSummaries() {
    const userId = workspace.value?.selfUserId ?? ''
    if (!userId) return
    threadSummaryPersistDirty = true
    if (threadSummaryPersistTimer || threadSummaryPersistInFlight) return
    threadSummaryPersistTimer = setTimeout(() => {
      threadSummaryPersistTimer = null
      void flushThreadSummaryPersistence()
    }, THREAD_SUMMARY_PERSIST_DELAY_MS)
  }

  async function flushThreadSummaryPersistence() {
    if (threadSummaryPersistInFlight || !threadSummaryPersistDirty) return
    const userId = workspace.value?.selfUserId ?? ''
    if (!userId) return

    threadSummaryPersistDirty = false
    threadSummaryPersistInFlight = true
    try {
      await saveThreadSummariesForUser(userId, threadSummaries.value)
    } finally {
      threadSummaryPersistInFlight = false
      if (threadSummaryPersistDirty && !threadSummaryPersistTimer) {
        persistThreadSummaries()
      }
    }
  }

  function scheduleMessageCache(conversationId: string, list: Message[]) {
    if (!conversationId) return
    pendingMessageCaches.set(conversationId, list)
    if (messageCacheTimers.has(conversationId) || messageCacheInFlight.has(conversationId)) return
    messageCacheTimers.set(conversationId, setTimeout(() => {
      messageCacheTimers.delete(conversationId)
      void flushMessageCache(conversationId)
    }, THREAD_SUMMARY_PERSIST_DELAY_MS))
  }

  async function flushMessageCache(conversationId: string) {
    if (messageCacheInFlight.has(conversationId)) return
    const list = pendingMessageCaches.get(conversationId)
    if (!list) return
    pendingMessageCaches.delete(conversationId)
    messageCacheInFlight.add(conversationId)
    try {
      await cacheMessages(conversationId, list)
    } finally {
      messageCacheInFlight.delete(conversationId)
      if (pendingMessageCaches.has(conversationId) && !messageCacheTimers.has(conversationId)) {
        scheduleMessageCache(conversationId, pendingMessageCaches.get(conversationId) ?? [])
      }
    }
  }

  function cancelScheduledMessageCache(conversationId: string) {
    const timer = messageCacheTimers.get(conversationId)
    if (timer) clearTimeout(timer)
    messageCacheTimers.delete(conversationId)
    pendingMessageCaches.delete(conversationId)
  }

  function bumpThreadReplayVersion(rootId: string) {
    if (!rootId) return
    threadReplayVersionByRoot.value = {
      ...threadReplayVersionByRoot.value,
      [rootId]: (threadReplayVersionByRoot.value[rootId] ?? 0) + 1,
    }
  }

  function upsertThreadSummary(rootId: string, summary: ThreadSummary) {
    threadSummaries.value[rootId] = summary
    persistThreadSummaries()
  }

  function clearThreadReplayResyncTimer(rootId: string) {
    const timer = threadReplayResyncTimers.get(rootId)
    if (!timer) return
    clearTimeout(timer)
    threadReplayResyncTimers.delete(rootId)
  }

  function clearAllThreadReplayResyncTimers() {
    for (const timer of threadReplayResyncTimers.values()) {
      clearTimeout(timer)
    }
    threadReplayResyncTimers.clear()
  }

  const THREAD_REPLAY_RESPONSE_TIMEOUT_MS = 15_000

  function clearThreadReplayResponseWatchdog(rootId: string) {
    const timeout = threadReplayResponseWatchdogs.get(rootId)
    if (!timeout) return
    clearTimeout(timeout)
    threadReplayResponseWatchdogs.delete(rootId)
  }

  function clearAllThreadReplayResponseWatchdogs() {
    for (const timeout of threadReplayResponseWatchdogs.values()) {
      clearTimeout(timeout)
    }
    threadReplayResponseWatchdogs.clear()
  }

  function armThreadReplayResponseWatchdog(conversationId: string, rootId: string) {
    clearThreadReplayResponseWatchdog(rootId)
    const timeout = setTimeout(() => {
      if (threadReplayResponseWatchdogs.get(rootId) !== timeout) return
      threadReplayResponseWatchdogs.delete(rootId)
      if (!isClientTabActive()) return
      if (!isActiveThreadWorkspace(conversationId, rootId)) return

      const ws = useWsStore()
      if (ws.state !== 'LIVE_SYNCED') return
      ws.invalidateTransport('Thread replay did not receive a response')
    }, THREAD_REPLAY_RESPONSE_TIMEOUT_MS)
    threadReplayResponseWatchdogs.set(rootId, timeout)
  }

  function highestConfirmedThreadSeq(rootId: string): bigint {
    const list = threadMessages.value[rootId] ?? []
    return list.reduce((max, message) => {
      if (!message.serverConfirmed || message.sendStatus || message.pending) return max
      return message.threadSeq > max ? message.threadSeq : max
    }, 0n)
  }

  function confirmedThreadReplyCount(rootId: string): number {
    const list = threadMessages.value[rootId] ?? []
    return list.reduce((count, message) => {
      if (!message.serverConfirmed || message.sendStatus || message.pending) return count
      return count + 1
    }, 0)
  }

  function isThreadReplayCacheIncomplete(rootId: string): boolean {
    const summary = threadSummaries.value[rootId]
    if (!summary) return false
    return confirmedThreadReplyCount(rootId) < summary.replyCount
  }

  function threadReplayCursor(rootId: string): bigint {
    if (isThreadReplayCacheIncomplete(rootId)) return 0n
    return highestConfirmedThreadSeq(rootId)
  }

  function threadReplayStatus(rootId: string): 'idle' | 'loading' | 'error' {
    return threadReplayStatusByRoot.value[rootId] ?? 'idle'
  }

  function setThreadReplayStatus(rootId: string, status: 'idle' | 'loading' | 'error') {
    if (!rootId) return
    threadReplayStatusByRoot.value[rootId] = status
  }

  function subscribeThreadReplay(conversationId: string, rootId: string, fromStart = false): boolean {
    if (!conversationId || !rootId) return false
    clearThreadReplayResponseWatchdog(rootId)
    setThreadReplayStatus(rootId, 'loading')
    const cursor = fromStart ? 0n : threadReplayCursor(rootId)
    const sent = useWsStore().sendSubscribeThread(conversationId, rootId, cursor)
    if (sent && isActiveThreadWorkspace(conversationId, rootId)) {
      armThreadReplayResponseWatchdog(conversationId, rootId)
    }
    return sent
  }

  function requestThreadReplayRecovery(rootId: string, conversationId: string, fromStart = false) {
    if (!rootId || !conversationId) return
    clearThreadReplayResyncTimer(rootId)
    threadReplayResyncTimers.set(rootId, setTimeout(() => {
      threadReplayResyncTimers.delete(rootId)
      if (!isThreadPanelOpen.value) return
      if (activeThreadRootId.value !== rootId || activeThreadConversationId.value !== conversationId) return
      const ws = useWsStore()
      if (ws.state !== 'LIVE_SYNCED') return
      subscribeThreadReplay(conversationId, rootId, fromStart)
    }, 150))
  }

  function maybeRecoverActiveThread(rootId: string, conversationId: string, force = false) {
    if (!isThreadPanelOpen.value) return
    if (activeThreadRootId.value !== rootId || activeThreadConversationId.value !== conversationId) return
    if (force) {
      requestThreadReplayRecovery(rootId, conversationId, true)
      return
    }
    const summary = threadSummaries.value[rootId]
    if (!summary) return
    const highestConfirmedSeq = highestConfirmedThreadSeq(rootId)
    if (summary.lastThreadSeq <= highestConfirmedSeq && !isThreadReplayCacheIncomplete(rootId)) return
    requestThreadReplayRecovery(rootId, conversationId)
  }

  function logConversationPerf(label: string, payload?: unknown) {
    if (!DEBUG_CONVERSATION_OPEN_PERF) return
    if (typeof payload === 'undefined') {
      console.debug(`[perf][conversation-open] ${label}`)
      return
    }
    console.debug(`[perf][conversation-open] ${label}`, payload)
  }

  function setChannels(list: Channel[]) {
    channels.value = list
    for (const ch of list) {
      if (!messages.value[ch.id]) messages.value[ch.id] = []
    }
  }

  function getOrCreateHistoryState(conversationId: string): ConversationHistoryState {
    const existing = conversationHistoryState.get(conversationId)
    if (existing) return existing
    const next: ConversationHistoryState = {
      initialized: false,
      loading: false,
      hasMore: true,
    }
    conversationHistoryState.set(conversationId, next)
    return next
  }

  function isConversationHistoryLoading(conversationId: string): boolean {
    if (!conversationId) return false
    return getOrCreateHistoryState(conversationId).loading
  }

  function isConversationInitialLoading(conversationId: string): boolean {
    if (!conversationId) return false
    return conversationInitialLoadingById.value[conversationId] === true
  }

  function conversationHasMoreHistory(conversationId: string): boolean {
    if (!conversationId) return false
    return getOrCreateHistoryState(conversationId).hasMore
  }

  function firstPublicChannelId(channelList: Channel[]): string {
    return channelList.find(channel => channel.visibility === 'public')?.id ?? ''
  }

  function conversationExistsInLists(conversationId: string, channelList: Channel[], dmList: DirectMessage[]): boolean {
    if (!conversationId) return false
    return channelList.some(channel => channel.id === conversationId) || dmList.some(dm => dm.id === conversationId)
  }

  function saveActiveConversationSelection(conversationId: string) {
    const authStore = useAuthStore()
    const workspaceId = workspace.value?.id || workspace.value?.name || ''
    const userId = workspace.value?.selfUserId || authStore.user?.id || ''
    if (!conversationId) return
    saveLastOpenedConversation(workspaceId, userId, conversationId)
  }

  function clearActiveConversationSelection() {
    const authStore = useAuthStore()
    const workspaceId = workspace.value?.id || workspace.value?.name || ''
    const userId = workspace.value?.selfUserId || authStore.user?.id || ''
    clearLastOpenedConversation(workspaceId, userId)
  }

  function resolveSnapshotActiveConversation(nextChannels: Channel[], nextDms: DirectMessage[], nextWorkspace: WorkspaceShell | null): string {
    const authStore = useAuthStore()
    const workspaceId = nextWorkspace?.id || nextWorkspace?.name || ''
    const userId = nextWorkspace?.selfUserId || authStore.user?.id || ''
    const persisted = loadLastOpenedConversation(workspaceId, userId)
    if (conversationExistsInLists(persisted, nextChannels, nextDms)) {
      return persisted
    }
    return firstPublicChannelId(nextChannels)
  }

  function showConversationView() {
    chatViewMode.value = 'conversation'
  }

  function showUnreadView() {
    chatViewMode.value = 'unread'
  }

  function showSavedView() {
    chatViewMode.value = 'saved'
  }

  function focusConversationMessage(messageId: string) {
    focusedMessageId.value = messageId
  }

  function focusThreadMessage(messageId: string) {
    focusedThreadMessageId.value = messageId
  }

  function requestConversationComposerFocus() {
    conversationComposerFocusToken.value += 1
  }

  function requestThreadComposerFocus() {
    threadComposerFocusToken.value += 1
  }

  function clearFocusedMessages() {
    focusedMessageId.value = ''
    focusedThreadMessageId.value = ''
  }

  function removeUnreadFeedItemLocally(itemId: string, notificationId?: string) {
    const previousLength = unreadFeedItems.value.length
    unreadFeedItems.value = unreadFeedItems.value.filter(item =>
      item.id !== itemId && (!notificationId || item.notificationId !== notificationId),
    )
    if (unreadFeedItems.value.length < previousLength) {
      unreadFeedTotalCount.value = Math.max(0, unreadFeedTotalCount.value - (previousLength - unreadFeedItems.value.length))
    }
    if (notificationId) {
      notifications.value = notifications.value.filter(item => item.id !== notificationId)
    }
  }

  function notificationIdsFromUnreadItems(items: UnreadFeedItem[]): string[] {
    return Array.from(new Set(items.flatMap(item => item.notificationId ? [item.notificationId] : [])))
  }

  function notificationIdsForTarget(
    conversationId: string,
    messageId?: string,
    threadRootMessageId?: string,
  ): string[] {
    if (!conversationId) return []
    return notifications.value
      .filter(item => {
        if (item.conversationId !== conversationId) return false
        if (threadRootMessageId) {
          return item.threadRootMessageId === threadRootMessageId
        }
        if (!messageId) return false
        return item.messageId === messageId && !item.threadRootMessageId
      })
      .map(item => item.id)
  }

  function resolveNotificationIds(ids: string[]): Promise<PromiseSettledResult<void>[]> | null {
    const uniqueIds = Array.from(new Set(ids.filter(Boolean)))
    return uniqueIds.length > 0
      ? Promise.allSettled(uniqueIds.map(notificationId => resolveUnreadFeedNotification(notificationId)))
      : null
  }

  function removeNotificationsByIds(ids: string[]) {
    const uniqueIds = new Set(ids.filter(Boolean))
    if (uniqueIds.size === 0) return
    notifications.value = notifications.value.filter(item => !uniqueIds.has(item.id))
  }

  function removeUnreadFeedItemsForRootMessages(conversationId: string, messageId?: string): UnreadFeedItem[] {
    if (!conversationId) return []
    const removed = unreadFeedItems.value.filter(item =>
      item.conversationId === conversationId
      && !item.threadRootMessageId
      && (!messageId || item.messageId === messageId),
    )
    if (removed.length === 0) return []

    const removedIds = new Set(removed.map(item => item.id))
    const removedNotificationIds = new Set(notificationIdsFromUnreadItems(removed))

    unreadFeedItems.value = unreadFeedItems.value.filter(item => !removedIds.has(item.id))
    unreadFeedTotalCount.value = Math.max(0, unreadFeedTotalCount.value - removed.length)

    if (removedNotificationIds.size > 0) {
      notifications.value = notifications.value.filter(item => !removedNotificationIds.has(item.id))
    }

    return removed
  }

  function removeUnreadFeedItemsForThread(conversationId: string, threadRootMessageId: string): UnreadFeedItem[] {
    if (!conversationId || !threadRootMessageId) return []
    const removed = unreadFeedItems.value.filter(item =>
      item.conversationId === conversationId
      && (item.threadRootMessageId === threadRootMessageId || item.messageId === threadRootMessageId),
    )
    if (removed.length === 0) return []

    const removedIds = new Set(removed.map(item => item.id))
    const removedNotificationIds = new Set(
      removed.flatMap(item => item.notificationId ? [item.notificationId] : []),
    )

    unreadFeedItems.value = unreadFeedItems.value.filter(item => !removedIds.has(item.id))
    unreadFeedTotalCount.value = Math.max(0, unreadFeedTotalCount.value - removed.length)

    if (removedNotificationIds.size > 0) {
      notifications.value = notifications.value.filter(item => !removedNotificationIds.has(item.id))
    }

    return removed
  }

  function rootReadSeq(conversationId: string, threadRootMessageId: string): bigint {
    return getThreadRoot(conversationId, threadRootMessageId)?.channelSeq ?? 0n
  }

  function isActiveThreadWorkspace(conversationId: string, threadRootMessageId: string): boolean {
    return Boolean(conversationId)
      && Boolean(threadRootMessageId)
      && activeThreadConversationId.value === conversationId
      && activeThreadRootId.value === threadRootMessageId
  }

  function isVisibleRootConversation(conversationId: string): boolean {
    return Boolean(conversationId)
      && isClientTabActive()
      && chatViewMode.value === 'conversation'
      && activeChannelId.value === conversationId
  }

  function isVisibleMessageTarget(conversationId: string, threadRootMessageId = ''): boolean {
    if (threadRootMessageId) {
      return isClientTabActive() && isActiveThreadWorkspace(conversationId, threadRootMessageId)
    }
    return isVisibleRootConversation(conversationId)
  }

  function resolveVisibleRootNotifications(conversationId: string, messageId?: string) {
    const removedItems = removeUnreadFeedItemsForRootMessages(conversationId, messageId)
    const notificationIds = [
      ...notificationIdsFromUnreadItems(removedItems),
      ...notificationIdsForTarget(conversationId, messageId),
    ]
    removeNotificationsByIds(notificationIds)
    const resolution = resolveNotificationIds(notificationIds)
    if (resolution) void resolution
  }

  function markVisibleConversationRead(conversationId: string, lastReadSeq = 0n, messageId?: string) {
    if (!conversationId) return
    if (lastReadSeq > 0n) {
      requestReadMark(conversationId, lastReadSeq)
    }
    resolveVisibleRootNotifications(conversationId, messageId)
  }

  async function markThreadUnreadAsRead(
    conversationId: string,
    threadRootMessageId: string,
    lastReadSeq = 0n,
  ): Promise<void> {
    if (!conversationId || !threadRootMessageId) return
    const key = `${conversationId}:${threadRootMessageId}`
    const removedItems = removeUnreadFeedItemsForThread(conversationId, threadRootMessageId)
    const notificationIds = [
      ...notificationIdsFromUnreadItems(removedItems),
      ...notificationIdsForTarget(conversationId, undefined, threadRootMessageId),
    ]
    removeNotificationsByIds(notificationIds)
    const resolveAll = resolveNotificationIds
    const existing = pendingThreadReadResolutions.get(key)
    if (existing) {
      const notificationResolution = resolveAll(notificationIds)
      if (notificationResolution) {
        await notificationResolution
      }
      return existing
    }

    const pending = (async () => {
      const notificationResolution = resolveAll(notificationIds)
      if (notificationResolution) {
        await notificationResolution
      }
      if (lastReadSeq > 0n) {
        requestReadMark(conversationId, lastReadSeq)
      }
    })().finally(() => {
      pendingThreadReadResolutions.delete(key)
    })

    pendingThreadReadResolutions.set(key, pending)
    return pending
  }

  function markVisibleThreadRead(conversationId: string, threadRootMessageId: string, lastReadSeq = rootReadSeq(conversationId, threadRootMessageId)) {
    if (!conversationId || !threadRootMessageId) return
    void markThreadUnreadAsRead(conversationId, threadRootMessageId, lastReadSeq)
    subscribeThreadReplay(conversationId, threadRootMessageId)
  }

  function retryThreadReplay(conversationId: string, threadRootMessageId: string) {
    if (!isActiveThreadWorkspace(conversationId, threadRootMessageId)) return
    incompleteThreadReplayResponses.delete(threadRootMessageId)
    clearThreadReplayResyncTimer(threadRootMessageId)
    subscribeThreadReplay(conversationId, threadRootMessageId, true)
  }

  function recoverActiveThreadAfterRealtimeSync() {
    const conversationId = activeThreadConversationId.value
    const rootMessageId = activeThreadRootId.value
    if (!conversationId || !rootMessageId) return
    incompleteThreadReplayResponses.delete(rootMessageId)
    setThreadReplayStatus(rootMessageId, 'loading')
    void (async () => {
      await ensureConversationHistory(conversationId)
      if (!isActiveThreadWorkspace(conversationId, rootMessageId)) return
      if (!getThreadRoot(conversationId, rootMessageId)) {
        await loadMessageContext(conversationId, rootMessageId)
      }
      if (!isActiveThreadWorkspace(conversationId, rootMessageId)) return
      markVisibleThreadRead(conversationId, rootMessageId)
    })()
  }

  function scrubActiveThreadUnreadFeed() {
    if (!activeThreadConversationId.value || !activeThreadRootId.value) return
    if (!isClientTabActive()) return
    markVisibleThreadRead(activeThreadConversationId.value, activeThreadRootId.value)
  }

  function scrubVisibleUnreadTargets() {
    if (!isClientTabActive()) return
    if (isVisibleRootConversation(activeChannelId.value)) {
      const lastReadSeq = channels.value.find(item => item.id === activeChannelId.value)?.lastMessageSeq
        ?? directMessages.value.find(item => item.id === activeChannelId.value)?.lastMessageSeq
        ?? 0n
      markVisibleConversationRead(activeChannelId.value, lastReadSeq)
    }
    scrubActiveThreadUnreadFeed()
  }

  function selectChannel(id: string) {
    const selectStartedAt = performance.now()
    logConversationPerf('select', {
      conversationId: id,
      cachedMessages: messages.value[id]?.length ?? 0,
      at: new Date().toISOString(),
    })
    activeChannelId.value = id
    showConversationView()
    clearFocusedMessages()
    requestConversationComposerFocus()
    saveActiveConversationSelection(id)
    if (activeThreadConversationId.value !== id) {
      closeThread()
    }
    const historyPromise = ensureConversationHistory(id, selectStartedAt)
    const ch = channels.value.find(c => c.id === id)
    let visibleLastReadSeq = 0n
    if (ch) {
      visibleLastReadSeq = typeof ch.lastMessageSeq === 'bigint' ? ch.lastMessageSeq : 0n
    }
    const dm = directMessages.value.find(d => d.id === id)
    if (dm) {
      visibleLastReadSeq = typeof dm.lastMessageSeq === 'bigint' ? dm.lastMessageSeq : 0n
    }
    if (isVisibleRootConversation(id)) {
      markVisibleConversationRead(id, visibleLastReadSeq)
    }
    return historyPromise
  }

  function registerUserName(userId: string, displayName: string) {
    const normalized = displayName.trim()
    if (!normalized) return
    userNames.value[userId] = normalized
  }

  function resolveDisplayName(userId: string): string {
    const directDisplayName = directMessages.value.find(dm => dm.userId === userId)?.displayName?.trim()
    const selfDisplayName = workspace.value?.selfUserId === userId
      ? workspace.value?.selfDisplayName?.trim()
      : ''
    return userNames.value[userId]
      || directDisplayName
      || selfDisplayName
      || userId.slice(0, 8)
  }

  function resolveAvatarUrl(userId: string): string {
    const fromDirectory = (userAvatars.value[userId] ?? '').trim()
    if (fromDirectory) return fromDirectory
    const fromDm = (directMessages.value.find(dm => dm.userId === userId)?.avatarUrl ?? '').trim()
    if (fromDm) return fromDm
    if (workspace.value?.selfUserId === userId) {
      return (workspace.value.selfAvatarUrl ?? '').trim()
    }
    return ''
  }

  function resolveUserCustomStatus(userId: string): UserCustomStatus | null {
    if (Object.prototype.hasOwnProperty.call(userCustomStatuses.value, userId)) {
      const fromDirectory = userCustomStatuses.value[userId]
      return isUserCustomStatusActive(fromDirectory) ? fromDirectory : null
    }
    const fromDm = directMessages.value.find(dm => dm.userId === userId)?.customStatus
    if (isUserCustomStatusActive(fromDm)) return fromDm
    if (workspace.value?.selfUserId === userId && isUserCustomStatusActive(workspace.value.selfCustomStatus)) {
      return workspace.value.selfCustomStatus
    }
    return null
  }

  function registerUserIdentity(
    userId: string,
    displayName?: string,
    email?: string,
    avatarUrl?: string,
    customStatus?: UserCustomStatus | null,
    refreshLabels = true,
  ): boolean {
    const normalizedName = (displayName ?? '').trim()
    const normalizedEmail = (email ?? '').trim()
    const normalizedAvatar = (avatarUrl ?? '').trim()
    const resolved = normalizedName || normalizedEmail
    const hasAvatarUpdate = avatarUrl !== undefined
    const previousAvatar = hasAvatarUpdate ? resolveAvatarUrl(userId) : ''
    const nameChanged = Boolean(resolved) && userNames.value[userId] !== resolved
    const emailChanged = Boolean(normalizedEmail) && userEmails.value[userId] !== normalizedEmail
    const avatarChanged = hasAvatarUpdate && userAvatars.value[userId] !== normalizedAvatar
    const previousCustomStatus = customStatus !== undefined ? resolveUserCustomStatus(userId) : null
    const resolvedCustomStatus = customStatus !== undefined
      ? (isUserCustomStatusActive(customStatus) ? customStatus : null)
      : undefined
    const customStatusChanged = resolvedCustomStatus !== undefined && (
      previousCustomStatus?.text !== resolvedCustomStatus?.text
      || previousCustomStatus?.emoji !== resolvedCustomStatus?.emoji
      || previousCustomStatus?.expiresAt !== resolvedCustomStatus?.expiresAt
    )

    if (nameChanged) {
      userNames.value[userId] = resolved
    }
    if (emailChanged) {
      userEmails.value[userId] = normalizedEmail
    }
    if (hasAvatarUpdate && avatarChanged) {
      userAvatars.value[userId] = normalizedAvatar
      void invalidateUserAvatar(previousAvatar, normalizedAvatar)
    }
    if (resolvedCustomStatus !== undefined && customStatusChanged) {
      userCustomStatuses.value[userId] = resolvedCustomStatus
      const dm = directMessages.value.find(item => item.userId === userId)
      if (dm) {
        dm.customStatus = resolvedCustomStatus
      }
      if (workspace.value?.selfUserId === userId) {
        workspace.value.selfCustomStatus = resolvedCustomStatus
      }
    }
    // Directory hydration and history pages can contain hundreds of messages
    // from the same sender. Only rescan resident message lists if this call
    // actually changes their rendered identity.
    const changed = nameChanged || emailChanged || avatarChanged || customStatusChanged
    if (changed && refreshLabels) refreshSenderLabels(userId)
    return changed
  }

  function refreshSenderLabels(userId: string) {
    refreshSenderLabelsForUsers([userId])
  }

  function refreshSenderLabelsForUsers(userIds: Iterable<string>) {
    const identities = new Map<string, {
      displayName: string
      avatarUrl: string
      customStatus: UserCustomStatus | null
    }>()
    for (const userId of userIds) {
      if (!userId || identities.has(userId)) continue
      identities.set(userId, {
        displayName: resolveDisplayName(userId),
        avatarUrl: resolveAvatarUrl(userId),
        customStatus: resolveUserCustomStatus(userId),
      })
    }
    if (identities.size === 0) return

    for (const conversationId of Object.keys(messages.value)) {
      const list = messages.value[conversationId]
      for (const msg of list) {
        const identity = identities.get(msg.senderId)
        if (!identity) continue
        msg.senderName = identity.displayName
        msg.senderAvatarUrl = identity.avatarUrl
      }
    }
    for (const rootId of Object.keys(threadMessages.value)) {
      const list = threadMessages.value[rootId]
      for (const msg of list) {
        const identity = identities.get(msg.senderId)
        if (!identity) continue
        msg.senderName = identity.displayName
        msg.senderAvatarUrl = identity.avatarUrl
      }
    }
    for (const dm of directMessages.value) {
      const identity = identities.get(dm.userId)
      if (!identity) continue
      dm.displayName = identity.displayName
      dm.avatarUrl = identity.avatarUrl
      dm.customStatus = identity.customStatus
    }
    if (workspace.value) {
      const identity = identities.get(workspace.value.selfUserId)
      if (identity) {
        workspace.value.selfDisplayName = identity.displayName
        workspace.value.selfAvatarUrl = identity.avatarUrl
        workspace.value.selfCustomStatus = identity.customStatus
      }
    }
  }

  async function ensureUserDirectory() {
    if (userDirectoryHydrated) return
    if (userDirectoryPromise) return userDirectoryPromise
    userDirectoryPromise = (async () => {
      try {
        const candidates = await listDmCandidates()
        const changedUserIds = new Set<string>()
        for (const candidate of candidates) {
          if (registerUserIdentity(
            candidate.user_id,
            candidate.display_name,
            candidate.email,
            candidate.avatar_url,
            userCustomStatusFromDto(candidate.custom_status),
            false,
          )) {
            changedUserIds.add(candidate.user_id)
          }
        }
        refreshSenderLabelsForUsers(changedUserIds)
        userDirectoryHydrated = true
      } catch {
        // Non-fatal: keep short-id fallback if directory fetch fails.
      } finally {
        userDirectoryPromise = null
      }
    })()
    return userDirectoryPromise
  }

  function addOptimisticMessage(msg: Message) {
    if (!messages.value[msg.channelId]) messages.value[msg.channelId] = []
    messages.value[msg.channelId].push(msg)
  }

  function reconcileMessage(channelId: string, clientMsgId: string, ack: SendMessageAck) {
    const list = messages.value[channelId]
    if (!list) return
    const idx = list.findIndex(m => m.clientMsgId === clientMsgId && (m.sendStatus || m.pending))
    if (idx === -1) return
    clearSendTimeout(clientMsgId)
    const duplicate = list.findIndex((m, i) => i !== idx && m.id === ack.messageId)
    if (duplicate !== -1) {
      list.splice(idx, 1)
      return
    }
    const existing = list[idx]
    const confirmed: Message = {
      ...existing,
      id: ack.messageId,
      channelSeq: ack.channelSeq,
      createdAt: ack.createdAt ? new Date(Number(ack.createdAt.seconds) * 1000).toISOString() : existing.createdAt,
      pending: undefined,
      sendStatus: undefined,
      failReason: undefined,
    }
    list.splice(idx, 1, confirmed)
    scheduleMessageCache(channelId, list)
  }

  function reconcileThreadMessage(_channelId: string, clientMsgId: string, ack: SendMessageAck) {
    // SendMessageAck does not include thread_seq; we reconcile identity/timestamps here
    // and rely on the subsequent message_created event as the authoritative thread order.
    for (const rootId of Object.keys(threadMessages.value)) {
      const list = threadMessages.value[rootId]
      const idx = list.findIndex(m => m.clientMsgId === clientMsgId && (m.sendStatus || m.pending))
      if (idx === -1) continue
      clearSendTimeout(clientMsgId)
      const duplicate = list.findIndex((m, i) => i !== idx && m.id === ack.messageId)
      if (duplicate !== -1) {
        list.splice(idx, 1)
        return
      }
      const existing = list[idx]
      list.splice(idx, 1, {
        ...existing,
        id: ack.messageId,
        channelSeq: ack.channelSeq,
        createdAt: ack.createdAt ? new Date(Number(ack.createdAt.seconds) * 1000).toISOString() : existing.createdAt,
        pending: undefined,
        sendStatus: undefined,
        failReason: undefined,
      } satisfies Message)
      return
    }
  }

  // ── Send status helpers ────────────────────────────────────────────────────

  const SEND_TIMEOUT_MS = 15_000

  function isPlaintextMessage(message: Message): boolean {
    return message.contentMode !== 'dm_pairwise_signal_v1'
  }

  function enqueuePlaintextMessage(
    message: Message,
    threadRootMessageId?: string,
    attachmentIds = message.attachments?.map(attachment => attachment.id),
  ): Promise<boolean> {
    if (!isPlaintextMessage(message) || !message.clientMsgId) return Promise.resolve(false)
    return useOfflineQueue().enqueue({
      conversationId: message.channelId,
      body: message.body,
      entities: message.entities,
      clientMsgId: message.clientMsgId,
      threadRootMessageId,
      attachmentIds,
      attachments: message.attachments?.map(attachment => ({ ...attachment })),
    })
  }

  function clearSendTimeout(clientMsgId: string) {
    const timer = sendTimeouts.get(clientMsgId)
    if (timer) {
      clearTimeout(timer)
      sendTimeouts.delete(clientMsgId)
    }
  }

  /** Clear all in-flight send timeouts. Called on logout / store reset. */
  function clearAllSendTimeouts() {
    for (const timer of sendTimeouts.values()) {
      clearTimeout(timer)
    }
    sendTimeouts.clear()
  }

  function resetRuntimeState() {
    messageStateGeneration += 1
    decryptionSessionGeneration += 1
    secretHistoryGeneration.clear()
    clearPendingNotificationLevelChange()
    clearAllSendTimeouts()
    clearAllThreadReplayResyncTimers()
    clearAllThreadReplayResponseWatchdogs()

    clearScheduledAck()
    if (ackResponseTimer) {
      clearTimeout(ackResponseTimer)
      ackResponseTimer = null
    }
    if (syncCursorPersistTimer) {
      clearTimeout(syncCursorPersistTimer)
      syncCursorPersistTimer = null
    }
    if (threadSummaryPersistTimer) {
      clearTimeout(threadSummaryPersistTimer)
      threadSummaryPersistTimer = null
    }
    if (toastTimer) {
      clearTimeout(toastTimer)
      toastTimer = null
    }
    if (unreadFeedRefreshTimer) {
      clearTimeout(unreadFeedRefreshTimer)
      unreadFeedRefreshTimer = null
    }
    for (const timer of messageCacheTimers.values()) {
      clearTimeout(timer)
    }
    messageCacheTimers.clear()
    pendingMessageCaches.clear()
    pendingThreadReadResolutions.clear()
    incompleteThreadReplayResponses.clear()

    channels.value = []
    directMessages.value = []
    activeChannelId.value = ''
    chatViewMode.value = 'conversation'
    workspace.value = null
    notifications.value = []
    activeCalls.value = []
    pendingInvites.value = []
    presenceByUserId.value = {}
    typingByConversationId.value = {}
    bootstrapped.value = false
    cachedBootstrap.value = false

    messages.value = {}
    threadMessages.value = {}
    threadReplayVersionByRoot.value = {}
    threadReplayStatusByRoot.value = {}
    threadSummaries.value = {}
    conversationInitialLoadingById.value = {}
    activeThreadRootId.value = ''
    activeThreadConversationId.value = ''
    focusedMessageId.value = ''
    focusedThreadMessageId.value = ''
    unreadFeedItems.value = []
    unreadFeedTotalCount.value = 0
    unreadFeedLoading.value = false
    unreadFeedError.value = ''
    unreadFeedLoaded.value = false
    unreadFeedRefreshQueued.value = false
    savedMessageItems.value = []
    savedMessageTotalCount.value = 0
    savedMessagesLoading.value = false
    savedMessagesError.value = ''
    savedMessagesLoaded.value = false

    userNames.value = {}
    userEmails.value = {}
    userAvatars.value = {}
    pendingReactionOps.value = {}
    toast.value = null
    lastAppliedEventSeq.value = 0n
    lastAckedEventSeq.value = 0n
    lastPersistedSyncCursor = 0n

    conversationHistoryState.clear()
    historyLoadTokenByConversation.clear()
    pendingReadByConversation.clear()
    incomingMessageNotificationHandlers.clear()
    taskStatusChangedNotificationHandlers.clear()

    bootstrapStage = null
    bootstrapPresenceOverlay = new Map()
    bufferedServerEvents = []
    seenEventIds = new Set()
    // Keep historyLoadToken monotonic across account/session resets so pending
    // HTTP history from the old session remains stale even if the next session
    // opens the same conversation id.
    pendingAckEventCount = 0
    ackInFlight = false
    syncCursorPersistDirty = false
    syncReplayGeneration += 1
    pendingSyncResponses.length = 0
    threadSummaryPersistDirty = false
    clientIsActive = true
    userDirectoryHydrated = false
    userDirectoryPromise = null

    clientInstanceId = ''
  }

  function requeueInFlightPlaintextMessages() {
    const offlineQueue = useOfflineQueue()

    const requeue = (message: Message, threadRootMessageId?: string) => {
      if (message.sendStatus !== 'sending') return
      clearSendTimeout(message.clientMsgId ?? '')
      if (!isPlaintextMessage(message) || !message.clientMsgId) {
        message.sendStatus = 'failed'
        message.failReason = 'Connection lost'
        return
      }
      message.sendStatus = 'queued'
      message.failReason = undefined
      offlineQueue.releaseInFlight(message.clientMsgId)
      void enqueuePlaintextMessage(message, threadRootMessageId)
    }

    for (const list of Object.values(messages.value)) {
      for (const message of list) requeue(message)
    }
    for (const [threadRootMessageId, list] of Object.entries(threadMessages.value)) {
      for (const message of list) requeue(message, threadRootMessageId)
    }
  }

  /**
   * Start a 15-second timeout for a message in 'sending' state.
   * A missing ACK means the locally-open transport is no longer trustworthy.
   */
  function startSendTimeout(channelId: string, clientMsgId: string, isThread: boolean, threadRootId?: string) {
    clearSendTimeout(clientMsgId) // avoid double timers
    const timer = setTimeout(() => {
      sendTimeouts.delete(clientMsgId)
      const ws = useWsStore()
      if (isThread && threadRootId) {
        const list = threadMessages.value[threadRootId]
        if (!list) return
        const msg = list.find(m => m.clientMsgId === clientMsgId && m.sendStatus === 'sending')
        if (!msg) return
        if (isPlaintextMessage(msg)) {
          requeueInFlightPlaintextMessages()
        } else {
          msg.sendStatus = 'failed'
          msg.failReason = 'Message timed out'
        }
        ws.invalidateTransport('Message delivery did not receive an acknowledgement')
        return
      }

      const list = messages.value[channelId]
      if (!list) return
      const msg = list.find(m => m.clientMsgId === clientMsgId && m.sendStatus === 'sending')
      if (!msg) return
      if (isPlaintextMessage(msg)) {
        requeueInFlightPlaintextMessages()
      } else {
        msg.sendStatus = 'failed'
        msg.failReason = 'Message timed out'
      }
      ws.invalidateTransport('Message delivery did not receive an acknowledgement')
    }, SEND_TIMEOUT_MS)
    sendTimeouts.set(clientMsgId, timer)
  }

  function updateSendStatus(channelId: string, clientMsgId: string, status: SendStatus | undefined, failReason?: string) {
    const list = messages.value[channelId]
    if (!list) return
    const msg = list.find(m => m.clientMsgId === clientMsgId)
    if (!msg) return
    msg.sendStatus = status
    msg.failReason = failReason
    if (status !== 'sending') {
      clearSendTimeout(clientMsgId)
    }
  }

  function updateThreadSendStatus(rootMessageId: string, clientMsgId: string, status: SendStatus | undefined, failReason?: string) {
    const list = threadMessages.value[rootMessageId]
    if (!list) return
    const msg = list.find(m => m.clientMsgId === clientMsgId)
    if (!msg) return
    msg.sendStatus = status
    msg.failReason = failReason
    if (status !== 'sending') {
      clearSendTimeout(clientMsgId)
    }
  }

  async function attemptPlaintextSend(
    message: Message,
    threadRootMessageId?: string,
    attachmentIds = message.attachments?.map(attachment => attachment.id) ?? [],
  ) {
    const clientMsgId = message.clientMsgId
    if (!clientMsgId || !isPlaintextMessage(message)) return

    const persisted = await enqueuePlaintextMessage(message, threadRootMessageId, attachmentIds)
    if (!persisted) {
      if (message.sendStatus === 'queued' || message.sendStatus === 'sending') {
        if (threadRootMessageId) {
          updateThreadSendStatus(threadRootMessageId, clientMsgId, 'failed', OUTBOUND_PERSISTENCE_FAILURE_REASON)
        } else {
          updateSendStatus(message.channelId, clientMsgId, 'failed', OUTBOUND_PERSISTENCE_FAILURE_REASON)
        }
      }
      return
    }

    // Another delivery path may have received its ACK while this IndexedDB
    // commit was pending. Do not resurrect a confirmed or discarded bubble.
    if (message.sendStatus !== 'queued' && message.sendStatus !== 'sending') return

    const ws = useWsStore()
    if (ws.state !== 'LIVE_SYNCED') {
      if (threadRootMessageId) {
        updateThreadSendStatus(threadRootMessageId, clientMsgId, 'queued')
      } else {
        updateSendStatus(message.channelId, clientMsgId, 'queued')
      }
      return
    }

    const offlineQueue = useOfflineQueue()
    if (!offlineQueue.claimInFlight(clientMsgId)) return
    if (threadRootMessageId) {
      updateThreadSendStatus(threadRootMessageId, clientMsgId, 'sending')
    } else {
      updateSendStatus(message.channelId, clientMsgId, 'sending')
    }

    const entities = message.entities ?? []
    const sent = entities.length > 0
      ? ws.sendMessage(message.channelId, message.body, clientMsgId, threadRootMessageId, attachmentIds, entities)
      : ws.sendMessage(message.channelId, message.body, clientMsgId, threadRootMessageId, attachmentIds)
    if (!sent) {
      offlineQueue.releaseInFlight(clientMsgId)
      requeueInFlightPlaintextMessages()
      ws.invalidateTransport('Message could not be sent')
      return
    }
    startSendTimeout(message.channelId, clientMsgId, Boolean(threadRootMessageId), threadRootMessageId)
  }

  function failSendByClientMsgId(clientMsgId: string, failReason: string) {
    for (const [conversationId, list] of Object.entries(messages.value)) {
      const msg = list.find(item => item.clientMsgId === clientMsgId && item.sendStatus === 'sending')
      if (!msg) continue
      updateSendStatus(conversationId, clientMsgId, 'failed', failReason)
      return
    }
    for (const [rootMessageId, list] of Object.entries(threadMessages.value)) {
      const msg = list.find(item => item.clientMsgId === clientMsgId && item.sendStatus === 'sending')
      if (!msg) continue
      updateThreadSendStatus(rootMessageId, clientMsgId, 'failed', failReason)
      return
    }
  }

  function retryMessage(channelId: string, clientMsgId: string) {
    const list = messages.value[channelId]
    if (!list) return
    const msg = list.find(m => m.clientMsgId === clientMsgId && m.sendStatus === 'failed')
    if (!msg) return
    if (!isPlaintextMessage(msg)) {
      msg.failReason = 'Encrypted message retry is unavailable'
      return
    }
    msg.sendStatus = 'queued'
    msg.failReason = undefined
    const attachmentIds = msg.attachments?.map(a => a.id) ?? []
    void attemptPlaintextSend(msg, undefined, attachmentIds)
  }

  function retryThreadMessage(rootMessageId: string, clientMsgId: string) {
    const list = threadMessages.value[rootMessageId]
    if (!list) return
    const msg = list.find(m => m.clientMsgId === clientMsgId && m.sendStatus === 'failed')
    if (!msg) return
    if (!isPlaintextMessage(msg)) {
      msg.failReason = 'Encrypted message retry is unavailable'
      return
    }
    msg.sendStatus = 'queued'
    msg.failReason = undefined
    const attachmentIds = msg.attachments?.map(a => a.id) ?? []
    void attemptPlaintextSend(msg, rootMessageId, attachmentIds)
  }

  function discardFailedMessage(channelId: string, clientMsgId: string) {
    const list = messages.value[channelId]
    if (!list) return
    const idx = list.findIndex(m => m.clientMsgId === clientMsgId && m.sendStatus === 'failed')
    if (idx !== -1) {
      clearSendTimeout(clientMsgId)
      list.splice(idx, 1)
      useOfflineQueue().remove(clientMsgId)
    }
  }

  function discardFailedThreadMessage(rootMessageId: string, clientMsgId: string) {
    const list = threadMessages.value[rootMessageId]
    if (!list) return
    const idx = list.findIndex(m => m.clientMsgId === clientMsgId && m.sendStatus === 'failed')
    if (idx !== -1) {
      clearSendTimeout(clientMsgId)
      list.splice(idx, 1)
      useOfflineQueue().remove(clientMsgId)
    }
  }

  // ── Thread management ───────────────────────────────────────────────────────

  function openThread(rootMessage: Message) {
    if (rootMessage.threadRootMessageId) return
    requestThreadComposerFocus()
    activateThreadWorkspace(rootMessage.channelId, rootMessage.id)
  }

  function activateThreadWorkspace(conversationId: string, rootMessageId: string) {
    if (!conversationId || !rootMessageId) return
    const switchingThread = Boolean(activeThreadRootId.value)
      && (activeThreadRootId.value !== rootMessageId || activeThreadConversationId.value !== conversationId)
    if (switchingThread) {
      clearThreadReplayResyncTimer(activeThreadRootId.value)
      clearThreadReplayResponseWatchdog(activeThreadRootId.value)
      focusedThreadMessageId.value = ''
    }
    activeThreadConversationId.value = conversationId
    activeThreadRootId.value = rootMessageId
    if (!threadMessages.value[rootMessageId]) threadMessages.value[rootMessageId] = []
    incompleteThreadReplayResponses.delete(rootMessageId)
    // Only server-confirmed replies advance the replay cursor. ACK-only
    // optimistic replies stay visible but must not suppress a later backfill.
    // If the confirmed cache is smaller than the known reply total, reopen
    // from zero so older replies are replayed instead of showing a partial thread.
    markVisibleThreadRead(conversationId, rootMessageId)
  }

  function deactivateThreadWorkspace(conversationId: string, rootMessageId: string) {
    if (!isActiveThreadWorkspace(conversationId, rootMessageId)) return
    closeThread()
  }

  function closeThread() {
    clearThreadReplayResyncTimer(activeThreadRootId.value)
    clearThreadReplayResponseWatchdog(activeThreadRootId.value)
    activeThreadRootId.value = ''
    activeThreadConversationId.value = ''
    focusedThreadMessageId.value = ''
  }

  function buildSelfSendContext(ws: ReturnType<typeof useWsStore>, attachmentIds: string[] = []) {
    const isOffline = ws.state !== 'LIVE_SYNCED'
    if (isOffline && attachmentIds.length > 0) return null

    const authStore = useAuthStore()
    const senderId = authStore.user?.id ?? workspace.value?.selfUserId ?? ''
    if (!senderId) return null

    return {
      senderId,
      senderName: (
        (authStore.user?.displayName?.trim() || '')
        || (workspace.value?.selfDisplayName?.trim() || '')
        || (authStore.user?.email?.trim() || '')
        || senderId.slice(0, 8)
      ),
      senderAvatarUrl: (
        (authStore.user?.avatarUrl?.trim() || '')
        || (workspace.value?.selfAvatarUrl?.trim() || '')
        || (resolveAvatarUrl(senderId).trim() || '')
      ),
      isOffline,
    }
  }

  function sendThreadReply(body: string, attachmentIds: string[] = [], attachments: MessageAttachment[] = [], entities: MessageEntity[] = []) {
    const text = body.trim()
    if (!text && attachmentIds.length === 0) return
    if (!isThreadPanelOpen.value) return
    const channelId = activeThreadConversationId.value
    const rootId = activeThreadRootId.value
    if (!channelId || !rootId) return
    const ws = useWsStore()
    const sendContext = buildSelfSendContext(ws, attachmentIds)
    if (!sendContext) return
    const { senderId, senderName, senderAvatarUrl, isOffline } = sendContext

    const clientMsgId = generateId()
    const now = new Date().toISOString()
    const nextThreadSeq = (threadSummaries.value[rootId]?.lastThreadSeq ?? 0n) + 1n

    const optimisticMessage: Message = {
      id: clientMsgId,
      channelId,
      senderId,
      senderName,
      senderAvatarUrl,
      body: text,
      entities,
      channelSeq: 0n,
      threadSeq: nextThreadSeq,
      threadRootMessageId: rootId,
      mentionedUserIds: mentionedUserIdsFromEntities(entities),
      mentionEveryone: false,
      createdAt: now,
      reactions: [],
      myReactions: [],
      attachments,
      clientMsgId,
      sendStatus: isOffline ? 'queued' : 'sending',
      serverConfirmed: false,
    }
    _upsertThreadMessage(rootId, optimisticMessage)
    void attemptPlaintextSend(optimisticMessage, rootId, attachmentIds)

    const known = threadSummaries.value[rootId]
    upsertThreadSummary(rootId, {
      replyCount: Math.max(known?.replyCount ?? 0, Number(nextThreadSeq)),
      lastThreadSeq: nextThreadSeq,
      lastReplyAt: now,
      lastReplyUserId: senderId,
    })

  }

  function sendMessageToConversation(
    conversationId: string,
    body: string,
    attachmentIds: string[] = [],
    attachments: MessageAttachment[] = [],
    entities: MessageEntity[] = [],
  ) {
    const text = body.trim()
    if (!conversationId || (!text && attachmentIds.length === 0)) return

    const ws = useWsStore()
    const sendContext = buildSelfSendContext(ws, attachmentIds)
    if (!sendContext) return
    const { senderId, senderName, senderAvatarUrl, isOffline } = sendContext

    const clientMsgId = generateId()
    const now = new Date().toISOString()

    const optimisticMessage: Message = {
      id: clientMsgId,
      channelId: conversationId,
      senderId,
      senderName,
      senderAvatarUrl,
      body: text,
      entities,
      channelSeq: 0n,
      threadSeq: 0n,
      mentionedUserIds: mentionedUserIdsFromEntities(entities),
      mentionEveryone: false,
      createdAt: now,
      reactions: [],
      myReactions: [],
      attachments,
      clientMsgId,
      sendStatus: isOffline ? 'queued' : 'sending',
      serverConfirmed: false,
    }
    addOptimisticMessage(optimisticMessage)
    void attemptPlaintextSend(optimisticMessage, undefined, attachmentIds)
  }

  function sendThreadReplyToRoot(
    conversationId: string,
    rootMessageId: string,
    body: string,
    attachmentIds: string[] = [],
    attachments: MessageAttachment[] = [],
    entities: MessageEntity[] = [],
  ) {
    const text = body.trim()
    if (!conversationId || !rootMessageId || (!text && attachmentIds.length === 0)) return
    const ws = useWsStore()
    const sendContext = buildSelfSendContext(ws, attachmentIds)
    if (!sendContext) return
    const { senderId, senderName, senderAvatarUrl, isOffline } = sendContext

    const clientMsgId = generateId()
    const now = new Date().toISOString()
    const nextThreadSeq = (threadSummaries.value[rootMessageId]?.lastThreadSeq ?? 0n) + 1n

    const optimisticMessage: Message = {
      id: clientMsgId,
      channelId: conversationId,
      senderId,
      senderName,
      senderAvatarUrl,
      body: text,
      entities,
      channelSeq: 0n,
      threadSeq: nextThreadSeq,
      threadRootMessageId: rootMessageId,
      mentionedUserIds: mentionedUserIdsFromEntities(entities),
      mentionEveryone: false,
      createdAt: now,
      reactions: [],
      myReactions: [],
      attachments,
      clientMsgId,
      sendStatus: isOffline ? 'queued' : 'sending',
      serverConfirmed: false,
    }
    _upsertThreadMessage(rootMessageId, optimisticMessage)
    void attemptPlaintextSend(optimisticMessage, rootMessageId, attachmentIds)

    const known = threadSummaries.value[rootMessageId]
    upsertThreadSummary(rootMessageId, {
      replyCount: Math.max(known?.replyCount ?? 0, Number(nextThreadSeq)),
      lastThreadSeq: nextThreadSeq,
      lastReplyAt: now,
      lastReplyUserId: senderId,
    })

  }

  function hasUsableSnapshot(): boolean {
    return bootstrapped.value && (channels.value.length > 0 || directMessages.value.length > 0 || workspace.value !== null)
  }

  function startRealtimeFlow() {
    const ws = useWsStore()
    const auth = ws.authResult
    if (!auth) return

    if (!hasUsableSnapshot() || lastAppliedEventSeq.value === 0n) {
      startBootstrap()
      return
    }

    if (auth.persistedEventSeq > lastAppliedEventSeq.value) {
      ws.setStaleRebootstrap()
    }

    // Reconnect resumes from cached/local state. Bootstrap is the authoritative
    // refresh for unread counters, presence, notifications, and other direct-only
    // state that cannot be reconstructed from SyncSince replay alone.
    startBootstrap()
  }

  function startBootstrap() {
    discardPendingSyncResponses()
    clearScheduledAck()
    ackInFlight = false
    clearAckResponseWatchdog()
    const ws = useWsStore()
    bootstrapStage = null
    bootstrapPresenceOverlay = new Map()
    bufferedServerEvents = []
    if (!clientInstanceId) {
      clientInstanceId = getOrCreateClientInstanceId()
    }
    ws.sendBootstrap({
      clientInstanceId,
      pageSizeHint: DEFAULT_SYNC_BATCH,
    })
  }

  function flushOfflineQueueAfterRealtimeSync() {
    const ws = useWsStore()
    if (ws.state !== 'LIVE_SYNCED') return
    void useOfflineQueue().flush(ws, (conversationId, clientMsgId, status, threadRootMessageId, failReason) => {
      if (threadRootMessageId) {
        updateThreadSendStatus(threadRootMessageId, clientMsgId, status, failReason)
        if (status === 'sending') {
          startSendTimeout(conversationId, clientMsgId, true, threadRootMessageId)
        }
        return
      }
      updateSendStatus(conversationId, clientMsgId, status, failReason)
      if (status === 'sending') {
        startSendTimeout(conversationId, clientMsgId, false)
      }
    })
  }

  function handleBootstrapResponse(resp: BootstrapResponse) {
    if (resp.pageIndex === 0) {
      const authStore = useAuthStore()
      const resolvedRole = workspaceRoleToSlug(resp.userRole || resp.workspace?.selfRole || WorkspaceRole.UNSPECIFIED)
      if (resolvedRole) {
        authStore.setSessionRole(resolvedRole)
      }
    }

    if (resp.pageIndex === 0) {
      bootstrapStage = {
        snapshotSeq: resp.snapshotSeq,
        workspace: resp.workspace ? {
          id: resp.workspace.workspaceId,
          name: resp.workspace.workspaceName,
          selfUserId: resp.workspace.selfUser?.userId ?? '',
          selfDisplayName: resp.workspace.selfUser?.displayName ?? '',
          selfAvatarUrl: resp.workspace.selfUser?.avatarUrl ?? '',
          selfCustomStatus: userCustomStatusFromProto(resp.workspace.selfUser?.customStatus),
          selfRole: workspaceRoleToSlug(resp.userRole || resp.workspace.selfRole),
        } : null,
        conversations: [],
        notifications: [],
        activeCalls: [],
        userCallPresence: new Map(),
        pendingInvites: [],
        unread: new Map(),
        presence: new Map(),
      }
    }
    if (!bootstrapStage) {
      console.warn('bootstrap continuation received without an active bootstrap stage', { pageIndex: resp.pageIndex })
      return
    }

    for (const conversation of resp.conversations) {
      bootstrapStage.conversations.push(conversation)
    }
    for (const counter of resp.unread) {
      bootstrapStage.unread.set(counter.conversationId, {
        unreadMessages: counter.unreadMessages,
        unreadMentions: counter.unreadMentions,
        hasUnreadThreadReplies: counter.hasUnreadThreadReplies,
      })
    }
    for (const item of resp.presence) {
      bootstrapStage.presence.set(item.userId, item)
    }
    if (resp.pageIndex === 0) {
      bootstrapStage.notifications = resp.notifications.slice()
      bootstrapStage.activeCalls = resp.activeCalls.slice()
      bootstrapStage.userCallPresence = new Map(resp.userCallPresence.map(item => [item.userId, item.activeCallCount]))
      bootstrapStage.pendingInvites = resp.pendingInvites.slice()
    }

    if (resp.hasMore) {
      const ws = useWsStore()
      ws.sendBootstrap({
        clientInstanceId,
        bootstrapSessionId: resp.bootstrapSessionId,
        pageToken: resp.nextPageToken,
      })
      return
    }

    applyBootstrapSnapshot(bootstrapStage)
    replaceSyncCursor(resp.snapshotSeq)
    if (activeChannelId.value) {
      void ensureConversationHistory(activeChannelId.value)
    }
    scheduleAckFlush()
    const ws = useWsStore()
    ws.setLiveSynced()
    flushOfflineQueueAfterRealtimeSync()
    drainBufferedEvents()
    recoverActiveThreadAfterRealtimeSync()
  }

  /** Max conversations whose messages are pre-loaded from cache on startup. */
  const CACHED_MSG_PRELOAD_LIMIT = 5

  function queuedMessageFromPending(message: PendingOutboundMessage, senderId: string): Message {
    const attachments = message.attachments?.map(attachment => ({ ...attachment }))
      ?? message.attachmentIds?.map(id => ({ id, fileName: '', fileSize: 0, mimeType: '' }))
    return {
      id: message.clientMsgId,
      channelId: message.conversationId,
      senderId,
      senderName: workspace.value?.selfDisplayName ?? resolveDisplayName(senderId),
      body: message.body,
      entities: message.entities ?? [],
      channelSeq: 0n,
      threadSeq: 0n,
      threadRootMessageId: message.threadRootMessageId,
      mentionedUserIds: mentionedUserIdsFromEntities(message.entities ?? []),
      mentionEveryone: false,
      createdAt: new Date().toISOString(),
      reactions: [],
      myReactions: [],
      attachments,
      contentMode: 'plaintext',
      clientMsgId: message.clientMsgId,
      sendStatus: 'queued',
      serverConfirmed: false,
    }
  }

  function hydrateQueuedMessages(queued: PendingOutboundMessage[], senderId: string) {
    for (const pending of queued) {
      const message = queuedMessageFromPending(pending, senderId)
      if (pending.threadRootMessageId) {
        const list = threadMessages.value[pending.threadRootMessageId] ?? []
        if (list.some(item => item.clientMsgId === pending.clientMsgId)) continue
        _upsertThreadMessage(pending.threadRootMessageId, message)
        continue
      }
      if (!messages.value[pending.conversationId]) {
        messages.value[pending.conversationId] = []
      }
      const list = messages.value[pending.conversationId]
      if (!list.some(item => item.clientMsgId === pending.clientMsgId)) {
        list.push(message)
      }
    }
  }

  /**
   * Load cached conversations and messages from IndexedDB for instant startup.
   * Returns true if cached data was available and hydrated into the store.
   */
  async function loadCachedState(): Promise<boolean> {
    try {
      const cached = await loadCachedConversations()
      const hasCachedConversations = Boolean(cached && (cached.channels.length > 0 || cached.dms.length > 0))
      const authStore = useAuthStore()
      const workspaceId = workspace.value?.id || workspace.value?.name || ''
      const userId = workspace.value?.selfUserId || authStore.user?.id || ''

      if (hasCachedConversations && cached) {
        channels.value = cached.channels
        directMessages.value = cached.dms
        cachedBootstrap.value = true

        // Determine which conversations' messages to preload.
        // Start with the last-opened conversation, then fill with the most
        // recently active channels/DMs (by lastActivityAt or list order).
        const lastConversation = loadLastOpenedConversation(workspaceId, userId)
        const preloadIds: string[] = []
        if (lastConversation) {
          const exists = cached.channels.some(ch => ch.id === lastConversation)
            || cached.dms.some(dm => dm.id === lastConversation)
          if (exists) {
            activeChannelId.value = lastConversation
            requestConversationComposerFocus()
            preloadIds.push(lastConversation)
          }
        }

        // Add top recently-active conversations (channels sorted by lastActivityAt desc)
        const sortedChannels = [...cached.channels]
          .sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''))
        for (const ch of sortedChannels) {
          if (preloadIds.length >= CACHED_MSG_PRELOAD_LIMIT) break
          if (!preloadIds.includes(ch.id)) preloadIds.push(ch.id)
        }
        // Add DMs (they are already ordered by recent activity from bootstrap)
        for (const dm of cached.dms) {
          if (preloadIds.length >= CACHED_MSG_PRELOAD_LIMIT) break
          if (!preloadIds.includes(dm.id)) preloadIds.push(dm.id)
        }

        // Load messages + thread summaries concurrently
        const [msgResults, cachedThreads] = await Promise.all([
          Promise.all(
            preloadIds.map(id => loadCachedMessages(id).then(msgs => ({ id, msgs }))),
          ),
          loadCachedThreadSummaries(userId),
        ])
        for (const { id, msgs } of msgResults) {
          if (msgs.length > 0) {
            messages.value[id] = msgs
          }
        }
        if (cachedThreads) {
          threadSummaries.value = cachedThreads
        }
      }

      // Hydrate durable records even when no conversations were cached. Thread
      // replies belong in their thread list so status/timer handling preserves
      // their root and attachment metadata after reconnect.
      let hydratedQueuedMessages = false
      try {
        const queued = await useOfflineQueue().loadPersisted()
        hydrateQueuedMessages(queued, userId)
        hydratedQueuedMessages = queued.length > 0
      } catch {
        // Non-fatal — queued messages will be flushed on reconnect regardless
      }

      return hasCachedConversations || hydratedQueuedMessages
    } catch {
      return false
    }
  }

  function setCachedBootstrap(value: boolean) {
    cachedBootstrap.value = value
  }

  function applyBootstrapSnapshot(stage: BootstrapStage) {
    decryptionSessionGeneration += 1
    // A purge may have removed replay events while this device was offline.
    // Never preserve secret history through an authoritative bootstrap.
    for (const dm of directMessages.value) {
      if (dm.encryptionMode === 'dm_pairwise_signal_v1') invalidateSecretHistory(dm.id, false)
    }
    messageStateGeneration += 1
    // Bootstrap is authoritative for server state, but locally accepted sends
    // must survive until their ACK or a replayed server event confirms them.
    // Do not mutate delivery state here: a healthy stale rebootstrap must not
    // replay plaintext sends or fail encrypted sends merely because it refreshes
    // the snapshot.
    const pendingConversationMessages = Object.fromEntries(
      Object.entries(messages.value)
        .map(([conversationId, list]) => [
          conversationId,
          list.filter(message => Boolean(message.clientMsgId && message.sendStatus)),
        ] as const)
        .filter(([, list]) => list.length > 0),
    )
    const pendingThreadMessages = Object.fromEntries(
      Object.entries(threadMessages.value)
        .map(([threadRootMessageId, list]) => [
          threadRootMessageId,
          list.filter(message => Boolean(message.clientMsgId && message.sendStatus)),
        ] as const)
        .filter(([, list]) => list.length > 0),
    )
    clearPendingNotificationLevelChange()
    clearAllSendTimeouts()
    clearAllThreadReplayResponseWatchdogs()

    const unreadByConversation = stage.unread
    const nextChannels: Channel[] = []
    const nextDms: DirectMessage[] = []

    const mergedPresence = new Map<string, PresenceEvent>()
    for (const [userId, evt] of stage.presence.entries()) {
      mergedPresence.set(userId, evt)
    }
    for (const [userId, evt] of bootstrapPresenceOverlay.entries()) {
      mergedPresence.set(userId, newerPresenceEvent(mergedPresence.get(userId), evt))
    }
    presenceByUserId.value = {}
    for (const [userId, evt] of mergedPresence.entries()) {
      presenceByUserId.value[userId] = evt
    }

    for (const summary of stage.conversations) {
      const unread = unreadByConversation.get(summary.conversationId)?.unreadMessages ?? 0
      const hasUnreadThreadReplies = unreadByConversation.get(summary.conversationId)?.hasUnreadThreadReplies ?? false
      if (summary.conversationType === ConversationType.DM) {
        const dmUserId = summary.topic || summary.conversationId
        registerUserName(dmUserId, summary.title)
        nextDms.push({
          id: summary.conversationId,
          userId: dmUserId,
          displayName: summary.title,
          avatarUrl: resolveAvatarUrl(dmUserId),
          customStatus: resolveUserCustomStatus(dmUserId),
          presence: resolveConversationPresence(summary.presence, dmUserId),
          encryptionMode: encryptionModeFromSummary(summary),
          unread,
          hasUnreadThreadReplies,
          lastMessageSeq: summary.lastMessageSeq,
          notificationLevel: summary.notificationLevel,
        })
      } else {
        nextChannels.push({
          id: summary.conversationId,
          name: summary.title,
          kind: 'channel',
          visibility: summary.conversationType === ConversationType.CHANNEL_PRIVATE ? 'private' : 'public',
          unread,
          hasUnreadThreadReplies,
          lastMessageSeq: summary.lastMessageSeq,
          lastActivityAt: summary.lastActivityAt
            ? new Date(Number(summary.lastActivityAt.seconds) * 1000).toISOString()
            : undefined,
          notificationLevel: summary.notificationLevel,
        })
      }
    }

    workspace.value = stage.workspace
    if (stage.workspace?.selfUserId) {
      registerUserIdentity(
        stage.workspace.selfUserId,
        stage.workspace.selfDisplayName,
        undefined,
        stage.workspace.selfAvatarUrl ?? '',
        stage.workspace.selfCustomStatus ?? null,
      )
    }
    channels.value = nextChannels
    directMessages.value = nextDms
    bootstrapPresenceOverlay = new Map()
    cachedBootstrap.value = false
    // Write-through to IndexedDB (fire-and-forget)
    void cacheConversations(nextChannels, nextDms)
    // Bootstrap conversation summaries do not carry peer avatar URLs.
    // Hydrate the identity directory after snapshot apply and refresh visible
    // sender/DM labels so avatars persist across full page reloads.
    void ensureUserDirectory().then(() => {
      for (const dm of directMessages.value) {
        refreshSenderLabels(dm.userId)
      }
    })
    notifications.value = stage.notifications.map(notificationSummaryToItem)
    activeCalls.value = stage.activeCalls.map(activeCallSummaryToItem)
    userCallPresenceByUserId.value = Object.fromEntries(stage.userCallPresence.entries())
    pendingInvites.value = stage.pendingInvites.map(callInviteSummaryToItem)
    // Preserve cached messages for the active conversation so the user
    // doesn't see a flash of empty content while ensureConversationHistory
    // fetches the authoritative page from the server. The HTTP history
    // response will overwrite these via applyConversationHistory.
    const preservedConversationId = activeChannelId.value
    const preservedMessages = preservedConversationId
      ? messages.value[preservedConversationId]?.filter(message => message.contentMode !== 'dm_pairwise_signal_v1')
      : undefined
    // PinnedDialogsHost keeps the visible ThreadWorkspace mounted during bootstrap.
    // Preserve its identity/root so realtime recovery can resubscribe after caches reset.
    const preservedActiveThreadRootId = activeThreadRootId.value
    const preservedActiveThreadConversationId = activeThreadConversationId.value
    const preservedActiveThreadRoot = getThreadRoot(
      preservedActiveThreadConversationId,
      preservedActiveThreadRootId,
    )
    messages.value = {}
    if (preservedConversationId && preservedMessages?.length) {
      messages.value[preservedConversationId] = preservedMessages
    }
    if (preservedActiveThreadRoot && preservedActiveThreadConversationId) {
      const preservedConversationMessages = messages.value[preservedActiveThreadConversationId] ?? []
      if (!preservedConversationMessages.some(message => message.id === preservedActiveThreadRoot.id)) {
        messages.value[preservedActiveThreadConversationId] = [
          ...preservedConversationMessages,
          preservedActiveThreadRoot,
        ]
      }
    }
    for (const [conversationId, pending] of Object.entries(pendingConversationMessages)) {
      const merged = messages.value[conversationId] ?? []
      for (const message of pending) {
        if (!merged.some(existing => existing.clientMsgId === message.clientMsgId)) {
          merged.push(message)
        }
      }
      messages.value[conversationId] = merged
    }
    conversationHistoryState.clear()
    conversationInitialLoadingById.value = {}
    historyLoadTokenByConversation.clear()
    threadMessages.value = {}
    for (const [threadRootMessageId, pending] of Object.entries(pendingThreadMessages)) {
      threadMessages.value[threadRootMessageId] = pending
    }
    // Timers are intentionally reset during bootstrap. Restore watchdogs for
    // sends that were still in flight on a healthy transport; queued sends are
    // flushed only after the session reaches LIVE_SYNCED.
    for (const [conversationId, pending] of Object.entries(pendingConversationMessages)) {
      for (const message of pending) {
        if (message.sendStatus === 'sending' && message.clientMsgId) {
          startSendTimeout(conversationId, message.clientMsgId, false)
        }
      }
    }
    for (const [threadRootMessageId, pending] of Object.entries(pendingThreadMessages)) {
      for (const message of pending) {
        if (message.sendStatus === 'sending' && message.clientMsgId) {
          startSendTimeout(message.channelId, message.clientMsgId, true, threadRootMessageId)
        }
      }
    }
    threadReplayVersionByRoot.value = {}
    threadReplayStatusByRoot.value = preservedActiveThreadRootId
      ? { [preservedActiveThreadRootId]: 'loading' }
      : {}
    incompleteThreadReplayResponses.clear()
    threadSummaries.value = loadThreadSummariesForUser(stage.workspace?.selfUserId ?? '')
    activeThreadRootId.value = preservedActiveThreadRootId
    activeThreadConversationId.value = preservedActiveThreadConversationId
    bootstrapped.value = true
    seenEventIds = new Set()

    const restoredConversation = resolveSnapshotActiveConversation(nextChannels, nextDms, stage.workspace)
    activeChannelId.value = restoredConversation
    if (restoredConversation) {
      requestConversationComposerFocus()
      saveActiveConversationSelection(restoredConversation)
    } else {
      clearActiveConversationSelection()
    }
    unreadFeedLoaded.value = false
    unreadFeedError.value = ''
    void refreshUnreadFeed()
  }

  async function ensureConversationHistory(conversationId: string, selectStartedAt?: number) {
    if (!conversationId) return
    const state = getOrCreateHistoryState(conversationId)
    if (state.initialized) {
      if (conversationInitialLoadingById.value[conversationId]) {
        conversationInitialLoadingById.value = {
          ...conversationInitialLoadingById.value,
          [conversationId]: false,
        }
      }
      const cached = messages.value[conversationId] ?? []
      logConversationPerf('history:cache-hit', {
        conversationId,
        messages: cached.length,
        totalSinceSelectMs: typeof selectStartedAt === 'number'
          ? Math.round((performance.now() - selectStartedAt) * 100) / 100
          : undefined,
      })
      return
    }

    await loadConversationHistoryPage(conversationId, undefined, selectStartedAt)
  }

  async function reloadActiveEncryptedDMHistory(): Promise<void> {
    const conversationId = activeChannelId.value
    if (!conversationId || !encryptedDMHistoryDeviceId(conversationId)) return

    // A pending request may have been addressed to the temporary local device.
    // Invalidate it before clearing the timeline so it cannot restore stale
    // encrypted-message placeholders after the recovered identity is installed.
    historyLoadTokenByConversation.set(conversationId, ++historyLoadToken)
    const state = getOrCreateHistoryState(conversationId)
    state.initialized = false
    state.loading = false
    state.hasMore = true
    state.nextBeforeChannelSeq = undefined
    cancelScheduledMessageCache(conversationId)
    messages.value[conversationId] = []

    await ensureConversationHistory(conversationId)
  }

  async function loadOlderConversationHistory(conversationId: string): Promise<number> {
    if (!conversationId) return 0
    const state = getOrCreateHistoryState(conversationId)
    if (!state.initialized || !state.hasMore || state.loading || typeof state.nextBeforeChannelSeq !== 'bigint') {
      return 0
    }
    return loadConversationHistoryPage(conversationId, state.nextBeforeChannelSeq)
  }

  async function loadConversationHistoryPage(
    conversationId: string,
    beforeChannelSeq?: bigint,
    selectStartedAt?: number,
  ): Promise<number> {
    const state = getOrCreateHistoryState(conversationId)
    if (state.loading) return 0

    const token = ++historyLoadToken
    historyLoadTokenByConversation.set(conversationId, token)
    state.loading = true
    const isInitialLoad = !state.initialized
    if (isInitialLoad) {
      conversationInitialLoadingById.value = {
        ...conversationInitialLoadingById.value,
        [conversationId]: true,
      }
    }

    const requestStartedAt = performance.now()
    logConversationPerf('history:request:start', {
      conversationId,
      token,
      beforeChannelSeq: typeof beforeChannelSeq === 'bigint' ? beforeChannelSeq.toString() : undefined,
    })
    try {
      const e2eeDeviceId = encryptedDMHistoryDeviceId(conversationId)
      const page = e2eeDeviceId
        ? await listConversationMessages(conversationId, beforeChannelSeq, e2eeDeviceId)
        : await listConversationMessages(conversationId, beforeChannelSeq)
      const requestMs = Math.round((performance.now() - requestStartedAt) * 100) / 100
      logConversationPerf('history:request:done', {
        conversationId,
        token,
        requestMs,
        count: page.messages.length,
        hasMore: page.has_more,
      })
      if (token !== historyLoadTokenByConversation.get(conversationId)) {
        logConversationPerf('history:request:stale', {
          conversationId,
          token,
          currentToken: historyLoadTokenByConversation.get(conversationId) ?? 0,
        })
        return 0
      }
      const applyStartedAt = performance.now()
      applyConversationHistory(conversationId, page.messages)
      state.initialized = true
      state.hasMore = page.has_more
      if (page.next_before_channel_seq) {
        state.nextBeforeChannelSeq = BigInt(page.next_before_channel_seq)
      } else if (page.messages.length > 0) {
        state.nextBeforeChannelSeq = BigInt(page.messages[0].channel_seq)
      } else {
        state.nextBeforeChannelSeq = undefined
      }
      const applyMs = Math.round((performance.now() - applyStartedAt) * 100) / 100
      logConversationPerf('history:apply:done', {
        conversationId,
        token,
        applyMs,
        totalSinceSelectMs: typeof selectStartedAt === 'number'
          ? Math.round((performance.now() - selectStartedAt) * 100) / 100
          : undefined,
      })
      return page.messages.length
    } catch {
      // Keep the shell usable; history reload can fail independently from WS state.
      logConversationPerf('history:request:error', {
        conversationId,
        token,
      })
      return 0
    } finally {
      const isCurrentRequest = token === historyLoadTokenByConversation.get(conversationId)
      if (isCurrentRequest) {
        state.loading = false
      }
      if (isInitialLoad && isCurrentRequest) {
        conversationInitialLoadingById.value = {
          ...conversationInitialLoadingById.value,
          [conversationId]: false,
        }
      }
    }
  }

  async function loadMessageContext(
    conversationId: string,
    messageId: string,
  ): Promise<'loaded' | 'not_found' | 'forbidden' | 'error'> {
    if (!conversationId || !messageId) return 'error'
    const generation = messageStateGeneration
    try {
      const e2eeDeviceId = encryptedDMHistoryDeviceId(conversationId)
      const page = e2eeDeviceId
        ? await getMessageContext(conversationId, messageId, e2eeDeviceId)
        : await getMessageContext(conversationId, messageId)
      if (generation !== messageStateGeneration) return 'error'
      applyConversationHistory(conversationId, page.messages)
      return 'loaded'
    } catch (err) {
      if (err instanceof ChatApiError) {
        if (err.status === 403) return 'forbidden'
        if (err.status === 404) return 'not_found'
      }
      return 'error'
    }
  }

  async function refreshUnreadFeed(): Promise<void> {
    if (!bootstrapped.value) return
    const generation = messageStateGeneration
    unreadFeedLoading.value = true
    unreadFeedError.value = ''
    try {
      const response = await listUnreadFeed()
      if (generation !== messageStateGeneration) return
      unreadFeedItems.value = (response.items ?? []).map(unreadFeedItemFromHttp)
      unreadFeedTotalCount.value = Math.max(0, Math.floor(response.total_count ?? 0))
      unreadFeedLoaded.value = true
      scrubVisibleUnreadTargets()
    } catch (err) {
      unreadFeedError.value = err instanceof Error ? err.message : 'Failed to load unread feed'
      unreadFeedLoaded.value = true
    } finally {
      unreadFeedLoading.value = false
      unreadFeedRefreshQueued.value = false
      if (unreadFeedRefreshTimer) {
        clearTimeout(unreadFeedRefreshTimer)
        unreadFeedRefreshTimer = null
      }
    }
  }

  async function refreshSavedMessages(): Promise<void> {
    if (!bootstrapped.value) return
    const generation = messageStateGeneration
    savedMessagesLoading.value = true
    savedMessagesError.value = ''
    try {
      const response = await listSavedMessages()
      if (generation !== messageStateGeneration) return
      savedMessageItems.value = (response.items ?? []).map(savedMessageItemFromHttp)
      savedMessageTotalCount.value = Math.max(0, Math.floor(response.total_count ?? 0))
      savedMessagesLoaded.value = true
    } catch (err) {
      savedMessagesError.value = err instanceof Error ? err.message : 'Failed to load saved messages'
      savedMessagesLoaded.value = true
    } finally {
      savedMessagesLoading.value = false
    }
  }

  function updateMessageSavedState(messageId: string, isSaved: boolean) {
    if (!messageId) return
    for (const conversationId of Object.keys(messages.value)) {
      const list = messages.value[conversationId] ?? []
      const idx = list.findIndex(message => message.id === messageId)
      if (idx === -1) continue
      const next = [...list]
      next[idx] = { ...next[idx], isSaved }
      messages.value[conversationId] = next
    }
    for (const rootId of Object.keys(threadMessages.value)) {
      const list = threadMessages.value[rootId] ?? []
      const idx = list.findIndex(message => message.id === messageId)
      if (idx === -1) continue
      const next = [...list]
      next[idx] = { ...next[idx], isSaved }
      threadMessages.value[rootId] = next
    }
  }

  async function toggleMessageSaved(message: Message): Promise<void> {
    if (!message.id || message.sendStatus || message.pending) return
    const nextSaved = !message.isSaved
    const previousSaved = Boolean(message.isSaved)
    updateMessageSavedState(message.id, nextSaved)
    if (!nextSaved) {
      const previousCount = savedMessageItems.value.length
      savedMessageItems.value = savedMessageItems.value.filter(item => item.messageId !== message.id)
      if (savedMessageItems.value.length < previousCount) {
        savedMessageTotalCount.value = Math.max(0, savedMessageTotalCount.value - (previousCount - savedMessageItems.value.length))
      }
    }

    try {
      if (nextSaved) {
        await saveMessageApi(message.id)
        if (savedMessagesLoaded.value) {
          void refreshSavedMessages()
        }
      } else {
        await unsaveMessageApi(message.id)
      }
    } catch (err) {
      updateMessageSavedState(message.id, previousSaved)
      if (!nextSaved && savedMessagesLoaded.value) {
        void refreshSavedMessages()
      }
      showToast(err instanceof Error ? err.message : 'Failed to update saved message')
    }
  }

  async function forwardMessageToTarget(
    message: Message,
    destinationConversationId: string,
    destinationThreadRootMessageId = '',
  ): Promise<void> {
    if (!message.id || message.sendStatus || message.pending || !destinationConversationId) return
    try {
      await forwardMessageApi(message.id, destinationConversationId, destinationThreadRootMessageId)
      showToast('Message forwarded')
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to forward message')
    }
  }

  function scheduleUnreadFeedRefresh() {
    if (!bootstrapped.value) return
    unreadFeedRefreshQueued.value = true
    if (!unreadFeedLoaded.value && chatViewMode.value !== 'unread') return
    if (unreadFeedRefreshTimer) return
    unreadFeedRefreshTimer = setTimeout(() => {
      unreadFeedRefreshTimer = null
      void refreshUnreadFeed()
    }, 1000)
  }

  function handleSyncSinceResponse(resp: SyncSinceResponse) {
    pendingSyncResponses.push(resp)
    if (syncReplayProcessing) return
    syncReplayProcessing = true
    void drainSyncSinceResponses()
  }

  function discardPendingSyncResponses() {
    syncReplayGeneration += 1
    pendingSyncResponses.length = 0
  }

  function yieldSyncReplayChunk(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0))
  }

  async function drainSyncSinceResponses() {
    let replayFailed = false
    try {
      while (pendingSyncResponses.length > 0) {
        const resp = pendingSyncResponses.shift()
        if (!resp) continue
        const generation = syncReplayGeneration
        try {
          await applySyncSinceResponse(resp, generation)
        } catch {
          replayFailed = true
          recoverFailedSyncReplay()
          return
        }
      }
    } finally {
      syncReplayProcessing = false
      if (replayFailed) {
        // Responses queued behind a failed apply were based on the same stale
        // local state. Bootstrap will establish a fresh replay boundary.
        pendingSyncResponses.length = 0
      } else if (pendingSyncResponses.length > 0) {
        // A handler can enqueue a response just after the loop drains. Start a
        // fresh drain rather than leaving it behind the previous async turn.
        syncReplayProcessing = true
        void drainSyncSinceResponses()
      }
    }
  }

  function recoverFailedSyncReplay() {
    const ws = useWsStore()
    ws.setStaleRebootstrap()
    // startBootstrap drops pending replay pages and invalidates any delayed
    // ACK so a cursor from a response that failed to apply is never sent.
    startBootstrap()
  }

  async function applySyncSinceResponse(resp: SyncSinceResponse, generation: number) {
    const ws = useWsStore()
    const previousCursor = lastAppliedEventSeq.value
    if (resp.needFullBootstrap) {
      ws.setStaleRebootstrap()
      startBootstrap()
      return
    }

    if (resp.events.length === 0) {
      advanceSyncCursor(resp.syncCursor)
      scheduleAckFlush()
      ws.setLiveSynced()
      flushOfflineQueueAfterRealtimeSync()
      drainBufferedEvents()
      recoverActiveThreadAfterRealtimeSync()
      _reloadActiveChannelHistory()
      return
    }

    for (let index = 0; index < resp.events.length; index += 1) {
      if (generation !== syncReplayGeneration) return
      const event = resp.events[index]
      applySequencedEvent(event)
      if ((index + 1) % SYNC_EVENT_CHUNK_SIZE === 0 && index + 1 < resp.events.length) {
        await yieldSyncReplayChunk()
      }
    }
    if (generation !== syncReplayGeneration) return
    advanceSyncCursor(resp.syncCursor)
    scheduleAckFlush()

    if (resp.events.length >= DEFAULT_SYNC_BATCH || resp.syncCursor > previousCursor) {
      ws.sendSyncSince(lastAppliedEventSeq.value, DEFAULT_SYNC_BATCH)
      return
    }

    ws.setLiveSynced()
    flushOfflineQueueAfterRealtimeSync()
    drainBufferedEvents()
    recoverActiveThreadAfterRealtimeSync()
    _reloadActiveChannelHistory()
  }

  /**
   * After a syncSince reconnect, the active channel's cached history may be
   * stale (e.g. the user switched channels while disconnected, or offline
   * messages were just flushed). Invalidate and reload so the user always
   * sees a fresh, complete history after reconnect.
   */
  function _reloadActiveChannelHistory() {
    const conversationId = activeChannelId.value
    if (!conversationId) return
    // Invalidate the cache so ensureConversationHistory fetches fresh data
    const state = conversationHistoryState.get(conversationId)
    if (state) {
      state.initialized = false
    }
    void ensureConversationHistory(conversationId)
  }

  function handleAckResponse(resp: AckResponse) {
    ackInFlight = false
    clearAckResponseWatchdog()
    if (!resp.ok) {
      scheduleAckRetry(true)
      return
    }
    lastAckedEventSeq.value = resp.persistedEventSeq
    pendingAckEventCount = 0
    if (lastAppliedEventSeq.value > lastAckedEventSeq.value) {
      scheduleAckFlush()
    }
  }

  function handleReadCursorAck(ack: ReadCursorAck) {
    const targetChannel = channels.value.find(channel => channel.id === ack.conversationId)
    if (targetChannel) targetChannel.unread = 0
    const targetDm = directMessages.value.find(dm => dm.id === ack.conversationId)
    if (targetDm) targetDm.unread = 0
    scheduleUnreadFeedRefresh()
  }

  function handlePresenceEvent(evt: PresenceEvent) {
    const nextPresence = newerPresenceEvent(presenceByUserId.value[evt.userId], evt)
    presenceByUserId.value[evt.userId] = nextPresence
    const ws = useWsStore()
    if (ws.state === 'BOOTSTRAPPING' || ws.state === 'RECOVERING_GAP' || ws.state === 'STALE_REBOOTSTRAP' || !bootstrapped.value) {
      bootstrapPresenceOverlay.set(evt.userId, newerPresenceEvent(bootstrapPresenceOverlay.get(evt.userId), evt))
    }
    const targetDm = directMessages.value.find(dm => dm.userId === evt.userId)
    if (targetDm) {
      targetDm.presence = nextPresence.effectivePresence === PresenceStatus.ONLINE
        ? 'online'
        : nextPresence.effectivePresence === PresenceStatus.AWAY
          ? 'away'
          : 'offline'
    }
  }

  function handleTypingEvent(evt: { conversationId: string; userId: string; expiresAt?: { seconds: bigint | string | number } | undefined; isTyping: boolean }) {
    if (!userNames.value[evt.userId]) {
      void ensureUserDirectory()
    }

    const existing = typingByConversationId.value[evt.conversationId] ?? []
    const next = existing.filter(entry => entry.userId !== evt.userId)
    if (evt.isTyping) {
      next.push({
        userId: evt.userId,
        expiresAt: evt.expiresAt ? new Date(Number(evt.expiresAt.seconds) * 1000).toISOString() : undefined,
      })
    }
    typingByConversationId.value[evt.conversationId] = next
  }

  function handleServerEvent(evt: ServerEvent) {
    if (isDirectImmediateEvent(evt)) {
      applyServerEventPayload(evt)
      return
    }
    const ws = useWsStore()
    if (ws.state === 'BOOTSTRAPPING' || ws.state === 'RECOVERING_GAP' || ws.state === 'STALE_REBOOTSTRAP' || !bootstrapped.value) {
      bufferServerEvent(evt)
      return
    }
    applySequencedEvent(evt)
  }

  function handleSendMessageAck(ack: SendMessageAck) {
    useOfflineQueue().remove(ack.clientMsgId)
    reconcileMessage(ack.conversationId, ack.clientMsgId, ack)
    reconcileThreadMessage(ack.conversationId, ack.clientMsgId, ack)
  }

  function handleReactionAck(ack: ReactionAck) {
    if (DEBUG_REACTIONS) {
      console.debug('[reactions][store] handleReactionAck', ack)
    }
    const op = pendingReactionOps.value[ack.clientOpId]
    if (!op) return
    clearTimeout(op.timeout)
    delete pendingReactionOps.value[ack.clientOpId]
    if (!ack.ok || !ack.applied) {
      rollbackReactionOp(op)
    }
  }

  function handleProtocolError(err: { requestId: string; message: string }) {
    if (!err.requestId) return
    // A protocol rejection is terminal for this delivery attempt. Do not
    // replay its durable record after reconnect, even if its bubble is gone.
    useOfflineQueue().remove(err.requestId)
    failSendByClientMsgId(err.requestId, err.message || 'Message rejected')
  }

  function handleSubscribeThreadResponse(resp: SubscribeThreadResponse) {
    const root = resp.threadRootMessageId
    clearThreadReplayResyncTimer(root)
    clearThreadReplayResponseWatchdog(root)
    if (!threadMessages.value[root]) threadMessages.value[root] = []
    for (const evt of resp.replay) {
      _upsertThreadMessage(root, {
        ..._messageEventToMessage(evt, evt.conversationId),
        serverConfirmed: true,
      })
    }
    const currentThreadSeq = resp.currentThreadSeq
    upsertThreadSummary(root, {
      replyCount: Math.max(0, Math.floor(Number(resp.replyCount))),
      lastThreadSeq: currentThreadSeq,
      lastReplyAt: threadSummaries.value[root]?.lastReplyAt,
      lastReplyUserId: threadSummaries.value[root]?.lastReplyUserId,
    })
    bumpThreadReplayVersion(root)
    if (confirmedThreadReplyCount(root) >= Math.max(0, Math.floor(Number(resp.replyCount)))) {
      incompleteThreadReplayResponses.delete(root)
      setThreadReplayStatus(root, 'idle')
      return
    }

    const incompleteResponses = (incompleteThreadReplayResponses.get(root) ?? 0) + 1
    incompleteThreadReplayResponses.set(root, incompleteResponses)
    if (!isActiveThreadWorkspace(resp.conversationId, root)) return
    if (incompleteResponses === 1) {
      setThreadReplayStatus(root, 'loading')
      requestThreadReplayRecovery(root, resp.conversationId, true)
      return
    }
    setThreadReplayStatus(root, 'error')
  }

  function registerWsHandlers() {
    const ws = useWsStore()
    ws.onServerEvent(handleServerEvent)
    ws.onSendMessageAck(handleSendMessageAck)
    ws.onReactionAck(handleReactionAck)
    ws.onSubscribeThreadResponse(handleSubscribeThreadResponse)
    ws.onBootstrapResponse(handleBootstrapResponse)
    ws.onSyncSinceResponse(handleSyncSinceResponse)
    ws.onAckResponse(handleAckResponse)
    ws.onReadCursorAck(handleReadCursorAck)
    ws.onPresenceEvent(handlePresenceEvent)
    ws.onTypingEvent(handleTypingEvent)
    ws.onSetNotificationLevelResponse(handleSetNotificationLevelResponse)
    ws.onProtocolError(handleProtocolError)
    // A view can mount after a successful reconnect (for example after
    // navigating away from chat). Deliver any unresolved durable records then.
    if (ws.state === 'LIVE_SYNCED') {
      flushOfflineQueueAfterRealtimeSync()
    }
  }

  function addMessage(msg: Message) {
    if (!messages.value[msg.channelId]) messages.value[msg.channelId] = []
    messages.value[msg.channelId].push(msg)
  }

  function queueReactionOp(clientOpId: string, channelId: string, messageId: string, emoji: string, op: 'add' | 'remove') {
    if (DEBUG_REACTIONS) {
      console.debug('[reactions][store] queueReactionOp', { clientOpId, channelId, messageId, emoji, op })
    }
    const msg = _findMessage(channelId, messageId)
    if (!msg) return
    applyOptimisticReaction(msg, emoji, op)

    const timeout = setTimeout(() => {
      const current = pendingReactionOps.value[clientOpId]
      if (!current) return
      delete pendingReactionOps.value[clientOpId]
      rollbackReactionOp(current)
    }, REACTION_OP_TIMEOUT_MS)

    pendingReactionOps.value[clientOpId] = {
      channelId,
      messageId,
      emoji,
      op,
      timeout,
    }
  }

  function rollbackReactionOp(op: PendingReactionOp) {
    if (DEBUG_REACTIONS) {
      console.debug('[reactions][store] rollbackReactionOp', op)
    }
    const msg = _findMessage(op.channelId, op.messageId)
    if (!msg) return
    if (op.op === 'add') {
      applyOptimisticReaction(msg, op.emoji, 'remove')
    } else {
      applyOptimisticReaction(msg, op.emoji, 'add')
    }
    showToast('Reaction failed. Try again.')
  }

  function applyOptimisticReaction(msg: Message, emoji: string, op: 'add' | 'remove') {
    const mine = msg.myReactions.includes(emoji)
    const idx = msg.reactions.findIndex(reaction => reaction.emoji === emoji)
    if (op === 'add') {
      if (mine) return
      _setMyReaction(msg, emoji, true)
      if (idx === -1) {
        msg.reactions.push({ emoji, count: 1 })
      } else {
        msg.reactions[idx].count += 1
      }
      return
    }
    if (!mine) return
    _setMyReaction(msg, emoji, false)
    if (idx === -1) return
    const nextCount = msg.reactions[idx].count - 1
    if (nextCount <= 0) {
      msg.reactions.splice(idx, 1)
      return
    }
    msg.reactions[idx].count = nextCount
  }

  function isReactionOpPending(channelId: string, messageId: string, emoji: string): boolean {
    return Object.values(pendingReactionOps.value).some(op =>
      op.channelId === channelId
      && op.messageId === messageId
      && op.emoji === emoji
    )
  }

  function showToast(message: string) {
    const id = Date.now()
    toast.value = { id, message }
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      if (toast.value?.id === id) {
        toast.value = null
      }
    }, TOAST_DURATION_MS)
  }

  function bufferServerEvent(evt: ServerEvent) {
    if (evt.eventId && bufferedServerEvents.some(existing => existing.eventId === evt.eventId)) return
    bufferedServerEvents.push(evt)
    bufferedServerEvents.sort((a, b) => Number(a.eventSeq - b.eventSeq))
    if (bufferedServerEvents.length > MAX_BUFFERED_SERVER_EVENTS) {
      bufferedServerEvents = bufferedServerEvents.slice(-MAX_BUFFERED_SERVER_EVENTS)
    }
  }

  function drainBufferedEvents() {
    if (bufferedServerEvents.length === 0) return
    const queued = bufferedServerEvents.slice()
    bufferedServerEvents = []
    for (const evt of queued) {
      applySequencedEvent(evt)
    }
  }

  function applySequencedEvent(evt: ServerEvent) {
    if (evt.eventSeq <= lastAppliedEventSeq.value) return
    applyContiguousEvent(evt)
  }

  function applyContiguousEvent(evt: ServerEvent): boolean {
    if (evt.eventSeq <= lastAppliedEventSeq.value) return true
    if (evt.eventId && seenEventIds.has(evt.eventId)) {
      advanceSyncCursor(evt.eventSeq)
      return true
    }

    applyServerEventPayload(evt)

    if (evt.eventId) {
      seenEventIds.add(evt.eventId)
      if (seenEventIds.size > 512) {
        const ids = Array.from(seenEventIds).slice(-256)
        seenEventIds = new Set(ids)
      }
    }
    advanceSyncCursor(evt.eventSeq)
    pendingAckEventCount += 1
    scheduleAckFlush()
    return true
  }

  function advanceSyncCursor(nextSeq: bigint) {
    if (nextSeq <= lastAppliedEventSeq.value) return
    lastAppliedEventSeq.value = nextSeq
    syncCursorPersistDirty = true
    scheduleSyncCursorPersistence()
  }

  function replaceSyncCursor(nextSeq: bigint) {
    lastAppliedEventSeq.value = nextSeq
    syncCursorPersistDirty = lastPersistedSyncCursor !== nextSeq
    if (!persistSyncCursor()) {
      scheduleSyncCursorPersistence()
    }
  }

  function persistSyncCursor(): boolean {
    if (!syncCursorPersistDirty && lastPersistedSyncCursor === lastAppliedEventSeq.value) return true
    if (!saveLastAppliedEventSeq(lastAppliedEventSeq.value)) return false
    lastPersistedSyncCursor = lastAppliedEventSeq.value
    syncCursorPersistDirty = false
    return true
  }

  function scheduleSyncCursorPersistence(delayMs = SYNC_CURSOR_PERSIST_DELAY_MS) {
    if (!syncCursorPersistDirty || syncCursorPersistTimer) return
    syncCursorPersistTimer = setTimeout(() => {
      syncCursorPersistTimer = null
      if (!persistSyncCursor()) {
        scheduleSyncCursorPersistence(SYNC_CURSOR_PERSIST_RETRY_MS)
      }
    }, delayMs)
  }

  function clearAckResponseWatchdog() {
    if (!ackResponseTimer) return
    clearTimeout(ackResponseTimer)
    ackResponseTimer = null
  }

  function cancelScheduledAckTimer() {
    ackRetryPending = false
    if (!ackTimer) return
    clearTimeout(ackTimer)
    ackTimer = null
  }

  function clearScheduledAck() {
    ackScheduleGeneration += 1
    cancelScheduledAckTimer()
  }

  function scheduleAckRetry(retrying = false) {
    if (ackTimer || lastAppliedEventSeq.value <= lastAckedEventSeq.value) return
    ackRetryPending = retrying
    const generation = ackScheduleGeneration
    const timer = setTimeout(() => {
      if (ackTimer === timer) {
        ackTimer = null
        ackRetryPending = false
      }
      if (generation !== ackScheduleGeneration) return
      flushAck(generation)
    }, ACK_INTERVAL_MS)
    ackTimer = timer
  }

  function flushAck(generation = ackScheduleGeneration) {
    if (generation !== ackScheduleGeneration) return
    if (lastAppliedEventSeq.value <= lastAckedEventSeq.value || ackInFlight) return
    // Do not tell the server an event is durable until its replay cursor has
    // actually reached local storage. If persistence is unavailable, replaying
    // after reconnect is safer than silently losing an event.
    if (!persistSyncCursor()) {
      scheduleSyncCursorPersistence(SYNC_CURSOR_PERSIST_RETRY_MS)
      scheduleAckRetry(true)
      return
    }
    const ws = useWsStore()
    let sent: boolean | void
    try {
      sent = ws.sendAck(lastAppliedEventSeq.value)
    } catch {
      scheduleAckRetry(true)
      return
    }
    // Existing test doubles and older transports return void; only an explicit
    // false means the ACK did not reach the socket send path.
    if (sent === false || generation !== ackScheduleGeneration) {
      if (generation === ackScheduleGeneration) scheduleAckRetry(true)
      return
    }
    ackInFlight = true
    clearAckResponseWatchdog()
    const responseTimer = setTimeout(() => {
      if (ackResponseTimer === responseTimer) {
        ackResponseTimer = null
      }
      if (generation !== ackScheduleGeneration) return
      ackInFlight = false
      scheduleAckRetry(true)
    }, ACK_RESPONSE_TIMEOUT_MS)
    ackResponseTimer = responseTimer
  }

  function scheduleAckFlush() {
    if (lastAppliedEventSeq.value <= lastAckedEventSeq.value) return
    if (ackInFlight) return
    if (pendingAckEventCount >= ACK_BATCH_SIZE && !ackRetryPending) {
      cancelScheduledAckTimer()
      flushAck()
      return
    }
    scheduleAckRetry()
  }

  function applyServerEventPayload(evt: ServerEvent) {
    switch (evt.payload.case) {
      case 'messageCreated':
        _onMessageCreated(evt.payload.value)
        break
      case 'threadSummaryUpdated':
        _onThreadSummaryUpdated(evt.payload.value)
        break
      case 'reactionUpdated':
        _onReactionUpdated(evt.payload.value)
        break
      case 'messageUpdated':
        _onMessageUpdated(evt.payload.value)
        break
      case 'messageDeleted':
        _onMessageDeleted(evt.payload.value)
        break
      case 'dmHistoryCleared':
        applyDMHistoryCleared(evt.payload.value)
        break
      case 'secretHistoryInvalidated':
        invalidateSecretHistory(evt.payload.value.conversationId)
        break
      case 'conversationUpserted':
        applyConversationSummary(evt.payload.value.conversation)
        break
      case 'conversationRemoved':
        removeConversation(evt.payload.value.conversationId)
        break
      case 'readCounterUpdated':
        applyReadCounterUpdate(evt.payload.value)
        break
      case 'notificationAdded':
        applyNotificationAdded(evt.payload.value)
        break
      case 'notificationResolved':
        notifications.value = notifications.value.filter(item => item.id !== (evt.payload.value as NotificationResolvedEvent).notificationId)
        scheduleUnreadFeedRefresh()
        break
      case 'callStateChanged':
        applyCallStateChanged(evt.payload.value)
        break
      case 'callRaisedHandsChanged':
        applyCallRaisedHandsChanged(evt.payload.value)
        break
      case 'userCallPresenceChanged':
        applyUserCallPresenceChanged(evt.payload.value)
        break
      case 'callInviteCreated':
        applyInviteCreated(evt.payload.value)
        break
      case 'callInviteCancelled':
        pendingInvites.value = pendingInvites.value.filter(item => item.id !== (evt.payload.value as CallInviteCancelledEvent).inviteId)
        break
      case 'forcePasswordChange':
        useAuthStore().setNeedChangePassword(true)
        break
      case 'userIdentityUpdated':
        applyUserIdentityUpdated(evt.payload.value)
        break
      case 'notificationLevelChanged':
        applyNotificationLevelChanged(evt.payload.value)
        break
      case 'taskStatusChanged':
        emitTaskStatusChangedNotification(evt.payload.value)
        break
      case 'messageAlert':
        applyMessageAlert(evt.payload.value)
        break
      default:
        break
    }
  }

  function isDirectImmediateEvent(evt: ServerEvent): boolean {
    if (evt.eventSeq !== 0n) return false
    return evt.payload.case === 'conversationUpserted'
      || evt.payload.case === 'conversationRemoved'
      || evt.payload.case === 'readCounterUpdated'
      || evt.payload.case === 'notificationAdded'
      || evt.payload.case === 'notificationResolved'
      || evt.payload.case === 'callInviteCreated'
      || evt.payload.case === 'callInviteCancelled'
      || evt.payload.case === 'forcePasswordChange'
      || evt.payload.case === 'notificationLevelChanged'
      || evt.payload.case === 'taskStatusChanged'
      || evt.payload.case === 'messageAlert'
  }

  function applyConversationSummary(summary?: ConversationSummary) {
    if (!summary) return
    const unread = currentUnread(summary.conversationId)
    const hasUnreadThreadReplies = currentHasUnreadThreadReplies(summary.conversationId)
    // ConversationUpserted events from direct delivery may not carry notification_level.
    // Preserve the current level if the summary doesn't provide one (defaults to ALL=0).
    const currentLevel = currentNotificationLevel(summary.conversationId)
    const notificationLevel = summary.notificationLevel || currentLevel
    if (summary.conversationType === ConversationType.DM) {
      const dmUserId = summary.topic || summary.conversationId
      registerUserName(dmUserId, summary.title)
      const next: DirectMessage = {
        id: summary.conversationId,
        userId: dmUserId,
        displayName: summary.title,
        avatarUrl: resolveAvatarUrl(dmUserId),
        presence: resolveConversationPresence(summary.presence, dmUserId),
        encryptionMode: encryptionModeFromSummary(summary),
        unread,
        hasUnreadThreadReplies,
        lastMessageSeq: summary.lastMessageSeq,
        notificationLevel,
      }
      upsertDirectMessage(next)
      return
    }

    const next: Channel = {
      id: summary.conversationId,
      name: summary.title,
      kind: 'channel',
      visibility: summary.conversationType === ConversationType.CHANNEL_PRIVATE ? 'private' : 'public',
      unread,
      hasUnreadThreadReplies,
      lastMessageSeq: summary.lastMessageSeq,
      lastActivityAt: summary.lastActivityAt
        ? new Date(Number(summary.lastActivityAt.seconds) * 1000).toISOString()
        : undefined,
      notificationLevel,
    }
    upsertChannel(next)
  }

  function applyReadCounterUpdate(evt: ReadCounterUpdatedEvent) {
    const counter = evt.counter
    if (!counter) return
    const targetChannel = channels.value.find(channel => channel.id === counter.conversationId)
    if (targetChannel) {
      targetChannel.unread = counter.unreadMessages
      targetChannel.hasUnreadThreadReplies = counter.hasUnreadThreadReplies
    }
    const targetDm = directMessages.value.find(dm => dm.id === counter.conversationId)
    if (targetDm) {
      targetDm.unread = counter.unreadMessages
      targetDm.hasUnreadThreadReplies = counter.hasUnreadThreadReplies
    }
    if (counter.hasUnreadThreadReplies && activeThreadConversationId.value === counter.conversationId && activeThreadRootId.value) {
      maybeRecoverActiveThread(activeThreadRootId.value, counter.conversationId)
    }
    scheduleUnreadFeedRefresh()
  }

  function applyNotificationAdded(evt: NotificationAddedEvent) {
    if (!evt.notification) return
    const senderName = decodeNotificationText(evt.notification.title) || 'Msgnr'
    const body = decodeNotificationText(evt.notification.body)
    // Add first so visible-target resolution can look up this notification by message/thread target.
    notifications.value = [
      notificationSummaryToItem(evt.notification),
      ...notifications.value.filter(item => item.id !== evt.notification?.notificationId),
    ]
    const conversationId = evt.notification.conversationId
    const messageId = evt.notification.messageId
    const threadRootMessageId = evt.notification.threadRootMessageId
    if (threadRootMessageId && isVisibleMessageTarget(conversationId, threadRootMessageId)) {
      markVisibleThreadRead(conversationId, threadRootMessageId)
      return
    }
    if (messageId && !threadRootMessageId && isVisibleMessageTarget(conversationId)) {
      const messageSeq = messages.value[conversationId]?.find(item => item.id === messageId)?.channelSeq ?? 0n
      markVisibleConversationRead(conversationId, messageSeq, messageId)
      return
    }
    const isHighPriorityNotification =
      evt.notification.type === NotificationType.MENTION
      || evt.notification.type === NotificationType.THREAD_REPLY
    // Visible targets already returned above. Hidden mentions/thread replies still need attention while active;
    // inactive windows emit all server-routed notifications so native/browser delivery can decide presentation.
    const shouldEmitIncoming = isHighPriorityNotification || !isClientTabActive()
    if (shouldEmitIncoming) {
      emitIncomingMessageNotification({
        reason: evt.notification.type === NotificationType.MENTION ? 'mention' : 'notification',
        conversationId: evt.notification.conversationId,
        messageId: messageId || undefined,
        threadRootMessageId: threadRootMessageId || undefined,
        senderId: '',
        senderName,
        body,
        attachmentCount: 0,
      })
    }
    if (!conversationId) return
    scheduleUnreadFeedRefresh()
    if (conversationExists(conversationId)) return
    const ws = useWsStore()
    if (ws.state === 'BOOTSTRAPPING' || ws.state === 'RECOVERING_GAP' || ws.state === 'STALE_REBOOTSTRAP') return
    startBootstrap()
  }

  function applyMessageAlert(evt: MessageAlertEvent) {
    if (isVisibleMessageTarget(evt.conversationId, evt.threadRootMessageId)) return
    emitIncomingMessageNotification({
      reason: 'message_alert',
      conversationId: evt.conversationId,
      messageId: evt.messageId,
      threadRootMessageId: evt.threadRootMessageId || undefined,
      senderId: evt.senderId,
      senderName: decodeNotificationText(evt.senderName),
      body: decodeNotificationText(evt.body),
      attachmentCount: evt.attachmentCount,
    })
  }

  function applyNotificationLevelChanged(evt: NotificationLevelChangedEvent) {
    const channel = channels.value.find(c => c.id === evt.conversationId)
    if (channel) {
      channel.notificationLevel = evt.level
    }
    const dm = directMessages.value.find(d => d.id === evt.conversationId)
    if (dm) {
      dm.notificationLevel = evt.level
    }
    scheduleUnreadFeedRefresh()
  }

  // Tracks the pending notification level request for optimistic rollback.
  // Only one request can be in-flight at a time (the UI shows one dropdown).
  // If the server doesn't confirm within NOTIFICATION_LEVEL_TIMEOUT_MS, or
  // returns an error, the optimistic update is rolled back.
  const NOTIFICATION_LEVEL_TIMEOUT_MS = 10_000
  let pendingNotificationLevelChange: {
    requestId: string
    conversationId: string
    previousLevel: NotificationLevel
    timer: ReturnType<typeof setTimeout>
  } | null = null

  function setNotificationLevel(conversationId: string, level: NotificationLevel) {
    // Cancel any previous in-flight request.
    clearPendingNotificationLevelChange()

    const previous = currentNotificationLevel(conversationId)

    // Optimistic update
    const channel = channels.value.find(c => c.id === conversationId)
    if (channel) channel.notificationLevel = level
    const dm = directMessages.value.find(d => d.id === conversationId)
    if (dm) dm.notificationLevel = level

    // Send WS command — returns the requestId for correlation.
    const requestId = useWsStore().sendSetNotificationLevel(conversationId, level)

    // Start a rollback timer. If the server doesn't respond, revert.
    const timer = setTimeout(() => {
      if (pendingNotificationLevelChange?.requestId === requestId) {
        rollbackNotificationLevel(conversationId, previous)
        pendingNotificationLevelChange = null
      }
    }, NOTIFICATION_LEVEL_TIMEOUT_MS)

    pendingNotificationLevelChange = { requestId, conversationId, previousLevel: previous, timer }
  }

  function handleSetNotificationLevelResponse(_resp: import('@/shared/proto/packets_pb').SetNotificationLevelResponse) {
    // Server confirmed. Clear the pending state — the optimistic update stands.
    clearPendingNotificationLevelChange()
  }

  function clearPendingNotificationLevelChange() {
    if (pendingNotificationLevelChange) {
      clearTimeout(pendingNotificationLevelChange.timer)
      pendingNotificationLevelChange = null
    }
  }

  function rollbackNotificationLevel(conversationId: string, level: NotificationLevel) {
    const ch = channels.value.find(c => c.id === conversationId)
    if (ch) ch.notificationLevel = level
    const dm = directMessages.value.find(d => d.id === conversationId)
    if (dm) dm.notificationLevel = level
  }

  function applyCallStateChanged(evt: CallStateChangedEvent) {
    const existing = activeCalls.value.find(call => call.id === evt.callId)
    activeCalls.value = activeCalls.value.filter(call => call.id !== evt.callId)
    if (evt.status === CallStatus.ACTIVE) {
      activeCalls.value.unshift({
        id: evt.callId,
        conversationId: evt.conversationId,
        status: evt.status.toString(),
        participantCount: 0,
        raisedHands: existing?.raisedHands ?? [],
      })
    }
  }

  function normalizeRaisedHands(hands: readonly RaisedHand[]): RaisedHand[] {
    return hands
      .filter(hand => Boolean(hand.userId) && Number.isInteger(hand.position) && hand.position > 0)
      .slice()
      .sort((a, b) => a.position - b.position)
      .map(hand => ({ userId: hand.userId, position: hand.position }))
  }

  function applyCallRaisedHandsSnapshot(callId: string, conversationId: string, raisedHands: readonly RaisedHand[]) {
    const queue = normalizeRaisedHands(raisedHands)
    const existing = activeCalls.value.find(call => call.id === callId)
    if (existing) {
      existing.raisedHands = queue
      return
    }
    activeCalls.value.unshift({
      id: callId,
      conversationId,
      status: CallStatus.ACTIVE.toString(),
      participantCount: 0,
      raisedHands: queue,
    })
  }

  function applyCallRaisedHandsChanged(evt: CallRaisedHandsChangedEvent) {
    applyCallRaisedHandsSnapshot(evt.callId, evt.conversationId, evt.raisedHands)
  }

  function applyUserCallPresenceChanged(evt: UserCallPresenceChangedEvent) {
    if (evt.activeCallCount > 0) {
      userCallPresenceByUserId.value[evt.userId] = evt.activeCallCount
      return
    }
    delete userCallPresenceByUserId.value[evt.userId]
  }

  function applyInviteCreated(evt: CallInviteCreatedEvent) {
    if (!evt.invite) return
    pendingInvites.value = [
      callInviteSummaryToItem(evt.invite),
      ...pendingInvites.value.filter(item => item.id !== evt.invite?.inviteId),
    ]
  }

  function onIncomingMessageNotification(handler: IncomingMessageNotificationHandler): () => void {
    incomingMessageNotificationHandlers.add(handler)
    return () => {
      incomingMessageNotificationHandlers.delete(handler)
    }
  }

  function emitIncomingMessageNotification(evt: IncomingMessageNotification) {
    for (const handler of incomingMessageNotificationHandlers) {
      try {
        handler(evt)
      } catch {
        // Best effort callback fanout: one listener failure must not break chat flow.
      }
    }
  }

  function onTaskStatusChanged(handler: TaskStatusChangedNotificationHandler): () => void {
    taskStatusChangedNotificationHandlers.add(handler)
    return () => {
      taskStatusChangedNotificationHandlers.delete(handler)
    }
  }

  function emitTaskStatusChangedNotification(evt: TaskStatusChangedEvent) {
    const updatedAt = evt.updatedAt
      ? new Date(Number(evt.updatedAt.seconds) * 1000).toISOString()
      : new Date().toISOString()
    const payload: TaskStatusChangedNotification = {
      taskId: evt.taskId,
      publicId: evt.publicId,
      fromStatusId: evt.fromStatusId,
      toStatusId: evt.toStatusId,
      updatedBy: evt.updatedBy,
      updatedAt,
    }
    for (const handler of taskStatusChangedNotificationHandlers) {
      try {
        handler(payload)
      } catch {
        // Best effort callback fanout: one listener failure must not break chat flow.
      }
    }
  }

  function applyUserIdentityUpdated(evt: {
    userId: string
    displayName: string
    avatarUrl: string
    customStatus?: Parameters<typeof userCustomStatusFromProto>[0]
  }) {
    registerUserIdentity(evt.userId, evt.displayName, undefined, evt.avatarUrl, userCustomStatusFromProto(evt.customStatus))
  }

  function removeConversation(conversationId: string) {
    const authStore = useAuthStore()
    const workspaceId = workspace.value?.id || workspace.value?.name || ''
    const userId = workspace.value?.selfUserId || authStore.user?.id || ''
    const persisted = loadLastOpenedConversation(workspaceId, userId)
    if (persisted === conversationId) {
      clearActiveConversationSelection()
    }
    channels.value = channels.value.filter(channel => channel.id !== conversationId)
    directMessages.value = directMessages.value.filter(dm => dm.id !== conversationId)
    cancelScheduledMessageCache(conversationId)
    pendingReadByConversation.delete(conversationId)
    conversationHistoryState.delete(conversationId)
    historyLoadTokenByConversation.delete(conversationId)
    const nextInitialLoading = { ...conversationInitialLoadingById.value }
    delete nextInitialLoading[conversationId]
    conversationInitialLoadingById.value = nextInitialLoading
    delete messages.value[conversationId]
    if (activeThreadConversationId.value === conversationId) {
      closeThread()
    }
    if (activeChannelId.value === conversationId) {
      const fallbackConversation = firstPublicChannelId(channels.value)
      activeChannelId.value = fallbackConversation
      if (fallbackConversation) {
        requestConversationComposerFocus()
        saveActiveConversationSelection(fallbackConversation)
      } else {
        clearActiveConversationSelection()
      }
    }
    scheduleUnreadFeedRefresh()
  }

  function clearDMConversationHistoryLocal(conversationId: string) {
    if (!conversationId) return
    messageStateGeneration += 1

    cancelScheduledMessageCache(conversationId)

    const rootIds = new Set((messages.value[conversationId] ?? []).map(message => message.id))
    for (const [rootId, replies] of Object.entries(threadMessages.value)) {
      if (rootIds.has(rootId) || replies.some(reply => reply.channelId === conversationId)) {
        delete threadMessages.value[rootId]
        delete threadReplayVersionByRoot.value[rootId]
        delete threadReplayStatusByRoot.value[rootId]
        delete threadSummaries.value[rootId]
        incompleteThreadReplayResponses.delete(rootId)
      }
    }

    messages.value[conversationId] = []
    pendingReadByConversation.delete(conversationId)
    historyLoadTokenByConversation.set(conversationId, ++historyLoadToken)
    conversationHistoryState.set(conversationId, {
      initialized: true,
      loading: false,
      hasMore: false,
    })
    if (conversationInitialLoadingById.value[conversationId]) {
      conversationInitialLoadingById.value = {
        ...conversationInitialLoadingById.value,
        [conversationId]: false,
      }
    }

    const dm = directMessages.value.find(item => item.id === conversationId)
    if (dm) {
      dm.unread = 0
      dm.hasUnreadThreadReplies = false
    }

    if (activeThreadConversationId.value === conversationId) {
      closeThread()
    }
    notifications.value = notifications.value.filter(item => item.conversationId !== conversationId)
    unreadFeedItems.value = unreadFeedItems.value.filter(item => item.conversationId !== conversationId)
    unreadFeedTotalCount.value = unreadFeedItems.value.length
    if (savedMessagesLoaded.value) {
      savedMessageItems.value = savedMessageItems.value.filter(item => item.conversationId !== conversationId)
      savedMessageTotalCount.value = savedMessageItems.value.length
    }

    void clearCachedMessages(conversationId)
    scheduleUnreadFeedRefresh()
  }

  function invalidateSecretHistory(conversationId: string, reload = true) {
    if (!conversationId) return
    secretHistoryGeneration.set(conversationId, (secretHistoryGeneration.get(conversationId) ?? 0) + 1)
    const dm = directMessages.value.find(item => item.id === conversationId)
    const unread = dm?.unread ?? 0
    const hasUnreadThreadReplies = dm?.hasUnreadThreadReplies ?? false
    clearDMConversationHistoryLocal(conversationId)
    // Deletion of one message is not a read action. Server counters arrive
    // independently and must not be overwritten by local cache invalidation.
    if (dm) {
      dm.unread = unread
      dm.hasUnreadThreadReplies = hasUnreadThreadReplies
    }
    if (activeChannelId.value === conversationId) clearFocusedMessages()
    conversationHistoryState.set(conversationId, { initialized: false, loading: false, hasMore: true })
    if (reload && activeChannelId.value === conversationId) void ensureConversationHistory(conversationId)
  }

  function applyDMHistoryCleared(evt: DmHistoryClearedEvent) {
    // Persisted event only: it is intentionally not listed as a seq=0 direct-immediate event.
    clearDMConversationHistoryLocal(evt.conversationId)
  }

  async function clearDMConversationHistory(conversationId: string): Promise<void> {
    await clearDMConversationHistoryApi(conversationId)
    clearDMConversationHistoryLocal(conversationId)
  }

  function removeConversationLocal(conversationId: string) {
    removeConversation(conversationId)
  }

  function upsertChannel(channel: Channel) {
    if (!messages.value[channel.id]) messages.value[channel.id] = []
    const idx = channels.value.findIndex(existing => existing.id === channel.id)
    if (idx === -1) {
      channels.value.unshift(channel)
    } else {
      channels.value.splice(idx, 1, channel)
    }
  }

  function upsertDirectMessage(dm: DirectMessage) {
    registerUserIdentity(dm.userId, dm.displayName, undefined, dm.avatarUrl ?? '', dm.customStatus ?? null)
    const idx = directMessages.value.findIndex(existing => existing.id === dm.id)
    if (idx === -1) {
      directMessages.value.unshift(dm)
    } else {
      directMessages.value.splice(idx, 1, dm)
    }
    void cacheConversations(channels.value, directMessages.value)
  }

  function markDirectMessageEncrypted(conversationId: string) {
    const dm = directMessages.value.find(item => item.id === conversationId)
    if (!dm) return
    dm.encryptionMode = 'dm_pairwise_signal_v1'
    void cacheConversations(channels.value, directMessages.value)
  }

  function openDirectMessage(dm: DirectMessage) {
    upsertDirectMessage(dm)
    if (!messages.value[dm.id]) messages.value[dm.id] = []
    activeChannelId.value = dm.id
    showConversationView()
    clearFocusedMessages()
    requestConversationComposerFocus()
    saveActiveConversationSelection(dm.id)
    closeThread()
    const target = directMessages.value.find(item => item.id === dm.id)
    if (target) target.unread = 0
    void ensureConversationHistory(dm.id)
  }

  function currentUnread(conversationId: string): number {
    return channels.value.find(channel => channel.id === conversationId)?.unread
      ?? directMessages.value.find(dm => dm.id === conversationId)?.unread
      ?? 0
  }

  function currentHasUnreadThreadReplies(conversationId: string): boolean {
    return channels.value.find(channel => channel.id === conversationId)?.hasUnreadThreadReplies
      ?? directMessages.value.find(dm => dm.id === conversationId)?.hasUnreadThreadReplies
      ?? false
  }

  function currentNotificationLevel(conversationId: string): NotificationLevel {
    return channels.value.find(channel => channel.id === conversationId)?.notificationLevel
      ?? directMessages.value.find(dm => dm.id === conversationId)?.notificationLevel
      ?? NotificationLevel.ALL
  }

  function conversationExists(conversationId: string): boolean {
    return channels.value.some(channel => channel.id === conversationId) || directMessages.value.some(dm => dm.id === conversationId)
  }

  function presenceEventTimestampMs(evt?: PresenceEvent): number {
    if (!evt?.lastActiveAt) return -1
    const seconds = Number(evt.lastActiveAt.seconds ?? 0)
    const nanos = Number(evt.lastActiveAt.nanos ?? 0)
    return seconds * 1000 + Math.floor(nanos / 1_000_000)
  }

  function newerPresenceEvent(current: PresenceEvent | undefined, incoming: PresenceEvent): PresenceEvent {
    if (!current) return incoming
    const currentTs = presenceEventTimestampMs(current)
    const incomingTs = presenceEventTimestampMs(incoming)
    if (incomingTs > currentTs) return incoming
    if (incomingTs < currentTs) return current
    return incoming
  }

  function resolveConversationPresence(
    summaryPresence: PresenceStatus,
    userId: string,
  ): 'online' | 'away' | 'offline' {
    const effectivePresence = presenceByUserId.value[userId]?.effectivePresence ?? summaryPresence
    return effectivePresence === PresenceStatus.ONLINE
      ? 'online'
      : effectivePresence === PresenceStatus.AWAY
        ? 'away'
        : 'offline'
  }

  function _onMessageCreated(evt: ProtoMessageEvent) {
    const channelId = evt.conversationId
    const msg = _messageEventToMessage(evt, channelId)

    if (evt.threadRootMessageId) {
      const rootId = evt.threadRootMessageId
      const alreadyPresentInThread = (threadMessages.value[rootId] ?? []).some(item => item.id === evt.messageId)
      _upsertThreadMessage(rootId, msg)
      decryptAndApplyMessage(
        msg,
        evt.encryptedDmPayload?.recipients,
        () => threadMessages.value[rootId]?.find(item => item.id === msg.id),
      )
      const known = threadSummaries.value[rootId]
      const nextLastThreadSeq = known?.lastThreadSeq && known.lastThreadSeq > evt.threadSeq
        ? known.lastThreadSeq
        : evt.threadSeq
      const knownReplyCount = known?.replyCount ?? 0
      const optimisticReplyCount = alreadyPresentInThread
        ? knownReplyCount
        : knownReplyCount + 1
      upsertThreadSummary(rootId, {
        replyCount: Math.max(optimisticReplyCount, 0),
        lastThreadSeq: nextLastThreadSeq,
        lastReplyAt: msg.createdAt,
        lastReplyUserId: evt.senderId,
      })
      if (nextLastThreadSeq <= highestConfirmedThreadSeq(rootId)) {
        clearThreadReplayResyncTimer(rootId)
      } else {
        maybeRecoverActiveThread(rootId, channelId)
      }
      if (isVisibleMessageTarget(channelId, rootId)) {
        markVisibleThreadRead(channelId, rootId)
        return
      }
      scheduleUnreadFeedRefresh()
      return
    }

    if (!messages.value[channelId]) messages.value[channelId] = []
    const alreadyPresent = messages.value[channelId].some(m => m.id === evt.messageId)
    if (alreadyPresent) return

    messages.value[channelId].push(msg)
    decryptAndApplyMessage(
      msg,
      evt.encryptedDmPayload?.recipients,
      () => messages.value[channelId]?.find(item => item.id === msg.id),
    )
    scheduleMessageCache(channelId, messages.value[channelId])
    const channel = channels.value.find(item => item.id === channelId)
    if (channel) channel.lastMessageSeq = evt.channelSeq
    const dm = directMessages.value.find(item => item.id === channelId)
    if (dm) dm.lastMessageSeq = evt.channelSeq
    if (isVisibleMessageTarget(channelId)) {
      markVisibleConversationRead(channelId, evt.channelSeq, evt.messageId)
      return
    }
    if (channelId === activeChannelId.value && !isClientTabActive()) {
      queuePendingReadMark(channelId, evt.channelSeq)
    }
    scheduleUnreadFeedRefresh()
  }

  function isClientTabActive(): boolean {
    return clientIsActive
  }

  function setClientActive(active: boolean) {
    clientIsActive = active
  }

  function queuePendingReadMark(conversationId: string, lastReadSeq: bigint) {
    const current = pendingReadByConversation.get(conversationId) ?? 0n
    if (lastReadSeq > current) {
      pendingReadByConversation.set(conversationId, lastReadSeq)
    }
  }

  function clearUnreadForConversation(conversationId: string) {
    const channel = channels.value.find(item => item.id === conversationId)
    if (channel) channel.unread = 0
    const dm = directMessages.value.find(item => item.id === conversationId)
    if (dm) dm.unread = 0
  }

  function sendReadMark(conversationId: string, lastReadSeq: bigint) {
    useWsStore().sendUpdateReadCursor(conversationId, lastReadSeq)
    clearUnreadForConversation(conversationId)
    pendingReadByConversation.delete(conversationId)
  }

  function requestReadMark(conversationId: string, lastReadSeq: bigint) {
    if (isClientTabActive()) {
      sendReadMark(conversationId, lastReadSeq)
      return
    }
    queuePendingReadMark(conversationId, lastReadSeq)
  }

  async function markUnreadFeedItemRead(item: UnreadFeedItem): Promise<void> {
    if (!item?.id || !item.conversationId) return
    const rootMessageId = item.threadRootMessageId || item.messageId
    if (rootMessageId) {
      const rootMessage = (messages.value[item.conversationId] ?? []).find(message => message.id === rootMessageId)
      await markThreadUnreadAsRead(item.conversationId, rootMessageId, rootMessage?.channelSeq ?? 0n)
      return
    }

    if (item.notificationId) {
      await resolveUnreadFeedNotification(item.notificationId)
      removeUnreadFeedItemLocally(item.id, item.notificationId)
    }
  }

  function onClientFocus() {
    if (!isClientTabActive()) return
    scrubVisibleUnreadTargets()
    const conversationId = activeChannelId.value
    if (!conversationId) return

    const pendingSeq = pendingReadByConversation.get(conversationId)
    if (typeof pendingSeq === 'bigint' && pendingSeq > 0n) {
      sendReadMark(conversationId, pendingSeq)
      return
    }

    const channel = channels.value.find(item => item.id === conversationId)
    if (channel && channel.unread > 0 && typeof channel.lastMessageSeq === 'bigint' && channel.lastMessageSeq > 0n) {
      sendReadMark(conversationId, channel.lastMessageSeq)
      return
    }
    const dm = directMessages.value.find(item => item.id === conversationId)
    if (dm && dm.unread > 0 && typeof dm.lastMessageSeq === 'bigint' && dm.lastMessageSeq > 0n) {
      sendReadMark(conversationId, dm.lastMessageSeq)
    }
  }

  function _onThreadSummaryUpdated(evt: ThreadSummaryUpdatedEvent) {
    const root = evt.threadRootMessageId
    const eventLastSeq = evt.lastThreadSeq >= 0n ? evt.lastThreadSeq : 0n
    const knownLastSeq = threadSummaries.value[root]?.lastThreadSeq ?? 0n
    upsertThreadSummary(root, {
      replyCount: Math.max(0, Math.floor(Number(evt.replyCount))),
      lastThreadSeq: knownLastSeq > eventLastSeq ? knownLastSeq : eventLastSeq,
      lastReplyAt: evt.lastThreadReplyAt
        ? new Date(Number(evt.lastThreadReplyAt.seconds) * 1000).toISOString()
        : undefined,
      lastReplyUserId: evt.lastThreadReplyUserId,
    })
    maybeRecoverActiveThread(root, evt.conversationId)
  }

  function _onReactionUpdated(evt: ReactionUpdatedEvent) {
    if (DEBUG_REACTIONS) {
      console.debug('[reactions][store] reactionUpdated:event', evt)
    }
    const candidates: Message[] = []
    const list = messages.value[evt.conversationId]
    if (list) {
      const msg = list.find(m => m.id === evt.messageId)
      if (msg) candidates.push(msg)
    }
    for (const rootId of Object.keys(threadMessages.value)) {
      const msg = threadMessages.value[rootId]?.find(item => item.id === evt.messageId)
      if (msg) candidates.push(msg)
    }
    for (const msg of candidates) {
      const idx = msg.reactions.findIndex(r => r.emoji === evt.emoji)
      if (evt.count <= 0) {
        if (idx !== -1) msg.reactions.splice(idx, 1)
      } else if (idx === -1) {
        msg.reactions.push({ emoji: evt.emoji, count: evt.count })
      } else {
        msg.reactions[idx].count = evt.count
      }
    }
  }

  function _onMessageUpdated(evt: MessageUpdatedEvent) {
    const apply = (msg: Message) => {
      const entities = normalizeMessageEntities(evt.entities)
      msg.body = evt.body
      msg.entities = entities
      msg.mentionedUserIds = mentionedUserIdsFromPayload(evt.entities, evt.mentionedUserIds)
      msg.mentionEveryone = evt.mentionEveryone ?? false
      if (evt.editedAt) {
        msg.editedAt = new Date(Number(evt.editedAt.seconds) * 1000).toISOString()
      } else {
        msg.editedAt = undefined
      }
    }

    const list = messages.value[evt.conversationId]
    if (list) {
      const msg = list.find(item => item.id === evt.messageId)
      if (msg) {
        apply(msg)
        scheduleMessageCache(evt.conversationId, list)
      }
    }
    for (const rootId of Object.keys(threadMessages.value)) {
      const msg = threadMessages.value[rootId]?.find(item => item.id === evt.messageId)
      if (!msg) continue
      apply(msg)
    }
    scheduleUnreadFeedRefresh()
  }

  function _onMessageDeleted(evt: MessageDeletedEvent) {
    const conversationId = evt.conversationId
    const rootList = messages.value[conversationId]
    let removedRoot = false

    if (rootList) {
      const idx = rootList.findIndex(item => item.id === evt.messageId)
      if (idx !== -1) {
        rootList.splice(idx, 1)
        removedRoot = true
      }
      scheduleMessageCache(conversationId, rootList)
    }

    for (const rootId of Object.keys(threadMessages.value)) {
      const list = threadMessages.value[rootId]
      if (!list) continue
      const idx = list.findIndex(item => item.id === evt.messageId)
      if (idx !== -1) {
        list.splice(idx, 1)
      }
    }

    const shouldClearRootThread = removedRoot || activeThreadRootId.value === evt.messageId
    if (shouldClearRootThread) {
      clearThreadReplayResyncTimer(evt.messageId)
      clearThreadReplayResponseWatchdog(evt.messageId)
      const nextThreadMessages = { ...threadMessages.value }
      delete nextThreadMessages[evt.messageId]
      threadMessages.value = nextThreadMessages

      const nextThreadSummaries = { ...threadSummaries.value }
      delete nextThreadSummaries[evt.messageId]
      threadSummaries.value = nextThreadSummaries
      const nextThreadReplayStatuses = { ...threadReplayStatusByRoot.value }
      delete nextThreadReplayStatuses[evt.messageId]
      threadReplayStatusByRoot.value = nextThreadReplayStatuses
      incompleteThreadReplayResponses.delete(evt.messageId)
      persistThreadSummaries()

    }

    if (activeThreadRootId.value === evt.messageId) {
      closeThread()
    }
    scheduleUnreadFeedRefresh()
  }

  function applyLocalMessageDeleted(conversationId: string, messageId: string, threadRootMessageId?: string) {
    _onMessageDeleted({
      conversationId,
      messageId,
      threadRootMessageId: threadRootMessageId ?? '',
    } as MessageDeletedEvent)
  }

  function applyLocalMessageEdited(
    conversationId: string,
    messageId: string,
    body: string,
    entities: MessageEntity[] = [],
    editedAt?: string,
  ) {
    _onMessageUpdated({
      conversationId,
      messageId,
      body,
      entities,
      mentionedUserIds: mentionedUserIdsFromEntities(entities),
      mentionEveryone: body.includes('@everyone') || body.includes('@channel'),
      editedAt: editedAt
        ? {
            seconds: BigInt(Math.floor(new Date(editedAt).getTime() / 1000)),
            nanos: 0,
          }
        : undefined,
    } as unknown as MessageUpdatedEvent)
  }

  function _upsertThreadMessage(rootId: string, msg: Message) {
    if (!threadMessages.value[rootId]) threadMessages.value[rootId] = []
    const list = threadMessages.value[rootId]
    const existing = list.findIndex(m => m.id === msg.id)
    if (existing === -1) {
      list.push(msg)
    } else {
      list.splice(existing, 1, msg)
    }
    list.sort((a, b) => {
      if (a.threadSeq !== b.threadSeq) return Number(a.threadSeq - b.threadSeq)
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    })
  }

  function _messageEventToMessage(evt: ProtoMessageEvent, channelId: string): Message {
    if (!userNames.value[evt.senderId]) {
      void ensureUserDirectory().then(() => refreshSenderLabels(evt.senderId))
    }
    const contentMode = contentModeFromProto(evt.contentMode)
    return {
      id: evt.messageId,
      channelId,
      senderId: evt.senderId,
      senderName: resolveDisplayName(evt.senderId),
      senderAvatarUrl: resolveAvatarUrl(evt.senderId),
      body: contentMode === 'dm_pairwise_signal_v1' ? 'Decrypting encrypted message...' : evt.body,
      forwardedFrom: forwardedMessageFromProto(evt),
      entities: normalizeMessageEntities(evt.entities),
      channelSeq: evt.channelSeq,
      threadSeq: evt.threadSeq,
      threadRootMessageId: evt.threadRootMessageId || undefined,
      mentionedUserIds: mentionedUserIdsFromPayload(evt.entities, evt.mentionedUserIds),
      mentionEveryone: evt.mentionEveryone ?? false,
      createdAt: evt.createdAt
        ? new Date(Number(evt.createdAt.seconds) * 1000).toISOString()
        : new Date().toISOString(),
      editedAt: evt.editedAt
        ? new Date(Number(evt.editedAt.seconds) * 1000).toISOString()
        : undefined,
      reactions: (evt.reactions ?? []).map(item => ({
        emoji: item.emoji,
        count: item.count,
      })),
      myReactions: [...(evt.myReactions ?? [])],
      attachments: (evt.attachments ?? []).map(item => ({
        id: item.attachmentId,
        fileName: item.fileName,
        fileSize: Number(item.fileSize),
        mimeType: item.mimeType,
        thumbnailMimeType: item.thumbnailMimeType || undefined,
        thumbnailFileSize: item.thumbnailFileSize > 0n ? Number(item.thumbnailFileSize) : undefined,
        thumbnailVersion: item.thumbnailVersion > 0 ? item.thumbnailVersion : undefined,
      })),
      isSaved: false,
      contentMode,
      senderDeviceId: evt.senderDeviceId || undefined,
      serverConfirmed: Boolean(evt.threadRootMessageId) || undefined,
    }
  }

  function decryptAndApplyMessage(
    message: Message,
    payloads: Parameters<typeof decryptDMMessage>[0],
    findCanonicalMessage: () => Message | undefined,
  ) {
    if (message.contentMode !== 'dm_pairwise_signal_v1') return
    const sessionGeneration = decryptionSessionGeneration
    const generation = secretHistoryGeneration.get(message.channelId)
    void decryptDMMessage(payloads).then(body => {
      if (body === null) return
      if (sessionGeneration !== decryptionSessionGeneration || generation !== secretHistoryGeneration.get(message.channelId)) return
      // `message` is initially a plain object. Resolve its reactive store
      // counterpart at completion so Vue updates the currently rendered row.
      const canonicalMessage = findCanonicalMessage()
      if (canonicalMessage?.body === 'Decrypting encrypted message...') {
        canonicalMessage.body = body
      }
    }).catch(() => {})
  }

  function applyConversationHistory(conversationId: string, history: ConversationMessageItem[]) {
    const applyStartedAt = performance.now()
    const existing = messages.value[conversationId] ?? []
    const byId = new Map(existing.map(message => [message.id, message]))
    const changedSenderIds = new Set<string>()
    const unresolvedSenderIds = new Set<string>()

    for (const item of history) {
      if (registerUserIdentity(item.sender_id, item.sender_name, undefined, undefined, undefined, false)) {
        changedSenderIds.add(item.sender_id)
      }
      if (!userNames.value[item.sender_id]) {
        unresolvedSenderIds.add(item.sender_id)
      }
      const prev = byId.get(item.id)
      const contentMode = item.content_mode === 'dm_pairwise_signal_v1' ? 'dm_pairwise_signal_v1' : 'plaintext'
      const entities = normalizeMessageEntities(item.entities)
      const nextMessage: Message = {
        id: item.id,
        channelId: item.conversation_id,
        senderId: item.sender_id,
        senderName: item.sender_name || resolveDisplayName(item.sender_id),
        senderAvatarUrl: resolveAvatarUrl(item.sender_id),
        body: contentMode === 'dm_pairwise_signal_v1' ? 'Decrypting encrypted message...' : item.body,
        forwardedFrom: normalizeForwardedMessage(item.forwarded_from),
        entities,
        channelSeq: BigInt(item.channel_seq),
        threadSeq: BigInt(item.thread_seq),
        threadRootMessageId: item.thread_root_message_id || undefined,
        mentionedUserIds: mentionedUserIdsFromEntities(entities),
        mentionEveryone: item.mention_everyone,
        createdAt: item.created_at,
        editedAt: item.edited_at || undefined,
        reactions: item.reactions ?? prev?.reactions ?? [],
        myReactions: item.my_reactions ?? prev?.myReactions ?? [],
        attachments: (item.attachments ?? []).map(attachment => ({
          id: attachment.id,
          fileName: attachment.file_name,
          fileSize: attachment.file_size,
          mimeType: attachment.mime_type,
          thumbnailMimeType: attachment.thumbnail_mime_type || undefined,
          thumbnailFileSize: attachment.thumbnail_file_size && attachment.thumbnail_file_size > 0
            ? attachment.thumbnail_file_size
            : undefined,
          thumbnailVersion: attachment.thumbnail_version && attachment.thumbnail_version > 0
            ? attachment.thumbnail_version
            : undefined,
        })),
        isSaved: item.is_saved ?? prev?.isSaved ?? false,
        contentMode,
        senderDeviceId: item.sender_device_id || undefined,
        encryptedDMPayloads: item.encrypted_dm_payloads,
      }
      byId.set(item.id, nextMessage)
      decryptAndApplyMessage(
        nextMessage,
        item.encrypted_dm_payloads,
        () => messages.value[conversationId]?.find(message => message.id === nextMessage.id),
      )

      const threadReplyCount = Math.max(0, Math.floor(Number(item.thread_reply_count ?? 0)))
      const known = threadSummaries.value[item.id]
      if (threadReplyCount > 0 || known) {
        const eventLastSeq = BigInt(threadReplyCount)
        const knownLastSeq = known?.lastThreadSeq ?? 0n
        const nextLastSeq = knownLastSeq > eventLastSeq ? knownLastSeq : eventLastSeq
        upsertThreadSummary(item.id, {
          replyCount: threadReplyCount,
          lastThreadSeq: nextLastSeq,
          lastReplyAt: known?.lastReplyAt,
          lastReplyUserId: known?.lastReplyUserId,
        })
      }
    }

    refreshSenderLabelsForUsers(changedSenderIds)
    if (unresolvedSenderIds.size > 0) {
      void ensureUserDirectory().then(() => refreshSenderLabelsForUsers(unresolvedSenderIds))
    }

    messages.value[conversationId] = Array.from(byId.values()).sort((a, b) => Number(a.channelSeq - b.channelSeq))
    scheduleMessageCache(conversationId, messages.value[conversationId])
    const applyMs = Math.round((performance.now() - applyStartedAt) * 100) / 100
    logConversationPerf('history:merge-sort:done', {
      conversationId,
      existingCount: existing.length,
      incomingCount: history.length,
      resultCount: messages.value[conversationId].length,
      applyMs,
    })
  }

  function _findMessage(channelId: string, messageId: string): Message | undefined {
    const inChannel = messages.value[channelId]?.find(m => m.id === messageId)
    if (inChannel) return inChannel
    for (const root of Object.keys(threadMessages.value)) {
      const msg = threadMessages.value[root]?.find(m => m.id === messageId)
      if (msg) return msg
    }
    return undefined
  }

  function _setMyReaction(msg: Message, emoji: string, present: boolean) {
    const idx = msg.myReactions.findIndex(e => e === emoji)
    if (present && idx === -1) msg.myReactions.push(emoji)
    if (!present && idx !== -1) msg.myReactions.splice(idx, 1)
  }

  // ── App badge (PWA) ────────────────────────────────────────────────────────
  // Update the app icon badge count when the total unread changes.

  const totalUnreadCount = computed(() => unreadFeedTotalCount.value)

  watch(totalUnreadCount, (count) => {
    const platform = getPlatformOrNull()
    if (platform) {
      if (count > 0) {
        void platform.notifications.setBadge(count)
      } else {
        void platform.notifications.clearBadge()
      }
      return
    }

    if (typeof navigator !== 'undefined' && 'setAppBadge' in navigator) {
      if (count > 0) {
        (navigator as any).setAppBadge(count).catch(() => {})
      } else {
        (navigator as any).clearAppBadge().catch(() => {})
      }
    }
  })

  return {
    channels,
    directMessages,
    chatViewMode,
    totalUnreadCount,
    activeChannelId,
    activeChannel,
    activeConversation,
    activeMessages,
    getConversationById,
    getMessagesForConversation,
    getTypingForConversation,
    getThreadRoot,
    getThreadReplies,
    isThreadPanelOpen,
    activeThreadRootId,
    activeThreadConversationId,
    activeThreadRootMessage,
    activeThreadReplies,
    activeThreadReplayVersion,
    focusedMessageId,
    focusedThreadMessageId,
    conversationComposerFocusToken,
    threadComposerFocusToken,
    unreadFeedItems,
    unreadFeedTotalCount,
    unreadFeedLoading,
    unreadFeedError,
    unreadFeedLoaded,
    unreadFeedRefreshQueued,
    savedMessageItems,
    savedMessageTotalCount,
    savedMessagesLoading,
    savedMessagesError,
    savedMessagesLoaded,
    workspace,
    notifications,
    activeCalls,
    applyCallRaisedHandsSnapshot,
    userCallPresenceByUserId,
    pendingInvites,
    presenceByUserId,
    typingByConversationId,
    bootstrapped,
    cachedBootstrap,
    messages,
    threadMessages,
    threadReplayVersionByRoot,
    threadSummaries,
    userNames,
    userEmails,
    userAvatars,
    userCustomStatuses,
    toast,
    lastAppliedEventSeq,
    lastAckedEventSeq,
    setChannels,
    showConversationView,
    showUnreadView,
    showSavedView,
    selectChannel,
    registerUserName,
    registerUserIdentity,
    resolveDisplayName,
    resolveAvatarUrl,
    resolveUserCustomStatus,
    addOptimisticMessage,
    reconcileMessage,
    addMessage,
    openThread,
    closeThread,
    activateThreadWorkspace,
    deactivateThreadWorkspace,
    markVisibleThreadRead,
    threadReplayStatus,
    retryThreadReplay,
    sendThreadReply,
    sendMessageToConversation,
    sendThreadReplyToRoot,
    forwardMessageToTarget,
    startRealtimeFlow,
    setCachedBootstrap,
    startBootstrap,
    handleBootstrapResponse,
    handleSyncSinceResponse,
    handleAckResponse,
    handlePresenceEvent,
    handleTypingEvent,
    handleServerEvent,
    applyLocalMessageDeleted,
    applyLocalMessageEdited,
    handleSendMessageAck,
    handleReactionAck,
    handleSubscribeThreadResponse,
    registerWsHandlers,
    queueReactionOp,
    isReactionOpPending,
    showToast,
    isConversationHistoryLoading,
    isConversationInitialLoading,
    conversationHasMoreHistory,
    loadCachedState,
    applyBootstrapSnapshot,
    ensureConversationHistory,
    reloadActiveEncryptedDMHistory,
    invalidateSecretHistory,
    loadMessageContext,
    refreshUnreadFeed,
    refreshSavedMessages,
    toggleMessageSaved,
    scheduleUnreadFeedRefresh,
    markUnreadFeedItemRead,
    loadOlderConversationHistory,
    openDirectMessage,
    markDirectMessageEncrypted,
    clearDMConversationHistory,
    removeConversationLocal,
    onClientFocus,
    setClientActive,
    onIncomingMessageNotification,
    onTaskStatusChanged,
    focusConversationMessage,
    focusThreadMessage,
    requestConversationComposerFocus,
    requestThreadComposerFocus,
    clearFocusedMessages,
    resetRuntimeState,
    setNotificationLevel,
    updateSendStatus,
    updateThreadSendStatus,
    retryMessage,
    retryThreadMessage,
    requeueInFlightPlaintextMessages,
    discardFailedMessage,
    discardFailedThreadMessage,
    startSendTimeout,
    clearAllSendTimeouts,
  }
})

function notificationSummaryToItem(summary: NotificationSummary): NotificationItem {
  return {
    id: summary.notificationId,
    type: summary.type.toString(),
    title: decodeNotificationText(summary.title),
    body: decodeNotificationText(summary.body),
    conversationId: summary.conversationId,
    messageId: summary.messageId || undefined,
    threadRootMessageId: summary.threadRootMessageId || undefined,
    isRead: summary.isRead,
    createdAt: summary.createdAt
      ? new Date(Number(summary.createdAt.seconds) * 1000).toISOString()
      : new Date().toISOString(),
  }
}

function activeCallSummaryToItem(summary: ActiveCallSummary): ActiveCallItem {
  return {
    id: summary.callId,
    conversationId: summary.conversationId,
    status: summary.status.toString(),
    participantCount: summary.participantCount,
    raisedHands: summary.raisedHands
      .filter(hand => Boolean(hand.userId) && Number.isInteger(hand.position) && hand.position > 0)
      .slice()
      .sort((a, b) => a.position - b.position)
      .map(hand => ({ userId: hand.userId, position: hand.position })),
  }
}

function callInviteSummaryToItem(summary: CallInviteSummary): PendingInviteItem {
  return {
    id: summary.inviteId,
    callId: summary.callId,
    conversationId: summary.conversationId,
    inviterUserId: summary.inviterUserId,
    state: summary.state.toString(),
    createdAt: summary.createdAt
      ? new Date(Number(summary.createdAt.seconds) * 1000).toISOString()
      : new Date().toISOString(),
    expiresAt: summary.expiresAt
      ? new Date(Number(summary.expiresAt.seconds) * 1000).toISOString()
      : new Date().toISOString(),
  }
}

function workspaceRoleToSlug(role: WorkspaceRole): string {
  switch (role) {
    case WorkspaceRole.ADMIN:
      return 'admin'
    case WorkspaceRole.OWNER:
      return 'owner'
    case WorkspaceRole.MEMBER:
      return 'member'
    default:
      return ''
  }
}
