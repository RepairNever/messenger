import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearSidebarWidth,
  loadSidebarWidth,
  saveSidebarWidth,
} from '@/services/storage/sidebarWidthStorage'

describe('sidebarWidthStorage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns the fallback width when nothing is stored', () => {
    expect(loadSidebarWidth('msgnr:sidebar-width:test:v1', 240)).toBe(240)
  })

  it('stores and restores a width value', () => {
    saveSidebarWidth('msgnr:sidebar-width:test:v1', 312)
    expect(loadSidebarWidth('msgnr:sidebar-width:test:v1', 240)).toBe(312)
  })

  it('falls back for malformed persisted values', () => {
    localStorage.setItem('msgnr:sidebar-width:test:v1', '{broken')
    expect(loadSidebarWidth('msgnr:sidebar-width:test:v1', 240)).toBe(240)
  })

  it('clears the stored width', () => {
    saveSidebarWidth('msgnr:sidebar-width:test:v1', 312)
    clearSidebarWidth('msgnr:sidebar-width:test:v1')
    expect(loadSidebarWidth('msgnr:sidebar-width:test:v1', 240)).toBe(240)
  })
})
