import { loadAudioPrefs } from '@/services/storage/audioPrefsStorage'
import type { SoundEngine } from '@/services/sound/types'

const MESSAGE_PING_SRC = '/sounds/message-ping.wav'
const CALL_INVITE_RING_SRC = '/sounds/call-invite.wav'
const CALL_MEMBER_JOINED_SRC = '/sounds/call-member-joined.wav'
const CALL_MEMBER_LEFT_SRC = '/sounds/call-member-left.wav'
const DEFAULT_MESSAGE_COOLDOWN_MS = 2_000

export class HtmlAudioSoundEngine implements SoundEngine {
  private readonly messageCooldownMs: number
  private lastMessageAt = 0
  private callInviteAudio: HTMLAudioElement | null = null
  private callInvitePlaying = false

  constructor(messageCooldownMs = DEFAULT_MESSAGE_COOLDOWN_MS) {
    this.messageCooldownMs = messageCooldownMs
  }

  async playMessagePing(): Promise<void> {
    const now = Date.now()
    if (now - this.lastMessageAt < this.messageCooldownMs) return
    this.lastMessageAt = now

    await this.playOneShot(MESSAGE_PING_SRC)
  }

  async playCallMemberJoined(): Promise<void> {
    await this.playOneShot(CALL_MEMBER_JOINED_SRC)
  }

  async playCallMemberLeft(): Promise<void> {
    await this.playOneShot(CALL_MEMBER_LEFT_SRC)
  }

  async startCallInviteRing(): Promise<void> {
    if (!this.callInviteAudio) {
      this.callInviteAudio = this.createAudio(CALL_INVITE_RING_SRC, true)
    }
    if (this.callInvitePlaying) return
    this.callInvitePlaying = true

    try {
      await this.routeToPreferredOutput(this.callInviteAudio)
      await this.callInviteAudio.play()
    } catch {
      this.callInvitePlaying = false
      // Best effort: autoplay/output routing may be blocked by browser policy.
    }
  }

  stopCallInviteRing(): void {
    if (!this.callInviteAudio) return
    this.callInvitePlaying = false
    this.callInviteAudio.pause()
    this.callInviteAudio.currentTime = 0
  }

  dispose(): void {
    this.stopCallInviteRing()
    if (!this.callInviteAudio) return
    this.callInviteAudio.src = ''
    this.callInviteAudio.load()
    this.callInviteAudio = null
  }

  private createAudio(src: string, loop: boolean): HTMLAudioElement {
    const audio = new Audio(src)
    audio.loop = loop
    audio.preload = 'auto'
    return audio
  }

  private async playOneShot(src: string): Promise<void> {
    const audio = this.createAudio(src, false)
    try {
      await this.routeToPreferredOutput(audio)
      // Best effort: play() can fail with NotAllowedError until the page
      // receives a user gesture (browser autoplay policy).
      await audio.play()
    } catch {
      // Best effort: autoplay/output routing may be blocked by browser policy.
    }
  }

  private async routeToPreferredOutput(audio: HTMLAudioElement): Promise<void> {
    const sinkable = audio as HTMLAudioElement & {
      setSinkId?: (id: string) => Promise<void>
    }
    if (typeof sinkable.setSinkId !== 'function') return

    const outputDeviceId = loadAudioPrefs().outputDeviceId
    if (!outputDeviceId) return

    try {
      await sinkable.setSinkId(outputDeviceId)
    } catch {
      // Device may be gone or unsupported; fall back to default output.
    }
  }
}
