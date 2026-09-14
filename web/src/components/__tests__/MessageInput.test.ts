import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, ref, shallowRef } from 'vue'
import MessageInput from '@/components/MessageInput.vue'
import RichTextComposer from '@/components/RichTextComposer.vue'
import { uploadChatAttachment } from '@/services/http/chatApi'
import { loadChatDraft, saveChatDraft, type ChatDraftScope } from '@/services/storage/chatDraftStorage'
import { storage } from '@/services/storage/storageAdapter'
import { ensureLocalStorageMock } from '@/__tests__/testUtils'

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

vi.mock('@/services/http/chatApi', () => ({
  uploadChatAttachment: vi.fn(),
  deleteChatAttachment: vi.fn(),
  listMessageReactionUsers: vi.fn(),
  listSavedMessages: vi.fn(),
  saveMessage: vi.fn(),
  unsaveMessage: vi.fn(),
}))

describe('MessageInput', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ensureLocalStorageMock()
    localStorage.clear()
    storage.clear()
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
  })

  async function flushAll() {
    await Promise.resolve()
    await nextTick()
  }

  async function waitForComposer(wrapper: ReturnType<typeof mount>) {
    for (let index = 0; index < 10; index += 1) {
      await flushAll()
      if (wrapper.find('.ProseMirror').exists()) return
    }
    throw new Error('composer did not mount')
  }

  function composer(wrapper: ReturnType<typeof mount>) {
    return wrapper.getComponent(RichTextComposer)
  }

  function composerEditor(wrapper: ReturnType<typeof mount>) {
    return (composer(wrapper).vm as unknown as { getEditor: () => any }).getEditor()
  }

  function prose(wrapper: ReturnType<typeof mount>) {
    return wrapper.get('.ProseMirror')
  }

  async function insertText(wrapper: ReturnType<typeof mount>, value: string) {
    ;(composer(wrapper).vm as unknown as { insertText: (text: string) => void }).insertText(value)
    await flushAll()
  }

  async function typeText(wrapper: ReturnType<typeof mount>, value: string) {
    const editor = composerEditor(wrapper)
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

    await flushAll()
  }

  async function insertHardBreak(wrapper: ReturnType<typeof mount>) {
    await prose(wrapper).trigger('keydown', { key: 'Enter', shiftKey: true })
    await flushAll()
  }

  async function pressArrowUp(wrapper: ReturnType<typeof mount>) {
    await prose(wrapper).trigger('keydown', { key: 'ArrowUp' })
    await flushAll()
  }

  const conversationDraftScope: ChatDraftScope = {
    kind: 'conversation',
    conversationId: 'channel-1',
  }

  const threadDraftScope: ChatDraftScope = {
    kind: 'thread',
    conversationId: 'channel-1',
    rootMessageId: 'root-1',
  }

  it('does not emit typing=false on blur', async () => {
    const wrapper = mount(MessageInput, {
      props: {
        channelName: 'general',
        disabled: false,
      },
    })
    await waitForComposer(wrapper)

    await insertText(wrapper, 'hello')
    await prose(wrapper).trigger('blur')

    const typingEvents = wrapper.emitted('typing') ?? []
    expect(typingEvents).toEqual([[true]])
  })

  it('renders composer controls row below textarea', async () => {
    const wrapper = mount(MessageInput, {
      props: {
        channelName: 'general',
        disabled: false,
      },
    })
    await waitForComposer(wrapper)

    const editor = prose(wrapper)
    const controls = wrapper.get('[data-testid="composer-controls-row"]')
    const position = editor.element.compareDocumentPosition(controls.element)
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('updates the composer placeholder when the conversation name changes', async () => {
    const wrapper = mount(MessageInput, {
      props: {
        channelName: 'general',
        disabled: false,
      },
    })
    await waitForComposer(wrapper)
    await flushAll()

    expect((prose(wrapper).element as HTMLElement).dataset.placeholder).toBe('Message #general')

    await wrapper.setProps({ channelName: 'random' })
    await flushAll()

    expect((prose(wrapper).element as HTMLElement).dataset.placeholder).toBe('Message #random')
  })

  it('inserts selected emoji at cursor and closes picker', async () => {
    const wrapper = mount(MessageInput, {
      attachTo: document.body,
      props: {
        channelName: 'general',
        disabled: false,
      },
    })
    await waitForComposer(wrapper)

    await insertText(wrapper, 'hello')

    await wrapper.get('[data-testid="composer-emoji-button"]').trigger('click')
    await flushAll()

    const emojiOption = document.body.querySelector('[data-testid="emoji-picker-option"]') as HTMLButtonElement | null
    expect(emojiOption).toBeTruthy()
    emojiOption?.click()
    await flushAll()

    expect(composer(wrapper).props('modelValue')).toContain('🙂')
    expect(document.body.querySelector('[data-testid="emoji-picker-option"]')).toBeNull()
  })

  it('disables emoji button when composer is disabled', async () => {
    const wrapper = mount(MessageInput, {
      props: {
        channelName: 'general',
        disabled: true,
      },
    })
    await waitForComposer(wrapper)

    expect(wrapper.get('[data-testid="composer-emoji-button"]').attributes('disabled')).toBeDefined()
  })

  it('uploads dropped files from textarea as attachments', async () => {
    vi.mocked(uploadChatAttachment).mockResolvedValue({
      id: 'att-1',
      file_name: 'photo.png',
      file_size: 4,
      mime_type: 'image/png',
    })

    const wrapper = mount(MessageInput, {
      props: {
        channelName: 'general',
        conversationId: 'channel-1',
        disabled: false,
      },
    })
    await waitForComposer(wrapper)

    const file = new File(['test'], 'photo.png', { type: 'image/png' })
    await (composer(wrapper).vm as unknown as { receiveFiles: (files: File[]) => Promise<void> }).receiveFiles([file])
    await flushAll()

    expect(uploadChatAttachment).toHaveBeenCalledWith('channel-1', file, expect.any(Function))
    expect(wrapper.text()).toContain('photo.png')
  })

  it('disables plaintext-only composer features in encrypted DMs', async () => {
    const wrapper = mount(MessageInput, {
      props: {
        channelName: 'Encrypted DM',
        conversationId: 'dm-e2ee-1',
        draftScope: conversationDraftScope,
        encrypted: true,
        disabled: false,
      },
    })
    await waitForComposer(wrapper)

    expect(composer(wrapper).props('enableMessageEntities')).toBe(false)
    expect(composer(wrapper).props('onFiles')).toBeNull()
    expect(wrapper.get('[data-testid="composer-attach-button"]').attributes('disabled')).toBeDefined()

    await typeText(wrapper, 'secret body')
    const file = new File(['test'], 'secret.txt', { type: 'text/plain' })
    await (composer(wrapper).vm as unknown as { receiveFiles: (files: File[]) => Promise<void> }).receiveFiles([file])
    await flushAll()

    expect(uploadChatAttachment).not.toHaveBeenCalled()
    expect(localStorage.getItem('msgnr:chat:drafts:v1')).toBeNull()

    await wrapper.get('[data-testid="composer-send-button"]').trigger('click')

    expect(wrapper.emitted('send')).toEqual([[
      {
        body: 'secret body',
        entities: [],
        attachmentIds: [],
        attachments: [],
      },
    ]])
  })

  it('holds send while a pasted task URL is resolving', async () => {
    const wrapper = mount(MessageInput, {
      props: {
        channelName: 'general',
        conversationId: 'channel-1',
        disabled: false,
      },
    })
    await waitForComposer(wrapper)
    await insertText(wrapper, 'ready to send')

    const sendButton = wrapper.get('[data-testid="composer-send-button"]')
    expect(sendButton.attributes('disabled')).toBeUndefined()

    ;(composer(wrapper).vm as unknown as { $emit: (event: string, value: boolean) => void })
      .$emit('pending-task-url-paste-change', true)
    await flushAll()

    expect(sendButton.attributes('disabled')).toBeDefined()
    await sendButton.trigger('click')
    expect(wrapper.emitted('send')).toBeFalsy()

    ;(composer(wrapper).vm as unknown as { $emit: (event: string, value: boolean) => void })
      .$emit('pending-task-url-paste-change', false)
    await flushAll()

    expect(sendButton.attributes('disabled')).toBeUndefined()
    await sendButton.trigger('click')
    expect(wrapper.emitted('send')?.[0]?.[0]).toMatchObject({ body: 'ready to send' })
  })

  it('does not upload dropped files when conversation is not selected', async () => {
    const wrapper = mount(MessageInput, {
      props: {
        channelName: 'general',
        disabled: false,
      },
    })
    await waitForComposer(wrapper)

    const file = new File(['x'], 'notes.txt', { type: 'text/plain' })
    await (composer(wrapper).vm as unknown as { receiveFiles: (files: File[]) => Promise<void> }).receiveFiles([file])
    await flushAll()

    expect(uploadChatAttachment).not.toHaveBeenCalled()
  })

  it('uploads pasted clipboard file attachments', async () => {
    vi.mocked(uploadChatAttachment).mockResolvedValue({
      id: 'att-clip-1',
      file_name: 'clipboard-image.png',
      file_size: 10,
      mime_type: 'image/png',
    })

    const wrapper = mount(MessageInput, {
      props: {
        channelName: 'general',
        conversationId: 'channel-1',
        disabled: false,
      },
    })
    await waitForComposer(wrapper)

    const file = new File(['img'], 'clipboard-image.png', { type: 'image/png' })
    await (composer(wrapper).vm as unknown as { receiveFiles: (files: File[]) => Promise<void> }).receiveFiles([file])
    await flushAll()

    expect(uploadChatAttachment).toHaveBeenCalledTimes(1)
    expect(uploadChatAttachment).toHaveBeenCalledWith('channel-1', file, expect.any(Function))
    expect(wrapper.text()).toContain('clipboard-image.png')
  })

  it('shows upload progress while attachment upload is in flight', async () => {
    let finishUpload: () => void = () => {
      throw new Error('finishUpload callback was not set')
    }
    vi.mocked(uploadChatAttachment).mockImplementation((_conversationId, _file, onProgress) => (
      new Promise(resolve => {
        onProgress?.(50, 100)
        finishUpload = () => resolve({
          id: 'att-2',
          file_name: 'big.png',
          file_size: 100,
          mime_type: 'image/png',
        })
      })
    ))

    const wrapper = mount(MessageInput, {
      props: {
        channelName: 'general',
        conversationId: 'channel-1',
        disabled: false,
      },
    })
    await waitForComposer(wrapper)

    const file = new File(['test'], 'big.png', { type: 'image/png' })
    const dropPromise = (composer(wrapper).vm as unknown as { receiveFiles: (files: File[]) => Promise<void> }).receiveFiles([file])
    await flushAll()

    expect(wrapper.text()).toContain('Uploading big.png...')
    expect(wrapper.text()).toMatch(/\d{1,3}%/)

    finishUpload()
    await dropPromise
    await flushAll()

    expect(wrapper.text()).not.toContain('Uploading big.png...')
  })

  it('auto-grows textarea and caps at 8 lines', async () => {
    const wrapper = mount(MessageInput, {
      props: {
        channelName: 'general',
        disabled: false,
      },
    })
    await waitForComposer(wrapper)

    const editor = prose(wrapper).element as HTMLDivElement
    Object.defineProperty(editor, 'scrollHeight', {
      configurable: true,
      get: () => 400,
    })

    await insertText(wrapper, 'line')

    expect(Number.parseInt(editor.style.maxHeight, 10)).toBeGreaterThan(0)
    expect(editor.style.height).toBe(editor.style.maxHeight)
    expect(editor.style.overflowY).toBe('auto')
  })

  it('focuses the textarea when focusToken changes', async () => {
    const wrapper = mount(MessageInput, {
      attachTo: document.body,
      props: {
        channelName: 'general',
        disabled: false,
        focusToken: 0,
      },
    })
    await waitForComposer(wrapper)

    const editor = prose(wrapper).element as HTMLDivElement
    expect(document.activeElement).not.toBe(editor)

    await wrapper.setProps({ focusToken: 1 })
    await flushAll()

    expect(document.activeElement === editor || editor.contains(document.activeElement)).toBe(true)
  })

  it('emits edit-last-message when ArrowUp is pressed in an empty composer', async () => {
    const wrapper = mount(MessageInput, {
      props: {
        channelName: 'general',
        disabled: false,
      },
    })
    await waitForComposer(wrapper)

    await pressArrowUp(wrapper)

    expect(wrapper.emitted('edit-last-message')).toHaveLength(1)
  })

  it('does not emit edit-last-message when composer has text', async () => {
    const wrapper = mount(MessageInput, {
      props: {
        channelName: 'general',
        disabled: false,
      },
    })
    await waitForComposer(wrapper)

    await insertText(wrapper, 'draft')
    await pressArrowUp(wrapper)

    expect(wrapper.emitted('edit-last-message')).toBeUndefined()
  })

  it('does not emit edit-last-message when disabled', async () => {
    const wrapper = mount(MessageInput, {
      props: {
        channelName: 'general',
        disabled: true,
      },
    })
    await waitForComposer(wrapper)

    await pressArrowUp(wrapper)

    expect(wrapper.emitted('edit-last-message')).toBeUndefined()
  })

  it('does not emit edit-last-message with staged attachments', async () => {
    vi.mocked(uploadChatAttachment).mockResolvedValue({
      id: 'att-1',
      file_name: 'photo.png',
      file_size: 4,
      mime_type: 'image/png',
    })

    const wrapper = mount(MessageInput, {
      props: {
        channelName: 'general',
        conversationId: 'channel-1',
        disabled: false,
      },
    })
    await waitForComposer(wrapper)

    const file = new File(['test'], 'photo.png', { type: 'image/png' })
    await (composer(wrapper).vm as unknown as { receiveFiles: (files: File[]) => Promise<void> }).receiveFiles([file])
    await flushAll()
    await pressArrowUp(wrapper)

    expect(wrapper.emitted('edit-last-message')).toBeUndefined()
  })

  it('does not emit edit-last-message while uploading attachments', async () => {
    vi.mocked(uploadChatAttachment).mockImplementation(() => new Promise(() => {}))

    const wrapper = mount(MessageInput, {
      props: {
        channelName: 'general',
        conversationId: 'channel-1',
        disabled: false,
      },
    })
    await waitForComposer(wrapper)

    const file = new File(['test'], 'photo.png', { type: 'image/png' })
    void (composer(wrapper).vm as unknown as { receiveFiles: (files: File[]) => Promise<void> }).receiveFiles([file])
    await flushAll()
    await pressArrowUp(wrapper)

    expect(wrapper.emitted('edit-last-message')).toBeUndefined()
  })

  it('supports visual-line code fence shortcuts below existing message text', async () => {
    const wrapper = mount(MessageInput, {
      props: {
        channelName: 'general',
        disabled: false,
      },
    })
    await waitForComposer(wrapper)

    await insertText(wrapper, 'alpha')
    await insertHardBreak(wrapper)
    await typeText(wrapper, '```')

    const content = composerEditor(wrapper).getJSON().content ?? []
    expect(content[0]?.type).toBe('paragraph')
    expect(content[1]?.type).toBe('codeBlock')
  })

  it('restores a saved conversation draft on mount', async () => {
    saveChatDraft(conversationDraftScope, {
      body: 'Saved draft',
      entities: [],
    })

    const wrapper = mount(MessageInput, {
      props: {
        channelName: 'general',
        conversationId: 'channel-1',
        draftScope: conversationDraftScope,
        disabled: false,
      },
    })
    await waitForComposer(wrapper)

    expect(composer(wrapper).props('modelValue')).toBe('Saved draft')
  })

  it('persists edits into storage as text changes', async () => {
    const wrapper = mount(MessageInput, {
      props: {
        channelName: 'general',
        conversationId: 'channel-1',
        draftScope: conversationDraftScope,
        disabled: false,
      },
    })
    await waitForComposer(wrapper)

    await insertText(wrapper, 'hello draft')

    expect(loadChatDraft(conversationDraftScope)).toEqual({
      body: 'hello draft',
      entities: [],
    })
  })

  it('restores saved mention metadata, not just plain text', async () => {
    saveChatDraft(conversationDraftScope, {
      body: 'Hello @Ada',
      entities: [{
        kind: 'user',
        targetId: 'user-1',
        label: '@Ada',
        href: '',
        start: 6,
        end: 10,
      }],
    })

    const wrapper = mount(MessageInput, {
      props: {
        channelName: 'general',
        conversationId: 'channel-1',
        draftScope: conversationDraftScope,
        disabled: false,
      },
    })
    await waitForComposer(wrapper)

    expect(composer(wrapper).props('modelValue')).toBe('Hello @Ada')
    expect(composer(wrapper).props('entities')).toEqual([{
      kind: 'user',
      targetId: 'user-1',
      label: '@Ada',
      href: '',
      start: 6,
      end: 10,
    }])
  })

  it('clears the stored draft on successful send', async () => {
    const wrapper = mount(MessageInput, {
      props: {
        channelName: 'general',
        conversationId: 'channel-1',
        draftScope: conversationDraftScope,
        disabled: false,
      },
    })
    await waitForComposer(wrapper)

    await insertText(wrapper, 'send me')
    await wrapper.get('[data-testid="composer-send-button"]').trigger('click')
    await flushAll()

    expect(loadChatDraft(conversationDraftScope)).toEqual({
      body: '',
      entities: [],
    })
    expect(wrapper.emitted('send')).toHaveLength(1)
  })

  it('swaps between draft scopes and restores the correct content for each', async () => {
    saveChatDraft(conversationDraftScope, {
      body: 'Conversation draft',
      entities: [],
    })
    saveChatDraft(threadDraftScope, {
      body: 'Thread draft',
      entities: [],
    })

    const wrapper = mount(MessageInput, {
      props: {
        channelName: 'general',
        conversationId: 'channel-1',
        draftScope: conversationDraftScope,
        disabled: false,
      },
    })
    await waitForComposer(wrapper)

    expect(composer(wrapper).props('modelValue')).toBe('Conversation draft')

    await wrapper.setProps({
      channelName: 'thread',
      draftScope: threadDraftScope,
    })
    await flushAll()

    expect(composer(wrapper).props('modelValue')).toBe('Thread draft')
  })

  it('keeps attachments out of persisted draft storage', async () => {
    vi.mocked(uploadChatAttachment).mockResolvedValue({
      id: 'att-1',
      file_name: 'photo.png',
      file_size: 4,
      mime_type: 'image/png',
    })

    const wrapper = mount(MessageInput, {
      props: {
        channelName: 'general',
        conversationId: 'channel-1',
        draftScope: conversationDraftScope,
        disabled: false,
      },
    })
    await waitForComposer(wrapper)

    const file = new File(['test'], 'photo.png', { type: 'image/png' })
    await (composer(wrapper).vm as unknown as { receiveFiles: (files: File[]) => Promise<void> }).receiveFiles([file])
    await flushAll()

    expect(loadChatDraft(conversationDraftScope)).toEqual({
      body: '',
      entities: [],
    })
    expect(localStorage.getItem('msgnr:chat:drafts:v1')).toBeNull()
  })
})
