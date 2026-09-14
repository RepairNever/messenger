-- name: SaveMessage :one
INSERT INTO message_saves (user_id, message_id)
SELECT @user_id, m.id
FROM messages m
JOIN channel_members cm
  ON cm.channel_id = m.channel_id
 AND cm.user_id = @user_id
 AND cm.is_archived = false
WHERE m.id = @message_id
-- Keep saved_at stable for idempotent saves. DO NOTHING cannot be used here
-- because PostgreSQL would not return the existing row from RETURNING.
ON CONFLICT (user_id, message_id) DO UPDATE
  SET saved_at = message_saves.saved_at
RETURNING saved_at;

-- name: UnsaveMessage :exec
DELETE FROM message_saves
WHERE user_id = @user_id
  AND message_id = @message_id;

-- name: ListSavedMessages :many
SELECT ms.message_id::text AS message_id,
       m.channel_id::text AS conversation_id,
       c.kind,
       c.visibility,
       (CASE
         WHEN c.kind = 'dm' THEN COALESCE(dm_peer.display_name, dm_peer.email, c.name)
         ELSE c.name
       END)::text AS conversation_title,
       m.sender_id::text AS sender_id,
       COALESCE(NULLIF(sender.display_name, ''), sender.email)::text AS sender_name,
       CASE
         WHEN m.content_mode = 'dm_pairwise_signal_v1' THEN 'Encrypted message'
         ELSE m.body
       END::text AS body,
       COALESCE(m.forwarded_from_message_id::text, '')::text AS forwarded_from_message_id,
       COALESCE(m.forwarded_from_sender_id::text, '')::text AS forwarded_from_sender_id,
       COALESCE(m.forwarded_from_sender_name, '')::text AS forwarded_from_sender_name,
       COALESCE(m.forwarded_from_conversation_kind, '')::text AS forwarded_from_conversation_kind,
       COALESCE(m.forwarded_from_conversation_title, '')::text AS forwarded_from_conversation_title,
       COALESCE(m.forwarded_from_thread_title, '')::text AS forwarded_from_thread_title,
       COALESCE(m.thread_root_id::text, '')::text AS thread_root_message_id,
       m.created_at,
       ms.saved_at
FROM message_saves ms
JOIN messages m
  ON m.id = ms.message_id
JOIN channels c
  ON c.id = m.channel_id
JOIN channel_members cm_self
  ON cm_self.channel_id = c.id
 AND cm_self.user_id = @user_id
 AND cm_self.is_archived = false
JOIN users sender
  ON sender.id = m.sender_id
LEFT JOIN LATERAL (
  SELECT COALESCE(NULLIF(u.display_name, ''), u.email) AS display_name,
         u.email
  FROM channel_members cm_other
  JOIN users u
    ON u.id = cm_other.user_id
  WHERE c.kind = 'dm'
    AND cm_other.channel_id = c.id
    AND cm_other.user_id <> @user_id
    AND cm_other.is_archived = false
  ORDER BY cm_other.created_at ASC
  LIMIT 1
) dm_peer ON true
WHERE ms.user_id = @user_id
  -- Archived conversations are hidden from the saved feed, matching sidebar visibility.
  AND c.is_archived = false
ORDER BY ms.saved_at DESC, ms.message_id DESC;
