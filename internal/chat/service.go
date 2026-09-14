package chat

import (
	"errors"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"go.uber.org/zap"

	"msgnr/internal/events"
	"msgnr/internal/gen/queries"
)

var (
	ErrNotMember                    = errors.New("not a channel member")
	ErrNotPublicChannel             = errors.New("not a public channel")
	ErrConversationArchived         = errors.New("conversation is archived")
	ErrInviteUnsupportedTarget      = errors.New("conversation does not support invites")
	ErrMessageNotFound              = errors.New("message not found")
	ErrMessageNotAuthor             = errors.New("message author mismatch")
	ErrSecretMessagePurgeIncomplete = errors.New("message deletion could not be completed; retry to finish deleting attachments")
	ErrInvalidThread                = errors.New("thread root does not belong to channel")
	ErrInvalidDMTarget              = errors.New("invalid dm target")
	ErrBlockedDMTarget              = errors.New("blocked dm target")
	ErrSelfDMProtected              = errors.New("self dm cannot be archived")
	ErrAttachmentNotFound           = errors.New("attachment not found")
	ErrAttachmentNotStaged          = errors.New("attachment is already linked to a message")
	ErrAttachmentOwnership          = errors.New("attachment does not belong to sender")
	ErrInvalidAttachment            = errors.New("invalid attachment")
	ErrEmptyMessage                 = errors.New("message body and attachments are both empty")
	ErrAttachmentStoreUnavailable   = errors.New("attachment storage is unavailable")
	ErrInvalidNotificationLevel     = errors.New("invalid notification level")
	ErrInvalidMessageEntity         = errors.New("invalid message entity")
	ErrRemoveMemberForbidden        = errors.New("not allowed to remove channel members")
	ErrRemoveUnsupportedTarget      = errors.New("conversation does not support member removal")
	ErrClearHistoryUnsupported      = errors.New("conversation does not support clear history")
	ErrEncryptedMessagesUnsupported = errors.New("encrypted messages are not implemented")
	ErrInvalidEncryptedPayload      = errors.New("invalid encrypted message payload")
	ErrEncryptedMessageUnsupported  = errors.New("encrypted message action is not supported")
	ErrE2EERecoveryDeviceOwnership  = errors.New("e2ee recovery device does not belong to user")
)

// Service handles messaging, reactions, and thread subscriptions.
type Service struct {
	pool                *pgxpool.Pool
	q                   *queries.Queries
	eventStore          *events.Store
	attachmentStore     AttachmentStorage
	attachmentMaxSizeMB int
	log                 *zap.Logger
}

const (
	defaultAttachmentMaxSizeMB = 50
	maxMessageAttachments      = 5
)

// NewService creates a chat Service.
func NewService(pool *pgxpool.Pool, eventStore *events.Store) *Service {
	sqlDB := stdlib.OpenDBFromPool(pool)
	return &Service{
		pool:                pool,
		q:                   queries.New(sqlDB),
		eventStore:          eventStore,
		attachmentMaxSizeMB: defaultAttachmentMaxSizeMB,
		log:                 zap.NewNop(),
	}
}

// ConfigureAttachments wires object storage and limits for chat attachments.
func (s *Service) ConfigureAttachments(store AttachmentStorage, maxSizeMB int) {
	s.attachmentStore = store
	if maxSizeMB > 0 {
		s.attachmentMaxSizeMB = maxSizeMB
	} else {
		s.attachmentMaxSizeMB = defaultAttachmentMaxSizeMB
	}
}

// SetLogger configures structured logging for non-fatal background failures.
func (s *Service) SetLogger(log *zap.Logger) {
	if log == nil {
		s.log = zap.NewNop()
		return
	}
	s.log = log
}
