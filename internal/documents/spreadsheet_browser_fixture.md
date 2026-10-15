The browser fixture is an opt-in integration test with a fresh Testcontainers
PostgreSQL database, the production Documents HTTP handler/service, active JWT
sessions for two members, and the production event store/LISTEN/bus pipeline.
The `/ws` route uses the actual production protobuf WebSocket server, including
hello/auth, live event authorization, SyncSince replay, and persisted ACK cursors.
It binds only to `127.0.0.1`; it never reads the application's database settings.

Run from the repository root:

```sh
MSGNR_SHEET_BROWSER_FIXTURE=1 CGO_ENABLED=0 GOCACHE=/private/tmp/msgnr-spreadsheets-go-cache go test -tags=integration ./internal/documents -run '^TestIntegration_SpreadsheetBrowserFixture$' -count=1 -timeout=30m -v
```

Read `/private/tmp/msgnr-spreadsheet-browser-fixture.json` after it appears. It contains
`base_url`, `teamspace_id`, `document_id`, and two `users` with `id`, `email`,
`password`, `access_token`, and `refresh_token`. The file is mode 0600 and removed
on graceful shutdown. Use `Authorization: Bearer <access_token>` for production
HTTP routes. Auth login/refresh/profile routes are also available. Configure the
test Vite server to proxy `/api`, `/__fixture`, and `/ws` (with WebSocket proxying)
to this server; there is no CORS
exception. Refresh credentials are disposable test data.

Additional test-only routes:

- `GET /__fixture/ready`: readiness, initial document ID, last event sequence
  observed by the actual LISTEN/bus pipeline.
- `POST /__fixture/reset` with either member's bearer: creates a fresh spreadsheet
  in the shared teamspace and returns `{document_id,state}`. It does not clear
  existing documents, receipts, or ordered events.
- `GET /__fixture/events?after=0` with a member's bearer: persisted, authorized
  spreadsheet events in standard protobuf JSON and the bus observation cursor.
  Protobuf int64 fields are decimal strings. This inspection route is not the
  application's WebSocket transport; use `/ws` for that transport.
- `POST /__fixture/shutdown` with the first member's bearer: gracefully stops the
  server and removes the test database container. SIGINT/SIGTERM also clean up.

Defaults: port 8093, lifetime 20 minutes. Optional environment variables:
`MSGNR_SHEET_BROWSER_FIXTURE_PORT` (1024–65535),
`MSGNR_SHEET_BROWSER_READY_FILE` (readiness file path), and
`MSGNR_SHEET_BROWSER_FIXTURE_SECONDS` (1–3600). Ordinary integration runs skip this
test without `MSGNR_SHEET_BROWSER_FIXTURE=1`.
