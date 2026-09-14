export interface ForwardedMessageAttribution {
  senderName: string
  conversationKind?: string
  conversationTitle?: string
  threadTitle?: string
}

function trimContext(value: string | undefined): string {
  return value?.trim() ?? ''
}

function shortenContext(value: string): string {
  const maxLength = 80
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength - 1).trimEnd()}...`
}

function formatConversationContext(kind: string | undefined, value: string): string {
  if (!value || value.startsWith('#') || value.startsWith('@')) return value
  if (kind === 'dm') return `@${value}`
  return `#${value}`
}

export function formatForwardedMessageLabel(info: ForwardedMessageAttribution): string {
  const sender = trimContext(info.senderName)
  const conversation = formatConversationContext(trimContext(info.conversationKind), trimContext(info.conversationTitle))
  const thread = shortenContext(trimContext(info.threadTitle))
  if (thread && conversation) return `Forwarded from ${sender} in thread "${thread}" (${conversation})`
  if (thread) return `Forwarded from ${sender} in thread "${thread}"`
  if (conversation) return `Forwarded from ${sender} in ${conversation}`
  return `Forwarded from ${sender}`
}
