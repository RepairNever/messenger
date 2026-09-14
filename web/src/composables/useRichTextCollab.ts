import { onBeforeUnmount, ref, shallowRef, watch, type Ref } from 'vue'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'
import { useWsStore, type WsState } from '@/stores/ws'

type CollabPayload<Kind extends number> = {
  kind: Kind
  payload: Uint8Array
}

type SyncFrameTypeValue = typeof SyncFrameType[keyof typeof SyncFrameType]

type SyncFrame = {
  type: SyncFrameTypeValue
  payload: Uint8Array
  legacy: boolean
}

export interface RichTextCollabUser {
  id: string
  name: string
  color: string
}

export interface RichTextCollabTransport<SubscribeResponse, Message, Kind extends number> {
  syncKind: Kind
  awarenessKind: Kind
  sendSubscribe: (entityId: string) => string
  sendUnsubscribe: (entityId: string) => string
  sendMessage: (entityId: string, kind: Kind, payload: Uint8Array) => boolean
  onSubscribeResponse: (cb: (resp: SubscribeResponse) => void) => void
  onMessage: (cb: (msg: Message) => void) => void
  getSubscribeResponseEntityId: (resp: SubscribeResponse) => string
  getSubscribeResponsePersistedMarkdown: (resp: SubscribeResponse) => string
  getSubscribeResponseSubscriberCount: (resp: SubscribeResponse) => number
  getSubscribeResponseRoomSnapshot: (resp: SubscribeResponse) => Uint8Array | undefined
  getMessageEntityId: (msg: Message) => string
  getMessageKind: (msg: Message) => Kind
  getMessagePayload: (msg: Message) => Uint8Array
}

const SYNC_MAGIC_0 = 0x54 // 'T'
const SYNC_MAGIC_1 = 0x44 // 'D'
const SYNC_PROTOCOL_V1 = 1
const PERSISTED_SEED_DELAY_MS = 250
const FULL_STATE_SNAPSHOT_DEBOUNCE_MS = 150

const SyncFrameType = {
  UPDATE: 1,
  STATE_VECTOR: 2,
  STATE_UPDATE: 3,
  FULL_STATE: 4,
} as const

const READY_STATES: WsState[] = [
  'AUTH_COMPLETE',
  'BOOTSTRAPPING',
  'LIVE_SYNCED',
  'RECOVERING_GAP',
  'STALE_REBOOTSTRAP',
]
const DEBUG_RICH_TEXT_COLLAB = import.meta.env.DEV

function isWsReady(state: WsState): boolean {
  return READY_STATES.includes(state)
}

function markdownSignature(input: string): string {
  let hash = 0
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) - hash) + input.charCodeAt(i)
    hash |= 0
  }
  const preview = input.slice(0, 80).replace(/\n/g, '\\n')
  return `len=${input.length},hash=${hash},preview="${preview}"`
}

function collabLog(logLabel: string, event: string, payload: Record<string, unknown>) {
  if (!DEBUG_RICH_TEXT_COLLAB) return
  console.debug(`[${logLabel}]`, event, payload)
}

function isDocEmpty(doc: Y.Doc | null): boolean {
  if (!doc) return true
  return Y.encodeStateVector(doc).length <= 2
}

function docMarkdownSignature(doc: Y.Doc | null): string {
  if (!doc) return 'doc=null'
  const stateVector = Y.encodeStateVector(doc)
  let hash = 0
  for (let i = 0; i < stateVector.length; i += 1) {
    hash = ((hash << 5) - hash) + stateVector[i]
    hash |= 0
  }
  return `stateVectorBytes=${stateVector.length},stateVectorHash=${hash}`
}

function encodeSyncFrame(type: SyncFrameTypeValue, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length)
  out[0] = SYNC_MAGIC_0
  out[1] = SYNC_MAGIC_1
  out[2] = SYNC_PROTOCOL_V1
  out[3] = type
  out.set(payload, 4)
  return out
}

function decodeSyncFrame(input: Uint8Array): SyncFrame {
  if (input.length >= 4 &&
    input[0] === SYNC_MAGIC_0 &&
    input[1] === SYNC_MAGIC_1 &&
    input[2] === SYNC_PROTOCOL_V1
  ) {
    const type = input[3]
    if (
      type === SyncFrameType.UPDATE ||
      type === SyncFrameType.STATE_VECTOR ||
      type === SyncFrameType.STATE_UPDATE ||
      type === SyncFrameType.FULL_STATE
    ) {
      return {
        type,
        payload: input.subarray(4),
        legacy: false,
      }
    }
  }
  return {
    type: SyncFrameType.UPDATE,
    payload: input,
    legacy: true,
  }
}

export function useRichTextCollab<SubscribeResponse, Message, Kind extends number>(params: {
  entityId: Ref<string | null>
  user: Ref<RichTextCollabUser | null>
  logLabel: string
  transportFactory: (wsStore: ReturnType<typeof useWsStore>) => RichTextCollabTransport<SubscribeResponse, Message, Kind>
}) {
  const wsStore = useWsStore()
  const transport = params.transportFactory(wsStore)

  const doc = shallowRef<Y.Doc | null>(null)
  const provider = shallowRef<{ awareness: Awareness } | null>(null)
  const subscribeError = ref<string | null>(null)
  const subscribedEntityId = ref<string | null>(null)
  const serverMarkdown = ref<string | null>(null)
  const allowLocalDraftSeed = ref(false)
  const hasRemotePeersRef = ref(false)
  const subscriberCount = ref(0)

  const pending: CollabPayload<Kind>[] = []
  let awarenessListener: ((payload: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => void) | null = null
  let docListener: ((update: Uint8Array, origin: unknown) => void) | null = null
  let hasLocalEdits = false
  let receivedMeaningfulRemoteSync = false
  let hasRemotePeers = false
  let subscribeAttempt = 0
  let subscribeResponseCount = 0
  let pendingPersistedMarkdown: string | null = null
  let seedFallbackTimer: ReturnType<typeof setTimeout> | null = null
  let fullStateSnapshotTimer: ReturnType<typeof setTimeout> | null = null
  let subscriptionReady = false

  function awarenessPeerSnapshot(awareness: Awareness | null | undefined): { local: number; clients: number[]; hasRemote: boolean } {
    if (!awareness) return { local: -1, clients: [], hasRemote: false }
    const local = awareness.clientID
    const clients = Array.from(awareness.getStates().keys())
    const hasRemote = clients.some(clientID => clientID !== local)
    return { local, clients, hasRemote }
  }

  function shouldSeedAsLeader(): boolean {
    if (!provider.value?.awareness) return true
    const snapshot = awarenessPeerSnapshot(provider.value.awareness)
    if (snapshot.clients.length === 0) return true
    const minClientID = snapshot.clients.reduce((min, current) => Math.min(min, current), snapshot.clients[0])
    return snapshot.local === minClientID
  }

  function refreshRemotePeerPresence(reason: string, entityId: string) {
    const snapshot = awarenessPeerSnapshot(provider.value?.awareness)
    hasRemotePeers = snapshot.hasRemote
    hasRemotePeersRef.value = snapshot.hasRemote
    collabLog(params.logLabel, 'awareness:peers', {
      entityId,
      reason,
      local: snapshot.local,
      clients: snapshot.clients,
      hasRemotePeers,
      isSeedLeader: shouldSeedAsLeader(),
    })
  }

  function clearSeedFallbackTimer() {
    if (!seedFallbackTimer) return
    clearTimeout(seedFallbackTimer)
    seedFallbackTimer = null
  }

  function clearFullStateSnapshotTimer() {
    if (!fullStateSnapshotTimer) return
    clearTimeout(fullStateSnapshotTimer)
    fullStateSnapshotTimer = null
  }

  function sendSyncFrame(entityId: string, type: SyncFrameTypeValue, payload: Uint8Array, reason: string) {
    const framed = encodeSyncFrame(type, payload)
    collabLog(params.logLabel, 'sync:send', {
      entityId,
      reason,
      type,
      frameBytes: framed.length,
      payloadBytes: payload.length,
      wsState: wsStore.state,
    })
    sendOrQueue(entityId, {
      kind: transport.syncKind,
      payload: framed,
    })
  }

  function requestPeerState(entityId: string, reason: string) {
    if (!doc.value) return
    const stateVector = Y.encodeStateVector(doc.value)
    sendSyncFrame(entityId, SyncFrameType.STATE_VECTOR, stateVector, reason)
  }

  function publishFullStateSnapshot(entityId: string, reason: string) {
    if (!doc.value) return
    const snapshot = Y.encodeStateAsUpdate(doc.value)
    sendSyncFrame(entityId, SyncFrameType.FULL_STATE, snapshot, reason)
  }

  function scheduleFullStateSnapshot(entityId: string, reason: string) {
    clearFullStateSnapshotTimer()
    fullStateSnapshotTimer = setTimeout(() => {
      fullStateSnapshotTimer = null
      if (entityId !== params.entityId.value) return
      publishFullStateSnapshot(entityId, reason)
    }, FULL_STATE_SNAPSHOT_DEBOUNCE_MS)
  }

  function flushScheduledFullStateSnapshot(entityId: string, reason: string) {
    if (!fullStateSnapshotTimer) return
    clearFullStateSnapshotTimer()
    publishFullStateSnapshot(entityId, reason)
  }

  function schedulePersistedSeed(entityId: string) {
    clearSeedFallbackTimer()
    if (pendingPersistedMarkdown === null) return
    seedFallbackTimer = setTimeout(() => {
      seedFallbackTimer = null
      if (entityId !== params.entityId.value) return
      const persisted = pendingPersistedMarkdown ?? ''
      if (receivedMeaningfulRemoteSync || hasLocalEdits) {
        collabLog(params.logLabel, 'seed:persisted:skip', {
          entityId,
          reason: receivedMeaningfulRemoteSync ? 'received-meaningful-remote-sync' : 'has-local-edits',
          persisted: markdownSignature(persisted),
        })
        pendingPersistedMarkdown = null
        return
      }
      if (hasRemotePeers && !shouldSeedAsLeader()) {
        collabLog(params.logLabel, 'seed:persisted:defer-non-leader', {
          entityId,
          persisted: markdownSignature(persisted),
        })
        schedulePersistedSeed(entityId)
        return
      }
      collabLog(params.logLabel, 'seed:persisted:apply', {
        entityId,
        persisted: markdownSignature(persisted),
      })
      serverMarkdown.value = persisted
      pendingPersistedMarkdown = null
    }, PERSISTED_SEED_DELAY_MS)
  }

  function flushPending(entityId: string) {
    if (!isWsReady(wsStore.state) || !subscriptionReady) return
    collabLog(params.logLabel, 'flushPending:start', {
      entityId,
      queue: pending.length,
      wsState: wsStore.state,
      subscriptionReady,
    })
    while (pending.length > 0) {
      const next = pending[0]
      const ok = transport.sendMessage(entityId, next.kind, next.payload)
      if (!ok) return
      pending.shift()
    }
    collabLog(params.logLabel, 'flushPending:done', { entityId, queue: pending.length })
  }

  function sendOrQueue(entityId: string, msg: CollabPayload<Kind>) {
    if (!isWsReady(wsStore.state)) {
      collabLog(params.logLabel, 'sendOrQueue:queue:ws-not-ready', { entityId, kind: msg.kind, bytes: msg.payload.length, wsState: wsStore.state })
      pending.push(msg)
      return
    }
    if (!subscriptionReady) {
      collabLog(params.logLabel, 'sendOrQueue:queue:subscribe-not-ready', {
        entityId,
        kind: msg.kind,
        bytes: msg.payload.length,
        wsState: wsStore.state,
      })
      pending.push(msg)
      return
    }
    const ok = transport.sendMessage(entityId, msg.kind, msg.payload)
    if (!ok) {
      collabLog(params.logLabel, 'sendOrQueue:queue:send-failed', { entityId, kind: msg.kind, bytes: msg.payload.length, wsState: wsStore.state })
      pending.push(msg)
      return
    }
    collabLog(params.logLabel, 'sendOrQueue:sent', { entityId, kind: msg.kind, bytes: msg.payload.length, wsState: wsStore.state })
  }

  function cleanupDoc() {
    collabLog(params.logLabel, 'cleanupDoc:start', {
      entityId: params.entityId.value,
      subscribedEntityId: subscribedEntityId.value,
      queue: pending.length,
    })
    if (doc.value && docListener) {
      doc.value.off('update', docListener)
    }
    if (provider.value && awarenessListener) {
      provider.value.awareness.off('update', awarenessListener)
    }
    if (provider.value?.awareness && provider.value.awareness.clientID >= 0) {
      removeAwarenessStates(provider.value.awareness, [provider.value.awareness.clientID], 'local-destroy')
    }
    provider.value?.awareness.destroy()
    doc.value?.destroy()
    doc.value = null
    provider.value = null
    awarenessListener = null
    docListener = null
    hasLocalEdits = false
    receivedMeaningfulRemoteSync = false
    hasRemotePeers = false
    subscribeAttempt = 0
    subscribeResponseCount = 0
    pendingPersistedMarkdown = null
    clearSeedFallbackTimer()
    clearFullStateSnapshotTimer()
    serverMarkdown.value = null
    allowLocalDraftSeed.value = false
    hasRemotePeersRef.value = false
    subscriberCount.value = 0
    subscriptionReady = false
    pending.length = 0
    collabLog(params.logLabel, 'cleanupDoc:done', { entityId: params.entityId.value })
  }

  function subscribe(entityId: string) {
    if (!isWsReady(wsStore.state)) return
    subscriptionReady = false
    allowLocalDraftSeed.value = false
    subscribeAttempt += 1
    collabLog(params.logLabel, 'subscribe', {
      entityId,
      wsState: wsStore.state,
      subscribeAttempt,
      doc: docMarkdownSignature(doc.value),
    })
    transport.sendSubscribe(entityId)
    subscribedEntityId.value = entityId
  }

  function unsubscribe(entityId: string) {
    if (!entityId) return
    flushScheduledFullStateSnapshot(entityId, 'unsubscribe')
    collabLog(params.logLabel, 'unsubscribe', { entityId, wsState: wsStore.state })
    subscriptionReady = false
    if (isWsReady(wsStore.state)) {
      transport.sendUnsubscribe(entityId)
    }
    subscribedEntityId.value = null
  }

  function setupDoc(entityId: string) {
    collabLog(params.logLabel, 'setupDoc:start', { entityId, wsState: wsStore.state })
    cleanupDoc()

    const nextDoc = new Y.Doc()
    const awareness = new Awareness(nextDoc)
    doc.value = nextDoc
    provider.value = { awareness }
    subscribeError.value = null

    docListener = (update: Uint8Array, origin: unknown) => {
      if (origin !== 'remote') {
        hasLocalEdits = true
      }
      collabLog(params.logLabel, 'doc:update', {
        entityId,
        origin: String(origin),
        bytes: update.length,
        hasLocalEdits,
        doc: docMarkdownSignature(nextDoc),
      })
      if (origin === 'remote') return
      scheduleFullStateSnapshot(entityId, 'doc-update-full-state')
      sendSyncFrame(entityId, SyncFrameType.UPDATE, update, 'doc-update')
    }
    nextDoc.on('update', docListener)

    awarenessListener = ({ added, updated, removed }, origin) => {
      if (origin === 'remote') return
      const changed = [...added, ...updated, ...removed]
      if (changed.length === 0) return
      const payload = encodeAwarenessUpdate(awareness, changed)
      collabLog(params.logLabel, 'awareness:update', {
        entityId,
        origin: String(origin),
        added,
        updated,
        removed,
        changed,
        bytes: payload.length,
      })
      refreshRemotePeerPresence('local-awareness-update', entityId)
      sendOrQueue(entityId, {
        kind: transport.awarenessKind,
        payload,
      })
    }
    awareness.on('update', awarenessListener)

    const user = params.user.value
    if (user) {
      awareness.setLocalStateField('user', {
        id: user.id,
        name: user.name,
        color: user.color,
      })
    }
    refreshRemotePeerPresence('setup-doc', entityId)

    subscribe(entityId)
    collabLog(params.logLabel, 'setupDoc:done', { entityId })
  }

  transport.onSubscribeResponse((resp) => {
    const entityId = params.entityId.value
    if (!entityId || transport.getSubscribeResponseEntityId(resp) !== entityId) return
    subscribeResponseCount += 1
    const roomSnapshot = transport.getSubscribeResponseRoomSnapshot(resp) ?? new Uint8Array()
    const hasRoomSnapshot = roomSnapshot.length > 0
    const persistedMarkdown = transport.getSubscribeResponsePersistedMarkdown(resp)
    const nextSubscriberCount = transport.getSubscribeResponseSubscriberCount(resp)
    const canSeedPersistedMarkdown = !hasRoomSnapshot && nextSubscriberCount <= 1
    subscriptionReady = true
    subscriberCount.value = nextSubscriberCount
    hasRemotePeers = nextSubscriberCount > 1
    hasRemotePeersRef.value = hasRemotePeers
    allowLocalDraftSeed.value = canSeedPersistedMarkdown
    collabLog(params.logLabel, 'onSubscribeResponse', {
      entityId,
      subscribeAttempt,
      subscribeResponseCount,
      subscriberCount: nextSubscriberCount,
      hasRoomSnapshot,
      canSeedPersistedMarkdown,
      roomSnapshotBytes: roomSnapshot.length,
      hasLocalEdits,
      persisted: markdownSignature(persistedMarkdown),
      doc: docMarkdownSignature(doc.value),
    })
    subscribeError.value = null
    receivedMeaningfulRemoteSync = false
    if (hasRoomSnapshot && doc.value) {
      const before = docMarkdownSignature(doc.value)
      Y.applyUpdate(doc.value, roomSnapshot, 'remote')
      const after = docMarkdownSignature(doc.value)
      receivedMeaningfulRemoteSync = true
      pendingPersistedMarkdown = null
      clearSeedFallbackTimer()
      collabLog(params.logLabel, 'seed:room-snapshot:apply', {
        entityId,
        bytes: roomSnapshot.length,
        before,
        after,
      })
    } else {
      pendingPersistedMarkdown = canSeedPersistedMarkdown ? persistedMarkdown : null
      requestPeerState(entityId, 'subscribe-response')
      if (canSeedPersistedMarkdown) {
        schedulePersistedSeed(entityId)
      }
    }
    flushPending(entityId)
  })

  transport.onMessage((msg) => {
    const entityId = params.entityId.value
    if (!entityId || transport.getMessageEntityId(msg) !== entityId || !doc.value || !provider.value) return
    const before = docMarkdownSignature(doc.value)
    const kind = transport.getMessageKind(msg)
    const payload = transport.getMessagePayload(msg)
    collabLog(params.logLabel, 'onCollabMessage', {
      entityId,
      kind,
      bytes: payload.length,
      before,
    })
    if (kind === transport.syncKind) {
      const frame = decodeSyncFrame(payload)
      collabLog(params.logLabel, 'onCollabMessage:sync-frame', {
        entityId,
        type: frame.type,
        legacy: frame.legacy,
        payloadBytes: frame.payload.length,
      })
      if (frame.type === SyncFrameType.STATE_VECTOR) {
        const stateUpdate = Y.encodeStateAsUpdate(doc.value, frame.payload)
        sendSyncFrame(entityId, SyncFrameType.STATE_UPDATE, stateUpdate, 'state-vector-request')
        return
      }
      if (
        frame.type === SyncFrameType.UPDATE ||
        frame.type === SyncFrameType.STATE_UPDATE ||
        frame.type === SyncFrameType.FULL_STATE
      ) {
        Y.applyUpdate(doc.value, frame.payload, 'remote')
        const after = docMarkdownSignature(doc.value)
        const changed = after !== before
        if (changed) {
          receivedMeaningfulRemoteSync = true
          clearSeedFallbackTimer()
        }
        collabLog(params.logLabel, 'onCollabMessage:sync-applied', {
          entityId,
          type: frame.type,
          legacy: frame.legacy,
          bytes: frame.payload.length,
          changed,
          before,
          after,
        })
      }
      return
    }
    if (kind === transport.awarenessKind) {
      applyAwarenessUpdate(provider.value.awareness, payload, 'remote')
      refreshRemotePeerPresence('remote-awareness-update', entityId)
      collabLog(params.logLabel, 'onCollabMessage:awareness-applied', {
        entityId,
        bytes: payload.length,
      })
      if (!hasRemotePeers && !hasLocalEdits && isDocEmpty(doc.value)) {
        collabLog(params.logLabel, 'awareness:peer-leave:resubscribe', {
          entityId,
          reason: 'all-peers-gone-doc-empty',
        })
        subscribe(entityId)
      }
    }
  })

  watch(
    () => params.entityId.value,
    (next, prev) => {
      collabLog(params.logLabel, 'watch:entityId', { prev, next, wsState: wsStore.state })
      if (prev) {
        unsubscribe(prev)
      }
      if (!next) {
        cleanupDoc()
        return
      }
      setupDoc(next)
    },
    { immediate: true },
  )

  watch(
    () => params.user.value,
    (user) => {
      collabLog(params.logLabel, 'watch:user', { entityId: params.entityId.value, hasUser: !!user })
      if (!provider.value?.awareness) return
      if (!user) {
        provider.value.awareness.setLocalStateField('user', null)
        return
      }
      provider.value.awareness.setLocalStateField('user', {
        id: user.id,
        name: user.name,
        color: user.color,
      })
    },
    { deep: true },
  )

  watch(
    () => wsStore.state,
    (next, prev) => {
      const entityId = params.entityId.value
      if (!entityId) return
      collabLog(params.logLabel, 'watch:wsState', { entityId, prev, next, doc: docMarkdownSignature(doc.value) })
      if (!isWsReady(next)) {
        subscriptionReady = false
        return
      }
      if (isWsReady(prev)) return
      subscribe(entityId)
    },
  )

  onBeforeUnmount(() => {
    if (params.entityId.value) {
      unsubscribe(params.entityId.value)
    }
    cleanupDoc()
  })

  function restart() {
    const entityId = params.entityId.value
    if (!entityId) return
    unsubscribe(entityId)
    setupDoc(entityId)
  }

  return {
    doc,
    provider,
    subscribeError,
    serverMarkdown,
    allowLocalDraftSeed,
    hasRemotePeers: hasRemotePeersRef,
    subscriberCount,
    restart,
  }
}
