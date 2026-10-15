package events

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type beginTransactionFunc func(context.Context) (pgx.Tx, error)

func (f beginTransactionFunc) Begin(ctx context.Context) (pgx.Tx, error) {
	return f(ctx)
}

type lockTestTransaction struct {
	pgx.Tx
	queryRow func(context.Context, string, ...any) pgx.Row
	rollback func(context.Context) error
}

func (tx *lockTestTransaction) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return tx.queryRow(ctx, sql, args...)
}

func (tx *lockTestTransaction) Rollback(ctx context.Context) error {
	return tx.rollback(ctx)
}

type scanRowFunc func(...any) error

func (f scanRowFunc) Scan(dest ...any) error { return f(dest...) }

func lockResult(locked bool) pgx.Row {
	return scanRowFunc(func(dest ...any) error {
		*dest[0].(*bool) = locked
		return nil
	})
}

func TestBeginTx_ReleasesContendedTransactionBeforeRetry(t *testing.T) {
	var operations []string
	first := &lockTestTransaction{
		queryRow: func(context.Context, string, ...any) pgx.Row {
			operations = append(operations, "first lock")
			return lockResult(false)
		},
		rollback: func(context.Context) error {
			operations = append(operations, "first rollback")
			return nil
		},
	}
	second := &lockTestTransaction{
		queryRow: func(context.Context, string, ...any) pgx.Row {
			operations = append(operations, "second lock")
			return lockResult(true)
		},
		rollback: func(context.Context) error {
			t.Fatal("the successful transaction belongs to its caller")
			return nil
		},
	}
	begins := 0
	db := beginTransactionFunc(func(context.Context) (pgx.Tx, error) {
		begins++
		if begins == 1 {
			operations = append(operations, "first begin")
			return first, nil
		}
		operations = append(operations, "second begin")
		return second, nil
	})

	tx, err := BeginTx(context.Background(), db)
	require.NoError(t, err)
	require.Same(t, second, tx)
	operations = append(operations, "domain work")
	assert.Equal(t, []string{"first begin", "first lock", "first rollback", "second begin", "second lock", "domain work"}, operations)
}

func TestBeginTx_CancellationReleasesTransactionWithLiveContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	begins, rollbacks := 0, 0
	tx := &lockTestTransaction{
		queryRow: func(context.Context, string, ...any) pgx.Row {
			cancel()
			return lockResult(false)
		},
		rollback: func(rollbackCtx context.Context) error {
			rollbacks++
			assert.NoError(t, rollbackCtx.Err(), "cancellation must not prevent releasing the connection")
			return nil
		},
	}
	db := beginTransactionFunc(func(context.Context) (pgx.Tx, error) {
		begins++
		return tx, nil
	})

	result, err := BeginTx(ctx, db)
	assert.Nil(t, result)
	assert.ErrorIs(t, err, context.Canceled)
	assert.Equal(t, 1, begins)
	assert.Equal(t, 1, rollbacks)
}

func TestBeginTx_LockErrorReleasesTransactionWithoutRetry(t *testing.T) {
	lockErr := errors.New("lock query failed")
	begins, rollbacks := 0, 0
	tx := &lockTestTransaction{
		queryRow: func(context.Context, string, ...any) pgx.Row {
			return scanRowFunc(func(...any) error { return lockErr })
		},
		rollback: func(context.Context) error { rollbacks++; return nil },
	}
	db := beginTransactionFunc(func(context.Context) (pgx.Tx, error) { begins++; return tx, nil })

	result, err := BeginTx(context.Background(), db)
	assert.Nil(t, result)
	assert.ErrorIs(t, err, lockErr)
	assert.Equal(t, 1, begins)
	assert.Equal(t, 1, rollbacks)
}

func TestBeginTx_FailedRollbackDoesNotBeginAnotherTransaction(t *testing.T) {
	rollbackErr := errors.New("rollback failed")
	begins := 0
	tx := &lockTestTransaction{
		queryRow: func(context.Context, string, ...any) pgx.Row { return lockResult(false) },
		rollback: func(context.Context) error { return rollbackErr },
	}
	db := beginTransactionFunc(func(context.Context) (pgx.Tx, error) { begins++; return tx, nil })

	result, err := BeginTx(context.Background(), db)
	assert.Nil(t, result)
	assert.ErrorIs(t, err, rollbackErr)
	assert.Equal(t, 1, begins)
}

func TestAppendEventTx_RejectsContendedLateWriterBeforeInsert(t *testing.T) {
	queries := 0
	tx := &lockTestTransaction{
		queryRow: func(_ context.Context, sql string, _ ...any) pgx.Row {
			queries++
			assert.Contains(t, sql, "pg_try_advisory_xact_lock")
			return lockResult(false)
		},
	}

	_, err := NewStore(nil).AppendEventTx(context.Background(), tx, AppendParams{})
	assert.ErrorIs(t, err, ErrEventWriterBusy)
	assert.Equal(t, 1, queries, "a contended legacy transaction must not allocate an event sequence")
}
