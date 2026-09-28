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
         WHERE a.comment_id = tc.id) AS attachment_count
FROM task_comment tc
JOIN users u ON u.id = tc.author_id
WHERE tc.task_id = @task_id
ORDER BY tc.created_at ASC, tc.id ASC;
