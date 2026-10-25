//go:build integration

package calls

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"msgnr/internal/auth"
	"msgnr/internal/config"
	"msgnr/internal/events"
	packetspb "msgnr/internal/gen/proto"
	"msgnr/internal/gen/queries"
	syncsvc "msgnr/internal/sync"
	"msgnr/internal/testdb"
)

func ageReconcileCall(t *testing.T, ctx context.Context, pool *pgxpool.Pool, callID uuid.UUID) {
	t.Helper()
	_, err := pool.Exec(ctx, `UPDATE calls SET started_at = now() - interval '1 hour' WHERE id = $1`, callID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE call_participants SET joined_at = now() - interval '1 hour' WHERE call_id = $1`, callID)
	require.NoError(t, err)
}

func seedReconcileLease(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID uuid.UUID, heartbeatCapable bool, heartbeatAt time.Time) {
	t.Helper()
	var sessionID uuid.UUID
	require.NoError(t, pool.QueryRow(ctx, `
		INSERT INTO refresh_sessions (user_id, token_hash, expires_at)
		VALUES ($1, $2, now() + interval '1 day') RETURNING id`, userID, uuid.NewString()).Scan(&sessionID))
	_, err := pool.Exec(ctx, `
		INSERT INTO ws_presence_leases (connection_id, user_id, auth_session_id, heartbeat_capable, last_heartbeat_at)
		VALUES ($1, $2, $3, $4, $5)`, uuid.New(), userID, sessionID, heartbeatCapable, heartbeatAt)
	require.NoError(t, err)
}

func TestIntegration_ReapAbandonedCalls_LeasePolicy(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := NewService(pool, events.NewStore(pool), &config.Config{})
	cutoff := time.Now().UTC().Add(-90 * time.Second)
	type scenario struct {
		name  string
		keep  bool
		setup func(uuid.UUID, uuid.UUID)
	}
	cases := []scenario{
		{name: "missing lease"},
		{name: "expired lease", setup: func(user, call uuid.UUID) {
			seedReconcileLease(t, ctx, pool, user, true, cutoff.Add(-time.Minute))
		}},
		{name: "fresh lease", keep: true, setup: func(user, call uuid.UUID) {
			seedReconcileLease(t, ctx, pool, user, true, cutoff.Add(time.Minute))
		}},
		{name: "lease at cutoff", keep: true, setup: func(user, call uuid.UUID) {
			seedReconcileLease(t, ctx, pool, user, true, cutoff)
		}},
		{name: "legacy lease", keep: true, setup: func(user, call uuid.UUID) {
			seedReconcileLease(t, ctx, pool, user, false, cutoff.Add(-time.Hour))
		}},
		{name: "one fresh session", keep: true, setup: func(user, call uuid.UUID) {
			seedReconcileLease(t, ctx, pool, user, true, cutoff.Add(-time.Minute))
			seedReconcileLease(t, ctx, pool, user, true, cutoff.Add(time.Minute))
		}},
		{name: "recent call", keep: true, setup: func(user, call uuid.UUID) {
			_, err := pool.Exec(ctx, `UPDATE calls SET started_at = now() WHERE id = $1`, call)
			require.NoError(t, err)
		}},
		{name: "recent join", keep: true, setup: func(user, call uuid.UUID) {
			_, err := pool.Exec(ctx, `UPDATE call_participants SET joined_at = now() WHERE call_id = $1`, call)
			require.NoError(t, err)
		}},
		{name: "recent disconnected activity", keep: true, setup: func(user, call uuid.UUID) {
			_, err := pool.Exec(ctx, `INSERT INTO user_presence (user_id, status, last_active_at) VALUES ($1, 'offline', now())`, user)
			require.NoError(t, err)
		}},
		{name: "stale displayed online status", setup: func(user, call uuid.UUID) {
			_, err := pool.Exec(ctx, `INSERT INTO user_presence (user_id, status, last_active_at) VALUES ($1, 'online', $2)`, user, cutoff.Add(-time.Minute))
			require.NoError(t, err)
		}},
		{name: "departed participant with live lease", setup: func(user, call uuid.UUID) {
			seedReconcileLease(t, ctx, pool, user, true, cutoff.Add(time.Minute))
			_, err := pool.Exec(ctx, `UPDATE call_participants SET left_at = now() WHERE call_id = $1`, call)
			require.NoError(t, err)
		}},
		{name: "empty call", setup: func(user, call uuid.UUID) {
			_, err := pool.Exec(ctx, `DELETE FROM call_participants WHERE call_id = $1`, call)
			require.NoError(t, err)
		}},
	}
	ids := make([]uuid.UUID, len(cases))
	wantEnded := 0
	for i, tc := range cases {
		user := seedCallUser(t, ctx, pool, tc.name)
		channel := seedCallChannel(t, ctx, pool, user)
		ids[i], _ = seedActiveCall(t, ctx, pool, channel, user)
		seedParticipant(t, ctx, pool, ids[i], user)
		ageReconcileCall(t, ctx, pool, ids[i])
		if tc.setup != nil {
			tc.setup(user, ids[i])
		}
		if !tc.keep {
			wantEnded++
		}
	}
	count, err := svc.ReapAbandonedCalls(ctx, cutoff)
	require.NoError(t, err)
	assert.Equal(t, wantEnded, count)
	for i, tc := range cases {
		var active bool
		require.NoError(t, pool.QueryRow(ctx, `SELECT status = 'active' FROM calls WHERE id = $1`, ids[i]).Scan(&active))
		assert.Equal(t, tc.keep, active, tc.name)
	}
	count, err = svc.ReapAbandonedCalls(ctx, cutoff)
	require.NoError(t, err)
	assert.Zero(t, count)
}

func TestIntegration_ReapAbandonedCalls_EventsReplayAndLateWebhooks(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	store := events.NewStore(pool)
	svc := NewService(pool, store, &config.Config{})
	userA := seedCallUser(t, ctx, pool, "Offline A")
	userB := seedCallUser(t, ctx, pool, "Offline B")
	online := seedCallUser(t, ctx, pool, "Online")
	invitee := seedCallUser(t, ctx, pool, "Invitee")
	seedReconcileLease(t, ctx, pool, online, true, time.Now())
	var callIDs []uuid.UUID
	var rooms []string
	var invite uuid.UUID
	for i, participants := range [][]uuid.UUID{{userA, userB}, {userA}, {}, {userA, online}} {
		channel := seedCallChannel(t, ctx, pool, userA)
		call, room := seedActiveCall(t, ctx, pool, channel, userA)
		callIDs = append(callIDs, call)
		rooms = append(rooms, room)
		for _, user := range participants {
			seedParticipant(t, ctx, pool, call, user)
		}
		ageReconcileCall(t, ctx, pool, call)
		if i == 0 {
			invite = seedPendingInviteWithNotification(t, ctx, pool, call, channel, userA, invitee)
		}
	}
	_, err := pool.Exec(ctx, `UPDATE call_participants SET hand_raised_sequence = 1 WHERE call_id = $1`, callIDs[0])
	require.NoError(t, err)
	listener, err := pool.Acquire(ctx)
	require.NoError(t, err)
	defer listener.Release()
	_, err = listener.Exec(ctx, `LISTEN workspace_events`)
	require.NoError(t, err)
	count, err := svc.ReapAbandonedCalls(ctx, time.Now().Add(-90*time.Second))
	require.NoError(t, err)
	assert.Equal(t, 3, count)
	waitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, err = listener.Conn().WaitForNotification(waitCtx)
	require.NoError(t, err, "committed cleanup must notify live listeners")
	assert.Equal(t, []int{1}, listUserCallPresenceEventCounts(t, ctx, pool, userA))
	assert.Equal(t, []int{0}, listUserCallPresenceEventCounts(t, ctx, pool, userB))
	assert.Empty(t, listUserCallPresenceEventCounts(t, ctx, pool, online))
	var activeParticipants int
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM call_participants WHERE call_id = ANY($1::uuid[]) AND (left_at IS NULL OR hand_raised_sequence IS NOT NULL)`, callIDs[:3]).Scan(&activeParticipants))
	assert.Zero(t, activeParticipants)
	var endedWithTimestamp int
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM calls WHERE id = ANY($1::uuid[]) AND status = 'ended' AND ended_at IS NOT NULL`, callIDs[:3]).Scan(&endedWithTimestamp))
	assert.Equal(t, 3, endedWithTimestamp)
	var inviteState string
	require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM call_invites WHERE id = $1`, invite).Scan(&inviteState))
	assert.Equal(t, "rejected", inviteState)
	var resolved bool
	require.NoError(t, pool.QueryRow(ctx, `SELECT resolved_at IS NOT NULL AND is_read FROM notifications WHERE user_id = $1`, invitee).Scan(&resolved))
	assert.True(t, resolved)

	// Fetch through the same decoder used by listener catch-up and SyncSince.
	replayed, err := store.ListEventsAfterSeq(ctx, 0, 100)
	require.NoError(t, err)
	ended := map[string]bool{}
	presence := map[string]int32{}
	var lastSeq int64
	for _, event := range replayed {
		assert.Greater(t, event.Seq, lastSeq)
		lastSeq = event.Seq
		if state := event.Proto.GetCallStateChanged(); state != nil {
			assert.Equal(t, packetspb.CallStatus_CALL_STATUS_ENDED, state.Status)
			ended[state.CallId] = true
		}
		if update := event.Proto.GetUserCallPresenceChanged(); update != nil {
			presence[update.UserId] = update.ActiveCallCount
		}
	}
	assert.Len(t, ended, 3)
	assert.False(t, ended[callIDs[3].String()])
	assert.Equal(t, map[string]int32{userA.String(): 1, userB.String(): 0}, presence)
	// Reapplying the same absolute counts on reconnect leaves the same state.
	for _, event := range replayed {
		if update := event.Proto.GetUserCallPresenceChanged(); update != nil {
			presence[update.UserId] = update.ActiveCallCount
		}
	}
	sqlDB := stdlib.OpenDBFromPool(pool)
	defer sqlDB.Close()
	snapshot, err := queries.New(sqlDB).ListBootstrapUserCallPresence(ctx)
	require.NoError(t, err)
	bootstrapCounts := map[string]int32{}
	for _, row := range snapshot {
		bootstrapCounts[row.UserID.String()] = int32(row.ActiveCallCount)
	}
	for user, count := range presence {
		assert.Equal(t, count, bootstrapCounts[user])
	}
	assert.Equal(t, int32(1), bootstrapCounts[online.String()])

	// An invited guest is not a conversation member. Cleanup must still be
	// replayable after left_at is set, without granting conversation access.
	authSvc := auth.NewService(nil, nil, nil, pool, 0, nil)
	syncSvc := syncsvc.NewService(pool, &config.Config{SyncEventLimit: 100, MaxSyncBatch: 100, SyncRetentionWindow: 24}, store, authSvc.CanReceiveEvent)
	for range 2 {
		result, err := syncSvc.SyncSince(ctx, auth.Principal{UserID: userB}, &packetspb.SyncSinceRequest{AfterSeq: 0})
		require.NoError(t, err)
		var sawEnded, sawZero bool
		for _, event := range result.Events {
			if state := event.GetCallStateChanged(); state != nil {
				assert.Equal(t, callIDs[0].String(), state.CallId)
				assert.Equal(t, packetspb.CallStatus_CALL_STATUS_ENDED, state.Status)
				sawEnded = true
			}
			if presence := event.GetUserCallPresenceChanged(); presence != nil && presence.UserId == userB.String() {
				assert.Zero(t, presence.ActiveCallCount)
				sawZero = true
			}
		}
		assert.True(t, sawEnded)
		assert.True(t, sawZero)
	}

	count, err = svc.ReapAbandonedCalls(ctx, time.Now().Add(-90*time.Second))
	require.NoError(t, err)
	assert.Zero(t, count)
	for _, event := range []string{webhookEventParticipantJoined, webhookEventParticipantLeft, webhookEventParticipantConnAbort, webhookEventRoomFinished} {
		processed, err := svc.HandleWebhook(ctx, &lkwebhookEvent{Event: event, RoomName: rooms[0], ParticipantIdentity: userA.String()})
		require.NoError(t, err)
		assert.False(t, processed)
	}
	assertParticipantActive(t, ctx, pool, callIDs[0], userA, false)
	extra, err := store.ListEventsAfterSeq(ctx, lastSeq, 100)
	require.NoError(t, err)
	assert.Empty(t, extra, "repeated sweeps and late webhooks must not append events")
}

func TestIntegration_ReapAbandonedCalls_RollbackAndConcurrentSweeps(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	store := events.NewStore(pool)
	svc := NewService(pool, store, &config.Config{})
	user := seedCallUser(t, ctx, pool, "Offline")
	invitee := seedCallUser(t, ctx, pool, "Invitee")
	channel := seedCallChannel(t, ctx, pool, user)
	call, _ := seedActiveCall(t, ctx, pool, channel, user)
	seedParticipant(t, ctx, pool, call, user)
	ageReconcileCall(t, ctx, pool, call)
	invite := seedPendingInviteWithNotification(t, ctx, pool, call, channel, user, invitee)
	_, err := pool.Exec(ctx, `ALTER TABLE workspace_events ADD CONSTRAINT test_reject_presence CHECK (event_type <> 'user_call_presence_changed')`)
	require.NoError(t, err)
	count, err := svc.ReapAbandonedCalls(ctx, time.Now().Add(-90*time.Second))
	require.ErrorContains(t, err, "test_reject_presence")
	assert.Zero(t, count)
	var active bool
	require.NoError(t, pool.QueryRow(ctx, `SELECT status = 'active' AND ended_at IS NULL FROM calls WHERE id = $1`, call).Scan(&active))
	assert.True(t, active)
	assertParticipantActive(t, ctx, pool, call, user, true)
	var state string
	require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM call_invites WHERE id = $1`, invite).Scan(&state))
	assert.Equal(t, "created", state)
	var unresolved bool
	require.NoError(t, pool.QueryRow(ctx, `SELECT resolved_at IS NULL AND NOT is_read FROM notifications WHERE user_id = $1`, invitee).Scan(&unresolved))
	assert.True(t, unresolved)
	rows, err := store.ListEventsAfterSeq(ctx, 0, 100)
	require.NoError(t, err)
	assert.Empty(t, rows)
	_, err = pool.Exec(ctx, `ALTER TABLE workspace_events DROP CONSTRAINT test_reject_presence`)
	require.NoError(t, err)

	var wg sync.WaitGroup
	counts := make([]int, 2)
	errors := make([]error, 2)
	for i := range counts {
		wg.Add(1)
		go func() {
			defer wg.Done()
			counts[i], errors[i] = svc.ReapAbandonedCalls(ctx, time.Now().Add(-90*time.Second))
		}()
	}
	wg.Wait()
	for _, err := range errors {
		require.NoError(t, err)
	}
	assert.Equal(t, 1, counts[0]+counts[1])
	assert.Equal(t, []int{0}, listUserCallPresenceEventCounts(t, ctx, pool, user))
}
