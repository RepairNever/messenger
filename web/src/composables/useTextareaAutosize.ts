import type { Ref } from 'vue'

interface UseTextareaAutosizeOptions {
  maxLines?: number | null
  onHeightDelta?: (deltaPx: number) => void
}

function parsePx(value: string | null | undefined): number {
  const parsed = Number.parseFloat(value ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

function getMinHeightPx(el: HTMLTextAreaElement): number {
  const style = window.getComputedStyle(el)
  return Math.ceil(parsePx(style.minHeight))
}

function getMaxHeightPx(el: HTMLTextAreaElement, maxLines: number): number {
  const style = window.getComputedStyle(el)
  const fontSize = parsePx(style.fontSize) || 16
  const lineHeight = parsePx(style.lineHeight) || (fontSize * 1.5)
  const paddingTop = parsePx(style.paddingTop)
  const paddingBottom = parsePx(style.paddingBottom)
  return Math.ceil((lineHeight * maxLines) + paddingTop + paddingBottom)
}

export function useTextareaAutosize(
  textareaRef: Ref<HTMLTextAreaElement | null>,
  options: UseTextareaAutosizeOptions = {},
) {
  let lastHeight = 0

  function emitDelta(nextHeight: number) {
    const previousHeight = lastHeight
    lastHeight = nextHeight
    if (previousHeight > 0 && previousHeight !== nextHeight) {
      options.onHeightDelta?.(nextHeight - previousHeight)
    }
  }

  function resize() {
    const el = textareaRef.value
    if (!el) return

    const minHeight = getMinHeightPx(el)
    el.style.height = '0px'

    if (typeof options.maxLines === 'number') {
      const maxHeight = Math.max(minHeight, getMaxHeightPx(el, options.maxLines))
      const nextHeight = Math.min(Math.max(el.scrollHeight, minHeight), maxHeight)
      el.style.maxHeight = `${maxHeight}px`
      el.style.height = `${nextHeight}px`
      el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden'
      emitDelta(nextHeight)
      return
    }

    const nextHeight = Math.max(el.scrollHeight, minHeight)
    el.style.maxHeight = ''
    el.style.height = `${nextHeight}px`
    el.style.overflowY = 'hidden'
    emitDelta(nextHeight)
  }

  function reset() {
    const el = textareaRef.value
    if (!el) {
      lastHeight = 0
      return
    }

    const nextHeight = getMinHeightPx(el)
    el.style.height = ''
    el.style.maxHeight = ''
    el.style.overflowY = ''
    emitDelta(nextHeight)
  }

  return {
    resize,
    reset,
  }
}
