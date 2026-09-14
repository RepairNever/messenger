import { describe, expect, it } from 'vitest'
import {
  diffTaskChangeMarkdown,
  diffTaskChangeWords,
  unifiedTaskChangeDiff,
} from '@/utils/taskChangeHistoryDiff'

describe('task change history unified word diff', () => {
  it('marks only the exchanged text within paired replacement lines', () => {
    const result = diffTaskChangeWords('Ship Backend today', 'Ship Frontend today')

    expect(result?.before).toEqual([
      { kind: 'context', value: 'Ship ' },
      { kind: 'removed', value: 'Backend' },
      { kind: 'context', value: ' today' },
    ])
    expect(result?.after).toEqual([
      { kind: 'context', value: 'Ship ' },
      { kind: 'added', value: 'Frontend' },
      { kind: 'context', value: ' today' },
    ])
  })

  it('adds word segments only to removed and added lines in the same replacement run', () => {
    const lines = diffTaskChangeMarkdown('Release v2.13.0 now', 'Release v2.14.0 now')
    const unified = unifiedTaskChangeDiff(lines)

    expect(unified).toHaveLength(2)
    expect(unified[0].kind).toBe('removed')
    expect(unified[0].segments).toContainEqual({ kind: 'removed', value: '13' })
    expect(unified[1].kind).toBe('added')
    expect(unified[1].segments).toContainEqual({ kind: 'added', value: '14' })
  })

  it('keeps unpaired additions at line level', () => {
    const unified = unifiedTaskChangeDiff(diffTaskChangeMarkdown('Existing line', 'Existing line\nNew line'))

    expect(unified).toContainEqual({ kind: 'added', value: 'New line' })
    expect(unified.find(line => line.kind === 'added')?.segments).toBeUndefined()
  })
})
