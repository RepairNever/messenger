-- name: CreateStagedMessageAttachment :one
INSERT INTO message_attachment (
  id,
  conversation_id,
  message_id,
  file_name,
  file_size,
  mime_type,
  storage_key,
  thumbnail_storage_key,
  thumbnail_mime_type,
  thumbnail_file_size,
  thumbnail_version,
  uploaded_by,
  created_at
) VALUES (
  @id,
  @conversation_id,
  NULL,
  @file_name,
  @file_size,
  @mime_type,
  @storage_key,
  @thumbnail_storage_key,
  @thumbnail_mime_type,
  @thumbnail_file_size,
  @thumbnail_version,
  @uploaded_by,
  now()
)
RETURNING id, conversation_id, message_id, file_name, file_size, mime_type, storage_key,
          thumbnail_storage_key, thumbnail_mime_type, thumbnail_file_size, thumbnail_version,
          uploaded_by, created_at;

-- name: GetMessageAttachmentByID :one
SELECT id, conversation_id, message_id, file_name, file_size, mime_type, storage_key,
       thumbnail_storage_key, thumbnail_mime_type, thumbnail_file_size, thumbnail_version,
       uploaded_by, created_at
FROM message_attachment
WHERE id = @attachment_id;

-- name: DeleteStagedMessageAttachment :exec
DELETE FROM message_attachment
WHERE id = @attachment_id
  AND message_id IS NULL;
