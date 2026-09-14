import { reactive } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TaskListView from '@/components/tasks/TaskListView.vue'
import { storage } from '@/services/storage/storageAdapter'

const tasksStoreMock = reactive({
  activeStatuses: [] as Array<{ id: string; name: string }>,
  activeTemplates: [] as Array<{ id: string; prefix: string }>,
  assigneeFieldIds: [] as string[],
  users: [] as Array<{ id: string; display_name: string; email: string; avatar_url: string }>,
  listParams: { page: 1, page_size: 50 },
  taskListTotal: 1,
  taskListLoading: false,
  taskListError: null as string | null,
  taskList: [] as Array<{ id: string; public_id: string; title: string; status_id: string; created_at: string; updated_at: string }>,
  groupedTaskStatusOrder: ['st-1', 'st-2'],
  groupedTaskGroupsByStatus: {
    'st-1': {
      status: { id: 'st-1', code: 'todo', name: 'Todo', sort_order: 1 },
      items: [
        {
          id: 'task-grouped-1',
          public_id: 'BUG-1',
          title: 'Grouped Task',
          description_preview: 'Grouped task description',
          status_id: 'st-1',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-02-03T00:00:00Z',
          created_by: { id: 'u-1', display_name: 'User One', avatar_url: '' },
        },
      ],
      total: 1,
      next_offset: 1,
      has_more: true,
      loading_more: false,
    },
    'st-2': {
      status: { id: 'st-2', code: 'done', name: 'Done', sort_order: 2 },
      items: [],
      total: 0,
      next_offset: 0,
      has_more: false,
      loading_more: false,
    },
  } as Record<string, any>,
  openCreateDialog: vi.fn(),
  statusById: vi.fn((id: string) => id),
  activeFieldsFor: vi.fn(() => []),
  loadConfig: vi.fn(async () => {}),
  loadAllTemplateFields: vi.fn(async () => {}),
  loadUsers: vi.fn(async () => {}),
  setListParams: vi.fn(),
  loadTaskList: vi.fn(),
  loadMoreGroupedStatus: vi.fn(),
})

vi.mock('@/stores/tasks', () => ({
  useTasksStore: () => tasksStoreMock,
}))

describe('TaskListView', () => {
  beforeEach(() => {
    storage.clear()
    vi.clearAllMocks()
    tasksStoreMock.listParams = { page: 1, page_size: 50 }
    tasksStoreMock.taskList = []
    tasksStoreMock.taskListTotal = 1
  })

  it('renders list/grouped switcher without kanban option', async () => {
    const wrapper = mount(TaskListView, {
      props: { templateFilter: null },
      global: {
        stubs: {
          TaskTrackerFilters: { template: '<div><slot name="after-controls" /></div>' },
          UserAvatar: { template: '<div class="user-avatar-stub" />' },
          TaskRow: { template: '<tr />' },
          SortIcon: { template: '<span />' },
        },
      },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('list')
    expect(wrapper.text()).toContain('group by status')
    expect(wrapper.text().toLowerCase()).not.toContain('kanban')
  })

  it('shows only non-zero groups and triggers show-more loading', async () => {
    storage.setItem('msgnr:tasks:view-mode:v1', 'grouped')
    const wrapper = mount(TaskListView, {
      props: { templateFilter: null },
      global: {
        stubs: {
          TaskTrackerFilters: { template: '<div><slot name="after-controls" /></div>' },
          UserAvatar: { template: '<div class="user-avatar-stub" />' },
          TaskRow: { template: '<tr />' },
          SortIcon: { template: '<span />' },
        },
      },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Todo')
    expect(wrapper.text()).not.toContain('Done')
    expect(wrapper.text()).toContain('show more…')

    const showMoreButton = wrapper.findAll('button').find(button => button.text().includes('show more…'))
    expect(showMoreButton).toBeTruthy()
    await showMoreButton!.trigger('click')
    expect(tasksStoreMock.loadMoreGroupedStatus).toHaveBeenCalledWith('st-1')
  })

  it('shows updated date in grouped mode', async () => {
    storage.setItem('msgnr:tasks:view-mode:v1', 'grouped')
    const wrapper = mount(TaskListView, {
      props: { templateFilter: null },
      global: {
        stubs: {
          TaskTrackerFilters: { template: '<div><slot name="after-controls" /></div>' },
          UserAvatar: { template: '<div class="user-avatar-stub" />' },
          TaskRow: { template: '<tr />' },
          SortIcon: { template: '<span />' },
        },
      },
    })
    await flushPromises()

    const createdLabel = new Date('2026-01-01T00:00:00Z').toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
    const updatedLabel = new Date('2026-02-03T00:00:00Z').toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })

    expect(wrapper.text()).toContain(updatedLabel)
    expect(wrapper.text()).not.toContain(createdLabel)
  })

  it('applies shared filter payload in grouped mode', async () => {
    storage.setItem('msgnr:tasks:view-mode:v1', 'grouped')
    const wrapper = mount(TaskListView, {
      props: { templateFilter: null },
      global: {
        stubs: {
          TaskTrackerFilters: {
            emits: ['filtersChange'],
            template: '<div><slot name="after-controls" /><button data-testid="filters-emit" @click="$emit(\'filtersChange\', { search: \'bug\', status_ids: [\'st-1\'], prefixes: [\'BUG\'], include_subtasks: true, created_from: \'2026-05-01\', created_to: \'2026-05-03\', field_filters: [{ field_definition_id: \'fld-1\', user_ids: [\'u-1\'] }] })">emit</button></div>',
          },
          UserAvatar: { template: '<div class="user-avatar-stub" />' },
          TaskRow: { template: '<tr />' },
          SortIcon: { template: '<span />' },
        },
      },
    })
    await flushPromises()

    await wrapper.get('[data-testid="filters-emit"]').trigger('click')
    expect(tasksStoreMock.setListParams).toHaveBeenCalledWith({
      search: 'bug',
      status_ids: ['st-1'],
      prefixes: ['BUG'],
      include_subtasks: true,
      field_filters: [{ field_definition_id: 'fld-1', user_ids: ['u-1'] }],
      page: 1,
    }, 'grouped')
  })

  it('applies created date filters in flat list mode', async () => {
    const wrapper = mount(TaskListView, {
      props: { templateFilter: null },
      global: {
        stubs: {
          TaskTrackerFilters: {
            emits: ['filtersChange'],
            template: '<div><slot name="after-controls" /><button data-testid="filters-emit" @click="$emit(\'filtersChange\', { search: \'bug\', created_from: \'2026-05-01\', created_to: \'2026-05-03\' })">emit</button></div>',
          },
          UserAvatar: { template: '<div class="user-avatar-stub" />' },
          TaskRow: { template: '<tr />' },
          SortIcon: { template: '<span />' },
        },
      },
    })
    await flushPromises()

    await wrapper.get('[data-testid="filters-emit"]').trigger('click')
    expect(tasksStoreMock.setListParams).toHaveBeenCalledWith({
      search: 'bug',
      created_from: '2026-05-01',
      created_to: '2026-05-03',
      page: 1,
      sort_by: 'updated_at',
      sort_order: 'desc',
    }, 'list')
  })

  it('waits for filter re-emit before fetching after grouped-to-list mode switch', async () => {
    storage.setItem('msgnr:tasks:view-mode:v1', 'grouped')
    const wrapper = mount(TaskListView, {
      props: { templateFilter: null },
      global: {
        stubs: {
          TaskTrackerFilters: {
            emits: ['filtersChange'],
            template: '<div><slot name="after-controls" /><button data-testid="filters-emit" @click="$emit(\'filtersChange\', { search: \'bug\', created_from: \'2026-05-01\', created_to: \'2026-05-03\' })">emit</button></div>',
          },
          UserAvatar: { template: '<div class="user-avatar-stub" />' },
          TaskRow: { template: '<tr />' },
          SortIcon: { template: '<span />' },
        },
      },
    })
    await flushPromises()

    tasksStoreMock.setListParams.mockClear()
    const listModeInput = wrapper.findAll('input[name="tasks-view-mode"]')[0]
    expect(listModeInput).toBeTruthy()
    await listModeInput.trigger('change')
    expect(tasksStoreMock.setListParams).not.toHaveBeenCalled()

    await wrapper.get('[data-testid="filters-emit"]').trigger('click')
    expect(tasksStoreMock.setListParams).toHaveBeenCalledWith({
      search: 'bug',
      created_from: '2026-05-01',
      created_to: '2026-05-03',
      page: 1,
      sort_by: 'updated_at',
      sort_order: 'desc',
    }, 'list')
  })

  it('uses descending as the first-click sort order for date columns', async () => {
    tasksStoreMock.taskList = [
      {
        id: 'task-1',
        public_id: 'BUG-1',
        title: 'Visible Task',
        status_id: 'st-1',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-02-03T00:00:00Z',
      },
    ]
    const wrapper = mount(TaskListView, {
      props: { templateFilter: null },
      global: {
        stubs: {
          TaskTrackerFilters: { template: '<div><slot name="after-controls" /><slot /></div>' },
          UserAvatar: { template: '<div class="user-avatar-stub" />' },
          TaskRow: { template: '<tr />' },
          SortIcon: { template: '<span />' },
        },
      },
    })
    await flushPromises()

    const headers = wrapper.findAll('th')
    const createdHeader = headers.find(header => header.text().includes('Created'))
    const titleHeader = headers.find(header => header.text().includes('Title'))
    const updatedHeader = headers.find(header => header.text().includes('Updated'))
    expect(createdHeader).toBeTruthy()
    expect(titleHeader).toBeTruthy()
    expect(updatedHeader).toBeTruthy()

    await createdHeader!.trigger('click')
    expect(tasksStoreMock.setListParams).toHaveBeenLastCalledWith({
      page: 1,
      sort_by: 'created_at',
      sort_order: 'desc',
    }, 'list')

    await titleHeader!.trigger('click')
    expect(tasksStoreMock.setListParams).toHaveBeenLastCalledWith({
      page: 1,
      sort_by: 'title',
      sort_order: 'asc',
    }, 'list')

    await updatedHeader!.trigger('click')
    expect(tasksStoreMock.setListParams).toHaveBeenLastCalledWith({
      page: 1,
      sort_by: 'updated_at',
      sort_order: 'desc',
    }, 'list')
  })

  it('emits task public id when a grouped row is clicked', async () => {
    storage.setItem('msgnr:tasks:view-mode:v1', 'grouped')
    const wrapper = mount(TaskListView, {
      props: { templateFilter: null },
      global: {
        stubs: {
          TaskTrackerFilters: { template: '<div><slot name="after-controls" /></div>' },
          UserAvatar: { template: '<div class="user-avatar-stub" />' },
          TaskRow: { template: '<tr />' },
          SortIcon: { template: '<span />' },
        },
      },
    })
    await flushPromises()

    await wrapper.find('tbody tr').trigger('click')
    expect(wrapper.emitted('openTask')).toEqual([['BUG-1']])
  })
})
