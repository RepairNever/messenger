import { generateJSON, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { describe, expect, it } from 'vitest'
import { hasMarkdownSyntax, normalizeEditorMarkdownHtml, renderEditorMarkdownHtml } from '@/utils/editorMarkdown'

const extensions = [StarterKit, TaskList, TaskItem.configure({ nested: true })]

describe('Markdown clipboard syntax detection', () => {
  it.each([
    '```js\nconst answer = 42\n```',
    '**bold** and *italic*',
    String.raw`Keep \*literal\* punctuation`,
    '# Heading',
    '- First\n- Second',
    '> Quoted',
    '| A | B |\n| --- | --- |\n| one | two |',
    'Before\n\n---\n\nAfter',
    '~~removed~~',
    '[Reference](https://example.test)',
    '[Reference][docs]\n\n[docs]: https://example.test',
    '[docs]\n\n[docs]: https://example.test',
    '<https://example.test>',
    '<alice@example.test>',
    '![Picture](https://example.test/photo.png)',
    'Use `code` here',
    'First  \nSecond',
    'First\\\nSecond',
  ])('recognizes actual Markdown formatting in %s', body => {
    expect(hasMarkdownSyntax(body)).toBe(true)
  })

  it.each([
    '',
    'Ordinary prose, with punctuation.',
    'First line\nSecond line',
    'd_trades_done_amount = 2, current_limit_reached = TRUE.',
    'Use #tag, a*b and a_b without formatting.',
    'Unmatched ** marker',
    'See https://example.com',
    'Visit www.example.com',
    'Write to a@example.com',
  ])('keeps ordinary text available for native rich HTML paste: %s', body => {
    expect(hasMarkdownSyntax(body)).toBe(false)
  })
})

describe('editor Markdown HTML', () => {
  it('keeps checkbox states, inline marks, and loose task paragraphs in the editor schema', () => {
    const html = renderEditorMarkdownHtml('- [ ] **First**\n\n- [x] Second\n\n  Additional paragraph')
    const doc = generateJSON(html, extensions)
    const list = doc.content?.[0]
    expect(list?.type).toBe('taskList')
    expect(list?.content?.map((item: JSONContent) => item.attrs?.checked)).toEqual([false, true])
    expect(list?.content?.[0]?.content?.[0]?.content?.[0]).toMatchObject({ type: 'text', text: 'First', marks: [{ type: 'bold' }] })
    expect(list?.content?.[1]?.content?.map((node: JSONContent) => node.type)).toEqual(['paragraph', 'paragraph'])
    expect(html).not.toContain('<input')
  })

  it('preserves mixed bullet and task runs together with nested lists', () => {
    const html = renderEditorMarkdownHtml('- Ordinary\n- [ ] Parent\n  - [x] Child\n  - Nested ordinary\n- Last ordinary')
    const doc = generateJSON(html, extensions)
    expect(doc.content?.map((node: JSONContent) => node.type)).toEqual(['bulletList', 'taskList', 'bulletList'])
    const parent = doc.content?.[1]?.content?.[0]
    expect(parent?.attrs?.checked).toBe(false)
    expect(parent?.content?.map((node: JSONContent) => node.type)).toEqual(['paragraph', 'taskList', 'bulletList'])
    expect(parent?.content?.[1]?.content?.[0]?.attrs?.checked).toBe(true)
    expect(parent?.content?.[2]?.content?.[0]?.content?.[0]?.content?.[0]?.text).toBe('Nested ordinary')
  })

  it('leaves native task-list markup and entity spans unchanged on repeated normalization', () => {
    const native = '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked><span></span></label><div><p><span data-message-entity-kind="user" data-message-entity-id="user-1">@Alice</span></p></div></li></ul>'
    expect(normalizeEditorMarkdownHtml(native)).toBe(native)
    const converted = renderEditorMarkdownHtml('- [x] Finished')
    expect(normalizeEditorMarkdownHtml(converted)).toBe(converted)
  })

  it('does not treat a checkbox in a later paragraph as a list marker', () => {
    const html = '<ul><li><p>Ordinary</p><p><input type="checkbox" disabled>Control</p></li></ul>'
    expect(normalizeEditorMarkdownHtml(html)).toBe(html)
  })

  it('uses shared GFM rendering and keeps literal author HTML escaped', () => {
    const html = renderEditorMarkdownHtml('| A | B |\n| --- | --- |\n| one | two |\n\nFirst\nSecond\n\n<script>alert(1)</script>')
    expect(html).toContain('<table>')
    expect(html).toContain('First<br>Second')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })
})
