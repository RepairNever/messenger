import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import RichTextComposer from '@/components/RichTextComposer.vue'
import type { Task } from '@/services/http/tasksApi'

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
