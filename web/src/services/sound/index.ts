import { HtmlAudioSoundEngine } from '@/services/sound/htmlAudioSoundEngine'
import type { SoundEngine } from '@/services/sound/types'

let singleton: SoundEngine | null = null

export function useNotificationSoundEngine(): SoundEngine {
  if (!singleton) {
    singleton = new HtmlAudioSoundEngine()
  }
  return singleton
}
