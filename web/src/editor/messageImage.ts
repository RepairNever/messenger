import { Node } from '@tiptap/core'
import { isSafeMessageUrl } from '@/utils/linkNavigation'

function safeImageSource(value: unknown): string | null {
  const source = String(value ?? '').trim()
  // Browsers remove embedded control characters while resolving URL schemes.
  if (/[\u0000-\u001f\u007f]/.test(source) || !isSafeMessageUrl(source)) return null
  return source
}

export const MessageImageNode = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      src: { default: '' },
      alt: { default: '' },
      title: { default: null },
    }
  },

  parseHTML() {
    return [{
      tag: 'img[src]',
      getAttrs: element => {
        const source = safeImageSource(element.getAttribute('src'))
        if (!source) return false
        return {
          src: source,
          alt: element.getAttribute('alt') ?? '',
          title: element.getAttribute('title'),
        }
      },
    }]
  },

  renderHTML({ node }) {
    const source = safeImageSource(node.attrs.src)
    if (!source) return ['span', {}, String(node.attrs.alt ?? '')]
    return ['img', {
      src: source,
      alt: String(node.attrs.alt ?? ''),
      ...(node.attrs.title == null ? {} : { title: String(node.attrs.title) }),
    }]
  },
})
