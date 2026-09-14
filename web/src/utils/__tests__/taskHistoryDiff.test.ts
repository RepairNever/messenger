import { describe, expect, it } from 'vitest'
import { buildRenderedMarkdownDiff, diffText } from '@/utils/taskHistoryDiff'

describe('taskHistoryDiff', () => {
  it('marks additions and preserves unchanged text', () => {
    expect(diffText('alpha beta', 'alpha gamma beta')).toEqual([
      { kind: 'equal', value: 'alpha ' },
      { kind: 'added', value: 'gamma ' },
      { kind: 'equal', value: 'beta' },
    ])
  })

  it('marks deletions', () => {
    expect(diffText('alpha stale beta', 'alpha beta')).toEqual([
      { kind: 'equal', value: 'alpha ' },
      { kind: 'removed', value: 'stale ' },
      { kind: 'equal', value: 'beta' },
    ])
  })

  it('keeps unchanged text as a single equal part', () => {
    expect(diffText('same text', 'same text')).toEqual([
      { kind: 'equal', value: 'same text' },
    ])
  })

  it('handles empty old and new values', () => {
    expect(diffText('', 'created')).toEqual([
      { kind: 'added', value: 'created' },
    ])
    expect(diffText('removed', '')).toEqual([
      { kind: 'removed', value: 'removed' },
    ])
  })

  it('handles multiline markdown text', () => {
    const parts = diffText('## Title\n\nOld line', '## Title\n\nNew line')
    expect(parts).toEqual([
      { kind: 'equal', value: '## Title\n\n' },
      { kind: 'removed', value: 'Old' },
      { kind: 'added', value: 'New' },
      { kind: 'equal', value: ' line' },
    ])
  })

  it('wraps rendered markdown additions and removals without dropping markup', () => {
    const diff = buildRenderedMarkdownDiff('## Old\n\nBody', '## New\n\nBody plus')

    expect(diff.hasChanges).toBe(true)
    expect(diff.beforeHtml).toContain('<h2>')
    expect(diff.afterHtml).toContain('<h2>')
    expect(diff.beforeHtml).toContain('data-testid="task-history-diff-removed"')
    expect(diff.afterHtml).toContain('data-testid="task-history-diff-added"')
  })
})
