# Msgnr — Corporate Messenger

A production-grade Slack-like team messenger built with Go and Vue 3. Installable as a Progressive Web App with offline-resilient app shell, Web Push notifications, and a Tauri-ready desktop abstraction layer.

## Architecture

- **Backend**: Go modular monolith (auth, chat, sequencing, bootstrap, sync, notifications, calls, tasks)
- **Frontend**: Vue 3 + TypeScript + Tailwind CSS, installable PWA
- **Media Plane**: LiveKit SFU for audio/video/screen sharing
- **Protocol**: Binary protobuf over WebSocket, event-sourced via append-only log

## Technology Stack

### Backend (Go)

- **Web Framework**: Custom HTTP server with `github.com/gobwas/ws` for WebSocket
- **Database**: PostgreSQL with `github.com/jackc/pgx/v5` driver, `sqlc` for type-safe queries
- **Configuration**: `github.com/spf13/viper` for environment-based config
- **Logging**: `go.uber.org/zap` for structured logging
- **Metrics**: `github.com/prometheus/client_golang` for Prometheus monitoring
- **Testing**: `github.com/stretchr/testify`, Testcontainers for integration tests
- **Cryptography**: `golang.org/x/crypto` for JWT and password hashing
- **Protobuf**: `google.golang.org/protobuf` for message serialization (buf-managed)

### Frontend (Vue 3)

- **Framework**: Vue 3.5, Vue Router 5, Pinia 3
- **Build**: Vite 6 with code-splitting (vendor-core, vendor-livekit, vendor-emoji, vendor-proto)
- **PWA**: `vite-plugin-pwa` (Workbox-based), service worker with precache, prompt-to-reload updates
- **Push Delivery**: Web Push (VAPID) via `github.com/SherClockHolmes/webpush-go`
- **Styling**: Tailwind CSS 3 with Slack-inspired dark theme
- **Components**: Ant Design Vue 4 (auto-imported)
- **Real-time**: LiveKit client SDK for voice/video calls
- **Proto**: `@bufbuild/protobuf` for typed WS protocol

## Quick Start

1. Copy environment configuration:
   ```bash
   cp .env.example .env
   ```

2. Install dependencies:
   ```bash
   make deps
   cd web && npm install
   ```

3. Run the backend:
   ```bash
   make run
   ```

4. Run the frontend (dev):
   ```bash
   cd web && npm run dev
   ```

## Development

### Build
```bash
make build                    # Go backend
cd web && npm run build       # Frontend (vue-tsc + vite build, generates SW)
cd web && npm run tauri:build # macOS desktop bundle (Tauri v2 shell)
```

### Run Tests
```bash
make test                     # Go tests (unit + integration via Testcontainers)
cd web && npm test            # Frontend tests (Vitest + jsdom)
```

### Desktop Dev (macOS)
```bash
cd web && npm run tauri:dev
```

### Generate Protocol Buffers
```bash
make proto                    # Regenerates Go + TypeScript from api/proto/packets.proto
```

### Generate SQL
```bash
make sqlc                     # Regenerates Go from internal/repo/queries/*.sql
```

## Configuration

The application uses Viper for configuration management. Configuration can be set via:

- `.env` file (see `.env.example`)
- Environment variables

Key configuration options:

| Variable | Description | Default |
|---|---|---|
| `PORT` | Server port | `8080` |
| `DATABASE_URL` | PostgreSQL connection string | — |
| `JWT_SECRET` | JWT signing secret | — |
| `LIVEKIT_URL` | LiveKit server URL | — |
| `LIVEKIT_API_KEY` | LiveKit API key | — |
| `LIVEKIT_API_SECRET` | LiveKit API secret | — |
| `VAPID_PUBLIC_KEY` | Web Push VAPID public key | — |
| `VAPID_PRIVATE_KEY` | Web Push VAPID private key | — |
| `VAPID_SUBJECT` | Web Push subject (`mailto:` or `https:`) | — |
| `PUSH_RATE_LIMIT_WINDOW` | In-memory per-user push rate limit window | `1s` |
| `PUSH_TTL_SECONDS` | Web Push TTL (seconds) | `60` |

## Project Structure

```
cmd/server/              # Application entry point (single binary)
internal/
  auth/                  # Authentication, JWT, user CRUD, avatar upload
  bootstrap/             # Paginated WS bootstrap (initial data load)
  calls/                 # LiveKit voice/video call management
  chat/                  # Messaging, reactions, threads, history
  config/                # Viper-based config from .env
  database/              # PostgreSQL connection pool (pgx)
  events/                # Append-only event log, LISTEN/NOTIFY, event bus
  admin/                 # Admin operations (user management)
  tasks/                 # Task tracker CRUD
  sync/                  # SyncSince recovery, ack cursor, retention
  storage/               # Minio object storage client
  ws/                    # WebSocket server, protobuf envelope dispatch
  logger/                # Zap structured logging
  metrics/               # Prometheus metrics
  push/                  # Web Push service + HTTP handlers
  repo/queries/          # SQL queries for sqlc generation
  gen/                   # Generated code (proto, sqlc)
api/proto/               # Protocol buffer definitions (buf-managed)
migrations/              # Database schema

web/                     # Vue 3 frontend
  public/                # Static assets, PWA icons, favicons
  src/
    components/          # Vue components (chat, sidebar, calls, tasks, admin)
    composables/         # Composables (session orchestrator, offline queue, PWA)
    services/            # HTTP clients, storage adapters, sound engine, ID generation
    stores/              # Pinia stores (auth, ws, chat, call, tasks)
    views/               # Route views (Login, Main, Admin)
    router/              # Vue Router config
    shared/proto/        # Generated TypeScript protobuf
```

## Features

- **Channels & DMs**: Public/private channels, direct messages, threaded replies
- **Real-time**: Binary protobuf over WebSocket, event-sourced consistency
- **Voice/Video Calls**: LiveKit-powered with noise suppression (RNNoise), echo cancellation, gain control
- **Task Tracker**: Built-in task management with custom fields, statuses, attachments
- **File Attachments**: Minio-backed object storage for images, documents, media
- **Unread Tracking**: Per-conversation unread counts with server-authoritative read cursors
- **Presence & Typing**: Online/away status, typing indicators
- **Admin Panel**: User management, force password change, workspace settings
- **PWA**: Installable from browser, service worker with precache, prompt-to-reload updates, offline-resilient app shell
- **Push Notifications**: VAPID-backed Web Push with service worker delivery and click-to-focus/open behavior
- **Notification Sounds**: Custom call ring (looping while invite is active) and message ping on inactive tabs (cooldown + notification-level aware)
- **Audio Settings**: Slack-style device selection, mic test with level meter, noise suppression / echo cancellation / AGC toggles, microphone gain slider

## Monitoring

Prometheus metrics on `/metrics` endpoint (when configured):

- `websocket_connections_total` / `websocket_connections_active`
- `messages_received_total` / `messages_sent_total`
- `database_connections_active`
- `http_requests_total` / `http_request_duration_seconds`
