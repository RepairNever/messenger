import type { MessageEntity } from '@/stores/chat'
import { escapeHtml, renderMarkdownToHtml } from '@/utils/markdown'
import { isSafeMessageUrl } from '@/utils/linkNavigation'
import { sortMessageEntities } from '@/utils/messageEntities'

function renderEntity(entity: MessageEntity): string {
  const label = escapeHtml(entity.label)
  const targetId = escapeHtml(entity.targetId)
  if (entity.kind === 'user') {
    return `<button type="button" class="inline rounded px-0.5 font-medium text-accent-text hover:bg-accent/10 hover:text-accent-text" data-message-entity-kind="user" data-target-id="${targetId}">${label}</button>`
  }

  // Server-normalized hrefs are always safe; render as plain text anyway if a
  // non-allowlisted scheme ever slips through storage or sync.
  if (!isSafeMessageUrl(entity.href)) {
    return label
  }

  const href = escapeHtml(entity.href)
  return `<a href="${href}" class="font-medium text-accent-text hover:text-accent-text underline decoration-accent-text/40" data-message-entity-kind="${escapeHtml(entity.kind)}" data-target-id="${targetId}">${label}</a>`
}

export function renderMessageBodyWithEntities(body: string, entities: MessageEntity[]): string {
  if (!body) return ''
  if (entities.length === 0) {
    return highlightBareMentions(renderMarkdownToHtml(body))
  }

  const sorted = sortMessageEntities(entities)
  let cursor = 0
  let tokenizedBody = ''
  const replacements: Array<{ token: string; html: string }> = []

  for (const entity of sorted) {
    if (entity.start < cursor || entity.end > body.length || entity.start >= entity.end) {
      continue
    }
    const token = `MSGNRENTITYTOKEN${replacements.length}END`
    tokenizedBody += body.slice(cursor, entity.start)
    tokenizedBody += token
    replacements.push({
      token,
      html: renderEntity(entity),
    })
    cursor = entity.end
  }

  tokenizedBody += body.slice(cursor)
  let html = renderMarkdownToHtml(tokenizedBody)
  for (const replacement of replacements) {
    html = html.replace(replacement.token, replacement.html)
  }
  return highlightBareMentions(html)
}

const BARE_MENTION_PATTERN = /(^|[^\p{L}\p{N}_@])@(\p{L}[\p{L}\p{N}_-]*(?:\.\p{L}[\p{L}\p{N}_-]+)*)/gu
const MENTION_SKIP_TAG_PATTERN = /^<\/?(?:button|a|code|pre)\b/i

// Color bare @name tokens (no matching entity) with the accent-text token.
// Splits on tags so attributes are never touched, and skips text inside
// entity markup, links, and code blocks.
function highlightBareMentions(html: string): string {
  const parts = html.split(/(<[^>]*>)/)
  let skipDepth = 0
  return parts
    .map((part) => {
      if (part.startsWith('<')) {
        if (MENTION_SKIP_TAG_PATTERN.test(part)) {
          skipDepth = Math.max(0, skipDepth + (part.startsWith('</') ? -1 : 1))
        }
        return part
      }
      if (skipDepth > 0) return part
      return part.replace(BARE_MENTION_PATTERN, (_match, prefix: string, name: string) => (
        `${prefix}<span class="text-accent-text" data-mention-text>@${name}</span>`
      ))
    })
    .join('')
}
