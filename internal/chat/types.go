package chat

import (
	"context"
	"io"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"google.golang.org/protobuf/types/known/timestamppb"

	packetspb "msgnr/internal/gen/proto"
	"msgnr/internal/userstatus"
)

// AttachmentStorage is the subset of object storage required for chat attachments.
type AttachmentStorage interface {
	PutObject(ctx context.Context, key string, r io.Reader, size int64, mimeType string) error
	GetObject(ctx context.Context, key string) (body io.ReadCloser, size int64, mimeType string, err error)
	DeleteObject(ctx context.Context, key string) error
}

type queryer interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

type DMCandidate struct {
	UserID       uuid.UUID
	DisplayName  string
	Email        string
	AvatarURL    string
	CustomStatus *userstatus.Status
	Presence     string
}

type ConversationMember struct {
	UserID       uuid.UUID
	DisplayName  string
	Email        string
	AvatarURL    string
	CustomStatus *userstatus.Status
}

type ReactionUser struct {
	UserID      uuid.UUID
	DisplayName string
	AvatarURL   string
}

type DirectMessage struct {
	ConversationID uuid.UUID
	UserID         uuid.UUID
	DisplayName    string
	Email          string
	AvatarURL      string
	CustomStatus   *userstatus.Status
	Kind           string
	Visibility     string
	EncryptionMode string
}

// CreateDMResult is returned by CreateOrOpenDirectMessage.
// DirectDeliveries is non-empty when a new DM is created or an archived DM is
// restored, and contains one conversation_upserted event per participant so
// both users' sidebars are updated immediately.
type CreateDMResult struct {
	DM               DirectMessage
	DirectDeliveries []DirectDelivery
}

type LeaveConversationResult struct {
	DirectDeliveries []DirectDelivery
}

type RemoveConversationMemberResult struct {
	DirectDeliveries []DirectDelivery
}

type JoinableChannel struct {
	ID             uuid.UUID
	Name           string
	Kind           string
	Visibility     string
	LastActivityAt time.Time
}

type ConversationMessage struct {
	ID                  uuid.UUID
	ConversationID      uuid.UUID
	SenderID            uuid.UUID
	SenderName          string
	Body                string
	ForwardedFrom       *ForwardedMessageInfo
	Entities            []MessageEntity
	ChannelSeq          int64
	ThreadSeq           int64
	ThreadRootMessageID uuid.UUID
	ThreadReplyCount    int32
	EditedAt            *time.Time
	CreatedAt           time.Time
	MentionEveryone     bool
	Reactions           []ReactionAggregate
	MyReactions         []string
	Attachments         []MessageAttachment
	IsSaved             bool
	ContentMode         string
	SenderDeviceID      uuid.UUID
	EncryptedDMPayloads []EncryptedDMRecipientPayload
}

type EncryptedDMRecipientPayload struct {
	RecipientDeviceID uuid.UUID
	SenderDeviceID    uuid.UUID
	Algorithm         string
	SessionMessage    []byte
	MetadataAAD       []byte
}

type ForwardedMessageInfo struct {
	MessageID         uuid.UUID
	SenderID          uuid.UUID
	SenderName        string
	ConversationKind  string
	ConversationTitle string
	ThreadTitle       string
}

type ForwardMessageParams struct {
	SourceMessageID                uuid.UUID
	ActorID                        uuid.UUID
	DestinationConversationID      uuid.UUID
	DestinationThreadRootMessageID uuid.UUID
}

type ForwardMessageResult struct {
	MessageID        uuid.UUID
	ChannelSeq       int64
	CreatedAt        *timestamppb.Timestamp
	DirectDeliveries []DirectDelivery
}

type ForwardTargetConversation struct {
	ConversationID uuid.UUID
	Title          string
	Kind           string
	Visibility     string
}

type ForwardTargetThread struct {
	ConversationID      uuid.UUID
	ConversationTitle   string
	ThreadRootMessageID uuid.UUID
	RootSenderName      string
	RootBody            string
	ReplyCount          int32
	LastReplyAt         time.Time
}

type ForwardTargets struct {
	Conversations []ForwardTargetConversation
	Threads       []ForwardTargetThread
}

type UnreadFeedItem struct {
	ID                     string
	Kind                   string
	NotificationID         uuid.UUID
	ConversationID         uuid.UUID
	ConversationKind       string
	ConversationVisibility string
	ConversationTitle      string
	MessageID              uuid.UUID
	ThreadRootMessageID    uuid.UUID
	SenderID               uuid.UUID
	SenderName             string
	Body                   string
	CreatedAt              time.Time
}

type SavedMessageItem struct {
	ID                     string
	ConversationID         uuid.UUID
	ConversationKind       string
	ConversationVisibility string
	ConversationTitle      string
	MessageID              uuid.UUID
	ThreadRootMessageID    uuid.UUID
	SenderID               uuid.UUID
	SenderName             string
	Body                   string
	ForwardedFrom          *ForwardedMessageInfo
	Entities               []MessageEntity
	CreatedAt              time.Time
	SavedAt                time.Time
}

type ReactionAggregate struct {
	Emoji string `json:"emoji"`
	Count int32  `json:"count"`
}

type messageReactionCountRow struct {
	MessageID uuid.UUID
	Emoji     string
	Count     int32
}

type messageUserReactionRow struct {
	MessageID uuid.UUID
	Emoji     string
}

type MessageAttachment struct {
	ID                  uuid.UUID `json:"id"`
	ConversationID      uuid.UUID `json:"conversation_id"`
	MessageID           uuid.UUID `json:"message_id"`
	FileName            string    `json:"file_name"`
	FileSize            int64     `json:"file_size"`
	MimeType            string    `json:"mime_type"`
	StorageKey          string    `json:"-"`
	ThumbnailStorageKey string    `json:"-"`
	ThumbnailMimeType   string    `json:"thumbnail_mime_type,omitempty"`
	ThumbnailFileSize   int64     `json:"thumbnail_file_size,omitempty"`
	ThumbnailVersion    int16     `json:"thumbnail_version,omitempty"`
	UploadedBy          uuid.UUID `json:"uploaded_by"`
	CreatedAt           time.Time `json:"created_at"`
}

type MessageEntityKind string

const (
	MessageEntityKindUser     MessageEntityKind = "user"
	MessageEntityKindTask     MessageEntityKind = "task"
	MessageEntityKindDocument MessageEntityKind = "document"
)

type MessageEntity struct {
	Kind     MessageEntityKind `json:"kind"`
	TargetID uuid.UUID         `json:"target_id"`
	Label    string            `json:"label"`
	Href     string            `json:"href"`
	Start    int32             `json:"start"`
	End      int32             `json:"end"`
}

type TagSearchUserResult struct {
	UserID       uuid.UUID
	DisplayName  string
	Email        string
	AvatarURL    string
	CustomStatus *userstatus.Status
	Presence     string
}

type TagSearchTaskResult struct {
	TaskID    uuid.UUID
	PublicID  string
	Title     string
	UpdatedAt time.Time
}

func (r TagSearchTaskResult) Label() string {
	return "@" + strings.TrimSpace(r.PublicID+" "+r.Title)
}

func (r TagSearchTaskResult) Href() string {
	return normalizeTaskHref(r.PublicID)
}

type TagSearchDocumentResult struct {
	DocumentID uuid.UUID
	Title      string
	UpdatedAt  time.Time
}

func (r TagSearchDocumentResult) Label() string {
	return "@" + strings.TrimSpace(r.Title)
}

func (r TagSearchDocumentResult) Href() string {
	return normalizeDocumentHref(r.DocumentID)
}

type TagSearchResult struct {
	Users     []TagSearchUserResult
	Tasks     []TagSearchTaskResult
	Documents []TagSearchDocumentResult
}

// SendMessageParams holds the input for SendMessage.
type SendMessageParams struct {
	ChannelID           uuid.UUID
	SenderID            uuid.UUID
	ClientMsgID         string
	Body                string
	Entities            []MessageEntity
	ThreadRootMessageID uuid.UUID // zero value = not a thread reply
	AttachmentIDs       []uuid.UUID
	ForwardedFrom       *ForwardedMessageInfo
	SuppressMentions    bool
	AttachmentCopies    []MessageAttachment
	ContentMode         string
	SenderDeviceID      uuid.UUID
	EncryptedDMPayloads []EncryptedDMRecipientPayload
}

// SendMessageResult is the output of SendMessage.
type SendMessageResult struct {
	MessageID        uuid.UUID
	ChannelSeq       int64
	CreatedAt        *timestamppb.Timestamp
	ClientMsgID      string
	Deduped          bool
	DirectDeliveries []DirectDelivery
}

type UpdateReadCursorParams struct {
	ChannelID   uuid.UUID
	UserID      uuid.UUID
	LastReadSeq int64
}

type UpdateReadCursorResult struct {
	ChannelID        uuid.UUID
	LastReadSeq      int64
	Counter          *packetspb.UnreadCounter
	DirectDeliveries []DirectDelivery
}

type EditMessageParams struct {
	MessageID uuid.UUID
	ActorID   uuid.UUID
	Body      string
	Entities  []MessageEntity
}

type EditMessageResult struct {
	ChannelID        uuid.UUID
	MessageID        uuid.UUID
	Body             string
	Entities         []MessageEntity
	MentionEveryone  bool
	MentionedUserIDs []uuid.UUID
	EditedAt         *timestamppb.Timestamp
	DirectDeliveries []DirectDelivery
}

type DeleteMessageParams struct {
	MessageID uuid.UUID
	ActorID   uuid.UUID
}

type DeleteMessageResult struct {
	ChannelID        uuid.UUID
	MessageID        uuid.UUID
	ThreadRootID     uuid.UUID
	DirectDeliveries []DirectDelivery
}

type ClearDMConversationHistoryParams struct {
	ConversationID uuid.UUID
	ActorID        uuid.UUID
}

type ClearDMConversationHistoryResult struct {
	ConversationID       uuid.UUID
	DeletedMessagesCount int32
}

type DirectDelivery struct {
	UserID string
	Event  *packetspb.ServerEvent
}

type messageAlertRecipient struct {
	UserID            uuid.UUID
	NotificationLevel int16
}

type UploadMessageAttachmentParams struct {
	ConversationID uuid.UUID
	ActorID        uuid.UUID
	FileName       string
	MimeType       string
	Size           int64
	Body           io.Reader
}

// ReactionParams holds common reaction input fields.
type ReactionParams struct {
	ChannelID  uuid.UUID
	MessageID  uuid.UUID
	UserID     uuid.UUID
	Emoji      string
	ClientOpID string
}

// ReactionResult is the output of AddReaction / RemoveReaction.
type ReactionResult struct {
	OK         bool
	MessageID  uuid.UUID
	Emoji      string
	ClientOpID string
	Applied    bool
}

// SubscribeThreadParams holds input for SubscribeThread.
type SubscribeThreadParams struct {
	ChannelID           uuid.UUID
	ThreadRootMessageID uuid.UUID
	RequesterID         uuid.UUID
	LastThreadSeq       int64
}

// SubscribeThreadResult holds the response for SubscribeThread.
type SubscribeThreadResult struct {
	CurrentThreadSeq int64
	ReplyCount       int32
	Replay           []*packetspb.MessageEvent
	DirectDeliveries []DirectDelivery
}

// InviteToChannelResult is returned by InviteToChannel.
type InviteToChannelResult struct {
	DirectDeliveries []DirectDelivery
}

// SetNotificationLevelParams holds the input for SetNotificationLevel.
type SetNotificationLevelParams struct {
	ChannelID uuid.UUID
	UserID    uuid.UUID
	Level     packetspb.NotificationLevel
}

// SetNotificationLevelResult carries the persisted level and direct deliveries
// for syncing other sessions of the same user.
type SetNotificationLevelResult struct {
	Level            packetspb.NotificationLevel
	DirectDeliveries []DirectDelivery
}

type ResolveNotificationParams struct {
	NotificationID uuid.UUID
	UserID         uuid.UUID
}

type ResolveNotificationResult struct {
	Resolved         bool
	DirectDeliveries []DirectDelivery
}
