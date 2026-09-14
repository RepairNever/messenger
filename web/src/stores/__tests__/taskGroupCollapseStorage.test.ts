import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearCollapsedTaskStatusIds,
  loadCollapsedTaskStatusIds,
  saveCollapsedTaskStatusIds,
} from '@/services/storage/taskGroupCollapseStorage'

describe('taskGroupCollapseStorage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns empty list when nothing stored', () => {
    expect(loadCollapsedTaskStatusIds()).toEqual([])
  })

  it('stores and restores unique status ids', () => {
    saveCollapsedTaskStatusIds(['st-1', 'st-1', 'st-2'])
    expect(loadCollapsedTaskStatusIds()).toEqual(['st-1', 'st-2'])
  })

  it('returns empty list on malformed payload', () => {
    localStorage.setItem('msgnr:tasks:group-collapsed:v1', '{broken')
    expect(loadCollapsedTaskStatusIds()).toEqual([])
  })

  it('clears persisted collapsed ids', () => {
    saveCollapsedTaskStatusIds(['st-1'])
    clearCollapsedTaskStatusIds()
    expect(loadCollapsedTaskStatusIds()).toEqual([])
  })
})
