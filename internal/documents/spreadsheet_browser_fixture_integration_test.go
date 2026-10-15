//go:build integration

package documents_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
	"google.golang.org/protobuf/encoding/protojson"
	"msgnr/internal/auth"
	"msgnr/internal/bootstrap"
	"msgnr/internal/chat"
	"msgnr/internal/config"
	"msgnr/internal/database"
	"msgnr/internal/documents"
	"msgnr/internal/events"
	"msgnr/internal/logger"
	syncsvc "msgnr/internal/sync"
	"msgnr/internal/testdb"
	"msgnr/internal/ws"
)

// TestIntegration_SpreadsheetBrowserFixture is an opt-in bridge for native
// browser integration tests. It never opens the configured application DB:
// testdb.New creates a fresh container and removes it at test cleanup. See
// spreadsheet_browser_fixture.md for the runner and loopback-only test routes.
func TestIntegration_SpreadsheetBrowserFixture(t *testing.T) {
	if os.Getenv("MSGNR_SHEET_BROWSER_FIXTURE") != "1" {
		t.Skip("set MSGNR_SHEET_BROWSER_FIXTURE=1 to run the isolated browser fixture")
	}
	port := 8093
	if raw := os.Getenv("MSGNR_SHEET_BROWSER_FIXTURE_PORT"); raw != "" {
		var err error
		port, err = strconv.Atoi(raw)
		require.NoError(t, err)
		require.True(t, port >= 1024 && port <= 65535, "fixture port must be unprivileged")
	}
	lifetime := 20 * time.Minute
	if raw := os.Getenv("MSGNR_SHEET_BROWSER_FIXTURE_SECONDS"); raw != "" {
		seconds, err := strconv.Atoi(raw)
		require.NoError(t, err)
		require.True(t, seconds >= 1 && seconds <= 3600)
		lifetime = time.Duration(seconds) * time.Second
	}
	readyPath := os.Getenv("MSGNR_SHEET_BROWSER_READY_FILE")
	if readyPath == "" {
		readyPath = "/private/tmp/msgnr-spreadsheet-browser-fixture.json"
	}
	// Remove a previous run's readiness marker before provisioning the new DB.
	require.NoError(t, removeFixtureReadyFile(readyPath))
	pool, dsn := testdb.New(t)
	ctx, cancel := context.WithTimeout(context.Background(), lifetime)
	defer cancel()
	ctx, stopSignal := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stopSignal()
	log := zap.NewNop()
	previousLog := logger.Logger
	logger.Logger = log
	t.Cleanup(func() { logger.Logger = previousLog })
	svc := documents.NewService(pool, nil)
	tokens := auth.NewTokenManager(uuid.NewString()+uuid.NewString(), 2*time.Hour)
	authSvc := auth.NewService(tokens, auth.NewRefreshSessionRepo(pool), auth.NewUserRepo(pool), pool, 2*time.Hour, log)
	password := "spreadsheet-test-fixture"
	hash, err := auth.HashPassword(password)
	require.NoError(t, err)
	type fixtureUser struct {
		ID           uuid.UUID `json:"id"`
		Email        string    `json:"email"`
		Password     string    `json:"password"`
		AccessToken  string    `json:"access_token"`
		RefreshToken string    `json:"refresh_token"`
	}
	users := make([]fixtureUser, 2)
	for i := range users {
		email := fmt.Sprintf("sheet-browser-%d-%s@example.test", i, uuid.NewString())
		var id uuid.UUID
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(email,password_hash,display_name,role) VALUES($1,$2,$3,'member') RETURNING id`, email, hash, fmt.Sprintf("Browser editor %d", i+1)).Scan(&id))
		pair, _, err := authSvc.Login(ctx, email, password, "spreadsheet-browser-fixture", "127.0.0.1")
		require.NoError(t, err)
		users[i] = fixtureUser{ID: id, Email: email, Password: password, AccessToken: pair.AccessToken, RefreshToken: pair.RefreshToken}
	}
	teamspace, err := svc.CreateTeamspace(ctx, documents.CreateTeamspaceParams{Name: "Isolated spreadsheet browser tests", IsPrivate: true, MemberIDs: []uuid.UUID{users[1].ID}, ActorID: users[0].ID}, "member")
	require.NoError(t, err)
	document, err := svc.CreateDocument(ctx, documents.CreateDocumentParams{TeamspaceID: teamspace.ID, Kind: documents.DocumentKindSpreadsheet, Title: "Browser workbook", ActorID: users[0].ID})
	require.NoError(t, err)
	store := events.NewStore(pool)
	bus := events.NewBus(log)
	_, observed, unsubscribe := bus.Subscribe(nil, 256)
	defer unsubscribe()
	var observedSeq atomic.Int64
	listenerDone := make(chan struct{})
	go func() {
		defer close(listenerDone)
		events.NewListener(events.ListenerConfig{DSN: dsn, CatchUpBatch: 256, RetryBackoff: 50 * time.Millisecond, RetryBackoffMax: time.Second}, store, bus, log).Run(ctx)
	}()
	go func() {
		for {
			select {
			case event, ok := <-observed:
				if !ok {
					return
				}
				observedSeq.Store(event.GetEventSeq())
			case <-ctx.Done():
				return
			}
		}
	}()

	mux := http.NewServeMux()
	h := documents.NewHandler(svc, authSvc, log, 50)
	h.RegisterRoutes(mux)
	auth.NewHandler(authSvc).RegisterRoutes(mux)
	cfg := &config.Config{
		WsOutboundQueueMax: 1024, EventBusSubscriberBuffer: 256,
		SyncEventLimit: 1000, MaxSyncBatch: 500, SyncRetentionWindow: 72,
		BootstrapDefaultPageSize: 100, BootstrapMaxPageSize: 200, BootstrapSessionTTL: 5 * time.Minute,
	}
	wsServer := ws.NewServer(&database.DB{Pool: pool}, cfg, authSvc,
		bootstrap.NewService(pool, cfg), nil, chat.NewService(pool, store),
		syncsvc.NewService(pool, cfg, store, authSvc.CanReceiveEvent), bus)
	wsServer.SetDocumentsService(svc)
	var sockets sync.WaitGroup
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		sockets.Add(1)
		defer sockets.Done()
		wsServer.Handler()(w, r)
	})
	requireAuth := func(next func(http.ResponseWriter, *http.Request, auth.Principal)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			const prefix = "Bearer "
			value := r.Header.Get("Authorization")
			if len(value) <= len(prefix) || value[:len(prefix)] != prefix {
				writeSpreadsheetFixtureJSON(w, http.StatusUnauthorized, map[string]string{"error": "missing token"})
				return
			}
			principal, err := authSvc.VerifyAccess(r.Context(), value[len(prefix):])
			if err != nil {
				writeSpreadsheetFixtureJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid or expired token"})
				return
			}
			next(w, r, principal)
		}
	}
	address := fmt.Sprintf("127.0.0.1:%d", port)
	ready := map[string]any{"base_url": "http://" + address, "teamspace_id": teamspace.ID, "document_id": document.ID, "users": users}
	mux.HandleFunc("/__fixture/ready", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeSpreadsheetFixtureJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}
		writeSpreadsheetFixtureJSON(w, http.StatusOK, map[string]any{"ready": true, "document_id": document.ID, "observed_event_seq": observedSeq.Load()})
	})
	mux.HandleFunc("/__fixture/reset", requireAuth(func(w http.ResponseWriter, r *http.Request, principal auth.Principal) {
		if r.Method != http.MethodPost {
			writeSpreadsheetFixtureJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}
		fresh, err := svc.CreateDocument(r.Context(), documents.CreateDocumentParams{TeamspaceID: teamspace.ID, Kind: documents.DocumentKindSpreadsheet, Title: "Browser workbook", ActorID: principal.UserID})
		if err != nil {
			writeSpreadsheetFixtureJSON(w, http.StatusInternalServerError, map[string]string{"error": "fixture service error"})
			return
		}
		state, err := svc.GetSpreadsheet(r.Context(), fresh.ID, principal.UserID)
		if err != nil {
			writeSpreadsheetFixtureJSON(w, http.StatusInternalServerError, map[string]string{"error": "fixture service error"})
			return
		}
		writeSpreadsheetFixtureJSON(w, http.StatusCreated, map[string]any{"document_id": fresh.ID, "state": state})
	}))
	mux.HandleFunc("/__fixture/events", requireAuth(func(w http.ResponseWriter, r *http.Request, principal auth.Principal) {
		if r.Method != http.MethodGet {
			writeSpreadsheetFixtureJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}
		after := int64(0)
		if raw := r.URL.Query().Get("after"); raw != "" {
			var err error
			after, err = strconv.ParseInt(raw, 10, 64)
			if err != nil || after < 0 {
				writeSpreadsheetFixtureJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid event cursor"})
				return
			}
		}
		stored, err := store.ListEventsAfterSeq(r.Context(), after, 1000)
		if err != nil {
			writeSpreadsheetFixtureJSON(w, http.StatusInternalServerError, map[string]string{"error": "fixture service error"})
			return
		}
		result := make([]json.RawMessage, 0, len(stored))
		for _, event := range stored {
			if event.Proto.GetSpreadsheetChanged() == nil {
				continue
			}
			allowed := authSvc.CanReceiveEvent(r.Context(), principal, event.Proto)
			if allowed {
				raw, err := protojson.Marshal(event.Proto)
				if err != nil {
					writeSpreadsheetFixtureJSON(w, http.StatusInternalServerError, map[string]string{"error": "fixture service error"})
					return
				}
				result = append(result, raw)
			}
		}
		writeSpreadsheetFixtureJSON(w, http.StatusOK, map[string]any{"events": result, "observed_event_seq": observedSeq.Load()})
	}))
	shutdown := make(chan struct{})
	var shutdownOnce sync.Once
	mux.HandleFunc("/__fixture/shutdown", requireAuth(func(w http.ResponseWriter, r *http.Request, principal auth.Principal) {
		if r.Method != http.MethodPost {
			writeSpreadsheetFixtureJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}
		if principal.UserID != users[0].ID {
			writeSpreadsheetFixtureJSON(w, http.StatusForbidden, map[string]string{"error": "fixture owner required"})
			return
		}
		writeSpreadsheetFixtureJSON(w, http.StatusOK, map[string]any{"stopping": true})
		shutdownOnce.Do(func() { close(shutdown) })
	}))
	listener, err := net.Listen("tcp", address)
	require.NoError(t, err)
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: time.Minute}
	// net/http does not close hijacked WebSocket connections on Shutdown.
	var hijackedMu sync.Mutex
	hijacked := make(map[net.Conn]struct{})
	server.ConnState = func(connection net.Conn, state http.ConnState) {
		if state == http.StateHijacked {
			hijackedMu.Lock()
			hijacked[connection] = struct{}{}
			hijackedMu.Unlock()
		}
	}
	defer server.Close()
	serveDone := make(chan error, 1)
	go func() { serveDone <- server.Serve(listener) }()
	rawReady, err := json.MarshalIndent(ready, "", "  ")
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(readyPath, rawReady, 0600))
	t.Cleanup(func() { _ = removeFixtureReadyFile(readyPath) })
	t.Logf("spreadsheet browser fixture ready: http://%s; credentials file: %s", address, readyPath)
	select {
	case <-ctx.Done():
	case <-shutdown:
	case err := <-serveDone:
		require.ErrorIs(t, err, http.ErrServerClosed)
	}
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	require.NoError(t, server.Shutdown(shutdownCtx))
	hijackedMu.Lock()
	for connection := range hijacked {
		_ = connection.Close()
	}
	hijackedMu.Unlock()
	socketsDone := make(chan struct{})
	go func() { sockets.Wait(); close(socketsDone) }()
	select {
	case <-socketsDone:
	case <-shutdownCtx.Done():
		t.Fatal("WebSocket handlers did not stop")
	}
	cancel()
	select {
	case <-listenerDone:
	case <-shutdownCtx.Done():
		t.Fatal("event listener did not stop")
	}
}

func writeSpreadsheetFixtureJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func removeFixtureReadyFile(path string) error {
	err := os.Remove(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
