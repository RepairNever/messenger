import { reactive, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TaskCard from '@/components/tasks/TaskCard.vue'
import type { Task } from '@/services/http/tasksApi'
import {
  loadSubtaskCreateDraft,
  saveSubtaskCreateDraft,
} from '@/services/storage/taskCreateDraftStorage'
import { storage } from '@/services/storage/storageAdapter'

const platformMocks = vi.hoisted(() => ({
  getPlatformOrNull: vi.fn(),
  initPlatform: vi.fn(),
  exportTaskToPdfBlob: vi.fn(),
}))
const clipboardWriteText = vi.fn()

const selectedTask: Task = {
  id: 'task-1',
  public_id: 'TASK-1',
  template_id: 'tpl-1',
  template_snapshot_prefix: 'TASK',
  sequence_number: 1,
  title: 'Initial title',
  description: '**old** description',
  status_id: 'st-1',
  parent_task_id: null,
  parent_public_id: null,
  created_by: 'u-1',
  updated_by: 'u-2',
  created_at: '2026-03-10T12:00:00Z',
  updated_at: '2026-03-10T12:00:00Z',
  field_values: [],
  subtasks: [],
}

const baseTemplates = [
  {
    id: 'tpl-1',
    prefix: 'TASK',
    sort_order: 1,
    deleted_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    created_by: 'u-1',
    updated_by: 'u-1',
  },
  {
    id: 'tpl-2',
    prefix: 'BUG',
    sort_order: 2,
    deleted_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    created_by: 'u-1',
    updated_by: 'u-1',
  },
]

const baseStatuses = [
  {
    id: 'st-1',
    code: 'open',
    name: 'Open',
    sort_order: 1,
    deleted_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    created_by: 'u-1',
    updated_by: 'u-1',
  },
  {
    id: 'st-2',
    code: 'todo',
    name: 'Todo',
    sort_order: 2,
    deleted_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    created_by: 'u-1',
    updated_by: 'u-1',
  },
]

const tasksStoreMock = reactive({
  selectedTask,
  taskLoading: false,
  taskError: null as string | null,
  users: [
    {
      id: 'u-1',
      display_name: 'Creator User',
      email: 'creator@example.com',
      avatar_url: '/api/public/avatars/avatars/u-1/creator.png',
    },
    {
      id: 'u-2',
      display_name: 'Updater User',
      email: 'updater@example.com',
      avatar_url: '/api/public/avatars/avatars/u-2/updater.png',
    },
  ],
  activeTemplates: [...baseTemplates],
  activeStatuses: [...baseStatuses],
  allStatuses: vi.fn(() => [
    {
      id: 'st-1',
      code: 'open',
      name: 'Open',
      sort_order: 1,
      deleted_at: null,
    },
  ]),
  statusById: vi.fn(() => ({ id: 'st-1', name: 'Open' })),
  activeFieldsFor: vi.fn(() => []),
  enumDictionaryFor: vi.fn(() => undefined),
  enumItemsFor: vi.fn(() => []),
  enumKnownItemsFor: vi.fn(() => []),
  enumItemCreateLoadingFor: vi.fn(() => false),
  enumItemSearchLoadingFor: vi.fn(() => false),
  enumVersionFor: vi.fn(() => undefined),
  loadUsers: vi.fn(async () => {}),
  loadEnumItemsFor: vi.fn(async () => {}),
  searchEnumItemsFor: vi.fn(async () => []),
  loadConfig: vi.fn(async () => {}),
  loadFieldsFor: vi.fn(async () => {}),
  updateTask: vi.fn(async () => selectedTask),
  updateTaskTitle: vi.fn(async () => selectedTask),
  updateTaskStatus: vi.fn(async () => selectedTask),
  updateTaskDescription: vi.fn(async () => selectedTask),
  listTaskChangeHistory: vi.fn(async () => ({ items: [] })),
  updateTaskFieldValue: vi.fn(async () => ({})),
  createSubtask: vi.fn(async () => ({})),
  selectTask: vi.fn(async () => {}),
})

const chatStoreMock = {
  showToast: vi.fn(),
}

vi.mock('@/stores/tasks', () => ({
  useTasksStore: () => tasksStoreMock,
}))

vi.mock('@/stores/chat', () => ({
  useChatStore: () => chatStoreMock,
}))

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    user: {
      id: 'u-1',
      email: 'u-1@example.com',
      displayName: 'User 1',
    },
  }),
}))

vi.mock('@/platform', () => ({
  getPlatformOrNull: platformMocks.getPlatformOrNull,
  initPlatform: platformMocks.initPlatform,
}))

vi.mock('@/services/taskPdfExport', () => ({
  exportTaskToPdfBlob: platformMocks.exportTaskToPdfBlob,
}))

vi.mock('@/composables/useTaskDescriptionCollab', () => ({
  useTaskDescriptionCollab: () => ({
    doc: ref({}),
    provider: ref({ awareness: { states: new Map() } }),
    subscribeError: ref(''),
    serverMarkdown: ref<string | null>(null),
    allowLocalDraftSeed: ref(true),
    hasRemotePeers: ref(false),
  }),
}))

function mountTaskCard() {
  return mount(TaskCard, {
    props: { templateFilter: null },
    global: {
      stubs: {
        TaskFieldInput: true,
        UserAvatar: true,
        TaskAttachments: true,
        TaskComments: true,
        TaskDescriptionEditor: {
          props: ['modelValue'],
          emits: ['update:modelValue', 'blur'],
          template: '<textarea data-testid="description-stub" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" @blur="$emit(\'blur\')" />',
        },
      },
    },
  })
}

describe('TaskCard', () => {
  beforeEach(() => {
    storage.clear()
    vi.clearAllMocks()
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: clipboardWriteText },
      configurable: true,
    })
    const platform = {
      files: {
        saveBlob: vi.fn(async () => ({ saved: true })),
      },
    }
    platformMocks.getPlatformOrNull.mockReturnValue(platform)
    platformMocks.initPlatform.mockResolvedValue(platform)
    platformMocks.exportTaskToPdfBlob.mockResolvedValue(new Blob(['pdf'], { type: 'application/pdf' }))
    tasksStoreMock.activeTemplates = [...baseTemplates]
    tasksStoreMock.activeStatuses = [...baseStatuses]
    tasksStoreMock.createSubtask.mockImplementation(async () => ({}))
    tasksStoreMock.selectedTask = {
      ...selectedTask,
      description: '**old** description',
      subtasks: [],
    }
  })

  it('shows rendered/markdown tabs in always-on description editor', async () => {
    const wrapper = mount(TaskCard, {
      props: { templateFilter: null },
      global: {
        stubs: {
          TaskFieldInput: true,
          UserAvatar: true,
          TaskAttachments: true,
          TaskComments: true,
          TaskDescriptionEditor: {
            template: '<div>Rendered Markdown</div>',
          },
        },
      },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Rendered')
    expect(wrapper.text()).toContain('Markdown')
    expect(wrapper.text()).not.toContain('Edit')
  })

  it('uses theme text token for the task status select', async () => {
    const wrapper = mountTaskCard()
    await flushPromises()

    expect(wrapper.get('select.field-select').classes()).toContain('text-app-text')
  })

  it('autosaves trimmed markdown description without edit mode', async () => {
    vi.useFakeTimers()
    const wrapper = mount(TaskCard, {
      props: { templateFilter: null },
      global: {
        stubs: {
          TaskFieldInput: true,
          UserAvatar: true,
          TaskAttachments: true,
          TaskComments: true,
          TaskDescriptionEditor: {
            props: ['modelValue'],
            emits: ['update:modelValue'],
            template: '<textarea data-testid="description-stub" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
          },
        },
      },
    })
    await flushPromises()

    await wrapper.get('[data-testid="description-stub"]').setValue('  ## Edited\\n\\nBody  ')
    vi.advanceTimersByTime(900)
    await flushPromises()

    expect(tasksStoreMock.updateTaskDescription).toHaveBeenCalledWith('task-1', '## Edited\\n\\nBody')
    vi.useRealTimers()
  })

  it('sends null description when markdown is empty', async () => {
    vi.useFakeTimers()
    const wrapper = mount(TaskCard, {
      props: { templateFilter: null },
      global: {
        stubs: {
          TaskFieldInput: true,
          UserAvatar: true,
          TaskAttachments: true,
          TaskComments: true,
          TaskDescriptionEditor: {
            props: ['modelValue'],
            emits: ['update:modelValue'],
            template: '<textarea data-testid="description-stub" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
          },
        },
      },
    })
    await flushPromises()

    await wrapper.get('[data-testid="description-stub"]').setValue('   ')
    vi.advanceTimersByTime(900)
    await flushPromises()

    expect(tasksStoreMock.updateTaskDescription).toHaveBeenCalledWith('task-1', null)
    vi.useRealTimers()
  })

  it('does not save unchanged description on blur', async () => {
    const wrapper = mount(TaskCard, {
      props: { templateFilter: null },
      global: {
        stubs: {
          TaskFieldInput: true,
          UserAvatar: true,
          TaskAttachments: true,
          TaskComments: true,
          TaskDescriptionEditor: {
            props: ['modelValue'],
            emits: ['update:modelValue', 'blur'],
            template: '<textarea data-testid="description-stub" :value="modelValue" @blur="$emit(\'blur\')" />',
          },
        },
      },
    })
    await flushPromises()

    await wrapper.get('[data-testid="description-stub"]').trigger('blur')
    await flushPromises()

    expect(tasksStoreMock.updateTaskDescription).not.toHaveBeenCalled()
  })

  it('does not save unchanged description when switching tasks', async () => {
    mount(TaskCard, {
      props: { templateFilter: null },
      global: {
        stubs: {
          TaskFieldInput: true,
          UserAvatar: true,
          TaskAttachments: true,
          TaskComments: true,
          TaskDescriptionEditor: {
            props: ['modelValue'],
            emits: ['update:modelValue'],
            template: '<textarea data-testid="description-stub" :value="modelValue" />',
          },
        },
      },
    })
    await flushPromises()

    tasksStoreMock.selectedTask = {
      ...selectedTask,
      id: 'task-2',
      public_id: 'TASK-2',
      description: 'second task',
      subtasks: [],
    }
    await flushPromises()

    expect(tasksStoreMock.updateTaskDescription).not.toHaveBeenCalled()
  })

  it('does not save unchanged description on unmount', async () => {
    const wrapper = mount(TaskCard, {
      props: { templateFilter: null },
      global: {
        stubs: {
          TaskFieldInput: true,
          UserAvatar: true,
          TaskAttachments: true,
          TaskComments: true,
          TaskDescriptionEditor: {
            props: ['modelValue'],
            emits: ['update:modelValue'],
            template: '<textarea data-testid="description-stub" :value="modelValue" />',
          },
        },
      },
    })
    await flushPromises()

    wrapper.unmount()
    await flushPromises()

    expect(tasksStoreMock.updateTaskDescription).not.toHaveBeenCalled()
  })

  it('creates subtask with trimmed markdown description', async () => {
    const wrapper = mount(TaskCard, {
      props: { templateFilter: null },
      global: {
        stubs: {
          TaskFieldInput: true,
          UserAvatar: true,
          TaskAttachments: true,
          TaskComments: true,
          TaskDescriptionEditor: {
            props: ['modelValue'],
            emits: ['update:modelValue'],
            template: '<textarea data-testid="description-stub" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
          },
        },
      },
    })
    await flushPromises()

    const addSubtaskButton = wrapper.findAll('button').find(button => button.text() === '+ Add subtask')
    expect(addSubtaskButton).toBeTruthy()
    await addSubtaskButton!.trigger('click')
    await flushPromises()

    await wrapper.get('input[placeholder="Subtask title"]').setValue('Subtask A')
    await wrapper.get('[data-testid="description-stub"]').setValue('  - one\\n- two  ')
    const createButton = wrapper.findAll('button').find(button => button.text() === 'Create subtask')
    expect(createButton).toBeTruthy()
    await createButton!.trigger('click')
    await flushPromises()

    expect(tasksStoreMock.createSubtask).toHaveBeenCalledWith('task-1', expect.objectContaining({
      template_id: 'tpl-1',
      status_id: 'st-1',
      description: '- one\\n- two',
    }))
  })

  it('restores saved subtask title and description on reopen without restoring template or status', async () => {
    saveSubtaskCreateDraft({
      title: 'Recovered subtask',
      description: 'Recovered subtask description',
    })
    const wrapper = mountTaskCard()
    await flushPromises()

    const addSubtaskButton = wrapper.findAll('button').find(button => button.text() === '+ Add subtask')
    expect(addSubtaskButton).toBeTruthy()
    await addSubtaskButton!.trigger('click')
    await flushPromises()

    expect((wrapper.get('input[placeholder="Subtask title"]').element as HTMLInputElement).value).toBe('Recovered subtask')
    expect((wrapper.get('[data-testid="description-stub"]').element as HTMLTextAreaElement).value).toBe('Recovered subtask description')
    expect((wrapper.findAll('select')[1].element as HTMLSelectElement).value).toBe('st-1')

    const templateButton = wrapper.findAll('button').find(button => button.text() === 'TASK')
    const secondTemplateButton = wrapper.findAll('button').find(button => button.text() === 'BUG')
    expect(templateButton?.classes()).toContain('bg-accent')
    expect(secondTemplateButton?.classes()).not.toContain('bg-accent')
  })

  it('saves subtask draft when title and description change', async () => {
    const wrapper = mountTaskCard()
    await flushPromises()

    const addSubtaskButton = wrapper.findAll('button').find(button => button.text() === '+ Add subtask')
    expect(addSubtaskButton).toBeTruthy()
    await addSubtaskButton!.trigger('click')
    await flushPromises()

    await wrapper.get('input[placeholder="Subtask title"]').setValue('Draft subtask')
    await wrapper.get('[data-testid="description-stub"]').setValue('Draft subtask description')
    await flushPromises()

    expect(loadSubtaskCreateDraft()).toEqual({
      title: 'Draft subtask',
      description: 'Draft subtask description',
      stagedAttachments: [],
    })
  })

  it('clears the subtask draft on create', async () => {
    saveSubtaskCreateDraft({
      title: 'Old subtask',
      description: 'Old subtask description',
    })
    const wrapper = mountTaskCard()
    await flushPromises()

    const addSubtaskButton = wrapper.findAll('button').find(button => button.text() === '+ Add subtask')
    expect(addSubtaskButton).toBeTruthy()
    await addSubtaskButton!.trigger('click')
    await flushPromises()

    const createButton = wrapper.findAll('button').find(button => button.text() === 'Create subtask')
    expect(createButton).toBeTruthy()
    await createButton!.trigger('click')
    await flushPromises()

    expect(loadSubtaskCreateDraft()).toEqual({
      title: '',
      description: '',
      stagedAttachments: [],
    })
  })

  it('clears the subtask draft on cancel', async () => {
    const wrapper = mountTaskCard()
    await flushPromises()

    const addSubtaskButton = wrapper.findAll('button').find(button => button.text() === '+ Add subtask')
    expect(addSubtaskButton).toBeTruthy()
    await addSubtaskButton!.trigger('click')
    await flushPromises()

    await wrapper.get('input[placeholder="Subtask title"]').setValue('Cancel subtask')
    await wrapper.get('[data-testid="description-stub"]').setValue('Cancel subtask description')
    await flushPromises()

    const cancelButton = wrapper.findAll('button').find(button => button.text() === 'Cancel')
    expect(cancelButton).toBeTruthy()
    await cancelButton!.trigger('click')
    await flushPromises()

    expect(loadSubtaskCreateDraft()).toEqual({
      title: '',
      description: '',
      stagedAttachments: [],
    })
  })

  it('keeps the subtask draft when create fails', async () => {
    tasksStoreMock.createSubtask.mockRejectedValueOnce(new Error('boom'))
    const wrapper = mountTaskCard()
    await flushPromises()

    const addSubtaskButton = wrapper.findAll('button').find(button => button.text() === '+ Add subtask')
    expect(addSubtaskButton).toBeTruthy()
    await addSubtaskButton!.trigger('click')
    await flushPromises()

    await wrapper.get('input[placeholder="Subtask title"]').setValue('Retry subtask')
    await wrapper.get('[data-testid="description-stub"]').setValue('Retry subtask description')
    const createButton = wrapper.findAll('button').find(button => button.text() === 'Create subtask')
    expect(createButton).toBeTruthy()
    await createButton!.trigger('click')
    await flushPromises()

    expect(loadSubtaskCreateDraft()).toEqual({
      title: 'Retry subtask',
      description: 'Retry subtask description',
      stagedAttachments: [],
    })
  })

  it('renders a single subtask assignee avatar and username in the right-side assignee list', async () => {
    tasksStoreMock.selectedTask = {
      ...selectedTask,
      subtasks: [
        {
          id: 'sub-1',
          public_id: 'TASK-2',
          template_id: 'tpl-1',
          template_snapshot_prefix: 'TASK',
          sequence_number: 2,
          title: 'Assigned child',
          description: null,
          status_id: 'st-1',
          parent_task_id: 'task-1',
          created_by: 'u-1',
          updated_by: 'u-1',
          created_at: '2026-03-10T12:05:00Z',
          updated_at: '2026-03-10T12:05:00Z',
          assignees: [
            {
              id: 'u-2',
              display_name: 'Updater User',
              email: 'updater@example.com',
              avatar_url: '/api/public/avatars/avatars/u-2/updater.png',
            },
          ],
        },
      ],
    }

    const wrapper = mount(TaskCard, {
      props: { templateFilter: null },
      global: {
        stubs: {
          TaskFieldInput: true,
          TaskAttachments: true,
          TaskComments: true,
          TaskDescriptionEditor: true,
          UserAvatar: {
            props: ['userId', 'displayName', 'avatarUrl', 'size'],
            template: '<div class="user-avatar-stub" :data-user-id="userId" :data-display-name="displayName" :data-avatar-url="avatarUrl" :data-size="size" />',
          },
        },
      },
    })
    await flushPromises()

    const assigneeBlock = wrapper.get('[data-testid="subtask-assignee-sub-1"]')
    const avatars = assigneeBlock.findAll('.user-avatar-stub')
    expect(avatars).toHaveLength(1)
    expect(avatars[0].attributes('data-user-id')).toBe('u-2')
    expect(avatars[0].attributes('data-display-name')).toBe('Updater User')
    expect(avatars[0].attributes('data-avatar-url')).toBe('/api/public/avatars/avatars/u-2/updater.png')
    expect(avatars[0].attributes('data-size')).toBe('xs')
    expect(assigneeBlock.text()).toContain('Updater User')
  })

  it('falls back to assignee email for avatar label and username when display name is empty', async () => {
    tasksStoreMock.selectedTask = {
      ...selectedTask,
      subtasks: [
        {
          id: 'sub-2',
          public_id: 'TASK-3',
          template_id: 'tpl-1',
          template_snapshot_prefix: 'TASK',
          sequence_number: 3,
          title: 'Assigned child',
          description: null,
          status_id: 'st-1',
          parent_task_id: 'task-1',
          created_by: 'u-1',
          updated_by: 'u-1',
          created_at: '2026-03-10T12:06:00Z',
          updated_at: '2026-03-10T12:06:00Z',
          assignees: [
            {
              id: 'u-3',
              display_name: '',
              email: 'fallback@example.com',
              avatar_url: '',
            },
          ],
        },
      ],
    }

    const wrapper = mount(TaskCard, {
      props: { templateFilter: null },
      global: {
        stubs: {
          TaskFieldInput: true,
          TaskAttachments: true,
          TaskComments: true,
          TaskDescriptionEditor: true,
          UserAvatar: {
            props: ['userId', 'displayName', 'avatarUrl', 'size'],
            template: '<div class="user-avatar-stub" :data-display-name="displayName" />',
          },
        },
      },
    })
    await flushPromises()

    const assigneeBlock = wrapper.get('[data-testid="subtask-assignee-sub-2"]')
    expect(assigneeBlock.text()).toContain('fallback@example.com')
    expect(assigneeBlock.get('.user-avatar-stub').attributes('data-display-name')).toBe('fallback@example.com')
  })

  it('renders multiple assignee avatar-and-username pairs with comma separators and overflow marker', async () => {
    tasksStoreMock.selectedTask = {
      ...selectedTask,
      subtasks: [
        {
          id: 'sub-3',
          public_id: 'TASK-4',
          template_id: 'tpl-1',
          template_snapshot_prefix: 'TASK',
          sequence_number: 4,
          title: 'Multi-assigned child',
          description: null,
          status_id: 'st-1',
          parent_task_id: 'task-1',
          created_by: 'u-1',
          updated_by: 'u-1',
          created_at: '2026-03-10T12:07:00Z',
          updated_at: '2026-03-10T12:07:00Z',
          assignees: [
            { id: 'u-1', display_name: 'Creator User', email: 'creator@example.com', avatar_url: '' },
            { id: 'u-2', display_name: 'Updater User', email: 'updater@example.com', avatar_url: '' },
            { id: 'u-3', display_name: '', email: 'third@example.com', avatar_url: '' },
            { id: 'u-4', display_name: 'Fourth User', email: 'fourth@example.com', avatar_url: '' },
          ],
        },
      ],
    }

    const wrapper = mount(TaskCard, {
      props: { templateFilter: null },
      global: {
        stubs: {
          TaskFieldInput: true,
          TaskAttachments: true,
          TaskComments: true,
          TaskDescriptionEditor: true,
          UserAvatar: {
            props: ['userId', 'displayName'],
            template: '<div class="user-avatar-stub" :data-user-id="userId" :data-display-name="displayName" />',
          },
        },
      },
    })
    await flushPromises()

    const assigneeBlock = wrapper.get('[data-testid="subtask-assignee-sub-3"]')
    const avatars = assigneeBlock.findAll('.user-avatar-stub')
    expect(avatars).toHaveLength(3)
    expect(avatars[0].attributes('data-user-id')).toBe('u-1')
    expect(avatars[1].attributes('data-user-id')).toBe('u-2')
    expect(avatars[2].attributes('data-user-id')).toBe('u-3')
    expect(wrapper.get('[data-testid="subtask-assignee-overflow-sub-3"]').text()).toBe('...')
    expect(assigneeBlock.text()).toContain('Creator User')
    expect(assigneeBlock.text()).toContain('Updater User')
    expect(assigneeBlock.text()).toContain('third@example.com')
    expect(assigneeBlock.text()).toContain(',')
    expect(assigneeBlock.text()).toContain('...')
  })

  it('hides the subtask assignee block when no assignee is attached', async () => {
    tasksStoreMock.selectedTask = {
      ...selectedTask,
      subtasks: [
        {
          id: 'sub-4',
          public_id: 'TASK-5',
          template_id: 'tpl-1',
          template_snapshot_prefix: 'TASK',
          sequence_number: 5,
          title: 'Unassigned child',
          description: null,
          status_id: 'st-1',
          parent_task_id: 'task-1',
          created_by: 'u-1',
          updated_by: 'u-1',
          created_at: '2026-03-10T12:08:00Z',
          updated_at: '2026-03-10T12:08:00Z',
          assignees: [],
        },
      ],
    }

    const wrapper = mount(TaskCard, {
      props: { templateFilter: null },
      global: {
        stubs: {
          TaskFieldInput: true,
          TaskAttachments: true,
          TaskComments: true,
          TaskDescriptionEditor: true,
          UserAvatar: true,
        },
      },
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="subtask-assignee-sub-4"]').exists()).toBe(false)
  })

  it('renders creator and updater metadata in the footer', async () => {
    const wrapper = mount(TaskCard, {
      props: { templateFilter: null },
      global: {
        stubs: {
          TaskFieldInput: true,
          TaskAttachments: true,
          TaskComments: true,
          TaskDescriptionEditor: true,
          UserAvatar: {
            props: ['userId', 'displayName', 'avatarUrl', 'size'],
            template: '<div class="user-avatar-stub" :data-user-id="userId" :data-display-name="displayName" :data-avatar-url="avatarUrl" :data-size="size" />',
          },
        },
      },
    })
    await flushPromises()

    const footer = wrapper.findAll('.user-avatar-stub')
    expect(footer).toHaveLength(2)
    expect(footer[0].attributes('data-user-id')).toBe('u-1')
    expect(footer[0].attributes('data-display-name')).toBe('Creator User')
    expect(footer[0].attributes('data-avatar-url')).toBe('/api/public/avatars/avatars/u-1/creator.png')
    expect(wrapper.text()).toContain('Creator User')
    expect(wrapper.text()).toContain('Updater User')
    expect(wrapper.text()).toMatch(/3\/10\/2026|2026-03-10/)
  })

  it('removes the legacy description history modal control', async () => {
    const wrapper = mount(TaskCard, {
      props: { templateFilter: null },
      global: {
        stubs: {
          TaskFieldInput: true,
          UserAvatar: true,
          TaskAttachments: true,
          TaskComments: true,
          TaskDescriptionEditor: true,
        },
      },
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="task-description-history-toggle"]').exists()).toBe(false)
    expect(document.body.querySelector('[data-testid="task-description-restore-modal"]')).toBeNull()
  })

  it('exports the current task to PDF and saves it through the platform adapter', async () => {
    const wrapper = mount(TaskCard, {
      props: { templateFilter: null },
      global: {
        stubs: {
          TaskFieldInput: true,
          UserAvatar: true,
          TaskAttachments: true,
          TaskComments: true,
          TaskDescriptionEditor: {
            props: ['modelValue'],
            emits: ['update:modelValue'],
            template: '<textarea data-testid="description-stub" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
          },
        },
      },
    })
    await flushPromises()

    await wrapper.get('[data-testid="description-stub"]').setValue('## Exported body')
    await wrapper.get('[data-testid="task-export-pdf"]').trigger('click')
    await flushPromises()

    expect(platformMocks.exportTaskToPdfBlob).toHaveBeenCalledWith({
      public_id: 'TASK-1',
      title: 'Initial title',
      description: '## Exported body',
    })
    const platform = platformMocks.getPlatformOrNull.mock.results[0]?.value
    expect(platform.files.saveBlob).toHaveBeenCalledWith(expect.objectContaining({
      suggestedName: 'TASK-1.pdf',
      mimeType: 'application/pdf',
    }))
  })

  it('copies the canonical task URL using the current browser host', async () => {
    const wrapper = mountTaskCard()
    await flushPromises()

    await wrapper.get('[data-testid="task-copy-url"]').trigger('click')

    expect(clipboardWriteText).toHaveBeenCalledWith(
      `${window.location.protocol}//${window.location.host}/tasks/task-1`,
    )
    expect(chatStoreMock.showToast).toHaveBeenCalledWith('Task URL copied.')
  })
})
