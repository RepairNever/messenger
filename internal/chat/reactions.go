package chat

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	packetspb "msgnr/internal/gen/proto"
)

func (s *Service) loadReactionAggregatesByMessageIDsTx(ctx context.Context, q queryer, messageIDs []uuid.UUID) (map[uuid.UUID][]ReactionAggregate, error) {
	result := make(map[uuid.UUID][]ReactionAggregate, len(messageIDs))
	if len(messageIDs) == 0 {
		return result, nil
	}

	rows, err := q.Query(ctx, `
		SELECT message_id, emoji, count
		  FROM reaction_counts
		 WHERE message_id = ANY($1::uuid[])
		 ORDER BY message_id ASC, emoji ASC`,
		messageIDs,
	)
	if err != nil {
		return nil, fmt.Errorf("chat.loadReactionAggregatesByMessageIDsTx query: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var row messageReactionCountRow
		if err := rows.Scan(&row.MessageID, &row.Emoji, &row.Count); err != nil {
			return nil, fmt.Errorf("chat.loadReactionAggregatesByMessageIDsTx scan: %w", err)
		}
		result[row.MessageID] = append(result[row.MessageID], ReactionAggregate{
			Emoji: row.Emoji,
			Count: row.Count,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("chat.loadReactionAggregatesByMessageIDsTx rows: %w", err)
	}

	return result, nil
}

func (s *Service) loadUserReactionsByMessageIDsTx(ctx context.Context, q queryer, messageIDs []uuid.UUID, userID uuid.UUID) (map[uuid.UUID][]string, error) {
	result := make(map[uuid.UUID][]string, len(messageIDs))
	if len(messageIDs) == 0 {
		return result, nil
	}

	rows, err := q.Query(ctx, `
		SELECT message_id, emoji
		  FROM reactions
		 WHERE message_id = ANY($1::uuid[])
		   AND user_id = $2
		 ORDER BY message_id ASC, emoji ASC`,
		messageIDs, userID,
	)
	if err != nil {
		return nil, fmt.Errorf("chat.loadUserReactionsByMessageIDsTx query: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var row messageUserReactionRow
		if err := rows.Scan(&row.MessageID, &row.Emoji); err != nil {
			return nil, fmt.Errorf("chat.loadUserReactionsByMessageIDsTx scan: %w", err)
		}
		result[row.MessageID] = append(result[row.MessageID], row.Emoji)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("chat.loadUserReactionsByMessageIDsTx rows: %w", err)
	}

	return result, nil
}

func (s *Service) ListReactionUsers(
	ctx context.Context,
	requesterID, conversationID, messageID uuid.UUID,
	emoji string,
) ([]ReactionUser, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("chat.ListReactionUsers begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if err := s.validateReactionTargetTx(ctx, tx, ReactionParams{
		ChannelID: conversationID,
		MessageID: messageID,
		UserID:    requesterID,
	}); err != nil {
		return nil, err
	}

	rows, err := tx.Query(ctx, `
		SELECT r.user_id,
		       COALESCE(NULLIF(u.display_name, ''), u.email) AS display_name,
		       u.avatar_url
		  FROM reactions r
		  JOIN users u ON u.id = r.user_id
		 WHERE r.message_id = $1
		   AND r.emoji = $2
		 ORDER BY r.created_at DESC, r.user_id`,
		messageID, emoji,
	)
	if err != nil {
		return nil, fmt.Errorf("chat.ListReactionUsers query: %w", err)
	}
	defer rows.Close()

	users := make([]ReactionUser, 0)
	for rows.Next() {
		var user ReactionUser
		if err := rows.Scan(&user.UserID, &user.DisplayName, &user.AvatarURL); err != nil {
			return nil, fmt.Errorf("chat.ListReactionUsers scan: %w", err)
		}
		users = append(users, user)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("chat.ListReactionUsers rows: %w", err)
	}
	return users, nil
}

// AddReaction idempotently adds a reaction and emits reaction_updated.
func (s *Service) AddReaction(ctx context.Context, p ReactionParams) (ReactionResult, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ReactionResult{}, fmt.Errorf("chat.AddReaction begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if err := s.validateReactionTargetTx(ctx, tx, p); err != nil {
		return ReactionResult{}, err
	}

	// ON CONFLICT DO NOTHING — check if inserted via RETURNING.
	var reactionMsgID *uuid.UUID
	err = tx.QueryRow(ctx,
		`INSERT INTO reactions (message_id, user_id, emoji, created_at)
		 VALUES ($1, $2, $3, now())
		 ON CONFLICT DO NOTHING
		 RETURNING message_id`,
		p.MessageID, p.UserID, p.Emoji,
	).Scan(&reactionMsgID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return ReactionResult{}, fmt.Errorf("chat.AddReaction insert reaction: %w", err)
	}
	if reactionMsgID == nil {
		// Already existed — idempotent no-op.
		return ReactionResult{OK: true, MessageID: p.MessageID, Emoji: p.Emoji, ClientOpID: p.ClientOpID, Applied: false}, nil
	}

	var newCount int32
	if err := tx.QueryRow(ctx, `
		INSERT INTO reaction_counts (message_id, emoji, count)
		VALUES ($1, $2, 1)
		ON CONFLICT (message_id, emoji) DO UPDATE SET count = reaction_counts.count + 1
		RETURNING count`,
		p.MessageID, p.Emoji,
	).Scan(&newCount); err != nil {
		return ReactionResult{}, fmt.Errorf("chat.AddReaction increment count: %w", err)
	}

	if err := s.emitReactionUpdated(ctx, tx, p, newCount); err != nil {
		return ReactionResult{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return ReactionResult{}, fmt.Errorf("chat.AddReaction commit: %w", err)
	}
	return ReactionResult{OK: true, MessageID: p.MessageID, Emoji: p.Emoji, ClientOpID: p.ClientOpID, Applied: true}, nil
}

// RemoveReaction idempotently removes a reaction and emits reaction_updated.
func (s *Service) RemoveReaction(ctx context.Context, p ReactionParams) (ReactionResult, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ReactionResult{}, fmt.Errorf("chat.RemoveReaction begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if err := s.validateReactionTargetTx(ctx, tx, p); err != nil {
		return ReactionResult{}, err
	}

	var deletedMsgID *uuid.UUID
	err = tx.QueryRow(ctx,
		`DELETE FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3 RETURNING message_id`,
		p.MessageID, p.UserID, p.Emoji,
	).Scan(&deletedMsgID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return ReactionResult{}, fmt.Errorf("chat.RemoveReaction delete reaction: %w", err)
	}
	if deletedMsgID == nil {
		return ReactionResult{OK: true, MessageID: p.MessageID, Emoji: p.Emoji, ClientOpID: p.ClientOpID, Applied: false}, nil
	}

	var newCount int32
	err = tx.QueryRow(ctx,
		`UPDATE reaction_counts SET count = count - 1 WHERE message_id = $1 AND emoji = $2 RETURNING count`,
		p.MessageID, p.Emoji,
	).Scan(&newCount)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return ReactionResult{}, fmt.Errorf("chat.RemoveReaction decrement count: %w", err)
	}

	if newCount <= 0 {
		if _, err := tx.Exec(ctx,
			`DELETE FROM reaction_counts WHERE message_id = $1 AND emoji = $2 AND count <= 0`,
			p.MessageID, p.Emoji,
		); err != nil {
			return ReactionResult{}, fmt.Errorf("chat.RemoveReaction delete zero count: %w", err)
		}
		newCount = 0
	}

	if err := s.emitReactionUpdated(ctx, tx, p, newCount); err != nil {
		return ReactionResult{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return ReactionResult{}, fmt.Errorf("chat.RemoveReaction commit: %w", err)
	}
	return ReactionResult{OK: true, MessageID: p.MessageID, Emoji: p.Emoji, ClientOpID: p.ClientOpID, Applied: true}, nil
}

// emitReactionUpdated appends a reaction_updated event within the given transaction.
func (s *Service) emitReactionUpdated(ctx context.Context, tx pgx.Tx, p ReactionParams, count int32) error {
	reEvt := &packetspb.ReactionUpdatedEvent{
		ConversationId: p.ChannelID.String(),
		MessageId:      p.MessageID.String(),
		Emoji:          p.Emoji,
		Count:          count,
	}
	reServerEvt := &packetspb.ServerEvent{
		EventType:      packetspb.EventType_EVENT_TYPE_REACTION_UPDATED,
		ConversationId: p.ChannelID.String(),
		Payload:        &packetspb.ServerEvent_ReactionUpdated{ReactionUpdated: reEvt},
	}
	if err := s.appendAndNotifyTx(ctx, tx, "reaction_updated", p.ChannelID.String(), reEvt, reServerEvt); err != nil {
		return fmt.Errorf("emitReactionUpdated %w", err)
	}
	return nil
}

func (s *Service) validateReactionTargetTx(ctx context.Context, tx pgx.Tx, p ReactionParams) error {
	var actualChannelID uuid.UUID
	var contentMode string
	if err := tx.QueryRow(ctx, `
		SELECT channel_id, content_mode
		  FROM messages
		 WHERE id = $1`,
		p.MessageID,
	).Scan(&actualChannelID, &contentMode); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrMessageNotFound
		}
		return fmt.Errorf("validate reaction target message: %w", err)
	}
	if actualChannelID != p.ChannelID {
		return ErrMessageNotFound
	}

	var isMember bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM channel_members
			 WHERE channel_id = $1
			   AND user_id = $2
			   AND is_archived = false
		)`,
		p.ChannelID, p.UserID,
	).Scan(&isMember); err != nil {
		return fmt.Errorf("validate reaction target membership: %w", err)
	}
	if !isMember {
		return ErrNotMember
	}
	if contentMode == MessageContentDMPairwiseSignal {
		return ErrEncryptedMessageUnsupported
	}
	return nil
}

func (s *Service) isChannelMemberTx(ctx context.Context, tx pgx.Tx, channelID, userID uuid.UUID) (bool, error) {
	var isMember bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM channel_members
			 WHERE channel_id = $1
			   AND user_id = $2
			   AND is_archived = false
		)`,
		channelID, userID,
	).Scan(&isMember); err != nil {
		return false, err
	}
	return isMember, nil
}
