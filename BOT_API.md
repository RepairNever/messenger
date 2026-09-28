# Bot API

This document describes the versioned HTTP API under `/api/bot/v1/*` that the external LLM Bot Service integrates over. The Bot Service consumes workspace events and acts in the workspace (posting replies, commenting on tasks) exclusively through these endpoints — **bots never open a WebSocket connection**; the event stream is HTTP long-polling (`GET /api/bot/v1/events`).

## Authentication

Bot API auth is identical to the Integration API. Provisioning is described in [INTEGRATION.md](INTEGRATION.md#provision-a-bot-user) (admin-created `role = bot` user with one active static token).

Send the token in the `Authorization` header:

```http
Authorization: Bearer <your-static-token>
```

- `401 {"error":"missing token"}` when the header is absent.
- `401 {"error":"invalid token"}` when the token is unknown, revoked, or not attached to an active bot user.

All responses use the common error format `{"error": "message"}`. Path or query values that fail UUID parsing return `400 {"error":"invalid <x> id"}`.

## Rate limits

- A per-bot token bucket (default 10 requests/sec, burst 20 — server-side configurable) applies to every request after token verification. On limit: `429 {"error":"rate limit exceeded"}` with a `Retry-After: 1` header.
- At most 2 concurrent `GET /events` requests with `wait_seconds > 0` per bot (configurable). A third simultaneous long-poll gets `429 {"error":"too many concurrent polls"}`. Plain polls (`wait_seconds=0`) are exempt.

## Versioning

`/api/bot/v1` may gain additive changes (new endpoints, new optional fields, new event types) within v1. Breaking changes (removals, semantic changes) will go to a new `/api/bot/v2` prefix.

## Endpoints

### Get own identity

`GET /api/bot/v1/me`

```json
{"user_id": "…uuid…", "display_name": "Helpful Bot", "email": "bot@example.com", "role": "bot"}
```

### Discover joinable public channels

`GET /api/bot/v1/channels` — public channels the bot is **not** yet a member of.

```json
{"channels": [{"id": "…uuid…", "name": "general", "kind": "channel", "visibility": "public", "last_activity_at": "2026-09-21T10:00:00Z"}]}
```

### Join public channels

`POST /api/bot/v1/channels/join`

```json
{"channel_ids": ["…uuid…"]}
```

- 1..100 UUIDs; idempotent; only public channels join, unknown/private ids are skipped.
- Empty list → `400`.

```json
{"joined": [{"id": "…uuid…", "name": "general"}]}
```

Channel invites do not apply to bots: the bot self-joins public channels and becomes a member of private channels only through task discussion channels (see below).

### List conversations

`GET /api/bot/v1/conversations` — every channel the bot is an active member of, most recently active first. DM rows carry an empty `name` (resolve the peer via the members endpoint). Hidden task discussion channels are included (`hidden: true`) — the bot needs them for conversation→task resolution.

```json
{"conversations": [{"id": "…uuid…", "kind": "channel", "visibility": "public", "name": "general", "hidden": false, "member_count": 12, "last_activity_at": "2026-09-21T10:00:00Z"}]}
```

### List conversation members

`GET /api/bot/v1/conversations/{id}/members`

```json
{"members": [{"user_id": "…uuid…", "display_name": "Bob", "email": "bob@example.com"}]}
```

A conversation that does not exist and a conversation the bot is not a member of are indistinguishable: both return `403 {"error":"not a channel member"}`. There is no 404 path.

### Resolve a task discussion channel

`GET /api/bot/v1/conversations/{id}/task` — resolves a (hidden) task discussion channel to its task.

```json
{"task_id": "…uuid…", "public_id": "DEV-42"}
```

`404 {"error":"not a task discussion channel"}` when the conversation is not a task discussion channel (including non-member conversations — check membership via `GET /conversations` first).

### Send a message / thread reply

`POST /api/bot/v1/messages`

```json
{
  "conversation_id": "…uuid…",
  "body": "Here is my analysis",
  "client_msg_id": "bot-evt-4512",
  "thread_root_message_id": null,
  "entities": [{"kind": "user", "target_id": "…uuid…", "label": "@Bob", "start": 0, "end": 4}]
}
```

- `conversation_id` — required UUID.
- `body` — required, 1..32000 runes after trimming.
- `client_msg_id` — **required**, 1..128 characters of `[A-Za-z0-9._:~-]`. Deduplication is keyed on `(conversation_id, sender, client_msg_id)`: retrying the same id returns the original message with `"deduped": true` and creates nothing — always derive it deterministically (e.g. `bot-<trigger-event-id>`).
- `thread_root_message_id` — optional UUID; set it to reply in a thread.
- `entities` — optional mentions. `kind` is `user`, `task`, or `document`; entity validation (offsets match the label inside the body, user targets are active channel members, canonical hrefs) runs server-side; failures return `400`.

```json
{"message_id": "…uuid…", "channel_seq": 42, "created_at": "2026-09-21T10:00:00Z", "client_msg_id": "bot-evt-4512", "deduped": false}
```

Errors: `403` not a channel member (or the conversation is E2EE-encrypted — bots cannot write there); `404` unknown thread root; `400` invalid body / entity / thread / client_msg_id.

### Read message history / thread replay

`GET /api/bot/v1/messages?conversation_id=…uuid…` — two modes:

- **Channel mode** (no `thread_root_message_id`): root-level messages, paginated newest-window-first — each page is returned oldest→newest within the fetched window; walk backward through history with `before_channel_seq` (exclusive upper bound) and `limit` (default 50, clamped 1..200).

  ```json
  {"messages": [ … ], "has_more": true, "next_before_channel_seq": 123}
  ```

  `next_before_channel_seq` is present only when `has_more` is true (the `channel_seq` of the oldest returned message).

- **Thread mode** (`thread_root_message_id=…uuid…`): all replies with `thread_seq > after_thread_seq` (default 0), ascending.

  ```json
  {"messages": [ … ], "current_thread_seq": 7, "reply_count": 7}
  ```

Message objects:

```json
{
  "id": "…uuid…",
  "conversation_id": "…uuid…",
  "sender_id": "…uuid…",
  "sender_name": "Bob",
  "body": "text",
  "channel_seq": 42,
  "thread_seq": 0,
  "thread_root_message_id": null,
  "thread_reply_count": 3,
  "mention_everyone": false,
  "created_at": "2026-09-21T10:00:00Z",
  "edited_at": null,
  "entities": [{"kind": "user", "target_id": "…uuid…", "label": "@Bob", "href": "", "start": 0, "end": 4}],
  "reactions": [{"emoji": "👍", "count": 2}],
  "attachments": [{"attachment_id": "…uuid…", "file_name": "a.png", "mime_type": "image/png", "file_size": 1234}],
  "content_mode": "plaintext"
}
```

`thread_reply_count` is populated only in channel mode. Messages inside end-to-end-encrypted DMs come back with an empty `body` and `content_mode: "dm_pairwise_signal_v1"` — E2EE content is not a bot surface; skip those messages.

### Get task context

`GET /api/bot/v1/tasks/{public_id}` — same response shape as `GET /api/integrations/tasks/{public_id}` (template field metadata and status included). `404 {"error":"not found: task"}` for unknown ids.

### List task comments

`GET /api/bot/v1/tasks/{public_id}/comments` — chronological.

```json
{"comments": [{"id": "…uuid…", "task_id": "…uuid…", "author_id": "…uuid…", "author_name": "Bob", "body": "text", "thread_root_message_id": null, "created_at": "…", "updated_at": "…", "attachment_count": 0}]}
```

### Create a task comment

`POST /api/bot/v1/tasks/{public_id}/comments`

```json
{"body": "bot analysis here"}
```

- `body` required, 1..32000 runes. The bot is the author; this also emits a `task_comment_created` event. Attachments are not part of the bot contract in v1.

`201` returns the created comment (same shape as the list items, `attachment_count: 0`).

### Search messages

`GET /api/bot/v1/search/messages?q=zebra&limit=20` — workspace-wide over conversations the bot can read; `limit` default 20, clamp 1..50; minimum query length 2 runes (`400` otherwise). Results carry provenance (`source` is `chat_message`, `task_comment`, or `task_comment_thread`, plus task/comment ids where applicable).

### Search documents

`GET /api/bot/v1/search/documents?q=handbook` — teamspace-scoped knowledge-base search; results are limited to teamspaces the bot belongs to. Blank `q` → `400`.

```json
{"results": [{"id": "…uuid…", "teamspace_id": "…uuid…", "teamspace_name": "Engineering", "title": "Onboarding Handbook", "snippet": "…"}]}
```

### Get a document

`GET /api/bot/v1/documents/{id}` — read a knowledge-base document. `403` when the bot is not a member of the document's teamspace, `404` when it does not exist.

```json
{"id": "…uuid…", "teamspace_id": "…uuid…", "parent_id": null, "title": "Onboarding Handbook", "content_markdown": "# …", "created_by": "…uuid…", "updated_by": "…uuid…", "created_at": "…", "updated_at": "…"}
```

Documents are read-only knowledge input for bots; document comments do not exist.

## Event stream

`GET /api/bot/v1/events?after_seq=0&limit=200&wait_seconds=30`

- `after_seq` (default 0) — return events with `event_seq > after_seq`.
- `limit` (default 200, 1..500 server-capped).
- `wait_seconds` (default 0, capped at 30 by default) — hold the request open when fully caught up, until a new event arrives or the wait expires.

```json
{
  "events": [
    {
      "event_seq": 4512,
      "event_id": "…uuid…",
      "event_type": "message_created",
      "occurred_at": "2026-09-21T10:00:00Z",
      "conversation_id": "…uuid…",
      "payload": { "messageId": "…", "senderId": "…", "body": "…", "channelSeq": 42, … }
    }
  ],
  "next_cursor": 4512,
  "latest_seq": 4600,
  "has_more": false,
  "gap_beyond_retention": false
}
```

`payload` is the JSON rendering of the protobuf event payload (`MessageEvent`, `TaskCommentCreatedEvent`, … — same shapes the web client consumes).

### Which events are delivered

| Event type | Delivered when |
|---|---|
| `task_comment_created` | always (task data is org-wide readable) |
| `message_created`, `message_deleted` | the conversation is in the bot's active memberships |
| `conversation_upserted` | the conversation is in the bot's active memberships |
| `conversation_removed` | always (defensive; not persisted today) |
| `membership_changed` | conversation in memberships, or the change concerns the bot itself (defensive; not persisted today) |

Everything else (read counters, notifications, presence, reactions, edits, …) is **not** exposed. Notably `message_updated` is excluded: the bot may act on stale message bodies until it re-reads history.

### Cursor semantics

- Poll with `after_seq = next_cursor` from the previous response. The cursor advances past an event only when that event was returned, or when it was filtered out at scan time — never past a returned-but-truncated tail, so paging with a small `limit` never drops admissible events.
- Membership is evaluated per scan: an event skipped because the bot had not joined yet is **not** re-delivered after a later join — recover such history via `GET /messages`.
- Events caused by the bot itself (its own messages and comments) **do** appear in the stream; ignore payload senders/authors equal to your own `user_id` (`senderId` / `authorId`).
- Delivery is at-least-once over the log: consumers must be idempotent (deterministic `client_msg_id` covers writes).
- Catch-up behavior: when events exist past the cursor but all of them are inadmissible, a `wait_seconds>0` poll returns immediately with `events: []` and an advanced `next_cursor` — keep re-polling until the response parks at the tail (an empty response that took ~`wait_seconds` to arrive).

### Gaps beyond retention

The event log is pruned after 72 h. If `after_seq > 0` and `after_seq + 1` is below the oldest retained sequence, the response is:

```json
{"events": [], "next_cursor": <latest_seq>, "latest_seq": <latest_seq>, "has_more": false, "gap_beyond_retention": true}
```

A fresh cursor (`after_seq=0`, the default) is exempt: the first poll simply starts at the oldest retained sequence — bootstrap your read-model state from the read endpoints before switching to the stream.

On `gap_beyond_retention: true` the client **MUST re-bootstrap from the read endpoints** (`/conversations`, `/messages`, `/tasks/.../comments`) — the returned `next_cursor` is the current `latest_seq` (the newest end of the log), so a client that ignores the flag silently skips the pruned range.

### Detecting channel removal

`membership_changed` and `conversation_removed` are not persisted to the event log today, so the bot cannot learn of its removal from a channel through the stream. Detect removal operationally instead: the channel disappears from `GET /conversations` and subsequent writes return `403`.

## Task discussion channels

Opening a thread under a task comment (by a human) lazily creates a hidden private discussion channel for that task. The bot is a member of every task discussion channel and can:

- receive its `message_created` events (thread replies) through the stream,
- read the thread via `GET /messages?conversation_id=<discussion_channel>&thread_root_message_id=<root>`,
- resolve the channel back to the task via `GET /conversations/{id}/task`.

`task_comment_created` payloads carry `discussionChannelId` when the task already has a discussion channel (absent otherwise). `threadRootMessageId` is reserved for forward compatibility and is currently never populated — discover the thread root via `GET /tasks/{public_id}/comments` (`thread_root_message_id`) or from the discussion channel's `message_created` events. (Protojson omits empty fields, so absent means empty.)

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `BOT_API_ENABLED` | `true` | feature flag for the whole `/api/bot/v1` group |
| `BOT_API_MAX_WAIT_SECONDS` | `30` | server-side cap on `wait_seconds` |
| `BOT_API_EVENTS_MAX_LIMIT` | `500` | cap on `limit` for `/events` |
| `BOT_API_RATE_LIMIT_RPS` | `10` | per-bot token bucket rate |
| `BOT_API_RATE_LIMIT_BURST` | `20` | token bucket burst |
| `BOT_API_MAX_CONCURRENT_POLLS` | `2` | concurrent `wait_seconds>0` polls per bot |
