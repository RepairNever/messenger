import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useCallStore } from '@/stores/call'
import { useWsStore } from '@/stores/ws'
import { RoomEvent } from 'livekit-client'
import { loadAudioPrefs, saveAudioPrefs } from '@/services/storage/audioPrefsStorage'

const mock = vi.hoisted(() => ({
  rooms: [] as any[],
  contexts: [] as any[],
  connect: null as Promise<void> | null,
  startAudio: null as Promise<void> | null,
  microphone: null as Promise<void> | null,
  processing: null as Promise<void> | null,
  worklet: null as Promise<void> | null,
  disconnect: null as Promise<void> | null,
}))

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

vi.mock('@/platform', () => ({ getPlatformOrNull: () => null }))
vi.mock('@/platform/runtime', () => ({ getRuntimePlatformType: () => 'pwa', isTauriRuntime: () => false }))
vi.mock('@/services/sound', () => ({ useNotificationSoundEngine: () => ({ playCallMemberJoined: vi.fn(), playCallMemberLeft: vi.fn(), playCallHandRaised: vi.fn() }) }))
vi.mock('livekit-client', async importOriginal => {
  const actual = await importOriginal<any>()
  const makeTrack = () => ({ kind: 'audio', readyState: 'live', enabled: true, stop: vi.fn(function (this: any) { this.readyState = 'ended' }), getSettings: () => ({}) })
  return { ...actual, Room: class {
    name = 'audit-room'
    handlers = new Map<string, Function>()
    remoteParticipants = new Map()
    canPlaybackAudio = true
    raw = makeTrack()
    audioTrack: any
    localParticipant: any
    constructor() {
      mock.rooms.push(this)
      const publication: any = { source: actual.Track.Source.Microphone, kind: 'audio', trackSid: 'mic' }
      this.audioTrack = {
        kind: 'audio', _mediaStreamTrack: this.raw,
        get mediaStreamTrack() { return this._mediaStreamTrack },
        replaceTrack: vi.fn(async (track: any) => { await mock.processing; this.audioTrack._mediaStreamTrack = track }),
        stop: vi.fn(() => this.audioTrack._mediaStreamTrack.stop()),
      }
      publication.track = this.audioTrack
      this.localParticipant = {
        identity: 'self', sid: 'self', isLocal: true,
        videoTrackPublications: new Map(), audioTrackPublications: new Map(), trackPublications: new Map(),
        setMicrophoneEnabled: vi.fn(async (enabled: boolean) => {
          if (enabled) {
            await mock.microphone;
            this.localParticipant.audioTrackPublications.set('mic', publication)
            this.localParticipant.trackPublications.set('mic', publication)
          }
        }),
        setCameraEnabled: vi.fn(async () => {}), setScreenShareEnabled: vi.fn(async () => {}),
        getTrackPublication: (source: string) => source === actual.Track.Source.Microphone ? this.localParticipant.audioTrackPublications.get('mic') : undefined,
        unpublishTrack: vi.fn(async () => {}),
      }
    }
    on(event: string, cb: Function) { this.handlers.set(event, cb); return this }
    async connect() {
      try {
        await mock.connect
        this.handlers.get(actual.RoomEvent.Connected)?.()
      } catch (err) {
        this.handlers.get(actual.RoomEvent.Disconnected)?.()
        throw err
      }
    }
    async startAudio() { await mock.startAudio }
    async disconnect() {
      await mock.disconnect
      // Model SDK disconnect: it stops the current published track, then emits Disconnected.
      for (const publication of this.localParticipant.trackPublications.values()) publication.track.stop()
      this.handlers.get(actual.RoomEvent.Disconnected)?.()
    }
  } }
})

const originalMediaDevices = navigator.mediaDevices
let onCreate: any, onJoin: any
beforeEach(() => {
  setActivePinia(createPinia())
  mock.rooms.length = 0; mock.contexts.length = 0
  mock.connect = mock.startAudio = mock.microphone = mock.processing = mock.worklet = mock.disconnect = null
  vi.spyOn(console, 'info').mockImplementation(() => {})
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn() } })
  vi.stubGlobal('MediaStream', class { constructor(public tracks: any[]) {} getAudioTracks() { return this.tracks } })
  vi.stubGlobal('GainNode', class { gain = { value: 1 }; connect() {} })
  vi.stubGlobal('AudioContext', class {
    close = vi.fn(async () => {})
    audioWorklet = { addModule: vi.fn(async () => { await mock.worklet }) }
    constructor() { mock.contexts.push(this) }
    createMediaStreamSource() { return { connect: vi.fn() } }
    createMediaStreamDestination() { return { stream: { getAudioTracks: () => [{ kind: 'audio', readyState: 'live', stop: vi.fn(), getSettings: () => ({}) }] } } }
  })
  saveAudioPrefs({ ...loadAudioPrefs(), rnnoiseEnabled: false, autoGainControl: false, microphoneGain: 200, muteMicOnJoinCall: false })
  const ws = useWsStore()
  vi.spyOn(ws, 'onCreateCallResponse').mockImplementation(cb => { onCreate = cb })
  vi.spyOn(ws, 'onJoinCallTokenResponse').mockImplementation(cb => { onJoin = cb })
  vi.spyOn(ws, 'sendCreateCall').mockReturnValue('create-1')
  vi.spyOn(ws, 'sendJoinCallToken').mockReturnValue('join-1')
  useCallStore().registerWsHandlers()
})
afterEach(async () => {
  await useCallStore().resetRuntimeState()
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: originalMediaDevices })
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
})
const token = () => onJoin({ livekitUrl: 'wss://call.test', livekitToken: 'token', livekitRoom: 'audit-room', callId: 'call-1', raisedHands: [] }, 'join-1')

it('Leave before create response must prevent a later join and microphone publication', async () => {
  const call = useCallStore()
  const start = call.startOrJoinCall({ conversationId: 'channel-1', kind: 'channel', visibility: 'public' })
  await call.leaveCall()
  onCreate({ callId: 'call-1', conversationId: 'channel-1', status: 1 }, 'create-1')
  expect(useWsStore().sendJoinCallToken).not.toHaveBeenCalled()
  await start
  expect(call.connected).toBe(false)
  expect(call.micEnabled).toBe(false)
})

it('Leave while waiting for a token must settle the join and clear connecting', async () => {
  vi.useFakeTimers()
  const call = useCallStore()
  let settled = false
  void call.startOrJoinCall({ conversationId: 'channel-1', kind: 'channel', visibility: 'public', joinExistingOnly: true }).then(() => { settled = true }, () => { settled = true })
  await call.leaveCall()
  token()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(settled).toBe(true)
  expect(call.connecting).toBe(false)
})

it('An SDK disconnect must stop the raw microphone and close its processing context', async () => {
  const call = useCallStore()
  const start = call.startOrJoinCall({ conversationId: 'channel-1', kind: 'channel', visibility: 'public', joinExistingOnly: true })
  token()
  await start
  const room = mock.rooms[0]
  expect(room.audioTrack.replaceTrack).toHaveBeenCalled()
  await room.disconnect()
  expect(call.connected).toBe(false)
  expect(room.raw.stop).toHaveBeenCalled()
  expect(mock.contexts[0].close).toHaveBeenCalled()
})

it.each([false, true])('reset cancels a pending join (existing call: %s)', async joinExistingOnly => {
  const call = useCallStore()
  const start = call.startOrJoinCall({ conversationId: 'channel-1', kind: 'channel', visibility: 'public', joinExistingOnly })
  await call.resetRuntimeState()
  onCreate({ callId: 'call-1', conversationId: 'channel-1', status: 1 }, 'create-1')
  token()
  await start
  expect(call.connecting).toBe(false)
  expect(call.connected).toBe(false)
  expect(mock.rooms).toHaveLength(0)
  expect(call.errorMessage).toBe('')
})

it('ignores an obsolete token while a newer request is pending', async () => {
  const call = useCallStore()
  const first = call.startOrJoinCall({ conversationId: 'channel-1', kind: 'channel', visibility: 'public', joinExistingOnly: true })
  vi.mocked(useWsStore().sendJoinCallToken).mockReturnValue('join-2')
  const second = call.startOrJoinCall({ conversationId: 'channel-2', kind: 'channel', visibility: 'private', joinExistingOnly: true })
  token()
  await first
  expect(call.connecting).toBe(true)
  expect(mock.rooms).toHaveLength(0)
  onJoin({ livekitUrl: 'wss://call.test', livekitToken: 'token', livekitRoom: 'room-2', callId: 'call-2', raisedHands: [] }, 'join-2')
  await second
  expect(call.connected).toBe(true)
  expect(call.activeCallId).toBe('call-2')
})

it.each(['connect', 'startAudio'] as const)('Leave cancels during %s and ignores its late completion', async stage => {
  const gate = deferred()
  mock[stage] = gate.promise
  const call = useCallStore()
  const start = call.startOrJoinCall({ conversationId: 'channel-1', kind: 'channel', visibility: 'public', joinExistingOnly: true })
  token()
  await vi.waitFor(() => expect(mock.rooms).toHaveLength(1))
  await call.leaveCall()
  await start
  gate.resolve()
  await vi.waitFor(() => expect(call.connecting).toBe(false))
  expect(call.connected).toBe(false)
  expect(call.room).toBeNull()
  expect(mock.rooms[0].localParticipant.setMicrophoneEnabled).not.toHaveBeenCalledWith(true, expect.anything())
  expect(call.errorMessage).toBe('')
})

it('stops microphone capture acquired after Leave without changing a newer call', async () => {
  const gate = deferred()
  mock.microphone = gate.promise
  const call = useCallStore()
  const first = call.startOrJoinCall({ conversationId: 'channel-1', kind: 'channel', visibility: 'public', joinExistingOnly: true })
  token()
  await vi.waitFor(() => expect(mock.rooms[0]?.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true, expect.anything()))
  const oldRoom = mock.rooms[0]
  await call.leaveCall()
  await first
  mock.microphone = null
  const second = call.startOrJoinCall({ conversationId: 'channel-2', kind: 'channel', visibility: 'private', joinExistingOnly: true })
  token()
  await second
  const newRoom = call.room
  gate.resolve()
  await vi.waitFor(() => expect(oldRoom.raw.stop).toHaveBeenCalled())
  expect(call.room).toBe(newRoom)
  expect(call.connected).toBe(true)
  expect(call.micEnabled).toBe(true)
  expect(mock.rooms[1].raw.stop).not.toHaveBeenCalled()
})

it.each(['microphone', 'processing'] as const)('cancels pending %s when another join starts waiting for its token', async stage => {
  const gate = deferred()
  mock[stage] = gate.promise
  const call = useCallStore()
  const first = call.startOrJoinCall({ conversationId: 'channel-1', kind: 'channel', visibility: 'public', joinExistingOnly: true })
  token()
  await vi.waitFor(() => {
    if (stage === 'microphone') {
      expect(mock.rooms[0]?.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true, expect.anything())
    } else {
      expect(mock.rooms[0]?.audioTrack.replaceTrack).toHaveBeenCalled()
    }
  })
  const oldRoom = mock.rooms[0]
  vi.mocked(useWsStore().sendJoinCallToken).mockReturnValue('join-2')
  const second = call.startOrJoinCall({ conversationId: 'channel-2', kind: 'channel', visibility: 'private', joinExistingOnly: true })
  await first
  expect(call.room).toBeNull()
  gate.resolve()
  await vi.waitFor(() => expect(oldRoom.raw.stop).toHaveBeenCalled())
  oldRoom.handlers.get(RoomEvent.Disconnected)?.()
  expect(call.connecting).toBe(true)
  if (stage === 'microphone') expect(oldRoom.audioTrack.replaceTrack).not.toHaveBeenCalled()
  else expect(mock.contexts[0].close).toHaveBeenCalledTimes(1)
  mock[stage] = null
  onJoin({ livekitUrl: 'wss://call.test', livekitToken: 'token', livekitRoom: 'room-2', callId: 'call-2', raisedHands: [] }, 'join-2')
  await second
  expect(call.activeCallId).toBe('call-2')
  expect(call.connected).toBe(true)
  expect(call.micEnabled).toBe(true)
  expect(mock.rooms[1].raw.stop).not.toHaveBeenCalled()
})

it('cleans processing before a pending replacement completes and ignores late old-room events', async () => {
  const gate = deferred()
  mock.processing = gate.promise
  const call = useCallStore()
  const first = call.startOrJoinCall({ conversationId: 'channel-1', kind: 'channel', visibility: 'public', joinExistingOnly: true })
  const failedJoin = expect(first).rejects.toThrow('Call disconnected while joining')
  token()
  await vi.waitFor(() => expect(mock.rooms[0]?.audioTrack.replaceTrack).toHaveBeenCalled())
  const oldRoom = mock.rooms[0]
  await oldRoom.disconnect()
  await failedJoin
  expect(oldRoom.raw.stop).toHaveBeenCalled()
  expect(mock.contexts[0].close).toHaveBeenCalledTimes(1)
  mock.processing = null
  const second = call.startOrJoinCall({ conversationId: 'channel-2', kind: 'channel', visibility: 'private', joinExistingOnly: true })
  token()
  await second
  const newRoom = call.room
  gate.resolve()
  oldRoom.handlers.get(RoomEvent.Disconnected)?.()
  oldRoom.handlers.get(RoomEvent.ParticipantDisconnected)?.({ sid: 'old-peer' })
  await Promise.resolve()
  expect(call.room).toBe(newRoom)
  expect(call.connected).toBe(true)
  expect(call.micEnabled).toBe(true)
  expect(mock.contexts[1].close).not.toHaveBeenCalled()
})

it('reports a connection failure even when the SDK also emits Disconnected', async () => {
  const gate = deferred()
  mock.connect = gate.promise
  const call = useCallStore()
  const start = call.startOrJoinCall({ conversationId: 'channel-1', kind: 'channel', visibility: 'public', joinExistingOnly: true })
  const failedJoin = expect(start).rejects.toThrow('Call disconnected while joining')
  token()
  await vi.waitFor(() => expect(mock.rooms).toHaveLength(1))
  gate.reject(new Error('Connection failed'))
  await failedJoin
  expect(call.errorMessage).toBe('Call disconnected while joining')
  expect(call.connecting).toBe(false)
  expect(call.connected).toBe(false)
  expect(call.room).toBeNull()
})

it('releases capture while an RNNoise worklet is loading and skips late initialization', async () => {
  const gate = deferred()
  mock.worklet = gate.promise
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '' })))
  vi.stubGlobal('URL', class extends URL { static createObjectURL() { return 'blob:rnnoise-test' } })
  saveAudioPrefs({ ...loadAudioPrefs(), rnnoiseEnabled: true })
  const call = useCallStore()
  const start = call.startOrJoinCall({ conversationId: 'channel-1', kind: 'channel', visibility: 'public', joinExistingOnly: true })
  token()
  await vi.waitFor(() => expect(mock.contexts[0]?.audioWorklet.addModule).toHaveBeenCalled())
  await call.leaveCall()
  await start
  expect(mock.rooms[0].raw.stop).toHaveBeenCalled()
  expect(mock.contexts[0].close).toHaveBeenCalledTimes(1)
  gate.resolve()
  await Promise.resolve()
  expect(mock.rooms[0].audioTrack.replaceTrack).not.toHaveBeenCalled()
  expect(call.micEnabled).toBe(false)
  expect(call.errorMessage).toBe('')
})

it('keeps the original microphone usable if audio processing fails', async () => {
  const gate = deferred()
  mock.processing = gate.promise
  const call = useCallStore()
  const start = call.startOrJoinCall({ conversationId: 'channel-1', kind: 'channel', visibility: 'public', joinExistingOnly: true })
  token()
  await vi.waitFor(() => expect(mock.rooms[0]?.audioTrack.replaceTrack).toHaveBeenCalled())
  gate.reject(new Error('Unable to replace audio track'))
  await start
  expect(call.connected).toBe(true)
  expect(call.micEnabled).toBe(true)
  expect(mock.rooms[0].raw.stop).not.toHaveBeenCalled()
  expect(mock.contexts[0].close).toHaveBeenCalledTimes(1)
  await mock.rooms[0].disconnect()
  expect(mock.rooms[0].raw.stop).toHaveBeenCalled()
})

it('waits for an old room to finish teardown before connecting a replacement', async () => {
  const call = useCallStore()
  const first = call.startOrJoinCall({ conversationId: 'channel-1', kind: 'channel', visibility: 'public', joinExistingOnly: true })
  token()
  await first
  const gate = deferred()
  mock.disconnect = gate.promise
  const leave = call.leaveCall()
  const second = call.startOrJoinCall({ conversationId: 'channel-2', kind: 'channel', visibility: 'private', joinExistingOnly: true })
  token()
  await Promise.resolve()
  expect(mock.rooms).toHaveLength(1)
  gate.resolve()
  await Promise.all([leave, second])
  expect(mock.rooms).toHaveLength(2)
  expect(call.connected).toBe(true)
  expect(call.activeConversationId).toBe('channel-2')
})

