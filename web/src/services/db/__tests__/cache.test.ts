import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CachedConversation, CachedMessage } from '@/services/db/msgnrDb'
import type { DirectMessage, Message } from '@/stores/chat'
import { NotificationLevel } from '@/shared/proto/packets_pb'

const cacheState = vi.hoisted(() => {
  const rows: CachedMessage[] = []
  const deleteMessages = vi.fn(async () => undefined)
  const equalsConversation = vi.fn(() => ({ delete: deleteMessages }))
  const whereMessages = vi.fn(() => ({ equals: equalsConversation }))
  const bulkPutMessages = vi.fn(async (nextRows: CachedMessage[]) => {
    rows.splice(0, rows.length, ...nextRows)
  })

  const conversationRows: CachedConversation[] = []
  const clearConversations = vi.fn(async () => undefined)
  const bulkPutConversations = vi.fn(async (nextRows: CachedConversation[]) => {
    conversationRows.splice(0, conversationRows.length, ...nextRows)
  })
  const toArrayConversations = vi.fn(async () => [...conversationRows])

  return {
    rows,
    deleteMessages,
    equalsConversation,
    whereMessages,
    bulkPutMessages,
    conversationRows,
    clearConversations,
    bulkPutConversations,
    toArrayConversations,
    transaction: vi.fn(async (_mode: string, _table: unknown, operation: () => Promise<void>) => operation()),
  }
})

vi.mock('@/services/db/msgnrDb', () => ({
  db: {
    transaction: cacheState.transaction,
    messages: {
      where: cacheState.whereMessages,
      bulkPut: cacheState.bulkPutMessages,
    },
    conversations: {
      clear: cacheState.clearConversations,
      bulkPut: cacheState.bulkPutConversations,
      toArray: cacheState.toArrayConversations,
    },
  },
}))

import { cacheMessages, cacheConversations, loadCachedConversations } from '@/services/db/cache'

function buildMessage(sequence: number, overrides: Partial<Message> = {}): Message {
  return {
    id: `message-${sequence}`,
    channelId: 'channel-1',
    senderId: 'user-1',
    senderName: 'Ada',
    body: `Message ${sequence}`,
    channelSeq: BigInt(sequence),
    threadSeq: 0n,
    mentionedUserIds: [],
    mentionEveryone: false,
    createdAt: '2026-08-24T00:00:00Z',
    reactions: [],
    myReactions: [],
    ...overrides,
  }
}

describe('cacheMessages', () => {
  beforeEach(() => {
    cacheState.rows.splice(0)
    vi.clearAllMocks()
  })

  it('retains the newest 50 confirmed messages by channel sequence when input is unsorted', async () => {
    const confirmed = Array.from({ length: 60 }, (_, index) => buildMessage(index + 1))
    const unsorted = [
      ...confirmed.slice(40),
      buildMessage(101, { sendStatus: 'sending' }),
      ...confirmed.slice(0, 20).reverse(),
      buildMessage(100, { pending: true }),
      ...confirmed.slice(20, 40),
    ]

    await cacheMessages('channel-1', unsorted)

    expect(cacheState.rows).toHaveLength(50)
    expect(cacheState.rows.map(row => row.channelSeq)).toEqual(
      Array.from({ length: 50 }, (_, index) => String(index + 11)),
    )
    expect(cacheState.rows.some(row => row.id === 'message-100' || row.id === 'message-101')).toBe(false)
  })
})

describe('cacheConversations', () => {
  beforeEach(() => {
    cacheState.conversationRows.splice(0)
    vi.clearAllMocks()
  })

  it('persists and restores DM lastActivityAt for sidebar ordering', async () => {
    const dm: DirectMessage = {
      id: 'dm-1',
      userId: 'user-2',
      displayName: 'Bob',
      presence: 'offline',
      unread: 0,
      lastMessageSeq: 4n,
      lastActivityAt: '2026-01-01T00:00:00.000Z',
      notificationLevel: NotificationLevel.ALL,
    }

    await cacheConversations([], [dm])
    const restored = await loadCachedConversations()

    expect(restored?.dms).toHaveLength(1)
    expect(restored?.dms[0].lastActivityAt).toBe('2026-01-01T00:00:00.000Z')
    expect(restored?.dms[0].lastMessageSeq).toBe(4n)
  })

  it('restores DMs without lastActivityAt when the cache predates the field', async () => {
    const dm: DirectMessage = {
      id: 'dm-2',
      userId: 'user-3',
      displayName: 'Carol',
      presence: 'offline',
      unread: 1,
      notificationLevel: NotificationLevel.ALL,
    }

    await cacheConversations([], [dm])
    const restored = await loadCachedConversations()

    expect(restored?.dms[0].lastActivityAt).toBeUndefined()
  })
})
