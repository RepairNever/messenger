import type { JSONContent } from '@tiptap/core'
import { Marked } from 'marked'
import { describe, expect, it } from 'vitest'
import { tiptapJsonToMarkdown } from '@/utils/tiptapMarkdown'
import { tiptapJsonToMessagePayload } from '@/utils/messageRichText'
import { renderMarkdownToHtml } from '@/utils/markdown'

// Use ordinary GFM soft-break behavior to catch output that only looks correct
// with the chat renderer's breaks:true setting.
const markdown = new Marked({ gfm: true, breaks: false })

function text(value: string, marks?: JSONContent['marks']): JSONContent {
  return { type: 'text', text: value, marks }
}

function paragraph(...content: JSONContent[]): JSONContent {
  return { type: 'paragraph', content }
}

function list(type: 'orderedList' | 'bulletList', items: JSONContent[][], start = 1): JSONContent {
  return { type, attrs: { start }, content: items.map(content => ({ type: 'listItem', content })) }
}

function message(...content: JSONContent[]) {
  const payload = tiptapJsonToMessagePayload({ type: 'doc', content })
  const root = document.createElement('div')
  root.innerHTML = String(markdown.parse(payload.body))
  return { ...payload, root }
}

describe('portable message Markdown serialization', () => {
  it('preserves hard breaks in ordinary Markdown renderers and keeps entity offsets valid', () => {
    const result = message(paragraph(
      text('first'),
      { type: 'hardBreak' },
      text('second '),
      { type: 'messageEntity', attrs: { kind: 'user', targetId: 'user-1', label: '@Alice', href: '' } },
    ))

    expect(result.body).toBe('first  \nsecond @Alice')
    expect(result.root.querySelector('p > br')).not.toBeNull()
    expect(result.entities).toHaveLength(1)
    const entity = result.entities[0]!
    expect(result.body.slice(entity.start, entity.end)).toBe('@Alice')
  })

  it('retains horizontal rules between paragraphs', () => {
    const result = message(paragraph(text('before')), { type: 'horizontalRule' }, paragraph(text('after')))

    expect(result.root.children).toHaveLength(3)
    expect(result.root.children[1]?.tagName).toBe('HR')
    expect(result.root.lastElementChild?.textContent).toBe('after')
  })

  it.each([
    ['bold', 'strong'],
    ['italic', 'em'],
    ['strike', 'del'],
  ])('keeps surrounding whitespace outside %s delimiters', (mark, tag) => {
    const result = message(paragraph(text('before'), text(' marked ', [{ type: mark }]), text('after')))

    expect(result.root.querySelector('p')?.textContent).toBe('before marked after')
    expect(result.root.querySelector(tag)?.textContent).toBe('marked')
  })

  it('preserves adjacent bold and italic segments and merges equal-mark boundaries', () => {
    const result = message(paragraph(
      text('before'),
      text(' bold ', [{ type: 'bold' }]),
      text('both', [{ type: 'bold' }, { type: 'italic' }]),
      text(' italic ', [{ type: 'italic' }]),
      text('adjacent', [{ type: 'bold' }]),
      text('bold', [{ type: 'bold' }]),
      text(' after'),
    ))

    expect(result.root.querySelector('p')?.textContent).toBe('before bold both italic adjacentbold after')
    expect(result.root.querySelector('em > strong')?.textContent).toBe('both')
    expect(Array.from(result.root.querySelectorAll('strong')).map(node => node.textContent))
      .toEqual(['bold', 'both', 'adjacentbold'])
    expect(Array.from(result.root.querySelectorAll('em')).map(node => node.textContent)).toEqual(['both', 'italic'])
  })

  it('keeps mixed nested lists under their parents across multi-digit ordered markers', () => {
    const result = message(list('orderedList', [
      [paragraph(text('parent')), list('bulletList', [
        [paragraph(text('nested')), list('orderedList', [[paragraph(text('deep'))]], 10)],
        [paragraph(text('nested sibling'))],
      ])],
      [paragraph(text('root sibling'))],
    ], 9))

    const rootList = result.root.querySelector(':scope > ol')!
    expect(rootList.getAttribute('start')).toBe('9')
    expect(rootList.querySelectorAll(':scope > li')).toHaveLength(2)
    expect(rootList.querySelector('li > ul > li > ol')?.getAttribute('start')).toBe('10')
    expect(rootList.querySelector('li > ul > li > ol > li')?.textContent).toBe('deep')
    expect(rootList.querySelectorAll('pre')).toHaveLength(0)
  })

  it('indents list hard-break continuations and separate paragraphs beneath the item content', () => {
    const result = message(list('orderedList', [[
      paragraph(text('first'), { type: 'hardBreak' }, text('next')),
      paragraph(text('second paragraph')),
    ]], 10))

    const item = result.root.querySelector('ol > li')!
    expect(item.querySelectorAll(':scope > p')).toHaveLength(2)
    expect(item.querySelector('p > br')).not.toBeNull()
    expect(item.lastElementChild?.textContent).toBe('second paragraph')
  })

  it.each([
    'one ` tick',
    '`edge`',
    '``',
    'multiple `` ticks and ` one',
    ' leading and trailing ',
    '   ',
    String.raw`keep \. \(`,
  ])('roundtrips inline code without changing its content: %s', (code) => {
    const result = message(paragraph(text(code, [{ type: 'code' }])))

    expect(result.root.querySelector('p > code')?.textContent).toBe(code)
  })

  it('preserves linked inline code destinations and source text', () => {
    const href = 'https://example.com/README.md'
    const code = String.raw`README\file.md`
    const result = message(paragraph(text(code, [{ type: 'code' }, { type: 'link', attrs: { href } }])))
    const link = result.root.querySelector('a')!

    expect(link.getAttribute('href')).toBe(href)
    expect(link.querySelector('code')?.textContent).toBe(code)
  })

  it('retains bold and italic formatting alongside inline code without trimming code spaces', () => {
    const code = ' `literal` '
    const result = message(paragraph(text(code, [{ type: 'code' }, { type: 'bold' }, { type: 'italic' }])))

    expect(result.root.querySelector('em > strong > code')?.textContent).toBe(code)
  })

  it('uses a fence longer than embedded backtick runs and preserves code pipes and escapes', () => {
    const code = '```md\n| left | right |\n````\nconst value = "\\\\*literal";'
    const result = message({ type: 'codeBlock', attrs: { language: 'markdown' }, content: [text(code)] })

    expect(result.body.startsWith('`````markdown\n')).toBe(true)
    expect(result.root.querySelectorAll('pre')).toHaveLength(1)
    expect(result.root.querySelector('pre > code')?.textContent).toBe(`${code}\n`)
    expect(result.root.querySelectorAll('table')).toHaveLength(0)
  })

  it.each(['line\n', 'line\n\n'])('preserves trailing newlines in parsed fenced-code source: %j', (code) => {
    const result = message({ type: 'codeBlock', content: [text(code)] })

    const token = markdown.lexer(result.body)[0]!
    expect(token.type).toBe('code')
    expect(token).toHaveProperty('text', code)
    const chatRoot = document.createElement('div')
    chatRoot.innerHTML = renderMarkdownToHtml(result.body)
    expect(chatRoot.querySelector('pre > code')?.textContent).toBe(code)
  })

  it('preserves Markdown image URLs, literal alt text, and titles', () => {
    const src = 'https://example.com/image (1).png'
    const alt = '*literal* _caption_ ~~text~~ [caption]'
    const title = 'An "image"'
    const result = message({ type: 'image', attrs: { src, alt, title } })
    const image = result.root.querySelector('img')!

    expect(image.getAttribute('src')).toBe(new URL(src).href)
    expect(image.getAttribute('alt')).toBe(alt)
    expect(image.getAttribute('title')).toBe(title)
  })

  it('preserves link labels, destinations, and quoted titles', () => {
    const href = 'https://example.com/page (1)'
    const title = 'A "link"'
    const result = message(paragraph(text('*literal*', [{ type: 'link', attrs: { href, title } }])))
    const link = result.root.querySelector('a')!

    expect(link.textContent).toBe('*literal*')
    expect(link.getAttribute('href')).toBe(new URL(href).href)
    expect(link.getAttribute('title')).toBe(title)
  })

  it('escapes table-cell pipes, retains code spans, and exports column alignment', () => {
    const header = (value: string, textAlign: string): JSONContent => ({
      type: 'tableHeader', attrs: { textAlign }, content: [paragraph(text(value))],
    })
    const cell = (...content: JSONContent[]): JSONContent => ({ type: 'tableCell', content: [paragraph(...content)] })
    const result = message({
      type: 'table',
      content: [
        { type: 'tableRow', content: [header('left', 'left'), header('center', 'center'), header('right', 'right')] },
        { type: 'tableRow', content: [cell(text('a | b')), cell(text('c|d', [{ type: 'code' }])), cell(text('*literal*'))] },
      ],
    })

    const cells = result.root.querySelectorAll('tbody td')
    expect(cells).toHaveLength(3)
    expect(cells[0]?.textContent).toBe('a | b')
    expect(cells[1]?.querySelector('code')?.textContent).toBe('c|d')
    expect(cells[2]?.textContent).toBe('*literal*')
    expect(Array.from(result.root.querySelectorAll('th')).map(cell => cell.getAttribute('align')))
      .toEqual(['left', 'center', 'right'])
  })

  it('keeps literal pipe rows with hard breaks as paragraph text', () => {
    const rows = ['| A | B |', '| --- | --- |', '| text | more |']
    const result = message(paragraph(
      text(rows[0]!), { type: 'hardBreak' },
      text(rows[1]!), { type: 'hardBreak' },
      text(rows[2]!),
    ))
    const paragraphElement = result.root.querySelector('p')!

    expect(result.root.querySelector('table')).toBeNull()
    expect(paragraphElement.querySelectorAll('br')).toHaveLength(2)
    expect(Array.from(paragraphElement.childNodes).map(node => node.nodeName === 'BR' ? '\n' : node.textContent).join(''))
      .toBe(rows.join('\n'))
  })

  it('preserves literal backslashes beside pipes in table text cells', () => {
    const literal = String.raw`a \| b`
    const result = message({ type: 'table', content: [
      { type: 'tableRow', content: [{ type: 'tableHeader', content: [paragraph(text('Header'))] }] },
      { type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph(text(literal))] }] },
    ] })

    expect(result.root.querySelectorAll('tbody td')).toHaveLength(1)
    expect(result.root.querySelector('tbody td')?.textContent).toBe(literal)
  })

  it('preserves literal punctuation after escaped Markdown has been rendered into editor text', () => {
    const original = String.raw`\*literal\* \_text\_ \~\~deleted\~\~ \[label\](path) ` + '\\`ticks\\`' + String.raw` \\backslash`
    const originalRoot = document.createElement('div')
    originalRoot.innerHTML = String(markdown.parse(original))
    const literal = originalRoot.querySelector('p')!.textContent!
    const result = message(paragraph(text(literal)))

    expect(result.root.querySelector('p')?.textContent).toBe(literal)
    expect(result.root.querySelectorAll('em, strong, del, a, code')).toHaveLength(0)
  })

  it('keeps literal block syntax as paragraph text without escaping underscore identifiers', () => {
    const literal = '# heading\n- list\n1. ordered\n---\n===\nd_trades_done_amount = 2'
    const result = message(paragraph(text(literal)))

    expect(result.root.querySelector('p')?.textContent).toBe(literal)
    expect(result.root.children).toHaveLength(1)
    expect(result.body).toContain('d_trades_done_amount = 2')
  })

  it('leaves legacy task-description escape cleanup enabled by default', () => {
    const doc: JSONContent = { type: 'doc', content: [paragraph(text(String.raw`Ready\. \(done\)`))] }

    expect(tiptapJsonToMarkdown(doc)).toBe('Ready. (done)')
    expect(message(...doc.content!).root.querySelector('p')?.textContent).toBe(String.raw`Ready\. \(done\)`)
  })

  it('keeps task attachment image serialization unchanged by default', () => {
    const image: JSONContent = {
      type: 'image', attrs: { src: 'msgnr-attachment://task/task-1/image-1', alt: 'Photo.png', title: 'Photo.png' },
    }

    expect(tiptapJsonToMarkdown({ type: 'doc', content: [image] }))
      .toBe('![Photo.png](msgnr-attachment://task/task-1/image-1)')
    expect(message(image).body).toContain(' "Photo.png"')
  })
})
