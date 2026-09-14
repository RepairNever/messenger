import { Extension, type Editor } from '@tiptap/core'
import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, TextSelection } from '@tiptap/pm/state'

const CODE_FENCE_RE = /^```([\w-]+)?$/

type VisualLineInfo = {
  parent: ProseMirrorNode
  parentPos: number
  parentEnd: number
  cursorOffset: number
  beforeText: string
  afterText: string
  beforeContentEnd: number
  afterContentStart: number
}

type VisualShortcutMatch =
  | { kind: 'orderedList'; start: number }
  | { kind: 'bulletList' }
  | { kind: 'blockquote' }
  | { kind: 'heading'; level: number }
  | { kind: 'taskItem'; checked: boolean }
  | { kind: 'codeFence'; language: string | null }

function getVisualLineInfo(editor: Editor): VisualLineInfo | null {
  const { selection } = editor.state
  if (!selection.empty) return null

  const parent = selection.$from.parent
  if (parent.type.name !== 'paragraph') return null

  const cursorOffset = selection.$from.parentOffset
  let previousBreakStart: number | null = null
  let previousBreakEnd: number | null = null
  let nextBreakStart: number | null = null
  let nextBreakEnd: number | null = null
  let offset = 0

  parent.forEach((child) => {
    const start = offset
    const end = start + child.nodeSize
    offset = end
    if (child.type.name !== 'hardBreak') return
    if (end <= cursorOffset) {
      previousBreakStart = start
      previousBreakEnd = end
      return
    }
    if (nextBreakStart === null && start >= cursorOffset) {
      nextBreakStart = start
      nextBreakEnd = end
    }
  })

  const lineStart = previousBreakEnd ?? 0
  const lineEnd = nextBreakStart ?? parent.content.size

  return {
    parent,
    parentPos: selection.$from.before(),
    parentEnd: selection.$from.after(),
    cursorOffset,
    beforeText: parent.textBetween(lineStart, cursorOffset, '\n', '\uFFFC'),
    afterText: parent.textBetween(cursorOffset, lineEnd, '\n', '\uFFFC'),
    beforeContentEnd: previousBreakStart ?? 0,
    afterContentStart: nextBreakEnd ?? parent.content.size,
  }
}

function buildShortcutBlock(editor: Editor, match: VisualShortcutMatch): ProseMirrorNode | null {
  const { schema } = editor.state
  const paragraph = schema.nodes.paragraph
  if (!paragraph) return null

  const emptyParagraph = paragraph.create()

  if (match.kind === 'orderedList') {
    const orderedList = schema.nodes.orderedList
    const listItem = schema.nodes.listItem
    if (!orderedList || !listItem) return null
    return orderedList.create(
      { start: match.start },
      listItem.create(null, emptyParagraph),
    )
  }

  if (match.kind === 'bulletList') {
    const bulletList = schema.nodes.bulletList
    const listItem = schema.nodes.listItem
    if (!bulletList || !listItem) return null
    return bulletList.create(null, listItem.create(null, emptyParagraph))
  }

  if (match.kind === 'blockquote') {
    const blockquote = schema.nodes.blockquote
    if (!blockquote) return null
    return blockquote.create(null, emptyParagraph)
  }

  if (match.kind === 'heading') {
    const heading = schema.nodes.heading
    if (!heading) return null
    return heading.create({ level: match.level })
  }

  if (match.kind === 'taskItem') {
    const taskList = schema.nodes.taskList
    const taskItem = schema.nodes.taskItem
    if (!taskList || !taskItem) return null
    return taskList.create(null, taskItem.create({ checked: match.checked }, emptyParagraph))
  }

  const codeBlock = schema.nodes.codeBlock
  if (!codeBlock) return null
  return codeBlock.create({ language: match.language })
}

function replaceVisualLineWithBlock(editor: Editor, match: VisualShortcutMatch, info = getVisualLineInfo(editor)): boolean {
  if (!info) return false

  const beforeFragment = info.beforeContentEnd > 0
    ? info.parent.content.cut(0, info.beforeContentEnd)
    : Fragment.empty
  const afterFragment = info.afterContentStart < info.parent.content.size
    // Skipping the next hard break turns the current visual line into its own block.
    ? info.parent.content.cut(info.afterContentStart, info.parent.content.size)
    : Fragment.empty

  const nodes: ProseMirrorNode[] = []
  const paragraph = editor.state.schema.nodes.paragraph
  if (!paragraph) return false

  if (beforeFragment.size > 0) {
    nodes.push(paragraph.create(null, beforeFragment))
  }

  const mainNode = buildShortcutBlock(editor, match)
  if (!mainNode) return false
  nodes.push(mainNode)

  if (afterFragment.size > 0) {
    nodes.push(paragraph.create(null, afterFragment))
  }

  return editor.commands.command(({ tr, dispatch }) => {
    tr.replaceWith(info.parentPos, info.parentEnd, Fragment.fromArray(nodes))
    const insertedMainPos = info.parentPos + (nodes[0] === mainNode ? 0 : nodes[0].nodeSize)
    tr.setSelection(TextSelection.near(tr.doc.resolve(insertedMainPos + 1), 1))

    dispatch?.(tr)
    return true
  })
}

function getFenceShortcutMatch(info: VisualLineInfo | null): Extract<VisualShortcutMatch, { kind: 'codeFence' }> | null {
  if (!info || info.afterText.length > 0) return null
  const match = info.beforeText.match(CODE_FENCE_RE)
  if (!match) return null

  return {
    kind: 'codeFence',
    language: match[1] ?? null,
  }
}

export function shouldConvertFenceParagraph(editor: Editor): boolean {
  return getFenceShortcutMatch(getVisualLineInfo(editor)) !== null
}

export function convertFenceParagraphToCodeBlock(editor: Editor): boolean {
  const info = getVisualLineInfo(editor)
  const match = getFenceShortcutMatch(info)
  if (!match) return false
  return replaceVisualLineWithBlock(editor, match, info)
}

export function shouldConvertFenceOnBacktick(editor: Editor): boolean {
  if (editor.isActive('code') || editor.isActive('codeBlock')) return false

  const info = getVisualLineInfo(editor)
  if (!info || info.afterText.length > 0) return false
  return info.beforeText === '``'
}

export function convertFenceOnBacktick(editor: Editor): boolean {
  return replaceVisualLineWithBlock(editor, {
    kind: 'codeFence',
    language: null,
  })
}

function getSpaceShortcutMatch(editor: Editor): VisualShortcutMatch | null {
  const info = getVisualLineInfo(editor)
  if (!info || info.afterText.length > 0) return null

  const orderedMatch = info.beforeText.match(/^(\d+)\.$/)
  if (orderedMatch) {
    return {
      kind: 'orderedList',
      start: Number.parseInt(orderedMatch[1]!, 10),
    }
  }

  if (info.beforeText === '-' || info.beforeText === '*') {
    return { kind: 'bulletList' }
  }

  if (info.beforeText === '>') {
    return { kind: 'blockquote' }
  }

  const headingMatch = info.beforeText.match(/^(#{1,6})$/)
  if (headingMatch) {
    return {
      kind: 'heading',
      level: headingMatch[1]?.length ?? 1,
    }
  }

  if (info.beforeText === '[ ]' || info.beforeText === '[x]' || info.beforeText === '[X]') {
    if (editor.state.schema.nodes.taskList && editor.state.schema.nodes.taskItem) {
      return {
        kind: 'taskItem',
        checked: info.beforeText !== '[ ]',
      }
    }
  }

  const fenceMatch = info.beforeText.match(CODE_FENCE_RE)
  if (fenceMatch) {
    return {
      kind: 'codeFence',
      language: fenceMatch[1] ?? null,
    }
  }

  return null
}

export function shouldSubmitOnEnter(editor: Editor): boolean {
  const { selection } = editor.state
  if (!selection.empty || selection.$from.parent.type.name !== 'paragraph') {
    return false
  }

  if (getSpaceShortcutMatch(editor)) {
    return false
  }

  return !(
    editor.isActive('bulletList')
    || editor.isActive('orderedList')
    || editor.isActive('taskList')
    || editor.isActive('blockquote')
    || editor.isActive('codeBlock')
  )
}

export const FenceOnEnterExtension = Extension.create({
  name: 'fenceOnEnter',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleTextInput: (_view, _from, _to, text) => {
            if (text === '`') {
              if (!shouldConvertFenceOnBacktick(this.editor)) return false
              return convertFenceOnBacktick(this.editor)
            }
            if (text === ' ') {
              const match = getSpaceShortcutMatch(this.editor)
              if (!match) return false
              return replaceVisualLineWithBlock(this.editor, match)
            }
            return false
          },
        },
      }),
    ]
  },

  addKeyboardShortcuts() {
    return {
      Enter: () => convertFenceParagraphToCodeBlock(this.editor),
    }
  },
})
