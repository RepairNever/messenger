import { storage } from '@/services/storage/storageAdapter'

const KEY = 'msgnr:audio-prefs'

export interface AudioPrefs {
  inputDeviceId: string    // '' = system default
  outputDeviceId: string   // '' = system default
  noiseSuppression: boolean
  echoCancellation: boolean
  autoGainControl: boolean
  microphoneGain: number   // 0–400, 100 = unity (only active when autoGainControl is off)
  rnnoiseEnabled: boolean  // software noise suppression via RNNoise WASM AudioWorklet
  muteMicOnJoinCall: boolean
}

const DEFAULT_PREFS: AudioPrefs = {
  inputDeviceId: '',
  outputDeviceId: '',
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  microphoneGain: 100,
  rnnoiseEnabled: true,
  muteMicOnJoinCall: false,
}

function parseBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  return fallback
}

export function loadAudioPrefs(): AudioPrefs {
  try {
    const raw = storage.getItem(KEY)
    if (!raw) return { ...DEFAULT_PREFS }
    const parsed = JSON.parse(raw)
    return {
      inputDeviceId: typeof parsed.inputDeviceId === 'string' ? parsed.inputDeviceId : '',
      outputDeviceId: typeof parsed.outputDeviceId === 'string' ? parsed.outputDeviceId : '',
      noiseSuppression: parseBool(parsed.noiseSuppression, DEFAULT_PREFS.noiseSuppression),
      echoCancellation: parseBool(parsed.echoCancellation, DEFAULT_PREFS.echoCancellation),
      autoGainControl: parseBool(parsed.autoGainControl, DEFAULT_PREFS.autoGainControl),
      microphoneGain: (typeof parsed.microphoneGain === 'number' && parsed.microphoneGain >= 0 && parsed.microphoneGain <= 400)
        ? parsed.microphoneGain
        : DEFAULT_PREFS.microphoneGain,
      rnnoiseEnabled: parseBool(parsed.rnnoiseEnabled, DEFAULT_PREFS.rnnoiseEnabled),
      muteMicOnJoinCall: parseBool(parsed.muteMicOnJoinCall, DEFAULT_PREFS.muteMicOnJoinCall),
    }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

export function saveAudioPrefs(prefs: AudioPrefs): void {
  storage.setItem(KEY, JSON.stringify(prefs))
}
