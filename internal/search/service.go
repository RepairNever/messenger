package search

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"

	"msgnr/internal/gen/queries"
)

var (
	ErrQueryTooShort = errors.New("search query must be at least 2 characters")
	ErrNotMember     = errors.New("not a searchable conversation member")
)

const (
	defaultMessageSearchLimit = 20
	maxMessageSearchLimit     = 50
)

type MessageSource string

const (
	MessageSourceChatMessage       MessageSource = "chat_message"
	MessageSourceTaskComment       MessageSource = "task_comment"
	MessageSourceTaskCommentThread MessageSource = "task_comment_thread"
)

type MessageResult struct {
	Source                 MessageSource
	ID                     string
	Body                   string
	CreatedAt              time.Time
	ActorID                string
	ActorName              string
	ConversationID         string
	ConversationTitle      string
	ConversationKind       string
	ConversationVisibility string
	MessageID              string
	ThreadRootMessageID    string
	TaskID                 string
	TaskPublicID           string
	TaskTitle              string
	TaskCommentID          string
}

type Service struct {
	q *queries.Queries
}

func NewService(pool *pgxpool.Pool) *Service {
	sqlDB := stdlib.OpenDBFromPool(pool)
	return &Service{q: queries.New(sqlDB)}
}

func (s *Service) SearchMessages(
	ctx context.Context,
	requesterID uuid.UUID,
	query string,
	conversationID *uuid.UUID,
	limit int,
) ([]MessageResult, error) {
	trimmed := strings.TrimSpace(query)
	if utf8.RuneCountInString(trimmed) < 2 {
		return nil, ErrQueryTooShort
	}
	if limit <= 0 {
		limit = defaultMessageSearchLimit
	}
	if limit > maxMessageSearchLimit {
		limit = maxMessageSearchLimit
	}

	likeQuery := "%" + escapeILikePattern(trimmed) + "%"
	if conversationID != nil {
		isMember, err := s.q.IsSearchableConversationMember(ctx, queries.IsSearchableConversationMemberParams{
			RequesterID:    requesterID,
			ConversationID: *conversationID,
		})
		if err != nil {
			return nil, fmt.Errorf("search.SearchMessages membership check: %w", err)
		}
		if !isMember {
			return nil, ErrNotMember
		}

		rows, err := s.q.SearchMessagesInConversation(ctx, queries.SearchMessagesInConversationParams{
			RequesterID:    requesterID,
			ConversationID: *conversationID,
			LikeQuery:      likeQuery,
			QueryLimit:     limit,
		})
		if err != nil {
			return nil, fmt.Errorf("search.SearchMessages scoped query: %w", err)
		}
		results := make([]MessageResult, 0, len(rows))
		for _, row := range rows {
			results = append(results, MessageResult{
				Source:                 MessageSource(row.Source),
				ID:                     row.ID,
				Body:                   row.Body,
				CreatedAt:              row.CreatedAt,
				ActorID:                row.ActorID,
				ActorName:              row.ActorName,
				ConversationID:         row.ConversationID,
				ConversationTitle:      row.ConversationTitle,
				ConversationKind:       row.ConversationKind,
				ConversationVisibility: row.ConversationVisibility,
				MessageID:              row.MessageID,
				ThreadRootMessageID:    row.ThreadRootMessageID,
				TaskID:                 row.TaskID,
				TaskPublicID:           row.TaskPublicID,
				TaskTitle:              row.TaskTitle,
				TaskCommentID:          row.TaskCommentID,
			})
		}
		return results, nil
	}

	rows, err := s.q.SearchMessagesGlobal(ctx, queries.SearchMessagesGlobalParams{
		RequesterID: requesterID,
		LikeQuery:   likeQuery,
		QueryLimit:  limit,
	})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return []MessageResult{}, nil
		}
		return nil, fmt.Errorf("search.SearchMessages global query: %w", err)
	}
	results := make([]MessageResult, 0, len(rows))
	for _, row := range rows {
		results = append(results, MessageResult{
			Source:                 MessageSource(row.Source),
			ID:                     row.ID,
			Body:                   row.Body,
			CreatedAt:              row.CreatedAt,
			ActorID:                row.ActorID,
			ActorName:              row.ActorName,
			ConversationID:         row.ConversationID,
			ConversationTitle:      row.ConversationTitle,
			ConversationKind:       row.ConversationKind,
			ConversationVisibility: row.ConversationVisibility,
			MessageID:              row.MessageID,
			ThreadRootMessageID:    row.ThreadRootMessageID,
			TaskID:                 row.TaskID,
			TaskPublicID:           row.TaskPublicID,
			TaskTitle:              row.TaskTitle,
			TaskCommentID:          row.TaskCommentID,
		})
	}
	return results, nil
}

func escapeILikePattern(value string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return replacer.Replace(value)
}
