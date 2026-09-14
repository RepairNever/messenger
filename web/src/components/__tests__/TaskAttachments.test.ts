import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import TaskAttachments from '@/components/tasks/TaskAttachments.vue'
import { tasksListAttachments, tasksUploadAttachments } from '@/services/http/tasksApi'

vi.mock('@/services/http/tasksApi', () => ({
  tasksListAttachments: vi.fn(),
  tasksUploadAttachment: vi.fn(),
  tasksUploadAttachments: vi.fn(),
  tasksDeleteAttachment: vi.fn(),
  tasksDownloadAttachment: vi.fn(),
}))

vi.mock('@/services/http/client', () => ({
  createAuthenticatedClient: vi.fn(() => ({
    get: vi.fn(),
  })),
}))

describe('TaskAttachments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(tasksListAttachments).mockResolvedValue([])
  })

  it('uploads files dropped on the attachment area', async () => {
    const file = new File(['png'], 'photo.png', { type: 'image/png' })
    vi.mocked(tasksUploadAttachments).mockResolvedValue({
      attachments: [{
        id: 'att-1',
        task_id: 'task-1',
        file_name: 'photo.png',
        file_size: 3,
        mime_type: 'image/png',
        uploaded_by: 'user-1',
        created_at: '2026-03-11T00:00:00Z',
      }],
      errors: [],
    })

    const wrapper = mount(TaskAttachments, {
      props: { taskId: 'task-1' },
    })
    await wrapper.vm.$nextTick()

    await wrapper.get('[data-testid="task-attachments-dropzone"]').trigger('drop', {
      dataTransfer: {
        files: [file],
        types: ['Files'],
      },
    })
    await wrapper.vm.$nextTick()

    expect(tasksUploadAttachments).toHaveBeenCalledWith('task-1', [file])
    expect(wrapper.text()).toContain('photo.png')
  })

  it('ignores drops that are not file drags', async () => {
    const file = new File(['txt'], 'notes.txt', { type: 'text/plain' })
    const wrapper = mount(TaskAttachments, {
      props: { taskId: 'task-1' },
    })
    await wrapper.vm.$nextTick()

    await wrapper.get('[data-testid="task-attachments-dropzone"]').trigger('drop', {
      dataTransfer: {
        files: [file],
        types: ['text/plain'],
      },
    })

    expect(tasksUploadAttachments).not.toHaveBeenCalled()
  })
})
