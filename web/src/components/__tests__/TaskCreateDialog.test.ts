import { defineComponent, reactive } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TaskCreateDialog from '@/components/tasks/TaskCreateDialog.vue'
import {
  clearTaskCreateDraft,
  loadTaskCreateDraft,
  saveTaskCreateDraft,
} from '@/services/storage/taskCreateDraftStorage'
import { storage } from '@/services/storage/storageAdapter'
import { ensureLocalStorageMock } from '@/__tests__/testUtils'

const tasksApiMock = vi.hoisted(() => ({
  tasksUploadStagedAttachment: vi.fn(),
  tasksDeleteStagedAttachment: vi.fn(),
}))

vi.mock('@/services/http/tasksApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/http/tasksApi')>()
  return {
    ...actual,
    tasksUploadStagedAttachment: tasksApiMock.tasksUploadStagedAttachment,
    tasksDeleteStagedAttachment: tasksApiMock.tasksDeleteStagedAttachment,
  }
})

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
  createDialogOpen: true,
  configError: null as string | null,
  configLoading: false,
  activeTemplates: [...baseTemplates],
  activeStatuses: [...baseStatuses],
  users: [],
  enumDictionaryFor: vi.fn(() => undefined),
  enumItemsFor: vi.fn(() => []),
  enumKnownItemsFor: vi.fn(() => []),
  enumItemCreateLoadingFor: vi.fn(() => false),
  enumItemSearchLoadingFor: vi.fn(() => false),
  activeFieldsFor: vi.fn(() => []),
  enumVersionFor: vi.fn(() => undefined),
  loadConfig: vi.fn(async () => {}),
  loadFieldsFor: vi.fn(async () => {}),
  loadUsers: vi.fn(async () => {}),
  loadEnumItemsFor: vi.fn(async () => {}),
  searchEnumItemsFor: vi.fn(async () => []),
  closeCreateDialog: vi.fn(),
  createTask: vi.fn(async () => ({
    id: 'task-1',
  })),
})

vi.mock('@/stores/tasks', () => ({
  useTasksStore: () => tasksStoreMock,
}))

function mountDialog(props: { initialTemplateId: string | null } = { initialTemplateId: null }) {
  return mount(TaskCreateDialog, {
    props,
    global: {
      stubs: {
        Teleport: true,
        TaskFieldInput: true,
        TaskDescriptionEditor: defineComponent({
          name: 'TaskDescriptionEditor',
          props: ['modelValue', 'taskStagedAttachmentUpload'],
          emits: ['update:modelValue'],
          methods: {
            async pasteImage() {
              const upload = this.taskStagedAttachmentUpload as ((files: File[]) => Promise<Array<{ id: string }>>) | undefined
              const rows = await upload?.([new File(['img'], 'Photo.png', { type: 'image/png' })])
              if (!rows?.length) return
              this.$emit('update:modelValue', `![Photo.png](msgnr-staged-attachment://task/${rows[0].id})`)
            },
          },
          template: '<div><textarea data-testid="description-stub" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" /><button type="button" data-testid="paste-image-stub" @click="pasteImage">paste</button></div>',
        }),
      },
    },
  })
}

describe('TaskCreateDialog', () => {
  beforeEach(() => {
    ensureLocalStorageMock()
    localStorage.clear()
    storage.clear()
    vi.clearAllMocks()
    tasksStoreMock.createDialogOpen = true
    tasksStoreMock.activeTemplates = [...baseTemplates]
    tasksStoreMock.activeStatuses = [...baseStatuses]
    tasksStoreMock.closeCreateDialog.mockImplementation(() => {
      tasksStoreMock.createDialogOpen = false
    })
    tasksStoreMock.createTask.mockImplementation(async () => ({ id: 'task-1' }))
    tasksApiMock.tasksUploadStagedAttachment.mockResolvedValue({
      id: 'staged-1',
      file_name: 'Photo.png',
      file_size: 3,
      mime_type: 'image/png',
      uploaded_by: 'u-1',
      created_at: '2026-01-01T00:00:00Z',
    })
    tasksApiMock.tasksDeleteStagedAttachment.mockResolvedValue(undefined)
  })

  it('submits trimmed markdown description', async () => {
    tasksStoreMock.createDialogOpen = false
    const wrapper = mountDialog()
    tasksStoreMock.createDialogOpen = true
    await wrapper.vm.$nextTick()
    await flushPromises()

    const templateButton = wrapper.findAll('button').find(button => button.text() === 'TASK')
    expect(templateButton).toBeTruthy()
    await templateButton!.trigger('click')
    await wrapper.get('select').setValue('st-1')
    await wrapper.get('input[placeholder="Task title"]').setValue('New task')
    await wrapper.get('[data-testid="description-stub"]').setValue('  ## Title\\n\\nBody  ')
    const createButton = wrapper.findAll('button').find(button => button.text() === 'Create task')
    expect(createButton).toBeTruthy()
    await createButton!.trigger('click')
    await flushPromises()

    expect(tasksStoreMock.createTask).toHaveBeenCalledWith(expect.objectContaining({
      title: 'New task',
      description: '## Title\\n\\nBody',
      status_id: 'st-1',
    }))
  })

  it('sends null description when markdown is blank after trim', async () => {
    tasksStoreMock.createDialogOpen = false
    const wrapper = mountDialog()
    tasksStoreMock.createDialogOpen = true
    await wrapper.vm.$nextTick()
    await flushPromises()

    const templateButton = wrapper.findAll('button').find(button => button.text() === 'TASK')
    expect(templateButton).toBeTruthy()
    await templateButton!.trigger('click')
    await wrapper.get('select').setValue('st-1')
    await wrapper.get('input[placeholder="Task title"]').setValue('Task without description')
    await wrapper.get('[data-testid="description-stub"]').setValue('   ')
    const createButton = wrapper.findAll('button').find(button => button.text() === 'Create task')
    expect(createButton).toBeTruthy()
    await createButton!.trigger('click')
    await flushPromises()

    expect(tasksStoreMock.createTask).toHaveBeenCalledWith(expect.objectContaining({
      description: null,
    }))
  })

  it('restores saved title and description on reopen without restoring template or status', async () => {
    saveTaskCreateDraft({
      title: 'Recovered task',
      description: 'Recovered description',
    })
    tasksStoreMock.createDialogOpen = false
    const wrapper = mountDialog()
    tasksStoreMock.createDialogOpen = true
    await wrapper.vm.$nextTick()
    await flushPromises()

    expect((wrapper.get('input[placeholder="Task title"]').element as HTMLInputElement).value).toBe('Recovered task')
    expect((wrapper.get('[data-testid="description-stub"]').element as HTMLTextAreaElement).value).toBe('Recovered description')
    expect((wrapper.get('select').element as HTMLSelectElement).value).toBe('st-1')

    const templateButton = wrapper.findAll('button').find(button => button.text() === 'TASK')
    const secondTemplateButton = wrapper.findAll('button').find(button => button.text() === 'BUG')
    expect(templateButton?.classes()).toContain('bg-accent')
    expect(secondTemplateButton?.classes()).not.toContain('bg-accent')
  })

  it('preselects the initial template when it is active', async () => {
    tasksStoreMock.createDialogOpen = false
    const wrapper = mountDialog({ initialTemplateId: 'tpl-2' })
    tasksStoreMock.createDialogOpen = true
    await wrapper.vm.$nextTick()
    await flushPromises()

    const firstTemplateButton = wrapper.findAll('button').find(button => button.text() === 'TASK')
    const secondTemplateButton = wrapper.findAll('button').find(button => button.text() === 'BUG')
    expect(firstTemplateButton?.classes()).not.toContain('bg-accent')
    expect(secondTemplateButton?.classes()).toContain('bg-accent')
  })

  it('uses the first active template when no initial template is provided', async () => {
    tasksStoreMock.createDialogOpen = false
    const wrapper = mountDialog({ initialTemplateId: null })
    tasksStoreMock.createDialogOpen = true
    await wrapper.vm.$nextTick()
    await flushPromises()

    const firstTemplateButton = wrapper.findAll('button').find(button => button.text() === 'TASK')
    const secondTemplateButton = wrapper.findAll('button').find(button => button.text() === 'BUG')
    expect(firstTemplateButton?.classes()).toContain('bg-accent')
    expect(secondTemplateButton?.classes()).not.toContain('bg-accent')
  })

  it('uses semantic theme classes for title surfaces in the create dialog', async () => {
    tasksStoreMock.createDialogOpen = false
    const wrapper = mountDialog()
    tasksStoreMock.createDialogOpen = true
    await wrapper.vm.$nextTick()
    await flushPromises()

    expect(wrapper.get('h2').classes()).toContain('text-app-text')
    expect(wrapper.get('label.form-label').classes()).toContain('form-label')

    const titleInput = wrapper.get('input[placeholder="Task title"]')
    expect(titleInput.classes()).toContain('form-input')
    expect(titleInput.classes()).not.toContain('text-white')

    const templateButton = wrapper.findAll('button').find(button => button.text() === 'TASK')
    expect(templateButton?.classes()).toContain('text-app-onAccent')
  })

  it('uses the first active template when the initial template is not active', async () => {
    tasksStoreMock.createDialogOpen = false
    const wrapper = mountDialog({ initialTemplateId: 'tpl-deleted' })
    tasksStoreMock.createDialogOpen = true
    await wrapper.vm.$nextTick()
    await flushPromises()

    const firstTemplateButton = wrapper.findAll('button').find(button => button.text() === 'TASK')
    const secondTemplateButton = wrapper.findAll('button').find(button => button.text() === 'BUG')
    expect(firstTemplateButton?.classes()).toContain('bg-accent')
    expect(secondTemplateButton?.classes()).not.toContain('bg-accent')
  })

  it('saves draft when title and description change', async () => {
    tasksStoreMock.createDialogOpen = false
    const wrapper = mountDialog()
    tasksStoreMock.createDialogOpen = true
    await wrapper.vm.$nextTick()
    await flushPromises()

    await wrapper.get('input[placeholder="Task title"]').setValue('Draft title')
    await wrapper.get('[data-testid="description-stub"]').setValue('Draft description')
    await flushPromises()

    expect(loadTaskCreateDraft()).toEqual({
      title: 'Draft title',
      description: 'Draft description',
      stagedAttachments: [],
    })
  })

  it('clears the draft on create task', async () => {
    saveTaskCreateDraft({
      title: 'Old draft',
      description: 'Old description',
    })
    tasksStoreMock.createDialogOpen = false
    const wrapper = mountDialog()
    tasksStoreMock.createDialogOpen = true
    await wrapper.vm.$nextTick()
    await flushPromises()

    await wrapper.get('select').setValue('st-1')
    const createButton = wrapper.findAll('button').find(button => button.text() === 'Create task')
    expect(createButton).toBeTruthy()
    await createButton!.trigger('click')
    await flushPromises()

    expect(loadTaskCreateDraft()).toEqual({
      title: '',
      description: '',
      stagedAttachments: [],
    })
  })

  it('uploads pasted staged images and sends referenced staged attachment ids on create', async () => {
    tasksStoreMock.createDialogOpen = false
    const wrapper = mountDialog()
    tasksStoreMock.createDialogOpen = true
    await wrapper.vm.$nextTick()
    await flushPromises()

    await wrapper.get('select').setValue('st-1')
    await wrapper.get('input[placeholder="Task title"]').setValue('Task with image')
    await wrapper.get('[data-testid="paste-image-stub"]').trigger('click')
    await flushPromises()

    expect(tasksApiMock.tasksUploadStagedAttachment).toHaveBeenCalledWith(expect.any(File))
    expect(loadTaskCreateDraft()).toMatchObject({
      description: '![Photo.png](msgnr-staged-attachment://task/staged-1)',
      stagedAttachments: [{
        id: 'staged-1',
        file_name: 'Photo.png',
      }],
    })

    const createButton = wrapper.findAll('button').find(button => button.text() === 'Create task')
    expect(createButton).toBeTruthy()
    await createButton!.trigger('click')
    await flushPromises()

    expect(tasksStoreMock.createTask).toHaveBeenCalledWith(expect.objectContaining({
      staged_attachment_ids: ['staged-1'],
      description: '![Photo.png](msgnr-staged-attachment://task/staged-1)',
    }))
    expect(tasksApiMock.tasksDeleteStagedAttachment).not.toHaveBeenCalled()
    expect(loadTaskCreateDraft()).toEqual({
      title: '',
      description: '',
      stagedAttachments: [],
    })
  })

  it('deletes staged attachments when cancel clears the draft', async () => {
    tasksStoreMock.createDialogOpen = false
    const wrapper = mountDialog()
    tasksStoreMock.createDialogOpen = true
    await wrapper.vm.$nextTick()
    await flushPromises()

    await wrapper.get('[data-testid="paste-image-stub"]').trigger('click')
    await flushPromises()

    const cancelButton = wrapper.findAll('button').find(button => button.text() === 'Cancel')
    expect(cancelButton).toBeTruthy()
    await cancelButton!.trigger('click')
    await flushPromises()

    expect(tasksApiMock.tasksDeleteStagedAttachment).toHaveBeenCalledWith('staged-1')
    expect(loadTaskCreateDraft()).toEqual({
      title: '',
      description: '',
      stagedAttachments: [],
    })
  })

  it('clears the draft on cancel', async () => {
    tasksStoreMock.createDialogOpen = false
    const wrapper = mountDialog()
    tasksStoreMock.createDialogOpen = true
    await wrapper.vm.$nextTick()
    await flushPromises()

    await wrapper.get('input[placeholder="Task title"]').setValue('Cancel me')
    await wrapper.get('[data-testid="description-stub"]').setValue('Cancel description')
    await flushPromises()

    const cancelButton = wrapper.findAll('button').find(button => button.text() === 'Cancel')
    expect(cancelButton).toBeTruthy()
    await cancelButton!.trigger('click')
    await flushPromises()

    expect(loadTaskCreateDraft()).toEqual({
      title: '',
      description: '',
      stagedAttachments: [],
    })
  })

  it('preserves the draft on header close', async () => {
    tasksStoreMock.createDialogOpen = false
    const wrapper = mountDialog()
    tasksStoreMock.createDialogOpen = true
    await wrapper.vm.$nextTick()
    await flushPromises()

    await wrapper.get('input[placeholder="Task title"]').setValue('Keep me')
    await wrapper.get('[data-testid="description-stub"]').setValue('Keep description')
    await flushPromises()

    await wrapper.get('button[aria-label="Close"]').trigger('click')
    await flushPromises()

    expect(loadTaskCreateDraft()).toEqual({
      title: 'Keep me',
      description: 'Keep description',
      stagedAttachments: [],
    })
  })

  it('keeps the draft when create fails', async () => {
    tasksStoreMock.createTask.mockRejectedValueOnce(new Error('boom'))
    tasksStoreMock.createDialogOpen = false
    const wrapper = mountDialog()
    tasksStoreMock.createDialogOpen = true
    await wrapper.vm.$nextTick()
    await flushPromises()

    await wrapper.get('select').setValue('st-1')
    await wrapper.get('input[placeholder="Task title"]').setValue('Retry task')
    await wrapper.get('[data-testid="description-stub"]').setValue('Retry description')
    const createButton = wrapper.findAll('button').find(button => button.text() === 'Create task')
    expect(createButton).toBeTruthy()
    await createButton!.trigger('click')
    await flushPromises()

    expect(loadTaskCreateDraft()).toEqual({
      title: 'Retry task',
      description: 'Retry description',
      stagedAttachments: [],
    })
  })

  it('does not close when clicking the backdrop', async () => {
    clearTaskCreateDraft()
    const wrapper = mount(TaskCreateDialog, {
      props: {
        initialTemplateId: null,
      },
      attachTo: document.body,
      global: {
        stubs: {
          Teleport: false,
          TaskFieldInput: true,
          TaskDescriptionEditor: true,
        },
      },
    })
    await flushPromises()

    const backdrop = document.body.querySelector('.fixed.inset-0.z-50') as HTMLElement | null
    expect(backdrop).toBeTruthy()
    backdrop!.click()
    await flushPromises()

    expect(tasksStoreMock.closeCreateDialog).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
