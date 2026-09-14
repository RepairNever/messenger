# Views Notes for Agents

This directory owns route-level orchestration (page composition, lifecycle wiring, and cross-store coordination).

## Responsibilities

1. Compose feature panels and dialogs without duplicating store business rules.
2. Wire browser lifecycle events (focus/blur/visibility) to store/WS activity signals.
3. Keep route-level side effects explicit (realtime startup, push checks, invite handling).

## Invariants

1. `MainView` must keep client activity reporting (`setClientActive` + `sendSetClientWindowActivity`) consistent on focus/blur/visibility transitions.
2. Incoming call invite ring starts when an invite is active and stops when invites clear or view unmounts.
3. On unmount, unsubscribe listeners and stop active audio playback; do not break singleton sound engine reuse.
4. Admin user editing must treat bot users as integration-only principals: hide password mutation UI and expose integration-token editing instead.
5. Chat navigation that opens a conversation or thread should also request focus for the matching composer so click-driven and programmatic opens behave the same.
6. The profile settings modal in `MainView` is intentionally tabbed (`Profile`, `Status`, `Theme`, `Password`) so it fits normal viewport heights; do not collapse these sections back into one tall form.
7. Color theme selection is local-only, applies immediately from the `Theme` tab, and must not be coupled to profile save or backend profile APIs.
8. View-owned teleports, including profile/status emoji pickers and modal loading states, must use the current color theme tokens rather than fixed dark palette colors.

## Change Guidance

1. Do not move protocol/event interpretation from stores into views.
2. When adding route lifecycle effects, ensure cleanup in `onUnmounted`.
3. Keep settings/profile dialogs accessible and non-blocking for realtime flows.
4. If the admin user form diverges by role, keep the conditional UX explicit in the view layer rather than burying it inside generic field helpers.
5. When `MainView` routes a user into a conversation target, prefer store focus actions over direct DOM focus work in the view.
6. If adding or changing profile tabs, keep tab buttons keyboard/ARIA-friendly and add/update `MainView` tests for section visibility and immediate theme application.
