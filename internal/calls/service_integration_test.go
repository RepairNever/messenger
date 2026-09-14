//go:build integration

package calls

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"msgnr/internal/config"
	"msgnr/internal/events"
	packetspb "msgnr/internal/gen/proto"
	"msgnr/internal/testdb"
)

func seedCallUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, name string) uuid.UUID {
	t.Helper()
	return seedCallUserWithStatus(t, ctx, pool, name, "active")
}

func seedCallUserWithStatus(t *testing.T, ctx context.Context, pool *pgxpool.Pool, name, status string) uuid.UUID {
	t.Helper()
	var userID uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role, status)
		 VALUES ($1, 'x', $2, 'member', $3)
		 RETURNING id`,
		uuid.NewString()+"@example.com",
		name,
		status,
	).Scan(&userID)
	require.NoError(t, err)
	return userID
}

func seedCallChannel(t *testing.T, ctx context.Context, pool *pgxpool.Pool, creatorID uuid.UUID) uuid.UUID {
	t.Helper()
	var channelID uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO channels (kind, visibility, name, created_by)
		 VALUES ('channel', 'public', $1, $2)
		 RETURNING id`,
		"room-"+uuid.NewString(),
		creatorID,
	).Scan(&channelID)
	require.NoError(t, err)
	return channelID
}

func seedCallDMConversation(t *testing.T, ctx context.Context, pool *pgxpool.Pool, creatorID uuid.UUID) uuid.UUID {
	t.Helper()
	var conversationID uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO channels (kind, visibility, name, created_by)
		 VALUES ('dm', 'dm', '', $1)
		 RETURNING id`,
		creatorID,
	).Scan(&conversationID)
	require.NoError(t, err)
	return conversationID
}

func seedMember(t *testing.T, ctx context.Context, pool *pgxpool.Pool, channelID, userID uuid.UUID) {
	t.Helper()
	_, err := pool.Exec(ctx, `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`, channelID, userID)
	require.NoError(t, err)
}

func seedActiveCall(t *testing.T, ctx context.Context, pool *pgxpool.Pool, channelID, creatorID uuid.UUID) (uuid.UUID, string) {
	t.Helper()
	callID := uuid.New()
	room := "call-" + callID.String()
	_, err := pool.Exec(ctx, `
		INSERT INTO calls (id, channel_id, status, livekit_room, created_by, started_at)
		VALUES ($1, $2, 'active', $3, $4, now())`,
		callID, channelID, room, creatorID,
	)
	require.NoError(t, err)
	return callID, room
}

func seedParticipant(t *testing.T, ctx context.Context, pool *pgxpool.Pool, callID, userID uuid.UUID) {
	t.Helper()
	_, err := pool.Exec(ctx, `
		INSERT INTO call_participants (call_id, user_id, joined_at, left_at)
		VALUES ($1, $2, now(), NULL)`,
		callID, userID,
	)
	require.NoError(t, err)
}

func seedPendingInviteWithNotification(t *testing.T, ctx context.Context, pool *pgxpool.Pool, callID, channelID, inviterID, inviteeID uuid.UUID) uuid.UUID {
	t.Helper()
	var inviteID uuid.UUID
	err := pool.QueryRow(ctx, `
		INSERT INTO call_invites (call_id, channel_id, inviter_id, invitee_id, state, expires_at, created_at, updated_at)
		VALUES ($1, $2, $3, $4, 'created', now() + interval '60 seconds', now(), now())
		RETURNING id`,
		callID, channelID, inviterID, inviteeID,
	).Scan(&inviteID)
	require.NoError(t, err)

	_, err = pool.Exec(ctx, `
		INSERT INTO notifications (user_id, type, title, body, channel_id, is_read, created_at)
		VALUES ($1, 'call_invite', 'Incoming call', 'Test call invite', $2, false, now())`,
		inviteeID, channelID,
	)
	require.NoError(t, err)
	return inviteID
}

func listUserCallPresenceEventCounts(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID uuid.UUID) []int {
	t.Helper()

	rows, err := pool.Query(ctx, `
		SELECT COALESCE((payload->>'activeCallCount')::int, 0)
		  FROM workspace_events
		 WHERE event_type = 'user_call_presence_changed'
		   AND payload->>'userId' = $1
		 ORDER BY event_seq ASC`, userID.String())
	require.NoError(t, err)
	defer rows.Close()

	counts := make([]int, 0, 4)
	for rows.Next() {
		var count int
		require.NoError(t, rows.Scan(&count))
		counts = append(counts, count)
	}
	require.NoError(t, rows.Err())
	return counts
}

func assertParticipantActive(t *testing.T, ctx context.Context, pool *pgxpool.Pool, callID, userID uuid.UUID, expected bool) {
	t.Helper()
	var active bool
	err := pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			  FROM call_participants
			 WHERE call_id = $1
			   AND user_id = $2
			   AND left_at IS NULL
		)`, callID, userID).Scan(&active)
	require.NoError(t, err)
	assert.Equal(t, expected, active)
}

func assertCallStatus(t *testing.T, ctx context.Context, pool *pgxpool.Pool, callID uuid.UUID, expected string) {
	t.Helper()
	var status string
	err := pool.QueryRow(ctx, `SELECT status FROM calls WHERE id = $1`, callID).Scan(&status)
	require.NoError(t, err)
	assert.Equal(t, expected, status)
}

func assertRaisedHands(t *testing.T, hands []*packetspb.CallRaisedHand, expectedUserIDs ...uuid.UUID) {
	t.Helper()
	require.Len(t, hands, len(expectedUserIDs))
	for index, userID := range expectedUserIDs {
		assert.Equal(t, userID.String(), hands[index].GetUserId())
		assert.Equal(t, int32(index+1), hands[index].GetPosition())
	}
}

func raisedHandEventCount(t *testing.T, ctx context.Context, pool *pgxpool.Pool, callID uuid.UUID) int {
	t.Helper()
	var count int
	err := pool.QueryRow(ctx, `
		SELECT COUNT(*)
		  FROM workspace_events
		 WHERE event_type = 'call_raised_hands_changed'
		   AND payload->>'callId' = $1`, callID.String()).Scan(&count)
	require.NoError(t, err)
	return count
}

func TestIntegration_SetHandRaised_OrdersQueueAcrossDuplicateCommandsLeavesAndRejoins(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	svc := NewService(pool, events.NewStore(pool), &config.Config{
		LiveKitURL:       "wss://livekit.example.test",
		LiveKitAPIKey:    "test-key",
		LiveKitAPISecret: "test-secret",
	})
	userA := seedCallUser(t, ctx, pool, "User A")
	userB := seedCallUser(t, ctx, pool, "User B")
	userC := seedCallUser(t, ctx, pool, "User C")
	channelID := seedCallChannel(t, ctx, pool, userA)
	for _, userID := range []uuid.UUID{userA, userB, userC} {
		seedMember(t, ctx, pool, channelID, userID)
	}
	callID, room := seedActiveCall(t, ctx, pool, channelID, userA)
	for _, userID := range []uuid.UUID{userA, userB, userC} {
		seedParticipant(t, ctx, pool, callID, userID)
	}

	raise := func(userID uuid.UUID) *SetHandRaisedResult {
		t.Helper()
		result, err := svc.SetHandRaised(ctx, SetHandRaisedParams{CallID: callID, ActorID: userID, Raised: true})
		require.NoError(t, err)
		return &result
	}
	lower := func(userID uuid.UUID) *SetHandRaisedResult {
		t.Helper()
		result, err := svc.SetHandRaised(ctx, SetHandRaisedParams{CallID: callID, ActorID: userID, Raised: false})
		require.NoError(t, err)
		return &result
	}

	assertRaisedHands(t, raise(userA).RaisedHands, userA)
	assertRaisedHands(t, raise(userB).RaisedHands, userA, userB)
	assertRaisedHands(t, raise(userC).RaisedHands, userA, userB, userC)
	assert.Equal(t, 3, raisedHandEventCount(t, ctx, pool, callID))

	// A duplicate raise is idempotent: it neither changes position nor emits an event.
	assertRaisedHands(t, raise(userA).RaisedHands, userA, userB, userC)
	assert.Equal(t, 3, raisedHandEventCount(t, ctx, pool, callID))

	assertRaisedHands(t, lower(userA).RaisedHands, userB, userC)
	assert.Equal(t, 4, raisedHandEventCount(t, ctx, pool, callID))
	assertRaisedHands(t, lower(userA).RaisedHands, userB, userC)
	assert.Equal(t, 4, raisedHandEventCount(t, ctx, pool, callID))

	// Re-raising goes to the tail instead of restoring the previous position.
	assertRaisedHands(t, raise(userA).RaisedHands, userB, userC, userA)

	// A transient token refresh keeps an active participant's hand and position.
	join, err := svc.JoinCallToken(ctx, JoinCallTokenParams{ConversationID: channelID, UserID: userB})
	require.NoError(t, err)
	assertRaisedHands(t, join.RaisedHands, userB, userC, userA)

	// A confirmed leave removes the hand, renumbers everyone, and a later rejoin
	// must explicitly raise again at the end of the queue.
	processed, err := svc.HandleWebhook(ctx, &lkwebhookEvent{
		Event:               webhookEventParticipantLeft,
		RoomName:            room,
		ParticipantIdentity: userB.String(),
	})
	require.NoError(t, err)
	assert.False(t, processed)

	join, err = svc.JoinCallToken(ctx, JoinCallTokenParams{ConversationID: channelID, UserID: userB})
	require.NoError(t, err)
	assertRaisedHands(t, join.RaisedHands, userC, userA)
	assertRaisedHands(t, raise(userB).RaisedHands, userC, userA, userB)
}

func TestIntegration_HandleWebhook_ParticipantLeftEndsCallWhenRoomBecomesEmpty(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := NewService(pool, store, &config.Config{})

	creatorID := seedCallUser(t, ctx, pool, "Creator")
	channelID := seedCallChannel(t, ctx, pool, creatorID)
	seedMember(t, ctx, pool, channelID, creatorID)
	callID, room := seedActiveCall(t, ctx, pool, channelID, creatorID)
	seedParticipant(t, ctx, pool, callID, creatorID)

	processed, err := svc.HandleWebhook(ctx, &lkwebhookEvent{
		Event:               "participant_left",
		RoomName:            room,
		ParticipantIdentity: creatorID.String(),
	})
	require.NoError(t, err)
	assert.True(t, processed)

	var status string
	err = pool.QueryRow(ctx, `SELECT status FROM calls WHERE id = $1`, callID).Scan(&status)
	require.NoError(t, err)
	assert.Equal(t, "ended", status)

	var leftCount int
	err = pool.QueryRow(ctx, `
		SELECT COUNT(*)
		  FROM call_participants
		 WHERE call_id = $1
		   AND left_at IS NOT NULL`, callID).Scan(&leftCount)
	require.NoError(t, err)
	assert.Equal(t, 1, leftCount)

	var eventCount int
	err = pool.QueryRow(ctx, `
		SELECT COUNT(*)
		  FROM workspace_events
		 WHERE channel_id = $1
		   AND event_type = 'call_state_changed'`, channelID.String()).Scan(&eventCount)
	require.NoError(t, err)
	assert.Equal(t, 1, eventCount)
}

func TestIntegration_HandleWebhook_ParticipantLeftKeepsCallActiveWhenOthersRemain(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := NewService(pool, store, &config.Config{})

	userA := seedCallUser(t, ctx, pool, "User A")
	userB := seedCallUser(t, ctx, pool, "User B")
	channelID := seedCallChannel(t, ctx, pool, userA)
	seedMember(t, ctx, pool, channelID, userA)
	seedMember(t, ctx, pool, channelID, userB)
	callID, room := seedActiveCall(t, ctx, pool, channelID, userA)
	seedParticipant(t, ctx, pool, callID, userA)
	seedParticipant(t, ctx, pool, callID, userB)

	processed, err := svc.HandleWebhook(ctx, &lkwebhookEvent{
		Event:               "participant_left",
		RoomName:            room,
		ParticipantIdentity: userA.String(),
	})
	require.NoError(t, err)
	assert.False(t, processed)

	var status string
	err = pool.QueryRow(ctx, `SELECT status FROM calls WHERE id = $1`, callID).Scan(&status)
	require.NoError(t, err)
	assert.Equal(t, "active", status)

	var activeParticipants int
	err = pool.QueryRow(ctx, `
		SELECT COUNT(*)
		  FROM call_participants
		 WHERE call_id = $1
		   AND left_at IS NULL`, callID).Scan(&activeParticipants)
	require.NoError(t, err)
	assert.Equal(t, 1, activeParticipants)
}

func TestIntegration_HandleWebhook_ParticipantLeftEndsCallWhenRoomSnapshotIsEmpty(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := NewService(pool, store, &config.Config{})

	userA := seedCallUser(t, ctx, pool, "User A")
	ghostUser := seedCallUser(t, ctx, pool, "Ghost User")
	channelID := seedCallChannel(t, ctx, pool, userA)
	seedMember(t, ctx, pool, channelID, userA)
	seedMember(t, ctx, pool, channelID, ghostUser)
	callID, room := seedActiveCall(t, ctx, pool, channelID, userA)
	seedParticipant(t, ctx, pool, callID, userA)
	seedParticipant(t, ctx, pool, callID, ghostUser) // stale participant row that did not leave yet

	processed, err := svc.HandleWebhook(ctx, &lkwebhookEvent{
		Event:               "participant_left",
		RoomName:            room,
		ParticipantIdentity: userA.String(),
		RoomNumParticipants: 0,
		HasRoomSnapshot:     true,
	})
	require.NoError(t, err)
	assert.True(t, processed)

	var status string
	err = pool.QueryRow(ctx, `SELECT status FROM calls WHERE id = $1`, callID).Scan(&status)
	require.NoError(t, err)
	assert.Equal(t, "ended", status)
}

func TestIntegration_HandleWebhook_EndCallAutoRejectsPendingInvites(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := NewService(pool, store, &config.Config{})

	initiatorID := seedCallUser(t, ctx, pool, "Initiator")
	inviteeID := seedCallUser(t, ctx, pool, "Invitee")
	channelID := seedCallChannel(t, ctx, pool, initiatorID)
	seedMember(t, ctx, pool, channelID, initiatorID)
	seedMember(t, ctx, pool, channelID, inviteeID)
	callID, room := seedActiveCall(t, ctx, pool, channelID, initiatorID)
	seedParticipant(t, ctx, pool, callID, initiatorID)
	inviteID := seedPendingInviteWithNotification(t, ctx, pool, callID, channelID, initiatorID, inviteeID)

	processed, err := svc.HandleWebhook(ctx, &lkwebhookEvent{
		Event:               "participant_left",
		RoomName:            room,
		ParticipantIdentity: initiatorID.String(),
		RoomNumParticipants: 0,
		HasRoomSnapshot:     true,
	})
	require.NoError(t, err)
	assert.True(t, processed)

	var inviteState string
	err = pool.QueryRow(ctx, `SELECT state FROM call_invites WHERE id = $1`, inviteID).Scan(&inviteState)
	require.NoError(t, err)
	assert.Equal(t, "rejected", inviteState)

	var inviteEventCount int
	err = pool.QueryRow(ctx, `
		SELECT COUNT(*)
		  FROM workspace_events
		 WHERE channel_id = $1
		   AND event_type = 'call_invite_cancelled'`, channelID.String()).Scan(&inviteEventCount)
	require.NoError(t, err)
	assert.Equal(t, 1, inviteEventCount)

	var resolvedNotificationEvents int
	err = pool.QueryRow(ctx, `
		SELECT COUNT(*)
		  FROM workspace_events
		 WHERE channel_id = $1
		   AND event_type = 'notification_resolved'`, channelID.String()).Scan(&resolvedNotificationEvents)
	require.NoError(t, err)
	assert.Equal(t, 1, resolvedNotificationEvents)
}

func TestIntegration_CreateCall_AppendsUserCallPresenceChangedEvent(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := NewService(pool, store, &config.Config{CallInviteTTL: time.Minute})

	initiatorID := seedCallUser(t, ctx, pool, "Initiator")
	channelID := seedCallChannel(t, ctx, pool, initiatorID)
	seedMember(t, ctx, pool, channelID, initiatorID)

	result, err := svc.CreateCall(ctx, CreateCallParams{
		ConversationID: channelID,
		InitiatorID:    initiatorID,
	})
	require.NoError(t, err)
	assert.Equal(t, packetspb.CallStatus_CALL_STATUS_ACTIVE, result.Status)
	assert.Equal(t, []int{1}, listUserCallPresenceEventCounts(t, ctx, pool, initiatorID))
}

func TestIntegration_CreateCall_NewInviteRejectsOlderInviteForSameInvitee(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := NewService(pool, store, &config.Config{CallInviteTTL: time.Minute})

	initiatorID := seedCallUser(t, ctx, pool, "Initiator")
	inviteeID := seedCallUser(t, ctx, pool, "Invitee")
	channelA := seedCallChannel(t, ctx, pool, initiatorID)
	channelB := seedCallChannel(t, ctx, pool, initiatorID)
	seedMember(t, ctx, pool, channelA, initiatorID)
	seedMember(t, ctx, pool, channelA, inviteeID)
	seedMember(t, ctx, pool, channelB, initiatorID)
	seedMember(t, ctx, pool, channelB, inviteeID)

	first, err := svc.CreateCall(ctx, CreateCallParams{
		ConversationID: channelA,
		InitiatorID:    initiatorID,
		InviteeUserIDs: []uuid.UUID{inviteeID},
	})
	require.NoError(t, err)
	require.Len(t, first.DirectDeliveries, 2) // invite created + notification added

	second, err := svc.CreateCall(ctx, CreateCallParams{
		ConversationID: channelB,
		InitiatorID:    initiatorID,
		InviteeUserIDs: []uuid.UUID{inviteeID},
	})
	require.NoError(t, err)

	var createdCount int
	var rejectedCount int
	err = pool.QueryRow(ctx, `
		SELECT
			COUNT(*) FILTER (WHERE state = 'created')::int,
			COUNT(*) FILTER (WHERE state = 'rejected')::int
		FROM call_invites
		WHERE invitee_id = $1`, inviteeID).Scan(&createdCount, &rejectedCount)
	require.NoError(t, err)
	assert.Equal(t, 1, createdCount)
	assert.Equal(t, 1, rejectedCount)

	var cancelledDelivered bool
	for _, delivery := range second.DirectDeliveries {
		if delivery.Event != nil && delivery.Event.GetCallInviteCancelled() != nil {
			cancelledDelivered = true
			break
		}
	}
	assert.True(t, cancelledDelivered, "second create should deliver cancellation for older invite")
}

func TestIntegration_InviteCallMembers_CreatesInviteAndNotification(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := NewService(pool, store, &config.Config{CallInviteTTL: time.Minute})

	actorID := seedCallUser(t, ctx, pool, "Actor")
	inviteeID := seedCallUser(t, ctx, pool, "Invitee")
	channelID := seedCallChannel(t, ctx, pool, actorID)
	seedMember(t, ctx, pool, channelID, actorID)
	seedMember(t, ctx, pool, channelID, inviteeID)
	callID, _ := seedActiveCall(t, ctx, pool, channelID, actorID)
	seedParticipant(t, ctx, pool, callID, actorID)

	result, err := svc.InviteCallMembers(ctx, InviteCallMembersParams{
		ConversationID: channelID,
		ActorID:        actorID,
		InviteeUserIDs: []uuid.UUID{inviteeID},
	})
	require.NoError(t, err)
	assert.Equal(t, callID, result.CallID)
	assert.Equal(t, channelID, result.ConversationID)
	assert.Equal(t, []uuid.UUID{inviteeID}, result.InvitedUserIDs)
	assert.Empty(t, result.SkippedUserIDs)
	require.Len(t, result.DirectDeliveries, 2)

	var inviteState string
	err = pool.QueryRow(ctx, `SELECT state FROM call_invites WHERE call_id = $1 AND invitee_id = $2`, callID, inviteeID).Scan(&inviteState)
	require.NoError(t, err)
	assert.Equal(t, "created", inviteState)
}

func TestIntegration_InviteCallMembers_SkipsAlreadyInCallMembers(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := NewService(pool, store, &config.Config{CallInviteTTL: time.Minute})

	actorID := seedCallUser(t, ctx, pool, "Actor")
	inviteeID := seedCallUser(t, ctx, pool, "Invitee")
	channelID := seedCallChannel(t, ctx, pool, actorID)
	seedMember(t, ctx, pool, channelID, actorID)
	seedMember(t, ctx, pool, channelID, inviteeID)
	callID, _ := seedActiveCall(t, ctx, pool, channelID, actorID)
	seedParticipant(t, ctx, pool, callID, actorID)
	seedParticipant(t, ctx, pool, callID, inviteeID)

	result, err := svc.InviteCallMembers(ctx, InviteCallMembersParams{
		ConversationID: channelID,
		ActorID:        actorID,
		InviteeUserIDs: []uuid.UUID{inviteeID},
	})
	require.NoError(t, err)
	assert.Empty(t, result.InvitedUserIDs)
	assert.Equal(t, []uuid.UUID{inviteeID}, result.SkippedUserIDs)
	assert.Empty(t, result.DirectDeliveries)

	var inviteCount int
	err = pool.QueryRow(ctx, `SELECT COUNT(*) FROM call_invites WHERE call_id = $1 AND invitee_id = $2`, callID, inviteeID).Scan(&inviteCount)
	require.NoError(t, err)
	assert.Equal(t, 0, inviteCount)
}

func TestIntegration_InviteCallMembers_SkipsPendingInviteesForSameCall(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := NewService(pool, store, &config.Config{CallInviteTTL: time.Minute})

	actorID := seedCallUser(t, ctx, pool, "Actor")
	inviteeID := seedCallUser(t, ctx, pool, "Invitee")
	channelID := seedCallChannel(t, ctx, pool, actorID)
	seedMember(t, ctx, pool, channelID, actorID)
	seedMember(t, ctx, pool, channelID, inviteeID)
	callID, _ := seedActiveCall(t, ctx, pool, channelID, actorID)
	seedParticipant(t, ctx, pool, callID, actorID)
	seedPendingInviteWithNotification(t, ctx, pool, callID, channelID, actorID, inviteeID)

	result, err := svc.InviteCallMembers(ctx, InviteCallMembersParams{
		ConversationID: channelID,
		ActorID:        actorID,
		InviteeUserIDs: []uuid.UUID{inviteeID},
	})
	require.NoError(t, err)
	assert.Empty(t, result.InvitedUserIDs)
	assert.Equal(t, []uuid.UUID{inviteeID}, result.SkippedUserIDs)
	assert.Empty(t, result.DirectDeliveries)
}

func TestIntegration_InviteCallMembers_InvitesActiveUsersWhoAreNotConversationMembers(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := NewService(pool, store, &config.Config{CallInviteTTL: time.Minute})

	actorID := seedCallUser(t, ctx, pool, "Actor")
	memberInviteeID := seedCallUser(t, ctx, pool, "Member Invitee")
	outsiderID := seedCallUser(t, ctx, pool, "Outsider")
	channelID := seedCallChannel(t, ctx, pool, actorID)
	seedMember(t, ctx, pool, channelID, actorID)
	seedMember(t, ctx, pool, channelID, memberInviteeID)
	callID, _ := seedActiveCall(t, ctx, pool, channelID, actorID)
	seedParticipant(t, ctx, pool, callID, actorID)

	result, err := svc.InviteCallMembers(ctx, InviteCallMembersParams{
		ConversationID: channelID,
		ActorID:        actorID,
		InviteeUserIDs: []uuid.UUID{memberInviteeID, outsiderID},
	})
	require.NoError(t, err)
	assert.ElementsMatch(t, []uuid.UUID{memberInviteeID, outsiderID}, result.InvitedUserIDs)
	assert.Empty(t, result.SkippedUserIDs)
}

func TestIntegration_InviteCallMembers_SkipsBlockedUsers(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := NewService(pool, store, &config.Config{CallInviteTTL: time.Minute})

	actorID := seedCallUser(t, ctx, pool, "Actor")
	activeInviteeID := seedCallUser(t, ctx, pool, "Active Invitee")
	blockedInviteeID := seedCallUserWithStatus(t, ctx, pool, "Blocked Invitee", "blocked")
	channelID := seedCallChannel(t, ctx, pool, actorID)
	seedMember(t, ctx, pool, channelID, actorID)
	callID, _ := seedActiveCall(t, ctx, pool, channelID, actorID)
	seedParticipant(t, ctx, pool, callID, actorID)

	result, err := svc.InviteCallMembers(ctx, InviteCallMembersParams{
		ConversationID: channelID,
		ActorID:        actorID,
		InviteeUserIDs: []uuid.UUID{activeInviteeID, blockedInviteeID},
	})
	require.NoError(t, err)
	assert.Equal(t, []uuid.UUID{activeInviteeID}, result.InvitedUserIDs)
	assert.Equal(t, []uuid.UUID{blockedInviteeID}, result.SkippedUserIDs)
}

func TestIntegration_InviteCallMembers_FailsForActorWhoIsNotCallParticipant(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := NewService(pool, store, &config.Config{CallInviteTTL: time.Minute})

	ownerID := seedCallUser(t, ctx, pool, "Owner")
	actorID := seedCallUser(t, ctx, pool, "Actor")
	inviteeID := seedCallUser(t, ctx, pool, "Invitee")
	channelID := seedCallChannel(t, ctx, pool, ownerID)
	seedMember(t, ctx, pool, channelID, ownerID)
	seedMember(t, ctx, pool, channelID, inviteeID)
	callID, _ := seedActiveCall(t, ctx, pool, channelID, ownerID)
	seedParticipant(t, ctx, pool, callID, ownerID)

	_, err := svc.InviteCallMembers(ctx, InviteCallMembersParams{
		ConversationID: channelID,
		ActorID:        actorID,
		InviteeUserIDs: []uuid.UUID{inviteeID},
	})
	require.ErrorIs(t, err, ErrForbiddenAction)
}

func TestIntegration_InviteCallMembers_AllowsNonMemberParticipantActor(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := NewService(pool, store, &config.Config{CallInviteTTL: time.Minute})

	ownerID := seedCallUser(t, ctx, pool, "Owner")
	memberPeerID := seedCallUser(t, ctx, pool, "Member Peer")
	outsiderActorID := seedCallUser(t, ctx, pool, "Outsider Actor")
	targetID := seedCallUser(t, ctx, pool, "Target")
	channelID := seedCallChannel(t, ctx, pool, ownerID)
	seedMember(t, ctx, pool, channelID, ownerID)
	seedMember(t, ctx, pool, channelID, memberPeerID)
	callID, _ := seedActiveCall(t, ctx, pool, channelID, ownerID)
	seedParticipant(t, ctx, pool, callID, ownerID)
	seedParticipant(t, ctx, pool, callID, outsiderActorID)

	result, err := svc.InviteCallMembers(ctx, InviteCallMembersParams{
		ConversationID: channelID,
		ActorID:        outsiderActorID,
		InviteeUserIDs: []uuid.UUID{targetID},
	})
	require.NoError(t, err)
	assert.Equal(t, []uuid.UUID{targetID}, result.InvitedUserIDs)
	assert.Empty(t, result.SkippedUserIDs)
}

func TestIntegration_InviteCallMembers_AllowsDMParticipantToInviteOutsiders(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := NewService(pool, store, &config.Config{CallInviteTTL: time.Minute})

	ownerID := seedCallUser(t, ctx, pool, "Owner")
	dmPeerID := seedCallUser(t, ctx, pool, "DM Peer")
	outsiderID := seedCallUser(t, ctx, pool, "Outsider")
	targetID := seedCallUser(t, ctx, pool, "Target")
	dmID := seedCallDMConversation(t, ctx, pool, ownerID)
	seedMember(t, ctx, pool, dmID, ownerID)
	seedMember(t, ctx, pool, dmID, dmPeerID)
	callID, _ := seedActiveCall(t, ctx, pool, dmID, ownerID)
	seedParticipant(t, ctx, pool, callID, ownerID)
	seedParticipant(t, ctx, pool, callID, outsiderID)

	result, err := svc.InviteCallMembers(ctx, InviteCallMembersParams{
		ConversationID: dmID,
		ActorID:        outsiderID,
		InviteeUserIDs: []uuid.UUID{targetID},
	})
	require.NoError(t, err)
	assert.Equal(t, []uuid.UUID{targetID}, result.InvitedUserIDs)
	assert.Empty(t, result.SkippedUserIDs)
}

func TestIntegration_AcceptInvite_AppendsActiveCallStateDelivery(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := NewService(pool, store, &config.Config{CallInviteTTL: time.Minute})

	ownerID := seedCallUser(t, ctx, pool, "Owner")
	memberPeerID := seedCallUser(t, ctx, pool, "Member Peer")
	inviteeID := seedCallUser(t, ctx, pool, "Invitee")
	dmID := seedCallDMConversation(t, ctx, pool, ownerID)
	seedMember(t, ctx, pool, dmID, ownerID)
	seedMember(t, ctx, pool, dmID, memberPeerID)
	callID, _ := seedActiveCall(t, ctx, pool, dmID, ownerID)
	seedParticipant(t, ctx, pool, callID, ownerID)
	inviteID := seedPendingInviteWithNotification(t, ctx, pool, callID, dmID, ownerID, inviteeID)

	result, err := svc.AcceptInvite(ctx, InviteActionParams{
		InviteID: inviteID,
		ActorID:  inviteeID,
	})
	require.NoError(t, err)
	assert.Equal(t, packetspb.InviteState_INVITE_STATE_ACCEPTED, result.ResultingState)
	assert.True(t, result.Applied)

	var acceptedState string
	err = pool.QueryRow(ctx, `SELECT state FROM call_invites WHERE id = $1`, inviteID).Scan(&acceptedState)
	require.NoError(t, err)
	assert.Equal(t, "accepted", acceptedState)

	var participantActive bool
	err = pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM call_participants
			WHERE call_id = $1
			  AND user_id = $2
			  AND left_at IS NULL
		)`, callID, inviteeID).Scan(&participantActive)
	require.NoError(t, err)
	assert.True(t, participantActive)

	var sawActiveCallState bool
	for _, delivery := range result.DirectDeliveries {
		if delivery.UserID != inviteeID.String() || delivery.Event == nil {
			continue
		}
		callState := delivery.Event.GetCallStateChanged()
		if callState == nil {
			continue
		}
		sawActiveCallState = true
		assert.Equal(t, callID.String(), callState.GetCallId())
		assert.Equal(t, dmID.String(), callState.GetConversationId())
		assert.Equal(t, packetspb.CallStatus_CALL_STATUS_ACTIVE, callState.GetStatus())
	}
	assert.True(t, sawActiveCallState, "accept invite should deliver active call state to invitee")
	assert.Equal(t, []int{1}, listUserCallPresenceEventCounts(t, ctx, pool, inviteeID))
}

func TestIntegration_AcceptInvite_LeaveExistingCallsLeavesPriorCallWithOtherParticipants(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := NewService(pool, store, &config.Config{CallInviteTTL: time.Minute})

	ownerID := seedCallUser(t, ctx, pool, "Owner")
	inviteeID := seedCallUser(t, ctx, pool, "Invitee")
	remainingID := seedCallUser(t, ctx, pool, "Remaining")
	oldChannelID := seedCallChannel(t, ctx, pool, inviteeID)
	targetChannelID := seedCallChannel(t, ctx, pool, ownerID)
	seedMember(t, ctx, pool, oldChannelID, inviteeID)
	seedMember(t, ctx, pool, oldChannelID, remainingID)
	seedMember(t, ctx, pool, targetChannelID, ownerID)
	seedMember(t, ctx, pool, targetChannelID, inviteeID)
	oldCallID, _ := seedActiveCall(t, ctx, pool, oldChannelID, inviteeID)
	targetCallID, _ := seedActiveCall(t, ctx, pool, targetChannelID, ownerID)
	seedParticipant(t, ctx, pool, oldCallID, inviteeID)
	seedParticipant(t, ctx, pool, oldCallID, remainingID)
	seedParticipant(t, ctx, pool, targetCallID, ownerID)
	inviteID := seedPendingInviteWithNotification(t, ctx, pool, targetCallID, targetChannelID, ownerID, inviteeID)

	result, err := svc.AcceptInvite(ctx, InviteActionParams{
		InviteID:           inviteID,
		ActorID:            inviteeID,
		LeaveExistingCalls: true,
	})
	require.NoError(t, err)
	assert.True(t, result.Applied)

	assertParticipantActive(t, ctx, pool, oldCallID, inviteeID, false)
	assertParticipantActive(t, ctx, pool, oldCallID, remainingID, true)
	assertParticipantActive(t, ctx, pool, targetCallID, inviteeID, true)
	assertCallStatus(t, ctx, pool, oldCallID, "active")
	assert.Empty(t, listUserCallPresenceEventCounts(t, ctx, pool, inviteeID))
}

func TestIntegration_AcceptInvite_LeaveExistingCallsEndsEmptyPriorCall(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := NewService(pool, store, &config.Config{CallInviteTTL: time.Minute})

	ownerID := seedCallUser(t, ctx, pool, "Owner")
	inviteeID := seedCallUser(t, ctx, pool, "Invitee")
	oldInviteeID := seedCallUser(t, ctx, pool, "Old Invitee")
	oldChannelID := seedCallChannel(t, ctx, pool, inviteeID)
	targetChannelID := seedCallChannel(t, ctx, pool, ownerID)
	seedMember(t, ctx, pool, oldChannelID, inviteeID)
	seedMember(t, ctx, pool, oldChannelID, oldInviteeID)
	seedMember(t, ctx, pool, targetChannelID, ownerID)
	seedMember(t, ctx, pool, targetChannelID, inviteeID)
	oldCallID, _ := seedActiveCall(t, ctx, pool, oldChannelID, inviteeID)
	targetCallID, _ := seedActiveCall(t, ctx, pool, targetChannelID, ownerID)
	seedParticipant(t, ctx, pool, oldCallID, inviteeID)
	seedParticipant(t, ctx, pool, targetCallID, ownerID)
	oldInviteID := seedPendingInviteWithNotification(t, ctx, pool, oldCallID, oldChannelID, inviteeID, oldInviteeID)
	targetInviteID := seedPendingInviteWithNotification(t, ctx, pool, targetCallID, targetChannelID, ownerID, inviteeID)

	_, err := svc.AcceptInvite(ctx, InviteActionParams{
		InviteID:           targetInviteID,
		ActorID:            inviteeID,
		LeaveExistingCalls: true,
	})
	require.NoError(t, err)

	assertParticipantActive(t, ctx, pool, oldCallID, inviteeID, false)
	assertParticipantActive(t, ctx, pool, targetCallID, inviteeID, true)
	assertCallStatus(t, ctx, pool, oldCallID, "ended")
	assert.Empty(t, listUserCallPresenceEventCounts(t, ctx, pool, inviteeID))

	var oldInviteState string
	err = pool.QueryRow(ctx, `SELECT state FROM call_invites WHERE id = $1`, oldInviteID).Scan(&oldInviteState)
	require.NoError(t, err)
	assert.Equal(t, "rejected", oldInviteState)

	var endedEvents int
	err = pool.QueryRow(ctx, `
		SELECT COUNT(*)
		  FROM workspace_events
		 WHERE event_type = 'call_state_changed'
		   AND payload->>'callId' = $1
		   AND payload->>'status' = 'CALL_STATUS_ENDED'`, oldCallID.String()).Scan(&endedEvents)
	require.NoError(t, err)
	assert.Equal(t, 1, endedEvents)
}

func TestIntegration_AcceptInvite_LeaveExistingCallsDoesNotLeaveWhenInviteInactive(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := NewService(pool, store, &config.Config{CallInviteTTL: time.Minute})

	ownerID := seedCallUser(t, ctx, pool, "Owner")
	inviteeID := seedCallUser(t, ctx, pool, "Invitee")
	oldChannelID := seedCallChannel(t, ctx, pool, inviteeID)
	targetChannelID := seedCallChannel(t, ctx, pool, ownerID)
	oldCallID, _ := seedActiveCall(t, ctx, pool, oldChannelID, inviteeID)
	targetCallID, _ := seedActiveCall(t, ctx, pool, targetChannelID, ownerID)
	seedParticipant(t, ctx, pool, oldCallID, inviteeID)
	seedParticipant(t, ctx, pool, targetCallID, ownerID)
	inviteID := seedPendingInviteWithNotification(t, ctx, pool, targetCallID, targetChannelID, ownerID, inviteeID)
	_, err := pool.Exec(ctx, `UPDATE call_invites SET state = 'rejected' WHERE id = $1`, inviteID)
	require.NoError(t, err)

	_, err = svc.AcceptInvite(ctx, InviteActionParams{
		InviteID:           inviteID,
		ActorID:            inviteeID,
		LeaveExistingCalls: true,
	})
	require.ErrorIs(t, err, ErrInviteNotActive)
	assertParticipantActive(t, ctx, pool, oldCallID, inviteeID, true)
	assertCallStatus(t, ctx, pool, oldCallID, "active")
}

func TestIntegration_AcceptInvite_LeaveExistingCallsDoesNotLeaveWhenForbidden(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := NewService(pool, store, &config.Config{CallInviteTTL: time.Minute})

	ownerID := seedCallUser(t, ctx, pool, "Owner")
	inviteeID := seedCallUser(t, ctx, pool, "Invitee")
	actorID := seedCallUser(t, ctx, pool, "Wrong Actor")
	oldChannelID := seedCallChannel(t, ctx, pool, actorID)
	targetChannelID := seedCallChannel(t, ctx, pool, ownerID)
	oldCallID, _ := seedActiveCall(t, ctx, pool, oldChannelID, actorID)
	targetCallID, _ := seedActiveCall(t, ctx, pool, targetChannelID, ownerID)
	seedParticipant(t, ctx, pool, oldCallID, actorID)
	seedParticipant(t, ctx, pool, targetCallID, ownerID)
	inviteID := seedPendingInviteWithNotification(t, ctx, pool, targetCallID, targetChannelID, ownerID, inviteeID)

	_, err := svc.AcceptInvite(ctx, InviteActionParams{
		InviteID:           inviteID,
		ActorID:            actorID,
		LeaveExistingCalls: true,
	})
	require.ErrorIs(t, err, ErrForbiddenAction)
	assertParticipantActive(t, ctx, pool, oldCallID, actorID, true)
	assertCallStatus(t, ctx, pool, oldCallID, "active")
}

func TestIntegration_InviteCallMembers_FailsWhenNoActiveCall(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := NewService(pool, store, &config.Config{CallInviteTTL: time.Minute})

	actorID := seedCallUser(t, ctx, pool, "Actor")
	inviteeID := seedCallUser(t, ctx, pool, "Invitee")
	channelID := seedCallChannel(t, ctx, pool, actorID)
	seedMember(t, ctx, pool, channelID, actorID)
	seedMember(t, ctx, pool, channelID, inviteeID)

	_, err := svc.InviteCallMembers(ctx, InviteCallMembersParams{
		ConversationID: channelID,
		ActorID:        actorID,
		InviteeUserIDs: []uuid.UUID{inviteeID},
	})
	require.ErrorIs(t, err, ErrCallNotActive)
}

func TestIntegration_JoinCallToken_AllowsNonMemberActiveParticipant(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := NewService(pool, store, &config.Config{
		LiveKitURL:       "ws://localhost:7880",
		LiveKitAPIKey:    "test-key",
		LiveKitAPISecret: "test-secret",
	})

	ownerID := seedCallUser(t, ctx, pool, "Owner")
	memberPeerID := seedCallUser(t, ctx, pool, "Member Peer")
	outsiderID := seedCallUser(t, ctx, pool, "Outsider")
	channelID := seedCallChannel(t, ctx, pool, ownerID)
	seedMember(t, ctx, pool, channelID, ownerID)
	seedMember(t, ctx, pool, channelID, memberPeerID)
	callID, _ := seedActiveCall(t, ctx, pool, channelID, ownerID)
	seedParticipant(t, ctx, pool, callID, ownerID)
	seedParticipant(t, ctx, pool, callID, outsiderID)

	result, err := svc.JoinCallToken(ctx, JoinCallTokenParams{
		ConversationID: channelID,
		UserID:         outsiderID,
	})
	require.NoError(t, err)
	assert.Equal(t, "ws://localhost:7880", result.LiveKitURL)
	assert.NotEmpty(t, result.LiveKitToken)
	assert.NotEmpty(t, result.LiveKitRoom)
}

func TestIntegration_JoinCallToken_AppendsUserCallPresenceChangedEvent(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := NewService(pool, store, &config.Config{
		LiveKitURL:       "ws://localhost:7880",
		LiveKitAPIKey:    "test-key",
		LiveKitAPISecret: "test-secret",
	})

	ownerID := seedCallUser(t, ctx, pool, "Owner")
	memberID := seedCallUser(t, ctx, pool, "Member")
	channelID := seedCallChannel(t, ctx, pool, ownerID)
	seedMember(t, ctx, pool, channelID, ownerID)
	seedMember(t, ctx, pool, channelID, memberID)
	callID, _ := seedActiveCall(t, ctx, pool, channelID, ownerID)
	seedParticipant(t, ctx, pool, callID, ownerID)

	_, err := svc.JoinCallToken(ctx, JoinCallTokenParams{
		ConversationID: channelID,
		UserID:         memberID,
	})
	require.NoError(t, err)
	assert.Equal(t, []int{1}, listUserCallPresenceEventCounts(t, ctx, pool, memberID))
}

func TestIntegration_JoinCallToken_FailsForNonMemberNonParticipant(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := NewService(pool, store, &config.Config{
		LiveKitURL:       "ws://localhost:7880",
		LiveKitAPIKey:    "test-key",
		LiveKitAPISecret: "test-secret",
	})

	ownerID := seedCallUser(t, ctx, pool, "Owner")
	memberPeerID := seedCallUser(t, ctx, pool, "Member Peer")
	outsiderID := seedCallUser(t, ctx, pool, "Outsider")
	channelID := seedCallChannel(t, ctx, pool, ownerID)
	seedMember(t, ctx, pool, channelID, ownerID)
	seedMember(t, ctx, pool, channelID, memberPeerID)
	callID, _ := seedActiveCall(t, ctx, pool, channelID, ownerID)
	seedParticipant(t, ctx, pool, callID, ownerID)

	_, err := svc.JoinCallToken(ctx, JoinCallTokenParams{
		ConversationID: channelID,
		UserID:         outsiderID,
	})
	require.ErrorIs(t, err, ErrNotMember)
}

func TestIntegration_UserCallPresence_StaysNonZeroUntilLastActiveCallEnds(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := NewService(pool, store, &config.Config{})

	userID := seedCallUser(t, ctx, pool, "Busy User")
	channelOneID := seedCallChannel(t, ctx, pool, userID)
	channelTwoID := seedCallChannel(t, ctx, pool, userID)
	seedMember(t, ctx, pool, channelOneID, userID)
	seedMember(t, ctx, pool, channelTwoID, userID)

	callOneID, roomOne := seedActiveCall(t, ctx, pool, channelOneID, userID)
	callTwoID, roomTwo := seedActiveCall(t, ctx, pool, channelTwoID, userID)
	seedParticipant(t, ctx, pool, callOneID, userID)
	seedParticipant(t, ctx, pool, callTwoID, userID)

	processed, err := svc.HandleWebhook(ctx, &lkwebhookEvent{
		Event:               "participant_left",
		RoomName:            roomOne,
		ParticipantIdentity: userID.String(),
	})
	require.NoError(t, err)
	assert.True(t, processed)

	processed, err = svc.HandleWebhook(ctx, &lkwebhookEvent{
		Event:    "room_finished",
		RoomName: roomTwo,
	})
	require.NoError(t, err)
	assert.True(t, processed)

	assert.Equal(t, []int{1, 0}, listUserCallPresenceEventCounts(t, ctx, pool, userID))
}
