package documents

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"msgnr/internal/auth"
)

type Handler struct {
	svc             *Service
	authSvc         *auth.Service
	log             *zap.Logger
	maxAttachSizeMB int
}

type authHandler func(w http.ResponseWriter, r *http.Request, p auth.Principal)

func NewHandler(svc *Service, authSvc *auth.Service, log *zap.Logger, maxAttachSizeMB int) *Handler {
	if log == nil {
		log = zap.NewNop()
	}
	if maxAttachSizeMB <= 0 {
		maxAttachSizeMB = 50
	}
	return &Handler{
		svc:             svc,
		authSvc:         authSvc,
		log:             log,
		maxAttachSizeMB: maxAttachSizeMB,
	}
}

func (h *Handler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/documents/teamspaces", h.requireAuth(h.teamspacesCollection))
	mux.HandleFunc("/api/documents/teamspaces/", h.requireAuth(h.teamspacesItem))
	mux.HandleFunc("/api/documents/sidebar", h.requireAuth(h.sidebarCollection))
	mux.HandleFunc("/api/documents/search", h.requireAuth(h.searchCollection))
	mux.HandleFunc("/api/documents", h.requireAuth(h.documentsCollection))
	mux.HandleFunc("/api/documents/", h.requireAuth(h.documentItem))
}

func (h *Handler) teamspacesCollection(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	switch r.Method {
	case http.MethodGet:
		rows, err := h.svc.ListTeamspaces(r.Context(), p.UserID, p.Role)
		if err != nil {
			h.serviceError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, rows)
	case http.MethodPost:
		var req struct {
			Name      string      `json:"name"`
			IsPrivate bool        `json:"is_private"`
			MemberIDs []uuid.UUID `json:"member_ids"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errBody("invalid request body"))
			return
		}
		row, err := h.svc.CreateTeamspace(r.Context(), CreateTeamspaceParams{
			Name:      req.Name,
			IsPrivate: req.IsPrivate,
			MemberIDs: req.MemberIDs,
			ActorID:   p.UserID,
		}, p.Role)
		if err != nil {
			h.serviceError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, row)
	default:
		methodNotAllowed(w)
	}
}

func (h *Handler) teamspacesItem(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/documents/teamspaces/")
	if rest == "" {
		writeJSON(w, http.StatusNotFound, errBody("not found"))
		return
	}
	if rawID, ok := strings.CutSuffix(rest, "/join"); ok {
		id, err := uuid.Parse(rawID)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errBody("invalid teamspace id"))
			return
		}
		h.teamspaceJoin(w, r, p, id)
		return
	}

	id, err := uuid.Parse(rest)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("invalid teamspace id"))
		return
	}
	h.teamspaceItem(w, r, p, id)
}

func (h *Handler) teamspaceItem(w http.ResponseWriter, r *http.Request, p auth.Principal, id uuid.UUID) {
	switch r.Method {
	case http.MethodPatch:
		var req struct {
			Name      string      `json:"name"`
			IsPrivate bool        `json:"is_private"`
			MemberIDs []uuid.UUID `json:"member_ids"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errBody("invalid request body"))
			return
		}

		row, err := h.svc.UpdateTeamspace(r.Context(), id, UpdateTeamspaceParams{
			Name:      req.Name,
			IsPrivate: req.IsPrivate,
			MemberIDs: req.MemberIDs,
			ActorID:   p.UserID,
			ActorRole: p.Role,
		})
		if err != nil {
			h.serviceError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, row)
	case http.MethodDelete:
		if err := h.svc.DeleteTeamspace(r.Context(), id, p.UserID, p.Role); err != nil {
			h.serviceError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		methodNotAllowed(w)
	}
}

func (h *Handler) teamspaceJoin(w http.ResponseWriter, r *http.Request, p auth.Principal, id uuid.UUID) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	row, err := h.svc.JoinTeamspace(r.Context(), id, p.UserID, p.Role)
	if err != nil {
		h.serviceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, row)
}

func (h *Handler) sidebarCollection(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	rows, err := h.svc.ListSidebar(r.Context(), p.UserID)
	if err != nil {
		h.serviceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

func (h *Handler) searchCollection(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}

	query := r.URL.Query().Get("q")
	rows, err := h.svc.SearchDocuments(r.Context(), p.UserID, query)
	if err != nil {
		h.serviceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

func (h *Handler) documentsCollection(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}

	var req struct {
		TeamspaceID      uuid.UUID  `json:"teamspace_id"`
		ParentDocumentID *uuid.UUID `json:"parent_document_id"`
		Title            string     `json:"title"`
		ContentMarkdown  *string    `json:"content_markdown"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("invalid request body"))
		return
	}

	row, err := h.svc.CreateDocument(r.Context(), CreateDocumentParams{
		TeamspaceID:      req.TeamspaceID,
		ParentDocumentID: req.ParentDocumentID,
		Title:            req.Title,
		ContentMarkdown:  req.ContentMarkdown,
		ActorID:          p.UserID,
	})
	if err != nil {
		h.serviceError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, row)
}

func (h *Handler) documentItem(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/documents/")
	if rest == "" {
		writeJSON(w, http.StatusNotFound, errBody("not found"))
		return
	}
	if rawID, ok := strings.CutSuffix(rest, "/favorite"); ok {
		id, err := uuid.Parse(rawID)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errBody("invalid document id"))
			return
		}
		h.documentFavoriteItem(w, r, p, id)
		return
	}
	if rawID, suffix, ok := strings.Cut(rest, "/attachments"); ok {
		id, err := uuid.Parse(rawID)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errBody("invalid document id"))
			return
		}
		h.documentAttachmentsRouter(w, r, p, id, suffix)
		return
	}
	if rawID, ok := strings.CutSuffix(rest, "/content"); ok {
		id, err := uuid.Parse(rawID)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errBody("invalid document id"))
			return
		}
		h.documentContentItem(w, r, p, id)
		return
	}
	if rawID, ok := strings.CutSuffix(rest, "/history"); ok {
		id, err := uuid.Parse(rawID)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errBody("invalid document id"))
			return
		}
		h.documentHistoryItem(w, r, p, id)
		return
	}

	id, err := uuid.Parse(rest)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("invalid document id"))
		return
	}

	switch r.Method {
	case http.MethodGet:
		row, err := h.svc.GetDocument(r.Context(), id, p.UserID)
		if err != nil {
			h.serviceError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, row)
	case http.MethodPatch:
		var req struct {
			Title           *string `json:"title"`
			ContentMarkdown *string `json:"content_markdown"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errBody("invalid request body"))
			return
		}
		row, err := h.svc.UpdateDocument(r.Context(), id, UpdateDocumentParams{
			Title:           req.Title,
			ContentMarkdown: req.ContentMarkdown,
			ActorID:         p.UserID,
		})
		if err != nil {
			h.serviceError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, row)
	case http.MethodDelete:
		if err := h.svc.DeleteDocument(r.Context(), id, p.UserID); err != nil {
			h.serviceError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		methodNotAllowed(w)
	}
}

func (h *Handler) documentFavoriteItem(w http.ResponseWriter, r *http.Request, p auth.Principal, id uuid.UUID) {
	switch r.Method {
	case http.MethodPost:
		row, err := h.svc.FavoriteDocument(r.Context(), id, p.UserID)
		if err != nil {
			h.serviceError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, row)
	case http.MethodDelete:
		row, err := h.svc.UnfavoriteDocument(r.Context(), id, p.UserID)
		if err != nil {
			h.serviceError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, row)
	default:
		methodNotAllowed(w)
	}
}

func (h *Handler) documentContentItem(w http.ResponseWriter, r *http.Request, p auth.Principal, id uuid.UUID) {
	if r.Method != http.MethodPatch {
		methodNotAllowed(w)
		return
	}

	var req struct {
		ContentMarkdown *string `json:"content_markdown"`
		ForceSnapshot   bool    `json:"force_snapshot"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("invalid request body"))
		return
	}

	row, err := h.svc.UpdateDocumentContent(r.Context(), id, UpdateDocumentContentParams{
		ContentMarkdown: req.ContentMarkdown,
		ActorID:         p.UserID,
		ForceSnapshot:   req.ForceSnapshot,
	})
	if err != nil {
		h.serviceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, row)
}

func (h *Handler) documentHistoryItem(w http.ResponseWriter, r *http.Request, p auth.Principal, id uuid.UUID) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	rows, err := h.svc.ListDocumentHistory(r.Context(), id, p.UserID)
	if err != nil {
		h.serviceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

func (h *Handler) documentAttachmentsRouter(
	w http.ResponseWriter,
	r *http.Request,
	p auth.Principal,
	documentID uuid.UUID,
	suffix string,
) {
	suffix = strings.TrimPrefix(suffix, "/")
	if suffix == "" {
		switch r.Method {
		case http.MethodGet:
			rows, err := h.svc.ListAttachments(r.Context(), documentID, p.UserID)
			if err != nil {
				h.serviceError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, rows)
		case http.MethodPost:
			h.documentAttachmentUpload(w, r, p, documentID)
		default:
			methodNotAllowed(w)
		}
		return
	}

	parts := strings.SplitN(suffix, "/", 2)
	attachmentID, err := uuid.Parse(parts[0])
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("invalid attachment id"))
		return
	}
	if len(parts) == 2 && parts[1] == "download" {
		if r.Method != http.MethodGet {
			methodNotAllowed(w)
			return
		}
		h.documentAttachmentDownload(w, r, p, documentID, attachmentID)
		return
	}
	if r.Method != http.MethodDelete {
		methodNotAllowed(w)
		return
	}
	if err := h.svc.DeleteAttachment(r.Context(), documentID, p.UserID, attachmentID); err != nil {
		h.serviceError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) documentAttachmentUpload(w http.ResponseWriter, r *http.Request, p auth.Principal, documentID uuid.UUID) {
	maxBytes := int64(h.maxAttachSizeMB) * 1024 * 1024
	formLimit := maxBytes + 2*1024*1024
	if err := r.ParseMultipartForm(formLimit); err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("failed to parse multipart form: "+err.Error()))
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("missing 'file' field in form"))
		return
	}
	defer file.Close()

	mimeType := header.Header.Get("Content-Type")
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}

	cr := &countingReader{r: file, maxBytes: maxBytes}
	row, err := h.svc.UploadAttachment(r.Context(), UploadAttachmentParams{
		DocumentID: documentID,
		ActorID:    p.UserID,
		FileName:   header.Filename,
		MimeType:   mimeType,
		Size:       -1,
		Body:       cr,
	}, h.maxAttachSizeMB, cr)
	if err != nil {
		h.serviceError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, row)
}

type countingReader struct {
	r        io.Reader
	n        int64
	maxBytes int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	if c.maxBytes > 0 {
		if c.n >= c.maxBytes {
			var probe [1]byte
			n, err := c.r.Read(probe[:])
			if n > 0 {
				return 0, errAttachmentTooLarge
			}
			return 0, err
		}
		remaining := c.maxBytes - c.n
		if int64(len(p)) > remaining {
			p = p[:remaining]
		}
	}
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}

func (c *countingReader) BytesRead() int64 { return c.n }

func (h *Handler) documentAttachmentDownload(
	w http.ResponseWriter,
	r *http.Request,
	p auth.Principal,
	documentID, attachmentID uuid.UUID,
) {
	body, size, mimeType, fileName, err := h.svc.DownloadAttachment(r.Context(), documentID, p.UserID, attachmentID)
	if err != nil {
		h.serviceError(w, err)
		return
	}
	defer body.Close()

	w.Header().Set("Content-Type", mimeType)
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	w.Header().Set("Content-Disposition", `attachment; filename="`+sanitiseHeaderValue(fileName)+`"`)
	w.WriteHeader(http.StatusOK)
	io.Copy(w, body) //nolint:errcheck
}

func (h *Handler) requireAuth(next authHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := bearerToken(r)
		if token == "" {
			writeJSON(w, http.StatusUnauthorized, errBody("missing token"))
			return
		}
		principal, err := h.authSvc.VerifyAccess(r.Context(), token)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, errBody("invalid or expired token"))
			return
		}
		next(w, r, principal)
	}
}

func (h *Handler) serviceError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		writeJSON(w, http.StatusNotFound, errBody(err.Error()))
	case errors.Is(err, ErrForbidden):
		writeJSON(w, http.StatusForbidden, errBody(err.Error()))
	case errors.Is(err, ErrConflict):
		writeJSON(w, http.StatusConflict, errBody(err.Error()))
	case errors.Is(err, ErrBadRequest):
		writeJSON(w, http.StatusBadRequest, errBody(err.Error()))
	case errors.Is(err, ErrUnavailable):
		writeJSON(w, http.StatusServiceUnavailable, errBody(err.Error()))
	default:
		h.log.Error("documents: internal error", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, errBody("internal error"))
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func errBody(msg string) map[string]string {
	return map[string]string{"error": msg}
}

func bearerToken(r *http.Request) string {
	value := r.Header.Get("Authorization")
	if after, ok := strings.CutPrefix(value, "Bearer "); ok {
		return strings.TrimSpace(after)
	}
	return ""
}

func methodNotAllowed(w http.ResponseWriter) {
	writeJSON(w, http.StatusMethodNotAllowed, errBody("method not allowed"))
}

func sanitiseHeaderValue(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r == '"' || r == '\\' || r <= 0x1f || r == 0x7f {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}
