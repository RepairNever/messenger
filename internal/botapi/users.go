package botapi

import (
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"msgnr/internal/auth"
	"msgnr/internal/gen/queries"
	"msgnr/internal/httputil"
)

type usersLookupResponse struct {
	Users []memberDTO `json:"users"`
}

func (h *Handler) usersLookup(w http.ResponseWriter, r *http.Request, _ auth.Principal) {
	if r.Method != http.MethodGet {
		h.methodNotAllowed(w)
		return
	}
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query != "" && utf8.RuneCountInString(query) < 2 {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("query must be at least 2 characters"))
		return
	}
	limit := 20
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid limit"))
			return
		}
		limit = min(50, max(1, parsed))
	}
	users, err := h.svc.q.ListBotActiveUsers(r.Context(), queries.ListBotActiveUsersParams{
		Query: query, ResultLimit: limit,
	})
	if err != nil {
		h.internalError(w, "users lookup", err)
		return
	}
	out := usersLookupResponse{Users: make([]memberDTO, 0, len(users))}
	for _, user := range users {
		out.Users = append(out.Users, memberDTO{
			UserID: user.ID, DisplayName: user.DisplayName, Email: user.Email,
		})
	}
	httputil.WriteJSON(w, http.StatusOK, out)
}
