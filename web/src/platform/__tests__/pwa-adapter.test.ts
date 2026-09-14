import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PwaAdapter } from '@/platform/pwa-adapter'

describe('PwaAdapter files.saveBlob', () => {
  const originalCreateElement = document.createElement.bind(document)

  beforeEach(() => {
    delete (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker
  })

  it('uses the save picker when available', async () => {
    const write = vi.fn(async () => {})
    const close = vi.fn(async () => {})
    const createWritable = vi.fn(async () => ({ write, close }))
    const showSaveFilePicker = vi.fn(async () => ({ createWritable }))
    ;(window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker = showSaveFilePicker

    const adapter = new PwaAdapter()
    const result = await adapter.files.saveBlob({
      blob: new Blob(['pdf'], { type: 'application/pdf' }),
      suggestedName: 'TASK-1.pdf',
      mimeType: 'application/pdf',
    })

    expect(result).toEqual({ saved: true })
    expect(showSaveFilePicker).toHaveBeenCalledWith(expect.objectContaining({
      suggestedName: 'TASK-1.pdf',
    }))
    expect(write).toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
  })

  it('falls back to browser download when no picker exists', async () => {
    const click = vi.fn()
    const anchor = {
      href: '',
      download: '',
      click,
    }
    const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
      if (tagName === 'a') {
        return anchor as unknown as HTMLAnchorElement
      }
      return originalCreateElement(tagName)
    }) as typeof document.createElement)

    const adapter = new PwaAdapter()
    const result = await adapter.files.saveBlob({
      blob: new Blob(['pdf'], { type: 'application/pdf' }),
      suggestedName: 'TASK-1.pdf',
      mimeType: 'application/pdf',
    })

    expect(result).toEqual({ saved: true })
    expect(anchor.download).toBe('TASK-1.pdf')
    expect(click).toHaveBeenCalledTimes(1)
    createElementSpy.mockRestore()
  })
})

describe('PwaAdapter callControls', () => {
  const originalMediaMetadata = globalThis.MediaMetadata

  beforeEach(() => {
    Object.defineProperty(navigator, 'mediaSession', {
      configurable: true,
      value: undefined,
    })
    ;(globalThis as typeof globalThis & { MediaMetadata?: typeof MediaMetadata }).MediaMetadata = originalMediaMetadata
  })

  it('registers hangup and microphone handlers with Media Session', async () => {
    const handlers = new Map<string, ((details?: unknown) => void) | null>()
    const mediaSession = {
      metadata: null as MediaMetadata | null,
      setActionHandler: vi.fn((action: string, handler: ((details?: unknown) => void) | null) => {
        handlers.set(action, handler)
      }),
      setMicrophoneActive: vi.fn(),
    }
    class MockMediaMetadata {
      title: string
      artist: string

      constructor(init: { title?: string; artist?: string }) {
        this.title = init.title ?? ''
        this.artist = init.artist ?? ''
      }
    }
    ;(globalThis as typeof globalThis & { MediaMetadata?: typeof MediaMetadata }).MediaMetadata = MockMediaMetadata as typeof MediaMetadata
    Object.defineProperty(navigator, 'mediaSession', {
      configurable: true,
      value: mediaSession,
    })

    const onHangup = vi.fn()
    const onToggleMicrophone = vi.fn()
    const adapter = new PwaAdapter()

    await adapter.callControls?.register({ onHangup, onToggleMicrophone })
    handlers.get('hangup')?.()
    handlers.get('togglemicrophone')?.()
    await adapter.callControls?.update({
      microphoneActive: true,
      title: 'General',
    })
    await adapter.callControls?.dispose()

    expect(onHangup).toHaveBeenCalledTimes(1)
    expect(onToggleMicrophone).toHaveBeenCalledTimes(1)
    expect(mediaSession.setActionHandler).toHaveBeenCalledWith('hangup', expect.any(Function))
    expect(mediaSession.setActionHandler).toHaveBeenCalledWith('togglemicrophone', expect.any(Function))
    expect(mediaSession.setMicrophoneActive).toHaveBeenCalledWith(true)
    expect(mediaSession.setMicrophoneActive).toHaveBeenCalledWith(false)
    expect(mediaSession.metadata).toBeNull()
    expect(mediaSession.setActionHandler).toHaveBeenCalledWith('hangup', null)
    expect(mediaSession.setActionHandler).toHaveBeenCalledWith('togglemicrophone', null)
  })

  it('unregisters previous Media Session handlers before re-registering', async () => {
    const mediaSession = {
      setActionHandler: vi.fn((action: string, handler: ((details?: unknown) => void) | null) => {
        if (action === 'hangup' && handler && mediaSession.setActionHandler.mock.calls.length > 2) {
          throw new Error('unsupported')
        }
      }),
      setMicrophoneActive: vi.fn(),
    }
    Object.defineProperty(navigator, 'mediaSession', {
      configurable: true,
      value: mediaSession,
    })

    const adapter = new PwaAdapter()
    adapter.callControls?.register({
      onHangup: vi.fn(),
      onToggleMicrophone: vi.fn(),
    })
    adapter.callControls?.register({
      onHangup: vi.fn(),
      onToggleMicrophone: vi.fn(),
    })
    adapter.callControls?.dispose()

    expect(mediaSession.setActionHandler.mock.calls).toEqual([
      ['hangup', expect.any(Function)],
      ['togglemicrophone', expect.any(Function)],
      ['hangup', null],
      ['togglemicrophone', null],
      ['hangup', expect.any(Function)],
      ['togglemicrophone', expect.any(Function)],
      ['togglemicrophone', null],
    ])
  })

  it('tolerates unsupported Media Session actions', async () => {
    const mediaSession = {
      setActionHandler: vi.fn(() => {
        throw new Error('unsupported')
      }),
      setMicrophoneActive: vi.fn(() => {
        throw new Error('unsupported')
      }),
    }
    Object.defineProperty(navigator, 'mediaSession', {
      configurable: true,
      value: mediaSession,
    })

    const adapter = new PwaAdapter()

    expect(() => adapter.callControls?.register({
      onHangup: vi.fn(),
      onToggleMicrophone: vi.fn(),
    })).not.toThrow()
    expect(() => adapter.callControls?.update({
      microphoneActive: true,
      title: 'General',
    })).not.toThrow()
    expect(() => adapter.callControls?.dispose()).not.toThrow()
  })
})
