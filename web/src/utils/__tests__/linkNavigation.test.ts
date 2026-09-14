import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Router } from 'vue-router'
import { handleMarkdownLinkClick, openMarkdownLink, resolveMarkdownLinkTarget } from '@/utils/linkNavigation'

const platformMocks = vi.hoisted(() => ({
  getPlatformOrNull: vi.fn(),
}))

vi.mock('@/platform', () => ({
  getPlatformOrNull: platformMocks.getPlatformOrNull,
}))

function createRouterMock() {
  const resolve = vi.fn((target: string) => {
    const matched = target.startsWith('/tasks') || target.startsWith('/documents') || target === '/' ? [{}] : []
    return {
      fullPath: target,
      matched,
    }
  })
  const push = vi.fn(async () => {})
  return { resolve, push } as unknown as Router & { resolve: typeof resolve; push: typeof push }
}

describe('linkNavigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    platformMocks.getPlatformOrNull.mockReturnValue(null)
    window.open = vi.fn(() => ({
      opener: null,
      focus: vi.fn(),
    } as unknown as Window))
    localStorage.removeItem('msgnr.desktop.backend_base_url')
  })

  it('classifies internal routes by router match', () => {
    const router = createRouterMock()
    const target = resolveMarkdownLinkTarget('/tasks/demo?tab=1#top', router)

    expect(target.kind).toBe('internal')
    expect(target.target).toBe('/tasks/demo?tab=1#top')
  })

  it('opens external links in a browser tab when no platform opener exists', async () => {
    const router = createRouterMock()

    await openMarkdownLink('https://example.com/docs', router)

    expect(router.push).not.toHaveBeenCalled()
    expect(window.open).toHaveBeenCalledWith('https://example.com/docs', '_blank')
  })

  it('uses the tauri opener when available', async () => {
    const openExternalUrl = vi.fn(async () => {})
    platformMocks.getPlatformOrNull.mockReturnValue({
      type: 'tauri',
      system: { openExternalUrl },
    })
    const router = createRouterMock()

    await openMarkdownLink('https://example.com/docs', router)

    expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/docs')
    expect(window.open).not.toHaveBeenCalled()
  })

  it('routes internal links through vue-router', async () => {
    const router = createRouterMock()

    await openMarkdownLink('/tasks/demo', router)

    expect(router.push).toHaveBeenCalledWith('/tasks/demo')
    expect(window.open).not.toHaveBeenCalled()
  })

  it('delegates attachment links to the provided callback', async () => {
    const router = createRouterMock()
    const onAttachmentLink = vi.fn(async () => {})

    await openMarkdownLink('msgnr-attachment://task/task-1/att-1', router, { onAttachmentLink })

    expect(onAttachmentLink).toHaveBeenCalledWith('msgnr-attachment://task/task-1/att-1')
    expect(window.open).not.toHaveBeenCalled()
  })

  it('classifies user mention links separately from internal and external links', () => {
    const router = createRouterMock()

    const target = resolveMarkdownLinkTarget('msgnr-mention://user/user-1', router)

    expect(target.kind).toBe('mention-user')
  })

  it('handles delegated markdown clicks on anchors', () => {
    const router = createRouterMock()
    const link = document.createElement('a')
    link.href = 'https://example.com/docs'
    const wrapper = document.createElement('div')
    wrapper.appendChild(link)

    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'target', { value: link })

    const handled = handleMarkdownLinkClick(event, router)

    expect(handled).toBe(true)
    expect(event.defaultPrevented).toBe(true)
  })

  it('delegates user mention clicks to the provided callback', () => {
    const router = createRouterMock()
    const link = document.createElement('a')
    link.href = 'msgnr-mention://user/user-1'
    const wrapper = document.createElement('div')
    wrapper.appendChild(link)
    const onUserMentionLink = vi.fn()

    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'target', { value: link })

    const handled = handleMarkdownLinkClick(event, router, { onUserMentionLink })

    expect(handled).toBe(true)
    expect(onUserMentionLink).toHaveBeenCalledWith('msgnr-mention://user/user-1', link, event)
    expect(router.push).not.toHaveBeenCalled()
  })
})
