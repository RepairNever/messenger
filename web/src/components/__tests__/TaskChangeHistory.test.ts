import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TaskChangeHistory from '@/components/tasks/TaskChangeHistory.vue'

type ObserverCallback = (entries: IntersectionObserverEntry[]) => void

class IntersectionObserverMock {
  static instances: IntersectionObserverMock[] = []
  readonly observed = new Set<Element>()

  constructor(private readonly callback: ObserverCallback) {
    IntersectionObserverMock.instances.push(this)
  }

  observe(element: Element) {
    this.observed.add(element)
  }

  disconnect() {
    this.observed.clear()
  }

  trigger(element: Element) {
    this.callback([{ target: element, isIntersecting: true } as IntersectionObserverEntry])
  }
}

const listTaskChangeHistory = vi.fn()
const tasksStoreMock = {
  users: [
    { id: 'u-1', display_name: 'Alice', email: 'alice@example.com', avatar_url: '/alice.png' },
    { id: 'u-2', display_name: 'Bob', email: 'bob@example.com', avatar_url: '/bob.png' },
  ],
  listTaskChangeHistory,
}

vi.mock('@/stores/tasks', () => ({
  useTasksStore: () => tasksStoreMock,
}))

function descriptionChange(id: string) {
  return {
    id,
    change_kind: 'field' as const,
    field_key: 'description',
    field_name: 'Description',
    field_type: 'markdown',
    before_value: Array.from({ length: 35 }, (_, index) => `old ${index + 1}`).join('\n'),
    after_value: Array.from({ length: 35 }, (_, index) => `new ${index + 1}`).join('\n'),
    created_at: '2026-08-05T10:20:00Z',
    actor: { id: 'u-1', display_name: 'Alice', avatar_url: '/alice.png' },
  }
}

describe('TaskChangeHistory', () => {
  beforeEach(() => {
    IntersectionObserverMock.instances = []
    listTaskChangeHistory.mockReset()
    vi.stubGlobal('IntersectionObserver', IntersectionObserverMock)
  })

  it('does not request history until the section becomes visible, then pages at 50 entries', async () => {
    listTaskChangeHistory
      .mockResolvedValueOnce({
        items: [
          {
            id: 'created',
            change_kind: 'created',
            field_key: 'task',
            field_name: 'Task',
            field_type: 'created',
            before_value: null,
            after_value: true,
            created_at: '2026-08-05T10:00:00Z',
            actor: { id: 'u-1', display_name: 'Alice', avatar_url: '/alice.png' },
          },
          descriptionChange('description-1'),
        ],
        next_cursor: 'page-2',
      })
      .mockResolvedValueOnce({ items: [], next_cursor: undefined })

    const wrapper = mount(TaskChangeHistory, {
      props: { taskId: 'task-1', scrollRoot: null },
      global: { stubs: { UserAvatar: true } },
    })
    await flushPromises()

    expect(listTaskChangeHistory).not.toHaveBeenCalled()
    const observer = IntersectionObserverMock.instances[IntersectionObserverMock.instances.length - 1]
    observer.trigger(wrapper.get('[data-testid="task-change-history"]').element)
    await flushPromises()

    expect(listTaskChangeHistory).toHaveBeenCalledWith('task-1', { cursor: undefined, limit: 50 })
    expect(wrapper.text()).toContain('Alice')
    expect(wrapper.text()).toContain('Created')
    expect(wrapper.get('[data-testid="task-change-history-diff-description-1"]')).toBeTruthy()

    const pagingObserver = IntersectionObserverMock.instances[IntersectionObserverMock.instances.length - 1]
    pagingObserver.trigger(wrapper.get('[data-testid="task-change-history-sentinel"]').element)
    await flushPromises()
    expect(listTaskChangeHistory).toHaveBeenLastCalledWith('task-1', { cursor: 'page-2', limit: 50 })
  })

  it('renders long description diffs inline with unified and inline modes', async () => {
    listTaskChangeHistory.mockResolvedValue({ items: [descriptionChange('description-1')] })
    const wrapper = mount(TaskChangeHistory, {
      props: { taskId: 'task-1', scrollRoot: null },
      global: { stubs: { UserAvatar: true } },
    })
    await flushPromises()
    IntersectionObserverMock.instances[IntersectionObserverMock.instances.length - 1]
      .trigger(wrapper.get('[data-testid="task-change-history"]').element)
    await flushPromises()

    await wrapper.get('[data-testid="task-change-history-diff-description-1"]').trigger('click')
    const unifiedBody = wrapper.get('[data-testid="task-change-history-diff-unified-body"]')
    expect(unifiedBody).toBeTruthy()
    expect(wrapper.get('[data-testid="task-change-history-diff-collapse"]').text()).toBe('Expand (70 lines)')
    expect(wrapper.get('[data-testid="task-change-history-diff-hidden-lines"]').text()).toBe('⋮40 lines hidden')
    expect(unifiedBody.text()).toContain('new 35')

    await wrapper.get('[data-testid="task-change-history-diff-inline"]').trigger('click')
    const inlineBody = wrapper.get('[data-testid="task-change-history-diff-inline-body"]')
    expect(inlineBody).toBeTruthy()
    expect(wrapper.get('[data-testid="task-change-history-diff-hidden-rows"]').text()).toBe('⋮ 5 diff rows hidden')
    expect(inlineBody.text()).toContain('old 35')
    expect(inlineBody.text()).toContain('new 35')

    await wrapper.get('[data-testid="task-change-history-diff-collapse"]').trigger('click')
    expect(wrapper.get('[data-testid="task-change-history-diff-collapse"]').text()).toBe('Collapse')
    expect(wrapper.find('[data-testid="task-change-history-diff-hidden-rows"]').exists()).toBe(false)
  })

  it('emphasizes changed words within paired unified diff lines', async () => {
    listTaskChangeHistory.mockResolvedValue({
      items: [{
        id: 'description-word-diff', change_kind: 'field', field_key: 'description', field_name: 'Description', field_type: 'markdown',
        before_value: 'Ship Backend today', after_value: 'Ship Frontend today', created_at: '2026-08-05T10:20:00Z',
        actor: { id: 'u-1', display_name: 'Alice', avatar_url: '/alice.png' },
      }],
    })
    const wrapper = mount(TaskChangeHistory, {
      props: { taskId: 'task-1', scrollRoot: null },
      global: { stubs: { UserAvatar: true } },
    })
    await flushPromises()
    IntersectionObserverMock.instances[IntersectionObserverMock.instances.length - 1]
      .trigger(wrapper.get('[data-testid="task-change-history"]').element)
    await flushPromises()

    await wrapper.get('[data-testid="task-change-history-diff-description-word-diff"]').trigger('click')
    expect(wrapper.get('[data-testid="task-change-history-diff-word-removed"]').text()).toBe('Backend')
    expect(wrapper.get('[data-testid="task-change-history-diff-word-added"]').text()).toBe('Frontend')
  })

  it('renders grouped attachment actions and staged creation attachments', async () => {
    const files = [
      { id: 'attachment-1', file_name: 'brief.pdf', file_size: 214, mime_type: 'application/pdf' },
      { id: 'attachment-2', file_name: 'notes.txt', file_size: 88, mime_type: 'text/plain' },
    ]
    listTaskChangeHistory.mockResolvedValue({
      items: [
        {
          id: 'created', change_kind: 'created', field_key: 'task', field_name: 'Task', field_type: 'created',
          before_value: null, after_value: { attachments: [files[0]] }, created_at: '2026-08-05T10:00:00Z',
          actor: { id: 'u-1', display_name: 'Alice', avatar_url: '/alice.png' },
        },
        {
          id: 'added', change_kind: 'field', field_key: 'attachments', field_name: 'Attachments', field_type: 'attachments_added',
          before_value: null, after_value: files, created_at: '2026-08-05T10:01:00Z',
          actor: { id: 'u-1', display_name: 'Alice', avatar_url: '/alice.png' },
        },
        {
          id: 'removed', change_kind: 'field', field_key: 'attachments', field_name: 'Attachments', field_type: 'attachments_removed',
          before_value: [files[1]], after_value: null, created_at: '2026-08-05T10:02:00Z',
          actor: { id: 'u-2', display_name: 'Bob', avatar_url: '/bob.png' },
        },
      ],
    })
    const wrapper = mount(TaskChangeHistory, {
      props: { taskId: 'task-1', scrollRoot: null },
      global: { stubs: { UserAvatar: true } },
    })
    await flushPromises()
    IntersectionObserverMock.instances[IntersectionObserverMock.instances.length - 1]
      .trigger(wrapper.get('[data-testid="task-change-history"]').element)
    await flushPromises()

    expect(wrapper.get('[data-testid="task-change-history-created-attachments"]').text()).toContain('brief.pdf')
    expect(wrapper.get('[data-testid="task-change-history-attachments-added"]').text()).toContain('Added')
    expect(wrapper.get('[data-testid="task-change-history-attachments-added"]').text()).toContain('notes.txt')
    expect(wrapper.get('[data-testid="task-change-history-attachments-removed"]').text()).toContain('Removed')
  })

  it('renders ordinary values as old-to-new transitions with explicit empty states', async () => {
    listTaskChangeHistory.mockResolvedValue({
      items: [
        {
          id: 'version', change_kind: 'field', field_key: 'version', field_name: 'Version', field_type: 'text',
          before_value: null, after_value: 'v2.14.0', created_at: '2026-08-05T10:01:00Z',
          actor: { id: 'u-1', display_name: 'Alice', avatar_url: '/alice.png' },
        },
        {
          id: 'component', change_kind: 'field', field_key: 'component', field_name: 'Component', field_type: 'text',
          before_value: 'Backend', after_value: 'Frontend', created_at: '2026-08-05T10:02:00Z',
          actor: { id: 'u-1', display_name: 'Alice', avatar_url: '/alice.png' },
        },
      ],
    })
    const wrapper = mount(TaskChangeHistory, {
      props: { taskId: 'task-1', scrollRoot: null },
      global: { stubs: { UserAvatar: true } },
    })
    await flushPromises()
    IntersectionObserverMock.instances[IntersectionObserverMock.instances.length - 1]
      .trigger(wrapper.get('[data-testid="task-change-history"]').element)
    await flushPromises()

    const beforeValues = wrapper.findAll('[data-testid="task-change-history-before-value"]')
    const afterValues = wrapper.findAll('[data-testid="task-change-history-after-value"]')
    expect(beforeValues[0].text()).toBe('empty')
    expect(beforeValues[0].classes()).toContain('italic')
    expect(afterValues[0].text()).toBe('v2.14.0')
    expect(afterValues[0].classes()).toContain('text-emerald-300')
    expect(beforeValues[1].text()).toBe('Backend')
    expect(beforeValues[1].classes()).toContain('line-through')
    expect(afterValues[1].text()).toBe('Frontend')
  })
})
