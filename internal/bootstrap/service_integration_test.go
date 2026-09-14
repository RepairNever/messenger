//go:build integration

package bootstrap_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/encoding/protojson"

	"msgnr/internal/auth"
	"msgnr/internal/bootstrap"
	"msgnr/internal/chat"
	"msgnr/internal/config"
	"msgnr/internal/events"
	packetspb "msgnr/internal/gen/proto"
	"msgnr/internal/sync"
	"msgnr/internal/testdb"
)

func seedBootstrapWorkspace(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	_, err := pool.Exec(ctx, `INSERT INTO workspace (name) VALUES ('Acme')`)
	require.NoError(t, err)
}

func seedBootstrapUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	return seedBootstrapUserWithIdentity(t, ctx, pool, "Bootstrap User", "bootstrap_"+uuid.NewString()+"@example.com")
}

func seedBootstrapUserWithIdentity(t *testing.T, ctx context.Context, pool *pgxpool.Pool, displayName, email string) uuid.UUID {
	t.Helper()
	var userID uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', $2, 'member')
		 RETURNING id`,
		email,
		displayName,
	).Scan(&userID)
	require.NoError(t, err)
	return userID
}

func seedBootstrapChannel(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID uuid.UUID, name string, lastActivity time.Time) uuid.UUID {
	t.Helper()
	var channelID uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO channels (kind, visibility, name, created_by, last_activity_at)
		 VALUES ('channel', 'public', $1, $2, $3)
		 RETURNING id`,
		name, userID, lastActivity,
	).Scan(&channelID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx,
		`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`,
		channelID, userID,
	)
	require.NoError(t, err)
	return channelID
}

func seedBootstrapDMConversation(t *testing.T, ctx context.Context, pool *pgxpool.Pool, creatorID uuid.UUID) uuid.UUID {
	t.Helper()
	var conversationID uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO channels (kind, visibility, name, created_by, last_activity_at)
		 VALUES ('dm', 'dm', '', $1, now())
		 RETURNING id`,
		creatorID,
	).Scan(&conversationID)
	require.NoError(t, err)
	return conversationID
}

func seedBootstrapMember(t *testing.T, ctx context.Context, pool *pgxpool.Pool, conversationID, userID uuid.UUID) {
	t.Helper()
	_, err := pool.Exec(ctx, `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`, conversationID, userID)
	require.NoError(t, err)
}

func seedBootstrapActiveCall(t *testing.T, ctx context.Context, pool *pgxpool.Pool, conversationID, creatorID uuid.UUID) uuid.UUID {
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

func seedBootstrapCallParticipant(t *testing.T, ctx context.Context, pool *pgxpool.Pool, callID, userID uuid.UUID) {
	t.Helper()
	_, err := pool.Exec(ctx, `
		INSERT INTO call_participants (call_id, user_id, joined_at, left_at)
		VALUES ($1, $2, now(), NULL)`,
		callID, userID,
	)
	require.NoError(t, err)
}

func appendMessageEvent(t *testing.T, ctx context.Context, pool *pgxpool.Pool, store *events.Store, channelID uuid.UUID, body string, occurredAt time.Time) int64 {
	t.Helper()
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer tx.Rollback(ctx) //nolint:errcheck

	msg := &packetspb.MessageEvent{
		ConversationId: channelID.String(),
		MessageId:      uuid.NewString(),
		SenderId:       uuid.NewString(),
		Body:           body,
		ChannelSeq:     1,
	}
	payload, err := protojson.Marshal(msg)
	require.NoError(t, err)
	stored, err := store.AppendEventTx(ctx, tx, events.AppendParams{
		EventID:     uuid.NewString(),
		EventType:   "message_created",
		ChannelID:   channelID.String(),
		PayloadJSON: payload,
		OccurredAt:  occurredAt,
	})
	require.NoError(t, err)
	require.NoError(t, tx.Commit(ctx))
	return stored.Seq
}

func TestIntegration_Bootstrap_FirstPageAndContinuation(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	cfg := &config.Config{
		BootstrapDefaultPageSize: 1,
		BootstrapMaxPageSize:     5,
		BootstrapSessionTTL:      5 * time.Minute,
		MaxSyncBatch:             100,
		SyncEventLimit:           100,
		SyncRetentionWindow:      72,
	}
	syncSvc := sync.NewService(pool, cfg, store, nil)
	bootstrapSvc := bootstrap.NewService(pool, cfg)

	seedBootstrapWorkspace(t, ctx, pool)
	userID := seedBootstrapUser(t, ctx, pool)
	ch1 := seedBootstrapChannel(t, ctx, pool, userID, "general", time.Now().Add(-1*time.Minute))
	ch2 := seedBootstrapChannel(t, ctx, pool, userID, "random", time.Now())
	_, err := pool.Exec(ctx, `INSERT INTO user_presence (user_id, status) VALUES ($1, 'online')`, userID)
	require.NoError(t, err)
	var rootMessageID uuid.UUID
	err = pool.QueryRow(ctx,
		`INSERT INTO messages (channel_id, channel_seq, sender_id, client_msg_id, body, thread_seq)
		 VALUES ($1, 1, $2, $3, 'root', 0)
		 RETURNING id`,
		ch2, userID, uuid.NewString(),
	).Scan(&rootMessageID)
	require.NoError(t, err)
	var replyMessageID uuid.UUID
	err = pool.QueryRow(ctx,
		`INSERT INTO messages (channel_id, channel_seq, sender_id, client_msg_id, body, thread_root_id, thread_seq)
		 VALUES ($1, 2, $2, $3, 'reply', $4, 1)
		 RETURNING id`,
		ch2, userID, uuid.NewString(), rootMessageID,
	).Scan(&replyMessageID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `
		INSERT INTO notifications (user_id, type, title, body, channel_id, message_id, thread_root_message_id)
		VALUES ($1, 'mention', 't', 'b', $2, $3, $4)`,
		userID, ch2, replyMessageID, rootMessageID,
	)
	require.NoError(t, err)

	appendMessageEvent(t, ctx, pool, store, ch1, "older", time.Now().Add(-2*time.Minute))
	appendMessageEvent(t, ctx, pool, store, ch2, "newer", time.Now().Add(-1*time.Minute))

	principal := auth.Principal{UserID: userID, SessionID: uuid.New(), Role: "member"}
	first, err := bootstrapSvc.Bootstrap(ctx, principal, &packetspb.BootstrapRequest{
		ClientInstanceId: "client-1",
		PageSizeHint:     1,
	})
	require.NoError(t, err)
	require.Equal(t, uint32(0), first.GetPageIndex())
	require.True(t, first.GetHasMore())
	require.Len(t, first.GetConversations(), 1)
	require.NotEmpty(t, first.GetBootstrapSessionId())
	require.NotNil(t, first.GetWorkspace())
	require.NotEmpty(t, first.GetNotifications())
	require.Equal(t, replyMessageID.String(), first.GetNotifications()[0].GetMessageId())
	require.Equal(t, rootMessageID.String(), first.GetNotifications()[0].GetThreadRootMessageId())

	second, err := bootstrapSvc.Bootstrap(ctx, principal, &packetspb.BootstrapRequest{
		ClientInstanceId:   "client-1",
		BootstrapSessionId: first.GetBootstrapSessionId(),
		PageToken:          first.GetNextPageToken(),
	})
	require.NoError(t, err)
	assert.Equal(t, first.GetSnapshotSeq(), second.GetSnapshotSeq())
	assert.Equal(t, first.GetBootstrapSessionId(), second.GetBootstrapSessionId())
	assert.Len(t, second.GetConversations(), 1)
	assert.Nil(t, second.GetWorkspace())
	assert.Empty(t, second.GetNotifications())
	assert.False(t, second.GetHasMore())

	persisted, err := syncSvc.GetPersistedCursor(ctx, userID)
	require.NoError(t, err)
	assert.Zero(t, persisted)
	assert.NotEqual(t, first.GetConversations()[0].GetConversationId(), second.GetConversations()[0].GetConversationId())
}

func TestIntegration_Bootstrap_HiddenChannelsExcluded(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	cfg := &config.Config{
		BootstrapDefaultPageSize: 10,
		BootstrapMaxPageSize:     10,
		BootstrapSessionTTL:      5 * time.Minute,
	}
	bootstrapSvc := bootstrap.NewService(pool, cfg)

	seedBootstrapWorkspace(t, ctx, pool)
	userID := seedBootstrapUser(t, ctx, pool)
	visibleID := seedBootstrapChannel(t, ctx, pool, userID, "general", time.Now())
	var hiddenID uuid.UUID
	err := pool.QueryRow(ctx, `
		INSERT INTO channels (kind, visibility, name, created_by, hidden)
		VALUES ('channel', 'private', 'task hidden', $1, true)
		RETURNING id`,
		userID,
	).Scan(&hiddenID)
	require.NoError(t, err)
	seedBootstrapMember(t, ctx, pool, hiddenID, userID)

	resp, err := bootstrapSvc.Bootstrap(ctx, auth.Principal{UserID: userID, SessionID: uuid.New(), Role: "member"}, &packetspb.BootstrapRequest{
		ClientInstanceId: "client-hidden",
		PageSizeHint:     10,
		IncludeArchived:  true,
	})
	require.NoError(t, err)
	require.Len(t, resp.GetConversations(), 1)
	assert.Equal(t, visibleID.String(), resp.GetConversations()[0].GetConversationId())
	assert.Equal(t, uint32(1), resp.GetEstimatedTotalConversations())
}

func TestIntegration_Bootstrap_SelfDmConversationSummary(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	cfg := &config.Config{
		BootstrapDefaultPageSize: 5,
		BootstrapMaxPageSize:     5,
		BootstrapSessionTTL:      5 * time.Minute,
	}
	bootstrapSvc := bootstrap.NewService(pool, cfg)
	chatSvc := chat.NewService(pool, store)

	seedBootstrapWorkspace(t, ctx, pool)
	userID := seedBootstrapUserWithIdentity(t, ctx, pool, "Ada", "ada_"+uuid.NewString()+"@example.com")
	_, err := pool.Exec(ctx, `INSERT INTO user_presence (user_id, status) VALUES ($1, 'online')`, userID)
	require.NoError(t, err)

	_, err = chatSvc.CreateOrOpenDirectMessage(ctx, userID, userID)
	require.NoError(t, err)

	principal := auth.Principal{UserID: userID, SessionID: uuid.New(), Role: "member"}
	resp, err := bootstrapSvc.Bootstrap(ctx, principal, &packetspb.BootstrapRequest{
		ClientInstanceId: "client-self-dm",
		PageSizeHint:     5,
	})
	require.NoError(t, err)
	require.Len(t, resp.GetConversations(), 1)

	dm := resp.GetConversations()[0]
	assert.Equal(t, packetspb.ConversationType_CONVERSATION_TYPE_DM, dm.GetConversationType())
	assert.Equal(t, "Ada", dm.GetTitle())
	assert.Equal(t, userID.String(), dm.GetTopic())
	assert.Equal(t, int32(1), dm.GetMemberCount())
	assert.Equal(t, packetspb.PresenceStatus_PRESENCE_STATUS_ONLINE, dm.GetPresence())
}

func TestIntegration_Bootstrap_FirstPageIncludesWorkspaceUserCallPresence(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	cfg := &config.Config{
		BootstrapDefaultPageSize: 5,
		BootstrapMaxPageSize:     5,
		BootstrapSessionTTL:      5 * time.Minute,
	}
	bootstrapSvc := bootstrap.NewService(pool, cfg)

	seedBootstrapWorkspace(t, ctx, pool)
	viewerID := seedBootstrapUserWithIdentity(t, ctx, pool, "Viewer", "viewer_"+uuid.NewString()+"@example.com")
	visibleChannelID := seedBootstrapChannel(t, ctx, pool, viewerID, "general", time.Now())

	callerID := seedBootstrapUserWithIdentity(t, ctx, pool, "Caller", "caller_"+uuid.NewString()+"@example.com")
	dmPeerID := seedBootstrapUserWithIdentity(t, ctx, pool, "DM Peer", "peer_"+uuid.NewString()+"@example.com")
	dmID := seedBootstrapDMConversation(t, ctx, pool, callerID)
	seedBootstrapMember(t, ctx, pool, dmID, callerID)
	seedBootstrapMember(t, ctx, pool, dmID, dmPeerID)
	callID := seedBootstrapActiveCall(t, ctx, pool, dmID, callerID)
	seedBootstrapCallParticipant(t, ctx, pool, callID, callerID)

	principal := auth.Principal{UserID: viewerID, SessionID: uuid.New(), Role: "member"}
	resp, err := bootstrapSvc.Bootstrap(ctx, principal, &packetspb.BootstrapRequest{
		ClientInstanceId: "client-user-call-presence",
		PageSizeHint:     5,
	})
	require.NoError(t, err)
	require.Len(t, resp.GetConversations(), 1)
	assert.Equal(t, visibleChannelID.String(), resp.GetConversations()[0].GetConversationId())
	assert.Empty(t, resp.GetActiveCalls(), "conversation-scoped active calls remain filtered by membership")

	require.Len(t, resp.GetUserCallPresence(), 1)
	assert.Equal(t, callerID.String(), resp.GetUserCallPresence()[0].GetUserId())
	assert.Equal(t, int32(1), resp.GetUserCallPresence()[0].GetActiveCallCount())
}

func TestIntegration_Bootstrap_ClientMismatchRejected(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	cfg := &config.Config{
		BootstrapDefaultPageSize: 1,
		BootstrapMaxPageSize:     5,
		BootstrapSessionTTL:      5 * time.Minute,
	}
	bootstrapSvc := bootstrap.NewService(pool, cfg)

	seedBootstrapWorkspace(t, ctx, pool)
	userID := seedBootstrapUser(t, ctx, pool)
	seedBootstrapChannel(t, ctx, pool, userID, "general", time.Now())

	principal := auth.Principal{UserID: userID, SessionID: uuid.New(), Role: "member"}
	first, err := bootstrapSvc.Bootstrap(ctx, principal, &packetspb.BootstrapRequest{
		ClientInstanceId: "client-a",
		PageSizeHint:     1,
	})
	require.NoError(t, err)

	_, err = bootstrapSvc.Bootstrap(ctx, principal, &packetspb.BootstrapRequest{
		ClientInstanceId:   "client-b",
		BootstrapSessionId: first.GetBootstrapSessionId(),
		PageToken:          first.GetNextPageToken(),
	})
	require.ErrorIs(t, err, bootstrap.ErrSessionMismatch)
}

func TestIntegration_Bootstrap_FirstPageWithoutWorkspaceRow(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	cfg := &config.Config{
		BootstrapDefaultPageSize: 1,
		BootstrapMaxPageSize:     5,
		BootstrapSessionTTL:      5 * time.Minute,
	}
	bootstrapSvc := bootstrap.NewService(pool, cfg)

	userID := seedBootstrapUser(t, ctx, pool)
	seedBootstrapChannel(t, ctx, pool, userID, "general", time.Now())

	principal := auth.Principal{UserID: userID, SessionID: uuid.New(), Role: "member"}
	first, err := bootstrapSvc.Bootstrap(ctx, principal, &packetspb.BootstrapRequest{
		ClientInstanceId: "client-1",
		PageSizeHint:     1,
	})
	require.NoError(t, err)
	require.NotNil(t, first.GetWorkspace())
	assert.Equal(t, "Workspace", first.GetWorkspace().GetWorkspaceName())
	assert.Equal(t, "", first.GetWorkspace().GetWorkspaceId())
	assert.Equal(t, userID.String(), first.GetWorkspace().GetSelfUser().GetUserId())
	assert.Equal(t, "Bootstrap User", first.GetWorkspace().GetSelfUser().GetDisplayName())
}

func TestIntegration_Bootstrap_UnreadCountersIncludeThreadReplies(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	cfg := &config.Config{
		BootstrapDefaultPageSize: 10,
		BootstrapMaxPageSize:     10,
		BootstrapSessionTTL:      5 * time.Minute,
	}
	bootstrapSvc := bootstrap.NewService(pool, cfg)

	seedBootstrapWorkspace(t, ctx, pool)
	userID := seedBootstrapUser(t, ctx, pool)
	channelID := seedBootstrapChannel(t, ctx, pool, userID, "general", time.Now())

	var rootMessageID uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO messages (channel_id, channel_seq, sender_id, client_msg_id, body, thread_seq)
		 VALUES ($1, 1, $2, $3, 'root', 0)
		 RETURNING id`,
		channelID, userID, uuid.NewString(),
	).Scan(&rootMessageID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx,
		`INSERT INTO thread_summaries (root_message_id, channel_id, reply_count, next_thread_seq, last_reply_at, last_reply_user_id)
		 VALUES ($1, $2, 1, 2, now(), $3)`,
		rootMessageID, channelID, userID,
	)
	require.NoError(t, err)
	_, err = pool.Exec(ctx,
		`INSERT INTO thread_reads (root_message_id, user_id, last_read_thread_seq)
		 VALUES ($1, $2, 0)`,
		rootMessageID, userID,
	)
	require.NoError(t, err)

	principal := auth.Principal{UserID: userID, SessionID: uuid.New(), Role: "member"}
	resp, err := bootstrapSvc.Bootstrap(ctx, principal, &packetspb.BootstrapRequest{
		ClientInstanceId: "client-1",
		PageSizeHint:     10,
	})
	require.NoError(t, err)
	require.Len(t, resp.GetUnread(), 1)
	assert.True(t, resp.GetUnread()[0].GetHasUnreadThreadReplies())
}

func TestIntegration_Bootstrap_UnreadCountersExcludeSelfMessages(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	cfg := &config.Config{
		BootstrapDefaultPageSize: 10,
		BootstrapMaxPageSize:     10,
		BootstrapSessionTTL:      5 * time.Minute,
	}
	bootstrapSvc := bootstrap.NewService(pool, cfg)

	seedBootstrapWorkspace(t, ctx, pool)
	selfUserID := seedBootstrapUserWithIdentity(t, ctx, pool, "Self User", "self_"+uuid.NewString()+"@example.com")
	peerUserID := seedBootstrapUserWithIdentity(t, ctx, pool, "Peer User", "peer_"+uuid.NewString()+"@example.com")
	channelID := seedBootstrapChannel(t, ctx, pool, selfUserID, "general", time.Now())
	_, err := pool.Exec(ctx,
		`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`,
		channelID, peerUserID,
	)
	require.NoError(t, err)

	_, err = pool.Exec(ctx,
		`INSERT INTO messages (channel_id, channel_seq, sender_id, client_msg_id, body, thread_seq)
		 VALUES ($1, 1, $2, $3, 'self message', 0),
		        ($1, 2, $4, $5, 'peer message', 0)`,
		channelID, selfUserID, uuid.NewString(), peerUserID, uuid.NewString(),
	)
	require.NoError(t, err)

	principal := auth.Principal{UserID: selfUserID, SessionID: uuid.New(), Role: "member"}
	resp, err := bootstrapSvc.Bootstrap(ctx, principal, &packetspb.BootstrapRequest{
		ClientInstanceId: "client-1",
		PageSizeHint:     10,
	})
	require.NoError(t, err)
	require.Len(t, resp.GetUnread(), 1)
	assert.Equal(t, int32(1), resp.GetUnread()[0].GetUnreadMessages())
}

func TestIntegration_Bootstrap_DmTitleFallsBackToPeerEmail(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	cfg := &config.Config{
		BootstrapDefaultPageSize: 10,
		BootstrapMaxPageSize:     10,
		BootstrapSessionTTL:      5 * time.Minute,
	}
	bootstrapSvc := bootstrap.NewService(pool, cfg)

	seedBootstrapWorkspace(t, ctx, pool)
	selfUserID := seedBootstrapUserWithIdentity(t, ctx, pool, "Self User", "self_"+uuid.NewString()+"@example.com")
	peerEmail := "dm_peer_" + uuid.NewString() + "@example.com"
	peerUserID := seedBootstrapUserWithIdentity(t, ctx, pool, "", peerEmail)

	var dmChannelID uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO channels (kind, visibility, name, created_by, last_activity_at)
		 VALUES ('dm', 'dm', '', $1, now())
		 RETURNING id`,
		selfUserID,
	).Scan(&dmChannelID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx,
		`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2), ($1, $3)`,
		dmChannelID, selfUserID, peerUserID,
	)
	require.NoError(t, err)

	principal := auth.Principal{UserID: selfUserID, SessionID: uuid.New(), Role: "member"}
	resp, err := bootstrapSvc.Bootstrap(ctx, principal, &packetspb.BootstrapRequest{
		ClientInstanceId: "client-1",
		PageSizeHint:     10,
	})
	require.NoError(t, err)
	require.Len(t, resp.GetConversations(), 1)
	assert.Equal(t, packetspb.ConversationType_CONVERSATION_TYPE_DM, resp.GetConversations()[0].GetConversationType())
	assert.Equal(t, peerEmail, resp.GetConversations()[0].GetTitle())
	assert.Equal(t, peerUserID.String(), resp.GetConversations()[0].GetTopic())
}

func TestIntegration_Bootstrap_ActiveCallsIncludeParticipantOnlyUser(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	cfg := &config.Config{
		BootstrapDefaultPageSize: 10,
		BootstrapMaxPageSize:     10,
		BootstrapSessionTTL:      5 * time.Minute,
	}
	bootstrapSvc := bootstrap.NewService(pool, cfg)

	seedBootstrapWorkspace(t, ctx, pool)
	ownerID := seedBootstrapUserWithIdentity(t, ctx, pool, "Owner", "owner_"+uuid.NewString()+"@example.com")
	dmPeerID := seedBootstrapUserWithIdentity(t, ctx, pool, "DM Peer", "peer_"+uuid.NewString()+"@example.com")
	outsiderID := seedBootstrapUserWithIdentity(t, ctx, pool, "Outsider", "outsider_"+uuid.NewString()+"@example.com")

	dmID := seedBootstrapDMConversation(t, ctx, pool, ownerID)
	seedBootstrapMember(t, ctx, pool, dmID, ownerID)
	seedBootstrapMember(t, ctx, pool, dmID, dmPeerID)

	callID := seedBootstrapActiveCall(t, ctx, pool, dmID, ownerID)
	seedBootstrapCallParticipant(t, ctx, pool, callID, ownerID)
	seedBootstrapCallParticipant(t, ctx, pool, callID, outsiderID)
	_, err := pool.Exec(ctx, `
		UPDATE call_participants
		   SET hand_raised_sequence = CASE user_id
		     WHEN $2 THEN 1
		     WHEN $3 THEN 2
		   END
		 WHERE call_id = $1`, callID, ownerID, outsiderID)
	require.NoError(t, err)

	principal := auth.Principal{UserID: outsiderID, SessionID: uuid.New(), Role: "member"}
	resp, err := bootstrapSvc.Bootstrap(ctx, principal, &packetspb.BootstrapRequest{
		ClientInstanceId: "client-outsider-active-call",
		PageSizeHint:     10,
	})
	require.NoError(t, err)
	require.Empty(t, resp.GetConversations())
	require.Len(t, resp.GetActiveCalls(), 1)
	assert.Equal(t, callID.String(), resp.GetActiveCalls()[0].GetCallId())
	assert.Equal(t, dmID.String(), resp.GetActiveCalls()[0].GetConversationId())
	assert.Equal(t, int32(2), resp.GetActiveCalls()[0].GetParticipantCount())
	require.Len(t, resp.GetActiveCalls()[0].GetRaisedHands(), 2)
	assert.Equal(t, ownerID.String(), resp.GetActiveCalls()[0].GetRaisedHands()[0].GetUserId())
	assert.Equal(t, int32(1), resp.GetActiveCalls()[0].GetRaisedHands()[0].GetPosition())
	assert.Equal(t, outsiderID.String(), resp.GetActiveCalls()[0].GetRaisedHands()[1].GetUserId())
	assert.Equal(t, int32(2), resp.GetActiveCalls()[0].GetRaisedHands()[1].GetPosition())
}
