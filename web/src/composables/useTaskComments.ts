import { onBeforeUnmount, ref, watch } from 'vue'
import { tasksListComments, type TaskComment } from '@/services/http/tasksApi'
import { useChatStore } from '@/stores/chat'
import { useWsStore } from '@/stores/ws'

/** HTTP owns full comment DTOs; ordered WS events invalidate the open task. */
export function useTaskComments(taskId: () => string) {
  const chat = useChatStore()
  const ws = useWsStore()
  const comments = ref<TaskComment[]>([])
  const loading = ref(false)
  const error = ref('')
  let generation = 0
  let disposed = false
  let pending: { generation: number; dirty: boolean; promise: Promise<void> } | null = null

  function registerAuthor(comment: TaskComment) {
    chat.registerUserIdentity(comment.author_id, comment.author_name, undefined, comment.author_avatar_url)
  }

  function sort(items: TaskComment[]): TaskComment[] {
    return [...items].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || a.id.localeCompare(b.id))
  }

  function upsert(comment: TaskComment) {
    if (disposed || comment.task_id !== taskId()) return
    registerAuthor(comment)
    comments.value = sort([comment, ...comments.value.filter(item => item.id !== comment.id)])
    // A response started before this local write must not replace it.
    if (pending?.generation === generation) pending.dirty = true
  }

  function refresh(): Promise<void> {
    if (disposed || !taskId()) return Promise.resolve()
    if (pending?.generation === generation) {
      pending.dirty = true
      return pending.promise
    }
    const id = taskId()
    const request = { generation, dirty: false, promise: Promise.resolve() }
    pending = request
    const isCurrent = () => !disposed && request.generation === generation && id === taskId()
    request.promise = (async () => {
      try {
        do {
          request.dirty = false
          try {
            const rows = await tasksListComments(id)
            if (!isCurrent()) return
            if (!request.dirty) {
              rows.forEach(registerAuthor)
              comments.value = sort(rows)
              error.value = ''
            }
          } catch (e) {
            if (!isCurrent()) return
            error.value = e instanceof Error ? e.message : 'Failed to load comments'
          }
        } while (request.dirty && isCurrent())
      } finally {
        if (pending === request) {
          pending = null
          if (isCurrent()) loading.value = false
        }
      }
    })()
    return request.promise
  }

  const unsubscribe = chat.onTaskCommentCreated(event => {
    if (event.taskId === taskId()) void refresh()
  })
  watch(taskId, () => {
    generation++
    comments.value = []
    error.value = ''
    loading.value = Boolean(taskId())
    void refresh()
  }, { immediate: true, flush: 'sync' })
  watch(() => ws.state, (state, previous) => {
    if (state === 'LIVE_SYNCED' && previous !== state) void refresh()
  })
  onBeforeUnmount(() => {
    disposed = true
    generation++
    unsubscribe()
  })

  return { comments, loading, error, refresh, upsert }
}
