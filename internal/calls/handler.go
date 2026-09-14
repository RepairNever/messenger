package calls

import (
	"encoding/json"
	"errors"
	"net/http"

	"go.uber.org/zap"

	"msgnr/internal/logger"
)

type Handler struct {
	svc *Service
	log *zap.Logger
}

func NewHandler(svc *Service) *Handler {
	return &Handler{svc: svc, log: logger.Logger}
}

func (h *Handler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/livekit/webhook", h.livekitWebhook)
}

func (h *Handler) livekitWebhook(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	evt, err := h.svc.ParseVerifiedWebhookRequest(r)
	if err != nil {
		h.log.Warn("calls webhook rejected",
			zap.Error(err),
			zap.String("method", r.Method),
			zap.String("path", r.URL.Path),
			zap.String("remote_addr", r.RemoteAddr),
			zap.Bool("has_auth_header", r.Header.Get("Authorization") != ""),
			zap.Bool("has_webhook_secret_header", r.Header.Get("X-LiveKit-Webhook-Secret") != ""),
		)
		switch {
		case errors.Is(err, ErrForbiddenAction):
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid webhook auth"})
		default:
			h.log.Warn("calls webhook verify failed", zap.Error(err))
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid webhook payload"})
		}
		return
	}

	h.log.Info("calls webhook received",
		zap.String("event", evt.Event),
		zap.String("room", evt.RoomName),
		zap.String("participant_identity", evt.ParticipantIdentity),
	)

	processed, err := h.svc.HandleWebhook(r.Context(), evt)
	if err != nil {
		h.log.Error("calls webhook handling failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	h.log.Info("calls webhook handled",
		zap.String("event", evt.Event),
		zap.String("room", evt.RoomName),
		zap.Bool("processed", processed),
	)

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
