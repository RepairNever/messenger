# Composables Notes for Agents

This directory wraps browser/platform APIs behind reusable Vue composables.

## Responsibilities

1. Encapsulate browser capability checks and fallbacks (media devices, push, SW registration).
2. Provide reactive, testable contracts to stores/views.
3. Keep side-effect boundaries clear (subscribe/unsubscribe, permission prompts, timers).

## Invariants

1. Push subscription logic must handle missing SW registration gracefully and surface actionable errors.
2. Browser permission states are best-effort and can change outside app control; re-check on open/focus flows.
3. Composables should not embed domain policy owned by backend (unread/notification authority).
4. `useColorTheme` is the single runtime path that applies color theme CSS variables to `document.documentElement`; keep root dataset values (`data-color-theme`, `data-color-scheme`) in sync with the active preset.
5. Theme application should set only the RGB CSS variables consumed by Tailwind/CSS; avoid unused parallel variables unless a real consumer is added with tests.

## Change Guidance

1. Prefer feature detection over user-agent branching where possible.
2. Keep composable APIs narrow and explicit; return only state/actions required by callers.
3. When behavior changes affect UX-critical flows (push, session orchestration), update tests and user-facing error text together.
4. If changing the theme token mapping, update the composable test that verifies all registry tokens map to CSS variable names.
