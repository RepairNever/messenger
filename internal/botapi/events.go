package botapi

import (
	"context"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"

	"msgnr/internal/events"
	packetspb "msgnr/internal/gen/proto"
)

var jsonNull = []byte("null")

// payloadMessage returns the concrete message held by the ServerEvent payload
// oneof (the generated wrapper interface is not itself a proto.Message).
func payloadMessage(serverEvent events.StoredEvent) (proto.Message, bool) {
	if serverEvent.Proto == nil || serverEvent.Proto.Payload == nil {
		return nil, false
	}
	var msg protoreflect.Message
	serverEvent.Proto.ProtoReflect().Range(func(fd protoreflect.FieldDescriptor, val protoreflect.Value) bool {
		if fd.ContainingOneof() != nil && fd.ContainingOneof().Name() == "payload" && fd.Message() != nil {
			msg = val.Message()
			return false
		}
		return true
	})
	if msg == nil {
		return nil, false
	}
	return msg.Interface(), true
}

// eventsQuery is the parsed query of GET /api/bot/v1/events.
type eventsQuery struct {
	AfterSeq    int64
	Limit       int
	WaitSeconds int
}

// clampWaitSeconds bounds wait_seconds to [0, cfg.BotAPIMaxWaitSeconds]; the
// handler also uses it to extend the request write deadline before parking.
func (s *Service) clampWaitSeconds(wait int) int {
	if wait < 0 {
		return 0
	}
	if wait > s.cfg.BotAPIMaxWaitSeconds {
		return s.cfg.BotAPIMaxWaitSeconds
	}
	return wait
}

// clampLimit bounds a provided /events limit into [1, cfg.BotAPIEventsMaxLimit];
// the 200 default is applied by the handler when the parameter is absent.
func (s *Service) clampLimit(limit int) int {
	if limit < 1 {
		return 1
	}
	if limit > s.cfg.BotAPIEventsMaxLimit {
		return s.cfg.BotAPIEventsMaxLimit
	}
	return limit
}

// Events runs one long-poll request over the workspace_events log. It returns
// as soon as any row past afterSeq exists (admitted or not); it parks on the
// event bus only while fully caught up, bounded by waitSeconds.
func (s *Service) Events(ctx context.Context, botUserID uuid.UUID, query eventsQuery) (eventsResponse, error) {
	query.Limit = s.clampLimit(query.Limit)
	query.WaitSeconds = s.clampWaitSeconds(query.WaitSeconds)
	deadline := time.Now().Add(time.Duration(query.WaitSeconds) * time.Second)

	// Plain polls (wait_seconds=0) are cheap and exempt from the cap.
	var eventCh <-chan *packetspb.ServerEvent
	if query.WaitSeconds > 0 {
		if !s.polls.acquire(botUserID) {
			return eventsResponse{}, ErrTooManyPolls
		}
		defer s.polls.release(botUserID)
		// Subscribe before the first scan: an event committed between a scan
		// and parking remains buffered and wakes the next scan.
		_, ch, unsubscribe := s.bus.SubscribeWithOverflow(nil, 16, nil)
		defer unsubscribe()
		eventCh = ch
	}

	for {
		res, err := s.scanOnce(ctx, botUserID, query.AfterSeq, query.Limit)
		if err != nil {
			return eventsResponse{}, err
		}
		if res.scanned > 0 || res.respond || query.WaitSeconds == 0 {
			return res.response, nil
		}
		if !s.park(ctx, deadline, eventCh) {
			// Client disconnected: the connection is gone, so skip the final
			// latest_seq lookup (it would fail on the canceled context) and
			// return the caught-up position without events.
			if ctx.Err() != nil {
				return eventsResponse{
					Events:     []eventDTO{},
					NextCursor: query.AfterSeq,
				}, nil
			}
			// Deadline or shutdown: report the caught-up position.
			latest, err := s.latestSeq(ctx)
			if err != nil {
				return eventsResponse{}, err
			}
			return eventsResponse{
				Events:     []eventDTO{},
				NextCursor: query.AfterSeq,
				LatestSeq:  latest,
			}, nil
		}
	}
}

// scanResult couples the HTTP response with how many raw rows the scan saw.
type scanResult struct {
	response eventsResponse
	scanned  int
	// respond forces Events to return this result immediately instead of
	// parking; used by the out-of-retention guard, which must not hold the
	// request (or a concurrent-poll slot) for the whole wait window.
	respond bool
}

func (s *Service) scanOnce(ctx context.Context, botUserID uuid.UUID, afterSeq int64, limit int) (scanResult, error) {
	latest, err := s.latestSeq(ctx)
	if err != nil {
		return scanResult{}, err
	}
	floor, err := s.q.GetWorkspaceEventFloorSeq(ctx)
	if err != nil {
		return scanResult{}, err
	}

	// Out-of-retention guard: the cursor points below the retained window, so
	// the bot cannot be fed a contiguous stream and must re-bootstrap from the
	// read endpoints. A fresh cursor (afterSeq 0) starts at the floor instead.
	// This responds immediately regardless of wait_seconds.
	if afterSeq > 0 && afterSeq+1 < floor {
		return scanResult{
			response: eventsResponse{
				Events:             []eventDTO{},
				NextCursor:         latest,
				LatestSeq:          latest,
				HasMore:            false,
				GapBeyondRetention: true,
			},
			scanned: 0,
			respond: true,
		}, nil
	}

	// Membership is reloaded every iteration so channels joined mid-poll are
	// honored (one indexed query per scan).
	membershipIDs, err := s.q.ListActiveConversationIDsForUser(ctx, botUserID)
	if err != nil {
		return scanResult{}, err
	}
	memberships := make(map[uuid.UUID]bool, len(membershipIDs))
	for _, id := range membershipIDs {
		memberships[id] = true
	}

	// Fetch limit+1 rows: the extra row only signals has_more.
	rows, err := s.eventStore.ListEventsAfterSeq(ctx, afterSeq, limit+1)
	if err != nil {
		return scanResult{}, err
	}
	scanned := len(rows)

	admitted := make([]eventDTO, 0, len(rows))
	for i := range rows {
		if len(admitted) == limit {
			break
		}
		dto, ok := s.admitEvent(&rows[i], botUserID, memberships)
		if !ok {
			continue
		}
		admitted = append(admitted, dto)
	}

	nextCursor, hasMore := nextCursorAfter(afterSeq, admitted, scanned, rows, limit)

	return scanResult{
		response: eventsResponse{
			Events:     admitted,
			NextCursor: nextCursor,
			LatestSeq:  latest,
			HasMore:    hasMore,
		},
		scanned: scanned,
	}, nil
}

// nextCursorAfter implements the cursor rule: the cursor advances past an
// event only when that event was returned, or when it is inadmissible at scan
// time (the zero-admitted case) — never past a returned-but-truncated tail.
func nextCursorAfter(afterSeq int64, admitted []eventDTO, scanned int, rows []events.StoredEvent, limit int) (int64, bool) {
	fullPage := scanned == limit+1
	switch {
	case len(admitted) > 0:
		return admitted[len(admitted)-1].EventSeq, fullPage
	case scanned > 0:
		// Everything scanned was inadmissible: safe to skip past.
		return rows[scanned-1].Seq, fullPage
	default:
		return afterSeq, false
	}
}

// admitEvent applies the stream admission rules and renders the DTO for
// admissible events.
func (s *Service) admitEvent(evt *events.StoredEvent, botUserID uuid.UUID, memberships map[uuid.UUID]bool) (eventDTO, bool) {
	admissible := false
	switch evt.EventType {
	case "task_comment_created":
		// Task data is org-wide readable today, same posture as the
		// documented integration endpoints.
		admissible = true
	case "message_created", "message_deleted", "conversation_upserted":
		admissible = memberships[eventChannelUUID(evt.ChannelID)]
	case "conversation_removed":
		// Defensive: no current writer persists this type; admitted so the
		// stream stays correct if persistence is ever added.
		admissible = true
	case "membership_changed":
		// Defensive: not persisted today. The user_id clause lets the bot
		// observe its own removal if that ever changes.
		admissible = memberships[eventChannelUUID(evt.ChannelID)]
		if !admissible && evt.Proto != nil {
			admissible = evt.Proto.GetMembershipChanged().GetUserId() == botUserID.String()
		}
	default:
		admissible = false
	}
	if !admissible {
		return eventDTO{}, false
	}

	dto := eventDTO{
		EventSeq:   evt.Seq,
		EventID:    evt.EventID,
		EventType:  evt.EventType,
		OccurredAt: evt.OccurredAt,
	}
	if evt.ChannelID != "" {
		conversationID := evt.ChannelID
		dto.ConversationID = &conversationID
	}
	if payload, ok := payloadMessage(*evt); ok {
		payloadJSON, err := protojson.Marshal(payload)
		if err != nil {
			s.log.Error("botapi: marshal event payload", zap.Int64("event_seq", evt.Seq), zap.Error(err))
			dto.Payload = jsonNull
		} else {
			dto.Payload = payloadJSON
		}
	} else {
		dto.Payload = jsonNull
	}
	return dto, true
}

func eventChannelUUID(channelID string) uuid.UUID {
	if channelID == "" {
		return uuid.Nil
	}
	id, err := uuid.Parse(channelID)
	if err != nil {
		return uuid.Nil
	}
	return id
}

// park blocks until a new workspace event is published, the deadline expires,
// the client disconnects, or the service shuts down. Returns true only when
// woken by an event (the caller rescans).
func (s *Service) park(ctx context.Context, deadline time.Time, eventCh <-chan *packetspb.ServerEvent) bool {
	timer := time.NewTimer(time.Until(deadline))
	defer timer.Stop()

	select {
	case <-eventCh:
		// Coalesce bursts: brief sleep, then drain buffered events.
		time.Sleep(100 * time.Millisecond)
		for {
			select {
			case <-eventCh:
				continue
			default:
				return true
			}
		}
	case <-timer.C:
		return false
	case <-ctx.Done():
		return false
	case <-s.stopCh:
		return false
	}
}

func (s *Service) latestSeq(ctx context.Context) (int64, error) {
	latest, err := s.q.GetLatestWorkspaceEventSeq(ctx)
	if err != nil {
		return 0, err
	}
	return latest, nil
}
