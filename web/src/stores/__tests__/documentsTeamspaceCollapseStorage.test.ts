import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearCollapsedDocumentsTeamspaceIds,
  loadCollapsedDocumentsTeamspaceIds,
  saveCollapsedDocumentsTeamspaceIds,
} from '@/services/storage/documentsTeamspaceCollapseStorage'

describe('documentsTeamspaceCollapseStorage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns empty list when nothing stored', () => {
    expect(loadCollapsedDocumentsTeamspaceIds()).toEqual([])
  })

  it('stores and restores unique teamspace ids', () => {
    saveCollapsedDocumentsTeamspaceIds(['ts-1', 'ts-1', 'ts-2'])
    expect(loadCollapsedDocumentsTeamspaceIds()).toEqual(['ts-1', 'ts-2'])
  })

  it('returns empty list on malformed payload', () => {
    localStorage.setItem('msgnr:documents:teamspace-collapsed:v1', '{broken')
    expect(loadCollapsedDocumentsTeamspaceIds()).toEqual([])
  })

  it('clears persisted collapsed ids', () => {
    saveCollapsedDocumentsTeamspaceIds(['ts-1'])
    clearCollapsedDocumentsTeamspaceIds()
    expect(loadCollapsedDocumentsTeamspaceIds()).toEqual([])
  })
})
