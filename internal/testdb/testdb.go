// Package testdb provides a Testcontainers-backed Postgres instance for
// integration tests. It is intended to be used only in _test.go files.
package testdb

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

const (
	dbName = "testdb"
	dbUser = "testuser"
	dbPass = "testpass"
)

// New spins up a postgres:17-alpine container, applies migrations/schema.sql,
// and returns a connected pgxpool.Pool. The container and pool are
// automatically terminated/closed at test cleanup.
func New(t *testing.T) (pool *pgxpool.Pool, connStr string) {
	t.Helper()

	ctx := context.Background()

	ctr, err := postgres.Run(ctx,
		"postgres:17-alpine",
		postgres.WithDatabase(dbName),
		postgres.WithUsername(dbUser),
		postgres.WithPassword(dbPass),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).
				WithStartupTimeout(60*time.Second),
		),
	)
	if err != nil {
		t.Fatalf("testdb: start container: %v", err)
	}
	t.Cleanup(func() {
		if err := ctr.Terminate(context.Background()); err != nil {
			t.Logf("testdb: terminate container: %v", err)
		}
	})

	connStr, err = ctr.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatalf("testdb: connection string: %v", err)
	}

	pool, err = pgxpool.New(ctx, connStr)
	if err != nil {
		t.Fatalf("testdb: pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)

	applySchema(t, ctx, pool)
	return pool, connStr
}

// applySchema loads migrations/schema.sql relative to the repository root and
// executes it against the given pool.
func applySchema(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()

	// Locate repo root: walk up from this file's directory.
	_, thisFile, _, _ := runtime.Caller(0)
	repoRoot := filepath.Join(filepath.Dir(thisFile), "..", "..")
	schemaPath := filepath.Join(repoRoot, "migrations", "schema.sql")

	schema, err := os.ReadFile(schemaPath)
	if err != nil {
		t.Fatalf("testdb: read schema: %v", err)
	}

	if _, err := pool.Exec(ctx, string(schema)); err != nil {
		t.Fatalf("testdb: apply schema: %v", err)
	}
}
