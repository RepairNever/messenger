-- name: ListBotConversations :many
SELECT c.id, c.kind, c.visibility, c.name, c.hidden, c.last_activity_at,
       (SELECT COUNT(*)::int FROM channel_members cm
         WHERE cm.channel_id = c.id AND cm.is_archived = false) AS member_count
FROM channels c
JOIN channel_members m
  ON m.channel_id = c.id AND m.user_id = @bot_user_id AND m.is_archived = false
ORDER BY c.last_activity_at DESC;

-- name: ListActiveConversationIDsForUser :many
SELECT channel_id FROM channel_members WHERE user_id = @user_id AND is_archived = false;

-- name: GetTaskByDiscussionChannel :many
SELECT t.id, t.public_id
FROM task t
WHERE t.discussion_channel_id = @discussion_channel_id
  AND EXISTS (
    SELECT 1
    FROM channel_members cm
    WHERE cm.channel_id = t.discussion_channel_id
      AND cm.user_id = @bot_user_id
      AND cm.is_archived = false
  )
ORDER BY t.created_at ASC;

-- name: ListBotTaskComments :many
SELECT tc.id, tc.task_id, tc.author_id,
       COALESCE(NULLIF(u.display_name, ''), u.email) AS author_name,
       tc.thread_root_message_id, tc.body, tc.created_at, tc.updated_at,
       (SELECT COUNT(*)::int FROM task_comment_attachment a
         WHERE a.comment_id = tc.id) AS attachment_count,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'attachment_id', a.id,
           'file_name', a.file_name,
           'mime_type', a.mime_type,
           'file_size', a.file_size
         ) ORDER BY a.created_at, a.id)
         FROM task_comment_attachment a
         WHERE a.comment_id = tc.id
       ), '[]'::jsonb)::jsonb AS attachments
FROM task_comment tc
JOIN users u ON u.id = tc.author_id
WHERE tc.task_id = @task_id
ORDER BY tc.created_at ASC, tc.id ASC;

-- name: ResolveBotAttachment :many
-- Resolve only linked attachments. Membership is checked by the owning domain
-- service so callers can distinguish missing resources from forbidden ones.
-- UUIDs are unique per table, not across kinds: callers must reject ambiguity.
SELECT 'message'::text AS kind, m.id AS parent_id, m.channel_id AS owner_id,
       c.encryption_mode, m.content_mode, a.mime_type
FROM message_attachment a
JOIN messages m ON m.id = a.message_id AND m.channel_id = a.conversation_id
JOIN channels c ON c.id = m.channel_id
WHERE a.id = @attachment_id
UNION ALL
SELECT 'task_comment'::text, tc.id, tc.task_id,
       'none'::text, 'plaintext'::text, a.mime_type
FROM task_comment_attachment a
JOIN task_comment tc ON tc.id = a.comment_id AND tc.task_id = a.task_id
JOIN task t ON t.id = tc.task_id
WHERE a.id = @attachment_id
UNION ALL
SELECT 'document'::text, d.id, d.teamspace_id,
       'none'::text, 'plaintext'::text, a.mime_type
FROM document_attachment a
JOIN document d ON d.id = a.document_id AND d.archived_at IS NULL
JOIN teamspace t ON t.id = d.teamspace_id AND t.deleted_at IS NULL
WHERE a.id = @attachment_id;
