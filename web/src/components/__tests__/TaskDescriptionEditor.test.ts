import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, nextTick, ref, watch } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { createPinia, setActivePinia } from 'pinia'
import TaskDescriptionEditor from '@/components/tasks/TaskDescriptionEditor.vue'
import TaskDescriptionRichEditor from '@/components/tasks/TaskDescriptionRichEditor.vue'
import { fetchOwnedAttachmentBlob, uploadOwnedAttachments } from '@/services/http/attachmentOwnersApi'
import { createOrOpenDm } from '@/services/http/chatApi'
import { tasksFetchStagedAttachmentBlob, tasksListTasks, tasksListUsers } from '@/services/http/tasksApi'
import { resetDescriptionMentionCacheForTests } from '@/utils/descriptionMentions'

vi.mock('@/services/http/attachmentOwnersApi', () => ({
  uploadOwnedAttachments: vi.fn(),
  fetchOwnedAttachmentBlob: vi.fn(),
}))

vi.mock('@/services/http/chatApi', () => ({
  createOrOpenDm: vi.fn(),
  listSavedMessages: vi.fn(),
  saveMessage: vi.fn(),
  unsaveMessage: vi.fn(),
}))

vi.mock('@/services/http/tasksApi', () => ({
  tasksListUsers: vi.fn(),
  tasksListTasks: vi.fn(),
  tasksFetchStagedAttachmentBlob: vi.fn(),
}))

vi.mock('@/services/http/documentsApi', () => ({
  documentsSearchDocuments: vi.fn(),
}))

describe('TaskDescriptionEditor', () => {
  async function waitForRenderedEditor(wrapper: ReturnType<typeof mount>) {
    for (let i = 0; i < 10; i += 1) {
      await flushPromises()
      await nextTick()
      if (wrapper.find('[data-testid="task-description-editor-content"] .ProseMirror').exists()) {
        return
      }
    }
    throw new Error('rendered editor did not mount')
  }

  async function waitForRenderedEditorText(wrapper: ReturnType<typeof mount>, expected: string) {
    for (let i = 0; i < 20; i += 1) {
      await flushPromises()
      await nextTick()
      const editor = wrapper.find('[data-testid="task-description-editor-content"] .ProseMirror')
      if (editor.exists() && editor.text().includes(expected)) {
        return
      }
    }
    throw new Error(`rendered editor did not contain ${JSON.stringify(expected)}`)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    resetDescriptionMentionCacheForTests()
    Object.defineProperty(globalThis.Node.prototype, 'getClientRects', {
      configurable: true,
      value: () => [],
    })
    Object.defineProperty(globalThis.Node.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
      }),
    })
    Object.defineProperty(globalThis.HTMLElement.prototype, 'getClientRects', {
      configurable: true,
      value: () => [],
    })
    Object.defineProperty(globalThis.HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
      }),
    })
    if (typeof globalThis.Range !== 'undefined') {
      Object.defineProperty(globalThis.Range.prototype, 'getClientRects', {
        configurable: true,
        value: () => [],
      })
      Object.defineProperty(globalThis.Range.prototype, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          top: 0,
          right: 0,
          bottom: 0,
          left: 0,
        }),
      })
    }
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:editor')
    globalThis.URL.revokeObjectURL = vi.fn()
    window.open = vi.fn(() => ({
      location: {
        replace: vi.fn(),
      },
      focus: vi.fn(),
      close: vi.fn(),
    } as unknown as Window))
    vi.mocked(fetchOwnedAttachmentBlob).mockResolvedValue(new Blob(['img'], { type: 'image/png' }))
    vi.mocked(tasksFetchStagedAttachmentBlob).mockResolvedValue(new Blob(['img'], { type: 'image/png' }))
    vi.mocked(createOrOpenDm).mockResolvedValue({
      conversation_id: 'dm-1',
      user_id: 'user-1',
      display_name: 'Alice Example',
      email: 'alice@example.com',
      avatar_url: 'https://example.com/alice.png',
      kind: 'dm',
      visibility: 'dm',
    })
    vi.mocked(tasksListUsers).mockResolvedValue([])
    vi.mocked(tasksListTasks).mockResolvedValue({ groups: [], grand_total: 0 })
  })

  it('uploads dropped files from the markdown tab and inserts tokens at the cursor', async () => {
    vi.mocked(uploadOwnedAttachments).mockResolvedValue({
      attachments: [{
        id: 'att-file',
        file_name: 'Spec.pdf',
        mime_type: 'application/pdf',
      }, {
        id: 'att-image',
        file_name: 'Photo.png',
        mime_type: 'image/png',
      }],
      errors: [],
    })

    const wrapper = mount(TaskDescriptionEditor, {
      props: {
        modelValue: 'Before',
        defaultTab: 'markdown',
        ownerKind: 'task',
        ownerId: 'task-1',
      },
    })

    const input = wrapper.get('[data-testid="task-description-markdown-input"]')
    ;(input.element as HTMLTextAreaElement).setSelectionRange(6, 6)

    await input.trigger('paste', {
      clipboardData: {
        files: [
          new File(['pdf'], 'Spec.pdf', { type: 'application/pdf' }),
          new File(['img'], 'Photo.png', { type: 'image/png' }),
        ],
      },
    })
    await flushPromises()

    const updates = wrapper.emitted('update:modelValue') ?? []
    const latest = updates[updates.length - 1]?.[0] as string
    expect(latest).toContain('[Spec.pdf](msgnr-attachment://task/task-1/att-file)')
    expect(latest).toContain('![Photo.png](msgnr-attachment://task/task-1/att-image)')
    expect(String(latest)).toMatch(/\[Spec\.pdf\].*!\[Photo\.png\]/s)
  })

  it('uploads one grouped selection and preserves the server result order', async () => {
    vi.mocked(uploadOwnedAttachments).mockResolvedValue({
      attachments: [
        { id: 'att-file', file_name: 'Spec.pdf', mime_type: 'application/pdf' },
        { id: 'att-image', file_name: 'Photo.png', mime_type: 'image/png' },
      ],
      errors: [],
    })

    const wrapper = mount(TaskDescriptionEditor, {
      props: {
        modelValue: '',
        defaultTab: 'markdown',
        ownerKind: 'task',
        ownerId: 'task-1',
      },
    })

    const input = wrapper.get('[data-testid="task-description-markdown-input"]')
    await input.trigger('paste', {
      clipboardData: {
        files: [
          new File(['pdf'], 'Spec.pdf', { type: 'application/pdf' }),
          new File(['img'], 'Photo.png', { type: 'image/png' }),
        ],
      },
    })
    await flushPromises()

    expect(uploadOwnedAttachments).toHaveBeenCalledWith('task', 'task-1', [expect.any(File), expect.any(File)])

    const updates = wrapper.emitted('update:modelValue') ?? []
    const latest = updates[updates.length - 1]?.[0] as string
    expect(String(latest)).toMatch(/\[Spec\.pdf\].*!\[Photo\.png\]/s)
  })

  it('shows a non-error hint and skips uploads when the owner is not saved yet', async () => {
    const wrapper = mount(TaskDescriptionEditor, {
      props: {
        modelValue: '',
        defaultTab: 'markdown',
        ownerKind: 'task',
      },
    })

    await wrapper.get('[data-testid="task-description-markdown-input"]').trigger('paste', {
      clipboardData: {
        files: [new File(['img'], 'Photo.png', { type: 'image/png' })],
      },
    })
    await flushPromises()

    expect(uploadOwnedAttachments).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="task-description-attachment-note"]').text()).toContain('available after save')
  })

  it('uses semantic theme classes for tabs and markdown input', async () => {
    const wrapper = mount(TaskDescriptionEditor, {
      props: {
        modelValue: '```ts\nconst value = 1\n```',
        defaultTab: 'markdown',
      },
    })

    const markdownTab = wrapper.get('[data-testid="task-description-tab-markdown"]')
    expect(markdownTab.classes()).toContain('text-app-onAccent')

    const input = wrapper.get('[data-testid="task-description-markdown-input"]')
    expect(input.classes()).toContain('text-app-text')
    expect(input.classes()).toContain('placeholder-app-muted')
    expect(input.classes()).not.toContain('text-white')
  })

  it('renders task content without an input-like description shell', () => {
    const wrapper = mount(TaskDescriptionEditor, {
      props: {
        modelValue: 'Description text',
      },
    })

    const rendered = wrapper.get('[data-testid="task-description-rendered"]')
    expect(rendered.classes()).not.toContain('border')
    expect(rendered.classes()).not.toContain('border-chat-border')
    expect(rendered.classes()).not.toContain('rounded')
    expect(rendered.classes()).not.toContain('bg-chat-input')
  })

  it('uploads pasted images through the create-task staging callback', async () => {
    const uploadStaged = vi.fn(async () => [{
      id: 'staged-1',
      file_name: 'Photo.png',
      mime_type: 'image/png',
    }])

    const wrapper = mount(TaskDescriptionEditor, {
      props: {
        modelValue: '',
        defaultTab: 'markdown',
        ownerKind: 'task',
        taskStagedAttachmentUpload: uploadStaged,
      },
    })

    await wrapper.get('[data-testid="task-description-markdown-input"]').trigger('paste', {
      clipboardData: {
        files: [new File(['img'], 'Photo.png', { type: 'image/png' })],
      },
    })
    await flushPromises()

    const updates = wrapper.emitted('update:modelValue') ?? []
    const latest = updates[updates.length - 1]?.[0] as string
    expect(uploadStaged).toHaveBeenCalledWith([expect.any(File)])
    expect(latest).toContain('![Photo.png](msgnr-staged-attachment://task/staged-1)')
    expect(uploadOwnedAttachments).not.toHaveBeenCalled()
  })

  it('syncs markdown-tab edits into the collab-backed rendered editor', async () => {
    const collabDoc = new Y.Doc()
    collabDoc.getXmlFragment('task_description')
    const richEditorStub = defineComponent({
      name: 'TaskDescriptionRichEditor',
      props: {
        modelValue: {
          type: String,
          required: true,
        },
        collabDoc: {
          type: Object,
          default: null,
        },
        forceLocalSyncToken: {
          type: Number,
          default: 0,
        },
      },
      setup(props) {
        const renderedValue = ref(props.modelValue)

        watch(
          () => props.forceLocalSyncToken,
          (next, prev) => {
            if (next === prev) return
            renderedValue.value = props.modelValue
            const collabDoc = props.collabDoc as Y.Doc | null
            if (!collabDoc) return
            const fragment = collabDoc.getXmlFragment('task_description')
            collabDoc.transact(() => {
              fragment.delete(0, fragment.length)
              if (props.modelValue.trim() === '') return
              const text = new Y.XmlText()
              text.insert(0, props.modelValue)
              fragment.insert(0, [text])
            }, 'test-stub-sync')
          },
        )

        return {
          renderedValue,
        }
      },
      template: '<div data-testid="task-description-editor-content"><div class="ProseMirror">{{ renderedValue }}</div></div>',
    })

    const wrapper = mount(TaskDescriptionEditor, {
      props: {
        modelValue: '**Old** text',
        defaultTab: 'rendered',
        collabDoc,
      },
      attachTo: document.body,
      global: {
        stubs: {
          TaskDescriptionRichEditor: richEditorStub,
        },
      },
    })
    await waitForRenderedEditor(wrapper)

    await wrapper.get('[data-testid="task-description-tab-markdown"]').trigger('click')
    await flushPromises()

    await wrapper.get('[data-testid="task-description-markdown-input"]').setValue('## Edited\n\nBody')
    await flushPromises()

    await wrapper.get('[data-testid="task-description-tab-rendered"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="task-description-editor-content"] .ProseMirror').text()).toContain('## Edited')
    expect(wrapper.get('[data-testid="task-description-editor-content"] .ProseMirror').text()).toContain('Body')
    expect(collabDoc.getXmlFragment('task_description').length).toBeGreaterThan(0)
  })

  it('disables markdown editing while remote collaborators are active', async () => {
    const collabDoc = new Y.Doc()
    collabDoc.getXmlFragment('task_description')

    const wrapper = mount(TaskDescriptionEditor, {
      props: {
        modelValue: '**Old** text',
        defaultTab: 'markdown',
        collabDoc,
        collabHasRemotePeers: true,
      },
      attachTo: document.body,
      global: {
        stubs: {
          TaskDescriptionRichEditor: defineComponent({
            name: 'TaskDescriptionRichEditor',
            template: '<div data-testid="task-description-editor-content"><div class="ProseMirror">Old text</div></div>',
          }),
        },
      },
    })
    await flushPromises()

    expect(wrapper.get('[data-testid="task-description-tab-markdown"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="task-description-markdown-input"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="task-description-attachment-note"]').text()).toContain('collaborators are active')
  })

  it('syncs markdown-tab edits through the real rich editor into the Yjs collab doc', async () => {
    const collabDoc = new Y.Doc()
    const collabFragment = collabDoc.getXmlFragment('task_description')

    const wrapper = mount(TaskDescriptionEditor, {
      props: {
        modelValue: '**Old** text',
        defaultTab: 'rendered',
        collabDoc,
      },
      attachTo: document.body,
      global: {
        stubs: {
          TaskDescriptionRichEditor,
        },
      },
    })
    await waitForRenderedEditor(wrapper)
    await waitForRenderedEditorText(wrapper, 'Old')

    const initialCollabText = String(collabFragment)
    let updateCount = 0
    collabDoc.on('update', () => {
      updateCount += 1
    })

    await wrapper.get('[data-testid="task-description-tab-markdown"]').trigger('click')
    await flushPromises()

    await wrapper.get('[data-testid="task-description-markdown-input"]').setValue('## Edited\n\nBody')
    await flushPromises()

    updateCount = 0
    await wrapper.get('[data-testid="task-description-tab-rendered"]').trigger('click')
    await flushPromises()

    await waitForRenderedEditorText(wrapper, 'Edited')
    await waitForRenderedEditorText(wrapper, 'Body')

    expect(updateCount).toBeGreaterThan(0)
    expect(String(collabFragment)).toContain('Edited')
    expect(String(collabFragment)).toContain('Body')
    expect(String(collabFragment)).not.toBe(initialCollabText)
  })
})
