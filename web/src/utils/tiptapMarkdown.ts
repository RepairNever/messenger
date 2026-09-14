import type { JSONContent } from '@tiptap/core'

interface MarkdownSerializeOptions {
  hardBreakStyle?: 'markdown' | 'newline'
}

const markdownEscapablePunctuation = new Set('`*_{}[]()#+-.!>|')

// Legacy clients escaped every Markdown punctuation character in ordinary text.
// During collaborative editing that escaped text can still arrive in the shared
// document, so remove exactly the generated escape before saving it again.
// An even-length backslash run is left intact to preserve literal backslashes.
function normalizeGeneratedMarkdownEscapes(input: string): string {
  let out = ''
  for (let index = 0; index < input.length;) {
    if (input[index] !== '\\') {
      out += input[index]
      index += 1
      continue
    }

    let nextIndex = index
    while (input[nextIndex] === '\\') nextIndex += 1
    const slashCount = nextIndex - index
    const nextChar = input[nextIndex]
    if (slashCount % 2 === 1 && nextChar && markdownEscapablePunctuation.has(nextChar)) {
      out += '\\'.repeat(slashCount - 1)
      out += nextChar
      index = nextIndex + 1
      continue
    }

    out += input.slice(index, nextIndex)
    index = nextIndex
  }
  return out
}

function extractText(node: JSONContent | null | undefined): string {
  if (!node) return ''
  if (node.type === 'text') return node.text ?? ''
  return (node.content ?? []).map(child => extractText(child)).join('')
}

function applyMarks(text: string, marks: JSONContent['marks']): string {
  if (!text) return ''
  const safeMarks = marks ?? []
  const hasCode = safeMarks.some(mark => mark.type === 'code')
  if (hasCode) {
    const escaped = text.replace(/`/g, '\\`')
    return `\`${escaped}\``
  }

  let out = normalizeGeneratedMarkdownEscapes(text)

  if (safeMarks.some(mark => mark.type === 'bold')) {
    out = `**${out}**`
  }
  if (safeMarks.some(mark => mark.type === 'italic')) {
    out = `*${out}*`
  }
  if (safeMarks.some(mark => mark.type === 'strike')) {
    out = `~~${out}~~`
  }

  const linkMark = safeMarks.find(mark => mark.type === 'link')
  if (linkMark) {
    const href = String(linkMark.attrs?.href ?? '').trim()
    if (href) {
      const safeHref = href.replace(/\)/g, '\\)')
      out = `[${out}](${safeHref})`
    }
  }

  return out
}

function serializeInline(nodes: JSONContent[] = [], options: MarkdownSerializeOptions = {}): string {
  return nodes.map((node) => {
    if (node.type === 'text') {
      return applyMarks(node.text ?? '', node.marks)
    }
    if (node.type === 'messageEntity') {
      return String(node.attrs?.label ?? '')
    }
    if (node.type === 'hardBreak') {
      return options.hardBreakStyle === 'newline' ? '\n' : '  \n'
    }
    if (node.type === 'codeBlock') {
      return serializeInline(node.content ?? [], options)
    }
    return serializeInline(node.content ?? [], options)
  }).join('')
}

function indentLines(input: string, indent: string): string {
  return input
    .split('\n')
    .map((line) => (line ? `${indent}${line}` : line))
    .join('\n')
}

function serializeListItem(item: JSONContent, depth: number, marker: string, options: MarkdownSerializeOptions = {}): string {
  const children = item.content ?? []
  const firstParagraph = children.find(child => child.type === 'paragraph')
  const firstLine = firstParagraph ? serializeInline(firstParagraph.content ?? [], options) : ''
  const baseIndent = '  '.repeat(depth)
  const childIndent = '  '.repeat(depth + 1)
  const lines: string[] = [`${baseIndent}${marker} ${firstLine}`.trimEnd()]

  const remainder = children.filter(child => child !== firstParagraph)
  remainder.forEach((child) => {
    const block = serializeBlock(child, depth + 1, options)
    if (!block) return
    lines.push(indentLines(block, childIndent))
  })

  return lines.join('\n')
}

function serializeList(node: JSONContent, depth: number, options: MarkdownSerializeOptions = {}): string {
  const ordered = node.type === 'orderedList'
  const start = Number(node.attrs?.start ?? 1)
  const items = node.content ?? []

  return items
    .filter(item => item.type === 'listItem')
    .map((item, index) => {
      const marker = ordered ? `${start + index}.` : '-'
      return serializeListItem(item, depth, marker, options)
    })
    .join('\n')
}

function serializeTaskList(node: JSONContent, depth: number, options: MarkdownSerializeOptions = {}): string {
  const items = node.content ?? []

  return items
    .filter(item => item.type === 'taskItem')
    .map((item) => {
      const checked = item.attrs?.checked ? '- [x]' : '- [ ]'
      return serializeListItem(item, depth, checked, options)
    })
    .join('\n')
}

function renderTableRow(cells: string[]): string {
  return `| ${cells.join(' | ')} |`
}

function serializeTableCell(node: JSONContent): string {
  const raw = serializeBlocks(node.content ?? []).trim()
  if (!raw) return ''
  return raw
    .replace(/\n{2,}/g, '<br>')
    .replace(/\n/g, '<br>')
    .replace(/\|/g, '\\|')
}

function serializeTable(node: JSONContent): string {
  const rows = (node.content ?? [])
    .filter(row => row.type === 'tableRow')
    .map((row) => {
      const cells = (row.content ?? []).filter(cell => cell.type === 'tableHeader' || cell.type === 'tableCell')
      return cells.map(cell => serializeTableCell(cell))
    })
    .filter(row => row.length > 0)

  if (rows.length === 0) return ''
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0)
  if (columnCount === 0) return ''

  const normalizedRows = rows.map(row => Array.from({ length: columnCount }, (_, idx) => row[idx] ?? ''))
  const firstRowNodes = (node.content?.[0]?.content ?? []).filter(cell => cell.type === 'tableHeader' || cell.type === 'tableCell')
  const hasHeader = firstRowNodes.length > 0 && firstRowNodes.every(cell => cell.type === 'tableHeader')
  const header = normalizedRows[0]
  const bodyRows = normalizedRows.slice(hasHeader ? 1 : 1)

  const lines = [
    renderTableRow(header),
    renderTableRow(Array.from({ length: columnCount }, () => '---')),
    ...bodyRows.map(renderTableRow),
  ]

  return lines.join('\n')
}

function serializeBlock(node: JSONContent, depth = 0, options: MarkdownSerializeOptions = {}): string {
  if (node.type === 'image') {
    const src = String(node.attrs?.src ?? '').trim()
    const alt = String(node.attrs?.alt ?? '').replace(/\\/g, '\\\\').replace(/\]/g, '\\]')
    if (!src) return ''
    return `![${alt}](${src})`
  }

  if (node.type === 'paragraph') {
    return serializeInline(node.content ?? [], options)
  }

  if (node.type === 'heading') {
    const levelRaw = Number(node.attrs?.level ?? 1)
    const level = Number.isFinite(levelRaw) ? Math.min(6, Math.max(1, levelRaw)) : 1
    const content = serializeInline(node.content ?? [], options)
    return `${'#'.repeat(level)} ${content}`.trimEnd()
  }

  if (node.type === 'bulletList' || node.type === 'orderedList') {
    return serializeList(node, depth, options)
  }

  if (node.type === 'taskList') {
    return serializeTaskList(node, depth, options)
  }

  if (node.type === 'taskItem') {
    const checked = node.attrs?.checked ? '- [x]' : '- [ ]'
    return serializeListItem(node, depth, checked, options)
  }

  if (node.type === 'table') {
    return serializeTable(node)
  }

  if (node.type === 'blockquote') {
    const body = serializeBlocks(node.content ?? [], depth, options).trim()
    if (!body) return '>'
    return body
      .split('\n')
      .map(line => (line ? `> ${line}` : '>'))
      .join('\n')
  }

  if (node.type === 'codeBlock') {
    const language = String(node.attrs?.language ?? '').trim()
    const source = extractText(node)
    return `\`\`\`${language}\n${source}\n\`\`\``
  }

  return serializeBlocks(node.content ?? [], depth, options)
}

function serializeBlocks(nodes: JSONContent[] = [], depth = 0, options: MarkdownSerializeOptions = {}): string {
  return nodes
    .map(node => serializeBlock(node, depth, options).trimEnd())
    .filter(Boolean)
    .join('\n\n')
}

export function tiptapJsonToMarkdown(doc: JSONContent | null | undefined, options: MarkdownSerializeOptions = {}): string {
  if (!doc) return ''
  return serializeBlocks(doc.content ?? [], 0, options).trim()
}
