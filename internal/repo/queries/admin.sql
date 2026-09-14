-- name: AdminListUsers :many
SELECT id, email, display_name, avatar_url, role, status, need_change_password, created_at, updated_at
FROM users
ORDER BY created_at DESC;

-- name: AdminCreateUser :one
INSERT INTO users (email, password_hash, display_name, role, status, need_change_password)
VALUES ($1, $2, $3, $4, 'active', $5)
RETURNING id, email, display_name, avatar_url, role, status, need_change_password, created_at, updated_at;

-- name: AdminSetUserStatus :one
UPDATE users SET status = $2, updated_at = now()
WHERE id = $1
RETURNING id, email, display_name, avatar_url, role, status, need_change_password, created_at, updated_at;

-- name: AdminSetNeedChangePassword :one
UPDATE users SET need_change_password = $2, updated_at = now()
WHERE id = $1
RETURNING id, email, display_name, avatar_url, role, status, need_change_password, created_at, updated_at;

-- name: AdminUpdateUser :one
UPDATE users
SET display_name  = $2,
    email         = $3,
    role          = $4,
    password_hash = CASE WHEN $5::text <> '' THEN $5::text ELSE password_hash END,
    updated_at    = now()
WHERE id = $1
RETURNING id, email, display_name, avatar_url, role, status, need_change_password, created_at, updated_at;

-- name: AdminListChannels :many
SELECT id, kind, visibility, name, topic, is_archived, created_by, created_at
FROM channels
WHERE kind <> 'dm'
ORDER BY created_at DESC;

-- name: AdminCreateChannel :one
INSERT INTO channels (kind, visibility, name, created_by)
VALUES ($1, $2, $3, $4)
RETURNING id, kind, visibility, name, topic, is_archived, created_by, created_at;

-- name: AdminDeleteChannel :exec
DELETE FROM channels WHERE id = $1;

-- name: AdminListChannelMembers :many
SELECT u.id, u.email, u.display_name, u.avatar_url, u.role, u.status, cm.created_at AS joined_at
FROM channel_members cm
JOIN users u ON u.id = cm.user_id
WHERE cm.channel_id = $1
  AND cm.is_archived = false
ORDER BY cm.created_at ASC;

-- name: AdminAddChannelMember :exec
INSERT INTO channel_members (channel_id, user_id)
VALUES ($1, $2)
ON CONFLICT (channel_id, user_id) DO UPDATE
    SET is_archived = false;

-- name: AdminAddAllUsersToChannel :exec
INSERT INTO channel_members (channel_id, user_id)
SELECT $1, u.id
FROM users u
WHERE u.role <> 'bot'
ON CONFLICT (channel_id, user_id) DO UPDATE
    SET is_archived = false;

-- name: AdminRemoveChannelMember :exec
UPDATE channel_members
SET is_archived = true
WHERE channel_id = $1
  AND user_id = $2
  AND is_archived = false;
