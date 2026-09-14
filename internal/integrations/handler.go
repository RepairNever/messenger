package integrations

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"msgnr/internal/auth"
	"msgnr/internal/documents"
	"msgnr/internal/httputil"
	"msgnr/internal/tasks"
)

type Handler struct {
	svc *Service
	log *zap.Logger
}

type authHandler func(w http.ResponseWriter, r *http.Request, p auth.Principal)

func NewHandler(svc *Service, log *zap.Logger) *Handler {
	if log == nil {
		log = zap.NewNop()
	}
	return &Handler{svc: svc, log: log}
}

func (h *Handler) RegisterRoutes(mux *http.ServeMux) {
	// net/http.ServeMux picks the longest matching pattern, so this more
	// specific prefix wins over the generic /api/integrations/tasks/ item route.
	mux.HandleFunc("/api/integrations/tasks/by-enum/", h.requireAuth(h.tasksByEnumValue))
	mux.HandleFunc("/api/integrations/tasks/", h.requireAuth(h.taskItem))
	mux.HandleFunc("/api/integrations/documents", h.requireAuth(h.documentsCollection))
	mux.HandleFunc("/api/integrations/documents/", h.requireAuth(h.documentItem))
}

func (h *Handler) taskItem(w http.ResponseWriter, r *http.Request, _ auth.Principal) {
	if r.Method != http.MethodGet {
		httputil.MethodNotAllowed(w)
		return
	}

	publicID := strings.TrimPrefix(r.URL.Path, "/api/integrations/tasks/")
	if strings.TrimSpace(publicID) == "" || strings.Contains(publicID, "/") {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid task id"))
		return
	}

	resp, err := h.svc.GetTask(r.Context(), publicID)
	if err != nil {
		h.serviceError(w, err)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) tasksByEnumValue(w http.ResponseWriter, r *http.Request, _ auth.Principal) {
	if r.Method != http.MethodGet {
		httputil.MethodNotAllowed(w)
		return
	}

	rest := strings.TrimPrefix(r.URL.Path, "/api/integrations/tasks/by-enum/")
	parts := strings.Split(rest, "/")
	if len(parts) != 3 || parts[1] != "value" {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid enum lookup path"))
		return
	}

	enumCode, err := url.PathUnescape(parts[0])
	if err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid enum code"))
		return
	}
	enumValue, err := url.PathUnescape(parts[2])
	if err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid enum value"))
		return
	}
	if strings.TrimSpace(enumCode) == "" || strings.TrimSpace(enumValue) == "" {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid enum lookup path"))
		return
	}

	resp, err := h.svc.FindTasksByEnumValue(r.Context(), enumCode, enumValue)
	if err != nil {
		h.serviceError(w, err)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) documentsCollection(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	if r.Method != http.MethodPost {
		httputil.MethodNotAllowed(w)
		return
	}

	var req struct {
		Title       string     `json:"title"`
		Description *string    `json:"description"`
		ParentID    *uuid.UUID `json:"parent_id"`
		TeamspaceID uuid.UUID  `json:"teamspace_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid request body"))
		return
	}

	resp, err := h.svc.CreateDocument(r.Context(), CreateDocumentParams{
		Title:       req.Title,
		Description: req.Description,
		ParentID:    req.ParentID,
		TeamspaceID: req.TeamspaceID,
		ActorID:     p.UserID,
	})
	if err != nil {
		h.serviceError(w, err)
		return
	}
	httputil.WriteJSON(w, http.StatusCreated, resp)
}

func (h *Handler) documentItem(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	if r.Method != http.MethodGet {
		httputil.MethodNotAllowed(w)
		return
	}

	rawID := strings.TrimPrefix(r.URL.Path, "/api/integrations/documents/")
	documentID, err := uuid.Parse(rawID)
	if err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid document id"))
		return
	}

	resp, err := h.svc.GetDocument(r.Context(), documentID, p.UserID)
	if err != nil {
		h.serviceError(w, err)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) requireAuth(next authHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := httputil.BearerToken(r)
		if token == "" {
			httputil.WriteJSON(w, http.StatusUnauthorized, httputil.ErrorBody("missing token"))
			return
		}

		principal, err := h.svc.VerifyToken(r.Context(), token)
		if err != nil {
			if errors.Is(err, ErrUnauthorized) {
				httputil.WriteJSON(w, http.StatusUnauthorized, httputil.ErrorBody("invalid token"))
				return
			}
			h.log.Error("integrations: verify token", zap.Error(err))
			httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
			return
		}

		next(w, r, principal)
	}
}

func (h *Handler) serviceError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, tasks.ErrNotFound), errors.Is(err, documents.ErrNotFound):
		httputil.WriteJSON(w, http.StatusNotFound, httputil.ErrorBody(err.Error()))
	case errors.Is(err, tasks.ErrForbidden), errors.Is(err, documents.ErrForbidden):
		httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody(err.Error()))
	case errors.Is(err, tasks.ErrBadRequest), errors.Is(err, documents.ErrBadRequest):
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody(err.Error()))
	case errors.Is(err, documents.ErrConflict):
		httputil.WriteJSON(w, http.StatusConflict, httputil.ErrorBody(err.Error()))
	default:
		h.log.Error("integrations: internal error", zap.Error(err))
		httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
	}
}
