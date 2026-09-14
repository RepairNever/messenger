import { describe, expect, it } from 'vitest'
import {
  applyTextEditToEntities,
  findMentionQuery,
  removeEntityAroundCursor,
  replaceTextRangeWithEntity,
} from '@/utils/messageEntities'

describe('messageEntities', () => {
  it('replaces a query range with an entity and trailing space', () => {
    const next = replaceTextRangeWithEntity(
      'hello @al',
      [],
      6,
      9,
      {
        kind: 'user',
        targetId: 'user-1',
        label: '@Alice',
        href: '',
        start: 6,
        end: 9,
      },
    )

    expect(next.text).toBe('hello @Alice ')
    expect(next.entities).toEqual([{
      kind: 'user',
      targetId: 'user-1',
      label: '@Alice',
      href: '',
      start: 6,
      end: 12,
    }])
  })

  it('drops an entity when edited through its range', () => {
    const next = applyTextEditToEntities(
      [{ kind: 'task', targetId: 'task-1', label: '@DEV-1 Demo', href: '/tasks/dev-1', start: 0, end: 11 }],
      5,
      5,
      1,
    )

    expect(next).toEqual([])
  })

  it('removes a whole entity on backspace at its boundary', () => {
    const removed = removeEntityAroundCursor(
      'hello @Alice world',
      [{ kind: 'user', targetId: 'user-1', label: '@Alice', href: '', start: 6, end: 12 }],
      12,
      'backward',
    )

    expect(removed?.text).toBe('hello  world')
    expect(removed?.entities).toEqual([])
    expect(removed?.nextCursor).toBe(6)
  })

  it('finds the active mention token at the caret', () => {
    expect(findMentionQuery('hello @ali', 10, [])).toEqual({
      start: 6,
      end: 10,
      query: 'ali',
    })
  })
})
