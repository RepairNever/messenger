import { Schema } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { describe, expect, it } from 'vitest'
import {
  addPendingPasteCandidateToTransaction,
  createPendingPasteCandidatesPlugin,
  findPendingPasteCandidate,
  removePendingPasteCandidateFromTransaction,
} from '@/editor/pendingPasteCandidates'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
  },
})

function stateWithText(text: string): EditorState {
  return EditorState.create({
    schema,
    doc: schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, text ? schema.text(text) : null),
    ]),
    plugins: [createPendingPasteCandidatesPlugin()],
  })
}

function applyCandidate(
  state: EditorState,
  id: string,
  from: number,
  to: number,
): EditorState {
  const transaction = state.tr
  expect(addPendingPasteCandidateToTransaction(transaction, { id, from, to })).toBe(true)
  return state.apply(transaction)
}

describe('pending paste candidates', () => {
  it('keeps candidate ranges out of the document while making them findable by id', () => {
    const url = 'https://chat.example.test/tasks/abc-123'
    const state = applyCandidate(stateWithText(url), 'paste-1', 1, url.length + 1)

    expect(state.doc.textContent).toBe(url)
    expect(findPendingPasteCandidate(state, 'paste-1')).toEqual({
      id: 'paste-1',
      from: 1,
      to: url.length + 1,
    })
  })

  it('maps a tracked range through later document transactions', () => {
    const url = 'https://chat.example.test/tasks/abc-123'
    let state = applyCandidate(stateWithText(url), 'paste-1', 1, url.length + 1)

    state = state.apply(state.tr.insertText('before ', 1))

    expect(findPendingPasteCandidate(state, 'paste-1')).toEqual({
      id: 'paste-1',
      from: 8,
      to: url.length + 8,
    })
  })

  it('keeps multiple candidates independent and removes only the requested id', () => {
    const first = 'https://chat.example.test/tasks/one'
    const second = 'https://chat.example.test/tasks/two'
    const text = `${first} ${second}`
    let state = stateWithText(text)
    const transaction = state.tr
    expect(addPendingPasteCandidateToTransaction(transaction, {
      id: 'first',
      from: 1,
      to: first.length + 1,
    })).toBe(true)
    expect(addPendingPasteCandidateToTransaction(transaction, {
      id: 'second',
      from: first.length + 2,
      to: text.length + 1,
    })).toBe(true)
    state = state.apply(transaction)

    const removeTransaction = state.tr
    expect(removePendingPasteCandidateFromTransaction(removeTransaction, 'first')).toBe(true)
    state = state.apply(removeTransaction)

    expect(findPendingPasteCandidate(state, 'first')).toBeNull()
    expect(findPendingPasteCandidate(state, 'second')).toEqual({
      id: 'second',
      from: first.length + 2,
      to: text.length + 1,
    })
    expect(state.doc.textContent).toBe(text)
  })

  it('does not register invalid ranges', () => {
    const state = stateWithText('text')
    const transaction = state.tr

    expect(addPendingPasteCandidateToTransaction(transaction, {
      id: 'bad',
      from: 4,
      to: 4,
    })).toBe(false)
    expect(findPendingPasteCandidate(state.apply(transaction), 'bad')).toBeNull()
  })
})
