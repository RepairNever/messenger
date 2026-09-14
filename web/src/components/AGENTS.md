# Components Notes for Agents

This directory contains UI components and interaction surfaces.

## Responsibilities

1. Render state from stores/composables; avoid owning domain authority.
2. Keep interaction semantics accessible (keyboard, ARIA, focus management).
3. Emit explicit events upward rather than mutating global state directly.

## Invariants

1. Components must tolerate async state transitions (reconnect, permission updates, delayed bootstrap).
2. Notification/push toggles should reflect source-of-truth state from composables/stores.
3. Visual-only changes must not alter protocol/store semantics.
4. Chat- and task-comment markdown display should stay consistent: rendered markdown surfaces use the shared marked-based helper path and `markdown-body` styling.
5. Image lightboxes should support both backdrop-click close and `Escape` close for keyboard parity.
6. Chat composers must accept explicit focus requests from parent orchestration; do not rely on global DOM queries to move focus into message inputs.
7. The web UI supports multiple color themes; component text/background/border colors should use semantic Tailwind tokens (`text-app-text`, `text-app-muted`, `bg-chat-*`, `border-chat-border`, `text-public_id`) instead of hard-coded dark-only grays where readability matters.
8. Task surfaces must keep task titles, creation-dialog inputs, status selects, task IDs, Kanban/list metadata, and rendered description code blocks readable in light, pink, and rose themes; avoid scoped `@apply text-white` / `text-gray-100` or fixed code-block accent colors for user-facing task text.
9. Teleported overlays and floating surfaces (emoji pickers, tag search, call controls, invite/input-device menus) are part of the themed UI; use semantic tokens there too, including third-party widget CSS overrides and inline accent props.

## Change Guidance

1. Keep heavy orchestration in views/stores, not leaf components.
2. When adding controls, include disabled/loading/error states and test IDs where existing patterns use them.
3. Maintain consistency with existing design language unless a deliberate redesign is requested.
4. When adding markdown rendering to a component, add/adjust tests to assert rendered HTML output rather than plain-text rendering.
5. For message-composer focus behavior, prefer explicit props/tokens or exposed methods over ad hoc `document.querySelector(...).focus()` logic.
6. When fixing theme readability, prefer semantic token substitutions and a targeted component regression over broad palette-specific CSS overrides.
7. Message entity chips and rendered tag links should use theme accent/selection tokens, not hard-coded cyan or dark-only foregrounds.
