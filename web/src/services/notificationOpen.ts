export const NOTIFICATION_OPEN_MESSAGE_TYPE = 'NOTIFICATION_OPEN'
export const NOTIFICATION_OPEN_QUERY_FLAG = 'notificationOpen'
export const NOTIFICATION_OPEN_QUERY_VALUE = '1'

export interface NotificationOpenIntent {
  conversationId: string
  messageId?: string
  threadRootMessageId?: string
  url?: string
}

function firstString(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const first = value.find((item): item is string => typeof item === 'string')
    return first ?? ''
  }
  return ''
}

export function toNotificationOpenMessage(intent: NotificationOpenIntent) {
  return {
    type: NOTIFICATION_OPEN_MESSAGE_TYPE,
    conversationId: intent.conversationId,
    ...(intent.messageId ? { messageId: intent.messageId } : {}),
    ...(intent.threadRootMessageId ? { threadRootMessageId: intent.threadRootMessageId } : {}),
    ...(intent.url ? { url: intent.url } : {}),
  }
}

export function notificationOpenIntentFromMessage(data: unknown): NotificationOpenIntent | null {
  if (!data || typeof data !== 'object') return null
  const record = data as Record<string, unknown>
  if (firstString(record.type) !== NOTIFICATION_OPEN_MESSAGE_TYPE) return null

  const conversationId = firstString(record.conversationId).trim()
  if (!conversationId) return null

  const messageId = firstString(record.messageId).trim()
  const threadRootMessageId = firstString(record.threadRootMessageId).trim()
  const url = firstString(record.url).trim()
  return {
    conversationId,
    ...(messageId ? { messageId } : {}),
    ...(threadRootMessageId ? { threadRootMessageId } : {}),
    ...(url ? { url } : {}),
  }
}

export function notificationOpenIntentFromQuery(query: Record<string, unknown>): NotificationOpenIntent | null {
  if (firstString(query[NOTIFICATION_OPEN_QUERY_FLAG]) !== NOTIFICATION_OPEN_QUERY_VALUE) {
    return null
  }

  const conversationId = firstString(query.conversationId).trim()
  if (!conversationId) return null

  const messageId = firstString(query.messageId).trim()
  const threadRootMessageId = firstString(query.threadRootMessageId).trim()
  return {
    conversationId,
    ...(messageId ? { messageId } : {}),
    ...(threadRootMessageId ? { threadRootMessageId } : {}),
  }
}

export function stripNotificationOpenQuery<T extends Record<string, unknown>>(query: T): Record<string, unknown> {
  const next = { ...query }
  delete next[NOTIFICATION_OPEN_QUERY_FLAG]
  delete next.conversationId
  delete next.messageId
  delete next.threadRootMessageId
  return next
}

export function buildNotificationOpenUrl(
  targetUrl: string,
  intent: NotificationOpenIntent,
  baseUrl: string,
): string {
  const url = new URL(targetUrl || '/', baseUrl)
  url.searchParams.set(NOTIFICATION_OPEN_QUERY_FLAG, NOTIFICATION_OPEN_QUERY_VALUE)
  url.searchParams.set('conversationId', intent.conversationId)
  if (intent.messageId) {
    url.searchParams.set('messageId', intent.messageId)
  } else {
    url.searchParams.delete('messageId')
  }
  if (intent.threadRootMessageId) {
    url.searchParams.set('threadRootMessageId', intent.threadRootMessageId)
  } else {
    url.searchParams.delete('threadRootMessageId')
  }
  return url.toString()
}
