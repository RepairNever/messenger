# Internal Package Notes for Agents

This directory contains the server-side runtime for the messenger.

## Structure

- `auth`: JWT, refresh-session rotation, WS principal verification.
- `bootstrap`: paginated snapshot bootstrap over WS.
- `chat`: messaging, reactions, thread replay, channel HTTP list endpoint.
- `chat` HTTP history (`GET /api/messages`) returns root timeline rows and includes server-derived `thread_reply_count` from `thread_summaries` for each root message.
- `events`: append-only event log, event bus, LISTEN/NOTIFY listener, codec.
- `integrations`: static Bearer-token HTTP endpoints for bot users; task/document DTO mapping stays here rather than leaking into `tasks` or `documents`.
- `push`: VAPID/Web Push subscription management and delivery.
- `sync`: `SyncSince`, ack cursor persistence, retention pruning policy.
- `ws`: websocket handshake, auth gate, authenticated payload dispatch.

## Working Rules

1. Preserve protocol-first behavior. If a runtime change affects WS payloads or event semantics, update `api/proto/packets.proto` and regenerate artifacts first.
2. Prefer query additions in `internal/repo/queries/*.sql` plus `sqlc generate` over handwritten SQL in service code, unless batching/transaction control makes handwritten SQL materially simpler.
3. Keep DB writes server-authoritative. Do not move unread, ordering, or recovery decisions into the client when the server already owns them.
4. Favor integration tests for DB-backed behavior and unit tests for pure mapping/validation logic.
5. Keep push delivery server-authoritative: recipient selection and runtime gating belong to backend state, not frontend assumptions.
6. When adding operational/automation surfaces for bots or integrations, keep static-token auth separate from interactive JWT session auth.

## Cross-Cutting Invariants

1. `workspace_events.event_seq` is the global ordering source for realtime and sync recovery.
2. WS auth must complete before any domain payload is handled.
3. Bootstrap + sync must remain safe under duplicate delivery and reconnect.
4. Any new behavior that changes recovery or ordering must be tested with reconnect/gap scenarios, not just happy-path request tests.
5. Thread summary-only state is not replay state: subscribe cursors for thread replay must come from cached replies, and empty cache must subscribe from seq `0`.
6. Push eligibility is window-activity-aware: connected WS sessions do not suppress push unless at least one session reports an active chat window.
