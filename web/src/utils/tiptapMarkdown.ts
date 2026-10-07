import type { JSONContent } from '@tiptap/core'

interface MarkdownSerializeOptions {
  hardBreakStyle?: 'markdown' | 'newline'
  escapeText?: boolean
  normalizeLegacyEscapes?: boolean
  preserveImageTitle?: boolean
  inTableCell?: boolean
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

function escapeInlineText(text: string, options: MarkdownSerializeOptions): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(options.inTableCell ? /[`*~\[\]<>]/g : /[`*~\[\]<>|]/g, '\\$&')
    .replace(/&(?=(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);)/gi, '\\&')
    .replace(/_+/g, (match, offset: number, source: string) => {
      const before = source[offset - 1] ?? ''
      const after = source[offset + match.length] ?? ''
      return /[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after)
        ? match
        : match.replace(/_/g, '\\_')
    })
    .replace(/(^|\n)([ \t]{0,3})(#{1,6})(?=\s|$)/g, '$1$2\\$3')
    .replace(/(^|\n)([ \t]{0,3})([-+])(?=\s|$)/g, '$1$2\\$3')
    .replace(/(^|\n)([ \t]{0,3})(\d{1,9})([.)])(?=\s|$)/g, '$1$2$3\\$4')
    .replace(/(^|\n)([ \t]{0,3})([-=]{2,})(?=\s*(?:\n|$))/g, '$1$2\\$3')
}

function longestBacktickRun(text: string): number {
  return Math.max(0, ...Array.from(text.matchAll(/`+/g), match => match[0].length))
}

function serializeDestination(href: string): string {
  return /[\s<>]/.test(href)
    ? `<${href.replace(/</g, '%3C').replace(/>/g, '%3E')}>`
    : href.replace(/[()\\]/g, '\\$&')
}

function serializeTitle(title: unknown): string {
  return title == null ? '' : ` "${String(title).replace(/[\\"]/g, '\\$&')}"`
}

function applyMarks(text: string, marks: JSONContent['marks'], options: MarkdownSerializeOptions): string {
  if (!text) return ''
  const safeMarks = marks ?? []
  const hasCode = safeMarks.some(mark => mark.type === 'code')
  let out: string
  if (hasCode) {
    const delimiter = '`'.repeat(longestBacktickRun(text) + 1)
    // CommonMark strips one surrounding space pair; add it only when needed
    // to separate backticks or retain an existing pair of edge spaces.
    const needsPadding = /^`|`$/.test(text) || (/^ .* $/s.test(text) && /[^ ]/.test(text))
    const padding = needsPadding ? ' ' : ''
    out = `${delimiter}${padding}${text}${padding}${delimiter}`
  } else {
    const normalized = options.normalizeLegacyEscapes === false ? text : normalizeGeneratedMarkdownEscapes(text)
    out = options.escapeText ? escapeInlineText(normalized, options) : normalized
  }

  let leadingWhitespace = ''
  let trailingWhitespace = ''
  if (!hasCode && options.escapeText && safeMarks.some(mark => mark.type === 'bold' || mark.type === 'italic' || mark.type === 'strike')) {
    // Delimiters surrounding whitespace do not form emphasis in Markdown.
    // Retain the whitespace beside the marked content instead.
    leadingWhitespace = out.match(/^\s*/)?.[0] ?? ''
    out = out.slice(leadingWhitespace.length)
    trailingWhitespace = out.match(/\s*$/)?.[0] ?? ''
    out = out.slice(0, out.length - trailingWhitespace.length)
    if (!out) return leadingWhitespace + trailingWhitespace
  }

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
      out = `[${out}](${serializeDestination(href)}${serializeTitle(linkMark.attrs?.title)})`
    }
  }

  return leadingWhitespace + out + trailingWhitespace
}

function serializeInline(nodes: JSONContent[] = [], options: MarkdownSerializeOptions = {}): string {
  const groupedNodes: JSONContent[] = []
  for (const node of nodes) {
    const previous = groupedNodes[groupedNodes.length - 1]
    if (
      options.escapeText && node.type === 'text' && previous?.type === 'text'
      && JSON.stringify(previous.marks ?? []) === JSON.stringify(node.marks ?? [])
    ) {
      previous.text = (previous.text ?? '') + (node.text ?? '')
    } else {
      groupedNodes.push({ ...node })
    }
  }
  return groupedNodes.map((node) => {
    if (node.type === 'text') {
      return applyMarks(node.text ?? '', node.marks, options)
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

function serializeListItem(item: JSONContent, marker: string, options: MarkdownSerializeOptions = {}): string {
  const children = item.content ?? []
  const firstParagraph = children.find(child => child.type === 'paragraph')
  const firstLine = firstParagraph ? serializeInline(firstParagraph.content ?? [], options) : ''
  // A continuation starts under the list item's content, including multi-digit
  // ordered markers. Task checkbox markers are part of the bullet content.
  const childIndent = ' '.repeat(marker.startsWith('- [') ? 2 : marker.length + 1)
  const [first, ...continuation] = firstLine.split('\n')
  const firstItemLine = `${marker} ${first}`
  const lines: string[] = [continuation.length ? firstItemLine : firstItemLine.trimEnd()]
  if (continuation.length) lines.push(indentLines(continuation.join('\n'), childIndent))

  const remainder = children.filter(child => child !== firstParagraph)
  remainder.forEach((child) => {
    const block = serializeBlock(child, options)
    if (!block) return
    const isList = child.type === 'bulletList' || child.type === 'orderedList' || child.type === 'taskList'
    lines.push(`${isList ? '' : '\n'}${indentLines(block, childIndent)}`)
  })

  return lines.join('\n')
}

function serializeList(node: JSONContent, options: MarkdownSerializeOptions = {}): string {
  const ordered = node.type === 'orderedList'
  const start = Number(node.attrs?.start ?? 1)
  const items = node.content ?? []

  return items
    .filter(item => item.type === 'listItem')
    .map((item, index) => {
      const marker = ordered ? `${start + index}.` : '-'
      return serializeListItem(item, marker, options)
    })
    .join('\n')
}

function serializeTaskList(node: JSONContent, options: MarkdownSerializeOptions = {}): string {
  const items = node.content ?? []

  return items
    .filter(item => item.type === 'taskItem')
    .map((item) => {
      const checked = item.attrs?.checked ? '- [x]' : '- [ ]'
      return serializeListItem(item, checked, options)
    })
    .join('\n')
}

function renderTableRow(cells: string[]): string {
  return `| ${cells.join(' | ')} |`
}

function serializeTableCell(node: JSONContent, options: MarkdownSerializeOptions): string {
  const raw = serializeBlocks(node.content ?? [], { ...options, inTableCell: true }).trim()
  if (!raw) return ''
  return raw
    .replace(/\n{2,}/g, '<br>')
    .replace(/\n/g, '<br>')
    .replace(/\|/g, '\\|')
}

function serializeTable(node: JSONContent, options: MarkdownSerializeOptions): string {
  const rows = (node.content ?? [])
    .filter(row => row.type === 'tableRow')
    .map((row) => {
      const cells = (row.content ?? []).filter(cell => cell.type === 'tableHeader' || cell.type === 'tableCell')
      return cells.map(cell => serializeTableCell(cell, options))
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
    renderTableRow(Array.from({ length: columnCount }, (_, index) => {
      const alignment = firstRowNodes[index]?.attrs?.textAlign
      if (alignment === 'left') return ':---'
      if (alignment === 'center') return ':---:'
      if (alignment === 'right') return '---:'
      return '---'
    })),
    ...bodyRows.map(renderTableRow),
  ]

  return lines.join('\n')
}

function serializeBlock(node: JSONContent, options: MarkdownSerializeOptions = {}): string {
  if (node.type === 'image') {
    const src = String(node.attrs?.src ?? '').trim()
    const alt = String(node.attrs?.alt ?? '').replace(/\\/g, '\\\\').replace(/[\[\]`*_~]/g, '\\$&')
    if (!src) return ''
    const title = options.preserveImageTitle ? serializeTitle(node.attrs?.title) : ''
    return `![${alt}](${serializeDestination(src)}${title})`
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
    return serializeList(node, options)
  }

  if (node.type === 'taskList') {
    return serializeTaskList(node, options)
  }

  if (node.type === 'taskItem') {
    const checked = node.attrs?.checked ? '- [x]' : '- [ ]'
    return serializeListItem(node, checked, options)
  }

  if (node.type === 'table') {
    return serializeTable(node, options)
  }

  if (node.type === 'blockquote') {
    const body = serializeBlocks(node.content ?? [], options).trim()
    if (!body) return '>'
    return body
      .split('\n')
      .map(line => (line ? `> ${line}` : '>'))
      .join('\n')
  }

  if (node.type === 'codeBlock') {
    const language = String(node.attrs?.language ?? '').trim()
    const source = extractText(node)
    const fence = '`'.repeat(Math.max(3, longestBacktickRun(source) + 1))
    // The fence's separating newline is syntax; Markdown parsers remove it
    // from the token text, so retain any trailing newline in the code source.
    return `${fence}${language}\n${source}\n${fence}`
  }

  if (node.type === 'horizontalRule') return '---'

  return serializeBlocks(node.content ?? [], options)
}

function serializeBlocks(nodes: JSONContent[] = [], options: MarkdownSerializeOptions = {}): string {
  return nodes
    .map(node => serializeBlock(node, options).trimEnd())
    .filter(Boolean)
    .join('\n\n')
}

export function tiptapJsonToMarkdown(doc: JSONContent | null | undefined, options: MarkdownSerializeOptions = {}): string {
  if (!doc) return ''
  return serializeBlocks(doc.content ?? [], options).trim()
}
