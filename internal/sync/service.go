package sync

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"

	"msgnr/internal/auth"
	"msgnr/internal/chat"
	"msgnr/internal/config"
	"msgnr/internal/events"
	packetspb "msgnr/internal/gen/proto"
	"msgnr/internal/gen/queries"
)

type EventAuthorizer func(ctx context.Context, principal auth.Principal, evt *packetspb.ServerEvent) bool

type Service struct {
	cfg        *config.Config
	q          *queries.Queries
	eventStore *events.Store
	authorize  EventAuthorizer
	pruneMu    sync.Mutex
	lastPrune  time.Time
}

const pruneInterval = time.Minute
const (
	minSyncScanBatch = 64
	maxSyncScanBatch = 1024
)

func NewService(pool *pgxpool.Pool, cfg *config.Config, eventStore *events.Store, authorize EventAuthorizer) *Service {
	if authorize == nil {
		authorize = func(_ context.Context, _ auth.Principal, _ *packetspb.ServerEvent) bool {
			return true
		}
	}
	return &Service{
		cfg:        cfg,
		q:          queries.New(stdlib.OpenDBFromPool(pool)),
		eventStore: eventStore,
		authorize:  authorize,
	}
}

func (s *Service) GetPersistedCursor(ctx context.Context, userID uuid.UUID) (int64, error) {
	return s.q.GetPersistedUserSyncCursor(ctx, userID)
}

func (s *Service) Ack(ctx context.Context, principal auth.Principal, req *packetspb.AckRequest) (*packetspb.AckResponse, error) {
	if req == nil || req.GetLastAppliedEventSeq() < 0 {
		return nil, fmt.Errorf("invalid ack request")
	}
	cursor, err := s.q.UpsertUserSyncCursor(ctx, queries.UpsertUserSyncCursorParams{
		UserID:            principal.UserID,
		PersistedEventSeq: req.GetLastAppliedEventSeq(),
	})
	if err != nil {
		return nil, fmt.Errorf("ack upsert cursor: %w", err)
	}
	return &packetspb.AckResponse{
		Ok:                true,
		PersistedEventSeq: cursor.PersistedEventSeq,
	}, nil
}

func (s *Service) SyncSince(ctx context.Context, principal auth.Principal, req *packetspb.SyncSinceRequest) (*packetspb.SyncSinceResponse, error) {
	if req == nil || req.GetAfterSeq() < 0 {
		return nil, fmt.Errorf("invalid sync request")
	}
	if err := s.maybePruneExpiredEvents(ctx); err != nil {
		return nil, err
	}

	latestSeq, err := s.q.GetLatestWorkspaceEventSeq(ctx)
	if err != nil {
		return nil, fmt.Errorf("sync latest seq: %w", err)
	}
	floorSeq, err := s.q.GetWorkspaceEventFloorSeq(ctx)
	if err != nil {
		return nil, fmt.Errorf("sync floor seq: %w", err)
	}

	resp := &packetspb.SyncSinceResponse{
		ServerSyncEventLimit: uint32(s.cfg.SyncEventLimit),
	}

	if floorSeq > 0 && req.GetAfterSeq()+1 < floorSeq {
		resp.NeedFullBootstrap = true
		resp.NeedFullBootstrapReason = packetspb.SyncBootstrapReason_SYNC_BOOTSTRAP_REASON_GAP_OUT_OF_RETENTION
		return resp, nil
	}
	if latestSeq == 0 && req.GetAfterSeq() > 0 {
		resp.NeedFullBootstrap = true
		resp.NeedFullBootstrapReason = packetspb.SyncBootstrapReason_SYNC_BOOTSTRAP_REASON_GAP_OUT_OF_RETENTION
		return resp, nil
	}
	if latestSeq-req.GetAfterSeq() > int64(s.cfg.SyncEventLimit) {
		resp.NeedFullBootstrap = true
		resp.NeedFullBootstrapReason = packetspb.SyncBootstrapReason_SYNC_BOOTSTRAP_REASON_GAP_TOO_LARGE
		return resp, nil
	}

	limit := s.cfg.MaxSyncBatch
	if req.GetMaxEvents() > 0 && int(req.GetMaxEvents()) < limit {
		limit = int(req.GetMaxEvents())
	}
	if limit <= 0 {
		limit = s.cfg.MaxSyncBatch
	}

	scanCursor := req.GetAfterSeq()
	expectedSeq := req.GetAfterSeq() + 1
	resp.Events = make([]*packetspb.ServerEvent, 0, limit)

	scanBatch := limit * 4
	if scanBatch <= 0 || scanBatch > maxSyncScanBatch {
		scanBatch = maxSyncScanBatch
	}
	if scanBatch < minSyncScanBatch {
		scanBatch = minSyncScanBatch
	}

	for scanCursor < latestSeq && len(resp.Events) < limit {
		storedEvents, err := s.eventStore.ListEventsAfterSeq(ctx, scanCursor, scanBatch)
		if err != nil {
			return nil, fmt.Errorf("sync list events: %w", err)
		}
		if len(storedEvents) == 0 {
			if latestSeq > scanCursor {
				resp.NeedFullBootstrap = true
				resp.NeedFullBootstrapReason = packetspb.SyncBootstrapReason_SYNC_BOOTSTRAP_REASON_DATA_RECOVERY
				return resp, nil
			}
			break
		}

		for _, stored := range storedEvents {
			if stored.Seq != expectedSeq {
				resp.Events = nil
				resp.NeedFullBootstrap = true
				resp.NeedFullBootstrapReason = packetspb.SyncBootstrapReason_SYNC_BOOTSTRAP_REASON_DATA_RECOVERY
				return resp, nil
			}
			scanCursor = stored.Seq
			expectedSeq++
			if s.authorize(ctx, principal, stored.Proto) {
				resp.Events = append(resp.Events, chat.StripEncryptedEventPayloads(stored.Proto))
				if resp.FromSeq == 0 {
					resp.FromSeq = stored.Seq
				}
				resp.ToSeq = stored.Seq
				if len(resp.Events) >= limit {
					break
				}
			}
		}

		if len(storedEvents) < scanBatch {
			break
		}
	}

	resp.SyncCursor = scanCursor
	return resp, nil
}

func (s *Service) maybePruneExpiredEvents(ctx context.Context) error {
	s.pruneMu.Lock()
	if !s.lastPrune.IsZero() && time.Since(s.lastPrune) < pruneInterval {
		s.pruneMu.Unlock()
		return nil
	}
	s.lastPrune = time.Now()
	s.pruneMu.Unlock()

	cutoff := time.Now().UTC().Add(-time.Duration(s.cfg.SyncRetentionWindow) * time.Hour)
	if _, err := s.q.PruneWorkspaceEventsBefore(ctx, cutoff); err != nil {
		s.pruneMu.Lock()
		s.lastPrune = time.Time{}
		s.pruneMu.Unlock()
		return fmt.Errorf("sync prune workspace events: %w", err)
	}
	return nil
}
