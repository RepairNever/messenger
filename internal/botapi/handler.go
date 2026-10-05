package botapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"msgnr/internal/auth"
	"msgnr/internal/chat"
	"msgnr/internal/documents"
	"msgnr/internal/httputil"
	"msgnr/internal/integrations"
	"msgnr/internal/search"
	"msgnr/internal/tasks"
)

const (
	// body limit shared by message and comment authoring, in runes.
	maxBodyRunes = chat.MaxMessageBodyRunes
	// slack added to the write deadline around a long poll.
	writeDeadlineSlack = 5 * time.Second
)

// Handler maps /api/bot/v1 routes onto Service calls.
type Handler struct {
	svc *Service
	log *zap.Logger
}

func NewHandler(svc *Service, log *zap.Logger) *Handler {
	return &Handler{svc: svc, log: log}
}

type botHandler func(w http.ResponseWriter, r *http.Request, p auth.Principal)

// RegisterRoutes wires every /api/bot/v1 endpoint. All patterns are exact
// (Go 1.25 ServeMux picks the longest match), so registration order carries
// no weight; the comment order mirrors the route table in BOT_API.md.
func (h *Handler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/bot/v1/events", h.requireAuth(h.events))
	mux.HandleFunc("/api/bot/v1/me", h.requireAuth(h.me))
	mux.HandleFunc("/api/bot/v1/channels", h.requireAuth(h.channelsDiscover))
	mux.HandleFunc("/api/bot/v1/channels/join", h.requireAuth(h.channelsJoin))
	mux.HandleFunc("/api/bot/v1/conversations", h.requireAuth(h.conversationsList))
	mux.HandleFunc("/api/bot/v1/conversations/", h.requireAuth(h.conversationsRouter))
	mux.HandleFunc("/api/bot/v1/messages", h.requireAuth(h.messages))
	mux.HandleFunc("/api/bot/v1/attachments/", h.requireAuth(h.attachmentDownload))
	// The longer enum lookup prefix wins over the public-ID task router.
	mux.HandleFunc("/api/bot/v1/tasks/by-enum/", h.requireAuth(h.tasksByEnumValue))
	mux.HandleFunc("/api/bot/v1/tasks/", h.requireAuth(h.tasksRouter))
	mux.HandleFunc("/api/bot/v1/search/messages", h.requireAuth(h.searchMessages))
	mux.HandleFunc("/api/bot/v1/search/documents", h.requireAuth(h.searchDocuments))
	mux.HandleFunc("/api/bot/v1/documents", h.requireAuth(h.documentsCollection))
	mux.HandleFunc("/api/bot/v1/documents/", h.requireAuth(h.documentItem))
}

func (h *Handler) requireAuth(next botHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := httputil.BearerToken(r)
		if token == "" {
			httputil.WriteJSON(w, http.StatusUnauthorized, httputil.ErrorBody("missing token"))
			return
		}
		principal, err := h.svc.integrations.VerifyToken(r.Context(), token)
		if err != nil {
			if errors.Is(err, integrations.ErrUnauthorized) {
				httputil.WriteJSON(w, http.StatusUnauthorized, httputil.ErrorBody("invalid token"))
				return
			}
			h.log.Error("botapi: verify token", zap.Error(err))
			httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
			return
		}
		if !h.svc.allowRequest(principal.UserID) {
			w.Header().Set("Retry-After", "1")
			httputil.WriteJSON(w, http.StatusTooManyRequests, httputil.ErrorBody("rate limit exceeded"))
			return
		}
		next(w, r, principal)
	}
}

func (h *Handler) methodNotAllowed(w http.ResponseWriter) {
	httputil.MethodNotAllowed(w)
}

// ---- identity & channels ----

func (h *Handler) me(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	if r.Method != http.MethodGet {
		h.methodNotAllowed(w)
		return
	}
	user, err := h.svc.Me(r.Context(), p.UserID)
	if err != nil {
		h.internalError(w, "me", err)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, meResponse{
		UserID:      user.ID,
		DisplayName: displayNameOrEmail(user.DisplayName, user.Email),
		Email:       user.Email,
		Role:        user.Role,
	})
}

func (h *Handler) channelsDiscover(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	if r.Method != http.MethodGet {
		h.methodNotAllowed(w)
		return
	}
	channels, err := h.svc.chatSvc.ListAvailablePublicChannels(r.Context(), p.UserID)
	if err != nil {
		h.internalError(w, "channels", err)
		return
	}
	out := channelsResponse{Channels: make([]channelDTO, 0, len(channels))}
	for _, c := range channels {
		out.Channels = append(out.Channels, channelDTO{
			ID:             c.ID,
			Name:           c.Name,
			Kind:           c.Kind,
			Visibility:     c.Visibility,
			LastActivityAt: c.LastActivityAt,
		})
	}
	httputil.WriteJSON(w, http.StatusOK, out)
}

func (h *Handler) channelsJoin(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	if r.Method != http.MethodPost {
		h.methodNotAllowed(w)
		return
	}
	var req joinChannelsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid json"))
		return
	}
	if len(req.ChannelIDs) == 0 || len(req.ChannelIDs) > 100 {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("channel_ids must contain 1 to 100 ids"))
		return
	}
	ids := make([]uuid.UUID, 0, len(req.ChannelIDs))
	for _, raw := range req.ChannelIDs {
		id, err := uuid.Parse(strings.TrimSpace(raw))
		if err != nil {
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid channel id"))
			return
		}
		ids = append(ids, id)
	}
	joined, err := h.svc.chatSvc.JoinPublicChannels(r.Context(), p.UserID, ids)
	if err != nil {
		h.internalError(w, "channels/join", err)
		return
	}
	out := joinChannelsResponse{Joined: make([]joinedChannelDTO, 0, len(joined))}
	for _, c := range joined {
		out.Joined = append(out.Joined, joinedChannelDTO{ID: c.ID, Name: c.Name})
	}
	httputil.WriteJSON(w, http.StatusOK, out)
}

// ---- conversations ----

func (h *Handler) conversationsList(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	if r.Method != http.MethodGet {
		h.methodNotAllowed(w)
		return
	}
	rows, err := h.svc.Conversations(r.Context(), p.UserID)
	if err != nil {
		h.internalError(w, "conversations", err)
		return
	}
	out := conversationsResponse{Conversations: make([]conversationDTO, 0, len(rows))}
	for _, row := range rows {
		out.Conversations = append(out.Conversations, conversationDTO{
			ID:             row.ID,
			Kind:           row.Kind,
			Visibility:     row.Visibility,
			Name:           row.Name.String,
			Hidden:         row.Hidden,
			MemberCount:    row.MemberCount,
			LastActivityAt: row.LastActivityAt,
		})
	}
	httputil.WriteJSON(w, http.StatusOK, out)
}

func (h *Handler) conversationsRouter(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	if r.Method != http.MethodGet {
		h.methodNotAllowed(w)
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/api/bot/v1/conversations/")
	parts := strings.Split(rest, "/")
	if len(parts) == 0 || parts[0] == "" {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid conversation id"))
		return
	}
	conversationID, err := uuid.Parse(parts[0])
	if err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid conversation id"))
		return
	}
	if len(parts) > 2 {
		httputil.WriteJSON(w, http.StatusNotFound, httputil.ErrorBody("not found"))
		return
	}
	sub := ""
	if len(parts) > 1 {
		sub = parts[1]
	}
	switch sub {
	case "members":
		h.conversationMembers(w, r, p, conversationID)
	case "task":
		h.conversationTask(w, r, p, conversationID)
	default:
		// A bare conversation id or an unknown sub-resource: there is no such
		// endpoint (the id itself may be valid).
		httputil.WriteJSON(w, http.StatusNotFound, httputil.ErrorBody("not found"))
	}
}

func (h *Handler) conversationMembers(w http.ResponseWriter, r *http.Request, p auth.Principal, conversationID uuid.UUID) {
	members, err := h.svc.chatSvc.ListConversationMembers(r.Context(), p.UserID, conversationID)
	if err != nil {
		// A missing conversation and a non-member conversation are
		// indistinguishable (both ErrNotMember) — 403 in either case.
		if errors.Is(err, chat.ErrNotMember) {
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("not a channel member"))
			return
		}
		h.internalError(w, "conversations/members", err)
		return
	}
	out := membersResponse{Members: make([]memberDTO, 0, len(members))}
	for _, m := range members {
		out.Members = append(out.Members, memberDTO{
			UserID:      m.UserID,
			DisplayName: displayNameOrEmail(m.DisplayName, m.Email),
			Email:       m.Email,
		})
	}
	httputil.WriteJSON(w, http.StatusOK, out)
}

func (h *Handler) conversationTask(w http.ResponseWriter, r *http.Request, p auth.Principal, conversationID uuid.UUID) {
	row, found, err := h.svc.ConversationTask(r.Context(), p.UserID, conversationID)
	if err != nil {
		h.internalError(w, "conversations/task", err)
		return
	}
	if !found {
		httputil.WriteJSON(w, http.StatusNotFound, httputil.ErrorBody("not a task discussion channel"))
		return
	}
	httputil.WriteJSON(w, http.StatusOK, conversationTaskResponse{
		TaskID:   row.ID,
		PublicID: row.PublicID,
	})
}

// ---- messages ----

func (h *Handler) messages(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	switch r.Method {
	case http.MethodGet:
		h.messagesGet(w, r, p)
	case http.MethodPost:
		h.messagesPost(w, r, p)
	default:
		h.methodNotAllowed(w)
	}
}

func (h *Handler) messagesGet(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	q := r.URL.Query()
	conversationID, err := uuid.Parse(strings.TrimSpace(q.Get("conversation_id")))
	if err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid conversation id"))
		return
	}
	limit := 50
	if raw := strings.TrimSpace(q.Get("limit")); raw != "" {
		parsed, parseErr := strconv.Atoi(raw)
		if parseErr != nil {
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid limit"))
			return
		}
		if parsed < 1 {
			parsed = 1
		}
		if parsed > 200 {
			parsed = 200
		}
		limit = parsed
	}

	threadRootRaw := strings.TrimSpace(q.Get("thread_root_message_id"))
	if threadRootRaw != "" {
		if q.Get("before_channel_seq") != "" {
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("before_channel_seq requires channel mode"))
			return
		}
		threadRootID, parseErr := uuid.Parse(threadRootRaw)
		if parseErr != nil {
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid thread root message id"))
			return
		}
		afterThreadSeq := int64(0)
		if raw := strings.TrimSpace(q.Get("after_thread_seq")); raw != "" {
			afterThreadSeq, err = strconv.ParseInt(raw, 10, 64)
			if err != nil || afterThreadSeq < 0 {
				httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid after_thread_seq"))
				return
			}
		}
		h.threadHistory(w, r, p, conversationID, threadRootID, afterThreadSeq)
		return
	}

	beforeSeq := (*int64)(nil)
	if raw := strings.TrimSpace(q.Get("before_channel_seq")); raw != "" {
		parsed, parseErr := strconv.ParseInt(raw, 10, 64)
		if parseErr != nil || parsed < 1 {
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid before_channel_seq"))
			return
		}
		beforeSeq = &parsed
	}
	if q.Get("after_thread_seq") != "" {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("after_thread_seq requires thread mode"))
		return
	}

	messages, hasMore, err := h.svc.chatSvc.ListMessagePage(r.Context(), p.UserID, conversationID, beforeSeq, limit)
	if err != nil {
		if errors.Is(err, chat.ErrNotMember) {
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("not a channel member"))
			return
		}
		h.internalError(w, "messages get", err)
		return
	}
	out := channelHistoryResponse{Messages: make([]messageDTO, 0, len(messages))}
	for i := range messages {
		out.Messages = append(out.Messages, messageToDTO(&messages[i]))
	}
	out.HasMore = hasMore
	if hasMore && len(messages) > 0 {
		// ListMessagePage returns pages ascending; the oldest row drives the
		// next page cursor.
		next := messages[0].ChannelSeq
		out.NextBeforeChannelSeq = &next
	}
	httputil.WriteJSON(w, http.StatusOK, out)
}

func (h *Handler) threadHistory(w http.ResponseWriter, r *http.Request, p auth.Principal, conversationID, threadRootID uuid.UUID, afterThreadSeq int64) {
	replay, err := h.svc.chatSvc.ListThreadReplay(r.Context(), p.UserID, conversationID, threadRootID, afterThreadSeq)
	if err != nil {
		switch {
		case errors.Is(err, chat.ErrNotMember):
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("not a channel member"))
		case errors.Is(err, chat.ErrMessageNotFound):
			httputil.WriteJSON(w, http.StatusNotFound, httputil.ErrorBody("message not found"))
		case errors.Is(err, chat.ErrInvalidThread):
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid thread"))
		default:
			h.internalError(w, "messages thread get", err)
		}
		return
	}
	out := threadHistoryResponse{Messages: make([]messageDTO, 0, len(replay.Messages))}
	for i := range replay.Messages {
		out.Messages = append(out.Messages, messageToDTO(&replay.Messages[i]))
	}
	out.CurrentThreadSeq = replay.CurrentThreadSeq
	out.ReplyCount = replay.ReplyCount
	httputil.WriteJSON(w, http.StatusOK, out)
}

func (h *Handler) messagesPost(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	var req sendMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid json"))
		return
	}
	conversationID, err := uuid.Parse(strings.TrimSpace(req.ConversationID))
	if err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid conversation id"))
		return
	}
	if !chat.IsValidClientMsgID(req.ClientMsgID) {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid client_msg_id"))
		return
	}
	body := strings.TrimSpace(req.Body)
	if body == "" || utf8.RuneCountInString(body) > maxBodyRunes {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid body"))
		return
	}
	params := chat.SendMessageParams{
		ChannelID:   conversationID,
		SenderID:    p.UserID,
		ClientMsgID: req.ClientMsgID,
		Body:        body,
	}
	if req.ThreadRootMessageID != nil && strings.TrimSpace(*req.ThreadRootMessageID) != "" {
		threadRootID, parseErr := uuid.Parse(strings.TrimSpace(*req.ThreadRootMessageID))
		if parseErr != nil {
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid thread root message id"))
			return
		}
		params.ThreadRootMessageID = threadRootID
	}
	if len(req.Entities) > 0 {
		entities := make([]chat.MessageEntity, 0, len(req.Entities))
		for _, e := range req.Entities {
			kind, ok := entityKindFromDTO(e.Kind)
			if !ok {
				httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid entity kind"))
				return
			}
			targetID, parseErr := uuid.Parse(strings.TrimSpace(e.TargetID))
			if parseErr != nil {
				httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid entity target_id"))
				return
			}
			entities = append(entities, chat.MessageEntity{
				Kind:     kind,
				TargetID: targetID,
				Label:    e.Label,
				Href:     e.Href,
				Start:    e.Start,
				End:      e.End,
			})
		}
		params.Entities = entities
	}

	result, err := h.svc.chatSvc.SendMessage(r.Context(), params)
	if err != nil {
		switch {
		case errors.Is(err, chat.ErrNotMember):
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("not a channel member"))
		case errors.Is(err, chat.ErrMessageNotFound):
			httputil.WriteJSON(w, http.StatusNotFound, httputil.ErrorBody("message not found"))
		case errors.Is(err, chat.ErrInvalidThread):
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid thread"))
		case errors.Is(err, chat.ErrEmptyMessage), errors.Is(err, chat.ErrInvalidMessageEntity):
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody(err.Error()))
		case errors.Is(err, chat.ErrEncryptedMessagesUnsupported):
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("encrypted conversations are not supported"))
		default:
			h.internalError(w, "messages post", err)
		}
		return
	}
	httputil.WriteJSON(w, http.StatusOK, sendMessageResponse{
		MessageID:   result.MessageID,
		ChannelSeq:  result.ChannelSeq,
		CreatedAt:   result.CreatedAt.AsTime(),
		ClientMsgID: result.ClientMsgID,
		Deduped:     result.Deduped,
	})
}

// ---- tasks ----

func (h *Handler) tasksRouter(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/bot/v1/tasks/")
	publicID, sub, ok := splitTaskPath(rest)
	if !ok {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid task id"))
		return
	}
	switch sub {
	case "":
		h.taskItem(w, r, p, publicID)
	case "comments":
		switch r.Method {
		case http.MethodGet:
			h.taskComments(w, r, p, publicID)
		case http.MethodPost:
			h.taskCommentCreate(w, r, p, publicID)
		default:
			h.methodNotAllowed(w)
		}
	default:
		httputil.WriteJSON(w, http.StatusNotFound, httputil.ErrorBody("not found"))
	}
}

// splitTaskPath splits "{public_id}" or "{public_id}/comments"; blank ids or
// deeper paths are rejected the same way the integrations handler does.
func splitTaskPath(rest string) (publicID, sub string, ok bool) {
	parts := strings.Split(rest, "/")
	if len(parts) == 0 || strings.TrimSpace(parts[0]) == "" {
		return "", "", false
	}
	if len(parts) == 1 {
		return parts[0], "", true
	}
	if len(parts) == 2 && parts[1] == "comments" {
		return parts[0], "comments", true
	}
	return "", "", false
}

func (h *Handler) taskItem(w http.ResponseWriter, r *http.Request, p auth.Principal, publicID string) {
	if r.Method != http.MethodGet {
		h.methodNotAllowed(w)
		return
	}
	task, err := h.svc.IntegrationTask(r.Context(), publicID)
	if err != nil {
		h.taskServiceError(w, err)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, task)
}

func (h *Handler) taskComments(w http.ResponseWriter, r *http.Request, p auth.Principal, publicID string) {
	task, err := h.svc.ResolveTaskByPublicID(r.Context(), publicID)
	if err != nil {
		h.taskServiceError(w, err)
		return
	}
	rows, err := h.svc.TaskComments(r.Context(), task.ID)
	if err != nil {
		h.internalError(w, "task comments", err)
		return
	}
	out := taskCommentsResponse{Comments: make([]taskCommentDTO, 0, len(rows))}
	for _, row := range rows {
		dto := taskCommentDTO{
			ID:              row.ID,
			TaskID:          row.TaskID,
			AuthorID:        row.AuthorID,
			AuthorName:      row.AuthorName,
			Body:            row.Body,
			CreatedAt:       row.CreatedAt,
			UpdatedAt:       row.UpdatedAt,
			AttachmentCount: row.AttachmentCount,
			Attachments:     []attachmentDTO{},
		}
		if err := json.Unmarshal(row.Attachments, &dto.Attachments); err != nil {
			h.internalError(w, "task comment attachments", err)
			return
		}
		if row.ThreadRootMessageID.Valid {
			rootID := row.ThreadRootMessageID.UUID
			dto.ThreadRootMessageID = &rootID
		}
		out.Comments = append(out.Comments, dto)
	}
	httputil.WriteJSON(w, http.StatusOK, out)
}

func (h *Handler) taskCommentCreate(w http.ResponseWriter, r *http.Request, p auth.Principal, publicID string) {
	var req createCommentRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid json"))
		return
	}
	body := strings.TrimSpace(req.Body)
	if body == "" || utf8.RuneCountInString(body) > maxBodyRunes {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid body"))
		return
	}
	task, err := h.svc.ResolveTaskByPublicID(r.Context(), publicID)
	if err != nil {
		h.taskServiceError(w, err)
		return
	}
	author, err := h.svc.Me(r.Context(), p.UserID)
	if err != nil {
		h.internalError(w, "task comment create", err)
		return
	}
	comment, err := h.svc.CreateTaskComment(r.Context(), task.ID, p.UserID, body)
	if err != nil {
		switch {
		case errors.Is(err, tasks.ErrBadRequest):
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody(err.Error()))
		case errors.Is(err, tasks.ErrNotFound):
			httputil.WriteJSON(w, http.StatusNotFound, httputil.ErrorBody(err.Error()))
		default:
			h.internalError(w, "task comment create", err)
		}
		return
	}
	dto := taskCommentDTO{
		ID:              comment.ID,
		TaskID:          comment.TaskID,
		AuthorID:        comment.AuthorID,
		AuthorName:      displayNameOrEmail(author.DisplayName, author.Email),
		Body:            comment.Body,
		CreatedAt:       comment.CreatedAt,
		UpdatedAt:       comment.UpdatedAt,
		AttachmentCount: len(comment.Attachments),
		Attachments:     make([]attachmentDTO, 0, len(comment.Attachments)),
	}
	for _, a := range comment.Attachments {
		dto.Attachments = append(dto.Attachments, attachmentDTO{
			AttachmentID: a.ID.String(), FileName: a.FileName, MimeType: a.MimeType, FileSize: a.FileSize,
		})
	}
	if comment.ThreadRootMessageID != nil {
		rootID := *comment.ThreadRootMessageID
		dto.ThreadRootMessageID = &rootID
	}
	httputil.WriteJSON(w, http.StatusCreated, dto)
}

// taskServiceError maps tasks service errors the same way the integrations
// handler does (404 body reads "not found: task").
func (h *Handler) taskServiceError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, tasks.ErrNotFound):
		httputil.WriteJSON(w, http.StatusNotFound, httputil.ErrorBody(err.Error()))
	case errors.Is(err, tasks.ErrForbidden):
		httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody(err.Error()))
	case errors.Is(err, tasks.ErrBadRequest):
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody(err.Error()))
	default:
		h.log.Error("botapi: task service", zap.Error(err))
		httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
	}
}

// ---- search ----

func (h *Handler) searchMessages(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	if r.Method != http.MethodGet {
		h.methodNotAllowed(w)
		return
	}
	q := r.URL.Query().Get("q")
	limit := 20
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		parsed, parseErr := strconv.Atoi(raw)
		if parseErr != nil {
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid limit"))
			return
		}
		if parsed < 1 {
			parsed = 1
		}
		if parsed > 50 {
			parsed = 50
		}
		limit = parsed
	}
	results, err := h.svc.SearchMessages(r.Context(), p.UserID, q, limit)
	if err != nil {
		if errors.Is(err, search.ErrQueryTooShort) {
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody(err.Error()))
			return
		}
		h.internalError(w, "search messages", err)
		return
	}
	out := searchMessagesResponse{Results: make([]searchMessageResultDTO, 0, len(results))}
	for _, res := range results {
		out.Results = append(out.Results, searchMessageResultDTO{
			Source:                 string(res.Source),
			ID:                     res.ID,
			Body:                   res.Body,
			CreatedAt:              res.CreatedAt,
			ActorID:                res.ActorID,
			ActorName:              res.ActorName,
			ConversationID:         res.ConversationID,
			ConversationTitle:      res.ConversationTitle,
			ConversationKind:       res.ConversationKind,
			ConversationVisibility: res.ConversationVisibility,
			MessageID:              res.MessageID,
			ThreadRootMessageID:    res.ThreadRootMessageID,
			TaskID:                 res.TaskID,
			TaskPublicID:           res.TaskPublicID,
			TaskTitle:              res.TaskTitle,
			TaskCommentID:          res.TaskCommentID,
		})
	}
	httputil.WriteJSON(w, http.StatusOK, out)
}

func (h *Handler) searchDocuments(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	if r.Method != http.MethodGet {
		h.methodNotAllowed(w)
		return
	}
	q := r.URL.Query().Get("q")
	results, err := h.svc.documentsSvc.SearchDocuments(r.Context(), p.UserID, q)
	if err != nil {
		if errors.Is(err, documents.ErrBadRequest) {
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody(err.Error()))
			return
		}
		h.internalError(w, "search documents", err)
		return
	}
	out := searchDocumentsResponse{Results: make([]searchDocumentResultDTO, 0, len(results))}
	for _, res := range results {
		out.Results = append(out.Results, searchDocumentResultDTO{
			ID:            res.ID,
			TeamspaceID:   res.TeamspaceID,
			TeamspaceName: res.TeamspaceName,
			Title:         res.Title,
			Snippet:       res.Snippet,
		})
	}
	httputil.WriteJSON(w, http.StatusOK, out)
}

// ---- documents ----

func (h *Handler) documentItem(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	if r.Method != http.MethodGet {
		h.methodNotAllowed(w)
		return
	}
	documentID, err := uuid.Parse(strings.TrimPrefix(r.URL.Path, "/api/bot/v1/documents/"))
	if err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid document id"))
		return
	}
	doc, err := h.svc.documentsSvc.GetDocument(r.Context(), documentID, p.UserID)
	if err != nil {
		h.documentServiceError(w, err)
		return
	}
	rows, err := h.svc.documentsSvc.ListAttachments(r.Context(), documentID, p.UserID)
	if err != nil {
		h.documentServiceError(w, err)
		return
	}
	attachments := make([]attachmentDTO, 0, len(rows))
	for _, a := range rows {
		attachments = append(attachments, attachmentDTO{
			AttachmentID: a.ID.String(), FileName: a.FileName, MimeType: a.MimeType, FileSize: a.FileSize,
		})
	}
	httputil.WriteJSON(w, http.StatusOK, documentDTO{
		ID:              doc.ID,
		TeamspaceID:     doc.TeamspaceID,
		ParentID:        doc.ParentDocumentID,
		Title:           doc.Title,
		ContentMarkdown: doc.ContentMarkdown,
		CreatedBy:       doc.CreatedBy,
		UpdatedBy:       doc.UpdatedBy,
		CreatedAt:       doc.CreatedAt,
		UpdatedAt:       doc.UpdatedAt,
		Attachments:     attachments,
	})
}

func (h *Handler) documentServiceError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, documents.ErrForbidden):
		httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody(err.Error()))
	case errors.Is(err, documents.ErrNotFound):
		httputil.WriteJSON(w, http.StatusNotFound, httputil.ErrorBody(err.Error()))
	default:
		h.internalError(w, "document item", err)
	}
}

// ---- events ----

func (h *Handler) events(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	if r.Method != http.MethodGet {
		h.methodNotAllowed(w)
		return
	}
	query := eventsQuery{AfterSeq: 0, Limit: 200, WaitSeconds: 0}
	if raw := strings.TrimSpace(r.URL.Query().Get("after_seq")); raw != "" {
		afterSeq, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || afterSeq < 0 {
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid after_seq"))
			return
		}
		query.AfterSeq = afterSeq
	}
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		limit, err := strconv.Atoi(raw)
		if err != nil {
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid limit"))
			return
		}
		query.Limit = limit
	}
	waitSeconds := 0
	if raw := strings.TrimSpace(r.URL.Query().Get("wait_seconds")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 0 {
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid wait_seconds"))
			return
		}
		waitSeconds = parsed
	}
	query.WaitSeconds = h.svc.clampWaitSeconds(waitSeconds)

	// A parked request outlives the server's global HTTPWriteTimeout, so the
	// per-request write deadline is extended for the poll window (plus slack).
	if query.WaitSeconds > 0 {
		rc := http.NewResponseController(w)
		if err := rc.SetWriteDeadline(time.Now().Add(time.Duration(query.WaitSeconds)*time.Second + writeDeadlineSlack)); err != nil {
			h.log.Warn("botapi: extend write deadline", zap.Error(err))
		}
	}

	res, err := h.svc.Events(r.Context(), p.UserID, query)
	if err != nil {
		if errors.Is(err, ErrTooManyPolls) {
			httputil.WriteJSON(w, http.StatusTooManyRequests, httputil.ErrorBody("too many concurrent polls"))
			return
		}
		h.internalError(w, "events", err)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, res)
}

// ---- helpers ----

func (h *Handler) internalError(w http.ResponseWriter, where string, err error) {
	h.log.Error("botapi: "+where, zap.Error(err))
	httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
}

func entityKindFromDTO(kind string) (chat.MessageEntityKind, bool) {
	switch kind {
	case "user":
		return chat.MessageEntityKindUser, true
	case "task":
		return chat.MessageEntityKindTask, true
	case "document":
		return chat.MessageEntityKindDocument, true
	default:
		return "", false
	}
}

func displayNameOrEmail(displayName, email string) string {
	if strings.TrimSpace(displayName) != "" {
		return displayName
	}
	return email
}

func messageToDTO(m *chat.ConversationMessage) messageDTO {
	dto := messageDTO{
		ID:               m.ID,
		ConversationID:   m.ConversationID,
		SenderID:         m.SenderID,
		SenderName:       m.SenderName,
		Body:             m.Body,
		ChannelSeq:       m.ChannelSeq,
		ThreadSeq:        m.ThreadSeq,
		ThreadReplyCount: m.ThreadReplyCount,
		MentionEveryone:  m.MentionEveryone,
		CreatedAt:        m.CreatedAt,
		ContentMode:      m.ContentMode,
	}
	if m.EditedAt != nil {
		editedAt := *m.EditedAt
		dto.EditedAt = &editedAt
	}
	if m.ThreadRootMessageID != uuid.Nil {
		rootID := m.ThreadRootMessageID
		dto.ThreadRootMessageID = &rootID
	}
	if len(m.Entities) > 0 {
		dto.Entities = make([]entityDTO, 0, len(m.Entities))
		for _, e := range m.Entities {
			dto.Entities = append(dto.Entities, entityDTO{
				Kind:     string(e.Kind),
				TargetID: e.TargetID.String(),
				Label:    e.Label,
				Href:     e.Href,
				Start:    e.Start,
				End:      e.End,
			})
		}
	}
	if len(m.Reactions) > 0 {
		dto.Reactions = make([]reactionDTO, 0, len(m.Reactions))
		for _, reaction := range m.Reactions {
			dto.Reactions = append(dto.Reactions, reactionDTO{Emoji: reaction.Emoji, Count: reaction.Count})
		}
	}
	if len(m.Attachments) > 0 {
		dto.Attachments = make([]attachmentDTO, 0, len(m.Attachments))
		for _, a := range m.Attachments {
			dto.Attachments = append(dto.Attachments, attachmentDTO{
				AttachmentID: a.ID.String(),
				FileName:     a.FileName,
				MimeType:     a.MimeType,
				FileSize:     a.FileSize,
			})
		}
	}
	return dto
}
