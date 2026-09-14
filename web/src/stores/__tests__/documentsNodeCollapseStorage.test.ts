import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearCollapsedDocumentsNodeIds,
  loadCollapsedDocumentsNodeIds,
  saveCollapsedDocumentsNodeIds,
} from '@/services/storage/documentsNodeCollapseStorage'

describe('documentsNodeCollapseStorage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns empty list when nothing stored', () => {
    expect(loadCollapsedDocumentsNodeIds()).toEqual([])
  })

  it('stores and restores unique document ids', () => {
    saveCollapsedDocumentsNodeIds(['doc-1', 'doc-1', 'doc-2'])
    expect(loadCollapsedDocumentsNodeIds()).toEqual(['doc-1', 'doc-2'])
  })

  it('returns empty list on malformed payload', () => {
    localStorage.setItem('msgnr:documents:node-collapsed:v1', '{broken')
    expect(loadCollapsedDocumentsNodeIds()).toEqual([])
  })

  it('clears persisted collapsed ids', () => {
    saveCollapsedDocumentsNodeIds(['doc-1'])
    clearCollapsedDocumentsNodeIds()
    expect(loadCollapsedDocumentsNodeIds()).toEqual([])
  })
})
