package ws

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"

	"msgnr/internal/auth"
	"msgnr/internal/database"
	"msgnr/internal/events"
	packetspb "msgnr/internal/gen/proto"
	"msgnr/internal/testdb"
)

func newPresenceTestServer(pool *pgxpool.Pool) *Server {
	return &Server{
		db:                    &database.DB{Pool: pool},
		log:                   zap.NewNop(),
		sessionsByUser:        make(map[string]map[chan outboundMsg]*sessionState),
		collabRooms:           make(map[string]*collabRoom),
		collabRoomsBySession:  make(map[chan outboundMsg]map[string]struct{}),
		presenceLeaseTTL:      defaultPresenceLeaseTTL,
		presenceSweepInterval: defaultPresenceSweepInt,
	}
}

func createPresenceUsersAndChannel(t *testing.T, ctx context.Context, pool *pgxpool.Pool) (uuid.UUID, uuid.UUID) {
	t.Helper()

	var userA, userB, channelID uuid.UUID
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'user-a', 'member')
		 RETURNING id`,
		"usera_"+uuid.NewString()+"@example.com",
	).Scan(&userA))
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'user-b', 'member')
		 RETURNING id`,
		"userb_"+uuid.NewString()+"@example.com",
	).Scan(&userB))
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO channels (kind, visibility, name, created_by)
		 VALUES ('channel', 'public', 'presence', $1)
		 RETURNING id`,
		userA,
	).Scan(&channelID))
	_, err := pool.Exec(ctx,
		`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2), ($1, $3)`,
		channelID, userA, userB,
	)
	require.NoError(t, err)

	return userA, userB
}

func createPresenceDirectMessage(t *testing.T, ctx context.Context, pool *pgxpool.Pool) (uuid.UUID, uuid.UUID) {
	t.Helper()
	userA, userB := createPresenceUsersAndChannel(t, ctx, pool)
	var channelID uuid.UUID
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO channels (kind, visibility, name, created_by)
		 VALUES ('dm', 'dm', '', $1)
		 RETURNING id`,
		userA,
	).Scan(&channelID))
	_, err := pool.Exec(ctx,
		`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2), ($1, $3)`,
		channelID, userA, userB,
	)
	require.NoError(t, err)
	return userA, userB
}

func createRefreshSession(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID uuid.UUID) uuid.UUID {
	t.Helper()

	var sessionID uuid.UUID
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO refresh_sessions (user_id, token_hash, user_agent, ip_addr, expires_at)
		 VALUES ($1, $2, 'agent', '127.0.0.1', now() + interval '1 day')
		 RETURNING id`,
		userID, "token_"+uuid.NewString(),
	).Scan(&sessionID))
	return sessionID
}

func applyPresenceLeaseChange(
	t *testing.T,
	ctx context.Context,
	srv *Server,
	userID, sessionID, connectionID uuid.UUID,
	heartbeatCapable bool,
) {
	t.Helper()
	require.NoError(t, srv.touchPresenceLease(ctx, connectionID, userID, sessionID, heartbeatCapable))
	snapshot, changed, err := srv.recomputePresence(ctx, userID)
	require.NoError(t, err)
	if changed {
		srv.broadcastPresence(ctx, userID, snapshot)
	}
}

func applyPresencePreferenceChange(
	t *testing.T,
	ctx context.Context,
	srv *Server,
	userID uuid.UUID,
	status packetspb.PresenceStatus,
) {
	t.Helper()
	require.NoError(t, srv.setPreferredPresence(ctx, userID, status))
	snapshot, changed, err := srv.recomputePresence(ctx, userID)
	require.NoError(t, err)
	if changed {
		srv.broadcastPresence(ctx, userID, snapshot)
	}
}

func removePresenceLeaseAndBroadcast(t *testing.T, ctx context.Context, srv *Server, userID, connectionID uuid.UUID) {
	t.Helper()
	require.NoError(t, srv.removePresenceLease(ctx, connectionID))
	snapshot, changed, err := srv.recomputePresence(ctx, userID)
	require.NoError(t, err)
	if changed {
		srv.broadcastPresence(ctx, userID, snapshot)
	}
}

func expectPresenceEvent(t *testing.T, ch chan outboundMsg, status packetspb.PresenceStatus) *packetspb.PresenceEvent {
	t.Helper()
	select {
	case msg := <-ch:
		require.NotNil(t, msg.env)
		evt := msg.env.GetPresenceEvent()
		require.NotNil(t, evt)
		assert.Equal(t, status, evt.GetEffectivePresence())
		require.NotNil(t, evt.GetLastActiveAt())
		return evt
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for presence event %s", status.String())
		return nil
	}
}

func expectNoPresenceEvent(t *testing.T, ch chan outboundMsg) {
	t.Helper()
	select {
	case msg := <-ch:
		t.Fatalf("unexpected presence event: %#v", msg.env)
	case <-time.After(120 * time.Millisecond):
	}
}

func TestPresence_MultiSessionDisconnectBroadcastsOfflineOnlyAfterLastLease(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	userA, userB := createPresenceUsersAndChannel(t, ctx, pool)
	sessionID := createRefreshSession(t, ctx, pool, userA)
	srv := newPresenceTestServer(pool)

	recipientCh := make(chan outboundMsg, 8)
	unregister := srv.registerUserSession(userB.String(), recipientCh, newSessionState(nil, false, nil))
	defer unregister()

	conn1 := uuid.New()
	conn2 := uuid.New()

	applyPresenceLeaseChange(t, ctx, srv, userA, sessionID, conn1, true)
	expectPresenceEvent(t, recipientCh, packetspb.PresenceStatus_PRESENCE_STATUS_ONLINE)

	applyPresenceLeaseChange(t, ctx, srv, userA, sessionID, conn2, true)
	expectNoPresenceEvent(t, recipientCh)

	removePresenceLeaseAndBroadcast(t, ctx, srv, userA, conn1)
	expectNoPresenceEvent(t, recipientCh)

	removePresenceLeaseAndBroadcast(t, ctx, srv, userA, conn2)
	expectPresenceEvent(t, recipientCh, packetspb.PresenceStatus_PRESENCE_STATUS_OFFLINE)
}

func TestPresence_ManualAwaySurvivesReconnect(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	userA, userB := createPresenceUsersAndChannel(t, ctx, pool)
	sessionID := createRefreshSession(t, ctx, pool, userA)
	srv := newPresenceTestServer(pool)

	recipientCh := make(chan outboundMsg, 8)
	unregister := srv.registerUserSession(userB.String(), recipientCh, newSessionState(nil, false, nil))
	defer unregister()

	conn1 := uuid.New()
	conn2 := uuid.New()

	applyPresenceLeaseChange(t, ctx, srv, userA, sessionID, conn1, true)
	expectPresenceEvent(t, recipientCh, packetspb.PresenceStatus_PRESENCE_STATUS_ONLINE)

	applyPresencePreferenceChange(t, ctx, srv, userA, packetspb.PresenceStatus_PRESENCE_STATUS_AWAY)
	expectPresenceEvent(t, recipientCh, packetspb.PresenceStatus_PRESENCE_STATUS_AWAY)

	removePresenceLeaseAndBroadcast(t, ctx, srv, userA, conn1)
	expectPresenceEvent(t, recipientCh, packetspb.PresenceStatus_PRESENCE_STATUS_OFFLINE)

	applyPresenceLeaseChange(t, ctx, srv, userA, sessionID, conn2, true)
	expectPresenceEvent(t, recipientCh, packetspb.PresenceStatus_PRESENCE_STATUS_AWAY)
}

func TestPresence_ExpireStaleHeartbeatLeaseBroadcastsOffline(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	userA, userB := createPresenceUsersAndChannel(t, ctx, pool)
	sessionID := createRefreshSession(t, ctx, pool, userA)
	srv := newPresenceTestServer(pool)
	srv.presenceLeaseTTL = 50 * time.Millisecond

	recipientCh := make(chan outboundMsg, 8)
	unregister := srv.registerUserSession(userB.String(), recipientCh, newSessionState(nil, false, nil))
	defer unregister()

	conn := uuid.New()
	applyPresenceLeaseChange(t, ctx, srv, userA, sessionID, conn, true)
	expectPresenceEvent(t, recipientCh, packetspb.PresenceStatus_PRESENCE_STATUS_ONLINE)

	_, err := pool.Exec(ctx,
		`UPDATE ws_presence_leases
		    SET last_heartbeat_at = now() - interval '5 minutes'
		  WHERE connection_id = $1`,
		conn,
	)
	require.NoError(t, err)

	require.NoError(t, srv.expireStalePresenceLeases(ctx))
	expectPresenceEvent(t, recipientCh, packetspb.PresenceStatus_PRESENCE_STATUS_OFFLINE)

	var leaseCount int
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM ws_presence_leases WHERE user_id = $1`, userA).Scan(&leaseCount))
	assert.Equal(t, 0, leaseCount)
}

func TestPresence_TransportHeartbeatRestoresOnlineAndReturnsAck(t *testing.T) {
	ctx := context.Background()
	pool, _ := testdb.New(t)
	userA, userB := createPresenceUsersAndChannel(t, ctx, pool)
	sessionID := createRefreshSession(t, ctx, pool, userA)
	srv := newPresenceTestServer(pool)

	recipientCh := make(chan outboundMsg, 4)
	srv.registerUserSession(userB.String(), recipientCh, newSessionState(nil, false, nil))
	connectionID := uuid.New()
	applyPresenceLeaseChange(t, ctx, srv, userA, sessionID, connectionID, true)
	expectPresenceEvent(t, recipientCh, packetspb.PresenceStatus_PRESENCE_STATUS_ONLINE)
	removePresenceLeaseAndBroadcast(t, ctx, srv, userA, connectionID)
	expectPresenceEvent(t, recipientCh, packetspb.PresenceStatus_PRESENCE_STATUS_OFFLINE)

	ackCh := make(chan outboundMsg, 1)
	srv.handleDomainPayload(
		ctx,
		&packetspb.Envelope{
			RequestId:       "transport-heartbeat",
			TraceId:         "transport-heartbeat-trace",
			ProtocolVersion: protocolVersion,
			Payload: &packetspb.Envelope_TransportHeartbeatRequest{
				TransportHeartbeatRequest: &packetspb.TransportHeartbeatRequest{},
			},
		},
		auth.Principal{UserID: userA, SessionID: sessionID},
		connectionID,
		true,
		ackCh,
		func(env *packetspb.Envelope) bool {
			ackCh <- outboundMsg{env: env}
			return true
		},
	)

	expectPresenceEvent(t, recipientCh, packetspb.PresenceStatus_PRESENCE_STATUS_ONLINE)
	ack := <-ackCh
	require.NotNil(t, ack.env)
	assert.Equal(t, "transport-heartbeat", ack.env.GetRequestId())
	assert.NotNil(t, ack.env.GetTransportHeartbeatAck())
}

func TestPresence_CrossInstanceNotificationFanout(t *testing.T) {
	ctx := context.Background()
	pool, connStr := testdb.New(t)
	userA, userB := createPresenceUsersAndChannel(t, ctx, pool)
	sessionID := createRefreshSession(t, ctx, pool, userA)

	srvA := newPresenceTestServer(pool)
	srvA.eventStore = events.NewStore(pool)
	srvB := newPresenceTestServer(pool)
	recipientCh := make(chan outboundMsg, 4)
	srvB.registerUserSession(userB.String(), recipientCh, newSessionState(nil, false, nil))

	listener := events.NewListener(events.ListenerConfig{
		DSN:             connStr,
		CatchUpBatch:    100,
		RetryBackoff:    10 * time.Millisecond,
		RetryBackoffMax: 50 * time.Millisecond,
	}, events.NewStore(pool), events.NewBus(zap.NewNop()), zap.NewNop())
	listener.SetPresenceHandler(srvB.HandlePresenceNotification)
	listenerCtx, cancel := context.WithCancel(ctx)
	listenerDone := make(chan struct{})
	go func() {
		defer close(listenerDone)
		listener.Run(listenerCtx)
	}()
	t.Cleanup(func() {
		cancel()
		<-listenerDone
	})
	time.Sleep(200 * time.Millisecond)

	applyPresenceLeaseChange(t, ctx, srvA, userA, sessionID, uuid.New(), true)
	expectPresenceEvent(t, recipientCh, packetspb.PresenceStatus_PRESENCE_STATUS_ONLINE)
}

func TestPresence_TransportHeartbeatSendsDirectMessagePeerSnapshot(t *testing.T) {
	ctx := context.Background()
	pool, _ := testdb.New(t)
	userA, userB := createPresenceDirectMessage(t, ctx, pool)
	sessionA := createRefreshSession(t, ctx, pool, userA)
	sessionB := createRefreshSession(t, ctx, pool, userB)
	srv := newPresenceTestServer(pool)
	applyPresenceLeaseChange(t, ctx, srv, userB, sessionB, uuid.New(), true)

	outbound := make(chan outboundMsg, 3)
	srv.handleDomainPayload(
		ctx,
		&packetspb.Envelope{
			RequestId:       "transport-heartbeat",
			TraceId:         "transport-heartbeat-trace",
			ProtocolVersion: protocolVersion,
			Payload: &packetspb.Envelope_TransportHeartbeatRequest{
				TransportHeartbeatRequest: &packetspb.TransportHeartbeatRequest{},
			},
		},
		auth.Principal{UserID: userA, SessionID: sessionA},
		uuid.New(),
		true,
		outbound,
		func(env *packetspb.Envelope) bool {
			outbound <- outboundMsg{env: env}
			return true
		},
	)

	ack := <-outbound
	require.NotNil(t, ack.env.GetTransportHeartbeatAck())
	snapshot := <-outbound
	require.NotNil(t, snapshot.env.GetPresenceEvent())
	assert.Equal(t, userB.String(), snapshot.env.GetPresenceEvent().GetUserId())
	assert.Equal(t, packetspb.PresenceStatus_PRESENCE_STATUS_ONLINE, snapshot.env.GetPresenceEvent().GetEffectivePresence())
}
