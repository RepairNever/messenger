package database

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"msgnr/internal/config"
)

type DB struct {
	Pool *pgxpool.Pool
}

func Connect(cfg *config.Config) (*DB, error) {
	poolCfg, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		return nil, fmt.Errorf("failed to parse database URL: %w", err)
	}

	poolCfg.MaxConns = cfg.DBMaxConns
	poolCfg.MinConns = cfg.DBMinConns
	poolCfg.MaxConnLifetime = cfg.DBMaxConnLifetime
	poolCfg.MaxConnIdleTime = cfg.DBMaxConnIdleTime
	poolCfg.HealthCheckPeriod = cfg.DBHealthCheckPeriod
	poolCfg.ConnConfig.ConnectTimeout = cfg.DBConnectTimeout

	ctx, cancel := context.WithTimeout(context.Background(), cfg.DBConnectTimeout)
	defer cancel()

	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return nil, fmt.Errorf("failed to create connection pool: %w", err)
	}

	pingCtx, pingCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer pingCancel()

	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	return &DB{Pool: pool}, nil
}

func (db *DB) Close() {
	db.Pool.Close()
}

func (db *DB) HealthCheck(ctx context.Context) error {
	return db.Pool.Ping(ctx)
}
