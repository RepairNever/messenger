import { parseSpreadsheetOperationResult, parseSpreadsheetState, spreadsheetSafeInteger } from './api'
import type { SpreadsheetJournalRecord, SpreadsheetOperationJournalRecord, SpreadsheetSessionJournal } from './journal'
import {
  SpreadsheetProblem,
  MAX_SPREADSHEET_CELL_PATCHES,
  type SpreadsheetAction,
  type SpreadsheetChangedEvent,
  type SpreadsheetHistoryRestoreAction,
  type SpreadsheetOperationResult,
  type SpreadsheetState,
  type SpreadsheetTransport,
} from './types'

export interface SpreadsheetPendingAction {
  action: SpreadsheetAction | SpreadsheetHistoryRestoreAction
  /** Present only for a history restore. Retained with its receipt request. */
  historyId?: string
  draft?: unknown
}

export interface SpreadsheetRejectedAction extends SpreadsheetPendingAction {
  result?: SpreadsheetOperationResult
}

export interface SpreadsheetLocalDraft {
  id: string
  draft: unknown
  recovered: boolean
}

export type SpreadsheetSessionStatus = 'idle' | 'loading' | 'ready' | 'draft' | 'submitting' | 'uncertain' | 'conflict' | 'blocked' | 'error' | 'disposed'

export interface SpreadsheetSessionSnapshot {
  state: SpreadsheetState | null
  status: SpreadsheetSessionStatus
  pending: SpreadsheetPendingAction | null
  rejected: SpreadsheetRejectedAction | null
  localDraft: SpreadsheetLocalDraft | null
  problem: SpreadsheetProblem | null
  editable: boolean
}

export interface SpreadsheetSessionOptions {
  documentId: string
  transport: SpreadsheetTransport
  /** Production supplies a journal bound to the authenticated user and book. */
  journal?: SpreadsheetSessionJournal
  onChange?: (snapshot: SpreadsheetSessionSnapshot) => void
  onProblem?: (problem: SpreadsheetProblem) => void
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

function problemFrom(error: unknown, write = false): SpreadsheetProblem {
  if (error instanceof SpreadsheetProblem) {
    if (write && error.kind === 'protocol' && !error.uncertain) return new SpreadsheetProblem(error.kind, error.message, error.status, true)
    return error
  }
  return new SpreadsheetProblem('network', error instanceof Error ? error.message : 'Spreadsheet request failed', 0, write)
}

/** One active workbook. Its owner explicitly subscribes, refreshes and disposes it. */
export function createSpreadsheetSession(options: SpreadsheetSessionOptions) {
  const controller = new AbortController()
  const usedIds = new Set<string>()
  let state: SpreadsheetState | null = null
  let pending: SpreadsheetPendingAction | null = null
  let rejected: SpreadsheetRejectedAction | null = null
  let localDraft: SpreadsheetLocalDraft | null = null
  let pendingReplaceId: string | undefined
  let problem: SpreadsheetProblem | null = null
  let disposed = false
  let blocked = false
  let sending = false
  let refreshing = false
  let refreshAgain = false
  let requiredRevision = 0
  let requiredEpoch = 0
  let refreshPromise: Promise<void> | null = null
  let writePromise: Promise<SpreadsheetOperationResult> | null = null
  let journalLoaded = !options.journal
  // Advance only after a durable read/write. A failed replacement leaves the
  // previous record in storage even though the latest local draft has a new ID.
  let journalOwnedId: string | undefined
  let journalTail: Promise<void> = Promise.resolve()
  let desiredDraftWrite: { record: SpreadsheetJournalRecord; replaceId?: string } | null = null
  let draftWritePromise: Promise<void> | null = null

  function getSnapshot(): SpreadsheetSessionSnapshot {
    const status: SpreadsheetSessionStatus = disposed ? 'disposed'
      : blocked ? 'blocked'
        : pending ? sending ? 'submitting' : 'uncertain'
          : rejected ? 'conflict'
            : refreshing ? 'loading'
              : localDraft?.recovered ? 'draft'
              : problem ? 'error'
                : state ? 'ready' : 'idle'
    return {
      state: state ? structuredClone(state) : null,
      status,
      pending: pending ? structuredClone(pending) : null,
      rejected: rejected ? structuredClone(rejected) : null,
      localDraft: localDraft ? structuredClone(localDraft) : null,
      problem,
      editable: status === 'ready',
    }
  }

  function publish() {
    // UI consumers cannot change transaction/recovery semantics by throwing.
    try { options.onChange?.(getSnapshot()) } catch { /* Consumer owns rendering errors. */ }
  }

  function report(next: SpreadsheetProblem) {
    problem = next
    if (next.kind === 'access') blocked = true
    try { options.onProblem?.(next) } catch { /* Isolate consumers. */ }
    publish()
  }

  function ensureAlive() {
    if (disposed) throw new SpreadsheetProblem('disposed', 'Spreadsheet session is closed')
  }

  function storageProblem(error: unknown, uncertain = false): SpreadsheetProblem {
    return new SpreadsheetProblem('storage', error instanceof Error ? error.message : 'The recovery journal could not be saved. Your draft remains open.', 0, uncertain)
  }

  function queueJournal(work: () => Promise<void>): Promise<void> {
    const next = journalTail.catch(() => {}).then(work)
    journalTail = next
    return next
  }

  async function saveJournal(record: SpreadsheetJournalRecord, replaceId?: string) {
    await options.journal!.save(record, journalOwnedId ?? replaceId)
    journalOwnedId = record.phase === 'draft' ? record.draftId : record.request.action.id
  }

  async function clearJournal(id: string) {
    await options.journal!.clear(id)
    if (journalOwnedId === id) journalOwnedId = undefined
  }

  function serializedProblem(value: SpreadsheetProblem): NonNullable<SpreadsheetOperationJournalRecord['problem']> {
    return { kind: value.kind, message: value.message, status: value.status, uncertain: value.uncertain }
  }

  async function restoreJournal() {
    if (journalLoaded) return
    try {
      const saved = await options.journal!.load()
      if (disposed) return
      if (saved) {
        if (saved.version !== 1) throw new SpreadsheetProblem('storage', 'Unsupported spreadsheet recovery journal version')
        if (saved.phase === 'draft') {
          if (!saved.draftId) throw new SpreadsheetProblem('storage', 'Invalid recovered draft ID')
          localDraft = { id: saved.draftId, draft: structuredClone(saved.draft), recovered: true }
          journalOwnedId = saved.draftId
        } else {
          if (saved.phase !== 'pending' && saved.phase !== 'rejected') throw new SpreadsheetProblem('storage', 'Invalid spreadsheet recovery journal')
          validateAction(saved.request.action)
          if (!saved.request.historyId && !('kind' in saved.request.action)) throw new SpreadsheetProblem('storage', 'Invalid recovered action route')
          const request = deepFreeze(structuredClone(saved.request))
          journalOwnedId = request.action.id
          usedIds.add(request.action.id)
          if (saved.phase === 'pending') {
            pending = request
            problem = new SpreadsheetProblem('network', 'An unresolved operation was recovered. Retry it with its original ID and content.', 0, true)
          } else {
            rejected = { ...request, ...(saved.result ? { result: parseSpreadsheetOperationResult(saved.result) } : {}) }
            problem = saved.problem
              ? new SpreadsheetProblem(saved.problem.kind, saved.problem.message, saved.problem.status, saved.problem.uncertain)
              : new SpreadsheetProblem('conflict', 'A rejected draft was recovered. It has not been resubmitted.', 409)
          }
        }
      }
      journalLoaded = true
    } catch (error) { throw storageProblem(error) }
  }

  function applyState(value: SpreadsheetState) {
    const next = parseSpreadsheetState(value)
    if (state) {
      if (next.revision < state.revision) return
      if (next.structure_epoch < state.structure_epoch || (next.revision === state.revision && next.structure_epoch !== state.structure_epoch)) {
        throw new SpreadsheetProblem('protocol', 'Spreadsheet revision and structure epoch disagree')
      }
      if (next.revision === state.revision && next.last_event_seq <= state.last_event_seq) return
      if (next.last_event_seq < state.last_event_seq) throw new SpreadsheetProblem('protocol', 'Spreadsheet event sequence moved backwards')
    }
    state = next
  }

  function refresh(): Promise<void> {
    ensureAlive()
    if (refreshPromise) return refreshPromise
    refreshing = true
    publish()
    const run = async () => {
      try {
        await restoreJournal()
        if (disposed) return
        do {
          refreshAgain = false
          const next = await options.transport.getState(options.documentId, controller.signal)
          if (disposed) return
          applyState(next)
        } while (refreshAgain)
        if (!state || state.revision < requiredRevision || state.structure_epoch < requiredEpoch) {
          throw new SpreadsheetProblem('protocol', 'Workbook state has not caught up to the received event')
        }
        if (options.journal && localDraft && !localDraft.recovered && problem?.kind === 'storage') {
          // A successful HTTP read does not repair failed draft persistence.
          // Retry the newest local snapshot before allowing editing again.
          if (draftWritePromise) await draftWritePromise.catch(() => {})
          const retained = localDraft
          desiredDraftWrite = null
          try {
            await queueJournal(() => saveJournal({ version: 1, phase: 'draft', draftId: retained.id, draft: retained.draft }))
          } catch (error) { throw storageProblem(error) }
        }
        if (disposed) return
        blocked = false
        if (!pending && !rejected) problem = null
      } catch (error) {
        const next = problemFrom(error)
        if (!disposed) report(next)
        throw next
      } finally {
        refreshing = false
        refreshPromise = null
        if (!disposed) publish()
      }
    }
    // Defer execution until the promise slot exists, including synchronous mocks.
    refreshPromise = Promise.resolve().then(run)
    return refreshPromise
  }

  function requestRefresh() {
    if (disposed || blocked) return
    if (refreshPromise) refreshAgain = true
    void refresh().catch(() => { /* report() already publishes the failure. */ })
  }

  function captureBase(): SpreadsheetState {
    ensureAlive()
    if (!state || blocked || refreshing) throw new SpreadsheetProblem('busy', 'The workbook is being synchronized')
    return structuredClone(state)
  }

  function validateAction(action: SpreadsheetAction | SpreadsheetHistoryRestoreAction) {
    if (!action.id || typeof action.id !== 'string') throw new SpreadsheetProblem('validation', 'An operation ID is required')
    spreadsheetSafeInteger(action.base_revision, 'action base revision')
    spreadsheetSafeInteger(action.structure_epoch, 'action structure epoch')
    if ('kind' in action) {
      if (action.kind === 'cells') {
        if (!Array.isArray(action.cells) || !action.cells.length) throw new SpreadsheetProblem('validation', 'A cell action must contain cells')
        if (action.cells.length > MAX_SPREADSHEET_CELL_PATCHES) throw new SpreadsheetProblem('validation', `A single edit supports at most ${MAX_SPREADSHEET_CELL_PATCHES} cells`)
        const addresses = new Set<string>()
        for (const cell of action.cells) {
          if (!cell.sheet_id) throw new SpreadsheetProblem('validation', 'A worksheet ID is required')
          spreadsheetSafeInteger(cell.row, 'cell row')
          spreadsheetSafeInteger(cell.col, 'cell column')
          const key = JSON.stringify([cell.sheet_id, cell.row, cell.col])
          if (addresses.has(key)) throw new SpreadsheetProblem('validation', 'A cell action contains duplicate addresses')
          addresses.add(key)
          if (cell.cell !== null && (typeof cell.cell !== 'object' || Array.isArray(cell.cell))) {
            throw new SpreadsheetProblem('validation', 'Invalid authored cell')
          }
        }
      } else if (action.kind !== 'structure') {
        throw new SpreadsheetProblem('validation', 'Invalid spreadsheet action kind')
      }
    }
  }

  function sendPending(retrying = false): Promise<SpreadsheetOperationResult> {
    ensureAlive()
    if (!pending) throw new SpreadsheetProblem('busy', 'There is no pending operation')
    if (blocked) throw new SpreadsheetProblem('access', 'Spreadsheet access is unavailable')
    if (writePromise) return writePromise
    const request = pending
    const draftBarrier = draftWritePromise ?? journalTail
    sending = true
    problem = null
    publish()
    const run = async () => {
      let sent = false
      try {
        if (options.journal) {
          try {
            // A failed in-progress draft write stops this first submission.
            // An explicit retry may attempt to persist the complete action anew.
            if (!retrying) await draftBarrier
            await queueJournal(() => saveJournal({ version: 1, phase: 'pending', request }, pendingReplaceId))
            pendingReplaceId = undefined
            if (!disposed) localDraft = null
          } catch (error) { throw storageProblem(error) }
        }
        ensureAlive()
        sent = true
        const response = request.historyId
          ? await options.transport.restoreHistory(options.documentId, request.historyId, request.action, controller.signal)
          : await options.transport.postAction(options.documentId, request.action as SpreadsheetAction, controller.signal)
        const result = parseSpreadsheetOperationResult(response)
        if (result.operation.id !== request.action.id) throw new SpreadsheetProblem('protocol', 'Acknowledgement operation ID does not match', 0, true)
        if (!disposed) applyState(result.state)
        if (result.operation.outcome === 'conflict') {
          const conflict = new SpreadsheetProblem('conflict', result.operation.message || 'Another edit was saved first. Your draft has been retained.', 409)
          if (options.journal) {
            try { await queueJournal(() => saveJournal({ version: 1, phase: 'rejected', request, result, problem: serializedProblem(conflict) })) } catch (error) { throw storageProblem(error, true) }
          }
          if (disposed) return result
          pending = null
          rejected = { ...request, result }
          report(conflict)
        } else {
          if (options.journal) {
            try { await queueJournal(() => clearJournal(request.action.id)) } catch (error) { throw storageProblem(error, true) }
          }
          if (disposed) return result
          pending = null
          rejected = null
          problem = null
        }
        return result
      } catch (error) {
        const next = problemFrom(error, true)
        if (!disposed) {
          // Invalid responses and server/network failures may follow a commit.
          // Definitive client/access rejections retain the draft but permit no
          // automatic replay with changed preconditions.
          if (sent && !next.uncertain && next.kind !== 'network' && next.kind !== 'server' && next.kind !== 'protocol' && next.kind !== 'storage') {
            if (next.kind === 'access') blocked = true
            if (options.journal) {
              try { await queueJournal(() => saveJournal({ version: 1, phase: 'rejected', request, problem: serializedProblem(next) })) } catch (error) {
                const failure = storageProblem(error, true)
                report(failure)
                throw failure
              }
            }
            if (disposed) throw next
            pending = null
            rejected = { ...request }
          }
          report(next)
        }
        throw next
      } finally {
        sending = false
        writePromise = null
        if (!disposed) publish()
      }
    }
    writePromise = Promise.resolve().then(run)
    return writePromise
  }

  function start(action: SpreadsheetAction | SpreadsheetHistoryRestoreAction, draft?: unknown, historyId?: string, replaceId?: string): Promise<SpreadsheetOperationResult> {
    ensureAlive()
    if (!getSnapshot().editable) throw new SpreadsheetProblem('busy', 'Resolve or retry the current operation before editing')
    validateAction(action)
    if (usedIds.has(action.id)) throw new SpreadsheetProblem('validation', 'A new operation requires a new ID')
    const retainedDraft = draft === undefined ? localDraft?.draft : draft
    const request = deepFreeze(structuredClone({ action, ...(historyId ? { historyId } : {}), ...(retainedDraft === undefined ? {} : { draft: retainedDraft }) }))
    usedIds.add(action.id)
    pending = request
    pendingReplaceId = replaceId ?? localDraft?.id
    return sendPending()
  }

  function discardRejected() {
    ensureAlive()
    if (pending) throw new SpreadsheetProblem('busy', 'The pending operation outcome must be resolved first')
    const discarded = rejected
    const run = async () => {
      try {
        if (discarded && options.journal) await queueJournal(() => clearJournal(discarded.action.id))
        if (disposed) return
        if (rejected === discarded) rejected = null
        problem = null
        publish()
      } catch (error) {
        const next = storageProblem(error)
        if (!disposed) report(next)
        throw next
      }
    }
    return run()
  }

  function resubmitRejected(action: SpreadsheetAction, draft?: unknown): Promise<SpreadsheetOperationResult> {
    ensureAlive()
    if (!rejected || pending || blocked || refreshing) throw new SpreadsheetProblem('busy', 'There is no rejected draft ready to resubmit')
    validateAction(action)
    if (usedIds.has(action.id)) throw new SpreadsheetProblem('validation', 'Resubmitting a draft requires a new operation ID')
    const previous = rejected
    rejected = null
    problem = null
    try { return start(action, draft === undefined ? previous.draft : draft, undefined, previous.action.id) } catch (error) {
      rejected = previous
      throw error
    }
  }

  function saveDraft(id: string, draft: unknown): Promise<void> {
    ensureAlive()
    if (!id) throw new SpreadsheetProblem('validation', 'A draft ID is required')
    if (!journalLoaded || pending || rejected || blocked || refreshing) throw new SpreadsheetProblem('busy', 'Resolve the current workbook operation before editing')
    const previousId = localDraft?.id
    const plain = structuredClone(draft)
    localDraft = { id, draft: plain, recovered: false }
    const record: SpreadsheetJournalRecord = { version: 1, phase: 'draft', draftId: id, draft: plain }
    // Keep only the running write and newest unsent snapshot. Rapid input must
    // not retain a workbook-sized record for every keystroke.
    const replaceId = desiredDraftWrite ? desiredDraftWrite.replaceId : previousId
    desiredDraftWrite = { record, replaceId }
    publish()
    if (draftWritePromise) return draftWritePromise
    const run = async () => {
      try {
        while (desiredDraftWrite) {
          const next = desiredDraftWrite
          desiredDraftWrite = null
          if (options.journal) await queueJournal(() => saveJournal(next.record, next.replaceId))
        }
        if (!disposed && !pending && !rejected && problem?.kind === 'storage') problem = null
      } catch (error) {
        const next = storageProblem(error)
        if (!disposed) report(next)
        throw next
      } finally {
        draftWritePromise = null
        if (!disposed) publish()
      }
    }
    draftWritePromise = Promise.resolve().then(run)
    return draftWritePromise
  }

  function clearDraft(): Promise<void> {
    ensureAlive()
    if (pending || rejected) throw new SpreadsheetProblem('busy', 'The operation outcome must be resolved before discarding its draft')
    const discarded = localDraft
    const draftBarrier = draftWritePromise
    desiredDraftWrite = null
    const run = async () => {
      try {
        if (draftBarrier) await draftBarrier.catch(() => {})
        if (localDraft !== discarded) return
        if (discarded && options.journal) await queueJournal(() => clearJournal(journalOwnedId ?? discarded.id))
        if (disposed) return
        if (localDraft === discarded) localDraft = null
        if (problem?.kind === 'storage') problem = null
        publish()
      } catch (error) {
        const next = storageProblem(error)
        if (!disposed) report(next)
        throw next
      }
    }
    return run()
  }

  function receive(event: SpreadsheetChangedEvent) {
    if (disposed || blocked || event.document_id !== options.documentId) return
    try {
      spreadsheetSafeInteger(event.revision, 'event revision')
      spreadsheetSafeInteger(event.structure_epoch, 'event structure epoch')
      spreadsheetSafeInteger(event.event_seq, 'event sequence')
      if (event.kind !== 'cells' && event.kind !== 'structure') throw new SpreadsheetProblem('protocol', 'Invalid spreadsheet event kind')
      if (state && event.revision <= state.revision) return
      if (!state || event.kind === 'structure' || event.revision !== state.revision + 1 || event.structure_epoch !== state.structure_epoch) {
        requiredRevision = Math.max(requiredRevision, event.revision)
        requiredEpoch = Math.max(requiredEpoch, event.structure_epoch)
        requestRefresh()
        return
      }
      const next = structuredClone(state)
      const addresses = new Set<string>()
      for (const patch of event.cells) {
        spreadsheetSafeInteger(patch.row, 'event row')
        spreadsheetSafeInteger(patch.col, 'event column')
        const sheet = next.workbook.sheets[patch.sheet_id]
        const key = JSON.stringify([patch.sheet_id, patch.row, patch.col])
        if (!sheet || patch.row >= spreadsheetSafeInteger(sheet.rowCount, 'worksheet row count') || patch.col >= spreadsheetSafeInteger(sheet.columnCount, 'worksheet column count') || addresses.has(key)) {
          requestRefresh()
          return
        }
        addresses.add(key)
        const matrix = sheet.cellData ?? (sheet.cellData = {})
        if (patch.cell === null) {
          if (matrix[patch.row]) {
            delete matrix[patch.row][patch.col]
            if (!Object.keys(matrix[patch.row]).length) delete matrix[patch.row]
          }
        } else {
          const row = matrix[patch.row] ?? (matrix[patch.row] = {})
          row[patch.col] = structuredClone(patch.cell)
        }
      }
      next.revision = event.revision
      next.last_event_seq = event.event_seq
      applyState(next)
      publish()
    } catch (error) {
      report(problemFrom(error))
      requestRefresh()
    }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    controller.abort()
    state = null
    pending = null
    rejected = null
    localDraft = null
    usedIds.clear()
    void (draftWritePromise ?? Promise.resolve()).catch(() => {})
      .then(() => journalTail.catch(() => {}))
      .finally(() => { options.journal?.close?.() })
    publish()
  }

  return {
    getSnapshot,
    captureBase,
    load: refresh,
    refresh,
    submit: (action: SpreadsheetAction, draft?: unknown) => start(action, draft),
    restoreHistory: (historyId: string, action: SpreadsheetHistoryRestoreAction, draft?: unknown) => {
      if (!historyId) throw new SpreadsheetProblem('validation', 'A history snapshot ID is required')
      return start(action, draft, historyId)
    },
    retryPending: () => sendPending(true),
    discardRejected,
    saveDraft,
    clearDraft,
    resubmitRejected,
    receive,
    dispose,
  }
}

export type SpreadsheetSession = ReturnType<typeof createSpreadsheetSession>
