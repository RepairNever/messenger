import { storage } from '@/services/storage/storageAdapter'

export type TaskCreateDraftStagedAttachment = {
  id: string
  file_name: string
  file_size: number
  mime_type: string
  uploaded_by: string
  created_at: string
}

export type TaskCreateDraft = {
  title: string
  description: string
  stagedAttachments: TaskCreateDraftStagedAttachment[]
}

type TaskCreateDraftInput = {
  title: string
  description: string
  stagedAttachments?: TaskCreateDraftStagedAttachment[]
}

const EMPTY_DRAFT: TaskCreateDraft = {
  title: '',
  description: '',
  stagedAttachments: [],
}

const TASK_CREATE_DRAFT_KEY = 'msgnr:tasks:create-draft:v1'
const SUBTASK_CREATE_DRAFT_KEY = 'msgnr:tasks:subtask-create-draft:v1'

function loadDraft(key: string): TaskCreateDraft {
  const raw = storage.getItem(key)
  if (!raw) return EMPTY_DRAFT
  try {
    const parsed = JSON.parse(raw) as Partial<TaskCreateDraft>
    return {
      title: typeof parsed.title === 'string' ? parsed.title : '',
      description: typeof parsed.description === 'string' ? parsed.description : '',
      stagedAttachments: Array.isArray(parsed.stagedAttachments)
        ? parsed.stagedAttachments.filter(isTaskCreateDraftStagedAttachment)
        : [],
    }
  } catch {
    return EMPTY_DRAFT
  }
}

function isTaskCreateDraftStagedAttachment(value: unknown): value is TaskCreateDraftStagedAttachment {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<TaskCreateDraftStagedAttachment>
  return typeof item.id === 'string'
    && typeof item.file_name === 'string'
    && typeof item.file_size === 'number'
    && typeof item.mime_type === 'string'
    && typeof item.uploaded_by === 'string'
    && typeof item.created_at === 'string'
}

function saveDraft(key: string, draft: TaskCreateDraftInput) {
  const stagedAttachments = draft.stagedAttachments ?? []
  if (draft.title.trim() === '' && draft.description.trim() === '' && stagedAttachments.length === 0) {
    storage.removeItem(key)
    return
  }
  storage.setItem(key, JSON.stringify({
    title: draft.title,
    description: draft.description,
    stagedAttachments,
  }))
}

function clearDraft(key: string) {
  storage.removeItem(key)
}

export function loadTaskCreateDraft(): TaskCreateDraft {
  return loadDraft(TASK_CREATE_DRAFT_KEY)
}

export function saveTaskCreateDraft(draft: TaskCreateDraftInput) {
  saveDraft(TASK_CREATE_DRAFT_KEY, draft)
}

export function clearTaskCreateDraft() {
  clearDraft(TASK_CREATE_DRAFT_KEY)
}

export function loadSubtaskCreateDraft(): TaskCreateDraft {
  return loadDraft(SUBTASK_CREATE_DRAFT_KEY)
}

export function saveSubtaskCreateDraft(draft: TaskCreateDraftInput) {
  saveDraft(SUBTASK_CREATE_DRAFT_KEY, draft)
}

export function clearSubtaskCreateDraft() {
  clearDraft(SUBTASK_CREATE_DRAFT_KEY)
}
