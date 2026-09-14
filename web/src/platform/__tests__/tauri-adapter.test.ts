import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/sound', () => ({
  useNotificationSoundEngine: () => ({
    playMessagePing: vi.fn(),
    playCallMemberJoined: vi.fn(),
    playCallMemberLeft: vi.fn(),
  }),
}))

describe('TauriAdapter files.saveBlob', () => {
  beforeEach(() => {
    ;(window as Window & { __TAURI__?: unknown }).__TAURI__ = undefined
    ;(window as Window & { __TAURI_INTERNALS__?: { invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__ = undefined
  })

  it('returns a clean cancel result when native save is dismissed', async () => {
    const invoke = vi.fn(async () => ({ saved: false }))
    ;(window as Window & { __TAURI_INTERNALS__?: { invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__ = { invoke }

    const { TauriAdapter } = await import('@/platform/tauri-adapter')
    const adapter = new TauriAdapter()
    const result = await adapter.files.saveBlob({
      blob: new Blob(['pdf'], { type: 'application/pdf' }),
      suggestedName: 'TASK-1.pdf',
      mimeType: 'application/pdf',
    })

    expect(result).toEqual({ saved: false })
    expect(invoke).toHaveBeenCalledWith('save_pdf_file', expect.objectContaining({
      suggestedName: 'TASK-1.pdf',
    }))
  })
})

describe('TauriAdapter callControls', () => {
  beforeEach(() => {
    ;(window as Window & { __TAURI__?: unknown }).__TAURI__ = undefined
    ;(window as Window & { __TAURI_INTERNALS__?: { invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__ = undefined
  })

  it('bridges native hardware call-control events into registered handlers', async () => {
    const listeners = new Map<string, (event: { payload: unknown }) => void>()
    const invoke = vi.fn(async () => null)
    const unlisten = vi.fn()
    const listen = vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
      listeners.set(event, handler)
      return unlisten
    })
    ;(window as Window & { __TAURI__?: unknown }).__TAURI__ = {
      core: { invoke },
      event: { listen },
    }

    const { TauriAdapter } = await import('@/platform/tauri-adapter')
    const adapter = new TauriAdapter()
    const onHangup = vi.fn()
    const onToggleMicrophone = vi.fn()
    const onSetMicrophoneMuted = vi.fn()

    await adapter.callControls?.register({ onHangup, onToggleMicrophone, onSetMicrophoneMuted })
    listeners.get('hardware-call-control')?.({ payload: { action: 'hangup' } })
    listeners.get('hardware-call-control')?.({ payload: { action: 'toggle-microphone' } })
    listeners.get('hardware-call-control')?.({ payload: { action: 'set-microphone-muted', muted: true } })
    await adapter.callControls?.update({
      microphoneActive: true,
      title: 'General',
    })
    await adapter.callControls?.dispose()

    expect(listen).toHaveBeenCalledWith('hardware-call-control', expect.any(Function))
    expect(onHangup).toHaveBeenCalledTimes(1)
    expect(onToggleMicrophone).toHaveBeenCalledTimes(1)
    expect(onSetMicrophoneMuted).toHaveBeenCalledWith(true)
    expect(invoke).toHaveBeenCalledWith('call_controls_set_active', {
      title: 'General',
      microphoneActive: true,
    })
    expect(invoke).toHaveBeenCalledWith('call_controls_clear', undefined)
    expect(unlisten).toHaveBeenCalledTimes(1)
  })
})
