//go:build integration

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
	"msgnr/internal/chat"
	"msgnr/internal/config"
	"msgnr/internal/database"
	"msgnr/internal/documents"
	packetspb "msgnr/internal/gen/proto"
	"msgnr/internal/testdb"
)

func seedDocumentCollabUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, displayName string) uuid.UUID {
	t.Helper()

	var userID uuid.UUID
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', $2, 'member')
		 RETURNING id`,
		"ws_document_collab_"+uuid.NewString()+"@example.com",
		displayName,
	).Scan(&userID))
	return userID
}

func seedDocumentCollabFixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool) (*documents.Service, uuid.UUID, uuid.UUID, uuid.UUID, string) {
	t.Helper()

	documentsSvc := documents.NewService(pool, nil)
	ownerID := seedDocumentCollabUser(t, ctx, pool, "Owner")
	memberID := seedDocumentCollabUser(t, ctx, pool, "Member")

	teamspace, err := documentsSvc.CreateTeamspace(ctx, documents.CreateTeamspaceParams{
		Name:      "WS Document Collab",
		MemberIDs: []uuid.UUID{memberID},
		ActorID:   ownerID,
	}, "member")
	require.NoError(t, err)

	persistedMarkdown := "persisted collaborative body"
	doc, err := documentsSvc.CreateDocument(ctx, documents.CreateDocumentParams{
		TeamspaceID:     teamspace.ID,
		Title:           "Realtime Spec",
		ContentMarkdown: &persistedMarkdown,
		ActorID:         ownerID,
	})
	require.NoError(t, err)

	return documentsSvc, ownerID, memberID, doc.ID, persistedMarkdown
}

func newDocumentCollabIntegrationServer(pool *pgxpool.Pool, documentsSvc *documents.Service) *Server {
	return &Server{
		db:                   &database.DB{Pool: pool},
		config:               &config.Config{WsOutboundQueueMax: 8},
		documentsSvc:         documentsSvc,
		log:                  zap.NewNop(),
		sessionsByUser:       make(map[string]map[chan outboundMsg]*sessionState),
		collabRooms:          make(map[string]*collabRoom),
		collabRoomsBySession: make(map[chan outboundMsg]map[string]struct{}),
	}
}

func documentCollabPrincipal(userID uuid.UUID) auth.Principal {
	return auth.Principal{
		UserID:    userID,
		SessionID: uuid.New(),
		Role:      "member",
	}
}

func enqueueToSession(outboundCh chan outboundMsg) func(*packetspb.Envelope) bool {
	return func(env *packetspb.Envelope) bool {
		outboundCh <- outboundMsg{env: env}
		return true
	}
}

func newChatMemberReadIntegrationServer(pool *pgxpool.Pool) *Server {
	return &Server{
		db:             &database.DB{Pool: pool},
		config:         &config.Config{WsOutboundQueueMax: 8},
		chatSvc:        chat.NewService(pool, nil),
		log:            zap.NewNop(),
		sessionsByUser: make(map[string]map[chan outboundMsg]*sessionState),
	}
}

func seedChatMemberReadFixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool) (uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID) {
	t.Helper()

	var ownerID, memberID, otherID uuid.UUID
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'Owner', 'member') RETURNING id`,
		"ws_member_owner_"+uuid.NewString()+"@example.com",
	).Scan(&ownerID))
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'Member', 'member') RETURNING id`,
		"ws_member_member_"+uuid.NewString()+"@example.com",
	).Scan(&memberID))
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'Other', 'member') RETURNING id`,
		"ws_member_other_"+uuid.NewString()+"@example.com",
	).Scan(&otherID))

	var channelID uuid.UUID
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO channels (kind, visibility, name, created_by)
		 VALUES ('channel', 'public', 'ws members', $1) RETURNING id`,
		ownerID,
	).Scan(&channelID))
	_, err := pool.Exec(ctx,
		`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2), ($1, $3)`,
		channelID, ownerID, memberID,
	)
	require.NoError(t, err)

	return ownerID, memberID, otherID, channelID
}

func receiveEnvelope(t *testing.T, outboundCh chan outboundMsg) *packetspb.Envelope {
	t.Helper()

	select {
	case msg := <-outboundCh:
		require.NotNil(t, msg.env)
		return msg.env
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for websocket response")
		return nil
	}
}

func encodeCollabSyncFrameForTest(frameType taskCollabSyncFrameType, payload []byte) []byte {
	framed := make([]byte, 4+len(payload))
	framed[0] = taskCollabSyncMagic0
	framed[1] = taskCollabSyncMagic1
	framed[2] = taskCollabSyncProtocolV
	framed[3] = byte(frameType)
	copy(framed[4:], payload)
	return framed
}

func TestIntegration_ExpireTyping_RechecksCurrentMembership(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	var senderID, remainingID, removedID, channelID uuid.UUID
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role) VALUES ($1, 'x', 'sender', 'member') RETURNING id`,
		"sender_"+uuid.NewString()+"@example.com",
	).Scan(&senderID))
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role) VALUES ($1, 'x', 'remaining', 'member') RETURNING id`,
		"remaining_"+uuid.NewString()+"@example.com",
	).Scan(&remainingID))
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role) VALUES ($1, 'x', 'removed', 'member') RETURNING id`,
		"removed_"+uuid.NewString()+"@example.com",
	).Scan(&removedID))
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO channels (kind, visibility, name, created_by) VALUES ('channel', 'public', 'typing', $1) RETURNING id`,
		senderID,
	).Scan(&channelID))
	_, err := pool.Exec(ctx,
		`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2), ($1, $3), ($1, $4)`,
		channelID, senderID, remainingID, removedID,
	)
	require.NoError(t, err)

	srv := &Server{
		db:             &database.DB{Pool: pool},
		config:         &config.Config{WsOutboundQueueMax: 8},
		log:            zap.NewNop(),
		sessionsByUser: make(map[string]map[chan outboundMsg]*sessionState),
		typingExpiry:   make(map[string]time.Time),
	}

	remainingCh := make(chan outboundMsg, 1)
	removedCh := make(chan outboundMsg, 1)
	unregisterRemaining := srv.registerUserSession(remainingID.String(), remainingCh, newSessionState(nil, false, nil))
	defer unregisterRemaining()
	unregisterRemoved := srv.registerUserSession(removedID.String(), removedCh, newSessionState(nil, false, nil))
	defer unregisterRemoved()

	key := channelID.String() + "||" + senderID.String()
	expiresAt := time.Now().Add(40 * time.Millisecond)
	srv.typingMu.Lock()
	srv.typingExpiry[key] = expiresAt
	srv.typingMu.Unlock()

	go srv.expireTyping(key, channelID.String(), "", senderID, expiresAt)

	time.Sleep(10 * time.Millisecond)
	_, err = pool.Exec(ctx, `DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2`, channelID, removedID)
	require.NoError(t, err)

	select {
	case msg := <-remainingCh:
		require.NotNil(t, msg.env)
		require.NotNil(t, msg.env.GetTypingEvent())
		assert.False(t, msg.env.GetTypingEvent().GetIsTyping())
		assert.Equal(t, channelID.String(), msg.env.GetTypingEvent().GetConversationId())
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for typing expiry event")
	}

	select {
	case msg := <-removedCh:
		t.Fatalf("removed member received stale typing expiry event: %#v", msg.env)
	case <-time.After(120 * time.Millisecond):
	}
}

func TestIntegration_ListConversationMembersRequestReturnsMembers(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	srv := newChatMemberReadIntegrationServer(pool)
	ownerID, memberID, _, channelID := seedChatMemberReadFixture(t, ctx, pool)
	outboundCh := make(chan outboundMsg, 1)

	srv.handleDomainPayload(ctx, &packetspb.Envelope{
		RequestId: "list-members",
		TraceId:   "trace-list-members",
		Payload: &packetspb.Envelope_ListConversationMembersRequest{
			ListConversationMembersRequest: &packetspb.ListConversationMembersRequest{
				ConversationId: channelID.String(),
			},
		},
	}, auth.Principal{UserID: ownerID, SessionID: uuid.New(), Role: "member"}, uuid.Nil, false, outboundCh, enqueueToSession(outboundCh))

	resp := receiveEnvelope(t, outboundCh).GetListConversationMembersResponse()
	require.NotNil(t, resp)
	require.Len(t, resp.GetMembers(), 2)
	assert.ElementsMatch(t, []string{ownerID.String(), memberID.String()}, []string{
		resp.GetMembers()[0].GetUserId(),
		resp.GetMembers()[1].GetUserId(),
	})
}

func TestIntegration_ListActiveCallMembersRequestReturnsActiveParticipants(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	srv := newChatMemberReadIntegrationServer(pool)
	ownerID, memberID, _, channelID := seedChatMemberReadFixture(t, ctx, pool)
	var callID uuid.UUID
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO calls (channel_id, status, livekit_room, created_by)
		 VALUES ($1, 'active', $2, $3) RETURNING id`,
		channelID, "room-"+uuid.NewString(), ownerID,
	).Scan(&callID))
	_, err := pool.Exec(ctx,
		`INSERT INTO call_participants (call_id, user_id) VALUES ($1, $2), ($1, $3)`,
		callID, ownerID, memberID,
	)
	require.NoError(t, err)
	outboundCh := make(chan outboundMsg, 1)

	srv.handleDomainPayload(ctx, &packetspb.Envelope{
		RequestId: "list-active-call-members",
		TraceId:   "trace-list-active-call-members",
		Payload: &packetspb.Envelope_ListActiveCallMembersRequest{
			ListActiveCallMembersRequest: &packetspb.ListActiveCallMembersRequest{
				ConversationId: channelID.String(),
			},
		},
	}, auth.Principal{UserID: ownerID, SessionID: uuid.New(), Role: "member"}, uuid.Nil, false, outboundCh, enqueueToSession(outboundCh))

	resp := receiveEnvelope(t, outboundCh).GetListActiveCallMembersResponse()
	require.NotNil(t, resp)
	require.Len(t, resp.GetMembers(), 2)
	assert.ElementsMatch(t, []string{ownerID.String(), memberID.String()}, []string{
		resp.GetMembers()[0].GetUserId(),
		resp.GetMembers()[1].GetUserId(),
	})
}

func TestIntegration_MemberReadRequestsRejectInvalidConversationID(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	srv := newChatMemberReadIntegrationServer(pool)
	principal := auth.Principal{UserID: uuid.New(), SessionID: uuid.New(), Role: "member"}

	tests := []struct {
		name  string
		build func(string) *packetspb.Envelope
	}{
		{
			name: "list conversation members",
			build: func(requestID string) *packetspb.Envelope {
				return &packetspb.Envelope{
					RequestId: requestID,
					Payload: &packetspb.Envelope_ListConversationMembersRequest{
						ListConversationMembersRequest: &packetspb.ListConversationMembersRequest{ConversationId: "bad"},
					},
				}
			},
		},
		{
			name: "list active call members",
			build: func(requestID string) *packetspb.Envelope {
				return &packetspb.Envelope{
					RequestId: requestID,
					Payload: &packetspb.Envelope_ListActiveCallMembersRequest{
						ListActiveCallMembersRequest: &packetspb.ListActiveCallMembersRequest{ConversationId: "bad"},
					},
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			outboundCh := make(chan outboundMsg, 1)
			srv.handleDomainPayload(ctx, tt.build("invalid-"+tt.name), principal, uuid.Nil, false, outboundCh, enqueueToSession(outboundCh))

			errEnv := receiveEnvelope(t, outboundCh).GetError()
			require.NotNil(t, errEnv)
			assert.Equal(t, packetspb.ErrorCode_ERROR_CODE_BAD_REQUEST, errEnv.GetCode())
		})
	}
}

func TestIntegration_MemberReadRequestsRejectNonMembers(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	srv := newChatMemberReadIntegrationServer(pool)
	_, _, otherID, channelID := seedChatMemberReadFixture(t, ctx, pool)
	principal := auth.Principal{UserID: otherID, SessionID: uuid.New(), Role: "member"}

	tests := []struct {
		name  string
		build func(string) *packetspb.Envelope
	}{
		{
			name: "list conversation members",
			build: func(requestID string) *packetspb.Envelope {
				return &packetspb.Envelope{
					RequestId: requestID,
					Payload: &packetspb.Envelope_ListConversationMembersRequest{
						ListConversationMembersRequest: &packetspb.ListConversationMembersRequest{ConversationId: channelID.String()},
					},
				}
			},
		},
		{
			name: "list active call members",
			build: func(requestID string) *packetspb.Envelope {
				return &packetspb.Envelope{
					RequestId: requestID,
					Payload: &packetspb.Envelope_ListActiveCallMembersRequest{
						ListActiveCallMembersRequest: &packetspb.ListActiveCallMembersRequest{ConversationId: channelID.String()},
					},
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			outboundCh := make(chan outboundMsg, 1)
			srv.handleDomainPayload(ctx, tt.build("forbidden-"+tt.name), principal, uuid.Nil, false, outboundCh, enqueueToSession(outboundCh))

			errEnv := receiveEnvelope(t, outboundCh).GetError()
			require.NotNil(t, errEnv)
			assert.Equal(t, packetspb.ErrorCode_ERROR_CODE_FORBIDDEN, errEnv.GetCode())
		})
	}
}

func TestIntegration_DocumentContentCollabSubscribeReturnsPersistedMarkdownAndRoomSnapshot(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	documentsSvc, _, memberID, documentID, persistedMarkdown := seedDocumentCollabFixture(t, ctx, pool)
	srv := newDocumentCollabIntegrationServer(pool, documentsSvc)

	existingSession := make(chan outboundMsg, 1)
	roomSnapshot := []byte{9, 8, 7, 6}
	srv.joinCollabRoom(collabEntityDocument, documentID.String(), existingSession)
	require.True(t, srv.setDocumentCollabRoomSnapshot(documentID.String(), existingSession, roomSnapshot))

	outboundCh := make(chan outboundMsg, 1)
	srv.handleDomainPayload(ctx, &packetspb.Envelope{
		RequestId: "doc-subscribe",
		TraceId:   "trace-doc-subscribe",
		Payload: &packetspb.Envelope_DocumentContentCollabSubscribeRequest{
			DocumentContentCollabSubscribeRequest: &packetspb.DocumentContentCollabSubscribeRequest{
				DocumentId: documentID.String(),
			},
		},
	}, documentCollabPrincipal(memberID), uuid.Nil, false, outboundCh, enqueueToSession(outboundCh))

	select {
	case msg := <-outboundCh:
		require.NotNil(t, msg.env)
		resp := msg.env.GetDocumentContentCollabSubscribeResponse()
		require.NotNil(t, resp)
		assert.Equal(t, documentID.String(), resp.GetDocumentId())
		assert.Equal(t, persistedMarkdown, resp.GetPersistedMarkdown())
		assert.Equal(t, int32(2), resp.GetSubscriberCount())
		assert.Equal(t, roomSnapshot, resp.GetRoomSnapshot())
		assert.True(t, srv.isCollabSubscribed(collabEntityDocument, documentID.String(), outboundCh))
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for document collab subscribe response")
	}
}

func TestIntegration_DocumentContentCollabUnsubscribeRemovesSessionFromRoom(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	documentsSvc, _, memberID, documentID, _ := seedDocumentCollabFixture(t, ctx, pool)
	srv := newDocumentCollabIntegrationServer(pool, documentsSvc)
	outboundCh := make(chan outboundMsg, 1)
	principal := documentCollabPrincipal(memberID)

	srv.handleDomainPayload(ctx, &packetspb.Envelope{
		RequestId: "doc-subscribe",
		TraceId:   "trace-doc-subscribe",
		Payload: &packetspb.Envelope_DocumentContentCollabSubscribeRequest{
			DocumentContentCollabSubscribeRequest: &packetspb.DocumentContentCollabSubscribeRequest{
				DocumentId: documentID.String(),
			},
		},
	}, principal, uuid.Nil, false, outboundCh, enqueueToSession(outboundCh))

	select {
	case <-outboundCh:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for initial document subscribe response")
	}

	srv.handleDomainPayload(ctx, &packetspb.Envelope{
		RequestId: "doc-unsubscribe",
		TraceId:   "trace-doc-unsubscribe",
		Payload: &packetspb.Envelope_DocumentContentCollabUnsubscribeRequest{
			DocumentContentCollabUnsubscribeRequest: &packetspb.DocumentContentCollabUnsubscribeRequest{
				DocumentId: documentID.String(),
			},
		},
	}, principal, uuid.Nil, false, outboundCh, enqueueToSession(outboundCh))

	assert.False(t, srv.isCollabSubscribed(collabEntityDocument, documentID.String(), outboundCh))
	assert.Zero(t, srv.documentCollabSubscriberCount(documentID.String()))
}

func TestIntegration_DocumentContentCollabMessageCachesFullStateAndRelaysIncrementalSync(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	documentsSvc, ownerID, _, documentID, _ := seedDocumentCollabFixture(t, ctx, pool)
	srv := newDocumentCollabIntegrationServer(pool, documentsSvc)

	senderCh := make(chan outboundMsg, 1)
	recipientCh := make(chan outboundMsg, 1)
	srv.joinCollabRoom(collabEntityDocument, documentID.String(), senderCh)
	srv.joinCollabRoom(collabEntityDocument, documentID.String(), recipientCh)

	fullStatePayload := encodeCollabSyncFrameForTest(taskCollabSyncFrameTypeFullState, []byte("late-join-snapshot"))
	srv.handleDomainPayload(ctx, &packetspb.Envelope{
		RequestId: "doc-full-state",
		TraceId:   "trace-doc-full-state",
		Payload: &packetspb.Envelope_DocumentContentCollabMessage{
			DocumentContentCollabMessage: &packetspb.DocumentContentCollabMessage{
				DocumentId: documentID.String(),
				Kind:       packetspb.DocumentContentCollabMessageKind_DOCUMENT_CONTENT_COLLAB_MESSAGE_KIND_SYNC,
				Payload:    fullStatePayload,
			},
		},
	}, documentCollabPrincipal(ownerID), uuid.Nil, false, senderCh, enqueueToSession(senderCh))

	select {
	case msg := <-recipientCh:
		t.Fatalf("recipient received FULL_STATE relay unexpectedly: %#v", msg.env)
	case <-time.After(120 * time.Millisecond):
	}

	lateJoinerCh := make(chan outboundMsg, 1)
	resp := srv.documentCollabSubscribeResponse(documentID.String(), lateJoinerCh, "")
	assert.Equal(t, []byte("late-join-snapshot"), resp.GetRoomSnapshot())

	updatePayload := encodeCollabSyncFrameForTest(taskCollabSyncFrameTypeUpdate, []byte{1, 2, 3})
	srv.handleDomainPayload(ctx, &packetspb.Envelope{
		RequestId: "doc-update",
		TraceId:   "trace-doc-update",
		Payload: &packetspb.Envelope_DocumentContentCollabMessage{
			DocumentContentCollabMessage: &packetspb.DocumentContentCollabMessage{
				DocumentId: documentID.String(),
				Kind:       packetspb.DocumentContentCollabMessageKind_DOCUMENT_CONTENT_COLLAB_MESSAGE_KIND_SYNC,
				Payload:    updatePayload,
			},
		},
	}, documentCollabPrincipal(ownerID), uuid.Nil, false, senderCh, enqueueToSession(senderCh))

	select {
	case msg := <-recipientCh:
		require.NotNil(t, msg.env)
		relay := msg.env.GetDocumentContentCollabMessage()
		require.NotNil(t, relay)
		assert.Equal(t, documentID.String(), relay.GetDocumentId())
		assert.Equal(t, packetspb.DocumentContentCollabMessageKind_DOCUMENT_CONTENT_COLLAB_MESSAGE_KIND_SYNC, relay.GetKind())
		assert.Equal(t, updatePayload, relay.GetPayload())
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for document collab relay")
	}

	assert.Equal(t, 3, srv.documentCollabSubscriberCount(documentID.String()))
	assert.True(t, srv.isCollabSubscribed(collabEntityDocument, documentID.String(), lateJoinerCh))
	assert.True(t, srv.isCollabSubscribed(collabEntityDocument, documentID.String(), senderCh))
	assert.True(t, srv.isCollabSubscribed(collabEntityDocument, documentID.String(), recipientCh))
}
