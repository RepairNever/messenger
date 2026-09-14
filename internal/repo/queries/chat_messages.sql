-- name: IsChannelMember :one
SELECT EXISTS (
  SELECT 1
  FROM channel_members
  WHERE channel_id = @channel_id
    AND user_id = @user_id
    AND is_archived = false
) AS is_member;

-- name: ListConversationMessagePage :many
SELECT m.id, m.channel_id, m.sender_id, u.display_name, m.body, m.channel_seq,
       m.content_mode,
       m.sender_device_id,
       m.forwarded_from_message_id,
       m.forwarded_from_sender_id,
       m.forwarded_from_sender_name,
       m.forwarded_from_conversation_kind,
       m.forwarded_from_conversation_title,
       m.forwarded_from_thread_title,
       COALESCE(m.thread_seq, 0) AS thread_seq,
       m.thread_root_id,
       COALESCE(ts.reply_count, 0) AS thread_reply_count,
       m.edited_at,
       m.created_at,
       m.mention_everyone,
       COALESCE((
         SELECT json_agg(json_build_object('emoji', rc.emoji, 'count', rc.count) ORDER BY rc.emoji)
           FROM reaction_counts rc
          WHERE rc.message_id = m.id
       ), '[]'::json) AS reactions,
       COALESCE((
         SELECT json_agg(r.emoji ORDER BY r.emoji)
           FROM reactions r
          WHERE r.message_id = m.id
            AND r.user_id = @requester_id
       ), '[]'::json) AS my_reactions,
       COALESCE((
         SELECT json_agg(json_build_object(
           'id', ma.id,
           'conversation_id', ma.conversation_id,
           'message_id', ma.message_id,
           'file_name', ma.file_name,
           'file_size', ma.file_size,
           'mime_type', ma.mime_type,
           'thumbnail_mime_type', ma.thumbnail_mime_type,
           'thumbnail_file_size', ma.thumbnail_file_size,
           'thumbnail_version', ma.thumbnail_version,
           'uploaded_by', ma.uploaded_by,
           'created_at', ma.created_at
         ) ORDER BY ma.created_at, ma.id)
           FROM message_attachment ma
          WHERE ma.message_id = m.id
       ), '[]'::json) AS attachments,
       EXISTS (
         SELECT 1
           FROM message_saves ms
          WHERE ms.message_id = m.id
            AND ms.user_id = @requester_id
       ) AS is_saved
FROM messages m
JOIN users u ON u.id = m.sender_id
LEFT JOIN thread_summaries ts ON ts.root_message_id = m.id
WHERE m.channel_id = @conversation_id
  AND m.thread_root_id IS NULL
  AND m.channel_seq < @before_channel_seq
ORDER BY m.channel_seq DESC
LIMIT @query_limit;

-- name: FindMessageByClientMsgID :one
SELECT id, channel_seq, client_msg_id, created_at
FROM messages
WHERE channel_id = @channel_id
  AND sender_id = @sender_id
  AND client_msg_id = @client_msg_id
LIMIT 1;

-- name: GetMessageChannelID :one
SELECT channel_id
FROM messages
WHERE id = @message_id;

-- name: ListMessageContextRows :many
WITH target AS (
  SELECT messages.id, messages.channel_seq
  FROM messages
  WHERE messages.id = @target_message_id
    AND messages.channel_id = @conversation_id
    AND messages.thread_root_id IS NULL
),
context_messages AS (
  SELECT m.id,
         m.channel_id,
         m.sender_id,
         u.display_name,
         m.body,
         m.content_mode,
         m.sender_device_id,
         m.forwarded_from_message_id,
         m.forwarded_from_sender_id,
         m.forwarded_from_sender_name,
         m.forwarded_from_conversation_kind,
         m.forwarded_from_conversation_title,
         m.forwarded_from_thread_title,
         m.channel_seq,
         COALESCE(m.thread_seq, 0) AS thread_seq,
         m.thread_root_id,
         COALESCE(ts.reply_count, 0) AS thread_reply_count,
         m.edited_at,
         m.created_at,
         m.mention_everyone,
         COALESCE((
           SELECT json_agg(json_build_object('emoji', rc.emoji, 'count', rc.count) ORDER BY rc.emoji)
           FROM reaction_counts rc
           WHERE rc.message_id = m.id
         ), '[]'::json) AS reactions,
         COALESCE((
           SELECT json_agg(r.emoji ORDER BY r.emoji)
           FROM reactions r
           WHERE r.message_id = m.id
             AND r.user_id = @requester_id
         ), '[]'::json) AS my_reactions,
         COALESCE((
           SELECT json_agg(json_build_object(
             'id', ma.id,
             'conversation_id', ma.conversation_id,
             'message_id', ma.message_id,
             'file_name', ma.file_name,
             'file_size', ma.file_size,
             'mime_type', ma.mime_type,
             'thumbnail_mime_type', ma.thumbnail_mime_type,
             'thumbnail_file_size', ma.thumbnail_file_size,
             'thumbnail_version', ma.thumbnail_version,
             'uploaded_by', ma.uploaded_by,
             'created_at', ma.created_at
         ) ORDER BY ma.created_at, ma.id)
           FROM message_attachment ma
           WHERE ma.message_id = m.id
         ), '[]'::json) AS attachments,
         EXISTS (
           SELECT 1
             FROM message_saves ms
            WHERE ms.message_id = m.id
              AND ms.user_id = @requester_id
         ) AS is_saved
  FROM messages m
  JOIN users u
    ON u.id = m.sender_id
  LEFT JOIN thread_summaries ts
    ON ts.root_message_id = m.id
  WHERE m.id IN (
    SELECT before_rows.id
    FROM (
      SELECT m_before.id, m_before.channel_seq
      FROM messages m_before
      JOIN target t ON true
      WHERE m_before.channel_id = @conversation_id
        AND m_before.thread_root_id IS NULL
        AND m_before.channel_seq < t.channel_seq
      ORDER BY m_before.channel_seq DESC
      LIMIT @before_limit
    ) before_rows
    UNION
    SELECT target.id FROM target
    UNION
    SELECT after_rows.id
    FROM (
      SELECT m_after.id, m_after.channel_seq
      FROM messages m_after
      JOIN target t ON true
      WHERE m_after.channel_id = @conversation_id
        AND m_after.thread_root_id IS NULL
        AND m_after.channel_seq > t.channel_seq
      ORDER BY m_after.channel_seq ASC
      LIMIT @after_limit
    ) after_rows
  )
)
SELECT context_messages.id,
       context_messages.channel_id,
       context_messages.sender_id,
       context_messages.display_name,
       context_messages.body,
       context_messages.content_mode,
       context_messages.sender_device_id,
       context_messages.forwarded_from_message_id,
       context_messages.forwarded_from_sender_id,
       context_messages.forwarded_from_sender_name,
       context_messages.forwarded_from_conversation_kind,
       context_messages.forwarded_from_conversation_title,
       context_messages.forwarded_from_thread_title,
       context_messages.channel_seq,
       context_messages.thread_seq,
       context_messages.thread_root_id,
       context_messages.thread_reply_count,
       context_messages.edited_at,
       context_messages.created_at,
       context_messages.mention_everyone,
       context_messages.reactions,
       context_messages.my_reactions,
       context_messages.attachments,
       context_messages.is_saved
FROM context_messages
ORDER BY context_messages.channel_seq ASC;
