package botapi

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// ---- /me ----

type meResponse struct {
	UserID      uuid.UUID `json:"user_id"`
	DisplayName string    `json:"display_name"`
	Email       string    `json:"email"`
	Role        string    `json:"role"`
}

// ---- channels ----

type channelDTO struct {
	ID             uuid.UUID `json:"id"`
	Name           string    `json:"name"`
	Kind           string    `json:"kind"`
	Visibility     string    `json:"visibility"`
	LastActivityAt time.Time `json:"last_activity_at"`
}

type channelsResponse struct {
	Channels []channelDTO `json:"channels"`
}

type joinChannelsRequest struct {
	ChannelIDs []string `json:"channel_ids"`
}

type joinedChannelDTO struct {
	ID   uuid.UUID `json:"id"`
	Name string    `json:"name"`
}

type joinChannelsResponse struct {
	Joined []joinedChannelDTO `json:"joined"`
}

// ---- conversations ----

type conversationDTO struct {
	ID             uuid.UUID `json:"id"`
	Kind           string    `json:"kind"`
	Visibility     string    `json:"visibility"`
	Name           string    `json:"name"`
	Hidden         bool      `json:"hidden"`
	MemberCount    int       `json:"member_count"`
	LastActivityAt time.Time `json:"last_activity_at"`
}

type conversationsResponse struct {
	Conversations []conversationDTO `json:"conversations"`
}

type memberDTO struct {
	UserID      uuid.UUID `json:"user_id"`
	DisplayName string    `json:"display_name"`
	Email       string    `json:"email"`
}

type membersResponse struct {
	Members []memberDTO `json:"members"`
}

type conversationTaskResponse struct {
	TaskID   uuid.UUID `json:"task_id"`
	PublicID string    `json:"public_id"`
}

// ---- messages ----

type entityDTO struct {
	Kind     string `json:"kind"`
	TargetID string `json:"target_id"`
	Label    string `json:"label"`
	Href     string `json:"href"`
	Start    int32  `json:"start"`
	End      int32  `json:"end"`
}

type reactionDTO struct {
	Emoji string `json:"emoji"`
	Count int32  `json:"count"`
}

type attachmentDTO struct {
	AttachmentID string `json:"attachment_id"`
	FileName     string `json:"file_name"`
	MimeType     string `json:"mime_type"`
	FileSize     int64  `json:"file_size"`
}

type messageDTO struct {
	ID                  uuid.UUID       `json:"id"`
	ConversationID      uuid.UUID       `json:"conversation_id"`
	SenderID            uuid.UUID       `json:"sender_id"`
	SenderName          string          `json:"sender_name"`
	Body                string          `json:"body"`
	ChannelSeq          int64           `json:"channel_seq"`
	ThreadSeq           int64           `json:"thread_seq"`
	ThreadRootMessageID *uuid.UUID      `json:"thread_root_message_id"`
	ThreadReplyCount    int32           `json:"thread_reply_count"`
	MentionEveryone     bool            `json:"mention_everyone"`
	CreatedAt           time.Time       `json:"created_at"`
	EditedAt            *time.Time      `json:"edited_at"`
	Entities            []entityDTO     `json:"entities"`
	Reactions           []reactionDTO   `json:"reactions"`
	Attachments         []attachmentDTO `json:"attachments"`
	ContentMode         string          `json:"content_mode"`
}

type channelHistoryResponse struct {
	Messages             []messageDTO `json:"messages"`
	HasMore              bool         `json:"has_more"`
	NextBeforeChannelSeq *int64       `json:"next_before_channel_seq"`
}

type threadHistoryResponse struct {
	Messages         []messageDTO `json:"messages"`
	CurrentThreadSeq int64        `json:"current_thread_seq"`
	ReplyCount       int32        `json:"reply_count"`
}

type sendMessageRequest struct {
	ConversationID      string      `json:"conversation_id"`
	Body                string      `json:"body"`
	ClientMsgID         string      `json:"client_msg_id"`
	ThreadRootMessageID *string     `json:"thread_root_message_id"`
	Entities            []entityDTO `json:"entities"`
}

type sendMessageResponse struct {
	MessageID   uuid.UUID `json:"message_id"`
	ChannelSeq  int64     `json:"channel_seq"`
	CreatedAt   time.Time `json:"created_at"`
	ClientMsgID string    `json:"client_msg_id"`
	Deduped     bool      `json:"deduped"`
}

// ---- tasks ----

type taskCommentDTO struct {
	ID                  uuid.UUID       `json:"id"`
	TaskID              uuid.UUID       `json:"task_id"`
	AuthorID            uuid.UUID       `json:"author_id"`
	AuthorName          string          `json:"author_name"`
	Body                string          `json:"body"`
	ThreadRootMessageID *uuid.UUID      `json:"thread_root_message_id"`
	CreatedAt           time.Time       `json:"created_at"`
	UpdatedAt           time.Time       `json:"updated_at"`
	AttachmentCount     int             `json:"attachment_count"`
	Attachments         []attachmentDTO `json:"attachments"`
}

type taskCommentsResponse struct {
	Comments []taskCommentDTO `json:"comments"`
}

type createCommentRequest struct {
	Body string `json:"body"`
}

// ---- search ----

type searchMessageResultDTO struct {
	Source                 string    `json:"source"`
	ID                     string    `json:"id"`
	Body                   string    `json:"body"`
	CreatedAt              time.Time `json:"created_at"`
	ActorID                string    `json:"actor_id"`
	ActorName              string    `json:"actor_name"`
	ConversationID         string    `json:"conversation_id"`
	ConversationTitle      string    `json:"conversation_title"`
	ConversationKind       string    `json:"conversation_kind"`
	ConversationVisibility string    `json:"conversation_visibility"`
	MessageID              string    `json:"message_id"`
	ThreadRootMessageID    string    `json:"thread_root_message_id"`
	TaskID                 string    `json:"task_id"`
	TaskPublicID           string    `json:"task_public_id"`
	TaskTitle              string    `json:"task_title"`
	TaskCommentID          string    `json:"task_comment_id"`
}

type searchMessagesResponse struct {
	Results []searchMessageResultDTO `json:"results"`
}

type searchDocumentResultDTO struct {
	ID            uuid.UUID `json:"id"`
	TeamspaceID   uuid.UUID `json:"teamspace_id"`
	TeamspaceName string    `json:"teamspace_name"`
	Title         string    `json:"title"`
	Snippet       string    `json:"snippet"`
}

type searchDocumentsResponse struct {
	Results []searchDocumentResultDTO `json:"results"`
}

// ---- documents ----

type createDocumentRequest struct {
	Title       string     `json:"title"`
	Description *string    `json:"description"`
	ParentID    *uuid.UUID `json:"parent_id"`
	TeamspaceID uuid.UUID  `json:"teamspace_id"`
}

type createDocumentResponse struct {
	ID          uuid.UUID  `json:"id"`
	ParentID    *uuid.UUID `json:"parent_id"`
	Title       string     `json:"title"`
	Description *string    `json:"description"`
	URL         string     `json:"url"`
}

type documentDTO struct {
	ID              uuid.UUID       `json:"id"`
	TeamspaceID     uuid.UUID       `json:"teamspace_id"`
	ParentID        *uuid.UUID      `json:"parent_id"`
	Title           string          `json:"title"`
	ContentMarkdown *string         `json:"content_markdown"`
	CreatedBy       uuid.UUID       `json:"created_by"`
	UpdatedBy       uuid.UUID       `json:"updated_by"`
	CreatedAt       time.Time       `json:"created_at"`
	UpdatedAt       time.Time       `json:"updated_at"`
	Attachments     []attachmentDTO `json:"attachments"`
}

// ---- events ----

type eventDTO struct {
	EventSeq       int64           `json:"event_seq"`
	EventID        string          `json:"event_id"`
	EventType      string          `json:"event_type"`
	OccurredAt     time.Time       `json:"occurred_at"`
	ConversationID *string         `json:"conversation_id"`
	Payload        json.RawMessage `json:"payload"`
}

type eventsResponse struct {
	Events             []eventDTO `json:"events"`
	NextCursor         int64      `json:"next_cursor"`
	LatestSeq          int64      `json:"latest_seq"`
	HasMore            bool       `json:"has_more"`
	GapBeyondRetention bool       `json:"gap_beyond_retention"`
}
