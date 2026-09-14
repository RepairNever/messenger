# Auth Package Notes for Agents

This package owns HTTP auth and WS principal verification.

## Responsibilities

1. Login, refresh rotation, and logout over HTTP.
2. Refresh-session persistence and revocation.
3. Access-token verification for WS and authenticated handlers.
4. Channel-scoped authorization checks for server-pushed events.
5. Auth middleware behavior is shared by push subscription endpoints (`/api/push/*`) and must stay consistent with WS principal rules.
6. Bot users are interactive-auth denied principals; static integration-token auth for bots must not be merged into JWT session codepaths.

## Invariants

1. Refresh rotates the refresh token in-place on the existing session row; do not mint a new session ID during normal refresh.
2. Blocked users must fail both login/refresh and WS access verification.
3. WS `Principal` is derived from a verified access token plus an active refresh session row.
4. Auth metrics/logging should distinguish invalid credentials, blocked users, and internal errors.
5. `role = bot` must fail login/refresh/interactive access-token verification even when the user row is active.

## Change Guidance

1. Keep HTTP handler behavior thin; business rules belong in `service.go`.
2. Reuse repository interfaces for tests instead of reaching directly into DB where unit tests suffice.
3. If auth payloads change, update both HTTP handlers and WS auth response wiring.
4. Do not weaken session checks to trust JWT claims alone.
5. Preserve shared-browser-session behavior across tabs: refresh should keep existing access tokens valid until expiry or explicit logout.
6. Keep integration-token hashing/storage rules aligned with refresh-token hashing semantics; never persist raw tokens.

## Tests

1. Unit-test token and service logic first.
2. Use integration coverage only when DB-backed session behavior is the point of the change.
