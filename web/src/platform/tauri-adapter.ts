import type {
  AppNotificationOptions,
  HardwareCallControlAction,
  HardwareCallControlHandlers,
  HardwareCallControlState,
  PlatformAdapter,
} from '@/platform/types'
import { normalizeNotificationPermission } from '@/platform/types'
import { useNotificationSoundEngine } from '@/services/sound'
import { PwaAdapter } from '@/platform/pwa-adapter'

type TauriNotificationBridge = {
  isPermissionGranted?: () => Promise<boolean>
  requestPermission?: () => Promise<string>
  sendNotification?: (options: { title: string; body: string; icon?: string }) => Promise<void> | void
}

type TauriUpdaterBridge = {
  check?: () => Promise<
    | {
        version?: string
        downloadAndInstall?: () => Promise<void>
      }
    | null
  >
}

type TauriWindowHandle = {
  minimize?: () => Promise<void>
  close?: () => Promise<void>
  setFocus?: () => Promise<void>
  isVisible?: () => Promise<boolean>
}

type TauriWindowBridge = {
  getCurrentWindow?: () => TauriWindowHandle
}

type TauriEventBridge = {
  listen?: <T = unknown>(
    event: string,
    handler: (event: { payload: T }) => void,
  ) => Promise<() => void> | (() => void)
}

type TauriBridge = {
  core?: {
    invoke?: <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>
  }
  notification?: TauriNotificationBridge
  updater?: TauriUpdaterBridge
  window?: TauriWindowBridge
  event?: TauriEventBridge
}

type TauriInternalsBridge = {
  invoke?: <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>
}

function tauriBridge(): TauriBridge {
  if (typeof window === 'undefined') return {}
  const win = window as Window & {
    __TAURI__?: TauriBridge
    __TAURI_INTERNALS__?: TauriInternalsBridge
  }
  if (win.__TAURI__) return win.__TAURI__
  if (win.__TAURI_INTERNALS__?.invoke) {
    return {
      core: {
        invoke: win.__TAURI_INTERNALS__.invoke,
      },
    }
  }
  return {}
}

async function invokeNative<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> {
  const bridge = tauriBridge()
  const invoke = bridge.core?.invoke
  if (typeof invoke !== 'function') {
    throw new Error('Tauri invoke bridge is unavailable.')
  }
  return invoke<T>(command, args)
}

function encodeBase64(bytes: Uint8Array): string {
  const maybeBuffer = (globalThis as {
    Buffer?: {
      from(data: Uint8Array): { toString(encoding: 'base64'): string }
    }
  }).Buffer

  if (typeof btoa !== 'function' && maybeBuffer) {
    return maybeBuffer.from(bytes).toString('base64')
  }

  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const slice = bytes.subarray(index, index + chunkSize)
    binary += String.fromCharCode(...slice)
  }
  return btoa(binary)
}

async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') {
    return new Uint8Array(await blob.arrayBuffer())
  }
  return new Uint8Array(await new Response(blob).arrayBuffer())
}

export class TauriAdapter implements PlatformAdapter {
  readonly type = 'tauri' as const
  private readonly soundEngine = useNotificationSoundEngine()
  private readonly pwaFallback = new PwaAdapter()
  private callControlUnlisten: (() => void) | null = null

  notifications: PlatformAdapter['notifications'] = {
    requestPermission: async () => {
      const bridge = tauriBridge().notification
      try {
        if (bridge?.isPermissionGranted && await bridge.isPermissionGranted()) {
          return 'granted'
        }
        if (bridge?.requestPermission) {
          return normalizeNotificationPermission(await bridge.requestPermission())
        }
      } catch {
        // Fall through to invoke-based path.
      }

      // Fallback for release builds where __TAURI__.notification bridge is not injected.
      try {
        const alreadyGranted = await invokeNative<boolean | null>('plugin:notification|is_permission_granted')
        if (alreadyGranted === true) {
          return 'granted'
        }
        const result = await invokeNative<string>('plugin:notification|request_permission')
        return normalizeNotificationPermission(result)
      } catch {
        // Fall through to browser Notification API.
      }

      try {
        if (typeof Notification !== 'undefined' && typeof Notification.requestPermission === 'function') {
          return normalizeNotificationPermission(await Notification.requestPermission())
        }
      } catch {
        // Fall through to denied.
      }
      return 'denied'
    },
    show: async (options: AppNotificationOptions) => {
      const bridge = tauriBridge().notification
      try {
        if (bridge?.sendNotification) {
          await bridge.sendNotification({
            title: options.title,
            body: options.body,
            icon: options.icon,
          })
          return
        }
      } catch {
        // Fall through to invoke fallback.
      }

      try {
        await invokeNative('plugin:notification|notify', {
          options: {
            title: options.title,
            body: options.body,
            icon: options.icon,
          },
        })
        return
      } catch {
        // Fall through to app command fallback.
      }

      try {
        await invokeNative('show_notification', {
          title: options.title,
          body: options.body,
          icon: options.icon,
        })
      } catch {
        // Best effort.
      }
    },
    setBadge: async (count: number) => {
      try {
        await invokeNative('set_badge_count', { count: Math.max(0, Math.floor(count)) })
      } catch {
        // Best effort.
      }
    },
    clearBadge: async () => {
      try {
        await invokeNative('set_badge_count', { count: 0 })
      } catch {
        // Best effort.
      }
    },
    playSound: async (soundId: string) => {
      let nativeHandled = false
      try {
        nativeHandled = await invokeNative<boolean>('play_sound', { soundId })
      } catch {
        nativeHandled = false
      }
      if (nativeHandled) return

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
    setTrayTitle: async (title: string) => {
      await invokeNative('set_tray_title', { title })
    },
    setTrayTooltip: async (tooltip: string) => {
      await invokeNative('set_tray_tooltip', { tooltip })
    },
    checkForUpdates: async () => {
      const updater = tauriBridge().updater
      try {
        if (!updater?.check) {
          return { updated: false }
        }
        const update = await updater.check()
        if (!update?.downloadAndInstall) {
          return { updated: false }
        }
        await update.downloadAndInstall()
        return { updated: true, version: update.version }
      } catch (error) {
        return {
          updated: false,
          error: error instanceof Error ? error.message : 'Failed to check for updates.',
        }
      }
    },
    invokeNative: async <T>(command: string, args?: Record<string, unknown>) => invokeNative<T>(command, args),
    openExternalUrl: async (url: string) => {
      await invokeNative('open_external_url', { url })
    },
  }

  window: PlatformAdapter['window'] = {
    minimize: async () => {
      await tauriBridge().window?.getCurrentWindow?.().minimize?.()
    },
    close: async () => {
      await tauriBridge().window?.getCurrentWindow?.().close?.()
    },
    focus: async () => {
      await tauriBridge().window?.getCurrentWindow?.().setFocus?.()
    },
    isVisible: async () => {
      try {
        return await tauriBridge().window?.getCurrentWindow?.().isVisible?.() ?? true
      } catch {
        return true
      }
    },
    setCloseToTray: async (enabled: boolean) => {
      await invokeNative('set_close_to_tray', { enabled })
    },
  }

  storage: PlatformAdapter['storage'] = {
    getSecureItem: async (key: string) => invokeNative<string | null>('keyring_get', { key }),
    setSecureItem: async (key: string, value: string) => {
      await invokeNative('keyring_set', { key, value })
    },
    deleteSecureItem: async (key: string) => {
      await invokeNative('keyring_delete', { key })
    },
  }
  files: PlatformAdapter['files'] = {
    saveBlob: async ({ blob, suggestedName, mimeType }) => {
      if (typeof tauriBridge().core?.invoke !== 'function') {
        return this.pwaFallback.files.saveBlob({ blob, suggestedName, mimeType })
      }

      const bytes = await blobToBytes(blob)
      return invokeNative<{ saved: boolean }>('save_pdf_file', {
        suggestedName,
        mimeType: mimeType || blob.type || 'application/pdf',
        base64: encodeBase64(bytes),
      })
    },
  }

  callControls: PlatformAdapter['callControls'] = {
    register: async (handlers: HardwareCallControlHandlers) => {
      await this.detachCallControlListener()
      // Keep Media Session enabled inside Tauri when WebView supports it, while
      // the native bridge covers desktop headset controls that WebView may miss.
      await this.pwaFallback.callControls?.register(handlers)

      const listen = tauriBridge().event?.listen
      if (typeof listen !== 'function') return

      const unlisten = await listen<{ action?: HardwareCallControlAction; muted?: boolean }>('hardware-call-control', (event) => {
        const action = event.payload?.action
        if (action === 'hangup') {
          void handlers.onHangup()
          return
        }
        if (action === 'toggle-microphone') {
          void handlers.onToggleMicrophone()
          return
        }
        if (action === 'set-microphone-muted' && typeof event.payload?.muted === 'boolean') {
          void handlers.onSetMicrophoneMuted?.(event.payload.muted)
        }
      })
      this.callControlUnlisten = unlisten
    },
    update: async (state: HardwareCallControlState) => {
      await this.pwaFallback.callControls?.update(state)
      try {
        await invokeNative('call_controls_set_active', {
          title: state.title || 'Msgnr call',
          microphoneActive: state.microphoneActive,
        })
      } catch {
        // Native headset hooks are best effort; the in-app controls remain authoritative.
      }
    },
    dispose: async () => {
      await this.detachCallControlListener()
      await this.pwaFallback.callControls?.dispose()
      try {
        await invokeNative('call_controls_clear')
      } catch {
        // Best effort.
      }
    },
  }

  lifecycle: PlatformAdapter['lifecycle'] = {
    init: async () => {
      await this.window.setCloseToTray?.(true)
    },
    dispose: async () => {
      // No-op for now.
    },
  }

  private async detachCallControlListener() {
    const unlisten = this.callControlUnlisten
    this.callControlUnlisten = null
    if (!unlisten) return
    try {
      unlisten()
    } catch {
      // Listener disposal is best effort.
    }
  }
}
