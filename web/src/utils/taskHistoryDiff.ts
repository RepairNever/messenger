import { renderTaskMarkdownToHtml } from '@/utils/taskMarkdown'

export type TextDiffKind = 'equal' | 'added' | 'removed'

export interface TextDiffPart {
  kind: TextDiffKind
  value: string
}

export interface RenderedMarkdownDiff {
  beforeHtml: string
  afterHtml: string
  hasChanges: boolean
}

const TOKEN_RE = /(\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]+)/gu

function tokenize(input: string): string[] {
  return input.match(TOKEN_RE) ?? []
}

function appendPart(parts: TextDiffPart[], kind: TextDiffKind, value: string) {
  if (!value) return
  const last = parts[parts.length - 1]
  if (last?.kind === kind) {
    last.value += value
    return
  }
  parts.push({ kind, value })
}

export function diffText(oldText: string, newText: string): TextDiffPart[] {
  const oldTokens = tokenize(oldText ?? '')
  const newTokens = tokenize(newText ?? '')
  const rows = oldTokens.length + 1
  const cols = newTokens.length + 1
  const dp = Array.from({ length: rows }, () => new Array<number>(cols).fill(0))

  for (let i = oldTokens.length - 1; i >= 0; i -= 1) {
    for (let j = newTokens.length - 1; j >= 0; j -= 1) {
      dp[i][j] = oldTokens[i] === newTokens[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const parts: TextDiffPart[] = []
  let i = 0
  let j = 0
  while (i < oldTokens.length && j < newTokens.length) {
    if (oldTokens[i] === newTokens[j]) {
      appendPart(parts, 'equal', oldTokens[i])
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      appendPart(parts, 'removed', oldTokens[i])
      i += 1
    } else {
      appendPart(parts, 'added', newTokens[j])
      j += 1
    }
  }
  while (i < oldTokens.length) {
    appendPart(parts, 'removed', oldTokens[i])
    i += 1
  }
  while (j < newTokens.length) {
    appendPart(parts, 'added', newTokens[j])
    j += 1
  }

  return parts
}

function renderedText(html: string): string {
  const root = document.createElement('div')
  root.innerHTML = html
  return root.textContent ?? ''
}

function kindQueue(parts: TextDiffPart[], target: 'before' | 'after'): TextDiffKind[] {
  const queue: TextDiffKind[] = []
  for (const part of parts) {
    if (target === 'before' && part.kind === 'added') continue
    if (target === 'after' && part.kind === 'removed') continue
    for (const _token of tokenize(part.value)) {
      queue.push(part.kind)
    }
  }
  return queue
}

function createDiffElement(kind: TextDiffKind, text: string): HTMLElement | Text {
  if (kind === 'equal') {
    return document.createTextNode(text)
  }
  const el = document.createElement(kind === 'added' ? 'ins' : 'del')
  el.className = kind === 'added' ? 'task-history-diff-added' : 'task-history-diff-removed'
  el.dataset.testid = kind === 'added' ? 'task-history-diff-added' : 'task-history-diff-removed'
  el.textContent = text
  return el
}

function wrapTextNodesWithDiff(html: string, parts: TextDiffPart[], target: 'before' | 'after'): string {
  const root = document.createElement('div')
  root.innerHTML = html
  const queue = kindQueue(parts, target)
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []
  let current = walker.nextNode()
  while (current) {
    textNodes.push(current as Text)
    current = walker.nextNode()
  }

  for (const textNode of textNodes) {
    const tokens = tokenize(textNode.nodeValue ?? '')
    if (tokens.length === 0) continue
    const fragment = document.createDocumentFragment()
    for (const token of tokens) {
      fragment.append(createDiffElement(queue.shift() ?? 'equal', token))
    }
    textNode.replaceWith(fragment)
  }

  return root.innerHTML
}

export function buildRenderedMarkdownDiff(oldMarkdown: string, newMarkdown: string): RenderedMarkdownDiff {
  const beforeHtml = renderTaskMarkdownToHtml(oldMarkdown ?? '')
  const afterHtml = renderTaskMarkdownToHtml(newMarkdown ?? '')
  const parts = diffText(renderedText(beforeHtml), renderedText(afterHtml))
  const hasTextChanges = parts.some(part => part.kind !== 'equal')
  return {
    beforeHtml: oldMarkdown ? wrapTextNodesWithDiff(beforeHtml, parts, 'before') : '',
    afterHtml: newMarkdown ? wrapTextNodesWithDiff(afterHtml, parts, 'after') : '',
    hasChanges: hasTextChanges || oldMarkdown !== newMarkdown,
  }
}
