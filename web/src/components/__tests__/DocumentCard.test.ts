import { reactive } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DocumentCard from '@/components/documents/DocumentCard.vue'
import type { DocumentHistoryItem } from '@/services/http/documentsApi'

const platformMocks = vi.hoisted(() => ({
  getPlatformOrNull: vi.fn(),
  initPlatform: vi.fn(),
  exportDocumentToPdfBlob: vi.fn(),
  buildDocumentPdfFileName: vi.fn(),
}))

const documentsStoreMock = reactive({
  selectedDocument: null as null | {
    id: string
    teamspace_id: string
    teamspace_name: string
    parent_document_id: string | null
    parent_title: string | null
    title: string
    content_markdown: string | null
    created_by: string
    updated_by: string
    created_at: string
    updated_at: string
  },
  documentLoading: false,
  documentError: null as string | null,
  sidebarTeamspaces: [] as Array<{
    id: string
    name: string
    documents: Array<{
      id: string
      teamspace_id: string
      parent_document_id: string | null
      title: string
      children: any[]
    }>
  }>,
  loadDocumentHistory: vi.fn(async (): Promise<DocumentHistoryItem[]> => []),
  updateDocument: vi.fn(),
  updateDocumentContent: vi.fn(),
})

const authStoreMock = reactive({
  user: {
    id: 'u-1',
    email: 'user@example.com',
    displayName: 'Doc User',
  },
})

const collabMock = {
  doc: { value: null },
  provider: { value: null },
  subscribeError: { value: null as string | null },
  serverMarkdown: { value: null as string | null },
  allowLocalDraftSeed: { value: true },
  restart: vi.fn(),
}

vi.mock('@/stores/documents', () => ({
  useDocumentsStore: () => documentsStoreMock,
}))

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => authStoreMock,
}))

vi.mock('@/platform', () => ({
  getPlatformOrNull: platformMocks.getPlatformOrNull,
  initPlatform: platformMocks.initPlatform,
}))

vi.mock('@/services/taskPdfExport', () => ({
  exportDocumentToPdfBlob: platformMocks.exportDocumentToPdfBlob,
  buildDocumentPdfFileName: platformMocks.buildDocumentPdfFileName,
}))

vi.mock('@/composables/useDocumentContentCollab', () => ({
  useDocumentContentCollab: () => collabMock,
}))

function buildDocumentRow(overrides: Partial<NonNullable<typeof documentsStoreMock.selectedDocument>> = {}) {
  return {
    id: 'doc-3',
    teamspace_id: 'teamspace-1',
    teamspace_name: 'Alpha',
    parent_document_id: 'doc-2',
    parent_title: 'Section',
    title: 'Design doc',
    content_markdown: 'Body',
    created_by: 'u-1',
    updated_by: 'u-1',
    created_at: '2026-03-10T12:00:00Z',
    updated_at: '2026-03-10T12:00:00Z',
    ...overrides,
  }
}

function editorStub() {
  return {
    props: ['modelValue'],
    emits: ['update:modelValue', 'blur'],
    template: `
      <textarea
        data-testid="document-content-stub"
        :value="modelValue"
        @input="$emit('update:modelValue', $event.target.value)"
        @blur="$emit('blur')"
      />
    `,
  }
}

describe('DocumentCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()

    const platform = {
      files: {
        saveBlob: vi.fn(async () => ({ saved: true })),
      },
    }
    platformMocks.getPlatformOrNull.mockReturnValue(platform)
    platformMocks.initPlatform.mockResolvedValue(platform)
    platformMocks.exportDocumentToPdfBlob.mockResolvedValue(new Blob(['pdf'], { type: 'application/pdf' }))
    platformMocks.buildDocumentPdfFileName.mockReturnValue('Design doc.pdf')

    collabMock.doc.value = null
    collabMock.provider.value = null
    collabMock.subscribeError.value = null
    collabMock.serverMarkdown.value = null
    collabMock.allowLocalDraftSeed.value = true

    documentsStoreMock.selectedDocument = buildDocumentRow()
    documentsStoreMock.updateDocument.mockImplementation(async (id: string, payload: Record<string, unknown>) => {
      const row = buildDocumentRow({
        id,
        title: (payload.title as string) ?? documentsStoreMock.selectedDocument?.title ?? 'Design doc',
        content_markdown: (payload.content_markdown as string | null | undefined)
          ?? documentsStoreMock.selectedDocument?.content_markdown
          ?? 'Body',
      })
      documentsStoreMock.selectedDocument = row
      return row
    })
    documentsStoreMock.updateDocumentContent.mockImplementation(async (id: string, payload: Record<string, unknown>) => {
      const row = buildDocumentRow({
        id,
        title: documentsStoreMock.selectedDocument?.title ?? 'Design doc',
        content_markdown: (payload.content_markdown as string | null),
      })
      documentsStoreMock.selectedDocument = row
      return row
    })
    documentsStoreMock.loadDocumentHistory.mockResolvedValue([])
    documentsStoreMock.sidebarTeamspaces = [
      {
        id: 'teamspace-1',
        name: 'Alpha',
        documents: [
          {
            id: 'doc-1',
            teamspace_id: 'teamspace-1',
            parent_document_id: null,
            title: 'Projects',
            children: [
              {
                id: 'doc-2',
                teamspace_id: 'teamspace-1',
                parent_document_id: 'doc-1',
                title: 'Section',
                children: [
                  {
                    id: 'doc-3',
                    teamspace_id: 'teamspace-1',
                    parent_document_id: 'doc-2',
                    title: 'Design doc',
                    children: [],
                  },
                ],
              },
            ],
          },
        ],
      },
    ]
  })

  it('shows the full teamspace-to-document breadcrumb in the header', async () => {
    const wrapper = mount(DocumentCard, {
      global: {
        stubs: {
          TaskDescriptionEditor: true,
          UserAvatar: true,
          Teleport: true,
        },
      },
    })
    await flushPromises()

    const breadcrumb = wrapper.get('[data-testid="document-breadcrumb"]')
    expect(breadcrumb.text()).toContain('Alpha')
    expect(breadcrumb.text()).toContain('Projects')
    expect(breadcrumb.text()).toContain('Section')
    expect(breadcrumb.text()).toContain('Design doc')
  })

  it('exports the current document to PDF through the platform adapter', async () => {
    const wrapper = mount(DocumentCard, {
      global: {
        stubs: {
          UserAvatar: true,
          Teleport: true,
          TaskDescriptionEditor: editorStub(),
        },
      },
    })
    await flushPromises()

    await wrapper.get('[data-testid="document-content-stub"]').setValue('## Updated content')
    await wrapper.get('[data-testid="document-export-pdf"]').trigger('click')
    await flushPromises()

    expect(platformMocks.exportDocumentToPdfBlob).toHaveBeenCalledWith({
      title: 'Design doc',
      content_markdown: '## Updated content',
    })
    const platform = platformMocks.getPlatformOrNull.mock.results[0]?.value
    expect(platform.files.saveBlob).toHaveBeenCalledWith(expect.objectContaining({
      suggestedName: 'Design doc.pdf',
      mimeType: 'application/pdf',
    }))
  })

  it('keeps the local body draft when a title-only save refreshes the selected document', async () => {
    documentsStoreMock.updateDocument.mockImplementationOnce(async (id: string, payload: Record<string, unknown>) => {
      const row = buildDocumentRow({
        id,
        title: (payload.title as string) ?? 'Renamed doc',
        content_markdown: 'Body',
      })
      documentsStoreMock.selectedDocument = row
      return row
    })

    const wrapper = mount(DocumentCard, {
      global: {
        stubs: {
          UserAvatar: true,
          Teleport: true,
          TaskDescriptionEditor: editorStub(),
        },
      },
    })
    await flushPromises()

    await wrapper.get('[data-testid="document-content-stub"]').setValue('## Local draft')
    await wrapper.get('button[title="Edit title"]').trigger('click')
    const titleInput = wrapper.get('input[type="text"]')
    await titleInput.setValue('Renamed doc')
    await titleInput.trigger('blur')
    await flushPromises()

    expect(documentsStoreMock.updateDocument).toHaveBeenCalledWith('doc-3', { title: 'Renamed doc' })
    expect((wrapper.get('[data-testid="document-content-stub"]').element as HTMLTextAreaElement).value).toBe('## Local draft')
  })

  it('autosaves body edits through the content-only endpoint', async () => {
    vi.useFakeTimers()
    const wrapper = mount(DocumentCard, {
      global: {
        stubs: {
          UserAvatar: true,
          Teleport: true,
          TaskDescriptionEditor: editorStub(),
        },
      },
    })
    await flushPromises()

    await wrapper.get('[data-testid="document-content-stub"]').setValue('## Draft body')
    await vi.advanceTimersByTimeAsync(850)
    await flushPromises()

    expect(documentsStoreMock.updateDocumentContent).toHaveBeenCalledWith('doc-3', {
      content_markdown: '## Draft body',
    })
    expect(documentsStoreMock.updateDocument).not.toHaveBeenCalled()
  })

  it('restores history through the content-only endpoint and preserves the current title', async () => {
    documentsStoreMock.loadDocumentHistory.mockResolvedValueOnce([
      {
        title: 'Older title',
        content_markdown: '## Historical',
        edited_by: 'u-2',
        created_at: '2026-03-09T10:00:00Z',
        editor: {
          id: 'u-2',
          display_name: 'Editor',
          avatar_url: '',
        },
      },
    ])

    const wrapper = mount(DocumentCard, {
      attachTo: document.body,
      global: {
        stubs: {
          UserAvatar: true,
          Teleport: false,
          TaskDescriptionEditor: editorStub(),
        },
      },
    })
    await flushPromises()

    await wrapper.get('[data-testid="documents-history-button"]').trigger('click')
    await flushPromises()
    const applyButton = Array.from(document.body.querySelectorAll('button')).find(
      button => button.textContent?.includes('Apply'),
    ) as HTMLButtonElement | undefined
    expect(applyButton).toBeTruthy()
    applyButton?.click()
    await flushPromises()

    expect(documentsStoreMock.updateDocumentContent).toHaveBeenCalledWith('doc-3', {
      content_markdown: '## Historical',
      force_snapshot: true,
    })
    expect(documentsStoreMock.updateDocument).not.toHaveBeenCalledWith('doc-3', expect.objectContaining({ title: 'Older title' }))
    expect(collabMock.restart).toHaveBeenCalled()
  })
})
