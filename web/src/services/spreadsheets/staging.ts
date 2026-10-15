import { LocaleType, Univer, type ICellData, type IWorkbookData, type IRange } from '@univerjs/presets';
import { FUniver } from '@univerjs/core/facade';
import {
  CalculationMode, UniverDocsPlugin, UniverFormulaEnginePlugin,
  UniverRenderEnginePlugin, UniverSheetsFormulaPlugin, UniverSheetsNumfmtPlugin,
  UniverSheetsPlugin,
  SheetsSelectionsService, type ISelectionWithStyle,
  UniverUIPlugin, UniverDocsUIPlugin, UniverSheetsUIPlugin,
  UniverSheetsNumfmtUIPlugin, UniverSheetsFormulaUIPlugin,
  ISheetClipboardService, COPY_TYPE, type ICellDataWithSpanInfo,
  SetBoldCommand, SetItalicCommand, SetUnderlineCommand, SetStrikeThroughCommand,
  SetOverlineCommand, SetFontFamilyCommand, SetFontSizeCommand,
  copyRangeStyles,
} from '@univerjs/preset-sheets-core';
import { ObjectMatrix, ICommandService, LifecycleService, LifecycleStages } from '@univerjs/core';
import enUS from '@univerjs/preset-sheets-core/locales/en-US';
import { assertBoundedCellRanges, assertBoundedCellShape, assertCommandCellBounds, SPREADSHEET_CELL_LIMIT_MESSAGE } from './actions';

export type CellInput = { sheetId: string; row: number; col: number; value: string | number | ICellData };
export type StructureInput = {
  sheetId: string; kind: 'insertRows' | 'deleteRows' | 'renameSheet';
  row?: number; count?: number; name?: string;
};
type Book = NonNullable<ReturnType<FUniver['getActiveWorkbook']>>;

// Staging reads ONLY confirmed authored state. It has no UI, no user drafts,
// and no evaluator/result application controller. Reference rewriting remains
// enabled. A fresh runtime per action also prevents unrelated queued commands
// or pending calculations from entering a structural snapshot.
export class StagingSession {
  private readonly univer = new Univer({ locale: LocaleType.EN_US, locales: { [LocaleType.EN_US]: enUS } });
  readonly book: Book;
  readonly api: FUniver;
  private host?: HTMLDivElement;

  constructor(source: IWorkbookData, clipboardUI = false) {
    const resources = new Set([
      'SHEET_RANGE_THEME_MODEL_PLUGIN', 'SHEET_WORKSHEET_PROTECTION_PLUGIN',
      'SHEET_WORKSHEET_PROTECTION_POINT_PLUGIN', 'SHEET_DEFINED_NAME_PLUGIN',
      'SHEET_RANGE_PROTECTION_PLUGIN',
      'SHEET_AuthzIoMockService_PLUGIN',
    ]);
    for (const resource of source.resources ?? []) {
      if (!resources.has(resource.name)) {
        this.univer.dispose();
        throw new Error(`Unsupported workbook resource ${resource.name}`);
      }
    }
    try {
      this.univer.registerPlugin(UniverRenderEnginePlugin);
      this.univer.registerPlugin(UniverFormulaEnginePlugin, { notExecuteFormula: true });
      this.univer.registerPlugin(UniverDocsPlugin);
      if (clipboardUI) {
        this.host = document.createElement('div');
        this.host.style.cssText = 'position:fixed;left:-20000px;top:0;width:800px;height:600px;pointer-events:none;';
        this.host.setAttribute('aria-hidden', 'true');
        document.body.appendChild(this.host);
        this.univer.registerPlugin(UniverUIPlugin, { container: this.host, header: false,
          toolbar: false, disableAutoFocus: true });
        this.univer.registerPlugin(UniverDocsUIPlugin);
      }
      this.univer.registerPlugin(UniverSheetsPlugin, { notExecuteFormula: true });
      this.univer.registerPlugin(UniverSheetsFormulaPlugin, {
        initialFormulaComputing: CalculationMode.NO_CALCULATION,
      });
      this.univer.registerPlugin(UniverSheetsNumfmtPlugin);
      if (clipboardUI) {
        this.univer.registerPlugin(UniverSheetsUIPlugin, { formulaBar: false, footer: false });
        this.univer.registerPlugin(UniverSheetsNumfmtUIPlugin);
        this.univer.registerPlugin(UniverSheetsFormulaUIPlugin);
      }
      this.api = FUniver.newAPI(this.univer);
      this.book = this.api.createWorkbook(structuredClone(source));
      const commands = this.univer.__getInjector().get(ICommandService);
      for (const command of [SetBoldCommand, SetItalicCommand, SetUnderlineCommand, SetStrikeThroughCommand,
        SetOverlineCommand, SetFontFamilyCommand, SetFontSizeCommand]) {
        if (!commands.hasCommand(command.id)) commands.registerCommand(command);
      }
    } catch (error) {
      this.univer.dispose();
      this.host?.remove();
      throw error;
    }
  }

  save(): IWorkbookData {
    const data = structuredClone(this.book.save());
    const inline = (style: ICellData['s']): ICellData['s'] => {
      if (typeof style !== 'string') return style;
      if (!Object.prototype.hasOwnProperty.call(data.styles, style)) throw new Error(`Unknown style ${style}`);
      return structuredClone(data.styles[style]);
    };
    for (const id of data.sheetOrder) {
      const sheet = data.sheets[id];
      const facade = this.book.getSheetBySheetId(id)!;
      if (sheet.mergeData) sheet.mergeData = sheet.mergeData.map(range => ({
        startRow: range.startRow, endRow: range.endRow,
        startColumn: range.startColumn, endColumn: range.endColumn,
        ...(range.rangeType === undefined ? {} : { rangeType: range.rangeType }),
      }));
      if (sheet.defaultStyle) sheet.defaultStyle = inline(sheet.defaultStyle);
      for (const [r, columns] of Object.entries(sheet.cellData ?? {}) as [string, Record<string, ICellData | null>][]) {
        for (const [c, cell] of Object.entries(columns)) {
          if (!cell) continue;
          if (cell.s) cell.s = inline(cell.s);
          if (cell.f || cell.si) {
            const formula = facade.getRange(Number(r), Number(c)).getFormula();
            if (!formula) throw new Error(`Cannot expand formula at ${id}:${r}:${c}`);
            cell.f = formula;
            delete cell.si;
            delete cell.v;
            delete cell.t;
          }
        }
      }
      for (const dimension of [sheet.rowData, sheet.columnData]) {
        for (const entry of Object.values(dimension ?? {})) {
          if (entry?.s) entry.s = inline(entry.s);
        }
      }
    }
    // Keep the style table: registered plugin resources may reference entries.
    // Cell patches are nevertheless independent because their styles are inline.
    for (const resource of data.resources ?? []) {
      // Univer's first save uses an empty string for uninitialized defined names;
      // its next load/save emits an empty object. They are the same authored data.
      if (resource.name === 'SHEET_DEFINED_NAME_PLUGIN' && resource.data === '') resource.data = '{}';
    }
    return data;
  }

  dispose() { this.univer.dispose(); this.host?.remove(); }

  select(sheetId: string, ranges: IRange[]) {
    const sheet = this.book.getSheetBySheetId(sheetId);
    if (!sheet) throw new Error(`Unknown sheet ${sheetId}`);
    this.book.setActiveSheet(sheet);
    const selections = ranges.map(range => ({ range, style: null, primary: {
      actualRow: range.startRow, actualColumn: range.startColumn,
      startRow: range.startRow, endRow: range.startRow,
      startColumn: range.startColumn, endColumn: range.startColumn,
      isMerged: false, isMergedMainCell: false,
    } })) as ISelectionWithStyle[];
    this.univer.__getInjector().get(SheetsSelectionsService).setSelections(this.book.getId(), sheetId, selections);
  }

  async paste(input: ClipboardInput): Promise<void> {
    await this.univer.__getInjector().get(LifecycleService).onStage(LifecycleStages.Rendered);
    const clipboard = this.univer.__getInjector().get(ISheetClipboardService);
    if (!clipboard.getClipboardHooks().some(hook => hook.id === 'default-paste')) {
      throw new Error('Clipboard staging did not initialize its paste handlers.');
    }
    const sourceSheet = this.book.getSheetBySheetId(input.sheetId)!.getSheet();
    // The pinned parser stays authoritative. Verify its actual output before
    // any paste handler builds mutations or materializes dimension changes.
    const guard = clipboard.addClipboardHook({ id: 'msgnr-bounded-paste', priority: -1_000_000,
      onBeforePaste: location => {
        assertBoundedCellShape(location.range.rows.length, location.range.cols.length);
        if (location.range.rows.some(row => !Number.isSafeInteger(row) || row < 0 || row >= sourceSheet.getRowCount())
          || location.range.cols.some(col => !Number.isSafeInteger(col) || col < 0 || col >= sourceSheet.getColumnCount())) {
          throw new Error('Clipboard range extends outside this worksheet');
        }
        return true;
      },
      onPasteCells: (_from, _to, cells) => {
        const range = cells.getDataRange();
        assertBoundedCellShape(range.endRow - range.startRow + 1, range.endColumn - range.startColumn + 1);
        return { undos: [], redos: [] };
      },
    });
    const target = { unitId: this.book.getId(), subUnitId: input.sheetId,
      range: input.range };
    try {
      if (input.internal) {
        const copyId = crypto.randomUUID();
        const { sheetId, range, cells, cut } = input.internal;
        const rows = Array.from({ length: range.endRow - range.startRow + 1 }, (_, i) => range.startRow + i);
        const cols = Array.from({ length: range.endColumn - range.startColumn + 1 }, (_, i) => range.startColumn + i);
        clipboard.copyContentCache().set(copyId, { unitId: this.book.getId(), subUnitId: sheetId,
          range: { rows, cols }, matrix: new ObjectMatrix<ICellDataWithSpanInfo>(structuredClone(cells)),
          copyType: cut ? COPY_TYPE.CUT : COPY_TYPE.COPY });
        if (!await clipboard.pasteByCopyId(copyId, undefined, target)) throw new Error('Не удалось вставить диапазон.');
      } else if (!await clipboard.legacyPaste(input.html, input.text, [], input.formulaClipboardPayload, target)) {
        throw new Error('Не удалось вставить содержимое буфера обмена.');
      }
    } finally { guard.dispose(); }
  }
}

export interface ClipboardInput {
  sheetId: string; range: IRange; text?: string; html?: string; formulaClipboardPayload?: string;
  internal?: { sheetId: string; range: IRange; cells: Record<number, Record<number, ICellDataWithSpanInfo>>; cut: boolean };
}

export const MAX_SPREADSHEET_CLIPBOARD_BYTES = 2 * 1024 * 1024;

export function assertClipboardPayloadBytes(input: Pick<ClipboardInput, 'text' | 'html' | 'formulaClipboardPayload'>) {
  let bytes = 0;
  for (const value of [input.text, input.html, input.formulaClipboardPayload]) {
    if (value === undefined) continue;
    if (typeof value !== 'string') throw new Error('Invalid clipboard content');
    if (value.length > MAX_SPREADSHEET_CLIPBOARD_BYTES) throw new Error('Clipboard content exceeds 2 MiB. Copy a smaller range.');
    bytes += new TextEncoder().encode(value).byteLength;
    if (bytes > MAX_SPREADSHEET_CLIPBOARD_BYTES) throw new Error('Clipboard content exceeds 2 MiB. Copy a smaller range.');
  }
}

function clipboardSpan(element: Element, attribute: string): number {
  const raw = element.getAttribute(attribute)?.trim();
  if (!raw) return 1;
  // Pinned conversion treats zero as its default span of one. Reject invalid
  // HTML dimensions before its Number()-based allocation loops can run.
  if (!/^\d+$/.test(raw)) throw new Error('Invalid clipboard table span');
  const value = Number(raw) || 1;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid clipboard table span');
  assertBoundedCellShape(1, value);
  return value;
}

export function assertClipboardHtmlShape(html: string) {
  // Pinned parseColGroup scans raw strings, including comments and empty
  // colgroup tags. Guard that same raw token shape before DOM parsing; a DOM
  // query alone misses spans the native parser would nevertheless expand.
  let rawColumns = 0, rawTables = 0, rawRows = 0;
  for (const table of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    if (++rawTables > 1_000) throw new Error(SPREADSHEET_CELL_LIMIT_MESSAGE);
    // Keep the case-sensitive, single-line group-body selection of 1.0.3.
    // Empty/multiline groups fall back to scanning the entire raw table.
    const group = table[0].match(/<colgroup([\s\S]*?)>(.*?)<\/colgroup>/);
    for (const match of (group?.[2] || table[0]).matchAll(/<col([\s\S]*?)>/g)) {
      let span: string | undefined;
      for (const property of match[1].matchAll(/([\w-]+)\s*=\s*(?:(['"])([^'"]*)\2|(\S+))/g)) {
        if (property[1] === 'span') span = property[3] ?? property[4];
      }
      if (span !== undefined && !/^\d+$/.test(span.trim())) throw new Error('Invalid clipboard table span');
      const count = span === undefined ? 1 : Number(span) || 1;
      assertBoundedCellShape(1, count);
      rawColumns += count;
      if (rawColumns > 1_000) throw new Error(SPREADSHEET_CELL_LIMIT_MESSAGE);
    }
    for (const _row of table[0].matchAll(/<tr([\s\S]*?)>([\s\S]*?)<\/tr>/gi)) {
      if (++rawRows > 1_000) throw new Error(SPREADSHEET_CELL_LIMIT_MESSAGE);
    }
  }
  // This DOM stays detached. It bounds expansion before Univer's converter
  // creates its rich-text/style matrices; it does not replace that converter.
  const document = new DOMParser().parseFromString(html, 'text/html');
  let rows = 0, columns = 1, cells = 0;
  for (const col of document.querySelectorAll('col')) {
    cells += clipboardSpan(col, 'span');
    if (cells > 1_000) throw new Error(SPREADSHEET_CELL_LIMIT_MESSAGE);
  }
  cells = 0;
  for (const table of document.querySelectorAll('table')) {
    const occupied = new Set<string>();
    let tableRows = 0, tableColumns = 1, rowIndex = 0;
    for (const row of table.querySelectorAll('tr')) {
      let column = 0;
      for (const cell of row.querySelectorAll('td, th')) {
        while (occupied.has(`${rowIndex}:${column}`)) column++;
        const rowSpan = clipboardSpan(cell, 'rowspan'), colSpan = clipboardSpan(cell, 'colspan');
        cells += rowSpan * colSpan;
        if (cells > 1_000) throw new Error(SPREADSHEET_CELL_LIMIT_MESSAGE);
        tableRows = Math.max(tableRows, rowIndex + rowSpan);
        tableColumns = Math.max(tableColumns, column + colSpan);
        assertBoundedCellShape(tableRows, tableColumns);
        for (let r = rowIndex; r < rowIndex + rowSpan; r++) {
          for (let c = column; c < column + colSpan; c++) occupied.add(`${r}:${c}`);
        }
        column += colSpan;
      }
      rowIndex++;
      if (rowIndex > 1_000) throw new Error(SPREADSHEET_CELL_LIMIT_MESSAGE);
    }
    rows += Math.max(tableRows, rowIndex);
    columns = Math.max(columns, tableColumns);
    if (rows) assertBoundedCellShape(rows, columns);
  }
  // Blocks outside tables become additional rich-text rows in pinned parsing.
  // Conservatively bound them here; the native parsed matrix is checked again.
  let blocks = 0, paragraphTags = 0;
  for (const block of document.querySelectorAll('p, div, br, h1, h2, h3, h4, h5, h6, li, pre')) {
    // Line breaks inside one cell also create rich-text paragraphs. Pinned
    // paragraph-ID generation scans previous paragraphs, so bound that work
    // separately even when the spreadsheet target itself is one cell.
    if (++paragraphTags > 1_000) throw new Error('Clipboard content contains too many paragraph breaks. Copy a smaller range.');
    if (block.closest('table')) continue;
    if (++blocks > 1_000) throw new Error(SPREADSHEET_CELL_LIMIT_MESSAGE);
  }
  // A final text segment can form a row after the last paragraph separator.
  // Include it even when a source table has no block elements around it.
  let textRow = 0;
  const textNodes = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (textNodes.nextNode()) {
    if (textNodes.currentNode.textContent?.trim() && !textNodes.currentNode.parentElement?.closest('table, style, script, iframe, object, embed')) {
      textRow = 1;
      break;
    }
  }
  if (blocks || textRow) assertBoundedCellShape(Math.max(1, rows + blocks + textRow), columns);
}

export function assertClipboardInputBounds(source: IWorkbookData, input: ClipboardInput) {
  assertClipboardPayloadBytes(input);
  const sheet = source.sheets[input.sheetId];
  if (!sheet || typeof sheet.rowCount !== 'number' || typeof sheet.columnCount !== 'number') throw new Error('Invalid clipboard worksheet');
  assertBoundedCellRanges([input.range], sheet.rowCount, sheet.columnCount);
  if (input.internal) {
    const copiedSheet = source.sheets[input.internal.sheetId];
    if (!copiedSheet || typeof copiedSheet.rowCount !== 'number' || typeof copiedSheet.columnCount !== 'number') throw new Error('Invalid copied worksheet');
    assertBoundedCellRanges([input.internal.range], copiedSheet.rowCount, copiedSheet.columnCount);
    const height = input.internal.range.endRow - input.internal.range.startRow + 1;
    const width = input.internal.range.endColumn - input.internal.range.startColumn + 1;
    const mergedCells = new Set<string>();
    let count = 0;
    for (const [row, columns] of Object.entries(input.internal.cells)) {
      if (!/^(0|[1-9]\d*)$/.test(row) || !Number.isSafeInteger(Number(row)) || Number(row) >= height
        || !columns || typeof columns !== 'object' || Array.isArray(columns)) throw new Error('Invalid copied cell matrix');
      for (const [column, cell] of Object.entries(columns)) {
        if (!/^(0|[1-9]\d*)$/.test(column) || !Number.isSafeInteger(Number(column)) || Number(column) >= width
          || !cell || typeof cell !== 'object' || Array.isArray(cell)) throw new Error('Invalid copied cell matrix');
        if (++count > 1_000) throw new Error(SPREADSHEET_CELL_LIMIT_MESSAGE);
        const rows = cell.rowSpan ?? 1, cols = cell.colSpan ?? 1;
        assertBoundedCellShape(rows, cols);
        if (Number(row) + rows > height || Number(column) + cols > width) throw new Error('Copy the complete merged cell range.');
        if (rows > 1 || cols > 1) {
          for (let r = Number(row); r < Number(row) + rows; r++) {
            for (let c = Number(column); c < Number(column) + cols; c++) {
              const key = `${r}:${c}`;
              if (mergedCells.has(key)) throw new Error('Copied merge ranges overlap.');
              mergedCells.add(key);
            }
          }
        }
      }
    }
    return;
  }
  if (input.html) assertClipboardHtmlShape(input.html);
  else if (input.text && /[\n\t]/.test(input.text)) {
    // Univer 1.0.3 keeps this helper private and does not implement quoted TSV:
    // legacyPaste uses trim().split('\n'), then each row's split('\t'). Bound
    // that exact delimiter behavior before constructing its raw HTML table.
    const text = input.text.trim();
    let cells = 1, rows = 1, columns = 1, currentColumns = 1;
    for (const char of text) {
      if (char === '\n') { rows++; columns = Math.max(columns, currentColumns); currentColumns = 1; cells++; }
      else if (char === '\t') { currentColumns++; cells++; }
      if (cells > 1_000) throw new Error(SPREADSHEET_CELL_LIMIT_MESSAGE);
    }
    columns = Math.max(columns, currentColumns);
    assertBoundedCellShape(rows, columns);
    const html = `<table>${text.split('\n').map(row => `<tr>${row.split('\t').map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</table>`;
    assertClipboardHtmlShape(html);
  }
  if (input.formulaClipboardPayload) {
    let payload: { rowCount?: number; columnCount?: number; formulas?: unknown[] };
    try { payload = JSON.parse(input.formulaClipboardPayload); } catch { throw new Error('Invalid clipboard formula metadata'); }
    if (!payload || !Array.isArray(payload.formulas)) throw new Error('Invalid clipboard formula metadata');
    assertBoundedCellShape(payload.rowCount!, payload.columnCount!);
    if (payload.formulas.length > 1_000) throw new Error(SPREADSHEET_CELL_LIMIT_MESSAGE);
  }
}

export async function stageClipboard(source: IWorkbookData, input: ClipboardInput): Promise<IWorkbookData> {
  assertClipboardInputBounds(source, input);
  const session = new StagingSession(source, true);
  try {
    session.select(input.sheetId, [input.range]);
    await session.paste(input);
    return session.save();
  } finally { session.dispose(); }
}

export interface AuthoredCommand { id: string; params: Record<string, unknown>; sheetId: string; ranges: IRange[] }

// Execute the same pinned OSS command against confirmed source, never against
// the visible workbook whose raw cells may already contain calculation output.
export async function stageCommand(source: IWorkbookData, command: AuthoredCommand): Promise<IWorkbookData> {
  assertCommandCellBounds(source, command.id, command.params, command.sheetId, command.ranges);
  const session = new StagingSession(source);
  try {
    session.select(command.sheetId, command.ranges);
    const params = structuredClone(command.params);
    if (command.id === 'sheet.command.insert-row-by-range' || command.id === 'sheet.command.insert-col-by-range') {
      // Facade insertion precomputes styles through visible interceptors.
      // Recompute them in this noncalculating runtime before mutation.
      const range = params.range as IRange;
      const sheet = session.book.getSheetBySheetId(String(params.subUnitId ?? command.sheetId));
      if (!sheet || !range) throw new Error('Invalid worksheet insertion range');
      const rows = command.id === 'sheet.command.insert-row-by-range';
      params.cellValue = copyRangeStyles(sheet.getSheet(), range.startRow, range.endRow,
        range.startColumn, range.endColumn, rows, (rows ? range.startRow : range.startColumn) - 1);
    }
    const ok = await session.api.executeCommand(command.id, params);
    if (!ok) throw new Error('Univer rejected the prepared spreadsheet command');
    return session.save();
  } finally { session.dispose(); }
}

export async function stageColumnWidths(source: IWorkbookData, sheetId: string, widths: Record<number, number | null | undefined | void>): Promise<IWorkbookData> {
  const session = new StagingSession(source);
  try {
    const sheet = source.sheets[sheetId];
    if (!sheet) throw new Error('Unknown sheet for column sizing');
    const { rowCount, columnCount } = sheet;
    if (typeof rowCount !== 'number' || typeof columnCount !== 'number') throw new Error('Invalid sheet dimensions');
    for (const [column, width] of Object.entries(widths)) {
      const col = Number(column);
      if (!Number.isSafeInteger(col) || col < 0 || col >= columnCount || typeof width !== 'number' || !Number.isFinite(width) || width <= 0) {
        throw new Error('Invalid prepared column size');
      }
      const ok = await session.api.executeCommand('sheet.command.set-worksheet-col-width', {
        unitId: session.book.getId(), subUnitId: sheetId, value: width,
        ranges: [{ startRow: 0, endRow: rowCount - 1, startColumn: col, endColumn: col }],
      });
      if (!ok) throw new Error('Univer rejected the prepared column size');
    }
    return session.save();
  } finally { session.dispose(); }
}

export function normalizeAuthoredWorkbook(source: IWorkbookData): IWorkbookData {
  const session = new StagingSession(source);
  try { return session.save(); }
  finally { session.dispose(); }
}

export function stageCells(source: IWorkbookData, inputs: CellInput[]): IWorkbookData {
  if (inputs.length > 1_000) throw new Error(SPREADSHEET_CELL_LIMIT_MESSAGE);
  for (const input of inputs) {
    const sheet = source.sheets[input.sheetId];
    if (!sheet || !Number.isSafeInteger(input.row) || !Number.isSafeInteger(input.col)
      || input.row < 0 || input.col < 0 || input.row >= (sheet.rowCount ?? 0) || input.col >= (sheet.columnCount ?? 0)) {
      throw new Error('Invalid cell target');
    }
  }
  const session = new StagingSession(source);
  try {
    for (const input of inputs) {
      const sheet = session.book.getSheetBySheetId(input.sheetId);
      if (!sheet) throw new Error(`Unknown sheet ${input.sheetId}`);
      sheet.getRange(input.row, input.col).setValue(input.value);
    }
    return session.save();
  } finally { session.dispose(); }
}

export function stageStructure(source: IWorkbookData, change: StructureInput): IWorkbookData {
  const session = new StagingSession(source);
  try {
    const sheet = session.book.getSheetBySheetId(change.sheetId);
    if (!sheet) throw new Error(`Unknown sheet ${change.sheetId}`);
    if (change.kind === 'insertRows') sheet.insertRowsBefore(change.row!, change.count!);
    else if (change.kind === 'deleteRows') sheet.deleteRows(change.row!, change.count!);
    else if (change.kind === 'renameSheet') sheet.setName(change.name!);
    else throw new Error('Unsupported structure action');
    return session.save();
  } finally { session.dispose(); }
}
