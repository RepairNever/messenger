-- name: CreateBootstrapSession :one
INSERT INTO bootstrap_sessions (
  user_id,
  client_instance_id,
  snapshot_seq,
  include_archived,
  expires_at
)
VALUES (
  @user_id,
  @client_instance_id,
  @snapshot_seq,
  @include_archived,
  @expires_at
)
RETURNING *;

-- name: GetBootstrapSession :one
SELECT *
FROM bootstrap_sessions
WHERE id = @id;

-- name: GetBootstrapSessionStats :one
SELECT
  COUNT(*)::int AS total_items,
  COALESCE(MAX(page_index), -1)::int AS max_page_index
FROM bootstrap_session_items
WHERE session_id = @session_id;

-- name: GetBootstrapPageFirstOrdinal :one
SELECT COALESCE(MIN(ordinal), -1)::int AS first_ordinal
FROM bootstrap_session_items
WHERE session_id = @session_id
  AND page_index = @page_index;

-- name: DeleteExpiredBootstrapSessions :execrows
DELETE FROM bootstrap_sessions
WHERE expires_at < now();

-- name: InsertBootstrapSessionItem :exec
INSERT INTO bootstrap_session_items (
  session_id,
  page_index,
  conversation_id,
  ordinal
)
VALUES (
  @session_id,
  @page_index,
  @conversation_id,
  @ordinal
);

-- name: CountBootstrapConversations :one
SELECT COUNT(*)::int AS total
FROM channels c
JOIN channel_members cm ON cm.channel_id = c.id
WHERE cm.user_id = @user_id
  AND c.hidden = false
  AND (
    @include_archived::bool
    OR (cm.is_archived = false AND c.is_archived = false)
  );

-- name: ListBootstrapConversationIDs :many
SELECT c.id
FROM channels c
JOIN channel_members cm ON cm.channel_id = c.id
WHERE cm.user_id = @user_id
  AND c.hidden = false
  AND (
    @include_archived::bool
    OR (cm.is_archived = false AND c.is_archived = false)
  )
ORDER BY c.last_activity_at DESC, c.id ASC;

-- name: GetBootstrapWorkspaceSummary :one
SELECT
  w.id AS workspace_id,
  w.name AS workspace_name,
  u.id AS self_user_id,
  u.display_name AS self_display_name,
  u.avatar_url AS self_avatar_url,
  u.custom_status_text AS self_custom_status_text,
  u.custom_status_emoji AS self_custom_status_emoji,
  u.custom_status_expires_at AS self_custom_status_expires_at,
  u.role AS self_role
FROM workspace w
JOIN users u ON u.id = @user_id
LIMIT 1;

-- name: ListBootstrapConversationsPage :many
SELECT
  bsi.ordinal,
  c.id AS conversation_id,
  CASE
    WHEN c.kind = 'dm' THEN 'dm'
    WHEN c.visibility = 'public' THEN 'channel_public'
    ELSE 'channel_private'
  END AS conversation_type,
  (
  CASE
    WHEN c.kind = 'dm' THEN COALESCE(
      NULLIF(dm_peer.display_name, ''),
      NULLIF(dm_peer.email, ''),
      NULLIF(self_user.display_name, ''),
      NULLIF(self_user.email, ''),
      'dm'
    )
    ELSE COALESCE(NULLIF(c.name, ''), c.kind)
  END
  )::text AS title,
  (
  CASE
    WHEN c.kind = 'dm' THEN COALESCE(dm_peer.user_id::text, bs.user_id::text, '')
    ELSE c.topic
  END
  )::text AS topic,
  COALESCE((c.is_archived OR cm_self.is_archived), false)::bool AS is_archived,
  cm_self.notification_level,
  c.next_seq AS last_message_seq,
  CASE
    WHEN c.encryption_mode = 'dm_pairwise_signal_v1' THEN ''
    ELSE COALESCE(last_message.body, '')
  END::text AS last_message_preview,
  c.last_activity_at,
  member_stats.member_count,
  COALESCE(dm_peer.status, self_presence.status, 'offline') AS presence,
  c.encryption_mode
FROM bootstrap_session_items bsi
JOIN bootstrap_sessions bs ON bs.id = bsi.session_id
JOIN channels c ON c.id = bsi.conversation_id
JOIN channel_members cm_self ON cm_self.channel_id = c.id
  AND cm_self.user_id = bs.user_id
LEFT JOIN users self_user ON self_user.id = bs.user_id
LEFT JOIN user_presence self_presence ON self_presence.user_id = bs.user_id
LEFT JOIN LATERAL (
  SELECT m.body
  FROM messages m
  WHERE m.channel_id = c.id
  ORDER BY m.channel_seq DESC
  LIMIT 1
) last_message ON true
LEFT JOIN LATERAL (
  SELECT COUNT(*)::int AS member_count
  FROM channel_members cm
  WHERE cm.channel_id = c.id
    AND cm.is_archived = false
) member_stats ON true
LEFT JOIN LATERAL (
  SELECT
    u.id AS user_id,
    u.display_name,
    u.email,
    COALESCE(up.status, 'offline') AS status
  FROM channel_members cm_other
  JOIN users u ON u.id = cm_other.user_id
  LEFT JOIN user_presence up ON up.user_id = cm_other.user_id
  WHERE c.kind = 'dm'
    AND cm_other.channel_id = c.id
    AND cm_other.user_id <> bs.user_id
  ORDER BY cm_other.created_at ASC
  LIMIT 1
) dm_peer ON true
WHERE bsi.session_id = @session_id
  AND bsi.page_index = @page_index
ORDER BY bsi.ordinal ASC;

-- name: ListBootstrapUnreadCountersForPage :many
SELECT
  c.id AS conversation_id,
  -- When notification_level=2 (NOTHING): suppress all unread.
  -- When notification_level=1 (MENTIONS_ONLY): only count mentions as unread_messages.
  -- When notification_level=0 (ALL): normal counting.
  CASE cm_self.notification_level
    WHEN 2 THEN 0
    WHEN 1 THEN COALESCE((
      SELECT COUNT(*)::int
      FROM message_mentions mm
      JOIN messages m ON m.id = mm.message_id
      WHERE mm.user_id = bs.user_id
        AND m.channel_id = c.id
        AND m.channel_seq > COALESCE(mr.last_read_seq, 0)
    ), 0)::int
    ELSE COALESCE((
      SELECT COUNT(*)::int
      FROM messages m_unread
      WHERE m_unread.channel_id = c.id
        AND m_unread.channel_seq > COALESCE(mr.last_read_seq, 0)
        AND m_unread.thread_root_id IS NULL
        AND m_unread.sender_id <> bs.user_id
    ), 0)::int
  END AS unread_messages,
  CASE cm_self.notification_level
    WHEN 2 THEN 0
    ELSE COALESCE((
      SELECT COUNT(*)::int
      FROM message_mentions mm
      JOIN messages m ON m.id = mm.message_id
      WHERE mm.user_id = bs.user_id
        AND m.channel_id = c.id
        AND m.channel_seq > COALESCE(mr.last_read_seq, 0)
    ), 0)::int
  END AS unread_mentions,
  (CASE cm_self.notification_level
    WHEN 2 THEN false
    ELSE EXISTS (
      SELECT 1
      FROM thread_summaries ts
      JOIN messages root ON root.id = ts.root_message_id
      LEFT JOIN thread_reads tr ON tr.root_message_id = ts.root_message_id
        AND tr.user_id = bs.user_id
      WHERE root.channel_id = c.id
        AND (
          root.sender_id = bs.user_id
          OR EXISTS (
            SELECT 1
            FROM messages participant_msg
            WHERE participant_msg.thread_root_id = ts.root_message_id
              AND participant_msg.sender_id = bs.user_id
          )
        )
        AND COALESCE(tr.last_read_thread_seq, 0) < GREATEST(ts.next_thread_seq - 1, 0)
    )
  END)::bool AS has_unread_thread_replies,
  COALESCE(mr.last_read_seq, 0) AS last_read_seq
FROM bootstrap_session_items bsi
JOIN bootstrap_sessions bs ON bs.id = bsi.session_id
JOIN channels c ON c.id = bsi.conversation_id
JOIN channel_members cm_self ON cm_self.channel_id = c.id
  AND cm_self.user_id = bs.user_id
  AND cm_self.is_archived = false
LEFT JOIN message_reads mr ON mr.channel_id = c.id
  AND mr.user_id = bs.user_id
WHERE bsi.session_id = @session_id
  AND bsi.page_index = @page_index
ORDER BY bsi.ordinal ASC;

-- name: ListBootstrapPresenceForPage :many
SELECT DISTINCT
  up.user_id,
  up.status,
  up.last_active_at
FROM bootstrap_session_items bsi
JOIN channels c ON c.id = bsi.conversation_id
JOIN channel_members cm ON cm.channel_id = c.id
  AND cm.is_archived = false
JOIN user_presence up ON up.user_id = cm.user_id
WHERE bsi.session_id = @session_id
  AND bsi.page_index = @page_index
ORDER BY up.user_id ASC;

-- name: ListBootstrapNotifications :many
SELECT
  n.id,
  n.type,
  COALESCE(n.title, '') AS title,
  COALESCE(n.body, '') AS body,
  n.channel_id,
  n.is_read,
  n.created_at,
  n.message_id,
  n.thread_root_message_id
FROM notifications n
WHERE n.user_id = @user_id
  AND n.resolved_at IS NULL
ORDER BY n.created_at DESC;

-- name: ListBootstrapActiveCalls :many
SELECT
  c.id,
  c.channel_id,
  c.status,
  COUNT(DISTINCT cp.user_id)::int AS participant_count
FROM calls c
LEFT JOIN call_participants cp ON cp.call_id = c.id
  AND cp.left_at IS NULL
WHERE c.status = 'active'
  AND (
    EXISTS (
      SELECT 1
      FROM channel_members cm
      WHERE cm.channel_id = c.channel_id
        AND cm.user_id = @user_id
        AND cm.is_archived = false
    )
    OR EXISTS (
      SELECT 1
      FROM call_participants self_cp
      WHERE self_cp.call_id = c.id
        AND self_cp.user_id = @user_id
        AND self_cp.left_at IS NULL
    )
  )
GROUP BY c.id, c.channel_id, c.status
ORDER BY c.started_at DESC;

-- name: ListBootstrapPendingInvites :many
SELECT
  ci.id,
  ci.call_id,
  ci.channel_id,
  ci.inviter_id,
  ci.created_at,
  ci.expires_at,
  ci.state
FROM call_invites ci
WHERE ci.invitee_id = @user_id
  AND ci.state = 'created'
ORDER BY ci.created_at DESC;

-- name: ListBootstrapUserCallPresence :many
SELECT
  cp.user_id,
  COUNT(DISTINCT c.id)::int AS active_call_count
FROM calls c
JOIN call_participants cp ON cp.call_id = c.id
  AND cp.left_at IS NULL
WHERE c.status = 'active'
GROUP BY cp.user_id
ORDER BY cp.user_id ASC;
