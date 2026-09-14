import type { MessageEntity } from '@/stores/chat'

export interface MentionQueryMatch {
  start: number
  end: number
  query: string
}

export function sortMessageEntities(entities: MessageEntity[]): MessageEntity[] {
  return [...entities].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start
    return a.end - b.end
  })
}

export function mentionedUserIdsFromMessageEntities(entities: MessageEntity[]): string[] {
  return entities.filter(entity => entity.kind === 'user').map(entity => entity.targetId)
}

export function applyTextEditToEntities(
  entities: MessageEntity[],
  editStart: number,
  editEnd: number,
  insertedLength: number,
): MessageEntity[] {
  const delta = insertedLength - (editEnd - editStart)
  const next: MessageEntity[] = []
  for (const entity of entities) {
    if (entity.end <= editStart) {
      next.push(entity)
      continue
    }
    if (entity.start >= editEnd) {
      next.push({
        ...entity,
        start: entity.start + delta,
        end: entity.end + delta,
      })
      continue
    }
    // Any overlap invalidates the entity.
  }
  return sortMessageEntities(next)
}

export function removeEntityAroundCursor(
  text: string,
  entities: MessageEntity[],
  cursor: number,
  direction: 'backward' | 'forward',
): { text: string; entities: MessageEntity[]; nextCursor: number } | null {
  const target = entities.find(entity => {
    if (direction === 'backward') {
      return entity.end === cursor
    }
    return entity.start === cursor
  })
  if (!target) return null

  const nextText = text.slice(0, target.start) + text.slice(target.end)
  const nextEntities = applyTextEditToEntities(
    entities.filter(entity => entity !== target),
    target.start,
    target.end,
    0,
  )
  return {
    text: nextText,
    entities: nextEntities,
    nextCursor: target.start,
  }
}

export function replaceTextRangeWithEntity(
  text: string,
  entities: MessageEntity[],
  rangeStart: number,
  rangeEnd: number,
  entity: MessageEntity,
  appendSpace = true,
): { text: string; entities: MessageEntity[]; nextCursor: number } {
  const suffix = appendSpace ? ' ' : ''
  const insertedText = entity.label + suffix
  const baseEntities = applyTextEditToEntities(entities, rangeStart, rangeEnd, insertedText.length)
  const nextText = text.slice(0, rangeStart) + insertedText + text.slice(rangeEnd)
  const nextEntity: MessageEntity = {
    ...entity,
    start: rangeStart,
    end: rangeStart + entity.label.length,
  }
  return {
    text: nextText,
    entities: sortMessageEntities([...baseEntities, nextEntity]),
    nextCursor: rangeStart + insertedText.length,
  }
}

export function isCursorInsideEntity(entities: MessageEntity[], cursor: number): boolean {
  return entities.some(entity => cursor > entity.start && cursor < entity.end)
}

export function findMentionQuery(
  text: string,
  cursor: number,
  entities: MessageEntity[],
): MentionQueryMatch | null {
  if (cursor < 0 || cursor > text.length) return null
  if (isCursorInsideEntity(entities, cursor)) return null

  let start = cursor
  while (start > 0) {
    const previous = text[start - 1]
    if (previous === '\n' || previous === '\r' || previous === '\t' || previous === ' ') {
      break
    }
    start -= 1
  }
  const token = text.slice(start, cursor)
  if (!token.startsWith('@')) return null
  return {
    start,
    end: cursor,
    query: token.slice(1),
  }
}
