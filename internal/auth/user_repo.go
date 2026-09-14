package auth

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"msgnr/internal/gen/queries"
)

// sqlcUserRepo adapts the sqlc-generated Queries to the UserRepo interface.
type sqlcUserRepo struct {
	q *queries.Queries
}

func NewUserRepo(pool *pgxpool.Pool) UserRepo {
	return &sqlcUserRepo{q: queries.New(stdlib.OpenDBFromPool(pool))}
}

func (r *sqlcUserRepo) GetUserByEmail(ctx context.Context, email string) (queries.User, error) {
	user, err := r.q.GetUserByEmail(ctx, email)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return queries.User{}, ErrInvalidCredentials
		}
		return queries.User{}, fmt.Errorf("get user by email: %w", err)
	}
	return user, nil
}

func (r *sqlcUserRepo) GetUserByID(ctx context.Context, id uuid.UUID) (queries.User, error) {
	user, err := r.q.GetUserByID(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return queries.User{}, fmt.Errorf("user not found: %w", err)
		}
		return queries.User{}, fmt.Errorf("get user by id: %w", err)
	}
	return user, nil
}
