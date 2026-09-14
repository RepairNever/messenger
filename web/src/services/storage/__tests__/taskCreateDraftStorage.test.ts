import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearSubtaskCreateDraft,
  clearTaskCreateDraft,
  loadSubtaskCreateDraft,
  loadTaskCreateDraft,
  saveSubtaskCreateDraft,
  saveTaskCreateDraft,
} from '@/services/storage/taskCreateDraftStorage'

describe('taskCreateDraftStorage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('loads saved task draft JSON', () => {
    saveTaskCreateDraft({
      title: 'Task title',
      description: 'Task description',
    })

    expect(loadTaskCreateDraft()).toEqual({
      title: 'Task title',
      description: 'Task description',
      stagedAttachments: [],
    })
  })

  it('persists staged task attachments with the task draft', () => {
    saveTaskCreateDraft({
      title: 'Task title',
      description: '![Photo](msgnr-staged-attachment://task/staged-1)',
      stagedAttachments: [{
        id: 'staged-1',
        file_name: 'Photo.png',
        file_size: 3,
        mime_type: 'image/png',
        uploaded_by: 'u-1',
        created_at: '2026-01-01T00:00:00Z',
      }],
    })

    expect(loadTaskCreateDraft()).toEqual({
      title: 'Task title',
      description: '![Photo](msgnr-staged-attachment://task/staged-1)',
      stagedAttachments: [{
        id: 'staged-1',
        file_name: 'Photo.png',
        file_size: 3,
        mime_type: 'image/png',
        uploaded_by: 'u-1',
        created_at: '2026-01-01T00:00:00Z',
      }],
    })
  })

  it('returns an empty task draft on malformed JSON', () => {
    localStorage.setItem('msgnr:tasks:create-draft:v1', '{bad json')

    expect(loadTaskCreateDraft()).toEqual({
      title: '',
      description: '',
      stagedAttachments: [],
    })
  })

  it('clears stored task draft explicitly', () => {
    saveTaskCreateDraft({
      title: 'Task title',
      description: 'Task description',
    })

    clearTaskCreateDraft()

    expect(loadTaskCreateDraft()).toEqual({
      title: '',
      description: '',
      stagedAttachments: [],
    })
  })

  it('removes the task draft when both fields are blank', () => {
    saveTaskCreateDraft({
      title: '   ',
      description: '',
    })

    expect(localStorage.getItem('msgnr:tasks:create-draft:v1')).toBeNull()
    expect(loadTaskCreateDraft()).toEqual({
      title: '',
      description: '',
      stagedAttachments: [],
    })
  })

  it('saves and clears the subtask draft independently', () => {
    saveSubtaskCreateDraft({
      title: 'Subtask title',
      description: 'Subtask description',
    })

    expect(loadSubtaskCreateDraft()).toEqual({
      title: 'Subtask title',
      description: 'Subtask description',
      stagedAttachments: [],
    })

    clearSubtaskCreateDraft()

    expect(loadSubtaskCreateDraft()).toEqual({
      title: '',
      description: '',
      stagedAttachments: [],
    })
  })
})
