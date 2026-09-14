import MarkdownIt from 'markdown-it'
import { highlightCodeToHtml } from '@/utils/codeHighlight'

const taskMarkdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight: (code, language) => highlightCodeToHtml(code, language),
})

const TASK_LIST_MARKER_RE = /^(\s*)\[( |x|X)\]\s+/
const TASK_LIST_BLOCK_TAGS = new Set(['P', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'TABLE', 'HR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'])

function firstTextNode(root: Node): Text | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let current = walker.nextNode()
  while (current) {
    const textNode = current as Text
    if (textNode.nodeValue !== null) {
      return textNode
    }
    current = walker.nextNode()
  }
  return null
}

function isBlockElement(node: ChildNode): node is Element {
  return node.nodeType === Node.ELEMENT_NODE && TASK_LIST_BLOCK_TAGS.has((node as Element).tagName)
}

function stripTaskMarker(li: HTMLLIElement): boolean | null {
  const textNode = firstTextNode(li)
  if (!textNode?.nodeValue) return null
  const match = textNode.nodeValue.match(TASK_LIST_MARKER_RE)
  if (!match) return null
  textNode.nodeValue = textNode.nodeValue.replace(TASK_LIST_MARKER_RE, '$1')
  return match[2].toLowerCase() === 'x'
}

function convertTaskListUl(ul: HTMLUListElement): boolean {
  const items = Array.from(ul.children).filter((child): child is HTMLLIElement => child.tagName === 'LI')
  if (items.length === 0) return false

  const checkedStates = items.map(item => stripTaskMarker(item))
  if (checkedStates.some(state => state === null)) return false

  ul.dataset.type = 'taskList'

  for (let index = 0; index < items.length; index += 1) {
    const li = items[index]
    const checked = checkedStates[index] ?? false
    const originalNodes = Array.from(li.childNodes)
    const firstBlockIndex = originalNodes.findIndex(node => isBlockElement(node))
    const contentWrapper = document.createElement('div')

    if (firstBlockIndex === -1) {
      const paragraph = document.createElement('p')
      originalNodes.forEach(node => paragraph.appendChild(node))
      if (!paragraph.childNodes.length) {
        paragraph.appendChild(document.createTextNode(''))
      }
      contentWrapper.appendChild(paragraph)
    } else if (firstBlockIndex === 0 && originalNodes[0] instanceof HTMLParagraphElement) {
      originalNodes.forEach(node => contentWrapper.appendChild(node))
    } else {
      const paragraph = document.createElement('p')
      originalNodes.slice(0, firstBlockIndex).forEach(node => paragraph.appendChild(node))
      if (paragraph.childNodes.length || firstBlockIndex === 0) {
        contentWrapper.appendChild(paragraph)
      }
      originalNodes.slice(firstBlockIndex).forEach(node => contentWrapper.appendChild(node))
    }

    li.dataset.type = 'taskItem'
    li.dataset.checked = checked ? 'true' : 'false'

    const label = document.createElement('label')
    const input = document.createElement('input')
    const span = document.createElement('span')
    input.type = 'checkbox'
    input.checked = checked
    input.disabled = true
    label.append(input, span)
    li.append(label, contentWrapper)
  }

  return true
}

function renderTaskCheckboxMarkdown(html: string): string {
  const root = document.createElement('div')
  root.innerHTML = html

  let transformed = false
  const lists = Array.from(root.querySelectorAll('ul'))
  for (const list of lists) {
    transformed = convertTaskListUl(list as HTMLUListElement) || transformed
  }

  return transformed ? root.innerHTML : html
}

export function renderTaskMarkdownToHtml(input: string): string {
  const html = taskMarkdown.render(input ?? '')
  return renderTaskCheckboxMarkdown(html).replace(/&lt;br\s*\/?&gt;/gi, '<br>')
}
