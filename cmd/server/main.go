package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.uber.org/zap"

	"msgnr/internal/admin"
	"msgnr/internal/auth"
	"msgnr/internal/bootstrap"
	"msgnr/internal/calls"
	"msgnr/internal/chat"
	"msgnr/internal/config"
	"msgnr/internal/database"
	"msgnr/internal/dayoffs"
	"msgnr/internal/documents"
	"msgnr/internal/events"
	"msgnr/internal/integrations"
	"msgnr/internal/logger"
	"msgnr/internal/push"
	"msgnr/internal/search"
	"msgnr/internal/storage"
	syncsvc "msgnr/internal/sync"
	"msgnr/internal/tasks"
	"msgnr/internal/ws"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		panic("failed to load config: " + err.Error())
	}

	if err := logger.Init(cfg.IsDev()); err != nil {
		panic("failed to initialise logger: " + err.Error())
	}
	defer logger.Sync()

	log := logger.Logger

	db, err := database.Connect(cfg)
	if err != nil {
		log.Fatal("Failed to connect to database", zap.Error(err))
	}
	defer db.Close()

	// Auth components
	tokenMgr := auth.NewTokenManager(cfg.JWTSecret, cfg.JWTAccessTokenTTL)
	sessionRepo := auth.NewRefreshSessionRepo(db.Pool)
	userRepo := auth.NewUserRepo(db.Pool)
	authSvc := auth.NewService(tokenMgr, sessionRepo, userRepo, db.Pool, cfg.JWTRefreshTokenTTL, log)
	authHandler := auth.NewHandler(authSvc)

	// Event pipeline
	eventStore := events.NewStore(db.Pool)
	eventBus := events.NewBus(log)
	listenerCfg := events.ListenerConfig{
		DSN:             cfg.DatabaseURL,
		CatchUpBatch:    cfg.EventListenerCatchupBatch,
		RetryBackoff:    cfg.EventListenerRetryBackoff,
		RetryBackoffMax: 10 * time.Second,
	}
	eventListener := events.NewListener(listenerCfg, eventStore, eventBus, log)

	chatSvc := chat.NewService(db.Pool, eventStore)
	chatSvc.SetLogger(log)
	chatHandler := chat.NewHandler(chatSvc, authSvc, cfg)
	searchSvc := search.NewService(db.Pool)
	searchHandler := search.NewHandler(searchSvc, authSvc, log)
	callSvc := calls.NewService(db.Pool, eventStore, cfg)
	callHandler := calls.NewHandler(callSvc)
	bootstrapSvc := bootstrap.NewService(db.Pool, cfg)
	syncSvc := syncsvc.NewService(db.Pool, cfg, eventStore, authSvc.CanReceiveEvent)

	wsServer := ws.NewServer(db, cfg, authSvc, bootstrapSvc, callSvc, chatSvc, syncSvc, eventBus)
	eventListener.SetPresenceHandler(wsServer.HandlePresenceNotification)
	listenerCtx, listenerCancel := context.WithCancel(context.Background())
	listenerStopped := make(chan struct{})
	go func() {
		defer close(listenerStopped)
		eventListener.Run(listenerCtx)
	}()
	chatHandler.SetNotifier(wsServer)

	// Push notifications (Web Push / VAPID)
	pushSvc := push.NewService(db.Pool, cfg, wsServer)
	pushHandler := push.NewHandler(pushSvc, authSvc)
	wsServer.SetPushNotifier(pushSvc)
	if pushSvc.Enabled() {
		if cfg.VAPIDSubject == "" {
			log.Warn("VAPID_SUBJECT is not set; push delivery will fail — set to mailto:admin@yourdomain.com")
		}
		log.Info("Push notifications enabled (VAPID keys configured)")
	} else {
		log.Info("Push notifications disabled (VAPID keys not configured)")
	}

	// Periodic cleanup of stale push subscriptions (unused for 30+ days).
	pushCleanupCtx, pushCleanupCancel := context.WithCancel(context.Background())
	pushCleanupDone := make(chan struct{})
	go func() {
		defer close(pushCleanupDone)
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-pushCleanupCtx.Done():
				return
			case <-ticker.C:
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				if err := pushSvc.CleanupStaleSubscriptions(ctx); err != nil {
					log.Warn("Push subscription cleanup failed", zap.Error(err))
				}
				cancel()
			}
		}
	}()

	callExpiryCtx, callExpiryCancel := context.WithCancel(context.Background())
	callExpiryDone := make(chan struct{})
	go func() {
		defer close(callExpiryDone)
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-callExpiryCtx.Done():
				return
			case <-ticker.C:
				runCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				result, err := callSvc.ExpireInvites(runCtx)
				cancel()
				if err != nil {
					log.Warn("Call invite expiry sweep failed", zap.Error(err))
					continue
				}
				if len(result.DirectDeliveries) > 0 {
					wsServer.SendCallDirectServerEvents(result.DirectDeliveries)
				}
			}
		}
	}()

	adminSvc := admin.NewService(db.Pool)
	adminHandler := admin.NewHandler(adminSvc, authSvc, wsServer, log)

	storageClient, err := storage.New(cfg)
	if err != nil {
		log.Fatal("Failed to connect to Minio", zap.Error(err))
	}
	authSvc.ConfigureAvatars(storageClient, cfg.AvatarMaxSizeMB, eventStore)
	chatSvc.ConfigureAttachments(storageClient, cfg.AttachmentMaxSizeMB)
	adminSvc.SetLogger(log)
	adminSvc.ConfigureMessageAttachmentStorage(storageClient)

	tasksSvc := tasks.NewService(db.Pool, storageClient)
	tasksSvc.SetDescriptionHistoryLimit(cfg.TaskDescriptionHistoryLimit)
	taskStagedCleanupCtx, taskStagedCleanupCancel := context.WithCancel(context.Background())
	taskStagedCleanupDone := make(chan struct{})
	go func() {
		defer close(taskStagedCleanupDone)
		const stagedAttachmentTTL = 24 * time.Hour
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-taskStagedCleanupCtx.Done():
				return
			case <-ticker.C:
				runCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				deleted, err := tasksSvc.CleanupExpiredTaskStagedAttachments(runCtx, stagedAttachmentTTL)
				cancel()
				if err != nil {
					log.Warn("Task staged attachment cleanup failed", zap.Error(err))
					continue
				}
				if deleted > 0 {
					log.Info("Task staged attachment cleanup removed expired uploads", zap.Int("deleted", deleted))
				}
			}
		}
	}()
	tasksHandler := tasks.NewHandler(
		tasksSvc,
		authSvc,
		log,
		cfg.AttachmentMaxSizeMB,
		cfg.TaskGroupPortionDefaultLimit,
		cfg.TaskGroupPortionMaxLimit,
	)
	tasksHandler.SetStatusChangeNotifier(wsServer)
	wsServer.SetTasksService(tasksSvc)

	documentsSvc := documents.NewService(db.Pool, storageClient)
	documentsSvc.SetHistoryLimit(cfg.DocumentHistoryLimit)
	documentsHandler := documents.NewHandler(documentsSvc, authSvc, log, cfg.AttachmentMaxSizeMB)
	wsServer.SetDocumentsService(documentsSvc)
	dayoffsSvc := dayoffs.NewService(db.Pool)
	dayoffsHandler := dayoffs.NewHandler(dayoffsSvc, authSvc, log)
	integrationsSvc := integrations.NewService(db.Pool, tasksSvc, documentsSvc, log)
	integrationsHandler := integrations.NewHandler(integrationsSvc, log)

	// --- main HTTP mux ---
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", wsServer.Handler())
	mux.HandleFunc("/health", livenessHandler())
	mux.HandleFunc("/ready", readinessHandler(db))
	authHandler.RegisterRoutes(mux)
	chatHandler.RegisterRoutes(mux)
	searchHandler.RegisterRoutes(mux)
	callHandler.RegisterRoutes(mux)
	adminHandler.RegisterRoutes(mux)
	tasksHandler.RegisterRoutes(mux)
	documentsHandler.RegisterRoutes(mux)
	dayoffsHandler.RegisterRoutes(mux)
	integrationsHandler.RegisterRoutes(mux)
	pushHandler.RegisterRoutes(mux)

	httpServer := &http.Server{
		Addr:         ":" + cfg.Port,
		Handler:      withCORS(mux, cfg.CORSAllowedOrigins),
		ReadTimeout:  cfg.HTTPReadTimeout,
		WriteTimeout: cfg.HTTPWriteTimeout,
		IdleTimeout:  cfg.HTTPIdleTimeout,
	}

	// --- metrics HTTP server (separate port) ---
	metricsMux := http.NewServeMux()
	metricsMux.Handle("/metrics", promhttp.Handler())

	metricsServer := &http.Server{
		Addr:         ":" + cfg.MetricsPort,
		Handler:      metricsMux,
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	go func() {
		log.Info("HTTP server listening", zap.String("addr", httpServer.Addr))
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal("HTTP server error", zap.Error(err))
		}
	}()

	go func() {
		log.Info("Metrics server listening", zap.String("addr", metricsServer.Addr))
		if err := metricsServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("Metrics server error", zap.Error(err))
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	sig := <-quit
	log.Info("Received signal, shutting down", zap.String("signal", sig.String()))

	shutCtx, shutCancel := context.WithTimeout(context.Background(), cfg.HTTPShutdownTimeout)
	defer shutCancel()

	if err := httpServer.Shutdown(shutCtx); err != nil {
		log.Error("HTTP server forced shutdown", zap.Error(err))
	}
	if err := metricsServer.Shutdown(shutCtx); err != nil {
		log.Error("Metrics server forced shutdown", zap.Error(err))
	}

	// Stop background goroutines and wait for them to exit.
	if err := pushSvc.Close(shutCtx); err != nil {
		log.Warn("Push service shutdown timed out", zap.Error(err))
	}
	pushCleanupCancel()
	<-pushCleanupDone
	callExpiryCancel()
	<-callExpiryDone
	taskStagedCleanupCancel()
	<-taskStagedCleanupDone
	listenerCancel()
	<-listenerStopped

	log.Info("Server exited cleanly")
}

func livenessHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`))
	}
}

func readinessHandler(db *database.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()

		if err := db.HealthCheck(ctx); err != nil {
			http.Error(w, `{"status":"not_ready","db":"error"}`, http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ready"}`))
	}
}

func withCORS(next http.Handler, allowedOriginsRaw string) http.Handler {
	allowedOrigins := map[string]struct{}{}
	allowAll := false

	for _, raw := range strings.Split(allowedOriginsRaw, ",") {
		origin := strings.TrimSpace(raw)
		if origin == "" {
			continue
		}
		if origin == "*" {
			allowAll = true
			break
		}
		allowedOrigins[origin] = struct{}{}
	}
	if allowedOriginsRaw == "" {
		allowAll = true
	}

	allowHeaders := "Authorization, Content-Type, Accept, X-Requested-With"
	allowMethods := "GET, POST, PUT, PATCH, DELETE, OPTIONS"

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := strings.TrimSpace(r.Header.Get("Origin"))
		if origin != "" {
			if allowAll {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Vary", "Origin")
			} else if _, ok := allowedOrigins[origin]; ok {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Vary", "Origin")
			}
		}

		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", allowMethods)
			reqHeaders := strings.TrimSpace(r.Header.Get("Access-Control-Request-Headers"))
			if reqHeaders != "" {
				w.Header().Set("Access-Control-Allow-Headers", reqHeaders)
			} else {
				w.Header().Set("Access-Control-Allow-Headers", allowHeaders)
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}
