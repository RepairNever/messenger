import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearSidebarCollapsed,
  loadSidebarCollapsed,
  saveSidebarCollapsed,
} from '@/services/storage/sidebarCollapseStorage'

describe('sidebarCollapseStorage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults to expanded when nothing is stored', () => {
    expect(loadSidebarCollapsed()).toBe(false)
  })

  it('stores and restores collapsed state', () => {
    saveSidebarCollapsed(true)
    expect(loadSidebarCollapsed()).toBe(true)

    saveSidebarCollapsed(false)
    expect(loadSidebarCollapsed()).toBe(false)
  })

  it('falls back to expanded for malformed persisted values', () => {
    localStorage.setItem('msgnr:sidebar-collapsed:v1', '{broken')
    expect(loadSidebarCollapsed()).toBe(false)
  })

  it('clears the stored collapsed state', () => {
    saveSidebarCollapsed(true)
    clearSidebarCollapsed()
    expect(loadSidebarCollapsed()).toBe(false)
  })
})
