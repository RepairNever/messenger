import { Marked, type Renderer, type Tokens } from 'marked'
import { highlightCodeToHtml } from '@/utils/codeHighlight'
import { isSafeMessageUrl } from '@/utils/linkNavigation'
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

// Links to disallowed schemes (javascript:, data:, ...) render as inert text:
// never an anchor, never clickable, even via auxiliary clicks that bypass the
// app's delegated click handling.
function renderLinkToken(this: Renderer, token: Tokens.Link): string {
  if (!isSafeMessageUrl(token.href)) {
    return escapeHtml(token.text)
  }
  const titleAttr = token.title ? ` title="${escapeHtml(token.title)}"` : ''
  const inner = this.parser.parseInline(token.tokens ?? [])
  return `<a href="${escapeHtml(token.href)}"${titleAttr}>${inner}</a>`
}

function renderImageToken(token: Tokens.Image): string {
  if (!isSafeMessageUrl(token.href)) {
    return escapeHtml(token.text)
  }
  const titleAttr = token.title ? ` title="${escapeHtml(token.title)}"` : ''
  const altAttr = ` alt="${escapeHtml(token.text)}"`
  return `<img src="${escapeHtml(token.href)}"${altAttr}${titleAttr}>`
}

const markdown = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    code: renderCodeToken,
    html: renderHtmlToken,
    link: renderLinkToken,
    image: renderImageToken,
  },
})

// The editor needs the authored language and source, without display-time
// language detection or highlighting changing the document during a roundtrip.
const editorMarkdown = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    code: (token: Tokens.Code) => {
      const language = token.lang?.trim().split(/\s+/)[0]
      const className = language ? ` class="language-${escapeHtml(language)}"` : ''
      return `<pre><code${className}>${escapeHtml(token.text)}</code></pre>`
    },
    html: renderHtmlToken,
    link: renderLinkToken,
    image: renderImageToken,
  },
})

export function renderMarkdownToEditorHtml(input: string): string {
  return String(editorMarkdown.parse(input ?? ''))
}

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
