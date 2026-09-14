import { describe, expect, it } from 'vitest'
import { renderTaskMarkdownToHtml } from '@/utils/taskMarkdown'
import { tiptapJsonToMarkdown } from '@/utils/tiptapMarkdown'

describe('task markdown helpers', () => {
  it('renders markdown task lists as checkbox HTML', () => {
    const html = renderTaskMarkdownToHtml('- [ ] Text....')

    expect(html).toContain('data-type="taskList"')
    expect(html).toContain('data-type="taskItem"')
    expect(html).toContain('data-checked="false"')
    expect(html).toContain('<input type="checkbox"')
  })

  it('serializes task list nodes back to markdown checkboxes', () => {
    const markdown = tiptapJsonToMarkdown({
      type: 'doc',
      content: [
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: {
                checked: false,
              },
              content: [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'text', text: 'First item' },
                  ],
                },
              ],
            },
            {
              type: 'taskItem',
              attrs: {
                checked: true,
              },
              content: [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'text', text: 'Second item' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })

    expect(markdown).toContain('- [ ] First item')
    expect(markdown).toContain('- [x] Second item')
  })

  it('preserves ordinary punctuation in task description text', () => {
    const markdown = tiptapJsonToMarkdown({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'd_trades_done_amount = 2, current_limit_reached = TRUE.',
            },
          ],
        },
      ],
    })

    expect(markdown).toBe('d_trades_done_amount = 2, current_limit_reached = TRUE.')
  })

  it('removes generated Markdown punctuation escapes from collaborative text before saving', () => {
    const markdown = tiptapJsonToMarkdown({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{
          type: 'text',
          text: String.raw`Ready\. \(in progress\)\.\.\. \- done`,
        }],
      }],
    })

    expect(markdown).toBe('Ready. (in progress)... - done')
  })

  it('keeps literal and unknown backslash sequences in ordinary text', () => {
    const input = String.raw`C:\folder \q \\server \\.`
    const markdown = tiptapJsonToMarkdown({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: input }],
      }],
    })

    expect(markdown).toBe(input)
  })

  it('stabilizes legacy punctuation escapes across repeated collaborative saves', () => {
    const serializeText = (text: string) => tiptapJsonToMarkdown({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text }],
      }],
    })

    const once = serializeText(String.raw`\\\.`)
    const twice = serializeText(once)

    expect(once).toBe(String.raw`\\.`)
    expect(twice).toBe(once)
  })

  it('keeps Markdown escapes inside code marks', () => {
    const code = String.raw`keep \. \(`
    const markdown = tiptapJsonToMarkdown({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: code, marks: [{ type: 'code' }] }],
      }],
    })

    expect(markdown).toBe(`\`${code}\``)
  })

  it('renders escaped br tokens inside markdown tables as line breaks', () => {
    const html = renderTaskMarkdownToHtml('| A |\n| --- |\n| one<br>two |')

    expect(html).toContain('<td>one<br>two</td>')
    expect(html).not.toContain('&lt;br&gt;')
  })

  it('renders fenced code with language-aware syntax highlighting', () => {
    const html = renderTaskMarkdownToHtml('```python\ndef hello(name):\n    return f"hi {name}"\n```')

    expect(html).toContain('language-python')
    expect(html).toContain('data-language="Python"')
    expect(html).toContain('<span class="hljs-keyword">def</span>')
  })
})
