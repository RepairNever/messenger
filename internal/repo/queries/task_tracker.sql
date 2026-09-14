-- =========================================================
-- Task Tracker — Phase 1 queries
-- =========================================================

-- ---- task_template ----

-- name: TaskTemplateCreate :one
INSERT INTO task_template (prefix, sort_order, created_by, updated_by)
VALUES ($1, $2, $3, $3)
RETURNING *;

-- name: TaskTemplateList :many
SELECT * FROM task_template
WHERE ($1::boolean OR deleted_at IS NULL)
ORDER BY sort_order ASC, prefix ASC;

-- name: TaskTemplateGet :one
SELECT * FROM task_template WHERE id = $1;

-- name: TaskTemplateUpdate :one
UPDATE task_template
SET prefix = $2, updated_by = $3, updated_at = now()
WHERE id = $1 AND deleted_at IS NULL
RETURNING *;

-- name: TaskTemplateSoftDelete :one
UPDATE task_template
SET deleted_at = now(), updated_by = $2, updated_at = now()
WHERE id = $1 AND deleted_at IS NULL
RETURNING *;

-- name: TaskTemplateSetSortOrder :exec
UPDATE task_template SET sort_order = $2, updated_at = now() WHERE id = $1;

-- ---- task_status ----

-- name: TaskStatusCreate :one
INSERT INTO task_status (code, name, sort_order, created_by)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: TaskStatusList :many
SELECT * FROM task_status
WHERE ($1::boolean OR deleted_at IS NULL)
ORDER BY sort_order ASC, name ASC;

-- name: TaskStatusGet :one
SELECT * FROM task_status WHERE id = $1;

-- name: TaskStatusUpdate :one
UPDATE task_status
SET code = $2, name = $3, updated_at = now()
WHERE id = $1 AND deleted_at IS NULL
RETURNING *;

-- name: TaskStatusSoftDelete :one
UPDATE task_status
SET deleted_at = now(), updated_at = now()
WHERE id = $1 AND deleted_at IS NULL
RETURNING *;

-- name: TaskStatusSetSortOrder :exec
UPDATE task_status SET sort_order = $2, updated_at = now() WHERE id = $1;

-- ---- enum_dictionary ----

-- name: EnumDictionaryCreate :one
INSERT INTO enum_dictionary (code, name, is_public, participates_in_filtration)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: EnumDictionaryList :many
SELECT * FROM enum_dictionary ORDER BY name ASC;

-- name: EnumDictionaryListFilterable :many
SELECT * FROM enum_dictionary
WHERE participates_in_filtration = true
ORDER BY name ASC;

-- name: EnumDictionaryGet :one
SELECT * FROM enum_dictionary WHERE id = $1;

-- name: EnumDictionaryUpdateSettings :one
UPDATE enum_dictionary
SET is_public = $2, participates_in_filtration = $3, updated_at = now()
WHERE id = $1
RETURNING *;

-- name: EnumDictionaryIncrementVersion :one
UPDATE enum_dictionary
SET current_version = current_version + 1, updated_at = now()
WHERE id = $1
RETURNING *;

-- ---- enum_dictionary_version ----

-- name: EnumDictionaryVersionCreate :one
INSERT INTO enum_dictionary_version (dictionary_id, version, created_by)
VALUES ($1, $2, $3)
RETURNING *;

-- name: EnumDictionaryVersionList :many
SELECT * FROM enum_dictionary_version
WHERE dictionary_id = $1
ORDER BY version DESC;

-- name: EnumDictionaryVersionGet :one
SELECT * FROM enum_dictionary_version WHERE id = $1;

-- ---- enum_dictionary_version_item ----

-- name: EnumDictionaryVersionItemCreate :one
INSERT INTO enum_dictionary_version_item
    (dictionary_version_id, value_code, value_name, sort_order, is_active)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: EnumDictionaryVersionItemList :many
SELECT * FROM enum_dictionary_version_item
WHERE dictionary_version_id = $1
ORDER BY sort_order ASC, value_name ASC;

-- =========================================================
-- Task Tracker — Phase 2 queries
-- =========================================================

-- ---- task_field_definition ----

-- name: TaskFieldCreate :one
INSERT INTO task_field_definition
    (template_id, code, name, type, required, sort_order, enum_dictionary_id, field_role)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING *;

-- name: TaskFieldList :many
SELECT * FROM task_field_definition
WHERE template_id = $1
  AND ($2::boolean OR deleted_at IS NULL)
ORDER BY sort_order ASC, code ASC;

-- name: TaskFieldGet :one
SELECT * FROM task_field_definition WHERE id = $1 AND template_id = $2;

-- name: TaskFieldUpdate :one
UPDATE task_field_definition
SET name = $2, required = $3, updated_at = now()
WHERE id = $1 AND template_id = $4 AND deleted_at IS NULL
RETURNING *;

-- name: TaskFieldSoftDelete :one
UPDATE task_field_definition
SET deleted_at = now(), updated_at = now()
WHERE id = $1 AND template_id = $2 AND deleted_at IS NULL
RETURNING *;

-- name: TaskFieldSetSortOrder :exec
UPDATE task_field_definition
SET sort_order = $2, updated_at = now()
WHERE id = $1 AND template_id = $3;

-- =========================================================
-- Task Tracker — Phase 3 queries
-- =========================================================

-- ---- task ----

-- name: TaskCreate :one
INSERT INTO task (template_id, parent_task_id, title, description, status_id, created_by, updated_by)
VALUES ($1, $2, $3, $4, $5, $6, $6)
RETURNING *;

-- name: TaskGet :one
SELECT * FROM task WHERE id = $1;

-- name: TaskSubtaskList :many
SELECT * FROM task
WHERE parent_task_id = $1
ORDER BY created_at ASC;

-- name: TaskUpdate :one
UPDATE task
SET title = $2, description = $3, status_id = $4, updated_by = $5, updated_at = now()
WHERE id = $1
RETURNING *;

-- name: TaskActiveTemplateCount :one
SELECT COUNT(*) FROM task_template WHERE deleted_at IS NULL;

-- name: TaskFieldDefinitionListActive :many
SELECT * FROM task_field_definition
WHERE template_id = $1 AND deleted_at IS NULL
ORDER BY sort_order ASC, code ASC;

-- ---- task_field_value ----

-- name: TaskFieldValueUpsert :one
INSERT INTO task_field_value
    (task_id, field_definition_id, value_text, value_number, value_user_id,
     value_date, value_datetime, value_json, enum_dictionary_id, enum_version)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
ON CONFLICT (task_id, field_definition_id) DO UPDATE SET
    value_text         = EXCLUDED.value_text,
    value_number       = EXCLUDED.value_number,
    value_user_id      = EXCLUDED.value_user_id,
    value_date         = EXCLUDED.value_date,
    value_datetime     = EXCLUDED.value_datetime,
    value_json         = EXCLUDED.value_json,
    enum_dictionary_id = EXCLUDED.enum_dictionary_id,
    enum_version       = EXCLUDED.enum_version,
    updated_at         = now()
RETURNING *;

-- name: TaskFieldValueList :many
SELECT * FROM task_field_value WHERE task_id = $1;

-- Delete field values NOT in the provided set (replace-all semantics).
-- $1 = task_id, $2 = field_definition_ids to keep (may be empty array).
-- name: TaskFieldValueDeleteExcept :exec
DELETE FROM task_field_value
WHERE task_id = $1
  AND field_definition_id != ALL($2::uuid[]);

-- =========================================================
-- Task Tracker — Phase 6 queries
-- =========================================================

-- ---- task_staged_attachment ----

-- name: TaskStagedAttachmentCreate :one
INSERT INTO task_staged_attachment (id, file_name, file_size, mime_type, storage_key, uploaded_by)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;

-- name: TaskStagedAttachmentGet :one
SELECT * FROM task_staged_attachment
WHERE id = $1;

-- name: TaskStagedAttachmentDelete :one
DELETE FROM task_staged_attachment
WHERE id = $1
  AND uploaded_by = $2
RETURNING *;

-- ---- task_attachment ----

-- name: TaskAttachmentCreate :one
INSERT INTO task_attachment (id, task_id, file_name, file_size, mime_type, storage_key, uploaded_by)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING *;

-- name: TaskAttachmentList :many
SELECT * FROM task_attachment
WHERE task_id = $1
ORDER BY created_at ASC;

-- name: TaskAttachmentGet :one
SELECT * FROM task_attachment WHERE id = $1;

-- name: TaskAttachmentDelete :one
DELETE FROM task_attachment
WHERE id = $1 AND task_id = $2
RETURNING *;

-- ---- task_comment ----

-- name: TaskCommentCreate :one
INSERT INTO task_comment (task_id, author_id, body)
VALUES ($1, $2, $3)
RETURNING *;

-- name: TaskCommentListWithAttachments :many
SELECT c.*,
       COALESCE(ts.reply_count, 0)::int AS thread_reply_count,
       COALESCE((
         SELECT json_agg(json_build_object(
           'id', a.id,
           'task_id', a.task_id,
           'comment_id', a.comment_id,
           'file_name', a.file_name,
           'file_size', a.file_size,
           'mime_type', a.mime_type,
           'uploaded_by', a.uploaded_by,
           'created_at', a.created_at
         ) ORDER BY a.created_at, a.id)
         FROM task_comment_attachment a
         WHERE a.comment_id = c.id
       ), '[]'::json) AS attachments
FROM task_comment c
LEFT JOIN thread_summaries ts ON ts.root_message_id = c.thread_root_message_id
WHERE c.task_id = $1
ORDER BY c.created_at ASC;

-- name: TaskCommentGetWithAttachments :one
SELECT c.*,
       COALESCE(ts.reply_count, 0)::int AS thread_reply_count,
       COALESCE((
         SELECT json_agg(json_build_object(
           'id', a.id,
           'task_id', a.task_id,
           'comment_id', a.comment_id,
           'file_name', a.file_name,
           'file_size', a.file_size,
           'mime_type', a.mime_type,
           'uploaded_by', a.uploaded_by,
           'created_at', a.created_at
         ) ORDER BY a.created_at, a.id)
         FROM task_comment_attachment a
         WHERE a.comment_id = c.id
       ), '[]'::json) AS attachments
FROM task_comment c
LEFT JOIN thread_summaries ts ON ts.root_message_id = c.thread_root_message_id
WHERE c.task_id = $1
  AND c.id = $2;

-- ---- task_comment_attachment ----

-- name: TaskCommentAttachmentCreate :one
INSERT INTO task_comment_attachment (id, task_id, comment_id, file_name, file_size, mime_type, storage_key, uploaded_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING *;

-- name: TaskCommentAttachmentGet :one
SELECT * FROM task_comment_attachment
WHERE id = $1;

-- name: TaskCommentAttachmentDeleteStaged :one
DELETE FROM task_comment_attachment
WHERE id = $1
  AND task_id = $2
  AND comment_id IS NULL
RETURNING *;
