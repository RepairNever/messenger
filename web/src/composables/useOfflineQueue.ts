import { ref } from 'vue'
import type { useWsStore } from '@/stores/ws'
import {
  enqueueOutbound,
  loadOutboundQueue,
  removeOutbound,
  clearOutboundQueue,
} from '@/services/db/cache'

export interface PendingOutboundMessage {
  conversationId: string
  body: string
  entities?: Array<{ kind: 'user' | 'task' | 'document'; targetId: string; label: string; href: string; start: number; end: number }>
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
}

/**
 * Callback type for notifying the chat store of send-status transitions
 * during flush. This avoids a direct import of the chat store (circular dep).
 */
export type FlushStatusCallback = (
  conversationId: string,
  clientMsgId: string,
  status: 'sending' | 'queued' | 'failed',
  threadRootMessageId?: string,
  failReason?: string,
) => void

// Singleton queue shared across all composable calls
const queue = ref<PendingOutboundMessage[]>([])
let hydrated = false
// Records remain durable until SendMessageAck. This guard prevents a second
// flush from replaying a record that is still in flight on this connection.
const inFlightClientMsgIds = new Set<string>()
const durableClientMsgIds = new Set<string>()
const persistenceByClientMsgId = new Map<string, Promise<boolean>>()

export const OUTBOUND_PERSISTENCE_FAILURE_REASON = 'Message could not be saved for reliable delivery'

export function useOfflineQueue() {
  function queuedMessage(clientMsgId: string): PendingOutboundMessage | undefined {
    return queue.value.find(message => message.clientMsgId === clientMsgId)
  }

  function persist(msg: PendingOutboundMessage): Promise<boolean> {
    if (durableClientMsgIds.has(msg.clientMsgId)) return Promise.resolve(true)

    const inProgress = persistenceByClientMsgId.get(msg.clientMsgId)
    if (inProgress) return inProgress

    const pending = enqueueOutbound({
      conversationId: msg.conversationId,
      body: msg.body,
      entities: msg.entities,
      clientMsgId: msg.clientMsgId,
      threadRootMessageId: msg.threadRootMessageId,
      attachmentIds: msg.attachmentIds,
      attachments: msg.attachments,
    })
      .then(async persisted => {
        if (!persisted) return false
        // A user may discard or clear a message while IndexedDB is committing.
        // Do not leave a record behind that could resurrect the discarded send.
        if (!queuedMessage(msg.clientMsgId)) {
          await removeOutbound(msg.clientMsgId)
          return false
        }
        durableClientMsgIds.add(msg.clientMsgId)
        return true
      })
      .catch(() => false)
      .finally(() => {
        persistenceByClientMsgId.delete(msg.clientMsgId)
      })
    persistenceByClientMsgId.set(msg.clientMsgId, pending)
    return pending
  }

  /**
   * Add a message to the replay queue and wait for IndexedDB to commit it.
   * Callers must await this before issuing the first socket write.
   */
  function enqueue(msg: PendingOutboundMessage): Promise<boolean> {
    // Avoid duplicates (e.g. if a reconnect requeues an existing send).
    const existing = queuedMessage(msg.clientMsgId)
    if (existing) return persist(existing)
    queue.value = [...queue.value, msg]
    return persist(msg)
  }

  /**
   * Flush all queued messages over the (now-live) WS connection.
   * Called after successful reconnect + LIVE_SYNCED.
   *
   * Records remain in IndexedDB until SendMessageAck. A new connection
   * releases the in-flight guard and safely replays original client IDs.
   *
   * @param ws - The WS store instance for sending messages.
   * @param onStatusChange - Optional callback to notify the chat store of
   *   send-status transitions (queued → sending, or back to queued).
   */
  async function flush(ws: ReturnType<typeof useWsStore>, onStatusChange?: FlushStatusCallback) {
    if (ws.state !== 'LIVE_SYNCED') return
    const pending = queue.value.filter(msg => !inFlightClientMsgIds.has(msg.clientMsgId))

    for (const msg of pending) {
      const persisted = await enqueue(msg)
      if (!persisted) {
        if (queuedMessage(msg.clientMsgId)) {
          onStatusChange?.(msg.conversationId, msg.clientMsgId, 'failed', msg.threadRootMessageId, OUTBOUND_PERSISTENCE_FAILURE_REASON)
        }
        continue
      }
      if (ws.state !== 'LIVE_SYNCED') {
        if (queuedMessage(msg.clientMsgId)) {
          onStatusChange?.(msg.conversationId, msg.clientMsgId, 'queued', msg.threadRootMessageId)
        }
        break
      }
      if (!claimInFlight(msg.clientMsgId)) continue

      // Notify store: queued → sending
      onStatusChange?.(msg.conversationId, msg.clientMsgId, 'sending', msg.threadRootMessageId)

      const sent = ws.sendMessage(
        msg.conversationId,
        msg.body,
        msg.clientMsgId,
        msg.threadRootMessageId,
        msg.attachmentIds ?? [],
        msg.entities ?? [],
      )

      if (sent) {
        continue
      } else {
        // Keep the record queued. The transport-drop path will reconnect and
        // release it for another idempotent attempt.
        releaseInFlight(msg.clientMsgId)
        onStatusChange?.(msg.conversationId, msg.clientMsgId, 'queued', msg.threadRootMessageId)
        break
      }
    }
  }

  /** Claim a durable record for one socket write in this delivery epoch. */
  function claimInFlight(clientMsgId: string): boolean {
    if (inFlightClientMsgIds.has(clientMsgId)) return false
    inFlightClientMsgIds.add(clientMsgId)
    return true
  }

  /** Allow a single unacknowledged record to replay on the next live session. */
  function releaseInFlight(clientMsgId: string) {
    inFlightClientMsgIds.delete(clientMsgId)
  }

  /** A new transport is a new delivery epoch; replay all unresolved records. */
  function releaseAllInFlight() {
    inFlightClientMsgIds.clear()
  }

  /** Remove a specific message from the queue (e.g. if user deletes the optimistic bubble) */
  function remove(clientMsgId: string) {
    inFlightClientMsgIds.delete(clientMsgId)
    durableClientMsgIds.delete(clientMsgId)
    queue.value = queue.value.filter((m) => m.clientMsgId !== clientMsgId)
    // Remove from IndexedDB (fire-and-forget)
    void removeOutbound(clientMsgId)
  }

  /** Clear everything — called on logout */
  function clear() {
    inFlightClientMsgIds.clear()
    durableClientMsgIds.clear()
    queue.value = []
    void clearOutboundQueue()
  }

  /**
   * Load persisted queue from IndexedDB on startup.
   * Should be called once during app initialization.
   * Returns the loaded messages so they can be rendered with queued status.
   */
  async function loadPersisted(): Promise<PendingOutboundMessage[]> {
    if (hydrated) return queue.value
    hydrated = true
    try {
      const stored = await loadOutboundQueue()
      if (stored.length === 0) return []
      const loaded: PendingOutboundMessage[] = stored.map(item => ({
        conversationId: item.conversationId,
        body: item.body,
        entities: item.entities,
        clientMsgId: item.clientMsgId,
        threadRootMessageId: item.threadRootMessageId,
        attachmentIds: item.attachmentIds,
        attachments: item.attachments,
      }))
      // Merge with any already-in-memory items (avoid duplicates)
      for (const msg of loaded) {
        durableClientMsgIds.add(msg.clientMsgId)
        if (!queue.value.some(m => m.clientMsgId === msg.clientMsgId)) {
          queue.value = [...queue.value, msg]
        }
      }
      return loaded
    } catch {
      return []
    }
  }

  return {
    queue,
    enqueue,
    flush,
    claimInFlight,
    releaseInFlight,
    releaseAllInFlight,
    remove,
    clear,
    loadPersisted,
  }
}
