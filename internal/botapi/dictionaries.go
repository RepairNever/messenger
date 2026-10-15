package botapi

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	"msgnr/internal/auth"
	"msgnr/internal/httputil"
)

func (h *Handler) dictionaryItems(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/bot/v1/dictionaries/"), "/")
	if len(parts) != 2 || parts[1] != "items" {
		httputil.WriteJSON(w, http.StatusNotFound, httputil.ErrorBody("not found"))
		return
	}
	if r.Method != http.MethodPost {
		h.methodNotAllowed(w)
		return
	}
	dictionaryID, err := uuid.Parse(parts[0])
	if err != nil || dictionaryID == uuid.Nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid dictionary id"))
		return
	}

	// Decode exact object keys so misspelled fields cannot silently disappear.
	dec := json.NewDecoder(r.Body)
	var req map[string]json.RawMessage
	if err := dec.Decode(&req); err != nil || len(req) != 1 {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid request body"))
		return
	}
	var value *string
	if err := json.Unmarshal(req["value"], &value); err != nil || value == nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid request body"))
		return
	}
	var extra json.RawMessage
	if err := dec.Decode(&extra); err != io.EOF {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid request body"))
		return
	}
	// Public items use the same value for value_code (varchar(64)) and name.
	if utf8.RuneCountInString(strings.TrimSpace(*value)) > 64 {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("value must be at most 64 characters"))
		return
	}

	item, err := h.svc.tasksSvc.CreatePublicDictionaryItem(r.Context(), dictionaryID, *value, p.UserID)
	if err != nil {
		h.taskServiceError(w, err)
		return
	}
	httputil.WriteJSON(w, http.StatusCreated, item)
}
