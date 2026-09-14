# Events Package Notes for Agents

This package is the authoritative realtime backbone.

## Responsibilities

1. Append committed domain changes to `workspace_events`.
2. Validate DB `event_type` against the protobuf payload shape.
3. Deliver committed events through `pg_notify -> listener -> bus -> WS fanout`.
4. Decode stored JSON payloads back into `ServerEvent` values for replay and sync.
5. Preserve payload fidelity for downstream consumers (WS fanout, push delivery) that react to specific event families such as `message_created` and `call_invite_created`.

## Invariants

1. `AppendEventTx` and `NotifyEventTx` must be used in the same DB transaction as the domain write.
2. The listener must only publish events that already committed.
3. `event_seq` ordering must stay strictly increasing and replayable.
4. `event_type` text and proto oneof case must remain aligned with `internal/events/types.go` and `codec.go`.

## Change Guidance

1. When adding a new event type:
   - update `api/proto/packets.proto`
   - update `migrations/schema.sql` event type check
   - update `internal/events/types.go`
   - update `internal/events/codec.go`
   - add codec and integration coverage
2. Do not bypass `ValidateEventTypePayload`.
3. Keep JSON payloads compatible with `protojson` decoding from stored rows.

## Tests

1. Prefer `internal/events/integration_test.go` for commit/rollback/listener behavior.
2. Use unit tests for codec/type mapping only.
