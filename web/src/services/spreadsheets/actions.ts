import type { ICellData, IRange, IStyleData, IWorkbookData } from '@univerjs/core'
import type { SpreadsheetAction, SpreadsheetCellPatch, SpreadsheetState } from './types'

// Commands beyond this boundary must be reviewed and exercised in a browser
// before they can mutate an authored workbook. UI wrappers may select/show a
// dialog, but their eventual persistence command goes through this list.
export const AUTHORED_COMMAND_IDS = new Set([
  'sheet.command.set-range-values', 'sheet.command.set-style',
  'sheet.command.set-bold', 'sheet.command.set-italic', 'sheet.command.set-underline',
  'sheet.command.set-stroke', 'sheet.command.set-overline',
  'sheet.command.set-font-family', 'sheet.command.set-font-size',
  'sheet.command.set-text-color', 'sheet.command.reset-text-color',
  'sheet.command.set-background-color', 'sheet.command.reset-background-color',
  'sheet.command.set-horizontal-text-align', 'sheet.command.set-vertical-text-align',
  'sheet.command.set-text-wrap', 'sheet.command.set-text-rotation', 'sheet.command.set-shrink-to-fit',
  'sheet.command.set-border', 'sheet.command.set-border-basic',
  'sheet.command.clear-selection-all', 'sheet.command.clear-selection-format',
  'sheet.command.clear-selection-content', 'sheet.command.auto-clear-content',
  'sheet.command.auto-fill', 'sheet.command.copy-down', 'sheet.command.copy-right',
  'sheet.command.insert-row', 'sheet.command.insert-row-by-range',
  'sheet.command.insert-row-before', 'sheet.command.insert-row-after',
  'sheet.command.insert-multi-rows-above', 'sheet.command.insert-multi-rows-after',
  'sheet.command.insert-col', 'sheet.command.insert-col-by-range',
  'sheet.command.insert-col-before', 'sheet.command.insert-col-after',
  'sheet.command.insert-multi-cols-before', 'sheet.command.insert-multi-cols-right',
  'sheet.command.remove-row', 'sheet.command.remove-row-by-range',
  'sheet.command.remove-col', 'sheet.command.remove-col-by-range',
  'sheet.command.move-rows', 'sheet.command.move-cols', 'sheet.command.move-range',
  'sheet.command.delete-range-move-left', 'sheet.command.delete-range-move-up',
  'sheet.command.insert-range-move-down', 'sheet.command.insert-range-move-right',
  'sheet.command.add-worksheet-merge', 'sheet.command.add-worksheet-merge-all',
  'sheet.command.add-worksheet-merge-horizontal', 'sheet.command.add-worksheet-merge-vertical',
  'sheet.command.remove-worksheet-merge',
  'sheet.command.insert-sheet', 'sheet.command.copy-sheet', 'sheet.command.remove-sheet',
  'sheet.command.set-worksheet-name', 'sheet.command.set-worksheet-order',
  'sheet.command.set-worksheet-hidden', 'sheet.command.set-worksheet-show',
  'sheet.command.set-tab-color', 'sheet.command.set-row-height', 'sheet.command.set-row-is-auto-height',
  'sheet.command.delta-row-height', 'sheet.command.set-worksheet-col-width',
  'sheet.command.delta-column-width', 'sheet.command.set-rows-hidden',
  'sheet.command.set-col-hidden', 'sheet.command.set-specific-rows-visible',
  'sheet.command.set-col-visible-on-cols', 'sheet.command.set-selected-rows-visible',
  'sheet.command.set-selected-cols-visible', 'sheet.command.set-frozen',
  'sheet.command.cancel-frozen', 'sheet.command.toggle-gridlines',
  'sheet.command.numfmt.set.numfmt', 'sheet.command.numfmt.set.currency',
  'sheet.command.numfmt.set.percent', 'sheet.command.numfmt.add.decimal.command',
  'sheet.command.numfmt.subtract.decimal.command',
])


// Cell commands can build dense matrices before a diff is available. Bound
// their actual target up front; workbook structure has its separate limits.
const CELL_AREA_COMMAND_IDS = new Set([
  'sheet.command.set-range-values', 'sheet.command.set-style',
  'sheet.command.set-bold', 'sheet.command.set-italic', 'sheet.command.set-underline',
  'sheet.command.set-stroke', 'sheet.command.set-overline',
  'sheet.command.set-font-family', 'sheet.command.set-font-size',
  'sheet.command.set-text-color', 'sheet.command.reset-text-color',
  'sheet.command.set-background-color', 'sheet.command.reset-background-color',
  'sheet.command.set-horizontal-text-align', 'sheet.command.set-vertical-text-align',
  'sheet.command.set-text-wrap', 'sheet.command.set-text-rotation', 'sheet.command.set-shrink-to-fit',
  'sheet.command.set-border', 'sheet.command.set-border-basic',
  'sheet.command.clear-selection-all', 'sheet.command.clear-selection-format',
  'sheet.command.clear-selection-content', 'sheet.command.auto-clear-content',
  'sheet.command.auto-fill', 'sheet.command.copy-down', 'sheet.command.copy-right',
  'sheet.command.add-worksheet-merge', 'sheet.command.add-worksheet-merge-all',
  'sheet.command.add-worksheet-merge-horizontal', 'sheet.command.add-worksheet-merge-vertical',
  'sheet.command.remove-worksheet-merge',
  'sheet.command.numfmt.set.currency', 'sheet.command.numfmt.set.percent',
  'sheet.command.numfmt.add.decimal.command', 'sheet.command.numfmt.subtract.decimal.command',
])

export const SPREADSHEET_CELL_LIMIT_MESSAGE = 'This change supports at most 1,000 cells. Select a smaller range.'

export function assertBoundedCellShape(rows: number, columns: number) {
  if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(columns) || rows < 1 || columns < 1) {
    throw new Error('Invalid spreadsheet cell dimensions')
  }
  // Division prevents overflow before the limit check.
  if (rows > 1_000 / columns) throw new Error(SPREADSHEET_CELL_LIMIT_MESSAGE)
}

function validCellRanges(ranges: unknown, rowCount: number, columnCount: number): IRange[] {
  if (!Array.isArray(ranges) || !ranges.length) throw new Error('Select a cell range first')
  if (ranges.length > 1_000) throw new Error(SPREADSHEET_CELL_LIMIT_MESSAGE)
  for (const range of ranges) {
    if (!range || typeof range !== 'object') throw new Error('Invalid spreadsheet range')
    const { startRow, endRow, startColumn, endColumn } = range
    if (![startRow, endRow, startColumn, endColumn].every(Number.isSafeInteger)
      || startRow < 0 || startColumn < 0 || endRow < startRow || endColumn < startColumn
      || endRow >= rowCount || endColumn >= columnCount) throw new Error('Invalid spreadsheet range')
  }
  return ranges
}

export function assertBoundedCellRanges(ranges: unknown, rowCount: number, columnCount: number) {
  let total = 0
  for (const range of validCellRanges(ranges, rowCount, columnCount)) {
    const { startRow, endRow, startColumn, endColumn } = range
    const rows = endRow - startRow + 1, columns = endColumn - startColumn + 1
    assertBoundedCellShape(rows, columns)
    total += rows * columns
    if (total > 1_000) throw new Error(SPREADSHEET_CELL_LIMIT_MESSAGE)
  }
}

function intersects(first: IRange, second: IRange) {
  return first.startRow <= second.endRow && first.endRow >= second.startRow
    && first.startColumn <= second.endColumn && first.endColumn >= second.startColumn
}

export function assertClipboardCopyBounds(source: IWorkbookData, sheetId: string, ranges: unknown) {
  const sheet = source.sheets[sheetId]
  if (!sheet || !Number.isSafeInteger(sheet.rowCount) || !Number.isSafeInteger(sheet.columnCount)) throw new Error('Invalid copied worksheet')
  const selected = validCellRanges(ranges, sheet.rowCount!, sheet.columnCount!)
  assertBoundedCellRanges(selected, sheet.rowCount!, sheet.columnCount!)
  // Native getMatrixWithMergedCells iterates complete intersected merges even
  // if the captured selection itself covers only a small part of that merge.
  const merged = sheet.mergeData?.filter(merge => selected.some(range => intersects(range, merge))) ?? []
  if (merged.length) assertBoundedCellRanges(merged, sheet.rowCount!, sheet.columnCount!)
}

function assertAutofillBounds(source: IRange, selection: IRange, rows: number, columns: number) {
  assertBoundedCellRanges([source], rows, columns)
  validCellRanges([selection], rows, columns)
  // Pinned triggerAutoFill treats targetRange as the final selection, then
  // derives the destination outside its source (or a cleared strip on shrink).
  let destination: IRange | null = { ...selection }
  if (selection.endColumn < source.endColumn && selection.endColumn > source.startColumn) {
    destination.startColumn = selection.endColumn + 1; destination.endColumn = source.endColumn
  } else if (selection.endRow < source.endRow && selection.endRow > source.startRow) {
    destination.startRow = selection.endRow + 1; destination.endRow = source.endRow
  } else if (selection.startRow < source.startRow) destination.endRow = source.startRow - 1
  else if (selection.endRow > source.endRow) destination.startRow = source.endRow + 1
  else if (selection.startColumn < source.startColumn) destination.endColumn = source.startColumn - 1
  else if (selection.endColumn > source.endColumn) destination.startColumn = source.endColumn + 1
  else destination = null
  if (destination) assertBoundedCellRanges([destination], rows, columns)
}

function assertBoundedCellMatrix(value: Record<string, unknown>, rows: number, columns: number) {
  let count = 0
  for (const row in value) {
    if (!Object.prototype.hasOwnProperty.call(value, row)) continue
    if (!/^(0|[1-9]\d*)$/.test(row) || !Number.isSafeInteger(Number(row)) || Number(row) >= rows) throw new Error('Invalid spreadsheet row')
    const cells = value[row]
    if (!cells || typeof cells !== 'object' || Array.isArray(cells)) throw new Error('Invalid spreadsheet cell matrix')
    for (const column in cells) {
      if (!Object.prototype.hasOwnProperty.call(cells, column)) continue
      if (!/^(0|[1-9]\d*)$/.test(column) || !Number.isSafeInteger(Number(column)) || Number(column) >= columns) throw new Error('Invalid spreadsheet column')
      if (++count > 1_000) throw new Error(SPREADSHEET_CELL_LIMIT_MESSAGE)
    }
  }
}

export function assertCommandCellBounds(source: IWorkbookData, id: string, params: Record<string, unknown>, sheetId: string, selections: unknown) {
  if (!CELL_AREA_COMMAND_IDS.has(id) && id !== 'sheet.command.numfmt.set.numfmt') return
  const target = source.sheets[String(params.subUnitId ?? sheetId)]
  if (!target || !Number.isSafeInteger(target.rowCount) || !Number.isSafeInteger(target.columnCount)) throw new Error('Invalid worksheet for cell edit')
  const rows = target.rowCount!, columns = target.columnCount!
  if (id === 'sheet.command.auto-fill') {
    assertAutofillBounds(params.sourceRange as IRange, params.targetRange as IRange, rows, columns)
    return
  }
  if (id === 'sheet.command.copy-down' || id === 'sheet.command.copy-right') {
    const ranges = validCellRanges(selections, rows, columns), range = ranges[ranges.length - 1]
    const down = id === 'sheet.command.copy-down'
    const start = down ? range.startRow : range.startColumn, end = down ? range.endRow : range.endColumn
    if (start === end && start === 0) return
    const origin = start === end ? start - 1 : start
    const source = down ? { ...range, startRow: origin, endRow: origin } : { ...range, startColumn: origin, endColumn: origin }
    const selection = down ? { ...range, startRow: origin } : { ...range, startColumn: origin }
    assertAutofillBounds(source, selection, rows, columns)
    return
  }
  if (id === 'sheet.command.remove-worksheet-merge') {
    const ranges = validCellRanges(params.ranges ?? selections, rows, columns)
    const styledMerges = target.mergeData?.filter(merge => target.cellData?.[merge.startRow]?.[merge.startColumn]?.s
      && ranges.some(range => intersects(range, merge))) ?? []
    // Unmerge expands only anchor styles, and does so across the complete
    // merge. Sparse, unstyled geometry has no corresponding dense cell work.
    if (styledMerges.length) assertBoundedCellRanges(styledMerges, rows, columns)
    return
  }
  if (id.startsWith('sheet.command.add-worksheet-merge')) {
    const ranges = params.selections ?? selections
    assertClipboardCopyBounds(source, String(params.subUnitId ?? sheetId), ranges)
    return
  }
  if (id === 'sheet.command.set-range-values' && Array.isArray(params.value)) {
    if (params.value.length > 1_000) throw new Error(SPREADSHEET_CELL_LIMIT_MESSAGE)
    let count = 0
    for (const row of params.value) {
      if (!Array.isArray(row)) throw new Error('Invalid spreadsheet value matrix')
      count += row.length
      if (count > 1_000) throw new Error(SPREADSHEET_CELL_LIMIT_MESSAGE)
    }
  }
  if (id === 'sheet.command.set-style') {
    const values = (params.style as { value?: unknown } | undefined)?.value
    if (Array.isArray(values)) {
      if (values.length > 1_000) throw new Error(SPREADSHEET_CELL_LIMIT_MESSAGE)
      let count = 0
      for (const row of values) {
        if (!Array.isArray(row)) throw new Error('Invalid spreadsheet style matrix')
        count += row.length
        if (count > 1_000) throw new Error(SPREADSHEET_CELL_LIMIT_MESSAGE)
      }
    }
  }
  if (id === 'sheet.command.numfmt.set.numfmt') {
    const values = params.values
    if (!Array.isArray(values) || values.length > 1_000) throw new Error(SPREADSHEET_CELL_LIMIT_MESSAGE)
    for (const value of values) {
      if (!value || !Number.isSafeInteger(value.row) || !Number.isSafeInteger(value.col)
        || value.row < 0 || value.col < 0 || value.row >= rows || value.col >= columns) throw new Error('Invalid number format target')
    }
    return
  }
  if (id === 'sheet.command.set-range-values' && params.value && typeof params.value === 'object' && !Array.isArray(params.value)) {
    // Mirrors the pinned core isICellData predicate. Numeric-key objects are
    // sparse matrices whose actual entries, rather than selection, are changed.
    const value = params.value as Record<string, unknown>
    const cellKeys = ['s', 'p', 'v', 't', 'f', 'ft', 'fd', 'si', 'custom']
    if (!cellKeys.some(key => value[key] !== undefined)) {
      assertBoundedCellMatrix(value, rows, columns)
      return
    }
  }
  const range = id === 'sheet.command.auto-clear-content' ? params.clearRange : params.range
  assertBoundedCellRanges(range ? [range] : params.ranges ?? selections, rows, columns)
}

export function stableJSON(value: unknown): string {
  const plain = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(plain)
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, plain(value)]))
    return item
  }
  return JSON.stringify(plain(value))
}

function structureOf(book: IWorkbookData): unknown {
  // Styles on cells/dimensions have been expanded to independent values. The
  // remaining table is retained in structural snapshots for plugin resources.
  const { styles: _styles, sheets, ...metadata } = book
  return { ...metadata, sheets: Object.fromEntries(Object.entries(sheets).map(([id, sheet]) => {
    const { cellData: _cells, ...structure } = sheet
    return [id, structure]
  })) }
}

export function prepareWorkbookAction(base: SpreadsheetState, next: IWorkbookData, id: string): SpreadsheetAction | null {
  const common = { id, base_revision: base.revision, structure_epoch: base.structure_epoch }
  if (stableJSON(structureOf(base.workbook)) !== stableJSON(structureOf(next))) {
    return { ...common, kind: 'structure', workbook: structuredClone(next) }
  }
  const cells: { sheet_id: string; row: number; col: number; cell: ICellData | null }[] = []
  for (const sheetId of next.sheetOrder) {
    const before = base.workbook.sheets[sheetId]?.cellData ?? {}
    const after = next.sheets[sheetId]?.cellData ?? {}
    for (const row of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const columns = new Set([...Object.keys(before[Number(row)] ?? {}), ...Object.keys(after[Number(row)] ?? {})])
      for (const col of columns) {
        const previous = before[Number(row)]?.[Number(col)] ?? null
        const current = after[Number(row)]?.[Number(col)] ?? null
        if (stableJSON(previous) !== stableJSON(current)) {
          cells.push({ sheet_id: sheetId, row: Number(row), col: Number(col), cell: structuredClone(current) })
          if (cells.length > 1_000) throw new Error('This change affects more than 1,000 cells. Select a smaller range.')
        }
      }
    }
  }
  return cells.length ? { ...common, kind: 'cells', cells } : null
}

// The native editor starts from a displayed cell. Keep source style, adding
// only style properties explicitly changed during that edit. A computed number
// format is never inferred as a user format. Staging's own literal parser may
// still produce an authored date/percent format from the user's input.
export function authoredEditorCell(parsed: ICellData, source: ICellData | null, displayedStyle: IStyleData, explicitStyleKeys: string[] = []): ICellData {
  const cell = structuredClone(parsed)
  const authoredStyle: IStyleData = source?.s && typeof source.s === 'object' ? structuredClone(source.s) : {}
  const inputStyle: IStyleData = parsed.s && typeof parsed.s === 'object' ? parsed.s : {}
  for (const [key, value] of Object.entries(inputStyle)) {
    if (key !== 'n' && explicitStyleKeys.includes(key) && stableJSON(value) !== stableJSON(displayedStyle[key as keyof IStyleData])) {
      Object.assign(authoredStyle, { [key]: structuredClone(value) })
    }
  }
  cell.s = authoredStyle
  if (cell.f) { delete cell.v; delete cell.t; delete cell.si }
  return cell
}

export function inverseCells(action: SpreadsheetAction, before: IWorkbookData): SpreadsheetCellPatch[] | undefined {
  if (action.kind !== 'cells') return undefined
  return action.cells.map(cell => ({ ...cell,
    cell: structuredClone(before.sheets[cell.sheet_id]?.cellData?.[cell.row]?.[cell.col] ?? null),
  }))
}
