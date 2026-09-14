import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearTaskListViewMode,
  loadTaskListViewMode,
  saveTaskListViewMode,
} from '@/services/storage/taskListViewModeStorage'

describe('taskListViewModeStorage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults to list mode when nothing stored', () => {
    expect(loadTaskListViewMode()).toBe('list')
  })

  it('stores and restores grouped mode', () => {
    saveTaskListViewMode('grouped')
    expect(loadTaskListViewMode()).toBe('grouped')
  })

  it('clears persisted mode', () => {
    saveTaskListViewMode('grouped')
    clearTaskListViewMode()
    expect(loadTaskListViewMode()).toBe('list')
  })

  it('falls back to list for removed legacy mode values', () => {
    localStorage.setItem('msgnr:tasks:view-mode:v1', 'kanban')
    expect(loadTaskListViewMode()).toBe('list')
  })
})
