//go:build integration

package search_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"msgnr/internal/chat"
	"msgnr/internal/events"
	"msgnr/internal/search"
	"msgnr/internal/tasks"
	"msgnr/internal/testdb"
)

func seedUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, displayName string) uuid.UUID {
	t.Helper()

	var id uuid.UUID
	err := pool.QueryRow(ctx, `
		INSERT INTO users (email, password_hash, display_name, role, status)
		VALUES ($1, 'x', $2, 'member', 'active')
		RETURNING id`,
		strings.ToLower(strings.ReplaceAll(displayName, " ", "_"))+"_"+uuid.NewString()+"@example.com",
		displayName,
	).Scan(&id)
	require.NoError(t, err)
	return id
}

func seedChannel(t *testing.T, ctx context.Context, pool *pgxpool.Pool, creatorID uuid.UUID, name string, hidden bool, memberIDs ...uuid.UUID) uuid.UUID {
	t.Helper()

	var id uuid.UUID
	err := pool.QueryRow(ctx, `
		INSERT INTO channels (kind, visibility, name, created_by, hidden)
		VALUES ('channel', 'private', $1, $2, $3)
		RETURNING id`,
		name,
		creatorID,
		hidden,
	).Scan(&id)
	require.NoError(t, err)

	for _, memberID := range memberIDs {
		_, err = pool.Exec(ctx, `
			INSERT INTO channel_members (channel_id, user_id)
			VALUES ($1, $2)
			ON CONFLICT DO NOTHING`,
			id,
			memberID,
		)
		require.NoError(t, err)
	}
	return id
}

func setMessageCreatedAt(t *testing.T, ctx context.Context, pool *pgxpool.Pool, messageID uuid.UUID, createdAt time.Time) {
	t.Helper()
	_, err := pool.Exec(ctx, `UPDATE messages SET created_at = $2 WHERE id = $1`, messageID, createdAt)
	require.NoError(t, err)
}

func setCommentCreatedAt(t *testing.T, ctx context.Context, pool *pgxpool.Pool, commentID uuid.UUID, createdAt time.Time) {
	t.Helper()
	_, err := pool.Exec(ctx, `UPDATE task_comment SET created_at = $2, updated_at = $2 WHERE id = $1`, commentID, createdAt)
	require.NoError(t, err)
}

func seedTask(t *testing.T, ctx context.Context, svc *tasks.Service, actorID uuid.UUID, title string) tasks.TaskResponse {
	t.Helper()
	template, err := svc.CreateTemplate(ctx, tasks.CreateTemplateParams{
		Prefix:    "SRCH",
		SortOrder: 1,
		ActorID:   actorID,
	})
	require.NoError(t, err)
	status, err := svc.CreateStatus(ctx, tasks.CreateStatusParams{
		Code:      "todo_" + uuid.NewString()[:8],
		Name:      "Todo",
		SortOrder: 1,
		ActorID:   actorID,
	})
	require.NoError(t, err)
	task, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: template.ID,
		Title:      title,
		StatusID:   status.ID,
		ActorID:    actorID,
	})
	require.NoError(t, err)
	return task
}

func TestIntegration_SearchMessages_GlobalFindsChatTaskCommentsAndTaskThreads(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	store := events.NewStore(pool)
	chatSvc := chat.NewService(pool, store)
	tasksSvc := tasks.NewService(pool, nil)
	searchSvc := search.NewService(pool)

	requesterID := seedUser(t, ctx, pool, "Search Requester")
	outsiderID := seedUser(t, ctx, pool, "Search Outsider")
	channelID := seedChannel(t, ctx, pool, requesterID, "visible-search", false, requesterID)
	outsiderChannelID := seedChannel(t, ctx, pool, outsiderID, "outsider-search", false, outsiderID)
	unrelatedHiddenID := seedChannel(t, ctx, pool, requesterID, "hidden-search", true, requesterID)
	baseTime := time.Date(2026, 5, 12, 10, 0, 0, 0, time.UTC)

	visibleRoot, err := chatSvc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    requesterID,
		ClientMsgID: uuid.NewString(),
		Body:        "needle visible root",
	})
	require.NoError(t, err)
	setMessageCreatedAt(t, ctx, pool, visibleRoot.MessageID, baseTime.Add(time.Minute))

	threadRoot, err := chatSvc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    requesterID,
		ClientMsgID: uuid.NewString(),
		Body:        "plain root",
	})
	require.NoError(t, err)
	threadReply, err := chatSvc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:           channelID,
		SenderID:            requesterID,
		ClientMsgID:         uuid.NewString(),
		Body:                "needle visible thread reply",
		ThreadRootMessageID: threadRoot.MessageID,
	})
	require.NoError(t, err)
	setMessageCreatedAt(t, ctx, pool, threadReply.MessageID, baseTime.Add(2*time.Minute))

	outsiderMessage, err := chatSvc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   outsiderChannelID,
		SenderID:    outsiderID,
		ClientMsgID: uuid.NewString(),
		Body:        "needle outsider message",
	})
	require.NoError(t, err)
	setMessageCreatedAt(t, ctx, pool, outsiderMessage.MessageID, baseTime.Add(3*time.Minute))

	unrelatedHidden, err := chatSvc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   unrelatedHiddenID,
		SenderID:    requesterID,
		ClientMsgID: uuid.NewString(),
		Body:        "needle unrelated hidden message",
	})
	require.NoError(t, err)
	setMessageCreatedAt(t, ctx, pool, unrelatedHidden.MessageID, baseTime.Add(4*time.Minute))

	task := seedTask(t, ctx, tasksSvc, requesterID, "Needle task")
	comment, err := tasksSvc.CreateComment(ctx, task.ID, requesterID, "needle task comment")
	require.NoError(t, err)
	setCommentCreatedAt(t, ctx, pool, comment.ID, baseTime.Add(5*time.Minute))
	commentThread, err := tasksSvc.EnsureCommentThread(ctx, task.ID, comment.ID, requesterID)
	require.NoError(t, err)
	taskThreadReply, err := chatSvc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:           commentThread.ConversationID,
		SenderID:            requesterID,
		ClientMsgID:         uuid.NewString(),
		Body:                "needle task thread reply",
		ThreadRootMessageID: commentThread.ThreadRootMessageID,
	})
	require.NoError(t, err)
	setMessageCreatedAt(t, ctx, pool, taskThreadReply.MessageID, baseTime.Add(6*time.Minute))

	results, err := searchSvc.SearchMessages(ctx, requesterID, "needle", nil, 20)
	require.NoError(t, err)

	require.Len(t, results, 4)
	assert.Equal(t, search.MessageSourceTaskCommentThread, results[0].Source)
	assert.Equal(t, taskThreadReply.MessageID.String(), results[0].MessageID)
	assert.Equal(t, commentThread.ThreadRootMessageID.String(), results[0].ThreadRootMessageID)
	assert.Equal(t, task.PublicID, results[0].TaskPublicID)

	sourcesByBody := map[string]search.MessageResult{}
	for _, item := range results {
		sourcesByBody[item.Body] = item
		assert.NotEqual(t, outsiderMessage.MessageID.String(), item.MessageID)
		assert.NotEqual(t, unrelatedHidden.MessageID.String(), item.MessageID)
	}
	assert.Equal(t, search.MessageSourceChatMessage, sourcesByBody["needle visible root"].Source)
	assert.Equal(t, search.MessageSourceChatMessage, sourcesByBody["needle visible thread reply"].Source)
	assert.Equal(t, search.MessageSourceTaskComment, sourcesByBody["needle task comment"].Source)
	assert.Equal(t, "", sourcesByBody["needle task comment"].MessageID)
	assert.Equal(t, commentThread.ThreadRootMessageID.String(), sourcesByBody["needle task comment"].ThreadRootMessageID)
	assert.Equal(t, search.MessageSourceTaskCommentThread, sourcesByBody["needle task thread reply"].Source)
}

func TestIntegration_SearchMessages_ScopedConversationAndValidation(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	store := events.NewStore(pool)
	chatSvc := chat.NewService(pool, store)
	searchSvc := search.NewService(pool)

	requesterID := seedUser(t, ctx, pool, "Scoped Requester")
	outsiderID := seedUser(t, ctx, pool, "Scoped Outsider")
	channelID := seedChannel(t, ctx, pool, requesterID, "scoped-visible", false, requesterID)
	outsiderChannelID := seedChannel(t, ctx, pool, outsiderID, "scoped-outsider", false, outsiderID)

	root, err := chatSvc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    requesterID,
		ClientMsgID: uuid.NewString(),
		Body:        "needle scoped root",
	})
	require.NoError(t, err)
	setMessageCreatedAt(t, ctx, pool, root.MessageID, time.Date(2026, 5, 12, 11, 0, 0, 0, time.UTC))
	reply, err := chatSvc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:           channelID,
		SenderID:            requesterID,
		ClientMsgID:         uuid.NewString(),
		Body:                "needle scoped thread reply",
		ThreadRootMessageID: root.MessageID,
	})
	require.NoError(t, err)
	setMessageCreatedAt(t, ctx, pool, reply.MessageID, time.Date(2026, 5, 12, 11, 1, 0, 0, time.UTC))
	_, err = chatSvc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   outsiderChannelID,
		SenderID:    outsiderID,
		ClientMsgID: uuid.NewString(),
		Body:        "needle should stay hidden",
	})
	require.NoError(t, err)

	results, err := searchSvc.SearchMessages(ctx, requesterID, "needle", &channelID, 20)
	require.NoError(t, err)
	require.Len(t, results, 2)
	assert.Equal(t, []string{reply.MessageID.String(), root.MessageID.String()}, []string{
		results[0].MessageID,
		results[1].MessageID,
	})
	for _, item := range results {
		assert.Equal(t, search.MessageSourceChatMessage, item.Source)
		assert.Equal(t, channelID.String(), item.ConversationID)
	}

	_, err = searchSvc.SearchMessages(ctx, requesterID, "needle", &outsiderChannelID, 20)
	assert.True(t, errors.Is(err, search.ErrNotMember))

	_, err = searchSvc.SearchMessages(ctx, requesterID, "n", nil, 20)
	assert.True(t, errors.Is(err, search.ErrQueryTooShort))

	for i := 0; i < 55; i++ {
		_, err := chatSvc.SendMessage(ctx, chat.SendMessageParams{
			ChannelID:   channelID,
			SenderID:    requesterID,
			ClientMsgID: uuid.NewString(),
			Body:        fmt.Sprintf("clampneedle %02d", i),
		})
		require.NoError(t, err)
	}
	results, err = searchSvc.SearchMessages(ctx, requesterID, "clampneedle", nil, 100)
	require.NoError(t, err)
	assert.Len(t, results, 50)
}
