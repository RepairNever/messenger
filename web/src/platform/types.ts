export type PlatformType = 'pwa' | 'tauri'

export type AppNotificationPermission = 'granted' | 'denied' | 'default'

export function normalizeNotificationPermission(
  result: NotificationPermission | string,
): AppNotificationPermission {
  if (result === 'granted' || result === 'denied' || result === 'default') return result
  if (result === 'prompt' || result === 'prompt-with-rationale') return 'default'
  return 'default'
}

export interface AppNotificationOptions {
  title: string
  body: string
  icon?: string
  badge?: string
  tag?: string
  conversationId?: string
  url?: string
  silent?: boolean
  onClick?: () => void
}

export interface SaveBlobOptions {
  blob: Blob
  suggestedName: string
  mimeType?: string
}

export type HardwareCallControlAction = 'hangup' | 'toggle-microphone' | 'set-microphone-muted'

export interface HardwareCallControlHandlers {
  onHangup(): Promise<void> | void
  onToggleMicrophone(): Promise<void> | void
  onSetMicrophoneMuted?(muted: boolean): Promise<void> | void
}

export interface HardwareCallControlState {
  microphoneActive: boolean
  title?: string
}

export interface PlatformAdapter {
  readonly type: PlatformType

  notifications: {
    requestPermission(): Promise<AppNotificationPermission>
    show(options: AppNotificationOptions): Promise<void>
    setBadge(count: number): Promise<void>
    clearBadge(): Promise<void>
    playSound?(soundId: string): Promise<void> | void
  }

  system: {
    setTrayTitle?(title: string): Promise<void> | void
    setTrayIcon?(icon: string): Promise<void> | void
    setTrayTooltip?(tooltip: string): Promise<void> | void
    showTrayBalloon?(title: string, body: string): Promise<void> | void
    getAutoLaunch?(): Promise<boolean>
    setAutoLaunch?(enabled: boolean): Promise<void>
    checkForUpdates?(): Promise<{ updated: boolean; version?: string; error?: string }>
    invokeNative?<T>(command: string, args?: Record<string, unknown>): Promise<T>
    openExternalUrl?(url: string): Promise<void> | void
  }

  window: {
    minimize?(): Promise<void> | void
    close?(): Promise<void> | void
    focus?(): Promise<void> | void
    isVisible?(): Promise<boolean> | boolean
    setCloseToTray?(enabled: boolean): Promise<void> | void
  }

  storage: {
    getSecureItem?(key: string): Promise<string | null>
    setSecureItem?(key: string, value: string): Promise<void>
    deleteSecureItem?(key: string): Promise<void>
  }

  files: {
    saveBlob(options: SaveBlobOptions): Promise<{ saved: boolean }>
  }

  callControls?: {
    register(handlers: HardwareCallControlHandlers): Promise<void> | void
    update(state: HardwareCallControlState): Promise<void> | void
    dispose(): Promise<void> | void
  }

  lifecycle: {
    init(): Promise<void>
    dispose(): Promise<void>
  }
}
