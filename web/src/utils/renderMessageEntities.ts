import type { MessageEntity } from '@/stores/chat'
import { escapeHtml, renderMarkdownToHtml } from '@/utils/markdown'
import { sortMessageEntities } from '@/utils/messageEntities'

function renderEntity(entity: MessageEntity): string {
  const label = escapeHtml(entity.label)
  const targetId = escapeHtml(entity.targetId)
  if (entity.kind === 'user') {
    return `<button type="button" class="inline rounded px-0.5 font-medium text-accent hover:bg-accent/10 hover:text-accent-hover" data-message-entity-kind="user" data-target-id="${targetId}">${label}</button>`
  }

  const href = escapeHtml(entity.href)
  return `<a href="${href}" class="font-medium text-accent hover:text-accent-hover underline decoration-accent/40" data-message-entity-kind="${escapeHtml(entity.kind)}" data-target-id="${targetId}">${label}</a>`
}

export function renderMessageBodyWithEntities(body: string, entities: MessageEntity[]): string {
  if (!body) return ''
  if (entities.length === 0) {
    return renderMarkdownToHtml(body)
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
  return html
}
