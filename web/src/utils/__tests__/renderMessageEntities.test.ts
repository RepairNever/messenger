import { describe, expect, it } from 'vitest'
import { renderMessageBodyWithEntities } from '@/utils/renderMessageEntities'

describe('renderMessageBodyWithEntities', () => {
  it('renders user entities as interactive mention buttons', () => {
    const html = renderMessageBodyWithEntities('hello @Alice', [
      { kind: 'user', targetId: 'user-1', label: '@Alice', href: '', start: 6, end: 12 },
    ])

    expect(html).toContain('data-message-entity-kind="user"')
    expect(html).toContain('data-target-id="user-1"')
    expect(html).toContain('text-accent')
    expect(html).not.toContain('text-cyan')
    expect(html).toContain('@Alice')
  })

  it('renders task entities as links and keeps plain text markdown-rendered', () => {
    const html = renderMessageBodyWithEntities('task: @DEV-1 Demo', [
      { kind: 'task', targetId: 'task-1', label: '@DEV-1 Demo', href: '/tasks/dev-1', start: 6, end: 17 },
    ])

    expect(html).toContain('href="/tasks/dev-1"')
    expect(html).toContain('data-message-entity-kind="task"')
    expect(html).toContain('decoration-accent/40')
    expect(html).not.toContain('decoration-cyan')
    expect(html).toContain('task:')
  })

  it('renders multiline messages with normal paragraph wrappers around entities', () => {
    const html = renderMessageBodyWithEntities('before\n@Alice\nafter', [
      { kind: 'user', targetId: 'user-1', label: '@Alice', href: '', start: 7, end: 13 },
    ])

    expect(html).toContain('<p>')
    expect(html).toContain('<br>')
    expect(html).toContain('after')
  })

  it('preserves unordered lists when a list item contains a mention', () => {
    const body = '- first\n- @Alice\n- third'
    const start = body.indexOf('@Alice')
    const html = renderMessageBodyWithEntities(body, [
      { kind: 'user', targetId: 'user-1', label: '@Alice', href: '', start, end: start + '@Alice'.length },
    ])

    expect(html).toContain('<ul>')
    expect(html).toContain('<li>first</li>')
    expect(html).toContain('data-message-entity-kind="user"')
    expect(html).toContain('<li><button')
    expect(html).toContain('<li>third</li>')
  })

  it('preserves ordered lists when a list item contains a mention', () => {
    const body = '1. first\n2. @Alice\n3. third'
    const start = body.indexOf('@Alice')
    const html = renderMessageBodyWithEntities(body, [
      { kind: 'user', targetId: 'user-1', label: '@Alice', href: '', start, end: start + '@Alice'.length },
    ])

    expect(html).toContain('<ol>')
    expect(html).toContain('<li>first</li>')
    expect(html).toContain('data-message-entity-kind="user"')
    expect(html).toContain('<li><button')
    expect(html).toContain('<li>third</li>')
  })

  it('keeps syntax highlighting when rendering messages with entities', () => {
    const body = 'Review @Alice\n\n```sql\nSELECT id FROM users WHERE active = true;\n```'
    const start = body.indexOf('@Alice')
    const html = renderMessageBodyWithEntities(body, [
      { kind: 'user', targetId: 'user-1', label: '@Alice', href: '', start, end: start + '@Alice'.length },
    ])

    expect(html).toContain('data-message-entity-kind="user"')
    expect(html).toContain('language-sql')
    expect(html).toContain('<span class="hljs-keyword">SELECT</span>')
  })
})
