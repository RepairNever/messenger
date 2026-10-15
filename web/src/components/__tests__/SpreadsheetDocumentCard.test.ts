import { reactive } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentItem } from '@/services/http/documentsApi'
import SpreadsheetDocumentCard from '@/components/documents/SpreadsheetDocumentCard.vue'
import DocumentSearchView from '@/components/documents/DocumentSearchView.vue'

const documentsStoreMock = reactive({
  selectedDocument: null as DocumentItem | null,
  documentLoading: false,
  documentError: null as string | null,
  sidebarTeamspaces: [] as any[],
  favoriteDocuments: [] as any[],
  searchResults: [] as any[],
  searchLoading: false,
  searchError: null as string | null,
  renameDocument: vi.fn(),
  favoriteDocument: vi.fn(),
  unfavoriteDocument: vi.fn(),
  updateDocumentContent: vi.fn(),
  loadDocumentHistory: vi.fn(),
})
const collabMock = vi.hoisted(() => vi.fn())
vi.mock('@/stores/documents', () => ({ useDocumentsStore: () => documentsStoreMock }))
vi.mock('@/composables/useDocumentContentCollab', () => ({ useDocumentContentCollab: collabMock }))
vi.mock('@/components/documents/SpreadsheetEditor.vue', () => ({
  default: { props: ['documentId'], template: '<div data-testid="spreadsheet-editor-stub" :data-document-id="documentId" />' },
}))

function sheet(id = 'sheet-1'): DocumentItem {
  return { id, kind: 'spreadsheet', title: 'Budget', teamspace_id: 'teamspace-1', teamspace_name: 'Alpha', parent_document_id: 'parent-1', parent_title: 'Projects', content_markdown: null, created_by: 'u-1', updated_by: 'u-1', created_at: '2026-10-08T00:00:00Z', updated_at: '2026-10-08T00:00:00Z' }
}
const wrappers: VueWrapper[] = []
function mountCard() {
  const wrapper = mount(SpreadsheetDocumentCard)
  wrappers.push(wrapper)
  return wrapper
}

describe('spreadsheet document metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    documentsStoreMock.selectedDocument = sheet()
    documentsStoreMock.documentLoading = false
    documentsStoreMock.documentError = null
    documentsStoreMock.sidebarTeamspaces = []
    documentsStoreMock.favoriteDocuments = []
    documentsStoreMock.searchResults = []
    documentsStoreMock.searchError = null
    documentsStoreMock.searchLoading = false
    documentsStoreMock.renameDocument.mockImplementation(async (id: string, title: string) => {
      if (documentsStoreMock.selectedDocument?.id === id) documentsStoreMock.selectedDocument.title = title
    })
    documentsStoreMock.favoriteDocument.mockImplementation(async (id: string) => { documentsStoreMock.favoriteDocuments = [{ id, kind: 'spreadsheet' }] })
    documentsStoreMock.unfavoriteDocument.mockImplementation(async () => { documentsStoreMock.favoriteDocuments = [] })
  })
  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  })

  it('loads the workbook editor with the selected ID without Markdown lifecycle or actions', async () => {
    const wrapper = mountCard()
    await vi.dynamicImportSettled()
    await flushPromises()
    expect(wrapper.get('[data-testid="spreadsheet-editor-stub"]').attributes('data-document-id')).toBe('sheet-1')
    expect(wrapper.find('[data-testid="document-export-pdf"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="documents-history-button"]').exists()).toBe(false)
    expect(collabMock).not.toHaveBeenCalled()
    expect(documentsStoreMock.updateDocumentContent).not.toHaveBeenCalled()
    expect(documentsStoreMock.loadDocumentHistory).not.toHaveBeenCalled()
    await wrapper.get('[data-testid="spreadsheet-document-breadcrumb"] button').trigger('click')
    expect(wrapper.emitted('openParent')).toEqual([['parent-1']])
  })

  it('renames only the metadata and toggles existing favorite endpoints', async () => {
    const wrapper = mountCard()
    await wrapper.get('[data-testid="spreadsheet-edit-title"]').trigger('click')
    await wrapper.get('[data-testid="spreadsheet-title-input"]').setValue('Forecast')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(documentsStoreMock.renameDocument).toHaveBeenCalledWith('sheet-1', 'Forecast')
    expect(wrapper.get('h1').text()).toBe('Forecast')
    await wrapper.get('[data-testid="spreadsheet-favorite-toggle"]').trigger('click')
    await flushPromises()
    expect(documentsStoreMock.favoriteDocument).toHaveBeenCalledWith('sheet-1')
    expect(wrapper.get('[data-testid="spreadsheet-favorite-toggle"]').attributes('aria-pressed')).toBe('true')
    await wrapper.get('[data-testid="spreadsheet-favorite-toggle"]').trigger('click')
    await flushPromises()
    expect(documentsStoreMock.unfavoriteDocument).toHaveBeenCalledWith('sheet-1')
    expect(documentsStoreMock.updateDocumentContent).not.toHaveBeenCalled()
  })

  it('retains the title draft when a metadata save fails', async () => {
    documentsStoreMock.renameDocument.mockRejectedValueOnce(new Error('Permission denied'))
    const wrapper = mountCard()
    await wrapper.get('[data-testid="spreadsheet-edit-title"]').trigger('click')
    await wrapper.get('[data-testid="spreadsheet-title-input"]').setValue('Draft title')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe('Permission denied')
    expect((wrapper.get('[data-testid="spreadsheet-title-input"]').element as HTMLInputElement).value).toBe('Draft title')
    expect((wrapper.get('[data-testid="spreadsheet-title-input"]').element as HTMLInputElement).disabled).toBe(false)
  })

  it('discards an old title-save error after leaving and returning to a spreadsheet', async () => {
    let rejectSave!: (reason: Error) => void
    documentsStoreMock.renameDocument.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSave = reject }))
    const wrapper = mountCard()
    await wrapper.get('[data-testid="spreadsheet-edit-title"]').trigger('click')
    await wrapper.get('[data-testid="spreadsheet-title-input"]').setValue('Old draft')
    await wrapper.get('form').trigger('submit')
    documentsStoreMock.selectedDocument = sheet('sheet-2')
    await flushPromises()
    documentsStoreMock.selectedDocument = sheet('sheet-1')
    await flushPromises()
    rejectSave(new Error('Old request failed'))
    await flushPromises()
    expect(wrapper.text()).not.toContain('Old request failed')
    expect(wrapper.find('[data-testid="spreadsheet-title-input"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="spreadsheet-editor-stub"]').attributes('data-document-id')).toBe('sheet-1')
  })

  it('displays metadata loading and error states before mounting an editor', async () => {
    documentsStoreMock.documentLoading = true
    const wrapper = mountCard()
    expect(wrapper.find('[data-testid="spreadsheet-editor-stub"]').exists()).toBe(false)
    documentsStoreMock.documentLoading = false
    documentsStoreMock.documentError = 'Access revoked'
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe('Access revoked')
    expect(wrapper.find('[data-testid="spreadsheet-editor-stub"]').exists()).toBe(false)
  })

  it('identifies spreadsheet search results and opens the shared document route', async () => {
    documentsStoreMock.searchResults = [{ id: 'sheet-1', title: 'Budget', kind: 'spreadsheet', teamspace_name: 'Alpha', snippet: '' }, { id: 'legacy-1', title: 'Notes', teamspace_name: 'Alpha', snippet: 'Text' }]
    const wrapper = mount(DocumentSearchView, { props: { query: 'Budget' } })
    wrappers.push(wrapper)
    expect(wrapper.get('[data-testid="document-search-result-sheet-1"]').find('[data-document-kind="spreadsheet"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="document-search-result-legacy-1"]').find('[data-document-kind="markdown"]').exists()).toBe(true)
    await wrapper.get('[data-testid="document-search-result-sheet-1"]').trigger('click')
    expect(wrapper.emitted('openDocument')).toEqual([['sheet-1']])
  })
})
