//go:build integration

package events_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"

	"msgnr/internal/events"
	packetspb "msgnr/internal/gen/proto"
	"msgnr/internal/testdb"
)

// listenerCfg builds a ListenerConfig pointing at connStr with tight retry
// settings suitable for tests.
func listenerCfg(connStr string) events.ListenerConfig {
	return events.ListenerConfig{
		DSN:             connStr,
		CatchUpBatch:    100,
		RetryBackoff:    100 * time.Millisecond,
		RetryBackoffMax: 500 * time.Millisecond,
	}
}

// startListener runs the listener in a background goroutine and registers
// cleanup via t.Cleanup.
func startListener(t *testing.T, store *events.Store, bus *events.Bus, connStr string) {
	t.Helper()
	l := events.NewListener(listenerCfg(connStr), store, bus, zap.NewNop())
	ctx, cancel := context.WithCancel(context.Background())
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		l.Run(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		<-stopped
	})
}

// subscribeAll subscribes to the bus without a filter and returns a channel
// that receives all published events.
func subscribeAll(t *testing.T, bus *events.Bus) <-chan *packetspb.ServerEvent {
	t.Helper()
	_, ch, unsub := bus.Subscribe(nil, 32)
	t.Cleanup(unsub)
	return ch
}

// waitEvent waits up to timeout for one event on ch; fails the test on timeout.
func waitEvent(t *testing.T, ch <-chan *packetspb.ServerEvent, timeout time.Duration) *packetspb.ServerEvent {
	t.Helper()
	select {
	case evt := <-ch:
		return evt
	case <-time.After(timeout):
		t.Fatal("timed out waiting for event")
		return nil
	}
}

// minimalMembershipPayload is a valid JSON payload for membership_changed.
const minimalMembershipPayload = `{"userId":"00000000-0000-0000-0000-000000000099","role":"member"}`

// --- Test 1: committed tx → listener publishes exactly once ---

func TestIntegration_AppendNotify_CommittedTxDeliveredOnce(t *testing.T) {
	pool, connStr := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	bus := events.NewBus(zap.NewNop())
	startListener(t, store, bus, connStr)

	// Give the listener a moment to connect and LISTEN.
	time.Sleep(300 * time.Millisecond)

	received := subscribeAll(t, bus)

	tx, err := pool.Begin(ctx)
	require.NoError(t, err)

	params := events.AppendParams{
		EventID:     uuid.New().String(),
		EventType:   "membership_changed",
		PayloadJSON: []byte(minimalMembershipPayload),
		OccurredAt:  time.Now().UTC(),
	}
	stored, err := store.AppendEventTx(ctx, tx, params)
	require.NoError(t, err)
	require.NoError(t, store.NotifyEventTx(ctx, tx, stored.Seq))
	require.NoError(t, tx.Commit(ctx))

	evt := waitEvent(t, received, 3*time.Second)
	assert.Equal(t, stored.Seq, evt.GetEventSeq())
	assert.Equal(t, packetspb.EventType_EVENT_TYPE_MEMBERSHIP_CHANGED, evt.GetEventType())

	// No second event should arrive.
	select {
	case extra := <-received:
		t.Fatalf("unexpected second event: seq=%d", extra.GetEventSeq())
	case <-time.After(300 * time.Millisecond):
	}
}

// --- Test 2: rolled-back tx → no event delivered ---

func TestIntegration_AppendNotify_RollbackNoDelivery(t *testing.T) {
	pool, connStr := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	bus := events.NewBus(zap.NewNop())
	startListener(t, store, bus, connStr)

	time.Sleep(300 * time.Millisecond)

	received := subscribeAll(t, bus)

	tx, err := pool.Begin(ctx)
	require.NoError(t, err)

	params := events.AppendParams{
		EventID:     uuid.New().String(),
		EventType:   "membership_changed",
		PayloadJSON: []byte(minimalMembershipPayload),
		OccurredAt:  time.Now().UTC(),
	}
	stored, err := store.AppendEventTx(ctx, tx, params)
	require.NoError(t, err)
	require.NoError(t, store.NotifyEventTx(ctx, tx, stored.Seq))

	// Rollback instead of commit.
	require.NoError(t, tx.Rollback(ctx))

	// No event should be delivered because the tx was rolled back.
	select {
	case evt := <-received:
		t.Fatalf("unexpected event after rollback: seq=%d", evt.GetEventSeq())
	case <-time.After(500 * time.Millisecond):
	}
}

// --- Test 3: listener catch-up after restart ---

func TestIntegration_Listener_CatchUpAfterRestart(t *testing.T) {
	pool, connStr := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)

	// Append an event BEFORE the listener starts (simulates offline period).
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)

	params := events.AppendParams{
		EventID:     uuid.New().String(),
		EventType:   "membership_changed",
		PayloadJSON: []byte(minimalMembershipPayload),
		OccurredAt:  time.Now().UTC(),
	}
	stored, err := store.AppendEventTx(ctx, tx, params)
	require.NoError(t, err)
	// No NotifyEventTx — the listener was not running yet.
	require.NoError(t, tx.Commit(ctx))

	// Now start the listener — it should catch up via ListEventsAfterSeq.
	bus := events.NewBus(zap.NewNop())
	received := subscribeAll(t, bus)
	startListener(t, store, bus, connStr)

	evt := waitEvent(t, received, 3*time.Second)
	assert.Equal(t, stored.Seq, evt.GetEventSeq())
	assert.Equal(t, packetspb.EventType_EVENT_TYPE_MEMBERSHIP_CHANGED, evt.GetEventType())
}

// --- Test 4: event_seq is strictly monotonically increasing ---

func TestIntegration_EventSeq_StrictlyMonotonic(t *testing.T) {
	pool, connStr := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	bus := events.NewBus(zap.NewNop())
	startListener(t, store, bus, connStr)

	time.Sleep(300 * time.Millisecond)

	received := subscribeAll(t, bus)

	const count = 5
	seqs := make([]int64, 0, count)

	for i := 0; i < count; i++ {
		tx, err := pool.Begin(ctx)
		require.NoError(t, err)

		params := events.AppendParams{
			EventID:     uuid.New().String(),
			EventType:   "membership_changed",
			PayloadJSON: []byte(minimalMembershipPayload),
			OccurredAt:  time.Now().UTC(),
		}
		stored, err := store.AppendEventTx(ctx, tx, params)
		require.NoError(t, err)
		require.NoError(t, store.NotifyEventTx(ctx, tx, stored.Seq))
		require.NoError(t, tx.Commit(ctx))
		seqs = append(seqs, stored.Seq)
	}

	// Collect all delivered events.
	delivered := make([]int64, 0, count)
	timeout := time.After(5 * time.Second)
	for len(delivered) < count {
		select {
		case evt := <-received:
			delivered = append(delivered, evt.GetEventSeq())
		case <-timeout:
			t.Fatalf("timed out after receiving %d/%d events", len(delivered), count)
		}
	}

	// Assert strictly increasing.
	for i := 1; i < len(delivered); i++ {
		assert.Greater(t, delivered[i], delivered[i-1],
			"event_seq must be strictly increasing: delivered[%d]=%d <= delivered[%d]=%d",
			i, delivered[i], i-1, delivered[i-1])
	}

	// Assert delivered seqs match appended seqs.
	assert.Equal(t, seqs, delivered)
}
