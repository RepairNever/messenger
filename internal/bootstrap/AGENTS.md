# Bootstrap Package Notes for Agents

This package serves the paginated WS bootstrap snapshot.

## Responsibilities

1. Start a bootstrap session on page 0.
2. Materialize deterministic conversation ordering into `bootstrap_session_items`.
3. Return page-scoped conversation/unread/presence data and first-page-only shell fields.
4. Enforce continuation validation with `bootstrap_session_id`, `client_instance_id`, expiry, and page token.

## Invariants

1. `snapshot_seq` must be stable across all pages in one bootstrap session.
2. `bootstrap_session_id` must remain stable across all pages in one bootstrap session.
3. Continuation pages must replay the stored session ordering, not live membership order.
4. `workspace`, `active_calls`, `pending_invites`, and `notifications` are first-page-only.
5. Invalid or expired continuations must fail deterministically, never silently downgrade to a fresh bootstrap.
6. Conversation summaries must carry server-authoritative `notification_level` values for client-side notification behavior.

## Change Guidance

1. Treat page tokens as opaque hints; stored session rows are the authority.
2. Keep ordering stable: `last_activity_at DESC`, then `conversation_id ASC`.
3. Be careful with performance when materializing large session item sets.
4. If bootstrap shape changes, update both backend service logic and the web snapshot apply path.

## Tests

1. Cover first page, continuation, client mismatch, expiry, and deterministic replay.
2. Include reconnect-style cases when changing continuation validation or token handling.
