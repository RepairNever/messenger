//go:build integration

package auth_test

import (
	"context"
	"testing"

	authsvc "msgnr/internal/auth"
	packetspb "msgnr/internal/gen/proto"
	"msgnr/internal/testdb"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func seedAuthCallUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, name string) uuid.UUID {
	t.Helper()
	var userID uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role, status)
		 VALUES ($1, 'x', $2, 'member', 'active')
		 RETURNING id`,
		uuid.NewString()+"@example.com",
		name,
	).Scan(&userID)
	require.NoError(t, err)
	return userID
}

func seedAuthDMConversation(t *testing.T, ctx context.Context, pool *pgxpool.Pool, creatorID uuid.UUID) uuid.UUID {
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

func seedAuthConversationMember(t *testing.T, ctx context.Context, pool *pgxpool.Pool, conversationID, userID uuid.UUID) {
	t.Helper()
	_, err := pool.Exec(ctx, `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`, conversationID, userID)
	require.NoError(t, err)
}

func seedAuthActiveCall(t *testing.T, ctx context.Context, pool *pgxpool.Pool, conversationID, creatorID uuid.UUID) uuid.UUID {
	t.Helper()
	callID := uuid.New()
	_, err := pool.Exec(ctx, `
		INSERT INTO calls (id, channel_id, status, livekit_room, created_by, started_at)
		VALUES ($1, $2, 'active', $3, $4, now())`,
		callID, conversationID, "call-"+callID.String(), creatorID,
	)
	require.NoError(t, err)
	return callID
}

func seedAuthCallParticipant(t *testing.T, ctx context.Context, pool *pgxpool.Pool, callID, userID uuid.UUID) {
	t.Helper()
	_, err := pool.Exec(ctx, `
		INSERT INTO call_participants (call_id, user_id, joined_at, left_at)
		VALUES ($1, $2, now(), NULL)`,
		callID, userID,
	)
	require.NoError(t, err)
}

func TestIntegration_CanReceiveEvent_CallEventsAllowActiveParticipant(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	ownerID := seedAuthCallUser(t, ctx, pool, "Owner")
	dmPeerID := seedAuthCallUser(t, ctx, pool, "DM Peer")
	outsiderID := seedAuthCallUser(t, ctx, pool, "Outsider")

	dmID := seedAuthDMConversation(t, ctx, pool, ownerID)
	seedAuthConversationMember(t, ctx, pool, dmID, ownerID)
	seedAuthConversationMember(t, ctx, pool, dmID, dmPeerID)

	callID := seedAuthActiveCall(t, ctx, pool, dmID, ownerID)
	seedAuthCallParticipant(t, ctx, pool, callID, ownerID)
	seedAuthCallParticipant(t, ctx, pool, callID, outsiderID)

	svc := authsvc.NewService(nil, nil, nil, pool, 0, nil)
	principal := authsvc.Principal{UserID: outsiderID, SessionID: uuid.New(), Role: "member"}

	callEvent := &packetspb.ServerEvent{
		EventType:      packetspb.EventType_EVENT_TYPE_CALL_STATE_CHANGED,
		ConversationId: dmID.String(),
		Payload: &packetspb.ServerEvent_CallStateChanged{
			CallStateChanged: &packetspb.CallStateChangedEvent{
				CallId:         callID.String(),
				ConversationId: dmID.String(),
				Status:         packetspb.CallStatus_CALL_STATUS_ACTIVE,
			},
		},
	}
	assert.True(t, svc.CanReceiveEvent(ctx, principal, callEvent))
	raisedHandsEvent := &packetspb.ServerEvent{
		EventType:      packetspb.EventType_EVENT_TYPE_CALL_RAISED_HANDS_CHANGED,
		ConversationId: dmID.String(),
		Payload: &packetspb.ServerEvent_CallRaisedHandsChanged{
			CallRaisedHandsChanged: &packetspb.CallRaisedHandsChangedEvent{
				CallId:         callID.String(),
				ConversationId: dmID.String(),
			},
		},
	}
	assert.True(t, svc.CanReceiveEvent(ctx, principal, raisedHandsEvent))

	messageEvent := &packetspb.ServerEvent{
		EventType:      packetspb.EventType_EVENT_TYPE_MESSAGE_CREATED,
		ConversationId: dmID.String(),
	}
	assert.False(t, svc.CanReceiveEvent(ctx, principal, messageEvent))
}

func TestIntegration_CanReceiveEvent_CallStateChangedDeniesNonParticipant(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	ownerID := seedAuthCallUser(t, ctx, pool, "Owner")
	dmPeerID := seedAuthCallUser(t, ctx, pool, "DM Peer")
	outsiderID := seedAuthCallUser(t, ctx, pool, "Outsider")

	dmID := seedAuthDMConversation(t, ctx, pool, ownerID)
	seedAuthConversationMember(t, ctx, pool, dmID, ownerID)
	seedAuthConversationMember(t, ctx, pool, dmID, dmPeerID)

	callID := seedAuthActiveCall(t, ctx, pool, dmID, ownerID)
	seedAuthCallParticipant(t, ctx, pool, callID, ownerID)

	svc := authsvc.NewService(nil, nil, nil, pool, 0, nil)
	principal := authsvc.Principal{UserID: outsiderID, SessionID: uuid.New(), Role: "member"}

	callEvent := &packetspb.ServerEvent{
		EventType:      packetspb.EventType_EVENT_TYPE_CALL_STATE_CHANGED,
		ConversationId: dmID.String(),
		Payload: &packetspb.ServerEvent_CallStateChanged{
			CallStateChanged: &packetspb.CallStateChangedEvent{
				CallId:         callID.String(),
				ConversationId: dmID.String(),
				Status:         packetspb.CallStatus_CALL_STATUS_ACTIVE,
			},
		},
	}
	assert.False(t, svc.CanReceiveEvent(ctx, principal, callEvent))
}

func TestIntegration_CanReceiveEvent_UserCallPresenceChangedAllowsWorkspaceMembers(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	viewerID := seedAuthCallUser(t, ctx, pool, "Viewer")
	svc := authsvc.NewService(nil, nil, nil, pool, 0, nil)
	principal := authsvc.Principal{UserID: viewerID, SessionID: uuid.New(), Role: "member"}

	evt := &packetspb.ServerEvent{
		EventType: packetspb.EventType_EVENT_TYPE_USER_CALL_PRESENCE_CHANGED,
		Payload: &packetspb.ServerEvent_UserCallPresenceChanged{
			UserCallPresenceChanged: &packetspb.UserCallPresenceChangedEvent{
				UserId:          uuid.NewString(),
				ActiveCallCount: 1,
			},
		},
	}
	assert.True(t, svc.CanReceiveEvent(ctx, principal, evt))
}
