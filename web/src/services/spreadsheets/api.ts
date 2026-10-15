import { isAxiosError, isCancel } from 'axios'
import type { ICellData, IWorkbookData } from '@univerjs/core'
import type { ServerEvent } from '@/shared/proto/packets_pb'
import { createAuthenticatedClient } from '@/services/http/client'
import {
  SpreadsheetProblem,
  type SpreadsheetChangedEvent,
  type SpreadsheetHistorySnapshot,
  type SpreadsheetOperationResult,
  type SpreadsheetState,
  type SpreadsheetTransport,
} from './types'

const http = createAuthenticatedClient()

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SpreadsheetProblem('protocol', `Invalid ${label}`)
  }
  return value as Record<string, unknown>
}

export function spreadsheetSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SpreadsheetProblem('protocol', `Invalid ${label}`)
  }
  return value
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new SpreadsheetProblem('protocol', `Invalid ${label}`)
  return value
}

function workbook(value: unknown): IWorkbookData {
  const book = record(value, 'workbook')
  string(book.id, 'workbook ID')
  const sheets = record(book.sheets, 'workbook sheets')
  if (!Array.isArray(book.sheetOrder) || !book.sheetOrder.length) {
    throw new SpreadsheetProblem('protocol', 'Invalid worksheet order')
  }
  const seen = new Set<string>()
  for (const id of book.sheetOrder) {
    string(id, 'worksheet ID')
    if (seen.has(id as string) || !Object.prototype.hasOwnProperty.call(sheets, id as string)) {
      throw new SpreadsheetProblem('protocol', 'Invalid worksheet order')
    }
    seen.add(id as string)
    const sheet = record(sheets[id as string], 'worksheet')
    if (sheet.id !== id) throw new SpreadsheetProblem('protocol', 'Invalid worksheet ID')
    spreadsheetSafeInteger(sheet.rowCount, 'row count')
    spreadsheetSafeInteger(sheet.columnCount, 'column count')
  }
  return structuredClone(book) as unknown as IWorkbookData
}

export function parseSpreadsheetState(value: unknown): SpreadsheetState {
  const state = record(value, 'spreadsheet state')
  return {
    revision: spreadsheetSafeInteger(state.revision, 'revision'),
    structure_epoch: spreadsheetSafeInteger(state.structure_epoch, 'structure epoch'),
    last_event_seq: spreadsheetSafeInteger(state.last_event_seq, 'event sequence'),
    workbook: workbook(state.workbook),
  }
}

export function parseSpreadsheetOperationResult(value: unknown): SpreadsheetOperationResult {
  const result = record(value, 'operation result')
  const operation = record(result.operation, 'operation receipt')
  if (operation.outcome !== 'accepted' && operation.outcome !== 'conflict') {
    throw new SpreadsheetProblem('protocol', 'Invalid operation outcome')
  }
  const state = parseSpreadsheetState(result.state)
  const receipt = {
    id: string(operation.id, 'operation ID'),
    outcome: operation.outcome,
    revision: spreadsheetSafeInteger(operation.revision, 'operation revision'),
    structure_epoch: spreadsheetSafeInteger(operation.structure_epoch, 'operation structure epoch'),
    event_seq: spreadsheetSafeInteger(operation.event_seq, 'operation event sequence'),
    ...(typeof operation.code === 'string' ? { code: operation.code } : {}),
    ...(typeof operation.message === 'string' ? { message: operation.message } : {}),
  } as const
  if (receipt.revision > state.revision || receipt.structure_epoch > state.structure_epoch || receipt.event_seq > state.last_event_seq) {
    throw new SpreadsheetProblem('protocol', 'Operation receipt is newer than its current state')
  }
  return { operation: receipt, state }
}

function transportProblem(error: unknown, write: boolean): SpreadsheetProblem {
  if (error instanceof SpreadsheetProblem) {
    return new SpreadsheetProblem(error.kind, error.message, error.status, write && error.kind === 'protocol')
  }
  if (isCancel(error)) return new SpreadsheetProblem('aborted', 'Request cancelled', 0, write)
  if (!isAxiosError(error) || !error.response) return new SpreadsheetProblem('network', 'Connection lost. The operation may need to be retried.', 0, write)
  const status = error.response.status
  const data = error.response.data
  const message = data && typeof data === 'object' && typeof data.error === 'string' ? data.error : 'Spreadsheet request failed'
  if (status === 401 || status === 403 || status === 404) return new SpreadsheetProblem('access', message, status)
  if (status >= 500 || status === 408) return new SpreadsheetProblem('server', message, status, write)
  return new SpreadsheetProblem('validation', message, status)
}

async function read<T>(request: Promise<{ data: unknown }>, parse: (value: unknown) => T): Promise<T> {
  try { return parse((await request).data) } catch (error) { throw transportProblem(error, false) }
}

async function write(request: Promise<{ data: unknown }>): Promise<SpreadsheetOperationResult> {
  try {
    return parseSpreadsheetOperationResult((await request).data)
  } catch (error) {
    if (isAxiosError(error) && error.response?.status === 409 && error.response.data?.operation) {
      try { return parseSpreadsheetOperationResult(error.response.data) } catch (parseError) { throw transportProblem(parseError, true) }
    }
    throw transportProblem(error, true)
  }
}

function parseHistorySnapshot(value: unknown): SpreadsheetHistorySnapshot {
  const snapshot = record(value, 'history snapshot')
  return {
    id: string(snapshot.id, 'history ID'),
    title: typeof snapshot.title === 'string' ? snapshot.title : '',
    revision: spreadsheetSafeInteger(snapshot.revision, 'history revision'),
    structure_epoch: spreadsheetSafeInteger(snapshot.structure_epoch, 'history structure epoch'),
    workbook: workbook(snapshot.workbook),
    edited_by: string(snapshot.edited_by, 'history actor'),
    created_at: string(snapshot.created_at, 'history timestamp'),
    editor: structuredClone(record(snapshot.editor, 'history editor')) as unknown as SpreadsheetHistorySnapshot['editor'],
  }
}

function path(documentId: string): string {
  return `/api/documents/${encodeURIComponent(documentId)}/spreadsheet`
}

export const spreadsheetApi: SpreadsheetTransport = {
  getState(documentId, signal) {
    return read(http.get(path(documentId), { signal }), parseSpreadsheetState)
  },
  postAction(documentId, action, signal) {
    return write(http.post(`${path(documentId)}/actions`, action, { signal }))
  },
  getHistorySnapshot(documentId, historyId, signal) {
    return read(http.get(`${path(documentId)}/history/${encodeURIComponent(historyId)}`, { signal }), parseHistorySnapshot)
  },
  restoreHistory(documentId, historyId, action, signal) {
    return write(http.post(`${path(documentId)}/history/${encodeURIComponent(historyId)}/restore`, action, { signal }))
  },
}

/** Adapt only ordered, already applied chat events. Protobuf int64s are bigint. */
export function spreadsheetEventFromServerEvent(event: ServerEvent): SpreadsheetChangedEvent | null {
  if (event.payload.case !== 'spreadsheetChanged') return null
  const value = event.payload.value
  if (value.kind !== 'cells' && value.kind !== 'structure') throw new SpreadsheetProblem('protocol', 'Invalid spreadsheet event kind')
  return {
    document_id: string(value.documentId, 'event document ID'),
    operation_id: string(value.operationId, 'event operation ID'),
    revision: spreadsheetSafeInteger(Number(value.revision), 'event revision'),
    structure_epoch: spreadsheetSafeInteger(Number(value.structureEpoch), 'event structure epoch'),
    event_seq: spreadsheetSafeInteger(Number(event.eventSeq), 'event sequence'),
    kind: value.kind,
    cells: value.cells.map(patch => {
      let cell: ICellData | null = null
      if (!patch.clear) {
        try { cell = record(JSON.parse(patch.cellJson), 'event cell') as ICellData } catch {
          throw new SpreadsheetProblem('protocol', 'Invalid spreadsheet event cell JSON')
        }
      }
      return {
        sheet_id: string(patch.sheetId, 'event worksheet ID'),
        row: spreadsheetSafeInteger(patch.row, 'event row'),
        col: spreadsheetSafeInteger(patch.col, 'event column'),
        cell,
      }
    }),
  }
}
