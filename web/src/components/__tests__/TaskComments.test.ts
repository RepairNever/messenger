import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref, shallowRef } from 'vue'
import TaskComments from '@/components/tasks/TaskComments.vue'
import RichTextComposer from '@/components/RichTextComposer.vue'
import router from '@/router'
import { useAuthStore } from '@/stores/auth'
import { usePinnedDialogsStore } from '@/stores/pinnedDialogs'
import {
  tasksCreateComment,
  tasksEnsureCommentThread,
  tasksFetchCommentAttachmentBlob,
  tasksListComments,
  tasksUpdateComment,
  tasksUploadCommentAttachment,
} from '@/services/http/tasksApi'

vi.mock('@/composables/useComposerEmojiPicker', () => ({
  useComposerEmojiPicker: ({ onSelect }: { onSelect: (emoji: string) => void }) => {
    const showEmojiPicker = ref(false)
    return {
      showEmojiPicker,
      pickerRoot: ref(null),
      pickerToggleButton: ref(null),
      pickerComponent: shallowRef({
        template: '<button data-testid="emoji-picker-option" @click="$emit(\'select\', { native: \'🙂\' })">emoji</button>',
      }),
      emojiIndex: shallowRef({}),
      emojiPickerStyle: ref({}),
      toggleEmojiPicker: () => { showEmojiPicker.value = !showEmojiPicker.value },
      closeEmojiPicker: () => { showEmojiPicker.value = false },
      onSelectEmoji: (emoji: { native?: string; colons?: string; id?: string }) => {
        const value = emoji.native ?? emoji.colons ?? emoji.id
        if (!value) return
        onSelect(value)
        showEmojiPicker.value = false
      },
    }
  },
}))

vi.mock('@/services/http/tasksApi', () => ({
  tasksListComments: vi.fn(),
  tasksCreateComment: vi.fn(),
  tasksEnsureCommentThread: vi.fn(),
  tasksUpdateComment: vi.fn(),
  tasksUploadCommentAttachment: vi.fn(),
  tasksDeleteCommentAttachment: vi.fn(),
  tasksFetchCommentAttachmentBlob: vi.fn(),
}))

describe('TaskComments', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()

    vi.mocked(tasksListComments).mockResolvedValue([])
    ;(router.currentRoute as any).value = { query: {} }
    vi.mocked(tasksFetchCommentAttachmentBlob).mockResolvedValue(new Blob(['preview']))
    vi.mocked(tasksCreateComment).mockResolvedValue({
      id: 'comment-1',
      task_id: 'task-1',
      author_id: 'user-1',
      body: '',
      created_at: '2026-03-10T12:00:00Z',
      updated_at: '2026-03-10T12:00:00Z',
      attachments: [],
    })
    vi.mocked(tasksEnsureCommentThread).mockResolvedValue({
      conversation_id: 'task-channel-1',
      thread_root_message_id: 'root-message-1',
      reply_count: 2,
    })
    vi.mocked(tasksUpdateComment).mockResolvedValue({
      id: 'comment-1',
      task_id: 'task-1',
      author_id: 'user-1',
      body: 'updated',
      created_at: '2026-03-10T12:00:00Z',
      updated_at: '2026-03-10T12:10:00Z',
      attachments: [],
    })

    ;(globalThis.URL as any).createObjectURL = vi.fn(() => 'blob:mock')
    ;(globalThis.URL as any).revokeObjectURL = vi.fn()
    window.open = vi.fn(() => ({
      opener: null,
      focus: vi.fn(),
    } as unknown as Window))

    const auth = useAuthStore()
    auth.user = { id: 'user-1', email: 'user@example.com', displayName: 'User 1', role: 'member' }
  })

  function mainComposer(wrapper: ReturnType<typeof mount>) {
    return wrapper.getComponent(RichTextComposer)
  }

  function mainEditor(wrapper: ReturnType<typeof mount>) {
    return (mainComposer(wrapper).vm as unknown as { getEditor: () => any }).getEditor()
  }

  async function waitForComposer(wrapper: ReturnType<typeof mount>, testId = 'task-comment-composer') {
    for (let index = 0; index < 10; index += 1) {
      await flushPromises()
      if (wrapper.find(`[data-testid="${testId}"] .ProseMirror`).exists()) return
    }
    throw new Error(`composer did not mount: ${testId}`)
  }

  function mainProse(wrapper: ReturnType<typeof mount>) {
    return wrapper.get('[data-testid="task-comment-composer"] .ProseMirror')
  }

  function editComposer(wrapper: ReturnType<typeof mount>) {
    return wrapper.findAllComponents(RichTextComposer)[1]
  }

  async function insertMainText(wrapper: ReturnType<typeof mount>, value: string) {
    ;(mainComposer(wrapper).vm as unknown as { insertText: (text: string) => void }).insertText(value)
    await flushPromises()
  }

  async function typeMainText(wrapper: ReturnType<typeof mount>, value: string) {
    const editor = mainEditor(wrapper)
    const view = editor.view

    for (const char of value) {
      const from = view.state.selection.from
      const to = view.state.selection.to
      let handled = false
      view.someProp('handleTextInput', (handler: (view: any, from: number, to: number, text: string) => boolean) => {
        handled = handler(view, from, to, char)
        return handled
      })
      if (!handled) {
        view.dispatch(view.state.tr.insertText(char, from, to))
      }
    }

    await flushPromises()
  }

  async function insertMainHardBreak(wrapper: ReturnType<typeof mount>) {
    await mainProse(wrapper).trigger('keydown', { key: 'Enter', shiftKey: true })
    await flushPromises()
  }

  async function insertEditText(wrapper: ReturnType<typeof mount>, value: string) {
    ;(editComposer(wrapper).vm as unknown as { setValue: (text: string) => void }).setValue(value)
    await flushPromises()
  }

  it('uploads dropped files onto the comment textarea', async () => {
    vi.mocked(tasksUploadCommentAttachment).mockResolvedValue({
      id: 'att-1',
      task_id: 'task-1',
      file_name: 'notes.txt',
      file_size: 5,
      mime_type: 'text/plain',
      uploaded_by: 'user-1',
      created_at: '2026-03-10T12:00:00Z',
    })

    const wrapper = mount(TaskComments, {
      props: { taskId: 'task-1' },
    })
    await waitForComposer(wrapper)

    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    await (mainComposer(wrapper).vm as unknown as { receiveFiles: (files: File[]) => Promise<void> }).receiveFiles([file])
    await flushPromises()

    expect(tasksUploadCommentAttachment).toHaveBeenCalledWith('task-1', file)
    expect(wrapper.text()).toContain('notes.txt')
  })

  it('uploads pasted clipboard files onto the comment textarea', async () => {
    vi.mocked(tasksUploadCommentAttachment).mockResolvedValue({
      id: 'att-paste-1',
      task_id: 'task-1',
      file_name: 'clipboard.png',
      file_size: 7,
      mime_type: 'image/png',
      uploaded_by: 'user-1',
      created_at: '2026-03-10T12:00:00Z',
    })

    const wrapper = mount(TaskComments, {
      props: { taskId: 'task-1' },
    })
    await waitForComposer(wrapper)

    const file = new File(['clip'], 'clipboard.png', { type: 'image/png' })
    await (mainComposer(wrapper).vm as unknown as { receiveFiles: (files: File[]) => Promise<void> }).receiveFiles([file])
    await flushPromises()

    expect(tasksUploadCommentAttachment).toHaveBeenCalledTimes(1)
    expect(tasksUploadCommentAttachment).toHaveBeenCalledWith('task-1', file)
    expect(wrapper.text()).toContain('clipboard.png')
  })

  it('renders comment controls row below textarea', async () => {
    const wrapper = mount(TaskComments, {
      props: { taskId: 'task-1' },
    })
    await waitForComposer(wrapper)

    const editor = mainProse(wrapper)
    const controls = wrapper.get('[data-testid="task-comment-controls-row"]')
    const position = editor.element.compareDocumentPosition(controls.element)
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('renders the composer before the comments list', async () => {
    vi.mocked(tasksListComments).mockResolvedValue([{
      id: 'comment-1',
      task_id: 'task-1',
      author_id: 'user-1',
      body: 'hello',
      created_at: '2026-03-10T12:00:00Z',
      updated_at: '2026-03-10T12:00:00Z',
      attachments: [],
    }])

    const wrapper = mount(TaskComments, {
      props: { taskId: 'task-1' },
    })
    await waitForComposer(wrapper)

    const editor = mainProse(wrapper)
    const commentsList = wrapper.get('ul.mb-4')
    const position = editor.element.compareDocumentPosition(commentsList.element)
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('highlights and scrolls the comment named in the route query', async () => {
    const scrollSpy = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      value: scrollSpy,
      configurable: true,
      writable: true,
    })
    ;(router.currentRoute as any).value = { query: { comment: 'comment-2' } }
    vi.mocked(tasksListComments).mockResolvedValue([
      {
        id: 'comment-1',
        task_id: 'task-1',
        author_id: 'user-1',
        body: 'first',
        created_at: '2026-03-10T12:00:00Z',
        updated_at: '2026-03-10T12:00:00Z',
        attachments: [],
      },
      {
        id: 'comment-2',
        task_id: 'task-1',
        author_id: 'user-1',
        body: 'searched',
        created_at: '2026-03-10T12:01:00Z',
        updated_at: '2026-03-10T12:01:00Z',
        attachments: [],
      },
    ])

    const wrapper = mount(TaskComments, {
      props: { taskId: 'task-1' },
    })
    await waitForComposer(wrapper)
    await flushPromises()

    const target = wrapper.get('[data-task-comment-id="comment-2"]')
    expect(target.classes()).toContain('bg-amber-500/10')
    expect(scrollSpy).toHaveBeenCalledWith({ block: 'center' })
  })

  it('inserts selected emoji at cursor into comment textarea', async () => {
    const wrapper = mount(TaskComments, {
      props: { taskId: 'task-1' },
      attachTo: document.body,
    })
    await waitForComposer(wrapper)

    await insertMainText(wrapper, 'world')

    await wrapper.get('[data-testid="task-comment-emoji-button"]').trigger('click')
    await flushPromises()

    const emojiOption = document.body.querySelector('[data-testid="emoji-picker-option"]') as HTMLButtonElement | null
    expect(emojiOption).toBeTruthy()
    emojiOption?.click()
    await flushPromises()

    expect(mainComposer(wrapper).props('modelValue')).toContain('🙂')
    expect(document.body.querySelector('[data-testid="emoji-picker-option"]')).toBeNull()
  })

  it('shows edit action only for author-owned comments', async () => {
    vi.mocked(tasksListComments).mockResolvedValue([
      {
        id: 'comment-own',
        task_id: 'task-1',
        author_id: 'user-1',
        body: 'mine',
        created_at: '2026-03-10T12:00:00Z',
        updated_at: '2026-03-10T12:00:00Z',
        attachments: [],
      },
      {
        id: 'comment-other',
        task_id: 'task-1',
        author_id: 'user-2',
        body: 'theirs',
        created_at: '2026-03-10T12:01:00Z',
        updated_at: '2026-03-10T12:01:00Z',
        attachments: [],
      },
    ])

    const wrapper = mount(TaskComments, {
      props: { taskId: 'task-1' },
    })
    await waitForComposer(wrapper)

    expect(wrapper.findAll('[data-testid="task-comment-edit-button"]')).toHaveLength(1)
    expect(wrapper.text()).toContain('mine')
    expect(wrapper.text()).toContain('theirs')
  })

  it('enters inline edit mode with the current body and attachments', async () => {
    vi.mocked(tasksListComments).mockResolvedValue([{
      id: 'comment-edit',
      task_id: 'task-1',
      author_id: 'user-1',
      body: 'edit me',
      created_at: '2026-03-10T12:00:00Z',
      updated_at: '2026-03-10T12:00:00Z',
      attachments: [{
        id: 'att-existing',
        task_id: 'task-1',
        comment_id: 'comment-edit',
        file_name: 'existing.txt',
        file_size: 11,
        mime_type: 'text/plain',
        uploaded_by: 'user-1',
        created_at: '2026-03-10T12:00:00Z',
      }],
    }])

    const wrapper = mount(TaskComments, {
      props: { taskId: 'task-1' },
    })
    await waitForComposer(wrapper)

    await wrapper.get('[data-testid="task-comment-edit-button"]').trigger('click')
    await waitForComposer(wrapper, 'task-comment-edit-textarea')

    expect(editComposer(wrapper).props('modelValue')).toBe('edit me')
    expect(wrapper.text()).toContain('existing.txt')
  })

  it('saves an edited comment in place and shows edited marker', async () => {
    vi.mocked(tasksListComments).mockResolvedValue([{
      id: 'comment-edit',
      task_id: 'task-1',
      author_id: 'user-1',
      body: 'before',
      created_at: '2026-03-10T12:00:00Z',
      updated_at: '2026-03-10T12:00:00Z',
      attachments: [],
    }])
    vi.mocked(tasksUpdateComment).mockResolvedValue({
      id: 'comment-edit',
      task_id: 'task-1',
      author_id: 'user-1',
      body: 'after',
      created_at: '2026-03-10T12:00:00Z',
      updated_at: '2026-03-10T12:10:00Z',
      attachments: [],
    })

    const wrapper = mount(TaskComments, {
      props: { taskId: 'task-1' },
    })
    await waitForComposer(wrapper)

    await wrapper.get('[data-testid="task-comment-edit-button"]').trigger('click')
    await waitForComposer(wrapper, 'task-comment-edit-textarea')
    await insertEditText(wrapper, 'after')
    await wrapper.get('[data-testid="task-comment-edit-save"]').trigger('click')
    await flushPromises()

    expect(tasksUpdateComment).toHaveBeenCalledWith('task-1', 'comment-edit', {
      body: 'after',
      attachment_ids: [],
    })
    expect(wrapper.text()).toContain('after')
    expect(wrapper.find('[data-testid="task-comment-edited-marker"]').exists()).toBe(true)
  })

  it('cancels inline edit without mutating the rendered comment', async () => {
    vi.mocked(tasksListComments).mockResolvedValue([{
      id: 'comment-edit',
      task_id: 'task-1',
      author_id: 'user-1',
      body: 'before',
      created_at: '2026-03-10T12:00:00Z',
      updated_at: '2026-03-10T12:00:00Z',
      attachments: [],
    }])

    const wrapper = mount(TaskComments, {
      props: { taskId: 'task-1' },
    })
    await waitForComposer(wrapper)

    await wrapper.get('[data-testid="task-comment-edit-button"]').trigger('click')
    await waitForComposer(wrapper, 'task-comment-edit-textarea')
    await insertEditText(wrapper, 'after')
    await wrapper.get('[data-testid="task-comment-edit-cancel"]').trigger('click')
    await flushPromises()

    expect(tasksUpdateComment).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="task-comment-edit-textarea"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('before')
  })

  it('replaces attachments while editing and submits the full attachment set', async () => {
    vi.mocked(tasksListComments).mockResolvedValue([{
      id: 'comment-edit',
      task_id: 'task-1',
      author_id: 'user-1',
      body: 'before',
      created_at: '2026-03-10T12:00:00Z',
      updated_at: '2026-03-10T12:00:00Z',
      attachments: [{
        id: 'att-existing',
        task_id: 'task-1',
        comment_id: 'comment-edit',
        file_name: 'existing.txt',
        file_size: 11,
        mime_type: 'text/plain',
        uploaded_by: 'user-1',
        created_at: '2026-03-10T12:00:00Z',
      }],
    }])
    vi.mocked(tasksUploadCommentAttachment).mockResolvedValue({
      id: 'att-new',
      task_id: 'task-1',
      file_name: 'new.txt',
      file_size: 9,
      mime_type: 'text/plain',
      uploaded_by: 'user-1',
      created_at: '2026-03-10T12:05:00Z',
    })
    vi.mocked(tasksUpdateComment).mockResolvedValue({
      id: 'comment-edit',
      task_id: 'task-1',
      author_id: 'user-1',
      body: 'after',
      created_at: '2026-03-10T12:00:00Z',
      updated_at: '2026-03-10T12:10:00Z',
      attachments: [{
        id: 'att-new',
        task_id: 'task-1',
        comment_id: 'comment-edit',
        file_name: 'new.txt',
        file_size: 9,
        mime_type: 'text/plain',
        uploaded_by: 'user-1',
        created_at: '2026-03-10T12:05:00Z',
      }],
    })

    const wrapper = mount(TaskComments, {
      props: { taskId: 'task-1' },
    })
    await waitForComposer(wrapper)

    await wrapper.get('[data-testid="task-comment-edit-button"]').trigger('click')
    await waitForComposer(wrapper, 'task-comment-edit-textarea')
    await wrapper.get('[title="Remove attachment"]').trigger('click')
    await flushPromises()

    const file = new File(['new'], 'new.txt', { type: 'text/plain' })
    await (editComposer(wrapper).vm as unknown as { receiveFiles: (files: File[]) => Promise<void> }).receiveFiles([file])
    await flushPromises()

    await insertEditText(wrapper, 'after')
    await wrapper.get('[data-testid="task-comment-edit-save"]').trigger('click')
    await flushPromises()

    expect(tasksUpdateComment).toHaveBeenCalledWith('task-1', 'comment-edit', {
      body: 'after',
      attachment_ids: ['att-new'],
    })
    expect(wrapper.text()).toContain('new.txt')
    expect(wrapper.text()).not.toContain('existing.txt')
  })

  it('submits attachment-only comment with attachment_ids payload', async () => {
    vi.mocked(tasksUploadCommentAttachment).mockResolvedValue({
      id: 'att-1',
      task_id: 'task-1',
      file_name: 'file.png',
      file_size: 9,
      mime_type: 'image/png',
      uploaded_by: 'user-1',
      created_at: '2026-03-10T12:00:00Z',
    })

    vi.mocked(tasksCreateComment).mockResolvedValue({
      id: 'comment-2',
      task_id: 'task-1',
      author_id: 'user-1',
      body: '',
      created_at: '2026-03-10T12:01:00Z',
      updated_at: '2026-03-10T12:01:00Z',
      attachments: [{
        id: 'att-1',
        task_id: 'task-1',
        comment_id: 'comment-2',
        file_name: 'file.png',
        file_size: 9,
        mime_type: 'image/png',
        uploaded_by: 'user-1',
        created_at: '2026-03-10T12:00:00Z',
      }],
    })

    const wrapper = mount(TaskComments, {
      props: { taskId: 'task-1' },
    })
    await waitForComposer(wrapper)

    const file = new File(['img-data'], 'file.png', { type: 'image/png' })
    await (mainComposer(wrapper).vm as unknown as { receiveFiles: (files: File[]) => Promise<void> }).receiveFiles([file])
    await flushPromises()

    await wrapper.get('[data-testid="task-comment-send-button"]').trigger('click')
    await flushPromises()

    expect(tasksCreateComment).toHaveBeenCalledWith('task-1', {
      body: '',
      attachment_ids: ['att-1'],
    })
  })

  it('renders rich attachment branches for image/video/audio and generic file', async () => {
    vi.mocked(tasksListComments).mockResolvedValue([{
      id: 'comment-rich',
      task_id: 'task-1',
      author_id: 'user-1',
      body: 'check files',
      created_at: '2026-03-10T12:00:00Z',
      updated_at: '2026-03-10T12:00:00Z',
      attachments: [
        {
          id: 'img-1',
          task_id: 'task-1',
          comment_id: 'comment-rich',
          file_name: 'photo.jpg',
          file_size: 10,
          mime_type: 'image/jpeg',
          uploaded_by: 'user-1',
          created_at: '2026-03-10T12:00:00Z',
        },
        {
          id: 'vid-1',
          task_id: 'task-1',
          comment_id: 'comment-rich',
          file_name: 'clip.mp4',
          file_size: 20,
          mime_type: 'video/mp4',
          uploaded_by: 'user-1',
          created_at: '2026-03-10T12:00:00Z',
        },
        {
          id: 'aud-1',
          task_id: 'task-1',
          comment_id: 'comment-rich',
          file_name: 'voice.ogg',
          file_size: 30,
          mime_type: 'audio/ogg',
          uploaded_by: 'user-1',
          created_at: '2026-03-10T12:00:00Z',
        },
        {
          id: 'doc-1',
          task_id: 'task-1',
          comment_id: 'comment-rich',
          file_name: 'notes.pdf',
          file_size: 1024,
          mime_type: 'application/pdf',
          uploaded_by: 'user-1',
          created_at: '2026-03-10T12:00:00Z',
        },
      ],
    }])

    const wrapper = mount(TaskComments, {
      props: { taskId: 'task-1' },
    })
    await waitForComposer(wrapper)

    expect(wrapper.find('img').exists()).toBe(true)
    expect(wrapper.find('video').exists()).toBe(true)
    expect(wrapper.find('audio').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('photo.jpg')
    expect(wrapper.text()).toContain('1.0 KB')
  })

  it('renders newest comments first', async () => {
    vi.mocked(tasksListComments).mockResolvedValue([
      {
        id: 'comment-old',
        task_id: 'task-1',
        author_id: 'user-1',
        body: 'older comment',
        created_at: '2026-03-10T12:00:00Z',
        updated_at: '2026-03-10T12:00:00Z',
        attachments: [],
      },
      {
        id: 'comment-new',
        task_id: 'task-1',
        author_id: 'user-1',
        body: 'newer comment',
        created_at: '2026-03-10T12:05:00Z',
        updated_at: '2026-03-10T12:05:00Z',
        attachments: [],
      },
    ])

    const wrapper = mount(TaskComments, {
      props: { taskId: 'task-1' },
    })
    await flushPromises()

    const bodies = wrapper.findAll('ul.mb-4 .markdown-body')
    expect(bodies).toHaveLength(2)
    expect(bodies[0].text()).toContain('newer comment')
    expect(bodies[1].text()).toContain('older comment')
  })

  it('uses compact image thumbnail contract and restrained lightbox for comment images', async () => {
    vi.mocked(tasksListComments).mockResolvedValue([{
      id: 'comment-image',
      task_id: 'task-1',
      author_id: 'user-1',
      body: 'image',
      created_at: '2026-03-10T12:00:00Z',
      updated_at: '2026-03-10T12:00:00Z',
      attachments: [{
        id: 'img-1',
        task_id: 'task-1',
        comment_id: 'comment-image',
        file_name: 'photo.jpg',
        file_size: 10,
        mime_type: 'image/jpeg',
        uploaded_by: 'user-1',
        created_at: '2026-03-10T12:00:00Z',
      }],
    }])

    const wrapper = mount(TaskComments, {
      props: { taskId: 'task-1' },
      attachTo: document.body,
    })
    await waitForComposer(wrapper)

    const thumbButton = wrapper.get('[data-testid="task-comment-image-thumbnail"]')
    expect(thumbButton.classes()).toContain('max-w-[180px]')
    expect(thumbButton.classes()).toContain('sm:max-w-[280px]')
    expect(thumbButton.classes()).toContain('cursor-pointer')
    expect(wrapper.text()).not.toContain('photo.jpg')

    const thumbImage = wrapper.get('[data-testid="task-comment-image-thumbnail-img"]')
    expect(thumbImage.classes()).toContain('max-h-[180px]')
    expect(thumbImage.classes()).toContain('sm:max-h-[220px]')
    expect(thumbImage.classes()).toContain('object-contain')
    expect(thumbImage.classes()).not.toContain('object-cover')

    await thumbButton.trigger('click')
    await flushPromises()

    const lightboxImage = document.body.querySelector('[data-testid="task-comment-image-lightbox-img"]')
    expect(lightboxImage).toBeTruthy()
    expect(lightboxImage?.classList.contains('max-h-[60vh]')).toBe(true)
    expect(lightboxImage?.classList.contains('sm:max-h-[70vh]')).toBe(true)
    expect(lightboxImage?.classList.contains('max-w-[86vw]')).toBe(true)
    expect(lightboxImage?.classList.contains('sm:max-w-[74vw]')).toBe(true)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(document.body.querySelector('[data-testid="task-comment-image-lightbox"]')).toBeNull()

    await thumbButton.trigger('click')
    await flushPromises()
    expect(document.body.querySelector('[data-testid="task-comment-image-lightbox"]')).toBeTruthy()

    const closeButton = document.body.querySelector('[data-testid="task-comment-image-lightbox-close"]') as HTMLButtonElement
    expect(closeButton).toBeTruthy()
    closeButton.click()
    await flushPromises()
    expect(document.body.querySelector('[data-testid="task-comment-image-lightbox"]')).toBeNull()

    wrapper.unmount()
  })

  it('keeps the composer shell stable when dragleave fires without dataTransfer types', async () => {
    const wrapper = mount(TaskComments, {
      props: { taskId: 'task-1' },
    })
    await waitForComposer(wrapper)

    const dropZone = wrapper.get('[data-testid="task-comment-composer"]').element.parentElement?.parentElement as HTMLElement
    await mainProse(wrapper).trigger('dragleave')
    expect(dropZone.className).toContain('border-chat-border')
  })

  it('auto-grows comment editor and caps at 8 lines', async () => {
    const wrapper = mount(TaskComments, {
      props: { taskId: 'task-1' },
    })
    await waitForComposer(wrapper)

    const editor = mainProse(wrapper).element as HTMLDivElement
    Object.defineProperty(editor, 'scrollHeight', {
      configurable: true,
      get: () => 420,
    })

    await insertMainText(wrapper, 'line')
    await flushPromises()

    expect(Number.parseInt(editor.style.maxHeight, 10)).toBeGreaterThan(0)
    expect(editor.style.height).toBe(editor.style.maxHeight)
    expect(editor.style.overflowY).toBe('auto')
  })

  it('renders comment bodies as markdown html (marked path)', async () => {
    vi.mocked(tasksListComments).mockResolvedValue([{
      id: 'comment-markdown',
      task_id: 'task-1',
      author_id: 'user-1',
      body: '**bold** and [link](https://example.com)',
      created_at: '2026-03-10T12:00:00Z',
      updated_at: '2026-03-10T12:00:00Z',
      attachments: [],
    }])

    const wrapper = mount(TaskComments, {
      props: { taskId: 'task-1' },
    })
    await waitForComposer(wrapper)

    expect(wrapper.find('.markdown-body strong').exists()).toBe(true)
    const link = wrapper.find('.markdown-body a')
    expect(link.exists()).toBe(true)
    expect(link.attributes('href')).toBe('https://example.com')
  })

  it('renders fenced code blocks with syntax highlighting', async () => {
    vi.mocked(tasksListComments).mockResolvedValue([{
      id: 'comment-code',
      task_id: 'task-1',
      author_id: 'user-1',
      body: '```sql\nSELECT id FROM users\n```',
      created_at: '2026-03-10T12:00:00Z',
      updated_at: '2026-03-10T12:00:00Z',
      attachments: [],
    }])

    const wrapper = mount(TaskComments, {
      props: { taskId: 'task-1' },
    })
    await waitForComposer(wrapper)

    expect(wrapper.find('.markdown-body pre code.language-sql').exists()).toBe(true)
    expect(wrapper.html()).toContain('<span class="hljs-keyword">SELECT</span>')
  })

  it('opens a task comment chat thread and pins it', async () => {
    vi.mocked(tasksListComments).mockResolvedValue([{
      id: 'comment-thread',
      task_id: 'task-1',
      author_id: 'user-1',
      body: 'thread me',
      thread_reply_count: 1,
      created_at: '2026-03-10T12:00:00Z',
      updated_at: '2026-03-10T12:00:00Z',
      attachments: [],
    }])

    const wrapper = mount(TaskComments, {
      props: { taskId: 'task-1' },
    })
    await waitForComposer(wrapper)

    expect(wrapper.get('[data-testid="task-comment-thread-button"]').text()).toContain('Thread (1)')
    await wrapper.get('[data-testid="task-comment-thread-button"]').trigger('click')
    await flushPromises()

    expect(tasksEnsureCommentThread).toHaveBeenCalledWith('task-1', 'comment-thread')
    const pinned = usePinnedDialogsStore()
    expect(pinned.activeId).toBe('thread:task-channel-1:root-message-1')
    expect(pinned.items[0]).toMatchObject({
      kind: 'thread',
      conversationId: 'task-channel-1',
      threadRootMessageId: 'root-message-1',
    })
    expect(wrapper.get('[data-testid="task-comment-thread-button"]').text()).toContain('Thread (2)')
  })

  it('opens markdown links in the system browser when clicked', async () => {
    vi.mocked(tasksListComments).mockResolvedValue([{
      id: 'comment-markdown',
      task_id: 'task-1',
      author_id: 'user-1',
      body: '[link](https://example.com)',
      created_at: '2026-03-10T12:00:00Z',
      updated_at: '2026-03-10T12:00:00Z',
      attachments: [],
    }])

    const wrapper = mount(TaskComments, {
      props: { taskId: 'task-1' },
    })
    await waitForComposer(wrapper)

    await wrapper.get('.markdown-body a').trigger('click')
    await flushPromises()

    expect(window.open).toHaveBeenCalledWith('https://example.com/', '_blank')
  })

  it('supports visual-line bullet shortcuts below existing comment text', async () => {
    const wrapper = mount(TaskComments, {
      props: { taskId: 'task-1' },
    })
    await waitForComposer(wrapper)

    await insertMainText(wrapper, 'alpha')
    await insertMainHardBreak(wrapper)
    await typeMainText(wrapper, '- ')

    const content = mainEditor(wrapper).getJSON().content ?? []
    expect(content[0]?.type).toBe('paragraph')
    expect(content[1]?.type).toBe('bulletList')
  })
})
