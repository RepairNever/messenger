package chat

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/types/known/timestamppb"

	packetspb "msgnr/internal/gen/proto"
	"msgnr/internal/gen/queries"
)

func (s *Service) UpdateReadCursor(ctx context.Context, p UpdateReadCursorParams) (UpdateReadCursorResult, error) {
	isMember, err := s.q.IsChannelMember(ctx, queries.IsChannelMemberParams{
		ChannelID: p.ChannelID,
		UserID:    p.UserID,
	})
	if err != nil {
		return UpdateReadCursorResult{}, fmt.Errorf("chat.UpdateReadCursor membership check: %w", err)
	}
	if !isMember {
		return UpdateReadCursorResult{}, ErrNotMember
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return UpdateReadCursorResult{}, fmt.Errorf("chat.UpdateReadCursor begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var nextSeq int64
	if err := tx.QueryRow(ctx,
		`SELECT next_seq FROM channels WHERE id = $1`,
		p.ChannelID,
	).Scan(&nextSeq); err != nil {
		return UpdateReadCursorResult{}, fmt.Errorf("chat.UpdateReadCursor load channel seq: %w", err)
	}

	clampedReadSeq := p.LastReadSeq
	if clampedReadSeq < 0 {
		clampedReadSeq = 0
	}
	if clampedReadSeq > nextSeq {
		clampedReadSeq = nextSeq
	}

	var persistedReadSeq int64
	if err := tx.QueryRow(ctx, `
		INSERT INTO message_reads (channel_id, user_id, last_read_seq, updated_at)
		VALUES ($1, $2, $3, now())
		ON CONFLICT (channel_id, user_id) DO UPDATE
		    SET last_read_seq = GREATEST(message_reads.last_read_seq, EXCLUDED.last_read_seq),
		        updated_at = now()
		RETURNING last_read_seq`,
		p.ChannelID, p.UserID, clampedReadSeq,
	).Scan(&persistedReadSeq); err != nil {
		return UpdateReadCursorResult{}, fmt.Errorf("chat.UpdateReadCursor upsert read cursor: %w", err)
	}

	directDeliveries := make([]DirectDelivery, 0, 1)

	counter, err := s.buildUnreadCounterTx(ctx, tx, p.ChannelID, p.UserID, persistedReadSeq)
	if err != nil {
		return UpdateReadCursorResult{}, fmt.Errorf("chat.UpdateReadCursor build unread counter: %w", err)
	}

	directDeliveries = append(directDeliveries, s.buildReadCounterUpdatedDelivery(p.ChannelID, p.UserID, counter))

	resolvedIDs, err := s.resolveConversationNotificationsTx(ctx, tx, p.ChannelID, p.UserID)
	if err != nil {
		return UpdateReadCursorResult{}, fmt.Errorf("chat.UpdateReadCursor resolve notifications: %w", err)
	}
	for _, notificationID := range resolvedIDs {
		directDeliveries = append(directDeliveries, s.buildNotificationResolvedDelivery(p.ChannelID, p.UserID, notificationID))
	}

	if err := tx.Commit(ctx); err != nil {
		return UpdateReadCursorResult{}, fmt.Errorf("chat.UpdateReadCursor commit: %w", err)
	}

	return UpdateReadCursorResult{
		ChannelID:        p.ChannelID,
		LastReadSeq:      persistedReadSeq,
		Counter:          counter,
		DirectDeliveries: directDeliveries,
	}, nil
}

func (s *Service) createNotificationTx(ctx context.Context, tx pgx.Tx, p createNotificationParams) (DirectDelivery, error) {
	var notificationID uuid.UUID
	var createdAt time.Time
	if err := tx.QueryRow(ctx, `
		INSERT INTO notifications (user_id, type, title, body, channel_id, message_id, thread_root_message_id, is_read, created_at)
		VALUES ($1, $2, $3, $4, $5, NULLIF($6::uuid, $7::uuid), NULLIF($8::uuid, $7::uuid), false, now())
		RETURNING id, created_at`,
		p.UserID, p.Type, p.Title, p.Body, p.ChannelID, p.MessageID, uuid.Nil, p.ThreadRootID,
	).Scan(&notificationID, &createdAt); err != nil {
		return DirectDelivery{}, err
	}

	messageID := ""
	if p.MessageID != uuid.Nil {
		messageID = p.MessageID.String()
	}
	threadRootID := ""
	if p.ThreadRootID != uuid.Nil {
		threadRootID = p.ThreadRootID.String()
	}
	notification := &packetspb.NotificationSummary{
		NotificationId:      notificationID.String(),
		Type:                notificationTypeToProto(p.Type),
		Title:               p.Title,
		Body:                p.Body,
		ConversationId:      p.ConversationID,
		IsRead:              false,
		CreatedAt:           timestamppb.New(createdAt),
		MessageId:           messageID,
		ThreadRootMessageId: threadRootID,
	}
	serverEvt := &packetspb.ServerEvent{
		EventType:      packetspb.EventType_EVENT_TYPE_NOTIFICATION_ADDED,
		ConversationId: p.ConversationID,
		Payload: &packetspb.ServerEvent_NotificationAdded{
			NotificationAdded: &packetspb.NotificationAddedEvent{
				Notification: notification,
				UserId:       p.UserID.String(),
			},
		},
	}
	return DirectDelivery{UserID: p.UserID.String(), Event: serverEvt}, nil
}

func parseUUIDOrNil(raw string) uuid.UUID {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return uuid.Nil
	}
	parsed, err := uuid.Parse(raw)
	if err != nil {
		return uuid.Nil
	}
	return parsed
}

func buildUnreadFeedItemID(kind string, id uuid.UUID, fallback string) string {
	if id != uuid.Nil {
		return kind + ":" + id.String()
	}
	fallback = strings.TrimSpace(fallback)
	if fallback != "" {
		return kind + ":" + fallback
	}
	return kind + ":missing"
}

func unreadFeedNotificationKind(notificationType string) string {
	if notificationType == "thread_reply" {
		return "thread"
	}
	return "mention"
}

func (s *Service) listUnreadNotificationFeedItems(ctx context.Context, userID uuid.UUID) ([]UnreadFeedItem, error) {
	rows, err := s.q.ListUnreadNotificationFeedItems(ctx, queries.ListUnreadNotificationFeedItemsParams{
		UserID:                   userID,
		NotificationLevelNothing: notificationLevelNothing,
	})
	if err != nil {
		return nil, err
	}

	items := make([]UnreadFeedItem, 0, len(rows))
	for _, row := range rows {
		notificationID := parseUUIDOrNil(row.NotificationID)
		kind := unreadFeedNotificationKind(row.Type)
		items = append(items, UnreadFeedItem{
			ID:                     buildUnreadFeedItemID(kind, notificationID, "notif:"+row.NotificationID),
			Kind:                   kind,
			NotificationID:         notificationID,
			ConversationID:         parseUUIDOrNil(row.ConversationID),
			ConversationKind:       row.Kind,
			ConversationVisibility: row.Visibility,
			ConversationTitle:      row.ConversationTitle,
			MessageID:              parseUUIDOrNil(row.MessageID),
			ThreadRootMessageID:    parseUUIDOrNil(row.ThreadRootMessageID),
			SenderID:               parseUUIDOrNil(row.SenderID),
			SenderName:             row.SenderName,
			Body:                   row.Body,
			CreatedAt:              row.CreatedAt,
		})
	}
	return items, nil
}

func (s *Service) listUnreadRootMessageFeedItems(ctx context.Context, userID uuid.UUID) ([]UnreadFeedItem, error) {
	rows, err := s.q.ListUnreadRootMessageFeedItems(ctx, queries.ListUnreadRootMessageFeedItemsParams{
		UserID:               userID,
		NotificationLevelAll: notificationLevelAll,
	})
	if err != nil {
		return nil, err
	}

	items := make([]UnreadFeedItem, 0, len(rows))
	for _, row := range rows {
		parsedMessageID := parseUUIDOrNil(row.MessageID)
		items = append(items, UnreadFeedItem{
			ID:                     buildUnreadFeedItemID("message", parsedMessageID, ""),
			Kind:                   "message",
			ConversationID:         parseUUIDOrNil(row.ConversationID),
			ConversationKind:       row.Kind,
			ConversationVisibility: row.Visibility,
			ConversationTitle:      row.ConversationTitle,
			MessageID:              parsedMessageID,
			SenderID:               parseUUIDOrNil(row.SenderID),
			SenderName:             row.SenderName,
			Body:                   row.Body,
			CreatedAt:              row.CreatedAt,
		})
	}
	return items, nil
}

func (s *Service) ListUnreadFeed(ctx context.Context, userID uuid.UUID) ([]UnreadFeedItem, error) {
	notificationItems, err := s.listUnreadNotificationFeedItems(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("chat.ListUnreadFeed notifications: %w", err)
	}
	rootMessages, err := s.listUnreadRootMessageFeedItems(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("chat.ListUnreadFeed messages: %w", err)
	}

	mentionedRootIDs := make(map[uuid.UUID]struct{}, len(notificationItems))
	for _, item := range notificationItems {
		if item.MessageID != uuid.Nil && item.ThreadRootMessageID == uuid.Nil {
			mentionedRootIDs[item.MessageID] = struct{}{}
		}
	}

	items := make([]UnreadFeedItem, 0, len(notificationItems)+len(rootMessages))
	items = append(items, notificationItems...)
	for _, item := range rootMessages {
		if _, skip := mentionedRootIDs[item.MessageID]; skip {
			continue
		}
		items = append(items, item)
	}

	sort.Slice(items, func(i, j int) bool {
		if items[i].CreatedAt.Equal(items[j].CreatedAt) {
			return items[i].ID > items[j].ID
		}
		return items[i].CreatedAt.After(items[j].CreatedAt)
	})

	return items, nil
}

func (s *Service) loadLastReadSeqTx(ctx context.Context, tx pgx.Tx, channelID, userID uuid.UUID) (int64, error) {
	var lastReadSeq int64
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(last_read_seq, 0)
		  FROM message_reads
		 WHERE channel_id = $1
		   AND user_id = $2`,
		channelID, userID,
	).Scan(&lastReadSeq); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, nil
		}
		return 0, err
	}
	return lastReadSeq, nil
}

func (s *Service) buildUnreadCounterTx(ctx context.Context, tx pgx.Tx, channelID, userID uuid.UUID, lastReadSeq int64) (*packetspb.UnreadCounter, error) {
	// Fetch notification level to respect mute/mentions-only settings.
	level, err := s.getNotificationLevelTx(ctx, tx, channelID, userID)
	if err != nil {
		return nil, fmt.Errorf("buildUnreadCounterTx notification level: %w", err)
	}

	// NOTHING: all counters are zero.
	if level == notificationLevelNothing {
		return &packetspb.UnreadCounter{
			ConversationId:         channelID.String(),
			UnreadMessages:         0,
			UnreadMentions:         0,
			HasUnreadThreadReplies: false,
			LastReadSeq:            lastReadSeq,
		}, nil
	}

	var unreadMessages int32
	if level == notificationLevelMentionsOnly {
		// MENTIONS_ONLY: count only mentions as unread messages.
		if err := tx.QueryRow(ctx, `
			SELECT COUNT(*)::int
			  FROM message_mentions mm
			  JOIN messages m ON m.id = mm.message_id
			 WHERE mm.user_id = $1
			   AND m.channel_id = $2
			   AND m.channel_seq > $3`,
			userID, channelID, lastReadSeq,
		).Scan(&unreadMessages); err != nil {
			return nil, err
		}
	} else {
		// ALL: normal counting.
		if err := tx.QueryRow(ctx, `
			SELECT COUNT(*)::int
			  FROM messages m
			 WHERE m.channel_id = $1
			   AND m.channel_seq > $2
			   AND m.thread_root_id IS NULL
			   AND m.sender_id <> $3`,
			channelID, lastReadSeq, userID,
		).Scan(&unreadMessages); err != nil {
			return nil, err
		}
	}

	var unreadMentions int32
	if err := tx.QueryRow(ctx, `
		SELECT COUNT(*)::int
		  FROM message_mentions mm
		  JOIN messages m ON m.id = mm.message_id
		 WHERE mm.user_id = $1
		   AND m.channel_id = $2
		   AND m.channel_seq > $3`,
		userID, channelID, lastReadSeq,
	).Scan(&unreadMentions); err != nil {
		return nil, err
	}

	var hasUnreadThreadReplies bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			  FROM thread_summaries ts
			  JOIN messages root ON root.id = ts.root_message_id
			 WHERE root.channel_id = $1
			   AND (
			   	root.sender_id = $2
			   	OR EXISTS (
			   		SELECT 1
			   		  FROM messages participant_msg
			   		 WHERE participant_msg.thread_root_id = ts.root_message_id
			   		   AND participant_msg.sender_id = $2
			   	)
			   	OR EXISTS (
			   		SELECT 1
			   		  FROM thread_reads thread_reader
			   		 WHERE thread_reader.root_message_id = ts.root_message_id
			   		   AND thread_reader.user_id = $2
			   	)
			   )
			   AND COALESCE((
			   	SELECT tr.last_read_thread_seq
			   	  FROM thread_reads tr
			   	 WHERE tr.root_message_id = ts.root_message_id
			   	   AND tr.user_id = $2
			   ), 0) < GREATEST(ts.next_thread_seq - 1, 0)
		)`,
		channelID, userID,
	).Scan(&hasUnreadThreadReplies); err != nil {
		return nil, err
	}

	return &packetspb.UnreadCounter{
		ConversationId:         channelID.String(),
		UnreadMessages:         unreadMessages,
		UnreadMentions:         unreadMentions,
		HasUnreadThreadReplies: hasUnreadThreadReplies,
		LastReadSeq:            lastReadSeq,
	}, nil
}

func (s *Service) buildReadCounterUpdatedDelivery(channelID, userID uuid.UUID, counter *packetspb.UnreadCounter) DirectDelivery {
	serverEvt := &packetspb.ServerEvent{
		EventType:      packetspb.EventType_EVENT_TYPE_READ_COUNTER_UPDATED,
		ConversationId: channelID.String(),
		Payload: &packetspb.ServerEvent_ReadCounterUpdated{
			ReadCounterUpdated: &packetspb.ReadCounterUpdatedEvent{
				Counter: counter,
				UserId:  userID.String(),
			},
		},
	}
	return DirectDelivery{UserID: userID.String(), Event: serverEvt}
}

func (s *Service) resolveConversationNotificationsTx(ctx context.Context, tx pgx.Tx, channelID, userID uuid.UUID) ([]uuid.UUID, error) {
	rows, err := tx.Query(ctx, `
		UPDATE notifications
		   SET resolved_at = now(),
		       is_read = true
		 WHERE user_id = $1
		   AND channel_id = $2
		   AND resolved_at IS NULL
		   AND thread_root_message_id IS NULL
		   AND type = ANY($3::text[])
		RETURNING id`,
		userID, channelID, resolvableNotificationTypes,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (s *Service) buildNotificationResolvedDelivery(channelID, userID, notificationID uuid.UUID) DirectDelivery {
	serverEvt := &packetspb.ServerEvent{
		EventType:      packetspb.EventType_EVENT_TYPE_NOTIFICATION_RESOLVED,
		ConversationId: channelID.String(),
		Payload: &packetspb.ServerEvent_NotificationResolved{
			NotificationResolved: &packetspb.NotificationResolvedEvent{
				NotificationId: notificationID.String(),
				UserId:         userID.String(),
			},
		},
	}
	return DirectDelivery{UserID: userID.String(), Event: serverEvt}
}

func (s *Service) buildMessageAlertDeliveries(
	channelID, messageID, threadRootMessageID, senderID uuid.UUID,
	senderName, body string,
	attachmentCount int,
	recipients []messageAlertRecipient,
	isDMConversation bool,
	skipRecipientIDs map[uuid.UUID]struct{},
) []DirectDelivery {
	deliveries := make([]DirectDelivery, 0, len(recipients))
	for _, recipient := range recipients {
		if recipient.NotificationLevel == notificationLevelNothing {
			continue
		}
		if !isDMConversation && recipient.NotificationLevel != notificationLevelAll {
			continue
		}
		if _, skip := skipRecipientIDs[recipient.UserID]; skip {
			continue
		}
		alert := &packetspb.MessageAlertEvent{
			ConversationId:  channelID.String(),
			MessageId:       messageID.String(),
			SenderId:        senderID.String(),
			SenderName:      senderName,
			Body:            body,
			AttachmentCount: int32(attachmentCount),
		}
		if threadRootMessageID != uuid.Nil {
			alert.ThreadRootMessageId = threadRootMessageID.String()
		}
		evt := &packetspb.ServerEvent{
			EventType:      packetspb.EventType_EVENT_TYPE_MESSAGE_ALERT,
			ConversationId: channelID.String(),
			OccurredAt:     timestamppb.Now(),
			Payload: &packetspb.ServerEvent_MessageAlert{
				MessageAlert: alert,
			},
		}
		deliveries = append(deliveries, DirectDelivery{UserID: recipient.UserID.String(), Event: evt})
	}
	return deliveries
}

func notificationTypeToProto(raw string) packetspb.NotificationType {
	switch raw {
	case "mention":
		return packetspb.NotificationType_NOTIFICATION_TYPE_MENTION
	case "thread_reply":
		return packetspb.NotificationType_NOTIFICATION_TYPE_THREAD_REPLY
	case "call_invite":
		return packetspb.NotificationType_NOTIFICATION_TYPE_CALL_INVITE
	case "call_missed":
		return packetspb.NotificationType_NOTIFICATION_TYPE_CALL_MISSED
	case "system":
		return packetspb.NotificationType_NOTIFICATION_TYPE_SYSTEM
	default:
		return packetspb.NotificationType_NOTIFICATION_TYPE_UNSPECIFIED
	}
}

// Notification level constants derived from proto enum for DB comparison.
const (
	notificationLevelAll          = int16(packetspb.NotificationLevel_NOTIFICATION_LEVEL_ALL)
	notificationLevelMentionsOnly = int16(packetspb.NotificationLevel_NOTIFICATION_LEVEL_MENTIONS_ONLY)
	notificationLevelNothing      = int16(packetspb.NotificationLevel_NOTIFICATION_LEVEL_NOTHING)
)

// resolvableNotificationTypes enumerates notification types that UpdateReadCursor
// and ResolveNotification may mark resolved. UpdateReadCursor additionally limits
// its scope to root-conversation notifications so opening a conversation cannot
// resolve notifications for threads that are not visible.
var resolvableNotificationTypes = []string{"mention", "thread_reply"}

func (s *Service) ResolveNotification(ctx context.Context, p ResolveNotificationParams) (ResolveNotificationResult, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ResolveNotificationResult{}, fmt.Errorf("chat.ResolveNotification begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var channelID uuid.UUID
	err = tx.QueryRow(ctx, `
		UPDATE notifications
		   SET resolved_at = now(),
		       is_read = true
		 WHERE id = $1
		   AND user_id = $2
		   AND resolved_at IS NULL
		   AND type = ANY($3::text[])
		RETURNING channel_id`,
		p.NotificationID, p.UserID, resolvableNotificationTypes,
	).Scan(&channelID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			if err := tx.Commit(ctx); err != nil {
				return ResolveNotificationResult{}, fmt.Errorf("chat.ResolveNotification commit noop: %w", err)
			}
			return ResolveNotificationResult{Resolved: false}, nil
		}
		return ResolveNotificationResult{}, fmt.Errorf("chat.ResolveNotification update: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return ResolveNotificationResult{}, fmt.Errorf("chat.ResolveNotification commit: %w", err)
	}

	return ResolveNotificationResult{
		Resolved: true,
		DirectDeliveries: []DirectDelivery{
			s.buildNotificationResolvedDelivery(channelID, p.UserID, p.NotificationID),
		},
	}, nil
}

// SetNotificationLevel updates the per-member notification level for a
// conversation and returns a direct delivery to sync the user's other sessions.
func (s *Service) SetNotificationLevel(ctx context.Context, p SetNotificationLevelParams) (SetNotificationLevelResult, error) {
	if p.Level < packetspb.NotificationLevel_NOTIFICATION_LEVEL_ALL ||
		p.Level > packetspb.NotificationLevel_NOTIFICATION_LEVEL_NOTHING {
		return SetNotificationLevelResult{}, fmt.Errorf("%w: notification level out of range", ErrInvalidNotificationLevel)
	}

	isMember, err := s.q.IsChannelMember(ctx, queries.IsChannelMemberParams{
		ChannelID: p.ChannelID,
		UserID:    p.UserID,
	})
	if err != nil {
		return SetNotificationLevelResult{}, fmt.Errorf("chat.SetNotificationLevel membership check: %w", err)
	}
	if !isMember {
		return SetNotificationLevelResult{}, ErrNotMember
	}

	if err := s.q.SetNotificationLevel(ctx, queries.SetNotificationLevelParams{
		ChannelID:         p.ChannelID,
		UserID:            p.UserID,
		NotificationLevel: int16(p.Level),
	}); err != nil {
		return SetNotificationLevelResult{}, fmt.Errorf("chat.SetNotificationLevel update: %w", err)
	}

	// Direct delivery to the user's other sessions so they sync the change.
	evt := &packetspb.ServerEvent{
		EventType:      packetspb.EventType_EVENT_TYPE_NOTIFICATION_LEVEL_CHANGED,
		ConversationId: p.ChannelID.String(),
		OccurredAt:     timestamppb.Now(),
		Payload: &packetspb.ServerEvent_NotificationLevelChanged{
			NotificationLevelChanged: &packetspb.NotificationLevelChangedEvent{
				ConversationId: p.ChannelID.String(),
				Level:          p.Level,
			},
		},
	}

	return SetNotificationLevelResult{
		Level: p.Level,
		DirectDeliveries: []DirectDelivery{
			{UserID: p.UserID.String(), Event: evt},
		},
	}, nil
}

// getNotificationLevelTx fetches the notification level for a user in a channel
// within an existing transaction. Returns notificationLevelAll (0) if not found.
func (s *Service) getNotificationLevelTx(ctx context.Context, tx pgx.Tx, channelID, userID uuid.UUID) (int16, error) {
	var level int16
	err := tx.QueryRow(ctx, `
		SELECT notification_level
		  FROM channel_members
		 WHERE channel_id = $1
		   AND user_id = $2
		   AND is_archived = false`,
		channelID, userID,
	).Scan(&level)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return notificationLevelAll, nil
		}
		return 0, err
	}
	return level, nil
}
