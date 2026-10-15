import { describe, expect, it, vi } from 'vitest'
import type { IWorkbookData } from '@univerjs/core'
import { assertClipboardCopyBounds, assertCommandCellBounds } from '../actions'
import { assertNativeClipboardPayload, installNativeClipboardGuards, installNumberFormatGuards } from '../editor'
import { ComponentManager, type IDocClipboardService, type IDocClipboardHook } from '@univerjs/preset-sheets-core'
import { assertClipboardInputBounds, MAX_SPREADSHEET_CLIPBOARD_BYTES, type ClipboardInput } from '../staging'

type IDocClipboardPayload = Parameters<IDocClipboardService['legacyPaste']>[0]

const workbook = { id: 'bounded', sheetOrder: ['sheet'], sheets: {
  sheet: { id: 'sheet', rowCount: 1_000, columnCount: 100, cellData: {} },
} } as unknown as IWorkbookData
const cell = { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 }
const thousand = { ...cell, endRow: 999 }
const wholeBook = { ...thousand, endColumn: 99 }
const clipboard = (extra: Partial<ClipboardInput>): ClipboardInput => ({ sheetId: 'sheet', range: cell, ...extra })
const check = (input: Partial<ClipboardInput>) => assertClipboardInputBounds(workbook, clipboard(input))
const command = (id: string, params: Record<string, unknown> = {}, selection = [cell]) => assertCommandCellBounds(workbook, id, params, 'sheet', selection)

describe('spreadsheet preparation limits', () => {
  it('rejects a whole-sheet format before dense style and number-format wrappers run', () => {
    expect(() => command('sheet.command.set-bold', {}, [wholeBook])).toThrow('1,000')
    expect(() => command('sheet.command.numfmt.set.percent', {}, [wholeBook])).toThrow('1,000')
    expect(() => command('sheet.command.set-bold', {}, [thousand])).not.toThrow()
    expect(() => command('sheet.command.set-bold', {}, [thousand, cell])).toThrow('1,000')
    expect(() => command('sheet.command.set-worksheet-col-width', { value: 80 }, [wholeBook])).not.toThrow()
  })

  it('checks explicit format targets independently from a small selection', () => {
    const values = Array.from({ length: 1_001 }, (_, index) => ({ row: index % 1_000, col: 0, pattern: '0%' }))
    expect(() => command('sheet.command.numfmt.set.numfmt', { values })).toThrow('1,000')
    expect(() => command('sheet.command.numfmt.set.numfmt', { values: [{ row: 1_000, col: 0, pattern: '0' }] })).toThrow('target')
    expect(() => command('sheet.command.numfmt.set.numfmt', { values: [{ row: 999, col: 99, pattern: '0' }] })).not.toThrow()
  })

  it('checks matrix cardinality before cloning and allows small sparse matrices outside the selection', () => {
    expect(() => command('sheet.command.set-range-values', { value: [Array(1_001).fill(1)], range: cell })).toThrow('1,000')
    expect(() => command('sheet.command.set-style', { style: { value: [Array(1_001).fill({ bl: 1 })] }, range: cell })).toThrow('1,000')
    expect(() => command('sheet.command.set-range-values', { value: { 999: { 99: { v: 1 } } } }, [wholeBook])).not.toThrow()
    expect(() => command('sheet.command.set-range-values', { value: { 1_000: { 0: { v: 1 } } } })).toThrow('row')
  })

  it('checks both fill source and target and refuses nonfinite or out-of-sheet ranges', () => {
    expect(() => command('sheet.command.auto-fill', { sourceRange: cell, targetRange: wholeBook })).toThrow('1,000')
    expect(() => command('sheet.command.auto-fill', { sourceRange: wholeBook, targetRange: cell })).toThrow('1,000')
    expect(() => command('sheet.command.set-style', {}, [{ ...cell, endRow: Infinity }])).toThrow('range')
    expect(() => command('sheet.command.set-style', {}, [{ ...cell, endColumn: 100 }])).toThrow('range')
  })

  it('bounds native copying before Facade generates clipboard matrices, including intersected merges', () => {
    expect(() => assertClipboardCopyBounds(workbook, 'sheet', [wholeBook])).toThrow('1,000')
    expect(() => assertClipboardCopyBounds(workbook, 'sheet', [thousand])).not.toThrow()
    const merged = structuredClone(workbook)
    merged.sheets.sheet.mergeData = [wholeBook]
    expect(() => assertClipboardCopyBounds(merged, 'sheet', [cell])).toThrow('1,000')
  })

  it('limits actual unmerge style expansion while allowing large unstyled geometry removal', () => {
    const merged = structuredClone(workbook)
    merged.sheets.sheet.mergeData = [wholeBook]
    expect(() => assertCommandCellBounds(merged, 'sheet.command.remove-worksheet-merge', { ranges: [cell] }, 'sheet', [cell])).not.toThrow()
    merged.sheets.sheet.cellData = { 0: { 0: { s: { bl: 1 } } } }
    expect(() => assertCommandCellBounds(merged, 'sheet.command.remove-worksheet-merge', { ranges: [cell] }, 'sheet', [cell])).toThrow('1,000')
  })

  it('bounds each add-merge path and complete merges encountered by native preparation', () => {
    for (const id of ['sheet.command.add-worksheet-merge', 'sheet.command.add-worksheet-merge-all',
      'sheet.command.add-worksheet-merge-horizontal', 'sheet.command.add-worksheet-merge-vertical']) {
      expect(() => command(id, { selections: [wholeBook] })).toThrow('1,000')
      expect(() => command(id, { selections: [{ ...cell, endColumn: 1 }] })).not.toThrow()
    }
    const merged = structuredClone(workbook)
    merged.sheets.sheet.mergeData = [wholeBook]
    expect(() => assertCommandCellBounds(merged, 'sheet.command.add-worksheet-merge', { selections: [cell] }, 'sheet', [cell])).toThrow('1,000')
  })

  it('counts the fill destination outside source and permits a one-cell extension of a thousand-cell source', () => {
    const expanded = structuredClone(workbook)
    expanded.sheets.sheet.rowCount = 2_000
    const run = (sourceRange: typeof cell, targetRange: typeof cell) => assertCommandCellBounds(expanded,
      'sheet.command.auto-fill', { sourceRange, targetRange }, 'sheet', [cell])
    expect(() => run(thousand, { ...thousand, endRow: 1_000 })).not.toThrow()
    expect(() => run(thousand, { ...thousand, endRow: 1_999 })).not.toThrow()
    expect(() => run(cell, { ...cell, endRow: 1_001 })).toThrow('1,000')
    expect(() => run({ ...cell, startRow: 1_000, endRow: 1_000 }, { ...cell, endRow: 1_000 })).not.toThrow()
    expect(() => assertCommandCellBounds(expanded, 'sheet.command.copy-down', {}, 'sheet', [{ ...cell, endRow: 1_000 }])).not.toThrow()
    expect(() => assertCommandCellBounds(expanded, 'sheet.command.copy-down', {}, 'sheet', [{ ...cell, endRow: 1_001 }])).toThrow('1,000')
  })
})

describe('native number-format allocation callbacks', () => {
  it('blocks the native dropdown before its click callback and checks sidebar confirmation against current selection', () => {
    const manager = new ComponentManager()
    const NativeOptions = () => null, NativePanel = () => null
    manager.register('sheets-numfmt-ui.moreNumfmtType.options', NativeOptions)
    manager.register('SHEET_NUMFMT_PANEL', NativePanel)
    let allowed = false
    const checks: boolean[] = [], changes: string[] = []
    const guards = installNumberFormatGuards(manager, all => { checks.push(all); return allowed })
    const dropdown = manager.get('sheets-numfmt-ui.moreNumfmtType.options')({})
    let stopped = false, prevented = false
    dropdown.props.onClickCapture({ stopPropagation: () => { stopped = true }, preventDefault: () => { prevented = true } })
    expect(stopped && prevented).toBe(true)
    expect(dropdown.props.children.type).toBe(NativeOptions)
    const panel = manager.get('SHEET_NUMFMT_PANEL')({ onChange: (change: { type: string }) => changes.push(change.type) })
    expect(panel.type).toBe(NativePanel)
    panel.props.onChange({ type: 'change', value: '0.0000' })
    panel.props.onChange({ type: 'confirm', value: '0.0000' })
    expect(changes).toEqual(['change'])
    allowed = true
    panel.props.onChange({ type: 'confirm', value: '0.0000' })
    panel.props.onChange({ type: 'cancel' })
    expect(changes).toEqual(['change', 'confirm', 'cancel'])
    expect(checks).toEqual([false, true, true])
    guards.forEach(guard => guard.dispose())
    expect(manager.get('SHEET_NUMFMT_PANEL')).toBeUndefined()
    manager.dispose()
  })
})

describe('native Docs clipboard public boundary', () => {
  const deferred = <T,>() => {
    let resolve!: (value: T) => void
    return { promise: new Promise<T>(yes => { resolve = yes }), resolve: (value: T) => resolve(value) }
  }
  const item = (types: Record<string, { size: number; text: () => Promise<string> } | Blob>) => ({
    types: Object.keys(types), getType: async (type: string) => types[type] as Blob,
  }) as unknown as ClipboardItem
  const blob = (value: string) => ({ size: new TextEncoder().encode(value).length, text: vi.fn(async () => value) })
  const setup = (read: () => Promise<ClipboardItem[]> = async () => [], convert?: () => Promise<void>, documentData = {}) => {
    let target: string | null = 'draft-A', hook: IDocClipboardHook | undefined
    const accepted: IDocClipboardPayload[] = [], errors: Error[] = []
    const nativeLegacy = vi.fn(async (payload: IDocClipboardPayload) => {
      service.dismissPasteOptions()
      if (convert) await convert()
      hook?.onBeforePaste?.({ dataStream: 'native\r\n' }, { documentData, targetUnitId: 'doc' })
      accepted.push(payload)
      return true
    })
    const nativePaste = vi.fn(async () => true), nativeFrom = vi.fn(async () => true)
    const nativeDismiss = vi.fn()
    const service = { paste: nativePaste, pasteFromClipboard: nativeFrom, legacyPaste: nativeLegacy,
      dismissPasteOptions: nativeDismiss, addClipboardHook: (value: IDocClipboardHook) => {
        hook = value; return { dispose: () => { hook = undefined } }
      },
    } as unknown as IDocClipboardService
    const clipboard = { supportClipboard: true, read }
    const guard = installNativeClipboardGuards(service, clipboard, () => target, error => errors.push(error))
    return { service, clipboard, guard, accepted, errors, nativeLegacy, nativePaste, nativeFrom, nativeDismiss,
      target: (value: string | null) => { target = value }, hook: () => hook }
  }

  it('checks every supported MIME blob before decoding any text', async () => {
    const text = blob('small'), huge = { size: MAX_SPREADSHEET_CLIPBOARD_BYTES, text: vi.fn(async () => 'huge') }
    const state = setup()
    expect(await state.service.paste([item({ 'text/plain': text, 'text/html': huge })])).toBe(false)
    expect(text.text).not.toHaveBeenCalled()
    expect(huge.text).not.toHaveBeenCalled()
    expect(state.nativeLegacy).not.toHaveBeenCalled()
    expect(state.errors[0].message).toContain('2 MiB')
    state.guard.dispose()
  })

  it('preserves supported rich MIME values, repeated item semantics, images and native mode', async () => {
    const state = setup(), image = new Blob(['image'], { type: 'image/png' })
    expect(await state.service.paste([
      item({ 'text/plain': blob('first'), 'text/html': blob('<p><b>rich</b></p>'),
        'application/x-doc-fragment+json': blob('{"body":{"dataStream":"rich\\r\\n"}}'), 'image/png': image }),
      item({ 'text/plain': blob('last'), 'application/ignored': { size: 10_000_000, text: vi.fn(async () => 'ignored') } }),
    ], 'source')).toBe(true)
    expect(state.accepted[0]).toMatchObject({ text: 'last', html: '<p><b>rich</b></p>',
      internalJson: '{"body":{"dataStream":"rich\\r\\n"}}', mode: 'source' })
    expect(state.accepted[0].files[0]).toMatchObject({ name: 'pasted_image.png', type: 'image/png', size: 5 })
    const files = [new File(['x'], 'local.png', { type: 'image/png' })]
    const direct = { text: 'direct', html: '<span style="font-weight:bold">direct</span>', files, unitId: 'native-editor' }
    expect(await state.service.legacyPaste(direct)).toBe(true)
    expect(state.accepted[1]).toEqual(direct)
    expect(state.accepted[1].files).toBe(files)
    state.guard.dispose()
  })

  it('blocks DOM/public payload bytes and table/paragraph expansion before native conversion', async () => {
    const state = setup()
    for (const span of ['Infinity', '1000000000', '-1', '1.5']) {
      expect(await state.service.legacyPaste({ files: [], html: `<table><tr><td rowspan="${span}">x</td></tr></table>` })).toBe(false)
    }
    for (const tag of ['h1', 'h6', 'li', 'pre']) {
      expect(await state.service.legacyPaste({ files: [], html: `<${tag}>x</${tag}>`.repeat(1_001) })).toBe(false)
    }
    expect(await state.service.legacyPaste({ files: [], text: 'x'.repeat(MAX_SPREADSHEET_CLIPBOARD_BYTES), internalJson: 'x' })).toBe(false)
    expect(() => assertNativeClipboardPayload({ text: 'x', files: [new File(['x'.repeat(MAX_SPREADSHEET_CLIPBOARD_BYTES)], 'large.png')] })).toThrow('2 MiB')
    expect(state.nativeLegacy).not.toHaveBeenCalled()
    expect(state.errors).toHaveLength(9)
    state.guard.dispose()
  })

  it('rejects actual parsed internal and HTML-embedded Doc tables before native insertion', async () => {
    // Never send these spans to the renderer: the native conversion mock
    // supplies its parsed document directly to the public pre-insertion hook.
    const documentData = { body: { dataStream: 'table\r\n', tables: [{ tableId: 'table', startIndex: 0, endIndex: 5 }] },
      tableSource: { table: { tableRows: [{ tableCells: [{ rowSpan: 1_000_000_000, columnSpan: 1 }] }] } } }
    const fragment = JSON.stringify({ version: 1, kind: 'univer-doc-fragment', doc: documentData })
    for (const payload of [{ internalJson: fragment }, { html: `<!--univer-doc-fragment:${btoa(fragment)}-->` }]) {
      const state = setup(undefined, undefined, documentData)
      expect(await state.service.legacyPaste({ ...payload, files: [] })).toBe(false)
      expect(state.accepted).toHaveLength(0)
      expect(state.errors[0].message).toContain('Embedded tables are unsupported')
      state.guard.dispose()
    }
    const bodyOnly = setup(undefined, undefined, { body: documentData.body })
    expect(await bodyOnly.service.legacyPaste({ internalJson: fragment, files: [] })).toBe(false)
    expect(bodyOnly.accepted).toHaveLength(0)
    bodyOnly.guard.dispose()
    const plain = setup(undefined, undefined, { body: { dataStream: 'rich\r\n', textRuns: [{ st: 0, ed: 4, ts: { bl: 1 } }] }, tableSource: {} })
    expect(await plain.service.legacyPaste({ text: 'rich', files: [] })).toBe(true)
    plain.guard.dispose()
  })

  it('cancels delayed OS reads after a new native draft or native invalidation', async () => {
    const os = deferred<ClipboardItem[]>(), state = setup(() => os.promise)
    const pending = state.service.pasteFromClipboard()
    state.target('draft-B')
    os.resolve([item({ 'text/plain': blob('late') })])
    expect(await pending).toBe(false)
    expect(state.nativeLegacy).not.toHaveBeenCalled()
    state.guard.dispose()
    const secondRead = deferred<ClipboardItem[]>(), second = setup(() => secondRead.promise)
    const invalidated = second.service.pasteFromClipboard()
    second.service.dismissPasteOptions()
    secondRead.resolve([item({ 'text/plain': blob('late') })])
    expect(await invalidated).toBe(false)
    expect(second.nativeLegacy).not.toHaveBeenCalled()
    second.guard.dispose()
  })

  it('retains draft identity through blob decoding and native asynchronous rich-text conversion', async () => {
    const decoded = deferred<string>(), state = setup()
    const pending = state.service.paste([item({ 'text/plain': { size: 4, text: () => decoded.promise } })])
    state.target('draft-B')
    decoded.resolve('late')
    expect(await pending).toBe(false)
    expect(state.nativeLegacy).not.toHaveBeenCalled()
    state.guard.dispose()
    const conversion = deferred<void>(), second = setup(undefined, () => conversion.promise)
    const converting = second.service.legacyPaste({ html: '<p>rich</p>', files: [] })
    await vi.waitFor(() => expect(second.nativeLegacy).toHaveBeenCalledOnce())
    second.target('draft-B')
    conversion.resolve()
    expect(await converting).toBe(false)
    expect(second.accepted).toHaveLength(0)
    expect(second.errors[0].message).toContain('cell editor changed')
    second.guard.dispose()
  })

  it('bounds native memory copies, preserves fallback and restores only this instance on disposal', async () => {
    const state = setup()
    expect(() => state.hook()?.onCopyDocData?.({ body: { dataStream: 'x'.repeat(MAX_SPREADSHEET_CLIPBOARD_BYTES) } }, { sourceDocuments: [] })).toThrow('2 MiB')
    state.clipboard.supportClipboard = false
    expect(await state.service.pasteFromClipboard('text')).toBe(true)
    expect(state.nativePaste).toHaveBeenCalledWith(undefined, 'text')
    state.clipboard.supportClipboard = true
    expect(await state.service.pasteFromClipboard('source')).toBe(true)
    expect(state.nativePaste).toHaveBeenLastCalledWith(undefined, 'source')
    state.guard.dispose()
    expect(state.service.paste).toBe(state.nativePaste)
    expect(state.service.pasteFromClipboard).toBe(state.nativeFrom)
    expect(state.service.legacyPaste).toBe(state.nativeLegacy)
    expect(state.service.dismissPasteOptions).toBe(state.nativeDismiss)
    const read = deferred<ClipboardItem[]>(), second = setup(() => read.promise)
    const pending = second.service.pasteFromClipboard()
    second.guard.dispose()
    read.resolve([item({ 'text/plain': blob('late') })])
    expect(await pending).toBe(false)
    expect(second.nativeLegacy).not.toHaveBeenCalled()
  })
})

describe('clipboard preflight before pinned parser allocations', () => {
  it('counts UTF-8 bytes across text, HTML and formula metadata', () => {
    expect(() => check({ text: 'я'.repeat(MAX_SPREADSHEET_CLIPBOARD_BYTES / 2 + 1) })).toThrow('2 MiB')
    expect(() => check({ text: 'x'.repeat(MAX_SPREADSHEET_CLIPBOARD_BYTES), html: 'x' })).toThrow('2 MiB')
  })

  it('uses pinned unquoted tab/newline semantics and bounds repeated targets', () => {
    expect(() => check({ text: 'x\t'.repeat(1_001) })).toThrow('1,000')
    expect(() => check({ text: '"a\tb"\nc\td' })).not.toThrow()
    expect(() => check({ text: 'x', range: wholeBook })).toThrow('1,000')
    expect(() => check({ text: 'x', range: thousand })).not.toThrow()
  })

  it('rejects malformed and huge HTML cell spans before native expansion', () => {
    for (const span of ['100000000', 'Infinity', 'NaN', '-2', '1e9', '1.5']) {
      expect(() => check({ html: `<table><tr><td rowspan="${span}">x</td></tr></table>` })).toThrow()
    }
    expect(() => check({ html: '<table><tr><td colspan="0">x</td><td>y</td></tr></table>' })).not.toThrow()
    expect(() => check({ html: '<table><tr><td colspan="2" rowspan="2">x</td><td>y</td></tr><tr><td>z</td></tr></table>' })).not.toThrow()
  })

  it('checks raw col parsing inside comments, empty colgroups and last-winning duplicate attributes', () => {
    for (const inner of ['<!-- <col span="100000000"> -->', '<colgroup span="100000000"></colgroup>', '<col span="1" span="100000000">']) {
      expect(() => check({ html: `<table>${inner}<tr><td>x</td></tr></table>` })).toThrow('1,000')
    }
    expect(() => check({ html: '<table><col span="2"><tr><td>x</td><td>y</td></tr></table>' })).not.toThrow()
    expect(() => check({ html: `<table><colgroup>${'<col>'.repeat(1_000)}</colgroup><tr><td>x</td></tr></table>` })).not.toThrow()
  })

  it('bounds raw rows hidden in comments and terminal text rows', () => {
    expect(() => check({ html: `<table><!-- ${'<tr></tr>'.repeat(1_001)} --><tr><td>x</td></tr></table>` })).toThrow('1,000')
    expect(() => check({ html: `${'<br>'.repeat(1_000)}x` })).toThrow('1,000')
    expect(() => check({ html: `outside<table><tr><td rowspan="1000">x</td></tr></table>` })).toThrow('1,000')
  })

  it('bounds rich-text paragraph work inside a single table cell', () => {
    expect(() => check({ html: `<table><tr><td>${'<br>'.repeat(1_001)}x</td></tr></table>` })).toThrow('paragraph')
  })

  it('bounds raw HTML introduced by the pinned plaintext-to-table conversion', () => {
    expect(() => check({ text: '<col span="100000000">\tx' })).toThrow('1,000')
  })

  it('bounds internal span expansion and rejects a partial merged copy', () => {
    const internal = { sheetId: 'sheet', range: cell, cut: false, cells: { 0: { 0: { v: 'x', rowSpan: 100000000, colSpan: 1 } } } }
    expect(() => check({ internal })).toThrow('1,000')
    expect(() => check({ internal: { ...internal, cells: { 0: { 0: { v: 'x', rowSpan: 2, colSpan: 1 } } } } })).toThrow('complete merged')
    expect(() => check({ internal: { ...internal, cells: { 1: { 0: { v: 'x' } } } } })).toThrow('matrix')
    expect(() => check({ internal: { ...internal, cells: { 0: { 0: { v: 'x' } } } } })).not.toThrow()
    expect(() => check({ internal: { ...internal, range: { ...cell, endRow: 2 }, cells: {
      0: { 0: { v: 'x', rowSpan: 2 } }, 1: { 0: { v: 'x', rowSpan: 2 } },
    } } })).toThrow('overlap')
    expect(() => check({ internal: { ...internal, range: thousand, cells: Object.fromEntries(
      Array.from({ length: 1_000 }, (_, row) => [row, { 0: row === 0 ? { v: 'x', rowSpan: 1_000 } : {} }]),
    ) } })).not.toThrow()
  })

  it('bounds formula metadata dimensions even when actual formula entries are small', () => {
    expect(() => check({ text: 'x', formulaClipboardPayload: JSON.stringify({ rowCount: 100000000, columnCount: 1, formulas: [] }) })).toThrow('1,000')
    expect(() => check({ text: 'x', formulaClipboardPayload: JSON.stringify({ rowCount: 1, columnCount: 1, formulas: [] }) })).not.toThrow()
    expect(() => check({ text: 'x', formulaClipboardPayload: '{' })).toThrow('metadata')
  })
})
