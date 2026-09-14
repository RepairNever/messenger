//go:build integration

package chat

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"msgnr/internal/auth"
	"msgnr/internal/config"
	"msgnr/internal/events"
	"msgnr/internal/testdb"
)

func seedReactionTestUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, displayName string) uuid.UUID {
	t.Helper()
	var userID uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', $2, 'member')
		 RETURNING id`,
		"testuser_"+uuid.New().String()+"@example.com",
		displayName,
	).Scan(&userID)
	require.NoError(t, err)
	return userID
}

func seedReactionTestChannel(t *testing.T, ctx context.Context, pool *pgxpool.Pool, ownerID uuid.UUID, name string) uuid.UUID {
	t.Helper()
	var channelID uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO channels (kind, visibility, name, created_by)
		 VALUES ('channel', 'public', $1, $2)
		 RETURNING id`,
		name, ownerID,
	).Scan(&channelID)
	require.NoError(t, err)
	return channelID
}

func addReactionMember(t *testing.T, ctx context.Context, pool *pgxpool.Pool, channelID, userID uuid.UUID) {
	t.Helper()
	_, err := pool.Exec(ctx,
		`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`,
		channelID, userID,
	)
	require.NoError(t, err)
}

func TestIntegration_Handler_ListMessageReactionUsers_Success(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := NewService(pool, store)
	h := NewHandler(svc, nil, &config.Config{ChatHistoryPageSize: 50})

	user1 := seedReactionTestUser(t, ctx, pool, "Alpha")
	user2 := seedReactionTestUser(t, ctx, pool, "Bravo")
	channelID := seedReactionTestChannel(t, ctx, pool, user1, "main")
	addReactionMember(t, ctx, pool, channelID, user1)
	addReactionMember(t, ctx, pool, channelID, user2)

	msg, err := svc.SendMessage(ctx, SendMessageParams{
		ChannelID:   channelID,
		SenderID:    user1,
		ClientMsgID: uuid.New().String(),
		Body:        "hello",
	})
	require.NoError(t, err)

	_, err = svc.AddReaction(ctx, ReactionParams{
		ChannelID:  channelID,
		MessageID:  msg.MessageID,
		UserID:     user1,
		Emoji:      "👍",
		ClientOpID: uuid.New().String(),
	})
	require.NoError(t, err)
	time.Sleep(2 * time.Millisecond)
	_, err = svc.AddReaction(ctx, ReactionParams{
		ChannelID:  channelID,
		MessageID:  msg.MessageID,
		UserID:     user2,
		Emoji:      "👍",
		ClientOpID: uuid.New().String(),
	})
	require.NoError(t, err)

	req := httptest.NewRequest("GET", "/api/messages/reaction-users?conversation_id="+channelID.String()+"&message_id="+msg.MessageID.String()+"&emoji=%F0%9F%91%8D", nil)
	rec := httptest.NewRecorder()

	h.listMessageReactionUsers(rec, req, auth.Principal{UserID: user1})

	require.Equal(t, 200, rec.Code)
	var body reactionUsersResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Len(t, body.Users, 2)
	assert.Equal(t, user2.String(), body.Users[0].UserID)
	assert.Equal(t, "Bravo", body.Users[0].DisplayName)
}

func TestIntegration_Handler_ListMessageReactionUsers_ForbiddenForNonMember(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := NewService(pool, store)
	h := NewHandler(svc, nil, &config.Config{ChatHistoryPageSize: 50})

	member := seedReactionTestUser(t, ctx, pool, "Member")
	outsider := seedReactionTestUser(t, ctx, pool, "Outsider")
	channelID := seedReactionTestChannel(t, ctx, pool, member, "main")
	addReactionMember(t, ctx, pool, channelID, member)

	msg, err := svc.SendMessage(ctx, SendMessageParams{
		ChannelID:   channelID,
		SenderID:    member,
		ClientMsgID: uuid.New().String(),
		Body:        "hello",
	})
	require.NoError(t, err)

	req := httptest.NewRequest("GET", "/api/messages/reaction-users?conversation_id="+channelID.String()+"&message_id="+msg.MessageID.String()+"&emoji=%F0%9F%91%8D", nil)
	rec := httptest.NewRecorder()

	h.listMessageReactionUsers(rec, req, auth.Principal{UserID: outsider})

	require.Equal(t, 403, rec.Code)
	assert.Contains(t, rec.Body.String(), "not a member")
}

func TestIntegration_Handler_ListMessageReactionUsers_MessageNotFoundForConversation(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := NewService(pool, store)
	h := NewHandler(svc, nil, &config.Config{ChatHistoryPageSize: 50})

	user := seedReactionTestUser(t, ctx, pool, "Member")
	channelA := seedReactionTestChannel(t, ctx, pool, user, "a")
	channelB := seedReactionTestChannel(t, ctx, pool, user, "b")
	addReactionMember(t, ctx, pool, channelA, user)
	addReactionMember(t, ctx, pool, channelB, user)

	msg, err := svc.SendMessage(ctx, SendMessageParams{
		ChannelID:   channelA,
		SenderID:    user,
		ClientMsgID: uuid.New().String(),
		Body:        "hello",
	})
	require.NoError(t, err)

	req := httptest.NewRequest("GET", "/api/messages/reaction-users?conversation_id="+channelB.String()+"&message_id="+msg.MessageID.String()+"&emoji=%F0%9F%91%8D", nil)
	rec := httptest.NewRecorder()

	h.listMessageReactionUsers(rec, req, auth.Principal{UserID: user})

	require.Equal(t, 404, rec.Code)
	assert.Contains(t, rec.Body.String(), "message not found")
}

func TestIntegration_Handler_ListActiveCallMembers_Success(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := NewService(pool, store)
	h := NewHandler(svc, nil, &config.Config{ChatHistoryPageSize: 50})

	member := seedReactionTestUser(t, ctx, pool, "Member")
	other := seedReactionTestUser(t, ctx, pool, "Other")
	outsider := seedReactionTestUser(t, ctx, pool, "Outsider")
	channelID := seedReactionTestChannel(t, ctx, pool, member, "main")
	addReactionMember(t, ctx, pool, channelID, member)
	addReactionMember(t, ctx, pool, channelID, other)

	callID := uuid.New()
	_, err := pool.Exec(ctx, `
		INSERT INTO calls (id, channel_id, status, livekit_room, created_by, started_at)
		VALUES ($1, $2, 'active', $3, $4, now())`,
		callID, channelID, "call-"+callID.String(), member,
	)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `
		INSERT INTO call_participants (call_id, user_id, joined_at, left_at)
		VALUES ($1, $2, now(), NULL), ($1, $3, now(), NULL), ($1, $4, now(), now())`,
		callID, member, other, outsider,
	)
	require.NoError(t, err)

	req := httptest.NewRequest("GET", "/api/conversations/active-call-members?conversation_id="+channelID.String(), nil)
	rec := httptest.NewRecorder()

	h.listActiveCallMembers(rec, req, auth.Principal{UserID: member})

	require.Equal(t, 200, rec.Code)
	var body []conversationMemberResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Len(t, body, 2)
	assert.Equal(t, "Member", body[0].DisplayName)
	assert.Equal(t, "Other", body[1].DisplayName)
}
