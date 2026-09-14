# Protocol Notes for Agents

This document describes the realtime protocol contract in `packets.proto`.

## Purpose

The protocol is designed for a Slack-like client lifecycle:
1. Authenticate over WebSocket.
2. Fetch one atomic bootstrap snapshot for sidebar state.
3. Receive realtime server events with strict global ordering.
4. Recover gaps using sync-by-sequence.

## Core Transport Envelope

All payloads are wrapped in `Envelope` with:
- `request_id`: request correlation.
- `trace_id`: distributed tracing correlation.
- `protocol_version`: protocol compatibility guard.
- `oneof payload`: concrete request/response/event body.

## Session and Handshake

Expected order:
1. `ClientHello`
2. `ServerHello`
3. `AuthRequest`
4. `AuthResponse`
5. `BootstrapRequest`
6. `BootstrapResponse`
7. ongoing `ServerEvent` stream

## Bootstrap and Sidebar State

`BootstrapResponse` is the canonical initial snapshot and contains:
- `snapshot_seq`: global event watermark of the snapshot.
- workspace/self metadata.
- `conversations[]`: sidebar channels and DMs.
- `unread[]`: server authoritative unread counters.
- `active_calls[]`: currently active calls.
- `pending_invites[]`: call invitations.
- `notifications[]`: unresolved notifications.
- `presence[]`: best-effort presence snapshot for initial hydration.

If result is paginated, use `has_more` and `next_page_token`.
`presence[]` is included on every bootstrap page.

## Global Realtime Ordering

`ServerEvent.event_seq` is globally monotonic.

Rules:
- client must apply events in sequence order.
- client tracks `last_applied_event_seq`.
- if a sequence gap is detected, client must call `SyncSinceRequest`.
- if server returns `need_full_bootstrap=true`, client must re-bootstrap.

## Sync Recovery

`SyncSinceRequest{after_seq,max_events}` requests missing events.
`SyncSinceResponse` returns contiguous events and seq window (`from_seq`, `to_seq`).

## Client Window Activity Signal

`SetClientWindowActivityRequest{is_active}` is a client-to-server runtime signal used by push gating.

Rules:
1. Clients should report on focus/blur/visibility transitions and after auth/bootstrap readiness.
2. This signal is ephemeral runtime state, not part of event replay semantics.
3. Connected sessions do not imply active windows; push suppression decisions use this signal.

## Client State Machine (Section 2)

Canonical states:
1. `DISCONNECTED`
2. `WS_CONNECTED`
3. `AUTHENTICATED`
4. `BOOTSTRAPPING`
5. `LIVE_SYNCED`
6. `RECOVERING_GAP`
7. `STALE_REBOOTSTRAP`

Implementation note:
1. The web client may expose extra transport-debug states such as `HELLO_SENT` and `AUTH_SENT`.
2. These are UI/debug refinements, not additional protocol lifecycle stages.
3. The canonical recovery model above remains the source of truth for behavior.

Required transitions:
1. `DISCONNECTED -> WS_CONNECTED` on websocket connect.
2. `WS_CONNECTED -> AUTHENTICATED` on successful `AuthResponse`.
3. `AUTHENTICATED -> BOOTSTRAPPING` immediately send `BootstrapRequest`.
4. `BOOTSTRAPPING -> LIVE_SYNCED` after atomic snapshot apply.
5. `LIVE_SYNCED -> RECOVERING_GAP` when `event_seq != last_applied + 1`.
6. `RECOVERING_GAP -> LIVE_SYNCED` after contiguous `SyncSinceResponse`.
7. `RECOVERING_GAP -> STALE_REBOOTSTRAP` when `need_full_bootstrap=true`.
8. `STALE_REBOOTSTRAP -> BOOTSTRAPPING` by sending a new `BootstrapRequest`.
9. Any state -> `DISCONNECTED` on transport close/error.

Client invariants:
1. `last_applied_event_seq` is monotonic and never decreases.
2. Snapshot apply is atomic across conversations/unread/notifications/calls.
3. Events with `event_seq <= last_applied_event_seq` are duplicates and must be ignored.
4. Unread counters are server-authoritative overwrite values.
5. Unknown event payloads should be skipped but `event_seq` still advances.

Reconnect strategy:
1. Re-authenticate first.
2. If local watermark exists, try `SyncSinceRequest` before full bootstrap.
3. If sync cannot be made contiguous, perform full bootstrap.

## Slack-Inspired Reconnect and Sync Policy

This protocol follows a practical model similar to Slack app-facing realtime behavior:
1. Use websocket for low-latency events.
2. Use snapshot/bootstrap for authoritative state hydration.
3. Use delta sync only for short, contiguous gaps.
4. Fall back to full bootstrap for long offline periods or non-contiguous gaps.

Rationale:
1. Long offline windows can produce very large event tails.
2. Replaying huge tails is slower and more failure-prone than fetching one fresh snapshot.
3. Server-side unread/read markers remain authoritative and avoid client drift.

Operational thresholds:
1. `SYNC_EVENT_LIMIT`: if `current_seq - after_seq` exceeds this limit, return `need_full_bootstrap=true`.
2. `SYNC_RETENTION_WINDOW`: if `after_seq` is older than retained event history, return `need_full_bootstrap=true`.
3. `MAX_SYNC_BATCH`: clamp `SyncSinceRequest.max_events` to a safe upper bound.

`SyncSinceResponse` guidance:
1. `need_full_bootstrap_reason` should explain why delta sync is refused (for telemetry and client behavior).
2. `suggested_retry_after_sec` can be used during transient incidents.
3. `server_sync_event_limit` helps clients understand server policy and tune reconnect UX.

Recommended reason codes:
1. `GAP_TOO_LARGE`
2. `GAP_OUT_OF_RETENTION`
3. `SERVER_RESHARD`
4. `DATA_RECOVERY`

## Unread Source of Truth

Unread state is server-owned:
- snapshot unread values from `BootstrapResponse.unread`.
- apply incremental changes from `ServerEvent` (`READ_COUNTER_UPDATED`).
- client should not treat local counters as authoritative.

## Event Taxonomy

Important event families:
- conversation lifecycle (`CONVERSATION_UPSERTED`, `CONVERSATION_REMOVED`)
- membership updates
- message creation
- unread updates
- notifications add/resolve
- call invites create/cancel
- call state changes
- raised-hand queue changes

Call lifecycle updates are delivered through `ServerEvent.call_state_changed`.
Raised-hand queue snapshots are delivered through `ServerEvent.call_raised_hands_changed`.

## Evolution Guidance

When evolving protocol:
- append new fields, avoid reusing field numbers.
- prefer additive changes and explicit new event types.
- preserve bootstrap + sync invariants (`snapshot_seq`, `event_seq`, `SyncSince`).

## Section 4: Pagination, Rate Limits, Multi-Device Consistency, Delivery

### Bootstrap pagination contract
1. Stable ordering for conversation pages:
 - primary sort: `last_activity_at DESC`
 - tie-breaker: `conversation_id ASC`
2. `BootstrapRequest.page_size_hint` default is 100, server clamps to safe min/max.
3. `BootstrapRequest.bootstrap_session_id`:
 - empty on first page request
 - required on continuation requests
4. `BootstrapResponse.bootstrap_session_id` must stay constant for all pages in one bootstrap flow.
5. `BootstrapResponse.snapshot_seq` must stay constant for all pages in one bootstrap flow.
6. If bootstrap expires mid-pagination, server should return `Error{code=BOOTSTRAP_EXPIRED}` and client restarts from page 1.
7. `workspace`, `active_calls`, `pending_invites`, and `notifications` are populated only on the first page (`page_index == 0`).
8. Clients must ignore `workspace`, `active_calls`, `pending_invites`, and `notifications` on continuation pages.

### Rate limits and backpressure
1. Server publishes runtime limits in `ServerHello.rate_limit_policy`.
2. Soft throttle uses `Error{code=RATE_LIMITED,retry_after_ms}`.
3. Hard backpressure overflow uses `Error{code=BACKPRESSURE_OVERFLOW}` and connection close.
4. Outbound queue overflow is recoverable through reconnect + sync/bootstrap.

### Multi-device consistency
1. Read/unread remains server-authoritative.
2. Read updates from one device must propagate to all devices of the same user via `READ_COUNTER_UPDATED`.
3. Notification resolve on one device must resolve on all devices via `NOTIFICATION_RESOLVED`.
4. Device-local state may differ transiently but must converge after applying the same `event_seq` watermark.

### Call invite lifecycle
1. Invite state machine:
 - `CREATED -> ACCEPTED | REJECTED | CANCELLED | EXPIRED`
2. `CallInviteSummary.state` is authoritative current invite state.
3. `CallInviteCancelledEvent.reason` should use values like `CANCELLED`, `EXPIRED`, `REJECTED`.
4. Invite actions use dedicated commands:
 - `AcceptCallInviteRequest`
 - `RejectCallInviteRequest`
 - `CancelCallInviteRequest`
 - `CallInviteActionAck`
5. ACL:
 - `accept/reject` only by invite recipient.
 - `cancel` only by inviter or admin.
6. Accept/reject on non-active invite should return `Error{code=INVITE_NOT_ACTIVE}`.
7. If a conversation already has an active call, creating new invite should return `Error{code=CALL_ALREADY_ACTIVE}`.

### Delivery semantics
1. WS event delivery is at-least-once.
2. Client must deduplicate by `event_id` and protect with `event_seq`.
3. Sequence gap rule:
 - if `event_seq == last_applied + 1`: apply
 - if `event_seq <= last_applied`: drop duplicate
 - if `event_seq > last_applied + 1`: enter gap recovery with `SyncSince`
4. Client sends `AckRequest(last_applied_event_seq)` in `batch+timer` mode:
 - after applying each event batch threshold.
 - by periodic heartbeat when stream is idle.
5. `AckResponse` handling:
 - if `ok=true`, client may treat `persisted_event_seq` as durable server resume cursor.
 - if `ok=false`, client keeps local watermark, retries `AckRequest` with backoff, and must not regress state.
 - repeated `ok=false` should be surfaced in telemetry and may trigger reconnect.

### Accepted error codes
1. `UNAUTHENTICATED`
2. `FORBIDDEN`
3. `BAD_REQUEST`
4. `RATE_LIMITED`
5. `BACKPRESSURE_OVERFLOW`
6. `BOOTSTRAP_EXPIRED`
7. `SYNC_NOT_CONTIGUOUS`
8. `INVITE_NOT_ACTIVE`
9. `CALL_ALREADY_ACTIVE`

### Acceptance criteria
1. Multi-page bootstrap returns stable `snapshot_seq` and `bootstrap_session_id`.
2. Short disconnects recover through sync without full bootstrap.
3. Long disconnects produce `need_full_bootstrap=true` with reason.
4. Outbound queue overflow produces controlled close and successful state recovery.
5. Cross-device read convergence is deterministic.
6. Invite expiration produces cancel event and clears badge/UI.

## Section 5: Threads, Reactions, Typing, Presence, Mentions

### Threads
1. Thread reply is a normal `MessageEvent` with:
 - `thread_root_message_id`
 - `thread_seq`
2. Channel timeline ordering remains `channel_seq`.
3. Thread timeline ordering is `thread_seq`.
4. Thread replay uses:
 - `SubscribeThreadRequest`
 - `SubscribeThreadResponse`
5. Parent message metadata updates are emitted via `THREAD_SUMMARY_UPDATED`.

### Reactions
1. Reaction commands:
 - `AddReactionRequest`
 - `RemoveReactionRequest`
 - `ReactionAck`
2. Reaction aggregate in message payload:
 - `MessageEvent.reactions[]` with `emoji,count`.
3. Delta updates use `REACTION_UPDATED` server event.
4. Server should treat duplicate add/remove operations as idempotent no-op success.

### Typing indicators (ephemeral)
1. Typing is not persisted in event log and not replayed by sync.
2. Messages:
 - `TypingRequest`
 - `TypingEvent`
3. Typing semantics:
 - `TypingEvent.is_typing=true`: mark user typing until `expires_at`.
 - `TypingEvent.is_typing=false`: clear typing indicator immediately.
 - TTL expiry is required as fallback safety.
4. Recommended operational policy:
 - client send interval >= 3 seconds per target
 - server TTL around 6 seconds

### Presence (best effort realtime)
1. Presence command:
 - `SetPresenceRequest`
2. Presence fanout:
 - `PresenceEvent`
3. Presence is bootstrap + realtime best effort and is not part of strict sync replay.
4. Fanout scope is membership-graph based:
 - when user A presence changes, server sends `PresenceEvent` only to users who share at least one conversation with A.
5. Bootstrap scope:
 - `BootstrapResponse.presence[]` includes only users participating in conversations present in the current bootstrap page.
6. Membership side effects for `MEMBERSHIP_CHANGED/JOINED`:
 - server sends joining user A `PresenceEvent` for participants of the new conversation that A has not seen yet.
 - server starts fanning out A presence to newly connected participants that previously had no shared conversation with A.
7. Leave/removal behavior:
 - if A no longer shares any conversation with a participant, server stops fanning out A presence to that participant.
 - no explicit presence-withdrawn event is required.
8. Invariant:
 - a client must never receive a `PresenceEvent.user_id` for a user absent from all known client conversations.

### Mentions and notifications
1. `MessageEvent` carries mention metadata:
 - `mentioned_user_ids[]`
 - `mention_everyone`
2. Per-conversation notification policy is enum-based:
 - `NOTIFICATION_LEVEL_ALL = 0`
 - `NOTIFICATION_LEVEL_MENTIONS_ONLY = 1`
 - `NOTIFICATION_LEVEL_NOTHING = 2`
3. Unread mentions remain server-authoritative through `UnreadCounter.unread_mentions`.
4. Mention-driven notifications should map to:
 - `NOTIFICATION_ADDED`
 - `NOTIFICATION_RESOLVED`

### Section 5 acceptance criteria
1. Thread replies preserve channel and thread ordering invariants.
2. Reconnect restores thread/reaction state without divergence.
3. Duplicate reaction operations are idempotent.
4. Typing indicators auto-expire and do not survive reconnect.
5. Mention unread counters converge across devices.

## Section 6: Hardening and Evolution Safety

### Strong typing over free-form strings
1. Use enums as the canonical wire contract:
 - `Error.code`
 - `SyncSinceResponse.need_full_bootstrap_reason`
 - `CallInviteSummary.state`
 - `CallInviteCancelledEvent.reason`
 - `MembershipChangedEvent.action`
 - `ConversationRemovedEvent.reason`
 - `NotificationSummary.type`
 - `WorkspaceSummary.self_role`
2. Boolean control flags are explicit where state transitions require them:
 - `TypingEvent.is_typing`

### Capability negotiation
1. Clients advertise supported features in `ClientHello.capabilities`.
2. Server responds with `ServerHello.accepted_capabilities`.
3. Feature rollout rule: a client must not use a feature unless accepted by server.

### Idempotency and response correlation
1. `SendMessageAck` includes:
 - `client_msg_id` echo
 - `deduped` flag
2. `ReactionAck` includes:
 - `client_op_id` echo
 - `applied` flag (`false` means idempotent no-op)

### Bootstrap observability
1. `BootstrapResponse` includes:
 - `page_index`
 - `page_size_effective`
 - `estimated_total_conversations`
2. These fields are intended for diagnostics and adaptive client UX.

### Event integrity contract
1. `ServerEvent.event_type` must match `ServerEvent.payload` case.
2. Server should reject/never emit mismatched pairs.
3. Client should treat mismatch as protocol error and trigger recovery sync.

### Rate-limit policy visibility
1. `RateLimitPolicy.max_sync_batch` defines hard clamp for `SyncSinceRequest.max_events`.
2. Clients should obey this value to avoid avoidable throttling.
