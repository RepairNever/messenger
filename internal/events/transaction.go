package events

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// Use the two-int advisory-lock namespace so task-specific bigint locks cannot
// collide with the workspace event writer lock.
const eventWriterLockNamespace int32 = 0x4d53474e
const eventWriterLockKey int32 = 1
const eventWriterRetryDelay = 10 * time.Millisecond

// ErrEventWriterBusy rejects a late append from a transaction that did not use
// BeginTx. Waiting after domain rows are locked could create a lock-order cycle.
var ErrEventWriterBusy = errors.New("workspace event writer is busy; begin event-producing transactions with events.BeginTx")

type transactionBeginner interface {
	Begin(context.Context) (pgx.Tx, error)
}

// BeginTx acquires the event writer lock before any domain work. Holding it until
// commit or rollback makes event_seq allocation follow commit order, which the
// listener, bootstrap and sync cursors require. Read-only and direct-delivery
// transactions should continue to use their ordinary transaction entry point.
//
// Contended attempts release their pooled connection before retrying: a writer
// may need another connection for a query, and blocked lock waiters must not
// exhaust the pool. Only transaction startup is retried, never domain work.
func BeginTx(ctx context.Context, db transactionBeginner) (pgx.Tx, error) {
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		tx, err := db.Begin(ctx)
		if err != nil {
			return nil, fmt.Errorf("begin event transaction: %w", err)
		}
		locked, lockErr := tryEventWriterLock(ctx, tx)
		if lockErr == nil && locked {
			return tx, nil
		}

		rollbackCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		rollbackErr := tx.Rollback(rollbackCtx)
		cancel()
		if lockErr != nil {
			return nil, fmt.Errorf("lock event transaction: %w", lockErr)
		}
		if rollbackErr != nil {
			return nil, fmt.Errorf("release contended event transaction: %w", rollbackErr)
		}

		timer := time.NewTimer(eventWriterRetryDelay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}

func tryEventWriterLock(ctx context.Context, tx pgx.Tx) (bool, error) {
	var locked bool
	err := tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock($1, $2)`, eventWriterLockNamespace, eventWriterLockKey).Scan(&locked)
	return locked, err
}
