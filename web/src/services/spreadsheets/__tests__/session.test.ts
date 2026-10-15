import { describe, expect, it, vi } from 'vitest'
import type { IWorkbookData } from '@univerjs/core'
import { createSpreadsheetSession } from '../session'
import { SpreadsheetProblem, type SpreadsheetAction, type SpreadsheetChangedEvent, type SpreadsheetOperationResult, type SpreadsheetState, type SpreadsheetTransport } from '../types'
import { spreadsheetJournalRecordId, type SpreadsheetJournalRecord, type SpreadsheetSessionJournal } from '../journal'

function state(revision = 0, epoch = 0): SpreadsheetState {
  return { revision, structure_epoch: epoch, last_event_seq: revision, workbook: {
    id: 'book', sheetOrder: ['sheet'], sheets: { sheet: { id: 'sheet', rowCount: 10, columnCount: 10, cellData: {} } },
  } as unknown as IWorkbookData }
}

function action(id = 'operation', revision = 0, epoch = 0): SpreadsheetAction {
  return { id, base_revision: revision, structure_epoch: epoch, kind: 'cells', cells: [{ sheet_id: 'sheet', row: 0, col: 0, cell: { v: 7 } }] }
}

function result(id: string, current: SpreadsheetState, outcome: 'accepted' | 'conflict' = 'accepted', receiptRevision = current.revision): SpreadsheetOperationResult {
  return { operation: { id, outcome, revision: receiptRevision, structure_epoch: current.structure_epoch, event_seq: receiptRevision }, state: current }
}

function event(revision: number, extra: Partial<SpreadsheetChangedEvent> = {}): SpreadsheetChangedEvent {
  return { document_id: 'doc', operation_id: `event-${revision}`, revision, structure_epoch: 0, event_seq: revision, kind: 'cells', cells: [{ sheet_id: 'sheet', row: 0, col: 0, cell: { v: revision } }], ...extra }
}

function transport() {
  return { getState: vi.fn().mockResolvedValue(state()), postAction: vi.fn(), getHistorySnapshot: vi.fn(), restoreHistory: vi.fn() } satisfies SpreadsheetTransport
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function settle() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

function journals() {
  const records = new Map<string, SpreadsheetJournalRecord>()
  return (userId = 'user', documentId = 'doc') => {
    const key = JSON.stringify([userId, documentId])
    const store = (record: SpreadsheetJournalRecord, replaceId?: string) => {
      const previous = records.get(key)
      if (previous && spreadsheetJournalRecordId(previous) !== spreadsheetJournalRecordId(record) && spreadsheetJournalRecordId(previous) !== replaceId) throw new Error('Another unresolved operation exists')
      records.set(key, structuredClone(record))
    }
    return {
      load: vi.fn(async () => structuredClone(records.get(key) ?? null)),
      save: vi.fn(async (record: SpreadsheetJournalRecord, replaceId?: string) => { store(record, replaceId) }),
      clear: vi.fn(async (id: string) => {
        const previous = records.get(key)
        if (previous && spreadsheetJournalRecordId(previous) !== id) throw new Error('Another unresolved operation exists')
        records.delete(key)
      }),
      close: vi.fn(),
      get: () => records.get(key),
      store,
    } satisfies SpreadsheetSessionJournal & { get: () => SpreadsheetJournalRecord | undefined; store: typeof store }
  }
}

describe('spreadsheet session recovery', () => {
  it('captures an independent authored workbook and applies duplicate-filtered patches', async () => {
    const api = transport()
    const session = createSpreadsheetSession({ documentId: 'doc', transport: api })
    await session.load()
    const base = session.captureBase()
    base.workbook.sheets.sheet!.rowCount = 99
    expect(session.captureBase().workbook.sheets.sheet!.rowCount).toBe(10)
    session.receive(event(1))
    session.receive(event(1, { cells: [{ sheet_id: 'sheet', row: 0, col: 0, cell: { v: 99 } }] }))
    expect(session.getSnapshot().state?.workbook.sheets.sheet!.cellData?.[0]?.[0]?.v).toBe(1)
    session.receive(event(2, { cells: [{ sheet_id: 'sheet', row: 0, col: 0, cell: null }] }))
    expect(session.getSnapshot().state?.workbook.sheets.sheet!.cellData?.[0]).toBeUndefined()
  })

  it('keeps the exact unknown-acknowledgement body and ID after reconnect and newer events', async () => {
    const api = transport()
    api.postAction.mockRejectedValueOnce(new SpreadsheetProblem('network', 'Acknowledgement lost', 0, true))
    const session = createSpreadsheetSession({ documentId: 'doc', transport: api })
    await session.load()
    const input = action()
    const draft = { body: { dataStream: 'my draft\r\n' } }
    const submitted = session.submit(input, draft)
    input.base_revision = 99
    draft.body.dataStream = 'changed outside'
    await expect(submitted).rejects.toMatchObject({ kind: 'network' })
    session.receive(event(1))
    session.receive(event(2))
    api.getState.mockResolvedValue(state(2))
    await session.refresh()
    expect(session.getSnapshot()).toMatchObject({ status: 'uncertain', editable: false, pending: { action: { id: 'operation', base_revision: 0 }, draft: { body: { dataStream: 'my draft\r\n' } } } })
    expect(() => session.discardRejected()).toThrow(SpreadsheetProblem)
    api.postAction.mockResolvedValueOnce(result('operation', state(2), 'accepted', 1))
    await session.retryPending()
    expect(api.postAction.mock.calls[0]![1]).toEqual(api.postAction.mock.calls[1]![1])
    expect(session.getSnapshot()).toMatchObject({ status: 'ready', pending: null, state: { revision: 2 } })
  })

  it('never rolls back newer WS state when an older HTTP acknowledgement arrives', async () => {
    const api = transport()
    const ack = deferred<SpreadsheetOperationResult>()
    api.postAction.mockReturnValue(ack.promise)
    const session = createSpreadsheetSession({ documentId: 'doc', transport: api })
    await session.load()
    const submitted = session.submit(action())
    session.receive(event(1))
    session.receive(event(2))
    ack.resolve(result('operation', state(1)))
    await submitted
    expect(session.getSnapshot().state?.revision).toBe(2)
  })

  it('retains a rejected rich-text draft and rebases only as an explicit new-ID action', async () => {
    const api = transport()
    api.postAction.mockResolvedValueOnce(result('operation', state(1), 'conflict'))
    const session = createSpreadsheetSession({ documentId: 'doc', transport: api })
    await session.load()
    await session.submit(action(), { body: { dataStream: 'draft\r\n', textRuns: [{ st: 0, ed: 4, ts: { bl: 1 } }] } })
    expect(session.getSnapshot()).toMatchObject({ status: 'conflict', editable: false, rejected: { draft: { body: { textRuns: [{ ts: { bl: 1 } }] } } } })
    api.getState.mockResolvedValue(state(2))
    await session.refresh()
    expect(api.postAction).toHaveBeenCalledTimes(1)
    expect(() => session.resubmitRejected(action())).toThrow('new operation ID')
    api.postAction.mockResolvedValueOnce(result('replacement', state(3)))
    await session.resubmitRejected(action('replacement', 2))
    expect(api.postAction.mock.calls[1]![1]).toMatchObject({ id: 'replacement', base_revision: 2 })
    expect(session.getSnapshot()).toMatchObject({ status: 'ready', rejected: null })
  })

  it('serializes a double submission and shares a duplicate retry promise', async () => {
    const api = transport()
    const ack = deferred<SpreadsheetOperationResult>()
    api.postAction.mockReturnValue(ack.promise)
    const session = createSpreadsheetSession({ documentId: 'doc', transport: api })
    await session.load()
    const first = session.submit(action())
    expect(() => session.submit(action('other'))).toThrow(SpreadsheetProblem)
    expect(session.retryPending()).toBe(first)
    ack.resolve(result('operation', state(1)))
    await first
    expect(api.postAction).toHaveBeenCalledTimes(1)
  })

  it('fetches state on gaps or structural changes instead of applying patches to old coordinates', async () => {
    const api = transport()
    const session = createSpreadsheetSession({ documentId: 'doc', transport: api })
    await session.load()
    api.getState.mockResolvedValueOnce(state(3))
    session.receive(event(3))
    await settle()
    expect(session.getSnapshot().state?.revision).toBe(3)
    api.getState.mockResolvedValueOnce(state(4, 1))
    session.receive(event(4, { kind: 'structure', structure_epoch: 1, cells: [] }))
    await settle()
    expect(session.getSnapshot().state?.structure_epoch).toBe(1)
    expect(api.getState).toHaveBeenCalledTimes(3)
  })

  it('refreshes again if another committed change arrives during an in-flight fetch', async () => {
    const api = transport()
    const fetched = deferred<SpreadsheetState>()
    const session = createSpreadsheetSession({ documentId: 'doc', transport: api })
    await session.load()
    api.getState.mockReturnValueOnce(fetched.promise).mockResolvedValueOnce(state(5))
    session.receive(event(3))
    await settle()
    session.receive(event(5))
    fetched.resolve(state(3))
    await settle()
    expect(session.getSnapshot().state?.revision).toBe(5)
    expect(api.getState).toHaveBeenCalledTimes(3)
  })

  it('does not partially apply a bulk event when a later patch requires resynchronization', async () => {
    const api = transport()
    const fetched = deferred<SpreadsheetState>()
    const session = createSpreadsheetSession({ documentId: 'doc', transport: api })
    await session.load()
    api.getState.mockReturnValue(fetched.promise)
    session.receive(event(1, { cells: [
      { sheet_id: 'sheet', row: 0, col: 0, cell: { v: 1 } },
      { sheet_id: 'missing', row: 0, col: 0, cell: { v: 2 } },
    ] }))
    expect(session.getSnapshot().state?.revision).toBe(0)
    expect(session.getSnapshot().state?.workbook.sheets.sheet!.cellData).toEqual({})
    fetched.resolve(state(1))
    await settle()
  })

  it('keeps editing stopped if a fetch is older than an already received committed event', async () => {
    const api = transport()
    const session = createSpreadsheetSession({ documentId: 'doc', transport: api })
    await session.load()
    api.getState.mockResolvedValueOnce(state(2))
    session.receive(event(3))
    await settle()
    expect(session.getSnapshot()).toMatchObject({ status: 'error', editable: false, problem: { kind: 'protocol' } })
    api.getState.mockResolvedValueOnce(state(3))
    await session.refresh()
    expect(session.getSnapshot()).toMatchObject({ status: 'ready', state: { revision: 3 } })
  })

  it('stops editing on membership loss, keeps rejected content and never retries automatically', async () => {
    const api = transport()
    api.postAction.mockRejectedValue(new SpreadsheetProblem('access', 'Forbidden', 403))
    const session = createSpreadsheetSession({ documentId: 'doc', transport: api })
    await session.load()
    await expect(session.submit(action(), 'draft')).rejects.toMatchObject({ kind: 'access' })
    expect(session.getSnapshot()).toMatchObject({ status: 'blocked', editable: false, pending: null, rejected: { draft: 'draft' } })
    expect(() => session.submit(action('other'))).toThrow(SpreadsheetProblem)
    expect(api.postAction).toHaveBeenCalledTimes(1)
  })

  it('keeps a mismatched or malformed acknowledgement uncertain', async () => {
    const api = transport()
    api.postAction.mockResolvedValue(result('wrong', state(1)))
    const session = createSpreadsheetSession({ documentId: 'doc', transport: api })
    await session.load()
    await expect(session.submit(action())).rejects.toMatchObject({ kind: 'protocol' })
    expect(session.getSnapshot()).toMatchObject({ status: 'uncertain', pending: { action: { id: 'operation' } } })
  })

  it('retries an unknown history restore on the same route and original preconditions', async () => {
    const api = transport()
    api.restoreHistory.mockRejectedValueOnce(new SpreadsheetProblem('network', 'lost', 0, true))
    const session = createSpreadsheetSession({ documentId: 'doc', transport: api })
    await session.load()
    await expect(session.restoreHistory('snapshot', { id: 'restore', base_revision: 0, structure_epoch: 0 }, 'restore draft')).rejects.toThrow()
    api.getState.mockResolvedValue(state(1, 1))
    await session.refresh()
    api.restoreHistory.mockResolvedValueOnce(result('restore', state(1, 1)))
    await session.retryPending()
    expect(api.restoreHistory.mock.calls[0]!.slice(0, 3)).toEqual(api.restoreHistory.mock.calls[1]!.slice(0, 3))
    expect(api.postAction).not.toHaveBeenCalled()
  })

  it('aborts disposed requests and ignores responses arriving after navigation', async () => {
    const api = transport()
    const fetched = deferred<SpreadsheetState>()
    api.getState.mockReturnValue(fetched.promise)
    const changed = vi.fn()
    const session = createSpreadsheetSession({ documentId: 'doc', transport: api, onChange: changed })
    const loading = session.load()
    await settle()
    const signal = api.getState.mock.calls[0]![1] as AbortSignal
    session.dispose()
    expect(signal.aborted).toBe(true)
    const count = changed.mock.calls.length
    fetched.resolve(state(7))
    await loading
    expect(changed).toHaveBeenCalledTimes(count)
    expect(session.getSnapshot()).toMatchObject({ status: 'disposed', state: null })
  })

  it('isolates consumer exceptions from acknowledgement and state progression', async () => {
    const api = transport()
    api.postAction.mockResolvedValue(result('operation', state(1)))
    const session = createSpreadsheetSession({ documentId: 'doc', transport: api, onChange: () => { throw new Error('render failed') } })
    await session.load()
    await session.submit(action())
    expect(session.getSnapshot().status).toBe('ready')
  })
})

describe('spreadsheet durable journal', () => {
  it('persists before POST and stops sending if persistence fails', async () => {
    const journal = journals()()
    journal.save.mockRejectedValueOnce(new Error('Storage quota exceeded'))
    const api = transport()
    const session = createSpreadsheetSession({ documentId: 'doc', transport: api, journal })
    await session.load()
    await expect(session.submit(action(), { stream: 'retained' })).rejects.toMatchObject({ kind: 'storage', uncertain: false })
    expect(api.postAction).not.toHaveBeenCalled()
    expect(session.getSnapshot()).toMatchObject({ pending: { draft: { stream: 'retained' } }, problem: { kind: 'storage' } })
    api.postAction.mockImplementation(async (_doc, request) => {
      expect(journal.get()).toMatchObject({ phase: 'pending', request: { action: { id: request.id } } })
      return result('operation', state(1))
    })
    await session.retryPending()
    expect(api.postAction).toHaveBeenCalledTimes(1)
    expect(journal.get()).toBeUndefined()
  })

  it('recovers an unknown action before fetching state and waits for explicit unchanged retry', async () => {
    const factory = journals()
    const firstJournal = factory()
    const api = transport()
    api.postAction.mockRejectedValueOnce(new SpreadsheetProblem('network', 'ack lost', 0, true))
    const first = createSpreadsheetSession({ documentId: 'doc', transport: api, journal: firstJournal })
    await first.load()
    await expect(first.submit(action(), { body: { dataStream: 'draft\r\n', textRuns: [{ st: 0, ed: 4, ts: { bl: 1 } }] } })).rejects.toThrow()
    first.dispose()
    const nextApi = transport()
    const nextJournal = factory()
    nextApi.getState.mockImplementation(async () => {
      expect(nextJournal.load).toHaveBeenCalledTimes(1)
      return state(2)
    })
    const second = createSpreadsheetSession({ documentId: 'doc', transport: nextApi, journal: nextJournal })
    await second.load()
    expect(second.getSnapshot()).toMatchObject({ status: 'uncertain', pending: { action: { id: 'operation', base_revision: 0 }, draft: { body: { dataStream: 'draft\r\n' } } } })
    expect(nextApi.postAction).not.toHaveBeenCalled()
    nextApi.postAction.mockResolvedValue(result('operation', state(2), 'accepted', 1))
    await second.retryPending()
    expect(nextApi.postAction.mock.calls[0]![1]).toEqual(api.postAction.mock.calls[0]![1])
  })

  it('persists rejected content across reload and clears it only on explicit discard', async () => {
    const factory = journals()
    const api = transport()
    api.postAction.mockResolvedValue(result('operation', state(1), 'conflict'))
    const first = createSpreadsheetSession({ documentId: 'doc', transport: api, journal: factory() })
    await first.load()
    await first.submit(action(), 'rejected text')
    first.dispose()
    const journal = factory()
    const second = createSpreadsheetSession({ documentId: 'doc', transport: transport(), journal })
    await second.load()
    expect(second.getSnapshot()).toMatchObject({ status: 'conflict', rejected: { draft: 'rejected text' } })
    journal.clear.mockRejectedValueOnce(new Error('Disk unavailable'))
    await expect(second.discardRejected()).rejects.toMatchObject({ kind: 'storage' })
    expect(second.getSnapshot().rejected?.draft).toBe('rejected text')
    await second.discardRejected()
    expect(journal.get()).toBeUndefined()
    expect(second.getSnapshot().status).toBe('ready')
  })

  it('atomically replaces a durable rejected receipt when explicitly resubmitting with a new ID', async () => {
    const journal = journals()()
    const api = transport()
    api.postAction.mockResolvedValueOnce(result('operation', state(1), 'conflict'))
    const session = createSpreadsheetSession({ documentId: 'doc', transport: api, journal })
    await session.load()
    await session.submit(action(), 'draft')
    api.postAction.mockImplementationOnce(async () => {
      expect(journal.get()).toMatchObject({ phase: 'pending', request: { action: { id: 'rebased', base_revision: 1 }, draft: 'draft' } })
      return result('rebased', state(2))
    })
    await session.resubmitRejected(action('rebased', 1))
    expect(journal.save.mock.calls[journal.save.mock.calls.length - 1]?.[1]).toBe('operation')
    expect(journal.get()).toBeUndefined()
  })

  it('preserves pending identity when a committed receipt cannot be cleared durably', async () => {
    const factory = journals()
    const journal = factory()
    journal.clear.mockRejectedValueOnce(new Error('Disk unavailable'))
    const api = transport()
    api.postAction.mockResolvedValue(result('operation', state(1)))
    const first = createSpreadsheetSession({ documentId: 'doc', transport: api, journal })
    await first.load()
    await expect(first.submit(action(), 'draft')).rejects.toMatchObject({ kind: 'storage', uncertain: true })
    expect(first.getSnapshot()).toMatchObject({ status: 'uncertain', state: { revision: 1 }, pending: { action: { id: 'operation' } } })
    first.dispose()
    const nextApi = transport()
    nextApi.getState.mockResolvedValue(state(2))
    nextApi.postAction.mockResolvedValue(result('operation', state(2), 'accepted', 1))
    const second = createSpreadsheetSession({ documentId: 'doc', transport: nextApi, journal: factory() })
    await second.load()
    await second.retryPending()
    expect(nextApi.postAction.mock.calls[0]![1]).toEqual(api.postAction.mock.calls[0]![1])
    expect(second.getSnapshot().state?.revision).toBe(2)
  })

  it('persists access-loss drafts and isolates another authenticated user', async () => {
    const factory = journals()
    const api = transport()
    api.postAction.mockRejectedValue(new SpreadsheetProblem('access', 'Forbidden', 403))
    const first = createSpreadsheetSession({ documentId: 'doc', transport: api, journal: factory('user-a') })
    await first.load()
    await expect(first.submit(action(), 'private draft')).rejects.toThrow()
    expect(factory('user-a').get()).toMatchObject({ phase: 'rejected', request: { draft: 'private draft' } })
    const second = createSpreadsheetSession({ documentId: 'doc', transport: transport(), journal: factory('user-b') })
    await second.load()
    expect(second.getSnapshot()).toMatchObject({ status: 'ready', pending: null, rejected: null, localDraft: null })
  })

  it('stops before state loading if the recovery journal cannot be read', async () => {
    const journal = journals()()
    journal.load.mockRejectedValue(new Error('Database denied'))
    const api = transport()
    const session = createSpreadsheetSession({ documentId: 'doc', transport: api, journal })
    await expect(session.load()).rejects.toMatchObject({ kind: 'storage' })
    expect(api.getState).not.toHaveBeenCalled()
    expect(session.getSnapshot()).toMatchObject({ editable: false, status: 'error' })
  })

  it('does not clear an active draft storage error until a refresh durably saves its latest content', async () => {
    const journal = journals()()
    const api = transport()
    const session = createSpreadsheetSession({ documentId: 'doc', transport: api, journal })
    await session.load()
    journal.save.mockRejectedValueOnce(new Error('Quota exceeded')).mockRejectedValueOnce(new Error('Quota still exceeded'))
    await expect(session.saveDraft('draft', 'latest content')).rejects.toMatchObject({ kind: 'storage' })
    await expect(session.refresh()).rejects.toMatchObject({ kind: 'storage' })
    expect(session.getSnapshot()).toMatchObject({ status: 'error', editable: false, localDraft: { draft: 'latest content' } })
    await session.refresh()
    expect(journal.get()).toMatchObject({ phase: 'draft', draft: 'latest content' })
    expect(session.getSnapshot()).toMatchObject({ status: 'ready', editable: true, problem: null })
    expect(api.postAction).not.toHaveBeenCalled()
  })

  it('recovers an active rich-text draft without submitting and keeps it on failed discard', async () => {
    const factory = journals()
    const first = createSpreadsheetSession({ documentId: 'doc', transport: transport(), journal: factory() })
    await first.load()
    await first.saveDraft('draft-id', { base: state(), richText: { body: { dataStream: 'unfinished\r\n' } } })
    first.dispose()
    const journal = factory()
    const api = transport()
    const second = createSpreadsheetSession({ documentId: 'doc', transport: api, journal })
    await second.load()
    expect(second.getSnapshot()).toMatchObject({ status: 'draft', editable: false, localDraft: { id: 'draft-id', recovered: true, draft: { richText: { body: { dataStream: 'unfinished\r\n' } } } } })
    expect(api.postAction).not.toHaveBeenCalled()
    journal.clear.mockRejectedValueOnce(new Error('Disk unavailable'))
    await expect(second.clearDraft()).rejects.toMatchObject({ kind: 'storage' })
    expect(second.getSnapshot().localDraft).not.toBeNull()
    await second.clearDraft()
    expect(second.getSnapshot()).toMatchObject({ status: 'ready', localDraft: null })
  })

  it('coalesces 100 input changes, persists the latest before POST and cannot write stale drafts after clear', async () => {
    const factory = journals()
    const journal = factory()
    const firstWrite = deferred<void>()
    let first = true
    journal.save.mockImplementation(async (record, replaceId) => {
      if (record.phase === 'draft' && first) {
        first = false
        await firstWrite.promise
      }
      journal.store(record, replaceId)
    })
    const api = transport()
    api.postAction.mockImplementation(async () => {
      expect(journal.get()).toMatchObject({ phase: 'pending', request: { draft: { stream: 'draft-100' } } })
      return result('operation', state(1))
    })
    const session = createSpreadsheetSession({ documentId: 'doc', transport: api, journal })
    await session.load()
    const initial = session.saveDraft('draft', { base: state(), stream: 'draft-0' })
    await settle()
    for (let index = 1; index <= 100; index++) {
      expect(session.saveDraft('draft', { base: state(), stream: `draft-${index}` })).toBe(initial)
    }
    const submitted = session.submit(action())
    await settle()
    expect(api.postAction).not.toHaveBeenCalled()
    expect(journal.save).toHaveBeenCalledTimes(1)
    firstWrite.resolve()
    await submitted
    expect(journal.save.mock.calls.filter(([record]) => record.phase === 'draft')).toHaveLength(2)
    expect(journal.get()).toBeUndefined()
    await settle()
    expect(journal.get()).toBeUndefined()
  })

  it('preserves the persisted ancestor when distinct draft IDs supersede an unsent replacement', async () => {
    const factory = journals()
    const journal = factory()
    const firstWrite = deferred<void>()
    journal.save.mockImplementation(async (record, replaceId) => {
      if (record.phase === 'draft' && record.draftId === 'draft-a') await firstWrite.promise
      journal.store(record, replaceId)
    })
    const session = createSpreadsheetSession({ documentId: 'doc', transport: transport(), journal })
    await session.load()
    const saving = session.saveDraft('draft-a', { richText: 'first' })
    await settle()
    expect(session.saveDraft('draft-b', { richText: 'superseded' })).toBe(saving)
    expect(session.saveDraft('draft-c', { richText: 'latest' })).toBe(saving)
    firstWrite.resolve()
    await saving
    expect(journal.save).toHaveBeenCalledTimes(2)
    expect(journal.save.mock.calls[1]?.[1]).toBe('draft-a')
    expect(journal.get()).toMatchObject({ phase: 'draft', draftId: 'draft-c', draft: { richText: 'latest' } })
    session.dispose()
    const recovered = createSpreadsheetSession({ documentId: 'doc', transport: transport(), journal: factory() })
    await recovered.load()
    expect(recovered.getSnapshot()).toMatchObject({ status: 'draft', localDraft: { id: 'draft-c', draft: { richText: 'latest' }, recovered: true } })
  })

  it('retries a failed distinct-ID draft replacement against its last durable ancestor', async () => {
    const journal = journals()()
    const api = transport()
    const session = createSpreadsheetSession({ documentId: 'doc', transport: api, journal })
    await session.load()
    await session.saveDraft('draft-a', 'first')
    journal.save.mockRejectedValueOnce(new Error('Disk temporarily unavailable'))
    await expect(session.saveDraft('draft-b', 'latest')).rejects.toMatchObject({ kind: 'storage' })
    expect(journal.get()).toMatchObject({ draftId: 'draft-a' })
    await session.refresh()
    expect(journal.save.mock.calls[journal.save.mock.calls.length - 1]?.[1]).toBe('draft-a')
    expect(journal.get()).toMatchObject({ draftId: 'draft-b', draft: 'latest' })
    expect(session.getSnapshot()).toMatchObject({ status: 'ready', problem: null, localDraft: { id: 'draft-b', draft: 'latest' } })
    expect(api.postAction).not.toHaveBeenCalled()
  })

  it('discards its durable ancestor after a newer draft replacement fails', async () => {
    const journal = journals()()
    const session = createSpreadsheetSession({ documentId: 'doc', transport: transport(), journal })
    await session.load()
    await session.saveDraft('draft-a', 'first')
    journal.save.mockRejectedValueOnce(new Error('Disk temporarily unavailable'))
    await expect(session.saveDraft('draft-b', 'latest')).rejects.toMatchObject({ kind: 'storage' })
    await session.clearDraft()
    expect(journal.clear).toHaveBeenCalledWith('draft-a')
    expect(journal.get()).toBeUndefined()
    expect(session.getSnapshot()).toMatchObject({ status: 'ready', localDraft: null, problem: null })
  })

  it('retries an action retained by a failed draft barrier against the durable ancestor', async () => {
    const journal = journals()()
    const api = transport()
    const session = createSpreadsheetSession({ documentId: 'doc', transport: api, journal })
    await session.load()
    await session.saveDraft('draft-a', 'first')
    const failedWrite = deferred<void>()
    journal.save.mockImplementationOnce(async () => { await failedWrite.promise })
    const saving = session.saveDraft('draft-b', 'latest')
    const submitted = session.submit(action())
    failedWrite.reject(new Error('Disk temporarily unavailable'))
    await expect(saving).rejects.toMatchObject({ kind: 'storage' })
    await expect(submitted).rejects.toMatchObject({ kind: 'storage' })
    expect(api.postAction).not.toHaveBeenCalled()
    expect(journal.get()).toMatchObject({ draftId: 'draft-a' })
    api.postAction.mockImplementation(async () => {
      expect(journal.get()).toMatchObject({ phase: 'pending', request: { draft: 'latest' } })
      return result('operation', state(1))
    })
    await session.retryPending()
    expect(journal.save.mock.calls[journal.save.mock.calls.length - 1]?.[1]).toBe('draft-a')
    expect(journal.get()).toBeUndefined()
    expect(session.getSnapshot()).toMatchObject({ status: 'ready', pending: null })
  })

  it('lets the latest queued draft finish after disposal before closing the connection', async () => {
    const journal = journals()()
    const write = deferred<void>()
    journal.save.mockImplementation(async (record, replaceId) => { await write.promise; journal.store(record, replaceId) })
    const session = createSpreadsheetSession({ documentId: 'doc', transport: transport(), journal })
    await session.load()
    const saving = session.saveDraft('draft', 'last typed value')
    await settle()
    session.dispose()
    expect(journal.close).not.toHaveBeenCalled()
    write.resolve()
    await saving
    await settle()
    expect(journal.get()).toMatchObject({ phase: 'draft', draft: 'last typed value' })
    expect(journal.close).toHaveBeenCalledTimes(1)
  })

  it('recovers the latest coalesced rich-text draft after acknowledgement loss', async () => {
    const factory = journals()
    const api = transport()
    api.postAction.mockRejectedValueOnce(new SpreadsheetProblem('network', 'ack lost', 0, true))
    const first = createSpreadsheetSession({ documentId: 'doc', transport: api, journal: factory() })
    await first.load()
    let saved: Promise<void> | undefined
    for (let index = 0; index < 100; index++) saved = first.saveDraft('draft', { base: state(), richText: { body: { dataStream: `draft-${index}\r\n` } } })
    const submitted = first.submit(action())
    await saved
    await expect(submitted).rejects.toThrow()
    first.dispose()
    const nextApi = transport()
    const second = createSpreadsheetSession({ documentId: 'doc', transport: nextApi, journal: factory() })
    await second.load()
    expect(second.getSnapshot()).toMatchObject({ status: 'uncertain', pending: { draft: { richText: { body: { dataStream: 'draft-99\r\n' } } } } })
    expect(nextApi.postAction).not.toHaveBeenCalled()
  })

  it('recovers the exact history route after reload without automatic replay', async () => {
    const factory = journals()
    const api = transport()
    api.restoreHistory.mockRejectedValueOnce(new SpreadsheetProblem('network', 'ack lost', 0, true))
    const first = createSpreadsheetSession({ documentId: 'doc', transport: api, journal: factory() })
    await first.load()
    await expect(first.restoreHistory('snapshot', { id: 'restore', base_revision: 0, structure_epoch: 0 }, 'draft')).rejects.toThrow()
    first.dispose()
    const nextApi = transport()
    nextApi.restoreHistory.mockResolvedValue(result('restore', state(1, 1)))
    const second = createSpreadsheetSession({ documentId: 'doc', transport: nextApi, journal: factory() })
    await second.load()
    expect(nextApi.restoreHistory).not.toHaveBeenCalled()
    await second.retryPending()
    expect(nextApi.restoreHistory.mock.calls[0]!.slice(0, 3)).toEqual(api.restoreHistory.mock.calls[0]!.slice(0, 3))
    expect(nextApi.postAction).not.toHaveBeenCalled()
  })

  it('does not overwrite another same-user tab operation before sending', async () => {
    const factory = journals()
    const journal = factory()
    const api = transport()
    const session = createSpreadsheetSession({ documentId: 'doc', transport: api, journal })
    await session.load()
    journal.store({ version: 1, phase: 'pending', request: { action: action('other-tab'), draft: 'other draft' } })
    await expect(session.submit(action(), 'current draft')).rejects.toMatchObject({ kind: 'storage' })
    expect(api.postAction).not.toHaveBeenCalled()
    expect(journal.get()).toMatchObject({ request: { action: { id: 'other-tab' } } })
    expect(session.getSnapshot()).toMatchObject({ pending: { draft: 'current draft' } })
  })
})
