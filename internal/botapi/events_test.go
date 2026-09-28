package botapi

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"

	"msgnr/internal/events"
	packetspb "msgnr/internal/gen/proto"
)

func testService() *Service {
	return &Service{
		log:    zap.NewNop(),
		bus:    events.NewBus(zap.NewNop()),
		stopCh: make(chan struct{}),
	}
}

func storedEvent(eventType string, channelID string, proto *packetspb.ServerEvent) events.StoredEvent {
	return events.StoredEvent{
		Seq:        1,
		EventID:    uuid.New().String(),
		EventType:  eventType,
		ChannelID:  channelID,
		OccurredAt: time.Now(),
		Proto:      proto,
	}
}

func TestAdmitEvent_Rules(t *testing.T) {
	svc := testService()
	botID := uuid.New()
	memberChannel := uuid.New()
	otherChannel := uuid.New()
	memberships := map[uuid.UUID]bool{memberChannel: true}

	cases := []struct {
		name       string
		evt        events.StoredEvent
		admissible bool
	}{
		{
			name:       "task_comment_created always (no channel)",
			evt:        storedEvent("task_comment_created", "", nil),
			admissible: true,
		},
		{
			name:       "message_created member channel",
			evt:        storedEvent("message_created", memberChannel.String(), nil),
			admissible: true,
		},
		{
			name:       "message_created non-member channel",
			evt:        storedEvent("message_created", otherChannel.String(), nil),
			admissible: false,
		},
		{
			name:       "message_created empty channel",
			evt:        storedEvent("message_created", "", nil),
			admissible: false,
		},
		{
			name:       "message_deleted member channel",
			evt:        storedEvent("message_deleted", memberChannel.String(), nil),
			admissible: true,
		},
		{
			name:       "conversation_upserted member channel",
			evt:        storedEvent("conversation_upserted", memberChannel.String(), nil),
			admissible: true,
		},
		{
			name:       "conversation_removed always (defensive)",
			evt:        storedEvent("conversation_removed", otherChannel.String(), nil),
			admissible: true,
		},
		{
			name: "membership_changed member channel (defensive)",
			evt: storedEvent("membership_changed", memberChannel.String(),
				&packetspb.ServerEvent{Payload: &packetspb.ServerEvent_MembershipChanged{
					MembershipChanged: &packetspb.MembershipChangedEvent{UserId: uuid.New().String()},
				}}),
			admissible: true,
		},
		{
			name: "membership_changed own user id (defensive)",
			evt: storedEvent("membership_changed", otherChannel.String(),
				&packetspb.ServerEvent{Payload: &packetspb.ServerEvent_MembershipChanged{
					MembershipChanged: &packetspb.MembershipChangedEvent{UserId: botID.String()},
				}}),
			admissible: true,
		},
		{
			name: "membership_changed someone else non-member channel",
			evt: storedEvent("membership_changed", otherChannel.String(),
				&packetspb.ServerEvent{Payload: &packetspb.ServerEvent_MembershipChanged{
					MembershipChanged: &packetspb.MembershipChangedEvent{UserId: uuid.New().String()},
				}}),
			admissible: false,
		},
		{name: "message_updated dropped", evt: storedEvent("message_updated", memberChannel.String(), nil)},
		{name: "reaction_updated dropped", evt: storedEvent("reaction_updated", memberChannel.String(), nil)},
		{name: "notification_added dropped", evt: storedEvent("notification_added", "", nil)},
		{name: "read_counter_updated dropped", evt: storedEvent("read_counter_updated", memberChannel.String(), nil)},
		{name: "task_status_changed dropped", evt: storedEvent("task_status_changed", "", nil)},
		{name: "user_identity_updated dropped", evt: storedEvent("user_identity_updated", "", nil)},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, ok := svc.admitEvent(&tc.evt, botID, memberships)
			assert.Equal(t, tc.admissible, ok)
		})
	}
}

func TestAdmitEvent_TaskCommentCreatedPayloadRenders(t *testing.T) {
	svc := testService()
	botID := uuid.New()
	channelID := uuid.New()
	evt := storedEvent("task_comment_created", channelID.String(), &packetspb.ServerEvent{
		EventType: packetspb.EventType_EVENT_TYPE_TASK_COMMENT_CREATED,
		Payload: &packetspb.ServerEvent_TaskCommentCreated{TaskCommentCreated: &packetspb.TaskCommentCreatedEvent{
			TaskId:     uuid.New().String(),
			PublicId:   "DEV-42",
			CommentId:  uuid.New().String(),
			AuthorId:   botID.String(),
			AuthorName: "Bot",
			Body:       "hello",
		}},
	})

	dto, ok := svc.admitEvent(&evt, botID, map[uuid.UUID]bool{})
	require.True(t, ok)
	assert.Equal(t, evt.Seq, dto.EventSeq)
	assert.Equal(t, "task_comment_created", dto.EventType)
	require.NotNil(t, dto.ConversationID)
	assert.Equal(t, channelID.String(), *dto.ConversationID)
	assert.Contains(t, string(dto.Payload), `"publicId":"DEV-42"`)
}

func TestNextCursorAfter(t *testing.T) {
	rows := func(seqs ...int64) []events.StoredEvent {
		out := make([]events.StoredEvent, 0, len(seqs))
		for _, s := range seqs {
			out = append(out, events.StoredEvent{Seq: s})
		}
		return out
	}
	dto := func(seq int64) eventDTO { return eventDTO{EventSeq: seq} }

	// Admitted events: cursor = last returned; the admissible (limit+1)-th row
	// is left for the next call.
	admitted := []eventDTO{dto(10), dto(11), dto(12)}
	cursor, hasMore := nextCursorAfter(9, admitted, 4, rows(10, 11, 12, 13), 3)
	assert.Equal(t, int64(12), cursor)
	assert.True(t, hasMore)

	// Admitted events filling less than a page: no more.
	cursor, hasMore = nextCursorAfter(9, admitted, 3, rows(10, 11, 12), 3)
	assert.Equal(t, int64(12), cursor)
	assert.False(t, hasMore)

	// All scanned rows inadmissible: cursor skips past them.
	cursor, hasMore = nextCursorAfter(9, nil, 3, rows(10, 11, 12), 3)
	assert.Equal(t, int64(12), cursor)
	assert.False(t, hasMore)

	// All inadmissible but a full page was scanned: has_more stays true so the
	// client keeps pulling.
	cursor, hasMore = nextCursorAfter(9, nil, 4, rows(10, 11, 12, 13), 3)
	assert.Equal(t, int64(13), cursor)
	assert.True(t, hasMore)

	// Fully caught up: cursor unchanged.
	cursor, hasMore = nextCursorAfter(9, nil, 0, nil, 3)
	assert.Equal(t, int64(9), cursor)
	assert.False(t, hasMore)
}

func TestPark_WakesOnBusPublish(t *testing.T) {
	svc := testService()
	_, eventCh, unsubscribe := svc.bus.SubscribeWithOverflow(nil, 16, nil)
	defer unsubscribe()

	go func() {
		time.Sleep(50 * time.Millisecond)
		svc.bus.Publish(&packetspb.ServerEvent{EventType: packetspb.EventType_EVENT_TYPE_MESSAGE_CREATED})
	}()

	start := time.Now()
	woken := svc.park(t.Context(), time.Now().Add(5*time.Second), eventCh)
	assert.True(t, woken, "park must return true when an event is published")
	assert.Less(t, time.Since(start), 3*time.Second, "wake should be prompt")
}

func TestPark_WakesOnEventPublishedBeforeParking(t *testing.T) {
	svc := testService()
	_, eventCh, unsubscribe := svc.bus.SubscribeWithOverflow(nil, 16, nil)
	defer unsubscribe()

	// The scan may finish after this publish; the subscription must retain
	// the wakeup until the request enters the parked state.
	svc.bus.Publish(&packetspb.ServerEvent{EventType: packetspb.EventType_EVENT_TYPE_MESSAGE_CREATED})
	start := time.Now()
	assert.True(t, svc.park(t.Context(), time.Now().Add(2*time.Second), eventCh))
	assert.Less(t, time.Since(start), time.Second)
}

func TestPark_DeadlineExpiry(t *testing.T) {
	svc := testService()
	_, eventCh, unsubscribe := svc.bus.SubscribeWithOverflow(nil, 16, nil)
	defer unsubscribe()
	woken := svc.park(t.Context(), time.Now().Add(50*time.Millisecond), eventCh)
	assert.False(t, woken, "deadline expiry is not an event wake")
}

func TestPark_ClientDisconnect(t *testing.T) {
	svc := testService()
	_, eventCh, unsubscribe := svc.bus.SubscribeWithOverflow(nil, 16, nil)
	defer unsubscribe()
	ctx, cancel := context.WithCancel(t.Context())
	go func() {
		time.Sleep(30 * time.Millisecond)
		cancel()
	}()
	woken := svc.park(ctx, time.Now().Add(5*time.Second), eventCh)
	assert.False(t, woken)
}

func TestClampWaitSecondsAndLimit(t *testing.T) {
	svc := testService()
	svc.cfg = testConfig()
	assert.Equal(t, 0, svc.clampWaitSeconds(-1))
	assert.Equal(t, 7, svc.clampWaitSeconds(7))
	assert.Equal(t, 30, svc.clampWaitSeconds(300))

	assert.Equal(t, 1, svc.clampLimit(0), "provided limit clamps up to 1")
	assert.Equal(t, 25, svc.clampLimit(25))
	assert.Equal(t, 500, svc.clampLimit(5000))
}
