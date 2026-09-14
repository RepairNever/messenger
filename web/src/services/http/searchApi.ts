import { AxiosError } from 'axios'
import { createAuthenticatedClient } from './client'

const http = createAuthenticatedClient()

export class SearchApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message)
    this.name = 'SearchApiError'
  }
}

function handleError(e: unknown): never {
  if (e instanceof AxiosError && e.response) {
    const msg: string = e.response.data?.error ?? e.response.statusText
    throw new SearchApiError(msg, e.response.status)
  }
  throw new SearchApiError('Network error', 0)
}

export type MessageSearchSource = 'chat_message' | 'task_comment' | 'task_comment_thread'

export interface MessageSearchResult {
  source: MessageSearchSource
  id: string
  body: string
  created_at: string
  actor_id: string
  actor_name: string
  conversation_id?: string
  conversation_title?: string
  conversation_kind?: 'channel' | 'dm'
  conversation_visibility?: 'public' | 'private' | 'dm'
  message_id?: string
  thread_root_message_id?: string
  task_id?: string
  task_public_id?: string
  task_title?: string
  task_comment_id?: string
}

export interface MessageSearchResponse {
  total_count: number
  items: MessageSearchResult[]
}

export async function searchMessages(params: {
  q: string
  conversationId?: string
  limit?: number
}): Promise<MessageSearchResponse> {
  try {
    const { data } = await http.get<MessageSearchResponse>('/api/search/messages', {
      params: {
        q: params.q,
        ...(params.conversationId ? { conversation_id: params.conversationId } : {}),
        ...(params.limit ? { limit: params.limit } : {}),
      },
    })
    return {
      total_count: data.total_count ?? 0,
      items: data.items ?? [],
    }
  } catch (e) {
    handleError(e)
  }
}
