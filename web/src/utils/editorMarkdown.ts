import { Marked } from 'marked'
import { renderMarkdownToEditorHtml } from '@/utils/markdown'

const BLOCK_TAGS = new Set(['P', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'TABLE', 'HR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DIV'])
const MARKDOWN_FORMAT_TOKENS = new Set(['heading', 'code', 'list', 'table', 'hr', 'blockquote', 'strong', 'em', 'del', 'image', 'codespan', 'escape', 'br'])
// Ordinary prose line endings alone should not override rich clipboard HTML.
const markdownSyntax = new Marked({ gfm: true, breaks: false })

export function hasMarkdownSyntax(body: string): boolean {
  let formatted = false
  markdownSyntax.walkTokens(markdownSyntax.lexer(body), token => {
    // GFM also creates link tokens for bare URLs and email addresses, which
    // remain ordinary prose when choosing between plain and rich clipboard data.
    if (token.type === 'link' && (token.raw.startsWith('[') || token.raw.startsWith('<'))) formatted = true
    if (MARKDOWN_FORMAT_TOKENS.has(token.type)) formatted = true
  })
  return formatted
}

function firstContentNode(parent: ParentNode): ChildNode | undefined {
  return Array.from(parent.childNodes).find(node => node.nodeType !== Node.TEXT_NODE || Boolean(node.textContent?.trim()))
}

function taskCheckbox(item: HTMLLIElement): HTMLInputElement | null {
  const first = firstContentNode(item)
  const candidate = first instanceof HTMLParagraphElement ? firstContentNode(first) : first
  return candidate instanceof HTMLInputElement && candidate.type === 'checkbox' ? candidate : null
}

function convertTaskItem(item: HTMLLIElement, checkbox: HTMLInputElement) {
  const checked = checkbox.checked
  const followingText = checkbox.nextSibling
  checkbox.remove()
  if (followingText?.nodeType === Node.TEXT_NODE) {
    followingText.textContent = followingText.textContent?.replace(/^[ \t]+/, '') ?? ''
  }

  item.dataset.type = 'taskItem'
  item.dataset.checked = String(checked)
  const content = document.createElement('div')
  let paragraph: HTMLParagraphElement | null = null

  for (const child of Array.from(item.childNodes)) {
    if (child instanceof Element && BLOCK_TAGS.has(child.tagName)) {
      paragraph = null
      content.appendChild(child)
      continue
    }
    if (!paragraph && child.nodeType === Node.TEXT_NODE && !child.textContent?.trim()) continue
    if (!paragraph) {
      paragraph = document.createElement('p')
      content.appendChild(paragraph)
    }
    paragraph.appendChild(child)
  }

  if (!(content.firstElementChild instanceof HTMLParagraphElement)) {
    content.prepend(document.createElement('p'))
  }
  item.appendChild(content)
}

function convertTaskList(list: HTMLUListElement): boolean {
  if (list.dataset.type === 'taskList') return false
  const items = Array.from(list.children).filter((child): child is HTMLLIElement => child instanceof HTMLLIElement)
  const taskItems = items.map(item => {
    if (item.dataset.type === 'taskItem') return true
    const checkbox = taskCheckbox(item)
    if (!checkbox) return false
    convertTaskItem(item, checkbox)
    return true
  })
  if (!taskItems.some(Boolean)) return false

  if (taskItems.every(Boolean)) {
    list.dataset.type = 'taskList'
    return true
  }

  // TipTap lists have a single item type. Preserve mixed bullet/task lists by
  // keeping each consecutive run in a container with its matching item type.
  const runs = document.createDocumentFragment()
  let current: HTMLUListElement | null = null
  let previousTask: boolean | null = null
  items.forEach((item, index) => {
    const task = taskItems[index]
    if (task !== previousTask) {
      current = list.cloneNode(false) as HTMLUListElement
      if (runs.childNodes.length) current.removeAttribute('id')
      if (task) current.dataset.type = 'taskList'
      else current.removeAttribute('data-type')
      runs.appendChild(current)
      previousTask = task
    }
    current!.appendChild(item)
  })
  list.replaceWith(runs)
  return true
}

export function normalizeEditorMarkdownHtml(html: string): string {
  const template = document.createElement('template')
  template.innerHTML = html
  let changed = false
  // Convert children first so wrapping or splitting a parent retains nested
  // checklists, ordinary lists, and native editor entity markup.
  const lists = Array.from(template.content.querySelectorAll<HTMLUListElement>('ul')).reverse()
  for (const list of lists) changed = convertTaskList(list) || changed
  return changed ? template.innerHTML : html
}

export function renderEditorMarkdownHtml(body: string): string {
  return normalizeEditorMarkdownHtml(renderMarkdownToEditorHtml(body))
}
