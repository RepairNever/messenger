import { beforeEach, describe, expect, it, vi } from 'vitest'
import { documentsSearchDocuments } from '@/services/http/documentsApi'
import { tasksListTasks, tasksListUsers } from '@/services/http/tasksApi'
import {
  buildDocumentMentionHref,
  buildTaskMentionHref,
  buildUserMentionHref,
  decorateDescriptionMentionAnchors,
  decorateDescriptionMentionHtml,
  parseUserMentionHref,
  resetDescriptionMentionCacheForTests,
  searchDescriptionMentionSuggestions,
} from '@/utils/descriptionMentions'

vi.mock('@/services/http/tasksApi', () => ({
  tasksListUsers: vi.fn(),
  tasksListTasks: vi.fn(),
}))

vi.mock('@/services/http/documentsApi', () => ({
  documentsSearchDocuments: vi.fn(),
}))

describe('descriptionMentions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetDescriptionMentionCacheForTests()
    vi.mocked(tasksListUsers).mockResolvedValue([
      {
        id: 'user-1',
        display_name: 'Alice Example',
        email: 'alice@example.com',
        avatar_url: 'https://example.com/alice.png',
      },
      {
        id: 'user-2',
        display_name: 'Bob Example',
        email: 'bob@example.com',
      },
    ])
    vi.mocked(tasksListTasks).mockResolvedValue({
      groups: [
        {
          status: { id: 'status-1', code: 'todo', name: 'Todo', sort_order: 1 },
          tasks: [
            {
              id: 'task-1',
              public_id: 'TASK-123',
              title: 'Fix search',
              template_id: 'tpl-1',
              template_snapshot_prefix: 'TASK',
              status_id: 'status-1',
              created_at: '2026-04-08T00:00:00Z',
              updated_at: '2026-04-08T00:00:00Z',
            },
          ],
          total: 1,
          page: 1,
          page_size: 10,
        },
      ],
      grand_total: 1,
    })
    vi.mocked(documentsSearchDocuments).mockResolvedValue([
      {
        id: 'doc-1',
        teamspace_id: 'teamspace-1',
        teamspace_name: 'Product',
        title: 'Release notes',
        snippet: 'Current rollout notes',
      },
    ])
  })

  it('builds and parses user mention hrefs', () => {
    const href = buildUserMentionHref('user-1')

    expect(href).toBe('msgnr-mention://user/user-1')
    expect(parseUserMentionHref(href)).toEqual({ userId: 'user-1' })
  })

  it('returns filtered user, task, and document suggestions', async () => {
    const results = await searchDescriptionMentionSuggestions('ali')

    expect(results[0]).toMatchObject({
      kind: 'user',
      id: 'user-1',
      label: '@Alice Example',
      href: 'msgnr-mention://user/user-1',
    })
    expect(results).toContainEqual(expect.objectContaining({
      kind: 'task',
      id: 'task-1',
      label: '@TASK-123 Fix search',
      href: buildTaskMentionHref('TASK-123'),
    }))
    expect(results).toContainEqual(expect.objectContaining({
      kind: 'document',
      id: 'doc-1',
      label: '@Release notes',
      href: buildDocumentMentionHref('doc-1'),
    }))
    expect(tasksListTasks).toHaveBeenCalledWith(expect.objectContaining({
      search: 'ali',
      include_subtasks: true,
    }))
    expect(documentsSearchDocuments).toHaveBeenCalledWith('ali')
  })

  it('prefers globally sorted flat task search results when present', async () => {
    vi.mocked(tasksListUsers).mockResolvedValueOnce([])
    vi.mocked(tasksListTasks).mockResolvedValueOnce({
      tasks: [
        {
          id: 'task-flat',
          public_id: 'TASK-999',
          title: 'Flat newest',
          template_id: 'tpl-1',
          template_snapshot_prefix: 'TASK',
          status_id: 'status-2',
          created_at: '2026-04-09T00:00:00Z',
          updated_at: '2026-04-09T00:00:00Z',
        },
      ],
      groups: [
        {
          status: { id: 'status-1', code: 'todo', name: 'Todo', sort_order: 1 },
          tasks: [
            {
              id: 'task-grouped',
              public_id: 'TASK-123',
              title: 'Grouped fallback',
              template_id: 'tpl-1',
              template_snapshot_prefix: 'TASK',
              status_id: 'status-1',
              created_at: '2026-04-08T00:00:00Z',
              updated_at: '2026-04-08T00:00:00Z',
            },
          ],
          total: 1,
          page: 1,
          page_size: 10,
        },
      ],
      grand_total: 2,
    })
    vi.mocked(documentsSearchDocuments).mockResolvedValueOnce([])

    const results = await searchDescriptionMentionSuggestions('task')

    expect(results).toContainEqual(expect.objectContaining({
      kind: 'task',
      id: 'task-flat',
      label: '@TASK-999 Flat newest',
    }))
    expect(results).not.toContainEqual(expect.objectContaining({
      kind: 'task',
      id: 'task-grouped',
    }))
  })

  it('skips document search for empty mention queries because document search requires text', async () => {
    await searchDescriptionMentionSuggestions('')

    expect(documentsSearchDocuments).not.toHaveBeenCalled()
  })

  it('decorates rendered user, task, and document mention anchors', () => {
    const root = document.createElement('div')
    root.innerHTML = [
      '<a href="msgnr-mention://user/user-1">@Alice Example</a>',
      '<a href="/tasks/task-123">@TASK-123 Fix search</a>',
      '<a href="/documents/doc-1">@Release notes</a>',
    ].join('')

    decorateDescriptionMentionAnchors(root)

    const anchors = root.querySelectorAll('a')
    expect(anchors[0].dataset.descriptionMentionKind).toBe('user')
    expect(anchors[0].dataset.userId).toBe('user-1')
    expect(anchors[0].className).toContain('mention-link')
    expect(anchors[1].dataset.descriptionMentionKind).toBe('task')
    expect(anchors[1].className).toContain('mention-link')
    expect(anchors[2].dataset.descriptionMentionKind).toBe('document')
    expect(anchors[2].className).toContain('mention-link')
  })

  it('decorates mention html strings', () => {
    const html = decorateDescriptionMentionHtml('<p><a href="msgnr-mention://user/user-1">@Alice Example</a></p>')

    expect(html).toContain('data-description-mention-kind="user"')
    expect(html).toContain('mention-link')
  })
})
