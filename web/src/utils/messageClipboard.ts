import type { MessageEntity } from '@/stores/chat'
import { isSafeMessageUrl } from '@/utils/linkNavigation'
import { renderMessageEditorHtml } from '@/utils/messageRichText'

function renderClipboardHtml(body: string, entities: MessageEntity[]): string {
  const template = document.createElement('template')
  template.innerHTML = renderMessageEditorHtml(body, entities)

  // Keep the entity metadata for Msgnr and a normal link for other rich editors.
  for (const entity of template.content.querySelectorAll<HTMLElement>('span[data-message-entity-kind]')) {
    if (entity.dataset.messageEntityKind !== 'task' && entity.dataset.messageEntityKind !== 'document') continue
    const href = entity.dataset.messageEntityHref ?? ''
    if (!isSafeMessageUrl(href)) continue

    const link = document.createElement('a')
    const absoluteUrl = new URL(href, window.location.href)
    link.setAttribute('href', isSafeMessageUrl(absoluteUrl.href) ? absoluteUrl.href : href)
    link.textContent = entity.textContent
    entity.replaceChildren(link)
  }

  return template.innerHTML
}

export async function copyMessageToClipboard(body: string, entities: MessageEntity[] = []): Promise<void> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
  if (!clipboard) throw new Error('Clipboard is unavailable')

  if (typeof clipboard.write === 'function' && typeof ClipboardItem !== 'undefined') {
    try {
      if (typeof ClipboardItem.supports !== 'function' || ClipboardItem.supports('text/html')) {
        // text/plain must be the original source, even when HTML is also available.
        const item = new ClipboardItem({
          'text/plain': new Blob([body], { type: 'text/plain' }),
          'text/html': new Blob([renderClipboardHtml(body, entities)], { type: 'text/html' }),
        })
        await clipboard.write([item])
        return
      }
    } catch {
      // Some webviews expose rich clipboard APIs but reject HTML writes.
    }
  }

  if (typeof clipboard.writeText !== 'function') throw new Error('Clipboard is unavailable')
  await clipboard.writeText(body)
}
