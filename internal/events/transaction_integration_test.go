//go:build integration

package events_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"

	"msgnr/internal/events"
	"msgnr/internal/testdb"
)

type observedBeginner struct {
	pool  *pgxpool.Pool
	began chan struct{}
}

func (db observedBeginner) Begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := db.pool.Begin(ctx)
	select {
	case db.began <- struct{}{}:
	default:
	}
	return tx, err
}

func appendMembership(t *testing.T, ctx context.Context, store *events.Store, tx pgx.Tx) events.StoredEvent {
	t.Helper()
	stored, err := store.AppendEventTx(ctx, tx, events.AppendParams{
		EventID: uuid.NewString(), EventType: "membership_changed",
		PayloadJSON: []byte(minimalMembershipPayload),
	})
	require.NoError(t, err)
	return stored
}

func TestIntegration_EventWriters_CommitOrderAndPoolAvailability(t *testing.T) {
	_, connStr := testdb.New(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cfg, err := pgxpool.ParseConfig(connStr)
	require.NoError(t, err)
	cfg.MaxConns = 2
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	store := events.NewStore(pool)
	bus := events.NewBus(zap.NewNop())
	received := subscribeAll(t, bus)
	startListener(t, store, bus, connStr)

	firstTx, err := events.BeginTx(ctx, pool)
	require.NoError(t, err)
	defer firstTx.Rollback(context.Background()) //nolint:errcheck
	first := appendMembership(t, ctx, store, firstTx)
	require.NoError(t, store.NotifyEventTx(ctx, firstTx, first.Seq))

	// The second writer tries to overtake a transaction that allocated its seq
	// but has not committed. It must wait before doing domain work or appending.
	began := make(chan struct{}, 1)
	type outcome struct {
		seq int64
		err error
	}
	finished := make(chan outcome, 1)
	go func() {
		tx, err := events.BeginTx(ctx, observedBeginner{pool: pool, began: began})
		if err != nil {
			finished <- outcome{err: err}
			return
		}
		defer tx.Rollback(context.Background()) //nolint:errcheck
		stored, err := store.AppendEventTx(ctx, tx, events.AppendParams{
			EventID: uuid.NewString(), EventType: "membership_changed",
			PayloadJSON: []byte(minimalMembershipPayload),
		})
		if err == nil {
			err = store.NotifyEventTx(ctx, tx, stored.Seq)
		}
		if err == nil {
			err = tx.Commit(ctx)
		}
		finished <- outcome{seq: stored.Seq, err: err}
	}()
	select {
	case <-began:
	case <-ctx.Done():
		t.Fatal("second writer never began")
	}

	// A blocking lock waiter would consume the only other connection and
	// deadlock a writer whose service performs a lookup through the pool.
	queryCtx, queryCancel := context.WithTimeout(ctx, time.Second)
	var value int
	err = pool.QueryRow(queryCtx, "SELECT 1").Scan(&value)
	queryCancel()
	require.NoError(t, err, "contended writers must release pooled connections")
	assert.Equal(t, 1, value)
	select {
	case result := <-finished:
		t.Fatalf("second writer passed the first uncommitted writer: %+v", result)
	default:
	}

	// The fallback guard rejects callers that acquired domain rows before
	// using the ordered transaction entry point, without waiting on the lock.
	legacyTx, err := pool.Begin(ctx)
	require.NoError(t, err)
	_, err = store.AppendEventTx(ctx, legacyTx, events.AppendParams{})
	assert.ErrorIs(t, err, events.ErrEventWriterBusy)
	require.NoError(t, legacyTx.Rollback(ctx))

	require.NoError(t, firstTx.Commit(ctx))
	var second outcome
	select {
	case second = <-finished:
	case <-ctx.Done():
		t.Fatal("second writer did not resume after commit")
	}
	require.NoError(t, second.err)
	assert.Greater(t, second.seq, first.Seq)
	assert.Equal(t, first.Seq, waitEvent(t, received, 3*time.Second).GetEventSeq())
	assert.Equal(t, second.seq, waitEvent(t, received, 3*time.Second).GetEventSeq())
	rows, err := store.ListEventsAfterSeq(ctx, 0, 100)
	require.NoError(t, err)
	require.Len(t, rows, 2)
	assert.Equal(t, []int64{first.Seq, second.seq}, []int64{rows[0].Seq, rows[1].Seq})
}

func TestIntegration_EventWriters_RollbackGapAndMultipleAppends(t *testing.T) {
	pool, connStr := testdb.New(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	store := events.NewStore(pool)
	firstTx, err := events.BeginTx(ctx, pool)
	require.NoError(t, err)
	defer firstTx.Rollback(ctx) //nolint:errcheck
	rolledBack := appendMembership(t, ctx, store, firstTx)
	require.NoError(t, store.NotifyEventTx(ctx, firstTx, rolledBack.Seq))
	require.NoError(t, firstTx.Rollback(ctx))

	secondTx, err := events.BeginTx(ctx, pool)
	require.NoError(t, err)
	defer secondTx.Rollback(ctx) //nolint:errcheck
	first := appendMembership(t, ctx, store, secondTx)
	second := appendMembership(t, ctx, store, secondTx)
	require.NoError(t, secondTx.Commit(ctx))
	assert.Greater(t, first.Seq, rolledBack.Seq)
	assert.Greater(t, second.Seq, first.Seq)

	// No notifications were sent for this committed transaction. A listener
	// starting after the offline period must replay both rows across the gap.
	bus := events.NewBus(zap.NewNop())
	received := subscribeAll(t, bus)
	startListener(t, store, bus, connStr)
	assert.Equal(t, first.Seq, waitEvent(t, received, 3*time.Second).GetEventSeq())
	assert.Equal(t, second.Seq, waitEvent(t, received, 3*time.Second).GetEventSeq())
	rows, err := store.ListEventsAfterSeq(ctx, rolledBack.Seq, 100)
	require.NoError(t, err)
	require.Len(t, rows, 2)
	assert.Equal(t, []int64{first.Seq, second.Seq}, []int64{rows[0].Seq, rows[1].Seq})
}

func TestIntegration_EventWriters_ListenerReconnectResumesWithoutDuplicates(t *testing.T) {
	pool, connStr := testdb.New(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	store := events.NewStore(pool)
	bus := events.NewBus(zap.NewNop())
	received := subscribeAll(t, bus)
	cfg := listenerCfg(connStr)
	cfg.RetryBackoff = 50 * time.Millisecond
	listener := events.NewListener(cfg, store, bus, zap.NewNop())
	listenerCtx, stopListener := context.WithCancel(context.Background())
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		listener.Run(listenerCtx)
	}()
	t.Cleanup(func() { stopListener(); <-stopped })

	tx, err := events.BeginTx(ctx, pool)
	require.NoError(t, err)
	defer tx.Rollback(context.Background()) //nolint:errcheck
	first := appendMembership(t, ctx, store, tx)
	require.NoError(t, store.NotifyEventTx(ctx, tx, first.Seq))
	require.NoError(t, tx.Commit(ctx))
	assert.Equal(t, first.Seq, waitEvent(t, received, 3*time.Second).GetEventSeq())

	// WaitForNotification leaves the last LISTEN command in pg_stat_activity.
	// Terminate only this test database's dedicated listener connection.
	var terminated bool
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT pg_terminate_backend(pid)
		  FROM pg_stat_activity
		 WHERE datname = current_database()
		   AND query = 'LISTEN workspace_presence'
		   AND pid <> pg_backend_pid()`).Scan(&terminated))
	require.True(t, terminated)

	// Events committed during the lost connection must be obtained by catch-up,
	// or by their notification if the reconnect has already finished.
	tx, err = events.BeginTx(ctx, pool)
	require.NoError(t, err)
	defer tx.Rollback(context.Background()) //nolint:errcheck
	second := appendMembership(t, ctx, store, tx)
	third := appendMembership(t, ctx, store, tx)
	require.NoError(t, store.NotifyEventTx(ctx, tx, second.Seq))
	require.NoError(t, store.NotifyEventTx(ctx, tx, third.Seq))
	require.NoError(t, tx.Commit(ctx))
	assert.Equal(t, second.Seq, waitEvent(t, received, 3*time.Second).GetEventSeq())
	assert.Equal(t, third.Seq, waitEvent(t, received, 3*time.Second).GetEventSeq())
	select {
	case extra := <-received:
		t.Fatalf("duplicate event after listener reconnect: seq=%d", extra.GetEventSeq())
	case <-time.After(100 * time.Millisecond):
	}
}
