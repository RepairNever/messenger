package calls

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"

	"msgnr/internal/events"
	packetspb "msgnr/internal/gen/proto"
)

// ReapAbandonedCalls ends calls whose active participants have no live WS lease
// and no activity or join at/after inactiveBefore. The caller supplies the WS
// lease cutoff so startup and periodic reconciliation use the presence policy.
// Legacy non-heartbeat leases stay live until the WS lifecycle removes them.
func (s *Service) ReapAbandonedCalls(ctx context.Context, inactiveBefore time.Time) (int, error) {
	tx, err := events.BeginTx(ctx, s.pool)
	if err != nil {
		return 0, fmt.Errorf("calls.ReapAbandonedCalls begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Keep selection and writes on the event transaction's pgx connection. The
	// event writer lock also serializes concurrent sweeps, joins, and webhooks.
	rows, err := tx.Query(ctx, `
		SELECT c.id, c.channel_id
		  FROM calls c
		 WHERE c.status = 'active'
		   AND c.started_at < $1
		   AND NOT EXISTS (
		       SELECT 1
		         FROM call_participants cp
		        WHERE cp.call_id = c.id
		          AND cp.left_at IS NULL
		          AND (
		              cp.joined_at >= $1
		              OR EXISTS (
		                  SELECT 1 FROM ws_presence_leases l
		                   WHERE l.user_id = cp.user_id
		                     AND (NOT l.heartbeat_capable OR l.last_heartbeat_at >= $1)
		              )
		              OR EXISTS (
		                  SELECT 1 FROM user_presence up
		                   WHERE up.user_id = cp.user_id
		                     AND up.last_active_at >= $1
		              )
		          )
		   )
		 ORDER BY c.id
		 FOR UPDATE OF c`, inactiveBefore)
	if err != nil {
		return 0, fmt.Errorf("calls.ReapAbandonedCalls select: %w", err)
	}
	var abandoned []callRow
	var callIDs []uuid.UUID
	for rows.Next() {
		var call callRow
		if err := rows.Scan(&call.ID, &call.ChannelID); err != nil {
			rows.Close()
			return 0, fmt.Errorf("calls.ReapAbandonedCalls scan: %w", err)
		}
		abandoned = append(abandoned, call)
		callIDs = append(callIDs, call.ID)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return 0, fmt.Errorf("calls.ReapAbandonedCalls rows: %w", err)
	}
	if len(abandoned) == 0 {
		return 0, nil
	}

	var userIDs []uuid.UUID
	for _, call := range abandoned {
		participants, err := s.listActiveParticipantUserIDsTx(ctx, tx, call.ID)
		if err != nil {
			return 0, err
		}
		userIDs = append(userIDs, participants...)
	}
	beforeCounts, err := s.activeCallCountsForUsersTx(ctx, tx, userIDs)
	if err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE calls SET status = 'ended', ended_at = now()
		 WHERE id = ANY($1::uuid[])`, callIDs); err != nil {
		return 0, fmt.Errorf("calls.ReapAbandonedCalls end calls: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE call_participants SET left_at = now(), hand_raised_sequence = NULL
		 WHERE call_id = ANY($1::uuid[]) AND left_at IS NULL`, callIDs); err != nil {
		return 0, fmt.Errorf("calls.ReapAbandonedCalls leave participants: %w", err)
	}
	for _, call := range abandoned {
		if err := s.appendCallStateChangedTx(ctx, tx, call.ID, call.ChannelID, packetspb.CallStatus_CALL_STATUS_ENDED); err != nil {
			return 0, err
		}
		if _, err := s.cancelPendingInvitesForEndedCallTx(ctx, tx, call.ID, call.ChannelID); err != nil {
			return 0, err
		}
	}
	if err := s.emitUserCallPresenceChangesForUsersTx(ctx, tx, beforeCounts); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("calls.ReapAbandonedCalls commit: %w", err)
	}
	return len(abandoned), nil
}
