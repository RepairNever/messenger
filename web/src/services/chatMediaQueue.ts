export const CHAT_MEDIA_REQUEST_CONCURRENCY = 4

export type ChatMediaRequestPriority = 'normal' | 'high'

export interface QueuedChatMediaRequest<T> {
  promise: Promise<T>
  cancel: () => void
}

export class ChatMediaRequestCancelledError extends Error {
  constructor() {
    super('Chat media request was cancelled')
    this.name = 'ChatMediaRequestCancelledError'
  }
}

interface PendingChatMediaRequest<T> {
  load: () => Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
  cancelled: boolean
  started: boolean
}

const pendingRequests: PendingChatMediaRequest<unknown>[] = []
let activeRequestCount = 0

/**
 * Limits image preview fetches across all mounted chat message bubbles. A
 * foreground lightbox request is placed ahead of viewport prefetches, while
 * still respecting the same global concurrency ceiling.
 */
export function enqueueChatMediaRequest<T>(
  load: () => Promise<T>,
  priority: ChatMediaRequestPriority = 'normal',
): QueuedChatMediaRequest<T> {
  let request!: PendingChatMediaRequest<T>
  const promise = new Promise<T>((resolve, reject) => {
    request = {
      load,
      resolve,
      reject,
      cancelled: false,
      started: false,
    }
  })

  const pendingRequest = request as PendingChatMediaRequest<unknown>
  if (priority === 'high') {
    pendingRequests.unshift(pendingRequest)
  } else {
    pendingRequests.push(pendingRequest)
  }
  drainChatMediaRequestQueue()

  return {
    promise,
    cancel: () => {
      if (request.started || request.cancelled) return
      request.cancelled = true
      request.reject(new ChatMediaRequestCancelledError())
    },
  }
}

export function isChatMediaRequestCancelled(error: unknown): boolean {
  return error instanceof ChatMediaRequestCancelledError
}

function drainChatMediaRequestQueue() {
  while (activeRequestCount < CHAT_MEDIA_REQUEST_CONCURRENCY && pendingRequests.length > 0) {
    const request = pendingRequests.shift()
    if (!request || request.cancelled) continue

    request.started = true
    activeRequestCount += 1
    void runChatMediaRequest(request)
  }
}

async function runChatMediaRequest(request: PendingChatMediaRequest<unknown>) {
  try {
    request.resolve(await request.load())
  } catch (error) {
    request.reject(error)
  } finally {
    activeRequestCount -= 1
    drainChatMediaRequestQueue()
  }
}
