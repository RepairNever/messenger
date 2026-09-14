-- name: ListDMCandidates :many
SELECT id,
       display_name,
       email,
       avatar_url,
       custom_status_text,
       custom_status_emoji,
       custom_status_expires_at
FROM users
WHERE id <> @requester_id
  AND status = 'active'
  AND role <> 'bot'
ORDER BY lower(COALESCE(NULLIF(display_name, ''), email)), id;

-- name: ListAvailablePublicChannels :many
SELECT c.id,
       c.kind,
       c.visibility,
       COALESCE(NULLIF(c.name, ''), c.kind) AS name,
       c.last_activity_at
FROM channels c
WHERE c.kind = 'channel'
  AND c.visibility = 'public'
  AND c.is_archived = false
  AND c.hidden = false
  AND NOT EXISTS (
    SELECT 1
    FROM channel_members cm
    WHERE cm.channel_id = c.id
      AND cm.user_id = @requester_id
      AND cm.is_archived = false
  )
ORDER BY lower(COALESCE(NULLIF(c.name, ''), c.kind)), c.id;

-- name: ListConversationMembers :many
SELECT u.id,
       u.display_name,
       u.email,
       u.avatar_url,
       u.custom_status_text,
       u.custom_status_emoji,
       u.custom_status_expires_at
FROM channel_members cm
JOIN users u
  ON u.id = cm.user_id
WHERE cm.channel_id = @conversation_id
  AND cm.is_archived = false
  AND u.status = 'active'
ORDER BY lower(COALESCE(NULLIF(u.display_name, ''), u.email)), u.id;

-- name: ListActiveCallMembers :many
SELECT member_id, display_name, email, avatar_url, custom_status_text, custom_status_emoji, custom_status_expires_at
FROM (
  SELECT DISTINCT
    u.id AS member_id,
    u.display_name,
    u.email,
    u.avatar_url,
    u.custom_status_text,
    u.custom_status_emoji,
    u.custom_status_expires_at
  FROM calls c
  JOIN call_participants cp
    ON cp.call_id = c.id
   AND cp.left_at IS NULL
  JOIN users u
    ON u.id = cp.user_id
  WHERE c.channel_id = @conversation_id
    AND c.status = 'active'
    AND u.status = 'active'
) active_members
ORDER BY lower(COALESCE(NULLIF(display_name, ''), email)), member_id;

-- name: LookupActiveDMUser :one
SELECT u.id,
       u.display_name,
       u.email,
       u.avatar_url,
       u.custom_status_text,
       u.custom_status_emoji,
       u.custom_status_expires_at,
       COALESCE(up.status, 'offline') AS presence
FROM users u
LEFT JOIN user_presence up
  ON up.user_id = u.id
WHERE id = @user_id
  AND u.status = 'active'
  AND u.role <> 'bot';

-- name: GetInvitableChannelByID :one
SELECT id,
       kind,
       visibility,
       COALESCE(NULLIF(name, ''), kind) AS name,
       last_activity_at,
       is_archived
FROM channels
WHERE id = @channel_id
  AND hidden = false;

-- name: GetRemovableChannelByID :one
SELECT id,
       kind,
       visibility,
       is_archived
FROM channels
WHERE id = @channel_id
  AND hidden = false;

-- name: GetInviteTargetUserByID :one
SELECT COALESCE(NULLIF(display_name, ''), email) AS display_name,
       email
FROM users
WHERE id = @user_id
  AND status = 'active'
  AND role <> 'bot';

-- name: UpsertChannelMember :exec
INSERT INTO channel_members (channel_id, user_id)
VALUES (@channel_id, @user_id)
ON CONFLICT (channel_id, user_id) DO UPDATE
    SET is_archived = false;

-- name: IsSelfDMConversation :one
SELECT EXISTS (
  SELECT 1
  FROM channels c
  JOIN channel_members cm
    ON cm.channel_id = c.id
   AND cm.user_id = @requester_id
  WHERE c.id = @conversation_id
    AND c.kind = 'dm'
    AND c.visibility = 'dm'
    AND (
      SELECT COUNT(*)
      FROM channel_members cm2
      WHERE cm2.channel_id = c.id
    ) = 1
) AS is_self_dm;

-- name: ArchiveConversationMembership :execrows
UPDATE channel_members
SET is_archived = true
WHERE channel_id = @conversation_id
  AND user_id = @requester_id
  AND is_archived = false;

-- name: ArchiveTargetChannelMembership :execrows
UPDATE channel_members
SET is_archived = true
WHERE channel_id = @conversation_id
  AND user_id = @target_user_id
  AND is_archived = false;

-- name: HasConversationMembership :one
SELECT EXISTS (
  SELECT 1
  FROM channel_members
  WHERE channel_id = @conversation_id
    AND user_id = @user_id
) AS has_membership;
