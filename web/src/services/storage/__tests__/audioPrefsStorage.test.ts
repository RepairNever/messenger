import { beforeEach, describe, expect, it } from 'vitest'
import {
  loadAudioPrefs,
  saveAudioPrefs,
} from '@/services/storage/audioPrefsStorage'

describe('audioPrefsStorage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns defaults when nothing is stored', () => {
    expect(loadAudioPrefs()).toEqual({
      inputDeviceId: '',
      outputDeviceId: '',
      noiseSuppression: true,
      echoCancellation: true,
      autoGainControl: true,
      microphoneGain: 100,
      rnnoiseEnabled: true,
      muteMicOnJoinCall: false,
    })
  })

  it('stores and restores mute-mic-on-join with the rest of the audio prefs', () => {
    saveAudioPrefs({
      inputDeviceId: 'mic-1',
      outputDeviceId: 'speaker-1',
      noiseSuppression: false,
      echoCancellation: false,
      autoGainControl: false,
      microphoneGain: 125,
      rnnoiseEnabled: false,
      muteMicOnJoinCall: true,
    })

    expect(loadAudioPrefs()).toEqual({
      inputDeviceId: 'mic-1',
      outputDeviceId: 'speaker-1',
      noiseSuppression: false,
      echoCancellation: false,
      autoGainControl: false,
      microphoneGain: 125,
      rnnoiseEnabled: false,
      muteMicOnJoinCall: true,
    })
  })
})
