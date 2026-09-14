import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CachedMessage } from '@/services/db/msgnrDb'
import type { Message } from '@/stores/chat'

const cacheState = vi.hoisted(() => {
  const rows: CachedMessage[] = []
  const deleteMessages = vi.fn(async () => undefined)
  const equalsConversation = vi.fn(() => ({ delete: deleteMessages }))
  const whereMessages = vi.fn(() => ({ equals: equalsConversation }))
  const bulkPutMessages = vi.fn(async (nextRows: CachedMessage[]) => {
    rows.splice(0, rows.length, ...nextRows)
  })

  return {
    rows,
    deleteMessages,
    equalsConversation,
    whereMessages,
    bulkPutMessages,
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
  },
}))

import { cacheMessages } from '@/services/db/cache'

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
