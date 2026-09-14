import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useTasksStore } from '@/stores/tasks'
import {
  tasksListTasks,
  tasksListStatuses,
  tasksListTemplates,
  tasksUpdateTaskDescription,
  tasksUpdateTaskStatus,
} from '@/services/http/tasksApi'

vi.mock('@/services/http/tasksApi', () => ({
  tasksListTemplates: vi.fn(async () => []),
  tasksListStatuses: vi.fn(async () => []),
  tasksListFields: vi.fn(async () => []),
  tasksListUsers: vi.fn(async () => []),
  tasksGetConfigDictionary: vi.fn(async () => ({
    id: 'dict-1',
    code: 'dict',
    name: 'Dictionary',
    is_public: false,
    participates_in_filtration: false,
    current_version: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  })),
  tasksListFilterableDictionaries: vi.fn(async () => []),
  tasksGetDictionaryVersionItems: vi.fn(async () => []),
  tasksListDictionaryVersions: vi.fn(async () => []),
  tasksCreatePublicDictionaryItem: vi.fn(),
  tasksCreate: vi.fn(),
  tasksGet: vi.fn(),
  tasksUpdate: vi.fn(),
  tasksUpdateTaskTitle: vi.fn(),
  tasksUpdateTaskStatus: vi.fn(),
  tasksUpdateTaskDescription: vi.fn(),
  tasksListTaskDescriptionHistory: vi.fn(async () => []),
  tasksListTaskChangeHistory: vi.fn(async () => ({ items: [] })),
  tasksUpdateTaskFieldValue: vi.fn(),
  tasksCreateSubtask: vi.fn(),
  tasksListTasks: vi.fn(async () => ({ groups: [], grand_total: 0 })),
  tasksListGrouped: vi.fn(async () => ({ status_order: [], groups_by_status: {}, grand_total: 0, limit: 50 })),
  tasksListStatusPortion: vi.fn(async () => ({ total: 0, items: [], next_offset: 0, has_more: false })),
}))

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeTask(id: string, description: string) {
  return {
    id,
    title: id,
    description,
    template_id: 'template-1',
    status_id: 'status-1',
    field_values: [],
    subtasks: [],
    updated_at: '2026-03-17T00:00:00Z',
  } as any
}

function makeListItem(id: string, title = id) {
  return {
    id,
    public_id: id.toUpperCase(),
    title,
    template_id: 'template-1',
    template_snapshot_prefix: 'TASK',
    status_id: 'status-1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }
}

describe('tasksStore.updateTaskDescription', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('updates selectedTask when response belongs to current task', async () => {
    const store = useTasksStore()
    store.selectedTask = makeTask('task-1', 'old')

    vi.mocked(tasksUpdateTaskDescription).mockResolvedValueOnce(makeTask('task-1', 'new markdown'))

    await store.updateTaskDescription('task-1', 'new markdown')

    expect(store.selectedTask?.id).toBe('task-1')
    expect(store.selectedTask?.description).toBe('new markdown')
  })

  it('ignores stale description response after navigation to another task', async () => {
    const store = useTasksStore()
    store.selectedTask = makeTask('task-1', 'old')

    const pending = deferred<any>()
    vi.mocked(tasksUpdateTaskDescription).mockReturnValueOnce(pending.promise)

    const inFlight = store.updateTaskDescription('task-1', 'new markdown')
    store.selectedTask = makeTask('task-2', 'second task')

    pending.resolve(makeTask('task-1', 'new markdown'))
    await inFlight

    expect(store.selectedTask?.id).toBe('task-2')
    expect(store.selectedTask?.description).toBe('second task')
  })

  it('passes force snapshot flag when requested', async () => {
    const store = useTasksStore()
    store.selectedTask = makeTask('task-1', 'old')

    vi.mocked(tasksUpdateTaskDescription).mockResolvedValueOnce(makeTask('task-1', 'restored'))

    await store.updateTaskDescription('task-1', 'restored', { forceSnapshot: true })

    expect(tasksUpdateTaskDescription).toHaveBeenCalledWith('task-1', {
      description: 'restored',
      force_snapshot: true,
    })
  })
})

describe('tasksStore.updateTaskStatus', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('updates selectedTask when patched task is currently selected', async () => {
    const store = useTasksStore()
    store.selectedTask = makeTask('task-1', 'old')

    vi.mocked(tasksUpdateTaskStatus).mockResolvedValueOnce({
      ...makeTask('task-1', 'old'),
      status_id: 'status-2',
    } as any)

    await store.updateTaskStatus('task-1', 'status-2')

    expect(store.selectedTask?.id).toBe('task-1')
    expect(store.selectedTask?.status_id).toBe('status-2')
  })

  it('does not overwrite selectedTask when another task status is updated', async () => {
    const store = useTasksStore()
    store.selectedTask = makeTask('task-selected', 'selected')

    vi.mocked(tasksUpdateTaskStatus).mockResolvedValueOnce({
      ...makeTask('task-other', 'other'),
      status_id: 'status-2',
    } as any)

    await store.updateTaskStatus('task-other', 'status-2')

    expect(store.selectedTask?.id).toBe('task-selected')
    expect(store.selectedTask?.description).toBe('selected')
  })
})

describe('tasksStore.loadConfig', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('awaits the same in-flight request for concurrent callers', async () => {
    const store = useTasksStore()
    const templatesPending = deferred<any[]>()
    const statusesPending = deferred<any[]>()

    vi.mocked(tasksListTemplates).mockReturnValueOnce(templatesPending.promise as Promise<any>)
    vi.mocked(tasksListStatuses).mockReturnValueOnce(statusesPending.promise as Promise<any>)

    const first = store.loadConfig()
    const second = store.loadConfig()

    expect(tasksListTemplates).toHaveBeenCalledTimes(1)
    expect(tasksListStatuses).toHaveBeenCalledTimes(1)
    expect(store.configLoading).toBe(true)

    templatesPending.resolve([{ id: 'tpl-1', prefix: 'BUG', sort_order: 1, deleted_at: null }])
    statusesPending.resolve([{ id: 'st-1', name: 'Todo', sort_order: 1, deleted_at: null }])

    await Promise.all([first, second])

    expect(store.configLoaded).toBe(true)
    expect(store.activeTemplates.map(template => template.id)).toEqual(['tpl-1'])
    expect(store.activeStatuses.map(status => status.id)).toEqual(['st-1'])
  })
})

describe('tasksStore.loadTaskList', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('uses backend flat tasks before grouped fallback rows', async () => {
    const store = useTasksStore()
    vi.mocked(tasksListTasks).mockResolvedValueOnce({
      tasks: [
        makeListItem('newest'),
        makeListItem('middle'),
      ],
      groups: [
        {
          status: { id: 'status-1', code: 'todo', name: 'Todo', sort_order: 1 },
          tasks: [makeListItem('grouped-old')],
          total: 1,
          page: 1,
          page_size: 50,
        },
      ],
      grand_total: 3,
    })

    await store.loadTaskList()

    expect(store.taskList.map(task => task.id)).toEqual(['newest', 'middle'])
    expect(store.taskListGroups[0].tasks.map(task => task.id)).toEqual(['grouped-old'])
    expect(store.taskListTotal).toBe(3)
  })

  it('falls back to grouped rows for older task list responses', async () => {
    const store = useTasksStore()
    vi.mocked(tasksListTasks).mockResolvedValueOnce({
      groups: [
        {
          status: { id: 'status-1', code: 'todo', name: 'Todo', sort_order: 1 },
          tasks: [makeListItem('grouped-1')],
          total: 1,
          page: 1,
          page_size: 50,
        },
        {
          status: { id: 'status-2', code: 'done', name: 'Done', sort_order: 2 },
          tasks: [makeListItem('grouped-2')],
          total: 1,
          page: 1,
          page_size: 50,
        },
      ],
      grand_total: 2,
    })

    await store.loadTaskList()

    expect(store.taskList.map(task => task.id)).toEqual(['grouped-1', 'grouped-2'])
  })
})
