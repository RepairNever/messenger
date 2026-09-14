# Push Package Notes for Agents

This package owns Web Push subscription APIs and outbound push delivery.

## Responsibilities

1. Expose authenticated push endpoints (`/api/push/vapid-key`, `/api/push/subscribe`, `/api/push/subscribe` DELETE).
2. Deliver VAPID-backed Web Push for chat/call events.
3. Apply runtime safeguards: recipient filtering, rate limiting, TTL/urgency, stale-sub cleanup.

## Invariants

1. Chat push flow is message-driven (`message_created`) for all-new-message delivery semantics.
2. Push delivery must respect backend gating (active window sessions suppress push, inactive-only can receive push).
3. Chat pushes keep urgency high and collapse disabled (no chat collapse topic).
4. 410 responses must remove stale subscriptions.

## Change Guidance

1. Keep config behavior aligned with `internal/config` defaults (`PUSH_RATE_LIMIT_WINDOW`, `PUSH_TTL_SECONDS`, VAPID fields).
2. If recipient selection logic changes, validate with offline/active-window scenarios.
3. Update both handler and service tests when changing payload shape or push routing policy.
