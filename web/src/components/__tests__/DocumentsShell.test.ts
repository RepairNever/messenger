import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import DocumentsShell from '@/components/documents/DocumentsShell.vue'
import { reactive } from 'vue'

const documentsStoreMock = reactive({ selectedDocument: null as null | { id: string; kind?: 'markdown' | 'spreadsheet' } })
vi.mock('@/stores/documents', () => ({ useDocumentsStore: () => documentsStoreMock }))

vi.mock('@/components/ResizableSidebar.vue', () => ({
  default: {
    template: '<div data-testid="resizable-sidebar"><slot /></div>',
  },
}))

vi.mock('@/components/documents/DocumentsSidebar.vue', () => ({
  default: {
    template: '<aside data-testid="documents-sidebar" />',
  },
}))

vi.mock('@/components/documents/TeamspacesView.vue', () => ({
  default: {
    template: '<section data-testid="teamspaces-view" />',
  },
}))

vi.mock('@/components/documents/DocumentCard.vue', () => ({
  default: {
    template: '<section data-testid="document-card" />',
  },
}))

vi.mock('@/components/documents/DocumentSearchView.vue', () => ({
  default: {
    template: '<section data-testid="documents-search-view" />',
  },
}))

vi.mock('@/components/documents/SpreadsheetDocumentCard.vue', () => ({
  default: { template: '<section data-testid="spreadsheet-document-card" />' },
}))

describe('DocumentsShell', () => {
  it('selects the spreadsheet card and keeps legacy documents on the Markdown card', async () => {
    documentsStoreMock.selectedDocument = { id: 'sheet-1', kind: 'spreadsheet' }
    const wrapper = mount(DocumentsShell, {
      props: { sidebarCollapsed: true, selectedTeamspaceId: 'teamspace-1', selectedDocumentId: 'sheet-1', searchQuery: '', viewMode: 'card' },
    })
    expect(wrapper.find('[data-testid="spreadsheet-document-card"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="document-card"]').exists()).toBe(false)

    documentsStoreMock.selectedDocument = { id: 'legacy-document' }
    await wrapper.setProps({ selectedDocumentId: 'legacy-document' })
    expect(wrapper.find('[data-testid="document-card"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="spreadsheet-document-card"]').exists()).toBe(false)
    wrapper.unmount()
    documentsStoreMock.selectedDocument = null
  })
  it('renders the sidebar when not collapsed', () => {
    const wrapper = mount(DocumentsShell, {
      props: {
        sidebarCollapsed: false,
        selectedTeamspaceId: null,
        selectedDocumentId: null,
        searchQuery: '',
        viewMode: 'teamspaces',
      },
    })

    expect(wrapper.find('[data-testid="resizable-sidebar"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="documents-sidebar"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="teamspaces-view"]').exists()).toBe(true)
  })

  it('hides the sidebar and keeps content visible when collapsed', () => {
    const wrapper = mount(DocumentsShell, {
      props: {
        sidebarCollapsed: true,
        selectedTeamspaceId: 'teamspace-1',
        selectedDocumentId: null,
        searchQuery: 'spec',
        viewMode: 'search',
      },
    })

    expect(wrapper.find('[data-testid="resizable-sidebar"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="documents-sidebar"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="documents-search-view"]').exists()).toBe(true)
  })
})
