package ws

import (
	"context"
	"net"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"

	"msgnr/internal/auth"
	"msgnr/internal/chat"
	"msgnr/internal/config"
	"msgnr/internal/events"
	packetspb "msgnr/internal/gen/proto"
)

// newTestServer builds a minimal Server wired to the given Bus.
func newTestServer(bus *events.Bus) *Server {
	cfg := &config.Config{
		WsOutboundQueueMax:       64,
		EventBusSubscriberBuffer: 16,
		MaxSyncBatch:             500,
	}
	return &Server{
		config: cfg,
		bus:    bus,
		log:    zap.NewNop(),
		authorizeEvent: func(_ context.Context, _ auth.Principal, _ *packetspb.ServerEvent) bool {
			return true
		},
		sessionsByUser:       make(map[string]map[chan outboundMsg]*sessionState),
		collabRooms:          make(map[string]*collabRoom),
		collabRoomsBySession: make(map[chan outboundMsg]map[string]struct{}),
	}
}

// testPrincipal returns an auth.Principal with deterministic non-zero UUIDs.
func testPrincipal() auth.Principal {
	return auth.Principal{
		UserID:    uuid.MustParse("00000000-0000-0000-0000-000000000001"),
		SessionID: uuid.MustParse("00000000-0000-0000-0000-000000000002"),
		Role:      "member",
	}
}

func testPrincipalWithUser(userID, sessionID string) auth.Principal {
	return auth.Principal{
		UserID:    uuid.MustParse(userID),
		SessionID: uuid.MustParse(sessionID),
		Role:      "member",
	}
}

func TestShouldPushChatDeliveryRequiresNoActiveWindowSessions(t *testing.T) {
	srv := newTestServer(nil)
	userID := uuid.NewString()
	delivery := chat.DirectDelivery{
		UserID: userID,
		Event: &packetspb.ServerEvent{
			EventType: packetspb.EventType_EVENT_TYPE_MESSAGE_ALERT,
		},
	}

	assert.True(t, srv.shouldPushChatDelivery(delivery))

	inactiveCh := make(chan outboundMsg, 1)
	inactiveState := newSessionState(nil, true, nil)
	inactiveState.setWindowActive(false)
	srv.sessionsByUser[userID] = map[chan outboundMsg]*sessionState{
		inactiveCh: inactiveState,
	}
	assert.True(t, srv.shouldPushChatDelivery(delivery))

	activeCh := make(chan outboundMsg, 1)
	activeState := newSessionState(nil, true, nil)
	activeState.setWindowActive(true)
	srv.sessionsByUser[userID][activeCh] = activeState
	assert.False(t, srv.shouldPushChatDelivery(delivery))
}

// pipeConn returns a pair of connected net.Conn backed by net.Pipe.
func pipeConn(t *testing.T) (client, server net.Conn) {
	t.Helper()
	client, server = net.Pipe()
	t.Cleanup(func() {
		client.Close()
		server.Close()
	})
	return client, server
}

// TestFanout_AuthenticatedSessionReceivesServerEvent verifies that after
// startEventFanout is called, a published ServerEvent reaches the outboundCh.
func TestFanout_AuthenticatedSessionReceivesServerEvent(t *testing.T) {
	bus := events.NewBus(zap.NewNop())
	srv := newTestServer(bus)

	_, serverConn := pipeConn(t)

	outboundCh := make(chan outboundMsg, srv.config.WsOutboundQueueMax+4)

	unsubscribe, done := srv.startEventFanout(serverConn, testPrincipal(), outboundCh, srv.config.WsOutboundQueueMax, nil)
	defer func() {
		unsubscribe()
		<-done
	}()

	evt := &packetspb.ServerEvent{
		EventSeq:  42,
		EventType: packetspb.EventType_EVENT_TYPE_MESSAGE_CREATED,
	}
	bus.Publish(evt)

	select {
	case msg := <-outboundCh:
		require.NotNil(t, msg.env)
		se := msg.env.GetServerEvent()
		require.NotNil(t, se, "expected ServerEvent payload in envelope")
		assert.Equal(t, int64(42), se.GetEventSeq())
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for ServerEvent on outboundCh")
	}
}

// TestFanout_OverflowClosesConn verifies the overflow path: when the outbound
// channel is full, the fanout goroutine closes the connection.
func TestFanout_OverflowClosesConn(t *testing.T) {
	bus := events.NewBus(zap.NewNop())
	srv := newTestServer(bus)

	clientConn, serverConn := pipeConn(t)

	// Queue capacity = headroom only, so it fills immediately.
	const headroom = 4
	outboundCh := make(chan outboundMsg, headroom)

	unsubscribe, done := srv.startEventFanout(serverConn, testPrincipal(), outboundCh, 0, nil)
	defer func() {
		unsubscribe()
		<-done
	}()

	// Fill the channel so the very next send overflows.
	for i := 0; i < headroom; i++ {
		outboundCh <- outboundMsg{env: &packetspb.Envelope{}}
	}

	// Trigger overflow.
	bus.Publish(&packetspb.ServerEvent{EventSeq: 1})

	// serverConn.Close() causes clientConn reads to fail.
	clientConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 1)
	_, err := clientConn.Read(buf)
	assert.Error(t, err, "expected connection closed after overflow")
}

func TestDirectEnvelope_PresenceOverflowForcesReconnect(t *testing.T) {
	srv := newTestServer(nil)
	userID := uuid.NewString()
	outboundCh := make(chan outboundMsg, 1)
	outboundCh <- outboundMsg{env: &packetspb.Envelope{}}

	disconnectReasons := make(chan string, 1)
	state := newSessionState(nil, true, func(reason string) {
		disconnectReasons <- reason
	})
	unregister := srv.registerUserSession(userID, outboundCh, state)
	defer unregister()

	srv.sendDirectEnvelope([]string{userID}, &packetspb.Envelope{
		ProtocolVersion: protocolVersion,
		Payload: &packetspb.Envelope_PresenceEvent{
			PresenceEvent: &packetspb.PresenceEvent{
				UserId:            uuid.NewString(),
				EffectivePresence: packetspb.PresenceStatus_PRESENCE_STATUS_ONLINE,
			},
		},
	})

	select {
	case reason := <-disconnectReasons:
		assert.Equal(t, "direct_overflow", reason)
	case <-time.After(2 * time.Second):
		t.Fatal("presence overflow did not force reconnect")
	}
}

func TestFanout_StopCompletesBeforeQueueClose(t *testing.T) {
	bus := events.NewBus(zap.NewNop())
	srv := newTestServer(bus)
	_, serverConn := pipeConn(t)

	outboundCh := make(chan outboundMsg, 8)
	unsubscribe, done := srv.startEventFanout(serverConn, testPrincipal(), outboundCh, srv.config.WsOutboundQueueMax, nil)

	unsubscribe()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("fanout goroutine did not stop after unsubscribe")
	}

	close(outboundCh)
}

func TestFanout_CallStateChangedDeliveredOnlyToAuthorizedMembers(t *testing.T) {
	bus := events.NewBus(zap.NewNop())
	srv := newTestServer(bus)
	memberID := uuid.MustParse("00000000-0000-0000-0000-000000000001")
	nonMemberID := uuid.MustParse("00000000-0000-0000-0000-000000000003")
	targetConversation := "00000000-0000-0000-0000-0000000000aa"

	srv.authorizeEvent = func(_ context.Context, principal auth.Principal, evt *packetspb.ServerEvent) bool {
		if evt.GetConversationId() != targetConversation {
			return false
		}
		return principal.UserID == memberID
	}

	_, memberServerConn := pipeConn(t)
	_, nonMemberServerConn := pipeConn(t)

	memberOutbound := make(chan outboundMsg, srv.config.WsOutboundQueueMax+4)
	nonMemberOutbound := make(chan outboundMsg, srv.config.WsOutboundQueueMax+4)

	memberUnsubscribe, memberDone := srv.startEventFanout(
		memberServerConn,
		testPrincipalWithUser(memberID.String(), "00000000-0000-0000-0000-00000000000a"),
		memberOutbound,
		srv.config.WsOutboundQueueMax,
		nil,
	)
	defer func() {
		memberUnsubscribe()
		<-memberDone
	}()
	nonMemberUnsubscribe, nonMemberDone := srv.startEventFanout(
		nonMemberServerConn,
		testPrincipalWithUser(nonMemberID.String(), "00000000-0000-0000-0000-00000000000b"),
		nonMemberOutbound,
		srv.config.WsOutboundQueueMax,
		nil,
	)
	defer func() {
		nonMemberUnsubscribe()
		<-nonMemberDone
	}()

	bus.Publish(&packetspb.ServerEvent{
		EventSeq:       7,
		EventType:      packetspb.EventType_EVENT_TYPE_CALL_STATE_CHANGED,
		ConversationId: targetConversation,
		Payload: &packetspb.ServerEvent_CallStateChanged{
			CallStateChanged: &packetspb.CallStateChangedEvent{
				CallId:         "call-1",
				ConversationId: targetConversation,
				Status:         packetspb.CallStatus_CALL_STATUS_ACTIVE,
			},
		},
	})

	select {
	case msg := <-memberOutbound:
		require.NotNil(t, msg.env)
		se := msg.env.GetServerEvent()
		require.NotNil(t, se)
		require.NotNil(t, se.GetCallStateChanged())
		assert.Equal(t, targetConversation, se.GetConversationId())
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for member call_state_changed event")
	}

	select {
	case <-nonMemberOutbound:
		t.Fatal("non-member unexpectedly received call_state_changed event")
	case <-time.After(200 * time.Millisecond):
	}
}

func TestFanout_CallParticipantEventsFallbackDoesNotGrantConversationCache(t *testing.T) {
	bus := events.NewBus(zap.NewNop())
	srv := newTestServer(bus)
	srv.authSvc = auth.NewService(nil, nil, nil, nil, 0, nil)

	participantID := uuid.MustParse("00000000-0000-0000-0000-000000000001")
	targetConversation := "00000000-0000-0000-0000-0000000000bb"

	srv.authorizeEvent = func(_ context.Context, principal auth.Principal, evt *packetspb.ServerEvent) bool {
		if principal.UserID != participantID {
			return false
		}
		return evt.GetConversationId() == targetConversation
	}

	_, serverConn := pipeConn(t)
	outbound := make(chan outboundMsg, srv.config.WsOutboundQueueMax+4)
	state := newSessionState(nil, true, nil)

	unsubscribe, done := srv.startEventFanout(
		serverConn,
		testPrincipalWithUser(participantID.String(), "00000000-0000-0000-0000-00000000000c"),
		outbound,
		srv.config.WsOutboundQueueMax,
		state,
	)
	defer func() {
		unsubscribe()
		<-done
	}()

	bus.Publish(&packetspb.ServerEvent{
		EventSeq:       8,
		EventType:      packetspb.EventType_EVENT_TYPE_CALL_STATE_CHANGED,
		ConversationId: targetConversation,
		Payload: &packetspb.ServerEvent_CallStateChanged{
			CallStateChanged: &packetspb.CallStateChangedEvent{
				CallId:         "call-1",
				ConversationId: targetConversation,
				Status:         packetspb.CallStatus_CALL_STATUS_ACTIVE,
			},
		},
	})

	select {
	case msg := <-outbound:
		require.NotNil(t, msg.env)
		require.NotNil(t, msg.env.GetServerEvent())
		require.NotNil(t, msg.env.GetServerEvent().GetCallStateChanged())
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for fallback-authorized call_state_changed event")
	}

	bus.Publish(&packetspb.ServerEvent{
		EventSeq:       9,
		EventType:      packetspb.EventType_EVENT_TYPE_CALL_RAISED_HANDS_CHANGED,
		ConversationId: targetConversation,
		Payload: &packetspb.ServerEvent_CallRaisedHandsChanged{
			CallRaisedHandsChanged: &packetspb.CallRaisedHandsChangedEvent{
				CallId:         "call-1",
				ConversationId: targetConversation,
			},
		},
	})

	select {
	case msg := <-outbound:
		require.NotNil(t, msg.env)
		require.NotNil(t, msg.env.GetServerEvent())
		require.NotNil(t, msg.env.GetServerEvent().GetCallRaisedHandsChanged())
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for fallback-authorized call_raised_hands_changed event")
	}

	bus.Publish(&packetspb.ServerEvent{
		EventSeq:       10,
		EventType:      packetspb.EventType_EVENT_TYPE_MESSAGE_CREATED,
		ConversationId: targetConversation,
	})

	select {
	case msg := <-outbound:
		t.Fatalf("message event unexpectedly delivered after call_state_changed fallback: %#v", msg.env)
	case <-time.After(200 * time.Millisecond):
	}
}

func TestFanout_UserCallPresenceChangedIsWorkspaceWide(t *testing.T) {
	bus := events.NewBus(zap.NewNop())
	srv := newTestServer(bus)
	srv.authSvc = &auth.Service{}

	memberOneID := uuid.MustParse("00000000-0000-0000-0000-000000000021")
	memberTwoID := uuid.MustParse("00000000-0000-0000-0000-000000000022")

	_, serverConnOne := pipeConn(t)
	outboundOne := make(chan outboundMsg, srv.config.WsOutboundQueueMax+2)
	unsubscribeOne, doneOne := srv.startEventFanout(
		serverConnOne,
		testPrincipalWithUser(memberOneID.String(), "00000000-0000-0000-0000-000000000101"),
		outboundOne,
		srv.config.WsOutboundQueueMax,
		newSessionState(nil, true, nil),
	)
	defer func() {
		unsubscribeOne()
		<-doneOne
	}()

	_, serverConnTwo := pipeConn(t)
	outboundTwo := make(chan outboundMsg, srv.config.WsOutboundQueueMax+2)
	unsubscribeTwo, doneTwo := srv.startEventFanout(
		serverConnTwo,
		testPrincipalWithUser(memberTwoID.String(), "00000000-0000-0000-0000-000000000102"),
		outboundTwo,
		srv.config.WsOutboundQueueMax,
		newSessionState(nil, true, nil),
	)
	defer func() {
		unsubscribeTwo()
		<-doneTwo
	}()

	bus.Publish(&packetspb.ServerEvent{
		EventSeq:  12,
		EventType: packetspb.EventType_EVENT_TYPE_USER_CALL_PRESENCE_CHANGED,
		Payload: &packetspb.ServerEvent_UserCallPresenceChanged{
			UserCallPresenceChanged: &packetspb.UserCallPresenceChangedEvent{
				UserId:          "user-9",
				ActiveCallCount: 1,
			},
		},
	})

	for _, outbound := range []chan outboundMsg{outboundOne, outboundTwo} {
		select {
		case msg := <-outbound:
			require.NotNil(t, msg.env)
			require.NotNil(t, msg.env.GetServerEvent())
			require.NotNil(t, msg.env.GetServerEvent().GetUserCallPresenceChanged())
			assert.Empty(t, msg.env.GetServerEvent().GetConversationId())
		case <-time.After(2 * time.Second):
			t.Fatal("timed out waiting for workspace-wide user_call_presence_changed event")
		}
	}
}

func TestFanout_ConversationCacheAllowsOrdinaryMessageWithoutFallback(t *testing.T) {
	bus := events.NewBus(zap.NewNop())
	srv := newTestServer(bus)
	srv.authSvc = &auth.Service{}

	targetConversation := uuid.NewString()
	conversationUUID := uuid.MustParse(targetConversation)
	principal := testPrincipal()
	_, serverConn := pipeConn(t)
	outboundCh := make(chan outboundMsg, srv.config.WsOutboundQueueMax+4)
	state := newSessionState([]uuid.UUID{conversationUUID}, true, nil)

	srv.authorizeEvent = func(_ context.Context, _ auth.Principal, _ *packetspb.ServerEvent) bool {
		t.Fatal("fallback authorizer should not be called for cached conversations")
		return false
	}

	unsubscribe, done := srv.startEventFanout(serverConn, principal, outboundCh, srv.config.WsOutboundQueueMax, state)
	defer func() {
		unsubscribe()
		<-done
	}()

	bus.Publish(&packetspb.ServerEvent{
		EventSeq:       11,
		EventType:      packetspb.EventType_EVENT_TYPE_MESSAGE_CREATED,
		ConversationId: targetConversation,
		Payload: &packetspb.ServerEvent_MessageCreated{
			MessageCreated: &packetspb.MessageEvent{
				ConversationId: targetConversation,
				MessageId:      "message-11",
			},
		},
	})

	select {
	case msg := <-outboundCh:
		require.NotNil(t, msg.env)
		require.NotNil(t, msg.env.GetServerEvent())
		assert.Equal(t, int64(11), msg.env.GetServerEvent().GetEventSeq())
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for cached message_created event")
	}
}

func TestFanout_ConversationUpsertFallbackPopulatesConversationCache(t *testing.T) {
	bus := events.NewBus(zap.NewNop())
	srv := newTestServer(bus)
	srv.authSvc = &auth.Service{}

	targetConversation := uuid.NewString()
	principal := testPrincipal()
	_, serverConn := pipeConn(t)
	outboundCh := make(chan outboundMsg, srv.config.WsOutboundQueueMax+4)
	state := newSessionState(nil, true, nil)
	fallbackCalls := 0

	srv.authorizeEvent = func(_ context.Context, _ auth.Principal, evt *packetspb.ServerEvent) bool {
		fallbackCalls++
		return evt.GetConversationId() == targetConversation
	}

	unsubscribe, done := srv.startEventFanout(serverConn, principal, outboundCh, srv.config.WsOutboundQueueMax, state)
	defer func() {
		unsubscribe()
		<-done
	}()

	bus.Publish(&packetspb.ServerEvent{
		EventSeq:       21,
		EventType:      packetspb.EventType_EVENT_TYPE_CONVERSATION_UPSERTED,
		ConversationId: targetConversation,
		Payload: &packetspb.ServerEvent_ConversationUpserted{
			ConversationUpserted: &packetspb.ConversationUpsertedEvent{
				Conversation: &packetspb.ConversationSummary{
					ConversationId:   targetConversation,
					ConversationType: packetspb.ConversationType_CONVERSATION_TYPE_CHANNEL_PUBLIC,
					Title:            "general",
				},
			},
		},
	})

	select {
	case msg := <-outboundCh:
		require.NotNil(t, msg.env)
		require.NotNil(t, msg.env.GetServerEvent())
		assert.Equal(t, packetspb.EventType_EVENT_TYPE_CONVERSATION_UPSERTED, msg.env.GetServerEvent().GetEventType())
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for conversation_upserted event")
	}

	srv.authorizeEvent = func(_ context.Context, _ auth.Principal, _ *packetspb.ServerEvent) bool {
		t.Fatal("fallback authorizer should not be called after conversation cache is updated")
		return false
	}

	bus.Publish(&packetspb.ServerEvent{
		EventSeq:       22,
		EventType:      packetspb.EventType_EVENT_TYPE_MESSAGE_CREATED,
		ConversationId: targetConversation,
		Payload: &packetspb.ServerEvent_MessageCreated{
			MessageCreated: &packetspb.MessageEvent{
				ConversationId: targetConversation,
				MessageId:      "message-22",
			},
		},
	})

	select {
	case msg := <-outboundCh:
		require.NotNil(t, msg.env)
		require.NotNil(t, msg.env.GetServerEvent())
		assert.Equal(t, int64(22), msg.env.GetServerEvent().GetEventSeq())
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for message_created after conversation cache update")
	}

	assert.Equal(t, 1, fallbackCalls)
}

func TestDirectEnvelope_ConversationRemovedRevokesConversationCache(t *testing.T) {
	bus := events.NewBus(zap.NewNop())
	srv := newTestServer(bus)
	srv.authSvc = &auth.Service{}

	targetConversation := uuid.NewString()
	principal := testPrincipal()
	_, serverConn := pipeConn(t)
	outboundCh := make(chan outboundMsg, srv.config.WsOutboundQueueMax+4)
	state := newSessionState([]uuid.UUID{uuid.MustParse(targetConversation)}, true, nil)
	unregister := srv.registerUserSession(principal.UserID.String(), outboundCh, state)
	defer unregister()

	unsubscribe, done := srv.startEventFanout(serverConn, principal, outboundCh, srv.config.WsOutboundQueueMax, state)
	defer func() {
		unsubscribe()
		<-done
	}()

	srv.sendDirectEnvelope([]string{principal.UserID.String()}, &packetspb.Envelope{
		ProtocolVersion: protocolVersion,
		Payload: &packetspb.Envelope_ServerEvent{
			ServerEvent: &packetspb.ServerEvent{
				EventType:      packetspb.EventType_EVENT_TYPE_CONVERSATION_REMOVED,
				ConversationId: targetConversation,
				Payload: &packetspb.ServerEvent_ConversationRemoved{
					ConversationRemoved: &packetspb.ConversationRemovedEvent{
						ConversationId: targetConversation,
					},
				},
			},
		},
	})

	select {
	case <-outboundCh:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for direct conversation_removed event")
	}

	srv.authorizeEvent = func(_ context.Context, _ auth.Principal, _ *packetspb.ServerEvent) bool {
		t.Fatal("fallback authorizer should not be called after conversation removal")
		return false
	}

	bus.Publish(&packetspb.ServerEvent{
		EventSeq:       31,
		EventType:      packetspb.EventType_EVENT_TYPE_MESSAGE_CREATED,
		ConversationId: targetConversation,
		Payload: &packetspb.ServerEvent_MessageCreated{
			MessageCreated: &packetspb.MessageEvent{
				ConversationId: targetConversation,
				MessageId:      "message-31",
			},
		},
	})

	select {
	case msg := <-outboundCh:
		t.Fatalf("unexpected event after conversation cache revoke: %#v", msg.env)
	case <-time.After(200 * time.Millisecond):
	}
}

func TestDirectEnvelope_StripsEncryptedPayloadWhenFilterUnavailable(t *testing.T) {
	bus := events.NewBus(zap.NewNop())
	srv := newTestServer(bus)

	principal := testPrincipal()
	outboundCh := make(chan outboundMsg, srv.config.WsOutboundQueueMax+4)
	state := newSessionState(nil, true, nil)
	unregister := srv.registerUserSession(principal.UserID.String(), outboundCh, state)
	defer unregister()

	evt := &packetspb.ServerEvent{
		EventType:      packetspb.EventType_EVENT_TYPE_MESSAGE_CREATED,
		ConversationId: uuid.NewString(),
		Payload: &packetspb.ServerEvent_MessageCreated{
			MessageCreated: &packetspb.MessageEvent{
				ContentMode: packetspb.MessageContentMode_MESSAGE_CONTENT_MODE_DM_PAIRWISE_SIGNAL_V1,
				EncryptedDmPayload: &packetspb.EncryptedDMMessagePayload{
					Recipients: []*packetspb.EncryptedDMRecipientPayload{
						{
							RecipientDeviceId: uuid.NewString(),
							SessionMessage:    []byte("ciphertext"),
						},
					},
				},
			},
		},
	}

	srv.sendDirectEnvelope([]string{principal.UserID.String()}, &packetspb.Envelope{
		ProtocolVersion: protocolVersion,
		Payload: &packetspb.Envelope_ServerEvent{
			ServerEvent: evt,
		},
	})

	select {
	case msg := <-outboundCh:
		delivered := msg.env.GetServerEvent()
		require.NotNil(t, delivered)
		assert.Empty(t, delivered.GetMessageCreated().GetEncryptedDmPayload().GetRecipients())
		assert.Len(t, evt.GetMessageCreated().GetEncryptedDmPayload().GetRecipients(), 1)
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for direct encrypted message event")
	}
}

func TestEventFanout_DMHistoryClearedScopedByConversationMembership(t *testing.T) {
	bus := events.NewBus(zap.NewNop())
	srv := newTestServer(bus)
	srv.authSvc = &auth.Service{}
	srv.authorizeEvent = func(_ context.Context, _ auth.Principal, _ *packetspb.ServerEvent) bool {
		t.Fatal("fallback authorizer should not be called for cached dm_history_cleared fanout")
		return false
	}

	targetConversation := uuid.New()
	memberPrincipal := testPrincipalWithUser(
		"00000000-0000-0000-0000-000000000101",
		"00000000-0000-0000-0000-000000000102",
	)
	nonMemberPrincipal := testPrincipalWithUser(
		"00000000-0000-0000-0000-000000000201",
		"00000000-0000-0000-0000-000000000202",
	)
	_, memberConn := pipeConn(t)
	_, nonMemberConn := pipeConn(t)
	memberOutbound := make(chan outboundMsg, srv.config.WsOutboundQueueMax+4)
	nonMemberOutbound := make(chan outboundMsg, srv.config.WsOutboundQueueMax+4)
	memberState := newSessionState([]uuid.UUID{targetConversation}, true, nil)
	nonMemberState := newSessionState(nil, true, nil)

	memberUnsubscribe, memberDone := srv.startEventFanout(memberConn, memberPrincipal, memberOutbound, srv.config.WsOutboundQueueMax, memberState)
	defer func() {
		memberUnsubscribe()
		<-memberDone
	}()
	nonMemberUnsubscribe, nonMemberDone := srv.startEventFanout(nonMemberConn, nonMemberPrincipal, nonMemberOutbound, srv.config.WsOutboundQueueMax, nonMemberState)
	defer func() {
		nonMemberUnsubscribe()
		<-nonMemberDone
	}()

	bus.Publish(&packetspb.ServerEvent{
		EventSeq:       41,
		EventId:        "evt-dm-history-cleared",
		EventType:      packetspb.EventType_EVENT_TYPE_DM_HISTORY_CLEARED,
		ConversationId: targetConversation.String(),
		Payload: &packetspb.ServerEvent_DmHistoryCleared{
			DmHistoryCleared: &packetspb.DmHistoryClearedEvent{
				ConversationId:       targetConversation.String(),
				ClearedByUserId:      memberPrincipal.UserID.String(),
				DeletedMessagesCount: 3,
			},
		},
	})

	select {
	case msg := <-memberOutbound:
		require.NotNil(t, msg.env)
		evt := msg.env.GetServerEvent()
		require.NotNil(t, evt)
		assert.Equal(t, packetspb.EventType_EVENT_TYPE_DM_HISTORY_CLEARED, evt.GetEventType())
		require.NotNil(t, evt.GetDmHistoryCleared())
		assert.Equal(t, int32(3), evt.GetDmHistoryCleared().GetDeletedMessagesCount())
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for dm_history_cleared event")
	}

	select {
	case msg := <-nonMemberOutbound:
		t.Fatalf("unexpected dm_history_cleared event for non-member: %#v", msg.env)
	case <-time.After(200 * time.Millisecond):
	}
}

func TestTaskCollabRecipientsScopedByTask(t *testing.T) {
	srv := newTestServer(nil)
	chA := make(chan outboundMsg, 1)
	chB := make(chan outboundMsg, 1)
	chC := make(chan outboundMsg, 1)

	srv.joinTaskCollabRoom("task-1", chA)
	srv.joinTaskCollabRoom("task-1", chB)
	srv.joinTaskCollabRoom("task-2", chC)

	recipients := srv.taskCollabRecipients("task-1", chA)
	require.Len(t, recipients, 1)
	assert.Equal(t, chB, recipients[0])
	assert.True(t, srv.isTaskCollabSubscribed("task-1", chB))
	assert.False(t, srv.isTaskCollabSubscribed("task-1", chC))
}

func TestTaskCollabCleanupRemovesSessionFromAllRooms(t *testing.T) {
	srv := newTestServer(nil)
	ch := make(chan outboundMsg, 1)

	srv.joinTaskCollabRoom("task-1", ch)
	srv.joinTaskCollabRoom("task-2", ch)
	srv.joinCollabRoom(collabEntityDocument, "doc-1", ch)
	assert.True(t, srv.isTaskCollabSubscribed("task-1", ch))
	assert.True(t, srv.isTaskCollabSubscribed("task-2", ch))
	assert.True(t, srv.isCollabSubscribed(collabEntityDocument, "doc-1", ch))

	srv.removeCollabSession(ch)

	assert.False(t, srv.isTaskCollabSubscribed("task-1", ch))
	assert.False(t, srv.isTaskCollabSubscribed("task-2", ch))
	assert.False(t, srv.isCollabSubscribed(collabEntityDocument, "doc-1", ch))
	assert.Nil(t, srv.collabRooms[collabRoomKey(collabEntityTask, "task-1")])
	assert.Nil(t, srv.collabRooms[collabRoomKey(collabEntityTask, "task-2")])
	assert.Nil(t, srv.collabRooms[collabRoomKey(collabEntityDocument, "doc-1")])
}

func TestTaskCollabSubscribeResponseIncludesSubscriberCount(t *testing.T) {
	srv := newTestServer(nil)
	chA := make(chan outboundMsg, 1)
	chB := make(chan outboundMsg, 1)

	first := srv.taskCollabSubscribeResponse("task-1", chA, "aabb")
	second := srv.taskCollabSubscribeResponse("task-1", chB, "aabb")

	assert.Equal(t, int32(1), first.GetSubscriberCount())
	assert.Equal(t, int32(2), second.GetSubscriberCount())
	assert.Equal(t, "aabb", first.GetPersistedMarkdown())
	assert.Equal(t, "aabb", second.GetPersistedMarkdown())
}

func TestTaskCollabSubscribeResponseIncludesRoomSnapshot(t *testing.T) {
	srv := newTestServer(nil)
	ch := make(chan outboundMsg, 1)
	srv.joinTaskCollabRoom("task-1", ch)
	ok := srv.setTaskCollabRoomSnapshot("task-1", ch, []byte{9, 8, 7})

	assert.True(t, ok)
	resp := srv.taskCollabSubscribeResponse("task-1", ch, "aabb")

	assert.Equal(t, []byte{9, 8, 7}, resp.GetRoomSnapshot())
	assert.Equal(t, int32(1), resp.GetSubscriberCount())
}

func TestSetTaskCollabRoomSnapshotDoesNotCreateGhostRoom(t *testing.T) {
	srv := newTestServer(nil)
	ch := make(chan outboundMsg, 1)

	ok := srv.setTaskCollabRoomSnapshot("task-1", ch, []byte{9, 8, 7})

	assert.False(t, ok)
	assert.Nil(t, srv.collabRooms[collabRoomKey(collabEntityTask, "task-1")])
}

func TestDocumentCollabSubscribeResponseIncludesRoomSnapshot(t *testing.T) {
	srv := newTestServer(nil)
	ch := make(chan outboundMsg, 1)

	srv.joinCollabRoom(collabEntityDocument, "doc-1", ch)
	ok := srv.setDocumentCollabRoomSnapshot("doc-1", ch, []byte{4, 5, 6})

	assert.True(t, ok)
	resp := srv.documentCollabSubscribeResponse("doc-1", ch, "markdown")

	assert.Equal(t, []byte{4, 5, 6}, resp.GetRoomSnapshot())
	assert.Equal(t, int32(1), resp.GetSubscriberCount())
	assert.Equal(t, "markdown", resp.GetPersistedMarkdown())
}

func TestSendTaskStatusChangedBroadcastsToActiveSessions(t *testing.T) {
	srv := newTestServer(nil)
	sessionA := make(chan outboundMsg, 1)
	sessionB := make(chan outboundMsg, 1)
	unregisterA := srv.registerUserSession("user-a", sessionA, newSessionState(nil, false, nil))
	unregisterB := srv.registerUserSession("user-b", sessionB, newSessionState(nil, false, nil))
	defer unregisterA()
	defer unregisterB()

	updatedAt := time.Unix(1700002000, 0).UTC()
	srv.SendTaskStatusChanged("task-1", "BUG-1", "st-1", "st-2", "user-updater", updatedAt)

	assertEvent := func(ch chan outboundMsg) {
		select {
		case msg := <-ch:
			require.NotNil(t, msg.env)
			evt := msg.env.GetServerEvent()
			require.NotNil(t, evt)
			assert.Equal(t, int64(0), evt.GetEventSeq())
			assert.Equal(t, packetspb.EventType_EVENT_TYPE_TASK_STATUS_CHANGED, evt.GetEventType())
			payload := evt.GetTaskStatusChanged()
			require.NotNil(t, payload)
			assert.Equal(t, "task-1", payload.GetTaskId())
			assert.Equal(t, "BUG-1", payload.GetPublicId())
			assert.Equal(t, "st-1", payload.GetFromStatusId())
			assert.Equal(t, "st-2", payload.GetToStatusId())
			assert.Equal(t, "user-updater", payload.GetUpdatedBy())
		case <-time.After(2 * time.Second):
			t.Fatal("timed out waiting for task_status_changed event")
		}
	}

	assertEvent(sessionA)
	assertEvent(sessionB)
}

func TestEventFanout_SecretHistoryInvalidatedScopedByConversationMembership(t *testing.T) {
	bus := events.NewBus(zap.NewNop())
	srv := newTestServer(bus)
	srv.authSvc = &auth.Service{}
	srv.authorizeEvent = func(_ context.Context, _ auth.Principal, _ *packetspb.ServerEvent) bool {
		t.Fatal("fallback authorizer should not be called for cached secret_history_invalidated fanout")
		return false
	}

	targetConversation := uuid.New()
	memberPrincipal := testPrincipalWithUser(
		"00000000-0000-0000-0000-000000000101",
		"00000000-0000-0000-0000-000000000102",
	)
	nonMemberPrincipal := testPrincipalWithUser(
		"00000000-0000-0000-0000-000000000201",
		"00000000-0000-0000-0000-000000000202",
	)
	_, memberConn := pipeConn(t)
	_, nonMemberConn := pipeConn(t)
	memberOutbound := make(chan outboundMsg, srv.config.WsOutboundQueueMax+4)
	nonMemberOutbound := make(chan outboundMsg, srv.config.WsOutboundQueueMax+4)
	memberState := newSessionState([]uuid.UUID{targetConversation}, true, nil)
	nonMemberState := newSessionState(nil, true, nil)

	memberUnsubscribe, memberDone := srv.startEventFanout(memberConn, memberPrincipal, memberOutbound, srv.config.WsOutboundQueueMax, memberState)
	defer func() {
		memberUnsubscribe()
		<-memberDone
	}()
	nonMemberUnsubscribe, nonMemberDone := srv.startEventFanout(nonMemberConn, nonMemberPrincipal, nonMemberOutbound, srv.config.WsOutboundQueueMax, nonMemberState)
	defer func() {
		nonMemberUnsubscribe()
		<-nonMemberDone
	}()

	bus.Publish(&packetspb.ServerEvent{
		EventSeq:       41,
		EventId:        "evt-dm-history-cleared",
		EventType:      packetspb.EventType_EVENT_TYPE_SECRET_HISTORY_INVALIDATED,
		ConversationId: targetConversation.String(),
		Payload: &packetspb.ServerEvent_SecretHistoryInvalidated{
			SecretHistoryInvalidated: &packetspb.SecretHistoryInvalidatedEvent{
				ConversationId: targetConversation.String(),
			},
		},
	})

	select {
	case msg := <-memberOutbound:
		require.NotNil(t, msg.env)
		evt := msg.env.GetServerEvent()
		require.NotNil(t, evt)
		assert.Equal(t, packetspb.EventType_EVENT_TYPE_SECRET_HISTORY_INVALIDATED, evt.GetEventType())
		require.NotNil(t, evt.GetSecretHistoryInvalidated())
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for secret_history_invalidated event")
	}

	select {
	case msg := <-nonMemberOutbound:
		t.Fatalf("unexpected secret_history_invalidated event for non-member: %#v", msg.env)
	case <-time.After(200 * time.Millisecond):
	}
}
