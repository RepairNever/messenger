<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, shallowRef, ref } from 'vue'
import { useChatStore } from '@/stores/chat'
import { useAuthStore } from '@/stores/auth'
import { documentsListDocumentHistory, type DocumentHistoryItem } from '@/services/http/documentsApi'
import { spreadsheetApi, spreadsheetEventFromServerEvent } from '@/services/spreadsheets/api'
import { createSpreadsheetSession, type SpreadsheetSessionSnapshot } from '@/services/spreadsheets/session'
import { SpreadsheetEditorBridge, type SpreadsheetEditorDraft } from '@/services/spreadsheets/editor'
import { inverseCells } from '@/services/spreadsheets/actions'
import type { SpreadsheetAction, SpreadsheetOperationResult, SpreadsheetState } from '@/services/spreadsheets/types'
import { createIndexedDbSpreadsheetJournal } from '@/services/spreadsheets/journal'

const props = defineProps<{ documentId: string }>()
const emit = defineEmits<{ metadataChanged: [] }>()
const chat = useChatStore()
const auth = useAuthStore()
const container = ref<HTMLElement | null>(null)
const headerMount = shallowRef<HTMLElement | null>(null)
const snapshot = shallowRef<SpreadsheetSessionSnapshot | null>(null)
const activeDraft = shallowRef<SpreadsheetEditorDraft | null>(null)
const localError = ref('')
const historyOpen = ref(false)
const historyLoading = ref(false)
const historyError = ref('')
const history = shallowRef<(DocumentHistoryItem & { id: string })[]>([])
const restoreChoice = ref<string | null>(null)
const reapplyChoice = ref(false)
let alive = true
let bridge: SpreadsheetEditorBridge | null = null
let unsubscribeEvents: (() => void) | null = null
let unsubscribeReady: (() => void) | null = null
let historyGeneration = 0

interface UndoEntry { inverse: SpreadsheetAction; bytes: number; continuous: boolean }
const undo = shallowRef<UndoEntry[]>([])
const redo = shallowRef<UndoEntry[]>([])
let historyRevision: number | null = null
type SavedWriteContext = { kind: 'restore'; id: string; before: SpreadsheetState }
  | { kind: 'edit' | 'undo' | 'redo'; action: SpreadsheetAction; before: SpreadsheetState }
let savedWriteContext: SavedWriteContext | null = null

function undoEntry(action: SpreadsheetAction, before: SpreadsheetState, result: SpreadsheetOperationResult): UndoEntry {
  const common = { id: '', base_revision: result.operation.revision, structure_epoch: result.operation.structure_epoch }
  const inverse: SpreadsheetAction = action.kind === 'cells'
    ? { ...common, kind: 'cells', cells: inverseCells(action, before.workbook)! }
    : { ...common, kind: 'structure', workbook: structuredClone(before.workbook) }
  return { inverse, bytes: JSON.stringify(inverse).length * 2,
    continuous: result.operation.revision === before.revision + 1 && result.state.revision === result.operation.revision }
}

function advanceHistory(before: SpreadsheetState, result: SpreadsheetOperationResult) {
  const consecutive = historyRevision === before.revision && result.operation.revision === before.revision + 1
    && result.state.revision === result.operation.revision
  const advance = (entry: UndoEntry): UndoEntry => {
    if (!consecutive || !entry.continuous) return { ...entry, continuous: false }
    return { ...entry, inverse: { ...entry.inverse, base_revision: result.operation.revision,
      structure_epoch: result.operation.structure_epoch } }
  }
  // Advancing through unknown revisions could conceal an intervening write
  // (including an ABA edit). Only a consecutive chain of our own committed
  // actions can advance older undo/redo preconditions.
  undo.value = undo.value.map(advance); redo.value = redo.value.map(advance)
  historyRevision = result.operation.revision
}

function boundedUndo(entries: UndoEntry[]): UndoEntry[] {
  const kept: UndoEntry[] = []
  let bytes = 0
  for (let index = entries.length - 1; index >= 0 && kept.length < 50; index--) {
    if (bytes + entries[index].bytes > 8 * 1024 * 1024) break
    bytes += entries[index].bytes; kept.unshift(entries[index])
  }
  return kept
}

function settleSavedWrite(result: SpreadsheetOperationResult) {
  const context = savedWriteContext
  savedWriteContext = null
  if (result.operation.outcome !== 'accepted') return
  if (!context || (context.kind === 'restore' ? context.id : context.action.id) !== result.operation.id
    || context.kind === 'restore') {
    // Recovered receipts have no trustworthy pre-edit snapshot in this mount.
    // Never expose an older entry as the last saved change after that receipt.
    undo.value = []; redo.value = []; historyRevision = result.operation.revision
    return
  }
  advanceHistory(context.before, result)
  const reversed = undoEntry(context.action, context.before, result)
  if (context.kind === 'undo') {
    undo.value = undo.value.slice(0, -1); redo.value = boundedUndo([...redo.value, reversed])
  } else if (context.kind === 'redo') {
    redo.value = redo.value.slice(0, -1); undo.value = boundedUndo([...undo.value, reversed])
  } else {
    undo.value = boundedUndo([...undo.value, reversed]); redo.value = []
  }
}

async function savedWrite(context: SavedWriteContext, send: () => Promise<SpreadsheetOperationResult>) {
  savedWriteContext = context
  try {
    const result = await send()
    if (alive) settleSavedWrite(result)
    return result
  } catch (error) {
    const id = context.kind === 'restore' ? context.id : context.action.id
    // Keep the inverse until an uncertain original operation is checked. The
    // same receipt must move the saved undo stack exactly once after retry.
    if (savedWriteContext === context && session.getSnapshot().pending?.action.id !== id) savedWriteContext = null
    throw error
  }
}
const busy = computed(() => !snapshot.value?.editable || activeDraft.value !== null)
const inProgress = computed(() => snapshot.value?.status === 'submitting'
  || (!localError.value && (!snapshot.value || ['idle', 'loading'].includes(snapshot.value.status))))
const pendingAttention = computed(() => !!snapshot.value?.pending && snapshot.value.status !== 'submitting')
const recoveredDraft = computed(() => !!snapshot.value?.localDraft?.recovered && !snapshot.value.pending && !snapshot.value.rejected)
const showNotice = computed(() => !inProgress.value && !!(pendingAttention.value || snapshot.value?.rejected
  || recoveredDraft.value || localError.value || snapshot.value?.problem))
const noticeTitle = computed(() => {
  if (snapshot.value?.status === 'blocked') return 'Editing stopped'
  if (pendingAttention.value) return 'Save not confirmed'
  if (snapshot.value?.rejected) return 'Change not saved'
  if (recoveredDraft.value) return 'Recovered draft'
  return 'Spreadsheet needs attention'
})
const noticeMessage = computed(() => {
  if (localError.value) return localError.value
  if (snapshot.value?.problem) return snapshot.value.problem.message
  if (pendingAttention.value) return 'The save could not be confirmed. Your draft is retained.'
  if (snapshot.value?.rejected) return snapshot.value.rejected.result?.operation.outcome === 'conflict'
    ? 'A newer conflicting change was saved first. Your draft is retained.'
    : 'Your change could not be saved. Your draft is retained.'
  if (recoveredDraft.value) return 'An unsaved draft was recovered. Review or download it before continuing.'
  return ''
})
const statusText = computed(() => {
  if (activeDraft.value && snapshot.value?.status === 'ready') return 'Editing — confirm the cell to save'
  switch (snapshot.value?.status) {
    case 'ready': return 'All changes saved'
    case 'submitting': return 'Saving…'
    case 'uncertain': return 'Save response lost — your change is retained'
    case 'conflict': return 'Change rejected — your draft is retained'
    case 'blocked': return 'Editing stopped: access is no longer available'
    case 'draft': return 'Unsaved draft recovered'
    case 'error': return 'Could not synchronize'
    default: return 'Loading spreadsheet…'
  }
})
const rejectedText = computed(() => {
  const draft = snapshot.value?.rejected?.draft as SpreadsheetEditorDraft | undefined
  return draft?.text ?? ''
})
const recoveredText = computed(() => (snapshot.value?.localDraft?.draft as SpreadsheetEditorDraft | undefined)?.text ?? '')

const session = createSpreadsheetSession({ documentId: props.documentId, transport: spreadsheetApi,
  journal: auth.user?.id ? createIndexedDbSpreadsheetJournal({ userId: auth.user.id, documentId: props.documentId }) : undefined,
  onChange: value => {
    if (!alive) return
    const previousEpoch = snapshot.value?.state?.structure_epoch
    snapshot.value = value
    bridge?.setEditable(value.editable)
    if (value.state) bridge?.applyState(value.state)
    if (previousEpoch !== undefined && value.state && previousEpoch !== value.state.structure_epoch) emit('metadataChanged')
  },
})

async function submit(action: SpreadsheetAction, draft: unknown): Promise<SpreadsheetOperationResult> {
  const before = session.captureBase()
  const result = await savedWrite({ kind: 'edit', action, before }, () => session.submit(action, draft))
  if (!alive) return result
  if (result.operation.outcome === 'accepted') {
    activeDraft.value = null
    localError.value = ''
  }
  return result
}

async function undoOrRedo(direction: 'undo' | 'redo') {
  if (busy.value) return
  const stack = direction === 'undo' ? undo.value : redo.value
  const entry = stack[stack.length - 1]
  if (!entry) return
  const action: SpreadsheetAction = { ...structuredClone(entry.inverse), id: crypto.randomUUID() }
  try {
    const current = session.captureBase()
    const result = await savedWrite({ kind: direction, action, before: current }, () => session.submit(action, { kind: direction, action }))
    if (!alive || result.operation.outcome !== 'accepted') return
  } catch (error) { if (alive) localError.value = error instanceof Error ? error.message : 'Could not save this action.' }
}

async function retryPending() {
  try {
    const result = await session.retryPending()
    if (alive) settleSavedWrite(result)
    if (alive && result.operation.outcome === 'accepted') { activeDraft.value = null; localError.value = '' }
  } catch (error) { if (alive) localError.value = error instanceof Error ? error.message : 'Retry failed.' }
}

const canReapply = computed(() => {
  const rejected = snapshot.value?.rejected
  return rejected && 'kind' in rejected.action && rejected.action.kind === 'cells'
    && rejected.action.structure_epoch === snapshot.value?.state?.structure_epoch
})

async function reapplyRejected() {
  const rejected = snapshot.value?.rejected
  if (!rejected || !canReapply.value || !('kind' in rejected.action) || rejected.action.kind !== 'cells') return
  const base = session.captureBase()
  const action: SpreadsheetAction = { ...structuredClone(rejected.action), id: crypto.randomUUID(),
    base_revision: base.revision, structure_epoch: base.structure_epoch }
  reapplyChoice.value = false
  try {
    const result = await savedWrite({ kind: 'edit', action, before: base }, () => session.resubmitRejected(action, rejected.draft))
    if (alive && result.operation.outcome === 'accepted') { activeDraft.value = null; localError.value = '' }
  } catch (error) { if (alive) localError.value = error instanceof Error ? error.message : 'Could not save the draft.' }
}

function exportDraft() {
  const data = snapshot.value?.rejected ?? snapshot.value?.pending ?? snapshot.value?.localDraft ?? activeDraft.value
  if (!data) return
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = `spreadsheet-draft-${props.documentId}.json`; anchor.click()
  URL.revokeObjectURL(url)
}

async function refresh() {
  localError.value = ''
  try { await session.refresh() }
  catch (error) { if (alive) localError.value = error instanceof Error ? error.message : 'Refresh failed.' }
}

async function discardDraft(kind: 'rejected' | 'local') {
  try {
    if (kind === 'rejected') await session.discardRejected()
    else await session.clearDraft()
    if (alive) { activeDraft.value = null; localError.value = ''; reapplyChoice.value = false }
  } catch (error) { if (alive) localError.value = error instanceof Error ? error.message : 'Could not clear the draft.' }
}

async function openHistory() {
  historyOpen.value = true
  historyLoading.value = true
  historyError.value = ''
  const generation = ++historyGeneration
  try {
    const entries = await documentsListDocumentHistory(props.documentId)
    if (alive && generation === historyGeneration) history.value = entries.filter((entry): entry is DocumentHistoryItem & { id: string } => typeof entry.id === 'string' && entry.kind === 'spreadsheet')
  } catch (error) {
    if (alive && generation === historyGeneration) historyError.value = error instanceof Error ? error.message : 'Could not load history.'
  } finally { if (alive && generation === historyGeneration) historyLoading.value = false }
}

async function restoreHistory() {
  if (!restoreChoice.value || busy.value) return
  const historyId = restoreChoice.value
  restoreChoice.value = null
  try {
    const base = session.captureBase()
    const action = { id: crypto.randomUUID(), base_revision: base.revision, structure_epoch: base.structure_epoch }
    const result = await savedWrite({ kind: 'restore', id: action.id, before: base }, () => session.restoreHistory(historyId, action, { kind: 'history_restore', historyId }))
    if (alive && result.operation.outcome === 'accepted') {
      historyOpen.value = false
      await openHistory()
    }
  } catch (error) { if (alive) historyError.value = error instanceof Error ? error.message : 'Restore failed.' }
}

function preventUnload(event: BeforeUnloadEvent) {
  if (snapshot.value?.pending || activeDraft.value) { event.preventDefault(); event.returnValue = '' }
}

onMounted(async () => {
  if (!container.value) return
  try {
    bridge = new SpreadsheetEditorBridge({ container: container.value, submit,
      onHeaderMount: element => { if (alive) headerMount.value = element },
      onDraft: draft => {
        if (!alive) return
        activeDraft.value = draft
        try {
          const current = session.getSnapshot()
          if (draft) void session.saveDraft(draft.id, draft).catch(error => { if (alive) localError.value = error.message })
          else if (current.localDraft && !current.pending && !current.rejected) {
            void session.clearDraft().catch(error => { if (alive) localError.value = error.message })
          }
        } catch (error) { localError.value = error instanceof Error ? error.message : 'Could not retain the draft.' }
      },
      onError: error => { if (alive) localError.value = error.message },
      onUndo: () => { void undoOrRedo('undo') }, onRedo: () => { void undoOrRedo('redo') },
    })
    unsubscribeEvents = chat.subscribeAppliedServerEvents(event => {
      const change = spreadsheetEventFromServerEvent(event)
      if (change) session.receive(change)
    })
    unsubscribeReady = chat.subscribeRealtimeReady(() => { void refresh() })
    window.addEventListener('beforeunload', preventUnload)
    await session.load()
  } catch (error) { if (alive) localError.value = error instanceof Error ? error.message : 'Could not initialize spreadsheet.' }
})

onBeforeUnmount(() => {
  alive = false
  historyGeneration++
  unsubscribeEvents?.(); unsubscribeReady?.()
  window.removeEventListener('beforeunload', preventUnload)
  session.dispose(); bridge?.dispose(); bridge = null
})
</script>

<template>
  <section class="spreadsheet-editor flex min-h-0 flex-1 flex-col spreadsheet-surface" data-testid="spreadsheet-editor">
    <Teleport :to="headerMount || 'body'" :disabled="!headerMount">
    <div class="spreadsheet-statusbar flex min-w-0 items-center gap-3 border-b spreadsheet-border px-3 univer-text-sm" data-testid="spreadsheet-statusbar">
      <span role="status" aria-live="polite" aria-atomic="true" :title="statusText" class="flex min-w-0 flex-1 items-center gap-2 spreadsheet-muted">
        <span class="spreadsheet-status-indicator" aria-hidden="true"><span v-if="inProgress" class="spreadsheet-spinner" data-testid="spreadsheet-save-spinner" /></span>
        <span class="spreadsheet-status-copy truncate">{{ statusText }}</span>
      </span>
      <div class="flex shrink-0 items-center gap-3">
        <button type="button" class="spreadsheet-action disabled:opacity-40" :disabled="busy || !undo.length" aria-label="Undo last saved change" @click="undoOrRedo('undo')">Undo</button>
        <button type="button" class="spreadsheet-action disabled:opacity-40" :disabled="busy || !redo.length" aria-label="Redo last undone change" @click="undoOrRedo('redo')">Redo</button>
        <button type="button" class="spreadsheet-action" data-testid="spreadsheet-history" @click="openHistory">History</button>
      </div>
    </div>
    </Teleport>
    <div v-if="showNotice" class="spreadsheet-notification spreadsheet-scrollbar rounded border spreadsheet-border spreadsheet-surface p-3 univer-text-sm" role="alert" data-testid="spreadsheet-notice">
      <p class="font-semibold">{{ noticeTitle }}</p>
      <p class="mt-1 spreadsheet-muted">{{ noticeMessage }}</p>
      <div v-if="pendingAttention" class="mt-2 flex flex-wrap gap-x-4 gap-y-2">
        <button type="button" class="spreadsheet-action" @click="retryPending">Check save / retry</button>
        <button type="button" class="spreadsheet-action" @click="exportDraft">Download draft</button>
      </div>
      <div v-else-if="snapshot?.rejected" data-testid="spreadsheet-conflict">
        <details v-if="rejectedText" class="mt-2">
          <summary class="cursor-pointer spreadsheet-action">View draft</summary>
          <textarea :value="rejectedText" readonly aria-label="Rejected spreadsheet draft" class="spreadsheet-scrollbar mt-2 w-full rounded border spreadsheet-border spreadsheet-surface p-2 univer-font-mono" rows="2" />
        </details>
        <div class="mt-2 flex flex-wrap gap-x-4 gap-y-2">
          <button type="button" class="spreadsheet-action" @click="exportDraft">Download draft</button>
          <button v-if="canReapply" type="button" class="spreadsheet-action" @click="reapplyChoice = true">Apply my draft again…</button>
          <button type="button" class="spreadsheet-action" @click="discardDraft('rejected')">Discard draft and continue</button>
        </div>
        <div v-if="reapplyChoice" class="mt-3 rounded border spreadsheet-border p-3">
          <p>This saves your original values and formatting over the current contents of the affected cells. Another concurrent change can still reject it.</p>
          <button type="button" class="mr-4 mt-2 spreadsheet-action" @click="reapplyRejected">Apply draft</button>
          <button type="button" @click="reapplyChoice = false">Cancel</button>
        </div>
      </div>
      <div v-else-if="recoveredDraft" data-testid="spreadsheet-recovered-draft">
        <details v-if="recoveredText" class="mt-2">
          <summary class="cursor-pointer spreadsheet-action">View draft</summary>
          <textarea :value="recoveredText" readonly aria-label="Recovered spreadsheet draft" class="spreadsheet-scrollbar mt-2 w-full rounded border spreadsheet-border spreadsheet-surface p-2 univer-font-mono" rows="2" />
        </details>
        <div class="mt-2 flex flex-wrap gap-x-4 gap-y-2">
          <button type="button" class="spreadsheet-action" @click="exportDraft">Download draft</button>
          <button type="button" class="spreadsheet-action" @click="discardDraft('local')">Discard draft and continue</button>
        </div>
      </div>
      <div v-else class="mt-2 flex flex-wrap gap-x-4 gap-y-2">
        <button type="button" class="spreadsheet-action" @click="refresh">Retry loading</button>
        <button v-if="activeDraft" type="button" class="spreadsheet-action" @click="exportDraft">Download draft</button>
      </div>
    </div>
    <div ref="container" class="min-h-0 flex-1" data-testid="spreadsheet-canvas" />
    <div v-if="historyOpen" class="spreadsheet-scrollbar absolute inset-y-0 right-0 z-20 w-80 overflow-auto border-l spreadsheet-border spreadsheet-surface p-4 shadow-xl" role="dialog" aria-label="Spreadsheet history">
      <div class="mb-4 flex items-center justify-between"><h3 class="font-semibold">Workbook history</h3><button type="button" aria-label="Close history" @click="historyOpen = false; restoreChoice = null">✕</button></div>
      <p v-if="historyLoading" role="status">Loading history…</p>
      <p v-if="historyError" role="alert">{{ historyError }}</p>
      <p v-if="!historyLoading && !history.length" class="spreadsheet-muted">No saved versions yet.</p>
      <div v-for="entry in history" :key="entry.id" class="mb-3 border-b spreadsheet-border pb-3 univer-text-sm">
        <p>{{ new Date(entry.created_at).toLocaleString() }}</p><p class="spreadsheet-muted">{{ entry.editor?.display_name }}</p>
        <button type="button" class="mt-1 spreadsheet-action disabled:opacity-40" :disabled="busy" @click="restoreChoice = entry.id">Restore this version</button>
      </div>
      <div v-if="restoreChoice" class="mt-4 rounded border spreadsheet-border p-3" role="alert">
        <p>Restore replaces the whole workbook and its title. It creates a new version and rejects prepared changes from the previous structure.</p>
        <button type="button" class="mr-3 mt-3 spreadsheet-action" :disabled="busy" @click="restoreHistory">Restore workbook</button>
        <button type="button" @click="restoreChoice = null">Cancel</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.spreadsheet-editor { position: relative; min-height: 0; container-type: inline-size; }
.spreadsheet-statusbar { height: 40px; flex-shrink: 0; }
@container (max-width: 640px) {
  .spreadsheet-status-copy {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
}
.spreadsheet-status-indicator { display: inline-flex; width: 16px; height: 16px; flex-shrink: 0; }
.spreadsheet-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--univer-gray-200, #e3e5ea);
  border-top-color: var(--univer-primary-500, #466af7);
  border-radius: 50%;
  animation: spreadsheet-spin 0.8s linear infinite;
}
.spreadsheet-notification {
  position: absolute;
  top: 48px;
  right: 12px;
  z-index: 10;
  width: min(440px, calc(100% - 24px));
  max-height: calc(100% - 60px);
  overflow: auto;
  overflow-wrap: anywhere;
  box-shadow: 0 4px 12px rgb(27 28 31 / 10%);
}
@keyframes spreadsheet-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spreadsheet-spinner { animation: none; } }
</style>
