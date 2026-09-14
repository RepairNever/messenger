import { defineStore } from 'pinia'
import { ref } from 'vue'
import { create, toBinary, fromBinary } from '@bufbuild/protobuf'
import {
  AcceptCallInviteRequestSchema,
  SetCallHandRaisedRequestSchema,
  EncryptedDMMessagePayloadSchema,
  EncryptedDMRecipientPayloadSchema,
  EnvelopeSchema,
  TransportHeartbeatRequestSchema,
  ListActiveCallMembersRequestSchema,
  ListConversationMembersRequestSchema,
  type Envelope,
  type SendMessageAck,
  type ReactionAck,
  type SubscribeThreadResponse,
  type ServerEvent,
  type BootstrapResponse,
  type SyncSinceResponse,
  type AckResponse,
  type ReadCursorAck,
  type PresenceEvent,
  type TypingEvent,
  type CreateCallResponse,
  type InviteCallMembersResponse,
  type JoinCallTokenResponse,
  type CallInviteActionAck,
  type SetCallHandRaisedResponse,
  type ListActiveCallMembersResponse,
  type ListConversationMembersResponse,
  type SetNotificationLevelResponse,
  type TaskDescriptionCollabSubscribeResponse,
  type TaskDescriptionCollabMessage,
  type DocumentContentCollabSubscribeResponse,
  type DocumentContentCollabMessage,
  MessageEntitySchema,
  FeatureCapability,
  ErrorCode,
  ConversationType,
  MessageEntityKind,
  WorkspaceRole,
  NotificationLevel,
  TaskDescriptionCollabMessageKind,
  DocumentContentCollabMessageKind,
  MessageContentMode,
} from '@/shared/proto/packets_pb'
import { generateId } from '@/services/id'

export type ServerEventHandler = (evt: ServerEvent) => void
export type SendMessageAckHandler = (ack: SendMessageAck) => void
export type ReactionAckHandler = (ack: ReactionAck) => void
export type SubscribeThreadResponseHandler = (resp: SubscribeThreadResponse) => void
export type BootstrapResponseHandler = (resp: BootstrapResponse) => void
export type SyncSinceResponseHandler = (resp: SyncSinceResponse) => void
export type AckResponseHandler = (resp: AckResponse) => void
export type ReadCursorAckHandler = (ack: ReadCursorAck) => void
export type PresenceEventHandler = (evt: PresenceEvent) => void
export type TypingEventHandler = (evt: TypingEvent) => void
export type CreateCallResponseHandler = (resp: CreateCallResponse, requestId: string) => void
export type InviteCallMembersResponseHandler = (resp: InviteCallMembersResponse, requestId: string) => void
export type JoinCallTokenResponseHandler = (resp: JoinCallTokenResponse, requestId: string) => void
export type CallInviteActionAckHandler = (ack: CallInviteActionAck) => void
export type SetNotificationLevelResponseHandler = (resp: SetNotificationLevelResponse) => void
export type TaskDescriptionCollabSubscribeResponseHandler = (resp: TaskDescriptionCollabSubscribeResponse) => void
export type TaskDescriptionCollabMessageHandler = (msg: TaskDescriptionCollabMessage) => void
export type DocumentContentCollabSubscribeResponseHandler = (resp: DocumentContentCollabSubscribeResponse) => void
export type DocumentContentCollabMessageHandler = (msg: DocumentContentCollabMessage) => void
export type ProtocolErrorHandler = (err: { requestId: string; code: ErrorCode; message: string; retryAfterMs: number }) => void

type EnvelopePayload = Exclude<Envelope['payload'], { case: undefined }>
type EnvelopePayloadCase = EnvelopePayload['case']
type EnvelopePayloadValue<C extends EnvelopePayloadCase> = Extract<EnvelopePayload, { case: C }>['value']
type PendingRequest = {
  expectedCase: EnvelopePayloadCase
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

export type WsState =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'WS_CONNECTED'
  | 'HELLO_SENT'
  | 'HELLO_COMPLETE'
  | 'AUTH_SENT'
  | 'AUTH_COMPLETE'
  | 'BOOTSTRAPPING'
  | 'LIVE_SYNCED'
  | 'RECOVERING_GAP'
  | 'STALE_REBOOTSTRAP'

export type WsErrorKind = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'BAD_REQUEST' | 'PROTOCOL' | 'TRANSPORT'

export interface WsAuthResult {
  userId: string
  sessionId: string
  persistedEventSeq: bigint
  userRole: string
}

const PROTOCOL_VERSION = 1
const WS_OPEN = 1   // WebSocket.OPEN
const WS_CLOSED = 3 // WebSocket.CLOSED
const PRESENCE_HEARTBEAT_INTERVAL_MS = 30_000
const TRANSPORT_HEARTBEAT_INTERVAL_MS = 30_000
const REQUEST_TIMEOUT_MS = 15_000
const DEBUG_WS_PACKETS = import.meta.env.DEV

const REQUESTED_CAPABILITIES: FeatureCapability[] = Object.values(FeatureCapability)
  .filter((v): v is FeatureCapability => typeof v === 'number' && v !== FeatureCapability.UNSPECIFIED)

function packetLabel(envelope: Envelope): string {
  return envelope.payload.case ?? 'unknown'
}

function normalizeForLog(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(normalizeForLog)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeForLog(entry)])
    )
  }
  return value
}

function logPacket(direction: 'SEND' | 'RECV', envelope: Envelope) {
  // Packet normalization walks every nested value. In particular, protobuf byte
  // fields expand into one property per byte, which can block the renderer for
  // large attachments or sync batches. Keep this diagnostic strictly dev-only
  // so it is compiled out of packaged clients.
  if (!DEBUG_WS_PACKETS) return
  const summary = `[WS ${direction}] ${packetLabel(envelope)}`
  const normalized = normalizeForLog(envelope)
  console.groupCollapsed(summary)
  console.log(normalized)
  console.groupEnd()
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

export const useWsStore = defineStore('ws', () => {
  const state = ref<WsState>('DISCONNECTED')
  const serverHello = ref<Envelope['payload'] | null>(null)
  const authResult = ref<WsAuthResult | null>(null)
  const lastError = ref<string | null>(null)
  const lastErrorKind = ref<WsErrorKind | null>(null)
  const lastCloseCode = ref<number | null>(null)

  let onServerHelloCallback: (() => void) | null = null

  let socket: WebSocket | null = null
  let onAuthFailCallback: ((kind: WsErrorKind) => void) | null = null
  let onTransportDropCallback: (() => void) | null = null
  let suppressTransportDrop = false
  let pendingAuthToken: string | null = null
  let onServerEventCallback: ServerEventHandler | null = null
  let onSendMessageAckCallback: SendMessageAckHandler | null = null
  let onReactionAckCallback: ReactionAckHandler | null = null
  let onSubscribeThreadResponseCallback: SubscribeThreadResponseHandler | null = null
  let onBootstrapResponseCallback: BootstrapResponseHandler | null = null
  let onSyncSinceResponseCallback: SyncSinceResponseHandler | null = null
  let onAckResponseCallback: AckResponseHandler | null = null
  let onReadCursorAckCallback: ReadCursorAckHandler | null = null
  let onPresenceEventCallback: PresenceEventHandler | null = null
  let onTypingEventCallback: TypingEventHandler | null = null
  let onCreateCallResponseCallback: CreateCallResponseHandler | null = null
  let onInviteCallMembersResponseCallback: InviteCallMembersResponseHandler | null = null
  let onJoinCallTokenResponseCallback: JoinCallTokenResponseHandler | null = null
  let onCallInviteActionAckCallback: CallInviteActionAckHandler | null = null
  let onSetNotificationLevelResponseCallback: SetNotificationLevelResponseHandler | null = null
  let onTaskDescriptionCollabSubscribeResponseCallback: TaskDescriptionCollabSubscribeResponseHandler | null = null
  let onTaskDescriptionCollabMessageCallback: TaskDescriptionCollabMessageHandler | null = null
  let onDocumentContentCollabSubscribeResponseCallback: DocumentContentCollabSubscribeResponseHandler | null = null
  let onDocumentContentCollabMessageCallback: DocumentContentCollabMessageHandler | null = null
  const protocolErrorHandlers = new Set<ProtocolErrorHandler>()
  const pendingRequests = new Map<string, PendingRequest>()
  let presenceHeartbeatTimer: ReturnType<typeof setInterval> | null = null
  let transportHeartbeatTimer: ReturnType<typeof setInterval> | null = null
  let transportHeartbeatGeneration = 0
  let transportHeartbeatInFlight = false

  function serverSupportsPresenceHeartbeat(): boolean {
    return serverHello.value?.case === 'serverHello'
      && serverHello.value.value.acceptedCapabilities.includes(FeatureCapability.PRESENCE_HEARTBEAT)
  }

  function canRunPresenceHeartbeat(): boolean {
    // Transport heartbeats are correlated and also refresh the presence lease.
    // Use the legacy one-way heartbeat only with servers that do not negotiate
    // the transport capability.
    return serverSupportsPresenceHeartbeat()
      && !serverSupportsTransportHeartbeat()
      && authResult.value !== null
      && socket !== null
      && socket.readyState === WS_OPEN
      && (
        state.value === 'AUTH_COMPLETE'
        || state.value === 'BOOTSTRAPPING'
        || state.value === 'LIVE_SYNCED'
        || state.value === 'RECOVERING_GAP'
        || state.value === 'STALE_REBOOTSTRAP'
      )
  }

  function serverSupportsTransportHeartbeat(): boolean {
    return serverHello.value?.case === 'serverHello'
      && serverHello.value.value.acceptedCapabilities.includes(FeatureCapability.TRANSPORT_HEARTBEAT)
  }

  function canRunTransportHeartbeat(): boolean {
    return serverSupportsTransportHeartbeat()
      && authResult.value !== null
      && socket !== null
      && socket.readyState === WS_OPEN
      && (
        state.value === 'AUTH_COMPLETE'
        || state.value === 'BOOTSTRAPPING'
        || state.value === 'LIVE_SYNCED'
        || state.value === 'RECOVERING_GAP'
        || state.value === 'STALE_REBOOTSTRAP'
      )
  }

  function stopPresenceHeartbeat() {
    if (presenceHeartbeatTimer) {
      clearInterval(presenceHeartbeatTimer)
      presenceHeartbeatTimer = null
    }
  }

  function stopTransportHeartbeat() {
    transportHeartbeatGeneration += 1
    transportHeartbeatInFlight = false
    if (transportHeartbeatTimer) {
      clearInterval(transportHeartbeatTimer)
      transportHeartbeatTimer = null
    }
  }

  function sendPresenceHeartbeat(): boolean {
    return sendEnvelope(create(EnvelopeSchema, {
      requestId: generateId(),
      traceId: generateId(),
      protocolVersion: PROTOCOL_VERSION,
      payload: {
        case: 'presenceHeartbeatRequest',
        value: {},
      },
    }))
  }

  function startPresenceHeartbeat() {
    if (!canRunPresenceHeartbeat() || presenceHeartbeatTimer) return
    presenceHeartbeatTimer = setInterval(() => {
      if (!canRunPresenceHeartbeat()) {
        stopPresenceHeartbeat()
        return
      }
      sendPresenceHeartbeat()
    }, PRESENCE_HEARTBEAT_INTERVAL_MS)
  }

  function isTransportHeartbeatTimeout(error: unknown): boolean {
    return error instanceof Error
      && error.message.startsWith('Request transportHeartbeatAck timed out:')
  }

  function sendTransportHeartbeat() {
    if (!canRunTransportHeartbeat() || transportHeartbeatInFlight) return

    const expectedSocket = socket
    const generation = transportHeartbeatGeneration
    transportHeartbeatInFlight = true
    void requestEnvelope({
      case: 'transportHeartbeatRequest',
      value: create(TransportHeartbeatRequestSchema),
    }, 'transportHeartbeatAck').catch((error: unknown) => {
      if (generation !== transportHeartbeatGeneration || socket !== expectedSocket) return
      if (!isTransportHeartbeatTimeout(error)) return
      invalidateTransport('Transport heartbeat timed out')
    }).finally(() => {
      if (generation === transportHeartbeatGeneration && socket === expectedSocket) {
        transportHeartbeatInFlight = false
      }
    })
  }

  function startTransportHeartbeat() {
    if (!canRunTransportHeartbeat() || transportHeartbeatTimer) return
    sendTransportHeartbeat()
    transportHeartbeatTimer = setInterval(() => {
      if (!canRunTransportHeartbeat()) {
        stopTransportHeartbeat()
        return
      }
      sendTransportHeartbeat()
    }, TRANSPORT_HEARTBEAT_INTERVAL_MS)
  }

  function onAuthFail(cb: (kind: WsErrorKind) => void) {
    onAuthFailCallback = cb
  }

  function onTransportDrop(cb: () => void) {
    onTransportDropCallback = cb
  }

  function onServerHello(cb: () => void) {
    onServerHelloCallback = cb
  }

  function setPendingAuthToken(token: string) {
    pendingAuthToken = token
  }

  function clearPendingAuthToken() {
    pendingAuthToken = null
  }

  function onServerEvent(cb: ServerEventHandler) {
    onServerEventCallback = cb
  }

  function onSendMessageAck(cb: SendMessageAckHandler) {
    onSendMessageAckCallback = cb
  }

  function onReactionAck(cb: ReactionAckHandler) {
    onReactionAckCallback = cb
  }

  function onSubscribeThreadResponse(cb: SubscribeThreadResponseHandler) {
    onSubscribeThreadResponseCallback = cb
  }

  function onBootstrapResponse(cb: BootstrapResponseHandler) {
    onBootstrapResponseCallback = cb
  }

  function onSyncSinceResponse(cb: SyncSinceResponseHandler) {
    onSyncSinceResponseCallback = cb
  }

  function onAckResponse(cb: AckResponseHandler) {
    onAckResponseCallback = cb
  }

  function onReadCursorAck(cb: ReadCursorAckHandler) {
    onReadCursorAckCallback = cb
  }

  function onPresenceEvent(cb: PresenceEventHandler) {
    onPresenceEventCallback = cb
  }

  function onTypingEvent(cb: TypingEventHandler) {
    onTypingEventCallback = cb
  }

  function onCreateCallResponse(cb: CreateCallResponseHandler) {
    onCreateCallResponseCallback = cb
  }

  function onInviteCallMembersResponse(cb: InviteCallMembersResponseHandler) {
    onInviteCallMembersResponseCallback = cb
  }

  function onJoinCallTokenResponse(cb: JoinCallTokenResponseHandler) {
    onJoinCallTokenResponseCallback = cb
  }

  function onCallInviteActionAck(cb: CallInviteActionAckHandler) {
    onCallInviteActionAckCallback = cb
  }

  function onSetNotificationLevelResponse(cb: SetNotificationLevelResponseHandler) {
    onSetNotificationLevelResponseCallback = cb
  }

  function onTaskDescriptionCollabSubscribeResponse(cb: TaskDescriptionCollabSubscribeResponseHandler) {
    onTaskDescriptionCollabSubscribeResponseCallback = cb
  }

  function onTaskDescriptionCollabMessage(cb: TaskDescriptionCollabMessageHandler) {
    onTaskDescriptionCollabMessageCallback = cb
  }

  function onDocumentContentCollabSubscribeResponse(cb: DocumentContentCollabSubscribeResponseHandler) {
    onDocumentContentCollabSubscribeResponseCallback = cb
  }

  function onDocumentContentCollabMessage(cb: DocumentContentCollabMessageHandler) {
    onDocumentContentCollabMessageCallback = cb
  }

  function onProtocolError(cb: ProtocolErrorHandler) {
    protocolErrorHandlers.add(cb)
  }

  function connect(url: string) {
    stopPresenceHeartbeat()
    stopTransportHeartbeat()
    if (socket && socket.readyState !== WS_CLOSED) {
      rejectPendingRequests(new Error('WebSocket reconnecting'))
      console.log('[ws:connect] closing old socket, suppressTransportDrop=true, readyState=', socket.readyState)
      suppressTransportDrop = true
      socket.close()
    }

    lastError.value = null
    lastErrorKind.value = null
    lastCloseCode.value = null
    serverHello.value = null
    authResult.value = null
    // Transition to CONNECTING so the orchestrator polling loop does not
    // mistake the pre-open window for a genuine disconnect.
    state.value = 'CONNECTING'

    const wsConn = new WebSocket(url)
    socket = wsConn
    suppressTransportDrop = false  // new socket is now the active one
    console.log('[ws:connect] new socket created, suppressTransportDrop reset to false')
    wsConn.binaryType = 'arraybuffer'

    wsConn.onopen = () => {
      if (socket !== wsConn) { console.log('[ws:onopen] stale socket, ignored'); return }
      console.log('[ws:onopen] socket opened')
      state.value = 'WS_CONNECTED'
      sendHello()
    }

    wsConn.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (socket !== wsConn) return
      handleMessage(event.data)
    }

    wsConn.onerror = () => {
      if (socket !== wsConn) { console.log('[ws:onerror] stale socket, ignored'); return }
      stopPresenceHeartbeat()
      stopTransportHeartbeat()
      console.log('[ws:onerror] transport error, suppress=', suppressTransportDrop)
      lastError.value = 'WebSocket transport error'
      lastErrorKind.value = 'TRANSPORT'
      state.value = 'DISCONNECTED'
      // Do NOT fire onTransportDropCallback here — onerror is always followed
      // by onclose, which is the single authoritative place to fire it.
    }

    wsConn.onclose = (ev: CloseEvent) => {
      if (socket !== wsConn) { console.log('[ws:onclose] stale socket, ignored. code=', ev?.code); return }
      stopPresenceHeartbeat()
      stopTransportHeartbeat()
      lastCloseCode.value = ev?.code ?? null
      console.log('[ws:onclose] code=', ev?.code, 'suppress=', suppressTransportDrop, 'lastErrorKind=', lastErrorKind.value)
      if (state.value !== 'DISCONNECTED') {
        state.value = 'DISCONNECTED'
      }
      rejectPendingRequests(new Error('WebSocket disconnected'))
      if (
        !suppressTransportDrop &&
        lastErrorKind.value !== 'UNAUTHENTICATED'
      ) {
        console.log('[ws:onclose] firing onTransportDropCallback')
        onTransportDropCallback?.()
      }
    }
  }

  function disconnect(reason: 'logout' | 'transport' = 'transport') {
    stopPresenceHeartbeat()
    stopTransportHeartbeat()
    rejectPendingRequests(new Error('WebSocket disconnected'))
    // Suppress transport-drop callback for intentional disconnects (logout)
    if (reason === 'logout') {
      onTransportDropCallback = null
    }
    socket?.close()
    socket = null
    state.value = 'DISCONNECTED'
  }

  /**
   * The browser can keep an OPEN WebSocket after the upstream path has died,
   * or close it between a state check and a send. Drop that local transport
   * and notify the session orchestrator immediately rather than waiting for a
   * close event that may never arrive on its own.
   */
  function invalidateTransport(reason = 'WebSocket transport was unresponsive'): boolean {
    const activeSocket = socket
    if (!activeSocket || state.value === 'DISCONNECTED') {
      return false
    }

    stopPresenceHeartbeat()
    stopTransportHeartbeat()
    rejectPendingRequests(new Error(reason))
    lastError.value = reason
    lastErrorKind.value = 'TRANSPORT'
    state.value = 'DISCONNECTED'

    // Detach before close so its eventual close event cannot report the same
    // transport drop twice. The orchestrator callback below owns recovery.
    socket = null
    if (activeSocket.readyState === WS_OPEN) {
      try {
        activeSocket.close()
      } catch {
        // The transport is already considered lost; recovery still proceeds.
      }
    }
    onTransportDropCallback?.()
    return true
  }

  function resetRuntimeState() {
    stopPresenceHeartbeat()
    stopTransportHeartbeat()
    rejectPendingRequests(new Error('WebSocket reset'))
    suppressTransportDrop = true
    try {
      socket?.close()
    } catch {
      // Best effort.
    }
    socket = null

    state.value = 'DISCONNECTED'
    serverHello.value = null
    authResult.value = null
    lastError.value = null
    lastErrorKind.value = null
    lastCloseCode.value = null

    pendingAuthToken = null
    onServerHelloCallback = null
    onAuthFailCallback = null
    onTransportDropCallback = null
    onServerEventCallback = null
    onSendMessageAckCallback = null
    onReactionAckCallback = null
    onSubscribeThreadResponseCallback = null
    onBootstrapResponseCallback = null
    onSyncSinceResponseCallback = null
    onAckResponseCallback = null
    onReadCursorAckCallback = null
    onPresenceEventCallback = null
    onTypingEventCallback = null
    onCreateCallResponseCallback = null
    onInviteCallMembersResponseCallback = null
    onJoinCallTokenResponseCallback = null
    onCallInviteActionAckCallback = null
    onSetNotificationLevelResponseCallback = null
    onTaskDescriptionCollabSubscribeResponseCallback = null
    onTaskDescriptionCollabMessageCallback = null
    onDocumentContentCollabSubscribeResponseCallback = null
    onDocumentContentCollabMessageCallback = null
    protocolErrorHandlers.clear()
  }

  function rejectPendingRequests(err: Error) {
    for (const [requestId, pending] of pendingRequests.entries()) {
      clearTimeout(pending.timeout)
      pending.reject(err)
      pendingRequests.delete(requestId)
    }
  }

  function rejectPendingRequest(requestId: string, err: Error): boolean {
    const pending = pendingRequests.get(requestId)
    if (!pending) return false
    clearTimeout(pending.timeout)
    pending.reject(err)
    pendingRequests.delete(requestId)
    return true
  }

  function resolvePendingResponse(envelope: Envelope): boolean {
    const pending = pendingRequests.get(envelope.requestId)
    if (!pending) return false
    const payload = envelope.payload
    if (payload.case === pending.expectedCase) {
      clearTimeout(pending.timeout)
      pending.resolve(payload.value)
      pendingRequests.delete(envelope.requestId)
      return true
    }
    clearTimeout(pending.timeout)
    pending.reject(new Error(`Unexpected response ${payload.case ?? 'empty'} for request ${envelope.requestId}; expected ${pending.expectedCase}`))
    pendingRequests.delete(envelope.requestId)
    return true
  }

  function requestEnvelope<ResponseCase extends EnvelopePayloadCase>(
    payload: EnvelopePayload,
    expectedCase: ResponseCase,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<EnvelopePayloadValue<ResponseCase>> {
    const requestId = generateId()
    const envelope = create(EnvelopeSchema, {
      requestId,
      traceId: generateId(),
      protocolVersion: PROTOCOL_VERSION,
      payload,
    })

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(requestId)
        reject(new Error(`Request ${expectedCase} timed out: ${requestId}`))
      }, timeoutMs)
      pendingRequests.set(requestId, {
        expectedCase,
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      })
      if (!sendEnvelope(envelope)) {
        rejectPendingRequest(requestId, new Error(lastError.value || 'WebSocket is not open'))
      }
    })
  }

  function sendHello() {
    const envelope = create(EnvelopeSchema, {
      requestId: generateId(),
      traceId: generateId(),
      protocolVersion: PROTOCOL_VERSION,
      payload: {
        case: 'clientHello',
        value: {
          client: 'msgnr-web',
          clientVersion: '0.1.0',
          capabilities: REQUESTED_CAPABILITIES,
        },
      },
    })
    sendEnvelope(envelope)
    state.value = 'HELLO_SENT'
  }

  function sendAuth(accessToken: string): boolean {
    const envelope = create(EnvelopeSchema, {
      requestId: generateId(),
      traceId: generateId(),
      protocolVersion: PROTOCOL_VERSION,
      payload: {
        case: 'authRequest',
        value: { accessToken },
      },
    })
    const sent = sendEnvelope(envelope)
    if (sent) {
      state.value = 'AUTH_SENT'
    }
    return sent
  }

  function sendEnvelope(envelope: Envelope): boolean {
    if (!socket || socket.readyState !== WS_OPEN) {
      lastError.value = 'WebSocket is not open'
      lastErrorKind.value = 'TRANSPORT'
      return false
    }
    logPacket('SEND', envelope)
    const bytes = toBinary(EnvelopeSchema, envelope)
    socket.send(bytes)
    return true
  }

  function sendMessage(
    conversationId: string,
    body: string,
    clientMsgId: string,
    threadRootMessageId?: string,
    attachmentIds: string[] = [],
    entities: Array<{ kind: 'user' | 'task' | 'document'; targetId: string; label: string; href: string; start: number; end: number }> = [],
    encrypted?: {
      senderDeviceId: string
      recipients: Array<{
        recipientDeviceId: string
        senderDeviceId: string
        algorithm: string
        sessionMessage: Uint8Array
        metadataAad: Uint8Array
      }>
    },
  ): boolean {
    const protoEntities = entities.map(entity => create(MessageEntitySchema, {
      kind: entity.kind === 'user'
        ? MessageEntityKind.USER
        : entity.kind === 'task'
          ? MessageEntityKind.TASK
          : MessageEntityKind.DOCUMENT,
      targetId: entity.targetId,
      label: entity.label,
      href: entity.href,
      start: entity.start,
      end: entity.end,
    }))
    return sendEnvelope(create(EnvelopeSchema, {
      requestId: clientMsgId,
      traceId: generateId(),
      protocolVersion: PROTOCOL_VERSION,
      payload: {
        case: 'sendMessageRequest',
        value: {
          conversationId,
          conversationType: ConversationType.CHANNEL_PUBLIC,
          clientMsgId,
          body,
          threadRootMessageId: threadRootMessageId ?? '',
          attachmentIds,
          entities: protoEntities,
          contentMode: encrypted ? MessageContentMode.DM_PAIRWISE_SIGNAL_V1 : MessageContentMode.PLAINTEXT,
          senderDeviceId: encrypted?.senderDeviceId ?? '',
          encryptedDmPayload: encrypted
            ? create(EncryptedDMMessagePayloadSchema, {
                recipients: encrypted.recipients.map(item => create(EncryptedDMRecipientPayloadSchema, {
                  recipientDeviceId: item.recipientDeviceId,
                  senderDeviceId: item.senderDeviceId,
                  algorithm: item.algorithm,
                  sessionMessage: item.sessionMessage,
                  metadataAad: item.metadataAad,
                })),
              })
            : undefined,
        },
      },
    }))
  }

  function sendAddReaction(conversationId: string, messageId: string, emoji: string, clientOpId: string) {
    sendEnvelope(create(EnvelopeSchema, {
      requestId: generateId(),
      traceId: generateId(),
      protocolVersion: PROTOCOL_VERSION,
      payload: {
        case: 'addReactionRequest',
        value: { conversationId, messageId, emoji, clientOpId },
      },
    }))
  }

  function sendRemoveReaction(conversationId: string, messageId: string, emoji: string, clientOpId: string) {
    sendEnvelope(create(EnvelopeSchema, {
      requestId: generateId(),
      traceId: generateId(),
      protocolVersion: PROTOCOL_VERSION,
      payload: {
        case: 'removeReactionRequest',
        value: { conversationId, messageId, emoji, clientOpId },
      },
    }))
  }

  function sendSubscribeThread(conversationId: string, threadRootMessageId: string, lastThreadSeq: bigint = 0n): boolean {
    return sendEnvelope(create(EnvelopeSchema, {
      requestId: generateId(),
      traceId: generateId(),
      protocolVersion: PROTOCOL_VERSION,
      payload: {
        case: 'subscribeThreadRequest',
        value: { conversationId, threadRootMessageId, lastThreadSeq },
      },
    }))
  }

  function sendBootstrap(args: {
    clientInstanceId: string
    includeArchived?: boolean
    pageSizeHint?: number
    pageToken?: string
    bootstrapSessionId?: string
  }) {
    sendEnvelope(create(EnvelopeSchema, {
      requestId: generateId(),
      traceId: generateId(),
      protocolVersion: PROTOCOL_VERSION,
      payload: {
        case: 'bootstrapRequest',
        value: {
          clientInstanceId: args.clientInstanceId,
          includeArchived: args.includeArchived ?? false,
          pageSizeHint: args.pageSizeHint ?? 0,
          pageToken: args.pageToken ?? '',
          bootstrapSessionId: args.bootstrapSessionId ?? '',
        },
      },
    }))
    state.value = 'BOOTSTRAPPING'
  }

  function sendSyncSince(afterSeq: bigint, maxEvents = 0) {
    sendEnvelope(create(EnvelopeSchema, {
      requestId: generateId(),
      traceId: generateId(),
      protocolVersion: PROTOCOL_VERSION,
      payload: {
        case: 'syncSinceRequest',
        value: {
          afterSeq,
          maxEvents,
        },
      },
    }))
    state.value = 'RECOVERING_GAP'
  }

  function sendAck(lastAppliedEventSeq: bigint): boolean {
    return sendEnvelope(create(EnvelopeSchema, {
      requestId: generateId(),
      traceId: generateId(),
      protocolVersion: PROTOCOL_VERSION,
      payload: {
        case: 'ackRequest',
        value: { lastAppliedEventSeq },
      },
    }))
  }

  function sendUpdateReadCursor(conversationId: string, lastReadSeq: bigint) {
    sendEnvelope(create(EnvelopeSchema, {
      requestId: generateId(),
      traceId: generateId(),
      protocolVersion: PROTOCOL_VERSION,
      payload: {
        case: 'updateReadCursorRequest',
        value: {
          conversationId,
          lastReadSeq,
        },
      },
    }))
  }

  function sendTyping(conversationId: string, isTyping: boolean, threadRootMessageId = '') {
    sendEnvelope(create(EnvelopeSchema, {
      requestId: generateId(),
      traceId: generateId(),
      protocolVersion: PROTOCOL_VERSION,
      payload: {
        case: 'typingRequest',
        value: {
          conversationId,
          threadRootMessageId,
          isTyping,
        },
      },
    }))
  }

  function sendSetPresence(desiredPresence: number) {
    sendEnvelope(create(EnvelopeSchema, {
      requestId: generateId(),
      traceId: generateId(),
      protocolVersion: PROTOCOL_VERSION,
      payload: {
        case: 'setPresenceRequest',
        value: { desiredPresence },
      },
    }))
  }

  function sendSetClientWindowActivity(isActive: boolean) {
    sendEnvelope(create(EnvelopeSchema, {
      requestId: generateId(),
      traceId: generateId(),
      protocolVersion: PROTOCOL_VERSION,
      payload: {
        case: 'setClientWindowActivityRequest',
        value: { isActive },
      },
    }))
  }

  function sendSetNotificationLevel(conversationId: string, level: NotificationLevel): string {
    const requestId = generateId()
    sendEnvelope(create(EnvelopeSchema, {
      requestId,
      traceId: generateId(),
      protocolVersion: PROTOCOL_VERSION,
      payload: {
        case: 'setNotificationLevelRequest',
        value: {
          conversationId,
          level,
        },
      },
    }))
    return requestId
  }

  function sendTaskDescriptionCollabSubscribe(taskId: string): string {
    const requestId = generateId()
    sendEnvelope(create(EnvelopeSchema, {
      requestId,
      traceId: generateId(),
      protocolVersion: PROTOCOL_VERSION,
      payload: {
        case: 'taskDescriptionCollabSubscribeRequest',
        value: { taskId },
      },
    }))
    return requestId
  }

  function sendTaskDescriptionCollabUnsubscribe(taskId: string): string {
    const requestId = generateId()
    sendEnvelope(create(EnvelopeSchema, {
      requestId,
      traceId: generateId(),
      protocolVersion: PROTOCOL_VERSION,
      payload: {
        case: 'taskDescriptionCollabUnsubscribeRequest',
        value: { taskId },
      },
    }))
    return requestId
  }

  function sendTaskDescriptionCollabMessage(
    taskId: string,
    kind: TaskDescriptionCollabMessageKind,
    payload: Uint8Array,
  ): boolean {
    return sendEnvelope(create(EnvelopeSchema, {
      requestId: generateId(),
      traceId: generateId(),
      protocolVersion: PROTOCOL_VERSION,
      payload: {
        case: 'taskDescriptionCollabMessage',
        value: { taskId, kind, payload },
      },
    }))
  }

  function sendDocumentContentCollabSubscribe(documentId: string): string {
    const requestId = generateId()
    sendEnvelope(create(EnvelopeSchema, {
      requestId,
      traceId: generateId(),
      protocolVersion: PROTOCOL_VERSION,
      payload: {
        case: 'documentContentCollabSubscribeRequest',
        value: { documentId },
      },
    }))
    return requestId
  }

  function sendDocumentContentCollabUnsubscribe(documentId: string): string {
    const requestId = generateId()
    sendEnvelope(create(EnvelopeSchema, {
      requestId,
      traceId: generateId(),
      protocolVersion: PROTOCOL_VERSION,
      payload: {
        case: 'documentContentCollabUnsubscribeRequest',
        value: { documentId },
      },
    }))
    return requestId
  }

  function sendDocumentContentCollabMessage(
    documentId: string,
    kind: DocumentContentCollabMessageKind,
    payload: Uint8Array,
  ): boolean {
    return sendEnvelope(create(EnvelopeSchema, {
      requestId: generateId(),
      traceId: generateId(),
      protocolVersion: PROTOCOL_VERSION,
      payload: {
        case: 'documentContentCollabMessage',
        value: { documentId, kind, payload },
      },
    }))
  }

  function sendCreateCall(conversationId: string, conversationType: ConversationType, inviteeUserIds: string[] = []): string {
    const requestId = generateId()
    sendEnvelope(create(EnvelopeSchema, {
      requestId,
      traceId: generateId(),
      protocolVersion: PROTOCOL_VERSION,
      payload: {
        case: 'createCallRequest',
        value: {
          conversationId,
          conversationType,
          inviteeUserIds,
        },
      },
    }))
    return requestId
  }

  function sendJoinCallToken(conversationId: string, conversationType: ConversationType): string {
    const requestId = generateId()
    sendEnvelope(create(EnvelopeSchema, {
      requestId,
      traceId: generateId(),
      protocolVersion: PROTOCOL_VERSION,
      payload: {
        case: 'joinCallTokenRequest',
        value: {
          conversationId,
          conversationType,
        },
      },
    }))
    return requestId
  }

  function sendInviteCallMembers(conversationId: string, conversationType: ConversationType, inviteeUserIds: string[] = []): string {
    const requestId = generateId()
    sendEnvelope(create(EnvelopeSchema, {
      requestId,
      traceId: generateId(),
      protocolVersion: PROTOCOL_VERSION,
      payload: {
        case: 'inviteCallMembersRequest',
        value: {
          conversationId,
          conversationType,
          inviteeUserIds,
        },
      },
    }))
    return requestId
  }

  function requestConversationMembers(conversationId: string): Promise<ListConversationMembersResponse> {
    return requestEnvelope({
      case: 'listConversationMembersRequest',
      value: create(ListConversationMembersRequestSchema, { conversationId }),
    }, 'listConversationMembersResponse')
  }

  function requestActiveCallMembers(conversationId: string): Promise<ListActiveCallMembersResponse> {
    return requestEnvelope({
      case: 'listActiveCallMembersRequest',
      value: create(ListActiveCallMembersRequestSchema, { conversationId }),
    }, 'listActiveCallMembersResponse')
  }

  function requestSetCallHandRaised(callId: string, raised: boolean): Promise<SetCallHandRaisedResponse> {
    return requestEnvelope({
      case: 'setCallHandRaisedRequest',
      value: create(SetCallHandRaisedRequestSchema, { callId, raised }),
    }, 'setCallHandRaisedResponse')
  }

  function sendAcceptCallInvite(inviteId: string) {
    sendEnvelope(create(EnvelopeSchema, {
      requestId: generateId(),
      traceId: generateId(),
      protocolVersion: PROTOCOL_VERSION,
      payload: {
        case: 'acceptCallInviteRequest',
        value: create(AcceptCallInviteRequestSchema, { inviteId }),
      },
    }))
  }

  function requestAcceptCallInvite(inviteId: string, options: { leaveExistingCalls?: boolean } = {}): Promise<CallInviteActionAck> {
    return requestEnvelope({
      case: 'acceptCallInviteRequest',
      value: create(AcceptCallInviteRequestSchema, {
        inviteId,
        leaveExistingCalls: options.leaveExistingCalls ?? false,
      }),
    }, 'callInviteActionAck')
  }

  function sendRejectCallInvite(inviteId: string) {
    sendEnvelope(create(EnvelopeSchema, {
      requestId: generateId(),
      traceId: generateId(),
      protocolVersion: PROTOCOL_VERSION,
      payload: {
        case: 'rejectCallInviteRequest',
        value: { inviteId },
      },
    }))
  }

  function sendCancelCallInvite(inviteId: string) {
    sendEnvelope(create(EnvelopeSchema, {
      requestId: generateId(),
      traceId: generateId(),
      protocolVersion: PROTOCOL_VERSION,
      payload: {
        case: 'cancelCallInviteRequest',
        value: { inviteId },
      },
    }))
  }

  function setLiveSynced() {
    state.value = 'LIVE_SYNCED'
  }

  function setRecoveringGap() {
    state.value = 'RECOVERING_GAP'
  }

  function setStaleRebootstrap() {
    state.value = 'STALE_REBOOTSTRAP'
  }

  function handleMessage(data: ArrayBuffer) {
    let envelope: Envelope
    try {
      envelope = fromBinary(EnvelopeSchema, new Uint8Array(data))
    } catch {
      lastError.value = 'Failed to decode server envelope'
      lastErrorKind.value = 'PROTOCOL'
      return
    }
    logPacket('RECV', envelope)

    if (envelope.payload.case !== 'error' && resolvePendingResponse(envelope)) {
      return
    }

    switch (envelope.payload.case) {
      case 'serverHello':
        serverHello.value = envelope.payload
        state.value = 'HELLO_COMPLETE'

        if (pendingAuthToken) {
          const token = pendingAuthToken
          const sent = sendAuth(token)
          if (sent) {
            pendingAuthToken = null
          }
        } else {
          console.warn('[ws-handshake] serverHello received without pending auth token')
        }

        onServerHelloCallback?.()
        onServerHelloCallback = null
        break

      case 'authResponse': {
        const ar = envelope.payload.value
        if (ar.ok) {
          authResult.value = {
            userId: ar.userId,
            sessionId: ar.sessionId,
            persistedEventSeq: ar.persistedEventSeq,
            userRole: workspaceRoleToSlug(ar.userRole),
          }
          state.value = 'AUTH_COMPLETE'
          startPresenceHeartbeat()
          startTransportHeartbeat()
        } else {
          stopPresenceHeartbeat()
          lastError.value = 'AuthResponse: ok=false'
          lastErrorKind.value = 'UNAUTHENTICATED'
          state.value = 'DISCONNECTED'
          onAuthFailCallback?.('UNAUTHENTICATED')
        }
        break
      }

      case 'serverEvent':
        onServerEventCallback?.(envelope.payload.value)
        break

      case 'sendMessageAck':
        onSendMessageAckCallback?.(envelope.payload.value)
        break

      case 'reactionAck':
        onReactionAckCallback?.(envelope.payload.value)
        break

      case 'subscribeThreadResponse':
        onSubscribeThreadResponseCallback?.(envelope.payload.value)
        break

      case 'bootstrapResponse':
        onBootstrapResponseCallback?.(envelope.payload.value)
        break

      case 'syncSinceResponse':
        onSyncSinceResponseCallback?.(envelope.payload.value)
        break

      case 'ackResponse':
        onAckResponseCallback?.(envelope.payload.value)
        break

      case 'readCursorAck':
        onReadCursorAckCallback?.(envelope.payload.value)
        break

      case 'presenceEvent':
        onPresenceEventCallback?.(envelope.payload.value)
        break

      case 'typingEvent':
        onTypingEventCallback?.(envelope.payload.value)
        break

      case 'createCallResponse':
        onCreateCallResponseCallback?.(envelope.payload.value, envelope.requestId)
        break

      case 'inviteCallMembersResponse':
        onInviteCallMembersResponseCallback?.(envelope.payload.value, envelope.requestId)
        break

      case 'joinCallTokenResponse':
        onJoinCallTokenResponseCallback?.(envelope.payload.value, envelope.requestId)
        break

      case 'callInviteActionAck':
        onCallInviteActionAckCallback?.(envelope.payload.value)
        break

      case 'setNotificationLevelResponse':
        onSetNotificationLevelResponseCallback?.(envelope.payload.value)
        break

      case 'taskDescriptionCollabSubscribeResponse':
        onTaskDescriptionCollabSubscribeResponseCallback?.(envelope.payload.value)
        break

      case 'taskDescriptionCollabMessage':
        onTaskDescriptionCollabMessageCallback?.(envelope.payload.value)
        break

      case 'documentContentCollabSubscribeResponse':
        onDocumentContentCollabSubscribeResponseCallback?.(envelope.payload.value)
        break

      case 'documentContentCollabMessage':
        onDocumentContentCollabMessageCallback?.(envelope.payload.value)
        break

      case 'error': {
        const err = envelope.payload.value
        const protocolError = {
          requestId: envelope.requestId,
          code: err.code,
          message: err.message,
          retryAfterMs: err.retryAfterMs,
        }
        protocolErrorHandlers.forEach(handler => handler(protocolError))
        rejectPendingRequest(envelope.requestId, new Error(err.message || `Protocol error: ${err.code}`))
        const kind = mapErrorCode(err.code)
        lastError.value = err.message || `Protocol error: ${err.code}`
        lastErrorKind.value = kind
        const inAuthHandshake =
          state.value === 'HELLO_SENT' ||
          state.value === 'HELLO_COMPLETE' ||
          state.value === 'AUTH_SENT'
        const shouldFailAuth =
          kind === 'UNAUTHENTICATED' ||
          (kind === 'FORBIDDEN' && inAuthHandshake)
        if (shouldFailAuth) {
          state.value = 'DISCONNECTED'
          socket?.close()
          onAuthFailCallback?.(kind)
        }
        break
      }

      default:
        break
    }
  }

  function mapErrorCode(code: ErrorCode): WsErrorKind {
    switch (code) {
      case ErrorCode.UNAUTHENTICATED:
        return 'UNAUTHENTICATED'
      case ErrorCode.FORBIDDEN:
        return 'FORBIDDEN'
      case ErrorCode.BAD_REQUEST:
      case ErrorCode.CALL_NOT_ACTIVE:
        return 'BAD_REQUEST'
      default:
        return 'PROTOCOL'
    }
  }

  return {
    state,
    serverHello,
    authResult,
    lastError,
    lastErrorKind,
    lastCloseCode,
    connect,
    disconnect,
    invalidateTransport,
    resetRuntimeState,
    sendAuth,
    sendMessage,
    sendAddReaction,
    sendRemoveReaction,
    sendSubscribeThread,
    sendBootstrap,
    sendSyncSince,
    sendAck,
    sendUpdateReadCursor,
    sendTyping,
    sendSetPresence,
    sendSetClientWindowActivity,
    sendSetNotificationLevel,
    sendTaskDescriptionCollabSubscribe,
    sendTaskDescriptionCollabUnsubscribe,
    sendTaskDescriptionCollabMessage,
    sendDocumentContentCollabSubscribe,
    sendDocumentContentCollabUnsubscribe,
    sendDocumentContentCollabMessage,
    sendCreateCall,
    sendInviteCallMembers,
    sendJoinCallToken,
    requestConversationMembers,
    requestActiveCallMembers,
    requestSetCallHandRaised,
    sendAcceptCallInvite,
    requestAcceptCallInvite,
    sendRejectCallInvite,
    sendCancelCallInvite,
    setLiveSynced,
    setRecoveringGap,
    setStaleRebootstrap,
    onAuthFail,
    onTransportDrop,
    onServerHello,
    onServerEvent,
    onSendMessageAck,
    onReactionAck,
    onSubscribeThreadResponse,
    clearPendingAuthToken,
    setPendingAuthToken,
    onBootstrapResponse,
    onSyncSinceResponse,
    onAckResponse,
    onReadCursorAck,
    onPresenceEvent,
    onTypingEvent,
    onCreateCallResponse,
    onInviteCallMembersResponse,
    onJoinCallTokenResponse,
    onCallInviteActionAck,
    onSetNotificationLevelResponse,
    onTaskDescriptionCollabSubscribeResponse,
    onTaskDescriptionCollabMessage,
    onDocumentContentCollabSubscribeResponse,
    onDocumentContentCollabMessage,
    onProtocolError,
  }
})
