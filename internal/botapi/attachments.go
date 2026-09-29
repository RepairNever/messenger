package botapi

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"msgnr/internal/auth"
	"msgnr/internal/chat"
	"msgnr/internal/documents"
	"msgnr/internal/httputil"
	"msgnr/internal/tasks"
)

var (
	errAttachmentNotFound  = errors.New("attachment not found")
	errAttachmentForbidden = errors.New("attachment forbidden")
)

// DownloadAttachment resolves an attachment's owning resource and delegates to
// its domain service. Only linked message, task-comment, and document attachments
// are bot-readable; staged uploads and direct task attachments are not resolved.
func (s *Service) DownloadAttachment(ctx context.Context, botID, attachmentID uuid.UUID) (body io.ReadCloser, size int64, mimeType, fileName string, err error) {
	rows, err := s.q.ResolveBotAttachment(ctx, attachmentID)
	if err != nil {
		return nil, 0, "", "", fmt.Errorf("botapi: resolve attachment: %w", err)
	}
	if len(rows) == 0 {
		return nil, 0, "", "", errAttachmentNotFound
	}
	if len(rows) != 1 {
		// IDs are unique within each table, not globally. Never choose a kind
		// by lookup order or retry another kind after an authorization failure.
		return nil, 0, "", "", fmt.Errorf("botapi: ambiguous attachment id %s", attachmentID)
	}
	row := rows[0]
	switch row.Kind {
	case "message":
		// The shared user download method intentionally permits encrypted
		// objects. Bots must not receive them, even with a legacy membership.
		if row.EncryptionMode != chat.ConversationEncryptionNone || row.ContentMode != chat.MessageContentPlaintext {
			return nil, 0, "", "", errAttachmentForbidden
		}
		body, size, mimeType, fileName, err = s.chatSvc.DownloadMessageAttachment(ctx, botID, row.ParentID, attachmentID)
	case "task_comment":
		// Task reads are org-wide for authenticated bots. Discussion-channel
		// membership is deliberately not required for task-comment files.
		body, size, mimeType, fileName, err = s.tasksSvc.DownloadCommentAttachment(ctx, row.OwnerID, row.ParentID, attachmentID)
	case "document":
		body, size, mimeType, fileName, err = s.documentsSvc.DownloadAttachment(ctx, row.ParentID, botID, attachmentID)
	default:
		return nil, 0, "", "", fmt.Errorf("botapi: unexpected attachment kind %q", row.Kind)
	}
	if err != nil {
		return nil, 0, "", "", err
	}
	if mimeType == "" {
		mimeType = row.MimeType
	}
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	return body, size, mimeType, fileName, nil
}

func (h *Handler) attachmentDownload(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	if r.Method != http.MethodGet {
		h.methodNotAllowed(w)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/bot/v1/attachments/")
	if strings.Contains(id, "/") {
		httputil.WriteJSON(w, http.StatusNotFound, httputil.ErrorBody("not found"))
		return
	}
	attachmentID, err := uuid.Parse(id)
	if err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid attachment id"))
		return
	}
	body, size, mimeType, fileName, err := h.svc.DownloadAttachment(r.Context(), p.UserID, attachmentID)
	if err != nil {
		switch {
		case errors.Is(err, errAttachmentForbidden), errors.Is(err, chat.ErrNotMember), errors.Is(err, documents.ErrForbidden):
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("forbidden"))
		case errors.Is(err, errAttachmentNotFound), errors.Is(err, chat.ErrAttachmentNotFound), errors.Is(err, tasks.ErrNotFound), errors.Is(err, documents.ErrNotFound):
			httputil.WriteJSON(w, http.StatusNotFound, httputil.ErrorBody("not found"))
		default:
			h.internalError(w, "attachment download", err)
		}
		return
	}
	defer body.Close()

	w.Header().Set("Content-Type", mimeType)
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": fileName}))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-store")
	w.WriteHeader(http.StatusOK)
	if _, err := io.Copy(w, body); err != nil {
		h.log.Warn("botapi: copy attachment", zap.String("attachment_id", attachmentID.String()), zap.Error(err))
	}
}
