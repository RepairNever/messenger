-- name: SearchTagUsersFiltered :many
SELECT u.id,
       COALESCE(NULLIF(u.display_name, ''), u.email) AS display_name,
       u.email,
       u.avatar_url,
       u.custom_status_text,
       u.custom_status_emoji,
       u.custom_status_expires_at,
       COALESCE(up.status, 'offline') AS presence
FROM channel_members cm
JOIN users u
  ON u.id = cm.user_id
LEFT JOIN user_presence up
  ON up.user_id = u.id
WHERE cm.channel_id = @conversation_id
  AND cm.user_id <> @requester_id
  AND cm.is_archived = false
  AND u.status = 'active'
  AND (
    COALESCE(NULLIF(u.display_name, ''), u.email) ILIKE @like_query
    OR u.email ILIKE @like_query
  )
ORDER BY lower(COALESCE(NULLIF(u.display_name, ''), u.email)), u.id
LIMIT 5;

-- name: SearchTagUsersRecent :many
SELECT u.id,
       COALESCE(NULLIF(u.display_name, ''), u.email) AS display_name,
       u.email,
       u.avatar_url,
       u.custom_status_text,
       u.custom_status_emoji,
       u.custom_status_expires_at,
       COALESCE(up.status, 'offline') AS presence
FROM channel_members cm
JOIN users u
  ON u.id = cm.user_id
LEFT JOIN user_presence up
  ON up.user_id = u.id
WHERE cm.channel_id = @conversation_id
  AND cm.user_id <> @requester_id
  AND cm.is_archived = false
  AND u.status = 'active'
ORDER BY (
  SELECT MAX(m.created_at)
  FROM messages m
  WHERE m.channel_id = cm.channel_id
    AND m.sender_id = cm.user_id
) DESC NULLS LAST,
lower(COALESCE(NULLIF(u.display_name, ''), u.email)),
u.id
LIMIT 5;

-- name: SearchTagTasksFiltered :many
SELECT id, public_id, title, updated_at
FROM task
WHERE public_id ILIKE @like_query
   OR title ILIKE @like_query
ORDER BY updated_at DESC, public_id ASC
LIMIT 5;

-- name: SearchTagTasksRecent :many
SELECT id, public_id, title, updated_at
FROM task
ORDER BY updated_at DESC, public_id ASC
LIMIT 5;

-- name: SearchTagDocumentsFiltered :many
SELECT d.id, d.title, d.updated_at
FROM document d
JOIN teamspace_member tm
  ON tm.teamspace_id = d.teamspace_id
 AND tm.user_id = @requester_id
WHERE d.archived_at IS NULL
  AND d.title ILIKE @like_query
ORDER BY d.updated_at DESC, d.title ASC, d.id ASC
LIMIT 5;

-- name: SearchTagDocumentsRecent :many
SELECT d.id, d.title, d.updated_at
FROM document d
JOIN teamspace_member tm
  ON tm.teamspace_id = d.teamspace_id
 AND tm.user_id = @requester_id
WHERE d.archived_at IS NULL
ORDER BY d.updated_at DESC, d.title ASC, d.id ASC
LIMIT 5;
