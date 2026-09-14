import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import AdminView from '@/views/AdminView.vue'
import { useAuthStore } from '@/stores/auth'
import { useChatStore } from '@/stores/chat'
import { useWsStore } from '@/stores/ws'

const adminApiMocks = vi.hoisted(() => ({
  adminListUsers: vi.fn(),
  adminCreateUser: vi.fn(),
  adminBlockUser: vi.fn(),
  adminUnblockUser: vi.fn(),
  adminListChannels: vi.fn(),
  adminCreateChannel: vi.fn(),
  adminRenameChannel: vi.fn(),
  adminDeleteChannel: vi.fn(),
  adminGetLogs: vi.fn(),
}))

vi.mock('@/services/http/adminApi', () => ({
  adminListUsers: adminApiMocks.adminListUsers,
  adminCreateUser: adminApiMocks.adminCreateUser,
  adminBlockUser: adminApiMocks.adminBlockUser,
  adminUnblockUser: adminApiMocks.adminUnblockUser,
  adminListChannels: adminApiMocks.adminListChannels,
  adminCreateChannel: adminApiMocks.adminCreateChannel,
  adminRenameChannel: adminApiMocks.adminRenameChannel,
  adminDeleteChannel: adminApiMocks.adminDeleteChannel,
  adminGetLogs: adminApiMocks.adminGetLogs,
}))

vi.mock('@/components/AppSidebar.vue', () => ({
  default: {
    template: '<aside data-testid="sidebar" />',
  },
}))

vi.mock('@/components/ResizableSidebar.vue', () => ({
  default: {
    template: '<div data-testid="resizable-sidebar"><slot /></div>',
  },
}))

async function flushAll() {
  await Promise.resolve()
  await nextTick()
}

describe('AdminView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    adminApiMocks.adminListUsers.mockResolvedValue([])
    adminApiMocks.adminListChannels.mockResolvedValue([])
    adminApiMocks.adminGetLogs.mockResolvedValue([])
  })

  it('loads channels when the channels tab is opened', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/admin', component: AdminView }],
    })
    router.push('/admin')
    await router.isReady()

    const wrapper = mount(AdminView, {
      global: {
        plugins: [router],
        stubs: {
          Teleport: true,
        },
      },
    })

    await flushAll()
    expect(adminApiMocks.adminListUsers).toHaveBeenCalledTimes(1)
    expect(adminApiMocks.adminListChannels).not.toHaveBeenCalled()

    const channelsTab = wrapper.findAll('button').find((button) => button.text() === 'Channels')
    expect(channelsTab).toBeTruthy()
    await channelsTab!.trigger('click')
    await flushAll()

    expect(adminApiMocks.adminListChannels).toHaveBeenCalledTimes(1)
  })

  it('starts realtime shell flow on mount for admin route', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/admin', component: AdminView }],
    })
    router.push('/admin')
    await router.isReady()

    const authStore = useAuthStore()
    const chatStore = useChatStore()
    const wsStore = useWsStore()
    authStore.accessToken = 'access-token'
    wsStore.state = 'AUTH_COMPLETE'
    chatStore.registerWsHandlers = vi.fn()
    chatStore.startRealtimeFlow = vi.fn()

    mount(AdminView, {
      global: {
        plugins: [router],
        stubs: {
          Teleport: true,
        },
      },
    })

    await flushAll()

    expect(chatStore.registerWsHandlers).toHaveBeenCalledTimes(1)
    expect(chatStore.startRealtimeFlow).toHaveBeenCalledTimes(1)
  })

  it('creates private channel with selected members and hides add-all toggle', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/admin', component: AdminView }],
    })
    router.push('/admin')
    await router.isReady()

    const authStore = useAuthStore()
    authStore.user = {
      id: 'admin-1',
      email: 'admin@example.com',
      displayName: 'Admin',
      role: 'admin',
    }
    adminApiMocks.adminListUsers.mockResolvedValue([
      {
        id: 'admin-1',
        email: 'admin@example.com',
        display_name: 'Admin',
        role: 'admin',
        status: 'active',
        created_at: '2026-03-06T00:00:00Z',
      },
      {
        id: 'member-1',
        email: 'member1@example.com',
        display_name: 'Member One',
        role: 'member',
        status: 'active',
        created_at: '2026-03-06T00:00:00Z',
      },
    ])
    adminApiMocks.adminCreateChannel.mockResolvedValue({
      id: 'channel-1',
      kind: 'channel',
      name: 'secret',
      visibility: 'private',
      is_archived: false,
      created_at: '2026-03-06T00:00:00Z',
    })

    const wrapper = mount(AdminView, {
      global: {
        plugins: [router],
        stubs: {
          Teleport: true,
        },
      },
    })

    await flushAll()
    const channelsTab = wrapper.findAll('button').find((button) => button.text() === 'Channels')
    expect(channelsTab).toBeTruthy()
    await channelsTab!.trigger('click')
    await flushAll()

    const createButton = wrapper.findAll('button').find((button) => button.text() === 'Create Channel')
    expect(createButton).toBeTruthy()
    await createButton!.trigger('click')
    await flushAll()

    await wrapper.get('input[placeholder="channel-name"]').setValue('secret')
    await wrapper.get('select').setValue('private')
    await flushAll()

    expect(wrapper.text()).not.toContain('Add all users to this channel')
    await wrapper.get('[data-testid="private-member-checkbox-member-1"]').setValue(true)
    await wrapper.findAll('button').find((button) => button.text() === 'Create')?.trigger('click')
    await flushAll()

    expect(adminApiMocks.adminCreateChannel).toHaveBeenCalledWith({
      kind: 'channel',
      name: 'secret',
      visibility: 'private',
      add_all_users: false,
      member_ids: ['member-1'],
    })
  })

  it('requires at least one selected member for private channel', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/admin', component: AdminView }],
    })
    router.push('/admin')
    await router.isReady()

    const authStore = useAuthStore()
    authStore.user = {
      id: 'admin-1',
      email: 'admin@example.com',
      displayName: 'Admin',
      role: 'admin',
    }
    adminApiMocks.adminListUsers.mockResolvedValue([
      {
        id: 'admin-1',
        email: 'admin@example.com',
        display_name: 'Admin',
        role: 'admin',
        status: 'active',
        created_at: '2026-03-06T00:00:00Z',
      },
      {
        id: 'member-1',
        email: 'member1@example.com',
        display_name: 'Member One',
        role: 'member',
        status: 'active',
        created_at: '2026-03-06T00:00:00Z',
      },
    ])

    const wrapper = mount(AdminView, {
      global: {
        plugins: [router],
        stubs: {
          Teleport: true,
        },
      },
    })

    await flushAll()
    const channelsTab = wrapper.findAll('button').find((button) => button.text() === 'Channels')
    expect(channelsTab).toBeTruthy()
    await channelsTab!.trigger('click')
    await flushAll()

    const createButton = wrapper.findAll('button').find((button) => button.text() === 'Create Channel')
    expect(createButton).toBeTruthy()
    await createButton!.trigger('click')
    await flushAll()

    await wrapper.get('input[placeholder="channel-name"]').setValue('private-1')
    await wrapper.get('select').setValue('private')
    await flushAll()

    const submit = wrapper.findAll('button').find((button) => button.text() === 'Create')
    expect(submit).toBeTruthy()
    expect((submit!.element as HTMLButtonElement).disabled).toBe(true)
    await submit!.trigger('click')
    expect(adminApiMocks.adminCreateChannel).not.toHaveBeenCalled()
  })

  it('renames channel from row click', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/admin', component: AdminView }],
    })
    router.push('/admin')
    await router.isReady()

    adminApiMocks.adminListChannels.mockResolvedValue([
      {
        id: 'channel-1',
        kind: 'channel',
        name: 'old-name',
        visibility: 'public',
        is_archived: false,
        created_at: '2026-03-06T00:00:00Z',
      },
    ])
    adminApiMocks.adminRenameChannel.mockResolvedValue({
      id: 'channel-1',
      kind: 'channel',
      name: 'renamed',
      visibility: 'public',
      is_archived: false,
      created_at: '2026-03-06T00:00:00Z',
    })

    const wrapper = mount(AdminView, {
      global: {
        plugins: [router],
        stubs: {
          Teleport: true,
        },
      },
    })

    await flushAll()
    const channelsTab = wrapper.findAll('button').find((button) => button.text() === 'Channels')
    expect(channelsTab).toBeTruthy()
    await channelsTab!.trigger('click')
    await flushAll()

    await wrapper.get('[data-testid=\"channel-row-channel-1\"]').trigger('click')
    await flushAll()

    await wrapper.get('input[placeholder=\"#channel-name\"]').setValue('renamed')
    const saveButton = wrapper.findAll('button').find((button) => button.text() === 'Save')
    expect(saveButton).toBeTruthy()
    await saveButton!.trigger('click')
    await flushAll()

    expect(adminApiMocks.adminRenameChannel).toHaveBeenCalledWith('channel-1', { name: 'renamed' })
  })
})
