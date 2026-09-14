# Chat Package Notes for Agents

This package owns message, thread, reaction, unread, notification-level, and invite-related domain behavior.

## Responsibilities

1. Execute server-authoritative message writes and emit append-only events.
2. Maintain unread/read counters and notification side effects per conversation policy.
3. Build direct-delivery events for immediate multi-session convergence.

## Invariants

1. `notification_level` semantics are authoritative on the server:
 - `ALL`: normal unread/notification behavior
 - `MENTIONS_ONLY`: only mention/thread-relevant behavior
 - `NOTHING`: suppress unread + notifications
2. Event payloads emitted by chat must stay protocol-compatible with `api/proto/packets.proto`.
3. Read/unread convergence is cross-session and server-owned.

## Change Guidance

1. Prefer sqlc query changes for DB access unless transaction-local SQL is required.
2. When changing message/notification behavior, update integration tests and WS fanout assumptions.
3. Do not shift unread/notification policy enforcement to frontend.
