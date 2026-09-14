import { reactive } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TaskKanbanView from '@/components/tasks/TaskKanbanView.vue'

const tasksStoreMock = reactive({
  taskListTotal: 2,
  taskListLoading: false,
  taskListError: null as string | null,
  groupedTaskPortionLimit: 50,
  groupedTaskStatusOrder: ['st-1', 'st-2'],
  groupedTaskGroupsByStatus: {
    'st-1': {
      status: { id: 'st-1', code: 'todo', name: 'Todo', sort_order: 1 },
      items: [{
        id: 'task-1',
        public_id: 'BUG-1',
        title: 'First task',
        description_preview: 'First task preview text',
        status_id: 'st-1',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
        created_by: { id: 'u-1', display_name: 'User One', avatar_url: '' },
      }],
      total: 1,
      next_offset: 1,
      has_more: true,
      loading_more: false,
      load_more_error: null,
    },
    'st-2': {
      status: { id: 'st-2', code: 'done', name: 'Done', sort_order: 2 },
      items: [],
      total: 0,
      next_offset: 0,
      has_more: false,
      loading_more: false,
      load_more_error: null,
    },
  } as Record<string, any>,
  setListParams: vi.fn(),
  loadMoreGroupedStatus: vi.fn(),
  optimisticMoveGroupedTaskCard: vi.fn(),
  updateTaskStatus: vi.fn(),
  applyTaskStatusChangedToGrouped: vi.fn(),
  loadGroupedTaskList: vi.fn(),
})

let taskStatusChangedHandler: ((evt: any) => void) | null = null
const unsubscribeTaskStatusChanged = vi.fn()
const chatStoreMock = {
  onTaskStatusChanged: vi.fn((handler: (evt: any) => void) => {
    taskStatusChangedHandler = handler
    return unsubscribeTaskStatusChanged
  }),
}

vi.mock('@/stores/tasks', () => ({
  useTasksStore: () => tasksStoreMock,
}))

vi.mock('@/stores/chat', () => ({
  useChatStore: () => chatStoreMock,
}))

function mountKanban() {
  return mount(TaskKanbanView, {
    props: { templateFilter: null },
    global: {
      stubs: {
        TaskTrackerFilters: {
          emits: ['filtersChange'],
          template: '<div><button data-testid="filters-emit" @click="$emit(\'filtersChange\', { search: \'bug\', status_ids: [\'st-1\'], prefixes: [\'BUG\'], include_subtasks: true, field_filters: [{ field_definition_id: \'fld-1\', user_ids: [\'u-1\'] }] })">emit</button></div>',
        },
      },
    },
  })
}

describe('TaskKanbanView', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    taskStatusChangedHandler = null
    unsubscribeTaskStatusChanged.mockReset()
    chatStoreMock.onTaskStatusChanged.mockClear()
    tasksStoreMock.taskListLoading = false
    tasksStoreMock.taskListError = null
    tasksStoreMock.groupedTaskGroupsByStatus['st-1'].has_more = true
    tasksStoreMock.groupedTaskGroupsByStatus['st-1'].loading_more = false
    tasksStoreMock.groupedTaskGroupsByStatus['st-1'].load_more_error = null
    tasksStoreMock.setListParams.mockReset()
    tasksStoreMock.loadMoreGroupedStatus.mockReset()
    tasksStoreMock.optimisticMoveGroupedTaskCard.mockReset()
    tasksStoreMock.updateTaskStatus.mockReset()
    tasksStoreMock.applyTaskStatusChangedToGrouped.mockReset()
    tasksStoreMock.loadGroupedTaskList.mockReset()
  })

  it('renders status columns with vertical cards', async () => {
    const wrapper = mountKanban()
    await flushPromises()

    expect(wrapper.find('[data-testid="kanban-column-st-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="kanban-column-st-2"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('BUG-1')
    expect(wrapper.text()).toContain('First task')
    expect(wrapper.text()).toContain('First task preview text')
  })

  it('uses theme text tokens for kanban task titles', async () => {
    const wrapper = mountKanban()
    await flushPromises()

    const title = wrapper.get('.kanban-card-title')
    expect(title.classes()).toContain('text-app-text')
    expect(title.classes()).not.toContain('text-gray-100')
  })

  it('applies filter payload in grouped mode and supports show more', async () => {
    const wrapper = mountKanban()
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

    const showMore = wrapper.findAll('button').find(item => item.text() === 'show more')
    expect(showMore).toBeTruthy()
    await showMore!.trigger('click')
    expect(tasksStoreMock.loadMoreGroupedStatus).toHaveBeenCalledWith('st-1')
  })

  it('emits openTask when card is clicked', async () => {
    const wrapper = mountKanban()
    await flushPromises()

    await wrapper.get('[data-testid="kanban-card-task-1"]').trigger('click')
    expect(wrapper.emitted('openTask')).toEqual([['BUG-1']])
  })

  it('optimistically moves card on drag/drop and patches status', async () => {
    const rollback = vi.fn()
    tasksStoreMock.optimisticMoveGroupedTaskCard.mockReturnValue(rollback)
    tasksStoreMock.updateTaskStatus.mockResolvedValue({ id: 'task-1' })

    const wrapper = mountKanban()
    await flushPromises()

    await wrapper.get('[data-testid="kanban-card-task-1"]').trigger('dragstart', {
      dataTransfer: {
        setData: vi.fn(),
        effectAllowed: 'move',
      },
    })
    await wrapper.get('[data-testid="kanban-column-st-2"]').trigger('drop')
    await flushPromises()

    expect(tasksStoreMock.optimisticMoveGroupedTaskCard).toHaveBeenCalledWith('task-1', 'st-2')
    expect(tasksStoreMock.updateTaskStatus).toHaveBeenCalledWith('task-1', 'st-2')
    expect(rollback).not.toHaveBeenCalled()
  })

  it('rolls back optimistic move when patch fails', async () => {
    const rollback = vi.fn()
    tasksStoreMock.optimisticMoveGroupedTaskCard.mockReturnValue(rollback)
    tasksStoreMock.updateTaskStatus.mockRejectedValue(new Error('move failed'))

    const wrapper = mountKanban()
    await flushPromises()

    await wrapper.get('[data-testid="kanban-card-task-1"]').trigger('dragstart', {
      dataTransfer: { setData: vi.fn(), effectAllowed: 'move' },
    })
    await wrapper.get('[data-testid="kanban-column-st-2"]').trigger('drop')
    await flushPromises()

    expect(rollback).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('move failed')
  })

  it('subscribes to realtime status changes and reloads grouped data', async () => {
    vi.useFakeTimers()
    const wrapper = mountKanban()
    await flushPromises()

    expect(chatStoreMock.onTaskStatusChanged).toHaveBeenCalledTimes(1)
    expect(taskStatusChangedHandler).toBeTypeOf('function')

    taskStatusChangedHandler?.({
      taskId: 'task-1',
      publicId: 'BUG-1',
      fromStatusId: 'st-1',
      toStatusId: 'st-2',
      updatedBy: 'u-2',
      updatedAt: '2026-03-18T12:00:00Z',
    })

    expect(tasksStoreMock.applyTaskStatusChangedToGrouped).toHaveBeenCalledWith('task-1', 'st-2')
    vi.advanceTimersByTime(350)
    await flushPromises()
    expect(tasksStoreMock.loadGroupedTaskList).toHaveBeenCalledWith(undefined, 50)

    wrapper.unmount()
    expect(unsubscribeTaskStatusChanged).toHaveBeenCalledTimes(1)
  })
})
