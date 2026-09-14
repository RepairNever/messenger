import { nextTick, reactive } from 'vue'
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DocumentsSidebar from '@/components/documents/DocumentsSidebar.vue'

const documentsStoreMock = reactive({
  sidebarLoading: false,
  sidebarError: null as string | null,
  sidebarTeamspaces: [] as any[],
  favoriteDocuments: [] as any[],
  loadSidebar: vi.fn(async () => {}),
  createDocument: vi.fn(),
  deleteDocument: vi.fn(),
  favoriteDocument: vi.fn(async () => {}),
  unfavoriteDocument: vi.fn(async () => {}),
})

const storageMocks = vi.hoisted(() => ({
  collapsedTeamspaceIds: [] as string[],
  collapsedNodeIds: [] as string[],
  saveCollapsedDocumentsTeamspaceIds: vi.fn(),
  saveCollapsedDocumentsNodeIds: vi.fn(),
}))

vi.mock('@/stores/documents', () => ({
  useDocumentsStore: () => documentsStoreMock,
}))

vi.mock('@/services/storage/documentsTeamspaceCollapseStorage', () => ({
  loadCollapsedDocumentsTeamspaceIds: () => storageMocks.collapsedTeamspaceIds,
  saveCollapsedDocumentsTeamspaceIds: storageMocks.saveCollapsedDocumentsTeamspaceIds,
}))

vi.mock('@/services/storage/documentsNodeCollapseStorage', () => ({
  loadCollapsedDocumentsNodeIds: () => storageMocks.collapsedNodeIds,
  saveCollapsedDocumentsNodeIds: storageMocks.saveCollapsedDocumentsNodeIds,
}))

describe('DocumentsSidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    documentsStoreMock.sidebarLoading = false
    documentsStoreMock.sidebarError = null
    documentsStoreMock.sidebarTeamspaces = []
    documentsStoreMock.favoriteDocuments = []
    storageMocks.collapsedTeamspaceIds = []
    storageMocks.collapsedNodeIds = []
  })

  it('tolerates null documents and null children in sidebar payloads', () => {
    documentsStoreMock.sidebarTeamspaces = [
      {
        id: 'teamspace-1',
        name: 'Alpha',
        documents: null,
      },
      {
        id: 'teamspace-2',
        name: 'Beta',
        documents: [
          {
            id: 'doc-1',
            teamspace_id: 'teamspace-2',
            parent_document_id: null,
            title: 'Root',
            children: null,
          },
        ],
      },
    ]

    const wrapper = mount(DocumentsSidebar, {
      props: {
        selectedTeamspaceId: null,
        selectedDocumentId: null,
        searchQuery: '',
      },
      global: {
        stubs: {
          Teleport: true,
        },
      },
    })

    expect(wrapper.text()).toContain('Alpha')
    expect(wrapper.text()).toContain('Beta')
    expect(wrapper.text()).toContain('Root')
  })

  it('emits search query changes from the header input', async () => {
    const wrapper = mount(DocumentsSidebar, {
      props: {
        selectedTeamspaceId: null,
        selectedDocumentId: null,
        searchQuery: '',
      },
      global: {
        stubs: {
          Teleport: true,
        },
      },
    })

    await wrapper.get('[data-testid="documents-search-input"]').setValue('spec')

    expect(wrapper.emitted('searchQueryChange')).toEqual([['spec']])
  })

  it('keeps teamspaces and favorites outside the scrollable document tree', () => {
    documentsStoreMock.favoriteDocuments = [
      {
        id: 'doc-1',
        teamspace_id: 'teamspace-1',
        title: 'Pinned favorite',
        favorited_at: '2026-05-22T00:00:00Z',
        ancestor_document_ids: [],
      },
    ]
    documentsStoreMock.sidebarTeamspaces = [
      {
        id: 'teamspace-1',
        name: 'Alpha',
        documents: [],
      },
    ]

    const wrapper = mount(DocumentsSidebar, {
      props: {
        selectedTeamspaceId: null,
        selectedDocumentId: null,
        searchQuery: '',
      },
      global: {
        stubs: {
          Teleport: true,
        },
      },
    })

    const pinnedPanel = wrapper.get('[data-testid="documents-pinned-panel"]')
    const treeScroll = wrapper.get('[data-testid="documents-tree-scroll"]')

    expect(pinnedPanel.find('[data-testid="documents-teamspaces-button"]').exists()).toBe(true)
    expect(pinnedPanel.find('[data-testid="documents-favorites-section"]').exists()).toBe(true)
    expect(treeScroll.find('[data-testid="documents-teamspaces-button"]').exists()).toBe(false)
    expect(treeScroll.find('[data-testid="documents-favorites-section"]').exists()).toBe(false)
    expect(treeScroll.classes()).toContain('overflow-y-auto')
  })

  it('renders favorites and opens a favorite while expanding its sidebar path', async () => {
    const scrollIntoView = vi.fn()
    const originalScrollIntoView = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scrollIntoView
    storageMocks.collapsedTeamspaceIds = ['teamspace-1']
    storageMocks.collapsedNodeIds = ['root-doc']
    documentsStoreMock.sidebarTeamspaces = [
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
                children: [],
              },
            ],
          },
        ],
      },
    ]
    try {
      documentsStoreMock.favoriteDocuments = [
        {
          id: 'child-doc',
          teamspace_id: 'teamspace-1',
          title: 'Child',
          favorited_at: '2026-05-22T00:00:00Z',
          ancestor_document_ids: ['root-doc'],
        },
      ]

      const wrapper = mount(DocumentsSidebar, {
        props: {
          selectedTeamspaceId: null,
          selectedDocumentId: null,
          searchQuery: '',
        },
        global: {
          stubs: {
            Teleport: true,
          },
        },
      })

      expect(wrapper.get('[data-testid="documents-favorite-child-doc"]').text()).toContain('Child')
      expect(wrapper.find('[data-testid="documents-node-child-doc"]').exists()).toBe(false)

      await wrapper.get('[data-testid="documents-favorite-child-doc"]').trigger('click')
      await nextTick()

      expect(wrapper.emitted('openDocument')).toEqual([['child-doc']])
      expect(wrapper.find('[data-testid="documents-node-child-doc"]').exists()).toBe(true)
      expect(wrapper.find('[data-document-node-id="child-doc"]').exists()).toBe(true)
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', inline: 'nearest' })
    } finally {
      if (originalScrollIntoView) {
        Element.prototype.scrollIntoView = originalScrollIntoView
      } else {
        delete (Element.prototype as any).scrollIntoView
      }
    }
  })

  it('adds a document to favorites from the selected row outline icon', async () => {
    documentsStoreMock.sidebarTeamspaces = [
      {
        id: 'teamspace-1',
        name: 'Alpha',
        documents: [
          {
            id: 'doc-1',
            teamspace_id: 'teamspace-1',
            parent_document_id: null,
            title: 'Root',
            is_favorite: false,
            children: [],
          },
        ],
      },
    ]

    const wrapper = mount(DocumentsSidebar, {
      props: {
        selectedTeamspaceId: null,
        selectedDocumentId: 'doc-1',
        searchQuery: '',
      },
      global: {
        stubs: {
          Teleport: true,
        },
      },
    })

    const favoriteToggle = wrapper.get('[data-testid="documents-node-favorite-toggle-doc-1"]')
    expect(favoriteToggle.attributes('aria-label')).toBe('Add to favorites')
    expect(favoriteToggle.classes()).toEqual(expect.arrayContaining([
      'hidden',
      'group-hover:flex',
      'group-focus-within:flex',
    ]))
    expect(wrapper.find('[data-testid="documents-node-favorite-outline-doc-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="documents-node-favorite-filled-doc-1"]').exists()).toBe(false)

    await favoriteToggle.trigger('click')
    await Promise.resolve()

    expect(documentsStoreMock.favoriteDocument).toHaveBeenCalledWith('doc-1')
    expect(documentsStoreMock.unfavoriteDocument).not.toHaveBeenCalled()
    expect(wrapper.emitted('openDocument')).toBeUndefined()
  })

  it('removes the favorite action from the document row menu', async () => {
    documentsStoreMock.sidebarTeamspaces = [
      {
        id: 'teamspace-1',
        name: 'Alpha',
        documents: [
          {
            id: 'doc-1',
            teamspace_id: 'teamspace-1',
            parent_document_id: null,
            title: 'Root',
            is_favorite: false,
            children: [],
          },
        ],
      },
    ]

    const wrapper = mount(DocumentsSidebar, {
      props: {
        selectedTeamspaceId: null,
        selectedDocumentId: null,
        searchQuery: '',
      },
      global: {
        stubs: {
          Teleport: true,
        },
      },
    })

    await wrapper.get('[data-testid="documents-node-menu-doc-1"]').trigger('click')

    expect(wrapper.find('[data-testid="documents-node-favorite-doc-1"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Add to favorites')
    expect(wrapper.text()).not.toContain('Remove from favorites')
    expect(documentsStoreMock.favoriteDocument).not.toHaveBeenCalled()
    expect(documentsStoreMock.unfavoriteDocument).not.toHaveBeenCalled()
  })

  it('removes a document from favorites from the filled row icon', async () => {
    documentsStoreMock.sidebarTeamspaces = [
      {
        id: 'teamspace-1',
        name: 'Alpha',
        documents: [
          {
            id: 'doc-1',
            teamspace_id: 'teamspace-1',
            parent_document_id: null,
            title: 'Root',
            is_favorite: true,
            favorited_at: '2026-05-22T00:00:00Z',
            children: [],
          },
        ],
      },
    ]

    const wrapper = mount(DocumentsSidebar, {
      props: {
        selectedTeamspaceId: null,
        selectedDocumentId: null,
        searchQuery: '',
      },
      global: {
        stubs: {
          Teleport: true,
        },
      },
    })

    const favoriteToggle = wrapper.get('[data-testid="documents-node-favorite-toggle-doc-1"]')
    expect(favoriteToggle.attributes('aria-label')).toBe('Remove from favorites')
    expect(wrapper.find('[data-testid="documents-node-favorite-filled-doc-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="documents-node-favorite-outline-doc-1"]').exists()).toBe(false)

    await favoriteToggle.trigger('click')
    await Promise.resolve()

    expect(documentsStoreMock.unfavoriteDocument).toHaveBeenCalledWith('doc-1')
    expect(documentsStoreMock.favoriteDocument).not.toHaveBeenCalled()
    expect(wrapper.emitted('openDocument')).toBeUndefined()
  })

  it('removes a favorite from the pinned favorites list without opening it', async () => {
    documentsStoreMock.favoriteDocuments = [
      {
        id: 'doc-1',
        teamspace_id: 'teamspace-1',
        title: 'Pinned favorite',
        favorited_at: '2026-05-22T00:00:00Z',
        ancestor_document_ids: [],
      },
    ]

    const wrapper = mount(DocumentsSidebar, {
      props: {
        selectedTeamspaceId: null,
        selectedDocumentId: 'doc-1',
        searchQuery: '',
      },
      global: {
        stubs: {
          Teleport: true,
        },
      },
    })

    const removeButton = wrapper.get('[data-testid="documents-favorite-remove-doc-1"]')
    expect(removeButton.attributes('aria-label')).toBe('Remove from favorites')
    expect(removeButton.classes()).toEqual(expect.arrayContaining([
      'hidden',
      'group-hover:flex',
      'group-focus-within:flex',
    ]))

    await removeButton.trigger('click')
    await Promise.resolve()

    expect(documentsStoreMock.unfavoriteDocument).toHaveBeenCalledWith('doc-1')
    expect(wrapper.emitted('openDocument')).toBeUndefined()
  })

  it('reserves action space only while a document-sidebar row is hovered or focused', () => {
    documentsStoreMock.favoriteDocuments = [
      {
        id: 'favorite-doc',
        teamspace_id: 'teamspace-1',
        title: 'Pinned favorite',
        favorited_at: '2026-05-22T00:00:00Z',
        ancestor_document_ids: [],
      },
    ]
    documentsStoreMock.sidebarTeamspaces = [
      {
        id: 'teamspace-1',
        name: 'Alpha',
        documents: [
          {
            id: 'doc-1',
            teamspace_id: 'teamspace-1',
            parent_document_id: null,
            title: 'A document with a long title',
            children: [],
          },
        ],
      },
    ]

    const wrapper = mount(DocumentsSidebar, {
      props: {
        selectedTeamspaceId: null,
        selectedDocumentId: null,
        searchQuery: '',
      },
      global: {
        stubs: {
          Teleport: true,
        },
      },
    })

    const documentTitle = wrapper.get('[data-testid="documents-node-doc-1"]')
    expect(documentTitle.classes()).toEqual(expect.arrayContaining(['min-w-0', 'flex-1', 'truncate']))
    for (const testId of [
      'documents-node-favorite-toggle-doc-1',
      'documents-node-add-doc-1',
      'documents-node-menu-doc-1',
    ]) {
      expect(wrapper.get(`[data-testid="${testId}"]`).classes()).toEqual(expect.arrayContaining([
        'hidden',
        'group-hover:flex',
        'group-focus-within:flex',
      ]))
    }

    const favoriteRemove = wrapper.get('[data-testid="documents-favorite-remove-favorite-doc"]')
    expect(favoriteRemove.classes()).toEqual(expect.arrayContaining([
      'hidden',
      'group-hover:flex',
      'group-focus-within:flex',
    ]))

    const teamspaceTitle = wrapper.get('[data-testid="documents-teamspace-teamspace-1"]')
    expect(teamspaceTitle.classes()).toEqual(expect.arrayContaining(['min-w-0', 'flex-1', 'truncate']))
    const teamspaceAdd = wrapper.get('[data-testid="documents-teamspace-add-teamspace-1"]')
    expect(teamspaceAdd.classes()).toEqual(expect.arrayContaining([
      'hidden',
      'group-hover:block',
      'group-focus-within:block',
    ]))
  })
})
