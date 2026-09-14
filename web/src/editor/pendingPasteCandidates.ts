import { Extension } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'

/**
 * A transient range for content that was inserted before an asynchronous paste
 * lookup completes. The range lives only in plugin state; it is never added to
 * the ProseMirror document or serialized with a message.
 */
export interface PendingPasteCandidate {
  id: string
  from: number
  to: number
}

type PendingPasteCandidateOperation =
  | { type: 'add'; candidate: PendingPasteCandidate }
  | { type: 'remove'; id: string }
  | { type: 'clear' }

const PENDING_PASTE_CANDIDATE_ID = 'pendingPasteCandidateId'

export const pendingPasteCandidatesPluginKey = new PluginKey<DecorationSet>('pendingPasteCandidates')

function candidateDecorationsById(decorations: DecorationSet, id: string): Decoration[] {
  return decorations.find(undefined, undefined, spec => spec?.[PENDING_PASTE_CANDIDATE_ID] === id)
}

function removeCandidateDecorations(decorations: DecorationSet, id: string): DecorationSet {
  const matches = candidateDecorationsById(decorations, id)
  return matches.length > 0 ? decorations.remove(matches) : decorations
}

function isTrackableCandidate(doc: ProseMirrorNode, candidate: PendingPasteCandidate): boolean {
  if (!candidate.id || !Number.isInteger(candidate.from) || !Number.isInteger(candidate.to)) {
    return false
  }
  if (candidate.from < 0 || candidate.from >= candidate.to || candidate.to > doc.content.size) {
    return false
  }

  try {
    doc.resolve(candidate.from)
    doc.resolve(candidate.to)
    return true
  } catch {
    return false
  }
}

function pendingPasteCandidateOperations(transaction: Transaction): PendingPasteCandidateOperation[] {
  const meta = transaction.getMeta(pendingPasteCandidatesPluginKey) as
    | PendingPasteCandidateOperation
    | PendingPasteCandidateOperation[]
    | undefined
  if (!meta) return []
  return Array.isArray(meta) ? meta : [meta]
}

function appendPendingPasteCandidateOperation(
  transaction: Transaction,
  operation: PendingPasteCandidateOperation,
): void {
  transaction.setMeta(pendingPasteCandidatesPluginKey, [
    ...pendingPasteCandidateOperations(transaction),
    operation,
  ])
}

/**
 * Creates the plugin used by {@link PendingPasteCandidatesExtension}. Exported
 * separately so non-Tiptap editor states can use the same tracker in tests.
 */
export function createPendingPasteCandidatesPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: pendingPasteCandidatesPluginKey,
    state: {
      init: () => DecorationSet.empty,
      apply(transaction, decorations) {
        let next = decorations.map(transaction.mapping, transaction.doc)

        for (const operation of pendingPasteCandidateOperations(transaction)) {
          if (operation.type === 'clear') {
            next = DecorationSet.empty
            continue
          }

          if (operation.type === 'remove') {
            next = removeCandidateDecorations(next, operation.id)
            continue
          }

          next = removeCandidateDecorations(next, operation.candidate.id)
          if (!isTrackableCandidate(transaction.doc, operation.candidate)) continue

          next = next.add(transaction.doc, [
            Decoration.inline(
              operation.candidate.from,
              operation.candidate.to,
              {},
              {
                [PENDING_PASTE_CANDIDATE_ID]: operation.candidate.id,
                // Text typed immediately before or after a pasted URL must not
                // become part of its tracked range.
                inclusiveStart: false,
                inclusiveEnd: false,
              },
            ),
          ])
        }

        return next
      },
    },
    props: {
      decorations(state) {
        return pendingPasteCandidatesPluginKey.getState(state)
      },
    },
  })
}

/**
 * Adds a candidate to an already-built transaction. Use this when inserting
 * pasted text so the insertion and its temporary tracking range are applied in
 * the same editor dispatch.
 */
export function addPendingPasteCandidateToTransaction(
  transaction: Transaction,
  candidate: PendingPasteCandidate,
): boolean {
  if (!isTrackableCandidate(transaction.doc, candidate)) return false

  appendPendingPasteCandidateOperation(transaction, {
    type: 'add',
    candidate: { ...candidate },
  })
  return true
}

/**
 * Registers a candidate in the current editor state. Prefer
 * {@link addPendingPasteCandidateToTransaction} when the caller is already
 * dispatching the paste insertion transaction.
 */
export function registerPendingPasteCandidate(
  view: EditorView,
  candidate: PendingPasteCandidate,
): boolean {
  const transaction = view.state.tr
  if (!addPendingPasteCandidateToTransaction(transaction, candidate)) return false
  view.dispatch(transaction)
  return true
}

/** Returns the mapped document range for a candidate, if it still exists. */
export function findPendingPasteCandidate(
  state: EditorState,
  id: string,
): PendingPasteCandidate | null {
  const decorations = pendingPasteCandidatesPluginKey.getState(state)
  if (!decorations) return null

  const decoration = candidateDecorationsById(decorations, id)[0]
  return decoration
    ? { id, from: decoration.from, to: decoration.to }
    : null
}

/** Removes one candidate without changing the message document. */
export function removePendingPasteCandidateFromTransaction(
  transaction: Transaction,
  id: string,
): boolean {
  if (!id) return false
  appendPendingPasteCandidateOperation(transaction, { type: 'remove', id })
  return true
}

/** Removes one candidate without changing the message document. */
export function removePendingPasteCandidate(view: EditorView, id: string): boolean {
  const transaction = view.state.tr
  if (!removePendingPasteCandidateFromTransaction(transaction, id)) return false
  view.dispatch(transaction)
  return true
}

/** Removes every transient candidate without changing the message document. */
export function clearPendingPasteCandidates(view: EditorView): void {
  const transaction = view.state.tr
  appendPendingPasteCandidateOperation(transaction, { type: 'clear' })
  view.dispatch(transaction)
}

export const PendingPasteCandidatesExtension = Extension.create({
  name: 'pendingPasteCandidates',

  addProseMirrorPlugins() {
    return [createPendingPasteCandidatesPlugin()]
  },
})
