import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RichTextComposer from '@/components/RichTextComposer.vue'
import type { Task } from '@/services/http/tasksApi'
import { renderMarkdownToHtml } from '@/utils/markdown'

const tasksApiMocks = vi.hoisted(() => ({
  tasksGet: vi.fn(),
}))

vi.mock('@/services/http/tasksApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/http/tasksApi')>()
  return {
    ...actual,
    tasksGet: tasksApiMocks.tasksGet,
  }
})

describe('RichTextComposer Markdown paste and edit', () => {
  let wrapper: ReturnType<typeof mount>

  afterEach(() => wrapper?.unmount())

  async function createComposer(modelValue = '', enableMessageEntities = true, enableTaskItems = false) {
    wrapper = mount(RichTextComposer, {
      props: { modelValue, enableMessageEntities, enableTaskItems },
      attachTo: document.body,
    })
    await waitForEditor(wrapper)
    return editorInstance(wrapper)
  }

  async function submitBody() {
    await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Enter', ctrlKey: true })
    await flushPromises()
    return (wrapper.emitted('submit')![0][0] as { body: string }).body
  }

  it('pastes fenced Markdown as code without adding blank lines', async () => {
    const editor = await createComposer()
    const source = 'const answer = 42\n\nconsole.log(answer)'
    await pasteText(wrapper, `\`\`\`typescript\n${source}\n\`\`\``)

    expect(editor.getJSON().content[0]).toMatchObject({
      type: 'codeBlock', content: [{ type: 'text', text: source }],
    })
    expect(await submitBody()).toBe(`\`\`\`typescript\n${source}\n\`\`\``)
  })

  it.each([true, false])('uses portable hard breaks for multiline paste (entities=%s)', async (entities) => {
    await createComposer('', entities)
    await pasteText(wrapper, 'first\nsecond')
    expect(await submitBody()).toBe('first  \nsecond')
  })

  it('keeps nested lists and ordered list numbering through paste and submit', async () => {
    await createComposer()
    await pasteText(wrapper, '10. first\n    - nested\n      - deeper\n11. second')
    const html = renderMarkdownToHtml(await submitBody())
    const container = document.createElement('div')
    container.innerHTML = html
    expect(container.querySelector('ol')?.getAttribute('start')).toBe('10')
    expect(container.querySelectorAll('ol > li')).toHaveLength(2)
    expect(container.querySelector('ol > li > ul > li > ul > li')?.textContent).toBe('deeper')
  })

  it('preserves aligned tables and horizontal rules when editing existing Markdown', async () => {
    const body = '# Heading\n\n| Left | Right |\n| :--- | ---: |\n| one | two |\n\n---\n\n> quote'
    const editor = await createComposer(body)
    expect(editor.getJSON().content.map((node: { type: string }) => node.type))
      .toEqual(['heading', 'table', 'horizontalRule', 'blockquote'])
    const container = document.createElement('div')
    container.innerHTML = renderMarkdownToHtml(await submitBody())
    expect(container.querySelectorAll('table tr')).toHaveLength(2)
    expect(container.querySelector('th')?.getAttribute('align')).toBe('left')
    expect(container.querySelectorAll('th')[1]?.getAttribute('align')).toBe('right')
    expect(container.querySelector('hr')).toBeTruthy()
    expect(container.querySelector('blockquote')?.textContent?.trim()).toBe('quote')
  })

  it('preserves literal punctuation instead of turning it into new formatting', async () => {
    await createComposer()
    await pasteText(wrapper, String.raw`\*literal\* and \[label\]`)
    const container = document.createElement('div')
    container.innerHTML = renderMarkdownToHtml(await submitBody())
    expect(container.querySelector('em')).toBeNull()
    expect(container.textContent?.trim()).toBe('*literal* and [label]')
  })

  it('preserves literal punctuation and hard breaks in the task-comment composer', async () => {
    await createComposer('', false, true)
    await pasteText(wrapper, String.raw`\*literal\*` + '\nnext')
    const container = document.createElement('div')
    const body = await submitBody()
    expect(body).toBe(String.raw`\*literal\*` + '  \nnext')
    container.innerHTML = renderMarkdownToHtml(body)
    expect(container.querySelector('em')).toBeNull()
    expect(container.querySelector('br')).toBeTruthy()
    expect(container.textContent?.trim()).toBe('*literal*next')
  })

  it('preserves Markdown link and image titles through paste and submit', async () => {
    await createComposer()
    await pasteText(wrapper, '[link](https://example.com "Link title")\n\n![alt](https://example.com/image.png "Image title")')
    const container = document.createElement('div')
    container.innerHTML = renderMarkdownToHtml(await submitBody())
    expect(container.querySelector('a')?.getAttribute('title')).toBe('Link title')
    expect(container.querySelector('img')?.getAttribute('title')).toBe('Image title')
  })

  it('preserves inline code inside formatted Markdown links', async () => {
    await createComposer()
    await pasteText(wrapper, '**[`README.md`](https://example.com)**')
    const container = document.createElement('div')
    container.innerHTML = renderMarkdownToHtml(await submitBody())
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com')
    expect(container.querySelector('a code')?.textContent).toBe('README.md')
    expect(container.querySelector('strong code')?.textContent).toBe('README.md')
  })

  it('keeps Markdown inside an existing code block as literal source', async () => {
    const editor = await createComposer('```text\nexisting\n```')
    editor.commands.setTextSelection(9)
    const pasted = '\n**literal**\n- literal'
    const event = new Event('paste')
    Object.defineProperty(event, 'clipboardData', { value: {
      files: [], getData: (format: string) => format === 'text/plain' ? pasted : '',
    } })
    editor.view.pasteText(pasted, event)
    await flushPromises()
    expect(editor.getJSON().content[0]).toMatchObject({
      type: 'codeBlock', content: [{ type: 'text', text: `existing${pasted}` }],
    })
  })

  it('keeps images and checkbox lists through paste and submit', async () => {
    const editor = await createComposer()
    await pasteText(wrapper, '![logo](https://example.com/logo.png)\n\n- [ ] todo\n- [x] done')
    const blocks = editor.getJSON().content.filter((node: { type: string; content?: unknown[] }) => node.type !== 'paragraph' || node.content?.length)
    expect(blocks.map((node: { type: string }) => node.type)).toEqual(['image', 'taskList'])
    const body = await submitBody()
    expect(body).toContain('![logo](https://example.com/logo.png)')
    expect(body).toContain('- [ ] todo')
    expect(body).toContain('- [x] done')
  })

  it('preserves rich pasted entity metadata instead of flattening it to labels', async () => {
    const editor = await createComposer()
    const html = '<p>see <span data-message-entity-kind="task" data-message-entity-id="task-1" data-message-entity-label="@DEV-1 Demo" data-message-entity-href="/tasks/dev-1"><a href="https://example.com/tasks/dev-1">@DEV-1 Demo</a></span></p>'
    const event = new Event('paste')
    Object.defineProperty(event, 'clipboardData', { value: {
      files: [], getData: (format: string) => format === 'text/plain' ? 'see @DEV-1 Demo' : format === 'text/html' ? html : '',
    } })
    editor.view.pasteHTML(html, event)
    await flushPromises()
    expect(editor.getJSON().content[0].content[1]).toMatchObject({
      type: 'messageEntity', attrs: { kind: 'task', targetId: 'task-1', href: '/tasks/dev-1' },
    })
    await submitBody()
    expect(wrapper.emitted('submit')![0][0]).toMatchObject({
      body: 'see @DEV-1 Demo',
      entities: [{ kind: 'task', targetId: 'task-1', href: '/tasks/dev-1', start: 4, end: 15 }],
    })
  })

  it('parses raw Markdown even when a source editor also supplies styled HTML', async () => {
    const editor = await createComposer()
    const source = '```html\n<span data-message-entity-kind="task">code</span>\n```'
    const html = '<div><span>```html</span><br><span>&lt;span data-message-entity-kind="task"&gt;code&lt;/span&gt;</span><br><span>```</span></div>'
    const event = new Event('paste')
    Object.defineProperty(event, 'clipboardData', { value: {
      files: [], getData: (format: string) => format === 'text/plain' ? source : format === 'text/html' ? html : '',
    } })
    editor.view.pasteHTML(html, event)
    await flushPromises()
    expect(editor.getJSON().content[0]).toMatchObject({
      type: 'codeBlock', content: [{ type: 'text', text: '<span data-message-entity-kind="task">code</span>' }],
    })
    expect(await submitBody()).toBe(source)
  })

  it('keeps ordinary rich HTML formatting and undoes a paste in one step', async () => {
    const editor = await createComposer('before')
    editor.commands.selectAll()
    const html = '<p><strong>bold </strong>and <a href="https://example.com">https://example.com</a></p>'
    const event = new Event('paste')
    Object.defineProperty(event, 'clipboardData', { value: {
      files: [], getData: (format: string) => format === 'text/plain' ? 'bold and https://example.com' : format === 'text/html' ? html : '',
    } })
    editor.view.pasteHTML(html, event)
    await flushPromises()
    const container = document.createElement('div')
    container.innerHTML = renderMarkdownToHtml(await submitBody())
    expect(container.querySelector('strong')?.textContent).toBe('bold')
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com')
    editor.commands.undo()
    expect(editor.getText()).toBe('before')
  })
})

async function waitForEditor(wrapper: ReturnType<typeof mount>) {
  for (let index = 0; index < 10; index += 1) {
    await flushPromises()
    await nextTick()
    const vm = wrapper.vm as unknown as { getEditor?: () => unknown }
    if (wrapper.find('.ProseMirror').exists() && vm.getEditor?.()) return
  }
  throw new Error('editor did not mount')
}

function editorInstance(wrapper: ReturnType<typeof mount>) {
  const vm = wrapper.vm as unknown as { getEditor: () => any }
  return vm.getEditor()
}

function typeText(wrapper: ReturnType<typeof mount>, text: string) {
  const editor = editorInstance(wrapper)
  const view = editor.view

  for (const char of text) {
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
}

async function insertHardBreak(wrapper: ReturnType<typeof mount>) {
  await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Enter', shiftKey: true })
  await flushPromises()
}

function taskFixture(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-uuid-42',
    public_id: 'TASK-42',
    template_id: 'template-1',
    template_snapshot_prefix: 'TASK',
    sequence_number: 42,
    title: 'Fix task URL mentions',
    description: null,
    status_id: 'status-open',
    parent_task_id: null,
    created_by: 'user-1',
    updated_by: 'user-1',
    created_at: '2026-08-19T00:00:00Z',
    updated_at: '2026-08-19T00:00:00Z',
    field_values: [],
    subtasks: [],
    ...overrides,
  }
}

function canonicalTaskUrl(): string {
  return `${window.location.protocol}//${window.location.host}/tasks/task-42`
}

async function pasteText(wrapper: ReturnType<typeof mount>, text: string, files: File[] = []) {
  await wrapper.get('.ProseMirror').trigger('paste', {
    clipboardData: {
      files,
      getData: (format: string) => format === 'text/plain' ? text : '',
    },
  })
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

describe('RichTextComposer shortcuts', () => {
  it('converts 1. space into an ordered list', async () => {
    const wrapper = mount(RichTextComposer, {
      props: {
        modelValue: '',
      },
      attachTo: document.body,
    })
    await waitForEditor(wrapper)

    typeText(wrapper, '1. ')
    await flushPromises()

    expect(editorInstance(wrapper).isActive('orderedList')).toBe(true)
    expect(wrapper.get('.ProseMirror').classes()).not.toContain('is-empty')
  })

  it('converts dash-space into a bullet list', async () => {
    const wrapper = mount(RichTextComposer, {
      props: {
        modelValue: '',
      },
      attachTo: document.body,
    })
    await waitForEditor(wrapper)

    typeText(wrapper, '- ')
    await flushPromises()

    expect(editorInstance(wrapper).isActive('bulletList')).toBe(true)
  })

  it('splits the current paragraph when ordered-list shortcut is typed after a hard break', async () => {
    const wrapper = mount(RichTextComposer, {
      props: {
        modelValue: '',
      },
      attachTo: document.body,
    })
    await waitForEditor(wrapper)

    typeText(wrapper, 'alpha')
    await insertHardBreak(wrapper)
    typeText(wrapper, '1. ')
    await flushPromises()

    const content = editorInstance(wrapper).getJSON().content ?? []
    expect(content[0]?.type).toBe('paragraph')
    expect(content[1]?.type).toBe('orderedList')
    expect(editorInstance(wrapper).getJSON().content?.[0]?.content?.[0]?.text).toBe('alpha')
    expect(editorInstance(wrapper).isActive('orderedList')).toBe(true)
  })

  it('splits the current paragraph when bullet-list shortcut is typed after a hard break', async () => {
    const wrapper = mount(RichTextComposer, {
      props: {
        modelValue: '',
      },
      attachTo: document.body,
    })
    await waitForEditor(wrapper)

    typeText(wrapper, 'alpha')
    await insertHardBreak(wrapper)
    typeText(wrapper, '- ')
    await flushPromises()

    const content = editorInstance(wrapper).getJSON().content ?? []
    expect(content[0]?.type).toBe('paragraph')
    expect(content[1]?.type).toBe('bulletList')
    expect(editorInstance(wrapper).getJSON().content?.[0]?.content?.[0]?.text).toBe('alpha')
    expect(editorInstance(wrapper).isActive('bulletList')).toBe(true)
  })

  it('converts task markers when task items are enabled', async () => {
    const wrapper = mount(RichTextComposer, {
      props: {
        modelValue: '',
        enableTaskItems: true,
      },
      attachTo: document.body,
    })
    await waitForEditor(wrapper)

    typeText(wrapper, '[ ] ')
    await flushPromises()

    expect(editorInstance(wrapper).isActive('taskList')).toBe(true)
  })

  it('converts triple backticks plus Enter into a code block', async () => {
    const wrapper = mount(RichTextComposer, {
      props: {
        modelValue: '',
      },
      attachTo: document.body,
    })
    await waitForEditor(wrapper)

    typeText(wrapper, '```')
    await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(editorInstance(wrapper).isActive('codeBlock')).toBe(true)
  })

  it('converts triple backticks immediately into a code block', async () => {
    const wrapper = mount(RichTextComposer, {
      props: {
        modelValue: '',
      },
      attachTo: document.body,
    })
    await waitForEditor(wrapper)

    typeText(wrapper, '```')
    await flushPromises()

    expect(editorInstance(wrapper).isActive('codeBlock')).toBe(true)
    expect(editorInstance(wrapper).getHTML()).toContain('<pre><code></code></pre>')
  })

  it('splits the current paragraph when triple backticks are typed after a hard break', async () => {
    const wrapper = mount(RichTextComposer, {
      props: {
        modelValue: '',
      },
      attachTo: document.body,
    })
    await waitForEditor(wrapper)

    typeText(wrapper, 'alpha')
    await insertHardBreak(wrapper)
    typeText(wrapper, '```')
    await flushPromises()

    const content = editorInstance(wrapper).getJSON().content ?? []
    expect(content[0]?.type).toBe('paragraph')
    expect(content[1]?.type).toBe('codeBlock')
    expect(editorInstance(wrapper).getJSON().content?.[0]?.content?.[0]?.text).toBe('alpha')
    expect(editorInstance(wrapper).isActive('codeBlock')).toBe(true)
  })

  it('prefers code block conversion over submit-on-enter when the line is a fence', async () => {
    const wrapper = mount(RichTextComposer, {
      props: {
        modelValue: '',
        submitOnEnter: true,
      },
      attachTo: document.body,
    })
    await waitForEditor(wrapper)

    typeText(wrapper, '```')
    await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(wrapper.emitted('submit')).toBeFalsy()
    expect(editorInstance(wrapper).isActive('codeBlock')).toBe(true)
  })

  it('does not submit when Enter is pressed on a fence after a hard break', async () => {
    const wrapper = mount(RichTextComposer, {
      props: {
        modelValue: '',
        submitOnEnter: true,
      },
      attachTo: document.body,
    })
    await waitForEditor(wrapper)

    typeText(wrapper, 'alpha')
    await insertHardBreak(wrapper)
    typeText(wrapper, '```ts')
    await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(wrapper.emitted('submit')).toBeFalsy()
    const content = editorInstance(wrapper).getJSON().content ?? []
    expect(content[0]?.type).toBe('paragraph')
    expect(content[1]?.type).toBe('codeBlock')
    expect(editorInstance(wrapper).isActive('codeBlock')).toBe(true)
  })

  it('does not submit when Enter is pressed on a visual-line list shortcut candidate', async () => {
    const wrapper = mount(RichTextComposer, {
      props: {
        modelValue: '',
        submitOnEnter: true,
      },
      attachTo: document.body,
    })
    await waitForEditor(wrapper)

    typeText(wrapper, 'alpha')
    await insertHardBreak(wrapper)
    typeText(wrapper, '1.')
    await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(wrapper.emitted('submit')).toBeFalsy()
  })

  it('converts single backticks into inline code', async () => {
    const wrapper = mount(RichTextComposer, {
      props: {
        modelValue: '',
      },
      attachTo: document.body,
    })
    await waitForEditor(wrapper)

    typeText(wrapper, '`code`')
    await flushPromises()

    expect(editorInstance(wrapper).getHTML()).toContain('<code>code</code>')
  })
})

describe('RichTextComposer task URL paste', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('replaces a copied canonical task URL with one atomic task entity and serializes it on submit', async () => {
    const task = taskFixture()
    tasksApiMocks.tasksGet.mockResolvedValue(task)
    const wrapper = mount(RichTextComposer, {
      props: {
        modelValue: '',
        enableMessageEntities: true,
      },
      attachTo: document.body,
    })
    await waitForEditor(wrapper)

    await pasteText(wrapper, canonicalTaskUrl())
    await flushPromises()
    await nextTick()

    expect(tasksApiMocks.tasksGet).toHaveBeenCalledWith('TASK-42')
    const content = editorInstance(wrapper).getJSON().content?.[0]?.content
    expect(content).toHaveLength(1)
    expect(content?.[0]).toMatchObject({
      type: 'messageEntity',
      attrs: {
        kind: 'task',
        targetId: task.id,
        label: '@TASK-42 Fix task URL mentions',
        href: '/tasks/task-42',
      },
    })

    await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Enter', ctrlKey: true })
    await flushPromises()

    expect(wrapper.emitted('submit')).toEqual([[
      {
        body: '@TASK-42 Fix task URL mentions',
        entities: [{
          kind: 'task',
          targetId: task.id,
          label: '@TASK-42 Fix task URL mentions',
          href: '/tasks/task-42',
          start: 0,
          end: '@TASK-42 Fix task URL mentions'.length,
        }],
      },
    ]])
  })

  it('keeps the async task URL range mapped when the user types after the paste', async () => {
    const lookup = deferred<Task>()
    const task = taskFixture()
    tasksApiMocks.tasksGet.mockReturnValueOnce(lookup.promise)
    const wrapper = mount(RichTextComposer, {
      props: {
        modelValue: '',
        enableMessageEntities: true,
      },
      attachTo: document.body,
    })
    await waitForEditor(wrapper)

    await pasteText(wrapper, canonicalTaskUrl())
    expect(tasksApiMocks.tasksGet).toHaveBeenCalledWith('TASK-42')
    typeText(wrapper, ' plus context')

    lookup.resolve(task)
    await flushPromises()
    await nextTick()

    const content = editorInstance(wrapper).getJSON().content?.[0]?.content
    expect(content).toEqual([
      expect.objectContaining({
        type: 'messageEntity',
        attrs: expect.objectContaining({
          kind: 'task',
          targetId: task.id,
          label: '@TASK-42 Fix task URL mentions',
          href: '/tasks/task-42',
        }),
      }),
      {
        type: 'text',
        text: ' plus context',
      },
    ])
  })

  it('does not submit the raw URL while its task lookup is pending', async () => {
    const lookup = deferred<Task>()
    const task = taskFixture()
    tasksApiMocks.tasksGet.mockReturnValueOnce(lookup.promise)
    const wrapper = mount(RichTextComposer, {
      props: {
        modelValue: '',
        enableMessageEntities: true,
      },
      attachTo: document.body,
    })
    await waitForEditor(wrapper)

    await pasteText(wrapper, canonicalTaskUrl())
    await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Enter', ctrlKey: true })
    await flushPromises()

    expect(wrapper.emitted('submit')).toBeFalsy()

    lookup.resolve(task)
    await flushPromises()
    await nextTick()
    await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Enter', ctrlKey: true })
    await flushPromises()

    expect(wrapper.emitted('submit')?.[0]?.[0]).toMatchObject({
      body: '@TASK-42 Fix task URL mentions',
      entities: [expect.objectContaining({
        kind: 'task',
        targetId: task.id,
        href: '/tasks/task-42',
      })],
    })
  })

  it('clears a pending lookup when an external draft value replaces the editor', async () => {
    const lookup = deferred<Task>()
    tasksApiMocks.tasksGet.mockReturnValueOnce(lookup.promise)
    const wrapper = mount(RichTextComposer, {
      props: {
        modelValue: '',
        enableMessageEntities: true,
      },
      attachTo: document.body,
    })
    await waitForEditor(wrapper)

    await pasteText(wrapper, canonicalTaskUrl())
    await wrapper.setProps({ modelValue: 'New conversation draft' })
    await flushPromises()
    await nextTick()

    expect(wrapper.emitted('pending-task-url-paste-change')).toEqual([[true], [false]])
    await wrapper.get('.ProseMirror').trigger('keydown', { key: 'Enter', ctrlKey: true })
    await flushPromises()
    expect(wrapper.emitted('submit')?.[0]?.[0]).toEqual({
      body: 'New conversation draft',
      entities: [],
    })

    lookup.resolve(taskFixture())
    await flushPromises()
    await nextTick()

    expect(editorInstance(wrapper).getText()).toBe('New conversation draft')
  })

  it('keeps an edited pasted URL as text when its lookup resolves later', async () => {
    const lookup = deferred<Task>()
    const task = taskFixture()
    tasksApiMocks.tasksGet.mockReturnValueOnce(lookup.promise)
    const wrapper = mount(RichTextComposer, {
      props: {
        modelValue: '',
        enableMessageEntities: true,
      },
      attachTo: document.body,
    })
    await waitForEditor(wrapper)

    const url = canonicalTaskUrl()
    await pasteText(wrapper, url)
    const editIndex = url.indexOf('task-42') + 4
    const editedUrl = `${url.slice(0, editIndex)}x${url.slice(editIndex)}`
    const editor = editorInstance(wrapper)
    editor.view.dispatch(editor.state.tr.insertText('x', 1 + editIndex))

    lookup.resolve(task)
    await flushPromises()
    await nextTick()

    const content = editor.getJSON().content?.[0]?.content
    expect(content).toEqual([
      {
        type: 'text',
        text: editedUrl,
      },
    ])
    expect(content?.some((node: { type?: string }) => node.type === 'messageEntity')).toBe(false)
  })

  it('keeps a formatted pasted URL as text when its lookup resolves later', async () => {
    const lookup = deferred<Task>()
    const task = taskFixture()
    tasksApiMocks.tasksGet.mockReturnValueOnce(lookup.promise)
    const wrapper = mount(RichTextComposer, {
      props: {
        modelValue: '',
        enableMessageEntities: true,
      },
      attachTo: document.body,
    })
    await waitForEditor(wrapper)

    const url = canonicalTaskUrl()
    await pasteText(wrapper, url)
    const editor = editorInstance(wrapper)
    editor.chain().setTextSelection({ from: 1, to: url.length + 1 }).setBold().run()

    lookup.resolve(task)
    await flushPromises()
    await nextTick()

    expect(editor.getJSON().content?.[0]?.content).toEqual([{
      type: 'text',
      marks: [{ type: 'bold' }],
      text: url,
    }])
  })

  it('leaves the pasted URL as ordinary text when its task lookup fails', async () => {
    tasksApiMocks.tasksGet.mockRejectedValueOnce(new Error('Task not found'))
    const wrapper = mount(RichTextComposer, {
      props: {
        modelValue: '',
        enableMessageEntities: true,
      },
      attachTo: document.body,
    })
    await waitForEditor(wrapper)

    const url = canonicalTaskUrl()
    await pasteText(wrapper, url)
    await flushPromises()
    await nextTick()

    expect(tasksApiMocks.tasksGet).toHaveBeenCalledWith('TASK-42')
    expect(editorInstance(wrapper).getJSON().content?.[0]?.content).toEqual([
      {
        type: 'text',
        text: url,
      },
    ])
  })

  it('handles pasted files before attempting a task URL lookup', async () => {
    const onFiles = vi.fn()
    const file = new File(['image'], 'task.png', { type: 'image/png' })
    const wrapper = mount(RichTextComposer, {
      props: {
        modelValue: '',
        enableMessageEntities: true,
        onFiles,
      },
      attachTo: document.body,
    })
    await waitForEditor(wrapper)

    await pasteText(wrapper, canonicalTaskUrl(), [file])
    await flushPromises()

    expect(onFiles).toHaveBeenCalledWith([file])
    expect(tasksApiMocks.tasksGet).not.toHaveBeenCalled()
    expect(editorInstance(wrapper).getText()).toBe('')
  })
})
