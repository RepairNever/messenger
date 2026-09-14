import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDocumentsStore } from '@/stores/documents'

const documentsApiMocks = vi.hoisted(() => ({
  documentsCreateDocument: vi.fn(),
  documentsCreateTeamspace: vi.fn(),
  documentsDeleteDocument: vi.fn(),
  documentsDeleteTeamspace: vi.fn(),
  documentsFavoriteDocument: vi.fn(),
  documentsGetDocument: vi.fn(),
  documentsJoinTeamspace: vi.fn(),
  documentsListDocumentHistory: vi.fn(),
  documentsListSidebar: vi.fn(),
  documentsListTeamspaces: vi.fn(),
  documentsSearchDocuments: vi.fn(),
  documentsUnfavoriteDocument: vi.fn(),
  documentsUpdateDocument: vi.fn(),
  documentsUpdateDocumentContent: vi.fn(),
  documentsUpdateTeamspace: vi.fn(),
}))

vi.mock('@/services/http/documentsApi', () => ({
  documentsCreateDocument: documentsApiMocks.documentsCreateDocument,
  documentsCreateTeamspace: documentsApiMocks.documentsCreateTeamspace,
  documentsDeleteDocument: documentsApiMocks.documentsDeleteDocument,
  documentsDeleteTeamspace: documentsApiMocks.documentsDeleteTeamspace,
  documentsFavoriteDocument: documentsApiMocks.documentsFavoriteDocument,
  documentsGetDocument: documentsApiMocks.documentsGetDocument,
  documentsJoinTeamspace: documentsApiMocks.documentsJoinTeamspace,
  documentsListDocumentHistory: documentsApiMocks.documentsListDocumentHistory,
  documentsListSidebar: documentsApiMocks.documentsListSidebar,
  documentsListTeamspaces: documentsApiMocks.documentsListTeamspaces,
  documentsSearchDocuments: documentsApiMocks.documentsSearchDocuments,
  documentsUnfavoriteDocument: documentsApiMocks.documentsUnfavoriteDocument,
  documentsUpdateDocument: documentsApiMocks.documentsUpdateDocument,
  documentsUpdateDocumentContent: documentsApiMocks.documentsUpdateDocumentContent,
  documentsUpdateTeamspace: documentsApiMocks.documentsUpdateTeamspace,
}))

describe('documents store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.useFakeTimers()
    documentsApiMocks.documentsDeleteDocument.mockResolvedValue(undefined)
    documentsApiMocks.documentsDeleteTeamspace.mockResolvedValue(undefined)
    documentsApiMocks.documentsListTeamspaces.mockResolvedValue([])
    documentsApiMocks.documentsListSidebar.mockResolvedValue([])
    documentsApiMocks.documentsSearchDocuments.mockResolvedValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('clears the selected document when its teamspace is deleted', async () => {
    const store = useDocumentsStore()
    store.selectedDocument = {
      id: 'doc-1',
      teamspace_id: 'teamspace-1',
    } as any

    await store.deleteTeamspace('teamspace-1')

    expect(documentsApiMocks.documentsDeleteTeamspace).toHaveBeenCalledWith('teamspace-1')
    expect(store.selectedDocument).toBeNull()
  })

  it('adds a created root document to the sidebar without reloading', async () => {
    const store = useDocumentsStore()
    store.sidebarTeamspaces = [
      {
        id: 'teamspace-1',
        name: 'Alpha',
        documents: [
          {
            id: 'existing-doc',
            teamspace_id: 'teamspace-1',
            parent_document_id: null,
            title: 'Existing',
            children: [],
          },
        ],
      },
    ] as any
    documentsApiMocks.documentsCreateDocument.mockResolvedValue({
      id: 'new-root-doc',
      teamspace_id: 'teamspace-1',
      teamspace_name: 'Alpha',
      parent_document_id: null,
      parent_title: null,
      title: 'New root',
      content_markdown: null,
      created_by: 'user-1',
      updated_by: 'user-1',
      created_at: '2026-05-22T00:00:00Z',
      updated_at: '2026-05-22T00:00:00Z',
    })

    const row = await store.createDocument({
      teamspace_id: 'teamspace-1',
      parent_document_id: null,
      title: 'New root',
      content_markdown: null,
    })

    expect(row.id).toBe('new-root-doc')
    expect(store.selectedDocument?.id).toBe('new-root-doc')
    expect(documentsApiMocks.documentsListSidebar).not.toHaveBeenCalled()
    expect(store.sidebarTeamspaces[0].documents).toEqual([
      expect.objectContaining({ id: 'existing-doc' }),
      expect.objectContaining({
        id: 'new-root-doc',
        parent_document_id: null,
        title: 'New root',
        children: [],
      }),
    ])
  })

  it('adds a created child document to its parent node without reloading', async () => {
    const store = useDocumentsStore()
    store.sidebarTeamspaces = [
      {
        id: 'teamspace-1',
        name: 'Alpha',
        documents: [
          {
            id: 'root-doc',
            teamspace_id: 'teamspace-1',
            parent_document_id: null,
            title: 'Root',
            children: [
              {
                id: 'existing-child-doc',
                teamspace_id: 'teamspace-1',
                parent_document_id: 'root-doc',
                title: 'Existing child',
                children: [],
              },
            ],
          },
        ],
      },
    ] as any
    documentsApiMocks.documentsCreateDocument.mockResolvedValue({
      id: 'new-child-doc',
      teamspace_id: 'teamspace-1',
      teamspace_name: 'Alpha',
      parent_document_id: 'root-doc',
      parent_title: 'Root',
      title: 'New child',
      content_markdown: null,
      created_by: 'user-1',
      updated_by: 'user-1',
      created_at: '2026-05-22T00:00:00Z',
      updated_at: '2026-05-22T00:00:00Z',
    })

    await store.createDocument({
      teamspace_id: 'teamspace-1',
      parent_document_id: 'root-doc',
      title: 'New child',
      content_markdown: null,
    })

    expect(documentsApiMocks.documentsListSidebar).not.toHaveBeenCalled()
    expect(store.sidebarTeamspaces[0].documents).toEqual([
      expect.objectContaining({
        id: 'root-doc',
        children: [
          expect.objectContaining({ id: 'existing-child-doc' }),
          expect.objectContaining({
            id: 'new-child-doc',
            parent_document_id: 'root-doc',
            title: 'New child',
            children: [],
          }),
        ],
      }),
    ])
  })

  it('removes a deleted root document subtree from the sidebar without reloading', async () => {
    const store = useDocumentsStore()
    store.sidebarTeamspaces = [
      {
        id: 'teamspace-1',
        name: 'Alpha',
        documents: [
          {
            id: 'root-doc',
            teamspace_id: 'teamspace-1',
            parent_document_id: null,
            title: 'Root',
            children: [
              {
                id: 'child-doc',
                teamspace_id: 'teamspace-1',
                parent_document_id: 'root-doc',
                title: 'Child',
                children: [
                  {
                    id: 'grandchild-doc',
                    teamspace_id: 'teamspace-1',
                    parent_document_id: 'child-doc',
                    title: 'Grandchild',
                    children: [],
                  },
                ],
              },
            ],
          },
          {
            id: 'sibling-doc',
            teamspace_id: 'teamspace-1',
            parent_document_id: null,
            title: 'Sibling',
            children: [],
          },
        ],
      },
    ] as any

    await store.deleteDocument('root-doc')

    expect(documentsApiMocks.documentsDeleteDocument).toHaveBeenCalledWith('root-doc')
    expect(documentsApiMocks.documentsListSidebar).not.toHaveBeenCalled()
    expect(store.sidebarTeamspaces[0].documents).toEqual([
      expect.objectContaining({ id: 'sibling-doc' }),
    ])
  })

  it('removes only the deleted nested document subtree from the sidebar', async () => {
    const store = useDocumentsStore()
    store.sidebarTeamspaces = [
      {
        id: 'teamspace-1',
        name: 'Alpha',
        documents: [
          {
            id: 'root-doc',
            teamspace_id: 'teamspace-1',
            parent_document_id: null,
            title: 'Root',
            children: [
              {
                id: 'child-doc',
                teamspace_id: 'teamspace-1',
                parent_document_id: 'root-doc',
                title: 'Child',
                children: [
                  {
                    id: 'grandchild-doc',
                    teamspace_id: 'teamspace-1',
                    parent_document_id: 'child-doc',
                    title: 'Grandchild',
                    children: [],
                  },
                ],
              },
              {
                id: 'child-sibling-doc',
                teamspace_id: 'teamspace-1',
                parent_document_id: 'root-doc',
                title: 'Child sibling',
                children: [],
              },
            ],
          },
        ],
      },
    ] as any

    await store.deleteDocument('child-doc')

    expect(documentsApiMocks.documentsListSidebar).not.toHaveBeenCalled()
    expect(store.sidebarTeamspaces[0].documents).toEqual([
      expect.objectContaining({
        id: 'root-doc',
        children: [
          expect.objectContaining({ id: 'child-sibling-doc' }),
        ],
      }),
    ])
  })

  it('updates nested favorite state and exposes newest favorites first', async () => {
    const store = useDocumentsStore()
    const unaffectedTeamspace = {
      id: 'teamspace-2',
      name: 'Beta',
      documents: [
        {
          id: 'other-doc',
          teamspace_id: 'teamspace-2',
          parent_document_id: null,
          title: 'Other',
          is_favorite: false,
          favorited_at: null,
          children: [],
        },
      ],
    }
    store.sidebarTeamspaces = [
      {
        id: 'teamspace-1',
        name: 'Alpha',
        documents: [
          {
            id: 'root-doc',
            teamspace_id: 'teamspace-1',
            parent_document_id: null,
            title: 'Root',
            is_favorite: true,
            favorited_at: '2026-05-20T00:00:00Z',
            children: [
              {
                id: 'child-doc',
                teamspace_id: 'teamspace-1',
                parent_document_id: 'root-doc',
                title: 'Child',
                is_favorite: false,
                favorited_at: null,
                children: [],
              },
            ],
          },
        ],
      },
      unaffectedTeamspace,
    ] as any
    const unchangedRoot = store.sidebarTeamspaces[0].documents[0]
    const unchangedTeamspace = store.sidebarTeamspaces[1]
    documentsApiMocks.documentsFavoriteDocument.mockResolvedValue({
      document_id: 'child-doc',
      is_favorite: true,
      favorited_at: '2026-05-22T00:00:00Z',
    })

    await store.favoriteDocument('child-doc')

    expect(documentsApiMocks.documentsFavoriteDocument).toHaveBeenCalledWith('child-doc')
    expect(store.sidebarTeamspaces[0].documents[0]).not.toBe(unchangedRoot)
    expect(store.sidebarTeamspaces[1]).toBe(unchangedTeamspace)
    expect(store.sidebarTeamspaces[0].documents[0].children[0]).toEqual(expect.objectContaining({
      id: 'child-doc',
      is_favorite: true,
      favorited_at: '2026-05-22T00:00:00Z',
    }))
    expect(store.favoriteDocuments.map(item => ({
      id: item.id,
      ancestors: item.ancestor_document_ids,
    }))).toEqual([
      { id: 'child-doc', ancestors: ['root-doc'] },
      { id: 'root-doc', ancestors: [] },
    ])
  })

  it('unfavorites a nested sidebar document in place', async () => {
    const store = useDocumentsStore()
    store.sidebarTeamspaces = [
      {
        id: 'teamspace-1',
        name: 'Alpha',
        documents: [
          {
            id: 'root-doc',
            teamspace_id: 'teamspace-1',
            parent_document_id: null,
            title: 'Root',
            is_favorite: true,
            favorited_at: '2026-05-22T00:00:00Z',
            children: [],
          },
        ],
      },
    ] as any
    documentsApiMocks.documentsUnfavoriteDocument.mockResolvedValue({
      document_id: 'root-doc',
      is_favorite: false,
      favorited_at: null,
    })

    await store.unfavoriteDocument('root-doc')

    expect(documentsApiMocks.documentsUnfavoriteDocument).toHaveBeenCalledWith('root-doc')
    expect(store.sidebarTeamspaces[0].documents[0]).toEqual(expect.objectContaining({
      id: 'root-doc',
      is_favorite: false,
      favorited_at: null,
    }))
    expect(store.favoriteDocuments).toEqual([])
  })

  it('debounces document search requests and stores results', async () => {
    const store = useDocumentsStore()
    documentsApiMocks.documentsSearchDocuments.mockResolvedValue([
      {
        id: 'doc-1',
        teamspace_id: 'teamspace-1',
        teamspace_name: 'Alpha',
        title: 'Spec',
        snippet: 'Spec details',
      },
    ])

    store.scheduleSearch('spec')
    store.scheduleSearch('specification')

    expect(documentsApiMocks.documentsSearchDocuments).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(250)
    await Promise.resolve()

    expect(documentsApiMocks.documentsSearchDocuments).toHaveBeenCalledTimes(1)
    expect(documentsApiMocks.documentsSearchDocuments).toHaveBeenCalledWith('specification')
    expect(store.searchResults).toEqual([
      expect.objectContaining({ id: 'doc-1', title: 'Spec' }),
    ])
  })

  it('clears pending search state when query is blank', async () => {
    const store = useDocumentsStore()
    store.searchResults = [
      {
        id: 'doc-1',
        teamspace_id: 'teamspace-1',
        teamspace_name: 'Alpha',
        title: 'Spec',
        snippet: 'Spec details',
      },
    ] as any

    store.scheduleSearch('   ')
    await vi.advanceTimersByTimeAsync(250)

    expect(documentsApiMocks.documentsSearchDocuments).not.toHaveBeenCalled()
    expect(store.searchResults).toEqual([])
    expect(store.searchError).toBeNull()
    expect(store.searchLoading).toBe(false)
  })
})
