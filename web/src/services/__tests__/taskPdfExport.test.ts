import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchOwnedAttachmentBlob } from '@/services/http/attachmentOwnersApi'
import {
  buildDocumentPdfExportDocument,
  buildDocumentPdfFileName,
  buildMarkdownPdfExportDocument,
  buildTaskPdfExportDocument,
  buildTaskPdfFileName,
  chooseNearestWhitespaceRow,
} from '@/services/taskPdfExport'

vi.mock('@/services/http/attachmentOwnersApi', () => ({
  fetchOwnedAttachmentBlob: vi.fn(),
}))

describe('taskPdfExport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('builds the expected PDF filename', () => {
    expect(buildTaskPdfFileName({ public_id: 'TASK-1' })).toBe('TASK-1.pdf')
  })

  it('builds the expected document PDF filename', () => {
    expect(buildDocumentPdfFileName({ title: 'Design / spec: v1?' })).toBe('Design spec v1.pdf')
  })

  it('renders markdown blocks into export html', async () => {
    const documentModel = await buildTaskPdfExportDocument({
      public_id: 'TASK-1',
      title: 'Initial title',
      description: '## Heading\n\nBody paragraph',
    })

    expect(documentModel.header).toBe('TASK-1 Initial title')
    expect(documentModel.blocks).toEqual([
      expect.objectContaining({
        kind: 'markdown',
        html: expect.stringContaining('<h2>Heading</h2>'),
      }),
    ])
  })

  it('embeds inline image attachments in the export model', async () => {
    vi.mocked(fetchOwnedAttachmentBlob).mockResolvedValue(new Blob(['image-bytes'], { type: 'image/png' }))

    const documentModel = await buildTaskPdfExportDocument({
      public_id: 'TASK-1',
      title: 'Initial title',
      description: '![Photo.png](msgnr-attachment://task/task-1/att-image)',
    })

    expect(fetchOwnedAttachmentBlob).toHaveBeenCalledWith('task', 'task-1', 'att-image')
    expect(documentModel.blocks).toEqual([
      expect.objectContaining({
        kind: 'image',
        fileName: 'Photo.png',
        src: expect.stringContaining('data:image/png;base64,'),
      }),
    ])
  })

  it('lists file attachments without treating them as inline images', async () => {
    const documentModel = await buildTaskPdfExportDocument({
      public_id: 'TASK-1',
      title: 'Initial title',
      description: '[Spec.pdf](msgnr-attachment://document/doc-1/att-file)',
    })

    expect(fetchOwnedAttachmentBlob).not.toHaveBeenCalled()
    expect(documentModel.blocks).toEqual([
      {
        kind: 'file',
        fileName: 'Spec.pdf',
      },
    ])
  })

  it('builds a generic markdown PDF document', async () => {
    const documentModel = await buildMarkdownPdfExportDocument({
      fileName: 'doc.pdf',
      header: 'Document title',
      markdown: 'Paragraph',
    })

    expect(documentModel.fileName).toBe('doc.pdf')
    expect(documentModel.header).toBe('Document title')
    expect(documentModel.blocks).toEqual([
      expect.objectContaining({
        kind: 'markdown',
        html: expect.stringContaining('<p>Paragraph</p>'),
      }),
    ])
  })

  it('renders document markdown into the shared export model', async () => {
    const documentModel = await buildDocumentPdfExportDocument({
      title: 'Design doc',
      content_markdown: '## Heading\n\nBody paragraph',
    })

    expect(documentModel.fileName).toBe('Design doc.pdf')
    expect(documentModel.header).toBe('Design doc')
    expect(documentModel.blocks).toEqual([
      expect.objectContaining({
        kind: 'markdown',
        html: expect.stringContaining('<h2>Heading</h2>'),
      }),
    ])
  })

  it('chooses a nearby whitespace row for page breaks', () => {
    const rowInkScores = [80, 80, 80, 8, 0, 7, 90, 90]
    expect(chooseNearestWhitespaceRow(rowInkScores, 5, 2, 6)).toBe(4)
  })

  it('falls back to the closest row when no cleaner break exists', () => {
    const rowInkScores = [100, 100, 100, 100, 100]
    expect(chooseNearestWhitespaceRow(rowInkScores, 2, 1, 4)).toBe(2)
  })
})
