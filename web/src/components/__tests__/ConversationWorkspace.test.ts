import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { NotificationLevel } from '@/shared/proto/packets_pb'
import ConversationWorkspace from '@/components/ConversationWorkspace.vue'
import { useAuthStore } from '@/stores/auth'
import { useChatStore, type Message } from '@/stores/chat'
import { useWsStore } from '@/stores/ws'

function buildMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-1',
    channelId: 'channel-1',
    senderId: 'user-2',
    senderName: 'Bob',
    body: 'hello',
    channelSeq: 1n,
    threadSeq: 0n,
    mentionedUserIds: [],
    mentionEveryone: false,
    createdAt: '2026-03-06T00:00:00Z',
    reactions: [],
    myReactions: [],
    ...overrides,
  }
}

describe('ConversationWorkspace', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      value: vi.fn(),
      configurable: true,
      writable: true,
    })
  })

  it('requests inline edit for the latest editable own conversation message', async () => {
    const auth = useAuthStore()
    const chat = useChatStore()
    const ws = useWsStore()
    auth.user = { id: 'user-1', email: 'u1@example.com', displayName: 'U1', role: 'member' }
    ws.state = 'LIVE_SYNCED'
    chat.ensureConversationHistory = vi.fn().mockResolvedValue(undefined)
    chat.channels = [{
      id: 'channel-1',
      name: 'general',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chat.messages = {
      'channel-1': [
        buildMessage({ id: 'own-confirmed', senderId: 'user-1', body: 'editable' }),
        buildMessage({ id: 'other-later', senderId: 'user-2', body: 'not mine', channelSeq: 2n }),
        buildMessage({ id: 'own-failed', senderId: 'user-1', body: 'failed', channelSeq: 0n, sendStatus: 'failed' }),
      ],
    }

    const wrapper = mount(ConversationWorkspace, {
      props: {
        conversationId: 'channel-1',
      },
      global: {
        stubs: {
          MessageBubble: {
            props: ['message', 'editRequestToken'],
            template: '<div class="msg" :data-id="message.id" :data-edit-token="editRequestToken" />',
          },
          MessageInput: {
            emits: ['edit-last-message'],
            template: '<button data-testid="edit-last" @click="$emit(\'edit-last-message\')">edit</button>',
          },
        },
      },
    })

    await nextTick()
    await wrapper.get('[data-testid="edit-last"]').trigger('click')
    await nextTick()

    expect(wrapper.get('[data-id="own-confirmed"]').attributes('data-edit-token')).toBe('1')
    expect(wrapper.get('[data-id="other-later"]').attributes('data-edit-token')).toBe('0')
    expect(wrapper.get('[data-id="own-failed"]').attributes('data-edit-token')).toBe('0')
  })
})
