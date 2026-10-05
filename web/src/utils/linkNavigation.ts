import type { Router } from 'vue-router'
import { getPlatformOrNull } from '@/platform'
import { getBackendBaseUrl } from '@/services/runtime/backendEndpoint'
import { openHrefInBrowser } from '@/utils/attachmentBrowser'

export interface MarkdownLinkNavigationOptions {
  onAttachmentLink?: (href: string) => Promise<void> | void
  onUserMentionLink?: (href: string, link: HTMLAnchorElement, event: MouseEvent) => Promise<void> | void
}

function hasScheme(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(value)
}

function resolveUrl(href: string): URL | null {
  const trimmed = href.trim()
  if (!trimmed) return null
  if (typeof window === 'undefined') return null

  try {
    return new URL(trimmed, window.location.href)
  } catch {
    return null
  }
}

function resolveBackendOrigin(): string {
  const base = getBackendBaseUrl().trim()
  if (!base || typeof window === 'undefined') return ''

  try {
    return new URL(base, window.location.href).origin
  } catch {
    return ''
  }
}

function isInternalHttpUrl(url: URL): boolean {
  if (typeof window === 'undefined') return false
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false

  const currentOrigin = window.location.origin
  const backendOrigin = resolveBackendOrigin()
  return url.origin === currentOrigin || (backendOrigin !== '' && url.origin === backendOrigin)
}

function isAttachmentHref(href: string): boolean {
  const trimmed = href.trim()
  return trimmed.startsWith('msgnr-attachment://') || trimmed.startsWith('msgnr-staged-attachment://')
}

function isUserMentionHref(href: string): boolean {
  return href.trim().startsWith('msgnr-mention://user/')
}

// Schemes a message author may link to. Everything else (javascript:, data:,
// vbscript:, file:, ...) must never become clickable content and must never
// reach openMarkdownLink. The click delegation in handleMarkdownLinkClick is
// only the first line of defense: auxiliary clicks (middle-click,
// modifier-click, the browser context menu) bypass it and use the browser's
// default navigation.
const SAFE_URL_SCHEMES = new Set(['http:', 'https:', 'mailto:'])

/**
 * True when href is safe to render as a clickable link. Relative URLs and the
 * app's msgnr-* pseudo-schemes are allowed; absolute URLs must carry a scheme
 * from the allowlist.
 */
export function isSafeMessageUrl(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false
  if (isAttachmentHref(trimmed) || isUserMentionHref(trimmed)) return true
  if (!hasScheme(trimmed)) return true
  try {
    return SAFE_URL_SCHEMES.has(new URL(trimmed).protocol)
  } catch {
    return false
  }
}

export function resolveMarkdownLinkTarget(href: string, router: Router): { kind: 'invalid' | 'attachment' | 'mention-user' | 'internal' | 'external'; href: string; target?: string } {
  const trimmed = href.trim()
  if (!trimmed) {
    return { kind: 'invalid', href: trimmed }
  }

  if (isAttachmentHref(trimmed)) {
    return { kind: 'attachment', href: trimmed }
  }

  if (isUserMentionHref(trimmed)) {
    return { kind: 'mention-user', href: trimmed }
  }

  if (!isSafeMessageUrl(trimmed)) {
    return { kind: 'invalid', href: trimmed }
  }

  const url = resolveUrl(trimmed)
  if (!url) {
    return { kind: 'invalid', href: trimmed }
  }

  if (!hasScheme(trimmed) || isInternalHttpUrl(url)) {
    const target = `${url.pathname}${url.search}${url.hash}`
    const resolved = router.resolve(target)
    if (resolved.matched.length > 0) {
      return {
        kind: 'internal',
        href: trimmed,
        target: resolved.fullPath,
      }
    }
  }

  return {
    kind: 'external',
    href: trimmed,
    target: url.toString(),
  }
}

export async function openMarkdownLink(
  href: string,
  router: Router,
  options: MarkdownLinkNavigationOptions = {},
): Promise<boolean> {
  const target = resolveMarkdownLinkTarget(href, router)

  if (target.kind === 'invalid') {
    return false
  }

  if (target.kind === 'attachment') {
    if (options.onAttachmentLink) {
      await options.onAttachmentLink(target.href)
      return true
    }
    return false
  }

  if (target.kind === 'mention-user') {
    return false
  }

  if (target.kind === 'internal') {
    await router.push(target.target ?? target.href)
    return true
  }

  const platform = getPlatformOrNull()
  if (platform?.type === 'tauri' && platform.system.openExternalUrl) {
    await platform.system.openExternalUrl(target.target ?? target.href)
    return true
  }

  openHrefInBrowser(target.target ?? target.href)
  return true
}

export function handleMarkdownLinkClick(
  event: MouseEvent,
  router: Router,
  options: MarkdownLinkNavigationOptions = {},
): boolean {
  if (event.defaultPrevented) return false
  if (event.button !== 0) return false
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false

  const target = event.target
  if (!(target instanceof HTMLElement)) return false

  const link = target.closest('a[href]')
  if (!(link instanceof HTMLAnchorElement)) return false

  const href = link.getAttribute('href') ?? ''
  const targetInfo = resolveMarkdownLinkTarget(href, router)
  if (targetInfo.kind === 'mention-user') {
    if (options.onUserMentionLink) {
      event.preventDefault()
      void options.onUserMentionLink(href, link, event)
      return true
    }
    return false
  }
  event.preventDefault()
  void openMarkdownLink(href, router, options)
  return true
}
