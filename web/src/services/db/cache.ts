/**
 * IndexedDB cache helpers for Msgnr.
 *
 * Every public function is resilient: IndexedDB failures are caught and
 * silently ignored. The cache is a read optimisation — the server bootstrap
 * is always the source of truth.
 */
import { db } from './msgnrDb'
import type {
  CachedConversation,
  CachedMessage,
  CachedUserProfile,
  CachedThreadSummary,
  QueuedOutboundAction,
} from './msgnrDb'
import { NotificationLevel } from '@/shared/proto/packets_pb'
import type { Channel, DirectMessage, Message, MessageAttachment, ThreadSummary } from '@/stores/chat'

// ── BigInt ↔ string helpers ───────────────────────────────────────────────────
// IndexedDB structured clone does not support BigInt.

function bigintToStr(value: bigint | undefined): string {
  return (value ?? 0n).toString()
}

function strToBigint(value: string | undefined): bigint {
  if (!value) return 0n
  try {
    return BigInt(value)
  } catch {
    return 0n
  }
}

/** Maximum messages cached per conversation. */
const MAX_MESSAGES_PER_CONVERSATION = 50

function toPlainStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(item => String(item))
}

function logDataCloneError(op: string, error: unknown, context?: Record<string, unknown>) {
  const name = (error as { name?: string } | null | undefined)?.name
  if (name !== 'DataCloneError') return
  console.error('[db-cache]', op, {
    error: error instanceof Error ? error.message : String(error),
    ...context,
  })
}

// ── Conversation cache ────────────────────────────────────────────────────────

function channelToCached(ch: Channel): CachedConversation {
  return {
    id: ch.id,
    type: 'channel',
    name: ch.name,
    visibility: ch.visibility,
    unread: ch.unread,
    hasUnreadThreadReplies: ch.hasUnreadThreadReplies,
    lastMessageSeq: bigintToStr(ch.lastMessageSeq),
    lastActivityAt: ch.lastActivityAt,
    notificationLevel: ch.notificationLevel,
    updatedAt: new Date().toISOString(),
  }
}

function dmToCached(dm: DirectMessage): CachedConversation {
  return {
    id: dm.id,
    type: 'dm',
    name: dm.displayName,
    userId: dm.userId,
    avatarUrl: dm.avatarUrl,
    presence: dm.presence,
    customStatus: dm.customStatus ?? null,
    encryptionMode: dm.encryptionMode ?? 'none',
    unread: dm.unread,
    hasUnreadThreadReplies: dm.hasUnreadThreadReplies,
    lastMessageSeq: bigintToStr(dm.lastMessageSeq),
    notificationLevel: dm.notificationLevel,
    updatedAt: new Date().toISOString(),
  }
}

function cachedToChannel(c: CachedConversation): Channel {
  return {
    id: c.id,
    name: c.name,
    kind: 'channel',
    visibility: (c.visibility as 'public' | 'private') ?? 'public',
    unread: c.unread,
    hasUnreadThreadReplies: c.hasUnreadThreadReplies,
    lastMessageSeq: strToBigint(c.lastMessageSeq),
    lastActivityAt: c.lastActivityAt,
    notificationLevel: (c.notificationLevel ?? 0) as NotificationLevel,
  }
}

function cachedToDm(c: CachedConversation): DirectMessage {
  return {
    id: c.id,
    userId: c.userId ?? c.id,
    displayName: c.name,
    avatarUrl: c.avatarUrl,
    presence: (c.presence as 'online' | 'away' | 'offline') ?? 'offline',
    customStatus: c.customStatus ?? null,
    encryptionMode: c.encryptionMode ?? 'none',
    unread: c.unread,
    hasUnreadThreadReplies: c.hasUnreadThreadReplies,
    lastMessageSeq: strToBigint(c.lastMessageSeq),
    notificationLevel: (c.notificationLevel ?? 0) as NotificationLevel,
  }
}

/** Write-through: store current conversations snapshot to IndexedDB. */
export async function cacheConversations(
  channels: Channel[],
  dms: DirectMessage[],
): Promise<void> {
  try {
    const rows: CachedConversation[] = [
      ...channels.map(channelToCached),
      ...dms.map(dmToCached),
    ]
    await db.transaction('rw', db.conversations, async () => {
      await db.conversations.clear()
      await db.conversations.bulkPut(rows)
    })
  } catch {
    // Non-fatal: cache write failure does not affect app functionality.
  }
}

/** Read cached conversations on startup. */
export async function loadCachedConversations(): Promise<{
  channels: Channel[]
  dms: DirectMessage[]
} | null> {
  try {
    const all = await db.conversations.toArray()
    if (all.length === 0) return null
    const channels: Channel[] = []
    const dms: DirectMessage[] = []
    for (const row of all) {
      if (row.type === 'dm') {
        dms.push(cachedToDm(row))
      } else {
        channels.push(cachedToChannel(row))
      }
    }
    return { channels, dms }
  } catch {
    return null
  }
}

// ── Message cache ─────────────────────────────────────────────────────────────

function messageToCache(msg: Message): CachedMessage {
  return {
    id: msg.id,
    conversationId: msg.channelId,
    senderId: msg.senderId,
    senderName: msg.senderName,
    senderAvatarUrl: msg.senderAvatarUrl,
    body: msg.body,
    forwardedFrom: msg.forwardedFrom ? { ...msg.forwardedFrom } : undefined,
    entities: msg.entities?.map(entity => ({ ...entity })),
    channelSeq: bigintToStr(msg.channelSeq),
    threadSeq: bigintToStr(msg.threadSeq),
    threadRootMessageId: msg.threadRootMessageId,
    mentionedUserIds: toPlainStringArray(msg.mentionedUserIds),
    mentionEveryone: msg.mentionEveryone,
    createdAt: msg.createdAt,
    editedAt: msg.editedAt,
    reactions: msg.reactions.map(r => ({ emoji: r.emoji, count: r.count })),
    myReactions: toPlainStringArray(msg.myReactions),
    attachments: msg.attachments?.map(a => ({ ...a })),
  }
}

function cachedToMessage(c: CachedMessage): Message {
  return {
    id: c.id,
    channelId: c.conversationId,
    senderId: c.senderId,
    senderName: c.senderName,
    senderAvatarUrl: c.senderAvatarUrl,
    body: c.body,
    forwardedFrom: c.forwardedFrom ? { ...c.forwardedFrom } : undefined,
    entities: c.entities?.map(entity => ({ ...entity })) ?? [],
    channelSeq: strToBigint(c.channelSeq),
    threadSeq: strToBigint(c.threadSeq),
    threadRootMessageId: c.threadRootMessageId,
    mentionedUserIds: c.mentionedUserIds ?? [],
    mentionEveryone: c.mentionEveryone ?? false,
    createdAt: c.createdAt,
    editedAt: c.editedAt,
    reactions: c.reactions ?? [],
    myReactions: c.myReactions ?? [],
    attachments: c.attachments as MessageAttachment[] | undefined,
  }
}

/**
 * Write-through: cache messages for a conversation.
 * Keeps only the latest MAX_MESSAGES_PER_CONVERSATION messages per conversation.
 * Skips pending/sending/queued/failed (optimistic) messages — they are not server-confirmed.
 */
export async function cacheMessages(
  conversationId: string,
  msgs: Message[],
): Promise<void> {
  try {
    // Timelines normally arrive ordered, but cache writes can also be invoked
    // with merged history or replay output. Select by server sequence rather
    // than input position so the retained window is always the newest one.
    const rows = msgs
      .filter(message => !message.sendStatus && !message.pending && message.contentMode !== 'dm_pairwise_signal_v1')
      .sort((left, right) => {
        if (left.channelSeq === right.channelSeq) return 0
        return left.channelSeq > right.channelSeq ? -1 : 1
      })
      .slice(0, MAX_MESSAGES_PER_CONVERSATION)
      .reverse()
      .map(messageToCache)

    await db.transaction('rw', db.messages, async () => {
      // Delete existing messages for this conversation
      await db.messages.where('conversationId').equals(conversationId).delete()
      if (rows.length > 0) {
        await db.messages.bulkPut(rows)
      }
    })
  } catch (error) {
    logDataCloneError('cacheMessages', error, {
      conversationId,
      count: msgs.length,
    })
    // Non-fatal
  }
}

/** Append a single confirmed message to the cache, trimming if needed. */
export async function cacheSingleMessage(msg: Message): Promise<void> {
  if (msg.sendStatus || msg.pending) return
  if (msg.contentMode === 'dm_pairwise_signal_v1') return
  try {
    const row = messageToCache(msg)
    await db.transaction('rw', db.messages, async () => {
      await db.messages.put(row)
      // Trim: count messages for this conversation and delete oldest by channelSeq
      const all = await db.messages
        .where('conversationId')
        .equals(msg.channelId)
        .toArray()
      if (all.length > MAX_MESSAGES_PER_CONVERSATION) {
        // Sort by channelSeq in JS (string-encoded BigInt), keep latest N
        all.sort((a, b) => {
          const seqA = BigInt(a.channelSeq || '0')
          const seqB = BigInt(b.channelSeq || '0')
          return Number(seqA - seqB)
        })
        const excess = all.length - MAX_MESSAGES_PER_CONVERSATION
        const toDelete = all.slice(0, excess).map(m => m.id)
        await db.messages.bulkDelete(toDelete)
      }
    })
  } catch (error) {
    logDataCloneError('cacheSingleMessage', error, {
      conversationId: msg.channelId,
      messageId: msg.id,
    })
    // Non-fatal
  }
}

/** Load cached messages for a conversation, sorted by channelSeq ascending. */
export async function loadCachedMessages(conversationId: string): Promise<Message[]> {
  try {
    const rows = await db.messages
      .where('conversationId')
      .equals(conversationId)
      .toArray()
    // Sort in JS — string-encoded BigInt values cannot be sorted by IndexedDB.
    return rows
      .map(cachedToMessage)
      .sort((a, b) => Number(a.channelSeq - b.channelSeq))
  } catch {
    return []
  }
}

/** Remove all cached messages for a conversation. */
export async function clearCachedMessages(conversationId: string): Promise<void> {
  try {
    await db.messages.where('conversationId').equals(conversationId).delete()
  } catch {
    // Non-fatal
  }
}

// ── User profile cache ────────────────────────────────────────────────────────

export async function cacheUserProfile(profile: CachedUserProfile): Promise<void> {
  try {
    await db.userProfile.put(profile)
  } catch {
    // Non-fatal
  }
}

export async function loadCachedUserProfile(): Promise<CachedUserProfile | null> {
  try {
    const all = await db.userProfile.toArray()
    return all[0] ?? null
  } catch {
    return null
  }
}

// ── Draft cache ───────────────────────────────────────────────────────────────

export async function saveDraft(conversationId: string, body: string): Promise<void> {
  try {
    await db.drafts.put({
      conversationId,
      body,
      updatedAt: new Date().toISOString(),
    })
  } catch {
    // Non-fatal
  }
}

export async function loadDraft(conversationId: string): Promise<string | null> {
  try {
    const draft = await db.drafts.get(conversationId)
    return draft?.body ?? null
  } catch {
    return null
  }
}

export async function deleteDraft(conversationId: string): Promise<void> {
  try {
    await db.drafts.delete(conversationId)
  } catch {
    // Non-fatal
  }
}

// ── Outbound queue ────────────────────────────────────────────────────────────

export async function enqueueOutbound(
  action: Omit<QueuedOutboundAction, 'id' | 'createdAt'>,
): Promise<boolean> {
  try {
    await db.outboundQueue.add({
      ...action,
      attachmentIds: action.attachmentIds ? toPlainStringArray(action.attachmentIds) : undefined,
      attachments: action.attachments?.map(attachment => ({ ...attachment })),
      createdAt: new Date().toISOString(),
    })
    return true
  } catch (error) {
    logDataCloneError('enqueueOutbound', error, {
      conversationId: action.conversationId,
      clientMsgId: action.clientMsgId,
      hasAttachmentIds: Array.isArray(action.attachmentIds),
      attachmentCount: action.attachmentIds?.length ?? 0,
    })
    return false
  }
}

export async function loadOutboundQueue(): Promise<QueuedOutboundAction[]> {
  try {
    return await db.outboundQueue.orderBy('createdAt').toArray()
  } catch {
    return []
  }
}

export async function removeOutbound(clientMsgId: string): Promise<void> {
  try {
    await db.outboundQueue.where('clientMsgId').equals(clientMsgId).delete()
  } catch {
    // Non-fatal
  }
}

export async function clearOutboundQueue(): Promise<void> {
  try {
    await db.outboundQueue.clear()
  } catch {
    // Non-fatal
  }
}

// ── Thread summaries cache ────────────────────────────────────────────────

function threadSummaryKey(userId: string, rootMessageId: string): string {
  return `${userId}:${rootMessageId}`
}

/**
 * Persist thread summaries for a user to IndexedDB.
 * Replaces all existing entries for the user.
 */
export async function cacheThreadSummaries(
  userId: string,
  summaries: Record<string, ThreadSummary>,
): Promise<void> {
  if (!userId) return
  try {
    const rows: CachedThreadSummary[] = Object.entries(summaries).map(([rootId, s]) => ({
      key: threadSummaryKey(userId, rootId),
      userId,
      rootMessageId: rootId,
      replyCount: s.replyCount,
      lastThreadSeq: bigintToStr(s.lastThreadSeq),
      lastReplyAt: s.lastReplyAt,
      lastReplyUserId: s.lastReplyUserId,
    }))
    await db.transaction('rw', db.threadSummaries, async () => {
      // Delete old entries for this user
      await db.threadSummaries.where('userId').equals(userId).delete()
      if (rows.length > 0) {
        await db.threadSummaries.bulkPut(rows)
      }
    })
  } catch {
    // Non-fatal
  }
}

/** Load thread summaries for a user from IndexedDB. */
export async function loadCachedThreadSummaries(
  userId: string,
): Promise<Record<string, ThreadSummary> | null> {
  if (!userId) return null
  try {
    const rows = await db.threadSummaries.where('userId').equals(userId).toArray()
    if (rows.length === 0) return null
    const result: Record<string, ThreadSummary> = {}
    for (const row of rows) {
      const lastThreadSeq = strToBigint(row.lastThreadSeq)
      result[row.rootMessageId] = {
        replyCount: Math.max(row.replyCount, Number(lastThreadSeq)),
        lastThreadSeq,
        lastReplyAt: row.lastReplyAt,
        lastReplyUserId: row.lastReplyUserId,
      }
    }
    return result
  } catch {
    return null
  }
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

/** Clear all cached data. Called on logout. */
export async function clearAllData(): Promise<void> {
  try {
    await db.transaction(
      'rw',
      [db.conversations, db.messages, db.userProfile, db.drafts, db.outboundQueue, db.threadSummaries],
      async () => {
        await db.conversations.clear()
        await db.messages.clear()
        await db.userProfile.clear()
        await db.drafts.clear()
        await db.outboundQueue.clear()
        await db.threadSummaries.clear()
      },
    )
  } catch {
    // Non-fatal — best effort cleanup.
  }
}

/** Nuclear option: delete the entire database. */
export async function deleteDatabase(): Promise<void> {
  try {
    await db.delete()
  } catch {
    // Non-fatal
  }
}
