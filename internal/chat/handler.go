package chat

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"msgnr/internal/auth"
	"msgnr/internal/config"
	"msgnr/internal/httputil"
	"msgnr/internal/logger"
	"msgnr/internal/userstatus"
)

// Handler exposes chat-related HTTP endpoints.
// DMNotifier is the subset of ws.Server used by the chat handler to push
// direct-delivery events after a new DM is created.
type DMNotifier interface {
	SendChatDirectServerEvents(deliveries []DirectDelivery)
}

type Handler struct {
	svc      *Service
	authSvc  *auth.Service
	cfg      *config.Config
	log      *zap.Logger
	notifier DMNotifier // may be nil until SetNotifier is called
}

// NewHandler creates a Handler.
func NewHandler(svc *Service, authSvc *auth.Service, cfg *config.Config) *Handler {
	return &Handler{svc: svc, authSvc: authSvc, cfg: cfg, log: logger.Logger}
}

// SetNotifier wires the WS server for direct-delivery push after DM creation.
// Called after ws.Server is constructed (which depends on the chat service).
func (h *Handler) SetNotifier(n DMNotifier) {
	h.notifier = n
}

// RegisterRoutes registers chat HTTP routes on mux.
func (h *Handler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/channels", h.requireAuth(h.listChannels))
	mux.HandleFunc("/api/channels/available", h.requireAuth(h.listAvailableChannels))
	mux.HandleFunc("/api/channels/join", h.requireAuth(h.joinChannels))
	mux.HandleFunc("/api/conversations/leave", h.requireAuth(h.leaveConversation))
	mux.HandleFunc("/api/conversations/clear-history", h.requireAuth(h.clearConversationHistory))
	mux.HandleFunc("/api/conversations/members", h.requireAuth(h.listConversationMembers))
	mux.HandleFunc("/api/conversations/members/remove", h.requireAuth(h.removeConversationMember))
	mux.HandleFunc("/api/conversations/active-call-members", h.requireAuth(h.listActiveCallMembers))
	mux.HandleFunc("/api/conversations/invite", h.requireAuth(h.inviteToConversation))
	mux.HandleFunc("/api/chat/unread-feed", h.requireAuth(h.listUnreadFeed))
	mux.HandleFunc("/api/chat/unread-feed/resolve", h.requireAuth(h.resolveUnreadFeedItem))
	mux.HandleFunc("/api/chat/saved-messages", h.requireAuth(h.listSavedMessages))
	mux.HandleFunc("/api/chat/forward-targets", h.requireAuth(h.listForwardTargets))
	mux.HandleFunc("/api/messages", h.requireAuth(h.listConversationMessages))
	mux.HandleFunc("/api/messages/context", h.requireAuth(h.getMessageContext))
	mux.HandleFunc("/api/messages/reaction-users", h.requireAuth(h.listMessageReactionUsers))
	mux.HandleFunc("/api/messages/", h.requireAuth(h.messageItem))
	mux.HandleFunc("/api/chat/tag-search", h.requireAuth(h.searchTagEntities))
	mux.HandleFunc("/api/chat/attachments", h.requireAuth(h.chatAttachments))
	mux.HandleFunc("/api/chat/attachments/", h.requireAuth(h.chatAttachmentItem))
	mux.HandleFunc("/api/dm-candidates", h.requireAuth(h.listDMCandidates))
	mux.HandleFunc("/api/e2ee/devices", h.requireAuth(h.e2eeDevices))
	mux.HandleFunc("/api/e2ee/recovery/activate", h.requireAuth(h.activateE2EERecoveryDevice))
	mux.HandleFunc("/api/e2ee/conversation-devices", h.requireAuth(h.listEncryptedDMDevices))
	mux.HandleFunc("/api/dms/e2ee", h.requireAuth(h.createOrOpenEncryptedDirectMessage))
	mux.HandleFunc("/api/dms", h.requireAuth(h.createOrOpenDirectMessage))
}

type channelResponse struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Kind           string `json:"kind"`
	Visibility     string `json:"visibility"`
	LastActivityAt string `json:"last_activity_at"`
}

type dmCandidateResponse struct {
	UserID       string           `json:"user_id"`
	DisplayName  string           `json:"display_name"`
	Email        string           `json:"email"`
	AvatarURL    string           `json:"avatar_url"`
	CustomStatus *userstatus.Body `json:"custom_status"`
}

type createDirectMessageRequest struct {
	UserID string `json:"user_id"`
}

type createEncryptedDirectMessageRequest struct {
	ConversationID string `json:"conversation_id"`
}

type registerE2EEDeviceRequest struct {
	DeviceID              string `json:"device_id"`
	DeviceLabel           string `json:"device_label"`
	IdentityKeyPublic     string `json:"identity_key_public"`
	SignedPrekeyID        int    `json:"signed_prekey_id"`
	SignedPrekeyPublic    string `json:"signed_prekey_public"`
	SignedPrekeySignature string `json:"signed_prekey_signature"`
}

type activateE2EERecoveryDeviceRequest struct {
	registerE2EEDeviceRequest
	ReplaceDeviceID string `json:"replace_device_id"`
}

const maxE2EEDeviceRequestBytes int64 = 64 * 1024

type e2eeDeviceResponse struct {
	DeviceID              string `json:"device_id"`
	UserID                string `json:"user_id"`
	DeviceLabel           string `json:"device_label"`
	IdentityKeyPublic     string `json:"identity_key_public"`
	SignedPrekeyID        int    `json:"signed_prekey_id"`
	SignedPrekeyPublic    string `json:"signed_prekey_public"`
	SignedPrekeySignature string `json:"signed_prekey_signature"`
}

type joinChannelsRequest struct {
	ChannelIDs []string `json:"channel_ids"`
}

type leaveConversationRequest struct {
	ConversationID string `json:"conversation_id"`
}

type clearConversationHistoryRequest struct {
	ConversationID string `json:"conversation_id"`
}

type clearConversationHistoryResponse struct {
	ConversationID       string `json:"conversation_id"`
	DeletedMessagesCount int32  `json:"deleted_messages_count"`
}

type inviteConversationRequest struct {
	ConversationID string `json:"conversation_id"`
	UserID         string `json:"user_id"`
}

type removeConversationMemberRequest struct {
	ConversationID string `json:"conversation_id"`
	UserID         string `json:"user_id"`
}

type conversationMemberResponse struct {
	UserID       string           `json:"user_id"`
	DisplayName  string           `json:"display_name"`
	Email        string           `json:"email"`
	AvatarURL    string           `json:"avatar_url"`
	CustomStatus *userstatus.Body `json:"custom_status"`
}

type directMessageResponse struct {
	ConversationID string           `json:"conversation_id"`
	UserID         string           `json:"user_id"`
	DisplayName    string           `json:"display_name"`
	Email          string           `json:"email"`
	AvatarURL      string           `json:"avatar_url"`
	CustomStatus   *userstatus.Body `json:"custom_status"`
	Kind           string           `json:"kind"`
	Visibility     string           `json:"visibility"`
	EncryptionMode string           `json:"encryption_mode"`
}

type conversationMessageResponse struct {
	ID                  string                      `json:"id"`
	ConversationID      string                      `json:"conversation_id"`
	SenderID            string                      `json:"sender_id"`
	SenderName          string                      `json:"sender_name"`
	Body                string                      `json:"body"`
	ForwardedFrom       *forwardedMessageResponse   `json:"forwarded_from,omitempty"`
	Entities            []messageEntityResponse     `json:"entities"`
	ChannelSeq          int64                       `json:"channel_seq"`
	ThreadSeq           int64                       `json:"thread_seq"`
	ThreadRootMessageID string                      `json:"thread_root_message_id"`
	ThreadReplyCount    int32                       `json:"thread_reply_count"`
	EditedAt            string                      `json:"edited_at,omitempty"`
	MentionEveryone     bool                        `json:"mention_everyone"`
	CreatedAt           string                      `json:"created_at"`
	Reactions           []reactionAggregateResponse `json:"reactions"`
	MyReactions         []string                    `json:"my_reactions"`
	Attachments         []messageAttachmentResponse `json:"attachments"`
	IsSaved             bool                        `json:"is_saved"`
	ContentMode         string                      `json:"content_mode"`
	SenderDeviceID      string                      `json:"sender_device_id,omitempty"`
	EncryptedDMPayloads []encryptedDMPayloadBody    `json:"encrypted_dm_payloads,omitempty"`
}

type encryptedDMPayloadBody struct {
	RecipientDeviceID string `json:"recipient_device_id"`
	SenderDeviceID    string `json:"sender_device_id"`
	Algorithm         string `json:"algorithm"`
	SessionMessage    string `json:"session_message"`
	MetadataAAD       string `json:"metadata_aad"`
}

type forwardedMessageResponse struct {
	MessageID         string `json:"message_id"`
	SenderID          string `json:"sender_id"`
	SenderName        string `json:"sender_name"`
	ConversationKind  string `json:"conversation_kind,omitempty"`
	ConversationTitle string `json:"conversation_title,omitempty"`
	ThreadTitle       string `json:"thread_title,omitempty"`
}

type messageAttachmentResponse struct {
	ID                string `json:"id"`
	FileName          string `json:"file_name"`
	FileSize          int64  `json:"file_size"`
	MimeType          string `json:"mime_type"`
	ThumbnailMimeType string `json:"thumbnail_mime_type,omitempty"`
	ThumbnailFileSize int64  `json:"thumbnail_file_size,omitempty"`
	ThumbnailVersion  int16  `json:"thumbnail_version,omitempty"`
}

type messageEntityRequest struct {
	Kind     string `json:"kind"`
	TargetID string `json:"target_id"`
	Label    string `json:"label"`
	Href     string `json:"href"`
	Start    int32  `json:"start"`
	End      int32  `json:"end"`
}

type messageEntityResponse struct {
	Kind     string `json:"kind"`
	TargetID string `json:"target_id"`
	Label    string `json:"label"`
	Href     string `json:"href"`
	Start    int32  `json:"start"`
	End      int32  `json:"end"`
}

type reactionAggregateResponse struct {
	Emoji string `json:"emoji"`
	Count int32  `json:"count"`
}

type reactionUserResponse struct {
	UserID      string `json:"user_id"`
	DisplayName string `json:"display_name"`
	AvatarURL   string `json:"avatar_url"`
}

type reactionUsersResponse struct {
	Users []reactionUserResponse `json:"users"`
}

type conversationMessagesPageResponse struct {
	Messages             []conversationMessageResponse `json:"messages"`
	HasMore              bool                          `json:"has_more"`
	PageSize             int                           `json:"page_size"`
	NextBeforeChannelSeq string                        `json:"next_before_channel_seq,omitempty"`
}

type unreadFeedItemResponse struct {
	ID                     string `json:"id"`
	Kind                   string `json:"kind"`
	NotificationID         string `json:"notification_id,omitempty"`
	ConversationID         string `json:"conversation_id"`
	ConversationKind       string `json:"conversation_kind"`
	ConversationVisibility string `json:"conversation_visibility"`
	ConversationTitle      string `json:"conversation_title"`
	MessageID              string `json:"message_id,omitempty"`
	ThreadRootMessageID    string `json:"thread_root_message_id,omitempty"`
	SenderID               string `json:"sender_id,omitempty"`
	SenderName             string `json:"sender_name"`
	Body                   string `json:"body"`
	CreatedAt              string `json:"created_at"`
}

type unreadFeedResponse struct {
	TotalCount int                      `json:"total_count"`
	Items      []unreadFeedItemResponse `json:"items"`
}

type savedMessageItemResponse struct {
	ID                     string                    `json:"id"`
	ConversationID         string                    `json:"conversation_id"`
	ConversationKind       string                    `json:"conversation_kind"`
	ConversationVisibility string                    `json:"conversation_visibility"`
	ConversationTitle      string                    `json:"conversation_title"`
	MessageID              string                    `json:"message_id"`
	ThreadRootMessageID    string                    `json:"thread_root_message_id,omitempty"`
	SenderID               string                    `json:"sender_id"`
	SenderName             string                    `json:"sender_name"`
	Body                   string                    `json:"body"`
	ForwardedFrom          *forwardedMessageResponse `json:"forwarded_from,omitempty"`
	Entities               []messageEntityResponse   `json:"entities"`
	CreatedAt              string                    `json:"created_at"`
	SavedAt                string                    `json:"saved_at"`
}

type savedMessagesResponse struct {
	TotalCount int                        `json:"total_count"`
	Items      []savedMessageItemResponse `json:"items"`
}

type forwardTargetConversationResponse struct {
	ConversationID string `json:"conversation_id"`
	Title          string `json:"title"`
	Kind           string `json:"kind"`
	Visibility     string `json:"visibility"`
}

type forwardTargetThreadResponse struct {
	ConversationID      string `json:"conversation_id"`
	ConversationTitle   string `json:"conversation_title"`
	ThreadRootMessageID string `json:"thread_root_message_id"`
	RootSenderName      string `json:"root_sender_name"`
	RootBody            string `json:"root_body"`
	ReplyCount          int32  `json:"reply_count"`
	LastReplyAt         string `json:"last_reply_at"`
}

type forwardTargetsResponse struct {
	Conversations []forwardTargetConversationResponse `json:"conversations"`
	Threads       []forwardTargetThreadResponse       `json:"threads"`
}

type resolveUnreadFeedItemRequest struct {
	NotificationID string `json:"notification_id"`
}

type forwardMessageRequest struct {
	DestinationConversationID      string `json:"destination_conversation_id"`
	DestinationThreadRootMessageID string `json:"destination_thread_root_message_id"`
}

type forwardMessageResponseBody struct {
	MessageID  string `json:"message_id"`
	ChannelSeq int64  `json:"channel_seq"`
	CreatedAt  string `json:"created_at"`
}

type editMessageRequest struct {
	Body     string                 `json:"body"`
	Entities []messageEntityRequest `json:"entities"`
}

type editMessageResponse struct {
	MessageID string                  `json:"message_id"`
	EditedAt  string                  `json:"edited_at"`
	Entities  []messageEntityResponse `json:"entities"`
}

type tagSearchUserResponse struct {
	UserID       string           `json:"user_id"`
	DisplayName  string           `json:"display_name"`
	Email        string           `json:"email"`
	AvatarURL    string           `json:"avatar_url"`
	CustomStatus *userstatus.Body `json:"custom_status"`
	Presence     string           `json:"presence"`
}

type tagSearchTaskResponse struct {
	TaskID   string `json:"task_id"`
	PublicID string `json:"public_id"`
	Title    string `json:"title"`
	Label    string `json:"label"`
	Href     string `json:"href"`
}

type tagSearchDocumentResponse struct {
	DocumentID string `json:"document_id"`
	Title      string `json:"title"`
	Label      string `json:"label"`
	Href       string `json:"href"`
}

type tagSearchResponse struct {
	Users     []tagSearchUserResponse     `json:"users"`
	Tasks     []tagSearchTaskResponse     `json:"tasks"`
	Documents []tagSearchDocumentResponse `json:"documents"`
}

func decodeMessageEntities(raw []messageEntityRequest) ([]MessageEntity, error) {
	entities := make([]MessageEntity, 0, len(raw))
	for _, item := range raw {
		targetID, err := uuid.Parse(item.TargetID)
		if err != nil {
			return nil, ErrInvalidMessageEntity
		}
		entities = append(entities, MessageEntity{
			Kind:     MessageEntityKind(item.Kind),
			TargetID: targetID,
			Label:    item.Label,
			Href:     item.Href,
			Start:    item.Start,
			End:      item.End,
		})
	}
	return entities, nil
}

func encodeForwardedMessage(info *ForwardedMessageInfo) *forwardedMessageResponse {
	if info == nil || info.MessageID == uuid.Nil || info.SenderID == uuid.Nil || strings.TrimSpace(info.SenderName) == "" {
		return nil
	}
	return &forwardedMessageResponse{
		MessageID:         info.MessageID.String(),
		SenderID:          info.SenderID.String(),
		SenderName:        info.SenderName,
		ConversationKind:  strings.TrimSpace(info.ConversationKind),
		ConversationTitle: strings.TrimSpace(info.ConversationTitle),
		ThreadTitle:       strings.TrimSpace(info.ThreadTitle),
	}
}

func encodeMessageEntities(raw []MessageEntity) []messageEntityResponse {
	entities := make([]messageEntityResponse, 0, len(raw))
	for _, item := range raw {
		entities = append(entities, messageEntityResponse{
			Kind:     string(item.Kind),
			TargetID: item.TargetID.String(),
			Label:    item.Label,
			Href:     item.Href,
			Start:    item.Start,
			End:      item.End,
		})
	}
	return entities
}

func (h *Handler) listChannels(w http.ResponseWriter, r *http.Request, principal auth.Principal) {
	if r.Method != http.MethodGet {
		httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
		return
	}

	channels, err := h.svc.q.ListUserChannels(r.Context(), principal.UserID)
	if err != nil {
		h.log.Error("listChannels query error", zap.Error(err))
		httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		return
	}

	resp := make([]channelResponse, 0, len(channels))
	for _, ch := range channels {
		name := ch.Name.String
		if !ch.Name.Valid || name == "" {
			name = ch.Kind
		}
		resp = append(resp, channelResponse{
			ID:             ch.ID.String(),
			Name:           name,
			Kind:           ch.Kind,
			Visibility:     ch.Visibility,
			LastActivityAt: ch.LastActivityAt.UTC().Format("2006-01-02T15:04:05Z"),
		})
	}

	httputil.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) listAvailableChannels(w http.ResponseWriter, r *http.Request, principal auth.Principal) {
	if r.Method != http.MethodGet {
		httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
		return
	}

	channels, err := h.svc.ListAvailablePublicChannels(r.Context(), principal.UserID)
	if err != nil {
		h.log.Error("listAvailableChannels error", zap.Error(err))
		httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		return
	}

	resp := make([]channelResponse, 0, len(channels))
	for _, ch := range channels {
		resp = append(resp, channelResponse{
			ID:             ch.ID.String(),
			Name:           ch.Name,
			Kind:           ch.Kind,
			Visibility:     ch.Visibility,
			LastActivityAt: ch.LastActivityAt.UTC().Format("2006-01-02T15:04:05Z"),
		})
	}
	httputil.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) searchTagEntities(w http.ResponseWriter, r *http.Request, principal auth.Principal) {
	if r.Method != http.MethodGet {
		httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
		return
	}

	conversationID, err := uuid.Parse(strings.TrimSpace(r.URL.Query().Get("conversation_id")))
	if err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid conversation_id"))
		return
	}

	result, err := h.svc.SearchTagEntities(r.Context(), principal.UserID, conversationID, r.URL.Query().Get("q"))
	if err != nil {
		switch {
		case errors.Is(err, ErrNotMember):
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("not a member of this conversation"))
		default:
			h.log.Error("searchTagEntities error", zap.Error(err))
			httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		}
		return
	}

	resp := tagSearchResponse{
		Users:     make([]tagSearchUserResponse, 0, len(result.Users)),
		Tasks:     make([]tagSearchTaskResponse, 0, len(result.Tasks)),
		Documents: make([]tagSearchDocumentResponse, 0, len(result.Documents)),
	}
	for _, item := range result.Users {
		resp.Users = append(resp.Users, tagSearchUserResponse{
			UserID:       item.UserID.String(),
			DisplayName:  item.DisplayName,
			Email:        item.Email,
			AvatarURL:    item.AvatarURL,
			CustomStatus: userstatus.ToBody(item.CustomStatus),
			Presence:     item.Presence,
		})
	}
	for _, item := range result.Tasks {
		resp.Tasks = append(resp.Tasks, tagSearchTaskResponse{
			TaskID:   item.TaskID.String(),
			PublicID: item.PublicID,
			Title:    item.Title,
			Label:    item.Label(),
			Href:     item.Href(),
		})
	}
	for _, item := range result.Documents {
		resp.Documents = append(resp.Documents, tagSearchDocumentResponse{
			DocumentID: item.DocumentID.String(),
			Title:      item.Title,
			Label:      item.Label(),
			Href:       item.Href(),
		})
	}
	httputil.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) joinChannels(w http.ResponseWriter, r *http.Request, principal auth.Principal) {
	if r.Method != http.MethodPost {
		httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
		return
	}

	var req joinChannelsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid json"))
		return
	}

	channelIDs := make([]uuid.UUID, 0, len(req.ChannelIDs))
	for _, rawID := range req.ChannelIDs {
		channelID, err := uuid.Parse(rawID)
		if err != nil {
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid channel_id"))
			return
		}
		channelIDs = append(channelIDs, channelID)
	}

	joined, err := h.svc.JoinPublicChannels(r.Context(), principal.UserID, channelIDs)
	if err != nil {
		h.log.Error("joinChannels error", zap.Error(err))
		httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		return
	}
	if len(joined) > 0 && h.notifier != nil {
		deliveries := make([]DirectDelivery, 0, len(joined))
		for _, channel := range joined {
			deliveries = append(deliveries, buildChannelConversationUpsertedDelivery(principal.UserID, channel))
		}
		h.notifier.SendChatDirectServerEvents(deliveries)
	}

	resp := make([]channelResponse, 0, len(joined))
	for _, ch := range joined {
		resp = append(resp, channelResponse{
			ID:             ch.ID.String(),
			Name:           ch.Name,
			Kind:           ch.Kind,
			Visibility:     ch.Visibility,
			LastActivityAt: ch.LastActivityAt.UTC().Format("2006-01-02T15:04:05Z"),
		})
	}
	httputil.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) leaveConversation(w http.ResponseWriter, r *http.Request, principal auth.Principal) {
	if r.Method != http.MethodPost {
		httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
		return
	}

	var req leaveConversationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid json"))
		return
	}
	conversationID, err := uuid.Parse(req.ConversationID)
	if err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid conversation_id"))
		return
	}

	result, err := h.svc.LeaveConversation(r.Context(), principal.UserID, conversationID)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotMember):
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("not a member of this conversation"))
		case errors.Is(err, ErrSelfDMProtected):
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("self dm cannot be archived"))
		default:
			h.log.Error("leaveConversation error", zap.Error(err))
			httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		}
		return
	}
	if len(result.DirectDeliveries) > 0 && h.notifier != nil {
		h.notifier.SendChatDirectServerEvents(result.DirectDeliveries)
	}

	httputil.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *Handler) clearConversationHistory(w http.ResponseWriter, r *http.Request, principal auth.Principal) {
	if r.Method != http.MethodPost {
		httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
		return
	}

	var req clearConversationHistoryRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid json"))
		return
	}
	conversationID, err := uuid.Parse(strings.TrimSpace(req.ConversationID))
	if err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid conversation_id"))
		return
	}

	result, err := h.svc.ClearDMConversationHistory(r.Context(), ClearDMConversationHistoryParams{
		ConversationID: conversationID,
		ActorID:        principal.UserID,
	})
	if err != nil {
		switch {
		case errors.Is(err, ErrNotMember):
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("not a member of this conversation"))
		case errors.Is(err, ErrClearHistoryUnsupported):
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("clear history is only supported for direct messages"))
		default:
			h.log.Error("clearConversationHistory error", zap.Error(err))
			httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		}
		return
	}

	httputil.WriteJSON(w, http.StatusOK, clearConversationHistoryResponse{
		ConversationID:       result.ConversationID.String(),
		DeletedMessagesCount: result.DeletedMessagesCount,
	})
}

func (h *Handler) listConversationMembers(w http.ResponseWriter, r *http.Request, principal auth.Principal) {
	if r.Method != http.MethodGet {
		httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
		return
	}

	conversationID, err := uuid.Parse(r.URL.Query().Get("conversation_id"))
	if err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid conversation_id"))
		return
	}

	members, err := h.svc.ListConversationMembers(r.Context(), principal.UserID, conversationID)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotMember):
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("not a member of this conversation"))
		default:
			h.log.Error("listConversationMembers error", zap.Error(err))
			httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		}
		return
	}

	resp := make([]conversationMemberResponse, 0, len(members))
	for _, member := range members {
		resp = append(resp, conversationMemberResponse{
			UserID:       member.UserID.String(),
			DisplayName:  member.DisplayName,
			Email:        member.Email,
			AvatarURL:    member.AvatarURL,
			CustomStatus: userstatus.ToBody(member.CustomStatus),
		})
	}
	httputil.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) removeConversationMember(w http.ResponseWriter, r *http.Request, principal auth.Principal) {
	if r.Method != http.MethodPost {
		httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
		return
	}

	var req removeConversationMemberRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid json"))
		return
	}
	conversationID, err := uuid.Parse(req.ConversationID)
	if err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid conversation_id"))
		return
	}
	targetUserID, err := uuid.Parse(req.UserID)
	if err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid user_id"))
		return
	}

	result, err := h.svc.RemoveConversationMember(r.Context(), principal.UserID, principal.Role, conversationID, targetUserID)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotMember):
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("not a member of this conversation"))
		case errors.Is(err, ErrRemoveMemberForbidden):
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("not allowed to remove members from this conversation"))
		case errors.Is(err, ErrRemoveUnsupportedTarget):
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("cannot remove members from this conversation"))
		case errors.Is(err, ErrConversationArchived):
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("cannot remove members from archived conversations"))
		case errors.Is(err, ErrNotPublicChannel):
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("conversation not found"))
		default:
			h.log.Error("removeConversationMember error", zap.Error(err))
			httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		}
		return
	}

	if len(result.DirectDeliveries) > 0 && h.notifier != nil {
		h.notifier.SendChatDirectServerEvents(result.DirectDeliveries)
	}

	httputil.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *Handler) listActiveCallMembers(w http.ResponseWriter, r *http.Request, principal auth.Principal) {
	if r.Method != http.MethodGet {
		httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
		return
	}

	conversationID, err := uuid.Parse(r.URL.Query().Get("conversation_id"))
	if err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid conversation_id"))
		return
	}

	members, err := h.svc.ListActiveCallMembers(r.Context(), principal.UserID, conversationID)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotMember):
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("not a member of this conversation"))
		default:
			h.log.Error("listActiveCallMembers error", zap.Error(err))
			httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		}
		return
	}

	resp := make([]conversationMemberResponse, 0, len(members))
	for _, member := range members {
		resp = append(resp, conversationMemberResponse{
			UserID:       member.UserID.String(),
			DisplayName:  member.DisplayName,
			Email:        member.Email,
			AvatarURL:    member.AvatarURL,
			CustomStatus: userstatus.ToBody(member.CustomStatus),
		})
	}
	httputil.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) listConversationMessages(w http.ResponseWriter, r *http.Request, principal auth.Principal) {
	if r.Method != http.MethodGet {
		httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
		return
	}

	conversationID, err := uuid.Parse(r.URL.Query().Get("conversation_id"))
	if err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid conversation_id"))
		return
	}
	var requesterDeviceID uuid.UUID
	if rawDeviceID := strings.TrimSpace(r.URL.Query().Get("e2ee_device_id")); rawDeviceID != "" {
		requesterDeviceID, err = uuid.Parse(rawDeviceID)
		if err != nil {
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid e2ee_device_id"))
			return
		}
	}

	var beforeChannelSeq *int64
	if raw := r.URL.Query().Get("before_channel_seq"); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid before_channel_seq"))
			return
		}
		if parsed <= 0 {
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("before_channel_seq must be > 0"))
			return
		}
		beforeChannelSeq = &parsed
	}

	pageSize := h.cfg.ChatHistoryPageSize
	if pageSize <= 0 {
		pageSize = 50
	}

	messages, hasMore, err := h.svc.ListMessagePage(
		r.Context(),
		principal.UserID,
		conversationID,
		beforeChannelSeq,
		pageSize,
		requesterDeviceID,
	)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotMember):
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("not a member of this channel"))
		default:
			h.log.Error("listConversationMessages error", zap.Error(err))
			httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		}
		return
	}

	resp := make([]conversationMessageResponse, 0, len(messages))
	for _, msg := range messages {
		threadRootID := ""
		if msg.ThreadRootMessageID != uuid.Nil {
			threadRootID = msg.ThreadRootMessageID.String()
		}
		reactions := make([]reactionAggregateResponse, 0, len(msg.Reactions))
		for _, reaction := range msg.Reactions {
			reactions = append(reactions, reactionAggregateResponse{
				Emoji: reaction.Emoji,
				Count: reaction.Count,
			})
		}
		attachments := make([]messageAttachmentResponse, 0, len(msg.Attachments))
		for _, attachment := range msg.Attachments {
			attachments = append(attachments, messageAttachmentResponse{
				ID:                attachment.ID.String(),
				FileName:          attachment.FileName,
				FileSize:          attachment.FileSize,
				MimeType:          attachment.MimeType,
				ThumbnailMimeType: attachment.ThumbnailMimeType,
				ThumbnailFileSize: attachment.ThumbnailFileSize,
				ThumbnailVersion:  attachment.ThumbnailVersion,
			})
		}
		editedAt := ""
		if msg.EditedAt != nil && !msg.EditedAt.IsZero() {
			editedAt = msg.EditedAt.UTC().Format("2006-01-02T15:04:05Z")
		}
		resp = append(resp, conversationMessageResponse{
			ID:                  msg.ID.String(),
			ConversationID:      msg.ConversationID.String(),
			SenderID:            msg.SenderID.String(),
			SenderName:          msg.SenderName,
			Body:                msg.Body,
			ForwardedFrom:       encodeForwardedMessage(msg.ForwardedFrom),
			Entities:            encodeMessageEntities(msg.Entities),
			ChannelSeq:          msg.ChannelSeq,
			ThreadSeq:           msg.ThreadSeq,
			ThreadRootMessageID: threadRootID,
			ThreadReplyCount:    msg.ThreadReplyCount,
			EditedAt:            editedAt,
			MentionEveryone:     msg.MentionEveryone,
			CreatedAt:           msg.CreatedAt.UTC().Format("2006-01-02T15:04:05Z"),
			Reactions:           reactions,
			MyReactions:         msg.MyReactions,
			Attachments:         attachments,
			IsSaved:             msg.IsSaved,
			ContentMode:         msg.ContentMode,
			SenderDeviceID:      uuidStringOrEmpty(msg.SenderDeviceID),
			EncryptedDMPayloads: encodeEncryptedDMPayloads(msg.EncryptedDMPayloads),
		})
	}

	page := conversationMessagesPageResponse{
		Messages: resp,
		HasMore:  hasMore,
		PageSize: pageSize,
	}
	if hasMore && len(messages) > 0 {
		page.NextBeforeChannelSeq = strconv.FormatInt(messages[0].ChannelSeq, 10)
	}

	httputil.WriteJSON(w, http.StatusOK, page)
}

func (h *Handler) getMessageContext(w http.ResponseWriter, r *http.Request, principal auth.Principal) {
	if r.Method != http.MethodGet {
		httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
		return
	}

	conversationID, err := uuid.Parse(strings.TrimSpace(r.URL.Query().Get("conversation_id")))
	if err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid conversation_id"))
		return
	}
	messageID, err := uuid.Parse(strings.TrimSpace(r.URL.Query().Get("message_id")))
	if err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid message_id"))
		return
	}
	var requesterDeviceID uuid.UUID
	if rawDeviceID := strings.TrimSpace(r.URL.Query().Get("e2ee_device_id")); rawDeviceID != "" {
		requesterDeviceID, err = uuid.Parse(rawDeviceID)
		if err != nil {
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid e2ee_device_id"))
			return
		}
	}

	// Match the default 50-message conversation page closely enough that an
	// anchored open can merge surrounding context without overfetching.
	messages, err := h.svc.ListMessageContext(r.Context(), principal.UserID, conversationID, messageID, 20, 20, requesterDeviceID)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotMember):
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("not a member of this channel"))
		case errors.Is(err, ErrMessageNotFound):
			httputil.WriteJSON(w, http.StatusNotFound, httputil.ErrorBody("message not found"))
		default:
			h.log.Error("getMessageContext error", zap.Error(err))
			httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		}
		return
	}

	resp := make([]conversationMessageResponse, 0, len(messages))
	for _, msg := range messages {
		threadRootID := ""
		if msg.ThreadRootMessageID != uuid.Nil {
			threadRootID = msg.ThreadRootMessageID.String()
		}
		reactions := make([]reactionAggregateResponse, 0, len(msg.Reactions))
		for _, reaction := range msg.Reactions {
			reactions = append(reactions, reactionAggregateResponse{
				Emoji: reaction.Emoji,
				Count: reaction.Count,
			})
		}
		attachments := make([]messageAttachmentResponse, 0, len(msg.Attachments))
		for _, attachment := range msg.Attachments {
			attachments = append(attachments, messageAttachmentResponse{
				ID:                attachment.ID.String(),
				FileName:          attachment.FileName,
				FileSize:          attachment.FileSize,
				MimeType:          attachment.MimeType,
				ThumbnailMimeType: attachment.ThumbnailMimeType,
				ThumbnailFileSize: attachment.ThumbnailFileSize,
				ThumbnailVersion:  attachment.ThumbnailVersion,
			})
		}
		editedAt := ""
		if msg.EditedAt != nil && !msg.EditedAt.IsZero() {
			editedAt = msg.EditedAt.UTC().Format("2006-01-02T15:04:05Z")
		}
		resp = append(resp, conversationMessageResponse{
			ID:                  msg.ID.String(),
			ConversationID:      msg.ConversationID.String(),
			SenderID:            msg.SenderID.String(),
			SenderName:          msg.SenderName,
			Body:                msg.Body,
			ForwardedFrom:       encodeForwardedMessage(msg.ForwardedFrom),
			Entities:            encodeMessageEntities(msg.Entities),
			ChannelSeq:          msg.ChannelSeq,
			ThreadSeq:           msg.ThreadSeq,
			ThreadRootMessageID: threadRootID,
			ThreadReplyCount:    msg.ThreadReplyCount,
			EditedAt:            editedAt,
			MentionEveryone:     msg.MentionEveryone,
			CreatedAt:           msg.CreatedAt.UTC().Format("2006-01-02T15:04:05Z"),
			Reactions:           reactions,
			MyReactions:         msg.MyReactions,
			Attachments:         attachments,
			IsSaved:             msg.IsSaved,
			ContentMode:         msg.ContentMode,
			SenderDeviceID:      uuidStringOrEmpty(msg.SenderDeviceID),
			EncryptedDMPayloads: encodeEncryptedDMPayloads(msg.EncryptedDMPayloads),
		})
	}

	httputil.WriteJSON(w, http.StatusOK, conversationMessagesPageResponse{
		Messages: resp,
		HasMore:  false,
		PageSize: len(resp),
	})
}

func (h *Handler) listUnreadFeed(w http.ResponseWriter, r *http.Request, principal auth.Principal) {
	if r.Method != http.MethodGet {
		httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
		return
	}

	items, err := h.svc.ListUnreadFeed(r.Context(), principal.UserID)
	if err != nil {
		h.log.Error("listUnreadFeed error", zap.Error(err))
		httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		return
	}

	resp := unreadFeedResponse{
		TotalCount: len(items),
		Items:      make([]unreadFeedItemResponse, 0, len(items)),
	}
	for _, item := range items {
		payload := unreadFeedItemResponse{
			ID:                     item.ID,
			Kind:                   item.Kind,
			ConversationID:         item.ConversationID.String(),
			ConversationKind:       item.ConversationKind,
			ConversationVisibility: item.ConversationVisibility,
			ConversationTitle:      item.ConversationTitle,
			SenderName:             item.SenderName,
			Body:                   item.Body,
			CreatedAt:              item.CreatedAt.UTC().Format("2006-01-02T15:04:05Z"),
		}
		if item.NotificationID != uuid.Nil {
			payload.NotificationID = item.NotificationID.String()
		}
		if item.MessageID != uuid.Nil {
			payload.MessageID = item.MessageID.String()
		}
		if item.ThreadRootMessageID != uuid.Nil {
			payload.ThreadRootMessageID = item.ThreadRootMessageID.String()
		}
		if item.SenderID != uuid.Nil {
			payload.SenderID = item.SenderID.String()
		}
		resp.Items = append(resp.Items, payload)
	}

	httputil.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) listSavedMessages(w http.ResponseWriter, r *http.Request, principal auth.Principal) {
	if r.Method != http.MethodGet {
		httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
		return
	}

	items, err := h.svc.ListSavedMessages(r.Context(), principal.UserID)
	if err != nil {
		h.log.Error("listSavedMessages error", zap.Error(err))
		httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		return
	}

	resp := savedMessagesResponse{
		TotalCount: len(items),
		Items:      make([]savedMessageItemResponse, 0, len(items)),
	}
	for _, item := range items {
		payload := savedMessageItemResponse{
			ID:                     item.ID,
			ConversationID:         item.ConversationID.String(),
			ConversationKind:       item.ConversationKind,
			ConversationVisibility: item.ConversationVisibility,
			ConversationTitle:      item.ConversationTitle,
			MessageID:              item.MessageID.String(),
			SenderID:               item.SenderID.String(),
			SenderName:             item.SenderName,
			Body:                   item.Body,
			ForwardedFrom:          encodeForwardedMessage(item.ForwardedFrom),
			Entities:               encodeMessageEntities(item.Entities),
			CreatedAt:              item.CreatedAt.UTC().Format("2006-01-02T15:04:05Z"),
			SavedAt:                item.SavedAt.UTC().Format("2006-01-02T15:04:05Z"),
		}
		if item.ThreadRootMessageID != uuid.Nil {
			payload.ThreadRootMessageID = item.ThreadRootMessageID.String()
		}
		resp.Items = append(resp.Items, payload)
	}

	httputil.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) listForwardTargets(w http.ResponseWriter, r *http.Request, principal auth.Principal) {
	if r.Method != http.MethodGet {
		httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
		return
	}

	targets, err := h.svc.ListForwardTargets(r.Context(), principal.UserID)
	if err != nil {
		h.log.Error("listForwardTargets error", zap.Error(err))
		httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		return
	}

	resp := forwardTargetsResponse{
		Conversations: make([]forwardTargetConversationResponse, 0, len(targets.Conversations)),
		Threads:       make([]forwardTargetThreadResponse, 0, len(targets.Threads)),
	}
	for _, item := range targets.Conversations {
		resp.Conversations = append(resp.Conversations, forwardTargetConversationResponse{
			ConversationID: item.ConversationID.String(),
			Title:          item.Title,
			Kind:           item.Kind,
			Visibility:     item.Visibility,
		})
	}
	for _, item := range targets.Threads {
		resp.Threads = append(resp.Threads, forwardTargetThreadResponse{
			ConversationID:      item.ConversationID.String(),
			ConversationTitle:   item.ConversationTitle,
			ThreadRootMessageID: item.ThreadRootMessageID.String(),
			RootSenderName:      item.RootSenderName,
			RootBody:            item.RootBody,
			ReplyCount:          item.ReplyCount,
			LastReplyAt:         item.LastReplyAt.UTC().Format("2006-01-02T15:04:05Z"),
		})
	}
	httputil.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) resolveUnreadFeedItem(w http.ResponseWriter, r *http.Request, principal auth.Principal) {
	if r.Method != http.MethodPost {
		httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
		return
	}

	var req resolveUnreadFeedItemRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid json"))
		return
	}

	notificationID, err := uuid.Parse(strings.TrimSpace(req.NotificationID))
	if err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid notification_id"))
		return
	}

	result, err := h.svc.ResolveNotification(r.Context(), ResolveNotificationParams{
		NotificationID: notificationID,
		UserID:         principal.UserID,
	})
	if err != nil {
		h.log.Error("resolveUnreadFeedItem error", zap.Error(err))
		httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		return
	}
	if len(result.DirectDeliveries) > 0 && h.notifier != nil {
		h.notifier.SendChatDirectServerEvents(result.DirectDeliveries)
	}
	httputil.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *Handler) listMessageReactionUsers(w http.ResponseWriter, r *http.Request, principal auth.Principal) {
	if r.Method != http.MethodGet {
		httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
		return
	}

	conversationID, err := uuid.Parse(strings.TrimSpace(r.URL.Query().Get("conversation_id")))
	if err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid conversation_id"))
		return
	}
	messageID, err := uuid.Parse(strings.TrimSpace(r.URL.Query().Get("message_id")))
	if err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid message_id"))
		return
	}
	emoji := strings.TrimSpace(r.URL.Query().Get("emoji"))
	if emoji == "" {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("emoji is required"))
		return
	}

	users, err := h.svc.ListReactionUsers(r.Context(), principal.UserID, conversationID, messageID, emoji)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotMember):
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("not a member of this channel"))
		case errors.Is(err, ErrMessageNotFound):
			httputil.WriteJSON(w, http.StatusNotFound, httputil.ErrorBody("message not found"))
		default:
			h.log.Error("listMessageReactionUsers error", zap.Error(err))
			httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		}
		return
	}

	resp := reactionUsersResponse{
		Users: make([]reactionUserResponse, 0, len(users)),
	}
	for _, user := range users {
		resp.Users = append(resp.Users, reactionUserResponse{
			UserID:      user.UserID.String(),
			DisplayName: user.DisplayName,
			AvatarURL:   user.AvatarURL,
		})
	}
	httputil.WriteJSON(w, http.StatusOK, resp)
}

// POST /api/chat/attachments
func (h *Handler) chatAttachments(w http.ResponseWriter, r *http.Request, principal auth.Principal) {
	if r.Method != http.MethodPost {
		httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
		return
	}

	maxAttachSizeMB := h.cfg.AttachmentMaxSizeMB
	if maxAttachSizeMB <= 0 {
		maxAttachSizeMB = 50
	}
	maxBytes := int64(maxAttachSizeMB) * 1024 * 1024
	formLimit := maxBytes + 2*1024*1024
	if err := r.ParseMultipartForm(formLimit); err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("failed to parse multipart form: "+err.Error()))
		return
	}

	conversationID, err := uuid.Parse(strings.TrimSpace(r.FormValue("conversation_id")))
	if err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid conversation_id"))
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("missing 'file' field in form"))
		return
	}
	defer file.Close()

	mimeType := header.Header.Get("Content-Type")
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	if header.Size < 0 {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("unable to determine file size"))
		return
	}
	if header.Size > maxBytes {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody(fmt.Sprintf("invalid attachment: file exceeds maximum allowed size of %d MB", maxAttachSizeMB)))
		return
	}
	cr := &countingReader{r: io.LimitReader(file, header.Size)}

	attachment, err := h.svc.UploadMessageAttachment(r.Context(), UploadMessageAttachmentParams{
		ConversationID: conversationID,
		ActorID:        principal.UserID,
		FileName:       header.Filename,
		MimeType:       mimeType,
		Size:           header.Size,
		Body:           cr,
	}, cr)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotMember):
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("not a member of this conversation"))
		case errors.Is(err, ErrInvalidAttachment):
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody(err.Error()))
		default:
			h.log.Error("chatAttachments upload error", zap.Error(err))
			httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		}
		return
	}

	httputil.WriteJSON(w, http.StatusCreated, messageAttachmentResponse{
		ID:                attachment.ID.String(),
		FileName:          attachment.FileName,
		FileSize:          attachment.FileSize,
		MimeType:          attachment.MimeType,
		ThumbnailMimeType: attachment.ThumbnailMimeType,
		ThumbnailFileSize: attachment.ThumbnailFileSize,
		ThumbnailVersion:  attachment.ThumbnailVersion,
	})
}

// DELETE /api/chat/attachments/:attachment_id
func (h *Handler) chatAttachmentItem(w http.ResponseWriter, r *http.Request, principal auth.Principal) {
	if r.Method != http.MethodDelete {
		httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
		return
	}

	rawID := strings.TrimPrefix(r.URL.Path, "/api/chat/attachments/")
	attachmentID, err := uuid.Parse(rawID)
	if err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid attachment_id"))
		return
	}

	if err := h.svc.DeleteStagedMessageAttachment(r.Context(), principal.UserID, attachmentID); err != nil {
		switch {
		case errors.Is(err, ErrAttachmentNotFound):
			httputil.WriteJSON(w, http.StatusNotFound, httputil.ErrorBody("attachment not found"))
		case errors.Is(err, ErrAttachmentOwnership):
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("attachment does not belong to user"))
		case errors.Is(err, ErrAttachmentNotStaged):
			httputil.WriteJSON(w, http.StatusConflict, httputil.ErrorBody("attachment already linked to a message"))
		default:
			h.log.Error("chatAttachmentItem delete error", zap.Error(err))
			httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		}
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) messageItem(w http.ResponseWriter, r *http.Request, principal auth.Principal) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/messages/")
	parts := strings.Split(rest, "/")
	if len(parts) == 1 {
		messageID, err := uuid.Parse(parts[0])
		if err != nil {
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid message_id"))
			return
		}
		switch r.Method {
		case http.MethodPatch:
			h.patchMessage(w, r, principal, messageID)
			return
		case http.MethodDelete:
			h.deleteMessage(w, r, principal, messageID)
			return
		default:
			httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
			return
		}
	}

	if len(parts) == 2 && parts[1] == "save" {
		messageID, err := uuid.Parse(parts[0])
		if err != nil {
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid message_id"))
			return
		}
		switch r.Method {
		case http.MethodPost:
			h.saveMessage(w, r, principal, messageID)
			return
		case http.MethodDelete:
			h.unsaveMessage(w, r, principal, messageID)
			return
		default:
			httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
			return
		}
	}

	if len(parts) == 2 && parts[1] == "forward" {
		messageID, err := uuid.Parse(parts[0])
		if err != nil {
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid message_id"))
			return
		}
		if r.Method != http.MethodPost {
			httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
			return
		}
		h.forwardMessage(w, r, principal, messageID)
		return
	}

	// GET /api/messages/:message_id/attachments/:attachment_id/download
	if len(parts) == 4 && parts[1] == "attachments" && parts[3] == "download" {
		if r.Method != http.MethodGet {
			httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
			return
		}
		messageID, err := uuid.Parse(parts[0])
		if err != nil {
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid message_id"))
			return
		}
		attachmentID, err := uuid.Parse(parts[2])
		if err != nil {
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid attachment_id"))
			return
		}
		h.downloadMessageAttachment(w, r, principal, messageID, attachmentID)
		return
	}

	// GET /api/messages/:message_id/attachments/:attachment_id/thumbnail/v1
	if len(parts) == 5 && parts[1] == "attachments" && parts[3] == "thumbnail" && parts[4] == "v1" {
		if r.Method != http.MethodGet {
			httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
			return
		}
		messageID, err := uuid.Parse(parts[0])
		if err != nil {
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid message_id"))
			return
		}
		attachmentID, err := uuid.Parse(parts[2])
		if err != nil {
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid attachment_id"))
			return
		}
		h.downloadMessageAttachmentThumbnail(w, r, principal, messageID, attachmentID)
		return
	}

	httputil.WriteJSON(w, http.StatusNotFound, httputil.ErrorBody("not found"))
}

func (h *Handler) saveMessage(w http.ResponseWriter, r *http.Request, principal auth.Principal, messageID uuid.UUID) {
	_, err := h.svc.SaveMessage(r.Context(), principal.UserID, messageID)
	if err != nil {
		switch {
		case errors.Is(err, ErrMessageNotFound):
			httputil.WriteJSON(w, http.StatusNotFound, httputil.ErrorBody("message not found"))
		case errors.Is(err, ErrNotMember):
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("not a member of this conversation"))
		default:
			h.log.Error("saveMessage error", zap.Error(err))
			httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		}
		return
	}
	httputil.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *Handler) unsaveMessage(w http.ResponseWriter, r *http.Request, principal auth.Principal, messageID uuid.UUID) {
	if err := h.svc.UnsaveMessage(r.Context(), principal.UserID, messageID); err != nil {
		h.log.Error("unsaveMessage error", zap.Error(err))
		httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) forwardMessage(w http.ResponseWriter, r *http.Request, principal auth.Principal, sourceMessageID uuid.UUID) {
	var req forwardMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid json"))
		return
	}
	destinationConversationID, err := uuid.Parse(strings.TrimSpace(req.DestinationConversationID))
	if err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid destination_conversation_id"))
		return
	}
	var destinationThreadRootMessageID uuid.UUID
	if strings.TrimSpace(req.DestinationThreadRootMessageID) != "" {
		destinationThreadRootMessageID, err = uuid.Parse(strings.TrimSpace(req.DestinationThreadRootMessageID))
		if err != nil {
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid destination_thread_root_message_id"))
			return
		}
	}

	result, err := h.svc.ForwardMessage(r.Context(), ForwardMessageParams{
		SourceMessageID:                sourceMessageID,
		ActorID:                        principal.UserID,
		DestinationConversationID:      destinationConversationID,
		DestinationThreadRootMessageID: destinationThreadRootMessageID,
	})
	if err != nil {
		switch {
		case errors.Is(err, ErrMessageNotFound):
			httputil.WriteJSON(w, http.StatusNotFound, httputil.ErrorBody("message not found"))
		case errors.Is(err, ErrNotMember):
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("not a member of this conversation"))
		case errors.Is(err, ErrInvalidThread):
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid destination thread"))
		case errors.Is(err, ErrEncryptedMessageUnsupported):
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("encrypted messages cannot be forwarded"))
		case errors.Is(err, ErrInvalidAttachment), errors.Is(err, ErrInvalidMessageEntity), errors.Is(err, ErrEmptyMessage):
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("message cannot be forwarded"))
		default:
			h.log.Error("forwardMessage error", zap.Error(err))
			httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		}
		return
	}
	if len(result.DirectDeliveries) > 0 && h.notifier != nil {
		h.notifier.SendChatDirectServerEvents(result.DirectDeliveries)
	}
	createdAt := ""
	if result.CreatedAt != nil {
		createdAt = result.CreatedAt.AsTime().UTC().Format("2006-01-02T15:04:05Z")
	}
	httputil.WriteJSON(w, http.StatusCreated, forwardMessageResponseBody{
		MessageID:  result.MessageID.String(),
		ChannelSeq: result.ChannelSeq,
		CreatedAt:  createdAt,
	})
}

func (h *Handler) patchMessage(w http.ResponseWriter, r *http.Request, principal auth.Principal, messageID uuid.UUID) {
	var req editMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid json"))
		return
	}
	entities, err := decodeMessageEntities(req.Entities)
	if err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid entities"))
		return
	}
	result, err := h.svc.EditMessage(r.Context(), EditMessageParams{
		MessageID: messageID,
		ActorID:   principal.UserID,
		Body:      req.Body,
		Entities:  entities,
	})
	if err != nil {
		switch {
		case errors.Is(err, ErrMessageNotFound):
			httputil.WriteJSON(w, http.StatusNotFound, httputil.ErrorBody("message not found"))
		case errors.Is(err, ErrNotMember):
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("not a member of this conversation"))
		case errors.Is(err, ErrMessageNotAuthor):
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("only author can edit this message"))
		case errors.Is(err, ErrEmptyMessage):
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("message body and attachments are both empty"))
		case errors.Is(err, ErrEncryptedMessageUnsupported):
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("encrypted messages cannot be edited yet"))
		case errors.Is(err, ErrInvalidMessageEntity):
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid entities"))
		default:
			h.log.Error("patchMessage error", zap.Error(err))
			httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		}
		return
	}
	if len(result.DirectDeliveries) > 0 && h.notifier != nil {
		h.notifier.SendChatDirectServerEvents(result.DirectDeliveries)
	}
	editedAt := ""
	if result.EditedAt != nil {
		editedAt = result.EditedAt.AsTime().UTC().Format("2006-01-02T15:04:05Z")
	}
	httputil.WriteJSON(w, http.StatusOK, editMessageResponse{
		MessageID: messageID.String(),
		EditedAt:  editedAt,
		Entities:  encodeMessageEntities(result.Entities),
	})
}

func (h *Handler) deleteMessage(w http.ResponseWriter, r *http.Request, principal auth.Principal, messageID uuid.UUID) {
	result, err := h.svc.DeleteMessage(r.Context(), DeleteMessageParams{
		MessageID: messageID,
		ActorID:   principal.UserID,
	})
	if err != nil {
		switch {
		case errors.Is(err, ErrSecretMessagePurgeIncomplete):
			httputil.WriteJSON(w, http.StatusServiceUnavailable, httputil.ErrorBody(err.Error()))
		case errors.Is(err, ErrMessageNotFound):
			httputil.WriteJSON(w, http.StatusNotFound, httputil.ErrorBody("message not found"))
		case errors.Is(err, ErrNotMember):
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("not a member of this conversation"))
		case errors.Is(err, ErrMessageNotAuthor):
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("only author can delete this message"))
		default:
			h.log.Error("deleteMessage error", zap.Error(err))
			httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		}
		return
	}
	if len(result.DirectDeliveries) > 0 && h.notifier != nil {
		h.notifier.SendChatDirectServerEvents(result.DirectDeliveries)
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) downloadMessageAttachment(
	w http.ResponseWriter,
	r *http.Request,
	principal auth.Principal,
	messageID uuid.UUID,
	attachmentID uuid.UUID,
) {
	body, size, mimeType, fileName, err := h.svc.DownloadMessageAttachment(r.Context(), principal.UserID, messageID, attachmentID)
	if err != nil {
		switch {
		case errors.Is(err, ErrAttachmentNotFound):
			httputil.WriteJSON(w, http.StatusNotFound, httputil.ErrorBody("attachment not found"))
		case errors.Is(err, ErrNotMember):
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("not a member of this conversation"))
		default:
			h.log.Error("downloadMessageAttachment error", zap.Error(err))
			httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		}
		return
	}
	defer body.Close()

	w.Header().Set("Content-Type", mimeType)
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	w.Header().Set("Content-Disposition", `attachment; filename="`+sanitiseHeaderValue(fileName)+`"`)
	w.WriteHeader(http.StatusOK)
	io.Copy(w, body) //nolint:errcheck
}

func (h *Handler) downloadMessageAttachmentThumbnail(
	w http.ResponseWriter,
	r *http.Request,
	principal auth.Principal,
	messageID, attachmentID uuid.UUID,
) {
	body, size, mimeType, version, err := h.svc.DownloadMessageAttachmentThumbnail(r.Context(), principal.UserID, messageID, attachmentID)
	if err != nil {
		switch {
		case errors.Is(err, ErrAttachmentNotFound):
			httputil.WriteJSON(w, http.StatusNotFound, httputil.ErrorBody("thumbnail not found"))
		case errors.Is(err, ErrNotMember):
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("not a member of this conversation"))
		default:
			h.log.Error("downloadMessageAttachmentThumbnail error", zap.Error(err))
			httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		}
		return
	}
	defer body.Close()

	etag := fmt.Sprintf(`"chat-thumbnail-v%d-%s-%d"`, version, attachmentID.String(), size)
	w.Header().Set("Content-Type", mimeType)
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	w.Header().Set("Cache-Control", "private, max-age=2592000, immutable")
	// Preserve a CORS middleware's Vary: Origin entry when this endpoint is
	// served cross-origin; HTTP caches must vary by both values.
	w.Header().Add("Vary", "Authorization")
	w.Header().Set("ETag", etag)
	if matchesETag(r.Header.Get("If-None-Match"), etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.WriteHeader(http.StatusOK)
	io.Copy(w, body) //nolint:errcheck
}

func matchesETag(requestValue, etag string) bool {
	for _, candidate := range strings.Split(requestValue, ",") {
		candidate = strings.TrimSpace(candidate)
		if candidate == "*" || candidate == etag {
			return true
		}
	}
	return false
}

func (h *Handler) listDMCandidates(w http.ResponseWriter, r *http.Request, principal auth.Principal) {
	if r.Method != http.MethodGet {
		httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
		return
	}

	candidates, err := h.svc.ListDMCandidates(r.Context(), principal.UserID)
	if err != nil {
		h.log.Error("listDMCandidates query error", zap.Error(err))
		httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		return
	}

	resp := make([]dmCandidateResponse, 0, len(candidates))
	for _, candidate := range candidates {
		resp = append(resp, dmCandidateResponse{
			UserID:       candidate.UserID.String(),
			DisplayName:  candidate.DisplayName,
			Email:        candidate.Email,
			AvatarURL:    candidate.AvatarURL,
			CustomStatus: userstatus.ToBody(candidate.CustomStatus),
		})
	}

	httputil.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) createOrOpenDirectMessage(w http.ResponseWriter, r *http.Request, principal auth.Principal) {
	if r.Method != http.MethodPost {
		httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
		return
	}

	var req createDirectMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid json"))
		return
	}

	targetUserID, err := uuid.Parse(req.UserID)
	if err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid user_id"))
		return
	}

	result, err := h.svc.CreateOrOpenDirectMessage(r.Context(), principal.UserID, targetUserID)
	if err != nil {
		switch {
		case errors.Is(err, ErrInvalidDMTarget):
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid dm target"))
		case errors.Is(err, ErrBlockedDMTarget):
			httputil.WriteJSON(w, http.StatusNotFound, httputil.ErrorBody("user not available"))
		default:
			h.log.Error("createOrOpenDirectMessage error", zap.Error(err))
			httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		}
		return
	}

	// Push conversation_upserted to affected participants when a DM was
	// created or restored.
	if len(result.DirectDeliveries) > 0 && h.notifier != nil {
		h.notifier.SendChatDirectServerEvents(result.DirectDeliveries)
	}

	dm := result.DM
	httputil.WriteJSON(w, http.StatusOK, directMessageResponse{
		ConversationID: dm.ConversationID.String(),
		UserID:         dm.UserID.String(),
		DisplayName:    dm.DisplayName,
		Email:          dm.Email,
		AvatarURL:      dm.AvatarURL,
		CustomStatus:   userstatus.ToBody(dm.CustomStatus),
		Kind:           dm.Kind,
		Visibility:     dm.Visibility,
		EncryptionMode: dm.EncryptionMode,
	})
}

func (h *Handler) createOrOpenEncryptedDirectMessage(w http.ResponseWriter, r *http.Request, principal auth.Principal) {
	if r.Method != http.MethodPost {
		httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
		return
	}

	var req createEncryptedDirectMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid json"))
		return
	}

	conversationID, err := uuid.Parse(req.ConversationID)
	if err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid conversation_id"))
		return
	}

	result, err := h.svc.CreateOrOpenEncryptedDirectMessage(r.Context(), principal.UserID, conversationID)
	if err != nil {
		switch {
		case errors.Is(err, ErrInvalidDMTarget):
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid dm target"))
		case errors.Is(err, ErrBlockedDMTarget):
			httputil.WriteJSON(w, http.StatusNotFound, httputil.ErrorBody("user not available"))
		case errors.Is(err, ErrNotMember):
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("not a dm member"))
		default:
			h.log.Error("createOrOpenEncryptedDirectMessage error", zap.Error(err))
			httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		}
		return
	}

	if len(result.DirectDeliveries) > 0 && h.notifier != nil {
		h.notifier.SendChatDirectServerEvents(result.DirectDeliveries)
	}

	dm := result.DM
	httputil.WriteJSON(w, http.StatusOK, directMessageResponse{
		ConversationID: dm.ConversationID.String(),
		UserID:         dm.UserID.String(),
		DisplayName:    dm.DisplayName,
		Email:          dm.Email,
		AvatarURL:      dm.AvatarURL,
		CustomStatus:   userstatus.ToBody(dm.CustomStatus),
		Kind:           dm.Kind,
		Visibility:     dm.Visibility,
		EncryptionMode: dm.EncryptionMode,
	})
}

func (h *Handler) e2eeDevices(w http.ResponseWriter, r *http.Request, principal auth.Principal) {
	if r.Method != http.MethodPost {
		httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
		return
	}

	var req registerE2EEDeviceRequest
	if err := decodeE2EEDeviceRequest(w, r, &req); err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid json"))
		return
	}
	params, err := parseE2EEDeviceRegistrationRequest(req, false)
	if err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody(err.Error()))
		return
	}
	params.UserID = principal.UserID
	device, err := h.svc.RegisterDevice(r.Context(), params)
	if err != nil {
		if errors.Is(err, ErrInvalidDMTarget) {
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid e2ee device"))
			return
		}
		h.log.Error("register e2ee device error", zap.Error(err))
		httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		return
	}
	httputil.WriteJSON(w, http.StatusOK, mapE2EEDeviceResponse(device))
}

func (h *Handler) activateE2EERecoveryDevice(w http.ResponseWriter, r *http.Request, principal auth.Principal) {
	if r.Method != http.MethodPost {
		httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
		return
	}

	var req activateE2EERecoveryDeviceRequest
	if err := decodeE2EEDeviceRequest(w, r, &req); err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid json"))
		return
	}
	params, err := parseE2EEDeviceRegistrationRequest(req.registerE2EEDeviceRequest, true)
	if err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid recovery device"))
		return
	}
	var replaceDeviceID uuid.UUID
	if strings.TrimSpace(req.ReplaceDeviceID) != "" {
		parsed, err := uuid.Parse(req.ReplaceDeviceID)
		if err != nil {
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid replace_device_id"))
			return
		}
		replaceDeviceID = parsed
	}
	params.UserID = principal.UserID
	device, err := h.svc.ActivateRecoveredDevice(r.Context(), ActivateRecoveredDeviceParams{
		RegisterDeviceParams: params,
		ReplaceDeviceID:      replaceDeviceID,
	})
	if err != nil {
		switch {
		case errors.Is(err, ErrInvalidDMTarget), errors.Is(err, ErrE2EERecoveryDeviceOwnership):
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid recovery device"))
		default:
			h.log.Error("activate e2ee recovery device error", zap.Error(err))
			httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		}
		return
	}
	httputil.WriteJSON(w, http.StatusOK, mapE2EEDeviceResponse(device))
}

func decodeE2EEDeviceRequest(w http.ResponseWriter, r *http.Request, target any) error {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxE2EEDeviceRequestBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return errors.New("invalid json")
	}
	return nil
}

func parseE2EEDeviceRegistrationRequest(req registerE2EEDeviceRequest, requireDeviceID bool) (RegisterDeviceParams, error) {
	var deviceID uuid.UUID
	if strings.TrimSpace(req.DeviceID) != "" {
		parsed, err := uuid.Parse(req.DeviceID)
		if err != nil {
			return RegisterDeviceParams{}, errors.New("invalid device_id")
		}
		deviceID = parsed
	}
	if requireDeviceID && deviceID == uuid.Nil {
		return RegisterDeviceParams{}, errors.New("invalid device_id")
	}
	identityKeyPublic, err := base64.StdEncoding.DecodeString(req.IdentityKeyPublic)
	if err != nil || len(identityKeyPublic) == 0 {
		return RegisterDeviceParams{}, errors.New("invalid identity_key_public")
	}
	signedPrekeyPublic, err := base64.StdEncoding.DecodeString(req.SignedPrekeyPublic)
	if err != nil || len(signedPrekeyPublic) == 0 {
		return RegisterDeviceParams{}, errors.New("invalid signed_prekey_public")
	}
	signedPrekeySignature, err := base64.StdEncoding.DecodeString(req.SignedPrekeySignature)
	if err != nil || len(signedPrekeySignature) == 0 {
		return RegisterDeviceParams{}, errors.New("invalid signed_prekey_signature")
	}
	return RegisterDeviceParams{
		DeviceID:              deviceID,
		DeviceLabel:           req.DeviceLabel,
		IdentityKeyPublic:     identityKeyPublic,
		SignedPrekeyID:        req.SignedPrekeyID,
		SignedPrekeyPublic:    signedPrekeyPublic,
		SignedPrekeySignature: signedPrekeySignature,
	}, nil
}

func (h *Handler) listEncryptedDMDevices(w http.ResponseWriter, r *http.Request, principal auth.Principal) {
	if r.Method != http.MethodGet {
		httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
		return
	}
	conversationID, err := uuid.Parse(r.URL.Query().Get("conversation_id"))
	if err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid conversation_id"))
		return
	}
	devices, err := h.svc.ListEncryptedDMDevices(r.Context(), principal.UserID, conversationID)
	if err != nil {
		h.log.Error("list encrypted dm devices error", zap.Error(err))
		httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		return
	}
	resp := make([]e2eeDeviceResponse, 0, len(devices))
	for _, device := range devices {
		resp = append(resp, mapE2EEDeviceResponse(device))
	}
	httputil.WriteJSON(w, http.StatusOK, resp)
}

func mapE2EEDeviceResponse(device UserDeviceBundle) e2eeDeviceResponse {
	return e2eeDeviceResponse{
		DeviceID:              device.DeviceID.String(),
		UserID:                device.UserID.String(),
		DeviceLabel:           device.DeviceLabel,
		IdentityKeyPublic:     base64.StdEncoding.EncodeToString(device.IdentityKeyPublic),
		SignedPrekeyID:        device.SignedPrekeyID,
		SignedPrekeyPublic:    base64.StdEncoding.EncodeToString(device.SignedPrekeyPublic),
		SignedPrekeySignature: base64.StdEncoding.EncodeToString(device.SignedPrekeySignature),
	}
}

func encodeEncryptedDMPayloads(items []EncryptedDMRecipientPayload) []encryptedDMPayloadBody {
	if len(items) == 0 {
		return nil
	}
	out := make([]encryptedDMPayloadBody, 0, len(items))
	for _, item := range items {
		out = append(out, encryptedDMPayloadBody{
			RecipientDeviceID: item.RecipientDeviceID.String(),
			SenderDeviceID:    item.SenderDeviceID.String(),
			Algorithm:         item.Algorithm,
			SessionMessage:    base64.StdEncoding.EncodeToString(item.SessionMessage),
			MetadataAAD:       base64.StdEncoding.EncodeToString(item.MetadataAAD),
		})
	}
	return out
}

func (h *Handler) inviteToConversation(w http.ResponseWriter, r *http.Request, principal auth.Principal) {
	if r.Method != http.MethodPost {
		httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
		return
	}

	var req inviteConversationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid json"))
		return
	}

	conversationID, err := uuid.Parse(req.ConversationID)
	if err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid conversation_id"))
		return
	}
	targetUserID, err := uuid.Parse(req.UserID)
	if err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid user_id"))
		return
	}

	result, err := h.svc.InviteToChannel(r.Context(), principal.UserID, conversationID, targetUserID)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotMember):
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("not a member of this conversation"))
		case errors.Is(err, ErrInviteUnsupportedTarget):
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("cannot invite users to this conversation"))
		case errors.Is(err, ErrConversationArchived):
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("cannot invite users to archived conversations"))
		case errors.Is(err, ErrNotPublicChannel):
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("conversation not found"))
		default:
			h.log.Error("inviteToConversation error", zap.Error(err))
			httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		}
		return
	}

	// Push conversation_upserted to the invited user so their sidebar
	// updates in real time without waiting for a re-bootstrap.
	if len(result.DirectDeliveries) > 0 && h.notifier != nil {
		h.notifier.SendChatDirectServerEvents(result.DirectDeliveries)
	}

	httputil.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// requireAuth is a thin middleware that validates the Bearer JWT and injects
// the Principal into the handler.
func (h *Handler) requireAuth(next func(w http.ResponseWriter, r *http.Request, p auth.Principal)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := httputil.BearerToken(r)
		if token == "" {
			httputil.WriteJSON(w, http.StatusUnauthorized, httputil.ErrorBody("missing authorization"))
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

// countingReader tracks bytes consumed while streaming multipart file contents.
type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}

func (c *countingReader) BytesRead() int64 { return c.n }

// sanitiseHeaderValue removes characters that are illegal in HTTP header values.
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
