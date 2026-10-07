//go:build integration

package botapi_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"

	"msgnr/internal/botapi"
	"msgnr/internal/chat"
	"msgnr/internal/config"
	"msgnr/internal/documents"
	"msgnr/internal/events"
	"msgnr/internal/integrations"
	"msgnr/internal/search"
	"msgnr/internal/tasks"
	"msgnr/internal/testdb"
)

// hashToken mirrors integrations.hashToken (SHA-256 hex, same scheme as
// auth.HashRefreshToken).
func hashToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

type botTestEnv struct {
	ts          *httptest.Server
	pool        *pgxpool.Pool
	chat        *chat.Service
	tasks       *tasks.Service
	documents   *documents.Service
	attachments *botAttachmentStore
	botID       uuid.UUID
	token       string
}

// newBotEnv provisions a bot user with an active integration token and a full
// botapi stack behind an httptest server. Rate limits are wide open here; the
// limiter itself is covered by unit tests.
func newBotEnv(t *testing.T) *botTestEnv {
	t.Helper()
	pool, _ := testdb.New(t)
	ctx := context.Background()

	log := zap.NewNop()
	store := events.NewStore(pool)
	bus := events.NewBus(log)
	chatSvc := chat.NewService(pool, store)
	attachmentStore := newBotAttachmentStore()
	chatSvc.ConfigureAttachments(attachmentStore, 50)
	tasksSvc := tasks.NewService(pool, attachmentStore)
	documentsSvc := documents.NewService(pool, attachmentStore)
	searchSvc := search.NewService(pool)
	integrationsSvc := integrations.NewService(pool, tasksSvc, documentsSvc, log)

	cfg := &config.Config{
		BotAPIEnabled:            true,
		BotAPIMaxWaitSeconds:     30,
		BotAPIEventsMaxLimit:     500,
		BotAPIRateLimitRPS:       10000,
		BotAPIRateLimitBurst:     100000,
		BotAPIMaxConcurrentPolls: 2,
	}
	svc := botapi.NewService(pool, store, bus, chatSvc, tasksSvc, documentsSvc, searchSvc, integrationsSvc, cfg, log)
	handler := botapi.NewHandler(svc, log)

	mux := http.NewServeMux()
	handler.RegisterRoutes(mux)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)

	var botID uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', $2, 'bot') RETURNING id`,
		"botapi_bot_"+uuid.NewString()+"@example.com", "Helpful Bot",
	).Scan(&botID)
	require.NoError(t, err)

	token := "bot-token-" + uuid.NewString()
	_, err = pool.Exec(ctx,
		`INSERT INTO integration_token (user_id, token_hash) VALUES ($1, $2)`,
		botID, hashToken(token),
	)
	require.NoError(t, err)

	return &botTestEnv{
		ts:          ts,
		pool:        pool,
		chat:        chatSvc,
		tasks:       tasksSvc,
		documents:   documentsSvc,
		attachments: attachmentStore,
		botID:       botID,
		token:       token,
	}
}

func (e *botTestEnv) seedHuman(t *testing.T, displayName string) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	var id uuid.UUID
	err := e.pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', $2, 'member') RETURNING id`,
		"botapi_human_"+uuid.NewString()+"@example.com", displayName,
	).Scan(&id)
	require.NoError(t, err)
	return id
}

func (e *botTestEnv) seedPublicChannel(t *testing.T, creator uuid.UUID, name string) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	var id uuid.UUID
	err := e.pool.QueryRow(ctx,
		`INSERT INTO channels (kind, visibility, name, created_by)
		 VALUES ('channel', 'public', $1, $2) RETURNING id`,
		name, creator,
	).Scan(&id)
	require.NoError(t, err)
	return id
}

func (e *botTestEnv) addMember(t *testing.T, channelID, userID uuid.UUID) {
	t.Helper()
	_, err := e.pool.Exec(context.Background(),
		`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`,
		channelID, userID)
	require.NoError(t, err)
}

func (e *botTestEnv) do(t *testing.T, method, path, token string, body any) (int, map[string]any) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		require.NoError(t, err)
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, e.ts.URL+path, reader)
	require.NoError(t, err)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	var out map[string]any
	if len(raw) > 0 {
		require.NoError(t, json.Unmarshal(raw, &out), "body: %s", raw)
	}
	return resp.StatusCode, out
}

func eventsOf(body map[string]any) []map[string]any {
	raw, _ := body["events"].([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		if m, ok := item.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

func TestIntegration_BotAPI_Auth(t *testing.T) {
	env := newBotEnv(t)

	status, body := env.do(t, http.MethodGet, "/api/bot/v1/me", "", nil)
	assert.Equal(t, http.StatusUnauthorized, status)
	assert.Equal(t, "missing token", body["error"])

	status, body = env.do(t, http.MethodGet, "/api/bot/v1/me", "wrong-token", nil)
	assert.Equal(t, http.StatusUnauthorized, status)
	assert.Equal(t, "invalid token", body["error"])

	status, body = env.do(t, http.MethodGet, "/api/bot/v1/me", env.token, nil)
	require.Equal(t, http.StatusOK, status)
	assert.Equal(t, env.botID.String(), body["user_id"])
	assert.Equal(t, "Helpful Bot", body["display_name"])
	assert.Equal(t, "bot", body["role"])
}

func TestIntegration_BotAPI_ChannelsDiscoverAndJoin(t *testing.T) {
	env := newBotEnv(t)
	human := env.seedHuman(t, "Channel Owner")
	channelID := env.seedPublicChannel(t, human, "bot-lounge")
	env.addMember(t, channelID, human)
	otherID := env.seedPublicChannel(t, human, "bot-lounge-2")
	env.addMember(t, otherID, env.botID) // already a member → not discoverable

	status, body := env.do(t, http.MethodGet, "/api/bot/v1/channels", env.token, nil)
	require.Equal(t, http.StatusOK, status)
	channels := body["channels"].([]any)
	require.Len(t, channels, 1)
	got := channels[0].(map[string]any)
	assert.Equal(t, channelID.String(), got["id"])
	assert.Equal(t, "bot-lounge", got["name"])

	// Join requires 1..100 ids.
	status, _ = env.do(t, http.MethodPost, "/api/bot/v1/channels/join", env.token, map[string]any{"channel_ids": []string{}})
	assert.Equal(t, http.StatusBadRequest, status)
	status, _ = env.do(t, http.MethodPost, "/api/bot/v1/channels/join", env.token, map[string]any{"channel_ids": []string{"not-a-uuid"}})
	assert.Equal(t, http.StatusBadRequest, status)

	status, body = env.do(t, http.MethodPost, "/api/bot/v1/channels/join", env.token, map[string]any{
		"channel_ids": []string{channelID.String()},
	})
	require.Equal(t, http.StatusOK, status)
	joined := body["joined"].([]any)
	require.Len(t, joined, 1)
	assert.Equal(t, channelID.String(), joined[0].(map[string]any)["id"])

	// After joining, the channel shows up in conversations and no longer in discovery.
	status, body = env.do(t, http.MethodGet, "/api/bot/v1/channels", env.token, nil)
	require.Equal(t, http.StatusOK, status)
	assert.Empty(t, body["channels"])

	status, body = env.do(t, http.MethodGet, "/api/bot/v1/conversations", env.token, nil)
	require.Equal(t, http.StatusOK, status)
	conversations := body["conversations"].([]any)
	require.Len(t, conversations, 2)
	byID := map[string]map[string]any{}
	for _, c := range conversations {
		m := c.(map[string]any)
		byID[m["id"].(string)] = m
	}
	assert.Equal(t, "bot-lounge", byID[channelID.String()]["name"])
	assert.Equal(t, float64(2), byID[channelID.String()]["member_count"])
}

func TestIntegration_BotAPI_EventsMembershipPagingAndGap(t *testing.T) {
	env := newBotEnv(t)
	ctx := context.Background()
	human := env.seedHuman(t, "Event Human")

	memberChannel := env.seedPublicChannel(t, human, "events-member")
	hiddenChannel := env.seedPublicChannel(t, human, "events-foreign")
	env.addMember(t, memberChannel, human)
	env.addMember(t, memberChannel, env.botID)
	env.addMember(t, hiddenChannel, human)

	for _, body := range []string{"member hello", "foreign hello", "member again"} {
		channel := memberChannel
		if strings.Contains(body, "foreign") {
			channel = hiddenChannel
		}
		_, err := env.chat.SendMessage(ctx, chat.SendMessageParams{
			ChannelID:   channel,
			SenderID:    human,
			ClientMsgID: "evt-" + uuid.NewString(),
			Body:        body,
		})
		require.NoError(t, err)
	}

	status, body := env.do(t, http.MethodGet, "/api/bot/v1/events?wait_seconds=0", env.token, nil)
	require.Equal(t, http.StatusOK, status)
	admitted := eventsOf(body)
	require.Len(t, admitted, 2, "only member-channel message_created events")
	for _, evt := range admitted {
		assert.Equal(t, "message_created", evt["event_type"])
		assert.Equal(t, memberChannel.String(), evt["conversation_id"])
	}
	hasMore, _ := body["has_more"].(bool)
	assert.False(t, hasMore)

	// Paging with limit=1 walks admitted events exactly once.
	var seenSeqs []float64
	cursor := 0.0
	for {
		status, body = env.do(t, http.MethodGet, fmt.Sprintf("/api/bot/v1/events?after_seq=%d&limit=1&wait_seconds=0", int64(cursor)), env.token, nil)
		require.Equal(t, http.StatusOK, status)
		page := eventsOf(body)
		if len(page) == 0 {
			break
		}
		for _, evt := range page {
			seenSeqs = append(seenSeqs, evt["event_seq"].(float64))
		}
		next, _ := body["next_cursor"].(float64)
		require.Greater(t, next, cursor, "cursor must advance")
		cursor = next
		if more, _ := body["has_more"].(bool); !more {
			// One more poll must be empty and not re-deliver.
			status, body = env.do(t, http.MethodGet, fmt.Sprintf("/api/bot/v1/events?after_seq=%d&limit=1&wait_seconds=0", int64(cursor)), env.token, nil)
			require.Equal(t, http.StatusOK, status)
			assert.Empty(t, eventsOf(body))
			break
		}
	}
	assert.Equal(t, 2, len(seenSeqs), "each admitted event exactly once across pages")
	assert.Equal(t, float64(cursor), body["next_cursor"], "caught-up cursor stays put")

	// Fully caught up with wait_seconds=0: empty, cursor unchanged.
	status, body = env.do(t, http.MethodGet, fmt.Sprintf("/api/bot/v1/events?after_seq=%d&wait_seconds=0", int64(cursor)), env.token, nil)
	require.Equal(t, http.StatusOK, status)
	assert.Empty(t, eventsOf(body))
	assert.Equal(t, float64(cursor), body["next_cursor"])

	// Gap beyond retention: prune everything, append fresh events, then poll
	// with a cursor one behind the old tail (a bot offline during the prune;
	// floor = old latest + 1 > stale cursor + 1). Use a wait window so the
	// test proves the gap response is returned immediately (a parked poll
	// would come back after the deadline with gap=false).
	_, err := env.pool.Exec(ctx, `DELETE FROM workspace_events`)
	require.NoError(t, err)
	for _, bodyText := range []string{"post-prune one", "post-prune two"} {
		_, err = env.chat.SendMessage(ctx, chat.SendMessageParams{
			ChannelID:   memberChannel,
			SenderID:    human,
			ClientMsgID: "evt-" + strings.ReplaceAll(bodyText, " ", "-"),
			Body:        bodyText,
		})
		require.NoError(t, err)
	}

	stale := cursor - 1
	start := time.Now()
	status, body = env.do(t, http.MethodGet, fmt.Sprintf("/api/bot/v1/events?after_seq=%d&wait_seconds=10", int64(stale)), env.token, nil)
	require.Equal(t, http.StatusOK, status)
	assert.Equal(t, true, body["gap_beyond_retention"])
	assert.Empty(t, eventsOf(body))
	assert.Less(t, time.Since(start), 8*time.Second, "gap response must not wait out the poll window")
}

func TestIntegration_BotAPI_SendMessageFlow(t *testing.T) {
	env := newBotEnv(t)
	ctx := context.Background()
	human := env.seedHuman(t, "Msg Human")
	channel := env.seedPublicChannel(t, human, "bot-send")
	env.addMember(t, channel, human)
	env.addMember(t, channel, env.botID)

	req := map[string]any{
		"conversation_id": channel.String(),
		"body":            "bot says hi",
		"client_msg_id":   "bot-evt-1",
	}
	status, body := env.do(t, http.MethodPost, "/api/bot/v1/messages", env.token, req)
	require.Equal(t, http.StatusOK, status)
	assert.NotEmpty(t, body["message_id"])
	assert.Equal(t, false, body["deduped"])
	messageID := body["message_id"].(string)

	// The message lands as a row and as a message_created event.
	var rowCount int
	err := env.pool.QueryRow(ctx, `SELECT COUNT(*) FROM messages WHERE id = $1`, messageID).Scan(&rowCount)
	require.NoError(t, err)
	assert.Equal(t, 1, rowCount)

	status, body = env.do(t, http.MethodGet, "/api/bot/v1/events?wait_seconds=0", env.token, nil)
	require.Equal(t, http.StatusOK, status)
	foundEvent := false
	for _, evt := range eventsOf(body) {
		if evt["event_type"] == "message_created" {
			payload := evt["payload"].(map[string]any)
			if payload["messageId"] == messageID {
				foundEvent = true
				assert.Equal(t, env.botID.String(), payload["senderId"])
				assert.Equal(t, "bot says hi", payload["body"])
			}
		}
	}
	assert.True(t, foundEvent, "bot's message appears in its own stream")

	// Idempotent replay.
	status, body = env.do(t, http.MethodPost, "/api/bot/v1/messages", env.token, req)
	require.Equal(t, http.StatusOK, status)
	assert.Equal(t, true, body["deduped"])
	assert.Equal(t, messageID, body["message_id"])

	// Validation failures.
	status, _ = env.do(t, http.MethodPost, "/api/bot/v1/messages", env.token, map[string]any{
		"conversation_id": channel.String(), "body": "x", "client_msg_id": "bad id with spaces",
	})
	assert.Equal(t, http.StatusBadRequest, status)
	status, _ = env.do(t, http.MethodPost, "/api/bot/v1/messages", env.token, map[string]any{
		"conversation_id": channel.String(), "body": "   ", "client_msg_id": "bot-evt-2",
	})
	assert.Equal(t, http.StatusBadRequest, status)
	status, _ = env.do(t, http.MethodPost, "/api/bot/v1/messages", env.token, map[string]any{
		"conversation_id": "not-a-uuid", "body": "x", "client_msg_id": "bot-evt-3",
	})
	assert.Equal(t, http.StatusBadRequest, status)
	status, _ = env.do(t, http.MethodPost, "/api/bot/v1/messages", env.token, map[string]any{
		"conversation_id": channel.String(), "body": "x", "client_msg_id": "bot-evt-4",
		"entities": []map[string]any{{"kind": "channel", "target_id": human.String(), "label": "@x"}},
	})
	assert.Equal(t, http.StatusBadRequest, status, "invalid entity kind")

	// Non-member write is forbidden.
	foreign := env.seedPublicChannel(t, human, "bot-send-foreign")
	env.addMember(t, foreign, human)
	status, body = env.do(t, http.MethodPost, "/api/bot/v1/messages", env.token, map[string]any{
		"conversation_id": foreign.String(), "body": "sneak", "client_msg_id": "bot-evt-5",
	})
	assert.Equal(t, http.StatusForbidden, status)
	assert.Equal(t, "not a channel member", body["error"])

	// Thread reply: human root, bot reply, replay via GET /messages.
	root, err := env.chat.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channel,
		SenderID:    human,
		ClientMsgID: "root-" + uuid.NewString(),
		Body:        "root msg",
	})
	require.NoError(t, err)
	status, body = env.do(t, http.MethodPost, "/api/bot/v1/messages", env.token, map[string]any{
		"conversation_id":        channel.String(),
		"body":                   "threaded beep",
		"client_msg_id":          "bot-evt-6",
		"thread_root_message_id": root.MessageID.String(),
	})
	require.Equal(t, http.StatusOK, status)

	status, body = env.do(t, http.MethodGet,
		fmt.Sprintf("/api/bot/v1/messages?conversation_id=%s&thread_root_message_id=%s", channel, root.MessageID), env.token, nil)
	require.Equal(t, http.StatusOK, status)
	assert.Equal(t, float64(1), body["current_thread_seq"])
	assert.Equal(t, float64(1), body["reply_count"])
	messages := body["messages"].([]any)
	require.Len(t, messages, 1)
	reply := messages[0].(map[string]any)
	assert.Equal(t, "threaded beep", reply["body"])
	assert.Equal(t, "Helpful Bot", reply["sender_name"])
	assert.Equal(t, root.MessageID.String(), reply["thread_root_message_id"])

	// Channel history contains the two roots, not the thread reply. Page one
	// root at a time so this fixture actually exercises a continuation.
	status, body = env.do(t, http.MethodGet,
		fmt.Sprintf("/api/bot/v1/messages?conversation_id=%s&limit=1", channel), env.token, nil)
	require.Equal(t, http.StatusOK, status)
	assert.Equal(t, true, body["has_more"])
	require.NotNil(t, body["next_before_channel_seq"])
	page := body["messages"].([]any)
	require.Len(t, page, 1)
	assert.Equal(t, root.MessageID.String(), page[0].(map[string]any)["id"])
	before := int64(body["next_before_channel_seq"].(float64))
	status, body = env.do(t, http.MethodGet,
		fmt.Sprintf("/api/bot/v1/messages?conversation_id=%s&limit=1&before_channel_seq=%d", channel, before), env.token, nil)
	require.Equal(t, http.StatusOK, status)
	page = body["messages"].([]any)
	require.Len(t, page, 1)
	assert.Equal(t, messageID, page[0].(map[string]any)["id"])
	assert.Equal(t, false, body["has_more"])
	assert.Nil(t, body["next_before_channel_seq"])

	// Thread replay of an unknown root.
	status, _ = env.do(t, http.MethodGet,
		fmt.Sprintf("/api/bot/v1/messages?conversation_id=%s&thread_root_message_id=%s", channel, uuid.New()), env.token, nil)
	assert.Equal(t, http.StatusNotFound, status)

	// Reading a channel the bot is not in: 403.
	status, _ = env.do(t, http.MethodGet, fmt.Sprintf("/api/bot/v1/messages?conversation_id=%s", foreign), env.token, nil)
	assert.Equal(t, http.StatusForbidden, status)
}

func TestIntegration_BotAPI_TaskCommentsAndConversationTask(t *testing.T) {
	env := newBotEnv(t)
	ctx := context.Background()
	human := env.seedHuman(t, "Task Human")

	tpl, err := env.tasks.CreateTemplate(ctx, tasks.CreateTemplateParams{Prefix: "BTC", SortOrder: 1, ActorID: human})
	require.NoError(t, err)
	status, err := env.tasks.CreateStatus(ctx, tasks.CreateStatusParams{Code: "botapi_open", Name: "Open", SortOrder: 1, ActorID: human})
	require.NoError(t, err)
	task, err := env.tasks.CreateTask(ctx, tasks.CreateTaskParams{TemplateID: tpl.ID, Title: "bot task", StatusID: status.ID, ActorID: human})
	require.NoError(t, err)

	// Task context mirrors the integrations endpoint shape.
	statusResp, body := env.do(t, http.MethodGet, "/api/bot/v1/tasks/"+task.PublicID, env.token, nil)
	require.Equal(t, http.StatusOK, statusResp)
	assert.Equal(t, task.PublicID, body["public_id"])
	assert.Equal(t, "bot task", body["title"])

	statusResp, _ = env.do(t, http.MethodGet, "/api/bot/v1/tasks/NOPE-1", env.token, nil)
	assert.Equal(t, http.StatusNotFound, statusResp)

	// Bot authors a comment; the event and listing must show it.
	statusResp, body = env.do(t, http.MethodPost, "/api/bot/v1/tasks/"+task.PublicID+"/comments", env.token, map[string]any{
		"body": "bot analysis here",
	})
	require.Equal(t, http.StatusCreated, statusResp)
	assert.Equal(t, "bot analysis here", body["body"])
	assert.Equal(t, "Helpful Bot", body["author_name"])
	assert.Equal(t, env.botID.String(), body["author_id"])

	statusResp, body = env.do(t, http.MethodGet, "/api/bot/v1/tasks/"+task.PublicID+"/comments", env.token, nil)
	require.Equal(t, http.StatusOK, statusResp)
	comments := body["comments"].([]any)
	require.Len(t, comments, 1)
	assert.Equal(t, "Helpful Bot", comments[0].(map[string]any)["author_name"])

	statusResp, body = env.do(t, http.MethodGet, "/api/bot/v1/events?wait_seconds=0", env.token, nil)
	require.Equal(t, http.StatusOK, statusResp)
	var commentEvent map[string]any
	for _, evt := range eventsOf(body) {
		if evt["event_type"] == "task_comment_created" {
			commentEvent = evt
		}
	}
	require.NotNil(t, commentEvent, "task_comment_created reaches the bot stream")
	payload := commentEvent["payload"].(map[string]any)
	assert.Equal(t, task.PublicID, payload["publicId"])
	assert.Equal(t, "bot analysis here", payload["body"])

	// Human opens the discussion thread → bot is a member and can resolve the task.
	humanComment, err := env.tasks.CreateComment(ctx, task.ID, human, "human opens thread")
	require.NoError(t, err)
	thread, err := env.tasks.EnsureCommentThread(ctx, task.ID, humanComment.ID, human)
	require.NoError(t, err)

	var botMember bool
	err = env.pool.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2 AND is_archived = false)`,
		thread.ConversationID, env.botID).Scan(&botMember)
	require.NoError(t, err)
	assert.True(t, botMember, "EnsureCommentThread adds the bot to the discussion channel")

	statusResp, body = env.do(t, http.MethodGet, "/api/bot/v1/conversations/"+thread.ConversationID.String()+"/task", env.token, nil)
	require.Equal(t, http.StatusOK, statusResp)
	assert.Equal(t, task.ID.String(), body["task_id"])
	assert.Equal(t, task.PublicID, body["public_id"])

	statusResp, _ = env.do(t, http.MethodGet, "/api/bot/v1/conversations/"+uuid.NewString()+"/task", env.token, nil)
	assert.Equal(t, http.StatusNotFound, statusResp)

	// Discussion channel visible in /conversations (hidden: true) and members readable.
	statusResp, body = env.do(t, http.MethodGet, "/api/bot/v1/conversations", env.token, nil)
	require.Equal(t, http.StatusOK, statusResp)
	foundHidden := false
	for _, c := range body["conversations"].([]any) {
		m := c.(map[string]any)
		if m["id"] == thread.ConversationID.String() {
			foundHidden = true
			assert.Equal(t, true, m["hidden"])
		}
	}
	assert.True(t, foundHidden, "hidden discussion channel listed")

	statusResp, body = env.do(t, http.MethodGet, "/api/bot/v1/conversations/"+thread.ConversationID.String()+"/members", env.token, nil)
	require.Equal(t, http.StatusOK, statusResp)
	assert.NotEmpty(t, body["members"])

	// Members of a channel the bot is not in are indistinguishable from missing.
	foreign := env.seedPublicChannel(t, human, "bot-task-foreign")
	env.addMember(t, foreign, human)
	statusResp, _ = env.do(t, http.MethodGet, "/api/bot/v1/conversations/"+foreign.String()+"/members", env.token, nil)
	assert.Equal(t, http.StatusForbidden, statusResp)

	// A task discussion channel must also disappear from the resolver after
	// the bot loses membership, even though the task still exists.
	_, err = env.pool.Exec(ctx,
		`UPDATE channel_members SET is_archived = true WHERE channel_id = $1 AND user_id = $2`,
		thread.ConversationID, env.botID)
	require.NoError(t, err)
	statusResp, _ = env.do(t, http.MethodGet, "/api/bot/v1/conversations/"+thread.ConversationID.String()+"/task", env.token, nil)
	assert.Equal(t, http.StatusNotFound, statusResp)
}

func TestIntegration_BotAPI_SearchAndDocuments(t *testing.T) {
	env := newBotEnv(t)
	ctx := context.Background()
	human := env.seedHuman(t, "Search Human")

	channel := env.seedPublicChannel(t, human, "bot-search")
	env.addMember(t, channel, human)
	env.addMember(t, channel, env.botID)
	_, err := env.chat.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channel,
		SenderID:    human,
		ClientMsgID: "search-" + uuid.NewString(),
		Body:        "unique zebra fact",
	})
	require.NoError(t, err)

	// Message search: member channel only.
	foreign := env.seedPublicChannel(t, human, "bot-search-foreign")
	env.addMember(t, foreign, human)
	_, err = env.chat.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   foreign,
		SenderID:    human,
		ClientMsgID: "search-" + uuid.NewString(),
		Body:        "secret zebra fact",
	})
	require.NoError(t, err)

	status, body := env.do(t, http.MethodGet, "/api/bot/v1/search/messages?q=zebra", env.token, nil)
	require.Equal(t, http.StatusOK, status)
	results := body["results"].([]any)
	require.Len(t, results, 1, "foreign-channel messages must not leak")
	res := results[0].(map[string]any)
	assert.Equal(t, "chat_message", res["source"])
	assert.Equal(t, channel.String(), res["conversation_id"])

	status, _ = env.do(t, http.MethodGet, "/api/bot/v1/search/messages?q=z", env.token, nil)
	assert.Equal(t, http.StatusBadRequest, status)

	// Documents: bot is member of one teamspace only.
	var teamspaceID, otherTeamspaceID uuid.UUID
	err = env.pool.QueryRow(ctx,
		`INSERT INTO teamspace (name, owner_user_id) VALUES ('Bot Space', $1) RETURNING id`, human).Scan(&teamspaceID)
	require.NoError(t, err)
	err = env.pool.QueryRow(ctx,
		`INSERT INTO teamspace (name, owner_user_id) VALUES ('Other Space', $1) RETURNING id`, human).Scan(&otherTeamspaceID)
	require.NoError(t, err)
	_, err = env.pool.Exec(ctx, `INSERT INTO teamspace_member (teamspace_id, user_id) VALUES ($1, $2)`, teamspaceID, env.botID)
	require.NoError(t, err)
	_, err = env.pool.Exec(ctx, `INSERT INTO teamspace_member (teamspace_id, user_id) VALUES ($1, $2)`, teamspaceID, human)
	require.NoError(t, err)
	_, err = env.pool.Exec(ctx, `INSERT INTO teamspace_member (teamspace_id, user_id) VALUES ($1, $2)`, otherTeamspaceID, human)
	require.NoError(t, err)

	documentsSvc := documents.NewService(env.pool, nil)
	visible, err := documentsSvc.CreateDocument(ctx, documents.CreateDocumentParams{TeamspaceID: teamspaceID, Title: "Zebra Handbook", ActorID: human})
	require.NoError(t, err)
	hiddenDoc, err := documentsSvc.CreateDocument(ctx, documents.CreateDocumentParams{TeamspaceID: otherTeamspaceID, Title: "Hidden Zebra Notes", ActorID: human})
	require.NoError(t, err)

	status, body = env.do(t, http.MethodGet, "/api/bot/v1/search/documents?q=Zebra", env.token, nil)
	require.Equal(t, http.StatusOK, status)
	results = body["results"].([]any)
	require.Len(t, results, 1)
	assert.Equal(t, "Zebra Handbook", results[0].(map[string]any)["title"])

	status, _ = env.do(t, http.MethodGet, "/api/bot/v1/search/documents?q=%20%20", env.token, nil)
	assert.Equal(t, http.StatusBadRequest, status)

	status, body = env.do(t, http.MethodGet, "/api/bot/v1/documents/"+visible.ID.String(), env.token, nil)
	require.Equal(t, http.StatusOK, status)
	assert.Equal(t, "Zebra Handbook", body["title"])
	assert.Equal(t, teamspaceID.String(), body["teamspace_id"])
	assert.Nil(t, body["parent_id"])

	status, body = env.do(t, http.MethodGet, "/api/bot/v1/documents/"+hiddenDoc.ID.String(), env.token, nil)
	assert.Equal(t, http.StatusForbidden, status)

	status, _ = env.do(t, http.MethodGet, "/api/bot/v1/documents/not-a-uuid", env.token, nil)
	assert.Equal(t, http.StatusBadRequest, status)
}
