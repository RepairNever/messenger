package chat

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	"msgnr/internal/events"
	packetspb "msgnr/internal/gen/proto"
	"msgnr/internal/gen/queries"
)

// Note on tx-local SQL duplicates: several small reads (e.g. conversationKindTx,
// isChannelMemberTx, messageChannelByIDTx, getNotificationLevelTx) re-implement
// queries that already exist in sqlc. They are kept inline because sqlc here
// targets database/sql while mutations use pgx.Tx directly, and sharing a
// single connection between the two drivers within a single transaction is not
// supported. Do NOT "DRY" these into sqlc calls without adopting pgx/v5 sqlc
// generation across the repo.

func (s *Service) ListRecentMessages(ctx context.Context, requesterID, conversationID uuid.UUID, limit int) ([]ConversationMessage, error) {
	messages, _, err := s.ListMessagePage(ctx, requesterID, conversationID, nil, limit, uuid.Nil)
	return messages, err
}

func (s *Service) SaveMessage(ctx context.Context, userID, messageID uuid.UUID) (time.Time, error) {
	savedAt, err := s.q.SaveMessage(ctx, queries.SaveMessageParams{
		UserID:    userID,
		MessageID: messageID,
	})
	if err == nil {
		return savedAt, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return time.Time{}, fmt.Errorf("chat.SaveMessage query: %w", err)
	}

	channelID, channelErr := s.q.GetMessageChannelID(ctx, messageID)
	if errors.Is(channelErr, sql.ErrNoRows) {
		return time.Time{}, ErrMessageNotFound
	}
	if channelErr != nil {
		return time.Time{}, fmt.Errorf("chat.SaveMessage message lookup: %w", channelErr)
	}
	isMember, memberErr := s.q.IsChannelMember(ctx, queries.IsChannelMemberParams{
		ChannelID: channelID,
		UserID:    userID,
	})
	if memberErr != nil {
		return time.Time{}, fmt.Errorf("chat.SaveMessage membership check: %w", memberErr)
	}
	if !isMember {
		return time.Time{}, ErrNotMember
	}
	return time.Time{}, fmt.Errorf("chat.SaveMessage unexpected empty insert result for message=%s user=%s", messageID, userID)
}

func (s *Service) UnsaveMessage(ctx context.Context, userID, messageID uuid.UUID) error {
	if err := s.q.UnsaveMessage(ctx, queries.UnsaveMessageParams{
		UserID:    userID,
		MessageID: messageID,
	}); err != nil {
		return fmt.Errorf("chat.UnsaveMessage query: %w", err)
	}
	return nil
}

func (s *Service) ListSavedMessages(ctx context.Context, userID uuid.UUID) ([]SavedMessageItem, error) {
	rows, err := s.q.ListSavedMessages(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("chat.ListSavedMessages query: %w", err)
	}

	items := make([]SavedMessageItem, 0, len(rows))
	messageIDs := make([]uuid.UUID, 0, len(rows))
	for _, row := range rows {
		messageID := parseUUIDOrNil(row.MessageID)
		if messageID != uuid.Nil {
			messageIDs = append(messageIDs, messageID)
		}
		items = append(items, SavedMessageItem{
			ID:                     "saved:" + row.MessageID,
			ConversationID:         parseUUIDOrNil(row.ConversationID),
			ConversationKind:       row.Kind,
			ConversationVisibility: row.Visibility,
			ConversationTitle:      row.ConversationTitle,
			MessageID:              messageID,
			ThreadRootMessageID:    parseUUIDOrNil(row.ThreadRootMessageID),
			SenderID:               parseUUIDOrNil(row.SenderID),
			SenderName:             row.SenderName,
			Body:                   row.Body,
			ForwardedFrom: forwardedMessageInfoFromStrings(
				row.ForwardedFromMessageID,
				row.ForwardedFromSenderID,
				row.ForwardedFromSenderName,
				row.ForwardedFromConversationKind,
				row.ForwardedFromConversationTitle,
				row.ForwardedFromThreadTitle,
			),
			CreatedAt: row.CreatedAt,
			SavedAt:   row.SavedAt,
		})
	}
	entitiesByMessageID, err := s.loadMessageEntitiesByMessageIDs(ctx, messageIDs)
	if err != nil {
		return nil, fmt.Errorf("chat.ListSavedMessages load entities: %w", err)
	}
	for i := range items {
		items[i].Entities = entitiesByMessageID[items[i].MessageID.String()]
	}
	return items, nil
}

func (s *Service) ListMessagePage(
	ctx context.Context,
	requesterID, conversationID uuid.UUID,
	beforeChannelSeq *int64,
	limit int,
	requesterDeviceID ...uuid.UUID,
) ([]ConversationMessage, bool, error) {
	isMember, err := s.q.IsChannelMember(ctx, queries.IsChannelMemberParams{
		ChannelID: conversationID,
		UserID:    requesterID,
	})
	if err != nil {
		return nil, false, fmt.Errorf("chat.ListMessagePage membership check: %w", err)
	}
	if !isMember {
		return nil, false, ErrNotMember
	}

	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	queryLimit := limit + 1

	before := int64(math.MaxInt64)
	if beforeChannelSeq != nil {
		before = *beforeChannelSeq
	}

	rows, err := s.q.ListConversationMessagePage(ctx, queries.ListConversationMessagePageParams{
		ConversationID:   conversationID,
		RequesterID:      requesterID,
		BeforeChannelSeq: before,
		QueryLimit:       queryLimit,
	})
	if err != nil {
		return nil, false, fmt.Errorf("chat.ListMessagePage query: %w", err)
	}

	messages := make([]ConversationMessage, 0, len(rows))
	for _, row := range rows {
		item := ConversationMessage{
			ID:               row.ID,
			ConversationID:   row.ChannelID,
			SenderID:         row.SenderID,
			SenderName:       row.DisplayName,
			Body:             row.Body,
			ForwardedFrom:    forwardedMessageInfoFromRow(row.ForwardedFromMessageID, row.ForwardedFromSenderID, row.ForwardedFromSenderName, row.ForwardedFromConversationKind, row.ForwardedFromConversationTitle, row.ForwardedFromThreadTitle),
			ChannelSeq:       row.ChannelSeq,
			ContentMode:      row.ContentMode,
			ThreadSeq:        row.ThreadSeq,
			ThreadReplyCount: int32(row.ThreadReplyCount),
			CreatedAt:        row.CreatedAt,
			MentionEveryone:  row.MentionEveryone,
			IsSaved:          row.IsSaved,
		}
		if row.EditedAt.Valid {
			editedAt := row.EditedAt.Time
			item.EditedAt = &editedAt
		}
		if row.ThreadRootID.Valid {
			item.ThreadRootMessageID = row.ThreadRootID.UUID
		}
		if row.SenderDeviceID.Valid {
			item.SenderDeviceID = row.SenderDeviceID.UUID
		}
		if err := hydrateMessageJSONFields(row.Reactions, row.MyReactions, row.Attachments, &item); err != nil {
			return nil, false, fmt.Errorf("chat.ListMessagePage hydrate: %w", err)
		}
		messages = append(messages, item)
	}

	hasMore := len(messages) > limit
	if hasMore {
		messages = messages[:limit]
	}

	messageIDs := make([]uuid.UUID, 0, len(messages))
	for _, message := range messages {
		messageIDs = append(messageIDs, message.ID)
	}
	entitiesByMessageID, err := s.loadMessageEntitiesByMessageIDs(ctx, messageIDs)
	if err != nil {
		return nil, false, fmt.Errorf("chat.ListMessagePage load entities: %w", err)
	}
	for i := range messages {
		messages[i].Entities = entitiesByMessageID[messages[i].ID.String()]
	}
	if err := s.hydrateEncryptedDMPayloads(ctx, requesterID, optionalUUID(requesterDeviceID), messages); err != nil {
		return nil, false, fmt.Errorf("chat.ListMessagePage load encrypted payloads: %w", err)
	}

	for i, j := 0, len(messages)-1; i < j; i, j = i+1, j-1 {
		messages[i], messages[j] = messages[j], messages[i]
	}
	return messages, hasMore, nil
}

func forwardedMessageInfoFromRow(messageID uuid.NullUUID, senderID uuid.NullUUID, senderName, conversationKind, conversationTitle, threadTitle sql.NullString) *ForwardedMessageInfo {
	if !messageID.Valid || !senderID.Valid || !senderName.Valid || strings.TrimSpace(senderName.String) == "" {
		return nil
	}
	return &ForwardedMessageInfo{
		MessageID:         messageID.UUID,
		SenderID:          senderID.UUID,
		SenderName:        senderName.String,
		ConversationKind:  strings.TrimSpace(conversationKind.String),
		ConversationTitle: strings.TrimSpace(conversationTitle.String),
		ThreadTitle:       strings.TrimSpace(threadTitle.String),
	}
}

func forwardedMessageInfoFromStrings(messageIDRaw, senderIDRaw, senderNameRaw, conversationKindRaw, conversationTitleRaw, threadTitleRaw string) *ForwardedMessageInfo {
	messageID := parseUUIDOrNil(messageIDRaw)
	senderID := parseUUIDOrNil(senderIDRaw)
	senderName := strings.TrimSpace(senderNameRaw)
	if messageID == uuid.Nil || senderID == uuid.Nil || senderName == "" {
		return nil
	}
	return &ForwardedMessageInfo{
		MessageID:         messageID,
		SenderID:          senderID,
		SenderName:        senderName,
		ConversationKind:  strings.TrimSpace(conversationKindRaw),
		ConversationTitle: strings.TrimSpace(conversationTitleRaw),
		ThreadTitle:       strings.TrimSpace(threadTitleRaw),
	}
}

// ForwardMessage copies one existing message into a destination conversation or thread.
// The forwarded message is authored by ActorID while preserving source attribution.
func (s *Service) ForwardMessage(ctx context.Context, p ForwardMessageParams) (ForwardMessageResult, error) {
	if p.DestinationThreadRootMessageID != uuid.Nil {
		return ForwardMessageResult{}, ErrInvalidThread
	}

	// Hold a key-share lock on the source message until the new message and its
	// attachment references are committed. This serializes forwarding with a
	// concurrent source deletion (including DM history/channel cascades), so a
	// forward cannot create a new row for an object that deletion has released.
	sourceTx, err := s.pool.Begin(ctx)
	if err != nil {
		return ForwardMessageResult{}, fmt.Errorf("chat.ForwardMessage begin source lock: %w", err)
	}
	defer sourceTx.Rollback(ctx) //nolint:errcheck

	var source struct {
		ID                uuid.UUID
		ChannelID         uuid.UUID
		SenderID          uuid.UUID
		SenderName        string
		Body              string
		ContentMode       string
		ConversationKind  string
		ConversationTitle string
		ThreadTitle       sql.NullString
	}
	if err := sourceTx.QueryRow(ctx, `
		SELECT m.id,
		       m.channel_id,
		       m.sender_id,
		       COALESCE(NULLIF(u.display_name, ''), u.email),
		       m.body,
		       m.content_mode,
		       c.kind,
		       COALESCE(
		         NULLIF(CASE
		           WHEN c.kind = 'dm' THEN COALESCE(NULLIF(peer.display_name, ''), peer.email, c.name)
		           ELSE c.name
		         END, ''),
		         c.kind
		       ) AS conversation_title,
		       CASE
		         WHEN m.thread_root_id IS NOT NULL THEN COALESCE(NULLIF(root.body, ''), 'Attachment')
		         ELSE NULL
		       END AS thread_title
		  FROM messages m
		  JOIN users u ON u.id = m.sender_id
		  JOIN channels c ON c.id = m.channel_id
		  LEFT JOIN LATERAL (
		    SELECT peer_user.display_name, peer_user.email
		      FROM channel_members peer_member
		      JOIN users peer_user ON peer_user.id = peer_member.user_id
		     WHERE peer_member.channel_id = c.id
		       AND peer_member.is_archived = false
		       AND peer_member.user_id <> $2
		     ORDER BY peer_user.display_name, peer_user.email
		     LIMIT 1
		  ) peer ON c.kind = 'dm'
		  LEFT JOIN messages root ON root.id = m.thread_root_id
		 WHERE m.id = $1
		 FOR KEY SHARE OF m`,
		p.SourceMessageID,
		p.ActorID,
	).Scan(
		&source.ID,
		&source.ChannelID,
		&source.SenderID,
		&source.SenderName,
		&source.Body,
		&source.ContentMode,
		&source.ConversationKind,
		&source.ConversationTitle,
		&source.ThreadTitle,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ForwardMessageResult{}, ErrMessageNotFound
		}
		return ForwardMessageResult{}, fmt.Errorf("chat.ForwardMessage load source: %w", err)
	}

	isSourceMember, err := s.q.IsChannelMember(ctx, queries.IsChannelMemberParams{
		ChannelID: source.ChannelID,
		UserID:    p.ActorID,
	})
	if err != nil {
		return ForwardMessageResult{}, fmt.Errorf("chat.ForwardMessage source membership: %w", err)
	}
	if !isSourceMember {
		return ForwardMessageResult{}, ErrNotMember
	}
	if source.ContentMode == MessageContentDMPairwiseSignal {
		return ForwardMessageResult{}, ErrEncryptedMessageUnsupported
	}

	entitiesByMessageID, err := s.loadMessageEntitiesByMessageIDs(ctx, []uuid.UUID{p.SourceMessageID})
	if err != nil {
		return ForwardMessageResult{}, fmt.Errorf("chat.ForwardMessage load entities: %w", err)
	}
	attachments, err := s.loadMessageAttachmentsForForward(ctx, p.SourceMessageID)
	if err != nil {
		return ForwardMessageResult{}, fmt.Errorf("chat.ForwardMessage load attachments: %w", err)
	}

	result, err := s.SendMessage(ctx, SendMessageParams{
		ChannelID: p.DestinationConversationID,
		SenderID:  p.ActorID,
		// Forwarding is intentionally non-idempotent in v1: each user action creates a new destination message.
		ClientMsgID:         "forward:" + uuid.NewString(),
		Body:                source.Body,
		Entities:            entitiesByMessageID[p.SourceMessageID.String()],
		ThreadRootMessageID: p.DestinationThreadRootMessageID,
		AttachmentCopies:    attachments,
		ForwardedFrom: &ForwardedMessageInfo{
			MessageID:         source.ID,
			SenderID:          source.SenderID,
			SenderName:        source.SenderName,
			ConversationKind:  source.ConversationKind,
			ConversationTitle: source.ConversationTitle,
			ThreadTitle:       source.ThreadTitle.String,
		},
		SuppressMentions: true,
	})
	if err != nil {
		return ForwardMessageResult{}, err
	}
	return ForwardMessageResult{
		MessageID:        result.MessageID,
		ChannelSeq:       result.ChannelSeq,
		CreatedAt:        result.CreatedAt,
		DirectDeliveries: result.DirectDeliveries,
	}, nil
}

func (s *Service) loadMessageAttachmentsForForward(ctx context.Context, messageID uuid.UUID) ([]MessageAttachment, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, conversation_id, message_id, file_name, file_size, mime_type, storage_key,
		       thumbnail_storage_key, thumbnail_mime_type, thumbnail_file_size, thumbnail_version,
		       uploaded_by, created_at
		  FROM message_attachment
		 WHERE message_id = $1
		 ORDER BY created_at ASC, id ASC`,
		messageID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	attachments := make([]MessageAttachment, 0)
	for rows.Next() {
		attachment, err := scanMessageAttachment(rows)
		if err != nil {
			return nil, err
		}
		attachments = append(attachments, attachment)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return attachments, nil
}

func (s *Service) ListForwardTargets(ctx context.Context, requesterID uuid.UUID) (ForwardTargets, error) {
	conversationRows, err := s.pool.Query(ctx, `
		SELECT c.id,
		       COALESCE(
		         NULLIF(CASE
		           WHEN c.kind = 'dm' THEN COALESCE(NULLIF(peer.display_name, ''), peer.email, c.name)
		           ELSE c.name
		         END, ''),
		         c.kind
		       ) AS title,
		       c.kind,
		       c.visibility
		  FROM channels c
		  JOIN channel_members self_member
		    ON self_member.channel_id = c.id
		   AND self_member.user_id = $1
		   AND self_member.is_archived = false
		  LEFT JOIN LATERAL (
		    SELECT u.display_name, u.email
		      FROM channel_members peer_member
		      JOIN users u ON u.id = peer_member.user_id
		     WHERE peer_member.channel_id = c.id
		       AND peer_member.is_archived = false
		       AND peer_member.user_id <> $1
		     ORDER BY u.display_name, u.email
		     LIMIT 1
		  ) peer ON c.kind = 'dm'
		 WHERE c.hidden = false
		   AND c.is_archived = false
		 ORDER BY CASE WHEN c.kind = 'channel' THEN 0 WHEN c.kind = 'dm' THEN 1 ELSE 2 END,
		          title ASC`,
		requesterID,
	)
	if err != nil {
		return ForwardTargets{}, fmt.Errorf("chat.ListForwardTargets conversations: %w", err)
	}
	defer conversationRows.Close()

	result := ForwardTargets{
		Conversations: make([]ForwardTargetConversation, 0),
		Threads:       make([]ForwardTargetThread, 0),
	}
	for conversationRows.Next() {
		var item ForwardTargetConversation
		if err := conversationRows.Scan(&item.ConversationID, &item.Title, &item.Kind, &item.Visibility); err != nil {
			return ForwardTargets{}, fmt.Errorf("chat.ListForwardTargets scan conversation: %w", err)
		}
		result.Conversations = append(result.Conversations, item)
	}
	if err := conversationRows.Err(); err != nil {
		return ForwardTargets{}, fmt.Errorf("chat.ListForwardTargets conversation rows: %w", err)
	}
	return result, nil
}

// SendMessage persists a message and emits message_created (and optionally
// thread_summary_updated) events. It manages its own pgx transaction.
func (s *Service) SendMessage(ctx context.Context, p SendMessageParams) (SendMessageResult, error) {
	p.Body = strings.TrimSpace(p.Body)
	contentMode := p.ContentMode
	if contentMode == "" {
		contentMode = MessageContentPlaintext
	}
	isEncryptedContent := contentMode == MessageContentDMPairwiseSignal
	if len(p.AttachmentIDs) > maxMessageAttachments {
		return SendMessageResult{}, fmt.Errorf("%w: too many attachments (max %d)", ErrInvalidAttachment, maxMessageAttachments)
	}
	if len(p.AttachmentCopies) > maxMessageAttachments {
		return SendMessageResult{}, fmt.Errorf("%w: too many attachments (max %d)", ErrInvalidAttachment, maxMessageAttachments)
	}
	if len(p.AttachmentIDs) > 0 && len(p.AttachmentCopies) > 0 {
		return SendMessageResult{}, fmt.Errorf("%w: cannot mix staged and copied attachments", ErrInvalidAttachment)
	}
	if !isEncryptedContent && p.Body == "" && len(p.AttachmentIDs) == 0 && len(p.AttachmentCopies) == 0 {
		return SendMessageResult{}, ErrEmptyMessage
	}
	if isEncryptedContent && len(p.EncryptedDMPayloads) == 0 {
		return SendMessageResult{}, ErrInvalidEncryptedPayload
	}

	// Dedup check outside transaction (read-only, idempotent).
	existing, err := s.findMessageByClientMsgID(ctx, p.ChannelID, p.SenderID, p.ClientMsgID)
	if err == nil {
		return SendMessageResult{
			MessageID:   existing.ID,
			ChannelSeq:  existing.ChannelSeq,
			CreatedAt:   timestamppb.New(existing.CreatedAt),
			ClientMsgID: existing.ClientMsgID,
			Deduped:     true,
		}, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return SendMessageResult{}, fmt.Errorf("chat.SendMessage dedup check: %w", err)
	}

	// Membership guard.
	isMember, err := s.q.IsChannelMember(ctx, queries.IsChannelMemberParams{
		ChannelID: p.ChannelID,
		UserID:    p.SenderID,
	})
	if err != nil {
		return SendMessageResult{}, fmt.Errorf("chat.SendMessage membership check: %w", err)
	}
	if !isMember {
		return SendMessageResult{}, ErrNotMember
	}
	var conversationEncryptionMode string
	if err := s.pool.QueryRow(ctx, `
		SELECT encryption_mode
		  FROM channels
		 WHERE id = $1`,
		p.ChannelID,
	).Scan(&conversationEncryptionMode); err != nil {
		return SendMessageResult{}, fmt.Errorf("chat.SendMessage conversation encryption mode: %w", err)
	}
	switch {
	case isEncryptedContent:
		if conversationEncryptionMode != ConversationEncryptionDMPairwiseSignal {
			return SendMessageResult{}, ErrInvalidEncryptedPayload
		}
		if p.ThreadRootMessageID != uuid.Nil || len(p.AttachmentIDs) > 0 || len(p.AttachmentCopies) > 0 || len(p.Entities) > 0 || p.SenderDeviceID == uuid.Nil {
			return SendMessageResult{}, ErrInvalidEncryptedPayload
		}
		isActiveSenderDevice, err := s.q.IsActiveUserDevice(ctx, queries.IsActiveUserDeviceParams{
			DeviceID: p.SenderDeviceID,
			UserID:   p.SenderID,
		})
		if err != nil {
			return SendMessageResult{}, fmt.Errorf("chat.SendMessage sender device: %w", err)
		}
		if !isActiveSenderDevice {
			return SendMessageResult{}, ErrInvalidEncryptedPayload
		}
		requiredDevices, err := s.requiredEncryptedDMRecipientDevices(ctx, p.SenderID, p.ChannelID)
		if err != nil {
			return SendMessageResult{}, err
		}
		if len(requiredDevices) == 0 || len(p.EncryptedDMPayloads) != len(requiredDevices) {
			return SendMessageResult{}, ErrInvalidEncryptedPayload
		}
		seenRecipients := make(map[uuid.UUID]struct{}, len(p.EncryptedDMPayloads))
		for _, payload := range p.EncryptedDMPayloads {
			if payload.RecipientDeviceID == uuid.Nil || payload.SenderDeviceID != p.SenderDeviceID || strings.TrimSpace(payload.Algorithm) != encryptedDMEnvelopeAlgorithm || len(payload.SessionMessage) == 0 {
				return SendMessageResult{}, ErrInvalidEncryptedPayload
			}
			if _, ok := requiredDevices[payload.RecipientDeviceID]; !ok {
				return SendMessageResult{}, ErrInvalidEncryptedPayload
			}
			if _, duplicate := seenRecipients[payload.RecipientDeviceID]; duplicate {
				return SendMessageResult{}, ErrInvalidEncryptedPayload
			}
			seenRecipients[payload.RecipientDeviceID] = struct{}{}
		}
		if len(seenRecipients) != len(requiredDevices) {
			return SendMessageResult{}, ErrInvalidEncryptedPayload
		}
	case conversationEncryptionMode != ConversationEncryptionNone:
		return SendMessageResult{}, ErrEncryptedMessagesUnsupported
	}

	isReply := p.ThreadRootMessageID != uuid.Nil

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SendMessageResult{}, fmt.Errorf("chat.SendMessage begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	restoredDMPeer, err := s.restoreArchivedDMPeerTx(ctx, tx, p.ChannelID, p.SenderID)
	if err != nil {
		return SendMessageResult{}, fmt.Errorf("chat.SendMessage restore dm peer: %w", err)
	}

	attachments, err := s.lockAndValidateStagedAttachmentsTx(ctx, tx, p.ChannelID, p.SenderID, p.AttachmentIDs)
	if err != nil {
		return SendMessageResult{}, err
	}
	if len(p.AttachmentCopies) > 0 {
		attachments = make([]MessageAttachment, len(p.AttachmentCopies))
		copy(attachments, p.AttachmentCopies)
	}
	var normalizedEntities []MessageEntity
	if isEncryptedContent {
		normalizedEntities = nil
	} else if p.SuppressMentions {
		normalizedEntities = append([]MessageEntity(nil), p.Entities...)
	} else {
		normalizedEntities, err = s.validateAndNormalizeMessageEntities(ctx, tx, p.ChannelID, p.SenderID, p.Body, p.Entities)
		if err != nil {
			return SendMessageResult{}, err
		}
	}

	mentionEveryone := !isEncryptedContent && !p.SuppressMentions && detectMentionEveryone(p.Body)

	var threadSeq int64
	var threadReplyAt time.Time
	if isReply {
		threadChannelID, err := s.messageChannelByIDTx(ctx, tx, p.ThreadRootMessageID)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return SendMessageResult{}, ErrMessageNotFound
			}
			return SendMessageResult{}, fmt.Errorf("chat.SendMessage resolve thread root: %w", err)
		}
		if threadChannelID != p.ChannelID {
			return SendMessageResult{}, ErrInvalidThread
		}

		// Upsert thread summary atomically.
		// next_thread_seq after upsert is for the NEXT reply; current gets (next - 1).
		var nextThreadSeq int64
		err = tx.QueryRow(ctx, `
			INSERT INTO thread_summaries (root_message_id, channel_id, reply_count, next_thread_seq, last_reply_at, last_reply_user_id)
			VALUES ($1, $2, 1, 2, now(), $3)
			ON CONFLICT (root_message_id) DO UPDATE
			    SET reply_count        = thread_summaries.reply_count + 1,
			        next_thread_seq    = thread_summaries.next_thread_seq + 1,
			        last_reply_at      = now(),
			        last_reply_user_id = $3
			RETURNING next_thread_seq`,
			p.ThreadRootMessageID, p.ChannelID, p.SenderID,
		).Scan(&nextThreadSeq)
		if err != nil {
			return SendMessageResult{}, fmt.Errorf("chat.SendMessage upsert thread summary: %w", err)
		}
		threadSeq = nextThreadSeq - 1
		threadReplyAt = time.Now().UTC()
	}

	// Insert message with atomic channel_seq increment.
	var threadRootArg interface{} = nil
	if isReply {
		threadRootArg = p.ThreadRootMessageID
	}
	var forwardedFromMessageArg interface{} = nil
	var forwardedFromSenderArg interface{} = nil
	var forwardedFromSenderNameArg interface{} = nil
	var forwardedFromConversationKindArg interface{} = nil
	var forwardedFromConversationTitleArg interface{} = nil
	var forwardedFromThreadTitleArg interface{} = nil
	if p.ForwardedFrom != nil {
		forwardedFromMessageArg = p.ForwardedFrom.MessageID
		forwardedFromSenderArg = p.ForwardedFrom.SenderID
		forwardedFromSenderNameArg = p.ForwardedFrom.SenderName
		forwardedFromConversationKindArg = strings.TrimSpace(p.ForwardedFrom.ConversationKind)
		forwardedFromConversationTitleArg = strings.TrimSpace(p.ForwardedFrom.ConversationTitle)
		threadTitle := strings.TrimSpace(p.ForwardedFrom.ThreadTitle)
		if threadTitle != "" {
			forwardedFromThreadTitleArg = threadTitle
		}
	}

	var msgID uuid.UUID
	var channelSeq int64
	var clientMsgID string
	var createdAt time.Time
	bodyToStore := p.Body
	if isEncryptedContent {
		bodyToStore = ""
	}
	var senderDeviceArg interface{} = nil
	if p.SenderDeviceID != uuid.Nil {
		senderDeviceArg = p.SenderDeviceID
	}

	if err := tx.QueryRow(ctx, `
		WITH seq AS (
		    UPDATE channels
		    SET next_seq = next_seq + 1,
		        last_activity_at = now()
		    WHERE id = $1
		    RETURNING next_seq
		)
		INSERT INTO messages (channel_id, channel_seq, sender_id, client_msg_id, body, content_mode, sender_device_id,
		                      forwarded_from_message_id, forwarded_from_sender_id, forwarded_from_sender_name,
		                      forwarded_from_conversation_kind,
		                      forwarded_from_conversation_title, forwarded_from_thread_title,
		                      thread_root_id, thread_seq, mention_everyone, created_at)
		VALUES ($1, (SELECT next_seq FROM seq), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())
		RETURNING id, channel_seq, client_msg_id, created_at`,
		p.ChannelID, p.SenderID, p.ClientMsgID, bodyToStore, contentMode, senderDeviceArg,
		forwardedFromMessageArg, forwardedFromSenderArg, forwardedFromSenderNameArg,
		forwardedFromConversationKindArg, forwardedFromConversationTitleArg, forwardedFromThreadTitleArg,
		threadRootArg, threadSeq, mentionEveryone,
	).Scan(&msgID, &channelSeq, &clientMsgID, &createdAt); err != nil {
		if isUniqueViolation(err) {
			existingRow, qErr := s.findMessageByClientMsgID(ctx, p.ChannelID, p.SenderID, p.ClientMsgID)
			if qErr == nil {
				return SendMessageResult{
					MessageID:   existingRow.ID,
					ChannelSeq:  existingRow.ChannelSeq,
					CreatedAt:   timestamppb.New(existingRow.CreatedAt),
					ClientMsgID: existingRow.ClientMsgID,
					Deduped:     true,
				}, nil
			}
		}
		return SendMessageResult{}, fmt.Errorf("chat.SendMessage insert message: %w", err)
	}
	if isEncryptedContent {
		batch := &pgx.Batch{}
		for _, payload := range p.EncryptedDMPayloads {
			metadataAAD := payload.MetadataAAD
			if metadataAAD == nil {
				metadataAAD = []byte{}
			}
			batch.Queue(`
				INSERT INTO message_recipient_ciphertexts (
					message_id, recipient_device_id, sender_device_id, algorithm, session_message, metadata_aad
				)
				VALUES ($1, $2, $3, $4, $5, $6)`,
				msgID,
				payload.RecipientDeviceID,
				payload.SenderDeviceID,
				strings.TrimSpace(payload.Algorithm),
				payload.SessionMessage,
				metadataAAD,
			)
		}
		results := tx.SendBatch(ctx, batch)
		for range p.EncryptedDMPayloads {
			if _, err := results.Exec(); err != nil {
				_ = results.Close()
				return SendMessageResult{}, fmt.Errorf("chat.SendMessage insert encrypted payload: %w", err)
			}
		}
		if err := results.Close(); err != nil {
			return SendMessageResult{}, fmt.Errorf("chat.SendMessage insert encrypted payload: %w", err)
		}
	}

	if len(attachments) > 0 && len(p.AttachmentCopies) == 0 {
		ids := make([]uuid.UUID, 0, len(attachments))
		for _, attachment := range attachments {
			ids = append(ids, attachment.ID)
		}
		updatedRows, err := tx.Exec(ctx, `
			UPDATE message_attachment
			   SET message_id = $1
			 WHERE id = ANY($2::uuid[])
			   AND message_id IS NULL`,
			msgID, ids,
		)
		if err != nil {
			return SendMessageResult{}, fmt.Errorf("chat.SendMessage link attachments: %w", err)
		}
		if int(updatedRows.RowsAffected()) != len(ids) {
			return SendMessageResult{}, fmt.Errorf("chat.SendMessage link attachments: %w", ErrAttachmentNotStaged)
		}
		for i := range attachments {
			attachments[i].MessageID = msgID
		}
	} else if len(attachments) > 0 {
		batch := &pgx.Batch{}
		now := time.Now().UTC()
		for i := range attachments {
			attachments[i].ID = uuid.New()
			attachments[i].ConversationID = p.ChannelID
			attachments[i].MessageID = msgID
			attachments[i].UploadedBy = p.SenderID
			attachments[i].CreatedAt = now
			batch.Queue(`
				INSERT INTO message_attachment (
					id, conversation_id, message_id, file_name, file_size,
					mime_type, storage_key,
					thumbnail_storage_key, thumbnail_mime_type, thumbnail_file_size, thumbnail_version,
					uploaded_by, created_at
				)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
				attachments[i].ID,
				attachments[i].ConversationID,
				attachments[i].MessageID,
				attachments[i].FileName,
				attachments[i].FileSize,
				attachments[i].MimeType,
				attachments[i].StorageKey,
				nullableString(attachments[i].ThumbnailStorageKey),
				nullableString(attachments[i].ThumbnailMimeType),
				nullableInt64(attachments[i].ThumbnailFileSize, attachments[i].ThumbnailStorageKey != ""),
				nullableInt16(attachments[i].ThumbnailVersion, attachments[i].ThumbnailStorageKey != ""),
				attachments[i].UploadedBy,
				attachments[i].CreatedAt,
			)
		}
		results := tx.SendBatch(ctx, batch)
		for range attachments {
			if _, err := results.Exec(); err != nil {
				_ = results.Close()
				return SendMessageResult{}, fmt.Errorf("chat.SendMessage copy attachments: %w", err)
			}
		}
		if err := results.Close(); err != nil {
			return SendMessageResult{}, fmt.Errorf("chat.SendMessage copy attachments: %w", err)
		}
	}
	if err := s.insertMessageEntitiesTx(ctx, tx, msgID, normalizedEntities); err != nil {
		return SendMessageResult{}, fmt.Errorf("chat.SendMessage insert entities: %w", err)
	}

	sender, err := s.lookupActiveDMUser(ctx, p.SenderID)
	if err != nil {
		return SendMessageResult{}, fmt.Errorf("chat.SendMessage lookup sender: %w", err)
	}
	senderName := sender.DisplayName
	if senderName == "" {
		senderName = sender.Email
	}

	directDeliveries := make([]DirectDelivery, 0)
	if restoredDMPeer != nil {
		// First event recreates the DM in sidebar before unread counters/message fanout arrive.
		upsert := s.buildDMConversationUpsertedDeliveries(p.ChannelID, *restoredDMPeer, sender, ConversationEncryptionNone)
		if len(upsert) > 0 {
			directDeliveries = append(directDeliveries, upsert[0])
		}
	}

	alertRecipients, err := s.messageAlertRecipientsTx(ctx, tx, p.ChannelID, p.SenderID)
	if err != nil {
		return SendMessageResult{}, fmt.Errorf("chat.SendMessage list alert recipients: %w", err)
	}
	conversationKind, err := s.conversationKindTx(ctx, tx, p.ChannelID)
	if err != nil {
		return SendMessageResult{}, fmt.Errorf("chat.SendMessage conversation kind: %w", err)
	}
	isDMConversation := conversationKind == "dm"

	mentionedIDs := mentionedUserIDsFromEntities(normalizedEntities)
	if p.SuppressMentions {
		mentionedIDs = nil
	}
	if err := s.insertMessageMentionRowsTx(ctx, tx, msgID, mentionedIDs); err != nil {
		return SendMessageResult{}, fmt.Errorf("chat.SendMessage %w", err)
	}
	mentionDeliveries, skipAlertRecipientIDs, err := s.createMentionNotificationsTx(ctx, tx, mentionNotificationContext{
		channelID:        p.ChannelID,
		actorID:          p.SenderID,
		messageID:        msgID,
		threadRootID:     p.ThreadRootMessageID,
		body:             bodyToStore,
		conversationKind: conversationKind,
		mentionedIDs:     mentionedIDs,
	})
	if err != nil {
		return SendMessageResult{}, fmt.Errorf("chat.SendMessage %w", err)
	}
	directDeliveries = append(directDeliveries, mentionDeliveries...)

	// Build and emit message_created event.
	mentionedStrs := uuidsToStrings(mentionedIDs)
	createdAtTS := timestamppb.New(createdAt)

	msgProto := &packetspb.MessageEvent{
		ConversationId:   p.ChannelID.String(),
		MessageId:        msgID.String(),
		SenderId:         p.SenderID.String(),
		Body:             bodyToStore,
		ChannelSeq:       channelSeq,
		CreatedAt:        createdAtTS,
		MentionedUserIds: mentionedStrs,
		MentionEveryone:  mentionEveryone,
		Attachments:      toProtoMessageAttachments(attachments),
		Entities:         toProtoMessageEntities(normalizedEntities),
		ContentMode:      mapMessageContentMode(contentMode),
		SenderDeviceId:   uuidStringOrEmpty(p.SenderDeviceID),
		EncryptedDmPayload: &packetspb.EncryptedDMMessagePayload{
			Recipients: toProtoEncryptedDMRecipientPayloads(p.EncryptedDMPayloads),
		},
	}
	if p.ForwardedFrom != nil {
		msgProto.ForwardedFromMessageId = p.ForwardedFrom.MessageID.String()
		msgProto.ForwardedFromSenderId = p.ForwardedFrom.SenderID.String()
		msgProto.ForwardedFromSenderName = p.ForwardedFrom.SenderName
		msgProto.ForwardedFromConversationKind = strings.TrimSpace(p.ForwardedFrom.ConversationKind)
		msgProto.ForwardedFromConversationTitle = strings.TrimSpace(p.ForwardedFrom.ConversationTitle)
		msgProto.ForwardedFromThreadTitle = strings.TrimSpace(p.ForwardedFrom.ThreadTitle)
	}
	if isReply {
		msgProto.ThreadRootMessageId = p.ThreadRootMessageID.String()
		msgProto.ThreadSeq = threadSeq
	}

	msgServerEvt := &packetspb.ServerEvent{
		EventType:      packetspb.EventType_EVENT_TYPE_MESSAGE_CREATED,
		ConversationId: p.ChannelID.String(),
		Payload:        &packetspb.ServerEvent_MessageCreated{MessageCreated: msgProto},
	}
	if err := s.appendAndNotifyTx(ctx, tx, "message_created", p.ChannelID.String(), msgProto, msgServerEvt); err != nil {
		return SendMessageResult{}, fmt.Errorf("chat.SendMessage %w", err)
	}

	// Emit thread_summary_updated for thread replies.
	if isReply {
		var replyCount int32
		var nextSeq int64
		if err := tx.QueryRow(ctx,
			`SELECT reply_count, next_thread_seq FROM thread_summaries WHERE root_message_id = $1`,
			p.ThreadRootMessageID,
		).Scan(&replyCount, &nextSeq); err != nil {
			return SendMessageResult{}, fmt.Errorf("chat.SendMessage re-fetch thread summary: %w", err)
		}

		tsEvt := &packetspb.ThreadSummaryUpdatedEvent{
			ConversationId:        p.ChannelID.String(),
			ThreadRootMessageId:   p.ThreadRootMessageID.String(),
			ReplyCount:            replyCount,
			LastThreadReplyAt:     timestamppb.New(threadReplyAt),
			LastThreadReplyUserId: p.SenderID.String(),
			LastThreadSeq:         nextSeq - 1,
		}
		tsServerEvt := &packetspb.ServerEvent{
			EventType:      packetspb.EventType_EVENT_TYPE_THREAD_SUMMARY_UPDATED,
			ConversationId: p.ChannelID.String(),
			Payload:        &packetspb.ServerEvent_ThreadSummaryUpdated{ThreadSummaryUpdated: tsEvt},
		}
		if err := s.appendAndNotifyTx(ctx, tx, "thread_summary_updated", p.ChannelID.String(), tsEvt, tsServerEvt); err != nil {
			return SendMessageResult{}, fmt.Errorf("chat.SendMessage %w", err)
		}

		recipients, err := s.threadNotificationRecipientsTx(ctx, tx, p.ThreadRootMessageID, p.SenderID)
		if err != nil {
			return SendMessageResult{}, fmt.Errorf("chat.SendMessage thread recipients: %w", err)
		}
		for _, recipientID := range recipients {
			// Check notification level before creating a thread reply notification.
			recipientLevel, err := s.getNotificationLevelTx(ctx, tx, p.ChannelID, recipientID)
			if err != nil {
				return SendMessageResult{}, fmt.Errorf("chat.SendMessage thread notification level check: %w", err)
			}
			if recipientLevel == notificationLevelNothing {
				continue // fully muted — skip notification
			}
			// Thread replies are treated like mentions for MENTIONS_ONLY:
			// the user participated in the thread, so they should be notified.
			skipAlertRecipientIDs[recipientID] = struct{}{}
			delivery, err := s.createNotificationTx(ctx, tx, createNotificationParams{
				UserID:         recipientID,
				ChannelID:      p.ChannelID,
				Type:           "thread_reply",
				Title:          "Thread reply",
				Body:           p.Body,
				ConversationID: p.ChannelID.String(),
				MessageID:      msgID,
				ThreadRootID:   p.ThreadRootMessageID,
			})
			if err != nil {
				return SendMessageResult{}, fmt.Errorf("chat.SendMessage create thread notification: %w", err)
			}
			directDeliveries = append(directDeliveries, delivery)
		}
	}

	readCounterDeliveries, err := s.buildUnreadRecalcDeliveriesForChannelMembersTx(ctx, tx, p.ChannelID)
	if err != nil {
		return SendMessageResult{}, fmt.Errorf("chat.SendMessage build unread deliveries: %w", err)
	}
	directDeliveries = append(directDeliveries, readCounterDeliveries...)

	if !isReply {
		directDeliveries = append(directDeliveries, s.buildMessageAlertDeliveries(
			p.ChannelID,
			msgID,
			p.ThreadRootMessageID,
			p.SenderID,
			senderName,
			messageAlertBody(contentMode, p.Body),
			len(attachments),
			alertRecipients,
			isDMConversation,
			skipAlertRecipientIDs,
		)...)
	}

	if err := tx.Commit(ctx); err != nil {
		return SendMessageResult{}, fmt.Errorf("chat.SendMessage commit: %w", err)
	}

	return SendMessageResult{
		MessageID:        msgID,
		ChannelSeq:       channelSeq,
		CreatedAt:        createdAtTS,
		ClientMsgID:      clientMsgID,
		Deduped:          false,
		DirectDeliveries: directDeliveries,
	}, nil
}

func mapMessageContentMode(raw string) packetspb.MessageContentMode {
	switch raw {
	case MessageContentDMPairwiseSignal:
		return packetspb.MessageContentMode_MESSAGE_CONTENT_MODE_DM_PAIRWISE_SIGNAL_V1
	default:
		return packetspb.MessageContentMode_MESSAGE_CONTENT_MODE_PLAINTEXT
	}
}

func uuidStringOrEmpty(id uuid.UUID) string {
	if id == uuid.Nil {
		return ""
	}
	return id.String()
}

func optionalUUID(ids []uuid.UUID) uuid.UUID {
	if len(ids) == 0 {
		return uuid.Nil
	}
	return ids[0]
}

func messageAlertBody(contentMode, body string) string {
	if contentMode == MessageContentDMPairwiseSignal {
		return "New encrypted message"
	}
	return body
}

func toProtoEncryptedDMRecipientPayloads(items []EncryptedDMRecipientPayload) []*packetspb.EncryptedDMRecipientPayload {
	if len(items) == 0 {
		return nil
	}
	out := make([]*packetspb.EncryptedDMRecipientPayload, 0, len(items))
	for _, item := range items {
		out = append(out, &packetspb.EncryptedDMRecipientPayload{
			RecipientDeviceId: item.RecipientDeviceID.String(),
			SenderDeviceId:    item.SenderDeviceID.String(),
			Algorithm:         item.Algorithm,
			SessionMessage:    append([]byte(nil), item.SessionMessage...),
			MetadataAad:       append([]byte(nil), item.MetadataAAD...),
		})
	}
	return out
}

type membershipNoticeAction string

const (
	membershipNoticeAdded   membershipNoticeAction = "added to"
	membershipNoticeRemoved membershipNoticeAction = "removed from"
)

func (s *Service) createMembershipChangeNoticeTx(
	ctx context.Context,
	tx pgx.Tx,
	channelID, actorID, targetUserID uuid.UUID,
	action membershipNoticeAction,
) ([]DirectDelivery, error) {
	actorLabel, err := s.userNoticeLabelTx(ctx, tx, actorID)
	if err != nil {
		return nil, fmt.Errorf("load actor label: %w", err)
	}
	targetLabel, err := s.userNoticeLabelTx(ctx, tx, targetUserID)
	if err != nil {
		return nil, fmt.Errorf("load target label: %w", err)
	}

	targetMentionLabel := "@" + targetLabel
	middle := fmt.Sprintf(" was %s this channel by ", action)
	actorMentionLabel := "@" + actorLabel
	body := targetMentionLabel + middle + actorMentionLabel
	targetMention := MessageEntity{
		Kind:     MessageEntityKindUser,
		TargetID: targetUserID,
		Label:    targetMentionLabel,
		Start:    0,
		End:      int32(len([]rune(targetMentionLabel))),
	}
	actorMention := MessageEntity{
		Kind:     MessageEntityKindUser,
		TargetID: actorID,
		Label:    actorMentionLabel,
		Start:    int32(len([]rune(targetMentionLabel + middle))),
		End:      int32(len([]rune(body))),
	}

	var msgID uuid.UUID
	var channelSeq int64
	var createdAt time.Time
	if err := tx.QueryRow(ctx, `
		WITH seq AS (
		    UPDATE channels
		    SET next_seq = next_seq + 1,
		        last_activity_at = now()
		    WHERE id = $1
		    RETURNING next_seq
		)
		INSERT INTO messages (channel_id, channel_seq, sender_id, client_msg_id, body, mention_everyone, created_at)
		VALUES ($1, (SELECT next_seq FROM seq), $2, $3, $4, false, now())
		RETURNING id, channel_seq, created_at`,
		channelID,
		actorID,
		"membership:"+strings.ReplaceAll(string(action), " ", "-")+":"+uuid.NewString(),
		body,
	).Scan(&msgID, &channelSeq, &createdAt); err != nil {
		return nil, fmt.Errorf("insert message: %w", err)
	}

	entities := []MessageEntity{targetMention, actorMention}
	if err := s.insertMessageEntitiesTx(ctx, tx, msgID, entities); err != nil {
		return nil, fmt.Errorf("insert entities: %w", err)
	}

	msgProto := &packetspb.MessageEvent{
		ConversationId:  channelID.String(),
		MessageId:       msgID.String(),
		SenderId:        actorID.String(),
		Body:            body,
		ChannelSeq:      channelSeq,
		CreatedAt:       timestamppb.New(createdAt),
		MentionEveryone: false,
		Entities:        toProtoMessageEntities(entities),
	}
	msgServerEvt := &packetspb.ServerEvent{
		EventType:      packetspb.EventType_EVENT_TYPE_MESSAGE_CREATED,
		ConversationId: channelID.String(),
		Payload:        &packetspb.ServerEvent_MessageCreated{MessageCreated: msgProto},
	}
	if err := s.appendAndNotifyTx(ctx, tx, "message_created", channelID.String(), msgProto, msgServerEvt); err != nil {
		return nil, err
	}

	deliveries, err := s.buildUnreadRecalcDeliveriesForChannelMembersTx(ctx, tx, channelID)
	if err != nil {
		return nil, fmt.Errorf("build unread deliveries: %w", err)
	}
	return deliveries, nil
}

func (s *Service) userNoticeLabelTx(ctx context.Context, tx pgx.Tx, userID uuid.UUID) (string, error) {
	var label string
	if err := tx.QueryRow(ctx,
		`SELECT COALESCE(NULLIF(display_name, ''), email) FROM users WHERE id = $1`,
		userID,
	).Scan(&label); err != nil {
		return "", err
	}
	return strings.TrimSpace(label), nil
}

// EditMessage updates body/mentions for an existing message authored by actor.
// The mutation emits message_updated and recalculates unread counters for members.
func (s *Service) EditMessage(ctx context.Context, p EditMessageParams) (EditMessageResult, error) {
	p.Body = strings.TrimSpace(p.Body)

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return EditMessageResult{}, fmt.Errorf("chat.EditMessage begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	target, err := s.loadMessageMutationTargetTx(ctx, tx, p.MessageID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return EditMessageResult{}, ErrMessageNotFound
		}
		return EditMessageResult{}, fmt.Errorf("chat.EditMessage load message: %w", err)
	}

	isMember, err := s.isChannelMemberTx(ctx, tx, target.ChannelID, p.ActorID)
	if err != nil {
		return EditMessageResult{}, fmt.Errorf("chat.EditMessage membership check: %w", err)
	}
	if !isMember {
		return EditMessageResult{}, ErrNotMember
	}
	if target.SenderID != p.ActorID {
		return EditMessageResult{}, ErrMessageNotAuthor
	}
	if target.ContentMode == MessageContentDMPairwiseSignal {
		return EditMessageResult{}, ErrEncryptedMessageUnsupported
	}

	attachmentCount, err := s.messageAttachmentCountTx(ctx, tx, p.MessageID)
	if err != nil {
		return EditMessageResult{}, fmt.Errorf("chat.EditMessage count attachments: %w", err)
	}
	if p.Body == "" && attachmentCount == 0 {
		return EditMessageResult{}, ErrEmptyMessage
	}
	normalizedEntities, err := s.validateAndNormalizeMessageEntities(ctx, tx, target.ChannelID, p.ActorID, p.Body, p.Entities)
	if err != nil {
		return EditMessageResult{}, err
	}
	previousEntitiesByMessageID, err := s.loadMessageEntitiesByMessageIDsTx(ctx, tx, []uuid.UUID{p.MessageID})
	if err != nil {
		return EditMessageResult{}, fmt.Errorf("chat.EditMessage load previous entities: %w", err)
	}
	previousMentionedUserIDs := mentionedUserIDsFromEntities(previousEntitiesByMessageID[p.MessageID.String()])

	mentionEveryone := detectMentionEveryone(p.Body)
	var editedAt time.Time
	if err := tx.QueryRow(ctx, `
		UPDATE messages
		   SET body = $1,
		       mention_everyone = $2,
		       edited_at = now()
		 WHERE id = $3
		 RETURNING edited_at`,
		p.Body, mentionEveryone, p.MessageID,
	).Scan(&editedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return EditMessageResult{}, ErrMessageNotFound
		}
		return EditMessageResult{}, fmt.Errorf("chat.EditMessage update message: %w", err)
	}

	if _, err := tx.Exec(ctx, `DELETE FROM message_mentions WHERE message_id = $1`, p.MessageID); err != nil {
		return EditMessageResult{}, fmt.Errorf("chat.EditMessage clear mentions: %w", err)
	}
	if err := s.insertMessageEntitiesTx(ctx, tx, p.MessageID, normalizedEntities); err != nil {
		return EditMessageResult{}, fmt.Errorf("chat.EditMessage save entities: %w", err)
	}
	mentionedIDs := mentionedUserIDsFromEntities(normalizedEntities)
	if err := s.insertMessageMentionRowsTx(ctx, tx, p.MessageID, mentionedIDs); err != nil {
		return EditMessageResult{}, fmt.Errorf("chat.EditMessage %w", err)
	}

	previousMentionSet := make(map[uuid.UUID]struct{}, len(previousMentionedUserIDs))
	for _, uid := range previousMentionedUserIDs {
		previousMentionSet[uid] = struct{}{}
	}
	conversationKind, err := s.conversationKindTx(ctx, tx, target.ChannelID)
	if err != nil {
		return EditMessageResult{}, fmt.Errorf("chat.EditMessage conversation kind: %w", err)
	}
	directDeliveries, _, err := s.createMentionNotificationsTx(ctx, tx, mentionNotificationContext{
		channelID:          target.ChannelID,
		actorID:            p.ActorID,
		messageID:          p.MessageID,
		threadRootID:       target.ThreadRootID,
		body:               p.Body,
		conversationKind:   conversationKind,
		mentionedIDs:       mentionedIDs,
		previousMentionSet: previousMentionSet,
	})
	if err != nil {
		return EditMessageResult{}, fmt.Errorf("chat.EditMessage %w", err)
	}

	unreadDeliveries, err := s.buildUnreadRecalcDeliveriesForChannelMembersTx(ctx, tx, target.ChannelID)
	if err != nil {
		return EditMessageResult{}, fmt.Errorf("chat.EditMessage build unread deliveries: %w", err)
	}
	directDeliveries = append(directDeliveries, unreadDeliveries...)

	updatedEvt := &packetspb.MessageUpdatedEvent{
		ConversationId:   target.ChannelID.String(),
		MessageId:        p.MessageID.String(),
		Body:             p.Body,
		MentionedUserIds: uuidsToStrings(mentionedIDs),
		MentionEveryone:  mentionEveryone,
		EditedAt:         timestamppb.New(editedAt),
		Entities:         toProtoMessageEntities(normalizedEntities),
	}
	updatedServerEvt := &packetspb.ServerEvent{
		EventType:      packetspb.EventType_EVENT_TYPE_MESSAGE_UPDATED,
		ConversationId: target.ChannelID.String(),
		Payload:        &packetspb.ServerEvent_MessageUpdated{MessageUpdated: updatedEvt},
	}
	if err := s.appendAndNotifyTx(ctx, tx, "message_updated", target.ChannelID.String(), updatedEvt, updatedServerEvt); err != nil {
		return EditMessageResult{}, fmt.Errorf("chat.EditMessage %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return EditMessageResult{}, fmt.Errorf("chat.EditMessage commit: %w", err)
	}

	return EditMessageResult{
		ChannelID:        target.ChannelID,
		MessageID:        p.MessageID,
		Body:             p.Body,
		Entities:         normalizedEntities,
		MentionEveryone:  mentionEveryone,
		MentionedUserIDs: mentionedIDs,
		EditedAt:         timestamppb.New(editedAt),
		DirectDeliveries: directDeliveries,
	}, nil
}

// DeleteMessage permits either secret-DM member to purge a message. Other
// conversations retain author-only deletion and message_deleted events.
// Thread replies update thread summaries; deleting a root cascades to replies.
func (s *Service) DeleteMessage(ctx context.Context, p DeleteMessageParams) (DeleteMessageResult, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return DeleteMessageResult{}, fmt.Errorf("chat.DeleteMessage begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	target, err := s.loadMessageMutationTargetTx(ctx, tx, p.MessageID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return DeleteMessageResult{}, ErrMessageNotFound
		}
		return DeleteMessageResult{}, fmt.Errorf("chat.DeleteMessage load message: %w", err)
	}

	isMember, err := s.isChannelMemberTx(ctx, tx, target.ChannelID, p.ActorID)
	if err != nil {
		return DeleteMessageResult{}, fmt.Errorf("chat.DeleteMessage membership check: %w", err)
	}
	if !isMember {
		return DeleteMessageResult{}, ErrNotMember
	}
	var isSecretDM bool
	if err := tx.QueryRow(ctx, `
		SELECT kind = 'dm' AND visibility = 'dm' AND encryption_mode = 'dm_pairwise_signal_v1'
		  FROM channels WHERE id = $1 FOR UPDATE`, target.ChannelID).Scan(&isSecretDM); err != nil {
		return DeleteMessageResult{}, fmt.Errorf("chat.DeleteMessage conversation: %w", err)
	}
	if target.SenderID != p.ActorID && !isSecretDM {
		return DeleteMessageResult{}, ErrMessageNotAuthor
	}

	attachmentsToDelete, err := s.listMessageAttachmentsForDeleteTargetTx(ctx, tx, p.MessageID)
	if err != nil {
		return DeleteMessageResult{}, fmt.Errorf("chat.DeleteMessage list attachments: %w", err)
	}
	if isSecretDM {
		if err := s.purgeSecretMessageTracesTx(ctx, tx, target); err != nil {
			return DeleteMessageResult{}, fmt.Errorf("chat.DeleteMessage purge: %w", err)
		}
		if err := s.deleteSecretAttachmentObjects(ctx, attachmentsToDelete); err != nil {
			return DeleteMessageResult{}, ErrSecretMessagePurgeIncomplete
		}
	}

	var deletedMessageID uuid.UUID
	var deletedChannelID uuid.UUID
	var deletedThreadRootID uuid.NullUUID
	if err := tx.QueryRow(ctx, `
		DELETE FROM messages
		 WHERE id = $1
		 RETURNING id, channel_id, thread_root_id`,
		p.MessageID,
	).Scan(&deletedMessageID, &deletedChannelID, &deletedThreadRootID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return DeleteMessageResult{}, ErrMessageNotFound
		}
		return DeleteMessageResult{}, fmt.Errorf("chat.DeleteMessage delete message: %w", err)
	}

	threadRootID := uuid.Nil
	if deletedThreadRootID.Valid {
		threadRootID = deletedThreadRootID.UUID

		replyCount, lastThreadSeq, lastReplyAt, lastReplyUserID, err := s.rebuildThreadSummaryAfterReplyDeleteTx(ctx, tx, threadRootID)
		if err != nil {
			return DeleteMessageResult{}, fmt.Errorf("chat.DeleteMessage rebuild thread summary: %w", err)
		}
		tsEvt := &packetspb.ThreadSummaryUpdatedEvent{
			ConversationId:      deletedChannelID.String(),
			ThreadRootMessageId: threadRootID.String(),
			ReplyCount:          replyCount,
			LastThreadSeq:       lastThreadSeq,
		}
		if !lastReplyAt.IsZero() {
			tsEvt.LastThreadReplyAt = timestamppb.New(lastReplyAt)
		}
		if lastReplyUserID != uuid.Nil {
			tsEvt.LastThreadReplyUserId = lastReplyUserID.String()
		}
		tsServerEvt := &packetspb.ServerEvent{
			EventType:      packetspb.EventType_EVENT_TYPE_THREAD_SUMMARY_UPDATED,
			ConversationId: deletedChannelID.String(),
			Payload:        &packetspb.ServerEvent_ThreadSummaryUpdated{ThreadSummaryUpdated: tsEvt},
		}
		if err := s.appendAndNotifyTx(ctx, tx, "thread_summary_updated", deletedChannelID.String(), tsEvt, tsServerEvt); err != nil {
			return DeleteMessageResult{}, fmt.Errorf("chat.DeleteMessage %w", err)
		}
	}

	directDeliveries, err := s.buildUnreadRecalcDeliveriesForChannelMembersTx(ctx, tx, deletedChannelID)
	if err != nil {
		return DeleteMessageResult{}, fmt.Errorf("chat.DeleteMessage build unread deliveries: %w", err)
	}

	deletedEvt := &packetspb.MessageDeletedEvent{
		ConversationId: deletedChannelID.String(),
		MessageId:      deletedMessageID.String(),
	}
	if threadRootID != uuid.Nil {
		deletedEvt.ThreadRootMessageId = threadRootID.String()
	}
	deletedServerEvt := &packetspb.ServerEvent{
		EventType:      packetspb.EventType_EVENT_TYPE_MESSAGE_DELETED,
		ConversationId: deletedChannelID.String(),
		Payload:        &packetspb.ServerEvent_MessageDeleted{MessageDeleted: deletedEvt},
	}
	if isSecretDM {
		refresh := &packetspb.SecretHistoryInvalidatedEvent{ConversationId: deletedChannelID.String()}
		evt := &packetspb.ServerEvent{
			EventType:      packetspb.EventType_EVENT_TYPE_SECRET_HISTORY_INVALIDATED,
			ConversationId: deletedChannelID.String(),
			Payload:        &packetspb.ServerEvent_SecretHistoryInvalidated{SecretHistoryInvalidated: refresh},
		}
		if err := s.appendAndNotifyTx(ctx, tx, "secret_history_invalidated", deletedChannelID.String(), refresh, evt); err != nil {
			return DeleteMessageResult{}, fmt.Errorf("chat.DeleteMessage %w", err)
		}
	} else {
		if err := s.appendAndNotifyTx(ctx, tx, "message_deleted", deletedChannelID.String(), deletedEvt, deletedServerEvt); err != nil {
			return DeleteMessageResult{}, fmt.Errorf("chat.DeleteMessage %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return DeleteMessageResult{}, fmt.Errorf("chat.DeleteMessage commit: %w", err)
	}

	if !isSecretDM {
		s.cleanupDeletedAttachments(attachmentsToDelete)
	}

	return DeleteMessageResult{
		ChannelID:        deletedChannelID,
		MessageID:        deletedMessageID,
		ThreadRootID:     threadRootID,
		DirectDeliveries: directDeliveries,
	}, nil
}

func (s *Service) ClearDMConversationHistory(ctx context.Context, p ClearDMConversationHistoryParams) (ClearDMConversationHistoryResult, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ClearDMConversationHistoryResult{}, fmt.Errorf("chat.ClearDMConversationHistory begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var kind string
	var visibility string
	var isMember bool
	if err := tx.QueryRow(ctx, `
		SELECT c.kind,
		       c.visibility,
		       EXISTS (
		         SELECT 1
		           FROM channel_members cm
		          WHERE cm.channel_id = c.id
		            AND cm.user_id = $2
		            AND cm.is_archived = false
		       ) AS is_member
		  FROM channels c
		 WHERE c.id = $1
		   AND c.is_archived = false
		   AND c.hidden = false`,
		p.ConversationID,
		p.ActorID,
	).Scan(&kind, &visibility, &isMember); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ClearDMConversationHistoryResult{}, ErrNotMember
		}
		return ClearDMConversationHistoryResult{}, fmt.Errorf("chat.ClearDMConversationHistory load conversation: %w", err)
	}
	if !isMember {
		return ClearDMConversationHistoryResult{}, ErrNotMember
	}
	if kind != "dm" || visibility != "dm" {
		return ClearDMConversationHistoryResult{}, ErrClearHistoryUnsupported
	}

	attachmentsToDelete, err := s.listMessageAttachmentsForConversationDeleteTx(ctx, tx, p.ConversationID)
	if err != nil {
		return ClearDMConversationHistoryResult{}, fmt.Errorf("chat.ClearDMConversationHistory list attachments: %w", err)
	}

	if _, err := tx.Exec(ctx, `
		DELETE FROM notifications
		 WHERE channel_id = $1`,
		p.ConversationID,
	); err != nil {
		return ClearDMConversationHistoryResult{}, fmt.Errorf("chat.ClearDMConversationHistory delete notifications: %w", err)
	}

	if _, err := tx.Exec(ctx, `
		DELETE FROM message_recipient_ciphertexts mrc
		 USING messages m
		 WHERE mrc.message_id = m.id
		   AND m.channel_id = $1`,
		p.ConversationID,
	); err != nil {
		return ClearDMConversationHistoryResult{}, fmt.Errorf("chat.ClearDMConversationHistory delete encrypted payloads: %w", err)
	}

	var deletedMessagesCount int32
	if err := tx.QueryRow(ctx, `
		WITH deleted AS (
			DELETE FROM messages
			 WHERE channel_id = $1
			 RETURNING id
		)
		SELECT COUNT(*)::int
		  FROM deleted`,
		p.ConversationID,
	).Scan(&deletedMessagesCount); err != nil {
		return ClearDMConversationHistoryResult{}, fmt.Errorf("chat.ClearDMConversationHistory delete messages: %w", err)
	}

	clearedEvt := &packetspb.DmHistoryClearedEvent{
		ConversationId:       p.ConversationID.String(),
		ClearedByUserId:      p.ActorID.String(),
		DeletedMessagesCount: deletedMessagesCount,
	}
	clearedServerEvt := &packetspb.ServerEvent{
		EventType:      packetspb.EventType_EVENT_TYPE_DM_HISTORY_CLEARED,
		ConversationId: p.ConversationID.String(),
		Payload:        &packetspb.ServerEvent_DmHistoryCleared{DmHistoryCleared: clearedEvt},
	}
	if err := s.appendAndNotifyTx(ctx, tx, "dm_history_cleared", p.ConversationID.String(), clearedEvt, clearedServerEvt); err != nil {
		return ClearDMConversationHistoryResult{}, fmt.Errorf("chat.ClearDMConversationHistory %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return ClearDMConversationHistoryResult{}, fmt.Errorf("chat.ClearDMConversationHistory commit: %w", err)
	}

	s.cleanupDeletedAttachments(attachmentsToDelete)

	return ClearDMConversationHistoryResult{
		ConversationID:       p.ConversationID,
		DeletedMessagesCount: deletedMessagesCount,
	}, nil
}

type existingMessageRow struct {
	ID          uuid.UUID
	ChannelSeq  int64
	ClientMsgID string
	CreatedAt   time.Time
}

type createNotificationParams struct {
	UserID         uuid.UUID
	ChannelID      uuid.UUID
	Type           string
	Title          string
	Body           string
	ConversationID string
	MessageID      uuid.UUID
	ThreadRootID   uuid.UUID
}

func (s *Service) findMessageByClientMsgID(ctx context.Context, channelID, senderID uuid.UUID, clientMsgID string) (existingMessageRow, error) {
	row, err := s.q.FindMessageByClientMsgID(ctx, queries.FindMessageByClientMsgIDParams{
		ChannelID:   channelID,
		SenderID:    senderID,
		ClientMsgID: clientMsgID,
	})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return existingMessageRow{}, sql.ErrNoRows
		}
		return existingMessageRow{}, err
	}
	return existingMessageRow{
		ID:          row.ID,
		ChannelSeq:  row.ChannelSeq,
		ClientMsgID: row.ClientMsgID,
		CreatedAt:   row.CreatedAt,
	}, nil
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func (s *Service) messageChannelByID(ctx context.Context, messageID uuid.UUID) (uuid.UUID, error) {
	channelID, err := s.q.GetMessageChannelID(ctx, messageID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return uuid.Nil, sql.ErrNoRows
		}
		return uuid.Nil, err
	}
	return channelID, nil
}

func (s *Service) messageChannelByIDTx(ctx context.Context, tx pgx.Tx, messageID uuid.UUID) (uuid.UUID, error) {
	var channelID uuid.UUID
	err := tx.QueryRow(ctx, `SELECT channel_id FROM messages WHERE id = $1`, messageID).Scan(&channelID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return uuid.Nil, sql.ErrNoRows
		}
		return uuid.Nil, err
	}
	return channelID, nil
}

type messageMutationTarget struct {
	MessageID    uuid.UUID
	ChannelID    uuid.UUID
	SenderID     uuid.UUID
	ThreadRootID uuid.UUID
	ContentMode  string
}

func (s *Service) loadMessageMutationTargetTx(ctx context.Context, tx pgx.Tx, messageID uuid.UUID) (messageMutationTarget, error) {
	var target messageMutationTarget
	var threadRootID uuid.NullUUID
	err := tx.QueryRow(ctx, `
		SELECT id, channel_id, sender_id, thread_root_id, content_mode
		  FROM messages
		 WHERE id = $1
		 FOR UPDATE`,
		messageID,
	).Scan(&target.MessageID, &target.ChannelID, &target.SenderID, &threadRootID, &target.ContentMode)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return messageMutationTarget{}, sql.ErrNoRows
		}
		return messageMutationTarget{}, err
	}
	if threadRootID.Valid {
		target.ThreadRootID = threadRootID.UUID
	}
	return target, nil
}

func (s *Service) messageAttachmentCountTx(ctx context.Context, tx pgx.Tx, messageID uuid.UUID) (int, error) {
	var count int
	if err := tx.QueryRow(ctx, `
		SELECT COUNT(*)::int
		  FROM message_attachment
		 WHERE message_id = $1`,
		messageID,
	).Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
}

func (s *Service) listActiveChannelMemberIDsTx(ctx context.Context, tx pgx.Tx, channelID uuid.UUID) ([]uuid.UUID, error) {
	rows, err := tx.Query(ctx, `
		SELECT user_id
		  FROM channel_members
		 WHERE channel_id = $1
		   AND is_archived = false
		 ORDER BY user_id`,
		channelID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	memberIDs := make([]uuid.UUID, 0)
	for rows.Next() {
		var userID uuid.UUID
		if err := rows.Scan(&userID); err != nil {
			return nil, err
		}
		memberIDs = append(memberIDs, userID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return memberIDs, nil
}

func (s *Service) messageAlertRecipientsTx(ctx context.Context, tx pgx.Tx, channelID, senderID uuid.UUID) ([]messageAlertRecipient, error) {
	rows, err := tx.Query(ctx, `
		SELECT user_id, notification_level
		  FROM channel_members
		 WHERE channel_id = $1
		   AND is_archived = false
		   AND user_id <> $2
		 ORDER BY user_id`,
		channelID, senderID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	recipients := make([]messageAlertRecipient, 0)
	for rows.Next() {
		var recipient messageAlertRecipient
		if err := rows.Scan(&recipient.UserID, &recipient.NotificationLevel); err != nil {
			return nil, err
		}
		recipients = append(recipients, recipient)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return recipients, nil
}

func (s *Service) conversationKindTx(ctx context.Context, tx pgx.Tx, channelID uuid.UUID) (string, error) {
	var kind string
	if err := tx.QueryRow(ctx, `
		SELECT kind
		  FROM channels
		 WHERE id = $1`,
		channelID,
	).Scan(&kind); err != nil {
		return "", err
	}
	return kind, nil
}

func (s *Service) buildUnreadRecalcDeliveriesForChannelMembersTx(ctx context.Context, tx pgx.Tx, channelID uuid.UUID) ([]DirectDelivery, error) {
	memberIDs, err := s.listActiveChannelMemberIDsTx(ctx, tx, channelID)
	if err != nil {
		return nil, err
	}

	deliveries := make([]DirectDelivery, 0, len(memberIDs))
	for _, userID := range memberIDs {
		lastReadSeq, err := s.loadLastReadSeqTx(ctx, tx, channelID, userID)
		if err != nil {
			return nil, err
		}
		counter, err := s.buildUnreadCounterTx(ctx, tx, channelID, userID, lastReadSeq)
		if err != nil {
			return nil, err
		}
		deliveries = append(deliveries, s.buildReadCounterUpdatedDelivery(channelID, userID, counter))
	}
	return deliveries, nil
}

func (s *Service) ListMessageContext(
	ctx context.Context,
	requesterID, conversationID, targetMessageID uuid.UUID,
	beforeLimit int,
	afterLimit int,
	requesterDeviceID ...uuid.UUID,
) ([]ConversationMessage, error) {
	isMember, err := s.q.IsChannelMember(ctx, queries.IsChannelMemberParams{
		ChannelID: conversationID,
		UserID:    requesterID,
	})
	if err != nil {
		return nil, fmt.Errorf("chat.ListMessageContext membership check: %w", err)
	}
	if !isMember {
		return nil, ErrNotMember
	}

	if beforeLimit <= 0 {
		beforeLimit = 20
	}
	if afterLimit <= 0 {
		afterLimit = 20
	}

	rows, err := s.q.ListMessageContextRows(ctx, queries.ListMessageContextRowsParams{
		TargetMessageID: targetMessageID,
		ConversationID:  conversationID,
		RequesterID:     requesterID,
		BeforeLimit:     beforeLimit,
		AfterLimit:      afterLimit,
	})
	if err != nil {
		return nil, fmt.Errorf("chat.ListMessageContext query: %w", err)
	}

	messages := make([]ConversationMessage, 0, len(rows))
	for _, row := range rows {
		item := ConversationMessage{
			ID:               row.ID,
			ConversationID:   row.ChannelID,
			SenderID:         row.SenderID,
			SenderName:       row.DisplayName,
			Body:             row.Body,
			ForwardedFrom:    forwardedMessageInfoFromRow(row.ForwardedFromMessageID, row.ForwardedFromSenderID, row.ForwardedFromSenderName, row.ForwardedFromConversationKind, row.ForwardedFromConversationTitle, row.ForwardedFromThreadTitle),
			ChannelSeq:       row.ChannelSeq,
			ContentMode:      row.ContentMode,
			ThreadSeq:        row.ThreadSeq,
			ThreadReplyCount: int32(row.ThreadReplyCount),
			CreatedAt:        row.CreatedAt,
			MentionEveryone:  row.MentionEveryone,
			IsSaved:          row.IsSaved,
		}
		if row.ThreadRootID.Valid {
			item.ThreadRootMessageID = row.ThreadRootID.UUID
		}
		if row.SenderDeviceID.Valid {
			item.SenderDeviceID = row.SenderDeviceID.UUID
		}
		if row.EditedAt.Valid {
			edited := row.EditedAt.Time
			item.EditedAt = &edited
		}
		if err := hydrateMessageJSONFields(row.Reactions, row.MyReactions, row.Attachments, &item); err != nil {
			return nil, fmt.Errorf("chat.ListMessageContext hydrate: %w", err)
		}
		messages = append(messages, item)
	}
	if len(messages) == 0 {
		return nil, ErrMessageNotFound
	}

	messageIDs := make([]uuid.UUID, 0, len(messages))
	for _, message := range messages {
		messageIDs = append(messageIDs, message.ID)
	}
	entitiesByMessageID, err := s.loadMessageEntitiesByMessageIDs(ctx, messageIDs)
	if err != nil {
		return nil, fmt.Errorf("chat.ListMessageContext load entities: %w", err)
	}
	for i := range messages {
		messages[i].Entities = entitiesByMessageID[messages[i].ID.String()]
	}
	if err := s.hydrateEncryptedDMPayloads(ctx, requesterID, optionalUUID(requesterDeviceID), messages); err != nil {
		return nil, fmt.Errorf("chat.ListMessageContext load encrypted payloads: %w", err)
	}

	return messages, nil
}

func (s *Service) hydrateEncryptedDMPayloads(ctx context.Context, requesterID, requesterDeviceID uuid.UUID, messages []ConversationMessage) error {
	messageIDs := make([]uuid.UUID, 0)
	indexByID := make(map[uuid.UUID]int, len(messages))
	for i, message := range messages {
		if message.ContentMode != MessageContentDMPairwiseSignal {
			continue
		}
		messageIDs = append(messageIDs, message.ID)
		indexByID[message.ID] = i
	}
	if len(messageIDs) == 0 {
		return nil
	}
	allowedDeviceIDs, err := s.activeUserDeviceIDs(ctx, requesterID, requesterDeviceID)
	if err != nil {
		return err
	}
	if len(allowedDeviceIDs) == 0 {
		return nil
	}
	rows, err := s.q.ListMessageRecipientCiphertexts(ctx, messageIDs)
	if err != nil {
		return err
	}
	for _, row := range rows {
		if _, ok := allowedDeviceIDs[row.RecipientDeviceID]; !ok {
			continue
		}
		idx, ok := indexByID[row.MessageID]
		if !ok {
			continue
		}
		messages[idx].EncryptedDMPayloads = append(messages[idx].EncryptedDMPayloads, EncryptedDMRecipientPayload{
			RecipientDeviceID: row.RecipientDeviceID,
			SenderDeviceID:    row.SenderDeviceID,
			Algorithm:         row.Algorithm,
			SessionMessage:    append([]byte(nil), row.SessionMessage...),
			MetadataAAD:       append([]byte(nil), row.MetadataAad...),
		})
	}
	return nil
}

// hydrateMessageJSONFields decodes the reactions / my_reactions / attachments
// JSON aggregates emitted by the message-list queries into the target item.
// Kept as a single helper so ListMessagePage and ListMessageContext cannot drift.
func hydrateMessageJSONFields(reactions, myReactions, attachments any, item *ConversationMessage) error {
	if err := decodeJSONInto(reactions, &item.Reactions); err != nil {
		return fmt.Errorf("reactions: %w", err)
	}
	if err := decodeJSONInto(myReactions, &item.MyReactions); err != nil {
		return fmt.Errorf("my_reactions: %w", err)
	}
	if err := decodeJSONInto(attachments, &item.Attachments); err != nil {
		return fmt.Errorf("attachments: %w", err)
	}
	return nil
}

func decodeJSONInto[T any](v any, dst *T) error {
	raw, err := normalizeJSONValue(v)
	if err != nil {
		return fmt.Errorf("normalize: %w", err)
	}
	if len(raw) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		return fmt.Errorf("decode: %w", err)
	}
	return nil
}

// appendAndNotifyTx marshals a proto payload, appends it to the event store
// inside tx, and issues pg_notify for listeners. Every chat event append goes
// through this helper so the Append/Notify ordering and error wrapping are
// consistent across send, edit, delete, thread, and reaction paths.
func (s *Service) appendAndNotifyTx(
	ctx context.Context,
	tx pgx.Tx,
	eventType, channelID string,
	payload proto.Message,
	wrapper *packetspb.ServerEvent,
) error {
	payloadJSON, err := protojson.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal %s: %w", eventType, err)
	}
	stored, err := s.eventStore.AppendEventTx(ctx, tx, events.AppendParams{
		EventID:      uuid.New().String(),
		EventType:    eventType,
		ChannelID:    channelID,
		PayloadJSON:  payloadJSON,
		ProtoPayload: wrapper,
	})
	if err != nil {
		return fmt.Errorf("append %s: %w", eventType, err)
	}
	if err := s.eventStore.NotifyEventTx(ctx, tx, stored.Seq); err != nil {
		return fmt.Errorf("notify %s: %w", eventType, err)
	}
	return nil
}

// insertMessageMentionRowsTx persists mention target rows for a message.
// Idempotent via ON CONFLICT DO NOTHING so it is safe to re-run on edit paths
// after the caller has cleared the previous set.
func (s *Service) insertMessageMentionRowsTx(ctx context.Context, tx pgx.Tx, messageID uuid.UUID, mentionedIDs []uuid.UUID) error {
	for _, uid := range mentionedIDs {
		if _, err := tx.Exec(ctx,
			`INSERT INTO message_mentions (message_id, user_id, created_at) VALUES ($1, $2, now()) ON CONFLICT DO NOTHING`,
			messageID, uid,
		); err != nil {
			return fmt.Errorf("insert mention row: %w", err)
		}
	}
	return nil
}

type mentionNotificationContext struct {
	channelID          uuid.UUID
	actorID            uuid.UUID
	messageID          uuid.UUID
	threadRootID       uuid.UUID
	body               string
	conversationKind   string
	mentionedIDs       []uuid.UUID
	previousMentionSet map[uuid.UUID]struct{} // nil/empty on send; populated on edit
}

// createMentionNotificationsTx emits mention notifications for eligible users
// and returns the resulting direct deliveries plus the set of recipients that
// were notified (so the caller can skip alerting them twice). The same filters
// apply for send and edit: exclude actor, non-members, DMs, muted recipients,
// and anyone already in previousMentionSet.
func (s *Service) createMentionNotificationsTx(
	ctx context.Context,
	tx pgx.Tx,
	p mentionNotificationContext,
) ([]DirectDelivery, map[uuid.UUID]struct{}, error) {
	deliveries := make([]DirectDelivery, 0)
	notified := make(map[uuid.UUID]struct{})
	if p.conversationKind == "dm" {
		return deliveries, notified, nil
	}
	for _, uid := range p.mentionedIDs {
		if uid == p.actorID {
			continue
		}
		if _, existed := p.previousMentionSet[uid]; existed {
			continue
		}
		isMember, err := s.isChannelMemberTx(ctx, tx, p.channelID, uid)
		if err != nil {
			return nil, nil, fmt.Errorf("mention membership check: %w", err)
		}
		if !isMember {
			continue
		}
		level, err := s.getNotificationLevelTx(ctx, tx, p.channelID, uid)
		if err != nil {
			return nil, nil, fmt.Errorf("mention notification level: %w", err)
		}
		if level == notificationLevelNothing {
			continue
		}
		delivery, err := s.createNotificationTx(ctx, tx, createNotificationParams{
			UserID:         uid,
			ChannelID:      p.channelID,
			Type:           "mention",
			Title:          "Mention",
			Body:           p.body,
			ConversationID: p.channelID.String(),
			MessageID:      p.messageID,
			ThreadRootID:   p.threadRootID,
		})
		if err != nil {
			return nil, nil, fmt.Errorf("create mention notification: %w", err)
		}
		deliveries = append(deliveries, delivery)
		notified[uid] = struct{}{}
	}
	return deliveries, notified, nil
}
