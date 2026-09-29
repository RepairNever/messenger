package botapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/google/uuid"

	"msgnr/internal/auth"
	"msgnr/internal/documents"
	"msgnr/internal/httputil"
	"msgnr/internal/integrations"
)

func (h *Handler) documentsCollection(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	if r.Method != http.MethodPost {
		h.methodNotAllowed(w)
		return
	}

	var req createDocumentRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid request body"))
		return
	}
	if req.TeamspaceID == uuid.Nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid teamspace id"))
		return
	}
	if req.ParentID != nil && *req.ParentID == uuid.Nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid parent id"))
		return
	}

	doc, err := h.svc.integrations.CreateDocument(r.Context(), integrations.CreateDocumentParams{
		Title:       req.Title,
		Description: req.Description,
		ParentID:    req.ParentID,
		TeamspaceID: req.TeamspaceID,
		ActorID:     p.UserID,
	})
	if err != nil {
		switch {
		case errors.Is(err, documents.ErrBadRequest):
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody(err.Error()))
		case errors.Is(err, documents.ErrForbidden):
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody(err.Error()))
		case errors.Is(err, documents.ErrNotFound):
			httputil.WriteJSON(w, http.StatusNotFound, httputil.ErrorBody(err.Error()))
		case errors.Is(err, documents.ErrConflict):
			httputil.WriteJSON(w, http.StatusConflict, httputil.ErrorBody(err.Error()))
		default:
			h.internalError(w, "document create", err)
		}
		return
	}

	httputil.WriteJSON(w, http.StatusCreated, createDocumentResponse{
		ID:          doc.ID,
		ParentID:    doc.ParentID,
		Title:       doc.Title,
		Description: doc.Description,
		// Matches the web router and canonical document mention links. The
		// public web origin may differ from the Bot API request's host.
		URL: "/documents/" + doc.ID.String(),
	})
}
