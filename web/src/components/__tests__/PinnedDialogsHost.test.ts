import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { NotificationLevel } from '@/shared/proto/packets_pb'
import PinnedDialogsHost from '@/components/PinnedDialogsHost.vue'
import { usePinnedDialogsStore } from '@/stores/pinnedDialogs'
import { useChatStore } from '@/stores/chat'

vi.mock('@/components/ConversationWorkspace.vue', () => ({
  default: {
    props: ['conversationId'],
    template: '<div data-testid="conversation-workspace">{{ conversationId }}</div>',
  },
}))

vi.mock('@/components/ThreadWorkspace.vue', () => ({
  default: {
    props: ['conversationId', 'rootMessageId'],
    template: '<div data-testid="thread-workspace">{{ conversationId }}:{{ rootMessageId }}</div>',
  },
}))

describe('PinnedDialogsHost', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('renders active card highlight and type-specific content', async () => {
    const chat = useChatStore()
    const pinned = usePinnedDialogsStore()

    chat.directMessages = [{
      id: 'dm-1',
      userId: 'user-1',
      displayName: 'Alice Ford',
      presence: 'online',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chat.channels = [{
      id: 'channel-1',
      name: 'qa',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]

    pinned.ensureConversationPinned('dm-1')
    pinned.ensureThreadPinned('channel-1', 'root-1')

    const wrapper = mount(PinnedDialogsHost)

    expect(wrapper.get('[data-testid="thread-workspace"]').text()).toBe('channel-1:root-1')
    expect(wrapper.text()).toContain('# qa > Conversation')

    const threadCard = wrapper.get('[data-testid="pinned-card-thread:channel-1:root-1"]')
    const dmCard = wrapper.get('[data-testid="pinned-card-dm:dm-1"]')

    expect(threadCard.attributes('class')).toContain('ring-2')
    expect(dmCard.attributes('class')).not.toContain('ring-2')
    expect(wrapper.text()).toContain('Alice Ford')
    expect(wrapper.text()).toContain('qa')
  })

  it('renders nothing when no pinned items exist', () => {
    const wrapper = mount(PinnedDialogsHost)
    expect(wrapper.find('[data-testid^="pinned-card-"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="conversation-workspace"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="thread-workspace"]').exists()).toBe(false)
  })

  it('switches active panel when clicking inactive card', async () => {
    const chat = useChatStore()
    const pinned = usePinnedDialogsStore()

    chat.directMessages = [{
      id: 'dm-1',
      userId: 'user-1',
      displayName: 'Alice Ford',
      presence: 'online',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chat.channels = [{
      id: 'channel-1',
      name: 'qa',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]

    pinned.ensureConversationPinned('dm-1')
    pinned.ensureThreadPinned('channel-1', 'root-1')

    const wrapper = mount(PinnedDialogsHost)
    await wrapper.get('[data-testid="pinned-card-dm:dm-1"]').trigger('click')

    expect(pinned.activeId).toBe('dm:dm-1')
    expect(wrapper.get('[data-testid="conversation-workspace"]').text()).toBe('dm-1')
  })

  it('unpins only target item from card close button', async () => {
    const chat = useChatStore()
    const pinned = usePinnedDialogsStore()

    chat.directMessages = [{
      id: 'dm-1',
      userId: 'user-1',
      displayName: 'Alice Ford',
      presence: 'online',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]
    chat.channels = [{
      id: 'channel-1',
      name: 'qa',
      kind: 'channel',
      visibility: 'public',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]

    pinned.ensureConversationPinned('dm-1')
    pinned.ensureThreadPinned('channel-1', 'root-1')

    const wrapper = mount(PinnedDialogsHost)
    const card = wrapper.get('[data-testid="pinned-card-dm:dm-1"]')
    await card.find('button[aria-label="Unpin Alice Ford"]').trigger('click')

    expect(pinned.items.map(item => item.id)).toEqual(['thread:channel-1:root-1'])
    expect(pinned.activeId).toBe('thread:channel-1:root-1')
  })

  it('header close hides panel but keeps item pinned', async () => {
    const chat = useChatStore()
    const pinned = usePinnedDialogsStore()

    chat.directMessages = [{
      id: 'dm-1',
      userId: 'user-1',
      displayName: 'Alice Ford',
      presence: 'online',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]

    pinned.ensureConversationPinned('dm-1')

    const wrapper = mount(PinnedDialogsHost)
    await wrapper.get('button[aria-label="Close pinned panel"]').trigger('click')

    expect(pinned.items.map(item => item.id)).toEqual(['dm:dm-1'])
    expect(wrapper.find('[data-testid="conversation-workspace"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="pinned-card-dm:dm-1"]').exists()).toBe(true)
    expect(pinned.activeId).toBeNull()
  })
})
