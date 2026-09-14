-- name: GetUserByID :one
SELECT * FROM users WHERE id = $1;

-- name: GetPushSenderTitle :one
SELECT COALESCE(NULLIF(display_name, ''), email, 'Someone') AS title
FROM users
WHERE id = $1;

-- name: ListActiveUsers :many
SELECT id,
       display_name,
       email,
       avatar_url,
       custom_status_text,
       custom_status_emoji,
       custom_status_expires_at
FROM users
WHERE status = 'active'
  AND role <> 'bot'
ORDER BY display_name ASC;

-- name: GetUserByEmail :one
SELECT * FROM users WHERE email = $1;

-- name: UpdateUserPassword :exec
UPDATE users
SET password_hash = $2, need_change_password = FALSE, updated_at = now()
WHERE id = $1;
