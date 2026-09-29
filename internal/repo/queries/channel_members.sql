-- name: GetChannelMember :one
SELECT channel_id, user_id, notification_level, created_at
FROM channel_members
WHERE channel_id = $1
  AND user_id = $2
  AND is_archived = false
LIMIT 1;

-- name: ListRealtimeConversationIDs :many
-- Realtime authorization includes hidden channels; sidebar bootstrap does not.
SELECT c.id
FROM channels c
JOIN channel_members cm ON cm.channel_id = c.id
WHERE cm.user_id = @user_id
  AND cm.is_archived = false
  AND c.is_archived = false
ORDER BY c.id;

-- name: SetNotificationLevel :exec
UPDATE channel_members
SET notification_level = $3
WHERE channel_id = $1
  AND user_id = $2
  AND is_archived = false;

-- name: ListPushRecipientsForChannel :many
SELECT user_id, notification_level
FROM channel_members
WHERE channel_id = $1
  AND is_archived = false
  AND user_id <> $2;
