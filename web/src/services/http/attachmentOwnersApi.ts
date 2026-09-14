import {
  documentsFetchAttachmentBlob,
  documentsUploadAttachment,
  type DocumentAttachment,
} from './documentsApi'
import {
  tasksFetchAttachmentBlob,
  tasksUploadAttachments,
  type TaskAttachment,
  type TaskAttachmentUploadError,
  type TaskStagedAttachment,
} from './tasksApi'
import type { AttachmentOwnerKind } from '@/utils/attachmentMarkdown'

export type OwnedAttachmentUpload = Pick<TaskAttachment, 'id' | 'file_name' | 'mime_type'>
  | Pick<DocumentAttachment, 'id' | 'file_name' | 'mime_type'>
  | Pick<TaskStagedAttachment, 'id' | 'file_name' | 'mime_type'>

export interface OwnedAttachmentsUploadResult {
  attachments: OwnedAttachmentUpload[]
  errors: TaskAttachmentUploadError[]
}

export async function fetchOwnedAttachmentBlob(
  ownerKind: AttachmentOwnerKind,
  ownerId: string,
  attachmentId: string,
): Promise<Blob> {
  if (ownerKind === 'task') {
    return tasksFetchAttachmentBlob(ownerId, attachmentId)
  }
  return documentsFetchAttachmentBlob(ownerId, attachmentId)
}

export async function uploadOwnedAttachments(
  ownerKind: AttachmentOwnerKind,
  ownerId: string,
  files: File[],
): Promise<OwnedAttachmentsUploadResult> {
  if (ownerKind === 'task') {
    return tasksUploadAttachments(ownerId, files)
  }
  const results = await Promise.allSettled(files.map(file => documentsUploadAttachment(ownerId, file)))
  const attachments: OwnedAttachmentUpload[] = []
  const errors: TaskAttachmentUploadError[] = []
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index]
    if (result.status === 'fulfilled') {
      attachments.push(result.value)
      continue
    }
    errors.push({
      file_name: files[index].name,
      message: result.reason instanceof Error ? result.reason.message : 'Upload failed',
    })
  }
  return { attachments, errors }
}

// Compatibility helper for callers that deliberately upload one file. Task
// picker/drop flows should use uploadOwnedAttachments so their audit stays
// grouped.
export async function uploadOwnedAttachment(
  ownerKind: AttachmentOwnerKind,
  ownerId: string,
  file: File,
): Promise<OwnedAttachmentUpload> {
  const result = await uploadOwnedAttachments(ownerKind, ownerId, [file])
  if (result.attachments[0]) return result.attachments[0]
  throw new Error(result.errors[0]?.message || 'Upload failed')
}
