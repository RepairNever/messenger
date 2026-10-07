import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyMessageToClipboard } from '@/utils/messageClipboard'

class ClipboardItemMock {
  static supports = vi.fn(() => true)

  constructor(readonly data: Record<string, Blob>) {}
}

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

describe('copyMessageToClipboard', () => {
  let clipboardDescriptor: PropertyDescriptor | undefined
  const write = vi.fn()
  const writeText = vi.fn()

  beforeEach(() => {
    clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write, writeText } })
    vi.stubGlobal('ClipboardItem', ClipboardItemMock)
    write.mockReset().mockResolvedValue(undefined)
    writeText.mockReset().mockResolvedValue(undefined)
    ClipboardItemMock.supports.mockReset().mockReturnValue(true)
  })

  afterEach(() => {
    if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
    else Reflect.deleteProperty(navigator, 'clipboard')
    vi.unstubAllGlobals()
  })

  it('copies exact Markdown source alongside semantic HTML', async () => {
    const body = '  # Title\r\n\r\n**bold** and [link](https://example.com)  \r\nnext\r\n\r\n| A | B |\r\n| - | - |\r\n| one | two |\r\n\r\n```ts\r\nconst x = "<tag>"\r\n```\r\n  '
    await copyMessageToClipboard(body)

    const item = write.mock.calls[0]?.[0]?.[0] as ClipboardItemMock
    expect(await readBlob(item.data['text/plain']!)).toBe(body)
    const html = await readBlob(item.data['text/html']!)
    expect(html).toContain('<h1>Title</h1>')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<a href="https://example.com">link</a>')
    expect(html).toContain('<table>')
    const template = document.createElement('template')
    template.innerHTML = html
    expect(template.content.querySelector('pre code')?.textContent).toBe('const x = "<tag>"')
    expect(template.content.querySelector('button')).toBeNull()
    expect(writeText).not.toHaveBeenCalled()
  })

  it('keeps entity metadata and safe clickable task/document links in HTML', async () => {
    const body = '@Alice @TASK-42 @Design'
    await copyMessageToClipboard(body, [
      { kind: 'user', targetId: 'user-1', label: '@Alice', href: 'msgnr-mention://user/user-1', start: 0, end: 6 },
      { kind: 'task', targetId: 'task-42', label: '@TASK-42', href: '/tasks/task-42', start: 7, end: 15 },
      { kind: 'document', targetId: 'doc-1', label: '@Design', href: '/documents/doc-1', start: 16, end: 23 },
    ])

    const item = write.mock.calls[0]?.[0]?.[0] as ClipboardItemMock
    expect(await readBlob(item.data['text/plain']!)).toBe(body)
    const template = document.createElement('template')
    template.innerHTML = await readBlob(item.data['text/html']!)
    const user = template.content.querySelector('[data-message-entity-kind="user"]')!
    expect(user.getAttribute('data-message-entity-id')).toBe('user-1')
    expect(user.querySelector('a')).toBeNull()
    const task = template.content.querySelector('[data-message-entity-kind="task"]')!
    expect(task.getAttribute('data-message-entity-href')).toBe('/tasks/task-42')
    expect(task.querySelector('a')?.getAttribute('href')).toBe(new URL('/tasks/task-42', window.location.href).href)
    expect(template.content.querySelector('[data-message-entity-kind="document"] a')?.getAttribute('href'))
      .toBe(new URL('/documents/doc-1', window.location.href).href)
  })

  it('does not turn unsafe entity URLs into clickable HTML links', async () => {
    await copyMessageToClipboard('@Task', [
      { kind: 'task', targetId: 'task-1', label: '@Task', href: 'javascript:alert(1)', start: 0, end: 5 },
    ])
    const item = write.mock.calls[0]?.[0]?.[0] as ClipboardItemMock
    const template = document.createElement('template')
    template.innerHTML = await readBlob(item.data['text/html']!)
    expect(template.content.querySelector('a')).toBeNull()
    expect(template.content.querySelector('[data-message-entity-id="task-1"]')?.textContent).toBe('@Task')
  })

  it('falls back to exact raw text when HTML writes reject', async () => {
    write.mockRejectedValueOnce(new Error('HTML clipboard unsupported'))
    const body = '\n**raw**\n  '
    await copyMessageToClipboard(body)
    expect(writeText).toHaveBeenCalledWith(body)
  })

  it.each(['ClipboardItem', 'write', 'text/html'])('copies raw text when %s support is missing', async (missing) => {
    if (missing === 'ClipboardItem') vi.stubGlobal('ClipboardItem', undefined)
    if (missing === 'write') Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    if (missing === 'text/html') ClipboardItemMock.supports.mockReturnValue(false)
    const body = '\t- one\n\n  - two  \n'
    await copyMessageToClipboard(body)
    expect(write).not.toHaveBeenCalled()
    expect(writeText).toHaveBeenCalledWith(body)
  })

  it('rejects when the clipboard is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    await expect(copyMessageToClipboard('raw')).rejects.toThrow('Clipboard is unavailable')
  })

  it('rejects when both clipboard writes fail', async () => {
    write.mockRejectedValueOnce(new Error('rich write failed'))
    writeText.mockRejectedValueOnce(new Error('plain write failed'))
    await expect(copyMessageToClipboard('raw')).rejects.toThrow('plain write failed')
  })
})
