package events

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"msgnr/internal/metrics"
)

const workspacePresenceChannel = "workspace_presence"

// PresenceNotification is an ephemeral, cross-instance snapshot. It is kept
// out of workspace_events because presence is not part of ordered sync replay.
type PresenceNotification struct {
	UserID            string    `json:"user_id"`
	EffectivePresence int32     `json:"effective_presence"`
	LastActiveAt      time.Time `json:"last_active_at"`
}

// Store provides append-only access to workspace_events.
type Store struct {
	pool *pgxpool.Pool
}

// NewStore creates a Store backed by the given pool.
func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

// AppendEventTx inserts an event into workspace_events within the given
// transaction and returns the stored row. The caller is responsible for
// committing or rolling back the transaction.
func (s *Store) AppendEventTx(ctx context.Context, tx pgx.Tx, p AppendParams) (StoredEvent, error) {
	if p.ProtoPayload != nil {
		if err := ValidateEventTypePayload(p.EventType, p.ProtoPayload); err != nil {
			metrics.EventOutboxAppendedTotal.WithLabelValues("error").Inc()
			return StoredEvent{}, fmt.Errorf("AppendEventTx validate payload: %w", err)
		}
	}

	occurredAt := p.OccurredAt
	if occurredAt.IsZero() {
		occurredAt = time.Now().UTC()
	}

	var channelID *string
	if p.ChannelID != "" {
		channelID = &p.ChannelID
	}

	const q = `
INSERT INTO workspace_events (event_id, event_type, channel_id, payload, occurred_at)
VALUES ($1, $2, $3, $4, $5)
RETURNING event_seq, event_id, event_type, occurred_at`

	row := tx.QueryRow(ctx, q,
		p.EventID,
		p.EventType,
		channelID,
		p.PayloadJSON,
		occurredAt,
	)

	var stored StoredEvent
	var retEventID string
	var retEventType string
	var retOccurredAt time.Time

	if err := row.Scan(&stored.Seq, &retEventID, &retEventType, &retOccurredAt); err != nil {
		metrics.EventOutboxAppendedTotal.WithLabelValues("error").Inc()
		return StoredEvent{}, fmt.Errorf("AppendEventTx scan: %w", err)
	}

	stored.EventID = retEventID
	stored.EventType = retEventType
	stored.ChannelID = p.ChannelID
	stored.OccurredAt = retOccurredAt

	if p.ProtoPayload != nil {
		stored.Proto = p.ProtoPayload
		stored.Proto.EventSeq = stored.Seq
		stored.Proto.EventId = stored.EventID
	}
	metrics.EventOutboxAppendedTotal.WithLabelValues("success").Inc()

	return stored, nil
}

// NotifyEventTx sends a pg_notify('workspace_events', <seq>) within the
// given transaction. The notification is only delivered to listeners after
// the transaction commits.
func (s *Store) NotifyEventTx(ctx context.Context, tx pgx.Tx, eventSeq int64) error {
	_, err := tx.Exec(ctx,
		`SELECT pg_notify('workspace_events', $1)`,
		fmt.Sprintf("%d", eventSeq),
	)
	if err != nil {
		metrics.EventNotifyTotal.WithLabelValues("error").Inc()
		return fmt.Errorf("NotifyEventTx: %w", err)
	}
	metrics.EventNotifyTotal.WithLabelValues("success").Inc()
	return nil
}

// NotifyPresence broadcasts a changed presence snapshot to every backend
// instance listening on the shared Postgres database.
func (s *Store) NotifyPresence(ctx context.Context, update PresenceNotification) error {
	payload, err := json.Marshal(update)
	if err != nil {
		return fmt.Errorf("NotifyPresence marshal: %w", err)
	}
	if _, err := s.pool.Exec(ctx, `SELECT pg_notify('workspace_presence', $1)`, string(payload)); err != nil {
		return fmt.Errorf("NotifyPresence: %w", err)
	}
	return nil
}

// GetEventBySeq fetches a single event by its sequence number.
func (s *Store) GetEventBySeq(ctx context.Context, seq int64) (StoredEvent, error) {
	const q = `
SELECT event_seq, event_id, event_type, COALESCE(channel_id::text, ''), occurred_at
     , payload
  FROM workspace_events
 WHERE event_seq = $1`

	row := s.pool.QueryRow(ctx, q, seq)
	return scanStoredEvent(row)
}

// ListEventsAfterSeq returns up to limit events with event_seq > afterSeq,
// ordered ascending. Used for catch-up replay.
func (s *Store) ListEventsAfterSeq(ctx context.Context, afterSeq int64, limit int) ([]StoredEvent, error) {
	const q = `
SELECT event_seq, event_id, event_type, COALESCE(channel_id::text, ''), occurred_at
     , payload
  FROM workspace_events
 WHERE event_seq > $1
 ORDER BY event_seq ASC
 LIMIT $2`

	rows, err := s.pool.Query(ctx, q, afterSeq, limit)
	if err != nil {
		return nil, fmt.Errorf("ListEventsAfterSeq: %w", err)
	}
	defer rows.Close()

	var events []StoredEvent
	for rows.Next() {
		evt, err := scanStoredEvent(rows)
		if err != nil {
			return nil, fmt.Errorf("ListEventsAfterSeq scan: %w", err)
		}
		events = append(events, evt)
	}
	return events, rows.Err()
}

// scanStoredEvent reads a single row into a StoredEvent.
// The row must have columns: event_seq, event_id, event_type, channel_id, occurred_at, payload.
func scanStoredEvent(row pgx.Row) (StoredEvent, error) {
	var e StoredEvent
	var payload []byte
	if err := row.Scan(&e.Seq, &e.EventID, &e.EventType, &e.ChannelID, &e.OccurredAt, &payload); err != nil {
		return StoredEvent{}, err
	}
	protoEvt, err := buildServerEventFromStored(e.EventType, e.EventID, e.ChannelID, e.OccurredAt, payload)
	if err != nil {
		return StoredEvent{}, fmt.Errorf("decode stored event seq=%d: %w", e.Seq, err)
	}
	protoEvt.EventSeq = e.Seq
	e.Proto = protoEvt
	return e, nil
}
