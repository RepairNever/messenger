import { Extension } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { highlightCodeForDisplay } from '@/utils/codeHighlight'

interface HighlightSpan {
  start: number
  end: number
  className: string
}

function highlightedHtmlToSpans(html: string): HighlightSpan[] {
  if (typeof document === 'undefined') return []

  const root = document.createElement('div')
  root.innerHTML = html
  const spans: HighlightSpan[] = []
  let offset = 0

  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      offset += node.textContent?.length ?? 0
      return
    }

    if (!(node instanceof HTMLElement)) return
    const start = offset
    for (const child of Array.from(node.childNodes)) {
      walk(child)
    }
    const end = offset
    const className = Array.from(node.classList)
      .filter(classItem => classItem.startsWith('hljs-') || classItem === 'function_')
      .join(' ')

    if (className && end > start) {
      spans.push({ start, end, className })
    }
  }

  for (const child of Array.from(root.childNodes)) {
    walk(child)
  }

  return spans
}

function codeBlockDecorations(node: ProseMirrorNode, pos: number): Decoration[] {
  const highlighted = highlightCodeForDisplay(node.textContent, String(node.attrs.language ?? ''))
  const decorations: Decoration[] = []
  const nodeClass = ['markdown-code-block', highlighted.languageClass ? `language-${highlighted.languageClass}` : '']
    .filter(Boolean)
    .join(' ')

  decorations.push(Decoration.node(pos, pos + node.nodeSize, {
    class: nodeClass,
    ...(highlighted.displayName ? { 'data-language': highlighted.displayName } : {}),
  }))

  for (const span of highlightedHtmlToSpans(highlighted.html)) {
    decorations.push(Decoration.inline(pos + 1 + span.start, pos + 1 + span.end, {
      class: span.className,
    }))
  }

  return decorations
}

export const CodeBlockHighlightExtension = Extension.create({
  name: 'codeBlockHighlight',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('codeBlockHighlight'),
        props: {
          decorations(state) {
            const decorations: Decoration[] = []
            state.doc.descendants((node, pos) => {
              if (node.type.name !== 'codeBlock') return
              decorations.push(...codeBlockDecorations(node, pos))
            })
            return DecorationSet.create(state.doc, decorations)
          },
        },
      }),
    ]
  },
})
