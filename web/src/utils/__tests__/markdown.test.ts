import { describe, expect, it } from 'vitest'
import { renderMarkdownToHtml } from '@/utils/markdown'

describe('renderMarkdownToHtml', () => {
  it('keeps code block text unescaped while still rendering raw br tags', () => {
    const html = renderMarkdownToHtml(`\`\`\`
const value = "<T>"
const quote = "
\`\`\`

Line<br>break`)

    expect(html).toContain('<code class="hljs')
    expect(html).toContain('&lt;T&gt;')
    expect(html).toContain('&quot;')
    expect(html).not.toContain('&amp;lt;T&amp;gt;')
    expect(html).not.toContain('&amp;quot;')
    expect(html).toContain('<br>')
  })

  it('restores escaped br tags as line breaks', () => {
    const html = renderMarkdownToHtml('| A |\n| --- |\n| one<br>two |')

    expect(html).toContain('<td>one<br>two</td>')
    expect(html).not.toContain('&lt;br&gt;')
  })

  it('renders fenced code with language-aware syntax highlighting', () => {
    const html = renderMarkdownToHtml('```go\npackage main\nfunc main() {}\n```')

    expect(html).toContain('language-go')
    expect(html).toContain('data-language="Go"')
    expect(html).toContain('<span class="hljs-keyword">package</span>')
  })

  it('renders safe http links as anchors', () => {
    const html = renderMarkdownToHtml('[docs](https://example.com/a)')

    expect(html).toContain('<a href="https://example.com/a">docs</a>')
  })

  it('renders attachment and mention pseudo-scheme links', () => {
    const html = renderMarkdownToHtml('[file](msgnr-attachment://01HTEST/01HTEST2) [alice](msgnr-mention://user/01HUSER)')

    expect(html).toContain('<a href="msgnr-attachment://01HTEST/01HTEST2">file</a>')
    expect(html).toContain('<a href="msgnr-mention://user/01HUSER">alice</a>')
  })

  it.each([
    ['javascript:alert(document.cookie)', '[click](javascript:alert(document.cookie))'],
    ['data:text/html,bad', '[click](data:text/html,bad)'],
    ['vbscript:msgbox', '[click](vbscript:msgbox)'],
  ])('strips %s links down to their text', (_scheme, markdown) => {
    const html = renderMarkdownToHtml(markdown)

    expect(html).toContain('click')
    expect(html).not.toContain('<a ')
  })

  it('keeps relative and scheme-less urls clickable', () => {
    const html = renderMarkdownToHtml('[page](/channels/12) [host](//example.com/x)')

    expect(html).toContain('<a href="/channels/12">page</a>')
    expect(html).toContain('<a href="//example.com/x">host</a>')
  })

  it('strips unsafe image sources but keeps alt text', () => {
    const html = renderMarkdownToHtml('![logo](javascript:alert(1)) ![ok](https://example.com/logo.png)')

    expect(html).toContain('logo')
    expect(html).not.toContain('<img src="javascript:')
    expect(html).toContain('<img src="https://example.com/logo.png"')
  })
})
