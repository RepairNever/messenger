import { createUniver, defaultTheme, CommandType, LocaleType, RANGE_TYPE, type ICellData, type IDocumentData, type IDisposable, type IRange, type IStyleData } from '@univerjs/presets'
import { CopyCommand, CutCommand, PasteCommand, SheetPasteShortKeyCommand, UniverSheetsCorePreset,
  ISheetClipboardService, SheetsSelectionsService, BorderStyleManagerService, AutoWidthController,
  IRenderManagerService, SheetScrollManagerService, SheetSkeletonManagerService, SHEET_VIEWPORT_KEY,
  ComponentManager, IDocClipboardService, IClipboardInterfaceService,
  DocSelectionManagerService } from '@univerjs/preset-sheets-core'
import { IUniverInstanceService, UniverInstanceType } from '@univerjs/core'
import enUS from '@univerjs/preset-sheets-core/locales/en-US'
import '@univerjs/preset-sheets-core/lib/index.css'
import './editor-classic.css'
import { AUTHORED_COMMAND_IDS, assertBoundedCellRanges, assertClipboardCopyBounds, assertCommandCellBounds, authoredEditorCell, prepareWorkbookAction } from './actions'
import { assertClipboardHtmlShape, assertClipboardPayloadBytes, MAX_SPREADSHEET_CLIPBOARD_BYTES, stageClipboard, stageColumnWidths, stageCommand, type AuthoredCommand, type ClipboardInput } from './staging'
import type { SpreadsheetAction, SpreadsheetOperationResult, SpreadsheetState } from './types'

type IDocClipboardPayload = Parameters<IDocClipboardService['legacyPaste']>[0]

export interface SpreadsheetEditorDraft {
  id: string
  base: SpreadsheetState
  sheetId: string
  row: number
  col: number
  text: string
  document?: IDocumentData
  displayedStyle: IStyleData
  explicitStyleKeys: string[]
}

interface EditorOptions {
  container: HTMLElement
  submit: (action: SpreadsheetAction, draft: unknown) => Promise<SpreadsheetOperationResult>
  onDraft: (draft: SpreadsheetEditorDraft | null) => void
  onError: (error: Error) => void
  onUndo?: () => void
  onRedo?: () => void
  onHeaderMount?: (element: HTMLElement | null) => void
}

/** Guard native callbacks that enumerate selected cells before any command. */
export function installNumberFormatGuards(manager: Pick<ComponentManager, 'get' | 'register' | 'reactUtils'>,
  canFormat: (allSelections: boolean) => boolean): IDisposable[] {
  const optionsKey = 'sheets-numfmt-ui.moreNumfmtType.options', panelKey = 'SHEET_NUMFMT_PANEL'
  const NativeOptions = manager.get(optionsKey), NativePanel = manager.get(panelKey)
  if (!NativeOptions || !NativePanel) throw new Error('Number-format controls did not initialize.')
  const createElement = manager.reactUtils.createElement
  const options = manager.register(optionsKey, (props: Record<string, unknown>) => createElement('div', {
    onClickCapture: (event: { preventDefault(): void; stopPropagation(): void }) => {
      if (!canFormat(false)) { event.preventDefault(); event.stopPropagation() }
    },
  }, createElement(NativeOptions, props)))
  const panel = manager.register(panelKey, (props: { onChange?: (change: { type: string; value?: unknown }) => void }) => createElement(NativePanel, {
    ...props,
    onChange: (change: { type: string; value?: unknown }) => {
      if (change.type !== 'confirm' || canFormat(true)) props.onChange?.(change)
    },
  }))
  return [options, panel]
}

/** Validate native rich text before Docs constructs its document or table. */
export function assertNativeClipboardPayload(payload: IDocClipboardPayload) {
  assertClipboardPayloadBytes({ text: payload.text, html: payload.html, formulaClipboardPayload: payload.internalJson })
  let bytes = (payload.text ? new TextEncoder().encode(payload.text).length : 0)
    + (payload.html ? new TextEncoder().encode(payload.html).length : 0)
    + (payload.internalJson ? new TextEncoder().encode(payload.internalJson).length : 0)
  for (const file of payload.files) {
    bytes += file.size
    if (bytes > MAX_SPREADSHEET_CLIPBOARD_BYTES) throw new Error('Clipboard content exceeds 2 MiB. Copy a smaller range.')
  }
  if (payload.html) assertClipboardHtmlShape(payload.html)
}

const DOC_CLIPBOARD_TEXT_TYPES = new Set(['text/plain', 'text/html', 'application/x-doc-fragment+json'])
const DOC_CLIPBOARD_IMAGE_TYPES = new Set(['image/bmp', 'image/jpeg', 'image/webp', 'image/png'])

/** One runtime's public clipboard boundary; native conversion/history stay intact. */
export function installNativeClipboardGuards(service: IDocClipboardService,
  clipboard: Pick<IClipboardInterfaceService, 'read' | 'supportClipboard'>,
  captureTarget: () => string | null, onError: (error: Error) => void): IDisposable {
  const originalPaste = service.paste, originalFromClipboard = service.pasteFromClipboard
  const originalLegacy = service.legacyPaste, originalDismiss = service.dismissPasteOptions
  let disposed = false, busy = false, readGeneration = 0
  let applyingTarget: string | null = null
  const fail = (error: unknown) => { if (!disposed) onError(error instanceof Error ? error : new Error(String(error))); return false }
  const current = (target: string | null, generation: number) => !disposed && target !== null
    && target === captureTarget() && generation === readGeneration
  const readItems = async (items: ClipboardItem[]): Promise<IDocClipboardPayload> => {
    const blobs: { type: string; blob: Blob }[] = []
    let bytes = 0
    // Validate all supported MIME payloads before calling text() on any blob.
    for (const item of items) for (const type of item.types) {
      if (!DOC_CLIPBOARD_TEXT_TYPES.has(type) && !DOC_CLIPBOARD_IMAGE_TYPES.has(type)) continue
      const blob = await item.getType(type)
      bytes += blob.size
      if (bytes > MAX_SPREADSHEET_CLIPBOARD_BYTES) throw new Error('Clipboard content exceeds 2 MiB. Copy a smaller range.')
      blobs.push({ type, blob })
    }
    const payload: IDocClipboardPayload = { html: '', internalJson: '', files: [] }
    for (const { type, blob } of blobs) {
      if (type === 'text/plain') payload.text = await blob.text()
      else if (type === 'text/html') payload.html = await blob.text()
      else if (type === 'application/x-doc-fragment+json') payload.internalJson = await blob.text()
      else payload.files.push(new File([blob], `pasted_image.${type.split('/')[1]}`, { type }))
    }
    return payload
  }
  const run = async (load: () => Promise<IDocClipboardPayload | null>, mode?: IDocClipboardPayload['mode'],
    fallback = false): Promise<boolean> => {
    if (busy || disposed) return false
    const target = captureTarget(), generation = readGeneration
    if (target === null) return false
    busy = true
    try {
      const payload = await load()
      if (!current(target, generation)) return false
      if (payload) assertNativeClipboardPayload(payload)
      applyingTarget = target
      // A fresh native runtime's memory cache is bounded by the copy hook below.
      // Calling the original paste preserves that public fallback and modes.
      return payload ? await originalLegacy.call(service, { ...payload, ...(mode === undefined ? {} : { mode }) })
        : fallback ? await originalPaste.call(service, undefined, mode) : false
    } catch (error) { return fail(error) }
    finally { applyingTarget = null; busy = false }
  }
  const paste: IDocClipboardService['paste'] = (items, mode = 'source') => run(
    () => items?.length ? readItems(items) : Promise.resolve(null), mode, true)
  const fromClipboard: IDocClipboardService['pasteFromClipboard'] = (mode = 'source') => run(async () => {
    if (!clipboard.supportClipboard) return null
    const items = await clipboard.read()
    return items.length ? readItems(items) : null
  }, mode, true)
  const legacy: IDocClipboardService['legacyPaste'] = payload => run(async () => {
    assertNativeClipboardPayload(payload)
    return payload
  })
  const dismiss = () => { readGeneration++; originalDismiss.call(service) }
  const hook = service.addClipboardHook({
    onCopyDocData: data => {
      try { assertClipboardPayloadBytes({ formulaClipboardPayload: JSON.stringify(data) }) }
      catch (error) { fail(error); throw error }
      return data
    },
    onBeforePaste: (body, context) => {
      // Internal MIME and HTML-embedded fragments can bypass HTML conversion.
      // Docs tables cannot be authored in cell rich text under the Go schema;
      // reject their actual parsed document before native insertion/rendering.
      const tables = context.documentData.tableSource
      if (tables != null && (typeof tables !== 'object' || Array.isArray(tables) || Object.keys(tables).length)
        || context.documentData.body?.tables?.length) {
        throw new Error('Embedded tables are unsupported in cell rich text. Paste plain text instead.')
      }
      // Native generation checks cover selection/focus mutations during its
      // asynchronous conversion; this also distinguishes two native drafts.
      if (applyingTarget !== null && (disposed || applyingTarget !== captureTarget())) {
        throw new Error('The cell editor changed while reading the clipboard. Paste again in the current editor.')
      }
      return body
    },
  })
  service.paste = paste; service.pasteFromClipboard = fromClipboard
  service.legacyPaste = legacy; service.dismissPasteOptions = dismiss
  return { dispose: () => {
    if (disposed) return
    disposed = true
    hook.dispose()
    if (service.paste === paste) service.paste = originalPaste
    if (service.pasteFromClipboard === fromClipboard) service.pasteFromClipboard = originalFromClipboard
    if (service.legacyPaste === legacy) service.legacyPaste = originalLegacy
    if (service.dismissPasteOptions === dismiss) service.dismissPasteOptions = originalDismiss
  } }
}

// UI wrappers may open dialogs or alter an editor draft. The actual workbook
// persistence commands they invoke are intercepted separately below.
const UI_WRAPPERS = new Set([
  'sheet.command.set-range-bold', 'sheet.command.set-range-italic',
  'sheet.command.set-range-underline', 'sheet.command.set-range-stroke',
  'sheet.command.set-range-font-family', 'sheet.command.set-range-fontsize',
  'sheet.command.set-range-text-color', 'sheet.command.set-range-font-increase',
  'sheet.command.set-range-font-decrease', 'sheet.command.set-range-subscript',
  'sheet.command.set-range-superscript', 'sheet.command.reset-range-text-color',
  'sheet.command.remove-row-confirm', 'sheet.command.remove-col-confirm',
  'sheet.command.remove-sheet-confirm', 'sheet.command.hide-row-confirm',
  'sheet.command.hide-col-confirm', 'sheet.command.insert-range-move-down-confirm',
  'sheet.command.insert-range-move-right-confirm', 'sheet.command.delete-range-move-left-confirm',
  'sheet.command.delete-range-move-up-confirm',
  'sheet.command.set-row-frozen', 'sheet.command.set-col-frozen',
  'sheet.command.move-range-confirm',
  'sheet.command.set-first-row-frozen', 'sheet.command.set-first-column-frozen',
  // These change only the visible picker before invoking set-border. The
  // nested persistence command captures their settings explicitly below.
  'sheet.command.set-border-position', 'sheet.command.set-border-style',
  'sheet.command.set-border-color',
  // These calculate an explicit format from the displayed precision/region.
  // Their nested set.numfmt command persists only that selected format.
  'sheet.command.numfmt.set.currency', 'sheet.command.numfmt.set.percent',
  'sheet.command.numfmt.add.decimal.command', 'sheet.command.numfmt.subtract.decimal.command',
])
const LOCAL_COMMANDS = new Set([
  'sheet.command.set-worksheet-activate', 'sheet.command.select-range',
  'sheet.command.move-selection', 'sheet.command.move-selection-enter-tab',
  'sheet.command.expand-selection', 'sheet.command.select-all', 'sheet.command.scroll',
  'sheet.command.scroll-view', 'sheet.command.scroll-view-reset',
  'sheet.command.scroll-to-cell', 'sheet.command.set-scroll-relative',
  'sheet.command.reset-scroll', 'sheet.command.set-zoom-ratio',
  'sheet.command.set-zoom-ratio-from-toolbar', 'sheet.command.change-zoom-ratio',
])

/** Owns one visible runtime; confirmed source and editor drafts stay separate. */
export class SpreadsheetEditorBridge {
  readonly runtime
  private readonly options: EditorOptions
  private state: SpreadsheetState | null = null
  private displayed: SpreadsheetState | null = null
  private draft: SpreadsheetEditorDraft | null = null
  private endedDraft: SpreadsheetEditorDraft | null = null
  private editable = false
  private preparing = false
  private applying = false
  private disposed = false
  private copyingCut = false
  private numberFormatGuardsInstalled = false
  private copied: { id: string; base: SpreadsheetState; input: NonNullable<ClipboardInput['internal']> } | null = null
  private listeners: IDisposable[] = []

  constructor(options: EditorOptions) {
    this.options = options
    // Native focus also opens the in-cell editor on the first typed character.
    // disableAutoFocus would silently route input into a hidden editor instead.
    this.runtime = createUniver({ theme: defaultTheme, darkMode: false,
      locale: LocaleType.EN_US, locales: { [LocaleType.EN_US]: enUS },
      presets: [UniverSheetsCorePreset({ container: options.container,
        menu: {
          'sheet.command.set-once-format-painter': { hidden: true },
          'sheet.command.set-infinite-format-painter': { hidden: true },
          'ui.operation.activate-format-painter': { hidden: true },
          'ui.operation.continuous-format-painter': { hidden: true },
          'sidebar.operation.defined-name': { hidden: true },
          'sheet-permission.operation.openPanel': { hidden: true },
          'sheet.command.set-range-protection-from-context-menu': { hidden: true },
          'sheet.command.add-range-protection-from-toolbar': { hidden: true },
          'sheet.command.add-range-protection-from-context-menu': { hidden: true },
          'sheet.command.view-sheet-permission-from-context-menu': { hidden: true },
          'sheet.command.delete-range-protection-from-context-menu': { hidden: true },
          'sheet.command.add-range-protection-from-sheet-bar': { hidden: true },
          'sheet.command.view-sheet-permission-from-sheet-bar': { hidden: true },
          'sheet.command.delete-worksheet-protection-from-sheet-bar': { hidden: true },
          'sheet.command.change-sheet-protection-from-sheet-bar': { hidden: true },
          'sheet.command.paste-value': { hidden: true },
          'sheet.command.paste-format': { hidden: true },
          'sheet.command.paste-col-width': { hidden: true },
          'sheet.command.paste-besides-border': { hidden: true },
          'sheet.command.optional-paste': { hidden: true },
        },
      })],
    })
    const api = this.api
    this.listeners = [
      api.addEvent(api.Event.BeforeSheetEditStart, event => { if (!this.canEdit()) event.cancel = true }),
      api.addEvent(api.Event.SheetEditStarted, event => {
        if (!this.state) return
        this.draft = { id: crypto.randomUUID(), base: structuredClone(this.state), sheetId: event.worksheet.getSheetId(),
          row: event.row, col: event.column, text: '',
          displayedStyle: structuredClone(event.worksheet.getRange(event.row, event.column).getCellStyleData('cell') ?? {}), explicitStyleKeys: [] }
        this.options.onDraft(structuredClone(this.draft))
      }),
      api.addEvent(api.Event.SheetEditChanging, event => {
        if (!this.draft) return
        this.draft.text = event.value.toPlainText()
        this.draft.document = structuredClone(event.value.getData())
        this.options.onDraft(structuredClone(this.draft))
      }),
      api.addEvent(api.Event.BeforeSheetEditEnd, event => {
        if (!this.draft) return
        this.draft.text = event.value.toPlainText()
        this.draft.document = structuredClone(event.value.getData())
        this.endedDraft = event.isConfirm ? structuredClone(this.draft) : null
        if (event.isConfirm) this.options.onDraft(structuredClone(this.draft))
        if (!event.isConfirm) this.options.onDraft(null)
      }),
      api.addEvent(api.Event.SheetEditEnded, () => {
        const completedDraftId = this.draft?.id ?? this.endedDraft?.id
        this.draft = null
        // A structural remote state is applied only after the native editor
        // has yielded its complete draft. The submission still uses its base.
        requestAnimationFrame(() => {
          if (this.disposed) return
          // Univer emits no value command when Enter confirms unchanged input.
          // The pinned editor can await local worksheet activation before
          // issuing its value command. Let that microtask chain settle too.
          if (completedDraftId && this.endedDraft?.id === completedDraftId && !this.preparing) {
            this.endedDraft = null
            if (!this.draft) this.options.onDraft(null)
          }
          if (!this.preparing && this.state) this.applyState(this.state)
        })
      }),
      api.addEvent(api.Event.BeforeCommandExecute, event => this.beforeCommand(event)),
      api.addEvent(api.Event.CommandExecuted, event => {
        if (event.id !== CopyCommand.id && event.id !== CutCommand.id || !this.copied) return
        const id = this.runtime.univer.__getInjector().get(ISheetClipboardService).copyContentCache().getLastCopyId()
        if (id) this.copied.id = id
      }),
      api.addEvent(api.Event.BeforeUndo, event => {
        // Core selects a document editor's local stack during cell editing;
        // native keyboard undo commonly supplies no command parameters.
        if (this.draft) return
        const unitId = event.params?.unitId ?? event.params?.unitID
        if (unitId && unitId !== this.book?.getId()) return
        event.cancel = true; this.options.onUndo?.()
      }),
      api.addEvent(api.Event.BeforeRedo, event => {
        if (this.draft) return
        const unitId = event.params?.unitId ?? event.params?.unitID
        if (unitId && unitId !== this.book?.getId()) return
        event.cancel = true; this.options.onRedo?.()
      }),
    ]
    if (options.onHeaderMount) {
      const { createElement } = api.getComponentManager().reactUtils
      const mount = (element: HTMLElement | null) => {
        if (!this.disposed) options.onHeaderMount?.(element)
      }
      // Register before the first workbook mounts. Univer owns its native tabs;
      // Vue teleports only our status/actions into the supported header slot.
      this.listeners.push(api.registerUIPart(api.Enum.BuiltInUIPart.HEADER_MENU,
        () => createElement('div', { ref: mount, className: 'spreadsheet-toolbar-mount',
          'data-testid': 'spreadsheet-toolbar-mount' })))
    }
  }

  get api() { return this.runtime.univerAPI }
  get book() { return this.api.getActiveWorkbook() }
  private canEdit() { return this.editable && !this.preparing && !this.disposed && !!this.state }
  setEditable(value: boolean) {
    // Journal updates publish the same permission while typing. Reapplying it
    // would invalidate Univer's pending clipboard read in the current draft.
    // Workbook creation and preparation set their effective permission below.
    if (this.editable === value) return
    this.editable = value
    this.book?.setEditable(value && !this.preparing)
  }

  applyState(next: SpreadsheetState) {
    if (this.disposed || this.state && next.revision < this.state.revision) return
    if (this.state?.revision === next.revision && this.displayed?.revision === next.revision) return
    this.state = structuredClone(next)
    if (this.draft || this.preparing) return
    if (this.displayed && this.displayed.revision === next.revision) return
    const book = this.book
    const sheetId = book?.getActiveSheet()?.getSheetId()
    const range = book?.getActiveRange()?.getRange()
    this.applying = true
    try {
      if (book) this.api.disposeUnit(book.getId())
      const created = this.api.createWorkbook(structuredClone(next.workbook))
      // Sheet plugin components start with the first workbook. Replace their
      // callbacks before the UI can render them, once for this runtime.
      if (!this.numberFormatGuardsInstalled) {
        const injector = this.runtime.univer.__getInjector()
        this.listeners.push(...installNumberFormatGuards(injector.get(ComponentManager), all => this.canFormatSelection(all)))
        this.listeners.push(installNativeClipboardGuards(injector.get(IDocClipboardService),
          injector.get(IClipboardInterfaceService), () => this.nativeClipboardTarget(), error => this.fail(error)))
        // Native editor DOM may use the layout service's body fallback. Scope
        // the capture listener to its exact current Docs unit, not container.
        const document = this.options.container.ownerDocument
        const beforePaste = (event: ClipboardEvent) => {
          if (!this.draft || this.disposed || !event.clipboardData || !(event.target instanceof Element)) return
          const currentDoc = injector.get(IUniverInstanceService).getCurrentUnitOfType(UniverInstanceType.UNIVER_DOC)
          const host = event.target.closest('[id^="univer-doc-selection-container-"]')
          if (!currentDoc || host?.id !== `univer-doc-selection-container-${currentDoc.getUnitId()}`) return
          try {
            assertNativeClipboardPayload({ text: event.clipboardData.getData('text/plain'),
              html: event.clipboardData.getData('text/html'), internalJson: event.clipboardData.getData('application/x-doc-fragment+json'),
              files: Array.from(event.clipboardData.files) })
          } catch (error) { event.preventDefault(); event.stopImmediatePropagation(); this.fail(error) }
        }
        document.addEventListener('paste', beforePaste, true)
        this.listeners.push({ dispose: () => document.removeEventListener('paste', beforePaste, true) })
        this.numberFormatGuardsInstalled = true
      }
      const sheet = sheetId && created.getSheetBySheetId(sheetId)
      if (sheet) { created.setActiveSheet(sheet); if (range) sheet.getRange(range).activate() }
      created.setEditable(this.canEdit())
      this.displayed = structuredClone(next)
    } finally { this.applying = false }
  }

  private selection(): { sheetId: string; ranges: IRange[] } {
    const sheetId = this.book?.getActiveSheet()?.getSheetId()
    if (!sheetId) throw new Error('Лист не выбран.')
    const selections = this.runtime.univer.__getInjector().get(SheetsSelectionsService).getCurrentSelections()
    return { sheetId, ranges: selections.map(selection => structuredClone(selection.range)) }
  }

  private nativeClipboardTarget() {
    if (this.disposed) return null
    const injector = this.runtime.univer.__getInjector()
    const doc = injector.get(IUniverInstanceService).getCurrentUnitOfType(UniverInstanceType.UNIVER_DOC)
    if (!doc) return null
    const ranges = injector.get(DocSelectionManagerService).getDocRanges()
      .map(range => [range.startOffset, range.endOffset, range.segmentId ?? '', range.rangeType ?? 0])
    return JSON.stringify([this.draft?.id ?? null, doc.getUnitId(), ranges])
  }

  private canFormatSelection(allSelections: boolean) {
    try {
      if (!this.canEdit() || this.draft) throw new Error('Дождитесь сохранения или завершите редактирование ячейки.')
      const selected = this.selection(), sheet = this.state!.workbook.sheets[selected.sheetId]
      const ranges = allSelections ? selected.ranges : selected.ranges.slice(-1)
      assertBoundedCellRanges(ranges, sheet.rowCount!, sheet.columnCount!)
      return true
    } catch (error) { this.fail(error); return false }
  }

  private captureWorksheetCopy(sheetId: string, range: IRange) {
    const cells: NonNullable<ClipboardInput['internal']>['cells'] = {}, sheet = this.state!.workbook.sheets[sheetId]
    for (let row = range.startRow; row <= range.endRow; row++) {
      const columns: Record<number, ICellData> = {}
      for (let col = range.startColumn; col <= range.endColumn; col++) {
        const cell = structuredClone(sheet.cellData?.[row]?.[col] ?? {})
        const merge = sheet.mergeData?.find(m => m.startRow === row && m.startColumn === col)
        columns[col - range.startColumn] = merge ? { ...cell, rowSpan: merge.endRow - row + 1, colSpan: merge.endColumn - col + 1 } as ICellData : cell
      }
      cells[row - range.startRow] = columns
    }
    this.copied = { id: '', base: structuredClone(this.state!), input: { sheetId, range: structuredClone(range), cells, cut: this.copyingCut } }
  }

  private beforeCommand(event: { id: string; type: CommandType; params: any; options?: any; cancel?: boolean }) {
    if (this.applying || this.disposed) return
    if (event.id === CopyCommand.id || event.id === CutCommand.id) {
      this.copyingCut = event.id === CutCommand.id
      if (this.preparing) { event.cancel = true; return }
      // Capture authored cells here instead of subscribing to Facade's copy
      // event: that subscription would generate a workbook clipboard even
      // during document-local text copying inside the native cell editor.
      if (this.draft) { this.copied = null; return }
      if (this.state) {
        try {
          const selected = this.selection()
          const range = selected.ranges[selected.ranges.length - 1]
          assertClipboardCopyBounds(this.state.workbook, selected.sheetId, [range])
          // Facade chooses the primary selection, while native copying uses
          // the last selection. Bound both before other Facade subscribers.
          const active = this.book?.getActiveRange()?.getRange()
          if (active) assertClipboardCopyBounds(this.state.workbook, selected.sheetId, [active])
          this.captureWorksheetCopy(selected.sheetId, range)
        } catch (error) { event.cancel = true; this.copied = null; this.fail(error) }
      }
      return
    }
    if (event.id.startsWith('doc.')) {
      if (this.draft && event.type === CommandType.COMMAND) {
        const keys: Record<string, string> = { bold: 'bl', italic: 'it', underline: 'ul', strikethrough: 'st',
          'font-family': 'ff', fontsize: 'fs', 'text-color': 'cl', subscript: 'va', superscript: 'va' }
        for (const [name, key] of Object.entries(keys)) if (event.id.includes(`inline-format-${name}`)) {
          if (!this.draft.explicitStyleKeys.includes(key)) this.draft.explicitStyleKeys.push(key)
        }
      }
      return
    }
    if (event.type === CommandType.OPERATION || LOCAL_COMMANDS.has(event.id)) return
    if (event.id === SheetPasteShortKeyCommand.id || event.id === PasteCommand.id) {
      // Handle the Docs route explicitly: a false result in the global multi
      // command would otherwise fall through to a worksheet paste handler.
      // Its guarded service keeps text in the captured draft until confirmation.
      if (event.id === PasteCommand.id && this.draft) {
        event.cancel = true
        void this.runtime.univer.__getInjector().get(IDocClipboardService).pasteFromClipboard('source')
          .catch(error => this.fail(error))
        return
      }
      event.cancel = true
      if (!this.canEdit()) { this.fail(new Error('Дождитесь сохранения или разрешите текущую ошибку.')); return }
      try { assertClipboardPayloadBytes({ text: event.params?.textContent, html: event.params?.htmlContent,
        formulaClipboardPayload: event.params?.formulaClipboardPayload }) }
      catch (error) { this.fail(error); return }
      const base = structuredClone(this.state!)
      const selected = this.selection()
      const params = structuredClone(event.params ?? {})
      const captured = event.id === PasteCommand.id ? this.readClipboard() : Promise.resolve({
        text: params.textContent as string | undefined, html: params.htmlContent as string | undefined,
        formulaClipboardPayload: params.formulaClipboardPayload as string | undefined,
      })
      void this.prepare(base, { kind: 'clipboard', ...params }, async () => {
        const content = await captured
        const input: ClipboardInput = { ...content, sheetId: selected.sheetId,
          range: params.target?.range ?? selected.ranges[0] }
        const copyId = input.html?.match(/data-copy-id="([^\s]+)"/)?.[1]
        if (copyId && this.copied?.id === copyId) {
          input.internal = structuredClone(this.copied.input)
          if (input.internal.cut && this.copied.base.revision !== base.revision) {
            throw new Error('Книга изменилась после вырезания. Вырежьте диапазон заново.')
          }
        }
        if (!input.range) throw new Error('Выберите ячейку для вставки.')
        return stageClipboard(base.workbook, input)
      })
      return
    }
    if (event.id === 'sheet.command.set-selection-frozen') {
      event.cancel = true
      if (!this.canEdit()) { this.fail(new Error('Дождитесь сохранения или разрешите текущую ошибку.')); return }
      try {
        const base = structuredClone(this.state!)
        const selected = this.selection()
        const injector = this.runtime.univer.__getInjector()
        const selections = injector.get(SheetsSelectionsService).getCurrentSelections()
        const last = selections[selections.length - 1]
        if (!last) throw new Error('Выберите ячейку для закрепления областей.')
        const scroll = injector.get(IRenderManagerService).getRenderUnitById(this.book!.getId())
          ?.with(SheetScrollManagerService).getCurrentScrollState()
        const scrollRow = scroll?.sheetViewStartRow ?? 0
        const scrollColumn = scroll?.sheetViewStartColumn ?? 0
        const type = event.params?.type
        let startRow = -1, startColumn = -1, xSplit = 0, ySplit = 0
        if (type === 3) { startRow = scrollRow + 1; ySplit = 1 }
        else if (type === 4) { startColumn = scrollColumn + 1; xSplit = 1 }
        else {
          const row = (last.primary?.startRow ?? last.range.startRow) || 1
          const column = (last.primary?.startColumn ?? last.range.startColumn) || 1
          const rangeType = last.range.rangeType
          if (rangeType === RANGE_TYPE.ROW || type === 1) {
            startRow = row; ySplit = Math.max(1, row - scrollRow)
          } else if (rangeType === RANGE_TYPE.COLUMN || type === 2) {
            startColumn = column; xSplit = Math.max(1, column - scrollColumn)
          } else if (rangeType === RANGE_TYPE.NORMAL) {
            startRow = row; startColumn = column
            ySplit = Math.max(1, row - scrollRow); xSplit = Math.max(1, column - scrollColumn)
          } else throw new Error('Выберите ячейку, строку или столбец для закрепления.')
        }
        const command: AuthoredCommand = { id: 'sheet.command.set-frozen', ...selected,
          params: { unitId: this.book!.getId(), subUnitId: selected.sheetId, startRow, startColumn, xSplit, ySplit } }
        void this.prepare(base, command, () => stageCommand(base.workbook, command))
      } catch (error) { this.fail(error) }
      return
    }
    if (UI_WRAPPERS.has(event.id)) {
      if (!this.canEdit() && !this.draft) event.cancel = true
      else if (this.state) {
        try {
          const selected = this.selection()
          assertCommandCellBounds(this.state.workbook, event.id, event.params ?? {}, selected.sheetId, selected.ranges)
        } catch (error) { event.cancel = true; this.fail(error) }
      }
      return
    }
    if (event.id === 'sheet.command.set-col-auto-width') {
      event.cancel = true
      if (!this.canEdit()) { this.fail(new Error('Wait for the current change to finish saving.')); return }
      try {
        const base = structuredClone(this.state!)
        const selected = this.selection()
        const injector = this.runtime.univer.__getInjector()
        const current = injector.get(IRenderManagerService).getRenderUnitById(this.book!.getId())
          ?.with(SheetSkeletonManagerService).getCurrentParam()
        if (current?.sheetId !== selected.sheetId || !current.skeleton.visibleRangeByViewportKey(SHEET_VIEWPORT_KEY.VIEW_MAIN)) {
          throw new Error('The worksheet is still rendering. Try auto-fit again when it is visible.')
        }
        // Auto-fit is an explicit user action based on the currently displayed
        // text. Capture its dimensions only; calculated cell data stays local.
        const prepared = injector.get(AutoWidthController).getUndoRedoParamsOfColWidth({
          unitId: this.book!.getId(), subUnitId: selected.sheetId,
          ranges: structuredClone(event.params?.ranges ?? selected.ranges),
        })
        const widths = structuredClone(prepared.redos[0]?.params.colWidth)
        if (!widths || typeof widths !== 'object') throw new Error('Unable to measure the selected columns.')
        void this.prepare(base, { kind: 'auto_width', sheetId: selected.sheetId, widths },
          () => stageColumnWidths(base.workbook, selected.sheetId, widths))
      } catch (error) { this.fail(error) }
      return
    }
    if (event.type === CommandType.MUTATION && event.id.startsWith('sheet.')) {
      // Formula result application and layout measurement are local display data.
      if (event.options?.onlyLocal || event.options?.fromFormula || event.options?.applyFormulaCalculationResult
        || event.id === 'sheet.mutation.set-worksheet-row-auto-height') return
      event.cancel = true
      this.fail(new Error('Это изменение пока не поддерживается совместным редактором.'))
      return
    }
    if (event.type !== CommandType.COMMAND || !event.id.startsWith('sheet.')) return
    event.cancel = true
    if (!AUTHORED_COMMAND_IDS.has(event.id)) {
      this.fail(new Error('Это действие пока недоступно в совместной таблице.')); return
    }
    const nativeDraft = event.id === 'sheet.command.set-range-values' ? this.endedDraft : null
    if (!this.canEdit()) { this.fail(new Error('Дождитесь сохранения или разрешите текущую ошибку.')); return }
    const base = structuredClone(nativeDraft?.base ?? this.state!)
    const selected = this.selection()
    try { assertCommandCellBounds(base.workbook, event.id, event.params ?? {}, selected.sheetId, selected.ranges) }
    catch (error) { this.fail(error); return }
    let params = structuredClone(event.params ?? {})
    let commandId = event.id
    if (commandId === 'sheet.command.set-border') {
      const border = structuredClone(this.runtime.univer.__getInjector().get(BorderStyleManagerService).getBorderInfo())
      if (!border.activeBorderType) return
      commandId = 'sheet.command.set-border-basic'
      params = { unitId: params.unitId ?? this.book!.getId(), subUnitId: params.subUnitId ?? selected.sheetId,
        ranges: params.ranges ?? selected.ranges, value: { type: border.type, color: border.color, style: border.style } }
    }
    if (nativeDraft) {
      const source = base.workbook.sheets[nativeDraft.sheetId]?.cellData?.[nativeDraft.row]?.[nativeDraft.col] ?? null
      if (params.value && !Array.isArray(params.value)) params.value = authoredEditorCell(params.value, source, nativeDraft.displayedStyle, nativeDraft.explicitStyleKeys)
      this.endedDraft = null
    }
    const command: AuthoredCommand = { id: commandId, params, ...selected }
    void this.prepare(base, nativeDraft ?? command, () => stageCommand(base.workbook, command))
  }

  private async readClipboard() {
    if (!navigator.clipboard?.read) throw new Error('Вставьте содержимое сочетанием клавиш Ctrl+V или ⌘V.')
    const item = (await navigator.clipboard.read())[0]
    if (!item) throw new Error('Буфер обмена пуст.')
    let bytes = 0
    const read = async (type: string) => {
      if (!item.types.includes(type)) return undefined
      const blob = await item.getType(type)
      bytes += blob.size
      if (bytes > MAX_SPREADSHEET_CLIPBOARD_BYTES) throw new Error('Clipboard content exceeds 2 MiB. Copy a smaller range.')
      return blob.text()
    }
    return { text: await read('text/plain'), html: await read('text/html'),
      formulaClipboardPayload: await read('web application/x-univer-sheets-formula') }
  }

  private async prepare(base: SpreadsheetState, draft: unknown, stage: () => Promise<SpreadsheetState['workbook']>) {
    this.preparing = true
    this.book?.setEditable(false)
    try {
      const next = await stage()
      if (this.disposed) return
      const action = prepareWorkbookAction(base, next, crypto.randomUUID())
      if (action) await this.options.submit(action, draft)
      else this.options.onDraft(null)
    } catch (error) { if (!this.disposed) this.fail(error) }
    finally {
      this.preparing = false
      if (!this.disposed && this.state) this.applyState(this.state)
      if (!this.disposed) this.book?.setEditable(this.editable)
    }
  }

  private fail(error: unknown) { this.options.onError(error instanceof Error ? error : new Error(String(error))) }
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.listeners.forEach(listener => listener.dispose())
    this.runtime.univer.dispose()
    this.state = this.displayed = null
    this.draft = this.endedDraft = null
    this.copied = null
  }
}
