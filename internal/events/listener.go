package events

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"
	"msgnr/internal/metrics"
)

// ListenerConfig holds tuning knobs for the Listener.
type ListenerConfig struct {
	// DSN is the Postgres connection string for the dedicated LISTEN connection.
	DSN string
	// CatchUpBatch is the number of rows fetched per catch-up iteration.
	CatchUpBatch int
	// RetryBackoff is the initial reconnect delay (doubles on each retry, capped at RetryBackoffMax).
	RetryBackoff time.Duration
	// RetryBackoffMax is the ceiling for reconnect delay.
	RetryBackoffMax time.Duration
}

// Listener opens a dedicated Postgres connection, issues LISTEN workspace_events,
// and publishes every committed event to the Bus.
type Listener struct {
	cfg             ListenerConfig
	store           *Store
	bus             *Bus
	log             *zap.Logger
	presenceHandler func(PresenceNotification)
}

// SetPresenceHandler configures delivery of ephemeral cross-instance presence
// updates. It must be called before Run.
func (l *Listener) SetPresenceHandler(handler func(PresenceNotification)) {
	l.presenceHandler = handler
}

// NewListener creates a Listener. Call Run to start the goroutine.
func NewListener(cfg ListenerConfig, store *Store, bus *Bus, log *zap.Logger) *Listener {
	return &Listener{
		cfg:   cfg,
		store: store,
		bus:   bus,
		log:   log,
	}
}

// Run blocks until ctx is cancelled. It reconnects with exponential back-off
// on connection errors.
func (l *Listener) Run(ctx context.Context) {
	backoff := l.cfg.RetryBackoff
	var lastDelivered int64

	for {
		if ctx.Err() != nil {
			return
		}

		err := l.runOnce(ctx, &lastDelivered)
		if ctx.Err() != nil {
			return
		}

		l.log.Warn("listener: connection lost, retrying",
			zap.Error(err),
			zap.Duration("backoff", backoff),
			zap.Int64("last_delivered_seq", lastDelivered),
		)

		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}

		backoff *= 2
		if backoff > l.cfg.RetryBackoffMax {
			backoff = l.cfg.RetryBackoffMax
		}
	}
}

// runOnce establishes one LISTEN connection and processes notifications until
// an error occurs or ctx is cancelled. It updates *lastDelivered in place so
// the outer retry loop knows where to resume.
func (l *Listener) runOnce(ctx context.Context, lastDelivered *int64) error {
	conn, err := pgx.Connect(ctx, l.cfg.DSN)
	if err != nil {
		return fmt.Errorf("listener connect: %w", err)
	}
	defer conn.Close(ctx)

	if _, err := conn.Exec(ctx, "LISTEN workspace_events"); err != nil {
		return fmt.Errorf("LISTEN: %w", err)
	}
	if _, err := conn.Exec(ctx, "LISTEN workspace_presence"); err != nil {
		return fmt.Errorf("LISTEN presence: %w", err)
	}

	l.log.Info("listener: connected and listening",
		zap.Int64("last_delivered_seq", *lastDelivered),
	)

	// Catch-up: replay any events that arrived while we were disconnected.
	if err := l.catchUp(ctx, lastDelivered); err != nil {
		return fmt.Errorf("catch-up: %w", err)
	}

	for {
		notification, err := conn.WaitForNotification(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return fmt.Errorf("WaitForNotification: %w", err)
		}

		if notification.Channel == workspacePresenceChannel {
			if err := l.handlePresenceNotification(notification.Payload); err != nil {
				metrics.EventListenerNotificationsTotal.WithLabelValues("presence_parse_error").Inc()
				l.log.Warn("listener: invalid presence notification", zap.String("payload", notification.Payload), zap.Error(err))
			} else {
				metrics.EventListenerNotificationsTotal.WithLabelValues("presence_ok").Inc()
			}
			continue
		}
		if notification.Channel != "workspace_events" {
			continue
		}

		seq, err := parseNotificationPayload(notification.Payload)
		if err != nil {
			metrics.EventListenerNotificationsTotal.WithLabelValues("parse_error").Inc()
			l.log.Warn("listener: invalid notification payload",
				zap.String("payload", notification.Payload),
				zap.Error(err),
			)
			continue
		}

		// Skip events we have already delivered (e.g. after a short reconnect).
		if seq <= *lastDelivered {
			continue
		}

		stored, err := l.store.GetEventBySeq(ctx, seq)
		if err != nil {
			metrics.EventListenerNotificationsTotal.WithLabelValues("fetch_error").Inc()
			l.log.Error("listener: failed to fetch event",
				zap.Int64("event_seq", seq),
				zap.Error(err),
			)
			continue
		}

		if stored.Proto != nil {
			l.bus.Publish(stored.Proto)
		}

		*lastDelivered = seq
		metrics.EventListenerNotificationsTotal.WithLabelValues("ok").Inc()
		metrics.EventListenerLagSeq.Set(0)

		l.log.Debug("listener: delivered event",
			zap.Int64("event_seq", seq),
			zap.String("event_type", stored.EventType),
			zap.String("event_id", stored.EventID),
		)
	}
}

func (l *Listener) handlePresenceNotification(payload string) error {
	if l.presenceHandler == nil {
		return nil
	}
	var update PresenceNotification
	if err := json.Unmarshal([]byte(payload), &update); err != nil {
		return fmt.Errorf("unmarshal: %w", err)
	}
	if update.UserID == "" {
		return fmt.Errorf("missing user_id")
	}
	l.presenceHandler(update)
	return nil
}

// catchUp fetches all events after *lastDelivered and publishes them to the
// bus in sequence. It updates *lastDelivered as it progresses.
func (l *Listener) catchUp(ctx context.Context, lastDelivered *int64) error {
	for {
		events, err := l.store.ListEventsAfterSeq(ctx, *lastDelivered, l.cfg.CatchUpBatch)
		if err != nil {
			return err
		}
		if len(events) == 0 {
			return nil
		}

		for _, evt := range events {
			if evt.Proto != nil {
				l.bus.Publish(evt.Proto)
			}
			*lastDelivered = evt.Seq

			l.log.Debug("listener: catch-up event",
				zap.Int64("event_seq", evt.Seq),
				zap.String("event_type", evt.EventType),
			)
		}

		if len(events) < l.cfg.CatchUpBatch {
			// We've exhausted the backlog.
			return nil
		}
	}
}

// parseNotificationPayload converts the pg_notify payload string to an int64 seq.
func parseNotificationPayload(payload string) (int64, error) {
	seq, err := strconv.ParseInt(payload, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("parseNotificationPayload %q: %w", payload, err)
	}
	return seq, nil
}
