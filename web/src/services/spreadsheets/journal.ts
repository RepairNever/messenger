import Dexie, { type Table } from 'dexie'
import type { SpreadsheetPendingAction } from './session'
import { SpreadsheetProblem, type SpreadsheetOperationResult, type SpreadsheetProblemKind } from './types'

export interface SpreadsheetOperationJournalRecord {
  version: 1
  phase: 'pending' | 'rejected'
  request: SpreadsheetPendingAction
  result?: SpreadsheetOperationResult
  problem?: { kind: SpreadsheetProblemKind; message: string; status: number; uncertain: boolean }
}

export interface SpreadsheetDraftJournalRecord {
  version: 1
  phase: 'draft'
  draftId: string
  draft: unknown
}

export type SpreadsheetJournalRecord = SpreadsheetOperationJournalRecord | SpreadsheetDraftJournalRecord

export interface SpreadsheetSessionJournal {
  load(): Promise<SpreadsheetJournalRecord | null>
  save(record: SpreadsheetJournalRecord, replaceOperationId?: string): Promise<void>
  /** Delete only the specified operation, never another tab's newer draft. */
  clear(operationId: string): Promise<void>
  close?(): void
}

interface StoredRecord {
  userId: string
  documentId: string
  record: SpreadsheetJournalRecord
}

export const SPREADSHEET_JOURNAL_DATABASE = 'msgnr-spreadsheet-journal'

export function spreadsheetJournalRecordId(record: SpreadsheetJournalRecord): string {
  return record.phase === 'draft' ? record.draftId : record.request.action.id
}

class JournalDatabase extends Dexie {
  drafts!: Table<StoredRecord, [string, string]>

  constructor() {
    super(SPREADSHEET_JOURNAL_DATABASE)
    this.version(1).stores({ drafts: '[userId+documentId]' })
  }
}

/** A separate database and explicit connection owned by one editor session. */
export function createIndexedDbSpreadsheetJournal(scope: { userId: string; documentId: string }): SpreadsheetSessionJournal {
  if (!scope.userId || !scope.documentId) throw new SpreadsheetProblem('storage', 'Authenticated journal scope is required')
  const userId = scope.userId
  const documentId = scope.documentId
  const key: [string, string] = [userId, documentId]
  const db = new JournalDatabase()
  return {
    async load() {
      const stored = await db.drafts.get(key)
      if (!stored) return null
      if (stored.userId !== userId || stored.documentId !== documentId) throw new SpreadsheetProblem('storage', 'Spreadsheet journal scope does not match')
      return structuredClone(stored.record)
    },
    async save(record, replaceOperationId) {
      const plain = structuredClone(record)
      await db.transaction('rw', db.drafts, async () => {
        const existing = await db.drafts.get(key)
        if (existing && spreadsheetJournalRecordId(existing.record) !== spreadsheetJournalRecordId(plain) && spreadsheetJournalRecordId(existing.record) !== replaceOperationId) {
          throw new SpreadsheetProblem('storage', 'Another tab has an unresolved operation for this workbook. Recover it before saving another edit.')
        }
        await db.drafts.put({ userId, documentId, record: plain })
      })
    },
    async clear(operationId) {
      await db.transaction('rw', db.drafts, async () => {
        const existing = await db.drafts.get(key)
        if (existing && spreadsheetJournalRecordId(existing.record) !== operationId) {
          throw new SpreadsheetProblem('storage', 'Another tab has a newer journal operation. Its draft was retained.')
        }
        if (existing) await db.drafts.delete(key)
      })
    },
    close() { db.close() },
  }
}

export function deleteSpreadsheetJournalDatabase(): Promise<void> {
  return Dexie.delete(SPREADSHEET_JOURNAL_DATABASE)
}
