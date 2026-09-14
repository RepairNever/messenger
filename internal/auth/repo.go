package auth

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"msgnr/internal/gen/queries"
)

var ErrSessionNotFound = errors.New("refresh session not found or expired")

// RefreshSessionRepo wraps sqlc-generated queries for refresh_sessions.
type RefreshSessionRepo struct {
	db *sql.DB
	q  *queries.Queries
}

func NewRefreshSessionRepo(pool *pgxpool.Pool) *RefreshSessionRepo {
	db := stdlib.OpenDBFromPool(pool)
	return &RefreshSessionRepo{
		db: db,
		q:  queries.New(db),
	}
}

type CreateSessionParams struct {
	UserID    uuid.UUID
	TokenHash string
	UserAgent string
	IPAddr    string
	ExpiresAt time.Time
}

type RotateSessionTokenParams struct {
	ID           uuid.UUID
	OldTokenHash string
	NewTokenHash string
	UserAgent    string
	IPAddr       string
	ExpiresAt    time.Time
}

func (r *RefreshSessionRepo) Create(ctx context.Context, p CreateSessionParams) (queries.RefreshSession, error) {
	row, err := r.q.CreateRefreshSession(ctx, queries.CreateRefreshSessionParams{
		UserID:    p.UserID,
		TokenHash: p.TokenHash,
		UserAgent: sql.NullString{String: p.UserAgent, Valid: p.UserAgent != ""},
		IpAddr:    sql.NullString{String: p.IPAddr, Valid: p.IPAddr != ""},
		ExpiresAt: p.ExpiresAt,
	})
	if err != nil {
		return queries.RefreshSession{}, fmt.Errorf("create refresh session: %w", err)
	}
	return row, nil
}

func (r *RefreshSessionRepo) RotateToken(ctx context.Context, p RotateSessionTokenParams) (queries.RefreshSession, error) {
	row, err := r.q.RotateRefreshSessionToken(ctx, queries.RotateRefreshSessionTokenParams{
		ID:          p.ID,
		TokenHash:   p.NewTokenHash,
		UserAgent:   sql.NullString{String: p.UserAgent, Valid: p.UserAgent != ""},
		IpAddr:      sql.NullString{String: p.IPAddr, Valid: p.IPAddr != ""},
		ExpiresAt:   p.ExpiresAt,
		TokenHash_2: p.OldTokenHash,
	})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return queries.RefreshSession{}, ErrSessionNotFound
		}
		return queries.RefreshSession{}, fmt.Errorf("rotate refresh session token: %w", err)
	}
	return row, nil
}

func (r *RefreshSessionRepo) GetActiveByTokenHash(ctx context.Context, tokenHash string) (queries.RefreshSession, error) {
	row, err := r.q.GetActiveRefreshSessionByTokenHash(ctx, tokenHash)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return queries.RefreshSession{}, ErrSessionNotFound
		}
		return queries.RefreshSession{}, fmt.Errorf("get refresh session: %w", err)
	}
	return row, nil
}

func (r *RefreshSessionRepo) RevokeByID(ctx context.Context, id uuid.UUID) error {
	if err := r.q.RevokeRefreshSessionByID(ctx, id); err != nil {
		return fmt.Errorf("revoke refresh session by id: %w", err)
	}
	return nil
}

func (r *RefreshSessionRepo) RevokeByTokenHash(ctx context.Context, tokenHash string) error {
	if err := r.q.RevokeRefreshSessionByTokenHash(ctx, tokenHash); err != nil {
		return fmt.Errorf("revoke refresh session by hash: %w", err)
	}
	return nil
}

func (r *RefreshSessionRepo) GetActiveByIDAndUser(ctx context.Context, sessionID, userID uuid.UUID) (queries.RefreshSession, error) {
	const q = `
SELECT id, user_id, token_hash, user_agent, ip_addr, expires_at, revoked_at, created_at
FROM refresh_sessions
WHERE id = $1
  AND user_id = $2
  AND revoked_at IS NULL
  AND expires_at > now()
`

	var row queries.RefreshSession
	err := r.db.QueryRowContext(ctx, q, sessionID, userID).Scan(
		&row.ID,
		&row.UserID,
		&row.TokenHash,
		&row.UserAgent,
		&row.IpAddr,
		&row.ExpiresAt,
		&row.RevokedAt,
		&row.CreatedAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return queries.RefreshSession{}, ErrSessionNotFound
		}
		return queries.RefreshSession{}, fmt.Errorf("get refresh session by id/user: %w", err)
	}
	return row, nil
}
