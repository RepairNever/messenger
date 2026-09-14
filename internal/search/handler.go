package search

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"msgnr/internal/auth"
	"msgnr/internal/httputil"
	"msgnr/internal/logger"
)

type Handler struct {
	svc     searchService
	authSvc *auth.Service
	log     *zap.Logger
}

type authHandler func(w http.ResponseWriter, r *http.Request, p auth.Principal)
type searchService interface {
	SearchMessages(ctx context.Context, requesterID uuid.UUID, query string, conversationID *uuid.UUID, limit int) ([]MessageResult, error)
}

func NewHandler(svc searchService, authSvc *auth.Service, log *zap.Logger) *Handler {
	if log == nil {
		log = logger.Logger
	}
	return &Handler{svc: svc, authSvc: authSvc, log: log}
}

func (h *Handler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/search/messages", h.requireAuth(h.searchMessages))
}

type messageResultResponse struct {
	Source                 string `json:"source"`
	ID                     string `json:"id"`
	Body                   string `json:"body"`
	CreatedAt              string `json:"created_at"`
	ActorID                string `json:"actor_id"`
	ActorName              string `json:"actor_name"`
	ConversationID         string `json:"conversation_id,omitempty"`
	ConversationTitle      string `json:"conversation_title,omitempty"`
	ConversationKind       string `json:"conversation_kind,omitempty"`
	ConversationVisibility string `json:"conversation_visibility,omitempty"`
	MessageID              string `json:"message_id,omitempty"`
	ThreadRootMessageID    string `json:"thread_root_message_id,omitempty"`
	TaskID                 string `json:"task_id,omitempty"`
	TaskPublicID           string `json:"task_public_id,omitempty"`
	TaskTitle              string `json:"task_title,omitempty"`
	TaskCommentID          string `json:"task_comment_id,omitempty"`
}

type messageSearchResponse struct {
	TotalCount int                     `json:"total_count"`
	Items      []messageResultResponse `json:"items"`
}

func (h *Handler) searchMessages(w http.ResponseWriter, r *http.Request, principal auth.Principal) {
	if r.Method != http.MethodGet {
		httputil.MethodNotAllowed(w)
		return
	}

	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if utf8.RuneCountInString(query) < 2 {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("q must be at least 2 characters"))
		return
	}
	var conversationID *uuid.UUID
	if raw := strings.TrimSpace(r.URL.Query().Get("conversation_id")); raw != "" {
		parsed, err := uuid.Parse(raw)
		if err != nil {
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid conversation_id"))
			return
		}
		conversationID = &parsed
	}

	limit := defaultMessageSearchLimit
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("limit must be > 0"))
			return
		}
		if parsed > 0 {
			limit = parsed
		}
	}

	results, err := h.svc.SearchMessages(r.Context(), principal.UserID, query, conversationID, limit)
	if err != nil {
		switch {
		case errors.Is(err, ErrQueryTooShort):
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("q must be at least 2 characters"))
		case errors.Is(err, ErrNotMember):
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("not a member of this conversation"))
		default:
			h.log.Error("searchMessages error", zap.Error(err))
			httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		}
		return
	}

	resp := messageSearchResponse{
		TotalCount: len(results),
		Items:      make([]messageResultResponse, 0, len(results)),
	}
	for _, result := range results {
		resp.Items = append(resp.Items, messageResultResponse{
			Source:                 string(result.Source),
			ID:                     result.ID,
			Body:                   result.Body,
			CreatedAt:              result.CreatedAt.UTC().Format("2006-01-02T15:04:05Z"),
			ActorID:                result.ActorID,
			ActorName:              result.ActorName,
			ConversationID:         result.ConversationID,
			ConversationTitle:      result.ConversationTitle,
			ConversationKind:       result.ConversationKind,
			ConversationVisibility: result.ConversationVisibility,
			MessageID:              result.MessageID,
			ThreadRootMessageID:    result.ThreadRootMessageID,
			TaskID:                 result.TaskID,
			TaskPublicID:           result.TaskPublicID,
			TaskTitle:              result.TaskTitle,
			TaskCommentID:          result.TaskCommentID,
		})
	}
	httputil.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) requireAuth(next authHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := httputil.BearerToken(r)
		if token == "" {
			httputil.WriteJSON(w, http.StatusUnauthorized, httputil.ErrorBody("missing authorization"))
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
