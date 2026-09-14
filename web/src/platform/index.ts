import { PwaAdapter } from '@/platform/pwa-adapter'
import { getRuntimePlatformType } from '@/platform/runtime'
import type { PlatformAdapter } from '@/platform/types'

let adapter: PlatformAdapter | null = null
let initPromise: Promise<PlatformAdapter> | null = null

async function createAdapter(): Promise<PlatformAdapter> {
  if (getRuntimePlatformType() === 'tauri') {
    try {
      const { TauriAdapter } = await import('@/platform/tauri-adapter')
      return new TauriAdapter()
    } catch {
      // Desktop bridge failed to load; keep app functional with browser adapter.
      return new PwaAdapter()
    }
  }
  return new PwaAdapter()
}

export async function initPlatform(): Promise<PlatformAdapter> {
  if (adapter) return adapter
  initPromise ??= (async () => {
    const next = await createAdapter()
    await next.lifecycle.init()
    adapter = next
    return next
  })()
  return initPromise
}

export function usePlatform(): PlatformAdapter {
  if (!adapter) {
    throw new Error('Platform not initialized. Call initPlatform() before using platform APIs.')
  }
  return adapter
}

export function getPlatformOrNull(): PlatformAdapter | null {
  return adapter
}
