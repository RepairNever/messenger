import { defineStore } from 'pinia'
import { computed, ref, shallowRef, watch } from 'vue'
import { ConversationType, ErrorCode } from '@/shared/proto/packets_pb'
import { Room, RoomEvent, Track, ScreenSharePresets, type AudioCaptureOptions, type LocalVideoTrack, type LocalAudioTrack, type TrackPublishOptions, type ScreenShareCaptureOptions } from 'livekit-client'
import { useWsStore } from '@/stores/ws'
import { useChatStore, type RaisedHand } from '@/stores/chat'
import { useNotificationSoundEngine } from '@/services/sound'
import { loadAudioPrefs, saveAudioPrefs } from '@/services/storage/audioPrefsStorage'
import { getPlatformOrNull } from '@/platform'
import { getRuntimePlatformType } from '@/platform/runtime'
import { resolveScreenAnnotationStrokeColor } from '@/utils/color'

// RNNoise blob URL is built once per page load and reused across all mute/unmute
// cycles. Fetching + Blob-URL creation is expensive (~network round trip + WASM
// compilation inside the worklet) so we cache the result at module scope.
let rnnoiseBlobUrlPromise: Promise<string> | null = null
let displayCaptureTrackerInstalled = false
const trackedDisplayCaptureTracks = new Set<MediaStreamTrack>()
let captureTeardownSeq = 0
const DISPLAY_CAPTURE_STOP_RETRY_MS = 250
const DISPLAY_CAPTURE_STOP_MAX_RETRIES = 3

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function describeMediaTrack(track: MediaStreamTrack | null | undefined): Record<string, unknown> {
  if (!track) {
    return { exists: false }
  }
  let settings: MediaTrackSettings | undefined
  try {
    settings = track.getSettings()
  } catch {
    settings = undefined
  }
  return {
    exists: true,
    id: track.id,
    kind: track.kind,
    label: track.label,
    enabled: track.enabled,
    muted: track.muted,
    readyState: track.readyState,
    settings,
  }
}

function describeTrackedDisplayCaptureTracks(): Array<Record<string, unknown>> {
  return Array.from(trackedDisplayCaptureTracks).map(track => describeMediaTrack(track))
}

function getTrackMediaVariants(trackLike: unknown): Array<{ role: string; track: MediaStreamTrack }> {
  if (!trackLike || typeof trackLike !== 'object') return []
  const candidate = trackLike as {
    mediaStreamTrack?: MediaStreamTrack | null
    _mediaStreamTrack?: MediaStreamTrack | null
    sender?: { track?: MediaStreamTrack | null } | null
  }
  const variants: Array<{ role: string; track: MediaStreamTrack | null | undefined }> = [
    { role: 'mediaStreamTrack', track: candidate.mediaStreamTrack },
    { role: '_mediaStreamTrack', track: candidate._mediaStreamTrack },
    { role: 'sender.track', track: candidate.sender?.track },
  ]
  const deduped = new Set<MediaStreamTrack>()
  const result: Array<{ role: string; track: MediaStreamTrack }> = []
  for (const item of variants) {
    if (!item.track) continue
    if (deduped.has(item.track)) continue
    deduped.add(item.track)
    result.push({ role: item.role, track: item.track })
  }
  return result
}

function logTrackedDisplayCaptureState(stage: string, extra: Record<string, unknown> = {}) {
  logScreenShare(`tracked display capture tracks (${stage})`, {
    ...extra,
    count: trackedDisplayCaptureTracks.size,
    tracks: describeTrackedDisplayCaptureTracks(),
  })
}

function rememberDisplayCaptureTrack(track: MediaStreamTrack, context: Record<string, unknown> = {}) {
  if (trackedDisplayCaptureTracks.has(track)) {
    return
  }
  trackedDisplayCaptureTracks.add(track)
  logScreenShare('tracked display capture track remembered', {
    ...context,
    track: describeMediaTrack(track),
  })
  const forget = () => {
    logScreenShare('tracked display capture track ended', {
      ...context,
      track: describeMediaTrack(track),
    })
    trackedDisplayCaptureTracks.delete(track)
    track.removeEventListener('ended', forget)
    logTrackedDisplayCaptureState('track-ended', context)
  }
  track.addEventListener('ended', forget, { once: true })
}

function getRnnoiseBlobUrl(): Promise<string> {
  if (!rnnoiseBlobUrlPromise) {
    rnnoiseBlobUrlPromise = (async () => {
      const [rnnoiseJs, processorJs] = await Promise.all([
        fetch('/rnnoise-classic.js').then(r => {
          if (!r.ok) throw new Error(`Failed to fetch rnnoise-classic.js: ${r.status}`)
          return r.text()
        }),
        fetch('/rnnoise-processor.js').then(r => {
          if (!r.ok) throw new Error(`Failed to fetch rnnoise-processor.js: ${r.status}`)
          return r.text()
        }),
      ])
      const blob = new Blob([rnnoiseJs + '\n' + processorJs], { type: 'application/javascript' })
      return URL.createObjectURL(blob)
    })().catch(err => {
      // Reset so the next call retries (e.g. transient network error)
      rnnoiseBlobUrlPromise = null
      throw err
    })
  }
  return rnnoiseBlobUrlPromise
}

function rememberDisplayCaptureStream(stream: MediaStream) {
  logScreenShare('display capture stream received', {
    streamId: stream.id,
    active: stream.active,
    tracks: stream.getTracks().map(track => describeMediaTrack(track)),
  })
  for (const track of stream.getTracks()) {
    rememberDisplayCaptureTrack(track, {
      source: 'getDisplayMedia',
      streamId: stream.id,
    })
  }
  logTrackedDisplayCaptureState('stream-remembered', { streamId: stream.id })
}

function installDisplayCaptureTracker() {
  if (displayCaptureTrackerInstalled) return
  const devices = getMediaDevices() as (MediaDevices & {
    getDisplayMedia?: (constraints?: DisplayMediaStreamOptions) => Promise<MediaStream>
  }) | null
  if (!devices || typeof devices.getDisplayMedia !== 'function') return

  const originalGetDisplayMedia = devices.getDisplayMedia.bind(devices)
  devices.getDisplayMedia = async (constraints?: DisplayMediaStreamOptions) => {
    logScreenShare('getDisplayMedia called', { constraints })
    try {
      const stream = await originalGetDisplayMedia(constraints)
      rememberDisplayCaptureStream(stream)
      return stream
    } catch (err) {
      logScreenShare('getDisplayMedia failed', {
        error: toErrorMessage(err),
      })
      throw err
    }
  }
  displayCaptureTrackerInstalled = true
  logScreenShare('display capture tracker installed')
}

function stopTrackedDisplayCaptureTracks(reason = 'unspecified') {
  logTrackedDisplayCaptureState('stop-start', { reason })
  for (const track of Array.from(trackedDisplayCaptureTracks)) {
    const stopTrack = (attempt: number) => {
      const before = describeMediaTrack(track)
      try {
        track.enabled = false
      } catch {
        // best effort
      }
      try {
        track.stop()
      } catch (err) {
        logScreenShare('tracked display capture track stop failed', {
          reason,
          attempt,
          before,
          error: toErrorMessage(err),
        })
      }
      const after = describeMediaTrack(track)
      const ended = track.readyState === 'ended'
      logScreenShare('tracked display capture track stop requested', {
        reason,
        attempt,
        ended,
        before,
        after,
      })
      if (ended) {
        trackedDisplayCaptureTracks.delete(track)
        return
      }
      if (attempt >= DISPLAY_CAPTURE_STOP_MAX_RETRIES) {
        logScreenShare('tracked display capture track still live after max stop retries', {
          reason,
          attempt,
          track: after,
        })
        trackedDisplayCaptureTracks.delete(track)
        return
      }
      setTimeout(() => {
        if (!trackedDisplayCaptureTracks.has(track)) return
        stopTrack(attempt + 1)
      }, DISPLAY_CAPTURE_STOP_RETRY_MS)
    }
    stopTrack(0)
  }
  logTrackedDisplayCaptureState('stop-end', { reason })
  if (trackedDisplayCaptureTracks.size > 0) {
    setTimeout(() => {
      logTrackedDisplayCaptureState('stop-end-post-retry', { reason })
    }, DISPLAY_CAPTURE_STOP_RETRY_MS * (DISPLAY_CAPTURE_STOP_MAX_RETRIES + 1))
  }
}

const JOIN_TOKEN_TIMEOUT_MS = 8000
const INVITE_CALL_MEMBERS_TIMEOUT_MS = 8000
const JOIN_ROOM_CONNECT_TIMEOUT_MS = 15000
const REMOTE_AUDIO_STATS_INTERVAL_MS = 3000
const EMPTY_CALL_AUTO_CLOSE_MS = 5000
const CALL_DEBUG_STORAGE_KEY = 'debug.calls'
const SCREEN_ANNOTATION_TOPIC = 'screen-annotation.v1'
const CALL_REACTION_TOPIC = 'call-reaction.v1'
const CALL_REACTION_TTL_MS = 4000
const CALL_REACTION_DEDUPE_TTL_MS = CALL_REACTION_TTL_MS + 1000
const SCREEN_ANNOTATION_OVERLAY_LABEL = 'annotation_overlay'
const SCREEN_ANNOTATION_MONITOR_POLL_MS = 500
const SCREEN_ANNOTATION_OVERLAY_BATCH_INTERVAL_MS = 33
const SCREEN_ANNOTATION_OVERLAY_MAX_PENDING_SEGMENTS = 256
const SCREEN_ANNOTATION_OVERLAY_MAX_BATCH_SEGMENTS = 64
const SCREEN_ANNOTATION_OVERLAY_SHOW_RETRY_MS = 1000

export interface ScreenAnnotationPoint {
  x: number
  y: number
}

export type ScreenAnnotationSharerPlatform = 'tauri' | 'pwa' | 'unknown'
export type ScreenAnnotationShareType = 'monitor' | 'window' | 'browser' | 'unknown'
export type ScreenAnnotationSessionMode = 'os-overlay' | 'preview-fallback' | 'disabled'

export const CALL_REACTION_EMOJIS = ['👍', '👏', '❤️', '😂', '🎉', '😮'] as const
export type CallReactionEmoji = (typeof CALL_REACTION_EMOJIS)[number]

export interface CallReactionPacketV1 {
  version: 1
  kind: 'reaction'
  emoji: CallReactionEmoji
  senderSessionId: string
  sequence: number
  reactionId: string
  sentAtMs: number
}

export interface ActiveCallReaction extends CallReactionPacketV1 {
  expiresAtMs: number
}

export interface ScreenAnnotationSessionState {
  version: 1
  kind: 'session'
  active: boolean
  sharerIdentity: string
  sharerPlatform: ScreenAnnotationSharerPlatform
  shareType: ScreenAnnotationShareType
  shareLabel: string
  sentAtMs: number
}

export interface ScreenAnnotationSegmentV1 {
  version: 1
  kind: 'segment'
  shareTrackSid: string
  senderIdentity: string
  strokeId: string
  seq: number
  from: ScreenAnnotationPoint
  to: ScreenAnnotationPoint
  sentAtMs: number
}

export interface ScreenAnnotationEvent extends ScreenAnnotationSegmentV1 {
  receivedAtMs: number
}

interface ScreenAnnotationOverlaySegment extends ScreenAnnotationEvent {
  color: string
}

type ScreenAnnotationPacketV1 = ScreenAnnotationSessionState | ScreenAnnotationSegmentV1
type ScreenAnnotationListener = (event: ScreenAnnotationEvent) => void
type LocalShareCaptureContext = {
  shareType: ScreenAnnotationShareType
  shareLabel: string
  overlayTargetKey: string
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

function normalizeLiveKitUrl(rawUrl: string): string {
  const urlValue = rawUrl.trim()
  if (!urlValue) {
    throw new Error('Join token response has empty livekitUrl')
  }

  let parsed: URL
  try {
    parsed = new URL(urlValue)
  } catch (err) {
    throw new Error('Join token response has invalid livekitUrl')
  }

  if (window.location.protocol === 'https:' && parsed.protocol === 'ws:') {
    parsed = new URL(parsed.href.replace(/^ws:/, 'wss:'))
  }

  if (parsed.protocol === 'http:') {
    parsed = new URL(parsed.href.replace(/^http:/, 'ws:'))
  }

  if (parsed.protocol === 'https:') {
    parsed = new URL(parsed.href.replace(/^https:/, 'wss:'))
  }

  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error('Join token response uses unsupported livekitUrl protocol')
  }

  if (isLoopbackHost(parsed.hostname) && !isLoopbackHost(window.location.hostname)) {
    const fallbackHost = window.location.hostname
    const fallbackPort = parsed.port || '7880'
    const fallbackProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const normalized = new URL(parsed.pathname || '/', `${fallbackProtocol}//${fallbackHost}:${fallbackPort}`)
    normalized.hash = parsed.hash
    normalized.search = parsed.search
    return normalized.toString()
  }

  return parsed.toString()
}

function toConversationType(kind: 'dm' | 'channel', visibility: 'public' | 'private' | 'dm'): ConversationType {
  if (kind === 'dm') return ConversationType.DM
  if (visibility === 'private') return ConversationType.CHANNEL_PRIVATE
  return ConversationType.CHANNEL_PUBLIC
}

function getMediaDevices(): MediaDevices | null {
  if (typeof globalThis === 'undefined') return null
  const nav = globalThis.navigator as Navigator | undefined
  return nav && nav.mediaDevices ? nav.mediaDevices : null
}

function hasGetUserMedia(): boolean {
  const devices = getMediaDevices()
  return Boolean(devices && typeof devices.getUserMedia === 'function')
}

function mediaUnavailableMessage(): string {
  return 'Media devices are not available in this browser. Join without microphone/camera or switch to HTTPS.'
}

function isCallDebugEnabled(): boolean {
  const envEnabled = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_CALL_DEBUG === '1'
  if (envEnabled) return true
  try {
    return globalThis.localStorage?.getItem(CALL_DEBUG_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function callDebug(message: string, payload?: unknown) {
  if (!isCallDebugEnabled()) return
  if (typeof payload === 'undefined') {
    console.info(`[call-debug] ${message}`)
    return
  }
  console.info(`[call-debug] ${message}`, payload)
}

function isScreenSource(source: unknown): boolean {
  return String(source ?? '').toLowerCase().includes('screen')
}

function isFinitePoint(value: unknown): value is ScreenAnnotationPoint {
  if (!value || typeof value !== 'object') return false
  const point = value as { x?: unknown; y?: unknown }
  if (typeof point.x !== 'number' || !Number.isFinite(point.x)) return false
  if (typeof point.y !== 'number' || !Number.isFinite(point.y)) return false
  return point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1
}

function normalizeShareType(value: unknown): ScreenAnnotationShareType {
  const normalized = String(value ?? '').toLowerCase()
  if (normalized === 'monitor') return 'monitor'
  if (normalized === 'window') return 'window'
  if (normalized === 'browser') return 'browser'
  return 'unknown'
}

function normalizeSharerPlatform(value: unknown): ScreenAnnotationSharerPlatform {
  const normalized = String(value ?? '').toLowerCase()
  if (normalized === 'tauri') return 'tauri'
  if (normalized === 'pwa') return 'pwa'
  return 'unknown'
}

function deriveAnnotationSessionMode(session: ScreenAnnotationSessionState | null): ScreenAnnotationSessionMode {
  if (!session?.active) return 'disabled'
  if (session.sharerPlatform !== 'tauri') return 'disabled'
  return session.shareType === 'window' || session.shareType === 'browser'
    ? 'preview-fallback'
    : 'os-overlay'
}

function parseDisplayIndex(shareLabel: string): number | null {
  let digits = ''
  for (const ch of shareLabel) {
    if (/\d/.test(ch)) {
      digits += ch
      continue
    }
    if (digits) break
  }
  if (!digits) return null
  const parsed = Number.parseInt(digits, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) return null
  if (parsed > 20) return null
  return parsed - 1
}

function normalizeOverlayKeyToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function resolveMonitorOverlayTargetKey(shareLabel: string): string {
  const displayIndex = parseDisplayIndex(shareLabel)
  if (displayIndex !== null) {
    return `monitor:${displayIndex}`
  }
  const normalized = normalizeOverlayKeyToken(shareLabel)
  return normalized ? `monitor:${normalized}` : ''
}

function decodeScreenAnnotationPacket(payload: Uint8Array): ScreenAnnotationPacketV1 | null {
  let parsed: unknown
  try {
    const decoded = new TextDecoder().decode(payload)
    parsed = JSON.parse(decoded)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const candidate = parsed as Record<string, unknown>
  if (candidate.version !== 1) return null
  if (candidate.kind === 'session') {
    if (typeof candidate.active !== 'boolean') return null
    if (typeof candidate.sharerIdentity !== 'string') return null
    if (typeof candidate.sentAtMs !== 'number' || !Number.isFinite(candidate.sentAtMs)) return null
    return {
      version: 1,
      kind: 'session',
      active: candidate.active,
      sharerIdentity: candidate.sharerIdentity.trim(),
      sharerPlatform: normalizeSharerPlatform(candidate.sharerPlatform),
      shareType: normalizeShareType(candidate.shareType),
      shareLabel: typeof candidate.shareLabel === 'string' ? candidate.shareLabel : '',
      sentAtMs: candidate.sentAtMs,
    }
  }
  if (candidate.kind !== 'segment') return null
  if (typeof candidate.shareTrackSid !== 'string' || !candidate.shareTrackSid.trim()) return null
  if (typeof candidate.senderIdentity !== 'string' || !candidate.senderIdentity.trim()) return null
  if (typeof candidate.strokeId !== 'string' || !candidate.strokeId.trim()) return null
  if (typeof candidate.seq !== 'number' || !Number.isInteger(candidate.seq) || candidate.seq < 0) return null
  if (typeof candidate.sentAtMs !== 'number' || !Number.isFinite(candidate.sentAtMs)) return null
  if (!isFinitePoint(candidate.from) || !isFinitePoint(candidate.to)) return null

  return {
    version: 1,
    kind: 'segment',
    shareTrackSid: candidate.shareTrackSid,
    senderIdentity: candidate.senderIdentity,
    strokeId: candidate.strokeId,
    seq: candidate.seq,
    from: candidate.from,
    to: candidate.to,
    sentAtMs: candidate.sentAtMs,
  }
}

function isBoundedNonEmptyString(value: unknown, maxLength = 128): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
}

function isCallReactionEmoji(value: unknown): value is CallReactionEmoji {
  return typeof value === 'string' && (CALL_REACTION_EMOJIS as readonly string[]).includes(value)
}

function decodeCallReactionPacket(payload: Uint8Array): CallReactionPacketV1 | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(payload))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null

  const candidate = parsed as Record<string, unknown>
  if (candidate.version !== 1 || candidate.kind !== 'reaction') return null
  if (!isCallReactionEmoji(candidate.emoji)) return null
  if (!isBoundedNonEmptyString(candidate.senderSessionId)) return null
  if (!isBoundedNonEmptyString(candidate.reactionId)) return null
  if (typeof candidate.sequence !== 'number' || !Number.isSafeInteger(candidate.sequence) || candidate.sequence <= 0) return null
  if (typeof candidate.sentAtMs !== 'number' || !Number.isFinite(candidate.sentAtMs) || candidate.sentAtMs < 0) return null

  return {
    version: 1,
    kind: 'reaction',
    emoji: candidate.emoji,
    senderSessionId: candidate.senderSessionId,
    sequence: candidate.sequence,
    reactionId: candidate.reactionId,
    sentAtMs: candidate.sentAtMs,
  }
}

let callReactionNonce = 0

function createCallReactionId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  callReactionNonce += 1
  return `${Date.now().toString(36)}-${callReactionNonce.toString(36)}`
}

function logScreenShare(message: string, payload?: unknown) {
  if (typeof payload === 'undefined') {
    console.info(`[call-screen] ${message}`)
    return
  }
  console.info(`[call-screen] ${message}`, payload)
}

export const useCallStore = defineStore('call', () => {
  installDisplayCaptureTracker()

  const room = shallowRef<Room | null>(null)
  const activeConversationId = ref('')
  const activeConversationKind = ref<'dm' | 'channel'>('channel')
  const activeConversationVisibility = ref<'public' | 'private' | 'dm'>('public')
  const activeCallId = ref('')
  const activeRoomName = ref('')
  const connecting = ref(false)
  const connected = ref(false)
  const minimized = ref(false)
  const micEnabled = ref(false)
  const cameraEnabled = ref(false)
  const screenShareEnabled = ref(false)
  const remoteScreenShareReceiveEnabled = ref(true)
  const remoteParticipantCount = ref(0)
  const mediaVersion = ref(0)
  const annotationSessionState = ref<ScreenAnnotationSessionState | null>(null)
  const reactionsByParticipantId = ref<Record<string, ActiveCallReaction>>({})
  const handActionInFlight = ref(false)

  // True when any remote participant is actively sharing a screen track.
  // Reads mediaVersion to re-evaluate whenever track publications change.
  const remoteScreenShareActive = computed(() => {
    void mediaVersion.value
    const current = room.value
    if (!current) return false
    if (!current.remoteParticipants || typeof current.remoteParticipants.values !== 'function') return false
    for (const participant of current.remoteParticipants.values()) {
      const publications = participant?.videoTrackPublications
      if (!publications || typeof publications.values !== 'function') continue
      for (const pub of publications.values()) {
        if (isScreenSource(pub.source) && !pub.isMuted) return true
      }
    }
    return false
  })
  const activeSpeakerSids = ref<Set<string>>(new Set())
  const playbackBlocked = ref(false)
  const errorMessage = ref('')

  const chatStore = useChatStore()
  const soundEngine = useNotificationSoundEngine()
  const platform = getPlatformOrNull()
  const annotationListeners = new Set<ScreenAnnotationListener>()
  const reactionTimeoutsByParticipantId = new Map<string, ReturnType<typeof setTimeout>>()
  const seenReactionTimeouts = new Map<string, ReturnType<typeof setTimeout>>()
  const reactionSessionId = createCallReactionId()
  let localReactionSequence = 0

  const annotationSessionMode = computed<ScreenAnnotationSessionMode>(() => deriveAnnotationSessionMode(annotationSessionState.value))

  const annotationAvailable = computed(() => annotationSessionMode.value !== 'disabled')

  const annotationDisabledReason = computed(() => {
    if (!annotationSessionState.value?.active) return 'No active screen share'
    if (screenShareEnabled.value) return 'Screen sharer cannot draw'
    if (annotationSessionState.value.sharerPlatform !== 'tauri') {
      return 'Annotation is unavailable: sharer is not on Tauri desktop'
    }
    return ''
  })

  let pendingJoinResolve: ((resp: {
    livekitUrl: string
    livekitToken: string
    livekitRoom: string
    callId: string
    raisedHands: RaisedHand[]
  }) => void) | null = null
  let pendingJoinReject: ((error: Error) => void) | null = null
  let pendingJoinTimer: ReturnType<typeof setTimeout> | null = null
  let pendingJoinRequestId = ''
  let pendingCreateCallResolve: (() => void) | null = null
  let pendingCreateCallReject: ((error: Error) => void) | null = null
  let pendingCreateCallTimer: ReturnType<typeof setTimeout> | null = null
  let pendingCreateCallRequestId = ''
  let pendingInviteMembersResolve: ((resp: { callId: string; conversationId: string; invitedUserIds: string[]; skippedUserIds: string[] }) => void) | null = null
  let pendingInviteMembersReject: ((error: Error) => void) | null = null
  let pendingInviteMembersTimer: ReturnType<typeof setTimeout> | null = null
  let pendingInviteMembersRequestId = ''
  let remoteAudioStatsTimer: ReturnType<typeof setInterval> | null = null
  let emptyCallAutoCloseTimer: ReturnType<typeof setTimeout> | null = null
  let annotationMonitorPollTimer: ReturnType<typeof setInterval> | null = null
  let annotationMonitorPollInFlight = false
  let audioProcessingCleanup: (() => void) | null = null
  let knownRemoteParticipantSids = new Set<string>()
  let suppressParticipantChangeSounds = false
  let localScreenShareUsedInSession = false
  let lastResolvedNativeOverlayTargetKey = ''
  let nativeAnnotationOverlayGeneration = 0
  let nativeAnnotationOverlayTargetKey = ''
  let nativeAnnotationOverlayShareLabel = ''
  let nativeAnnotationOverlayVisible = false
  let nativeAnnotationOverlayReady = false
  let nativeAnnotationOverlayShowQueued = false
  let nativeAnnotationOverlayNextShowAtMs = 0
  let nativeAnnotationOverlayBatchTimer: ReturnType<typeof setTimeout> | null = null
  let nativeAnnotationOverlayBatchInFlight = false
  const pendingNativeAnnotationOverlaySegments: ScreenAnnotationOverlaySegment[] = []
  let nativeAnnotationOverlayLifecycle = Promise.resolve()
  let hardwareCallControlsRegistered = false
  let hardwareCallControlsSyncSeq = 0
  let hardwareHangupInFlight = false
  let hardwareMuteInFlight = false

  const activeConversationTitle = computed(() => {
    const channel = chatStore.channels.find(item => item.id === activeConversationId.value)
    if (channel) return channel.name
    const dm = chatStore.directMessages.find(item => item.id === activeConversationId.value)
    if (dm) return dm.displayName
    return 'Call'
  })

  const raisedHands = computed<RaisedHand[]>(() => {
    const call = chatStore.activeCalls.find(item => item.id === activeCallId.value)
      ?? chatStore.activeCalls.find(item => item.conversationId === activeConversationId.value)
    return call?.raisedHands ?? []
  })

  const localHandRaised = computed(() => {
    // LiveKit fills in identity during connect() without mutating the shallow
    // room ref. Re-evaluate when connection completes, even if the dock rendered
    // earlier with an empty identity and never subscribed to raisedHands.
    if (!connected.value) return false
    const identity = room.value?.localParticipant.identity ?? ''
    return Boolean(identity && raisedHands.value.some(hand => hand.userId === identity))
  })

  function shouldExposeHardwareCallControls(): boolean {
    return Boolean(activeCallId.value && connected.value)
  }

  async function handleHardwareHangup() {
    if (!shouldExposeHardwareCallControls()) return
    if (hardwareHangupInFlight) return
    hardwareHangupInFlight = true
    try {
      await leaveCall()
    } catch (err) {
      callDebug('hardware hangup failed', {
        error: toErrorMessage(err),
      })
    } finally {
      hardwareHangupInFlight = false
    }
  }

  async function handleHardwareToggleMicrophone() {
    if (!shouldExposeHardwareCallControls()) return
    if (hardwareMuteInFlight) return
    hardwareMuteInFlight = true
    try {
      await toggleMute()
    } catch (err) {
      callDebug('hardware microphone toggle failed', {
        error: toErrorMessage(err),
      })
    } finally {
      hardwareMuteInFlight = false
    }
  }

  async function handleHardwareSetMicrophoneMuted(muted: boolean) {
    if (!shouldExposeHardwareCallControls()) return
    const nextMicEnabled = !muted
    if (micEnabled.value === nextMicEnabled) return
    await handleHardwareToggleMicrophone()
  }

  async function syncHardwareCallControls() {
    const seq = ++hardwareCallControlsSyncSeq
    const controls = platform?.callControls
    if (!controls) {
      hardwareCallControlsRegistered = false
      return
    }

    const active = shouldExposeHardwareCallControls()
    if (!active) {
      if (!hardwareCallControlsRegistered) return
      hardwareCallControlsRegistered = false
      try {
        await controls.dispose()
      } catch (err) {
        callDebug('hardware call controls dispose failed', {
          error: toErrorMessage(err),
        })
      }
      return
    }

    if (!hardwareCallControlsRegistered) {
      try {
        await controls.register({
          onHangup: handleHardwareHangup,
          onToggleMicrophone: handleHardwareToggleMicrophone,
          onSetMicrophoneMuted: handleHardwareSetMicrophoneMuted,
        })
        if (seq !== hardwareCallControlsSyncSeq) return
        hardwareCallControlsRegistered = true
      } catch (err) {
        callDebug('hardware call controls register failed', {
          error: toErrorMessage(err),
        })
        return
      }
    }

    try {
      await controls.update({
        microphoneActive: micEnabled.value,
        title: activeConversationTitle.value,
      })
    } catch (err) {
      callDebug('hardware call controls update failed', {
        error: toErrorMessage(err),
      })
    }
  }

  function clearPendingJoin() {
    if (pendingJoinTimer) {
      clearTimeout(pendingJoinTimer)
      pendingJoinTimer = null
    }
    pendingJoinResolve = null
    pendingJoinReject = null
    pendingJoinRequestId = ''
  }

  function clearPendingCreateCall() {
    if (pendingCreateCallTimer) {
      clearTimeout(pendingCreateCallTimer)
      pendingCreateCallTimer = null
    }
    pendingCreateCallResolve = null
    pendingCreateCallReject = null
    pendingCreateCallRequestId = ''
  }

  function clearPendingInviteMembers() {
    if (pendingInviteMembersTimer) {
      clearTimeout(pendingInviteMembersTimer)
      pendingInviteMembersTimer = null
    }
    pendingInviteMembersResolve = null
    pendingInviteMembersReject = null
    pendingInviteMembersRequestId = ''
  }

  function stopRemoteAudioStatsLoop() {
    if (remoteAudioStatsTimer) {
      clearInterval(remoteAudioStatsTimer)
      remoteAudioStatsTimer = null
    }
  }

  function clearEmptyCallAutoCloseTimer() {
    if (emptyCallAutoCloseTimer) {
      clearTimeout(emptyCallAutoCloseTimer)
      emptyCallAutoCloseTimer = null
    }
  }

  function localRuntimePlatform(): ScreenAnnotationSharerPlatform {
    const platformType = getPlatformOrNull()?.type ?? getRuntimePlatformType()
    return platformType === 'tauri' ? 'tauri' : 'pwa'
  }

  function isLocalSharerSession(session: ScreenAnnotationSessionState | null): boolean {
    if (!session?.active) return false
    const current = room.value
    if (!current) return false
    const identity = current.localParticipant.identity?.trim() || ''
    return Boolean(identity && identity === session.sharerIdentity)
  }

  async function showNativeAnnotationOverlay(shareLabel: string): Promise<boolean> {
    if (localRuntimePlatform() !== 'tauri') return false
    try {
      await platform?.system.invokeNative?.('annotation_overlay_show', {
        overlayLabel: SCREEN_ANNOTATION_OVERLAY_LABEL,
        shareLabel,
      })
      return true
    } catch (err) {
      callDebug('annotation overlay show failed', { error: toErrorMessage(err) })
      return false
    }
  }

  async function hideNativeAnnotationOverlay(): Promise<void> {
    if (localRuntimePlatform() !== 'tauri') return
    try {
      await platform?.system.invokeNative?.('annotation_overlay_hide', {
        overlayLabel: SCREEN_ANNOTATION_OVERLAY_LABEL,
      })
    } catch (err) {
      callDebug('annotation overlay hide failed', { error: toErrorMessage(err) })
    }
  }

  async function clearNativeAnnotationOverlay(): Promise<void> {
    if (localRuntimePlatform() !== 'tauri') return
    try {
      await platform?.system.invokeNative?.('annotation_overlay_clear', {
        overlayLabel: SCREEN_ANNOTATION_OVERLAY_LABEL,
      })
    } catch (err) {
      callDebug('annotation overlay clear failed', { error: toErrorMessage(err) })
    }
  }

  async function pushNativeAnnotationOverlaySegments(segments: ScreenAnnotationOverlaySegment[]): Promise<void> {
    if (localRuntimePlatform() !== 'tauri') return
    try {
      await platform?.system.invokeNative?.('annotation_overlay_push_segments', {
        overlayLabel: SCREEN_ANNOTATION_OVERLAY_LABEL,
        segmentsJson: JSON.stringify(segments),
      })
    } catch (err) {
      callDebug('annotation overlay segment batch push failed', { error: toErrorMessage(err) })
    }
  }

  function enqueueNativeAnnotationOverlayOperation(operation: () => Promise<void>): Promise<void> {
    const queued = nativeAnnotationOverlayLifecycle
      .catch(() => undefined)
      .then(operation)
    nativeAnnotationOverlayLifecycle = queued
    return queued
  }

  function enqueueNativeAnnotationOverlayOperationForGeneration(
    generation: number,
    operation: () => Promise<void>,
  ): Promise<void> {
    return enqueueNativeAnnotationOverlayOperation(async () => {
      if (generation !== nativeAnnotationOverlayGeneration) return
      await operation()
    })
  }

  function clearPendingNativeAnnotationOverlaySegments() {
    if (nativeAnnotationOverlayBatchTimer) {
      clearTimeout(nativeAnnotationOverlayBatchTimer)
      nativeAnnotationOverlayBatchTimer = null
    }
    pendingNativeAnnotationOverlaySegments.length = 0
  }

  function scheduleNativeAnnotationOverlayBatch() {
    if (!nativeAnnotationOverlayVisible || !nativeAnnotationOverlayTargetKey) return
    if (nativeAnnotationOverlayBatchTimer || nativeAnnotationOverlayBatchInFlight) return
    if (pendingNativeAnnotationOverlaySegments.length === 0) return

    const generation = nativeAnnotationOverlayGeneration
    nativeAnnotationOverlayBatchTimer = setTimeout(() => {
      nativeAnnotationOverlayBatchTimer = null
      void flushNativeAnnotationOverlayBatch(generation)
    }, SCREEN_ANNOTATION_OVERLAY_BATCH_INTERVAL_MS)
  }

  async function flushNativeAnnotationOverlayBatch(generation: number): Promise<void> {
    if (generation !== nativeAnnotationOverlayGeneration) return
    if (!nativeAnnotationOverlayVisible || !nativeAnnotationOverlayTargetKey) return
    if (nativeAnnotationOverlayBatchInFlight) return

    const batch = pendingNativeAnnotationOverlaySegments.splice(0, SCREEN_ANNOTATION_OVERLAY_MAX_BATCH_SEGMENTS)
    if (batch.length === 0) return

    nativeAnnotationOverlayBatchInFlight = true
    try {
      await enqueueNativeAnnotationOverlayOperationForGeneration(generation, async () => {
        if (!nativeAnnotationOverlayReady || !nativeAnnotationOverlayVisible) return
        await pushNativeAnnotationOverlaySegments(batch)
      })
    } finally {
      nativeAnnotationOverlayBatchInFlight = false
      scheduleNativeAnnotationOverlayBatch()
    }
  }

  function queueNativeAnnotationOverlaySegment(targetKey: string, segment: ScreenAnnotationEvent) {
    if (targetKey !== nativeAnnotationOverlayTargetKey) return
    if (!nativeAnnotationOverlayVisible) return

    const overlaySegment: ScreenAnnotationOverlaySegment = {
      ...segment,
      color: resolveScreenAnnotationStrokeColor(segment.senderIdentity),
    }
    const overflow = pendingNativeAnnotationOverlaySegments.length - SCREEN_ANNOTATION_OVERLAY_MAX_PENDING_SEGMENTS + 1
    if (overflow > 0) {
      pendingNativeAnnotationOverlaySegments.splice(0, overflow)
      callDebug('annotation overlay batch queue dropped stale segments', { overflow })
    }
    pendingNativeAnnotationOverlaySegments.push(overlaySegment)
    scheduleNativeAnnotationOverlayBatch()
  }

  function ensureNativeAnnotationOverlayVisible(targetKey: string, shareLabel: string): void {
    if (!targetKey) return

    const sameTarget = nativeAnnotationOverlayTargetKey === targetKey
      && nativeAnnotationOverlayShareLabel === shareLabel
      && nativeAnnotationOverlayVisible
    if (sameTarget && (nativeAnnotationOverlayReady || nativeAnnotationOverlayShowQueued || Date.now() < nativeAnnotationOverlayNextShowAtMs)) {
      return
    }

    const targetChanged = nativeAnnotationOverlayVisible && nativeAnnotationOverlayTargetKey !== targetKey
    if (!sameTarget) {
      nativeAnnotationOverlayGeneration += 1
      clearPendingNativeAnnotationOverlaySegments()
      nativeAnnotationOverlayTargetKey = targetKey
      nativeAnnotationOverlayShareLabel = shareLabel
      nativeAnnotationOverlayVisible = true
      nativeAnnotationOverlayReady = false
      nativeAnnotationOverlayShowQueued = false
      nativeAnnotationOverlayNextShowAtMs = 0
    }

    const generation = nativeAnnotationOverlayGeneration
    nativeAnnotationOverlayShowQueued = true
    void enqueueNativeAnnotationOverlayOperationForGeneration(generation, async () => {
      if (targetChanged) {
        await clearNativeAnnotationOverlay()
      }
      if (generation !== nativeAnnotationOverlayGeneration) return

      const shown = await showNativeAnnotationOverlay(shareLabel)
      if (generation !== nativeAnnotationOverlayGeneration) return

      nativeAnnotationOverlayShowQueued = false
      nativeAnnotationOverlayReady = shown
      nativeAnnotationOverlayNextShowAtMs = shown ? 0 : Date.now() + SCREEN_ANNOTATION_OVERLAY_SHOW_RETRY_MS
      if (shown) {
        scheduleNativeAnnotationOverlayBatch()
      }
    })
  }

  async function clearAndHideAllNativeAnnotationOverlays(): Promise<void> {
    const hadOverlay = nativeAnnotationOverlayVisible || nativeAnnotationOverlayShowQueued || Boolean(nativeAnnotationOverlayTargetKey)
    nativeAnnotationOverlayGeneration += 1
    clearPendingNativeAnnotationOverlaySegments()
    nativeAnnotationOverlayTargetKey = ''
    nativeAnnotationOverlayShareLabel = ''
    nativeAnnotationOverlayVisible = false
    nativeAnnotationOverlayReady = false
    nativeAnnotationOverlayShowQueued = false
    nativeAnnotationOverlayNextShowAtMs = 0
    if (!hadOverlay) return

    await enqueueNativeAnnotationOverlayOperation(async () => {
      await clearNativeAnnotationOverlay()
      await hideNativeAnnotationOverlay()
    })
  }

  function resolveCurrentLocalAnnotationRoutingTarget(
    session: ScreenAnnotationSessionState | null,
    capture: LocalShareCaptureContext,
  ): { targetKey: string; shareLabel: string } | null {
    if (!session?.active) return null
    if (capture.shareType === 'window' || capture.shareType === 'browser') return null
    const sessionTargetKey = session.shareType === 'monitor'
      ? resolveMonitorOverlayTargetKey(session.shareLabel)
      : ''
    const targetKey = capture.overlayTargetKey || lastResolvedNativeOverlayTargetKey || sessionTargetKey
    if (!targetKey) return null

    return {
      targetKey,
      shareLabel: capture.shareLabel || session.shareLabel,
    }
  }

  async function syncLocalSharerAnnotationTarget(reason: string): Promise<void> {
    const current = room.value
    const session = annotationSessionState.value
    if (!current || !session?.active || !isLocalSharerSession(session)) return

    const capture = resolveLocalShareCaptureContext(current)
    const routingTarget = resolveCurrentLocalAnnotationRoutingTarget(session, capture)
    if (routingTarget) {
      lastResolvedNativeOverlayTargetKey = routingTarget.targetKey
      ensureNativeAnnotationOverlayVisible(routingTarget.targetKey, routingTarget.shareLabel)
    } else if (capture.shareType === 'window' || capture.shareType === 'browser') {
      lastResolvedNativeOverlayTargetKey = ''
    }

    const shareTypeKnown = capture.shareType === 'monitor'
      || capture.shareType === 'window'
      || capture.shareType === 'browser'
    if (!shareTypeKnown) return
    if (capture.shareType === session.shareType && capture.shareLabel === session.shareLabel) return

    callDebug('annotation share target changed', {
      reason,
      prevShareType: session.shareType,
      prevShareLabel: session.shareLabel,
      nextShareType: capture.shareType,
      nextShareLabel: capture.shareLabel,
      targetKey: routingTarget?.targetKey ?? null,
    })
    await publishLocalAnnotationSessionUpdate(true, capture.shareType, capture.shareLabel)
  }

  function stopLocalAnnotationMonitorPolling() {
    if (annotationMonitorPollTimer) {
      clearInterval(annotationMonitorPollTimer)
      annotationMonitorPollTimer = null
    }
    // Force-clear the guard so a new session can restart polling immediately
    // even if the previous poll promise is still settling in the background.
    annotationMonitorPollInFlight = false
  }

  function runLocalAnnotationMonitorPoll(reason: string) {
    if (annotationMonitorPollInFlight) return
    annotationMonitorPollInFlight = true
    void syncLocalSharerAnnotationTarget(reason).finally(() => {
      annotationMonitorPollInFlight = false
    })
  }

  function startLocalAnnotationMonitorPolling() {
    if (annotationMonitorPollTimer) return
    annotationMonitorPollTimer = setInterval(() => {
      runLocalAnnotationMonitorPoll('interval')
    }, SCREEN_ANNOTATION_MONITOR_POLL_MS)
    runLocalAnnotationMonitorPoll('start')
  }

  function syncNativeOverlayWithSession(nextSession: ScreenAnnotationSessionState | null) {
    const isSharer = isLocalSharerSession(nextSession)
    const nextMode = deriveAnnotationSessionMode(nextSession)

    if (!isSharer || nextMode !== 'os-overlay') {
      stopLocalAnnotationMonitorPolling()
      lastResolvedNativeOverlayTargetKey = ''
      void clearAndHideAllNativeAnnotationOverlays()
      return
    }

    startLocalAnnotationMonitorPolling()
  }

  function setAnnotationSession(nextSession: ScreenAnnotationSessionState | null) {
    annotationSessionState.value = nextSession
    syncNativeOverlayWithSession(nextSession)
  }

  function clearAnnotationSession() {
    setAnnotationSession(null)
  }

  function syncRemoteScreenPublicationSubscription(
    publication: {
      trackSid?: string
      source?: unknown
      isSubscribed: boolean
      setSubscribed?: (next: boolean) => void
    },
    participant: { identity?: string; sid?: string },
    reason: string,
  ) {
    const nextSubscribed = remoteScreenShareReceiveEnabled.value
    if (publication.isSubscribed === nextSubscribed || typeof publication.setSubscribed !== 'function') return
    callDebug(nextSubscribed ? 'forcing remote screen share subscribe' : 'stopping remote screen share for local viewer', {
      participant: participant.identity,
      participantSid: participant.sid,
      trackSid: publication.trackSid,
      source: publication.source,
      reason,
    })
    publication.setSubscribed(nextSubscribed)
  }

  function syncRemoteParticipantSubscriptions(
    participant: {
      identity?: string
      sid?: string
      audioTrackPublications: Map<unknown, {
        isSubscribed: boolean
        trackSid?: string
        setSubscribed?: (next: boolean) => void
      }>
      videoTrackPublications: Map<unknown, {
        isSubscribed: boolean
        trackSid?: string
        source?: unknown
        setSubscribed?: (next: boolean) => void
      }>
    },
    reason: string,
  ) {
    for (const publication of participant.audioTrackPublications.values()) {
      if (!publication.isSubscribed && typeof publication.setSubscribed === 'function') {
        callDebug('forcing remote audio subscribe', {
          participant: participant.identity,
          participantSid: participant.sid,
          trackSid: publication.trackSid,
          reason,
        })
        publication.setSubscribed(true)
      }
    }
    for (const publication of participant.videoTrackPublications.values()) {
      if (isScreenSource(publication.source)) {
        syncRemoteScreenPublicationSubscription(publication, participant, reason)
        continue
      }
      if (!publication.isSubscribed && typeof publication.setSubscribed === 'function') {
        callDebug('forcing remote video subscribe', {
          participant: participant.identity,
          participantSid: participant.sid,
          trackSid: publication.trackSid,
          source: publication.source,
          reason,
        })
        publication.setSubscribed(true)
      }
    }
  }

  function syncRemoteTrackSubscriptions(current: Room, reason: string) {
    if (!current.remoteParticipants || typeof current.remoteParticipants.values !== 'function') return
    for (const participant of current.remoteParticipants.values()) {
      syncRemoteParticipantSubscriptions(participant, reason)
    }
  }

  function emitScreenAnnotation(event: ScreenAnnotationEvent) {
    for (const listener of annotationListeners) {
      try {
        listener(event)
      } catch (err) {
        callDebug('screen annotation listener failed', {
          error: toErrorMessage(err),
        })
      }
    }
  }

  function onScreenAnnotation(listener: ScreenAnnotationListener): () => void {
    annotationListeners.add(listener)
    return () => {
      annotationListeners.delete(listener)
    }
  }

  function callReactionKey(participantId: string, reactionId: string): string {
    return `${participantId}\u0000${reactionId}`
  }

  function hasSeenCallReaction(participantId: string, reactionId: string): boolean {
    return seenReactionTimeouts.has(callReactionKey(participantId, reactionId))
  }

  function rememberCallReaction(participantId: string, reactionId: string) {
    const key = callReactionKey(participantId, reactionId)
    if (seenReactionTimeouts.has(key)) return
    const timeout = setTimeout(() => {
      seenReactionTimeouts.delete(key)
    }, CALL_REACTION_DEDUPE_TTL_MS)
    seenReactionTimeouts.set(key, timeout)
  }

  function clearCallReaction(participantId: string) {
    const normalizedParticipantId = participantId.trim()
    if (!normalizedParticipantId) return

    const timeout = reactionTimeoutsByParticipantId.get(normalizedParticipantId)
    if (timeout) {
      clearTimeout(timeout)
      reactionTimeoutsByParticipantId.delete(normalizedParticipantId)
    }
    if (!(normalizedParticipantId in reactionsByParticipantId.value)) return

    const { [normalizedParticipantId]: _removed, ...remaining } = reactionsByParticipantId.value
    reactionsByParticipantId.value = remaining
  }

  function clearCallReactions() {
    for (const timeout of reactionTimeoutsByParticipantId.values()) {
      clearTimeout(timeout)
    }
    reactionTimeoutsByParticipantId.clear()
    reactionsByParticipantId.value = {}

    for (const timeout of seenReactionTimeouts.values()) {
      clearTimeout(timeout)
    }
    seenReactionTimeouts.clear()
  }

  function showCallReaction(participantId: string, packet: CallReactionPacketV1) {
    const currentTimeout = reactionTimeoutsByParticipantId.get(participantId)
    if (currentTimeout) clearTimeout(currentTimeout)

    const reaction: ActiveCallReaction = {
      ...packet,
      expiresAtMs: Date.now() + CALL_REACTION_TTL_MS,
    }
    reactionsByParticipantId.value = {
      ...reactionsByParticipantId.value,
      [participantId]: reaction,
    }

    const timeout = setTimeout(() => {
      const activeReaction = reactionsByParticipantId.value[participantId]
      if (
        activeReaction?.reactionId !== reaction.reactionId
        || activeReaction.senderSessionId !== reaction.senderSessionId
        || activeReaction.sequence !== reaction.sequence
      ) {
        return
      }
      clearCallReaction(participantId)
    }, CALL_REACTION_TTL_MS)
    reactionTimeoutsByParticipantId.set(participantId, timeout)
  }

  function ingestCallReactionPacket(payload: Uint8Array, participantIdentity?: string): boolean {
    const packet = decodeCallReactionPacket(payload)
    const participantId = participantIdentity?.trim() || ''
    if (!packet || !isBoundedNonEmptyString(participantId)) return false
    if (hasSeenCallReaction(participantId, packet.reactionId)) return true
    rememberCallReaction(participantId, packet.reactionId)

    const activeReaction = reactionsByParticipantId.value[participantId]
    if (
      activeReaction?.senderSessionId === packet.senderSessionId
      && packet.sequence <= activeReaction.sequence
    ) {
      return true
    }
    if (activeReaction && packet.sentAtMs < activeReaction.sentAtMs) return true

    showCallReaction(participantId, packet)
    return true
  }

  async function sendCallReaction(emoji: CallReactionEmoji): Promise<void> {
    if (!isCallReactionEmoji(emoji)) {
      throw new Error('Unsupported call reaction')
    }

    const current = room.value
    const participantId = current?.localParticipant.identity?.trim() || ''
    if (!current || !connected.value || !isBoundedNonEmptyString(participantId)) {
      throw new Error('Call is not connected')
    }

    localReactionSequence += 1
    const packet: CallReactionPacketV1 = {
      version: 1,
      kind: 'reaction',
      emoji,
      senderSessionId: reactionSessionId,
      sequence: localReactionSequence,
      reactionId: createCallReactionId(),
      sentAtMs: Date.now(),
    }
    rememberCallReaction(participantId, packet.reactionId)
    showCallReaction(participantId, packet)

    const encoded = new TextEncoder().encode(JSON.stringify(packet))
    await current.localParticipant.publishData(encoded, {
      reliable: true,
      topic: CALL_REACTION_TOPIC,
    })
  }

  async function publishAnnotationPacket(packet: ScreenAnnotationPacketV1): Promise<void> {
    const current = room.value
    if (!current) return
    const encoded = new TextEncoder().encode(JSON.stringify(packet))
    await current.localParticipant.publishData(encoded, {
      reliable: false,
      topic: SCREEN_ANNOTATION_TOPIC,
    })
  }

  function resolveLocalShareCaptureContext(current: Room): LocalShareCaptureContext {
    const getTrackPublication = current.localParticipant?.getTrackPublication
    if (typeof getTrackPublication !== 'function') {
      return { shareType: 'unknown', shareLabel: '', overlayTargetKey: '' }
    }
    const publication = getTrackPublication.call(current.localParticipant, Track.Source.ScreenShare)
    const trackLike = publication?.track as {
      mediaStreamTrack?: MediaStreamTrack | null
    } | null
    const mediaTrack = trackLike?.mediaStreamTrack ?? null
    if (!mediaTrack) {
      return { shareType: 'unknown', shareLabel: '', overlayTargetKey: '' }
    }
    const label = mediaTrack.label || ''
    let shareType: ScreenAnnotationShareType = 'unknown'
    try {
      const settings = mediaTrack.getSettings?.()
      const surface = String(settings?.displaySurface ?? '').toLowerCase()
      if (surface === 'monitor' || surface === 'window' || surface === 'browser') {
        shareType = surface
      }
    } catch {
      shareType = 'unknown'
    }
    if (shareType === 'unknown') {
      const normalized = label.toLowerCase()
      if (normalized.includes('screen') || normalized.includes('display') || normalized.includes('monitor')) {
        shareType = 'monitor'
      } else if (normalized.includes('window')) {
        shareType = 'window'
      } else if (normalized.includes('tab') || normalized.includes('browser')) {
        shareType = 'browser'
      }
    }
    return {
      shareType,
      shareLabel: label,
      overlayTargetKey: shareType === 'monitor' ? resolveMonitorOverlayTargetKey(label) : '',
    }
  }

  async function publishLocalAnnotationSessionUpdate(active: boolean, shareType: ScreenAnnotationShareType, shareLabel: string) {
    const current = room.value
    if (!current) return
    const identity = current.localParticipant.identity?.trim() || ''
    const session: ScreenAnnotationSessionState = {
      version: 1,
      kind: 'session',
      active,
      sharerIdentity: identity,
      sharerPlatform: localRuntimePlatform(),
      shareType,
      shareLabel,
      sentAtMs: Date.now(),
    }
    setAnnotationSession(session)
    await publishAnnotationPacket(session)
  }

  function ingestScreenAnnotationPacket(payload: Uint8Array, participantIdentity?: string): boolean {
    const parsed = decodeScreenAnnotationPacket(payload)
    if (!parsed) return false
    if (parsed.kind === 'session') {
      setAnnotationSession({
        ...parsed,
        sharerIdentity: participantIdentity?.trim() || parsed.sharerIdentity,
      })
      return true
    }
    const event: ScreenAnnotationEvent = {
      ...parsed,
      senderIdentity: participantIdentity?.trim() || parsed.senderIdentity,
      receivedAtMs: Date.now(),
    }
    emitScreenAnnotation(event)
    if (isLocalSharerSession(annotationSessionState.value) && annotationSessionMode.value === 'os-overlay') {
      const routingTarget = resolveCurrentLocalAnnotationRoutingTarget(
        annotationSessionState.value,
        room.value ? resolveLocalShareCaptureContext(room.value) : { shareType: 'unknown', shareLabel: '', overlayTargetKey: '' },
      )
      if (routingTarget) {
        ensureNativeAnnotationOverlayVisible(routingTarget.targetKey, routingTarget.shareLabel)
        queueNativeAnnotationOverlaySegment(routingTarget.targetKey, event)
      }
    }
    return true
  }

  function syncKnownRemoteParticipants(current: Room) {
    knownRemoteParticipantSids = new Set(
      Array.from(current.remoteParticipants.values()).map(participant => participant.sid),
    )
  }

  function scheduleEmptyCallAutoClose() {
    clearEmptyCallAutoCloseTimer()

    if (!connected.value) return
    if (remoteParticipantCount.value > 0) return
    if (!activeConversationId.value) return

    const shouldCloseIfStillEmpty = () => {
      if (!connected.value) return
      if (!activeConversationId.value) return
      if (remoteParticipantCount.value > 0) return
      if (chatStore.activeCalls.some(call => call.conversationId === activeConversationId.value)) return

      callDebug('auto closing empty call', {
        conversationId: activeConversationId.value,
        remoteParticipantCount: remoteParticipantCount.value,
      })
      void leaveCall()
    }

    emptyCallAutoCloseTimer = setTimeout(shouldCloseIfStillEmpty, EMPTY_CALL_AUTO_CLOSE_MS)
  }

  async function logRemoteAudioStatsSnapshot(current: Room) {
    const snapshot: Array<Record<string, unknown>> = []
    for (const participant of current.remoteParticipants.values()) {
      for (const publication of participant.audioTrackPublications.values()) {
        const track = publication.track as {
          sid?: string
          kind?: string
          getReceiverStats?: () => Promise<Record<string, unknown> | undefined>
        } | null
        const entry: Record<string, unknown> = {
          participantIdentity: participant.identity,
          participantSid: participant.sid,
          publicationSid: publication.trackSid,
          publicationName: publication.trackName,
          subscribed: publication.isSubscribed,
          muted: publication.isMuted,
          hasTrack: Boolean(track),
          trackSid: track?.sid ?? null,
          trackKind: track?.kind ?? null,
        }
        if (track && typeof track.getReceiverStats === 'function') {
          try {
            const stats = await track.getReceiverStats()
            entry.receiverStats = stats
          } catch (err) {
            entry.statsError = err instanceof Error ? err.message : String(err)
          }
        }
        snapshot.push(entry)
      }
    }

    callDebug('remote audio stats snapshot', {
      room: current.name,
      canPlaybackAudio: current.canPlaybackAudio,
      remoteParticipantCount: current.remoteParticipants.size,
      tracks: snapshot,
    })
  }

  function startRemoteAudioStatsLoop(current: Room) {
    stopRemoteAudioStatsLoop()
    if (!isCallDebugEnabled()) return
    void logRemoteAudioStatsSnapshot(current)
    remoteAudioStatsTimer = setInterval(() => {
      void logRemoteAudioStatsSnapshot(current)
    }, REMOTE_AUDIO_STATS_INTERVAL_MS)
  }

  function logLocalVideoPublications(current: Room, stage: string) {
    const publications = Array.from(current.localParticipant.videoTrackPublications.values()).map((publication) => ({
      trackSid: publication.trackSid,
      source: publication.source,
      muted: publication.isMuted,
      hasTrack: Boolean(publication.track),
      trackKind: publication.track?.kind ?? null,
    }))
    logScreenShare(`local video publications (${stage})`, publications)
  }

  function logRemoteVideoPublications(current: Room, stage: string) {
    const publications = Array.from(current.remoteParticipants.values()).flatMap(participant =>
      Array.from(participant.videoTrackPublications.values()).map(publication => ({
        participant: participant.identity,
        participantSid: participant.sid,
        trackSid: publication.trackSid,
        source: publication.source,
        subscribed: publication.isSubscribed,
        muted: publication.isMuted,
        hasTrack: Boolean(publication.track),
        trackKind: publication.track?.kind ?? null,
      }))
    )
    logScreenShare(`remote video publications (${stage})`, publications)
  }

  function describeLocalPublication(publication: {
    trackSid: string
    source: unknown
    kind: unknown
    isMuted: boolean
    track?: {
      sid?: string
      kind?: string
      mediaStreamTrack?: MediaStreamTrack | null
    } | null
  }): Record<string, unknown> {
    return {
      trackSid: publication.trackSid,
      source: publication.source,
      kind: publication.kind,
      muted: publication.isMuted,
      hasTrack: Boolean(publication.track),
      liveKitTrackSid: publication.track?.sid ?? null,
      liveKitTrackKind: publication.track?.kind ?? null,
      mediaTracks: getTrackMediaVariants(publication.track).map(item => ({
        role: item.role,
        track: describeMediaTrack(item.track),
      })),
    }
  }

  function logLocalCaptureState(current: Room, stage: string, extra: Record<string, unknown> = {}) {
    const local = current.localParticipant
    const publications = [
      ...Array.from(local.videoTrackPublications.values()),
      ...Array.from(local.audioTrackPublications.values()),
    ].map(publication => describeLocalPublication(publication))
    logScreenShare(`local capture snapshot (${stage})`, {
      ...extra,
      room: current.name,
      participant: local.identity,
      publicationCount: publications.length,
      publications,
    })
  }

  function trackLocalScreenCapturePublications(current: Room, stage: string, extra: Record<string, unknown> = {}) {
    const local = current.localParticipant
    const publications = [
      ...Array.from(local.videoTrackPublications.values()),
      ...Array.from(local.audioTrackPublications.values()),
    ]
    for (const publication of publications) {
      if (!isScreenSource(publication.source)) continue
      const variants = getTrackMediaVariants(publication.track)
      for (const variant of variants) {
        rememberDisplayCaptureTrack(variant.track, {
          source: 'local-publication',
          stage,
          room: current.name,
          participant: local.identity,
          publicationSource: publication.source,
          trackSid: publication.trackSid,
          trackRole: variant.role,
          ...extra,
        })
      }
    }
    logTrackedDisplayCaptureState(`after trackLocalScreenCapturePublications (${stage})`, {
      room: current.name,
      participant: local.identity,
      ...extra,
    })
  }

  function buildAudioCaptureOptions(): AudioCaptureOptions {
    const prefs = loadAudioPrefs()
    const opts: AudioCaptureOptions = {
      // When RNNoise is active it handles noise suppression; disable the browser's
      // native implementation to avoid double-processing.
      noiseSuppression: prefs.rnnoiseEnabled ? false : prefs.noiseSuppression,
      echoCancellation: prefs.echoCancellation,
      autoGainControl: prefs.autoGainControl,
      // Explicitly request mono capture. All voice processing (AEC, NS, AGC,
      // RNNoise) operates on a single channel. Bluetooth headsets (AirPods,
      // HFP/HSP profile) deliver a mono SCO link regardless, so specifying 1
      // here makes intent clear and prevents unexpected stereo on multi-mic
      // devices (e.g. laptop beamforming arrays).
      channelCount: 1,
    }
    if (prefs.inputDeviceId) {
      opts.deviceId = prefs.inputDeviceId
    }
    return opts
  }

  function persistInputDevicePreference(deviceId: string): void {
    const prefs = loadAudioPrefs()
    if (prefs.inputDeviceId === deviceId) return
    saveAudioPrefs({
      ...prefs,
      inputDeviceId: deviceId,
    })
  }

  // Builds the complete audio post-processing pipeline in a single AudioContext
  // and replaces the track LiveKit is sending with the processed output.
  //
  // Pipeline (left to right):
  //   raw mic → GainNode (if !autoGainControl && gain ≠ 100)
  //           → AudioWorkletNode/RNNoise (if rnnoiseEnabled)
  //           → MediaStreamDestination → replaceTrack
  //
  // Gain is applied BEFORE noise suppression so RNNoise receives a well-levelled
  // signal. Its VAD is level-dependent — a signal that is too quiet causes
  // speech frames to be misclassified as noise and suppressed.
  //
  // Both stages share one AudioContext and one replaceTrack() call, which avoids
  // the previous bug where two independent replaceTrack() calls raced each other
  // and the second one silently discarded the first stage's output.
  //
  // The RNNoise blob URL is cached at module scope via getRnnoiseBlobUrl() so
  // the JS files are only downloaded once per page load.
  //
  // Returns a cleanup function that tears down the AudioContext on call leave.
  async function applyAudioProcessing(
    publication: LocalAudioTrack,
    prefs: { autoGainControl: boolean; microphoneGain: number; rnnoiseEnabled: boolean },
  ): Promise<() => void> {
    // Always read _mediaStreamTrack directly (not via the .mediaStreamTrack
    // getter) so we get the original raw capture track rather than any
    // previously replaced/processed track.
    const rawTrack = (publication as unknown as { _mediaStreamTrack: MediaStreamTrack })._mediaStreamTrack
      ?? publication.mediaStreamTrack

    const applyGain = !prefs.autoGainControl && prefs.microphoneGain !== 100

    // If neither stage is needed, there is nothing to do.
    if (!applyGain && !prefs.rnnoiseEnabled) {
      return () => {}
    }

    const ctx = new AudioContext()
    try {
      const source = ctx.createMediaStreamSource(new MediaStream([rawTrack]))
      let current: AudioNode = source

      // Mono node options shared by every processing stage.
      // channelCountMode:'explicit' locks channel count to exactly 1 at every
      // node so the pipeline never silently up-mixes mid-chain.
      const monoNodeOptions: AudioNodeOptions = {
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
      }

      // Stage 1 — gain (must come before noise suppression)
      if (applyGain) {
        const gainNode = new GainNode(ctx, monoNodeOptions)
        gainNode.gain.value = prefs.microphoneGain / 100
        current.connect(gainNode)
        current = gainNode
      }

      // Stage 2 — RNNoise WASM noise suppression
      if (prefs.rnnoiseEnabled) {
        const blobUrl = await getRnnoiseBlobUrl()
        await ctx.audioWorklet.addModule(blobUrl)
        const workletNode = new AudioWorkletNode(ctx, 'rnnoise-processor', {
          ...monoNodeOptions,
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        })
        current.connect(workletNode)
        current = workletNode
      }

      // MediaStreamAudioDestinationNode defaults to 2 channels (stereo).
      // Web Audio spec §4.4 mono→stereo upmix: L = M, R = M.
      // Connecting the 1-ch pipeline output here automatically fills both
      // channels with the same signal — remote participants hear audio on
      // both sides regardless of which physical mic they used.
      const dest = ctx.createMediaStreamDestination()
      current.connect(dest)

      const processedTrack = dest.stream.getAudioTracks()[0]
      await publication.replaceTrack(processedTrack, true)

      return () => {
        // Stop both the processed output track and the raw mic track.
        // This cleanup is only called on call leave (ensureDisconnected) —
        // never during a mute/unmute cycle. Stopping rawTrack releases the
        // browser microphone indicator. AudioContext.close() alone does NOT
        // stop the underlying MediaStreamTrack.
        processedTrack.stop()
        rawTrack.stop()
        ctx.close().catch(() => {})
      }
    } catch (err) {
      console.error('[call] applyAudioProcessing failed:', err)
      ctx.close().catch(() => {})
      throw err
    }
  }

  async function enableMicrophoneWithProcessing(current: Room): Promise<void> {
    await current.localParticipant.setMicrophoneEnabled(true, buildAudioCaptureOptions())
    micEnabled.value = true
    callDebug('microphone enabled', { localParticipant: current.localParticipant.identity })

    const prefs = loadAudioPrefs()
    const pub = current.localParticipant.getTrackPublication(Track.Source.Microphone)
    const audioTrack = pub?.track as LocalAudioTrack | undefined
    if (!audioTrack) {
      audioProcessingCleanup?.()
      audioProcessingCleanup = null
      return
    }

    try {
      audioProcessingCleanup?.()
      audioProcessingCleanup = await applyAudioProcessing(audioTrack, {
        autoGainControl: prefs.autoGainControl,
        microphoneGain: prefs.microphoneGain,
        rnnoiseEnabled: prefs.rnnoiseEnabled,
      })
      callDebug('audio processing applied', {
        gain: prefs.microphoneGain,
        rnnoise: prefs.rnnoiseEnabled,
        agc: prefs.autoGainControl,
      })
    } catch (err) {
      callDebug('audio processing failed', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  function createRoom(): Room {
    const next = new Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: buildAudioCaptureOptions(),
    })

    next.on(RoomEvent.Disconnected, () => {
      callDebug('room disconnected', {
        room: next.name,
        canPlaybackAudio: next.canPlaybackAudio,
      })
      trackLocalScreenCapturePublications(next, 'room-event-disconnected')
      logLocalCaptureState(next, 'room-event-disconnected')
      stopRemoteAudioStatsLoop()
      connected.value = false
      connecting.value = false
      cameraEnabled.value = false
      screenShareEnabled.value = false
      micEnabled.value = false
      remoteScreenShareReceiveEnabled.value = true
      remoteParticipantCount.value = 0
      handActionInFlight.value = false
      mediaVersion.value += 1
      activeSpeakerSids.value = new Set()
      playbackBlocked.value = false
      activeCallId.value = ''
      activeRoomName.value = ''
      activeConversationId.value = ''
      activeConversationKind.value = 'channel'
      activeConversationVisibility.value = 'public'
      room.value = null
      clearAnnotationSession()
      clearCallReactions()
      stopTrackedDisplayCaptureTracks('room-event-disconnected')
      clearEmptyCallAutoCloseTimer()
      knownRemoteParticipantSids.clear()
      suppressParticipantChangeSounds = false
    })

    next.on(RoomEvent.Connected, () => {
      callDebug('room connected', {
        room: next.name,
        localParticipant: next.localParticipant.identity,
        canPlaybackAudio: next.canPlaybackAudio,
      })
      remoteParticipantCount.value = next.remoteParticipants.size
      syncKnownRemoteParticipants(next)
      suppressParticipantChangeSounds = false
      mediaVersion.value += 1
      clearEmptyCallAutoCloseTimer()
      if (remoteParticipantCount.value === 0) {
        scheduleEmptyCallAutoClose()
      }
    })

    next.on(RoomEvent.Reconnecting, () => {
      callDebug('room reconnecting', { room: next.name })
      clearCallReactions()
    })

    next.on(RoomEvent.Reconnected, () => {
      callDebug('room reconnected', {
        room: next.name,
        canPlaybackAudio: next.canPlaybackAudio,
      })
      remoteParticipantCount.value = next.remoteParticipants.size
      syncKnownRemoteParticipants(next)
      suppressParticipantChangeSounds = false
      mediaVersion.value += 1
      if (remoteParticipantCount.value === 0) {
        scheduleEmptyCallAutoClose()
      } else {
        clearEmptyCallAutoCloseTimer()
      }
    })

    next.on(RoomEvent.ParticipantConnected, (participant) => {
      const isKnownParticipant = knownRemoteParticipantSids.has(participant.sid)
      knownRemoteParticipantSids.add(participant.sid)
      if (screenShareEnabled.value) {
        const capture = resolveLocalShareCaptureContext(next)
        void publishLocalAnnotationSessionUpdate(true, capture.shareType, capture.shareLabel)
      }

      syncRemoteParticipantSubscriptions(participant, 'participant-connected')
      callDebug('remote participant connected', {
        participant: participant.identity,
        sid: participant.sid,
        remoteParticipantCount: next.remoteParticipants.size,
      })
      remoteParticipantCount.value = next.remoteParticipants.size
      clearEmptyCallAutoCloseTimer()
      mediaVersion.value += 1
      if (!isKnownParticipant && connected.value && !suppressParticipantChangeSounds) {
        if (platform?.type === 'tauri') {
          void platform.notifications.playSound?.('call-member-joined')
        } else {
          void soundEngine.playCallMemberJoined()
        }
      }
    })

    next.on(RoomEvent.ParticipantDisconnected, (participant) => {
      const isKnownParticipant = knownRemoteParticipantSids.delete(participant.sid)
      if (annotationSessionState.value?.sharerIdentity === participant.identity) {
        clearAnnotationSession()
      }
      clearCallReaction(participant.identity ?? '')
      callDebug('remote participant disconnected', {
        participant: participant.identity,
        sid: participant.sid,
        remoteParticipantCount: next.remoteParticipants.size,
      })
      remoteParticipantCount.value = next.remoteParticipants.size
      if (remoteParticipantCount.value === 0) {
        scheduleEmptyCallAutoClose()
      }
      mediaVersion.value += 1
      if (isKnownParticipant && connected.value && !suppressParticipantChangeSounds) {
        if (platform?.type === 'tauri') {
          void platform.notifications.playSound?.('call-member-left')
        } else {
          void soundEngine.playCallMemberLeft()
        }
      }
    })

    next.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      if (topic === SCREEN_ANNOTATION_TOPIC) {
        const accepted = ingestScreenAnnotationPacket(payload, participant?.identity)
        if (accepted) return
        callDebug('screen annotation packet ignored (invalid payload)', {
          participant: participant?.identity ?? null,
          topic,
          payloadSize: payload.byteLength,
        })
        return
      }
      if (topic === CALL_REACTION_TOPIC) {
        const accepted = ingestCallReactionPacket(payload, participant?.identity)
        if (accepted) return
        callDebug('call reaction packet ignored (invalid payload)', {
          participant: participant?.identity ?? null,
          topic,
          payloadSize: payload.byteLength,
        })
      }
    })

    next.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      callDebug('track subscribed', {
        participant: participant.identity,
        publicationSid: publication.trackSid,
        kind: track.kind,
        source: publication.source,
        muted: publication.isMuted,
      })
      if (isScreenSource(publication.source)) {
        logScreenShare('remote screen track subscribed', {
          participant: participant.identity,
          participantSid: participant.sid,
          trackSid: publication.trackSid,
          muted: publication.isMuted,
          hasTrack: Boolean(publication.track),
        })
        logRemoteVideoPublications(next, 'track-subscribed')
      }
      mediaVersion.value += 1
    })

    next.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
      callDebug('track unsubscribed', {
        participant: participant.identity,
        publicationSid: publication.trackSid,
        kind: track.kind,
        source: publication.source,
      })
      if (isScreenSource(publication.source)) {
        if (remoteScreenShareReceiveEnabled.value && annotationSessionState.value?.sharerIdentity === participant.identity) {
          clearAnnotationSession()
        }
        logScreenShare('remote screen track unsubscribed', {
          participant: participant.identity,
          participantSid: participant.sid,
          trackSid: publication.trackSid,
        })
        logRemoteVideoPublications(next, 'track-unsubscribed')
      }
      mediaVersion.value += 1
    })

    next.on(RoomEvent.TrackPublished, (publication, participant) => {
      if (!participant.isLocal) {
        if (isScreenSource(publication.source)) {
          syncRemoteScreenPublicationSubscription(publication, participant, 'track-published')
        } else if (!publication.isSubscribed) {
          callDebug('forcing remote track subscribe on track publish', {
            participant: participant.identity,
            trackSid: publication.trackSid,
            kind: publication.kind,
            source: publication.source,
          })
          publication.setSubscribed(true)
        }
      }
      callDebug('track published event', {
        participant: participant.identity,
        publicationSid: publication.trackSid,
        kind: publication.kind,
        source: publication.source,
        subscribed: publication.isSubscribed,
        muted: publication.isMuted,
      })
      if (isScreenSource(publication.source)) {
        logScreenShare('track published with screen source', {
          participant: participant.identity,
          participantSid: participant.sid,
          trackSid: publication.trackSid,
          subscribed: publication.isSubscribed,
          hasTrack: Boolean(publication.track),
        })
        logRemoteVideoPublications(next, 'track-published')
      }
      mediaVersion.value += 1
    })

    next.on(RoomEvent.TrackSubscriptionFailed, (trackSid, participant) => {
      logScreenShare('track subscription failed', {
        trackSid,
        participant: participant.identity,
        participantSid: participant.sid,
      })
    })

    next.on(RoomEvent.LocalTrackPublished, (publication) => {
      mediaVersion.value += 1
      if (isScreenSource(publication.source)) {
        localScreenShareUsedInSession = true
        const capture = resolveLocalShareCaptureContext(next)
        void publishLocalAnnotationSessionUpdate(true, capture.shareType, capture.shareLabel)
        const variants = getTrackMediaVariants(publication.track)
        for (const variant of variants) {
          rememberDisplayCaptureTrack(variant.track, {
            source: 'local-track-published',
            room: next.name,
            participant: next.localParticipant.identity,
            publicationSource: publication.source,
            trackSid: publication.trackSid,
            trackRole: variant.role,
          })
        }
        logTrackedDisplayCaptureState('local-track-published', {
          room: next.name,
          trackSid: publication.trackSid,
          variantCount: variants.length,
        })
        logScreenShare('local screen track published', {
          trackSid: publication.trackSid,
          source: publication.source,
          muted: publication.isMuted,
          hasTrack: Boolean(publication.track),
        })
        logLocalVideoPublications(next, 'local-track-published')
      }
    })

    next.on(RoomEvent.LocalTrackUnpublished, (publication) => {
      mediaVersion.value += 1
      if (isScreenSource(publication.source)) {
        void publishLocalAnnotationSessionUpdate(false, 'unknown', '')
        logScreenShare('local screen track unpublished', {
          trackSid: publication.trackSid,
          source: publication.source,
        })
        logLocalVideoPublications(next, 'local-track-unpublished')
      }
      // When the ScreenShare video track is unpublished via Safari's native
      // "Stop Sharing" toolbar button, Safari fires 'ended' on the track.
      // LiveKit's handleTrackEnded unpublishes only that one track, so:
      //   1. screenShareEnabled is never reset — UI stays stuck in "sharing" state.
      //   2. The ScreenShareAudio companion track is left published/live —
      //      Safari keeps showing the audio capture indicator indefinitely.
      if (publication.source === Track.Source.ScreenShare) {
        screenShareEnabled.value = false
        clearAnnotationSession()
        const audioPublication = next.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)
        if (audioPublication?.track) {
          const audioTrackStateBefore = describeMediaTrack(audioPublication.track.mediaStreamTrack ?? null)
          Promise.resolve(next.localParticipant.unpublishTrack(audioPublication.track))
            .then(() => {
              logScreenShare('screen share companion audio unpublished after screen stop', {
                room: next.name,
                trackSid: audioPublication.trackSid,
                mediaTrackBefore: audioTrackStateBefore,
                mediaTrackAfter: describeMediaTrack(audioPublication.track?.mediaStreamTrack ?? null),
              })
            })
            .catch((err) => {
              logScreenShare('screen share companion audio unpublish failed', {
                room: next.name,
                trackSid: audioPublication.trackSid,
                mediaTrackBefore: audioTrackStateBefore,
                error: toErrorMessage(err),
              })
            })
        }
      }
    })

    next.on(RoomEvent.AudioPlaybackStatusChanged, () => {
      callDebug('audio playback status changed', {
        canPlaybackAudio: next.canPlaybackAudio,
      })
      playbackBlocked.value = !next.canPlaybackAudio
    })

    next.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      activeSpeakerSids.value = new Set(speakers.map(s => s.sid))
      mediaVersion.value += 1
    })

    return next
  }

  function ensureRemoteTracksSubscribed(current: Room) {
    syncRemoteTrackSubscriptions(current, 'sync')
  }

  function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(message))
      }, ms)
      void promise.then(
        (result) => {
          clearTimeout(timeout)
          resolve(result)
        },
        (err) => {
          clearTimeout(timeout)
          reject(err)
        },
      )
    })
  }

  async function ensureDisconnected() {
    suppressParticipantChangeSounds = true
    const teardownId = `leave-${Date.now()}-${++captureTeardownSeq}`
    logScreenShare('ensureDisconnected start', {
      teardownId,
      hasRoom: Boolean(room.value),
      room: room.value?.name ?? null,
      conversationId: activeConversationId.value || null,
      activeCallId: activeCallId.value || null,
      remoteParticipantCount: remoteParticipantCount.value,
    })
    audioProcessingCleanup?.()
    audioProcessingCleanup = null
    stopTrackedDisplayCaptureTracks(`ensureDisconnected:pre-room:${teardownId}`)
    const current = room.value
    clearPendingJoin()
    stopRemoteAudioStatsLoop()
    clearEmptyCallAutoCloseTimer()
    if (!current) {
      clearAnnotationSession()
      clearCallReactions()
      remoteScreenShareReceiveEnabled.value = true
      suppressParticipantChangeSounds = false
      logScreenShare('ensureDisconnected skipped: no active room', { teardownId })
      return
    }
    trackLocalScreenCapturePublications(current, 'ensureDisconnected:pre-stop', { teardownId })
    logLocalCaptureState(current, 'ensureDisconnected:before-stop', { teardownId })
    await stopAllLocalCaptureTracks(current, teardownId)
    logLocalCaptureState(current, 'ensureDisconnected:after-stop', { teardownId })
    try {
      console.info('[call-leave] disconnecting room', {
        room: current.name,
        conversationId: activeConversationId.value,
        activeCallId: activeCallId.value,
      })
      callDebug('disconnecting room', { room: current.name })
      await current.disconnect()
      console.info('[call-leave] disconnect resolved', {
        room: current.name,
      })
    } catch (err) {
      logScreenShare('room disconnect failed', {
        teardownId,
        room: current.name,
        error: toErrorMessage(err),
      })
    }
    room.value = null
    clearAnnotationSession()
    clearCallReactions()
    remoteScreenShareReceiveEnabled.value = true
    knownRemoteParticipantSids.clear()
    suppressParticipantChangeSounds = false
    logTrackedDisplayCaptureState('ensureDisconnected:end', { teardownId })
  }

  async function stopAllLocalCaptureTracks(current: Room, teardownId: string) {
    const local = current.localParticipant
    if (!local) {
      logScreenShare('stopAllLocalCaptureTracks skipped: local participant missing', {
        teardownId,
        room: current.name,
      })
      return
    }

    logLocalCaptureState(current, 'stopAllLocalCaptureTracks:start', { teardownId })

    const disableOps: Array<{ op: string; promise: Promise<unknown> }> = []
    if (typeof local.setScreenShareEnabled === 'function') {
      disableOps.push({ op: 'setScreenShareEnabled(false)', promise: local.setScreenShareEnabled(false) })
    }
    if (typeof local.setCameraEnabled === 'function') {
      disableOps.push({ op: 'setCameraEnabled(false)', promise: local.setCameraEnabled(false) })
    }
    if (typeof local.setMicrophoneEnabled === 'function') {
      disableOps.push({ op: 'setMicrophoneEnabled(false)', promise: local.setMicrophoneEnabled(false) })
    }
    if (disableOps.length > 0) {
      const disableResults = await Promise.allSettled(disableOps.map(item => item.promise))
      logScreenShare('local capture disable operations settled', {
        teardownId,
        room: current.name,
        results: disableResults.map((result, index) => (
          result.status === 'fulfilled'
            ? { op: disableOps[index].op, status: result.status }
            : { op: disableOps[index].op, status: result.status, reason: toErrorMessage(result.reason) }
        )),
      })
    }

    const unpublishOps: Array<{ publication: Record<string, unknown>; promise: Promise<unknown> }> = []
    const videoPublications = Array.from(local.videoTrackPublications.values())
    const audioPublications = Array.from(local.audioTrackPublications.values())
    for (const publication of [...videoPublications, ...audioPublications]) {
      const publicationSummary = describeLocalPublication(publication)
      const publicationTrack = publication.track
      const track = publicationTrack as unknown as {
        stop?: () => void
        mediaStreamTrack?: MediaStreamTrack | null
        _mediaStreamTrack?: MediaStreamTrack | null
        sender?: { track?: MediaStreamTrack | null } | null
      } | null
      if (!track) {
        logScreenShare('local publication teardown skipped (no track)', {
          teardownId,
          room: current.name,
          publication: publicationSummary,
        })
        continue
      }
      const mediaVariants = getTrackMediaVariants(track)
      const beforeMediaTracks = mediaVariants.map(item => ({
        role: item.role,
        track: describeMediaTrack(item.track),
      }))
      try {
        if (publicationTrack) {
          unpublishOps.push({
            publication: publicationSummary,
            promise: Promise.resolve(local.unpublishTrack(publicationTrack, true)),
          })
        }
      } catch (err) {
        logScreenShare('local publication unpublish enqueue failed', {
          teardownId,
          room: current.name,
          publication: publicationSummary,
          error: toErrorMessage(err),
        })
      }
      try {
        track.stop?.()
      } catch (err) {
        logScreenShare('local track.stop() failed', {
          teardownId,
          room: current.name,
          publication: publicationSummary,
          error: toErrorMessage(err),
        })
      }
      for (const variant of mediaVariants) {
        try {
          variant.track.enabled = false
        } catch {
          // best effort
        }
        try {
          variant.track.stop()
        } catch (err) {
          logScreenShare('local media variant stop() failed', {
            teardownId,
            room: current.name,
            publication: publicationSummary,
            trackRole: variant.role,
            error: toErrorMessage(err),
          })
        }
      }
      logScreenShare('local publication teardown attempted', {
        teardownId,
        room: current.name,
        publication: publicationSummary,
        mediaTracksBefore: beforeMediaTracks,
        mediaTracksAfter: mediaVariants.map(item => ({
          role: item.role,
          track: describeMediaTrack(item.track),
        })),
      })
    }
    if (unpublishOps.length > 0) {
      const unpublishResults = await Promise.allSettled(unpublishOps.map(item => item.promise))
      logScreenShare('local publication unpublish settled', {
        teardownId,
        room: current.name,
        results: unpublishResults.map((result, index) => (
          result.status === 'fulfilled'
            ? { publication: unpublishOps[index].publication, status: result.status }
            : { publication: unpublishOps[index].publication, status: result.status, reason: toErrorMessage(result.reason) }
        )),
      })
    }
    await stopPublisherSenderTracks(current, teardownId)
    stopTrackedDisplayCaptureTracks(`stopAllLocalCaptureTracks:${teardownId}`)
    logLocalCaptureState(current, 'stopAllLocalCaptureTracks:end', { teardownId })
  }

  async function stopPublisherSenderTracks(current: Room, teardownId: string) {
    const publisher = (current as unknown as {
      engine?: { pcManager?: { publisher?: RTCPeerConnection } }
    }).engine?.pcManager?.publisher
    if (!publisher || typeof publisher.getSenders !== 'function') {
      logScreenShare('publisher senders unavailable', {
        teardownId,
        room: current.name,
      })
      return
    }

    const senders = publisher.getSenders()
    logScreenShare('publisher sender snapshot before stop', {
      teardownId,
      room: current.name,
      senderCount: senders.length,
      senders: senders.map((sender, index) => ({
        index,
        track: describeMediaTrack(sender.track ?? null),
      })),
    })

    const replaceOps: Array<{ index: number; kind: string; promise: Promise<void> }> = []
    for (const [index, sender] of senders.entries()) {
      const senderTrack = sender.track
      if (!senderTrack) continue
      const beforeTrack = describeMediaTrack(senderTrack)
      try {
        senderTrack.stop()
      } catch (err) {
        logScreenShare('publisher sender track.stop() failed', {
          teardownId,
          room: current.name,
          senderIndex: index,
          track: beforeTrack,
          error: toErrorMessage(err),
        })
      }
      try {
        replaceOps.push({
          index,
          kind: senderTrack.kind,
          promise: Promise.resolve(sender.replaceTrack(null)),
        })
      } catch (err) {
        logScreenShare('publisher sender replaceTrack(null) enqueue failed', {
          teardownId,
          room: current.name,
          senderIndex: index,
          track: beforeTrack,
          error: toErrorMessage(err),
        })
      }
      logScreenShare('publisher sender stop attempted', {
        teardownId,
        room: current.name,
        senderIndex: index,
        beforeTrack,
        afterTrack: describeMediaTrack(senderTrack),
      })
    }

    if (replaceOps.length > 0) {
      const replaceResults = await Promise.allSettled(replaceOps.map(item => item.promise))
      logScreenShare('publisher sender replaceTrack(null) settled', {
        teardownId,
        room: current.name,
        results: replaceResults.map((result, index) => (
          result.status === 'fulfilled'
            ? { senderIndex: replaceOps[index].index, kind: replaceOps[index].kind, status: result.status }
            : {
                senderIndex: replaceOps[index].index,
                kind: replaceOps[index].kind,
                status: result.status,
                reason: toErrorMessage(result.reason),
              }
        )),
      })
    }
  }

  async function requestJoinToken(conversationId: string, kind: 'dm' | 'channel', visibility: 'public' | 'private' | 'dm') {
    const ws = useWsStore()
    if (pendingJoinResolve || pendingJoinReject) {
      throw new Error('join token request already in flight')
    }
    callDebug('requesting join token', { conversationId, kind, visibility })

    const response = await new Promise<{
      livekitUrl: string
      livekitToken: string
      livekitRoom: string
      callId: string
      raisedHands: RaisedHand[]
    }>((resolve, reject) => {
      pendingJoinResolve = resolve
      pendingJoinReject = reject
      pendingJoinTimer = setTimeout(() => {
        clearPendingJoin()
        reject(new Error('Timed out waiting for join token'))
      }, JOIN_TOKEN_TIMEOUT_MS)
      pendingJoinRequestId = ws.sendJoinCallToken(conversationId, toConversationType(kind, visibility))
    })
    callDebug('join token received', {
      conversationId,
      room: response.livekitRoom,
      livekitUrl: response.livekitUrl,
      callId: response.callId,
    })

    return response
  }

  async function requestCreateCall(
    conversationId: string,
    kind: 'dm' | 'channel',
    visibility: 'public' | 'private' | 'dm',
    inviteeUserIds: string[],
  ) {
    const ws = useWsStore()
    if (pendingCreateCallResolve || pendingCreateCallReject) {
      throw new Error('create call request already in flight')
    }
    callDebug('requesting create call', { conversationId, kind, visibility, inviteeUserIds })

    await new Promise<void>((resolve, reject) => {
      pendingCreateCallResolve = resolve
      pendingCreateCallReject = reject
      pendingCreateCallTimer = setTimeout(() => {
        clearPendingCreateCall()
        reject(new Error('Timed out waiting for create call'))
      }, JOIN_TOKEN_TIMEOUT_MS)
      pendingCreateCallRequestId = ws.sendCreateCall(conversationId, toConversationType(kind, visibility), inviteeUserIds)
    })
  }

  function resolveActiveConversationType(): { kind: 'dm' | 'channel'; visibility: 'public' | 'private' | 'dm' } | null {
    const conversationId = activeConversationId.value
    if (!conversationId) return null
    const channel = chatStore.channels.find(item => item.id === conversationId)
    if (channel) {
      return {
        kind: 'channel',
        visibility: channel.visibility,
      }
    }
    const dm = chatStore.directMessages.find(item => item.id === conversationId)
    if (dm) {
      return {
        kind: 'dm',
        visibility: 'dm',
      }
    }
    return {
      kind: activeConversationKind.value,
      visibility: activeConversationVisibility.value,
    }
  }

  async function inviteMembersToActiveCall(userIds: string[]) {
    const ws = useWsStore()
    if (!activeConversationId.value) {
      throw new Error('No active conversation for call invite')
    }
    const conversationMeta = resolveActiveConversationType()
    if (!conversationMeta) {
      throw new Error('Unable to resolve active conversation type')
    }
    if (pendingInviteMembersResolve || pendingInviteMembersReject) {
      throw new Error('call invite request already in flight')
    }

    const response = await new Promise<{ callId: string; conversationId: string; invitedUserIds: string[]; skippedUserIds: string[] }>((resolve, reject) => {
      pendingInviteMembersResolve = resolve
      pendingInviteMembersReject = reject
      pendingInviteMembersTimer = setTimeout(() => {
        clearPendingInviteMembers()
        reject(new Error('Timed out waiting for call invite response'))
      }, INVITE_CALL_MEMBERS_TIMEOUT_MS)
      pendingInviteMembersRequestId = ws.sendInviteCallMembers(
        activeConversationId.value,
        toConversationType(conversationMeta.kind, conversationMeta.visibility),
        userIds,
      )
    })
    clearPendingInviteMembers()
    return {
      invitedUserIds: response.invitedUserIds,
      skippedUserIds: response.skippedUserIds,
    }
  }

  async function startOrJoinCall(args: {
    conversationId: string
    kind: 'dm' | 'channel'
    visibility: 'public' | 'private' | 'dm'
    inviteeUserIds?: string[]
    joinExistingOnly?: boolean
  }) {
    const ws = useWsStore()
    const { conversationId, kind, visibility } = args
    const inviteeUserIds = args.inviteeUserIds ?? []
    const joinExistingOnly = args.joinExistingOnly ?? false
    const audioPrefs = loadAudioPrefs()
    const currentActive = chatStore.activeCalls.find(call => call.conversationId === conversationId)
    callDebug('startOrJoinCall invoked', {
      conversationId,
      kind,
      visibility,
      inviteeUserIds,
      joinExistingOnly,
      joiningExistingCall: Boolean(currentActive),
    })
    activeConversationKind.value = kind
    activeConversationVisibility.value = visibility

    errorMessage.value = ''
    connecting.value = true
    localScreenShareUsedInSession = false
    clearEmptyCallAutoCloseTimer()

    try {
      if (!currentActive && !joinExistingOnly) {
        await requestCreateCall(conversationId, kind, visibility, inviteeUserIds)
      }

      const join = await requestJoinToken(conversationId, kind, visibility)
      if (join.callId) {
        chatStore.applyCallRaisedHandsSnapshot(join.callId, conversationId, join.raisedHands)
      }
      const normalizedLiveKitUrl = normalizeLiveKitUrl(join.livekitUrl)
      if (!join.livekitToken) {
        throw new Error('Join token response has empty livekitToken')
      }
      callDebug('join token normalized', {
        conversationId,
        requestedUrl: join.livekitUrl,
        resolvedUrl: normalizedLiveKitUrl,
        room: join.livekitRoom,
      })

      await ensureDisconnected()
      const canUseMediaDevices = hasGetUserMedia()

      const nextRoom = createRoom()
      room.value = nextRoom
      activeConversationId.value = conversationId
      activeRoomName.value = join.livekitRoom
      activeCallId.value = join.callId || (chatStore.activeCalls.find(call => call.conversationId === conversationId)?.id ?? '')

      callDebug('joining livekit room', {
        room: join.livekitRoom,
        livekitUrl: normalizedLiveKitUrl,
      })
      await withTimeout(
        nextRoom.connect(normalizedLiveKitUrl, join.livekitToken),
        JOIN_ROOM_CONNECT_TIMEOUT_MS,
        'Timed out while joining huddle',
      )

      // PCTransport.publisher accumulates one `.once('rtpVideoPayloadTypes')`
      // listener per negotiate() call (triggered by every replaceTrack and track
      // publish). The default EventEmitter limit is 10 — raise it to silence the
      // MaxListenersExceededWarning that appears during normal operation.
      try {
        const publisher = (nextRoom as unknown as {
          engine: { pcManager?: { publisher: { setMaxListeners(n: number): void } } }
        }).engine?.pcManager?.publisher
        publisher?.setMaxListeners(50)
      } catch { /* best effort */ }

      ensureRemoteTracksSubscribed(nextRoom)
      logLocalVideoPublications(nextRoom, 'after-connect')
      logRemoteVideoPublications(nextRoom, 'after-connect')
      if (canUseMediaDevices) {
        await nextRoom.startAudio()
        callDebug('startAudio resolved', {
          canPlaybackAudio: nextRoom.canPlaybackAudio,
        })
      } else {
        errorMessage.value = mediaUnavailableMessage()
      }
      playbackBlocked.value = !nextRoom.canPlaybackAudio
      connected.value = true
      remoteScreenShareReceiveEnabled.value = true
      remoteParticipantCount.value = nextRoom.remoteParticipants.size
      if (remoteParticipantCount.value === 0) {
        scheduleEmptyCallAutoClose()
      }
      mediaVersion.value += 1
      startRemoteAudioStatsLoop(nextRoom)
      micEnabled.value = false
      if (canUseMediaDevices && !audioPrefs.muteMicOnJoinCall) {
        try {
          await enableMicrophoneWithProcessing(nextRoom)
        } catch (err) {
          errorMessage.value = err instanceof Error
            ? err.message
            : 'Failed to enable microphone.'
          callDebug('microphone enable failed', {
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      cameraEnabled.value = false
      screenShareEnabled.value = false
      callDebug('call connected summary', {
        room: nextRoom.name,
        remoteParticipantCount: nextRoom.remoteParticipants.size,
        canPlaybackAudio: nextRoom.canPlaybackAudio,
      })
    } catch (err) {
      await ensureDisconnected()
      errorMessage.value = err instanceof Error ? err.message : 'Failed to join call'
      callDebug('startOrJoinCall failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    } finally {
      clearPendingJoin()
      connecting.value = false
    }
  }

  async function leaveCall() {
    console.info('[call-leave] leave requested', {
      connected: connected.value,
      room: room.value?.name ?? null,
      conversationId: activeConversationId.value || null,
      activeCallId: activeCallId.value || null,
      remoteParticipantCount: remoteParticipantCount.value,
    })
    await ensureDisconnected()
    if (platform?.type === 'tauri' && localScreenShareUsedInSession) {
      logScreenShare('requesting tauri app restart after screen share teardown', {
        reason: 'post-leave-screen-share-used',
      })
      localScreenShareUsedInSession = false
      try {
        await platform.system.invokeNative?.('request_app_restart')
      } catch (err) {
        logScreenShare('tauri app restart request failed', {
          error: toErrorMessage(err),
        })
      }
    }
  }

  async function resetRuntimeState() {
    await ensureDisconnected()
    clearAnnotationSession()
    clearCallReactions()
    localScreenShareUsedInSession = false
    clearPendingCreateCall()
    clearPendingInviteMembers()
    clearEmptyCallAutoCloseTimer()
    stopRemoteAudioStatsLoop()

    activeConversationId.value = ''
    activeConversationKind.value = 'channel'
    activeConversationVisibility.value = 'public'
    activeCallId.value = ''
    activeRoomName.value = ''
    connecting.value = false
    connected.value = false
    minimized.value = false
    micEnabled.value = false
    cameraEnabled.value = false
    screenShareEnabled.value = false
    remoteScreenShareReceiveEnabled.value = true
    remoteParticipantCount.value = 0
    handActionInFlight.value = false
    mediaVersion.value = 0
    activeSpeakerSids.value = new Set()
    playbackBlocked.value = false
    errorMessage.value = ''
    knownRemoteParticipantSids.clear()
    suppressParticipantChangeSounds = false
  }

  async function toggleMute() {
    const current = room.value
    if (!current) return
    const next = !micEnabled.value
    if (!hasGetUserMedia() && !micEnabled.value && next) {
      throw new Error(mediaUnavailableMessage())
    }
    // The AudioContext pipeline (RNNoise / gain) stays alive across mute/unmute.
    // setMicrophoneEnabled(false) calls _mediaStreamTrack.enabled = false which
    // silences the MediaStreamSource inside the AudioContext naturally.
    // setMicrophoneEnabled(true) re-enables the track and audio flows again.
    // Tearing down and rebuilding the pipeline on every mute/unmute would:
    //   1. Re-download rnnoise JS files and recompile the WASM worklet every time.
    //   2. Require replaceTrack() again, which has a race with LiveKit's own
    //      resumeUpstream() call, leaving the RTCRtpSender pointing at the wrong track.
    await current.localParticipant.setMicrophoneEnabled(next, next ? buildAudioCaptureOptions() : undefined)
    micEnabled.value = next
    callDebug('toggle mute', {
      enabled: next,
      room: current.name,
    })
  }

  async function toggleHandRaised() {
    if (handActionInFlight.value) return
    const callId = activeCallId.value || chatStore.activeCalls.find(call => call.conversationId === activeConversationId.value)?.id
    if (!callId || !connected.value) {
      throw new Error('Call is not connected')
    }

    handActionInFlight.value = true
    try {
      const response = await useWsStore().requestSetCallHandRaised(callId, !localHandRaised.value)
      activeCallId.value = response.callId
      chatStore.applyCallRaisedHandsSnapshot(response.callId, response.conversationId, response.raisedHands)
    } finally {
      handActionInFlight.value = false
    }
  }

  async function switchInputDevice(deviceId: string) {
    const normalizedDeviceId = deviceId.trim()
    console.info('[call-input-device] switchInputDevice called', {
      requestedDeviceId: normalizedDeviceId || 'default',
      connected: connected.value,
      micEnabled: micEnabled.value,
      hasRoom: Boolean(room.value),
    })
    persistInputDevicePreference(normalizedDeviceId)

    const current = room.value
    if (!current || !connected.value) {
      console.info('[call-input-device] switchInputDevice no-op: call is not connected')
      return
    }
    if (!micEnabled.value) {
      console.info('[call-input-device] switchInputDevice no-op: microphone is muted')
      return
    }
    if (!hasGetUserMedia()) {
      console.warn('[call-input-device] switchInputDevice blocked: getUserMedia unavailable')
      throw new Error(mediaUnavailableMessage())
    }

    callDebug('switch input device requested', {
      room: current.name,
      deviceId: normalizedDeviceId || 'default',
    })

    const local = current.localParticipant
    const previousPublication = local.getTrackPublication(Track.Source.Microphone)
    const previousTrack = previousPublication?.track ?? null
    console.info('[call-input-device] switching microphone track', {
      room: current.name,
      previousTrackSid: previousTrack?.sid ?? null,
      requestedDeviceId: normalizedDeviceId || 'default',
    })

    await local.setMicrophoneEnabled(false)
    micEnabled.value = false
    console.info('[call-input-device] microphone disabled before republish', {
      room: current.name,
    })
    if (previousTrack) {
      try {
        await Promise.resolve(local.unpublishTrack(previousTrack, true))
        console.info('[call-input-device] unpublished previous microphone track', {
          room: current.name,
          previousTrackSid: previousTrack.sid ?? null,
        })
      } catch (err) {
        console.warn('[call-input-device] failed to unpublish previous microphone track', {
          room: current.name,
          error: toErrorMessage(err),
        })
        callDebug('failed to unpublish previous microphone track', {
          room: current.name,
          error: toErrorMessage(err),
        })
      }
    }

    // Device changes require rebuilding the capture + processing pipeline so the
    // new source track becomes the one LiveKit publishes.
    audioProcessingCleanup?.()
    audioProcessingCleanup = null
    await enableMicrophoneWithProcessing(current)
    console.info('[call-input-device] switchInputDevice completed', {
      room: current.name,
      requestedDeviceId: normalizedDeviceId || 'default',
      micEnabled: micEnabled.value,
    })
  }

  async function toggleCamera() {
    const current = room.value
    if (!current) return
    if (!hasGetUserMedia()) {
      throw new Error(mediaUnavailableMessage())
    }
    const next = !cameraEnabled.value
    await current.localParticipant.setCameraEnabled(next)
    cameraEnabled.value = next
    callDebug('toggle camera', {
      enabled: next,
      room: current.name,
    })
  }

  async function toggleScreenShare() {
    const current = room.value
    if (!current) return
    if (!hasGetUserMedia()) {
      throw new Error(mediaUnavailableMessage())
    }
    const next = !screenShareEnabled.value
    const toggleId = `toggle-${Date.now()}-${++captureTeardownSeq}`
    logScreenShare('toggle requested', {
      toggleId,
      enabled: next,
      room: current.name,
    })
    logTrackedDisplayCaptureState('toggle:before', { toggleId, room: current.name, enabling: next })
    logLocalVideoPublications(current, 'before-toggle')
    try {
      if (next) {
        if (remoteScreenShareActive.value) {
          throw new Error('Another participant is already sharing their screen')
        }
        // Capture options: match fps to encoding target (avoids capturing 30 fps
        // only to drop to 15 at the encoder), and hint the encoder to preserve
        // spatial sharpness — critical for text, code, and UI content.
        const captureOptions: ScreenShareCaptureOptions = {
          // resolution.frameRate constrains getDisplayMedia capture fps to match
          // the encoding target — avoids capturing 30 fps only to discard half.
          resolution: { ...ScreenSharePresets.h1080fps15.resolution, frameRate: 15 },
          contentHint: 'detail',
        }
        // Publish options: VP9 gives ~40% better quality than VP8 at the same
        // bitrate for screen content (sharp edges, text). VP8 fallback ensures
        // compatibility with any receiver that doesn't support VP9.
        // simulcast is disabled: for text/UI a single high-quality layer is
        // preferable — the lower simulcast layer (~960×540) degrades text
        // legibility and adaptiveStream already handles receiver-side adaptation.
        const publishOptions: TrackPublishOptions = {
          videoCodec: 'vp9',
          backupCodec: { codec: 'vp8' },
          screenShareEncoding: ScreenSharePresets.h1080fps15.encoding,
          simulcast: false,
        }
        await current.localParticipant.setScreenShareEnabled(true, captureOptions, publishOptions)
        localScreenShareUsedInSession = true
        const capture = resolveLocalShareCaptureContext(current)
        await publishLocalAnnotationSessionUpdate(true, capture.shareType, capture.shareLabel)
        trackLocalScreenCapturePublications(current, 'toggle:on:after-set-enabled', { toggleId })
      } else {
        await current.localParticipant.setScreenShareEnabled(false)
        await publishLocalAnnotationSessionUpdate(false, 'unknown', '')
        trackLocalScreenCapturePublications(current, 'toggle:off:after-set-disabled', { toggleId })
        stopTrackedDisplayCaptureTracks(`toggle:off:${toggleId}`)
      }
    } catch (err) {
      logScreenShare('toggle failed', {
        toggleId,
        room: current.name,
        enabled: next,
        error: toErrorMessage(err),
      })
      throw err
    }
    screenShareEnabled.value = next
    logLocalVideoPublications(current, 'after-toggle')
    logRemoteVideoPublications(current, 'after-toggle')
    logTrackedDisplayCaptureState('toggle:after', { toggleId, room: current.name, enabled: next })
    callDebug('toggle screen share', {
      enabled: next,
      room: current.name,
    })
  }

  function stopRemoteScreenShareForMe() {
    const current = room.value
    remoteScreenShareReceiveEnabled.value = false
    if (current) {
      syncRemoteTrackSubscriptions(current, 'viewer-stop-remote-screen-share')
    }
  }

  function startRemoteScreenShareForMe() {
    const current = room.value
    remoteScreenShareReceiveEnabled.value = true
    if (current) {
      syncRemoteTrackSubscriptions(current, 'viewer-start-remote-screen-share')
    }
  }

  async function publishScreenAnnotationSegment(segment: ScreenAnnotationSegmentV1): Promise<boolean> {
    const current = room.value
    if (!current) return false
    if (screenShareEnabled.value) return false
    if (!annotationAvailable.value) return false

    const localIdentity = current.localParticipant.identity?.trim() || segment.senderIdentity.trim()
    if (!localIdentity) return false
    const payload: ScreenAnnotationSegmentV1 = {
      version: 1,
      kind: 'segment',
      shareTrackSid: segment.shareTrackSid.trim(),
      senderIdentity: localIdentity,
      strokeId: segment.strokeId.trim(),
      seq: segment.seq,
      from: segment.from,
      to: segment.to,
      sentAtMs: Number.isFinite(segment.sentAtMs) ? segment.sentAtMs : Date.now(),
    }
    if (!payload.shareTrackSid || !payload.strokeId) return false
    if (!isFinitePoint(payload.from) || !isFinitePoint(payload.to)) return false
    if (!Number.isInteger(payload.seq) || payload.seq < 0) return false

    await publishAnnotationPacket(payload)
    return true
  }

  async function enableAudioPlayback() {
    const current = room.value
    if (!current) return
    callDebug('enableAudioPlayback requested')
    await current.startAudio()
    playbackBlocked.value = !current.canPlaybackAudio
    callDebug('enableAudioPlayback resolved', {
      canPlaybackAudio: current.canPlaybackAudio,
    })
  }

  function localVideoTrack(): LocalVideoTrack | null {
    const current = room.value
    if (!current) return null
    const pub = current.localParticipant.getTrackPublication(Track.Source.Camera)
    if (pub?.track && pub.track.kind === 'video') return pub.track as LocalVideoTrack
    return null
  }

  function localScreenShareTrack(): LocalVideoTrack | null {
    const current = room.value
    if (!current) return null
    const pub = current.localParticipant.getTrackPublication(Track.Source.ScreenShare)
    if (pub?.track && pub.track.kind === 'video') return pub.track as LocalVideoTrack
    return null
  }

  function toggleMinimized() {
    minimized.value = !minimized.value
  }

  watch([remoteScreenShareActive, screenShareEnabled], ([remoteActive, localSharing]) => {
    if (localSharing || remoteActive) return
    clearAnnotationSession()
  })

  function registerWsHandlers() {
    const ws = useWsStore()
    ws.onJoinCallTokenResponse((resp, requestId) => {
      if (pendingJoinRequestId && requestId !== pendingJoinRequestId) return
      callDebug('ws joinCallTokenResponse', {
        room: resp.livekitRoom,
        livekitUrl: resp.livekitUrl,
      })
      if (pendingJoinResolve) {
        pendingJoinResolve(resp)
      }
      clearPendingJoin()
    })
    ws.onCreateCallResponse((resp, requestId) => {
      if (pendingCreateCallRequestId && requestId !== pendingCreateCallRequestId) return
      callDebug('ws createCallResponse', resp)
      if (pendingCreateCallResolve) {
        pendingCreateCallResolve()
      }
      clearPendingCreateCall()
    })
    ws.onProtocolError((err) => {
      if (pendingCreateCallRequestId && err.requestId === pendingCreateCallRequestId) {
        if (err.code === ErrorCode.CALL_ALREADY_ACTIVE) {
          if (pendingCreateCallResolve) {
            pendingCreateCallResolve()
          }
          clearPendingCreateCall()
          return
        }
        const message = err.message || 'Failed to start call'
        if (pendingCreateCallReject) {
          pendingCreateCallReject(new Error(message))
        }
        clearPendingCreateCall()
        return
      }
      if (pendingJoinRequestId && err.requestId === pendingJoinRequestId) {
        const message = err.code === ErrorCode.CALL_NOT_ACTIVE
          ? 'Call is no longer active'
          : (err.message || 'Failed to join call')
        if (pendingJoinReject) {
          pendingJoinReject(new Error(message))
        }
        clearPendingJoin()
        return
      }
      if (!pendingInviteMembersRequestId) return
      if (err.requestId !== pendingInviteMembersRequestId) return
      const message = err.code === ErrorCode.CALL_NOT_ACTIVE
        ? 'Call is no longer active'
        : (err.message || 'Failed to invite members')
      if (pendingInviteMembersReject) {
        pendingInviteMembersReject(new Error(message))
      }
      clearPendingInviteMembers()
    })
    ws.onInviteCallMembersResponse((resp, requestId) => {
      if (!pendingInviteMembersRequestId) return
      if (requestId !== pendingInviteMembersRequestId) return
      callDebug('ws inviteCallMembersResponse', resp)
      if (pendingInviteMembersResolve) {
        pendingInviteMembersResolve(resp)
      }
      clearPendingInviteMembers()
    })
    ws.onCallInviteActionAck((resp) => {
      callDebug('ws callInviteActionAck', resp)
      // call invite actions are currently handled by chat state fanout.
    })
  }

  function syncWithActiveCalls() {
    if (!activeConversationId.value) return
    const conversationKnownInSidebar = chatStore.channels.some(channel => channel.id === activeConversationId.value)
      || chatStore.directMessages.some(dm => dm.id === activeConversationId.value)
    if (!conversationKnownInSidebar) return
    const stillActive = chatStore.activeCalls.some(call => call.conversationId === activeConversationId.value)
    if (!stillActive) {
      callDebug('active call missing from chat store, leaving room', {
        conversationId: activeConversationId.value,
      })
      void leaveCall()
    }
  }

  watch([connected, activeCallId, micEnabled, activeConversationTitle], () => {
    void syncHardwareCallControls()
  }, { immediate: true })

  return {
    room,
    activeConversationId,
    activeCallId,
    activeRoomName,
    activeConversationTitle,
    connecting,
    connected,
    minimized,
    micEnabled,
    cameraEnabled,
    screenShareEnabled,
    remoteScreenShareReceiveEnabled,
    annotationSessionState,
    reactionsByParticipantId,
    annotationAvailable,
    annotationDisabledReason,
    annotationSessionMode,
    remoteScreenShareActive,
    remoteParticipantCount,
    raisedHands,
    localHandRaised,
    handActionInFlight,
    mediaVersion,
    activeSpeakerSids,
    playbackBlocked,
    errorMessage,
    startOrJoinCall,
    inviteMembersToActiveCall,
    leaveCall,
    resetRuntimeState,
    toggleMute,
    toggleHandRaised,
    switchInputDevice,
    toggleCamera,
    toggleScreenShare,
    sendCallReaction,
    stopRemoteScreenShareForMe,
    startRemoteScreenShareForMe,
    publishScreenAnnotationSegment,
    onScreenAnnotation,
    ingestScreenAnnotationPacket,
    ingestCallReactionPacket,
    clearCallReaction,
    clearCallReactions,
    enableAudioPlayback,
    localVideoTrack,
    localScreenShareTrack,
    toggleMinimized,
    registerWsHandlers,
    syncWithActiveCalls,
  }
})
