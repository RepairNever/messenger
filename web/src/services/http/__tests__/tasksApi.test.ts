import { beforeEach, describe, expect, it, vi } from 'vitest'

const getMock = vi.fn()
const postMock = vi.fn()
const patchMock = vi.fn()

vi.mock('@/services/http/client', () => ({
  createAuthenticatedClient: () => ({
    get: getMock,
    post: postMock,
    patch: patchMock,
    delete: vi.fn(),
  }),
}))

describe('tasksApi task list queries', () => {
  beforeEach(() => {
    getMock.mockReset()
    postMock.mockReset()
    patchMock.mockReset()
  })

  it('serializes list mode params for GET /api/tasks', async () => {
    getMock.mockResolvedValueOnce({ data: { groups: [], grand_total: 0 } })
    const { tasksListTasks } = await import('@/services/http/tasksApi')

    await tasksListTasks({
      search: 'abc',
      status_ids: ['status-1'],
      prefixes: ['BUG'],
      created_from: '2026-05-01',
      created_to: '2026-05-03',
      sort_by: 'created_at',
      sort_order: 'desc',
      page: 2,
      page_size: 50,
    })

    expect(getMock).toHaveBeenCalledTimes(1)
    const [url, config] = getMock.mock.calls[0]
    expect(url).toBe('/api/tasks')
    const query = String((config.params as URLSearchParams).toString())
    expect(query).toContain('search=abc')
    expect(query).toContain('status_id=status-1')
    expect(query).toContain('prefix=BUG')
    expect(query).toContain('created_from=2026-05-01')
    expect(query).toContain('created_to=2026-05-03')
    expect(query).toContain('sort_by=created_at')
    expect(query).toContain('sort_order=desc')
    expect(query).toContain('page=2')
    expect(query).toContain('page_size=50')
  })

  it('serializes grouped mode params for GET /api/tasks/grouped', async () => {
    getMock.mockResolvedValueOnce({
      data: { status_order: [], groups_by_status: {}, grand_total: 0, limit: 50 },
    })
    const { tasksListGrouped } = await import('@/services/http/tasksApi')

    await tasksListGrouped({
      search: 'need',
      status_ids: ['status-1'],
      prefixes: ['QA'],
      field_filters: [{ field_definition_id: 'fd-1', enum_codes: ['high'] }],
      dictionary_filters: [{ dictionary_id: 'dict-1', enum_codes: ['high', 'medium'] }],
    }, 40)

    expect(getMock).toHaveBeenCalledTimes(1)
    const [url, config] = getMock.mock.calls[0]
    expect(url).toBe('/api/tasks/grouped')
    const query = String((config.params as URLSearchParams).toString())
    expect(query).toContain('search=need')
    expect(query).toContain('status_id=status-1')
    expect(query).toContain('prefix=QA')
    expect(query).toContain('field_fd-1_enum=high')
    expect(query).toContain('dictionary_dict-1_enum=high')
    expect(query).toContain('dictionary_dict-1_enum=medium')
    expect(query).toContain('limit=40')
  })

  it('serializes portion params for GET /api/tasks/status/:id/portion', async () => {
    getMock.mockResolvedValueOnce({
      data: {
        status_id: 'status-1',
        items: [],
        total: 0,
        offset: 0,
        limit: 50,
        next_offset: 0,
        has_more: false,
      },
    })
    const { tasksListStatusPortion } = await import('@/services/http/tasksApi')

    await tasksListStatusPortion(
      'status-1',
      {
        search: 'n',
        field_filters: [{ field_definition_id: 'fd-2', user_ids: ['u-1'] }],
      },
      30,
      20,
    )

    expect(getMock).toHaveBeenCalledTimes(1)
    const [url, config] = getMock.mock.calls[0]
    expect(url).toBe('/api/tasks/status/status-1/portion')
    const query = String((config.params as URLSearchParams).toString())
    expect(query).toContain('search=n')
    expect(query).toContain('field_fd-2_user=u-1')
    expect(query).toContain('offset=30')
    expect(query).toContain('limit=20')
  })

  it('hits description history endpoint', async () => {
    getMock.mockResolvedValueOnce({ data: [] })
    const { tasksListTaskDescriptionHistory } = await import('@/services/http/tasksApi')

    await tasksListTaskDescriptionHistory('task-1')

    expect(getMock).toHaveBeenCalledTimes(1)
    expect(getMock).toHaveBeenCalledWith('/api/tasks/task-1/description/history')
  })

  it('requests task change history with cursor pagination', async () => {
    getMock.mockResolvedValueOnce({ data: { items: [], next_cursor: 'next' } })
    const { tasksListTaskChangeHistory } = await import('@/services/http/tasksApi')

    await tasksListTaskChangeHistory('task-1', { cursor: 'cursor-1', limit: 50 })

    expect(getMock).toHaveBeenCalledWith('/api/tasks/task-1/history', {
      params: { cursor: 'cursor-1', limit: 50 },
    })
  })

  it('uploads one task picker selection through the grouped attachment endpoint', async () => {
    postMock.mockResolvedValueOnce({ data: { attachments: [], errors: [] } })
    const { tasksUploadAttachments } = await import('@/services/http/tasksApi')
    const first = new File(['one'], 'one.txt', { type: 'text/plain' })
    const second = new File(['two'], 'two.txt', { type: 'text/plain' })

    await tasksUploadAttachments('task-1', [first, second])

    const [url, form, config] = postMock.mock.calls[0]
    expect(url).toBe('/api/tasks/task-1/attachments/batch')
    expect([...((form as FormData).getAll('files'))].map(file => (file as File).name)).toEqual(['one.txt', 'two.txt'])
    expect(config).toEqual({ headers: { 'Content-Type': 'multipart/form-data' } })
  })

  it('forwards force_snapshot for PATCH /api/tasks/:id/description', async () => {
    patchMock.mockResolvedValueOnce({ data: { id: 'task-1', description: 'x', updated_at: '2026-01-01T00:00:00Z' } })
    const { tasksUpdateTaskDescription } = await import('@/services/http/tasksApi')

    await tasksUpdateTaskDescription('task-1', { description: 'x', force_snapshot: true })

    expect(patchMock).toHaveBeenCalledTimes(1)
    expect(patchMock).toHaveBeenCalledWith('/api/tasks/task-1/description', {
      description: 'x',
      force_snapshot: true,
    })
  })

  it('ensures a comment thread via POST /api/tasks/:id/comments/:comment_id/thread', async () => {
    postMock.mockResolvedValueOnce({
      data: {
        conversation_id: 'channel-1',
        thread_root_message_id: 'root-1',
        reply_count: 0,
      },
    })
    const { tasksEnsureCommentThread } = await import('@/services/http/tasksApi')

    const result = await tasksEnsureCommentThread('task-1', 'comment-1')

    expect(postMock).toHaveBeenCalledWith('/api/tasks/task-1/comments/comment-1/thread')
    expect(result.thread_root_message_id).toBe('root-1')
  })
})
