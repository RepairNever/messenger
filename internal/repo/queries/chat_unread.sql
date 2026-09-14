-- name: ListUnreadNotificationFeedItems :many
SELECT n.id::text AS notification_id,
       n.type,
       n.channel_id::text AS conversation_id,
       c.kind,
       c.visibility,
       (CASE
         WHEN c.kind = 'dm' THEN COALESCE(dm_peer.display_name, dm_peer.email, c.name)
         WHEN c.hidden THEN COALESCE('Task ' || t.public_id, c.name)
         ELSE c.name
       END)::text AS conversation_title,
       COALESCE(n.message_id::text, '')::text AS message_id,
       COALESCE(n.thread_root_message_id::text, '')::text AS thread_root_message_id,
       COALESCE(msg.sender_id::text, '')::text AS sender_id,
       COALESCE(NULLIF(sender.display_name, ''), sender.email, n.title)::text AS sender_name,
       n.body,
       n.created_at
FROM notifications n
JOIN channels c
  ON c.id = n.channel_id
JOIN channel_members cm_self
  ON cm_self.channel_id = c.id
 AND cm_self.user_id = @user_id
 AND cm_self.is_archived = false
LEFT JOIN messages msg
  ON msg.id = n.message_id
LEFT JOIN users sender
  ON sender.id = msg.sender_id
LEFT JOIN task_comment tc
  ON tc.thread_root_message_id = COALESCE(n.thread_root_message_id, n.message_id)
LEFT JOIN task t
  ON t.id = tc.task_id
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
WHERE n.user_id = @user_id
  AND n.resolved_at IS NULL
  AND n.type IN ('mention', 'thread_reply')
  AND c.is_archived = false
  AND cm_self.notification_level <> @notification_level_nothing
ORDER BY n.created_at DESC;

-- name: ListUnreadRootMessageFeedItems :many
SELECT m.id::text AS message_id,
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
       m.created_at
FROM channel_members cm_self
JOIN channels c
  ON c.id = cm_self.channel_id
LEFT JOIN message_reads mr
  ON mr.channel_id = c.id
 AND mr.user_id = @user_id
JOIN messages m
  ON m.channel_id = c.id
 AND m.channel_seq > COALESCE(mr.last_read_seq, 0)
 AND m.thread_root_id IS NULL
 AND m.sender_id <> @user_id
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
WHERE cm_self.user_id = @user_id
  AND cm_self.is_archived = false
  AND c.is_archived = false
  AND c.hidden = false
  AND cm_self.notification_level = @notification_level_all
ORDER BY m.created_at DESC;
