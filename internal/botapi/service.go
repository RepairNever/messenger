// Package botapi exposes the versioned HTTP API consumed by the external Bot
// Service (static-token auth, read endpoints, message authoring, and a
// long-polling event stream over the workspace_events log).
package botapi

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"go.uber.org/zap"

	"msgnr/internal/chat"
	"msgnr/internal/config"
	"msgnr/internal/documents"
	"msgnr/internal/events"
	"msgnr/internal/gen/queries"
	"msgnr/internal/integrations"
	"msgnr/internal/search"
	"msgnr/internal/tasks"
)

// Service holds botapi business logic: event scanning, admission filtering,
// long-poll parking, and delegation to the existing chat/tasks/documents/
// search/integrations services.
type Service struct {
	q            *queries.Queries
	eventStore   *events.Store
	bus          *events.Bus
	chatSvc      *chat.Service
	tasksSvc     *tasks.Service
	documentsSvc *documents.Service
	searchSvc    *search.Service
	integrations *integrations.Service
	cfg          *config.Config
	log          *zap.Logger

	limiter *tokenBucketLimiter
	polls   *pollCounter

	closeOnce sync.Once
	stopCh    chan struct{}
}

func NewService(
	pool *pgxpool.Pool,
	eventStore *events.Store,
	bus *events.Bus,
	chatSvc *chat.Service,
	tasksSvc *tasks.Service,
	documentsSvc *documents.Service,
	searchSvc *search.Service,
	integrationsSvc *integrations.Service,
	cfg *config.Config,
	log *zap.Logger,
) *Service {
	return &Service{
		q:            queries.New(stdlib.OpenDBFromPool(pool)),
		eventStore:   eventStore,
		bus:          bus,
		chatSvc:      chatSvc,
		tasksSvc:     tasksSvc,
		documentsSvc: documentsSvc,
		searchSvc:    searchSvc,
		integrations: integrationsSvc,
		cfg:          cfg,
		log:          log,
		limiter:      newTokenBucketLimiter(cfg.BotAPIRateLimitRPS, cfg.BotAPIRateLimitBurst),
		polls:        newPollCounter(cfg.BotAPIMaxConcurrentPolls),
		stopCh:       make(chan struct{}),
	}
}

// Close is idempotent; it wakes every parked /events long-poll so shutdown is
// not blocked by in-flight polls. main wires it to httpServer.RegisterOnShutdown.
func (s *Service) Close() {
	s.closeOnce.Do(func() {
		close(s.stopCh)
	})
}

// ErrTooManyPolls is returned when a bot user already holds the maximum
// number of concurrent long-polling /events requests.
var ErrTooManyPolls = errors.New("too many concurrent polls")

// allowRequest applies the per-bot token bucket after token verification.
func (s *Service) allowRequest(userID uuid.UUID) bool {
	return s.limiter.allow(userID)
}

// ---- identity ----

func (s *Service) Me(ctx context.Context, userID uuid.UUID) (queries.User, error) {
	user, err := s.q.GetUserByID(ctx, userID)
	if err != nil {
		return queries.User{}, fmt.Errorf("botapi: get user: %w", err)
	}
	return user, nil
}

// ---- conversations ----

func (s *Service) Conversations(ctx context.Context, botUserID uuid.UUID) ([]queries.ListBotConversationsRow, error) {
	rows, err := s.q.ListBotConversations(ctx, botUserID)
	if err != nil {
		return nil, fmt.Errorf("botapi: list conversations: %w", err)
	}
	return rows, nil
}

// ConversationTask resolves a hidden task discussion channel to its task.
// task.discussion_channel_id has no UNIQUE constraint; EnsureCommentThread
// maintains 1:1 in practice, so the first (oldest) row wins.
func (s *Service) ConversationTask(ctx context.Context, botUserID, conversationID uuid.UUID) (queries.GetTaskByDiscussionChannelRow, bool, error) {
	rows, err := s.q.GetTaskByDiscussionChannel(ctx, queries.GetTaskByDiscussionChannelParams{
		DiscussionChannelID: uuid.NullUUID{UUID: conversationID, Valid: true},
		BotUserID:           botUserID,
	})
	if err != nil {
		return queries.GetTaskByDiscussionChannelRow{}, false, fmt.Errorf("botapi: resolve discussion channel task: %w", err)
	}
	if len(rows) == 0 {
		return queries.GetTaskByDiscussionChannelRow{}, false, nil
	}
	return rows[0], true, nil
}

// ---- tasks ----

func (s *Service) TaskComments(ctx context.Context, taskID uuid.UUID) ([]queries.ListBotTaskCommentsRow, error) {
	rows, err := s.q.ListBotTaskComments(ctx, taskID)
	if err != nil {
		return nil, fmt.Errorf("botapi: list task comments: %w", err)
	}
	return rows, nil
}

func (s *Service) ResolveTaskByPublicID(ctx context.Context, publicID string) (tasks.TaskResponse, error) {
	task, err := s.tasksSvc.GetTaskByPublicID(ctx, publicID)
	if err != nil {
		if errors.Is(err, tasks.ErrNotFound) {
			return tasks.TaskResponse{}, err
		}
		return tasks.TaskResponse{}, fmt.Errorf("botapi: resolve task: %w", err)
	}
	return task, nil
}

func (s *Service) CreateTaskComment(ctx context.Context, taskID, authorID uuid.UUID, body string) (*tasks.CommentRow, error) {
	return s.tasksSvc.CreateComment(ctx, taskID, authorID, body)
}

func (s *Service) IntegrationTask(ctx context.Context, publicID string) (any, error) {
	// The return type is integrations' unexported DTO with exported,
	// json-tagged fields; marshal the value verbatim.
	return s.integrations.GetTask(ctx, publicID)
}

// ---- search ----

// SearchMessages runs a workspace-wide message search on the bot's behalf
// (nil conversation scope = all conversations the bot can read).
func (s *Service) SearchMessages(ctx context.Context, botUserID uuid.UUID, query string, limit int) ([]search.MessageResult, error) {
	return s.searchSvc.SearchMessages(ctx, botUserID, query, nil, limit)
}
