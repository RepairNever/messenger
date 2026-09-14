package push

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"

	"go.uber.org/zap"

	"msgnr/internal/auth"
	"msgnr/internal/httputil"
	"msgnr/internal/logger"
)

// Handler serves the push notification HTTP endpoints.
type Handler struct {
	svc     *Service
	authSvc *auth.Service
	log     *zap.Logger
}

// NewHandler creates a push HTTP handler.
func NewHandler(svc *Service, authSvc *auth.Service) *Handler {
	return &Handler{
		svc:     svc,
		authSvc: authSvc,
		log:     logger.Logger.Named("push.handler"),
	}
}

// RegisterRoutes registers push-related HTTP routes on the mux.
func (h *Handler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/push/vapid-key", h.requireAuth(h.vapidKey))
	mux.HandleFunc("/api/push/subscribe", h.requireAuth(h.subscribe))
	mux.HandleFunc("/api/push/subscriptions/", h.requireAuth(h.unsubscribeByPath))
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

type authHandler func(w http.ResponseWriter, r *http.Request, p auth.Principal)

func (h *Handler) vapidKey(w http.ResponseWriter, r *http.Request, _ auth.Principal) {
	if r.Method != http.MethodGet {
		httputil.MethodNotAllowed(w)
		return
	}
	if !h.svc.Enabled() {
		httputil.WriteJSON(w, http.StatusServiceUnavailable, httputil.ErrorBody("push notifications are not configured"))
		return
	}
	httputil.WriteJSON(w, http.StatusOK, VAPIDKeyResponse{PublicKey: h.svc.cfg.VAPIDPublicKey})
}

func (h *Handler) subscribe(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	switch r.Method {
	case http.MethodPost:
		h.handleSubscribe(w, r, p)
	case http.MethodDelete:
		h.handleUnsubscribe(w, r, p)
	default:
		httputil.MethodNotAllowed(w)
	}
}

func (h *Handler) handleSubscribe(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	if !h.svc.Enabled() {
		httputil.WriteJSON(w, http.StatusServiceUnavailable, httputil.ErrorBody("push notifications are not configured"))
		return
	}

	var req SubscribeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid request body"))
		return
	}

	if err := h.svc.Subscribe(r.Context(), p.UserID, req); err != nil {
		h.log.Error("failed to subscribe", zap.Error(err))
		httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("failed to save subscription"))
		return
	}

	httputil.WriteJSON(w, http.StatusCreated, map[string]string{"status": "subscribed"})
}

func (h *Handler) handleUnsubscribe(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	var req UnsubscribeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid request body"))
		return
	}

	if req.Endpoint == "" {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("endpoint is required"))
		return
	}

	if err := h.svc.Unsubscribe(r.Context(), p.UserID, req.Endpoint); err != nil {
		h.log.Error("failed to unsubscribe", zap.Error(err))
		httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("failed to remove subscription"))
		return
	}

	httputil.WriteJSON(w, http.StatusOK, map[string]string{"status": "unsubscribed"})
}

func (h *Handler) unsubscribeByPath(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	if r.Method != http.MethodDelete {
		httputil.MethodNotAllowed(w)
		return
	}
	rawEndpoint := strings.TrimPrefix(r.URL.Path, "/api/push/subscriptions/")
	if rawEndpoint == "" {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("endpoint is required"))
		return
	}
	endpoint, err := url.PathUnescape(rawEndpoint)
	if err != nil || endpoint == "" {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid endpoint"))
		return
	}
	if err := h.svc.Unsubscribe(r.Context(), p.UserID, endpoint); err != nil {
		h.log.Error("failed to unsubscribe", zap.Error(err))
		httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("failed to remove subscription"))
		return
	}
	httputil.WriteJSON(w, http.StatusOK, map[string]string{"status": "unsubscribed"})
}

// ---------------------------------------------------------------------------
// Auth middleware (same pattern as other handlers in the codebase)
// ---------------------------------------------------------------------------

func (h *Handler) requireAuth(next authHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := httputil.BearerToken(r)
		if token == "" {
			httputil.WriteJSON(w, http.StatusUnauthorized, httputil.ErrorBody("missing token"))
			return
		}
		principal, err := h.authSvc.VerifyAccess(r.Context(), token)
		if err != nil {
			httputil.WriteJSON(w, http.StatusUnauthorized, httputil.ErrorBody("invalid or expired token"))
			return
		}
		next(w, r, principal)
	}
}
