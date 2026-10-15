import type { ICellData, IWorkbookData } from '@univerjs/core'
import type { DocumentHistoryEditor } from '@/services/http/documentsApi'

export const MAX_SPREADSHEET_CELL_PATCHES = 1000

export interface SpreadsheetState {
  revision: number
  structure_epoch: number
  last_event_seq: number
  workbook: IWorkbookData
}

export interface SpreadsheetCellPatch {
  sheet_id: string
  row: number
  col: number
  cell: ICellData | null
}

export interface SpreadsheetActionBase {
  id: string
  base_revision: number
  structure_epoch: number
}

export type SpreadsheetAction = SpreadsheetActionBase & (
  | { kind: 'cells'; cells: SpreadsheetCellPatch[] }
  | { kind: 'structure'; workbook: IWorkbookData }
)

export type SpreadsheetHistoryRestoreAction = SpreadsheetActionBase

export interface SpreadsheetOperationReceipt {
  id: string
  outcome: 'accepted' | 'conflict'
  revision: number
  structure_epoch: number
  event_seq: number
  code?: string
  message?: string
}

export interface SpreadsheetOperationResult {
  operation: SpreadsheetOperationReceipt
  state: SpreadsheetState
}

export interface SpreadsheetHistoryEntry {
  id: string
  kind: 'spreadsheet'
  title: string
  spreadsheet_revision?: number
  spreadsheet_structure_epoch?: number
  edited_by: string
  created_at: string
  editor: DocumentHistoryEditor
}

export interface SpreadsheetHistorySnapshot {
  id: string
  title: string
  revision: number
  structure_epoch: number
  workbook: IWorkbookData
  edited_by: string
  created_at: string
  editor: DocumentHistoryEditor
}

export interface SpreadsheetChangedEvent {
  document_id: string
  operation_id: string
  revision: number
  structure_epoch: number
  event_seq: number
  kind: 'cells' | 'structure'
  cells: SpreadsheetCellPatch[]
}

export type SpreadsheetProblemKind =
  | 'network' | 'access' | 'validation' | 'server' | 'protocol'
  | 'aborted' | 'conflict' | 'busy' | 'disposed' | 'storage'

export class SpreadsheetProblem extends Error {
  constructor(
    public readonly kind: SpreadsheetProblemKind,
    message: string,
    public readonly status = 0,
    /** The write might have committed. Retry its unchanged ID and body. */
    public readonly uncertain = false,
  ) {
    super(message)
    this.name = 'SpreadsheetProblem'
  }
}

export interface SpreadsheetTransport {
  getState(documentId: string, signal?: AbortSignal): Promise<SpreadsheetState>
  postAction(documentId: string, action: SpreadsheetAction, signal?: AbortSignal): Promise<SpreadsheetOperationResult>
  getHistorySnapshot(documentId: string, historyId: string, signal?: AbortSignal): Promise<SpreadsheetHistorySnapshot>
  restoreHistory(documentId: string, historyId: string, action: SpreadsheetHistoryRestoreAction, signal?: AbortSignal): Promise<SpreadsheetOperationResult>
}
