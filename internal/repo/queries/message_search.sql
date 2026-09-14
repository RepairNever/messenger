-- name: IsSearchableConversationMember :one
SELECT EXISTS (
  SELECT 1
  FROM channels c
  JOIN channel_members cm
    ON cm.channel_id = c.id
   AND cm.user_id = @requester_id
   AND cm.is_archived = false
  WHERE c.id = @conversation_id
    AND c.is_archived = false
    AND c.hidden = false
) AS is_member;

-- name: SearchMessagesGlobal :many
WITH search_results AS (
  SELECT ('chat_message')::text AS source,
         ('chat:' || m.id::text)::text AS id,
         m.body::text AS body,
         m.created_at,
         m.sender_id::text AS actor_id,
         COALESCE(NULLIF(actor.display_name, ''), actor.email)::text AS actor_name,
         m.channel_id::text AS conversation_id,
         (CASE
            WHEN c.kind = 'dm' THEN COALESCE(dm_peer.display_name, dm_peer.email, c.name, 'Direct message')
            ELSE COALESCE(NULLIF(c.name, ''), c.kind)
          END)::text AS conversation_title,
         c.kind::text AS conversation_kind,
         c.visibility::text AS conversation_visibility,
         m.id::text AS message_id,
         COALESCE(m.thread_root_id::text, '')::text AS thread_root_message_id,
         ''::text AS task_id,
         ''::text AS task_public_id,
         ''::text AS task_title,
         ''::text AS task_comment_id
  FROM messages m
  JOIN channels c
    ON c.id = m.channel_id
   AND c.is_archived = false
   AND c.hidden = false
  JOIN channel_members cm_self
    ON cm_self.channel_id = c.id
   AND cm_self.user_id = @requester_id
   AND cm_self.is_archived = false
  JOIN users actor
    ON actor.id = m.sender_id
  LEFT JOIN LATERAL (
    SELECT COALESCE(NULLIF(u.display_name, ''), u.email) AS display_name,
           u.email
    FROM channel_members cm_other
    JOIN users u
      ON u.id = cm_other.user_id
    WHERE c.kind = 'dm'
      AND cm_other.channel_id = c.id
      AND cm_other.user_id <> @requester_id
      AND cm_other.is_archived = false
    ORDER BY cm_other.created_at ASC
    LIMIT 1
  ) dm_peer ON true
  WHERE m.body ILIKE @like_query::text ESCAPE '\'
    AND m.content_mode = 'plaintext'
    AND c.encryption_mode = 'none'

  UNION ALL

  SELECT ('task_comment')::text AS source,
         ('task-comment:' || tc.id::text)::text AS id,
         tc.body::text AS body,
         tc.created_at,
         tc.author_id::text AS actor_id,
         COALESCE(NULLIF(actor.display_name, ''), actor.email)::text AS actor_name,
         COALESCE(t.discussion_channel_id::text, '')::text AS conversation_id,
         ''::text AS conversation_title,
         ''::text AS conversation_kind,
         ''::text AS conversation_visibility,
         ''::text AS message_id,
         COALESCE(tc.thread_root_message_id::text, '')::text AS thread_root_message_id,
         t.id::text AS task_id,
         t.public_id::text AS task_public_id,
         t.title::text AS task_title,
         tc.id::text AS task_comment_id
  FROM task_comment tc
  JOIN task t
    ON t.id = tc.task_id
  JOIN users actor
    ON actor.id = tc.author_id
  WHERE tc.body ILIKE @like_query::text ESCAPE '\'

  UNION ALL

  SELECT ('task_comment_thread')::text AS source,
         ('task-comment-thread:' || m.id::text)::text AS id,
         m.body::text AS body,
         m.created_at,
         m.sender_id::text AS actor_id,
         COALESCE(NULLIF(actor.display_name, ''), actor.email)::text AS actor_name,
         m.channel_id::text AS conversation_id,
         ''::text AS conversation_title,
         ''::text AS conversation_kind,
         ''::text AS conversation_visibility,
         m.id::text AS message_id,
         m.thread_root_id::text AS thread_root_message_id,
         t.id::text AS task_id,
         t.public_id::text AS task_public_id,
         t.title::text AS task_title,
         tc.id::text AS task_comment_id
  FROM messages m
  JOIN channels c
    ON c.id = m.channel_id
   AND c.is_archived = false
   AND c.hidden = true
  JOIN channel_members cm_self
    ON cm_self.channel_id = c.id
   AND cm_self.user_id = @requester_id
   AND cm_self.is_archived = false
  JOIN task_comment tc
    ON tc.thread_root_message_id = m.thread_root_id
  JOIN task t
    ON t.id = tc.task_id
   AND m.channel_id = t.discussion_channel_id
  JOIN users actor
    ON actor.id = m.sender_id
  WHERE m.thread_root_id IS NOT NULL
    AND m.body ILIKE @like_query::text ESCAPE '\'
    AND m.content_mode = 'plaintext'
)
SELECT source, id, body, created_at, actor_id, actor_name,
       conversation_id, conversation_title, conversation_kind, conversation_visibility,
       message_id, thread_root_message_id,
       task_id, task_public_id, task_title, task_comment_id
FROM search_results
ORDER BY created_at DESC, id DESC
LIMIT @query_limit;

-- name: SearchMessagesInConversation :many
WITH search_results AS (
  SELECT ('chat_message')::text AS source,
         ('chat:' || m.id::text)::text AS id,
         m.body::text AS body,
         m.created_at,
         m.sender_id::text AS actor_id,
         COALESCE(NULLIF(actor.display_name, ''), actor.email)::text AS actor_name,
         m.channel_id::text AS conversation_id,
         (CASE
            WHEN c.kind = 'dm' THEN COALESCE(dm_peer.display_name, dm_peer.email, c.name, 'Direct message')
            ELSE COALESCE(NULLIF(c.name, ''), c.kind)
          END)::text AS conversation_title,
         c.kind::text AS conversation_kind,
         c.visibility::text AS conversation_visibility,
         m.id::text AS message_id,
         COALESCE(m.thread_root_id::text, '')::text AS thread_root_message_id,
         ''::text AS task_id,
         ''::text AS task_public_id,
         ''::text AS task_title,
         ''::text AS task_comment_id
  FROM messages m
  JOIN channels c
    ON c.id = m.channel_id
   AND c.id = @conversation_id
   AND c.is_archived = false
   AND c.hidden = false
  JOIN channel_members cm_self
    ON cm_self.channel_id = c.id
   AND cm_self.user_id = @requester_id
   AND cm_self.is_archived = false
  JOIN users actor
    ON actor.id = m.sender_id
  LEFT JOIN LATERAL (
    SELECT COALESCE(NULLIF(u.display_name, ''), u.email) AS display_name,
           u.email
    FROM channel_members cm_other
    JOIN users u
      ON u.id = cm_other.user_id
    WHERE c.kind = 'dm'
      AND cm_other.channel_id = c.id
      AND cm_other.user_id <> @requester_id
      AND cm_other.is_archived = false
    ORDER BY cm_other.created_at ASC
    LIMIT 1
  ) dm_peer ON true
  WHERE m.body ILIKE @like_query::text ESCAPE '\'
    AND m.content_mode = 'plaintext'
    AND c.encryption_mode = 'none'
)
SELECT source, id, body, created_at, actor_id, actor_name,
       conversation_id, conversation_title, conversation_kind, conversation_visibility,
       message_id, thread_root_message_id,
       task_id, task_public_id, task_title, task_comment_id
FROM search_results
ORDER BY created_at DESC, id DESC
LIMIT @query_limit;
