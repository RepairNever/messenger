import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, nextTick, reactive } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { useTaskComments } from '@/composables/useTaskComments'
import { tasksListComments, type TaskComment } from '@/services/http/tasksApi'
import type { TaskCommentCreatedEvent } from '@/shared/proto/packets_pb'

const mocks = vi.hoisted(() => ({
  handlers: new Set<(event: TaskCommentCreatedEvent) => void>(),
  registerUserIdentity: vi.fn(),
}))
const ws = reactive({ state: 'LIVE_SYNCED' })
vi.mock('@/stores/ws', () => ({ useWsStore: () => ws }))
vi.mock('@/stores/chat', () => ({ useChatStore: () => ({
  registerUserIdentity: mocks.registerUserIdentity,
  onTaskCommentCreated: (handler: (event: TaskCommentCreatedEvent) => void) => {
    mocks.handlers.add(handler)
    return () => mocks.handlers.delete(handler)
  },
}) }))
vi.mock('@/services/http/tasksApi', () => ({ tasksListComments: vi.fn() }))

function comment(id = 'comment-1', taskId = 'task-1'): TaskComment {
  return {
    id, task_id: taskId, author_id: 'bot-id', author_name: 'Bot', author_avatar_url: '/bot.png',
    body: '**hello**', created_at: '2026-09-29T10:00:00Z', updated_at: '2026-09-29T10:00:00Z',
    attachments: [{ id: 'attachment-1', task_id: taskId, comment_id: id, file_name: 'note.txt',
      mime_type: 'text/plain', file_size: 12, uploaded_by: 'bot-id', created_at: '2026-09-29T10:00:00Z' }],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function emit(taskId = 'task-1') {
  mocks.handlers.forEach(handler => handler({ taskId } as TaskCommentCreatedEvent))
}

describe('useTaskComments', () => {
  let wrapper: VueWrapper | undefined
  function open() {
    let state!: ReturnType<typeof useTaskComments>
    wrapper = mount(defineComponent({
      props: { taskId: { type: String, required: true } },
      setup(props) { state = useTaskComments(() => props.taskId); return {} },
      template: '<div />',
    }), { props: { taskId: 'task-1' } })
    return state
  }
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.handlers.clear()
    ws.state = 'LIVE_SYNCED'
    vi.mocked(tasksListComments).mockResolvedValue([])
  })
  afterEach(() => { wrapper?.unmount(); wrapper = undefined })

  it('refreshes only the open task with complete attachments and author identity', async () => {
    const state = open()
    await flushPromises()
    emit('other-task')
    expect(tasksListComments).toHaveBeenCalledTimes(1)
    vi.mocked(tasksListComments).mockResolvedValue([comment()])
    emit()
    expect(state.loading.value).toBe(false)
    await flushPromises()
    expect(state.comments.value).toEqual([comment()])
    expect(mocks.registerUserIdentity).toHaveBeenCalledWith('bot-id', 'Bot', undefined, '/bot.png')
  })

  it('coalesces events during a request and loads again without applying its stale result', async () => {
    const first = deferred<TaskComment[]>()
    vi.mocked(tasksListComments).mockReturnValueOnce(first.promise).mockResolvedValue([comment('latest')])
    const state = open()
    emit(); emit(); emit()
    expect(tasksListComments).toHaveBeenCalledTimes(1)
    first.resolve([comment('stale')])
    await flushPromises()
    expect(tasksListComments).toHaveBeenCalledTimes(2)
    expect(state.comments.value.map(item => item.id)).toEqual(['latest'])
  })

  it.each(['success', 'failure'])('ignores old task responses after navigating away and back: %s', async (outcome) => {
    const first = deferred<TaskComment[]>()
    vi.mocked(tasksListComments).mockReturnValueOnce(first.promise)
    const state = open()
    await wrapper!.setProps({ taskId: 'task-2' })
    await flushPromises()
    vi.mocked(tasksListComments).mockResolvedValue([comment('current')])
    await wrapper!.setProps({ taskId: 'task-1' })
    await flushPromises()
    if (outcome === 'success') first.resolve([comment('old')])
    else first.reject(new Error('old task failure'))
    await flushPromises()
    expect(state.comments.value.map(item => item.id)).toEqual(['current'])
    expect(state.error.value).toBe('')
    expect(state.loading.value).toBe(false)
  })

  it('keeps local writes through an older fetch and deduplicates the HTTP/WS result', async () => {
    const state = open()
    await flushPromises()
    const stale = deferred<TaskComment[]>()
    vi.mocked(tasksListComments).mockReturnValueOnce(stale.promise).mockResolvedValue([comment()])
    emit()
    state.upsert(comment())
    state.upsert(comment())
    stale.resolve([])
    await flushPromises()
    expect(state.comments.value).toEqual([comment()])
    expect(tasksListComments).toHaveBeenCalledTimes(3)
  })

  it('retains visible comments after failure and refreshes on reconnect', async () => {
    vi.mocked(tasksListComments).mockResolvedValueOnce([comment()])
    const state = open()
    await flushPromises()
    vi.mocked(tasksListComments).mockRejectedValueOnce(new Error('offline'))
    emit()
    await flushPromises()
    expect(state.comments.value).toHaveLength(1)
    expect(state.error.value).toBe('offline')
    ws.state = 'DISCONNECTED'
    await nextTick()
    vi.mocked(tasksListComments).mockResolvedValue([comment('after-reconnect')])
    ws.state = 'LIVE_SYNCED'
    await flushPromises()
    expect(state.comments.value[0].id).toBe('after-reconnect')
    expect(state.error.value).toBe('')
  })

  it('unsubscribes and discards pending responses on unmount', async () => {
    const first = deferred<TaskComment[]>()
    vi.mocked(tasksListComments).mockReturnValueOnce(first.promise)
    const state = open()
    wrapper!.unmount(); wrapper = undefined
    first.resolve([comment()])
    emit()
    await flushPromises()
    expect(mocks.handlers.size).toBe(0)
    expect(state.comments.value).toEqual([])
    expect(mocks.registerUserIdentity).not.toHaveBeenCalled()
    expect(tasksListComments).toHaveBeenCalledTimes(1)
  })
})
