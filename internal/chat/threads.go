package chat

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/types/known/timestamppb"

	packetspb "msgnr/internal/gen/proto"
	"msgnr/internal/gen/queries"
)

// SubscribeThread fetches thread replay for a subscriber.
func (s *Service) SubscribeThread(ctx context.Context, p SubscribeThreadParams) (SubscribeThreadResult, error) {
	isMember, err := s.q.IsChannelMember(ctx, queries.IsChannelMemberParams{
		ChannelID: p.ChannelID,
		UserID:    p.RequesterID,
	})
	if err != nil {
		return SubscribeThreadResult{}, fmt.Errorf("chat.SubscribeThread membership check: %w", err)
	}
	if !isMember {
		return SubscribeThreadResult{}, ErrNotMember
	}

	threadChannelID, err := s.messageChannelByID(ctx, p.ThreadRootMessageID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return SubscribeThreadResult{}, ErrMessageNotFound
		}
		return SubscribeThreadResult{}, fmt.Errorf("chat.SubscribeThread resolve thread root: %w", err)
	}
	if threadChannelID != p.ChannelID {
		return SubscribeThreadResult{}, ErrInvalidThread
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SubscribeThreadResult{}, fmt.Errorf("chat.SubscribeThread begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var nextThreadSeq int64
	var replyCount int32
	err = tx.QueryRow(ctx,
		`SELECT next_thread_seq, reply_count
		   FROM thread_summaries
		  WHERE root_message_id = $1
		  FOR UPDATE`,
		p.ThreadRootMessageID,
	).Scan(&nextThreadSeq, &replyCount)
	if errors.Is(err, pgx.ErrNoRows) {
		nextThreadSeq = 1
		replyCount = 0
	} else if err != nil {
		return SubscribeThreadResult{}, fmt.Errorf("chat.SubscribeThread get summary: %w", err)
	}

	currentSeq := nextThreadSeq - 1

	rows, err := tx.Query(ctx, `
		SELECT id, channel_id, channel_seq, sender_id, client_msg_id, body,
		       forwarded_from_message_id, forwarded_from_sender_id, forwarded_from_sender_name,
		       forwarded_from_conversation_kind,
		       forwarded_from_conversation_title, forwarded_from_thread_title,
		       thread_root_id, thread_seq, mention_everyone, edited_at, created_at
		  FROM messages
		 WHERE thread_root_id = $1
		   AND thread_seq > $2
		 ORDER BY thread_seq ASC`,
		p.ThreadRootMessageID, p.LastThreadSeq,
	)
	if err != nil {
		return SubscribeThreadResult{}, fmt.Errorf("chat.SubscribeThread get messages: %w", err)
	}
	defer rows.Close()

	msgs := make([]queries.Message, 0)
	for rows.Next() {
		var m queries.Message
		var forwardedFromMessageID uuid.NullUUID
		var forwardedFromSenderID uuid.NullUUID
		var forwardedFromSenderName sql.NullString
		var forwardedFromConversationKind sql.NullString
		var forwardedFromConversationTitle sql.NullString
		var forwardedFromThreadTitle sql.NullString
		if err := rows.Scan(
			&m.ID,
			&m.ChannelID,
			&m.ChannelSeq,
			&m.SenderID,
			&m.ClientMsgID,
			&m.Body,
			&forwardedFromMessageID,
			&forwardedFromSenderID,
			&forwardedFromSenderName,
			&forwardedFromConversationKind,
			&forwardedFromConversationTitle,
			&forwardedFromThreadTitle,
			&m.ThreadRootID,
			&m.ThreadSeq,
			&m.MentionEveryone,
			&m.EditedAt,
			&m.CreatedAt,
		); err != nil {
			return SubscribeThreadResult{}, fmt.Errorf("chat.SubscribeThread scan messages: %w", err)
		}
		m.ForwardedFromMessageID = forwardedFromMessageID
		m.ForwardedFromSenderID = forwardedFromSenderID
		m.ForwardedFromSenderName = forwardedFromSenderName
		m.ForwardedFromConversationKind = forwardedFromConversationKind
		m.ForwardedFromConversationTitle = forwardedFromConversationTitle
		m.ForwardedFromThreadTitle = forwardedFromThreadTitle
		msgs = append(msgs, m)
	}
	if err := rows.Err(); err != nil {
		return SubscribeThreadResult{}, fmt.Errorf("chat.SubscribeThread rows: %w", err)
	}

	messageIDs := make([]uuid.UUID, 0, len(msgs))
	for _, m := range msgs {
		messageIDs = append(messageIDs, m.ID)
	}
	attachmentsByMessageID, err := s.loadMessageAttachmentsByMessageIDsTx(ctx, tx, messageIDs)
	if err != nil {
		return SubscribeThreadResult{}, fmt.Errorf("chat.SubscribeThread load attachments: %w", err)
	}
	entitiesByMessageID, err := s.loadMessageEntitiesByMessageIDsTx(ctx, tx, messageIDs)
	if err != nil {
		return SubscribeThreadResult{}, fmt.Errorf("chat.SubscribeThread load entities: %w", err)
	}
	reactionsByMessageID, err := s.loadReactionAggregatesByMessageIDsTx(ctx, tx, messageIDs)
	if err != nil {
		return SubscribeThreadResult{}, fmt.Errorf("chat.SubscribeThread load reactions: %w", err)
	}
	myReactionsByMessageID, err := s.loadUserReactionsByMessageIDsTx(ctx, tx, messageIDs, p.RequesterID)
	if err != nil {
		return SubscribeThreadResult{}, fmt.Errorf("chat.SubscribeThread load my reactions: %w", err)
	}

	replay := make([]*packetspb.MessageEvent, 0, len(msgs))
	for _, m := range msgs {
		entities := entitiesByMessageID[m.ID.String()]
		mentionedUserIDStrings := uuidsToStrings(mentionedUserIDsFromEntities(entities))
		evt := &packetspb.MessageEvent{
			ConversationId:   p.ChannelID.String(),
			MessageId:        m.ID.String(),
			SenderId:         m.SenderID.String(),
			Body:             m.Body,
			ChannelSeq:       m.ChannelSeq,
			CreatedAt:        timestamppb.New(m.CreatedAt),
			ThreadSeq:        m.ThreadSeq,
			MentionedUserIds: mentionedUserIDStrings,
			MentionEveryone:  m.MentionEveryone,
			Reactions:        toProtoReactionAggregates(reactionsByMessageID[m.ID]),
			Entities:         toProtoMessageEntities(entities),
			Attachments:      toProtoMessageAttachments(attachmentsByMessageID[m.ID]),
			MyReactions:      myReactionsByMessageID[m.ID],
		}
		if m.EditedAt.Valid {
			evt.EditedAt = timestamppb.New(m.EditedAt.Time)
		}
		if m.ThreadRootID.Valid {
			evt.ThreadRootMessageId = m.ThreadRootID.UUID.String()
		}
		if m.ForwardedFromMessageID.Valid && m.ForwardedFromSenderID.Valid && m.ForwardedFromSenderName.Valid {
			evt.ForwardedFromMessageId = m.ForwardedFromMessageID.UUID.String()
			evt.ForwardedFromSenderId = m.ForwardedFromSenderID.UUID.String()
			evt.ForwardedFromSenderName = m.ForwardedFromSenderName.String
			evt.ForwardedFromConversationKind = strings.TrimSpace(m.ForwardedFromConversationKind.String)
			evt.ForwardedFromConversationTitle = strings.TrimSpace(m.ForwardedFromConversationTitle.String)
			evt.ForwardedFromThreadTitle = strings.TrimSpace(m.ForwardedFromThreadTitle.String)
		}
		replay = append(replay, evt)
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO thread_reads (root_message_id, user_id, last_read_thread_seq, updated_at)
		VALUES ($1, $2, $3, now())
		ON CONFLICT (root_message_id, user_id) DO UPDATE
		    SET last_read_thread_seq = GREATEST(thread_reads.last_read_thread_seq, EXCLUDED.last_read_thread_seq),
		        updated_at = now()`,
		p.ThreadRootMessageID, p.RequesterID, currentSeq,
	); err != nil {
		return SubscribeThreadResult{}, fmt.Errorf("chat.SubscribeThread upsert thread read: %w", err)
	}

	lastReadSeq, err := s.loadLastReadSeqTx(ctx, tx, p.ChannelID, p.RequesterID)
	if err != nil {
		return SubscribeThreadResult{}, fmt.Errorf("chat.SubscribeThread get read cursor: %w", err)
	}

	counter, err := s.buildUnreadCounterTx(ctx, tx, p.ChannelID, p.RequesterID, lastReadSeq)
	if err != nil {
		return SubscribeThreadResult{}, fmt.Errorf("chat.SubscribeThread build unread counter: %w", err)
	}
	directDeliveries := []DirectDelivery{
		s.buildReadCounterUpdatedDelivery(p.ChannelID, p.RequesterID, counter),
	}

	if err := tx.Commit(ctx); err != nil {
		return SubscribeThreadResult{}, fmt.Errorf("chat.SubscribeThread commit: %w", err)
	}

	return SubscribeThreadResult{
		CurrentThreadSeq: currentSeq,
		ReplyCount:       replyCount,
		Replay:           replay,
		DirectDeliveries: directDeliveries,
	}, nil
}

func (s *Service) rebuildThreadSummaryAfterReplyDeleteTx(
	ctx context.Context,
	tx pgx.Tx,
	threadRootID uuid.UUID,
) (replyCount int32, lastThreadSeq int64, lastReplyAt time.Time, lastReplyUserID uuid.UUID, err error) {
	var nextThreadSeq int64
	if err := tx.QueryRow(ctx, `
		SELECT next_thread_seq
		  FROM thread_summaries
		 WHERE root_message_id = $1
		 FOR UPDATE`,
		threadRootID,
	).Scan(&nextThreadSeq); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, 0, time.Time{}, uuid.Nil, nil
		}
		return 0, 0, time.Time{}, uuid.Nil, err
	}
	// last_thread_seq is a high-watermark cursor source; it must remain monotonic.
	lastThreadSeq = nextThreadSeq - 1

	if err := tx.QueryRow(ctx, `
		SELECT COUNT(*)::int
		  FROM messages
		 WHERE thread_root_id = $1`,
		threadRootID,
	).Scan(&replyCount); err != nil {
		return 0, 0, time.Time{}, uuid.Nil, err
	}
	if replyCount <= 0 {
		if _, err := tx.Exec(ctx, `
			UPDATE thread_summaries
			   SET reply_count = 0,
			       last_reply_at = NULL,
			       last_reply_user_id = NULL
			 WHERE root_message_id = $1`,
			threadRootID,
		); err != nil {
			return 0, 0, time.Time{}, uuid.Nil, err
		}
		return 0, lastThreadSeq, time.Time{}, uuid.Nil, nil
	}

	if err := tx.QueryRow(ctx, `
		SELECT created_at, sender_id
		  FROM messages
		 WHERE thread_root_id = $1
		 ORDER BY thread_seq DESC
		 LIMIT 1`,
		threadRootID,
	).Scan(&lastReplyAt, &lastReplyUserID); err != nil {
		return 0, 0, time.Time{}, uuid.Nil, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE thread_summaries
		   SET reply_count = $2,
		       last_reply_at = $3,
		       last_reply_user_id = $4
		 WHERE root_message_id = $1`,
		threadRootID, replyCount, lastReplyAt, lastReplyUserID,
	); err != nil {
		return 0, 0, time.Time{}, uuid.Nil, err
	}
	return replyCount, lastThreadSeq, lastReplyAt, lastReplyUserID, nil
}

func (s *Service) threadNotificationRecipientsTx(ctx context.Context, tx pgx.Tx, rootMessageID, senderID uuid.UUID) ([]uuid.UUID, error) {
	rows, err := tx.Query(ctx, `
		SELECT DISTINCT candidate_id
		  FROM (
			SELECT root.sender_id AS candidate_id
			  FROM messages root
			 WHERE root.id = $1
			UNION
			SELECT participant.sender_id AS candidate_id
			  FROM messages participant
			 WHERE participant.thread_root_id = $1
		  ) candidates
		  JOIN messages root ON root.id = $1
		  JOIN channel_members cm
		    ON cm.channel_id = root.channel_id
		   AND cm.user_id = candidate_id
		   AND cm.is_archived = false
		 WHERE candidate_id <> $2`,
		rootMessageID, senderID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	recipients := make([]uuid.UUID, 0)
	for rows.Next() {
		var recipient uuid.UUID
		if err := rows.Scan(&recipient); err != nil {
			return nil, err
		}
		recipients = append(recipients, recipient)
	}
	return recipients, rows.Err()
}
