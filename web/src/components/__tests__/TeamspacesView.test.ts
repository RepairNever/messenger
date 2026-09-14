import { reactive } from 'vue'
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TeamspacesView from '@/components/documents/TeamspacesView.vue'

const documentsStoreMock = reactive({
  teamspaces: [] as any[],
  teamspacesLoading: false,
  teamspacesError: null as string | null,
  users: [] as any[],
  usersLoaded: true,
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
