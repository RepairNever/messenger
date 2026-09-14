import { Marked, type Tokens } from 'marked'
import { highlightCodeToHtml } from '@/utils/codeHighlight'
import { escapeHtml } from '@/utils/html'

export { escapeHtml }

function renderHtmlToken(token: { text: string }): string {
  if (/^<br\s*\/?>$/i.test(token.text)) {
    return '<br>'
  }

  return escapeHtml(token.text)
}

function renderCodeToken(token: Tokens.Code): string {
  return highlightCodeToHtml(token.text, token.lang)
}

const markdown = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    code: renderCodeToken,
    html: renderHtmlToken,
  },
})

export function renderMarkdownToHtml(input: string): string {
  return String(markdown.parse(input ?? ''))
}

export function renderMarkdownInlineToHtml(input: string): string {
  if (!input) return ''
  const safe = input.replace(/\r\n/g, '\n')
  return safe
    .split('\n')
    .map(part => String(markdown.parseInline(part)))
    .join('<br>')
}
