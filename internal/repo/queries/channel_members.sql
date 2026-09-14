-- name: GetChannelMember :one
SELECT channel_id, user_id, notification_level, created_at
FROM channel_members
WHERE channel_id = $1
  AND user_id = $2
  AND is_archived = false
LIMIT 1;

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
