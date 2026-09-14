package dayoffs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"msgnr/internal/auth"
	"msgnr/internal/httputil"
)

type serviceAPI interface {
	ListMonth(ctx context.Context, year, month int) (MonthResponse, error)
	Create(ctx context.Context, params CreateParams) (Dayoff, error)
	Update(ctx context.Context, id uuid.UUID, params UpdateParams) (Dayoff, error)
	Delete(ctx context.Context, id, actorID uuid.UUID, actorRole string) error
}

// Handler exposes the authenticated dayoffs REST surface under /api/dayoffs.
type Handler struct {
	svc     serviceAPI
	authSvc *auth.Service
	log     *zap.Logger
}

func NewHandler(svc serviceAPI, authSvc *auth.Service, log *zap.Logger) *Handler {
	if log == nil {
		log = zap.NewNop()
	}
	return &Handler{svc: svc, authSvc: authSvc, log: log}
}

func (h *Handler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/dayoffs", h.requireAuth(h.collection))
	mux.HandleFunc("/api/dayoffs/", h.requireAuth(h.item))
}

func (h *Handler) collection(w http.ResponseWriter, r *http.Request, principal auth.Principal) {
	switch r.Method {
	case http.MethodGet:
		year, month, err := parseMonthQuery(r)
		if err != nil {
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody(err.Error()))
			return
		}
		response, err := h.svc.ListMonth(r.Context(), year, month)
		if err != nil {
			h.serviceError(w, err)
			return
		}
		httputil.WriteJSON(w, http.StatusOK, response)

	case http.MethodPost:
		var request mutationRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid request body"))
			return
		}
		record, err := h.svc.Create(r.Context(), CreateParams{
			UserID:    request.UserID,
			Type:      request.Type,
			StartDate: request.StartDate,
			EndDate:   request.EndDate,
			Note:      request.Note,
			ActorID:   principal.UserID,
			ActorRole: principal.Role,
		})
		if err != nil {
			h.serviceError(w, err)
			return
		}
		httputil.WriteJSON(w, http.StatusCreated, record)

	default:
		httputil.MethodNotAllowed(w)
	}
}

func (h *Handler) item(w http.ResponseWriter, r *http.Request, principal auth.Principal) {
	rawID := strings.TrimPrefix(r.URL.Path, "/api/dayoffs/")
	if rawID == "" || strings.Contains(rawID, "/") {
		httputil.WriteJSON(w, http.StatusNotFound, httputil.ErrorBody("not found"))
		return
	}
	id, err := uuid.Parse(rawID)
	if err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid dayoff id"))
		return
	}

	switch r.Method {
	case http.MethodPatch:
		var request mutationRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid request body"))
			return
		}
		record, err := h.svc.Update(r.Context(), id, UpdateParams{
			UserID:    request.UserID,
			Type:      request.Type,
			StartDate: request.StartDate,
			EndDate:   request.EndDate,
			Note:      request.Note,
			ActorID:   principal.UserID,
			ActorRole: principal.Role,
		})
		if err != nil {
			h.serviceError(w, err)
			return
		}
		httputil.WriteJSON(w, http.StatusOK, record)

	case http.MethodDelete:
		if err := h.svc.Delete(r.Context(), id, principal.UserID, principal.Role); err != nil {
			h.serviceError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)

	default:
		httputil.MethodNotAllowed(w)
	}
}

type mutationRequest struct {
	UserID    *uuid.UUID `json:"user_id"`
	Type      string     `json:"type"`
	StartDate string     `json:"start_date"`
	EndDate   string     `json:"end_date"`
	Note      string     `json:"note"`
}

func (h *Handler) requireAuth(next func(http.ResponseWriter, *http.Request, auth.Principal)) http.HandlerFunc {
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

func (h *Handler) serviceError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		httputil.WriteJSON(w, http.StatusNotFound, httputil.ErrorBody(err.Error()))
	case errors.Is(err, ErrForbidden):
		httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody(err.Error()))
	case errors.Is(err, ErrConflict):
		httputil.WriteJSON(w, http.StatusConflict, httputil.ErrorBody(err.Error()))
	case errors.Is(err, ErrBadRequest):
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody(err.Error()))
	default:
		h.log.Error("dayoffs: internal error", zap.Error(err))
		httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
	}
}

func parseMonthQuery(r *http.Request) (int, int, error) {
	year, err := parsePositiveQueryInt(r.URL.Query().Get("year"), "year")
	if err != nil || year > 9999 {
		if err != nil {
			return 0, 0, err
		}
		return 0, 0, fmt.Errorf("year must be between 1 and 9999")
	}
	month, err := parsePositiveQueryInt(r.URL.Query().Get("month"), "month")
	if err != nil || month > 12 {
		if err != nil {
			return 0, 0, err
		}
		return 0, 0, fmt.Errorf("month must be between 1 and 12")
	}
	return year, month, nil
}

func parsePositiveQueryInt(raw, field string) (int, error) {
	if raw == "" {
		return 0, fmt.Errorf("%s is required", field)
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 {
		return 0, fmt.Errorf("%s must be a positive integer", field)
	}
	return value, nil
}
