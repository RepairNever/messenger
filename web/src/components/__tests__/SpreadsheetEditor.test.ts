import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { IWorkbookData } from '@univerjs/core'
import type { SpreadsheetSessionOptions, SpreadsheetSessionSnapshot } from '@/services/spreadsheets/session'
import type { SpreadsheetEditorDraft } from '@/services/spreadsheets/editor'
import type { SpreadsheetAction, SpreadsheetOperationResult, SpreadsheetState } from '@/services/spreadsheets/types'
import { SpreadsheetProblem } from '@/services/spreadsheets/types'

const runtime = vi.hoisted(() => ({
  sessionOptions: null as SpreadsheetSessionOptions | null,
  snapshot: null as SpreadsheetSessionSnapshot | null,
  draftCallback: null as ((draft: SpreadsheetEditorDraft | null) => void) | null,
  headerCallback: null as ((element: HTMLElement | null) => void) | null,
  eventCallback: null as ((event: unknown) => void) | null,
  readyCallback: null as (() => void) | null,
  auth: { user: { id: 'authenticated-user' } },
  load: vi.fn(), refresh: vi.fn(), captureBase: vi.fn(), submit: vi.fn(), retryPending: vi.fn(),
  resubmitRejected: vi.fn(), discardRejected: vi.fn(), saveDraft: vi.fn(), clearDraft: vi.fn(),
  receive: vi.fn(), dispose: vi.fn(), bridgeDispose: vi.fn(), setEditable: vi.fn(), applyState: vi.fn(),
  unsubscribeEvents: vi.fn(), unsubscribeReady: vi.fn(), createJournal: vi.fn(), eventAdapter: vi.fn(),
  history: vi.fn(),
  bridgeSubmit: null as ((action: SpreadsheetAction, draft: unknown) => Promise<SpreadsheetOperationResult>) | null,
}))

vi.mock('@/stores/chat', () => ({ useChatStore: () => ({
  subscribeAppliedServerEvents: (callback: (event: unknown) => void) => { runtime.eventCallback = callback; return runtime.unsubscribeEvents },
  subscribeRealtimeReady: (callback: () => void) => { runtime.readyCallback = callback; return runtime.unsubscribeReady },
}) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => runtime.auth }))
vi.mock('@/services/spreadsheets/journal', () => ({ createIndexedDbSpreadsheetJournal: runtime.createJournal }))
vi.mock('@/services/spreadsheets/api', () => ({ spreadsheetApi: {}, spreadsheetEventFromServerEvent: runtime.eventAdapter }))
vi.mock('@/services/http/documentsApi', () => ({ documentsListDocumentHistory: runtime.history }))
vi.mock('@/services/spreadsheets/session', () => ({ createSpreadsheetSession: (options: SpreadsheetSessionOptions) => {
  runtime.sessionOptions = options
  return {
    getSnapshot: () => runtime.snapshot, load: runtime.load, refresh: runtime.refresh, captureBase: runtime.captureBase,
    submit: runtime.submit, retryPending: runtime.retryPending, resubmitRejected: runtime.resubmitRejected,
    discardRejected: runtime.discardRejected, saveDraft: runtime.saveDraft, clearDraft: runtime.clearDraft,
    receive: runtime.receive, dispose: runtime.dispose,
  }
} }))
vi.mock('@/services/spreadsheets/editor', () => ({ SpreadsheetEditorBridge: class {
  constructor(options: { onDraft: (draft: SpreadsheetEditorDraft | null) => void; submit: typeof runtime.bridgeSubmit; onHeaderMount: typeof runtime.headerCallback }) {
    runtime.draftCallback = options.onDraft; runtime.bridgeSubmit = options.submit
    runtime.headerCallback = options.onHeaderMount
  }
  setEditable = runtime.setEditable
  applyState = runtime.applyState
  dispose = runtime.bridgeDispose
} }))

import SpreadsheetEditor from '@/components/documents/SpreadsheetEditor.vue'

function state(revision = 2): SpreadsheetState {
  return { revision, structure_epoch: 0, last_event_seq: revision, workbook: {
    id: 'book', sheetOrder: ['sheet'], sheets: { sheet: { id: 'sheet', rowCount: 10, columnCount: 10, cellData: {} } },
  } as unknown as IWorkbookData }
}

function action(): SpreadsheetAction {
  return { id: 'original-operation', base_revision: 0, structure_epoch: 0, kind: 'cells', cells: [{ sheet_id: 'sheet', row: 1, col: 1, cell: { v: 9 } }] }
}

function snapshot(overrides: Partial<SpreadsheetSessionSnapshot> = {}): SpreadsheetSessionSnapshot {
  return { state: state(), status: 'ready', pending: null, rejected: null, localDraft: null, problem: null, editable: true, ...overrides }
}

function publish(value: SpreadsheetSessionSnapshot) {
  runtime.snapshot = value
  runtime.sessionOptions?.onChange?.(value)
}

function button(wrapper: ReturnType<typeof mount>, label: string) {
  return wrapper.findAll('button').find(element => element.text() === label)!
}

describe('SpreadsheetEditor recovery and lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runtime.sessionOptions = null
    runtime.snapshot = snapshot()
    runtime.draftCallback = null
    runtime.headerCallback = null
    runtime.bridgeSubmit = null
    runtime.createJournal.mockReturnValue({ load: vi.fn(), save: vi.fn(), clear: vi.fn() })
    runtime.load.mockImplementation(async () => publish(runtime.snapshot!))
    runtime.refresh.mockResolvedValue(undefined)
    runtime.captureBase.mockImplementation(() => state())
    runtime.clearDraft.mockImplementation(async () => publish(snapshot()))
    runtime.discardRejected.mockImplementation(async () => publish(snapshot()))
    runtime.saveDraft.mockImplementation(async (id, draft) => publish(snapshot({ localDraft: { id, draft, recovered: false } })))
    runtime.retryPending.mockResolvedValue({ operation: { id: 'original-operation', outcome: 'accepted', revision: 2, structure_epoch: 0, event_seq: 2 }, state: state() })
    runtime.resubmitRejected.mockResolvedValue({ operation: { id: 'new', outcome: 'accepted', revision: 3, structure_epoch: 0, event_seq: 3 }, state: state(3) })
    runtime.history.mockResolvedValue([])
  })

  it('binds the journal to the authenticated user and selected document', async () => {
    const wrapper = mount(SpreadsheetEditor, { props: { documentId: 'doc' } })
    await flushPromises()
    expect(runtime.createJournal).toHaveBeenCalledWith({ userId: 'authenticated-user', documentId: 'doc' })
    expect(runtime.sessionOptions?.journal).toBe(runtime.createJournal.mock.results[0]?.value)
    expect(runtime.setEditable).toHaveBeenCalledWith(true)
    expect(runtime.applyState).toHaveBeenCalledWith(state())
    wrapper.unmount()
  })

  it('uses only the reserved status spinner throughout an ordinary save', async () => {
    const wrapper = mount(SpreadsheetEditor, { props: { documentId: 'doc' } })
    await flushPromises()
    const statusbar = wrapper.get('[data-testid="spreadsheet-statusbar"]').element
    const canvas = wrapper.get('[data-testid="spreadsheet-canvas"]').element
    expect(wrapper.find('[data-testid="spreadsheet-save-spinner"]').exists()).toBe(false)
    publish(snapshot({ status: 'submitting', editable: false, pending: { action: action(), draft: { text: '9' } } }))
    await flushPromises()
    expect(wrapper.get('[data-testid="spreadsheet-save-spinner"]').isVisible()).toBe(true)
    expect(wrapper.get('[role="status"]').text()).toBe('Saving…')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="spreadsheet-notice"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="spreadsheet-statusbar"]').element).toBe(statusbar)
    expect(wrapper.get('[data-testid="spreadsheet-canvas"]').element).toBe(canvas)
    publish(snapshot())
    await flushPromises()
    expect(wrapper.find('[data-testid="spreadsheet-save-spinner"]').exists()).toBe(false)
    expect(wrapper.get('[role="status"]').text()).toBe('All changes saved')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('mounts status and saved actions in the native ribbon slot without duplicating them', async () => {
    const wrapper = mount(SpreadsheetEditor, { props: { documentId: 'doc' } })
    const host = document.createElement('div')
    document.body.append(host)
    try {
      await flushPromises()
      runtime.headerCallback?.(host)
      await flushPromises()
      expect(wrapper.find('[data-testid="spreadsheet-statusbar"]').exists()).toBe(false)
      expect(host.querySelectorAll('[data-testid="spreadsheet-statusbar"]')).toHaveLength(1)
      expect(host.querySelectorAll('button')).toHaveLength(3)
      expect(host.textContent).toContain('All changes saved')
      publish(snapshot({ status: 'submitting', editable: false, pending: { action: action() } }))
      await flushPromises()
      expect(host.querySelector('[data-testid="spreadsheet-save-spinner"]')).not.toBeNull()
      runtime.headerCallback?.(null)
      await flushPromises()
      expect(wrapper.find('[data-testid="spreadsheet-statusbar"]').exists()).toBe(true)
      expect(host.querySelector('[data-testid="spreadsheet-statusbar"]')).toBeNull()
    } finally {
      wrapper.unmount()
      host.remove()
    }
  })

  it('consolidates an uncertain save into one notice and hides it while checking the receipt', async () => {
    runtime.snapshot = snapshot({ status: 'uncertain', editable: false, pending: { action: action(), draft: { text: '9' } },
      problem: new SpreadsheetProblem('network', 'Save acknowledgement was lost', 0, true) })
    const wrapper = mount(SpreadsheetEditor, { props: { documentId: 'doc' } })
    await flushPromises()
    expect(wrapper.findAll('[role="alert"]')).toHaveLength(1)
    expect(wrapper.get('[data-testid="spreadsheet-notice"]').text()).toContain('Save acknowledgement was lost')
    expect(button(wrapper, 'Check save / retry').exists()).toBe(true)
    expect(button(wrapper, 'Download draft').exists()).toBe(true)
    publish(snapshot({ status: 'submitting', editable: false, pending: runtime.snapshot!.pending }))
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="spreadsheet-save-spinner"]').isVisible()).toBe(true)
    wrapper.unmount()
  })

  it.each(['access', 'validation'] as const)('shows the actual %s failure without misreporting a conflict', async kind => {
    runtime.snapshot = snapshot({ status: kind === 'access' ? 'blocked' : 'conflict', editable: false,
      rejected: { action: action(), draft: { text: '9' } }, problem: new SpreadsheetProblem(kind, 'This action is unavailable') })
    const wrapper = mount(SpreadsheetEditor, { props: { documentId: 'doc' } })
    await flushPromises()
    expect(wrapper.findAll('[role="alert"]')).toHaveLength(1)
    expect(wrapper.get('[data-testid="spreadsheet-notice"]').text()).toContain('This action is unavailable')
    expect(wrapper.text()).not.toContain('conflicting change')
    expect(wrapper.get('details').attributes('open')).toBeUndefined()
    expect(wrapper.get('textarea').element).toHaveProperty('value', '9')
    wrapper.unmount()
  })

  it('shows an initialization failure even before the session publishes its first state', async () => {
    runtime.load.mockRejectedValueOnce(new Error('Could not initialize spreadsheet'))
    const wrapper = mount(SpreadsheetEditor, { props: { documentId: 'doc' } })
    await flushPromises()
    expect(wrapper.findAll('[role="alert"]')).toHaveLength(1)
    expect(wrapper.get('[data-testid="spreadsheet-notice"]').text()).toContain('Could not initialize spreadsheet')
    expect(wrapper.find('[data-testid="spreadsheet-save-spinner"]').exists()).toBe(false)
    expect(button(wrapper, 'Retry loading').exists()).toBe(true)
    wrapper.unmount()
  })

  it('refreshes metadata after an accepted structural state without replacing the editor', async () => {
    const wrapper = mount(SpreadsheetEditor, { props: { documentId: 'doc' } })
    await flushPromises()
    publish(snapshot({ state: { ...state(3), structure_epoch: 1 } }))
    expect(wrapper.emitted('metadataChanged')).toHaveLength(1)
    publish(snapshot({ state: { ...state(4), structure_epoch: 1 } }))
    expect(wrapper.emitted('metadataChanged')).toHaveLength(1)
    expect(runtime.bridgeDispose).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('subscribes to ordered events and recovery, then disposes every lifecycle resource', async () => {
    const addListener = vi.spyOn(window, 'addEventListener')
    const removeListener = vi.spyOn(window, 'removeEventListener')
    const wrapper = mount(SpreadsheetEditor, { props: { documentId: 'doc' } })
    await flushPromises()
    const change = { document_id: 'doc', revision: 3 }
    runtime.eventAdapter.mockReturnValue(change)
    runtime.eventCallback?.({ wire: true })
    expect(runtime.receive).toHaveBeenCalledWith(change)
    runtime.readyCallback?.()
    await flushPromises()
    expect(runtime.refresh).toHaveBeenCalledTimes(1)
    const unload = addListener.mock.calls.find(([type]) => String(type) === 'beforeunload')?.[1]
    wrapper.unmount()
    expect(runtime.unsubscribeEvents).toHaveBeenCalledTimes(1)
    expect(runtime.unsubscribeReady).toHaveBeenCalledTimes(1)
    expect(runtime.dispose).toHaveBeenCalledTimes(1)
    expect(runtime.bridgeDispose).toHaveBeenCalledTimes(1)
    expect(removeListener).toHaveBeenCalledWith('beforeunload', unload)
    const before = runtime.applyState.mock.calls.length
    publish(snapshot({ state: state(99) }))
    expect(runtime.applyState).toHaveBeenCalledTimes(before)
    addListener.mockRestore()
    removeListener.mockRestore()
  })

  it('shows a recovered rich draft, stops editing and retains it if durable discard fails', async () => {
    runtime.snapshot = snapshot({ status: 'draft', editable: false,
      localDraft: { id: 'draft', recovered: true, draft: { text: 'unfinished value', document: { body: { dataStream: 'unfinished value\r\n' } } } } })
    const wrapper = mount(SpreadsheetEditor, { props: { documentId: 'doc' } })
    await flushPromises()
    expect(wrapper.find('[data-testid="spreadsheet-recovered-draft"]').exists()).toBe(true)
    expect(wrapper.find('textarea[aria-label="Recovered spreadsheet draft"]').element).toHaveProperty('value', 'unfinished value')
    expect(runtime.setEditable).toHaveBeenLastCalledWith(false)
    runtime.clearDraft.mockRejectedValueOnce(new Error('Recovery storage unavailable'))
    await button(wrapper, 'Discard draft and continue').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Recovery storage unavailable')
    expect(wrapper.find('[data-testid="spreadsheet-recovered-draft"]').exists()).toBe(true)
    await button(wrapper, 'Discard draft and continue').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="spreadsheet-recovered-draft"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('retries a recovered unknown operation explicitly and warns on browser unload', async () => {
    runtime.snapshot = snapshot({ status: 'uncertain', editable: false, pending: { action: action(), draft: { text: 'draft' } } })
    const wrapper = mount(SpreadsheetEditor, { props: { documentId: 'doc' } })
    await flushPromises()
    expect(runtime.retryPending).not.toHaveBeenCalled()
    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)
    await button(wrapper, 'Check save / retry').trigger('click')
    await flushPromises()
    expect(runtime.retryPending).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('retains conflict text, confirms a new-ID reapplication and can undo that accepted draft', async () => {
    runtime.snapshot = snapshot({ status: 'conflict', editable: false, rejected: { action: action(), draft: { text: 'my rejected value' } } })
    runtime.resubmitRejected.mockImplementation(async (change: SpreadsheetAction) => {
      const acceptedState = state(3)
      acceptedState.workbook.sheets.sheet.cellData = { 1: { 1: { v: 9 } } }
      runtime.captureBase.mockImplementation(() => structuredClone(acceptedState))
      publish(snapshot({ state: acceptedState }))
      return { operation: { id: change.id, outcome: 'accepted', revision: 3, structure_epoch: 0, event_seq: 3 }, state: acceptedState }
    })
    runtime.submit.mockImplementation(async (change: SpreadsheetAction) => ({
      operation: { id: change.id, outcome: 'accepted', revision: 4, structure_epoch: 0, event_seq: 4 }, state: state(4),
    }))
    const wrapper = mount(SpreadsheetEditor, { props: { documentId: 'doc' } })
    await flushPromises()
    expect(wrapper.find('textarea[aria-label="Rejected spreadsheet draft"]').element).toHaveProperty('value', 'my rejected value')
    await button(wrapper, 'Apply my draft again…').trigger('click')
    expect(runtime.resubmitRejected).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('original values and formatting over the current contents')
    await button(wrapper, 'Apply draft').trigger('click')
    await flushPromises()
    const newAction = runtime.resubmitRejected.mock.calls[0]?.[0] as SpreadsheetAction
    expect(newAction.id).not.toBe('original-operation')
    expect(newAction).toMatchObject({ base_revision: 2, structure_epoch: 0, cells: action().kind === 'cells' ? (action() as Extract<SpreadsheetAction, { kind: 'cells' }>).cells : [] })
    await button(wrapper, 'Undo').trigger('click'); await flushPromises()
    expect(runtime.submit.mock.calls[0][0]).toMatchObject({ kind: 'cells', base_revision: 3,
      cells: [{ sheet_id: 'sheet', row: 1, col: 1, cell: null }] })
    wrapper.unmount()
  })

  it.each(['rich text', ''])('journals native input %j, warns before unload, and clears only active drafts after Escape', async text => {
    const wrapper = mount(SpreadsheetEditor, { props: { documentId: 'doc' } })
    await flushPromises()
    const draft = { id: 'draft-id', text, document: { body: { dataStream: `${text}\r\n` } } } as SpreadsheetEditorDraft
    runtime.draftCallback?.(draft)
    await flushPromises()
    expect(runtime.saveDraft).toHaveBeenCalledWith('draft-id', draft)
    const editingUnload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(editingUnload)
    expect(editingUnload.defaultPrevented).toBe(true)
    expect(wrapper.get('[role="status"]').text()).toContain('Editing')
    runtime.draftCallback?.(null)
    await flushPromises()
    expect(runtime.clearDraft).toHaveBeenCalledTimes(1)
    const escapedUnload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(escapedUnload)
    expect(escapedUnload.defaultPrevented).toBe(false)
    publish(snapshot({ status: 'uncertain', editable: false, pending: { action: action(), draft }, localDraft: { id: 'draft-id', draft, recovered: false } }))
    runtime.draftCallback?.(null)
    await flushPromises()
    expect(runtime.clearDraft).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it.each(['edit', 'undo'] as const)('updates saved undo/redo exactly once after a lost %s acknowledgement is checked', async lostKind => {
    let current = state(0)
    let loseNext = false
    let receipt: SpreadsheetOperationResult | null = null
    runtime.snapshot = snapshot({ state: current })
    runtime.captureBase.mockImplementation(() => structuredClone(current))
    runtime.submit.mockImplementation(async (change: SpreadsheetAction, draft: unknown) => {
      if (change.kind !== 'cells') throw new Error('Unexpected structure change')
      expect(change.base_revision).toBe(current.revision)
      current = { ...structuredClone(current), revision: current.revision + 1 }
      current.workbook.sheets.sheet.cellData = { 0: {} }
      if (change.cells[0].cell) current.workbook.sheets.sheet.cellData[0][0] = change.cells[0].cell
      const result: SpreadsheetOperationResult = { operation: { id: change.id, outcome: 'accepted', revision: current.revision,
        structure_epoch: 0, event_seq: current.revision }, state: structuredClone(current) }
      if (loseNext) {
        loseNext = false; receipt = result
        publish(snapshot({ state: current, status: 'uncertain', editable: false, pending: { action: change, draft } }))
        throw new Error('Response lost after commit')
      }
      publish(snapshot({ state: current })); return result
    })
    runtime.retryPending.mockImplementation(async () => {
      if (!receipt) throw new Error('No receipt to check')
      publish(snapshot({ state: current })); return receipt
    })
    const wrapper = mount(SpreadsheetEditor, { props: { documentId: 'doc' } })
    await flushPromises()
    const edit = (value: number) => runtime.bridgeSubmit!({ id: `edit-${value}`, base_revision: current.revision,
      structure_epoch: 0, kind: 'cells', cells: [{ sheet_id: 'sheet', row: 0, col: 0, cell: { v: value } }] }, { text: String(value) })
    await edit(1)
    if (lostKind === 'edit') { loseNext = true; await expect(edit(2)).rejects.toThrow('Response lost') }
    else { await edit(2); await flushPromises(); loseNext = true; await button(wrapper, 'Undo').trigger('click'); await flushPromises() }
    expect(button(wrapper, 'Undo').attributes('disabled')).toBeDefined()
    const sendsBeforeRetry = runtime.submit.mock.calls.length
    await button(wrapper, 'Check save / retry').trigger('click'); await flushPromises()
    expect(runtime.submit).toHaveBeenCalledTimes(sendsBeforeRetry)
    if (lostKind === 'edit') { await button(wrapper, 'Undo').trigger('click'); await flushPromises() }
    expect(current.workbook.sheets.sheet.cellData?.[0]?.[0]?.v).toBe(1)
    await button(wrapper, 'Undo').trigger('click'); await flushPromises()
    expect(current.workbook.sheets.sheet.cellData?.[0]?.[0]).toBeUndefined()
    await button(wrapper, 'Redo').trigger('click'); await flushPromises()
    expect(current.workbook.sheets.sheet.cellData?.[0]?.[0]?.v).toBe(1)
    await button(wrapper, 'Redo').trigger('click'); await flushPromises()
    expect(current.workbook.sheets.sheet.cellData?.[0]?.[0]?.v).toBe(2)
    wrapper.unmount()
  })

  it('blocks saved undo and history restore while an empty native edit is unconfirmed', async () => {
    runtime.submit.mockResolvedValue({ operation: { id: 'original-operation', outcome: 'accepted', revision: 3,
      structure_epoch: 0, event_seq: 3 }, state: state(3) })
    runtime.history.mockResolvedValue([{ id: 'version-id', kind: 'spreadsheet', created_at: '2026-10-08T00:00:00Z' }])
    const wrapper = mount(SpreadsheetEditor, { props: { documentId: 'doc' } })
    await flushPromises()
    await runtime.bridgeSubmit!(action(), { text: '9' }); await flushPromises()
    expect(button(wrapper, 'Undo').attributes('disabled')).toBeUndefined()
    runtime.draftCallback?.({ id: 'deletion-draft', text: '' } as SpreadsheetEditorDraft)
    await flushPromises()
    expect(button(wrapper, 'Undo').attributes('disabled')).toBeDefined()
    await button(wrapper, 'Undo').trigger('click'); await flushPromises()
    expect(runtime.submit).toHaveBeenCalledTimes(1)
    await button(wrapper, 'History').trigger('click'); await flushPromises()
    expect(button(wrapper, 'Restore this version').attributes('disabled')).toBeDefined()
    runtime.draftCallback?.(null); await flushPromises()
    expect(button(wrapper, 'Undo').attributes('disabled')).toBeUndefined()
    expect(button(wrapper, 'Restore this version').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('undoes and redoes repeated saved edits while advancing only its own consecutive commits', async () => {
    let current = state(0)
    let lastWrite = 0
    runtime.snapshot = snapshot({ state: current })
    runtime.captureBase.mockImplementation(() => structuredClone(current))
    runtime.submit.mockImplementation(async (change: SpreadsheetAction) => {
      expect(change.kind).toBe('cells')
      if (change.kind !== 'cells') throw new Error('unexpected structure action')
      const conflict = lastWrite > change.base_revision
      if (!conflict) {
        current = { ...structuredClone(current), revision: current.revision + 1 }
        current.workbook.sheets.sheet.cellData = { 0: {} }
        if (change.cells[0].cell) current.workbook.sheets.sheet.cellData[0][0] = change.cells[0].cell
        lastWrite = current.revision
      }
      const result = { operation: { id: change.id, outcome: conflict ? 'conflict' as const : 'accepted' as const,
        revision: current.revision, structure_epoch: 0, event_seq: current.revision }, state: structuredClone(current) }
      publish(snapshot({ state: current }))
      return result
    })
    const wrapper = mount(SpreadsheetEditor, { props: { documentId: 'doc' } })
    await flushPromises()
    for (const value of [1, 2]) await runtime.bridgeSubmit!({ id: `edit-${value}`, base_revision: current.revision, structure_epoch: 0,
      kind: 'cells', cells: [{ sheet_id: 'sheet', row: 0, col: 0, cell: { v: value } }] }, {})
    await button(wrapper, 'Undo').trigger('click'); await flushPromises()
    expect(current.workbook.sheets.sheet.cellData?.[0]?.[0]?.v).toBe(1)
    await button(wrapper, 'Undo').trigger('click'); await flushPromises()
    expect(current.workbook.sheets.sheet.cellData?.[0]?.[0]).toBeUndefined()
    await button(wrapper, 'Redo').trigger('click'); await flushPromises()
    expect(current.workbook.sheets.sheet.cellData?.[0]?.[0]?.v).toBe(1)
    await button(wrapper, 'Redo').trigger('click'); await flushPromises()
    expect(current.workbook.sheets.sheet.cellData?.[0]?.[0]?.v).toBe(2)
    expect(runtime.submit.mock.calls.map(([change]) => change.base_revision)).toEqual([0, 1, 2, 3, 4, 5])
    wrapper.unmount()
  })

  it('never advances an old undo across an unknown ABA revision gap, even after a later own undo', async () => {
    let current = state(0)
    const versions = new Map<number, number>()
    runtime.snapshot = snapshot({ state: current })
    runtime.captureBase.mockImplementation(() => structuredClone(current))
    runtime.submit.mockImplementation(async (change: SpreadsheetAction) => {
      if (change.kind !== 'cells') throw new Error('unexpected structure action')
      const conflict = change.cells.some(cell => (versions.get(cell.col) ?? 0) > change.base_revision)
      if (!conflict) {
        current = { ...structuredClone(current), revision: current.revision + 1 }
        current.workbook.sheets.sheet.cellData ??= {}
        current.workbook.sheets.sheet.cellData[0] ??= {}
        for (const cell of change.cells) {
          if (cell.cell) current.workbook.sheets.sheet.cellData[0][cell.col] = cell.cell
          else delete current.workbook.sheets.sheet.cellData[0][cell.col]
          versions.set(cell.col, current.revision)
        }
      }
      const result = { operation: { id: change.id, outcome: conflict ? 'conflict' as const : 'accepted' as const,
        revision: current.revision, structure_epoch: 0, event_seq: current.revision }, state: structuredClone(current) }
      publish(snapshot({ state: current, status: conflict ? 'conflict' : 'ready', editable: !conflict }))
      return result
    })
    const wrapper = mount(SpreadsheetEditor, { props: { documentId: 'doc' } })
    await flushPromises()
    await runtime.bridgeSubmit!({ id: 'original', base_revision: 0, structure_epoch: 0, kind: 'cells',
      cells: [{ sheet_id: 'sheet', row: 0, col: 0, cell: { v: 10 } }] }, {})
    // Another actor changes and restores the value; equality does not make
    // the original precondition eligible again.
    current = { ...structuredClone(current), revision: 3 }; versions.set(0, 3)
    publish(snapshot({ state: current }))
    await runtime.bridgeSubmit!({ id: 'later-own', base_revision: 3, structure_epoch: 0, kind: 'cells',
      cells: [{ sheet_id: 'sheet', row: 0, col: 1, cell: { v: 20 } }] }, {})
    await button(wrapper, 'Undo').trigger('click'); await flushPromises()
    expect(current.revision).toBe(5)
    await button(wrapper, 'Undo').trigger('click'); await flushPromises()
    expect(runtime.submit.mock.calls[runtime.submit.mock.calls.length - 1]?.[0].base_revision).toBe(1)
    expect(runtime.snapshot?.status).toBe('conflict')
    expect(current.workbook.sheets.sheet.cellData?.[0]?.[0]?.v).toBe(10)
    expect(current.revision).toBe(5)
    wrapper.unmount()
  })
})
