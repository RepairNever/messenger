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
})
