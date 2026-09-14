import { Node, mergeAttributes } from '@tiptap/core'

export const MessageEntityNode = Node.create({
  name: 'messageEntity',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      kind: { default: 'user' },
      targetId: { default: '' },
      label: { default: '' },
      href: { default: '' },
    }
  },

  parseHTML() {
    return [{
      tag: 'span[data-message-entity-kind][data-message-entity-id]',
      getAttrs: element => {
        if (!(element instanceof HTMLElement)) return false
        return {
          kind: element.dataset.messageEntityKind ?? 'user',
          targetId: element.dataset.messageEntityId ?? '',
          label: element.dataset.messageEntityLabel ?? element.textContent ?? '',
          href: element.dataset.messageEntityHref ?? '',
        }
      },
    }]
  },

  renderHTML({ HTMLAttributes }) {
    const kind = String(HTMLAttributes.kind ?? 'user')
    const targetId = String(HTMLAttributes.targetId ?? '')
    const label = String(HTMLAttributes.label ?? '')
    const href = String(HTMLAttributes.href ?? '')

    return [
      'span',
      mergeAttributes({
        'data-message-entity-kind': kind,
        'data-message-entity-id': targetId,
        'data-message-entity-label': label,
        'data-message-entity-href': href,
        class: 'message-entity-chip',
      }),
      label,
    ]
  },

  renderText({ node }) {
    return String(node.attrs.label ?? '')
  },
})
