//go:build integration

package chat_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"msgnr/internal/chat"
	"msgnr/internal/events"
	"msgnr/internal/testdb"
)

func TestIntegration_ListReactionUsers_OrderedNewestFirst(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	user1, channelID := seedUserAndChannel(t, ctx, pool)

	var user2 uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'Second User', 'member')
		 RETURNING id`,
		"testuser_"+uuid.New().String()+"@example.com",
	).Scan(&user2)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`, channelID, user2)
	require.NoError(t, err)

	msg, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    user1,
		ClientMsgID: uuid.New().String(),
		Body:        "with reactions",
	})
	require.NoError(t, err)

	_, err = svc.AddReaction(ctx, chat.ReactionParams{
		ChannelID:  channelID,
		MessageID:  msg.MessageID,
		UserID:     user1,
		Emoji:      "👍",
		ClientOpID: uuid.New().String(),
	})
	require.NoError(t, err)

	time.Sleep(2 * time.Millisecond)

	_, err = svc.AddReaction(ctx, chat.ReactionParams{
		ChannelID:  channelID,
		MessageID:  msg.MessageID,
		UserID:     user2,
		Emoji:      "👍",
		ClientOpID: uuid.New().String(),
	})
	require.NoError(t, err)

	users, err := svc.ListReactionUsers(ctx, user1, channelID, msg.MessageID, "👍")
	require.NoError(t, err)
	require.Len(t, users, 2)
	assert.Equal(t, user2, users[0].UserID)
	assert.Equal(t, user1, users[1].UserID)
	assert.Equal(t, "Second User", users[0].DisplayName)

	empty, err := svc.ListReactionUsers(ctx, user1, channelID, msg.MessageID, "🎉")
	require.NoError(t, err)
	assert.Len(t, empty, 0)
}

func TestIntegration_ListReactionUsers_NotMember(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	ownerID, channelID := seedUserAndChannel(t, ctx, pool)
	msg, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    ownerID,
		ClientMsgID: uuid.New().String(),
		Body:        "hello",
	})
	require.NoError(t, err)

	var outsiderID uuid.UUID
	err = pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'Outsider', 'member')
		 RETURNING id`,
		"testuser_"+uuid.New().String()+"@example.com",
	).Scan(&outsiderID)
	require.NoError(t, err)

	_, err = svc.ListReactionUsers(ctx, outsiderID, channelID, msg.MessageID, "👍")
	require.Error(t, err)
	assert.True(t, errors.Is(err, chat.ErrNotMember))
}

func TestIntegration_ListReactionUsers_MessageNotInConversation(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	userID, sourceChannelID := seedUserAndChannel(t, ctx, pool)
	targetChannelID := seedChannelForUser(t, ctx, pool, userID, "target")

	msg, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   sourceChannelID,
		SenderID:    userID,
		ClientMsgID: uuid.New().String(),
		Body:        "wrong conversation",
	})
	require.NoError(t, err)

	_, err = svc.ListReactionUsers(ctx, userID, targetChannelID, msg.MessageID, "👍")
	require.Error(t, err)
	assert.True(t, errors.Is(err, chat.ErrMessageNotFound))
}
