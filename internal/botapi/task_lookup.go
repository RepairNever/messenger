package botapi

import (
	"net/http"
	"net/url"
	"strings"

	"msgnr/internal/auth"
	"msgnr/internal/httputil"
)

func (h *Handler) tasksByEnumValue(w http.ResponseWriter, r *http.Request, _ auth.Principal) {
	if r.Method != http.MethodGet {
		h.methodNotAllowed(w)
		return
	}

	// Split before unescaping so an encoded slash remains part of the label,
	// and literal percent sequences in labels are decoded only once.
	rest := strings.TrimPrefix(r.URL.EscapedPath(), "/api/bot/v1/tasks/by-enum/")
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

	// Reuse integration matching and DTO mapping, including organization-wide
	// task visibility and the same result limit and ordering.
	resp, err := h.svc.integrations.FindTasksByEnumValue(r.Context(), enumCode, enumValue)
	if err != nil {
		h.taskServiceError(w, err)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, resp)
}
