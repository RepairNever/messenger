import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CONVERSATION_HISTORY_REQUEST_TIMEOUT_MS } from '@/services/http/timeouts'

const mockHttp = vi.hoisted(() => ({
  get: vi.fn(),
}))

vi.mock('@/services/http/client', () => ({
  createAuthenticatedClient: () => mockHttp,
}))

describe('chat API timeouts', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('bounds conversation history requests without changing their cursor parameters', async () => {
    mockHttp.get.mockResolvedValue({
      data: {
        messages: [],
        has_more: false,
        page_size: 50,
      },
    })

    const { listConversationMessages } = await import('@/services/http/chatApi')

    await listConversationMessages('conversation-1', 42n, 'device-1')

    expect(mockHttp.get).toHaveBeenCalledWith('/api/messages', {
      params: {
        conversation_id: 'conversation-1',
        before_channel_seq: '42',
        e2ee_device_id: 'device-1',
      },
      timeout: CONVERSATION_HISTORY_REQUEST_TIMEOUT_MS,
    })
  })
})
