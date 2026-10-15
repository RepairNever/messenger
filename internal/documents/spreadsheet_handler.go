package documents

import (
	"errors"
	"github.com/google/uuid"
	"io"
	"mime"
	"msgnr/internal/auth"
	"net/http"
	"strings"
)

func (h *Handler) spreadsheetRouter(w http.ResponseWriter, r *http.Request, p auth.Principal, rest string) {
	parts := strings.Split(rest, "/")
	if len(parts) < 2 || parts[1] != "spreadsheet" {
		writeJSON(w, http.StatusNotFound, errBody("not found"))
		return
	}
	documentID, err := uuid.Parse(parts[0])
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("invalid document id"))
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if len(parts) == 2 {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			methodNotAllowed(w)
			return
		}
		state, err := h.svc.GetSpreadsheet(r.Context(), documentID, p.UserID)
		if err != nil {
			h.serviceError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, state)
		return
	}
	if len(parts) == 3 && parts[2] == "actions" {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			methodNotAllowed(w)
			return
		}
		body, ok := readSpreadsheetBody(w, r)
		if !ok {
			return
		}
		response, err := h.svc.ApplySpreadsheetAction(r.Context(), documentID, p.UserID, body)
		h.writeSpreadsheetAction(w, response, err)
		return
	}
	if (len(parts) == 4 || len(parts) == 5) && parts[2] == "history" {
		historyID, err := uuid.Parse(parts[3])
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errBody("invalid history id"))
			return
		}
		if len(parts) == 4 {
			if r.Method != http.MethodGet {
				w.Header().Set("Allow", http.MethodGet)
				methodNotAllowed(w)
				return
			}
			snapshot, err := h.svc.GetSpreadsheetHistory(r.Context(), documentID, historyID, p.UserID)
			if err != nil {
				h.serviceError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, snapshot)
			return
		}
		if parts[4] == "restore" {
			if r.Method != http.MethodPost {
				w.Header().Set("Allow", http.MethodPost)
				methodNotAllowed(w)
				return
			}
			body, ok := readSpreadsheetBody(w, r)
			if !ok {
				return
			}
			response, err := h.svc.RestoreSpreadsheetHistory(r.Context(), documentID, historyID, p.UserID, body)
			h.writeSpreadsheetAction(w, response, err)
			return
		}
	}
	writeJSON(w, http.StatusNotFound, errBody("not found"))
}
func readSpreadsheetBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		writeJSON(w, http.StatusUnsupportedMediaType, errBody("use application/json"))
		return nil, false
	}
	r.Body = http.MaxBytesReader(w, r.Body, SpreadsheetMaxBodyBytes)
	defer r.Body.Close()
	body, err := io.ReadAll(r.Body)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeJSON(w, http.StatusRequestEntityTooLarge, errBody("spreadsheet request exceeds size limit"))
		} else {
			writeJSON(w, http.StatusBadRequest, errBody("invalid request body"))
		}
		return nil, false
	}
	return body, true
}
func (h *Handler) writeSpreadsheetAction(w http.ResponseWriter, response SpreadsheetActionResponse, err error) {
	if err != nil {
		h.serviceError(w, err)
		return
	}
	status := http.StatusOK
	if response.Operation.Outcome == "conflict" {
		status = http.StatusConflict
	}
	writeJSON(w, status, response)
}
