import { describe, expect, it, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SavedMessagesPane from '@/components/SavedMessagesPane.vue'
import { useChatStore } from '@/stores/chat'

const chatApiMocks = vi.hoisted(() => ({
  listSavedMessages: vi.fn(),
  saveMessage: vi.fn(),
  unsaveMessage: vi.fn(),
  listMessageReactionUsers: vi.fn(),
}))

vi.mock('@/services/http/chatApi', () => ({
  listSavedMessages: chatApiMocks.listSavedMessages,
  saveMessage: chatApiMocks.saveMessage,
  unsaveMessage: chatApiMocks.unsaveMessage,
  listMessageReactionUsers: chatApiMocks.listMessageReactionUsers,
}))

describe('SavedMessagesPane', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('renders saved message bodies as markdown with message entities', () => {
    const chat = useChatStore()
    chat.savedMessageItems = [{
      id: 'saved:message-1',
      conversationId: 'channel-1',
      conversationKind: 'channel',
      conversationVisibility: 'public',
      conversationTitle: 'general',
      messageId: 'message-1',
      senderId: 'user-2',
      senderName: 'Bob',
      body: '**hello** @Ada',
      entities: [{
        kind: 'user',
        targetId: 'user-1',
        label: '@Ada',
        href: '',
        start: 10,
        end: 14,
      }],
      createdAt: '2026-03-06T00:00:00Z',
      savedAt: '2026-03-06T00:01:00Z',
    }]

    const wrapper = mount(SavedMessagesPane)

    expect(wrapper.html()).toContain('<strong>hello</strong>')
    expect(wrapper.find('[data-message-entity-kind="user"][data-target-id="user-1"]').exists()).toBe(true)
  })
})
