import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AxiosError } from 'axios'
import { create } from '@bufbuild/protobuf'
import type { IWorkbookData } from '@univerjs/core'
import { ServerEventSchema, SpreadsheetChangedEventSchema } from '@/shared/proto/packets_pb'

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
vi.mock('@/services/http/client', () => ({ createAuthenticatedClient: () => http }))

import { parseSpreadsheetState, spreadsheetApi, spreadsheetEventFromServerEvent } from '../api'
import { SpreadsheetProblem, type SpreadsheetState } from '../types'

function state(revision = 1): SpreadsheetState {
  return { revision, structure_epoch: 0, last_event_seq: revision, workbook: {
    id: 'book', sheetOrder: ['sheet'], sheets: { sheet: { id: 'sheet', rowCount: 10, columnCount: 10, cellData: {} } },
  } as unknown as IWorkbookData }
}

function failure(status: number, data: unknown) {
  return new AxiosError('failed', undefined, undefined, undefined, { status, data, statusText: 'failed', headers: {}, config: {} as never })
}

const action = { id: 'operation', base_revision: 1, structure_epoch: 0, kind: 'cells' as const, cells: [{ sheet_id: 'sheet', row: 0, col: 0, cell: { v: 1 } }] }

describe('spreadsheet transport', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('uses authenticated routes, preserves the supplied signal and clones received state', async () => {
    const source = state()
    http.get.mockResolvedValue({ data: source })
    const signal = new AbortController().signal
    const result = await spreadsheetApi.getState('doc/one', signal)
    expect(http.get).toHaveBeenCalledWith('/api/documents/doc%2Fone/spreadsheet', { signal })
    result.workbook.sheets.sheet!.rowCount = 30
    expect(source.workbook.sheets.sheet!.rowCount).toBe(10)
  })

  it('parses a stable conflict receipt and separately returns newer current state', async () => {
    http.post.mockRejectedValue(failure(409, {
      operation: { id: 'operation', outcome: 'conflict', revision: 2, structure_epoch: 0, event_seq: 2, code: 'CELL_CONFLICT' },
      state: state(4),
    }))
    const result = await spreadsheetApi.postAction('doc', action)
    expect(result.operation.revision).toBe(2)
    expect(result.state.revision).toBe(4)
  })

  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2'])('rejects unsafe revisions: %s', revision => {
    expect(() => parseSpreadsheetState({ ...state(), revision })).toThrow(SpreadsheetProblem)
  })

  it('marks a malformed successful write response as uncertain', async () => {
    http.post.mockResolvedValue({ data: { operation: { id: 'operation', outcome: 'accepted', revision: 3, structure_epoch: 0, event_seq: 3 }, state: state(2) } })
    await expect(spreadsheetApi.postAction('doc', action)).rejects.toMatchObject({ kind: 'protocol', uncertain: true })
  })

  it('keeps reused-ID rejections definitive rather than treating them as conflict receipts', async () => {
    http.post.mockRejectedValue(failure(409, { error: 'Operation ID reused', code: 'OPERATION_ID_REUSED' }))
    await expect(spreadsheetApi.postAction('doc', action)).rejects.toMatchObject({ kind: 'validation', status: 409, uncertain: false })
  })

  it.each([401, 403, 404])('classifies denied or archived workbooks as access failures (%s)', async status => {
    http.get.mockRejectedValue(failure(status, { error: 'Access denied' }))
    await expect(spreadsheetApi.getState('doc')).rejects.toMatchObject({ kind: 'access', status })
  })

  it('retains unknown acknowledgement semantics for network and server failures', async () => {
    http.post.mockRejectedValueOnce(new AxiosError('offline'))
    await expect(spreadsheetApi.postAction('doc', action)).rejects.toMatchObject({ kind: 'network', uncertain: true })
    http.post.mockRejectedValueOnce(failure(503, { error: 'Unavailable' }))
    await expect(spreadsheetApi.postAction('doc', action)).rejects.toMatchObject({ kind: 'server', uncertain: true })
  })

  it('encodes history routes and sends the original restore preconditions', async () => {
    http.post.mockResolvedValue({ data: { operation: { id: 'restore', outcome: 'accepted', revision: 2, structure_epoch: 1, event_seq: 2 }, state: { ...state(2), structure_epoch: 1 } } })
    const restore = { id: 'restore', base_revision: 1, structure_epoch: 0 }
    await spreadsheetApi.restoreHistory('doc', 'history/1', restore)
    expect(http.post).toHaveBeenCalledWith('/api/documents/doc/spreadsheet/history/history%2F1/restore', restore, { signal: undefined })
  })
})

describe('spreadsheet event wire adapter', () => {
  it('decodes authored cell JSON and explicit clear while preserving int64 safety', () => {
    const source = create(ServerEventSchema, {
      eventSeq: 10n,
      payload: { case: 'spreadsheetChanged', value: create(SpreadsheetChangedEventSchema, {
        documentId: 'doc', operationId: 'op', revision: 2n, structureEpoch: 0n, kind: 'cells',
        cells: [{ sheetId: 'sheet', row: 1, col: 2, cellJson: '{"f":"=SUM(A1:A2)"}' }, { sheetId: 'sheet', row: 3, col: 4, clear: true }],
      }) },
    })
    expect(spreadsheetEventFromServerEvent(source)).toMatchObject({
      document_id: 'doc', revision: 2, event_seq: 10,
      cells: [{ row: 1, col: 2, cell: { f: '=SUM(A1:A2)' } }, { row: 3, col: 4, cell: null }],
    })
    source.eventSeq = 9007199254740993n
    expect(() => spreadsheetEventFromServerEvent(source)).toThrow(SpreadsheetProblem)
    source.eventSeq = 10n
    if (source.payload.case === 'spreadsheetChanged') source.payload.value.cells[0]!.cellJson = 'broken JSON'
    expect(() => spreadsheetEventFromServerEvent(source)).toThrow(SpreadsheetProblem)
  })
})
