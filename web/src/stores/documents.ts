import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  documentsCreateDocument,
  documentsCreateTeamspace,
  documentsDeleteDocument,
  documentsDeleteTeamspace,
  documentsFavoriteDocument,
  documentsGetDocument,
  documentsJoinTeamspace,
  documentsListDocumentHistory,
  documentsListSidebar,
  documentsListTeamspaces,
  documentsSearchDocuments,
  documentsUnfavoriteDocument,
  documentsUpdateDocument,
  documentsUpdateDocumentContent,
  documentsUpdateTeamspace,
  type CreateDocumentPayload,
  type DocumentFavoriteResponse,
  type DocumentHistoryItem,
  type DocumentItem,
  type DocumentSearchResult,
  type SidebarDocumentNode,
  type SidebarTeamspace,
  type Teamspace,
  type UpsertTeamspacePayload,
  type UpdateDocumentContentPayload,
  type UpdateDocumentPayload,
} from '@/services/http/documentsApi'
import { tasksListUsers, type TaskUser } from '@/services/http/tasksApi'
import { useChatStore } from '@/stores/chat'
import { userCustomStatusFromDto } from '@/types/userStatus'

export interface FavoriteSidebarDocument {
  id: string
  teamspace_id: string
  title: string
  favorited_at: string
  ancestor_document_ids: string[]
}

export const useDocumentsStore = defineStore('documents', () => {
  const teamspaces = ref<Teamspace[]>([])
  const teamspacesLoading = ref(false)
  const teamspacesError = ref<string | null>(null)

  const sidebarTeamspaces = ref<SidebarTeamspace[]>([])
  const sidebarLoading = ref(false)
  const sidebarError = ref<string | null>(null)

  const selectedDocument = ref<DocumentItem | null>(null)
  const documentLoading = ref(false)
  const documentError = ref<string | null>(null)
  const selectedDocumentContentRequestKey = ref('')

  const users = ref<TaskUser[]>([])
  const usersLoaded = ref(false)
  const usersLoading = ref(false)

  const selectedDocumentRequestKey = ref('')
  const searchQuery = ref('')
  const searchResults = ref<DocumentSearchResult[]>([])
  const searchLoading = ref(false)
  const searchError = ref<string | null>(null)
  const searchRequestKey = ref('')
  let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null

  const memberTeamspaces = computed(() => teamspaces.value.filter(item => item.is_member))
  const favoriteDocuments = computed<FavoriteSidebarDocument[]>(() => {
    const favorites = sidebarTeamspaces.value.flatMap(teamspace => collectFavoriteDocuments(teamspace.documents, []))
    return favorites.sort((a, b) => (
      b.favorited_at > a.favorited_at ? 1 : b.favorited_at < a.favorited_at ? -1 : 0
    ) || a.title.localeCompare(b.title))
  })

  async function loadTeamspaces(force = false) {
    if (teamspacesLoading.value) return
    if (!force && teamspaces.value.length > 0) return
    teamspacesLoading.value = true
    teamspacesError.value = null
    try {
      teamspaces.value = await documentsListTeamspaces()
    } catch (e) {
      teamspacesError.value = e instanceof Error ? e.message : 'Failed to load teamspaces'
    } finally {
      teamspacesLoading.value = false
    }
  }

  async function loadSidebar(force = false) {
    if (sidebarLoading.value) return
    if (!force && sidebarTeamspaces.value.length > 0) return
    sidebarLoading.value = true
    sidebarError.value = null
    try {
      sidebarTeamspaces.value = await documentsListSidebar()
    } catch (e) {
      sidebarError.value = e instanceof Error ? e.message : 'Failed to load documents sidebar'
    } finally {
      sidebarLoading.value = false
    }
  }

  async function loadUsers() {
    if (usersLoaded.value || usersLoading.value) return
    usersLoading.value = true
    try {
      users.value = await tasksListUsers()
      const chatStore = useChatStore()
      for (const user of users.value) {
        chatStore.registerUserIdentity(
          user.id,
          user.display_name,
          user.email,
          user.avatar_url ?? '',
          userCustomStatusFromDto(user.custom_status),
        )
      }
      usersLoaded.value = true
    } finally {
      usersLoading.value = false
    }
  }

  async function selectDocument(id: string, forceRefresh = false) {
    if (!forceRefresh && selectedDocument.value?.id === id) return
    const requestKey = `${Date.now()}:${id}`
    selectedDocumentRequestKey.value = requestKey
    documentLoading.value = true
    documentError.value = null
    try {
      const documentItem = await documentsGetDocument(id)
      if (selectedDocumentRequestKey.value !== requestKey) return
      selectedDocument.value = documentItem
    } catch (e) {
      if (selectedDocumentRequestKey.value !== requestKey) return
      selectedDocument.value = null
      documentError.value = e instanceof Error ? e.message : 'Failed to load document'
    } finally {
      if (selectedDocumentRequestKey.value === requestKey) {
        documentLoading.value = false
      }
    }
  }

  function clearSelectedDocument() {
    selectedDocumentRequestKey.value = ''
    selectedDocumentContentRequestKey.value = ''
    selectedDocument.value = null
    documentLoading.value = false
    documentError.value = null
  }

  function setSearchQuery(query: string) {
    searchQuery.value = query
  }

  function clearSearch() {
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer)
      searchDebounceTimer = null
    }
    searchRequestKey.value = ''
    searchQuery.value = ''
    searchResults.value = []
    searchLoading.value = false
    searchError.value = null
  }

  async function loadSearchResults(query = searchQuery.value) {
    const trimmedQuery = query.trim()
    if (!trimmedQuery) {
      searchResults.value = []
      searchLoading.value = false
      searchError.value = null
      searchRequestKey.value = ''
      return
    }

    const requestKey = `${Date.now()}:${trimmedQuery}`
    searchRequestKey.value = requestKey
    searchLoading.value = true
    searchError.value = null
    try {
      const results = await documentsSearchDocuments(trimmedQuery)
      if (searchRequestKey.value !== requestKey) return
      searchResults.value = results
    } catch (e) {
      if (searchRequestKey.value !== requestKey) return
      searchResults.value = []
      searchError.value = e instanceof Error ? e.message : 'Failed to search documents'
    } finally {
      if (searchRequestKey.value === requestKey) {
        searchLoading.value = false
      }
    }
  }

  function scheduleSearch(query: string, delayMs = 250) {
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer)
      searchDebounceTimer = null
    }
    if (!query.trim()) {
      searchResults.value = []
      searchLoading.value = false
      searchError.value = null
      searchRequestKey.value = ''
      return
    }
    searchLoading.value = true
    searchError.value = null
    searchDebounceTimer = setTimeout(() => {
      searchDebounceTimer = null
      void loadSearchResults(query)
    }, delayMs)
  }

  function pruneDocumentTree(
    nodes: SidebarDocumentNode[] | null | undefined,
    deletedDocumentId: string,
  ): SidebarDocumentNode[] {
    if (!Array.isArray(nodes)) return []
    return nodes.flatMap((node) => {
      if (node.id === deletedDocumentId) return []
      return [{
        ...node,
        children: pruneDocumentTree(node.children, deletedDocumentId),
      }]
    })
  }

  function removeDocumentFromSidebar(deletedDocumentId: string) {
    sidebarTeamspaces.value = sidebarTeamspaces.value.map(teamspace => ({
      ...teamspace,
      documents: pruneDocumentTree(teamspace.documents, deletedDocumentId),
    }))
  }

  function collectFavoriteDocuments(
    nodes: SidebarDocumentNode[] | null | undefined,
    ancestors: string[],
  ): FavoriteSidebarDocument[] {
    if (!Array.isArray(nodes)) return []
    return nodes.flatMap((node) => {
      const childFavorites = collectFavoriteDocuments(node.children, [...ancestors, node.id])
      if (!node.is_favorite || !node.favorited_at) return childFavorites
      return [
        {
          id: node.id,
          teamspace_id: node.teamspace_id,
          title: node.title,
          favorited_at: node.favorited_at,
          ancestor_document_ids: ancestors,
        },
        ...childFavorites,
      ]
    })
  }

  function updateDocumentFavoriteInTree(
    nodes: SidebarDocumentNode[] | null | undefined,
    documentId: string,
    favorite: DocumentFavoriteResponse,
  ): SidebarDocumentNode[] | null | undefined {
    if (!Array.isArray(nodes)) return nodes
    let changed = false
    const result = nodes.map((node) => {
      if (node.id === documentId) {
        changed = true
        return {
          ...node,
          is_favorite: favorite.is_favorite,
          favorited_at: favorite.favorited_at ?? null,
        }
      }
      const children = updateDocumentFavoriteInTree(node.children, documentId, favorite)
      if (children === node.children) return node
      changed = true
      return {
        ...node,
        children: Array.isArray(children) ? children : [],
      }
    })
    return changed ? result : nodes
  }

  function applyDocumentFavorite(favorite: DocumentFavoriteResponse) {
    sidebarTeamspaces.value = sidebarTeamspaces.value.map((teamspace) => {
      const documents = updateDocumentFavoriteInTree(teamspace.documents, favorite.document_id, favorite)
      if (documents === teamspace.documents) return teamspace
      return { ...teamspace, documents: Array.isArray(documents) ? documents : [] }
    })
  }

  function documentToSidebarNode(documentItem: DocumentItem): SidebarDocumentNode {
    return {
      id: documentItem.id,
      teamspace_id: documentItem.teamspace_id,
      parent_document_id: documentItem.parent_document_id,
      title: documentItem.title,
      is_favorite: false,
      favorited_at: null,
      children: [],
    }
  }

  function appendDocumentNode(
    nodes: SidebarDocumentNode[] | null | undefined,
    parentDocumentId: string,
    newNode: SidebarDocumentNode,
  ): SidebarDocumentNode[] {
    if (!Array.isArray(nodes)) return []
    return nodes.map((node) => {
      if (node.id === parentDocumentId) {
        return {
          ...node,
          children: [...(Array.isArray(node.children) ? node.children : []), newNode],
        }
      }
      return {
        ...node,
        children: appendDocumentNode(node.children, parentDocumentId, newNode),
      }
    })
  }

  function addDocumentToSidebar(documentItem: DocumentItem) {
    const newNode = documentToSidebarNode(documentItem)
    sidebarTeamspaces.value = sidebarTeamspaces.value.map((teamspace) => {
      if (teamspace.id !== documentItem.teamspace_id) return teamspace
      if (!documentItem.parent_document_id) {
        return {
          ...teamspace,
          documents: [...(Array.isArray(teamspace.documents) ? teamspace.documents : []), newNode],
        }
      }
      return {
        ...teamspace,
        documents: appendDocumentNode(teamspace.documents, documentItem.parent_document_id, newNode),
      }
    })
  }

  async function createTeamspace(payload: UpsertTeamspacePayload) {
    const row = await documentsCreateTeamspace(payload)
    await Promise.all([loadTeamspaces(true), loadSidebar(true)])
    return row
  }

  async function updateTeamspace(id: string, payload: UpsertTeamspacePayload) {
    const row = await documentsUpdateTeamspace(id, payload)
    await Promise.all([loadTeamspaces(true), loadSidebar(true)])
    return row
  }

  async function deleteTeamspace(id: string) {
    await documentsDeleteTeamspace(id)
    if (selectedDocument.value?.teamspace_id === id) {
      clearSelectedDocument()
    }
    await Promise.all([loadTeamspaces(true), loadSidebar(true)])
  }

  async function joinTeamspace(id: string) {
    const row = await documentsJoinTeamspace(id)
    await Promise.all([loadTeamspaces(true), loadSidebar(true)])
    return row
  }

  async function createDocument(payload: CreateDocumentPayload) {
    const row = await documentsCreateDocument(payload)
    selectedDocument.value = row
    addDocumentToSidebar(row)
    return row
  }

  async function updateDocument(id: string, payload: UpdateDocumentPayload) {
    const row = await documentsUpdateDocument(id, payload)
    if (selectedDocument.value?.id === id) {
      selectedDocument.value = row
    }
    await loadSidebar(true)
    return row
  }

  async function updateDocumentContent(id: string, payload: UpdateDocumentContentPayload) {
    const requestKey = `${Date.now()}:${id}`
    selectedDocumentContentRequestKey.value = requestKey
    const row = await documentsUpdateDocumentContent(id, payload)
    if (selectedDocumentContentRequestKey.value === requestKey && selectedDocument.value?.id === id) {
      selectedDocument.value = row
    }
    return row
  }

  async function deleteDocument(id: string) {
    await documentsDeleteDocument(id)
    if (selectedDocument.value?.id === id) {
      clearSelectedDocument()
    }
    removeDocumentFromSidebar(id)
  }

  async function favoriteDocument(id: string) {
    const row = await documentsFavoriteDocument(id)
    applyDocumentFavorite(row)
    return row
  }

  async function unfavoriteDocument(id: string) {
    const row = await documentsUnfavoriteDocument(id)
    applyDocumentFavorite(row)
    return row
  }

  async function loadDocumentHistory(id: string): Promise<DocumentHistoryItem[]> {
    return documentsListDocumentHistory(id)
  }

  return {
    teamspaces,
    teamspacesLoading,
    teamspacesError,
    sidebarTeamspaces,
    sidebarLoading,
    sidebarError,
    selectedDocument,
    documentLoading,
    documentError,
    users,
    usersLoaded,
    memberTeamspaces,
    favoriteDocuments,
    searchQuery,
    searchResults,
    searchLoading,
    searchError,
    loadTeamspaces,
    loadSidebar,
    loadUsers,
    selectDocument,
    clearSelectedDocument,
    setSearchQuery,
    clearSearch,
    loadSearchResults,
    scheduleSearch,
    createTeamspace,
    updateTeamspace,
    deleteTeamspace,
    joinTeamspace,
    createDocument,
    updateDocument,
    updateDocumentContent,
    deleteDocument,
    favoriteDocument,
    unfavoriteDocument,
    loadDocumentHistory,
  }
})
