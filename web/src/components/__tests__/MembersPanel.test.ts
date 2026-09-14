import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { NotificationLevel } from '@/shared/proto/packets_pb'
import MembersPanel from '@/components/MembersPanel.vue'
import { useAuthStore } from '@/stores/auth'
import { useChatStore } from '@/stores/chat'
import { ChatApiError } from '@/services/http/chatApi'

const chatApiMocks = vi.hoisted(() => ({
  listConversationMembers: vi.fn(),
  listDmCandidates: vi.fn(),
  inviteToConversation: vi.fn(),
  removeConversationMember: vi.fn(),
}))

vi.mock('@/services/http/chatApi', () => {
  class MockChatApiError extends Error {
    constructor(message: string, public readonly status: number) {
      super(message)
      this.name = 'ChatApiError'
    }
  }

  return {
    listConversationMembers: chatApiMocks.listConversationMembers,
    listDmCandidates: chatApiMocks.listDmCandidates,
    inviteToConversation: chatApiMocks.inviteToConversation,
    removeConversationMember: chatApiMocks.removeConversationMember,
    ChatApiError: MockChatApiError,
  }
})

async function flushAll() {
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
}

function seedStores(role: string, visibility: 'public' | 'private' = 'private') {
  const auth = useAuthStore()
  const chat = useChatStore()
  auth.user = { id: 'self-user', email: 'self@example.com', displayName: 'Self', role }
  chat.channels = [{
    id: 'channel-1',
    name: 'team',
    kind: 'channel',
    visibility,
    unread: 0,
    notificationLevel: NotificationLevel.ALL,
  }]
  chat.activeChannelId = 'channel-1'
}

function members() {
  return [
    {
      user_id: 'self-user',
      display_name: 'Self',
      email: 'self@example.com',
      avatar_url: '',
      custom_status: null,
    },
    {
      user_id: 'target-user',
      display_name: 'Target',
      email: 'target@example.com',
      avatar_url: '',
      custom_status: null,
    },
  ]
}

async function mountPanel(visibility: 'public' | 'private') {
  const wrapper = mount(MembersPanel, {
    props: { visibility },
    global: {
      stubs: {
        UserAvatar: true,
      },
    },
  })
  await flushAll()
  return wrapper
}

describe('MembersPanel member removal', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    chatApiMocks.listConversationMembers.mockResolvedValue(members())
    chatApiMocks.listDmCandidates.mockResolvedValue([])
    chatApiMocks.inviteToConversation.mockResolvedValue(undefined)
    chatApiMocks.removeConversationMember.mockResolvedValue(undefined)
  })

  it('shows remove actions for other members in private channels', async () => {
    seedStores('member', 'private')

    const wrapper = await mountPanel('private')

    const buttons = wrapper.findAll('[data-testid="remove-member-button"]')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].attributes('data-user-id')).toBe('target-user')
  })

  it('hides remove actions for normal members in public channels', async () => {
    seedStores('member', 'public')

    const wrapper = await mountPanel('public')

    expect(wrapper.find('[data-testid="remove-member-button"]').exists()).toBe(false)
  })

  it.each(['admin', 'owner'])('shows remove actions for %s users in public channels', async (role) => {
    seedStores(role, 'public')

    const wrapper = await mountPanel('public')

    const buttons = wrapper.findAll('[data-testid="remove-member-button"]')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].attributes('data-user-id')).toBe('target-user')
  })

  it('removes a member and refreshes the list', async () => {
    seedStores('member', 'private')
    chatApiMocks.listConversationMembers
      .mockResolvedValueOnce(members())
      .mockResolvedValueOnce([members()[0]])

    const wrapper = await mountPanel('private')
    await wrapper.get('[data-testid="remove-member-button"]').trigger('click')
    await flushAll()

    expect(chatApiMocks.removeConversationMember).toHaveBeenCalledWith('channel-1', 'target-user')
    expect(chatApiMocks.listConversationMembers).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).not.toContain('Target')
  })

  it('shows an inline error when removal is forbidden', async () => {
    seedStores('member', 'private')
    chatApiMocks.removeConversationMember.mockRejectedValue(new ChatApiError('not allowed to remove members from this conversation', 403))

    const wrapper = await mountPanel('private')
    await wrapper.get('[data-testid="remove-member-button"]').trigger('click')
    await flushAll()

    expect(wrapper.text()).toContain('not allowed to remove members from this conversation')
  })
})
