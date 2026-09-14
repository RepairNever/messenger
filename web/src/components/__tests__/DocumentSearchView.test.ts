import { reactive } from 'vue'
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DocumentSearchView from '@/components/documents/DocumentSearchView.vue'

const documentsStoreMock = reactive({
  searchResults: [] as Array<{
    id: string
    teamspace_id: string
    teamspace_name: string
    title: string
    snippet: string
  }>,
  searchLoading: false,
  searchError: null as string | null,
})

vi.mock('@/stores/documents', () => ({
  useDocumentsStore: () => documentsStoreMock,
}))

describe('DocumentSearchView', () => {
  beforeEach(() => {
    documentsStoreMock.searchResults = []
    documentsStoreMock.searchLoading = false
    documentsStoreMock.searchError = null
  })

  it('renders search results with teamspace and snippet', () => {
    documentsStoreMock.searchResults = [
      {
        id: 'doc-1',
        teamspace_id: 'teamspace-1',
        teamspace_name: 'Alpha',
        title: 'Spec',
        snippet: 'Spec details for release readiness.',
      },
    ]

    const wrapper = mount(DocumentSearchView, {
      props: {
        query: 'spec',
      },
    })

    expect(wrapper.text()).toContain('Results for "spec"')
    expect(wrapper.text()).toContain('Spec')
    expect(wrapper.text()).toContain('Alpha')
    expect(wrapper.text()).toContain('Spec details for release readiness.')
  })

  it('emits document open when a result is clicked', async () => {
    documentsStoreMock.searchResults = [
      {
        id: 'doc-1',
        teamspace_id: 'teamspace-1',
        teamspace_name: 'Alpha',
        title: 'Spec',
        snippet: 'Spec details',
      },
    ]

    const wrapper = mount(DocumentSearchView, {
      props: {
        query: 'spec',
      },
    })

    await wrapper.get('[data-testid="document-search-result-doc-1"]').trigger('click')

    expect(wrapper.emitted('openDocument')).toEqual([['doc-1']])
  })

  it('renders loading, empty, and error states', async () => {
    const wrapper = mount(DocumentSearchView, {
      props: {
        query: 'spec',
      },
    })

    documentsStoreMock.searchLoading = true
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('Searching...')

    documentsStoreMock.searchLoading = false
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('No documents found.')

    documentsStoreMock.searchError = 'boom'
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('boom')
  })
})
