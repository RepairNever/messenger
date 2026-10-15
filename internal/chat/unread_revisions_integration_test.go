//go:build integration

package chat_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"msgnr/internal/chat"
	"msgnr/internal/events"
	packetspb "msgnr/internal/gen/proto"
	"msgnr/internal/testdb"
)

func unreadCounterForUser(t *testing.T, deliveries []chat.DirectDelivery, userID uuid.UUID) *packetspb.UnreadCounter {
	t.Helper()
	for _, delivery := range deliveries {
		if delivery.UserID == userID.String() && delivery.Event.GetReadCounterUpdated() != nil {
			return delivery.Event.GetReadCounterUpdated().GetCounter()
		}
	}
	t.Fatal("missing unread counter for user", userID)
	return nil
}

func TestIntegration_UnreadCounterRevisions_CoverMutationsAndZeroSnapshots(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := chat.NewService(pool, events.NewStore(pool))
	reader := seedChatUserWithAttrs(t, ctx, pool, "Reader", "member", "active")
	sender := seedChatUserWithAttrs(t, ctx, pool, "Sender", "member", "active")
	dm, err := svc.CreateOrOpenDirectMessage(ctx, reader, sender)
	require.NoError(t, err)
	channelID := dm.DM.ConversationID
	var previousRevision int64
	check := func(counter *packetspb.UnreadCounter, unread int32, lastRead, lastMessage, lastRoot int64) {
		t.Helper()
		require.Greater(t, counter.GetRevision(), previousRevision)
		previousRevision = counter.GetRevision()
		assert.Equal(t, unread, counter.GetUnreadMessages())
		assert.Equal(t, lastRead, counter.GetLastReadSeq())
		assert.Equal(t, lastMessage, counter.GetLastMessageSeq())
		assert.Equal(t, lastRoot, counter.GetLastRootMessageSeq())
	}

	empty, err := svc.UpdateReadCursor(ctx, chat.UpdateReadCursorParams{ChannelID: channelID, UserID: reader})
	require.NoError(t, err)
	check(empty.Counter, 0, 0, 0, 0)
	root, err := svc.SendMessage(ctx, chat.SendMessageParams{ChannelID: channelID, SenderID: sender, ClientMsgID: uuid.NewString(), Body: "root"})
	require.NoError(t, err)
	check(unreadCounterForUser(t, root.DirectDeliveries, reader), 1, 0, root.ChannelSeq, root.ChannelSeq)
	read, err := svc.UpdateReadCursor(ctx, chat.UpdateReadCursorParams{ChannelID: channelID, UserID: reader, LastReadSeq: root.ChannelSeq})
	require.NoError(t, err)
	check(read.Counter, 0, root.ChannelSeq, root.ChannelSeq, root.ChannelSeq)
	reply, err := svc.SendMessage(ctx, chat.SendMessageParams{ChannelID: channelID, SenderID: sender, ClientMsgID: uuid.NewString(), Body: "reply", ThreadRootMessageID: root.MessageID})
	require.NoError(t, err)
	check(unreadCounterForUser(t, reply.DirectDeliveries, reader), 0, root.ChannelSeq, reply.ChannelSeq, root.ChannelSeq)
	subscription, err := svc.SubscribeThread(ctx, chat.SubscribeThreadParams{ChannelID: channelID, RequesterID: reader, ThreadRootMessageID: root.MessageID})
	require.NoError(t, err)
	check(unreadCounterForUser(t, subscription.DirectDeliveries, reader), 0, root.ChannelSeq, reply.ChannelSeq, root.ChannelSeq)
	edit, err := svc.EditMessage(ctx, chat.EditMessageParams{ActorID: sender, MessageID: root.MessageID, Body: "edited"})
	require.NoError(t, err)
	check(unreadCounterForUser(t, edit.DirectDeliveries, reader), 0, root.ChannelSeq, reply.ChannelSeq, root.ChannelSeq)
	mute, err := svc.SetNotificationLevel(ctx, chat.SetNotificationLevelParams{ChannelID: channelID, UserID: reader, Level: packetspb.NotificationLevel_NOTIFICATION_LEVEL_NOTHING})
	require.NoError(t, err)
	check(unreadCounterForUser(t, mute.DirectDeliveries, reader), 0, root.ChannelSeq, reply.ChannelSeq, root.ChannelSeq)
	newRoot, err := svc.SendMessage(ctx, chat.SendMessageParams{ChannelID: channelID, SenderID: sender, ClientMsgID: uuid.NewString(), Body: "new root"})
	require.NoError(t, err)
	check(unreadCounterForUser(t, newRoot.DirectDeliveries, reader), 0, root.ChannelSeq, newRoot.ChannelSeq, newRoot.ChannelSeq)
	unmute, err := svc.SetNotificationLevel(ctx, chat.SetNotificationLevelParams{ChannelID: channelID, UserID: reader, Level: packetspb.NotificationLevel_NOTIFICATION_LEVEL_ALL})
	require.NoError(t, err)
	check(unreadCounterForUser(t, unmute.DirectDeliveries, reader), 1, root.ChannelSeq, newRoot.ChannelSeq, newRoot.ChannelSeq)
	deleted, err := svc.DeleteMessage(ctx, chat.DeleteMessageParams{MessageID: newRoot.MessageID, ActorID: sender})
	require.NoError(t, err)
	check(unreadCounterForUser(t, deleted.DirectDeliveries, reader), 0, root.ChannelSeq, newRoot.ChannelSeq, root.ChannelSeq)
	cleared, err := svc.ClearDMConversationHistory(ctx, chat.ClearDMConversationHistoryParams{ConversationID: channelID, ActorID: reader})
	require.NoError(t, err)
	check(unreadCounterForUser(t, cleared.DirectDeliveries, reader), 0, root.ChannelSeq, newRoot.ChannelSeq, 0)
}

func TestIntegration_UnreadCounterRevision_ReloadsCursorAfterLockWait(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	svc := chat.NewService(pool, events.NewStore(pool))
	reader := seedChatUserWithAttrs(t, ctx, pool, "Reader", "member", "active")
	sender := seedChatUserWithAttrs(t, ctx, pool, "Sender", "member", "active")
	dm, err := svc.CreateOrOpenDirectMessage(ctx, reader, sender)
	require.NoError(t, err)
	channelID := dm.DM.ConversationID
	first, err := svc.SendMessage(ctx, chat.SendMessageParams{ChannelID: channelID, SenderID: sender, ClientMsgID: uuid.NewString(), Body: "first"})
	require.NoError(t, err)
	firstCounter := unreadCounterForUser(t, first.DirectDeliveries, reader)

	blocker, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer blocker.Rollback(context.Background()) //nolint:errcheck
	_, err = blocker.Exec(ctx, `SELECT revision FROM conversation_unread_revisions WHERE channel_id = $1 AND user_id = $2 FOR UPDATE`, channelID, reader)
	require.NoError(t, err)
	_, err = blocker.Exec(ctx, `INSERT INTO message_reads (channel_id, user_id, last_read_seq) VALUES ($1, $2, $3)`, channelID, reader, first.ChannelSeq)
	require.NoError(t, err)
	type outcome struct {
		result chat.SendMessageResult
		err    error
	}
	done := make(chan outcome, 1)
	go func() {
		result, err := svc.SendMessage(ctx, chat.SendMessageParams{ChannelID: channelID, SenderID: sender, ClientMsgID: uuid.NewString(), Body: "second"})
		done <- outcome{result, err}
	}()
	require.Eventually(t, func() bool {
		var waiting bool
		err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%INSERT INTO conversation_unread_revisions%')`).Scan(&waiting)
		return err == nil && waiting
	}, 3*time.Second, 10*time.Millisecond, "send must wait for the reader's revision lock")
	require.NoError(t, blocker.Commit(ctx))
	select {
	case sent := <-done:
		require.NoError(t, sent.err)
		counter := unreadCounterForUser(t, sent.result.DirectDeliveries, reader)
		assert.Greater(t, counter.GetRevision(), firstCounter.GetRevision())
		assert.Equal(t, first.ChannelSeq, counter.GetLastReadSeq())
		assert.Equal(t, int32(1), counter.GetUnreadMessages(), "first message became read while the send waited")
		assert.Equal(t, sent.result.ChannelSeq, counter.GetLastRootMessageSeq())
	case <-ctx.Done():
		t.Fatal("send did not finish after releasing the revision lock", ctx.Err())
	}
}
