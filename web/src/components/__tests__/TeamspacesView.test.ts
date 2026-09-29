import { reactive } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TeamspacesView from '@/components/documents/TeamspacesView.vue'

const authStoreMock = reactive({ effectiveRole: 'member' })
vi.mock('@/stores/auth', () => ({ useAuthStore: () => authStoreMock }))

const documentsStoreMock = reactive({
  teamspaces: [] as any[],
  teamspacesLoading: false,
  teamspacesError: null as string | null,
  users: [] as any[],
  usersLoaded: true,
  bots: [] as any[],
  botsLoading: false,
  botsError: null as string | null,
  loadBots: vi.fn(async () => {}),
  loadTeamspaces: vi.fn(async () => {}),
  loadUsers: vi.fn(async () => {}),
  createTeamspace: vi.fn(),
  updateTeamspace: vi.fn(),
  deleteTeamspace: vi.fn(async () => {}),
  joinTeamspace: vi.fn(),
})

vi.mock('@/stores/documents', () => ({
  useDocumentsStore: () => documentsStoreMock,
}))

describe('TeamspacesView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    documentsStoreMock.teamspaces = []
    documentsStoreMock.teamspacesLoading = false
    documentsStoreMock.teamspacesError = null
    documentsStoreMock.users = []
    documentsStoreMock.usersLoaded = true
    documentsStoreMock.bots = []
    documentsStoreMock.botsLoading = false
    documentsStoreMock.botsError = null
    authStoreMock.effectiveRole = 'member'
  })

  it.each(['admin', 'owner'])('lets %s select bots in create and edit member lists', async (role) => {
    authStoreMock.effectiveRole = role
    documentsStoreMock.users = [{ id: 'human', display_name: 'Human', email: 'human@example.com' }]
    documentsStoreMock.bots = [{ id: 'bot', display_name: 'Docs bot', email: 'bot@example.com' }]
    const teamspace = {
      id: 'space', name: 'Docs', is_private: false, is_member: true, can_manage: true,
      members: [{ id: 'human' }], member_count: 1,
    }
    documentsStoreMock.teamspaces = [teamspace]
    documentsStoreMock.createTeamspace.mockResolvedValue(teamspace)
    documentsStoreMock.updateTeamspace.mockResolvedValue(teamspace)
    const wrapper = mount(TeamspacesView, {
      props: { selectedTeamspaceId: null }, global: { stubs: { Teleport: true, UserAvatar: true } },
    })
    const button = (label: string) => wrapper.findAll('button').find(item => item.text() === label)!

    await button('Edit').trigger('click')
    expect(documentsStoreMock.loadBots).toHaveBeenCalledOnce()
    expect(wrapper.get('[data-testid="teamspace-member-bot"]').element.parentElement?.textContent).toContain('Bot')
    await wrapper.get('[data-testid="teamspace-member-bot"]').setValue(true)
    await button('Save').trigger('click')
    await flushPromises()
    expect(documentsStoreMock.updateTeamspace).toHaveBeenCalledWith('space', {
      name: 'Docs', is_private: false, member_ids: ['human', 'bot'],
    })

    await wrapper.get('[data-testid="documents-create-teamspace"]').trigger('click')
    await wrapper.get('input[placeholder="Engineering docs"]').setValue('New docs')
    await wrapper.get('[data-testid="teamspace-member-bot"]').setValue(true)
    await button('Create').trigger('click')
    await flushPromises()
    expect(documentsStoreMock.createTeamspace).toHaveBeenCalledWith({
      name: 'New docs', is_private: false, member_ids: ['bot'],
    })
    wrapper.unmount()
  })

  it('hides bot candidates for non-admin owners and preserves existing bot membership on save', async () => {
    documentsStoreMock.bots = [{ id: 'bot', display_name: 'Docs bot' }]
    documentsStoreMock.teamspaces = [{
      id: 'space', name: 'Docs', is_private: false, is_member: true, can_manage: true,
      members: [{ id: 'bot' }], member_count: 1,
    }]
    documentsStoreMock.updateTeamspace.mockResolvedValue({ id: 'space' })
    const wrapper = mount(TeamspacesView, {
      props: { selectedTeamspaceId: null }, global: { stubs: { Teleport: true, UserAvatar: true } },
    })
    await wrapper.findAll('button').find(item => item.text() === 'Edit')!.trigger('click')
    expect(wrapper.find('[data-testid="teamspace-member-bot"]').exists()).toBe(false)
    await wrapper.get('input[placeholder="Engineering docs"]').setValue('Renamed')
    await wrapper.findAll('button').find(item => item.text() === 'Save')!.trigger('click')
    await flushPromises()
    expect(documentsStoreMock.updateTeamspace).toHaveBeenCalledWith('space', {
      name: 'Renamed', is_private: false, member_ids: ['bot'],
    })
    wrapper.unmount()
  })

  it('shows bot loading and retry states', async () => {
    authStoreMock.effectiveRole = 'admin'
    documentsStoreMock.botsLoading = true
    const wrapper = mount(TeamspacesView, {
      props: { selectedTeamspaceId: null }, global: { stubs: { Teleport: true } },
    })
    await wrapper.get('[data-testid="documents-create-teamspace"]').trigger('click')
    expect(wrapper.text()).toContain('Loading bots...')
    documentsStoreMock.botsLoading = false
    documentsStoreMock.botsError = 'Failed to load bots'
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Failed to load bots')
    await wrapper.findAll('button').find(item => item.text() === 'Retry')!.trigger('click')
    expect(documentsStoreMock.loadBots).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('shows delete only for manageable teamspaces and confirms delete', async () => {
    documentsStoreMock.teamspaces = [
      {
        id: 'teamspace-1',
        name: 'Alpha',
        owner_user_id: 'user-1',
        is_private: false,
        is_member: true,
        is_owner: true,
        can_manage: true,
        member_count: 2,
        members: [],
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'teamspace-2',
        name: 'Beta',
        owner_user_id: 'user-2',
        is_private: false,
        is_member: true,
        is_owner: false,
        can_manage: false,
        member_count: 1,
        members: [],
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ]

    const wrapper = mount(TeamspacesView, {
      props: {
        selectedTeamspaceId: 'teamspace-1',
      },
      global: {
        stubs: {
          Teleport: true,
        },
      },
    })

    expect(wrapper.find('[data-testid="teamspace-delete-teamspace-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="teamspace-delete-teamspace-2"]').exists()).toBe(false)

    await wrapper.find('[data-testid="teamspace-delete-teamspace-1"]').trigger('click')
    expect(wrapper.text()).toContain('Delete teamspace?')
    expect(wrapper.text()).toContain('Alpha')

    await wrapper.get('[data-testid="teamspace-delete-confirm"]').trigger('click')

    expect(documentsStoreMock.deleteTeamspace).toHaveBeenCalledWith('teamspace-1')
    expect(wrapper.emitted('openTeamspaces')).toBeTruthy()
  })

  it('cancels the delete confirmation dialog', async () => {
    documentsStoreMock.teamspaces = [
      {
        id: 'teamspace-1',
        name: 'Alpha',
        owner_user_id: 'user-1',
        is_private: false,
        is_member: true,
        is_owner: true,
        can_manage: true,
        member_count: 2,
        members: [],
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ]

    const wrapper = mount(TeamspacesView, {
      props: {
        selectedTeamspaceId: null,
      },
      global: {
        stubs: {
          Teleport: true,
        },
      },
    })

    await wrapper.find('[data-testid="teamspace-delete-teamspace-1"]').trigger('click')
    expect(wrapper.text()).toContain('Delete teamspace?')

    const cancelButton = wrapper.findAll('button').find(button => button.text() === 'Cancel')
    expect(cancelButton).toBeTruthy()
    await cancelButton!.trigger('click')
    expect(wrapper.text()).not.toContain('Delete teamspace?')
  })
})
