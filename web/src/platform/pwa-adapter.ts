import { normalizeNotificationPermission } from '@/platform/types'
import type {
  AppNotificationOptions,
  HardwareCallControlHandlers,
  HardwareCallControlState,
  PlatformAdapter,
} from '@/platform/types'
import { useNotificationSoundEngine } from '@/services/sound'

type BrowserMediaSessionAction = 'hangup' | 'togglemicrophone'

type BrowserMediaSession = {
  metadata?: MediaMetadata | null
  setActionHandler?: (
    action: BrowserMediaSessionAction,
    handler: ((details?: unknown) => void) | null,
  ) => void
  setMicrophoneActive?: (active: boolean) => void
}

function getBrowserMediaSession(): BrowserMediaSession | null {
  if (typeof navigator === 'undefined') return null
  const nav = navigator as Navigator & { mediaSession?: BrowserMediaSession }
  return nav.mediaSession ?? null
}

function setMediaSessionActionHandler(
  action: BrowserMediaSessionAction,
  handler: ((details?: unknown) => void) | null,
): boolean {
  const mediaSession = getBrowserMediaSession()
  if (typeof mediaSession?.setActionHandler !== 'function') return false
  try {
    mediaSession.setActionHandler(action, handler)
    return true
  } catch {
    return false
  }
}

function setMediaSessionMicrophoneActive(active: boolean) {
  const mediaSession = getBrowserMediaSession()
  if (typeof mediaSession?.setMicrophoneActive !== 'function') return
  try {
    mediaSession.setMicrophoneActive(active)
  } catch {
    // Best effort: some browsers expose the method before the action is usable.
  }
}

type SaveFilePickerWindow = Window & {
  showSaveFilePicker?: (options?: {
    suggestedName?: string
    excludeAcceptAllOption?: boolean
    types?: Array<{
      description?: string
      accept: Record<string, string[]>
    }>
  }) => Promise<{
    createWritable: () => Promise<{
      write: (data: Blob) => Promise<void>
      close: () => Promise<void>
    }>
  }>
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function downloadBlob(blob: Blob, suggestedName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = suggestedName
  a.click()
  URL.revokeObjectURL(url)
}

export class PwaAdapter implements PlatformAdapter {
  readonly type = 'pwa' as const
  private readonly soundEngine = useNotificationSoundEngine()
  private registeredCallControlActions = new Set<BrowserMediaSessionAction>()

  notifications: PlatformAdapter['notifications'] = {
    requestPermission: async () => {
      if (typeof window === 'undefined' || !('Notification' in window)) return 'denied'
      return normalizeNotificationPermission(await Notification.requestPermission())
    },
    show: async (options: AppNotificationOptions) => {
      if (typeof window === 'undefined' || !('Notification' in window)) return
      if (Notification.permission !== 'granted') return
      const notification = new Notification(options.title, {
        body: options.body,
        icon: options.icon,
        badge: options.badge,
        tag: options.tag,
        silent: options.silent,
      })
      if (options.onClick) {
        notification.onclick = () => {
          options.onClick?.()
          notification.close()
        }
      }
    },
    setBadge: async (count: number) => {
      if (typeof navigator === 'undefined') return
      const nav = navigator as Navigator & { setAppBadge?: (count?: number) => Promise<void> }
      if (typeof nav.setAppBadge !== 'function') return
      try {
        await nav.setAppBadge(Math.max(0, count))
      } catch {
        // Best effort.
      }
    },
    clearBadge: async () => {
      if (typeof navigator === 'undefined') return
      const nav = navigator as Navigator & { clearAppBadge?: () => Promise<void> }
      if (typeof nav.clearAppBadge !== 'function') return
      try {
        await nav.clearAppBadge()
      } catch {
        // Best effort.
      }
    },
    playSound: async (soundId: string) => {
      if (soundId === 'message-ping') {
        await this.soundEngine.playMessagePing()
        return
      }
      if (soundId === 'call-member-joined') {
        await this.soundEngine.playCallMemberJoined()
        return
      }
      if (soundId === 'call-member-left') {
        await this.soundEngine.playCallMemberLeft()
      }
    },
  }

  system: PlatformAdapter['system'] = {
    openExternalUrl: async (url: string) => {
      if (typeof window === 'undefined') return
      const opened = window.open(url, '_blank')
      if (!opened) return
      try {
        opened.opener = null
      } catch {
        // Ignore browsers that expose opener as read-only.
      }
    },
  }
  window: PlatformAdapter['window'] = {}
  storage: PlatformAdapter['storage'] = {}
  files: PlatformAdapter['files'] = {
    saveBlob: async ({ blob, suggestedName, mimeType }) => {
      if (typeof window !== 'undefined') {
        const pickerWindow = window as SaveFilePickerWindow
        if (typeof pickerWindow.showSaveFilePicker === 'function') {
          try {
            const handle = await pickerWindow.showSaveFilePicker({
              suggestedName,
              excludeAcceptAllOption: false,
              types: [{
                description: 'PDF document',
                accept: {
                  [mimeType || blob.type || 'application/pdf']: ['.pdf'],
                },
              }],
            })
            const writable = await handle.createWritable()
            await writable.write(blob)
            await writable.close()
            return { saved: true }
          } catch (error) {
            if (isAbortError(error)) {
              return { saved: false }
            }
          }
        }
      }

      downloadBlob(blob, suggestedName)
      return { saved: true }
    },
  }

  callControls: PlatformAdapter['callControls'] = {
    register: (handlers: HardwareCallControlHandlers) => {
      for (const action of this.registeredCallControlActions) {
        setMediaSessionActionHandler(action, null)
      }
      this.registeredCallControlActions.clear()

      if (setMediaSessionActionHandler('hangup', () => {
        void handlers.onHangup()
      })) {
        this.registeredCallControlActions.add('hangup')
      }

      if (setMediaSessionActionHandler('togglemicrophone', () => {
        void handlers.onToggleMicrophone()
      })) {
        this.registeredCallControlActions.add('togglemicrophone')
      }
    },
    update: (state: HardwareCallControlState) => {
      const mediaSession = getBrowserMediaSession()
      if (!mediaSession) return

      if (typeof MediaMetadata !== 'undefined') {
        try {
          mediaSession.metadata = new MediaMetadata({
            title: state.title || 'Msgnr call',
            artist: 'Msgnr',
          })
        } catch {
          // Metadata is only a hint for OS-level call controls.
        }
      }

      setMediaSessionMicrophoneActive(state.microphoneActive)
    },
    dispose: () => {
      for (const action of this.registeredCallControlActions) {
        setMediaSessionActionHandler(action, null)
      }
      this.registeredCallControlActions.clear()

      const mediaSession = getBrowserMediaSession()
      if (mediaSession) {
        try {
          mediaSession.metadata = null
        } catch {
          // Best effort.
        }
      }
      setMediaSessionMicrophoneActive(false)
    },
  }

  lifecycle: PlatformAdapter['lifecycle'] = {
    init: async () => {
      // Service worker lifecycle is handled by vite-plugin-pwa.
    },
    dispose: async () => {
      // No-op for browser runtime.
    },
  }
}
