import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HtmlAudioSoundEngine } from '@/services/sound/htmlAudioSoundEngine'
import type { AudioPrefs } from '@/services/storage/audioPrefsStorage'
import * as audioPrefsStorage from '@/services/storage/audioPrefsStorage'

const DEFAULT_AUDIO_PREFS: AudioPrefs = {
  inputDeviceId: '',
  outputDeviceId: '',
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  microphoneGain: 100,
  rnnoiseEnabled: true,
  muteMicOnJoinCall: false,
}

describe('HtmlAudioSoundEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(audioPrefsStorage, 'loadAudioPrefs').mockReturnValue({ ...DEFAULT_AUDIO_PREFS })
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('throttles message ping playback by cooldown', async () => {
    const playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play')
    const engine = new HtmlAudioSoundEngine(2_000)

    await engine.playMessagePing()
    await engine.playMessagePing()

    expect(playSpy).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(2_000)
    await engine.playMessagePing()

    expect(playSpy).toHaveBeenCalledTimes(2)
  })

  it('starts call ring once, then stops and disposes', async () => {
    const playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play')
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause')
    const loadSpy = vi.spyOn(HTMLMediaElement.prototype, 'load')

    const engine = new HtmlAudioSoundEngine()

    await engine.startCallInviteRing()
    await engine.startCallInviteRing()

    expect(playSpy).toHaveBeenCalledTimes(1)

    engine.stopCallInviteRing()
    expect(pauseSpy).toHaveBeenCalledTimes(1)

    pauseSpy.mockClear()
    engine.dispose()
    expect(pauseSpy).toHaveBeenCalledTimes(1)
    expect(loadSpy).toHaveBeenCalledTimes(1)
  })

  it('plays member join/leave sounds as one-shot effects', async () => {
    const playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play')
    const engine = new HtmlAudioSoundEngine()

    await engine.playCallMemberJoined()
    await engine.playCallMemberLeft()

    expect(playSpy).toHaveBeenCalledTimes(2)
  })
})
