import { defineComponent, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { DocumentContentCollabMessageKind } from '@/shared/proto/packets_pb'
import { useDocumentContentCollab } from '@/composables/useDocumentContentCollab'

const mockState = vi.hoisted(() => ({
  onSubscribeResponse: null as ((payload: {
    documentId: string
    persistedMarkdown: string
    subscriberCount: number
    roomSnapshot?: Uint8Array
  }) => void) | null,
  onMessage: null as ((payload: { documentId: string; kind: DocumentContentCollabMessageKind; payload: Uint8Array }) => void) | null,
}))

const mockWsStore = vi.hoisted(() => ({
  state: 'LIVE_SYNCED' as
    | 'DISCONNECTED'
    | 'CONNECTING'
    | 'WS_CONNECTED'
    | 'HELLO_SENT'
    | 'HELLO_COMPLETE'
    | 'AUTH_SENT'
    | 'AUTH_COMPLETE'
    | 'BOOTSTRAPPING'
    | 'LIVE_SYNCED'
    | 'RECOVERING_GAP'
    | 'STALE_REBOOTSTRAP',
  sendDocumentContentCollabSubscribe: vi.fn<(documentId: string) => string>(() => 'req-subscribe'),
  sendDocumentContentCollabUnsubscribe: vi.fn<(documentId: string) => string>(() => 'req-unsubscribe'),
  sendDocumentContentCollabMessage: vi.fn<(documentId: string, kind: DocumentContentCollabMessageKind, payload: Uint8Array) => boolean>(() => true),
  onDocumentContentCollabSubscribeResponse: vi.fn<(cb: (payload: {
    documentId: string
    persistedMarkdown: string
    subscriberCount: number
    roomSnapshot?: Uint8Array
  }) => void) => void>((cb) => {
    mockState.onSubscribeResponse = cb
  }),
  onDocumentContentCollabMessage: vi.fn<(cb: (payload: { documentId: string; kind: DocumentContentCollabMessageKind; payload: Uint8Array }) => void) => void>((cb) => {
    mockState.onMessage = cb
  }),
}))

vi.mock('@/stores/ws', () => ({
  useWsStore: () => mockWsStore,
}))

function mountHost() {
  let collabState: ReturnType<typeof useDocumentContentCollab> | null = null
  const Host = defineComponent({
    setup() {
      const documentId = ref('doc-1')
      const user = ref({
        id: 'user-1',
        name: 'User One',
        color: '#60a5fa',
      })
      collabState = useDocumentContentCollab({ documentId, user })
      return {}
    },
    template: '<div />',
  })

  return {
    wrapper: mount(Host),
    getCollabState() {
      if (!collabState) throw new Error('collab state is not initialized')
      return collabState
    },
  }
}

describe('useDocumentContentCollab', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mockState.onSubscribeResponse = null
    mockState.onMessage = null
    mockWsStore.state = 'LIVE_SYNCED'
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('seeds persisted markdown for the first document subscriber and requests peer state', async () => {
    const { wrapper, getCollabState } = mountHost()
    await nextTick()

    mockState.onSubscribeResponse?.({
      documentId: 'doc-1',
      persistedMarkdown: 'aabb',
      subscriberCount: 1,
      roomSnapshot: new Uint8Array(),
    })
    await vi.advanceTimersByTimeAsync(260)

    expect(getCollabState().serverMarkdown.value).toBe('aabb')
    const syncSends = mockWsStore.sendDocumentContentCollabMessage.mock.calls.filter(
      (call) => call[1] === DocumentContentCollabMessageKind.SYNC,
    )
    expect(syncSends.length).toBeGreaterThan(0)
    expect((syncSends[0][2] as Uint8Array)[3]).toBe(2)

    wrapper.unmount()
  })

  it('applies an active document room snapshot instead of seeding persisted markdown', async () => {
    const { wrapper, getCollabState } = mountHost()
    await nextTick()

    const snapshotDoc = new Y.Doc()
    snapshotDoc.getText('note').insert(0, 'hello')
    const roomSnapshot = Y.encodeStateAsUpdate(snapshotDoc)

    mockState.onSubscribeResponse?.({
      documentId: 'doc-1',
      persistedMarkdown: 'stale persisted',
      subscriberCount: 2,
      roomSnapshot,
    })
    await vi.advanceTimersByTimeAsync(260)

    expect(getCollabState().serverMarkdown.value).toBeNull()
    expect(Y.encodeStateVector(getCollabState().doc.value!).length).toBeGreaterThan(1)

    wrapper.unmount()
  })
})
