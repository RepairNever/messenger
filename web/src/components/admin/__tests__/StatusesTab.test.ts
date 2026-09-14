import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import StatusesTab from '@/components/admin/StatusesTab.vue'

const tasksApiMocks = vi.hoisted(() => ({
  tasksListStatuses: vi.fn(),
  tasksCreateStatus: vi.fn(),
  tasksUpdateStatus: vi.fn(),
  tasksDeleteStatus: vi.fn(),
  tasksReorderStatuses: vi.fn(),
}))

vi.mock('@/services/http/tasksApi', () => ({
  tasksListStatuses: tasksApiMocks.tasksListStatuses,
  tasksCreateStatus: tasksApiMocks.tasksCreateStatus,
  tasksUpdateStatus: tasksApiMocks.tasksUpdateStatus,
  tasksDeleteStatus: tasksApiMocks.tasksDeleteStatus,
  tasksReorderStatuses: tasksApiMocks.tasksReorderStatuses,
}))

function makeStatus(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'status-1',
    code: 'todo',
    name: 'Todo',
    sort_order: 1,
    deleted_at: null,
    created_at: '2026-03-06T00:00:00Z',
    updated_at: '2026-03-06T00:00:00Z',
    created_by: 'user-1',
    ...overrides,
  }
}

async function flushAll() {
  await Promise.resolve()
  await nextTick()
}

describe('StatusesTab', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    tasksApiMocks.tasksCreateStatus.mockResolvedValue(undefined)
    tasksApiMocks.tasksUpdateStatus.mockResolvedValue(undefined)
    tasksApiMocks.tasksDeleteStatus.mockResolvedValue(undefined)
    tasksApiMocks.tasksReorderStatuses.mockResolvedValue(undefined)
  })

  it('reorders active rows by drag and excludes deleted statuses from the payload', async () => {
    tasksApiMocks.tasksListStatuses
      .mockResolvedValueOnce([
        makeStatus({ id: 'status-1', code: 'todo', name: 'Todo', sort_order: 1 }),
        makeStatus({ id: 'status-2', code: 'done', name: 'Done', sort_order: 2, deleted_at: '2026-03-07T00:00:00Z' }),
        makeStatus({ id: 'status-3', code: 'doing', name: 'Doing', sort_order: 3 }),
      ])
      .mockResolvedValueOnce([
        makeStatus({ id: 'status-3', code: 'doing', name: 'Doing', sort_order: 1 }),
        makeStatus({ id: 'status-2', code: 'done', name: 'Done', sort_order: 2, deleted_at: '2026-03-07T00:00:00Z' }),
        makeStatus({ id: 'status-1', code: 'todo', name: 'Todo', sort_order: 3 }),
      ])

    const wrapper = mount(StatusesTab, {
      global: {
        stubs: {
          Teleport: true,
        },
      },
    })

    await flushAll()

    const source = wrapper.get('[data-testid="status-row-status-3"]')
    const target = wrapper.get('[data-testid="status-row-status-1"]')

    await source.trigger('dragstart')
    await target.trigger('dragover')
    await target.trigger('drop')
    await flushAll()

    expect(tasksApiMocks.tasksReorderStatuses).toHaveBeenCalledTimes(1)
    expect(tasksApiMocks.tasksReorderStatuses).toHaveBeenCalledWith(['status-3', 'status-1'])
    expect(tasksApiMocks.tasksListStatuses).toHaveBeenCalledTimes(2)
  })
})
