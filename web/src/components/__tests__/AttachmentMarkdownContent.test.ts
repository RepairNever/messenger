import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AttachmentMarkdownContent from '@/components/AttachmentMarkdownContent.vue'
import router from '@/router'
import { fetchOwnedAttachmentBlob } from '@/services/http/attachmentOwnersApi'
import { tasksFetchStagedAttachmentBlob, tasksListUsers } from '@/services/http/tasksApi'
import { resetDescriptionMentionCacheForTests } from '@/utils/descriptionMentions'

vi.mock('@/services/http/attachmentOwnersApi', () => ({
  fetchOwnedAttachmentBlob: vi.fn(),
}))

vi.mock('@/services/http/tasksApi', () => ({
  tasksListUsers: vi.fn(),
  tasksListTasks: vi.fn(),
  tasksFetchStagedAttachmentBlob: vi.fn(),
}))

vi.mock('@/services/http/documentsApi', () => ({
  documentsSearchDocuments: vi.fn(),
}))

describe('AttachmentMarkdownContent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    resetDescriptionMentionCacheForTests()
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:attachment')
    globalThis.URL.revokeObjectURL = vi.fn()
    window.open = vi.fn(() => ({
      location: {
        replace: vi.fn(),
      },
      close: vi.fn(),
    } as unknown as Window))
    vi.mocked(fetchOwnedAttachmentBlob).mockResolvedValue(new Blob(['blob'], { type: 'application/octet-stream' }))
    vi.mocked(tasksListUsers).mockResolvedValue([])
    vi.mocked(tasksFetchStagedAttachmentBlob).mockResolvedValue(new Blob(['staged'], { type: 'image/png' }))
  })

  it('renders image tokens with fetched previews and opens file tokens in a new tab', async () => {
    const wrapper = mount(AttachmentMarkdownContent, {
      props: {
        markdown: [
          '![Photo](msgnr-attachment://task/task-1/att-1)',
          '',
          '[Spec.pdf](msgnr-attachment://document/doc-1/att-2)',
        ].join('\n'),
      },
    })

    await flushPromises()

    expect(fetchOwnedAttachmentBlob).toHaveBeenCalledWith('task', 'task-1', 'att-1')
    expect(wrapper.get('[data-testid="attachment-markdown-image-img"]').attributes('src')).toBe('blob:attachment')

    await wrapper.get('[data-testid="attachment-markdown-file-link"]').trigger('click')
    await flushPromises()

    expect(fetchOwnedAttachmentBlob).toHaveBeenCalledWith('document', 'doc-1', 'att-2')
    expect(window.open).toHaveBeenCalledWith('about:blank', '_blank')
    const opened = vi.mocked(window.open).mock.results[0]?.value as { location: { replace: ReturnType<typeof vi.fn> } }
    expect(opened.location.replace).toHaveBeenCalledWith('blob:attachment')
    vi.advanceTimersByTime(1_000)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:attachment')
  })

  it('opens markdown links in the system browser when clicked', async () => {
    const wrapper = mount(AttachmentMarkdownContent, {
      props: {
        markdown: '[Docs](https://example.com/docs)',
      },
    })

    await flushPromises()

    await wrapper.get('.markdown-body a').trigger('click')
    await flushPromises()

    expect(window.open).toHaveBeenCalledWith('https://example.com/docs', '_blank')
  })

  it('renders fenced code blocks with syntax highlighting', async () => {
    const wrapper = mount(AttachmentMarkdownContent, {
      props: {
        markdown: '```go\npackage main\nfunc main() {}\n```',
      },
    })

    await flushPromises()

    expect(wrapper.find('.markdown-body pre code.language-go').exists()).toBe(true)
    expect(wrapper.html()).toContain('<span class="hljs-keyword">package</span>')
  })

  it('does not navigate the current tab when the popup is blocked', async () => {
    window.open = vi.fn(() => null)

    const wrapper = mount(AttachmentMarkdownContent, {
      props: {
        markdown: '[Spec.pdf](msgnr-attachment://document/doc-1/att-2)',
      },
    })

    await wrapper.get('[data-testid="attachment-markdown-file-link"]').trigger('click')
    await flushPromises()

    expect(fetchOwnedAttachmentBlob).not.toHaveBeenCalled()
    expect(window.open).toHaveBeenCalledWith('about:blank', '_blank')
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('opens a user popover for rendered user mention links', async () => {
    vi.mocked(tasksListUsers).mockResolvedValue([
      {
        id: 'user-1',
        display_name: 'Alice Example',
        email: 'alice@example.com',
        avatar_url: 'https://example.com/alice.png',
      },
    ])

    const wrapper = mount(AttachmentMarkdownContent, {
      props: {
        markdown: 'Hello [@Alice Example](msgnr-mention://user/user-1)',
      },
      attachTo: document.body,
      global: {
        stubs: {
          UserAvatar: true,
        },
      },
    })

    await flushPromises()
    await wrapper.get('.markdown-body a').trigger('click')
    await flushPromises()

    const card = document.body.querySelector('[data-testid="attachment-markdown-user-card"]')
    expect(card?.textContent).toContain('Alice Example')
    expect(card?.textContent).toContain('alice@example.com')
  })

  it('routes rendered task mention links through vue-router', async () => {
    const pushSpy = vi.spyOn(router, 'push').mockResolvedValue(undefined as never)
    const wrapper = mount(AttachmentMarkdownContent, {
      props: {
        markdown: 'See [@TASK-123 Fix search](/tasks/task-123)',
      },
    })

    await flushPromises()
    await wrapper.get('.markdown-body a').trigger('click')
    await flushPromises()

    expect(pushSpy).toHaveBeenCalledWith('/tasks/task-123')
    pushSpy.mockRestore()
  })
})
