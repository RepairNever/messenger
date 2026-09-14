-- name: InsertMessage :one
WITH seq AS (
    UPDATE channels
    SET next_seq = next_seq + 1,
        last_activity_at = now()
    WHERE id = @channel_id
    RETURNING next_seq
)
INSERT INTO messages (channel_id, channel_seq, sender_id, client_msg_id, body,
                      thread_root_id, thread_seq, mention_everyone, created_at)
VALUES (@channel_id,
        (SELECT next_seq FROM seq),
        @sender_id,
        @client_msg_id,
        @body,
        @thread_root_id,
        @thread_seq,
        @mention_everyone,
        now())
RETURNING id, channel_id, channel_seq, sender_id, client_msg_id, body,
          forwarded_from_message_id, forwarded_from_sender_id, forwarded_from_sender_name,
          forwarded_from_conversation_kind,
          forwarded_from_conversation_title, forwarded_from_thread_title,
          thread_root_id, thread_seq, mention_everyone, edited_at, created_at;

-- name: GetMessageByClientMsgID :one
SELECT id, channel_id, channel_seq, sender_id, client_msg_id, body,
       forwarded_from_message_id, forwarded_from_sender_id, forwarded_from_sender_name,
       forwarded_from_conversation_kind,
       forwarded_from_conversation_title, forwarded_from_thread_title,
       thread_root_id, thread_seq, mention_everyone, edited_at, created_at
FROM messages
WHERE channel_id = @channel_id
  AND client_msg_id = @client_msg_id
LIMIT 1;

-- name: GetMessageByID :one
SELECT id, channel_id, channel_seq, sender_id, client_msg_id, body,
       forwarded_from_message_id, forwarded_from_sender_id, forwarded_from_sender_name,
       forwarded_from_conversation_kind,
       forwarded_from_conversation_title, forwarded_from_thread_title,
       thread_root_id, thread_seq, mention_everyone, edited_at, created_at
FROM messages
WHERE id = @message_id;

-- name: UpdateMessageBody :one
UPDATE messages
SET body = @body,
    mention_everyone = @mention_everyone,
    edited_at = now()
WHERE id = @message_id
RETURNING id, channel_id, channel_seq, sender_id, client_msg_id, body,
          forwarded_from_message_id, forwarded_from_sender_id, forwarded_from_sender_name,
          forwarded_from_conversation_kind,
          forwarded_from_conversation_title, forwarded_from_thread_title,
          thread_root_id, thread_seq, mention_everyone, edited_at, created_at;

-- name: DeleteMessageByID :one
DELETE FROM messages
WHERE id = @message_id
RETURNING id, channel_id, channel_seq, sender_id, client_msg_id, body,
          forwarded_from_message_id, forwarded_from_sender_id, forwarded_from_sender_name,
          forwarded_from_conversation_kind,
          forwarded_from_conversation_title, forwarded_from_thread_title,
          thread_root_id, thread_seq, mention_everyone, edited_at, created_at;

-- name: InsertMessageMention :exec
INSERT INTO message_mentions (message_id, user_id, created_at)
VALUES (@message_id, @user_id, now())
ON CONFLICT DO NOTHING;

-- name: GetThreadSummary :one
SELECT root_message_id, reply_count, next_thread_seq, last_reply_at, last_reply_user_id
FROM thread_summaries
WHERE root_message_id = @root_message_id;

-- name: GetThreadMessages :many
SELECT m.id, m.channel_id, m.channel_seq, m.sender_id, m.client_msg_id, m.body,
       m.forwarded_from_message_id, m.forwarded_from_sender_id, m.forwarded_from_sender_name,
       m.forwarded_from_conversation_kind,
       m.forwarded_from_conversation_title, m.forwarded_from_thread_title,
       m.thread_root_id, m.thread_seq, m.mention_everyone, m.edited_at, m.created_at
FROM messages m
WHERE m.thread_root_id = @root_message_id
  AND m.thread_seq > @after_thread_seq
ORDER BY m.thread_seq ASC;

-- name: DeleteMessageMentions :exec
DELETE FROM message_mentions
WHERE message_id = @message_id;

-- name: ListActiveChannelMemberIDs :many
SELECT user_id
FROM channel_members
WHERE channel_id = @channel_id
  AND is_archived = false
ORDER BY user_id;

-- name: ListMessageAttachmentsForDeleteTarget :many
SELECT ma.id,
       ma.conversation_id,
       ma.message_id,
       ma.file_name,
       ma.file_size,
       ma.mime_type,
       ma.storage_key,
       ma.thumbnail_storage_key,
       ma.thumbnail_mime_type,
       ma.thumbnail_file_size,
       ma.thumbnail_version,
       ma.uploaded_by,
       ma.created_at
FROM message_attachment ma
WHERE ma.message_id IN (
  SELECT m.id
  FROM messages m
  WHERE m.id = @message_id
     OR m.thread_root_id = @message_id
)
ORDER BY ma.created_at, ma.id;

-- name: InsertReaction :one
INSERT INTO reactions (message_id, user_id, emoji, created_at)
VALUES (@message_id, @user_id, @emoji, now())
ON CONFLICT DO NOTHING
RETURNING message_id, user_id, emoji, created_at;

-- name: DeleteReaction :one
DELETE FROM reactions
WHERE message_id = @message_id
  AND user_id    = @user_id
  AND emoji      = @emoji
RETURNING message_id, user_id, emoji, created_at;

-- name: IncrementReactionCount :one
INSERT INTO reaction_counts (message_id, emoji, count)
VALUES (@message_id, @emoji, 1)
ON CONFLICT (message_id, emoji) DO UPDATE
    SET count = reaction_counts.count + 1
RETURNING message_id, emoji, count;

-- name: DecrementReactionCount :one
UPDATE reaction_counts
SET count = count - 1
WHERE message_id = @message_id
  AND emoji      = @emoji
RETURNING message_id, emoji, count;

-- name: DeleteReactionCountIfZero :exec
DELETE FROM reaction_counts
WHERE message_id = @message_id
  AND emoji      = @emoji
  AND count      <= 0;

-- name: GetReactionCounts :many
SELECT message_id, emoji, count
FROM reaction_counts
WHERE message_id = @message_id
ORDER BY emoji ASC;

-- name: ListReactionUsersByMessageEmoji :many
SELECT r.user_id,
       COALESCE(NULLIF(u.display_name, ''), u.email) AS display_name,
       u.avatar_url
FROM reactions r
JOIN users u ON u.id = r.user_id
WHERE r.message_id = @message_id
  AND r.emoji = @emoji
ORDER BY r.created_at DESC, r.user_id;

-- name: ListUserChannels :many
SELECT c.id, c.kind, c.visibility, c.name, c.topic, c.is_archived,
       c.next_seq, c.last_activity_at, c.created_at
FROM channels c
JOIN channel_members cm ON cm.channel_id = c.id
WHERE cm.user_id = @user_id
  AND cm.is_archived = false
  AND c.is_archived = false
  AND c.hidden = false
ORDER BY c.last_activity_at DESC;
