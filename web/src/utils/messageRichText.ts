import type { JSONContent } from '@tiptap/core'
import type { MessageEntity } from '@/stores/chat'
import { escapeHtml } from '@/utils/html'
import { renderMarkdownToHtml } from '@/utils/markdown'
import { tiptapJsonToMarkdown } from '@/utils/tiptapMarkdown'

interface PlaceholderEntity {
  token: string
  entity: MessageEntity
}

function cloneNode(node: JSONContent | null | undefined, placeholders: PlaceholderEntity[]): JSONContent | null | undefined {
  if (!node) return node

  if (node.type === 'messageEntity') {
    const label = String(node.attrs?.label ?? '')
    const kind = node.attrs?.kind
    const targetId = String(node.attrs?.targetId ?? '')
    const href = String(node.attrs?.href ?? '')
    const token = `MSGNRENTITYTOKEN${placeholders.length}END`
    placeholders.push({
      token,
      entity: {
        kind: kind === 'task' || kind === 'document' ? kind : 'user',
        targetId,
        label,
        href,
        start: 0,
        end: 0,
      },
    })
    return {
      type: 'text',
      text: token,
    }
  }

  return {
    ...node,
    content: node.content?.map(child => cloneNode(child, placeholders)).filter(Boolean) as JSONContent[] | undefined,
  }
}

export function tiptapJsonToMessagePayload(doc: JSONContent | null | undefined): {
  body: string
  entities: MessageEntity[]
} {
  if (!doc) {
    return {
      body: '',
      entities: [],
    }
  }

  const placeholders: PlaceholderEntity[] = []
  const cloned = cloneNode(doc, placeholders)
  let body = tiptapJsonToMarkdown(cloned, { hardBreakStyle: 'newline' })
  const entities: MessageEntity[] = []

  for (const placeholder of placeholders) {
    const index = body.indexOf(placeholder.token)
    if (index === -1) continue
    body = `${body.slice(0, index)}${placeholder.entity.label}${body.slice(index + placeholder.token.length)}`
    entities.push({
      ...placeholder.entity,
      start: index,
      end: index + placeholder.entity.label.length,
    })
  }

  return {
    body,
    entities,
  }
}

export function renderMessageEditorHtml(body: string, entities: MessageEntity[]): string {
  if (!body) return ''
  if (!entities.length) return renderMarkdownToHtml(body)

  const sorted = [...entities].sort((a, b) => a.start - b.start)
  let cursor = 0
  let nextBody = ''

  sorted.forEach((entity, index) => {
    if (entity.start < cursor || entity.end > body.length || entity.start >= entity.end) {
      return
    }
    nextBody += body.slice(cursor, entity.start)
    nextBody += `MSGNRENTITYTOKEN${index}END`
    cursor = entity.end
  })

  nextBody += body.slice(cursor)

  let html = renderMarkdownToHtml(nextBody)
  sorted.forEach((entity, index) => {
    const token = `MSGNRENTITYTOKEN${index}END`
    const replacement = `<span data-message-entity-kind="${escapeHtml(entity.kind)}" data-message-entity-id="${escapeHtml(entity.targetId)}" data-message-entity-label="${escapeHtml(entity.label)}" data-message-entity-href="${escapeHtml(entity.href)}" class="message-entity-chip">${escapeHtml(entity.label)}</span>`
    html = html.replace(token, replacement)
  })

  return html
}
