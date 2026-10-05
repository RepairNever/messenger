import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { nextTick } from 'vue'
import { create } from '@bufbuild/protobuf'
import { NotificationLevel, PresenceStatus, MessageEventSchema, ServerEventSchema, ReadCounterUpdatedEventSchema, UnreadCounterSchema, BootstrapResponseSchema, ConversationSummarySchema } from '@/shared/proto/packets_pb'
import AppSidebar from '@/components/AppSidebar.vue'
import SidebarItem from '@/components/SidebarItem.vue'
import { useAuthStore } from '@/stores/auth'
import { useChatStore } from '@/stores/chat'
import { useWsStore } from '@/stores/ws'
import { ensureLocalStorageMock } from '@/__tests__/testUtils'
import { storage } from '@/services/storage/storageAdapter'
import * as cacheService from '@/services/db/cache'

const chatApiMocks = vi.hoisted(() => ({
  listDmCandidates: vi.fn(),
  createOrOpenDm: vi.fn(),
  createOrOpenEncryptedDm: vi.fn(),
  listAvailableChannels: vi.fn(),
  joinChannels: vi.fn(),
  leaveConversation: vi.fn(),
  clearDMConversationHistory: vi.fn(),
  listMessageReactionUsers: vi.fn(),
  listUnreadFeed: vi.fn(),
  listSavedMessages: vi.fn(),
  saveMessage: vi.fn(),
  unsaveMessage: vi.fn(),
  getMessageContext: vi.fn(),
  resolveUnreadFeedNotification: vi.fn(),
  listConversationMessages: vi.fn(),
}))

vi.mock('@/services/http/chatApi', () => ({
  listDmCandidates: chatApiMocks.listDmCandidates,
  createOrOpenDm: chatApiMocks.createOrOpenDm,
  createOrOpenEncryptedDm: chatApiMocks.createOrOpenEncryptedDm,
  listAvailableChannels: chatApiMocks.listAvailableChannels,
  joinChannels: chatApiMocks.joinChannels,
  leaveConversation: chatApiMocks.leaveConversation,
  clearDMConversationHistory: chatApiMocks.clearDMConversationHistory,
  listMessageReactionUsers: chatApiMocks.listMessageReactionUsers,
  listUnreadFeed: chatApiMocks.listUnreadFeed,
  listSavedMessages: chatApiMocks.listSavedMessages,
  saveMessage: chatApiMocks.saveMessage,
  unsaveMessage: chatApiMocks.unsaveMessage,
  getMessageContext: chatApiMocks.getMessageContext,
  resolveUnreadFeedNotification: chatApiMocks.resolveUnreadFeedNotification,
  listConversationMessages: chatApiMocks.listConversationMessages,
}))

vi.mock('@/composables/useSessionOrchestrator', () => ({
  useSessionOrchestrator: () => ({
    logout: vi.fn(),
  }),
}))

async function flushAll() {
  await Promise.resolve()
  await nextTick()
}

describe('AppSidebar', () => {
  beforeEach(() => {
    ensureLocalStorageMock()
    setActivePinia(createPinia())
    storage.clear()
    vi.clearAllMocks()
    chatApiMocks.listDmCandidates.mockResolvedValue([
      { user_id: 'user-2', display_name: 'Bob', email: 'bob@example.com', avatar_url: '' },
    ])
    chatApiMocks.createOrOpenDm.mockResolvedValue({
      conversation_id: 'dm-1',
      user_id: 'user-2',
      display_name: 'Bob',
      email: 'bob@example.com',
      avatar_url: '',
      kind: 'dm',
      visibility: 'dm',
    })
    chatApiMocks.createOrOpenEncryptedDm.mockResolvedValue({
      conversation_id: 'dm-e2ee-1',
      user_id: 'user-2',
      display_name: 'Bob',
      email: 'bob@example.com',
      avatar_url: '',
      kind: 'dm',
      visibility: 'dm',
      encryption_mode: 'dm_pairwise_signal_v1',
    })
    chatApiMocks.listAvailableChannels.mockResolvedValue([
      { id: 'channel-1', name: 'General', kind: 'channel', visibility: 'public', last_activity_at: '2026-03-06T00:00:00Z' },
      { id: 'channel-2', name: 'Random', kind: 'channel', visibility: 'public', last_activity_at: '2026-03-06T00:00:00Z' },
    ])
    chatApiMocks.joinChannels.mockResolvedValue([
      { id: 'channel-1', name: 'General', kind: 'channel', visibility: 'public', last_activity_at: '2026-03-06T00:00:00Z' },
      { id: 'channel-2', name: 'Random', kind: 'channel', visibility: 'public', last_activity_at: '2026-03-06T00:00:00Z' },
    ])
    chatApiMocks.leaveConversation.mockResolvedValue(undefined)
    chatApiMocks.clearDMConversationHistory.mockResolvedValue(undefined)
    chatApiMocks.listUnreadFeed.mockResolvedValue({ total_count: 0, items: [] })
    chatApiMocks.listSavedMessages.mockResolvedValue({ total_count: 0, items: [] })
    chatApiMocks.saveMessage.mockResolvedValue(undefined)
    chatApiMocks.unsaveMessage.mockResolvedValue(undefined)
    chatApiMocks.getMessageContext.mockResolvedValue({ messages: [], has_more: false, page_size: 0 })
    chatApiMocks.resolveUnreadFeedNotification.mockResolvedValue(undefined)
  })

  it('shows email fallback in DM picker and opened DM when display name is empty', async () => {
    chatApiMocks.listDmCandidates.mockResolvedValue([
      { user_id: 'user-3', display_name: '', email: 'eve@example.com', avatar_url: '' },
    ])
    chatApiMocks.createOrOpenDm.mockResolvedValue({
      conversation_id: 'dm-2',
      user_id: 'user-3',
      display_name: '',
      email: 'eve@example.com',
      avatar_url: '',
      kind: 'dm',
      visibility: 'dm',
    })

    const authStore = useAuthStore()
    const chatStore = useChatStore()
    authStore.sessionRole = 'member'
    chatStore.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfRole: 'member',
    }

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: { template: '<div />' } }],
    })
    await router.push('/')
    await router.isReady()

    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [router],
        stubs: {
          SidebarItem: {
            template: '<button class="sidebar-item" @click="$emit(\'click\')"><slot name="icon" /><slot /><slot name="actions" /></button>',
          },
          RouterLink: {
            template: '<a><slot /></a>',
          },
          Teleport: true,
        },
      },
    })

    await wrapper.get('[data-testid="new-message-button"]').trigger('click')
    await flushAll()

    expect(wrapper.text()).toContain('eve@example.com')

    await wrapper.get('[data-testid="dm-candidate-user-3"]').trigger('click')
    await flushAll()

    expect(chatStore.directMessages).toEqual([
      {
        id: 'dm-2',
        userId: 'user-3',
        displayName: 'eve@example.com',
        avatarUrl: '',
        presence: 'offline',
        encryptionMode: 'none',
        unread: 0,
        notificationLevel: NotificationLevel.ALL,
      },
    ])
  })

  it('opens the dm picker and selects a created direct message', async () => {
    const authStore = useAuthStore()
    const chatStore = useChatStore()
    authStore.sessionRole = 'member'
    chatStore.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfRole: 'member',
    }

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: { template: '<div />' } }],
    })
    await router.push('/')
    await router.isReady()

    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [router],
        stubs: {
          SidebarItem: {
            template: '<button class="sidebar-item" @click="$emit(\'click\')"><slot name="icon" /><slot /><slot name="actions" /></button>',
          },
          RouterLink: {
            template: '<a><slot /></a>',
          },
          Teleport: true,
        },
      },
    })

    await wrapper.get('[data-testid="new-message-button"]').trigger('click')
    await flushAll()

    expect(chatApiMocks.listDmCandidates).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('Bob')

    await wrapper.get('[data-testid="dm-candidate-user-2"]').trigger('click')
    await flushAll()

    expect(chatApiMocks.createOrOpenDm).toHaveBeenCalledWith('user-2')
    expect(chatStore.directMessages).toEqual([
      {
        id: 'dm-1',
        userId: 'user-2',
        displayName: 'Bob',
        avatarUrl: '',
        presence: 'offline',
        encryptionMode: 'none',
        unread: 0,
        notificationLevel: NotificationLevel.ALL,
      },
    ])
    expect(chatStore.activeChannelId).toBe('dm-1')
  })

  it('shows the encrypted DM icon immediately after starting an E2E session', async () => {
    const authStore = useAuthStore()
    const chatStore = useChatStore()
    authStore.sessionRole = 'member'
    chatStore.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfRole: 'member',
    }
    chatStore.directMessages = [{
      id: 'dm-plain-1',
      userId: 'user-2',
      displayName: 'Bob',
      avatarUrl: '',
      presence: 'offline',
      encryptionMode: 'none',
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
    }]

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: { template: '<div />' } }],
    })
    await router.push('/')
    await router.isReady()

    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [router],
        stubs: {
          SidebarItem: {
            template: '<button class="sidebar-item" @click="$emit(\'click\')"><slot name="icon" /><slot /><slot name="actions" /></button>',
          },
          RouterLink: {
            template: '<a><slot /></a>',
          },
          Teleport: true,
        },
      },
    })

    expect(wrapper.find('[aria-label="Encrypted DM"]').exists()).toBe(false)

    await wrapper.get('[data-testid="conversation-menu-button-dm-dm-plain-1"]').trigger('click')
    await wrapper.get('[data-testid="conversation-start-e2ee-dm-dm-plain-1"]').trigger('click')
    await flushAll()

    expect(chatApiMocks.createOrOpenEncryptedDm).toHaveBeenCalledWith('dm-plain-1')
    expect(chatStore.activeChannelId).toBe('dm-e2ee-1')
    expect(chatStore.directMessages.find(dm => dm.id === 'dm-e2ee-1')?.encryptionMode).toBe('dm_pairwise_signal_v1')
    expect(wrapper.find('[aria-label="Encrypted DM"]').exists()).toBe(true)
  })

  it('includes self in the dm picker and opens a self dm', async () => {
    const authStore = useAuthStore()
    const chatStore = useChatStore()
    authStore.user = {
      id: 'user-1',
      email: 'ada@example.com',
      displayName: 'Ada',
      role: 'member',
    }
    authStore.sessionRole = 'member'
    chatStore.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfAvatarUrl: '/api/public/avatars/avatars/user-1/avatar.png',
      selfRole: 'member',
    }
    chatApiMocks.createOrOpenDm.mockResolvedValue({
      conversation_id: 'dm-self',
      user_id: 'user-1',
      display_name: 'Ada',
      email: 'ada@example.com',
      avatar_url: '/api/public/avatars/avatars/user-1/avatar.png',
      kind: 'dm',
      visibility: 'dm',
    })

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: { template: '<div />' } }],
    })
    await router.push('/')
    await router.isReady()

    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [router],
        stubs: {
          SidebarItem: {
            template: '<button class="sidebar-item" @click="$emit(\'click\')"><slot name="icon" /><slot /><slot name="actions" /></button>',
          },
          RouterLink: {
            template: '<a><slot /></a>',
          },
          Teleport: true,
        },
      },
    })

    await wrapper.get('[data-testid="new-message-button"]').trigger('click')
    await flushAll()

    expect(wrapper.find('[data-testid="dm-candidate-user-1"]').exists()).toBe(true)
    await wrapper.get('[data-testid="dm-candidate-user-1"]').trigger('click')
    await flushAll()

    expect(chatApiMocks.createOrOpenDm).toHaveBeenCalledWith('user-1')
    expect(chatStore.directMessages).toEqual([
      {
        id: 'dm-self',
        userId: 'user-1',
        displayName: 'Ada',
        avatarUrl: '/api/public/avatars/avatars/user-1/avatar.png',
        presence: 'offline',
        encryptionMode: 'none',
        unread: 0,
        notificationLevel: NotificationLevel.ALL,
      },
    ])
  })

  it('shows the unread badge capped at 99+ and switches to unread view on click', async () => {
    const chatStore = useChatStore()
    chatStore.unreadFeedLoaded = true as any
    chatStore.unreadFeedTotalCount = 120 as any
    const refreshUnreadFeed = vi.spyOn(chatStore, 'refreshUnreadFeed').mockResolvedValue()

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', name: 'main', component: { template: '<div />' } }],
    })
    await router.push('/')
    await router.isReady()

    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [router],
        stubs: {
          SidebarItem: {
            template: '<button class="sidebar-item" @click="$emit(\'click\')"><slot name="icon" /><slot /><slot name="actions" /></button>',
          },
          RouterLink: {
            template: '<a><slot /></a>',
          },
          Teleport: true,
        },
      },
    })

    expect(wrapper.get('[data-testid="sidebar-unread-badge"]').text()).toBe('99+')

    await wrapper.get('[data-testid="sidebar-unread-button"]').trigger('click')
    expect(chatStore.chatViewMode).toBe('unread')
    expect(refreshUnreadFeed).toHaveBeenCalledTimes(1)
  })

  it('highlights unread without leaving the active conversation highlighted', async () => {
    const chatStore = useChatStore()
    chatStore.channels = [
      { id: 'channel-1', name: 'General', kind: 'channel', visibility: 'public', unread: 3, notificationLevel: NotificationLevel.ALL },
    ]
    chatStore.activeChannelId = 'channel-1'
    chatStore.chatViewMode = 'conversation'
    vi.spyOn(chatStore, 'refreshUnreadFeed').mockResolvedValue()

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', name: 'main', component: { template: '<div />' } }],
    })
    await router.push('/')
    await router.isReady()

    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [router],
        stubs: {
          SidebarItem: {
            props: ['active'],
            template: '<button class="sidebar-item" :class="{ active }" @click="$emit(\'click\')"><slot name="icon" /><slot /><slot name="actions" /></button>',
          },
          RouterLink: {
            template: '<a><slot /></a>',
          },
          Teleport: true,
        },
      },
    })

    expect(wrapper.get('.sidebar-item').classes()).toContain('active')

    await wrapper.get('[data-testid="sidebar-unread-button"]').trigger('click')
    await flushAll()

    expect(wrapper.get('[data-testid="sidebar-unread-button"]').classes()).toContain('bg-sidebar-active')
    expect(wrapper.get('.sidebar-item').classes()).not.toContain('active')
  })

  it('switches to saved message view on click', async () => {
    const chatStore = useChatStore()
    const refreshSavedMessages = vi.spyOn(chatStore, 'refreshSavedMessages').mockResolvedValue()

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', name: 'main', component: { template: '<div />' } }],
    })
    await router.push('/')
    await router.isReady()

    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [router],
        stubs: {
          SidebarItem: {
            template: '<button class="sidebar-item" @click="$emit(\'click\')"><slot name="icon" /><slot /><slot name="actions" /></button>',
          },
          RouterLink: {
            template: '<a><slot /></a>',
          },
          Teleport: true,
        },
      },
    })

    await wrapper.get('[data-testid="sidebar-saved-button"]').trigger('click')
    expect(chatStore.chatViewMode).toBe('saved')
    expect(refreshSavedMessages).toHaveBeenCalledTimes(1)
  })

  it('hides the leave action for a self dm', async () => {
    const authStore = useAuthStore()
    const chatStore = useChatStore()
    authStore.user = {
      id: 'user-1',
      email: 'ada@example.com',
      displayName: 'Ada',
      role: 'member',
    }
    authStore.sessionRole = 'member'
    chatStore.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfRole: 'member',
    }
    chatStore.directMessages = [
      {
        id: 'dm-self',
        userId: 'user-1',
        displayName: 'Ada',
        avatarUrl: '/api/public/avatars/avatars/user-1/avatar.png',
        presence: 'offline',
        unread: 0,
        notificationLevel: NotificationLevel.ALL,
      },
    ]

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: { template: '<div />' } }],
    })
    await router.push('/')
    await router.isReady()

    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [router],
        stubs: {
          SidebarItem: {
            template: '<button class="sidebar-item" @click="$emit(\'click\')"><slot name="icon" /><slot /><slot name="actions" /></button>',
          },
          RouterLink: {
            template: '<a><slot /></a>',
          },
          Teleport: true,
        },
      },
    })

    await wrapper.get('[data-testid="conversation-menu-button-dm-dm-self"]').trigger('click')
    await flushAll()

    expect(wrapper.find('[data-testid="conversation-leave-dm-dm-self"]').exists()).toBe(false)
  })

  it('hides users that already have an opened dm from the dm picker', async () => {
    chatApiMocks.listDmCandidates.mockResolvedValue([
      { user_id: 'user-2', display_name: 'Bob', email: 'bob@example.com', avatar_url: '' },
      { user_id: 'user-3', display_name: 'Eve', email: 'eve@example.com', avatar_url: '' },
    ])

    const authStore = useAuthStore()
    const chatStore = useChatStore()
    authStore.sessionRole = 'member'
    chatStore.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfRole: 'member',
    }
    chatStore.directMessages = [
      {
        id: 'dm-1',
        userId: 'user-2',
        displayName: 'Bob',
        avatarUrl: '',
        presence: 'offline',
        unread: 0,
        notificationLevel: NotificationLevel.ALL,
      },
    ]

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: { template: '<div />' } }],
    })
    await router.push('/')
    await router.isReady()

    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [router],
        stubs: {
          SidebarItem: {
            template: '<button class="sidebar-item" @click="$emit(\'click\')"><slot name="icon" /><slot /><slot name="actions" /></button>',
          },
          RouterLink: {
            template: '<a><slot /></a>',
          },
          Teleport: true,
        },
      },
    })

    await wrapper.get('[data-testid="new-message-button"]').trigger('click')
    await flushAll()

    expect(wrapper.find('[data-testid="dm-candidate-user-2"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="dm-candidate-user-3"]').exists()).toBe(true)
  })

  it('joins multiple channels and opens the first in dialog list order', async () => {
    const authStore = useAuthStore()
    const chatStore = useChatStore()
    authStore.sessionRole = 'member'
    chatStore.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfRole: 'member',
    }

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: { template: '<div />' } }],
    })
    await router.push('/')
    await router.isReady()

    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [router],
        stubs: {
          SidebarItem: {
            template: '<button class="sidebar-item" @click="$emit(\'click\')"><slot name="icon" /><slot /><slot name="actions" /></button>',
          },
          RouterLink: {
            template: '<a><slot /></a>',
          },
          Teleport: true,
        },
      },
    })

    await wrapper.get('[data-testid="add-channel-button"]').trigger('click')
    await flushAll()

    await wrapper.get('[data-testid="channel-candidate-channel-2"]').trigger('click')
    await wrapper.get('[data-testid="channel-candidate-channel-1"]').trigger('click')
    await wrapper.get('[data-testid="join-selected-channels-button"]').trigger('click')
    await flushAll()

    expect(chatApiMocks.joinChannels).toHaveBeenCalledWith(['channel-1', 'channel-2'])
    expect(chatStore.activeChannelId).toBe('channel-1')
    expect(chatStore.channels.map(channel => channel.id)).toEqual(['channel-2', 'channel-1'])
  })

  it('renders channel list in alphabetical order', async () => {
    const authStore = useAuthStore()
    const chatStore = useChatStore()
    authStore.sessionRole = 'member'
    chatStore.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfRole: 'member',
    }
    chatStore.channels = [
      { id: 'c2', name: 'zulu', kind: 'channel', visibility: 'public', unread: 0, notificationLevel: NotificationLevel.ALL },
      { id: 'c1', name: 'Alpha', kind: 'channel', visibility: 'public', unread: 0, notificationLevel: NotificationLevel.ALL },
    ]

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: { template: '<div />' } }],
    })
    await router.push('/')
    await router.isReady()

    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [router],
        stubs: {
          SidebarItem: {
            template: '<button class="sidebar-item" @click="$emit(\'click\')"><slot name="icon" /><slot /><slot name="actions" /></button>',
          },
          RouterLink: {
            template: '<a><slot /></a>',
          },
          Teleport: true,
        },
      },
    })

    const text = wrapper.text()
    expect(text.indexOf('Alpha')).toBeLessThan(text.indexOf('zulu'))
  })

  it('renders direct messages without activity alphabetically regardless of unread state', async () => {
    const authStore = useAuthStore()
    const chatStore = useChatStore()
    authStore.sessionRole = 'member'
    chatStore.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfRole: 'member',
    }
    chatStore.directMessages = [
      { id: 'dm-1', userId: 'user-4', displayName: 'Zulu', presence: 'offline', unread: 0, notificationLevel: NotificationLevel.ALL },
      { id: 'dm-2', userId: 'user-3', displayName: 'bravo', presence: 'offline', unread: 3, notificationLevel: NotificationLevel.ALL },
      { id: 'dm-3', userId: 'user-2', displayName: 'Alpha', presence: 'offline', unread: 0, notificationLevel: NotificationLevel.ALL },
      { id: 'dm-4', userId: 'user-5', displayName: 'charlie', presence: 'offline', unread: 0, notificationLevel: NotificationLevel.ALL },
    ]

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: { template: '<div />' } }],
    })
    await router.push('/')
    await router.isReady()

    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [router],
        stubs: {
          SidebarItem: {
            template: '<button class="sidebar-item" @click="$emit(\'click\')"><slot name="icon" /><slot /><slot name="actions" /></button>',
          },
          RouterLink: {
            template: '<a><slot /></a>',
          },
          Teleport: true,
        },
      },
    })

    const text = wrapper.text()
    expect(text.indexOf('Alpha')).toBeLessThan(text.indexOf('bravo'))
    expect(text.indexOf('bravo')).toBeLessThan(text.indexOf('charlie'))
    expect(text.indexOf('charlie')).toBeLessThan(text.indexOf('Zulu'))
  })

  it('shows lock icon for private channels', async () => {
    const authStore = useAuthStore()
    const chatStore = useChatStore()
    authStore.sessionRole = 'member'
    chatStore.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfRole: 'member',
    }
    chatStore.channels = [
      { id: 'private-1', name: 'Secret', kind: 'channel', visibility: 'private', unread: 0, notificationLevel: NotificationLevel.ALL },
    ]

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: { template: '<div />' } }],
    })
    await router.push('/')
    await router.isReady()

    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [router],
        stubs: {
          SidebarItem: {
            template: '<button class="sidebar-item" @click="$emit(\'click\')"><slot name="icon" /><slot /><slot name="actions" /></button>',
          },
          RouterLink: {
            template: '<a><slot /></a>',
          },
          Teleport: true,
        },
      },
    })

    expect(wrapper.find('[data-testid="channel-private-icon-private-1"]').exists()).toBe(true)
  })

  it('shows active call icon for a channel conversation', async () => {
    const authStore = useAuthStore()
    const chatStore = useChatStore()
    authStore.sessionRole = 'member'
    chatStore.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfRole: 'member',
    }
    chatStore.channels = [
      { id: 'channel-1', name: 'General', kind: 'channel', visibility: 'public', unread: 0, notificationLevel: NotificationLevel.ALL },
    ]
    chatStore.activeCalls = [
      { id: 'call-1', conversationId: 'channel-1', status: '1', participantCount: 2 },
    ]

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: { template: '<div />' } }],
    })
    await router.push('/')
    await router.isReady()

    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [router],
        stubs: {
          SidebarItem: {
            template: '<button class="sidebar-item" @click="$emit(\'click\')"><slot name="icon" /><slot /><slot name="actions" /></button>',
          },
          RouterLink: {
            template: '<a><slot /></a>',
          },
          Teleport: true,
        },
      },
    })

    expect(wrapper.find('[data-testid="active-call-icon-channel-channel-1"]').exists()).toBe(true)
  })

  it('shows and hides active call icon for a DM conversation from user call presence updates', async () => {
    const authStore = useAuthStore()
    const chatStore = useChatStore()
    authStore.sessionRole = 'member'
    chatStore.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfRole: 'member',
    }
    chatStore.directMessages = [
      { id: 'dm-1', userId: 'user-2', displayName: 'Bob', presence: 'online', unread: 0, notificationLevel: NotificationLevel.ALL },
    ]
    chatStore.userCallPresenceByUserId = { 'user-2': 1 }

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: { template: '<div />' } }],
    })
    await router.push('/')
    await router.isReady()

    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [router],
        stubs: {
          SidebarItem: {
            template: '<button class="sidebar-item" @click="$emit(\'click\')"><slot name="icon" /><slot /><slot name="actions" /></button>',
          },
          RouterLink: {
            template: '<a><slot /></a>',
          },
          Teleport: true,
        },
      },
    })

    expect(wrapper.find('[data-testid="active-call-icon-dm-dm-1"]').exists()).toBe(true)

    chatStore.userCallPresenceByUserId = {}
    await flushAll()
    expect(wrapper.find('[data-testid="active-call-icon-dm-dm-1"]').exists()).toBe(false)
  })

  it('navigates from admin page to main when selecting a conversation', async () => {
    const authStore = useAuthStore()
    const chatStore = useChatStore()
    authStore.sessionRole = 'admin'
    chatStore.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfRole: 'admin',
    }
    chatStore.channels = [
      { id: 'channel-1', name: 'General', kind: 'channel', visibility: 'public', unread: 0, notificationLevel: NotificationLevel.ALL },
    ]

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'main', component: { template: '<div />' } },
        { path: '/admin', name: 'admin', component: { template: '<div />' } },
      ],
    })
    await router.push('/admin')
    await router.isReady()

    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [router],
        stubs: {
          SidebarItem: {
            template: '<button class="sidebar-item" @click="$emit(\'click\')"><slot name="icon" /><slot /><slot name="actions" /></button>',
          },
          RouterLink: {
            template: '<a><slot /></a>',
          },
          Teleport: true,
        },
      },
    })

    const channelButton = wrapper.findAll('button.sidebar-item').find(button => button.text().includes('General'))
    expect(channelButton).toBeTruthy()
    await channelButton!.trigger('click')
    await flushAll()

    expect(chatStore.activeChannelId).toBe('channel-1')
    await vi.waitFor(() => {
      expect(router.currentRoute.value.name).toBe('main')
    })
  })

  it('sends manual away presence from sidebar user block', async () => {
    const authStore = useAuthStore()
    const chatStore = useChatStore()
    const wsStore = useWsStore()
    wsStore.state = 'LIVE_SYNCED'
    const sendSetPresenceSpy = vi.spyOn(wsStore, 'sendSetPresence')

    authStore.user = {
      id: 'user-1',
      email: 'ada@example.com',
      displayName: 'Ada',
      role: 'member',
    }
    authStore.sessionRole = 'member'
    chatStore.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfRole: 'member',
    }

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: { template: '<div />' } }],
    })
    await router.push('/')
    await router.isReady()

    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [router],
        stubs: {
          SidebarItem: {
            template: '<button class="sidebar-item" @click="$emit(\'click\')"><slot name="icon" /><slot /><slot name="actions" /></button>',
          },
          RouterLink: {
            template: '<a><slot /></a>',
          },
          Teleport: true,
        },
      },
    })

    await wrapper.get('[data-testid="presence-menu-button"]').trigger('click')
    await wrapper.get('[data-testid="presence-set-away"]').trigger('click')

    expect(sendSetPresenceSpy).toHaveBeenCalledWith(PresenceStatus.AWAY)
    expect(storage.getItem('msgnr:manual-presence')).toBe('away')
  })

  it('leaves selected channel via conversation menu', async () => {
    const authStore = useAuthStore()
    const chatStore = useChatStore()
    authStore.sessionRole = 'member'
    chatStore.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfRole: 'member',
    }
    chatStore.channels = [
      { id: 'channel-1', name: 'General', kind: 'channel', visibility: 'public', unread: 0, notificationLevel: NotificationLevel.ALL },
    ]
    chatStore.activeChannelId = 'channel-1'

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: { template: '<div />' } }],
    })
    await router.push('/')
    await router.isReady()

    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [router],
        stubs: {
          SidebarItem: {
            template: '<button class="sidebar-item" @click="$emit(\'click\')"><slot name="icon" /><slot /><slot name="actions" /></button>',
          },
          RouterLink: {
            template: '<a><slot /></a>',
          },
          Teleport: true,
        },
      },
    })

    await wrapper.get('[data-testid="conversation-menu-button-channel-channel-1"]').trigger('click')
    await wrapper.get('[data-testid="conversation-leave-channel-channel-1"]').trigger('click')
    await flushAll()

    expect(chatApiMocks.leaveConversation).toHaveBeenCalledWith('channel-1')
    expect(chatStore.channels).toEqual([])
    expect(chatStore.activeChannelId).toBe('')
  })

  it('clears DM history from the conversation menu after confirmation', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const authStore = useAuthStore()
    const chatStore = useChatStore()
    authStore.sessionRole = 'member'
    chatStore.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfRole: 'member',
    }
    chatStore.directMessages = [
      {
        id: 'dm-1',
        userId: 'user-2',
        displayName: 'Bob',
        avatarUrl: '',
        presence: 'online',
        unread: 2,
        hasUnreadThreadReplies: true,
        notificationLevel: NotificationLevel.ALL,
      },
    ]
    chatStore.messages = {
      'dm-1': [{
        id: 'message-1',
        channelId: 'dm-1',
        senderId: 'user-2',
        senderName: 'Bob',
        body: 'history',
        channelSeq: 1n,
        threadSeq: 0n,
        mentionedUserIds: [],
        mentionEveryone: false,
        createdAt: '2026-03-06T00:00:00Z',
        reactions: [],
        myReactions: [],
      }],
    }

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: { template: '<div />' } }],
    })
    await router.push('/')
    await router.isReady()

    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [router],
        stubs: {
          SidebarItem: {
            template: '<button class="sidebar-item" @click="$emit(\'click\')"><slot name="icon" /><slot /><slot name="actions" /></button>',
          },
          RouterLink: {
            template: '<a><slot /></a>',
          },
          Teleport: true,
        },
      },
    })

    await wrapper.get('[data-testid="conversation-menu-button-dm-dm-1"]').trigger('click')
    await wrapper.get('[data-testid="conversation-clear-history-dm-dm-1"]').trigger('click')
    await flushAll()

    expect(confirmSpy).toHaveBeenCalled()
    expect(chatApiMocks.clearDMConversationHistory).toHaveBeenCalledWith('dm-1')
    expect(chatStore.directMessages).toHaveLength(1)
    expect(chatStore.directMessages[0].unread).toBe(0)
    expect(chatStore.directMessages[0].hasUnreadThreadReplies).toBe(false)
    expect(chatStore.messages['dm-1']).toEqual([])

    confirmSpy.mockRestore()
  })

  it('uses workspace user call presence for DM icons and keeps channel icons conversation-scoped', async () => {
    const authStore = useAuthStore()
    const chatStore = useChatStore()
    authStore.sessionRole = 'member'
    chatStore.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfRole: 'member',
    }
    chatStore.channels = [
      { id: 'channel-1', name: 'General', kind: 'channel', visibility: 'public', unread: 0, notificationLevel: NotificationLevel.ALL },
    ]
    chatStore.directMessages = [
      { id: 'dm-1', userId: 'user-2', displayName: 'Bob', avatarUrl: '', presence: 'offline', unread: 0, notificationLevel: NotificationLevel.ALL },
    ]
    chatStore.activeCalls = [
      { id: 'call-1', conversationId: 'channel-1', status: String(1), participantCount: 1 },
    ]
    chatStore.userCallPresenceByUserId = {
      'user-2': 1,
    }

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: { template: '<div />' } }],
    })
    await router.push('/')
    await router.isReady()

    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [router],
        stubs: {
          SidebarItem: {
            template: '<button class="sidebar-item" @click="$emit(\'click\')"><slot name="icon" /><slot /><slot name="actions" /></button>',
          },
          RouterLink: {
            template: '<a><slot /></a>',
          },
          Teleport: true,
        },
      },
    })

    expect(wrapper.find('[data-testid="active-call-icon-channel-channel-1"]').exists()).toBe(true)
    const dmIcon = wrapper.find('[data-testid="active-call-icon-dm-dm-1"]')
    expect(dmIcon.exists()).toBe(true)
    expect(dmIcon.attributes('title')).toBe('In a call')
  })

  it('renders a hash icon for public channels and a lock icon for private ones', () => {
    const chatStore = useChatStore()
    chatStore.bootstrapped = true
    chatStore.channels = [
      { id: 'channel-1', name: 'General', kind: 'channel', visibility: 'public', unread: 0, notificationLevel: NotificationLevel.ALL },
      { id: 'channel-2', name: 'Secret', kind: 'channel', visibility: 'private', unread: 0, notificationLevel: NotificationLevel.ALL },
    ]

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: { template: '<div />' } }],
    })
    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [router],
        stubs: {
          SidebarItem: {
            template: '<button class="sidebar-item" @click="$emit(\'click\')"><slot name="icon" /><slot /><slot name="actions" /></button>',
          },
          RouterLink: { template: '<a><slot /></a>' },
          Teleport: true,
        },
      },
    })

    expect(wrapper.find('[data-testid="channel-hash-icon-channel-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="channel-private-icon-channel-2"]').exists()).toBe(true)
  })

  it('opens the conversation menu on right-click', async () => {
    const chatStore = useChatStore()
    chatStore.bootstrapped = true
    chatStore.channels = [
      { id: 'channel-1', name: 'General', kind: 'channel', visibility: 'public', unread: 0, notificationLevel: NotificationLevel.ALL },
    ]

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: { template: '<div />' } }],
    })
    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [router],
        stubs: {
          SidebarItem: {
            template: '<button class="sidebar-item" @click="$emit(\'click\')"><slot name="icon" /><slot /><slot name="actions" /></button>',
          },
          RouterLink: { template: '<a><slot /></a>' },
          Teleport: true,
        },
      },
    })

    expect(wrapper.find('[data-testid="conversation-leave-channel-channel-1"]').exists()).toBe(false)

    await wrapper.get('.sidebar-item').trigger('contextmenu')
    await flushAll()

    expect(wrapper.find('[data-testid="conversation-leave-channel-channel-1"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Leave')
  })

  it('shows empty-state hints after bootstrap and skeletons before it', () => {
    const chatStore = useChatStore()
    chatStore.bootstrapped = false

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: { template: '<div />' } }],
    })
    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [router],
        stubs: {
          SidebarItem: {
            template: '<button class="sidebar-item" @click="$emit(\'click\')"><slot name="icon" /><slot /><slot name="actions" /></button>',
          },
          RouterLink: { template: '<a><slot /></a>' },
          Teleport: true,
        },
      },
    })

    expect(wrapper.text()).not.toContain('No channels yet')
    expect(wrapper.text()).not.toContain('No conversations yet')
    expect(wrapper.findAll('.animate-pulse').length).toBeGreaterThan(0)

    chatStore.bootstrapped = true
    return wrapper.vm.$nextTick().then(() => {
      expect(wrapper.text()).toContain('No channels yet')
      expect(wrapper.text()).toContain('No conversations yet')
    })
  })
})

describe('AppSidebar direct message ordering', () => {
  let pinia: ReturnType<typeof createPinia>

  beforeEach(() => {
    ensureLocalStorageMock()
    pinia = createPinia()
    setActivePinia(pinia)
    storage.clear()
    vi.clearAllMocks()
    chatApiMocks.listConversationMessages.mockResolvedValue({ messages: [], has_more: false, page_size: 50 })
    chatApiMocks.listUnreadFeed.mockResolvedValue({ total_count: 0, items: [] })
    chatApiMocks.listDmCandidates.mockResolvedValue([])
  })

  afterEach(() => {
    useChatStore().resetRuntimeState()
    vi.restoreAllMocks()
  })

  function buildDm(id: string, displayName: string, overrides: Record<string, unknown> = {}) {
    return {
      id,
      userId: `user-${id}`,
      displayName,
      avatarUrl: '',
      presence: 'offline' as const,
      encryptionMode: 'none' as const,
      unread: 0,
      notificationLevel: NotificationLevel.ALL,
      ...overrides,
    }
  }

  async function mountSidebarWith(dms: ReturnType<typeof buildDm>[]) {
    const chatStore = useChatStore()
    chatStore.bootstrapped = true
    chatStore.workspace = {
      id: 'workspace-1',
      name: 'Acme',
      selfUserId: 'user-1',
      selfDisplayName: 'Ada',
      selfRole: 'member',
    }
    chatStore.directMessages = dms

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', name: 'main', component: { template: '<div />' } }],
    })
    await router.push('/')
    await router.isReady()

    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [pinia, router],
        stubs: {
          RouterLink: { template: '<a><slot /></a>' },
          Teleport: true,
        },
      },
    })
    await flushAll()
    return { wrapper, chatStore }
  }

  function renderedDmOrder(wrapper: Awaited<ReturnType<typeof mountSidebarWith>>['wrapper']) {
    return wrapper.findAll('[data-testid^="conversation-menu-button-dm-"]')
      .map(node => node.attributes('data-testid')!.replace('conversation-menu-button-dm-', ''))
  }

  it('orders direct messages by latest activity regardless of unread state', async () => {
    const { wrapper } = await mountSidebarWith([
      buildDm('dm-alex', 'Alex', { lastActivityAt: '2026-01-01T10:00:00.000Z' }),
      buildDm('dm-morgan', 'Morgan', { lastActivityAt: '2026-01-03T10:00:00.000Z' }),
      buildDm('dm-taylor', 'Taylor', { lastActivityAt: '2026-01-02T10:00:00.000Z', unread: 5 }),
    ])

    // Alphabetical would be Alex, Morgan, Taylor and unread-first would put
    // Taylor on top; latest-activity order must win over both.
    expect(renderedDmOrder(wrapper)).toEqual(['dm-morgan', 'dm-taylor', 'dm-alex'])
  })

  it('keeps the order when an unread conversation is read', async () => {
    const { wrapper, chatStore } = await mountSidebarWith([
      buildDm('dm-alex', 'Alex', { lastActivityAt: '2026-01-01T10:00:00.000Z' }),
      buildDm('dm-morgan', 'Morgan', { lastActivityAt: '2026-01-03T10:00:00.000Z' }),
      buildDm('dm-taylor', 'Taylor', { lastActivityAt: '2026-01-02T10:00:00.000Z', lastMessageSeq: 5n, unread: 5 }),
    ])
    expect(renderedDmOrder(wrapper)).toEqual(['dm-morgan', 'dm-taylor', 'dm-alex'])

    const taylor = wrapper.findAllComponents(SidebarItem).find(item => item.text().includes('Taylor'))!
    expect(taylor.find('.text-sidebar-unreadBadge').text()).toBe('5')
    await taylor.find('button').trigger('click')
    await flushAll()

    expect(renderedDmOrder(wrapper)).toEqual(['dm-morgan', 'dm-taylor', 'dm-alex'])
    expect(chatStore.directMessages.find(dm => dm.id === 'dm-taylor')!.unread).toBe(0)
    expect(taylor.find('.text-sidebar-unreadBadge').exists()).toBe(false)
  })

  it('moves a conversation to the top when its activity timestamp advances', async () => {
    const { wrapper, chatStore } = await mountSidebarWith([
      buildDm('dm-alex', 'Alex', { lastActivityAt: '2026-01-01T10:00:00.000Z' }),
      buildDm('dm-morgan', 'Morgan', { lastActivityAt: '2026-01-03T10:00:00.000Z' }),
      buildDm('dm-taylor', 'Taylor', { lastActivityAt: '2026-01-02T10:00:00.000Z' }),
    ])
    expect(renderedDmOrder(wrapper)).toEqual(['dm-morgan', 'dm-taylor', 'dm-alex'])

    chatStore.directMessages.find(dm => dm.id === 'dm-alex')!.lastActivityAt = '2026-01-04T10:00:00.000Z'
    await flushAll()

    expect(renderedDmOrder(wrapper)).toEqual(['dm-alex', 'dm-morgan', 'dm-taylor'])
  })

  it('sorts conversations without activity data last and falls back to name', async () => {
    const { wrapper } = await mountSidebarWith([
      buildDm('dm-carol', 'Carol'),
      buildDm('dm-alex', 'Alex', { lastActivityAt: '2026-01-01T10:00:00.000Z' }),
      buildDm('dm-bob', 'Bob'),
    ])

    expect(renderedDmOrder(wrapper)).toEqual(['dm-alex', 'dm-bob', 'dm-carol'])
  })

  it('uses deterministic tie breaks for equal, missing and invalid timestamps', async () => {
    const { wrapper, chatStore } = await mountSidebarWith([
      buildDm('dm-z', 'Same', { lastActivityAt: '2026-01-01T00:00:00.500Z', lastMessageSeq: 4n }),
      buildDm('dm-a', 'Same', { lastActivityAt: '2026-01-01T00:00:00.500Z', lastMessageSeq: 4n }),
      buildDm('dm-seq', 'Zulu', { lastActivityAt: '2026-01-01T00:00:00.500Z', lastMessageSeq: 8n }),
      buildDm('dm-bob', 'Bob', { lastActivityAt: 'invalid', unread: 9 }),
      buildDm('dm-alex', 'Alex'),
    ])
    expect(renderedDmOrder(wrapper)).toEqual(['dm-seq', 'dm-a', 'dm-z', 'dm-alex', 'dm-bob'])
    chatStore.directMessages.reverse()
    await flushAll()
    expect(renderedDmOrder(wrapper)).toEqual(['dm-seq', 'dm-a', 'dm-z', 'dm-alex', 'dm-bob'])
  })

  it('keeps the example order through incoming, reading, sending and reconnect bootstrap', async () => {
    const { wrapper, chatStore } = await mountSidebarWith([
      buildDm('dm-alex', 'Alex', { lastActivityAt: '2026-01-03T00:00:00.000Z', lastMessageSeq: 3n }),
      buildDm('dm-morgan', 'Morgan', { lastActivityAt: '2026-01-02T00:00:00.000Z', lastMessageSeq: 2n }),
      buildDm('dm-taylor', 'Taylor', { lastActivityAt: '2026-01-01T00:00:00.000Z', lastMessageSeq: 1n }),
    ])
    useWsStore().state = 'LIVE_SYNCED'
    expect(renderedDmOrder(wrapper)).toEqual(['dm-alex', 'dm-morgan', 'dm-taylor'])
    chatStore.handleServerEvent(create(ServerEventSchema, {
      eventSeq: 1n, eventId: 'incoming-taylor', conversationId: 'dm-taylor',
      payload: { case: 'messageCreated', value: create(MessageEventSchema, {
        conversationId: 'dm-taylor', messageId: 'taylor-message', senderId: 'user-dm-taylor',
        channelSeq: 2n, createdAt: { seconds: 1767484800n, nanos: 250_000_000 }, body: 'hello',
      }) },
    }))
    chatStore.handleServerEvent(create(ServerEventSchema, {
      payload: { case: 'readCounterUpdated', value: create(ReadCounterUpdatedEventSchema, {
        counter: create(UnreadCounterSchema, { conversationId: 'dm-taylor', unreadMessages: 1 }),
      }) },
    }))
    await flushAll()
    expect(renderedDmOrder(wrapper)).toEqual(['dm-taylor', 'dm-alex', 'dm-morgan'])
    const taylor = wrapper.findAllComponents(SidebarItem).find(item => item.text().includes('Taylor'))!
    expect(taylor.find('.text-sidebar-unreadBadge').text()).toBe('1')
    await taylor.find('button').trigger('click')
    await flushAll()
    expect(renderedDmOrder(wrapper)).toEqual(['dm-taylor', 'dm-alex', 'dm-morgan'])
    expect(taylor.find('.text-sidebar-unreadBadge').exists()).toBe(false)

    chatStore.sendMessageToConversation('dm-morgan', 'outgoing')
    await flushAll()
    expect(renderedDmOrder(wrapper)).toEqual(['dm-morgan', 'dm-taylor', 'dm-alex'])

    // Reconnect/reload replaces runtime state with server summaries, whose
    // unread counters and delivery order differ from the visible activity order.
    chatStore.handleBootstrapResponse(create(BootstrapResponseSchema, {
      snapshotSeq: 2n, bootstrapSessionId: 'reconnected-order',
      conversations: [
        create(ConversationSummarySchema, { conversationId: 'dm-alex', conversationType: 1, title: 'Alex', topic: 'user-dm-alex', lastMessageSeq: 3n, lastActivityAt: { seconds: 1767398400n, nanos: 0 } }),
        create(ConversationSummarySchema, { conversationId: 'dm-taylor', conversationType: 1, title: 'Taylor', topic: 'user-dm-taylor', lastMessageSeq: 2n, lastActivityAt: { seconds: 1767484800n, nanos: 250_000_000 } }),
        create(ConversationSummarySchema, { conversationId: 'dm-morgan', conversationType: 1, title: 'Morgan', topic: 'user-dm-morgan', lastMessageSeq: 3n, lastActivityAt: { seconds: 1767484800n, nanos: 750_000_000 } }),
      ],
      unread: [create(UnreadCounterSchema, { conversationId: 'dm-alex', unreadMessages: 2 })],
    }))
    await flushAll()
    expect(renderedDmOrder(wrapper)).toEqual(['dm-morgan', 'dm-taylor', 'dm-alex'])
    const alex = wrapper.findAllComponents(SidebarItem).find(item => item.text().includes('Alex'))!
    expect(alex.find('.text-sidebar-unreadBadge').text()).toBe('2')
    wrapper.unmount()
  })

  it('restores the same sidebar order from cached conversations in a fresh app session', async () => {
    const dms = [
      buildDm('dm-alex', 'Alex', { lastActivityAt: '2026-01-01T00:00:00.000Z' }),
      buildDm('dm-morgan', 'Morgan', { lastActivityAt: '2026-01-01T00:00:00.750Z' }),
      buildDm('dm-taylor', 'Taylor', { lastActivityAt: '2026-01-01T00:00:00.250Z', unread: 3 }),
    ]
    vi.spyOn(cacheService, 'loadCachedConversations').mockResolvedValue({ channels: [], dms })
    vi.spyOn(cacheService, 'loadCachedMessages').mockResolvedValue([])
    const { wrapper, chatStore } = await mountSidebarWith([])
    expect(await chatStore.loadCachedState()).toBe(true)
    await flushAll()
    expect(renderedDmOrder(wrapper)).toEqual(['dm-morgan', 'dm-taylor', 'dm-alex'])
    wrapper.unmount()
  })
})
