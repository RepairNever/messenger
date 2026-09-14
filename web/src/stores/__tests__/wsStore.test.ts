import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import { EnvelopeSchema, ErrorCode, PresenceStatus, ConversationType, TaskDescriptionCollabMessageKind, DocumentContentCollabMessageKind, FeatureCapability, InviteState } from '@/shared/proto/packets_pb'
import { useWsStore } from '@/stores/ws'

// Minimal WebSocket mock
class MockWebSocket {
  static OPEN = 1
  static CLOSED = 3
  readyState = MockWebSocket.OPEN
  binaryType = 'arraybuffer'
  onopen: (() => void) | null = null
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null
  sent: Uint8Array[] = []

  send(data: ArrayBuffer | Uint8Array) {
    this.sent.push(data instanceof Uint8Array ? data : new Uint8Array(data))
  }

  close(code = 1000) {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.({ code })
  }

  simulateOpen() { this.onopen?.() }
  simulateMessage(data: ArrayBuffer) { this.onmessage?.({ data }) }
  simulateError() { this.onerror?.() }
  simulateClose(code = 1006) {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.({ code })
  }
}

function makeServerHelloEnvelope(acceptedCapabilities: FeatureCapability[] = []): ArrayBuffer {
  const env = create(EnvelopeSchema, {
    requestId: '1',
    protocolVersion: 1,
    payload: {
      case: 'serverHello',
      value: {
        server: 'msgnr',
        protocolVersion: 1,
        acceptedCapabilities,
      },
    },
  })
  return toBinary(EnvelopeSchema, env).buffer as ArrayBuffer
}

function decodePayloadType(payload: Uint8Array | ArrayBuffer): string {
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload)
  const envelope = fromBinary(EnvelopeSchema, bytes)
  return envelope.payload.case ?? 'unknown'
}

function makeAuthResponseEnvelope(ok: boolean): ArrayBuffer {
  const env = create(EnvelopeSchema, {
    requestId: '2',
    protocolVersion: 1,
    payload: {
      case: 'authResponse',
      value: { ok, userId: 'user-1', sessionId: 'session-1', persistedEventSeq: 12n, userRole: 2 },
    },
  })
  return toBinary(EnvelopeSchema, env).buffer as ArrayBuffer
}

function makeTransportHeartbeatAckEnvelope(requestId: string): ArrayBuffer {
  const env = create(EnvelopeSchema, {
    requestId,
    protocolVersion: 1,
    payload: {
      case: 'transportHeartbeatAck',
      value: {},
    },
  })
  return toBinary(EnvelopeSchema, env).buffer as ArrayBuffer
}

function makeErrorEnvelope(code: ErrorCode, message: string, requestId = '3'): ArrayBuffer {
  const env = create(EnvelopeSchema, {
    requestId,
    protocolVersion: 1,
    payload: {
      case: 'error',
      value: { code, message },
    },
  })
  return toBinary(EnvelopeSchema, env).buffer as ArrayBuffer
}

function makeListConversationMembersResponseEnvelope(requestId: string): ArrayBuffer {
  const env = create(EnvelopeSchema, {
    requestId,
    protocolVersion: 1,
    payload: {
      case: 'listConversationMembersResponse',
      value: {
        members: [
          {
            userId: 'user-2',
            displayName: 'Bob',
            email: 'bob@example.com',
            avatarUrl: '/avatars/bob.png',
          },
        ],
      },
    },
  })
  return toBinary(EnvelopeSchema, env).buffer as ArrayBuffer
}

function makeListActiveCallMembersResponseEnvelope(requestId: string): ArrayBuffer {
  const env = create(EnvelopeSchema, {
    requestId,
    protocolVersion: 1,
    payload: {
      case: 'listActiveCallMembersResponse',
      value: {
        members: [
          {
            userId: 'user-3',
            displayName: 'Eve',
            email: 'eve@example.com',
            avatarUrl: '',
          },
        ],
      },
    },
  })
  return toBinary(EnvelopeSchema, env).buffer as ArrayBuffer
}

function makePresenceEventEnvelope(): ArrayBuffer {
  const env = create(EnvelopeSchema, {
    requestId: '4',
    protocolVersion: 1,
    payload: {
      case: 'presenceEvent',
      value: {
        userId: 'user-2',
        effectivePresence: PresenceStatus.ONLINE,
      },
    },
  })
  return toBinary(EnvelopeSchema, env).buffer as ArrayBuffer
}

function makeInviteCallMembersResponseEnvelope(): ArrayBuffer {
  const env = create(EnvelopeSchema, {
    requestId: '5',
    protocolVersion: 1,
    payload: {
      case: 'inviteCallMembersResponse',
      value: {
        callId: 'call-1',
        conversationId: 'channel-1',
        invitedUserIds: ['user-2'],
        skippedUserIds: ['user-3'],
      },
    },
  })
  return toBinary(EnvelopeSchema, env).buffer as ArrayBuffer
}

function makeCallInviteActionAckEnvelope(requestId: string): ArrayBuffer {
  const env = create(EnvelopeSchema, {
    requestId,
    protocolVersion: 1,
    payload: {
      case: 'callInviteActionAck',
      value: {
        ok: true,
        inviteId: 'invite-1',
        resultingState: InviteState.ACCEPTED,
        applied: true,
      },
    },
  })
  return toBinary(EnvelopeSchema, env).buffer as ArrayBuffer
}

function makeTaskDescriptionCollabSubscribeResponseEnvelope(roomSnapshot: Uint8Array = new Uint8Array()): ArrayBuffer {
  const env = create(EnvelopeSchema, {
    requestId: '6',
    protocolVersion: 1,
    payload: {
      case: 'taskDescriptionCollabSubscribeResponse',
      value: {
        taskId: 'task-1',
        persistedMarkdown: '## persisted',
        subscriberCount: 1,
        roomSnapshot,
      },
    },
  })
  return toBinary(EnvelopeSchema, env).buffer as ArrayBuffer
}

function makeTaskDescriptionCollabMessageEnvelope(): ArrayBuffer {
  const env = create(EnvelopeSchema, {
    requestId: '7',
    protocolVersion: 1,
    payload: {
      case: 'taskDescriptionCollabMessage',
      value: {
        taskId: 'task-1',
        kind: TaskDescriptionCollabMessageKind.SYNC,
        payload: new Uint8Array([1, 2, 3]),
      },
    },
  })
  return toBinary(EnvelopeSchema, env).buffer as ArrayBuffer
}

function makeDocumentContentCollabSubscribeResponseEnvelope(roomSnapshot: Uint8Array = new Uint8Array()): ArrayBuffer {
  const env = create(EnvelopeSchema, {
    requestId: '8',
    protocolVersion: 1,
    payload: {
      case: 'documentContentCollabSubscribeResponse',
      value: {
        documentId: 'doc-1',
        persistedMarkdown: '## persisted doc',
        subscriberCount: 2,
        roomSnapshot,
      },
    },
  })
  return toBinary(EnvelopeSchema, env).buffer as ArrayBuffer
}

function makeDocumentContentCollabMessageEnvelope(): ArrayBuffer {
  const env = create(EnvelopeSchema, {
    requestId: '9',
    protocolVersion: 1,
    payload: {
      case: 'documentContentCollabMessage',
      value: {
        documentId: 'doc-1',
        kind: DocumentContentCollabMessageKind.SYNC,
        payload: new Uint8Array([4, 5, 6]),
      },
    },
  })
  return toBinary(EnvelopeSchema, env).buffer as ArrayBuffer
}

let mockSocket: MockWebSocket
let groupCollapsedSpy: ReturnType<typeof vi.spyOn>
let consoleLogSpy: ReturnType<typeof vi.spyOn>
let groupEndSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useRealTimers()
  mockSocket = new MockWebSocket()
  vi.stubGlobal('WebSocket', vi.fn(function () { return mockSocket }))
  groupCollapsedSpy = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {})
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  groupEndSpy = vi.spyOn(console, 'groupEnd').mockImplementation(() => {})
})

describe('wsStore state machine', () => {
  it('sends one clientHello and one authRequest for successful handshake', () => {
    const store = useWsStore()
    store.setPendingAuthToken('jwt-token')
    store.connect('/ws')
    mockSocket.simulateOpen()

    mockSocket.simulateMessage(makeServerHelloEnvelope())

    expect(mockSocket.sent.length).toBe(2)
    expect(decodePayloadType(mockSocket.sent[0])).toBe('clientHello')
    expect(decodePayloadType(mockSocket.sent[1])).toBe('authRequest')
  })

  it('DISCONNECTED -> HELLO_SENT on connect+open', () => {
    const store = useWsStore()
    store.connect('/ws')
    mockSocket.simulateOpen()
    expect(store.state).toBe('HELLO_SENT')
  })

  it('HELLO_SENT -> HELLO_COMPLETE on serverHello', () => {
    const store = useWsStore()
    store.connect('/ws')
    mockSocket.simulateOpen()
    mockSocket.simulateMessage(makeServerHelloEnvelope())
    expect(store.state).toBe('HELLO_COMPLETE')
    expect(store.serverHello?.case).toBe('serverHello')
  })

  it('invokes onServerHello callback exactly once', () => {
    const store = useWsStore()
    const onHello = vi.fn()
    store.onServerHello(onHello)

    store.connect('/ws')
    mockSocket.simulateOpen()
    mockSocket.simulateMessage(makeServerHelloEnvelope())
    mockSocket.simulateMessage(makeServerHelloEnvelope())

    expect(onHello).toHaveBeenCalledTimes(1)
    expect(store.state).toBe('HELLO_COMPLETE')
  })

  it('HELLO_COMPLETE -> AUTH_SENT on sendAuth', () => {
    const store = useWsStore()
    store.connect('/ws')
    mockSocket.simulateOpen()
    mockSocket.simulateMessage(makeServerHelloEnvelope())
    store.sendAuth('my-access-token')
    expect(store.state).toBe('AUTH_SENT')
    expect(mockSocket.sent.length).toBeGreaterThan(1) // hello + auth
  })

  it('logs outgoing packets in a readable format', () => {
    const store = useWsStore()
    store.connect('/ws')
    mockSocket.simulateOpen()

    expect(store.sendAck(42n)).toBe(true)

    expect(groupCollapsedSpy.mock.calls.some(([message]: [string]) => message === '[WS SEND] ackRequest')).toBe(true)
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        case: 'ackRequest',
        value: expect.objectContaining({
          lastAppliedEventSeq: '42',
        }),
      }),
    }))
    expect(groupEndSpy).toHaveBeenCalled()
  })

  it('reports an unsent ACK when the socket is not open', () => {
    const store = useWsStore()

    expect(store.sendAck(42n)).toBe(false)
  })

  it('sends updateReadCursor requests', () => {
    const store = useWsStore()
    store.connect('/ws')
    mockSocket.simulateOpen()

    store.sendUpdateReadCursor('channel-1', 9n)

    expect(groupCollapsedSpy.mock.calls.some(([message]: [string]) => message === '[WS SEND] updateReadCursorRequest')).toBe(true)
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        case: 'updateReadCursorRequest',
        value: expect.objectContaining({
          conversationId: 'channel-1',
          lastReadSeq: '9',
        }),
      }),
    }))
  })

  it('reports whether a thread subscription reached the websocket', () => {
    const store = useWsStore()
    store.connect('/ws')

    expect(store.sendSubscribeThread('channel-1', 'root-1', 0n)).toBe(true)
    expect(decodePayloadType(mockSocket.sent[mockSocket.sent.length - 1])).toBe('subscribeThreadRequest')

    mockSocket.readyState = MockWebSocket.CLOSED

    expect(store.sendSubscribeThread('channel-1', 'root-1', 0n)).toBe(false)
  })

  it('invalidates an unresponsive transport and reports one reconnectable drop', () => {
    const store = useWsStore()
    const onDrop = vi.fn()
    store.onTransportDrop(onDrop)
    store.connect('/ws')
    mockSocket.simulateOpen()
    store.state = 'LIVE_SYNCED'

    expect(store.invalidateTransport('Thread replay did not receive a response')).toBe(true)
    expect(store.state).toBe('DISCONNECTED')
    expect(store.lastErrorKind).toBe('TRANSPORT')
    expect(store.lastError).toBe('Thread replay did not receive a response')
    expect(onDrop).toHaveBeenCalledTimes(1)

    expect(store.invalidateTransport()).toBe(false)
    expect(onDrop).toHaveBeenCalledTimes(1)
  })

  it('AUTH_SENT -> AUTH_COMPLETE on authResponse ok=true', () => {
    const store = useWsStore()
    store.connect('/ws')
    mockSocket.simulateOpen()
    mockSocket.simulateMessage(makeServerHelloEnvelope())
    store.sendAuth('my-access-token')
    mockSocket.simulateMessage(makeAuthResponseEnvelope(true))
    expect(store.state).toBe('AUTH_COMPLETE')
    expect(store.authResult?.userId).toBe('user-1')
    expect(store.authResult?.sessionId).toBe('session-1')
    expect(store.authResult?.persistedEventSeq).toBe(12n)
    expect(store.authResult?.userRole).toBe('admin')
  })

  it('starts presence heartbeat after auth when the server advertises support and stops on disconnect/reset', () => {
    vi.useFakeTimers()
    const store = useWsStore()
    store.connect('/ws')
    mockSocket.simulateOpen()
    mockSocket.simulateMessage(makeServerHelloEnvelope([FeatureCapability.PRESENCE_HEARTBEAT]))
    store.sendAuth('my-access-token')
    mockSocket.simulateMessage(makeAuthResponseEnvelope(true))

    const sentBeforeHeartbeat = mockSocket.sent.length
    vi.advanceTimersByTime(30_000)

    expect(mockSocket.sent).toHaveLength(sentBeforeHeartbeat + 1)
    expect(decodePayloadType(mockSocket.sent[mockSocket.sent.length - 1])).toBe('presenceHeartbeatRequest')

    store.disconnect('logout')
    const sentBeforeDisconnectAdvance = mockSocket.sent.length
    vi.advanceTimersByTime(60_000)
    expect(mockSocket.sent).toHaveLength(sentBeforeDisconnectAdvance)

    store.connect('/ws')
    mockSocket.simulateOpen()
    mockSocket.simulateMessage(makeServerHelloEnvelope([FeatureCapability.PRESENCE_HEARTBEAT]))
    store.sendAuth('my-access-token')
    mockSocket.simulateMessage(makeAuthResponseEnvelope(true))
    store.resetRuntimeState()
    const sentBeforeResetAdvance = mockSocket.sent.length
    vi.advanceTimersByTime(60_000)
    expect(mockSocket.sent).toHaveLength(sentBeforeResetAdvance)
  })

  it('probes negotiated transport heartbeat capability and accepts a correlated ACK', async () => {
    vi.useFakeTimers()
    const store = useWsStore()
    const onDrop = vi.fn()
    store.onTransportDrop(onDrop)
    store.connect('/ws')
    mockSocket.simulateOpen()
    mockSocket.simulateMessage(makeServerHelloEnvelope([FeatureCapability.TRANSPORT_HEARTBEAT]))
    store.sendAuth('my-access-token')
    mockSocket.simulateMessage(makeAuthResponseEnvelope(true))

    const heartbeat = fromBinary(EnvelopeSchema, mockSocket.sent[mockSocket.sent.length - 1])
    expect(heartbeat.payload.case).toBe('transportHeartbeatRequest')

    mockSocket.simulateMessage(makeTransportHeartbeatAckEnvelope(heartbeat.requestId))
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(14_999)

    expect(onDrop).not.toHaveBeenCalled()
    expect(store.state).toBe('AUTH_COMPLETE')
  })

  it('uses the correlated transport heartbeat instead of the legacy presence heartbeat when both are supported', async () => {
    vi.useFakeTimers()
    const store = useWsStore()
    store.connect('/ws')
    mockSocket.simulateOpen()
    mockSocket.simulateMessage(makeServerHelloEnvelope([
      FeatureCapability.PRESENCE_HEARTBEAT,
      FeatureCapability.TRANSPORT_HEARTBEAT,
    ]))
    store.sendAuth('my-access-token')
    mockSocket.simulateMessage(makeAuthResponseEnvelope(true))

    const firstHeartbeat = fromBinary(EnvelopeSchema, mockSocket.sent[mockSocket.sent.length - 1])
    expect(firstHeartbeat.payload.case).toBe('transportHeartbeatRequest')
    mockSocket.simulateMessage(makeTransportHeartbeatAckEnvelope(firstHeartbeat.requestId))
    await Promise.resolve()

    const sentBeforeInterval = mockSocket.sent.length
    await vi.advanceTimersByTimeAsync(30_000)

    expect(mockSocket.sent).toHaveLength(sentBeforeInterval + 1)
    expect(decodePayloadType(mockSocket.sent[mockSocket.sent.length - 1])).toBe('transportHeartbeatRequest')
  })

  it('invalidates a locally-open transport when its heartbeat ACK is missing despite inbound traffic', async () => {
    vi.useFakeTimers()
    const store = useWsStore()
    const onDrop = vi.fn()
    store.onTransportDrop(onDrop)
    store.connect('/ws')
    mockSocket.simulateOpen()
    mockSocket.simulateMessage(makeServerHelloEnvelope([FeatureCapability.TRANSPORT_HEARTBEAT]))
    store.sendAuth('my-access-token')
    mockSocket.simulateMessage(makeAuthResponseEnvelope(true))
    mockSocket.simulateMessage(makePresenceEventEnvelope())

    await vi.advanceTimersByTimeAsync(15_000)

    expect(store.state).toBe('DISCONNECTED')
    expect(store.lastErrorKind).toBe('TRANSPORT')
    expect(store.lastError).toBe('Transport heartbeat timed out')
    expect(onDrop).toHaveBeenCalledTimes(1)
  })

  it('does not start a transport heartbeat when the server does not negotiate it', async () => {
    vi.useFakeTimers()
    const store = useWsStore()
    const onDrop = vi.fn()
    store.onTransportDrop(onDrop)
    store.connect('/ws')
    mockSocket.simulateOpen()
    mockSocket.simulateMessage(makeServerHelloEnvelope())
    store.sendAuth('my-access-token')
    mockSocket.simulateMessage(makeAuthResponseEnvelope(true))

    await vi.advanceTimersByTimeAsync(45_000)

    expect(mockSocket.sent.some(packet => decodePayloadType(packet) === 'transportHeartbeatRequest')).toBe(false)
    expect(onDrop).not.toHaveBeenCalled()
  })

  it('cancels a pending transport heartbeat when the connection closes', async () => {
    vi.useFakeTimers()
    const store = useWsStore()
    const onDrop = vi.fn()
    store.onTransportDrop(onDrop)
    store.connect('/ws')
    mockSocket.simulateOpen()
    mockSocket.simulateMessage(makeServerHelloEnvelope([FeatureCapability.TRANSPORT_HEARTBEAT]))
    store.sendAuth('my-access-token')
    mockSocket.simulateMessage(makeAuthResponseEnvelope(true))

    store.disconnect('logout')
    await vi.advanceTimersByTimeAsync(15_000)

    expect(onDrop).not.toHaveBeenCalled()
    expect(store.state).toBe('DISCONNECTED')
  })

  it('logs incoming packets in a readable format', () => {
    const store = useWsStore()
    store.connect('/ws')
    mockSocket.simulateOpen()
    mockSocket.simulateMessage(makeServerHelloEnvelope())
    store.sendAuth('my-access-token')

    mockSocket.simulateMessage(makeAuthResponseEnvelope(true))

    expect(groupCollapsedSpy.mock.calls.some(([message]: [string]) => message === '[WS RECV] authResponse')).toBe(true)
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        case: 'authResponse',
        value: expect.objectContaining({
          persistedEventSeq: '12',
        }),
      }),
    }))
    expect(groupEndSpy).toHaveBeenCalled()
  })

  it('transitions to BOOTSTRAPPING when bootstrap starts after auth', () => {
    const store = useWsStore()
    store.connect('/ws')
    mockSocket.simulateOpen()
    mockSocket.simulateMessage(makeServerHelloEnvelope())
    store.sendAuth('my-access-token')
    mockSocket.simulateMessage(makeAuthResponseEnvelope(true))

    store.sendBootstrap({ clientInstanceId: 'client-1' })

    expect(store.state).toBe('BOOTSTRAPPING')
  })

  it('transitions to DISCONNECTED on UNAUTHENTICATED error and calls onAuthFail', () => {
    const store = useWsStore()
    const onFail = vi.fn()
    store.onAuthFail(onFail)

    store.connect('/ws')
    mockSocket.simulateOpen()
    mockSocket.simulateMessage(makeServerHelloEnvelope())
    store.sendAuth('bad-token')
    mockSocket.simulateMessage(makeErrorEnvelope(ErrorCode.UNAUTHENTICATED, 'unauthenticated'))

    expect(store.state).toBe('DISCONNECTED')
    expect(store.lastErrorKind).toBe('UNAUTHENTICATED')
    expect(onFail).toHaveBeenCalledWith('UNAUTHENTICATED')
  })

  it('transitions to DISCONNECTED on FORBIDDEN during auth handshake and calls onAuthFail', () => {
    const store = useWsStore()
    const onFail = vi.fn()
    store.onAuthFail(onFail)

    store.connect('/ws')
    mockSocket.simulateOpen()
    mockSocket.simulateMessage(makeServerHelloEnvelope())
    store.sendAuth('blocked-token')
    mockSocket.simulateMessage(makeErrorEnvelope(ErrorCode.FORBIDDEN, 'forbidden'))

    expect(store.state).toBe('DISCONNECTED')
    expect(store.lastErrorKind).toBe('FORBIDDEN')
    expect(onFail).toHaveBeenCalledWith('FORBIDDEN')
  })

  it('keeps session on FORBIDDEN after auth is complete', () => {
    const store = useWsStore()
    const onFail = vi.fn()
    store.onAuthFail(onFail)

    store.connect('/ws')
    mockSocket.simulateOpen()
    mockSocket.simulateMessage(makeServerHelloEnvelope())
    store.sendAuth('good-token')
    mockSocket.simulateMessage(makeAuthResponseEnvelope(true))
    mockSocket.simulateMessage(makeErrorEnvelope(ErrorCode.FORBIDDEN, 'task collab forbidden'))

    expect(store.state).toBe('AUTH_COMPLETE')
    expect(store.lastErrorKind).toBe('FORBIDDEN')
    expect(onFail).not.toHaveBeenCalled()
  })

  it('transport error transitions to DISCONNECTED', () => {
    const store = useWsStore()
    store.connect('/ws')
    mockSocket.simulateOpen()
    mockSocket.simulateError()
    expect(store.state).toBe('DISCONNECTED')
    expect(store.lastErrorKind).toBe('TRANSPORT')
  })

  it('reports a reconnectable transport drop when the socket closes before opening', () => {
    const store = useWsStore()
    const onDrop = vi.fn()
    store.onTransportDrop(onDrop)

    store.connect('/ws')
    mockSocket.simulateError()
    mockSocket.simulateClose(1006)

    expect(store.state).toBe('DISCONNECTED')
    expect(store.lastErrorKind).toBe('TRANSPORT')
    expect(onDrop).toHaveBeenCalledTimes(1)
  })

  it('stores last close code and clears it on next connect', () => {
    const store = useWsStore()
    store.connect('/ws')
    mockSocket.simulateOpen()
    mockSocket.simulateClose(1006)

    expect(store.lastCloseCode).toBe(1006)
    expect(store.state).toBe('DISCONNECTED')

    store.connect('/ws')
    expect(store.lastCloseCode).toBeNull()
  })

  it('rejects malformed binary data gracefully', () => {
    const store = useWsStore()
    store.connect('/ws')
    mockSocket.simulateOpen()
    const garbage = new Uint8Array([0xff, 0xfe, 0x00]).buffer as ArrayBuffer
    mockSocket.simulateMessage(garbage)
    expect(store.lastErrorKind).toBe('PROTOCOL')
    // state should still be HELLO_SENT (not crash)
    expect(store.state).toBe('HELLO_SENT')
  })

  it('routes direct presence events to the registered callback', () => {
    const store = useWsStore()
    const onPresence = vi.fn()
    store.onPresenceEvent(onPresence)

    store.connect('/ws')
    mockSocket.simulateOpen()
    mockSocket.simulateMessage(makePresenceEventEnvelope())

    expect(onPresence).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-2',
      effectivePresence: PresenceStatus.ONLINE,
    }))
  })

  it('sends inviteCallMembersRequest envelopes', () => {
    const store = useWsStore()
    store.connect('/ws')
    mockSocket.simulateOpen()

    store.sendInviteCallMembers('channel-1', ConversationType.CHANNEL_PUBLIC, ['user-2', 'user-3'])

    const lastSent = mockSocket.sent[mockSocket.sent.length - 1]
    const envelope = fromBinary(EnvelopeSchema, lastSent)
    expect(envelope.payload.case).toBe('inviteCallMembersRequest')
    expect(envelope.payload.value).toEqual(expect.objectContaining({
      conversationId: 'channel-1',
      conversationType: ConversationType.CHANNEL_PUBLIC,
      inviteeUserIds: ['user-2', 'user-3'],
    }))
  })

  it('routes inviteCallMembersResponse to the registered callback', () => {
    const store = useWsStore()
    const onInviteResponse = vi.fn()
    store.onInviteCallMembersResponse(onInviteResponse)

    store.connect('/ws')
    mockSocket.simulateOpen()
    mockSocket.simulateMessage(makeInviteCallMembersResponseEnvelope())

    expect(onInviteResponse).toHaveBeenCalledWith(expect.objectContaining({
      callId: 'call-1',
      conversationId: 'channel-1',
      invitedUserIds: ['user-2'],
      skippedUserIds: ['user-3'],
    }), '5')
  })

  it('requests acceptCallInvite with leaveExistingCalls and resolves action ack', async () => {
    const store = useWsStore()
    store.connect('/ws')
    mockSocket.simulateOpen()

    const promise = store.requestAcceptCallInvite('invite-1', { leaveExistingCalls: true })

    const lastSent = mockSocket.sent[mockSocket.sent.length - 1]
    const envelope = fromBinary(EnvelopeSchema, lastSent)
    expect(envelope.payload.case).toBe('acceptCallInviteRequest')
    expect(envelope.payload.value).toEqual(expect.objectContaining({
      inviteId: 'invite-1',
      leaveExistingCalls: true,
    }))

    mockSocket.simulateMessage(makeCallInviteActionAckEnvelope(envelope.requestId))
    await expect(promise).resolves.toEqual(expect.objectContaining({
      inviteId: 'invite-1',
      resultingState: InviteState.ACCEPTED,
      applied: true,
    }))
  })

  it('routes protocol error envelopes to the registered callback with request id', () => {
    const store = useWsStore()
    const onProtocolError = vi.fn()
    store.onProtocolError(onProtocolError)

    store.connect('/ws')
    mockSocket.simulateOpen()
    mockSocket.simulateMessage(makeErrorEnvelope(ErrorCode.CALL_NOT_ACTIVE, 'call is not active'))

    expect(onProtocolError).toHaveBeenCalledWith(expect.objectContaining({
      requestId: '3',
      code: ErrorCode.CALL_NOT_ACTIVE,
      message: 'call is not active',
    }))
  })

  it('sends listActiveCallMembersRequest envelopes and resolves the matching response', async () => {
    const store = useWsStore()
    store.connect('/ws')
    mockSocket.simulateOpen()

    const promise = store.requestActiveCallMembers('channel-1')
    const envelope = fromBinary(EnvelopeSchema, mockSocket.sent[mockSocket.sent.length - 1])

    expect(envelope.payload.case).toBe('listActiveCallMembersRequest')
    expect(envelope.payload.value).toEqual(expect.objectContaining({
      conversationId: 'channel-1',
    }))

    mockSocket.simulateMessage(makeListActiveCallMembersResponseEnvelope(envelope.requestId))

    await expect(promise).resolves.toEqual(expect.objectContaining({
      members: [
        expect.objectContaining({
          userId: 'user-3',
          displayName: 'Eve',
        }),
      ],
    }))
  })

  it('sends listConversationMembersRequest envelopes and resolves the matching response', async () => {
    const store = useWsStore()
    store.connect('/ws')
    mockSocket.simulateOpen()

    const promise = store.requestConversationMembers('channel-1')
    const envelope = fromBinary(EnvelopeSchema, mockSocket.sent[mockSocket.sent.length - 1])

    expect(envelope.payload.case).toBe('listConversationMembersRequest')
    expect(envelope.payload.value).toEqual(expect.objectContaining({
      conversationId: 'channel-1',
    }))

    mockSocket.simulateMessage(makeListConversationMembersResponseEnvelope(envelope.requestId))

    await expect(promise).resolves.toEqual(expect.objectContaining({
      members: [
        expect.objectContaining({
          userId: 'user-2',
          displayName: 'Bob',
        }),
      ],
    }))
  })

  it('rejects managed requests on matching protocol errors', async () => {
    const store = useWsStore()
    store.connect('/ws')
    mockSocket.simulateOpen()

    const promise = store.requestConversationMembers('channel-1')
    const envelope = fromBinary(EnvelopeSchema, mockSocket.sent[mockSocket.sent.length - 1])
    mockSocket.simulateMessage(makeErrorEnvelope(ErrorCode.FORBIDDEN, 'not a member of this conversation', envelope.requestId))

    await expect(promise).rejects.toThrow('not a member of this conversation')
  })

  it('rejects managed requests on unexpected response cases', async () => {
    const store = useWsStore()
    store.connect('/ws')
    mockSocket.simulateOpen()

    const promise = store.requestActiveCallMembers('channel-1')
    const envelope = fromBinary(EnvelopeSchema, mockSocket.sent[mockSocket.sent.length - 1])
    const wrongResponse = create(EnvelopeSchema, {
      requestId: envelope.requestId,
      protocolVersion: 1,
      payload: {
        case: 'inviteCallMembersResponse',
        value: {
          callId: 'call-1',
          conversationId: 'channel-1',
        },
      },
    })
    mockSocket.simulateMessage(toBinary(EnvelopeSchema, wrongResponse).buffer as ArrayBuffer)

    await expect(promise).rejects.toThrow('Unexpected response inviteCallMembersResponse')
  })

  it('rejects managed requests on timeout and reset cleanup', async () => {
    vi.useFakeTimers()
    const store = useWsStore()
    store.connect('/ws')
    mockSocket.simulateOpen()

    const timedOut = store.requestActiveCallMembers('channel-1')
    vi.advanceTimersByTime(15_000)
    await expect(timedOut).rejects.toThrow('timed out')

    const resetRejected = store.requestConversationMembers('channel-1')
    store.resetRuntimeState()
    await expect(resetRejected).rejects.toThrow('WebSocket reset')
  })

  it('sends task collab subscribe and collab message envelopes', () => {
    const store = useWsStore()
    store.connect('/ws')
    mockSocket.simulateOpen()

    store.sendTaskDescriptionCollabSubscribe('task-1')
    store.sendTaskDescriptionCollabMessage('task-1', TaskDescriptionCollabMessageKind.SYNC, new Uint8Array([9, 9]))

    const secondLast = fromBinary(EnvelopeSchema, mockSocket.sent[mockSocket.sent.length - 2])
    const last = fromBinary(EnvelopeSchema, mockSocket.sent[mockSocket.sent.length - 1])
    expect(secondLast.payload.case).toBe('taskDescriptionCollabSubscribeRequest')
    expect(secondLast.payload.value).toEqual(expect.objectContaining({ taskId: 'task-1' }))
    expect(last.payload.case).toBe('taskDescriptionCollabMessage')
    expect(last.payload.value).toEqual(expect.objectContaining({
      taskId: 'task-1',
      kind: TaskDescriptionCollabMessageKind.SYNC,
    }))
  })

  it('routes task collab subscribe response and relay message callbacks', () => {
    const store = useWsStore()
    const onSubscribe = vi.fn()
    const onCollab = vi.fn()
    store.onTaskDescriptionCollabSubscribeResponse(onSubscribe)
    store.onTaskDescriptionCollabMessage(onCollab)

    store.connect('/ws')
    mockSocket.simulateOpen()
    mockSocket.simulateMessage(makeTaskDescriptionCollabSubscribeResponseEnvelope())
    mockSocket.simulateMessage(makeTaskDescriptionCollabMessageEnvelope())

    expect(onSubscribe).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1',
      persistedMarkdown: '## persisted',
      subscriberCount: 1,
      roomSnapshot: expect.any(Uint8Array),
    }))
    expect(onCollab).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1',
      kind: TaskDescriptionCollabMessageKind.SYNC,
    }))
  })

  it('preserves a non-empty room snapshot in subscribe callbacks', () => {
    const store = useWsStore()
    const onSubscribe = vi.fn()
    const roomSnapshot = new Uint8Array([9, 8, 7, 6])
    store.onTaskDescriptionCollabSubscribeResponse(onSubscribe)

    store.connect('/ws')
    mockSocket.simulateOpen()
    mockSocket.simulateMessage(makeTaskDescriptionCollabSubscribeResponseEnvelope(roomSnapshot))

    expect(onSubscribe).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1',
      roomSnapshot,
    }))
  })

  it('sends document collab subscribe and collab message envelopes', () => {
    const store = useWsStore()
    store.connect('/ws')
    mockSocket.simulateOpen()

    store.sendDocumentContentCollabSubscribe('doc-1')
    store.sendDocumentContentCollabMessage('doc-1', DocumentContentCollabMessageKind.SYNC, new Uint8Array([7, 7]))

    const secondLast = fromBinary(EnvelopeSchema, mockSocket.sent[mockSocket.sent.length - 2])
    const last = fromBinary(EnvelopeSchema, mockSocket.sent[mockSocket.sent.length - 1])
    expect(secondLast.payload.case).toBe('documentContentCollabSubscribeRequest')
    expect(secondLast.payload.value).toEqual(expect.objectContaining({ documentId: 'doc-1' }))
    expect(last.payload.case).toBe('documentContentCollabMessage')
    expect(last.payload.value).toEqual(expect.objectContaining({
      documentId: 'doc-1',
      kind: DocumentContentCollabMessageKind.SYNC,
    }))
  })

  it('routes document collab subscribe response and relay message callbacks', () => {
    const store = useWsStore()
    const onSubscribe = vi.fn()
    const onCollab = vi.fn()
    store.onDocumentContentCollabSubscribeResponse(onSubscribe)
    store.onDocumentContentCollabMessage(onCollab)

    store.connect('/ws')
    mockSocket.simulateOpen()
    mockSocket.simulateMessage(makeDocumentContentCollabSubscribeResponseEnvelope())
    mockSocket.simulateMessage(makeDocumentContentCollabMessageEnvelope())

    expect(onSubscribe).toHaveBeenCalledWith(expect.objectContaining({
      documentId: 'doc-1',
      persistedMarkdown: '## persisted doc',
      subscriberCount: 2,
      roomSnapshot: expect.any(Uint8Array),
    }))
    expect(onCollab).toHaveBeenCalledWith(expect.objectContaining({
      documentId: 'doc-1',
      kind: DocumentContentCollabMessageKind.SYNC,
    }))
  })
})
