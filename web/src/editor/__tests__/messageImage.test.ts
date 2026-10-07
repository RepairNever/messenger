import { Editor, generateJSON, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { describe, expect, it } from 'vitest'
import { MessageImageNode } from '@/editor/messageImage'

const extensions = [StarterKit, MessageImageNode]

describe('message image node', () => {
  it('preserves image source, alt text, and title while dropping unrelated HTML attributes', () => {
    const doc = generateJSON('<p><img src="https://example.test/photo.png" alt="Photo &amp; text" title="Caption" onerror="alert(1)"></p>', extensions)
    expect(doc.content?.find((node: JSONContent) => node.type === 'image')).toMatchObject({
      attrs: { src: 'https://example.test/photo.png', alt: 'Photo & text', title: 'Caption' },
    })
    const editor = new Editor({ extensions, content: doc })
    try {
      expect(editor.getHTML()).toContain('<img src="https://example.test/photo.png" alt="Photo &amp; text" title="Caption">')
      expect(editor.getHTML()).not.toContain('onerror')
    } finally {
      editor.destroy()
    }
  })

  it.each(['javascript:alert(1)', 'data:image/png;base64,bad', 'java\nscript:alert(1)', 'file:///tmp/private.png'])('rejects unsafe %s image sources while parsing HTML', source => {
    const doc = generateJSON(`<img src="${source}" alt="Blocked">`, extensions)
    expect(doc.content?.some((node: JSONContent) => node.type === 'image')).toBe(false)
  })

  it.each(['/uploads/photo.png', 'msgnr-attachment://message-id/attachment-id'])('preserves safe %s image sources', source => {
    const doc = generateJSON(`<img src="${source}" alt="Photo">`, extensions)
    expect(doc.content?.find((node: JSONContent) => node.type === 'image')?.attrs?.src).toBe(source)
  })

  it('keeps unsafe JSON image attributes inert when rendering', () => {
    const editor = new Editor({
      extensions,
      content: { type: 'doc', content: [{ type: 'image', attrs: { src: 'javascript:alert(1)', alt: 'Blocked' } }] },
    })
    try {
      expect(editor.getHTML()).not.toContain('<img')
      expect(editor.getHTML()).not.toContain('javascript:')
      expect(editor.getHTML()).toContain('Blocked')
    } finally {
      editor.destroy()
    }
  })
})
