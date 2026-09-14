import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { Track } from 'livekit-client'
import { ErrorCode, NotificationLevel, type SetCallHandRaisedResponse } from '@/shared/proto/packets_pb'
import { useCallStore } from '@/stores/call'
import { useChatStore } from '@/stores/chat'
import { useWsStore } from '@/stores/ws'
import { loadAudioPrefs, saveAudioPrefs } from '@/services/storage/audioPrefsStorage'
import { resolveScreenAnnotationStrokeColor } from '@/utils/color'

const platformMocks = vi.hoisted(() => ({
  getPlatformOrNull: vi.fn(),
  getRuntimePlatformType: vi.fn(),
  isTauriRuntime: vi.fn(),
}))

vi.mock('@/platform', () => ({
  getPlatformOrNull: platformMocks.getPlatformOrNull,
}))

vi.mock('@/platform/runtime', () => ({
  getRuntimePlatformType: platformMocks.getRuntimePlatformType,
  isTauriRuntime: platformMocks.isTauriRuntime,
}))

vi.mock('@/services/sound', () => ({
  useNotificationSoundEngine: () => ({
    playIncomingMessage: vi.fn(),
    startCallInviteRing: vi.fn().mockResolvedValue(undefined),
    stopCallInviteRing: vi.fn(),
  }),
}))

beforeEach(() => {
  platformMocks.getPlatformOrNull.mockReset()
  platformMocks.getPlatformOrNull.mockReturnValue(null)
  platformMocks.getRuntimePlatformType.mockReset()
  platformMocks.getRuntimePlatformType.mockReturnValue('pwa')
  platformMocks.isTauriRuntime.mockReset()
  platformMocks.isTauriRuntime.mockReturnValue(false)
})

describe('callStore syncWithActiveCalls', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('keeps external invited calls when conversation is not in sidebar lists', () => {
    const callStore = useCallStore()
    const chatStore = useChatStore()
    const consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    callStore.activeConversationId = 'external-conversation'
    chatStore.channels = []
    chatStore.directMessages = []
    chatStore.activeCalls = []

    callStore.syncWithActiveCalls()

    expect(consoleInfoSpy).not.toHaveBeenCalledWith('[call-leave] leave requested', expect.anything())
    consoleInfoSpy.mockRestore()
  })

  it('leaves when known sidebar conversation no longer has active call', () => {
    const callStore = useCallStore()
    const chatStore = useChatStore()
    const consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    callStore.activeConversationId = 'channel-1'
    chatStore.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chatStore.directMessages = []
    chatStore.activeCalls = []

    callStore.syncWithActiveCalls()

    expect(consoleInfoSpy).toHaveBeenCalledWith('[call-leave] leave requested', expect.objectContaining({
      conversationId: 'channel-1',
    }))
    consoleInfoSpy.mockRestore()
  })
})

describe('callStore raised hands', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('uses the server queue response and prevents rapid duplicate requests', async () => {
    const callStore = useCallStore()
    const chatStore = useChatStore()
    const wsStore = useWsStore()
    let resolveRequest: ((value: SetCallHandRaisedResponse | PromiseLike<SetCallHandRaisedResponse>) => void) | undefined

    chatStore.activeCalls = [{
      id: 'call-1',
      conversationId: 'channel-1',
      status: '1',
      participantCount: 2,
      raisedHands: [],
    }]
    callStore.activeCallId = 'call-1'
    callStore.activeConversationId = 'channel-1'
    const localParticipant = { identity: '' }
    callStore.room = { localParticipant } as never
    // The dock renders before connect() populates LiveKit's non-reactive identity.
    expect(callStore.localHandRaised).toBe(false)
    localParticipant.identity = 'user-a'
    callStore.connected = true

    const requestSpy = vi.spyOn(wsStore, 'requestSetCallHandRaised').mockImplementation(() => new Promise(resolve => {
      resolveRequest = resolve
    }))

    const first = callStore.toggleHandRaised()
    const duplicate = callStore.toggleHandRaised()
    expect(requestSpy).toHaveBeenCalledTimes(1)
    expect(requestSpy).toHaveBeenCalledWith('call-1', true)

    resolveRequest?.({
      callId: 'call-1',
      conversationId: 'channel-1',
      raisedHands: [{ userId: 'user-a', position: 1 }],
    } as never)
    await Promise.all([first, duplicate])

    expect(callStore.localHandRaised).toBe(true)
    expect(callStore.raisedHands).toEqual([{ userId: 'user-a', position: 1 }])

    requestSpy.mockResolvedValue({
      callId: 'call-1',
      conversationId: 'channel-1',
      raisedHands: [],
    } as never)
    await callStore.toggleHandRaised()

    expect(requestSpy).toHaveBeenLastCalledWith('call-1', false)
    expect(callStore.localHandRaised).toBe(false)
    expect(callStore.raisedHands).toEqual([])

    requestSpy.mockResolvedValue({
      callId: 'call-1',
      conversationId: 'channel-1',
      raisedHands: [{ userId: 'user-a', position: 1 }],
    } as never)
    await callStore.toggleHandRaised()

    expect(requestSpy).toHaveBeenLastCalledWith('call-1', true)
    expect(callStore.localHandRaised).toBe(true)
  })

  it('replaces and renumbers the queue from a later shared snapshot', () => {
    const callStore = useCallStore()
    const chatStore = useChatStore()

    callStore.activeCallId = 'call-1'
    callStore.activeConversationId = 'channel-1'
    chatStore.applyCallRaisedHandsSnapshot('call-1', 'channel-1', [
      { userId: 'user-a', position: 1 },
      { userId: 'user-b', position: 2 },
      { userId: 'user-c', position: 3 },
    ] as never)
    chatStore.applyCallRaisedHandsSnapshot('call-1', 'channel-1', [
      { userId: 'user-b', position: 1 },
      { userId: 'user-c', position: 2 },
    ] as never)

    expect(callStore.raisedHands).toEqual([
      { userId: 'user-b', position: 1 },
      { userId: 'user-c', position: 2 },
    ])
  })
})

describe('callStore reactions', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('shows the local reaction immediately, sends it reliably, replaces rapid reactions, and expires the latest one', async () => {
    vi.useFakeTimers()
    try {
      const callStore = useCallStore()
      const publishData = vi.fn().mockResolvedValue(undefined)
      callStore.connected = true
      callStore.room = {
        localParticipant: {
          identity: 'user-a',
          publishData,
        },
      } as never

      await callStore.sendCallReaction('👍')
      expect(callStore.reactionsByParticipantId['user-a']?.emoji).toBe('👍')
      expect(publishData).toHaveBeenCalledWith(expect.objectContaining({
        byteLength: expect.any(Number),
      }), {
        reliable: true,
        topic: 'call-reaction.v1',
      })

      const firstPacket = JSON.parse(new TextDecoder().decode(publishData.mock.calls[0]?.[0]))
      expect(firstPacket).toEqual(expect.objectContaining({
        version: 1,
        kind: 'reaction',
        emoji: '👍',
        sequence: 1,
      }))

      await vi.advanceTimersByTimeAsync(1_000)
      await callStore.sendCallReaction('🎉')
      expect(callStore.reactionsByParticipantId['user-a']?.emoji).toBe('🎉')

      await vi.advanceTimersByTimeAsync(3_999)
      expect(callStore.reactionsByParticipantId['user-a']?.emoji).toBe('🎉')
      await vi.advanceTimersByTimeAsync(1)
      expect(callStore.reactionsByParticipantId['user-a']).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('accepts valid remote reactions once, rejects invalid input, and ignores stale replacements', async () => {
    vi.useFakeTimers()
    try {
      const callStore = useCallStore()
      const encode = (packet: Record<string, unknown>) => new TextEncoder().encode(JSON.stringify(packet))
      const latestPacket = {
        version: 1,
        kind: 'reaction',
        emoji: '👏',
        senderSessionId: 'remote-session',
        sequence: 2,
        reactionId: 'reaction-2',
        sentAtMs: 200,
      }

      expect(callStore.ingestCallReactionPacket(encode(latestPacket), 'user-b')).toBe(true)
      expect(callStore.reactionsByParticipantId['user-b']?.emoji).toBe('👏')

      // A duplicate does not restart its lifetime or alter the visible state.
      expect(callStore.ingestCallReactionPacket(encode(latestPacket), 'user-b')).toBe(true)
      expect(callStore.ingestCallReactionPacket(encode({
        ...latestPacket,
        emoji: '❤️',
        reactionId: 'reaction-1',
        sequence: 1,
        sentAtMs: 100,
      }), 'user-b')).toBe(true)
      expect(callStore.reactionsByParticipantId['user-b']?.emoji).toBe('👏')

      expect(callStore.ingestCallReactionPacket(encode({
        ...latestPacket,
        emoji: 'not-an-emoji',
        reactionId: 'invalid-reaction',
        sequence: 3,
      }), 'user-b')).toBe(false)
      expect(callStore.ingestCallReactionPacket(encode(latestPacket), '')).toBe(false)
      expect(callStore.reactionsByParticipantId['user-b']?.emoji).toBe('👏')

      callStore.clearCallReaction('user-b')
      expect(callStore.reactionsByParticipantId['user-b']).toBeUndefined()
      callStore.clearCallReactions()
      expect(callStore.reactionsByParticipantId).toEqual({})
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('callStore leaveCall media cleanup', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('stops local screen/camera/microphone capture tracks before disconnecting', async () => {
    const callStore = useCallStore()

    const cameraMediaTrackStop = vi.fn()
    const screenMediaTrackStop = vi.fn()
    const micMediaTrackStop = vi.fn()
    const cameraTrackStop = vi.fn()
    const screenTrackStop = vi.fn()
    const micTrackStop = vi.fn()

    const cameraPublication = {
      track: {
        stop: cameraTrackStop,
        mediaStreamTrack: { stop: cameraMediaTrackStop },
      },
    }
    const screenPublication = {
      track: {
        stop: screenTrackStop,
        mediaStreamTrack: { stop: screenMediaTrackStop },
      },
    }
    const micPublication = {
      track: {
        stop: micTrackStop,
        mediaStreamTrack: { stop: micMediaTrackStop },
      },
    }

    const localParticipant = {
      setScreenShareEnabled: vi.fn().mockResolvedValue(undefined),
      setCameraEnabled: vi.fn().mockResolvedValue(undefined),
      setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
      unpublishTrack: vi.fn(),
      videoTrackPublications: new Map([
        ['camera', cameraPublication],
        ['screen', screenPublication],
      ]),
      audioTrackPublications: new Map([
        ['mic', micPublication],
      ]),
    }

    const room = {
      name: 'room-1',
      localParticipant,
      disconnect: vi.fn().mockResolvedValue(undefined),
    }

    callStore.room = room as never
    callStore.activeConversationId = 'channel-1'
    await callStore.leaveCall()

    expect(localParticipant.setScreenShareEnabled).toHaveBeenCalledWith(false)
    expect(localParticipant.setCameraEnabled).toHaveBeenCalledWith(false)
    expect(localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(false)
    expect(localParticipant.unpublishTrack).toHaveBeenCalledTimes(3)
    expect(screenTrackStop).toHaveBeenCalledTimes(1)
    expect(screenMediaTrackStop).toHaveBeenCalledTimes(1)
    expect(cameraTrackStop).toHaveBeenCalledTimes(1)
    expect(cameraMediaTrackStop).toHaveBeenCalledTimes(1)
    expect(micTrackStop).toHaveBeenCalledTimes(1)
    expect(micMediaTrackStop).toHaveBeenCalledTimes(1)
    expect(room.disconnect).toHaveBeenCalledTimes(1)
  })
})

describe('callStore hardware call controls', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('registers while connected, disposes on inactive, and ignores duplicate in-flight hangup', async () => {
    type RegisteredHardwareHandlers = {
      onHangup(): Promise<void> | void
      onToggleMicrophone(): Promise<void> | void
      onSetMicrophoneMuted?(muted: boolean): Promise<void> | void
    }
    let registeredHandlers: RegisteredHardwareHandlers | undefined
    const controls = {
      register: vi.fn((handlers: RegisteredHardwareHandlers) => {
        registeredHandlers = handlers
      }),
      update: vi.fn(),
      dispose: vi.fn(),
    }
    platformMocks.getPlatformOrNull.mockReturnValue({
      type: 'pwa',
      callControls: controls,
    })
    const consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    const callStore = useCallStore()
    callStore.activeConversationId = 'channel-1'
    callStore.activeCallId = 'call-1'
    callStore.connected = true

    await nextTick()
    await Promise.resolve()

    expect(controls.register).toHaveBeenCalledTimes(1)
    expect(controls.update).toHaveBeenLastCalledWith(expect.objectContaining({
      microphoneActive: false,
    }))
    const handlers = registeredHandlers
    expect(handlers).toBeDefined()
    if (!handlers) {
      throw new Error('expected hardware call handlers to be registered')
    }

    const firstHangup = handlers.onHangup()
    const secondHangup = handlers.onHangup()
    await Promise.all([firstHangup, secondHangup])

    const leaveRequests = consoleInfoSpy.mock.calls.filter(call => call[0] === '[call-leave] leave requested')
    expect(leaveRequests).toHaveLength(1)
    expect(consoleInfoSpy).toHaveBeenCalledWith('[call-leave] leave requested', expect.objectContaining({
      activeCallId: 'call-1',
    }))

    callStore.connected = false
    await nextTick()
    await Promise.resolve()

    expect(controls.dispose).toHaveBeenCalledTimes(1)
    consoleInfoSpy.mockRestore()
  })

  it('ignores duplicate in-flight hardware microphone toggles', async () => {
    type RegisteredHardwareHandlers = {
      onHangup(): Promise<void> | void
      onToggleMicrophone(): Promise<void> | void
      onSetMicrophoneMuted?(muted: boolean): Promise<void> | void
    }
    let registeredHandlers: RegisteredHardwareHandlers | undefined
    const controls = {
      register: vi.fn((handlers: RegisteredHardwareHandlers) => {
        registeredHandlers = handlers
      }),
      update: vi.fn(),
      dispose: vi.fn(),
    }
    platformMocks.getPlatformOrNull.mockReturnValue({
      type: 'pwa',
      callControls: controls,
    })
    const originalMediaDevices = navigator.mediaDevices
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        ...(originalMediaDevices ?? {}),
        getUserMedia: vi.fn(),
      },
    })

    let resolveSetMicrophone: () => void = () => {}
    const setMicrophoneEnabled = vi.fn(() => new Promise<void>((resolve) => {
      resolveSetMicrophone = resolve
    }))

    try {
      const callStore = useCallStore()
      callStore.room = {
        name: 'room-1',
        localParticipant: {
          setMicrophoneEnabled,
        },
      } as never
      callStore.activeConversationId = 'channel-1'
      callStore.activeCallId = 'call-1'
      callStore.connected = true
      callStore.micEnabled = false

      await nextTick()
      await Promise.resolve()

      const handlers = registeredHandlers
      expect(handlers).toBeDefined()
      if (!handlers) {
        throw new Error('expected hardware call handlers to be registered')
      }

      const firstToggle = handlers.onToggleMicrophone()
      const secondToggle = handlers.onToggleMicrophone()

      expect(setMicrophoneEnabled).toHaveBeenCalledTimes(1)
      expect(setMicrophoneEnabled).toHaveBeenCalledWith(true, expect.any(Object))
      resolveSetMicrophone()
      await Promise.all([firstToggle, secondToggle])
      expect(callStore.micEnabled).toBe(true)
    } finally {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: originalMediaDevices,
      })
    }
  })

  it('applies AirPods mute state events without toggling when already synced', async () => {
    type RegisteredHardwareHandlers = {
      onHangup(): Promise<void> | void
      onToggleMicrophone(): Promise<void> | void
      onSetMicrophoneMuted?(muted: boolean): Promise<void> | void
    }
    let registeredHandlers: RegisteredHardwareHandlers | undefined
    const controls = {
      register: vi.fn((handlers: RegisteredHardwareHandlers) => {
        registeredHandlers = handlers
      }),
      update: vi.fn(),
      dispose: vi.fn(),
    }
    platformMocks.getPlatformOrNull.mockReturnValue({
      type: 'tauri',
      callControls: controls,
    })
    const originalMediaDevices = navigator.mediaDevices
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        ...(originalMediaDevices ?? {}),
        getUserMedia: vi.fn(),
      },
    })
    const setMicrophoneEnabled = vi.fn().mockResolvedValue(undefined)

    try {
      const callStore = useCallStore()
      callStore.room = {
        name: 'room-1',
        localParticipant: {
          setMicrophoneEnabled,
        },
      } as never
      callStore.activeConversationId = 'channel-1'
      callStore.activeCallId = 'call-1'
      callStore.connected = true
      callStore.micEnabled = true

      await nextTick()
      await Promise.resolve()

      const handlers = registeredHandlers
      expect(handlers?.onSetMicrophoneMuted).toBeDefined()
      await handlers?.onSetMicrophoneMuted?.(true)
      await handlers?.onSetMicrophoneMuted?.(true)

      expect(setMicrophoneEnabled).toHaveBeenCalledTimes(1)
      expect(setMicrophoneEnabled).toHaveBeenCalledWith(false, undefined)
      expect(callStore.micEnabled).toBe(false)
    } finally {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: originalMediaDevices,
      })
    }
  })
})

describe('callStore join token error handling', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('rejects immediately on join_call_token protocol errors instead of timing out', async () => {
    const callStore = useCallStore()
    const chatStore = useChatStore()
    const wsStore = useWsStore()

    chatStore.activeCalls = []
    chatStore.channels = []
    chatStore.directMessages = []

    const joinResponseHandler = {
      current: null as null | ((resp: { livekitUrl: string; livekitToken: string; livekitRoom: string }, requestId: string) => void),
    }
    const protocolErrorHandler = {
      current: null as null | ((err: { requestId: string; code: ErrorCode; message: string; retryAfterMs?: number }) => void),
    }

    wsStore.onJoinCallTokenResponse = vi.fn((cb) => {
      joinResponseHandler.current = cb as typeof joinResponseHandler.current
    }) as typeof wsStore.onJoinCallTokenResponse
    wsStore.onCreateCallResponse = vi.fn() as typeof wsStore.onCreateCallResponse
    wsStore.onProtocolError = vi.fn((cb) => {
      protocolErrorHandler.current = cb as typeof protocolErrorHandler.current
    }) as typeof wsStore.onProtocolError
    wsStore.onInviteCallMembersResponse = vi.fn() as typeof wsStore.onInviteCallMembersResponse
    wsStore.onCallInviteActionAck = vi.fn() as typeof wsStore.onCallInviteActionAck
    wsStore.sendJoinCallToken = vi.fn(() => 'join-req-1') as typeof wsStore.sendJoinCallToken

    callStore.registerWsHandlers()
    expect(joinResponseHandler.current).not.toBeNull()
    expect(protocolErrorHandler.current).not.toBeNull()
    if (!protocolErrorHandler.current) {
      throw new Error('expected protocolErrorHandler to be registered')
    }

    const joinPromise = callStore.startOrJoinCall({
      conversationId: 'dm-1',
      kind: 'dm',
      visibility: 'dm',
      joinExistingOnly: true,
    })

    protocolErrorHandler.current({
      requestId: 'join-req-1',
      code: ErrorCode.CALL_NOT_ACTIVE,
      message: 'join_call_token_request: call is not active',
    })

    await expect(joinPromise).rejects.toThrow('Call is no longer active')
    expect(callStore.errorMessage).toBe('Call is no longer active')
  })

  it('waits for create_call success before requesting join token', async () => {
    const callStore = useCallStore()
    const chatStore = useChatStore()
    const wsStore = useWsStore()

    chatStore.activeCalls = []
    chatStore.channels = []
    chatStore.directMessages = []

    const createCallHandler = {
      current: null as null | ((resp: { callId: string; conversationId: string; status: number }, requestId: string) => void),
    }
    const joinResponseHandler = {
      current: null as null | ((resp: { livekitUrl: string; livekitToken: string; livekitRoom: string }, requestId: string) => void),
    }
    const protocolErrorHandler = {
      current: null as null | ((err: { requestId: string; code: ErrorCode; message: string; retryAfterMs?: number }) => void),
    }

    wsStore.onCreateCallResponse = vi.fn((cb) => {
      createCallHandler.current = cb as typeof createCallHandler.current
    }) as typeof wsStore.onCreateCallResponse
    wsStore.onJoinCallTokenResponse = vi.fn((cb) => {
      joinResponseHandler.current = cb as typeof joinResponseHandler.current
    }) as typeof wsStore.onJoinCallTokenResponse
    wsStore.onProtocolError = vi.fn((cb) => {
      protocolErrorHandler.current = cb as typeof protocolErrorHandler.current
    }) as typeof wsStore.onProtocolError
    wsStore.onInviteCallMembersResponse = vi.fn() as typeof wsStore.onInviteCallMembersResponse
    wsStore.onCallInviteActionAck = vi.fn() as typeof wsStore.onCallInviteActionAck
    wsStore.sendCreateCall = vi.fn(() => 'create-req-1') as typeof wsStore.sendCreateCall
    wsStore.sendJoinCallToken = vi.fn(() => 'join-req-1') as typeof wsStore.sendJoinCallToken

    callStore.registerWsHandlers()
    expect(createCallHandler.current).not.toBeNull()
    expect(joinResponseHandler.current).not.toBeNull()
    expect(protocolErrorHandler.current).not.toBeNull()
    if (!createCallHandler.current || !joinResponseHandler.current || !protocolErrorHandler.current) {
      throw new Error('expected call handlers to be registered')
    }

    const startPromise = callStore.startOrJoinCall({
      conversationId: 'dm-1',
      kind: 'dm',
      visibility: 'dm',
    })

    expect(wsStore.sendCreateCall).toHaveBeenCalledTimes(1)
    expect(wsStore.sendJoinCallToken).not.toHaveBeenCalled()

    createCallHandler.current({
      callId: 'call-1',
      conversationId: 'dm-1',
      status: 1,
    }, 'create-req-1')

    await vi.waitFor(() => {
      expect(wsStore.sendJoinCallToken).toHaveBeenCalledTimes(1)
    })
    protocolErrorHandler.current({
      requestId: 'join-req-1',
      code: ErrorCode.CALL_NOT_ACTIVE,
      message: 'join_call_token_request: call is not active',
    })

    await expect(startPromise).rejects.toThrow('Call is no longer active')
  })

  it('surfaces create_call errors without sending join token', async () => {
    const callStore = useCallStore()
    const chatStore = useChatStore()
    const wsStore = useWsStore()

    chatStore.activeCalls = []
    chatStore.channels = []
    chatStore.directMessages = []

    const protocolErrorHandler = {
      current: null as null | ((err: { requestId: string; code: ErrorCode; message: string; retryAfterMs?: number }) => void),
    }

    wsStore.onJoinCallTokenResponse = vi.fn() as typeof wsStore.onJoinCallTokenResponse
    wsStore.onCreateCallResponse = vi.fn() as typeof wsStore.onCreateCallResponse
    wsStore.onProtocolError = vi.fn((cb) => {
      protocolErrorHandler.current = cb as typeof protocolErrorHandler.current
    }) as typeof wsStore.onProtocolError
    wsStore.onInviteCallMembersResponse = vi.fn() as typeof wsStore.onInviteCallMembersResponse
    wsStore.onCallInviteActionAck = vi.fn() as typeof wsStore.onCallInviteActionAck
    wsStore.sendCreateCall = vi.fn(() => 'create-req-2') as typeof wsStore.sendCreateCall
    wsStore.sendJoinCallToken = vi.fn(() => 'join-req-2') as typeof wsStore.sendJoinCallToken

    callStore.registerWsHandlers()
    expect(protocolErrorHandler.current).not.toBeNull()
    if (!protocolErrorHandler.current) {
      throw new Error('expected protocolErrorHandler to be registered')
    }

    const startPromise = callStore.startOrJoinCall({
      conversationId: 'dm-1',
      kind: 'dm',
      visibility: 'dm',
    })

    protocolErrorHandler.current({
      requestId: 'create-req-2',
      code: ErrorCode.BAD_REQUEST,
      message: 'create_call_request: internal error',
    })

    await expect(startPromise).rejects.toThrow('create_call_request: internal error')
    expect(wsStore.sendJoinCallToken).not.toHaveBeenCalled()
  })
})

describe('callStore switchInputDevice', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('persists the selected microphone and republishes local audio when mic is active', async () => {
    const callStore = useCallStore()
    const oldTrack = { sid: 'old-mic-track' }
    const setMicrophoneEnabled = vi.fn().mockResolvedValue(undefined)
    const unpublishTrack = vi.fn().mockResolvedValue(undefined)
    const getTrackPublication = vi.fn()
      .mockReturnValueOnce({ track: oldTrack })
      .mockReturnValueOnce(undefined)

    const originalMediaDevices = navigator.mediaDevices
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        ...(originalMediaDevices ?? {}),
        getUserMedia: vi.fn(),
      },
    })

    try {
      callStore.room = {
        name: 'room-1',
        localParticipant: {
          identity: 'user-1',
          setMicrophoneEnabled,
          unpublishTrack,
          getTrackPublication,
        },
      } as never
      callStore.connected = true
      callStore.micEnabled = true

      const currentPrefs = loadAudioPrefs()
      saveAudioPrefs({
        ...currentPrefs,
        inputDeviceId: '',
      })

      await callStore.switchInputDevice('mic-2')

      expect(loadAudioPrefs().inputDeviceId).toBe('mic-2')
      expect(setMicrophoneEnabled).toHaveBeenNthCalledWith(1, false)
      expect(unpublishTrack).toHaveBeenCalledWith(oldTrack, true)
      expect(setMicrophoneEnabled).toHaveBeenNthCalledWith(
        2,
        true,
        expect.objectContaining({
          deviceId: 'mic-2',
        }),
      )
      expect(callStore.micEnabled).toBe(true)
    } finally {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: originalMediaDevices,
      })
    }
  })
})

describe('callStore screen annotations', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  function createTauriPlatform() {
    const invokeNative = vi.fn().mockResolvedValue(undefined)
    platformMocks.getPlatformOrNull.mockReturnValue({
      type: 'tauri',
      system: {
        invokeNative,
      },
    })
    platformMocks.getRuntimePlatformType.mockReturnValue('tauri')
    platformMocks.isTauriRuntime.mockReturnValue(true)
    return { invokeNative }
  }

  function createLocalSharerRoom(options?: {
    shareLabel?: string
    shareType?: 'monitor' | 'window' | 'browser'
  }) {
    let shareLabel = options?.shareLabel ?? 'Display 1'
    let shareType = options?.shareType ?? 'monitor'
    const mediaStreamTrack = {
      get label() {
        return shareLabel
      },
      getSettings: vi.fn(() => ({
        displaySurface: shareType,
      })),
    }
    const screenPublication = {
      track: {
        mediaStreamTrack,
      },
      isMuted: false,
    }
    const publishData = vi.fn().mockResolvedValue(undefined)
    const localParticipant = {
      identity: 'user-a',
      publishData,
      getTrackPublication: vi.fn((source: Track.Source) => (
        source === Track.Source.ScreenShare ? screenPublication : undefined
      )),
      setScreenShareEnabled: vi.fn().mockResolvedValue(undefined),
      setCameraEnabled: vi.fn().mockResolvedValue(undefined),
      setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
      unpublishTrack: vi.fn().mockResolvedValue(undefined),
      videoTrackPublications: new Map(),
      audioTrackPublications: new Map(),
    }

    return {
      publishData,
      room: {
        name: 'room-annotation',
        disconnect: vi.fn().mockResolvedValue(undefined),
        localParticipant,
        remoteParticipants: new Map(),
      },
      setShareLabel(next: string) {
        shareLabel = next
      },
      setShareType(next: 'monitor' | 'window' | 'browser') {
        shareType = next
      },
    }
  }

  async function flushAsync() {
    for (let index = 0; index < 5; index += 1) {
      await Promise.resolve()
    }
  }

  function buildInactiveSessionPacket() {
    return new TextEncoder().encode(JSON.stringify({
      version: 1,
      kind: 'session',
      active: false,
      sharerIdentity: 'user-a',
      sharerPlatform: 'tauri',
      shareType: 'unknown',
      shareLabel: '',
      sentAtMs: Date.now(),
    }))
  }

  function buildSegmentPacket(seq: number, options?: { senderIdentity?: string; strokeId?: string }) {
    return new TextEncoder().encode(JSON.stringify({
      version: 1,
      kind: 'segment',
      shareTrackSid: 'screen-track',
      senderIdentity: options?.senderIdentity ?? 'user-b',
      strokeId: options?.strokeId ?? 'stroke-batch',
      seq,
      from: { x: 0.1, y: 0.1 },
      to: { x: 0.5, y: 0.5 },
      sentAtMs: Date.now(),
    }))
  }

  it('allows non-sharer publish when sharer session supports annotation', async () => {
    const callStore = useCallStore()
    const publishData = vi.fn().mockResolvedValue(undefined)

    callStore.room = {
      localParticipant: {
        identity: 'user-b',
        publishData,
      },
      remoteParticipants: new Map(),
    } as never
    callStore.screenShareEnabled = false
    callStore.ingestScreenAnnotationPacket(
      new TextEncoder().encode(JSON.stringify({
        version: 1,
        kind: 'session',
        active: true,
        sharerIdentity: 'user-a',
        sharerPlatform: 'tauri',
        shareType: 'monitor',
        shareLabel: 'Display 1',
        sentAtMs: Date.now(),
      })),
      'user-a',
    )

    const sent = await callStore.publishScreenAnnotationSegment({
      version: 1,
      kind: 'segment',
      shareTrackSid: 'remote-screen-track',
      senderIdentity: 'ignored-client-id',
      strokeId: 'stroke-1',
      seq: 0,
      from: { x: 0.1, y: 0.2 },
      to: { x: 0.3, y: 0.4 },
      sentAtMs: Date.now(),
    })

    expect(sent).toBe(true)
    expect(publishData).toHaveBeenCalledTimes(1)
    const encodedPayload = publishData.mock.calls[0]?.[0] as Uint8Array
    const publishOptions = publishData.mock.calls[0]?.[1] as { reliable: boolean; topic: string }
    expect(ArrayBuffer.isView(encodedPayload)).toBe(true)
    expect(publishOptions).toEqual(expect.objectContaining({
      reliable: false,
      topic: 'screen-annotation.v1',
    }))
    const decoded = JSON.parse(new TextDecoder().decode(encodedPayload)) as Record<string, unknown>
    expect(decoded.kind).toBe('segment')
    expect(decoded.senderIdentity).toBe('user-b')
    expect(decoded.color).toBeUndefined()
  })

  it('blocks annotation publish for the screen sharer', async () => {
    const callStore = useCallStore()
    const publishData = vi.fn().mockResolvedValue(undefined)

    callStore.room = {
      localParticipant: {
        identity: 'user-a',
        publishData,
      },
      remoteParticipants: new Map(),
    } as never
    callStore.screenShareEnabled = true
    callStore.ingestScreenAnnotationPacket(
      new TextEncoder().encode(JSON.stringify({
        version: 1,
        kind: 'session',
        active: true,
        sharerIdentity: 'user-a',
        sharerPlatform: 'tauri',
        shareType: 'monitor',
        shareLabel: 'Display 1',
        sentAtMs: Date.now(),
      })),
      'user-a',
    )

    const sent = await callStore.publishScreenAnnotationSegment({
      version: 1,
      kind: 'segment',
      shareTrackSid: 'local-screen-track',
      senderIdentity: 'user-a',
      strokeId: 'stroke-1',
      seq: 0,
      from: { x: 0.1, y: 0.2 },
      to: { x: 0.3, y: 0.4 },
      sentAtMs: Date.now(),
    })

    expect(sent).toBe(false)
    expect(publishData).not.toHaveBeenCalled()
  })

  it('disables annotation globally when sharer is non-tauri', async () => {
    const callStore = useCallStore()
    const publishData = vi.fn().mockResolvedValue(undefined)

    callStore.room = {
      localParticipant: {
        identity: 'user-b',
        publishData,
      },
      remoteParticipants: new Map(),
    } as never
    callStore.screenShareEnabled = false
    callStore.ingestScreenAnnotationPacket(
      new TextEncoder().encode(JSON.stringify({
        version: 1,
        kind: 'session',
        active: true,
        sharerIdentity: 'user-a',
        sharerPlatform: 'pwa',
        shareType: 'monitor',
        shareLabel: 'Display 1',
        sentAtMs: Date.now(),
      })),
      'user-a',
    )

    expect(callStore.annotationAvailable).toBe(false)
    expect(callStore.annotationDisabledReason).toContain('not on Tauri')

    const sent = await callStore.publishScreenAnnotationSegment({
      version: 1,
      kind: 'segment',
      shareTrackSid: 'remote-screen-track',
      senderIdentity: 'user-b',
      strokeId: 'stroke-1',
      seq: 0,
      from: { x: 0.1, y: 0.2 },
      to: { x: 0.3, y: 0.4 },
      sentAtMs: Date.now(),
    })
    expect(sent).toBe(false)
    expect(publishData).not.toHaveBeenCalled()
  })

  it('parses session metadata and transitions annotation mode', () => {
    const callStore = useCallStore()

    const monitorAccepted = callStore.ingestScreenAnnotationPacket(
      new TextEncoder().encode(JSON.stringify({
        version: 1,
        kind: 'session',
        active: true,
        sharerIdentity: 'user-a',
        sharerPlatform: 'tauri',
        shareType: 'monitor',
        shareLabel: 'Display 1',
        sentAtMs: Date.now(),
      })),
      'user-a',
    )
    expect(monitorAccepted).toBe(true)
    expect(callStore.annotationSessionMode).toBe('os-overlay')
    expect(callStore.annotationAvailable).toBe(true)

    const windowAccepted = callStore.ingestScreenAnnotationPacket(
      new TextEncoder().encode(JSON.stringify({
        version: 1,
        kind: 'session',
        active: true,
        sharerIdentity: 'user-a',
        sharerPlatform: 'tauri',
        shareType: 'window',
        shareLabel: 'Code Window',
        sentAtMs: Date.now(),
      })),
      'user-a',
    )
    expect(windowAccepted).toBe(true)
    expect(callStore.annotationSessionMode).toBe('preview-fallback')

    const inactiveAccepted = callStore.ingestScreenAnnotationPacket(
      new TextEncoder().encode(JSON.stringify({
        version: 1,
        kind: 'session',
        active: false,
        sharerIdentity: 'user-a',
        sharerPlatform: 'tauri',
        shareType: 'window',
        shareLabel: '',
        sentAtMs: Date.now(),
      })),
      'user-a',
    )
    expect(inactiveAccepted).toBe(true)
    expect(callStore.annotationAvailable).toBe(false)
    expect(callStore.annotationDisabledReason).toBe('No active screen share')
  })

  it('ignores malformed packets and emits valid segments even for sharer clients', () => {
    const callStore = useCallStore()
    callStore.screenShareEnabled = true

    const received: Array<{ senderIdentity: string; strokeId: string; seq: number }> = []
    const unsubscribe = callStore.onScreenAnnotation((event) => {
      received.push({
        senderIdentity: event.senderIdentity,
        strokeId: event.strokeId,
        seq: event.seq,
      })
    })

    const malformedAccepted = callStore.ingestScreenAnnotationPacket(
      new TextEncoder().encode('{"bad":true}'),
      'user-b',
    )
    expect(malformedAccepted).toBe(false)
    expect(received).toHaveLength(0)

    const validAccepted = callStore.ingestScreenAnnotationPacket(
      new TextEncoder().encode(JSON.stringify({
        version: 1,
        kind: 'segment',
        shareTrackSid: 'remote-screen-track',
        senderIdentity: 'payload-user',
        strokeId: 'stroke-ok',
        seq: 7,
        from: { x: 0.25, y: 0.25 },
        to: { x: 0.5, y: 0.5 },
        sentAtMs: Date.now(),
      })),
      'participant-identity',
    )

    expect(validAccepted).toBe(true)
    expect(received).toEqual([{
      senderIdentity: 'participant-identity',
      strokeId: 'stroke-ok',
      seq: 7,
    }])

    unsubscribe()
  })

  it('republishes local session metadata when the shared monitor label changes', async () => {
    vi.useFakeTimers()
    try {
      const { invokeNative } = createTauriPlatform()
      const localShare = createLocalSharerRoom({ shareLabel: 'Display 1', shareType: 'monitor' })
      const callStore = useCallStore()

      callStore.room = localShare.room as never
      callStore.screenShareEnabled = true
      callStore.ingestScreenAnnotationPacket(
        new TextEncoder().encode(JSON.stringify({
          version: 1,
          kind: 'session',
          active: true,
          sharerIdentity: 'user-a',
          sharerPlatform: 'tauri',
          shareType: 'monitor',
          shareLabel: 'Display 1',
          sentAtMs: Date.now(),
        })),
        'user-a',
      )
      await flushAsync()

      localShare.publishData.mockClear()
      invokeNative.mockClear()
      localShare.setShareLabel('Display 2')

      await vi.advanceTimersByTimeAsync(600)
      await flushAsync()

      expect(localShare.publishData).toHaveBeenCalledTimes(1)
      const payload = JSON.parse(new TextDecoder().decode(localShare.publishData.mock.calls[0][0]))
      expect(payload).toEqual(expect.objectContaining({
        kind: 'session',
        shareType: 'monitor',
        shareLabel: 'Display 2',
      }))
      expect(invokeNative).toHaveBeenCalledWith('annotation_overlay_show', expect.objectContaining({
        overlayLabel: 'annotation_overlay',
        shareLabel: 'Display 2',
      }))
      expect(invokeNative).toHaveBeenCalledWith('annotation_overlay_clear', {
        overlayLabel: 'annotation_overlay',
      })

      callStore.ingestScreenAnnotationPacket(buildInactiveSessionPacket(), 'user-a')
      await flushAsync()
    } finally {
      vi.useRealTimers()
    }
  })

  it('routes incoming sharer-side overlay segments to the current active monitor in batches without re-showing it', async () => {
    vi.useFakeTimers()
    try {
      const { invokeNative } = createTauriPlatform()
      const localShare = createLocalSharerRoom({ shareLabel: 'Display 2', shareType: 'monitor' })
      const callStore = useCallStore()

      callStore.room = localShare.room as never
      callStore.screenShareEnabled = true
      callStore.ingestScreenAnnotationPacket(
        new TextEncoder().encode(JSON.stringify({
          version: 1,
          kind: 'session',
          active: true,
          sharerIdentity: 'user-a',
          sharerPlatform: 'tauri',
          shareType: 'monitor',
          shareLabel: 'Display 1',
          sentAtMs: Date.now(),
        })),
        'user-a',
      )
      await flushAsync()

      invokeNative.mockClear()
      const accepted = callStore.ingestScreenAnnotationPacket(
        new TextEncoder().encode(JSON.stringify({
          version: 1,
          kind: 'segment',
          shareTrackSid: 'stale-track-sid',
          senderIdentity: 'user-b',
          strokeId: 'stroke-2',
          seq: 0,
          from: { x: 0.1, y: 0.1 },
          to: { x: 0.5, y: 0.5 },
          sentAtMs: Date.now(),
        })),
        'user-b',
      )
      await vi.advanceTimersByTimeAsync(40)
      await flushAsync()

      expect(accepted).toBe(true)
      expect(invokeNative).not.toHaveBeenCalledWith('annotation_overlay_show', expect.anything())
      expect(invokeNative).toHaveBeenCalledWith('annotation_overlay_push_segments', expect.objectContaining({
        overlayLabel: 'annotation_overlay',
      }))
      const pushCall = invokeNative.mock.calls.find(([command]) => command === 'annotation_overlay_push_segments')
      const pushedSegments = JSON.parse(pushCall?.[1]?.segmentsJson ?? '[]') as Array<Record<string, unknown>>
      expect(pushedSegments).toHaveLength(1)
      expect(pushedSegments[0]?.senderIdentity).toBe('user-b')
      expect(pushedSegments[0]?.color).toBe(resolveScreenAnnotationStrokeColor('user-b'))

      callStore.ingestScreenAnnotationPacket(buildInactiveSessionPacket(), 'user-a')
      await flushAsync()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not re-show an unchanged overlay during monitor polling', async () => {
    vi.useFakeTimers()
    try {
      const { invokeNative } = createTauriPlatform()
      const localShare = createLocalSharerRoom({ shareLabel: 'Display 1', shareType: 'monitor' })
      const callStore = useCallStore()

      callStore.room = localShare.room as never
      callStore.screenShareEnabled = true
      callStore.ingestScreenAnnotationPacket(
        new TextEncoder().encode(JSON.stringify({
          version: 1,
          kind: 'session',
          active: true,
          sharerIdentity: 'user-a',
          sharerPlatform: 'tauri',
          shareType: 'monitor',
          shareLabel: 'Display 1',
          sentAtMs: Date.now(),
        })),
        'user-a',
      )
      await flushAsync()

      invokeNative.mockClear()
      await vi.advanceTimersByTimeAsync(1_600)
      await flushAsync()

      expect(invokeNative).not.toHaveBeenCalled()

      callStore.ingestScreenAnnotationPacket(buildInactiveSessionPacket(), 'user-a')
      await flushAsync()
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds queued native segments and flushes them in fixed-size batches', async () => {
    vi.useFakeTimers()
    try {
      const { invokeNative } = createTauriPlatform()
      const localShare = createLocalSharerRoom({ shareLabel: 'Display 1', shareType: 'monitor' })
      const callStore = useCallStore()

      callStore.room = localShare.room as never
      callStore.screenShareEnabled = true
      callStore.ingestScreenAnnotationPacket(
        new TextEncoder().encode(JSON.stringify({
          version: 1,
          kind: 'session',
          active: true,
          sharerIdentity: 'user-a',
          sharerPlatform: 'tauri',
          shareType: 'monitor',
          shareLabel: 'Display 1',
          sentAtMs: Date.now(),
        })),
        'user-a',
      )
      await flushAsync()

      invokeNative.mockClear()
      for (let seq = 0; seq < 300; seq += 1) {
        callStore.ingestScreenAnnotationPacket(buildSegmentPacket(seq), 'user-b')
      }
      for (let batch = 0; batch < 4; batch += 1) {
        await vi.advanceTimersByTimeAsync(40)
        await flushAsync()
      }

      const pushCalls = invokeNative.mock.calls.filter(([command]) => command === 'annotation_overlay_push_segments')
      expect(pushCalls).toHaveLength(4)
      const pushedBatches = pushCalls.map(([, args]) => JSON.parse(args?.segmentsJson ?? '[]') as Array<{ seq: number }>)
      expect(pushedBatches.every(batch => batch.length <= 64)).toBe(true)
      const pushedSegments = pushedBatches.flat()
      expect(pushedSegments).toHaveLength(256)
      expect(pushedSegments[0]?.seq).toBe(44)
      expect(pushedSegments[pushedSegments.length - 1]?.seq).toBe(299)
      expect(invokeNative).not.toHaveBeenCalledWith('annotation_overlay_show', expect.anything())

      callStore.ingestScreenAnnotationPacket(buildInactiveSessionPacket(), 'user-a')
      await flushAsync()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops queued native batches when the annotation session ends before they flush', async () => {
    vi.useFakeTimers()
    try {
      const { invokeNative } = createTauriPlatform()
      const localShare = createLocalSharerRoom({ shareLabel: 'Display 1', shareType: 'monitor' })
      const callStore = useCallStore()

      callStore.room = localShare.room as never
      callStore.screenShareEnabled = true
      callStore.ingestScreenAnnotationPacket(
        new TextEncoder().encode(JSON.stringify({
          version: 1,
          kind: 'session',
          active: true,
          sharerIdentity: 'user-a',
          sharerPlatform: 'tauri',
          shareType: 'monitor',
          shareLabel: 'Display 1',
          sentAtMs: Date.now(),
        })),
        'user-a',
      )
      await flushAsync()

      invokeNative.mockClear()
      callStore.ingestScreenAnnotationPacket(buildSegmentPacket(0), 'user-b')
      callStore.ingestScreenAnnotationPacket(buildInactiveSessionPacket(), 'user-a')
      await vi.advanceTimersByTimeAsync(100)
      await flushAsync()

      expect(invokeNative).not.toHaveBeenCalledWith('annotation_overlay_push_segments', expect.anything())
      expect(invokeNative).toHaveBeenCalledWith('annotation_overlay_clear', { overlayLabel: 'annotation_overlay' })
      expect(invokeNative).toHaveBeenCalledWith('annotation_overlay_hide', { overlayLabel: 'annotation_overlay' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('reuses one overlay across monitor switches and clears it when the session stops', async () => {
    vi.useFakeTimers()
    try {
      const { invokeNative } = createTauriPlatform()
      const localShare = createLocalSharerRoom({ shareLabel: 'Display 1', shareType: 'monitor' })
      const callStore = useCallStore()

      callStore.room = localShare.room as never
      callStore.screenShareEnabled = true
      callStore.ingestScreenAnnotationPacket(
        new TextEncoder().encode(JSON.stringify({
          version: 1,
          kind: 'session',
          active: true,
          sharerIdentity: 'user-a',
          sharerPlatform: 'tauri',
          shareType: 'monitor',
          shareLabel: 'Display 1',
          sentAtMs: Date.now(),
        })),
        'user-a',
      )
      await flushAsync()

      invokeNative.mockClear()
      localShare.setShareLabel('Display 2')
      await vi.advanceTimersByTimeAsync(600)
      await flushAsync()

      expect(invokeNative).toHaveBeenCalledWith('annotation_overlay_show', expect.objectContaining({
        overlayLabel: 'annotation_overlay',
        shareLabel: 'Display 2',
      }))
      expect(invokeNative).toHaveBeenCalledWith('annotation_overlay_clear', { overlayLabel: 'annotation_overlay' })
      expect(invokeNative).not.toHaveBeenCalledWith('annotation_overlay_hide', expect.anything())

      invokeNative.mockClear()
      callStore.ingestScreenAnnotationPacket(buildInactiveSessionPacket(), 'user-a')
      await flushAsync()

      expect(invokeNative).toHaveBeenCalledWith('annotation_overlay_clear', { overlayLabel: 'annotation_overlay' })
      expect(invokeNative).toHaveBeenCalledWith('annotation_overlay_hide', { overlayLabel: 'annotation_overlay' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears native overlays when the sharer switches from monitor to window sharing', async () => {
    vi.useFakeTimers()
    try {
      const { invokeNative } = createTauriPlatform()
      const localShare = createLocalSharerRoom({ shareLabel: 'Display 1', shareType: 'monitor' })
      const callStore = useCallStore()

      callStore.room = localShare.room as never
      callStore.screenShareEnabled = true
      callStore.ingestScreenAnnotationPacket(
        new TextEncoder().encode(JSON.stringify({
          version: 1,
          kind: 'session',
          active: true,
          sharerIdentity: 'user-a',
          sharerPlatform: 'tauri',
          shareType: 'monitor',
          shareLabel: 'Display 1',
          sentAtMs: Date.now(),
        })),
        'user-a',
      )
      await flushAsync()

      invokeNative.mockClear()
      localShare.setShareType('window')
      localShare.setShareLabel('Code Window')

      await vi.advanceTimersByTimeAsync(600)
      await flushAsync()

      expect(invokeNative).toHaveBeenCalledWith('annotation_overlay_clear', { overlayLabel: 'annotation_overlay' })
      expect(invokeNative).toHaveBeenCalledWith('annotation_overlay_hide', { overlayLabel: 'annotation_overlay' })
      expect(localShare.publishData).toHaveBeenCalled()
      const lastPublishCall = localShare.publishData.mock.calls[localShare.publishData.mock.calls.length - 1]
      const payload = JSON.parse(new TextDecoder().decode(lastPublishCall?.[0]))
      expect(payload).toEqual(expect.objectContaining({
        kind: 'session',
        shareType: 'window',
        shareLabel: 'Code Window',
      }))

      callStore.ingestScreenAnnotationPacket(buildInactiveSessionPacket(), 'user-a')
      await flushAsync()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('callStore remote screen share receive toggle', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  function createRemoteShareRoom() {
    const remoteAudioPublication = {
      trackSid: 'remote-audio-track',
      source: Track.Source.Microphone,
      isSubscribed: true,
      setSubscribed: vi.fn(),
    }
    const remoteCameraPublication = {
      trackSid: 'remote-camera-track',
      source: Track.Source.Camera,
      isSubscribed: true,
      setSubscribed: vi.fn(),
    }
    const remoteScreenPublication = {
      trackSid: 'remote-screen-track',
      source: Track.Source.ScreenShare,
      isSubscribed: true,
      setSubscribed: vi.fn(),
    }

    return {
      remoteAudioPublication,
      remoteCameraPublication,
      remoteScreenPublication,
      room: {
        localParticipant: {
          identity: 'user-a',
          videoTrackPublications: new Map(),
          audioTrackPublications: new Map(),
        },
        remoteParticipants: new Map([
          ['remote-sid', {
            sid: 'remote-sid',
            identity: 'user-b',
            audioTrackPublications: new Map([['mic', remoteAudioPublication]]),
            videoTrackPublications: new Map([
              ['camera', remoteCameraPublication],
              ['screen', remoteScreenPublication],
            ]),
          }],
        ]),
      },
    }
  }

  it('unsubscribes only the remote screen share for the local viewer and can resume it', () => {
    const callStore = useCallStore()
    const remoteShare = createRemoteShareRoom()

    callStore.room = remoteShare.room as never

    callStore.stopRemoteScreenShareForMe()

    expect(callStore.remoteScreenShareReceiveEnabled).toBe(false)
    expect(remoteShare.remoteScreenPublication.setSubscribed).toHaveBeenCalledWith(false)
    expect(remoteShare.remoteAudioPublication.setSubscribed).not.toHaveBeenCalled()
    expect(remoteShare.remoteCameraPublication.setSubscribed).not.toHaveBeenCalled()

    remoteShare.remoteScreenPublication.isSubscribed = false
    callStore.startRemoteScreenShareForMe()

    expect(callStore.remoteScreenShareReceiveEnabled).toBe(true)
    expect(remoteShare.remoteScreenPublication.setSubscribed).toHaveBeenLastCalledWith(true)
  })

  it('resets incoming remote screen share receive to enabled on leave and runtime reset', async () => {
    const callStore = useCallStore()

    callStore.remoteScreenShareReceiveEnabled = false
    await callStore.leaveCall()
    expect(callStore.remoteScreenShareReceiveEnabled).toBe(true)

    callStore.remoteScreenShareReceiveEnabled = false
    await callStore.resetRuntimeState()
    expect(callStore.remoteScreenShareReceiveEnabled).toBe(true)
  })

  it('keeps later remote screen publications blocked while still syncing other remote media', () => {
    const callStore = useCallStore()
    const firstRoom = createRemoteShareRoom()

    callStore.room = firstRoom.room as never
    callStore.stopRemoteScreenShareForMe()
    expect(callStore.remoteScreenShareReceiveEnabled).toBe(false)

    const remoteAudioPublication = {
      trackSid: 'remote-audio-track-b',
      source: Track.Source.Microphone,
      isSubscribed: false,
      setSubscribed: vi.fn(),
    }
    const remoteCameraPublication = {
      trackSid: 'remote-camera-track-b',
      source: Track.Source.Camera,
      isSubscribed: false,
      setSubscribed: vi.fn(),
    }
    const remoteScreenPublication = {
      trackSid: 'remote-screen-track-b',
      source: Track.Source.ScreenShare,
      isSubscribed: false,
      setSubscribed: vi.fn(),
    }

    callStore.room = {
      localParticipant: {
        identity: 'user-a',
        videoTrackPublications: new Map(),
        audioTrackPublications: new Map(),
      },
      remoteParticipants: new Map([
        ['remote-sid-b', {
          sid: 'remote-sid-b',
          identity: 'user-c',
          audioTrackPublications: new Map([['mic', remoteAudioPublication]]),
          videoTrackPublications: new Map([
            ['camera', remoteCameraPublication],
            ['screen', remoteScreenPublication],
          ]),
        }],
      ]),
    } as never

    callStore.stopRemoteScreenShareForMe()

    expect(remoteAudioPublication.setSubscribed).toHaveBeenCalledWith(true)
    expect(remoteCameraPublication.setSubscribed).toHaveBeenCalledWith(true)
    expect(remoteScreenPublication.setSubscribed).not.toHaveBeenCalled()
  })
})
