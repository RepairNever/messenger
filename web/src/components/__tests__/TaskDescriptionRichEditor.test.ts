import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { createPinia, setActivePinia } from 'pinia'
import type { Editor } from '@tiptap/core'
import TaskDescriptionRichEditor from '@/components/tasks/TaskDescriptionRichEditor.vue'
import { fetchOwnedAttachmentBlob, uploadOwnedAttachment } from '@/services/http/attachmentOwnersApi'
import { createOrOpenDm } from '@/services/http/chatApi'
import { tasksFetchStagedAttachmentBlob, tasksListTasks, tasksListUsers } from '@/services/http/tasksApi'
import MessageTagPicker from '@/components/MessageTagPicker.vue'
import { resetDescriptionMentionCacheForTests } from '@/utils/descriptionMentions'
import router from '@/router'
import { useChatStore } from '@/stores/chat'

vi.mock('@/services/http/attachmentOwnersApi', () => ({
  uploadOwnedAttachment: vi.fn(),
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

describe('TaskDescriptionRichEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
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

  async function waitForRichEditor(wrapper: ReturnType<typeof mount>) {
    for (let i = 0; i < 10; i += 1) {
      await flushPromises()
      await nextTick()
      if (wrapper.find('[data-testid="task-description-editor-content"] .ProseMirror').exists()) {
        return
      }
    }
    throw new Error('rich editor did not mount')
  }

  async function waitForEditorText(wrapper: ReturnType<typeof mount>, expected: string) {
    for (let i = 0; i < 10; i += 1) {
      await flushPromises()
      await nextTick()
      const editorContent = wrapper.find('[data-testid="task-description-editor-content"] .ProseMirror')
      if (editorContent.exists() && editorContent.text().includes(expected)) {
        return
      }
    }
    throw new Error(`editor text did not include ${JSON.stringify(expected)}`)
  }

  async function waitForLatestMarkdownUpdate(wrapper: ReturnType<typeof mount>, expected: string) {
    for (let i = 0; i < 10; i += 1) {
      await flushPromises()
      await nextTick()
      const updates = wrapper.emitted('update:modelValue') ?? []
      const latest = updates[updates.length - 1]?.[0]
      if (latest === expected) {
        return
      }
    }
    throw new Error(`latest markdown update did not equal ${JSON.stringify(expected)}`)
  }

  function getEditor(wrapper: ReturnType<typeof mount>) {
    const editor = wrapper.getComponent({ name: 'EditorContent' }).props('editor') as Editor | undefined
    if (!editor) {
      throw new Error('editor did not initialize')
    }
    return editor
  }

  function latestMarkdown(wrapper: ReturnType<typeof mount>): string {
    const updates = wrapper.emitted('update:modelValue') ?? []
    return String(updates[updates.length - 1]?.[0] ?? '')
  }

  function rect(top: number, bottom: number): DOMRect {
    return {
      x: 0,
      y: top,
      width: 100,
      height: bottom - top,
      top,
      right: 100,
      bottom,
      left: 0,
      toJSON: () => ({}),
    } as DOMRect
  }

  function mountScrollHost() {
    const host = document.createElement('div')
    host.style.overflowY = 'auto'
    Object.defineProperty(host, 'clientHeight', {
      configurable: true,
      value: 300,
    })
    Object.defineProperty(host, 'scrollHeight', {
      configurable: true,
      value: 900,
    })
    Object.defineProperty(host, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(100, 400),
    })
    document.body.appendChild(host)
    return host
  }

  function scrollToSelectionHandled(editor: Editor): boolean {
    const handler = editor.view.someProp('handleScrollToSelection')
    if (!handler) {
      throw new Error('handleScrollToSelection prop missing')
    }
    return handler(editor.view)
  }

  function selectTextInEditor(editor: Editor, text: string) {
    let targetPos: number | null = null
    editor.state.doc.descendants((node, pos) => {
      if (targetPos !== null) return false
      if (node.isText && node.text === text) {
        targetPos = pos + 1
        return false
      }
      return true
    })
    if (targetPos === null) {
      throw new Error(`editor text node ${JSON.stringify(text)} not found`)
    }
    editor.commands.setTextSelection(targetPos)
  }

  function selectTextRangeInEditor(editor: Editor, fromText: string, toText: string) {
    let from: number | null = null
    let to: number | null = null
    editor.state.doc.descendants((node, pos) => {
      if (!node.isText || !node.text) return true
      if (from === null) {
        const startIndex = node.text.indexOf(fromText)
        if (startIndex !== -1) {
          from = pos + startIndex
        }
      }
      const endIndex = node.text.indexOf(toText)
      if (endIndex !== -1) {
        to = pos + endIndex + toText.length
      }
      return from === null || to === null
    })
    if (from === null || to === null) {
      throw new Error(`editor text range ${JSON.stringify(fromText)}..${JSON.stringify(toText)} not found`)
    }
    editor.commands.setTextSelection({ from, to })
  }

  async function waitForTableToolbar(wrapper: ReturnType<typeof mount>) {
    for (let i = 0; i < 10; i += 1) {
      await flushPromises()
      await nextTick()
      if (wrapper.find('[data-testid="task-description-table-toolbar"]').exists()) {
        return
      }
    }
    throw new Error('table toolbar did not appear')
  }

  async function mountTableEditor() {
    const wrapper = mount(TaskDescriptionRichEditor, {
      props: {
        modelValue: [
          '| H1 | H2 | H3 |',
          '| --- | --- | --- |',
          '| A1 | B1 | C1 |',
          '| A2 | B2 | C2 |',
        ].join('\n'),
        uploadAttachments: vi.fn(),
      },
      attachTo: document.body,
    })
    await waitForRichEditor(wrapper)
    const editor = getEditor(wrapper)
    selectTextInEditor(editor, 'B1')
    await waitForTableToolbar(wrapper)
    return { wrapper, editor }
  }

  async function clickToolbarButton(wrapper: ReturnType<typeof mount>, testId: string) {
    const button = wrapper.get(`[data-testid="${testId}"]`)
    await button.trigger('mousedown')
    await button.trigger('click')
    await flushPromises()
    await nextTick()
  }

  it('renders markdown task items as checkboxes and toggles them back to markdown', async () => {
    const wrapper = mount(TaskDescriptionRichEditor, {
      props: {
        modelValue: '- [ ] Text',
        uploadAttachments: vi.fn(),
      },
      attachTo: document.body,
    })
    await waitForRichEditor(wrapper)

    const checkbox = wrapper.get('[data-testid="task-description-editor-content"] input[type="checkbox"]')
    const checkboxEl = checkbox.element as HTMLInputElement
    expect(checkboxEl.checked).toBe(false)

    checkboxEl.checked = true
    await checkbox.trigger('change')
    await flushPromises()
    await nextTick()

    const updates = wrapper.emitted('update:modelValue') ?? []
    const latest = updates[updates.length - 1]?.[0] as string
    expect(latest).toContain('- [x] Text')
  })

  it('adds task-item markup so checkbox text stays inline', async () => {
    const wrapper = mount(TaskDescriptionRichEditor, {
      props: {
        modelValue: '- [x] text\n- [ ] two',
        uploadAttachments: vi.fn(),
      },
      attachTo: document.body,
    })
    await waitForRichEditor(wrapper)

    const items = wrapper.findAll('[data-testid="task-description-editor-content"] li[data-type="taskItem"]')

    expect(items).toHaveLength(2)
    expect(items[0].attributes('data-type')).toBe('taskItem')
    expect(items[0].find('label').exists()).toBe(true)
    expect(items[0].find('div').exists()).toBe(true)
    expect(items[0].text()).toContain('text')
  })

  it('shows table structure controls only when the selection is inside a table', async () => {
    const wrapper = mount(TaskDescriptionRichEditor, {
      props: {
        modelValue: 'Plain text',
        uploadAttachments: vi.fn(),
      },
      attachTo: document.body,
    })
    await waitForRichEditor(wrapper)

    expect(wrapper.find('[data-testid="task-description-table-toolbar"]').exists()).toBe(false)

    const editor = getEditor(wrapper)
    editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
    await waitForTableToolbar(wrapper)

    expect(wrapper.find('[data-testid="task-description-table-add-row"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="task-description-table-delete-row"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="task-description-table-add-column"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="task-description-table-delete-column"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="task-description-table-delete-table"]').exists()).toBe(true)
  })

  it('renders accessible edge controls for editable tables', async () => {
    const { wrapper } = await mountTableEditor()

    const addColumn = wrapper.get('[data-testid="task-description-table-edge-add-column"]')
    const addRow = wrapper.get('[data-testid="task-description-table-edge-add-row"]')
    expect(addColumn.attributes('aria-label')).toBe('Add table column')
    expect(addRow.attributes('aria-label')).toBe('Add table row')
    expect(addColumn.attributes('contenteditable')).toBe('false')
    expect(addRow.attributes('contenteditable')).toBe('false')
    expect(addColumn.attributes('disabled')).toBeUndefined()
    expect(addRow.attributes('disabled')).toBeUndefined()
  })

  it('keeps table controls outside the internal horizontal scroll viewport', async () => {
    const { wrapper } = await mountTableEditor()

    const tableWrapper = wrapper.get('.task-table-wrapper')
    const scrollViewport = wrapper.get('[data-testid="task-description-table-scroll"]')
    const table = wrapper.get('[data-testid="task-description-table-scroll"] > table')
    const addColumn = wrapper.get('[data-testid="task-description-table-edge-add-column"]')
    const addRow = wrapper.get('[data-testid="task-description-table-edge-add-row"]')

    expect(scrollViewport.element.contains(table.element)).toBe(true)
    expect(scrollViewport.element.contains(addColumn.element)).toBe(false)
    expect(scrollViewport.element.contains(addRow.element)).toBe(false)
    expect(tableWrapper.element.contains(addColumn.element)).toBe(true)
    expect(tableWrapper.element.contains(addRow.element)).toBe(true)
  })

  it('appends a column from the table edge control', async () => {
    const { wrapper } = await mountTableEditor()

    await clickToolbarButton(wrapper, 'task-description-table-edge-add-column')

    expect(latestMarkdown(wrapper)).toContain('| H1 | H2 | H3 |  |')
    expect(latestMarkdown(wrapper)).toContain('| A1 | B1 | C1 |  |')
  })

  it('appends a row from the table edge control', async () => {
    const { wrapper } = await mountTableEditor()

    await clickToolbarButton(wrapper, 'task-description-table-edge-add-row')

    const rows = latestMarkdown(wrapper).split('\n')
    expect(rows[rows.length - 1]).toBe('|  |  |  |')
  })

  it('deletes a hovered column from its header actions menu', async () => {
    const { wrapper } = await mountTableEditor()
    const header = wrapper.get('[data-testid="task-description-table-scroll"] th:nth-child(2)')

    await header.trigger('mousemove', { clientX: 0 })
    await nextTick()

    const actions = wrapper.get('[data-testid="task-description-table-column-actions"]')
    expect(actions.attributes('aria-label')).toBe('Column actions')
    await actions.trigger('mousedown')
    await actions.trigger('click')
    await flushPromises()
    await nextTick()

    const deleteAction = wrapper.get('[data-testid="task-description-table-delete-column-action"]')
    expect(deleteAction.text()).toBe('Delete column')
    await deleteAction.trigger('mousedown')
    await deleteAction.trigger('click')
    await flushPromises()
    await nextTick()

    expect(latestMarkdown(wrapper)).toContain('| H1 | H3 |')
    expect(latestMarkdown(wrapper)).toContain('| A1 | C1 |')
    expect(latestMarkdown(wrapper)).not.toContain('B1')
  })

  it('resizes an adjacent column pair without changing the table width', async () => {
    const { wrapper, editor } = await mountTableEditor()
    const cells = wrapper.findAll('[data-testid="task-description-table-scroll"] tr:first-child > *')
    const widths = [120, 120, 120]
    cells.forEach((cell, index) => {
      const left = widths.slice(0, index).reduce((sum, width) => sum + width, 0)
      const width = widths[index] ?? 0
      vi.spyOn(cell.element, 'getBoundingClientRect').mockReturnValue({
        x: left,
        y: 0,
        top: 0,
        right: left + width,
        bottom: 32,
        left,
        width,
        height: 32,
        toJSON: () => ({}),
      })
    })

    const firstHeader = cells[0]!
    firstHeader.element.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      button: 0,
      clientX: 120,
      clientY: 12,
    }))
    document.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      button: 0,
      clientX: 160,
      clientY: 12,
    }))
    document.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true,
      button: 0,
      clientX: 160,
      clientY: 12,
    }))
    await flushPromises()
    await nextTick()

    const table = editor.getJSON().content?.find(node => node.type === 'table') as {
      content?: Array<{ content?: Array<{ attrs?: { colwidth?: number[] } }> }>
    } | undefined
    const firstRow = table?.content?.[0]?.content ?? []
    expect(firstRow[0]?.attrs?.colwidth).toEqual([160])
    expect(firstRow[1]?.attrs?.colwidth).toEqual([80])
    expect(firstRow[2]?.attrs?.colwidth).toEqual([120])
    expect(document.body.classList.contains('task-table-is-resizing')).toBe(false)
  })

  it('disables table structure controls when TipTap reports commands cannot run', async () => {
    const { wrapper, editor } = await mountTableEditor()
    vi.spyOn(editor, 'can').mockReturnValue({
      chain: () => ({
        focus: () => ({
          addRowAfter: () => ({ run: () => false }),
          deleteRow: () => ({ run: () => false }),
          addColumnAfter: () => ({ run: () => false }),
          deleteColumn: () => ({ run: () => false }),
          deleteTable: () => ({ run: () => false }),
        }),
      }),
    } as never)
    wrapper.vm.$forceUpdate()
    await nextTick()

    expect(wrapper.get('[data-testid="task-description-table-add-row"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="task-description-table-delete-row"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="task-description-table-add-column"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="task-description-table-delete-column"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="task-description-table-delete-table"]').attributes('disabled')).toBeDefined()
  })

  it('adds and deletes table columns from the contextual table toolbar', async () => {
    const { wrapper } = await mountTableEditor()

    await clickToolbarButton(wrapper, 'task-description-table-add-column')
    expect(latestMarkdown(wrapper)).toContain('| H1 | H2 |  | H3 |')
    expect(latestMarkdown(wrapper)).toContain('| A1 | B1 |  | C1 |')

    await clickToolbarButton(wrapper, 'task-description-table-delete-column')
    expect(latestMarkdown(wrapper)).toContain('| H1 |  | H3 |')
    expect(latestMarkdown(wrapper)).toContain('| A1 |  | C1 |')
    expect(latestMarkdown(wrapper)).not.toContain('B1')
  })

  it('adds and deletes table rows from the contextual table toolbar', async () => {
    const { wrapper } = await mountTableEditor()

    await clickToolbarButton(wrapper, 'task-description-table-add-row')
    expect(latestMarkdown(wrapper)).toContain('| A1 | B1 | C1 |')
    expect(latestMarkdown(wrapper)).toContain('|  |  |  |')
    expect(latestMarkdown(wrapper)).toContain('| A2 | B2 | C2 |')

    await clickToolbarButton(wrapper, 'task-description-table-delete-row')
    expect(latestMarkdown(wrapper)).not.toContain('| A1 | B1 | C1 |')
    expect(latestMarkdown(wrapper)).toContain('|  |  |  |')
    expect(latestMarkdown(wrapper)).toContain('| A2 | B2 | C2 |')
  })

  it('deletes the current table from the contextual table toolbar', async () => {
    const { wrapper } = await mountTableEditor()

    await clickToolbarButton(wrapper, 'task-description-table-delete-table')

    expect(latestMarkdown(wrapper)).toBe('')
    expect(wrapper.find('[data-testid="task-description-table-toolbar"]').exists()).toBe(false)
  })

  it('falls back to rendered markdown when collab doc stays empty', async () => {
    const collabDoc = new Y.Doc()
    collabDoc.getXmlFragment('task_description')

    const wrapper = mount(TaskDescriptionRichEditor, {
      props: {
        modelValue: '**Bold** text',
        collabDoc,
        allowLocalDraftSeed: false,
        uploadAttachments: vi.fn(),
      },
      attachTo: document.body,
    })
    await waitForRichEditor(wrapper)

    expect(wrapper.get('[data-testid="task-description-editor-fallback"] .markdown-body strong').text()).toBe('Bold')
  })

  it('highlights fenced code in the rendered markdown fallback', async () => {
    const collabDoc = new Y.Doc()
    collabDoc.getXmlFragment('task_description')

    const wrapper = mount(TaskDescriptionRichEditor, {
      props: {
        modelValue: '```python\ndef hello(name):\n    return name\n```',
        collabDoc,
        allowLocalDraftSeed: false,
        uploadAttachments: vi.fn(),
      },
      attachTo: document.body,
    })
    await waitForRichEditor(wrapper)

    const code = wrapper.get('[data-testid="task-description-editor-fallback"] .markdown-body pre code')
    expect(code.classes()).toContain('hljs')
    expect(code.classes()).toContain('language-python')
    expect(wrapper.html()).toContain('<span class="hljs-keyword">def</span>')
  })

  it('highlights fenced code in the editable rendered description', async () => {
    const wrapper = mount(TaskDescriptionRichEditor, {
      props: {
        modelValue: '```go\npackage main\nfunc main() {}\n```',
        uploadAttachments: vi.fn(),
      },
      attachTo: document.body,
    })
    await waitForRichEditor(wrapper)
    await flushPromises()

    const pre = wrapper.get('[data-testid="task-description-editor-content"] .ProseMirror pre')
    expect(pre.classes()).toContain('language-go')
    expect(pre.attributes('data-language')).toBe('Go')
    expect(wrapper.find('[data-testid="task-description-editor-content"] .ProseMirror pre .hljs-keyword').exists()).toBe(true)
  })

  it('autodetects unlabeled code blocks in the editable rendered description', async () => {
    const wrapper = mount(TaskDescriptionRichEditor, {
      props: {
        modelValue: '```\nSELECT id FROM users WHERE active = true;\n```',
        uploadAttachments: vi.fn(),
      },
      attachTo: document.body,
    })
    await waitForRichEditor(wrapper)
    await flushPromises()

    const pre = wrapper.get('[data-testid="task-description-editor-content"] .ProseMirror pre')
    expect(pre.classes()).toContain('language-sql')
    expect(pre.attributes('data-language')).toBe('SQL')
    expect(wrapper.find('[data-testid="task-description-editor-content"] .ProseMirror pre .hljs-keyword').exists()).toBe(true)
  })

  it('autodetects command and JSON output blocks in the editable rendered description', async () => {
    const wrapper = mount(TaskDescriptionRichEditor, {
      props: {
        modelValue: [
          '```',
          'curl --request POST \\',
          "     --url 'https://uat.com/oauth/token?form=2' \\",
          "     --header 'Content-Type: application/x-www-form-urlencoded' \\",
          "     --header 'accept: application/json' \\",
          '     --data grant_type=client_credentials',
          '```',
          '',
          '```',
          '{"error":"invalid_scope","error_description":"The requested scope is invalid, unknown, or malformed."}%',
          '```',
        ].join('\n'),
        uploadAttachments: vi.fn(),
      },
      attachTo: document.body,
    })
    await waitForRichEditor(wrapper)
    await flushPromises()

    const codeBlocks = wrapper.findAll('[data-testid="task-description-editor-content"] .ProseMirror pre')
    expect(codeBlocks).toHaveLength(2)
    expect(codeBlocks[0]!.classes()).toContain('language-shell')
    expect(codeBlocks[0]!.attributes('data-language')).toBe('Shell')
    expect(codeBlocks[1]!.classes()).toContain('language-json')
    expect(codeBlocks[1]!.attributes('data-language')).toBe('JSON')
    expect(wrapper.find('[data-testid="task-description-editor-content"] .ProseMirror pre.language-json .hljs-attr').exists()).toBe(true)
  })

  it('converts selected multiline text to a fenced code block', async () => {
    const wrapper = mount(TaskDescriptionRichEditor, {
      props: {
        modelValue: 'Before\n\nline one\nline two\n\nAfter',
        uploadAttachments: vi.fn(),
      },
      attachTo: document.body,
    })
    await waitForRichEditor(wrapper)

    const editor = getEditor(wrapper)
    editor.commands.focus()
    selectTextRangeInEditor(editor, 'line one', 'line two')
    await flushPromises()
    await nextTick()
    wrapper.vm.convertSelectionToCodeBlock()
    await flushPromises()

    const codeBlocks = wrapper.findAll('[data-testid="task-description-editor-content"] .ProseMirror pre')
    expect(codeBlocks).toHaveLength(1)
    expect(codeBlocks[0]!.text()).toContain('line one')
    expect(codeBlocks[0]!.text()).toContain('line two')
    expect(latestMarkdown(wrapper)).toContain('```\nline one\nline two\n```')
  })

  it('keeps rendered mode editable after local collab content is cleared', async () => {
    const collabDoc = new Y.Doc()
    const collabFragment = collabDoc.getXmlFragment('task_description')

    const wrapper = mount(TaskDescriptionRichEditor, {
      props: {
        modelValue: '**Bold** text',
        collabDoc,
        uploadAttachments: vi.fn(),
      },
      attachTo: document.body,
    })
    await waitForRichEditor(wrapper)
    await waitForEditorText(wrapper, 'Bold')

    const editor = getEditor(wrapper)
    expect(editor.isEditable).toBe(true)

    collabDoc.transact(() => {
      collabFragment.delete(0, collabFragment.length)
    }, 'local-clear')
    await waitForLatestMarkdownUpdate(wrapper, '')

    expect(wrapper.find('[data-testid="task-description-editor-fallback"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="task-description-editor-content"] .ProseMirror').text()).toBe('')
    expect(editor.isEditable).toBe(true)
  })

  it('applies remote collab clears without showing stale rendered fallback', async () => {
    const collabDoc = new Y.Doc()
    collabDoc.getXmlFragment('task_description')

    const wrapper = mount(TaskDescriptionRichEditor, {
      props: {
        modelValue: '**Bold** text',
        collabDoc,
        uploadAttachments: vi.fn(),
      },
      attachTo: document.body,
    })
    await waitForRichEditor(wrapper)
    await waitForEditorText(wrapper, 'Bold')

    const remoteDoc = new Y.Doc()
    const remoteFragment = remoteDoc.getXmlFragment('task_description')
    Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(collabDoc), 'initial-sync')

    let remoteClearUpdate: Uint8Array | null = null
    remoteDoc.on('update', (update, origin) => {
      if (origin === 'remote-clear') {
        remoteClearUpdate = update
      }
    })
    remoteDoc.transact(() => {
      remoteFragment.delete(0, remoteFragment.length)
    }, 'remote-clear')

    expect(remoteClearUpdate).not.toBeNull()
    Y.applyUpdate(collabDoc, remoteClearUpdate!, 'remote')
    await waitForLatestMarkdownUpdate(wrapper, '')

    expect(wrapper.find('[data-testid="task-description-editor-fallback"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="task-description-editor-content"] .ProseMirror').text()).toBe('')
    expect(getEditor(wrapper).isEditable).toBe(true)
  })

  it('forces markdown draft into the collab doc only when the editor content differs', async () => {
    const collabDoc = new Y.Doc()
    collabDoc.getXmlFragment('task_description')

    const wrapper = mount(TaskDescriptionRichEditor, {
      props: {
        modelValue: '**Old** text',
        collabDoc,
        uploadAttachments: vi.fn(),
      },
      attachTo: document.body,
    })
    await waitForRichEditor(wrapper)
    await waitForEditorText(wrapper, 'Old')

    let updateCount = 0
    collabDoc.on('update', () => {
      updateCount += 1
    })

    await wrapper.setProps({
      modelValue: '## New\n\nBody',
      forceLocalSyncToken: 1,
    })
    await flushPromises()

    expect(updateCount).toBeGreaterThan(0)
    expect(collabDoc.getXmlFragment('task_description').length).toBeGreaterThan(0)
    await waitForEditorText(wrapper, 'New')
    await waitForEditorText(wrapper, 'Body')

    updateCount = 0
    await wrapper.setProps({
      forceLocalSyncToken: 2,
    })
    await flushPromises()

    expect(updateCount).toBe(0)
  })

  it('does not force a whole-document markdown replacement while remote collaborators are active', async () => {
    const collabDoc = new Y.Doc()
    const collabFragment = collabDoc.getXmlFragment('task_description')

    const wrapper = mount(TaskDescriptionRichEditor, {
      props: {
        modelValue: '**Old** text',
        collabDoc,
        uploadAttachments: vi.fn(),
      },
      attachTo: document.body,
    })
    await waitForRichEditor(wrapper)
    await waitForEditorText(wrapper, 'Old')

    let updateCount = 0
    collabDoc.on('update', () => {
      updateCount += 1
    })

    await wrapper.setProps({
      modelValue: '## New\n\nBody',
      forceLocalSyncToken: 1,
      collabHasRemotePeers: true,
    })
    await flushPromises()

    expect(updateCount).toBe(0)
    expect(String(collabFragment)).not.toContain('New')
    expect(String(collabFragment)).toContain('Old')
  })

  it('handles scroll-to-selection when the caret is already visible in the task body', async () => {
    const host = mountScrollHost()
    const wrapper = mount(TaskDescriptionRichEditor, {
      props: {
        modelValue: 'Visible caret',
        uploadAttachments: vi.fn(),
      },
      attachTo: host,
    })
    await waitForRichEditor(wrapper)
    const editor = getEditor(wrapper)
    vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue(rect(180, 198))

    expect(scrollToSelectionHandled(editor)).toBe(true)
  })

  it('allows default scroll-to-selection when the caret is outside the task body viewport', async () => {
    const host = mountScrollHost()
    const wrapper = mount(TaskDescriptionRichEditor, {
      props: {
        modelValue: 'Hidden caret',
        uploadAttachments: vi.fn(),
      },
      attachTo: host,
    })
    await waitForRichEditor(wrapper)
    const editor = getEditor(wrapper)
    vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue(rect(430, 448))

    expect(scrollToSelectionHandled(editor)).toBe(false)
  })

  it('falls back to default scroll-to-selection when caret layout cannot be read', async () => {
    const host = mountScrollHost()
    const wrapper = mount(TaskDescriptionRichEditor, {
      props: {
        modelValue: 'Missing layout',
        uploadAttachments: vi.fn(),
      },
      attachTo: host,
    })
    await waitForRichEditor(wrapper)
    const editor = getEditor(wrapper)
    vi.spyOn(editor.view, 'coordsAtPos').mockImplementation(() => {
      throw new Error('layout unavailable')
    })

    expect(scrollToSelectionHandled(editor)).toBe(false)
  })

  it('uploads image files from the rendered editor and serializes them back to markdown tokens', async () => {
    vi.mocked(uploadOwnedAttachment).mockResolvedValue({
      id: 'att-image',
      file_name: 'Photo.png',
      mime_type: 'image/png',
    })

    const wrapper = mount(TaskDescriptionRichEditor, {
      props: {
        modelValue: '',
        ownerKind: 'task',
        ownerId: 'task-1',
        uploadAttachments: async (files: File[]) => Promise.all(files.map(file => uploadOwnedAttachment('task', 'task-1', file))),
      },
      attachTo: document.body,
    })
    await waitForRichEditor(wrapper)

    const editorEl = wrapper.get('[data-testid="task-description-editor-content"] .ProseMirror')
    await editorEl.trigger('paste', {
      clipboardData: {
        files: [new File(['img'], 'Photo.png', { type: 'image/png' })],
        getData: () => '',
      },
    })
    await flushPromises()

    const updates = wrapper.emitted('update:modelValue') ?? []
    const latest = updates[updates.length - 1]?.[0] as string
    expect(latest).toContain('![Photo.png](msgnr-attachment://task/task-1/att-image)')
    expect(uploadOwnedAttachment).toHaveBeenCalledWith('task', 'task-1', expect.any(File))
    expect(fetchOwnedAttachmentBlob).toHaveBeenCalledWith('task', 'task-1', 'att-image')
  })

  it('uploads create-task staged images from the rendered editor', async () => {
    const uploadStaged = vi.fn(async () => [{
      id: 'staged-1',
      file_name: 'Photo.png',
      mime_type: 'image/png',
    }])

    const wrapper = mount(TaskDescriptionRichEditor, {
      props: {
        modelValue: '',
        attachmentUploadMode: 'task-staged',
        uploadAttachments: uploadStaged,
      },
      attachTo: document.body,
    })
    await waitForRichEditor(wrapper)

    const editorEl = wrapper.get('[data-testid="task-description-editor-content"] .ProseMirror')
    await editorEl.trigger('paste', {
      clipboardData: {
        files: [new File(['img'], 'Photo.png', { type: 'image/png' })],
        getData: () => '',
      },
    })
    await flushPromises()

    const updates = wrapper.emitted('update:modelValue') ?? []
    const latest = updates[updates.length - 1]?.[0] as string
    expect(uploadStaged).toHaveBeenCalledWith([expect.any(File)])
    expect(latest).toContain('![Photo.png](msgnr-staged-attachment://task/staged-1)')
    expect(tasksFetchStagedAttachmentBlob).toHaveBeenCalledWith('staged-1')
    expect(fetchOwnedAttachmentBlob).not.toHaveBeenCalled()
  })

  it('opens inline attachment images in a lightbox and closes it with every supported action', async () => {
    const wrapper = mount(TaskDescriptionRichEditor, {
      props: {
        modelValue: '![Photo.png](msgnr-attachment://task/task-1/att-image)',
        ownerKind: 'task',
        ownerId: 'task-1',
        uploadAttachments: vi.fn(),
      },
      attachTo: document.body,
    })
    await waitForRichEditor(wrapper)
    await flushPromises()

    const image = wrapper.get('[data-testid="task-description-editor-content"] .ProseMirror img')
    expect(image.attributes('src')).toBe('blob:editor')

    async function openLightbox() {
      await image.trigger('click')
      await flushPromises()
      return document.body.querySelector<HTMLElement>('[data-testid="task-description-image-lightbox"]')
    }

    let lightbox = await openLightbox()
    expect(lightbox).not.toBeNull()
    expect(lightbox?.querySelector('img')?.getAttribute('src')).toBe('blob:editor')
    expect(lightbox?.querySelector('img')?.getAttribute('alt')).toBe('Photo.png')
    expect(fetchOwnedAttachmentBlob).toHaveBeenCalledTimes(1)

    const closeButton = lightbox?.querySelector<HTMLButtonElement>('[data-testid="task-description-image-lightbox-close"]')
    expect(closeButton).not.toBeNull()
    closeButton?.click()
    await flushPromises()
    expect(document.body.querySelector('[data-testid="task-description-image-lightbox"]')).toBeNull()

    lightbox = await openLightbox()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(lightbox).not.toBeNull()
    expect(document.body.querySelector('[data-testid="task-description-image-lightbox"]')).toBeNull()

    lightbox = await openLightbox()
    lightbox?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await flushPromises()
    expect(document.body.querySelector('[data-testid="task-description-image-lightbox"]')).toBeNull()
  })

  it('opens attachment links from the editor on first mouse press', async () => {
    const wrapper = mount(TaskDescriptionRichEditor, {
      props: {
        modelValue: '[Spec.pdf](msgnr-attachment://document/doc-1/att-2)',
        ownerKind: 'document',
        ownerId: 'doc-1',
        uploadAttachments: vi.fn(),
      },
      attachTo: document.body,
    })
    await waitForRichEditor(wrapper)

    const link = wrapper.get('[data-testid="task-description-editor-content"] .ProseMirror a')
    link.element.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
    }))
    await flushPromises()

    expect(fetchOwnedAttachmentBlob).toHaveBeenCalledWith('document', 'doc-1', 'att-2')
    expect(window.open).toHaveBeenCalledWith('about:blank', '_blank')
    const opened = vi.mocked(window.open).mock.results[0]?.value as { location: { replace: ReturnType<typeof vi.fn> } }
    expect(opened.location.replace).toHaveBeenCalledWith('blob:editor')
  })

  it('opens normal markdown links from the editor on first mouse press', async () => {
    const wrapper = mount(TaskDescriptionRichEditor, {
      props: {
        modelValue: '[OpenAI](https://openai.com)',
        uploadAttachments: vi.fn(),
      },
      attachTo: document.body,
    })
    await waitForRichEditor(wrapper)

    const link = wrapper.get('[data-testid="task-description-editor-content"] .ProseMirror a')
    link.element.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
    }))
    await flushPromises()

    expect(fetchOwnedAttachmentBlob).not.toHaveBeenCalled()
    expect(window.open).toHaveBeenCalledWith('https://openai.com/', '_blank')
    const opened = vi.mocked(window.open).mock.results[0]?.value as { focus: ReturnType<typeof vi.fn> }
    expect(opened.focus).toHaveBeenCalled()
  })

  it('opens task mention links from the editor on first mouse press', async () => {
    const pushSpy = vi.spyOn(router, 'push').mockResolvedValue(undefined as never)
    const wrapper = mount(TaskDescriptionRichEditor, {
      props: {
        modelValue: 'See [@TASK-123 Fix search](/tasks/task-123)',
        uploadAttachments: vi.fn(),
      },
      attachTo: document.body,
    })
    await waitForRichEditor(wrapper)

    const link = wrapper.get('[data-testid="task-description-editor-content"] .ProseMirror a')
    link.element.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
    }))
    await flushPromises()

    expect(pushSpy).toHaveBeenCalledWith('/tasks/task-123')
    pushSpy.mockRestore()
  })

  it('opens a direct message when a user mention is pressed in the editor', async () => {
    const chatStore = useChatStore()
    const openDirectMessageSpy = vi.spyOn(chatStore, 'openDirectMessage').mockImplementation(() => {})
    const wrapper = mount(TaskDescriptionRichEditor, {
      props: {
        modelValue: 'Hello [@Alice Example](msgnr-mention://user/user-1)',
        uploadAttachments: vi.fn(),
      },
      attachTo: document.body,
    })
    await waitForRichEditor(wrapper)

    const link = wrapper.get('[data-testid="task-description-editor-content"] .ProseMirror a')
    link.element.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
    }))
    await flushPromises()

    expect(createOrOpenDm).toHaveBeenCalledWith('user-1')
    expect(openDirectMessageSpy).toHaveBeenCalledWith(expect.objectContaining({
      id: 'dm-1',
      userId: 'user-1',
      displayName: 'Alice Example',
    }))
  })

  it('opens mention picker and inserts markdown-backed user mentions', async () => {
    vi.useFakeTimers()
    vi.mocked(tasksListUsers).mockResolvedValue([
      {
        id: 'user-1',
        display_name: 'Alice Example',
        email: 'alice@example.com',
        avatar_url: 'https://example.com/alice.png',
      },
    ])

    const wrapper = mount(TaskDescriptionRichEditor, {
      props: {
        modelValue: '',
        uploadAttachments: vi.fn(),
      },
      attachTo: document.body,
      global: {
        stubs: {
          UserAvatar: true,
        },
      },
    })
    await waitForRichEditor(wrapper)

    const editor = getEditor(wrapper)
    editor.commands.focus('end')
    editor.commands.insertContent('@ali')
    await nextTick()
    vi.advanceTimersByTime(130)
    await flushPromises()

    expect(document.body.textContent).toContain('Tag search')
    wrapper.getComponent(MessageTagPicker).vm.$emit('select', {
      kind: 'user',
      id: 'user-1',
      label: '@Alice Example',
      subtitle: 'alice@example.com',
      href: 'msgnr-mention://user/user-1',
      icon: '@',
      flatIndex: 0,
    })
    await flushPromises()

    const updates = wrapper.emitted('update:modelValue') ?? []
    const latest = updates[updates.length - 1]?.[0] as string
    expect(latest).toContain('[@Alice Example](msgnr-mention://user/user-1)')
    vi.useRealTimers()
  })

  it('does not open mention picker inside code blocks', async () => {
    vi.useFakeTimers()
    vi.mocked(tasksListUsers).mockResolvedValue([
      {
        id: 'user-1',
        display_name: 'Alice Example',
        email: 'alice@example.com',
      },
    ])

    const wrapper = mount(TaskDescriptionRichEditor, {
      props: {
        modelValue: '',
        uploadAttachments: vi.fn(),
      },
      attachTo: document.body,
    })
    await waitForRichEditor(wrapper)

    const editor = getEditor(wrapper)
    editor.commands.focus('end')
    editor.commands.setCodeBlock()
    editor.commands.insertContent('@ali')
    await nextTick()
    vi.advanceTimersByTime(130)
    await flushPromises()

    expect(wrapper.getComponent(MessageTagPicker).props('open')).toBe(false)
    vi.useRealTimers()
  })
})
