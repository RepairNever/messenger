export type TaskChangeDiffKind = 'context' | 'added' | 'removed'

export interface TaskChangeDiffLine {
  kind: TaskChangeDiffKind
  value: string
}

export interface TaskChangeInlineDiffLine {
  before: TaskChangeDiffLine | null
  after: TaskChangeDiffLine | null
}

export type TaskChangeDiffSegmentKind = 'context' | 'added' | 'removed'

export interface TaskChangeDiffSegment {
  kind: TaskChangeDiffSegmentKind
  value: string
}

export interface TaskChangeUnifiedDiffLine extends TaskChangeDiffLine {
  /** Present only when this line has a paired replacement for word diffing. */
  segments?: TaskChangeDiffSegment[]
}

const MAX_LCS_CELLS = 160_000
const MAX_WORD_LCS_CELLS = 25_000

function splitLines(value: string): string[] {
  return value.replace(/\r\n/g, '\n').split('\n')
}

/**
 * Produces a compact, line-oriented diff for task-description Markdown. A
 * bounded fallback avoids quadratic work for exceptionally large documents.
 */
export function diffTaskChangeMarkdown(before: string, after: string): TaskChangeDiffLine[] {
  const oldLines = splitLines(before)
  const newLines = splitLines(after)

  if (oldLines.length * newLines.length > MAX_LCS_CELLS) {
    return [
      ...oldLines.map(value => ({ kind: 'removed' as const, value })),
      ...newLines.map(value => ({ kind: 'added' as const, value })),
    ]
  }

  const rows = oldLines.length + 1
  const cols = newLines.length + 1
  const dp = Array.from({ length: rows }, () => new Uint32Array(cols))
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      dp[oldIndex][newIndex] = oldLines[oldIndex] === newLines[newIndex]
        ? dp[oldIndex + 1][newIndex + 1] + 1
        : Math.max(dp[oldIndex + 1][newIndex], dp[oldIndex][newIndex + 1])
    }
  }

  const output: TaskChangeDiffLine[] = []
  let oldIndex = 0
  let newIndex = 0
  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      output.push({ kind: 'context', value: oldLines[oldIndex] })
      oldIndex += 1
      newIndex += 1
    } else if (dp[oldIndex + 1][newIndex] >= dp[oldIndex][newIndex + 1]) {
      output.push({ kind: 'removed', value: oldLines[oldIndex] })
      oldIndex += 1
    } else {
      output.push({ kind: 'added', value: newLines[newIndex] })
      newIndex += 1
    }
  }
  while (oldIndex < oldLines.length) {
    output.push({ kind: 'removed', value: oldLines[oldIndex] })
    oldIndex += 1
  }
  while (newIndex < newLines.length) {
    output.push({ kind: 'added', value: newLines[newIndex] })
    newIndex += 1
  }
  return output
}

/** Pairs deletion/addition runs for the two-column Inline presentation. */
export function inlineTaskChangeDiff(lines: TaskChangeDiffLine[]): TaskChangeInlineDiffLine[] {
  const output: TaskChangeInlineDiffLine[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line.kind === 'context') {
      output.push({ before: line, after: line })
      index += 1
      continue
    }

    const removed: TaskChangeDiffLine[] = []
    const added: TaskChangeDiffLine[] = []
    while (index < lines.length && lines[index].kind !== 'context') {
      if (lines[index].kind === 'removed') removed.push(lines[index])
      else added.push(lines[index])
      index += 1
    }
    const count = Math.max(removed.length, added.length)
    for (let pairIndex = 0; pairIndex < count; pairIndex += 1) {
      output.push({
        before: removed[pairIndex] ?? null,
        after: added[pairIndex] ?? null,
      })
    }
  }
  return output
}

/**
 * Builds Unified-view lines with stronger segments for actual word changes in
 * paired removal/addition lines. Unpaired lines deliberately remain at the
 * line level so unrelated text is never presented as a replacement.
 */
export function unifiedTaskChangeDiff(lines: TaskChangeDiffLine[]): TaskChangeUnifiedDiffLine[] {
  const output: TaskChangeUnifiedDiffLine[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line.kind === 'context') {
      output.push(line)
      index += 1
      continue
    }

    const removed: TaskChangeDiffLine[] = []
    const added: TaskChangeDiffLine[] = []
    while (index < lines.length && lines[index].kind !== 'context') {
      if (lines[index].kind === 'removed') removed.push(lines[index])
      else added.push(lines[index])
      index += 1
    }

    const renderedRemoved: TaskChangeUnifiedDiffLine[] = removed.map(line => ({ ...line }))
    const renderedAdded: TaskChangeUnifiedDiffLine[] = added.map(line => ({ ...line }))
    const pairCount = Math.min(removed.length, added.length)
    for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
      const removedLine = removed[pairIndex]
      const addedLine = added[pairIndex]
      if (removedLine.value === '' || addedLine.value === '') continue
      const segments = diffTaskChangeWords(removedLine.value, addedLine.value)
      if (!segments) continue
      renderedRemoved[pairIndex].segments = segments.before
      renderedAdded[pairIndex].segments = segments.after
    }
    output.push(...renderedRemoved, ...renderedAdded)
  }
  return output
}

/**
 * Splits a pair of replacement lines into context, removed, and added tokens.
 * Whitespace and punctuation are retained verbatim, so rendered Markdown
 * remains faithful to its source. Returns null when the pair is too large for
 * bounded LCS work.
 */
export function diffTaskChangeWords(
  before: string,
  after: string,
): { before: TaskChangeDiffSegment[]; after: TaskChangeDiffSegment[] } | null {
  const beforeTokens = splitWordTokens(before)
  const afterTokens = splitWordTokens(after)
  if (beforeTokens.length * afterTokens.length > MAX_WORD_LCS_CELLS) return null

  const rows = beforeTokens.length + 1
  const cols = afterTokens.length + 1
  const dp = Array.from({ length: rows }, () => new Uint16Array(cols))
  for (let beforeIndex = beforeTokens.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = afterTokens.length - 1; afterIndex >= 0; afterIndex -= 1) {
      dp[beforeIndex][afterIndex] = beforeTokens[beforeIndex] === afterTokens[afterIndex]
        ? dp[beforeIndex + 1][afterIndex + 1] + 1
        : Math.max(dp[beforeIndex + 1][afterIndex], dp[beforeIndex][afterIndex + 1])
    }
  }

  const beforeSegments: TaskChangeDiffSegment[] = []
  const afterSegments: TaskChangeDiffSegment[] = []
  let beforeIndex = 0
  let afterIndex = 0
  while (beforeIndex < beforeTokens.length && afterIndex < afterTokens.length) {
    if (beforeTokens[beforeIndex] === afterTokens[afterIndex]) {
      appendSegment(beforeSegments, 'context', beforeTokens[beforeIndex])
      appendSegment(afterSegments, 'context', afterTokens[afterIndex])
      beforeIndex += 1
      afterIndex += 1
    } else if (dp[beforeIndex + 1][afterIndex] >= dp[beforeIndex][afterIndex + 1]) {
      appendSegment(beforeSegments, 'removed', beforeTokens[beforeIndex])
      beforeIndex += 1
    } else {
      appendSegment(afterSegments, 'added', afterTokens[afterIndex])
      afterIndex += 1
    }
  }
  while (beforeIndex < beforeTokens.length) {
    appendSegment(beforeSegments, 'removed', beforeTokens[beforeIndex])
    beforeIndex += 1
  }
  while (afterIndex < afterTokens.length) {
    appendSegment(afterSegments, 'added', afterTokens[afterIndex])
    afterIndex += 1
  }
  return { before: beforeSegments, after: afterSegments }
}

function splitWordTokens(value: string): string[] {
  return value.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]+/gu) ?? []
}

function appendSegment(segments: TaskChangeDiffSegment[], kind: TaskChangeDiffSegmentKind, value: string) {
  const previous = segments[segments.length - 1]
  if (previous?.kind === kind) {
    previous.value += value
    return
  }
  segments.push({ kind, value })
}
