//go:build integration

package tasks_test

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/encoding/protojson"
	"msgnr/internal/auth"
	"msgnr/internal/chat"
	"msgnr/internal/config"
	"msgnr/internal/events"
	packetspb "msgnr/internal/gen/proto"
	syncsvc "msgnr/internal/sync"
	"msgnr/internal/tasks"
	"msgnr/internal/testdb"
)

func TestIntegration_CommentBotAuthorIdentity(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	human := seedUser(t, ctx, pool)
	bot := seedBotUser(t, ctx, pool, "Bot")
	_, err := pool.Exec(ctx, `UPDATE users SET avatar_url = '/bot.png' WHERE id = $1`, bot)
	require.NoError(t, err)
	tpl := seedTemplate(t, ctx, svc, "BOT", human)
	status := seedStatus(t, ctx, svc, human)
	task := seedTask(t, ctx, svc, tpl.ID, status.ID, human, "Bot author")
	comment, err := svc.CreateComment(ctx, task.ID, bot, "hello")
	require.NoError(t, err)
	assert.Equal(t, "Bot", comment.AuthorName)
	assert.Equal(t, "/bot.png", comment.AuthorAvatarURL)
	updated, err := svc.UpdateComment(ctx, task.ID, comment.ID, bot, "edited")
	require.NoError(t, err)
	assert.Equal(t, "Bot", updated.AuthorName)
	assert.Equal(t, "/bot.png", updated.AuthorAvatarURL)
	comments, err := svc.ListComments(ctx, task.ID)
	require.NoError(t, err)
	require.Len(t, comments, 1)
	assert.Equal(t, "Bot", comments[0].AuthorName)
	assert.Equal(t, "/bot.png", comments[0].AuthorAvatarURL)
	thread, err := svc.EnsureCommentThread(ctx, task.ID, comment.ID, human)
	require.NoError(t, err)
	chatSvc := chat.NewService(pool, events.NewStore(pool))
	messages, err := chatSvc.ListRecentMessages(ctx, human, thread.ConversationID, 20)
	require.NoError(t, err)
	require.Len(t, messages, 1)
	assert.Equal(t, "Bot", messages[0].SenderName)
	users, err := svc.ListUsers(ctx)
	require.NoError(t, err)
	for _, user := range users {
		assert.NotEqual(t, bot, user.ID, "mention/assignee directory remains human-only")
	}
	_, err = pool.Exec(ctx, `UPDATE users SET display_name = '', email = 'bot@bot.com' WHERE id = $1`, bot)
	require.NoError(t, err)
	comments, err = svc.ListComments(ctx, task.ID)
	require.NoError(t, err)
	assert.Equal(t, "bot@bot.com", comments[0].AuthorName)
}

func TestIntegration_DiscussionMembershipEventsPrecedeMessages(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := tasks.NewService(pool, nil)
	human := seedUser(t, ctx, pool)
	other := seedUser(t, ctx, pool)
	bot := seedBotUser(t, ctx, pool, "Bot")
	tpl := seedTemplate(t, ctx, svc, "MEM", human)
	status := seedStatus(t, ctx, svc, human)
	task := seedTask(t, ctx, svc, tpl.ID, status.ID, human, "Membership events")
	comment, err := svc.CreateComment(ctx, task.ID, human, "root")
	require.NoError(t, err)
	thread, err := svc.EnsureCommentThread(ctx, task.ID, comment.ID, human)
	require.NoError(t, err)

	rows, err := pool.Query(ctx, `SELECT event_type, payload FROM workspace_events WHERE channel_id = $1 ORDER BY event_seq`, thread.ConversationID)
	require.NoError(t, err)
	var users []uuid.UUID
	rootSeen := false
	for rows.Next() {
		var kind string
		var payload []byte
		require.NoError(t, rows.Scan(&kind, &payload))
		if kind == "membership_changed" {
			assert.False(t, rootSeen, "membership must arrive before the root message")
			var event packetspb.MembershipChangedEvent
			require.NoError(t, protojson.Unmarshal(payload, &event))
			assert.Equal(t, packetspb.MembershipAction_MEMBERSHIP_ACTION_ADDED, event.Action)
			assert.Equal(t, thread.ConversationID.String(), event.ConversationId)
			users = append(users, uuid.MustParse(event.UserId))
		} else if kind == "message_created" {
			rootSeen = true
		}
	}
	require.NoError(t, rows.Err())
	rows.Close()
	assert.True(t, rootSeen)
	assert.ElementsMatch(t, []uuid.UUID{human, other, bot}, users)

	_, err = svc.EnsureCommentThread(ctx, task.ID, comment.ID, human)
	require.NoError(t, err)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspace_events WHERE channel_id = $1 AND event_type = 'membership_changed'`, thread.ConversationID).Scan(&count))
	assert.Equal(t, 3, count, "unchanged memberships emit no events")

	_, err = pool.Exec(ctx, `UPDATE channel_members SET is_archived = true WHERE channel_id = $1`, thread.ConversationID)
	require.NoError(t, err)
	_, err = svc.EnsureCommentThread(ctx, task.ID, comment.ID, human)
	require.NoError(t, err)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspace_events WHERE channel_id = $1 AND event_type = 'membership_changed'`, thread.ConversationID).Scan(&count))
	assert.Equal(t, 5, count, "only requester and bot memberships are restored")
	assert.False(t, isUnarchivedChannelMember(t, ctx, pool, thread.ConversationID, other))

	// A reconnect uses persisted membership and replays scoped task comments.
	created, err := svc.CreateComment(ctx, task.ID, bot, "after discussion exists")
	require.NoError(t, err)
	authSvc := auth.NewService(nil, nil, nil, pool, 0, nil)
	ids, err := authSvc.ListAuthorizedConversationIDs(ctx, human)
	require.NoError(t, err)
	assert.Contains(t, ids, thread.ConversationID)
	syncService := syncsvc.NewService(pool, &config.Config{
		MaxSyncBatch: 100, SyncEventLimit: 100, SyncRetentionWindow: 72,
	}, events.NewStore(pool), authSvc.CanReceiveEvent)
	for _, userID := range []uuid.UUID{human, other} {
		replay, err := syncService.SyncSince(ctx, auth.Principal{UserID: userID}, &packetspb.SyncSinceRequest{MaxEvents: 100})
		require.NoError(t, err)
		assert.False(t, replay.NeedFullBootstrap)
		found := false
		for _, event := range replay.Events {
			if payload := event.GetTaskCommentCreated(); payload != nil && payload.CommentId == created.ID.String() {
				found = true
			}
		}
		assert.Equal(t, userID == human, found, "only active members receive scoped comment replay")
	}
}
