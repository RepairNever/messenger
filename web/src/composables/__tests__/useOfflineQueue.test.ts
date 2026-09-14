import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useOfflineQueue } from '@/composables/useOfflineQueue'

const cacheMocks = vi.hoisted(() => ({
  enqueueOutbound: vi.fn(),
  loadOutboundQueue: vi.fn(),
  removeOutbound: vi.fn(),
  clearOutboundQueue: vi.fn(),
}))

vi.mock('@/services/db/cache', () => cacheMocks)

describe('useOfflineQueue', () => {
  beforeEach(() => {
    cacheMocks.enqueueOutbound.mockReset()
    cacheMocks.loadOutboundQueue.mockReset()
    cacheMocks.removeOutbound.mockReset()
    cacheMocks.clearOutboundQueue.mockReset()
    cacheMocks.enqueueOutbound.mockResolvedValue(true)
    useOfflineQueue().clear()
  })

  it('keeps a sent record durable until its correlated ACK removes it', async () => {
    const offlineQueue = useOfflineQueue()
    const ws = {
      state: 'LIVE_SYNCED',
      sendMessage: vi.fn(() => true),
    } as any
    const onStatusChange = vi.fn()

    await offlineQueue.enqueue({
      conversationId: 'channel-1',
      body: 'retry me',
      clientMsgId: 'client-1',
      threadRootMessageId: 'root-1',
      attachmentIds: ['attachment-1'],
      attachments: [{ id: 'attachment-1', fileName: 'notes.txt', fileSize: 12, mimeType: 'text/plain' }],
      entities: [{ kind: 'user', targetId: 'user-2', label: '@Bob', href: '', start: 0, end: 4 }],
    })

    await offlineQueue.flush(ws, onStatusChange)

    expect(ws.sendMessage).toHaveBeenCalledWith(
      'channel-1',
      'retry me',
      'client-1',
      'root-1',
      ['attachment-1'],
      [{ kind: 'user', targetId: 'user-2', label: '@Bob', href: '', start: 0, end: 4 }],
    )
    expect(onStatusChange).toHaveBeenCalledWith('channel-1', 'client-1', 'sending', 'root-1')
    expect(offlineQueue.queue.value).toHaveLength(1)
    expect(cacheMocks.removeOutbound).not.toHaveBeenCalled()

    // The same live session cannot send the unresolved record twice.
    await offlineQueue.flush(ws, onStatusChange)
    expect(ws.sendMessage).toHaveBeenCalledTimes(1)

    // A new connection can idempotently replay the original client ID.
    offlineQueue.releaseAllInFlight()
    await offlineQueue.flush(ws, onStatusChange)
    expect(ws.sendMessage).toHaveBeenCalledTimes(2)

    offlineQueue.remove('client-1')
    expect(offlineQueue.queue.value).toEqual([])
    expect(cacheMocks.removeOutbound).toHaveBeenCalledWith('client-1')
  })

  it('keeps records queued when the transport changes during a flush', async () => {
    const offlineQueue = useOfflineQueue()
    const ws = {
      state: 'LIVE_SYNCED',
      sendMessage: vi.fn(() => false),
    } as any
    const onStatusChange = vi.fn()

    await offlineQueue.enqueue({ conversationId: 'channel-1', body: 'hello', clientMsgId: 'client-2' })
    await offlineQueue.flush(ws, onStatusChange)

    expect(offlineQueue.queue.value).toHaveLength(1)
    expect(onStatusChange).toHaveBeenLastCalledWith('channel-1', 'client-2', 'queued', undefined)
    expect(cacheMocks.removeOutbound).not.toHaveBeenCalled()
  })

  it('does not flush a record until its IndexedDB commit succeeds', async () => {
    const offlineQueue = useOfflineQueue()
    const ws = {
      state: 'LIVE_SYNCED',
      sendMessage: vi.fn(() => true),
    } as any
    let resolvePersistence: ((persisted: boolean) => void) | undefined
    cacheMocks.enqueueOutbound.mockReturnValue(new Promise<boolean>(resolve => {
      resolvePersistence = resolve
    }))

    const persisted = offlineQueue.enqueue({ conversationId: 'channel-1', body: 'wait', clientMsgId: 'client-3' })
    const flushing = offlineQueue.flush(ws)

    await Promise.resolve()
    expect(ws.sendMessage).not.toHaveBeenCalled()

    resolvePersistence?.(true)
    await persisted
    await flushing

    expect(ws.sendMessage).toHaveBeenCalledWith('channel-1', 'wait', 'client-3', undefined, [], [])
  })
})
