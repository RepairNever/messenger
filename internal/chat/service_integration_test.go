//go:build integration

package chat_test

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"

	"msgnr/internal/chat"
	"msgnr/internal/documents"
	"msgnr/internal/events"
	packetspb "msgnr/internal/gen/proto"
	"msgnr/internal/tasks"
	"msgnr/internal/testdb"
)

// seedUserAndChannel inserts a user, channel, and channel_member row and returns their IDs.
func seedUserAndChannel(t *testing.T, ctx context.Context, pool *pgxpool.Pool) (userID uuid.UUID, channelID uuid.UUID) {
	t.Helper()

	err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'Test User', 'member')
		 RETURNING id`,
		"testuser_"+uuid.New().String()+"@example.com",
	).Scan(&userID)
	require.NoError(t, err)

	err = pool.QueryRow(ctx,
		`INSERT INTO channels (kind, visibility, name, created_by)
		 VALUES ('channel', 'public', 'test', $1)
		 RETURNING id`,
		userID,
	).Scan(&channelID)
	require.NoError(t, err)

	_, err = pool.Exec(ctx,
		`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`,
		channelID, userID,
	)
	require.NoError(t, err)

	return userID, channelID
}

func seedChatUserWithAttrs(t *testing.T, ctx context.Context, pool *pgxpool.Pool, displayName, role, status string) uuid.UUID {
	t.Helper()

	if role == "" {
		role = "member"
	}
	if status == "" {
		status = "active"
	}

	var userID uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role, status)
		 VALUES ($1, 'x', $2, $3, $4)
		 RETURNING id`,
		strings.ToLower(strings.ReplaceAll(displayName, " ", "_"))+"_"+uuid.New().String()+"@example.com",
		displayName,
		role,
		status,
	).Scan(&userID)
	require.NoError(t, err)

	return userID
}

func seedChannelForUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID uuid.UUID, name string) uuid.UUID {
	t.Helper()

	return seedChannelForUserWithVisibility(t, ctx, pool, userID, name, "public")
}

func seedChannelForUserWithVisibility(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID uuid.UUID, name, visibility string) uuid.UUID {
	t.Helper()

	var channelID uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO channels (kind, visibility, name, created_by)
		 VALUES ('channel', $1, $2, $3)
		 RETURNING id`,
		visibility, name, userID,
	).Scan(&channelID)
	require.NoError(t, err)

	_, err = pool.Exec(ctx,
		`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`,
		channelID, userID,
	)
	require.NoError(t, err)
	return channelID
}

func addChannelMemberWithAttrs(t *testing.T, ctx context.Context, pool *pgxpool.Pool, channelID uuid.UUID, displayName, role, status string) uuid.UUID {
	t.Helper()

	userID := seedChatUserWithAttrs(t, ctx, pool, displayName, role, status)

	_, err := pool.Exec(ctx,
		`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`,
		channelID, userID,
	)
	require.NoError(t, err)

	return userID
}

func createMemberInChannel(t *testing.T, ctx context.Context, pool *pgxpool.Pool, channelID uuid.UUID, name string) uuid.UUID {
	t.Helper()

	return addChannelMemberWithAttrs(t, ctx, pool, channelID, name, "member", "active")
}

func archiveChannelMembership(t *testing.T, ctx context.Context, pool *pgxpool.Pool, channelID, userID uuid.UUID) {
	t.Helper()

	_, err := pool.Exec(ctx,
		`UPDATE channel_members
		    SET is_archived = true
		  WHERE channel_id = $1
		    AND user_id = $2`,
		channelID, userID,
	)
	require.NoError(t, err)
}

func setMessageCreatedAt(t *testing.T, ctx context.Context, pool *pgxpool.Pool, messageID uuid.UUID, createdAt time.Time) {
	t.Helper()

	_, err := pool.Exec(ctx, `UPDATE messages SET created_at = $2 WHERE id = $1`, messageID, createdAt)
	require.NoError(t, err)
}

func setTaskUpdatedAt(t *testing.T, ctx context.Context, pool *pgxpool.Pool, taskID uuid.UUID, updatedAt time.Time) {
	t.Helper()

	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer tx.Rollback(ctx)

	_, err = tx.Exec(ctx, `SET LOCAL msgnr.preserve_task_updated_at = 'on'`)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `UPDATE task SET updated_at = $2 WHERE id = $1`, taskID, updatedAt)
	require.NoError(t, err)
	require.NoError(t, tx.Commit(ctx))
}

func setDocumentUpdatedAt(t *testing.T, ctx context.Context, pool *pgxpool.Pool, documentID uuid.UUID, updatedAt time.Time) {
	t.Helper()

	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer tx.Rollback(ctx)

	_, err = tx.Exec(ctx, `SET LOCAL msgnr.preserve_document_updated_at = 'on'`)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `UPDATE document SET updated_at = $2 WHERE id = $1`, documentID, updatedAt)
	require.NoError(t, err)
	require.NoError(t, tx.Commit(ctx))
}

func seedSearchTask(t *testing.T, ctx context.Context, pool *pgxpool.Pool, svc *tasks.Service, templateID, statusID, actorID uuid.UUID, title string, updatedAt time.Time) tasks.TaskResponse {
	t.Helper()

	row, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: templateID,
		Title:      title,
		StatusID:   statusID,
		ActorID:    actorID,
	})
	require.NoError(t, err)
	setTaskUpdatedAt(t, ctx, pool, row.ID, updatedAt)
	return row
}

func seedSearchDocument(t *testing.T, ctx context.Context, pool *pgxpool.Pool, svc *documents.Service, teamspaceID, actorID uuid.UUID, title string, updatedAt time.Time) documents.DocumentResponse {
	t.Helper()

	row, err := svc.CreateDocument(ctx, documents.CreateDocumentParams{
		TeamspaceID: teamspaceID,
		Title:       title,
		ActorID:     actorID,
	})
	require.NoError(t, err)
	setDocumentUpdatedAt(t, ctx, pool, row.ID, updatedAt)
	return row
}

func setChannelMemberNotificationLevel(t *testing.T, ctx context.Context, pool *pgxpool.Pool, channelID, userID uuid.UUID, level int16) {
	t.Helper()
	_, err := pool.Exec(ctx, `
		UPDATE channel_members
		   SET notification_level = $3
		 WHERE channel_id = $1
		   AND user_id = $2`,
		channelID, userID, level,
	)
	require.NoError(t, err)
}

func filterDirectDeliveriesByType(deliveries []chat.DirectDelivery, eventType packetspb.EventType) []chat.DirectDelivery {
	filtered := make([]chat.DirectDelivery, 0)
	for _, delivery := range deliveries {
		if delivery.Event != nil && delivery.Event.GetEventType() == eventType {
			filtered = append(filtered, delivery)
		}
	}
	return filtered
}

func TestIntegration_SendMessage_Basic(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	userID, channelID := seedUserAndChannel(t, ctx, pool)

	result, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    userID,
		ClientMsgID: uuid.New().String(),
		Body:        "hello world",
	})
	require.NoError(t, err)
	assert.False(t, result.Deduped)
	assert.NotEqual(t, uuid.Nil, result.MessageID)
	assert.Equal(t, int64(1), result.ChannelSeq)

	var evtType string
	err = pool.QueryRow(ctx,
		`SELECT event_type FROM workspace_events WHERE channel_id = $1 ORDER BY event_seq DESC LIMIT 1`,
		channelID,
	).Scan(&evtType)
	require.NoError(t, err)
	assert.Equal(t, "message_created", evtType)
}

func TestIntegration_ForwardMessage_ChatToChatCopiesMetadataAndAttachments(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	forwarderID, sourceChannelID := seedUserAndChannel(t, ctx, pool)
	originalSenderID := createMemberInChannel(t, ctx, pool, sourceChannelID, "Original Sender")
	destinationChannelID := seedChannelForUser(t, ctx, pool, forwarderID, "destination")

	source, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   sourceChannelID,
		SenderID:    originalSenderID,
		ClientMsgID: uuid.New().String(),
		Body:        "source body",
	})
	require.NoError(t, err)
	var sourceAttachmentID uuid.UUID
	err = pool.QueryRow(ctx, `
		INSERT INTO message_attachment (
			conversation_id, message_id, file_name, file_size, mime_type, storage_key,
			thumbnail_storage_key, thumbnail_mime_type, thumbnail_file_size, thumbnail_version,
			uploaded_by
		)
		VALUES (
			$1, $2, 'source.png', 12, 'image/png', 'objects/source.png',
			'objects/thumbnail-v1.jpg', 'image/jpeg', 44, 1,
			$3
		)
		RETURNING id`,
		sourceChannelID, source.MessageID, originalSenderID,
	).Scan(&sourceAttachmentID)
	require.NoError(t, err)

	forwarded, err := svc.ForwardMessage(ctx, chat.ForwardMessageParams{
		SourceMessageID:           source.MessageID,
		ActorID:                   forwarderID,
		DestinationConversationID: destinationChannelID,
	})
	require.NoError(t, err)
	assert.NotEqual(t, source.MessageID, forwarded.MessageID)

	page, hasMore, err := svc.ListMessagePage(ctx, forwarderID, destinationChannelID, nil, 20)
	require.NoError(t, err)
	require.False(t, hasMore)
	require.Len(t, page, 1)
	assert.Equal(t, "source body", page[0].Body)
	require.NotNil(t, page[0].ForwardedFrom)
	assert.Equal(t, source.MessageID, page[0].ForwardedFrom.MessageID)
	assert.Equal(t, originalSenderID, page[0].ForwardedFrom.SenderID)
	assert.Equal(t, "Original Sender", page[0].ForwardedFrom.SenderName)
	assert.Equal(t, "channel", page[0].ForwardedFrom.ConversationKind)
	assert.Equal(t, "test", page[0].ForwardedFrom.ConversationTitle)
	assert.Empty(t, page[0].ForwardedFrom.ThreadTitle)
	require.Len(t, page[0].Attachments, 1)
	assert.NotEqual(t, sourceAttachmentID, page[0].Attachments[0].ID)
	assert.Equal(t, "source.png", page[0].Attachments[0].FileName)
	assert.Equal(t, "image/jpeg", page[0].Attachments[0].ThumbnailMimeType)
	assert.Equal(t, int64(44), page[0].Attachments[0].ThumbnailFileSize)
	assert.Equal(t, int16(1), page[0].Attachments[0].ThumbnailVersion)

	var sourceStorageKey string
	var sourceThumbnailStorageKey string
	err = pool.QueryRow(ctx,
		`SELECT storage_key, thumbnail_storage_key FROM message_attachment WHERE id = $1`,
		sourceAttachmentID,
	).Scan(&sourceStorageKey, &sourceThumbnailStorageKey)
	require.NoError(t, err)
	var copiedStorageKey string
	var copiedThumbnailStorageKey string
	err = pool.QueryRow(ctx,
		`SELECT storage_key, thumbnail_storage_key FROM message_attachment WHERE id = $1`,
		page[0].Attachments[0].ID,
	).Scan(&copiedStorageKey, &copiedThumbnailStorageKey)
	require.NoError(t, err)
	assert.Equal(t, sourceStorageKey, copiedStorageKey)
	assert.Equal(t, sourceThumbnailStorageKey, copiedThumbnailStorageKey)
}

func TestIntegration_ForwardMessage_ThreadReplyToChatPreservesSourceThreadMetadata(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	forwarderID, channelID := seedUserAndChannel(t, ctx, pool)
	originalSenderID := createMemberInChannel(t, ctx, pool, channelID, "Reply Author")

	sourceRoot, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    forwarderID,
		ClientMsgID: uuid.New().String(),
		Body:        "source root",
	})
	require.NoError(t, err)
	sourceReply, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:           channelID,
		SenderID:            originalSenderID,
		ClientMsgID:         uuid.New().String(),
		Body:                "reply body",
		ThreadRootMessageID: sourceRoot.MessageID,
	})
	require.NoError(t, err)
	forwarded, err := svc.ForwardMessage(ctx, chat.ForwardMessageParams{
		SourceMessageID:           sourceReply.MessageID,
		ActorID:                   forwarderID,
		DestinationConversationID: channelID,
	})
	require.NoError(t, err)

	page, _, err := svc.ListMessagePage(ctx, forwarderID, channelID, nil, 20)
	require.NoError(t, err)
	var forwardedMessage chat.ConversationMessage
	for _, item := range page {
		if item.ID == forwarded.MessageID {
			forwardedMessage = item
			break
		}
	}
	require.Equal(t, forwarded.MessageID, forwardedMessage.ID)
	assert.Equal(t, "reply body", forwardedMessage.Body)
	assert.Equal(t, uuid.Nil, forwardedMessage.ThreadRootMessageID)
	require.NotNil(t, forwardedMessage.ForwardedFrom)
	assert.Equal(t, sourceReply.MessageID, forwardedMessage.ForwardedFrom.MessageID)
	assert.Equal(t, originalSenderID, forwardedMessage.ForwardedFrom.SenderID)
	assert.Equal(t, "Reply Author", forwardedMessage.ForwardedFrom.SenderName)
	assert.Equal(t, "channel", forwardedMessage.ForwardedFrom.ConversationKind)
	assert.Equal(t, "test", forwardedMessage.ForwardedFrom.ConversationTitle)
	assert.Equal(t, "source root", forwardedMessage.ForwardedFrom.ThreadTitle)
}

func TestIntegration_ForwardMessage_RejectsUnreadableSourceAndInvalidDestinationThread(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	forwarderID, sourceChannelID := seedUserAndChannel(t, ctx, pool)
	originalSenderID := createMemberInChannel(t, ctx, pool, sourceChannelID, "Source Author")
	outsiderID := seedChatUserWithAttrs(t, ctx, pool, "Outsider", "member", "active")
	destinationOwnerID := seedChatUserWithAttrs(t, ctx, pool, "Destination Owner", "member", "active")
	destinationChannelID := seedChannelForUser(t, ctx, pool, forwarderID, "destination")
	nonMemberDestinationChannelID := seedChannelForUser(t, ctx, pool, destinationOwnerID, "private destination")
	otherChannelID := seedChannelForUser(t, ctx, pool, forwarderID, "other")
	otherRoot, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   otherChannelID,
		SenderID:    forwarderID,
		ClientMsgID: uuid.New().String(),
		Body:        "other root",
	})
	require.NoError(t, err)
	source, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   sourceChannelID,
		SenderID:    originalSenderID,
		ClientMsgID: uuid.New().String(),
		Body:        "source body",
	})
	require.NoError(t, err)

	_, err = svc.ForwardMessage(ctx, chat.ForwardMessageParams{
		SourceMessageID:           source.MessageID,
		ActorID:                   outsiderID,
		DestinationConversationID: destinationChannelID,
	})
	require.ErrorIs(t, err, chat.ErrNotMember)

	_, err = svc.ForwardMessage(ctx, chat.ForwardMessageParams{
		SourceMessageID:           source.MessageID,
		ActorID:                   forwarderID,
		DestinationConversationID: nonMemberDestinationChannelID,
	})
	require.ErrorIs(t, err, chat.ErrNotMember)

	_, err = svc.ForwardMessage(ctx, chat.ForwardMessageParams{
		SourceMessageID:                source.MessageID,
		ActorID:                        forwarderID,
		DestinationConversationID:      destinationChannelID,
		DestinationThreadRootMessageID: otherRoot.MessageID,
	})
	require.ErrorIs(t, err, chat.ErrInvalidThread)
}

func TestIntegration_ForwardMessage_PreservesEntitiesWithoutMentionNotifications(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	forwarderID, channelID := seedUserAndChannel(t, ctx, pool)
	mentionedID := createMemberInChannel(t, ctx, pool, channelID, "Mentioned User")
	originalSenderID := createMemberInChannel(t, ctx, pool, channelID, "Original Sender")
	body := "@Mentioned User hello"
	source, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    originalSenderID,
		ClientMsgID: uuid.New().String(),
		Body:        body,
		Entities: []chat.MessageEntity{{
			Kind:     chat.MessageEntityKindUser,
			TargetID: mentionedID,
			Label:    "@Mentioned User",
			Start:    0,
			End:      int32(len([]rune("@Mentioned User"))),
		}},
	})
	require.NoError(t, err)

	forwarded, err := svc.ForwardMessage(ctx, chat.ForwardMessageParams{
		SourceMessageID:           source.MessageID,
		ActorID:                   forwarderID,
		DestinationConversationID: channelID,
	})
	require.NoError(t, err)
	assert.Empty(t, filterDirectDeliveriesByType(forwarded.DirectDeliveries, packetspb.EventType_EVENT_TYPE_NOTIFICATION_ADDED))

	page, _, err := svc.ListMessagePage(ctx, forwarderID, channelID, nil, 20)
	require.NoError(t, err)
	var forwardedMessage chat.ConversationMessage
	for _, item := range page {
		if item.ID == forwarded.MessageID {
			forwardedMessage = item
			break
		}
	}
	require.Equal(t, forwarded.MessageID, forwardedMessage.ID)
	require.Len(t, forwardedMessage.Entities, 1)
	assert.Equal(t, mentionedID, forwardedMessage.Entities[0].TargetID)
	assert.False(t, forwardedMessage.MentionEveryone)
}

func TestIntegration_SavedMessages_SaveListUnsave(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)
	userID, channelID := seedUserAndChannel(t, ctx, pool)
	otherUserID := createMemberInChannel(t, ctx, pool, channelID, "Other User")
	outsiderID := seedChatUserWithAttrs(t, ctx, pool, "Outsider", "member", "active")

	first, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    userID,
		ClientMsgID: "saved-first",
		Body:        "first saved",
	})
	require.NoError(t, err)
	root, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    otherUserID,
		ClientMsgID: "saved-root",
		Body:        "root saved",
	})
	require.NoError(t, err)
	reply, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:           channelID,
		SenderID:            otherUserID,
		ClientMsgID:         "saved-reply",
		Body:                "reply saved",
		ThreadRootMessageID: root.MessageID,
	})
	require.NoError(t, err)

	_, err = svc.SaveMessage(ctx, userID, first.MessageID)
	require.NoError(t, err)
	_, err = svc.SaveMessage(ctx, userID, reply.MessageID)
	require.NoError(t, err)
	_, err = svc.SaveMessage(ctx, userID, reply.MessageID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE message_saves SET saved_at = now() - interval '1 hour' WHERE user_id = $1 AND message_id = $2`, userID, first.MessageID)
	require.NoError(t, err)

	items, err := svc.ListSavedMessages(ctx, userID)
	require.NoError(t, err)
	require.Len(t, items, 2)
	assert.Equal(t, reply.MessageID, items[0].MessageID)
	assert.Equal(t, root.MessageID, items[0].ThreadRootMessageID)
	assert.Equal(t, "reply saved", items[0].Body)
	assert.Equal(t, first.MessageID, items[1].MessageID)

	page, _, err := svc.ListMessagePage(ctx, userID, channelID, nil, 20)
	require.NoError(t, err)
	require.Len(t, page, 2)
	assert.True(t, page[0].IsSaved)

	_, err = svc.SaveMessage(ctx, outsiderID, first.MessageID)
	require.ErrorIs(t, err, chat.ErrNotMember)

	require.NoError(t, svc.UnsaveMessage(ctx, userID, first.MessageID))
	items, err = svc.ListSavedMessages(ctx, userID)
	require.NoError(t, err)
	require.Len(t, items, 1)
	assert.Equal(t, reply.MessageID, items[0].MessageID)
}

func TestIntegration_SavedMessages_DeleteCascade(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)
	userID, channelID := seedUserAndChannel(t, ctx, pool)

	msg, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    userID,
		ClientMsgID: "saved-delete",
		Body:        "saved then deleted",
	})
	require.NoError(t, err)
	_, err = svc.SaveMessage(ctx, userID, msg.MessageID)
	require.NoError(t, err)

	_, err = pool.Exec(ctx, `DELETE FROM messages WHERE id = $1`, msg.MessageID)
	require.NoError(t, err)

	items, err := svc.ListSavedMessages(ctx, userID)
	require.NoError(t, err)
	assert.Empty(t, items)
}

func TestIntegration_SendMessage_MessageAlertForChannelMember(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)
	authorID, channelID := seedUserAndChannel(t, ctx, pool)

	var peerID uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'Peer', 'member')
		 RETURNING id`,
		"peer_"+uuid.New().String()+"@example.com",
	).Scan(&peerID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`, channelID, peerID)
	require.NoError(t, err)

	result, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    authorID,
		ClientMsgID: uuid.New().String(),
		Body:        "hello channel",
	})
	require.NoError(t, err)
	alertDeliveries := filterDirectDeliveriesByType(result.DirectDeliveries, packetspb.EventType_EVENT_TYPE_MESSAGE_ALERT)
	require.Len(t, alertDeliveries, 1)
	assert.Equal(t, peerID.String(), alertDeliveries[0].UserID)
	alert := alertDeliveries[0].Event.GetMessageAlert()
	require.NotNil(t, alert)
	assert.Equal(t, channelID.String(), alert.GetConversationId())
	assert.Equal(t, "hello channel", alert.GetBody())
	assert.Equal(t, int32(0), alert.GetAttachmentCount())

	readCounterDeliveries := filterDirectDeliveriesByType(result.DirectDeliveries, packetspb.EventType_EVENT_TYPE_READ_COUNTER_UPDATED)
	require.Len(t, readCounterDeliveries, 2)
}

func TestIntegration_SendMessage_MessageAlertRespectsNotificationLevel(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)
	authorID, channelID := seedUserAndChannel(t, ctx, pool)

	insertMember := func(name string) uuid.UUID {
		var userID uuid.UUID
		err := pool.QueryRow(ctx,
			`INSERT INTO users (email, password_hash, display_name, role)
			 VALUES ($1, 'x', $2, 'member')
			 RETURNING id`,
			strings.ToLower(name)+"_"+uuid.New().String()+"@example.com",
			name,
		).Scan(&userID)
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`, channelID, userID)
		require.NoError(t, err)
		return userID
	}

	allID := insertMember("All")
	mentionsID := insertMember("Mentions")
	nothingID := insertMember("Nothing")

	setChannelMemberNotificationLevel(t, ctx, pool, channelID, mentionsID, int16(packetspb.NotificationLevel_NOTIFICATION_LEVEL_MENTIONS_ONLY))
	setChannelMemberNotificationLevel(t, ctx, pool, channelID, nothingID, int16(packetspb.NotificationLevel_NOTIFICATION_LEVEL_NOTHING))

	result, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    authorID,
		ClientMsgID: uuid.New().String(),
		Body:        "plain message",
	})
	require.NoError(t, err)
	alertDeliveries := filterDirectDeliveriesByType(result.DirectDeliveries, packetspb.EventType_EVENT_TYPE_MESSAGE_ALERT)
	require.Len(t, alertDeliveries, 1)
	assert.Equal(t, allID.String(), alertDeliveries[0].UserID)

	readCounterDeliveries := filterDirectDeliveriesByType(result.DirectDeliveries, packetspb.EventType_EVENT_TYPE_READ_COUNTER_UPDATED)
	require.Len(t, readCounterDeliveries, 4)
}

func TestIntegration_SendMessage_Dedup(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	userID, channelID := seedUserAndChannel(t, ctx, pool)
	clientMsgID := uuid.New().String()

	r1, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    userID,
		ClientMsgID: clientMsgID,
		Body:        "first send",
	})
	require.NoError(t, err)
	require.False(t, r1.Deduped)

	r2, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    userID,
		ClientMsgID: clientMsgID,
		Body:        "first send",
	})
	require.NoError(t, err)
	assert.True(t, r2.Deduped)
	assert.Equal(t, r1.MessageID, r2.MessageID)

	var count int
	err = pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM messages WHERE channel_id = $1 AND client_msg_id = $2`,
		channelID, clientMsgID,
	).Scan(&count)
	require.NoError(t, err)
	assert.Equal(t, 1, count)
}

func TestIntegration_SendMessage_DedupScopedBySender(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	user1, channelID := seedUserAndChannel(t, ctx, pool)

	var user2 uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'User2', 'member')
		 RETURNING id`,
		"testuser_"+uuid.New().String()+"@example.com",
	).Scan(&user2)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`, channelID, user2)
	require.NoError(t, err)

	clientMsgID := uuid.New().String()
	r1, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    user1,
		ClientMsgID: clientMsgID,
		Body:        "from user1",
	})
	require.NoError(t, err)
	require.False(t, r1.Deduped)

	r2, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    user2,
		ClientMsgID: clientMsgID,
		Body:        "from user2",
	})
	require.NoError(t, err)
	require.False(t, r2.Deduped)
	require.NotEqual(t, r1.MessageID, r2.MessageID)
}

func TestIntegration_SendMessage_ThreadSeqMonotonic(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	userID, channelID := seedUserAndChannel(t, ctx, pool)

	root, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    userID,
		ClientMsgID: uuid.New().String(),
		Body:        "root",
	})
	require.NoError(t, err)

	for i := 0; i < 3; i++ {
		_, err := svc.SendMessage(ctx, chat.SendMessageParams{
			ChannelID:           channelID,
			SenderID:            userID,
			ClientMsgID:         uuid.New().String(),
			Body:                "reply",
			ThreadRootMessageID: root.MessageID,
		})
		require.NoError(t, err)
	}

	rows, err := pool.Query(ctx,
		`SELECT thread_seq FROM messages WHERE thread_root_id = $1 ORDER BY thread_seq ASC`,
		root.MessageID,
	)
	require.NoError(t, err)
	defer rows.Close()

	var threadSeqs []int64
	for rows.Next() {
		var s int64
		require.NoError(t, rows.Scan(&s))
		threadSeqs = append(threadSeqs, s)
	}
	require.NoError(t, rows.Err())

	require.Len(t, threadSeqs, 3)
	for i := 1; i < len(threadSeqs); i++ {
		assert.Greater(t, threadSeqs[i], threadSeqs[i-1])
	}
}

func TestIntegration_Reaction_Idempotent(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	userID, channelID := seedUserAndChannel(t, ctx, pool)

	msg, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    userID,
		ClientMsgID: uuid.New().String(),
		Body:        "hello",
	})
	require.NoError(t, err)

	p := chat.ReactionParams{
		ChannelID:  channelID,
		MessageID:  msg.MessageID,
		UserID:     userID,
		Emoji:      "👍",
		ClientOpID: uuid.New().String(),
	}

	// First add — applied.
	r1, err := svc.AddReaction(ctx, p)
	require.NoError(t, err)
	assert.True(t, r1.Applied)

	// Second add — no-op.
	r2, err := svc.AddReaction(ctx, p)
	require.NoError(t, err)
	assert.False(t, r2.Applied)

	var count int
	err = pool.QueryRow(ctx,
		`SELECT count FROM reaction_counts WHERE message_id = $1 AND emoji = $2`,
		msg.MessageID, "👍",
	).Scan(&count)
	require.NoError(t, err)
	assert.Equal(t, 1, count)

	// Remove — applied.
	r3, err := svc.RemoveReaction(ctx, p)
	require.NoError(t, err)
	assert.True(t, r3.Applied)

	// Remove again — no-op.
	r4, err := svc.RemoveReaction(ctx, p)
	require.NoError(t, err)
	assert.False(t, r4.Applied)

	// Count row should be gone.
	var countAfter int
	err = pool.QueryRow(ctx,
		`SELECT count FROM reaction_counts WHERE message_id = $1 AND emoji = $2`,
		msg.MessageID, "👍",
	).Scan(&countAfter)
	assert.Error(t, err, "reaction_counts row should have been deleted")
}

func TestIntegration_ListDMCandidates_ExcludesSelfBlockedAndBotUsers(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	selfID := seedChatUserWithAttrs(t, ctx, pool, "Self", "member", "active")
	activeID := seedChatUserWithAttrs(t, ctx, pool, "Active User", "member", "active")
	seedChatUserWithAttrs(t, ctx, pool, "Blocked User", "member", "blocked")
	seedChatUserWithAttrs(t, ctx, pool, "Bot User", "bot", "active")

	candidates, err := svc.ListDMCandidates(ctx, selfID)
	require.NoError(t, err)
	require.Len(t, candidates, 1)
	assert.Equal(t, activeID, candidates[0].UserID)
	assert.Equal(t, "Active User", candidates[0].DisplayName)
}

func TestIntegration_SearchTagEntities_FilteredQuery_RespectsMembershipOrderingAndLimit(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)
	taskSvc := tasks.NewService(pool, nil)
	documentSvc := documents.NewService(pool, nil)

	requesterID, channelID := seedUserAndChannel(t, ctx, pool)
	outsiderID := seedChatUserWithAttrs(t, ctx, pool, "Outsider", "member", "active")

	for _, name := range []string{
		"Needle Bravo",
		"Needle Echo",
		"Needle Alpha",
		"Needle Foxtrot",
		"Needle Charlie",
		"Needle Delta",
	} {
		createMemberInChannel(t, ctx, pool, channelID, name)
	}
	createMemberInChannel(t, ctx, pool, channelID, "Other User")
	addChannelMemberWithAttrs(t, ctx, pool, channelID, "Needle Blocked", "member", "blocked")
	archivedID := createMemberInChannel(t, ctx, pool, channelID, "Needle Archived")
	archiveChannelMembership(t, ctx, pool, channelID, archivedID)

	template, err := taskSvc.CreateTemplate(ctx, tasks.CreateTemplateParams{
		Prefix:    "NDL",
		SortOrder: 1,
		ActorID:   requesterID,
	})
	require.NoError(t, err)
	status, err := taskSvc.CreateStatus(ctx, tasks.CreateStatusParams{
		Code:      "status_" + uuid.NewString()[:8],
		Name:      "Open",
		SortOrder: 1,
		ActorID:   requesterID,
	})
	require.NoError(t, err)

	baseTime := time.Date(2026, 1, 2, 15, 0, 0, 0, time.UTC)
	for i, title := range []string{
		"Needle Task A",
		"Needle Task B",
		"Needle Task C",
		"Needle Task D",
		"Needle Task E",
		"Needle Task F",
	} {
		seedSearchTask(t, ctx, pool, taskSvc, template.ID, status.ID, requesterID, title, baseTime.Add(time.Duration(i)*time.Minute))
	}
	seedSearchTask(t, ctx, pool, taskSvc, template.ID, status.ID, requesterID, "Other Task", baseTime.Add(10*time.Minute))

	teamspace, err := documentSvc.CreateTeamspace(ctx, documents.CreateTeamspaceParams{
		Name:    "Visible search space",
		ActorID: requesterID,
	}, "member")
	require.NoError(t, err)
	for i, title := range []string{
		"Needle Doc A",
		"Needle Doc B",
		"Needle Doc C",
		"Needle Doc D",
		"Needle Doc E",
		"Needle Doc F",
	} {
		seedSearchDocument(t, ctx, pool, documentSvc, teamspace.ID, requesterID, title, baseTime.Add(time.Duration(i)*time.Minute))
	}
	seedSearchDocument(t, ctx, pool, documentSvc, teamspace.ID, requesterID, "Other Doc", baseTime.Add(10*time.Minute))

	hiddenOwnerID := seedChatUserWithAttrs(t, ctx, pool, "Hidden Owner", "member", "active")
	hiddenSpace, err := documentSvc.CreateTeamspace(ctx, documents.CreateTeamspaceParams{
		Name:      "Hidden search space",
		IsPrivate: true,
		ActorID:   hiddenOwnerID,
	}, "member")
	require.NoError(t, err)
	hiddenDoc := seedSearchDocument(t, ctx, pool, documentSvc, hiddenSpace.ID, hiddenOwnerID, "Needle Hidden Doc", baseTime.Add(20*time.Minute))

	_, err = svc.SearchTagEntities(ctx, outsiderID, channelID, "needle")
	require.ErrorIs(t, err, chat.ErrNotMember)

	result, err := svc.SearchTagEntities(ctx, requesterID, channelID, "needle")
	require.NoError(t, err)

	gotUserNames := make([]string, 0, len(result.Users))
	for _, row := range result.Users {
		gotUserNames = append(gotUserNames, row.DisplayName)
	}
	assert.Equal(t, []string{
		"Needle Alpha",
		"Needle Bravo",
		"Needle Charlie",
		"Needle Delta",
		"Needle Echo",
	}, gotUserNames)

	gotTaskTitles := make([]string, 0, len(result.Tasks))
	for _, row := range result.Tasks {
		gotTaskTitles = append(gotTaskTitles, row.Title)
	}
	assert.Equal(t, []string{
		"Needle Task F",
		"Needle Task E",
		"Needle Task D",
		"Needle Task C",
		"Needle Task B",
	}, gotTaskTitles)

	gotDocumentTitles := make([]string, 0, len(result.Documents))
	for _, row := range result.Documents {
		gotDocumentTitles = append(gotDocumentTitles, row.Title)
		assert.NotEqual(t, hiddenDoc.ID, row.DocumentID)
	}
	assert.Equal(t, []string{
		"Needle Doc F",
		"Needle Doc E",
		"Needle Doc D",
		"Needle Doc C",
		"Needle Doc B",
	}, gotDocumentTitles)
}

func TestIntegration_SearchTagEntities_EmptyQuery_UsesRecentOrderingAndLimit(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)
	taskSvc := tasks.NewService(pool, nil)
	documentSvc := documents.NewService(pool, nil)

	requesterID, channelID := seedUserAndChannel(t, ctx, pool)

	baseTime := time.Date(2026, 2, 3, 9, 0, 0, 0, time.UTC)
	for i, name := range []string{
		"Recent User A",
		"Recent User B",
		"Recent User C",
		"Recent User D",
		"Recent User E",
		"Recent User F",
	} {
		memberID := createMemberInChannel(t, ctx, pool, channelID, name)
		msg, err := svc.SendMessage(ctx, chat.SendMessageParams{
			ChannelID:   channelID,
			SenderID:    memberID,
			ClientMsgID: uuid.NewString(),
			Body:        "hello " + name,
		})
		require.NoError(t, err)
		setMessageCreatedAt(t, ctx, pool, msg.MessageID, baseTime.Add(time.Duration(i)*time.Minute))
	}
	createMemberInChannel(t, ctx, pool, channelID, "Recent User NoMessage")

	template, err := taskSvc.CreateTemplate(ctx, tasks.CreateTemplateParams{
		Prefix:    "RCN",
		SortOrder: 1,
		ActorID:   requesterID,
	})
	require.NoError(t, err)
	status, err := taskSvc.CreateStatus(ctx, tasks.CreateStatusParams{
		Code:      "status_" + uuid.NewString()[:8],
		Name:      "Open",
		SortOrder: 1,
		ActorID:   requesterID,
	})
	require.NoError(t, err)
	for i, title := range []string{
		"Recent Task A",
		"Recent Task B",
		"Recent Task C",
		"Recent Task D",
		"Recent Task E",
		"Recent Task F",
	} {
		seedSearchTask(t, ctx, pool, taskSvc, template.ID, status.ID, requesterID, title, baseTime.Add(time.Duration(i)*time.Minute))
	}

	teamspace, err := documentSvc.CreateTeamspace(ctx, documents.CreateTeamspaceParams{
		Name:    "Recent search space",
		ActorID: requesterID,
	}, "member")
	require.NoError(t, err)
	for i, title := range []string{
		"Recent Doc A",
		"Recent Doc B",
		"Recent Doc C",
		"Recent Doc D",
		"Recent Doc E",
		"Recent Doc F",
	} {
		seedSearchDocument(t, ctx, pool, documentSvc, teamspace.ID, requesterID, title, baseTime.Add(time.Duration(i)*time.Minute))
	}

	result, err := svc.SearchTagEntities(ctx, requesterID, channelID, "")
	require.NoError(t, err)

	gotUserNames := make([]string, 0, len(result.Users))
	for _, row := range result.Users {
		gotUserNames = append(gotUserNames, row.DisplayName)
	}
	assert.Equal(t, []string{
		"Recent User F",
		"Recent User E",
		"Recent User D",
		"Recent User C",
		"Recent User B",
	}, gotUserNames)

	gotTaskTitles := make([]string, 0, len(result.Tasks))
	for _, row := range result.Tasks {
		gotTaskTitles = append(gotTaskTitles, row.Title)
	}
	assert.Equal(t, []string{
		"Recent Task F",
		"Recent Task E",
		"Recent Task D",
		"Recent Task C",
		"Recent Task B",
	}, gotTaskTitles)

	gotDocumentTitles := make([]string, 0, len(result.Documents))
	for _, row := range result.Documents {
		gotDocumentTitles = append(gotDocumentTitles, row.Title)
	}
	assert.Equal(t, []string{
		"Recent Doc F",
		"Recent Doc E",
		"Recent Doc D",
		"Recent Doc C",
		"Recent Doc B",
	}, gotDocumentTitles)
}

func TestIntegration_CreateOrOpenDirectMessage_ReusesExistingPair(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	var selfID uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'Ada', 'member')
		 RETURNING id`,
		"ada_"+uuid.New().String()+"@example.com",
	).Scan(&selfID)
	require.NoError(t, err)

	var otherID uuid.UUID
	err = pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'Bob', 'member')
		 RETURNING id`,
		"bob_"+uuid.New().String()+"@example.com",
	).Scan(&otherID)
	require.NoError(t, err)

	first, err := svc.CreateOrOpenDirectMessage(ctx, selfID, otherID)
	require.NoError(t, err)
	assert.Equal(t, otherID, first.DM.UserID)
	assert.Equal(t, "Bob", first.DM.DisplayName)
	assert.Equal(t, "dm", first.DM.Visibility)

	second, err := svc.CreateOrOpenDirectMessage(ctx, selfID, otherID)
	require.NoError(t, err)
	assert.Equal(t, first.DM.ConversationID, second.DM.ConversationID)

	var memberCount int
	err = pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM channel_members WHERE channel_id = $1`,
		first.DM.ConversationID,
	).Scan(&memberCount)
	require.NoError(t, err)
	assert.Equal(t, 2, memberCount)
}

func TestIntegration_CreateOrOpenEncryptedDirectMessage_CreatesSeparateSibling(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	userA := seedChatUserWithAttrs(t, ctx, pool, "E2E Ada", "member", "active")
	userB := seedChatUserWithAttrs(t, ctx, pool, "E2E Bob", "member", "active")

	plaintext, err := svc.CreateOrOpenDirectMessage(ctx, userA, userB)
	require.NoError(t, err)
	require.Equal(t, "none", plaintext.DM.EncryptionMode)

	encrypted, err := svc.CreateOrOpenEncryptedDirectMessage(ctx, userA, plaintext.DM.ConversationID)
	require.NoError(t, err)
	require.NotEqual(t, plaintext.DM.ConversationID, encrypted.DM.ConversationID)
	require.Equal(t, "dm_pairwise_signal_v1", encrypted.DM.EncryptionMode)

	reopenedPlaintext, err := svc.CreateOrOpenDirectMessage(ctx, userA, userB)
	require.NoError(t, err)
	assert.Equal(t, plaintext.DM.ConversationID, reopenedPlaintext.DM.ConversationID)

	reopenedEncrypted, err := svc.CreateOrOpenEncryptedDirectMessage(ctx, userA, plaintext.DM.ConversationID)
	require.NoError(t, err)
	assert.Equal(t, encrypted.DM.ConversationID, reopenedEncrypted.DM.ConversationID)

	var dmCount int
	err = pool.QueryRow(ctx, `
		SELECT COUNT(*)
		  FROM channels
		 WHERE kind = 'dm'
		   AND visibility = 'dm'
		   AND id IN ($1, $2)`,
		plaintext.DM.ConversationID,
		encrypted.DM.ConversationID,
	).Scan(&dmCount)
	require.NoError(t, err)
	assert.Equal(t, 2, dmCount)
}

func TestIntegration_SendMessage_StoresEncryptedDMCiphertexts(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	userA := seedChatUserWithAttrs(t, ctx, pool, "E2E Sender", "member", "active")
	userB := seedChatUserWithAttrs(t, ctx, pool, "E2E Receiver", "member", "active")

	plaintext, err := svc.CreateOrOpenDirectMessage(ctx, userA, userB)
	require.NoError(t, err)
	encrypted, err := svc.CreateOrOpenEncryptedDirectMessage(ctx, userA, plaintext.DM.ConversationID)
	require.NoError(t, err)

	senderDevice, err := svc.RegisterDevice(ctx, chat.RegisterDeviceParams{
		UserID:                userA,
		IdentityKeyPublic:     []byte("sender identity"),
		SignedPrekeyID:        1,
		SignedPrekeyPublic:    []byte("sender signed prekey"),
		SignedPrekeySignature: []byte("sender signature"),
	})
	require.NoError(t, err)
	recipientDevice, err := svc.RegisterDevice(ctx, chat.RegisterDeviceParams{
		UserID:                userB,
		IdentityKeyPublic:     []byte("recipient identity"),
		SignedPrekeyID:        1,
		SignedPrekeyPublic:    []byte("recipient signed prekey"),
		SignedPrekeySignature: []byte("recipient signature"),
	})
	require.NoError(t, err)

	_, err = svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:      encrypted.DM.ConversationID,
		SenderID:       userA,
		ClientMsgID:    uuid.NewString(),
		ContentMode:    chat.MessageContentDMPairwiseSignal,
		SenderDeviceID: senderDevice.DeviceID,
		EncryptedDMPayloads: []chat.EncryptedDMRecipientPayload{
			{
				RecipientDeviceID: senderDevice.DeviceID,
				SenderDeviceID:    senderDevice.DeviceID,
				Algorithm:         "dm-p256-aesgcm-v1",
				SessionMessage:    []byte("sender ciphertext"),
			},
		},
	})
	require.ErrorIs(t, err, chat.ErrInvalidEncryptedPayload)

	sent, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:      encrypted.DM.ConversationID,
		SenderID:       userA,
		ClientMsgID:    uuid.NewString(),
		ContentMode:    chat.MessageContentDMPairwiseSignal,
		SenderDeviceID: senderDevice.DeviceID,
		EncryptedDMPayloads: []chat.EncryptedDMRecipientPayload{
			{
				RecipientDeviceID: senderDevice.DeviceID,
				SenderDeviceID:    senderDevice.DeviceID,
				Algorithm:         "dm-p256-aesgcm-v1",
				SessionMessage:    []byte("sender ciphertext"),
			},
			{
				RecipientDeviceID: recipientDevice.DeviceID,
				SenderDeviceID:    senderDevice.DeviceID,
				Algorithm:         "dm-p256-aesgcm-v1",
				SessionMessage:    []byte("recipient ciphertext"),
			},
		},
	})
	require.NoError(t, err)

	var body string
	var contentMode string
	var ciphertextCount int
	err = pool.QueryRow(ctx, `
		SELECT m.body,
		       m.content_mode,
		       COUNT(mrc.recipient_device_id)::int
		  FROM messages m
		  LEFT JOIN message_recipient_ciphertexts mrc
		    ON mrc.message_id = m.id
		 WHERE m.id = $1
		 GROUP BY m.id`,
		sent.MessageID,
	).Scan(&body, &contentMode, &ciphertextCount)
	require.NoError(t, err)
	assert.Equal(t, "", body)
	assert.Equal(t, "dm_pairwise_signal_v1", contentMode)
	assert.Equal(t, 2, ciphertextCount)

	senderHistory, _, err := svc.ListMessagePage(ctx, userA, encrypted.DM.ConversationID, nil, 20, senderDevice.DeviceID)
	require.NoError(t, err)
	require.Len(t, senderHistory, 1)
	require.Len(t, senderHistory[0].EncryptedDMPayloads, 1)
	assert.Equal(t, senderDevice.DeviceID, senderHistory[0].EncryptedDMPayloads[0].RecipientDeviceID)

	crossDeviceHistory, _, err := svc.ListMessagePage(ctx, userA, encrypted.DM.ConversationID, nil, 20, recipientDevice.DeviceID)
	require.NoError(t, err)
	require.Len(t, crossDeviceHistory, 1)
	assert.Empty(t, crossDeviceHistory[0].EncryptedDMPayloads)

	recipientHistory, _, err := svc.ListMessagePage(ctx, userB, encrypted.DM.ConversationID, nil, 20, recipientDevice.DeviceID)
	require.NoError(t, err)
	require.Len(t, recipientHistory, 1)
	require.Len(t, recipientHistory[0].EncryptedDMPayloads, 1)
	assert.Equal(t, recipientDevice.DeviceID, recipientHistory[0].EncryptedDMPayloads[0].RecipientDeviceID)

	var storedMessageCreated *packetspb.ServerEvent
	storedEvents, listErr := store.ListEventsAfterSeq(ctx, 0, 20)
	require.NoError(t, listErr)
	for _, stored := range storedEvents {
		if stored.EventType == "message_created" {
			storedMessageCreated = stored.Proto
			break
		}
	}
	require.NotNil(t, storedMessageCreated)
	filteredForSender, err := svc.FilterEncryptedEventPayloadsForUser(ctx, storedMessageCreated, userA)
	require.NoError(t, err)
	require.NotNil(t, filteredForSender)
	require.Len(t, filteredForSender.GetMessageCreated().GetEncryptedDmPayload().GetRecipients(), 1)

	_, err = svc.EditMessage(ctx, chat.EditMessageParams{
		MessageID: sent.MessageID,
		ActorID:   userA,
		Body:      "plaintext edit must not apply",
	})
	require.ErrorIs(t, err, chat.ErrEncryptedMessageUnsupported)

	_, err = svc.ForwardMessage(ctx, chat.ForwardMessageParams{
		SourceMessageID:           sent.MessageID,
		ActorID:                   userA,
		DestinationConversationID: plaintext.DM.ConversationID,
	})
	require.ErrorIs(t, err, chat.ErrEncryptedMessageUnsupported)

	_, err = svc.AddReaction(ctx, chat.ReactionParams{
		ChannelID: encrypted.DM.ConversationID,
		MessageID: sent.MessageID,
		UserID:    userB,
		Emoji:     "ok",
	})
	require.ErrorIs(t, err, chat.ErrEncryptedMessageUnsupported)

	_, err = svc.SaveMessage(ctx, userB, sent.MessageID)
	require.NoError(t, err)
	savedItems, err := svc.ListSavedMessages(ctx, userB)
	require.NoError(t, err)
	require.Len(t, savedItems, 1)
	assert.Equal(t, "Encrypted message", savedItems[0].Body)

	unreadItems, err := svc.ListUnreadFeed(ctx, userB)
	require.NoError(t, err)
	require.NotEmpty(t, unreadItems)
	assert.Equal(t, "Encrypted message", unreadItems[0].Body)

	clearResult, err := svc.ClearDMConversationHistory(ctx, chat.ClearDMConversationHistoryParams{
		ConversationID: encrypted.DM.ConversationID,
		ActorID:        userB,
	})
	require.NoError(t, err)
	assert.Equal(t, int32(1), clearResult.DeletedMessagesCount)

	var remainingMessages int
	err = pool.QueryRow(ctx, `SELECT COUNT(*)::int FROM messages WHERE channel_id = $1`, encrypted.DM.ConversationID).Scan(&remainingMessages)
	require.NoError(t, err)
	assert.Equal(t, 0, remainingMessages)

	var remainingCiphertexts int
	err = pool.QueryRow(ctx, `SELECT COUNT(*)::int FROM message_recipient_ciphertexts WHERE message_id = $1`, sent.MessageID).Scan(&remainingCiphertexts)
	require.NoError(t, err)
	assert.Equal(t, 0, remainingCiphertexts)
}

func TestIntegration_ActivateRecoveredDevice_ReactivatesOwnerDeviceAndRetiresTemporaryDevice(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	ownerID := seedChatUserWithAttrs(t, ctx, pool, "Recovery Owner", "member", "active")
	otherUserID := seedChatUserWithAttrs(t, ctx, pool, "Recovery Other", "member", "active")
	restoredDeviceID := uuid.New()
	temporaryDeviceID := uuid.New()
	otherDeviceID := uuid.New()

	restored, err := svc.RegisterDevice(ctx, chat.RegisterDeviceParams{
		DeviceID:              restoredDeviceID,
		UserID:                ownerID,
		DeviceLabel:           "old browser",
		IdentityKeyPublic:     []byte("restored identity"),
		SignedPrekeyID:        1,
		SignedPrekeyPublic:    []byte("restored prekey"),
		SignedPrekeySignature: []byte("restored signature"),
	})
	require.NoError(t, err)
	_, err = svc.RegisterDevice(ctx, chat.RegisterDeviceParams{
		DeviceID:              temporaryDeviceID,
		UserID:                ownerID,
		DeviceLabel:           "temporary browser",
		IdentityKeyPublic:     []byte("temporary identity"),
		SignedPrekeyID:        1,
		SignedPrekeyPublic:    []byte("temporary prekey"),
		SignedPrekeySignature: []byte("temporary signature"),
	})
	require.NoError(t, err)
	_, err = svc.RegisterDevice(ctx, chat.RegisterDeviceParams{
		DeviceID:              otherDeviceID,
		UserID:                otherUserID,
		IdentityKeyPublic:     []byte("other identity"),
		SignedPrekeyID:        1,
		SignedPrekeyPublic:    []byte("other prekey"),
		SignedPrekeySignature: []byte("other signature"),
	})
	require.NoError(t, err)

	_, err = pool.Exec(ctx, `UPDATE user_devices SET revoked_at = now() WHERE id = $1`, restoredDeviceID)
	require.NoError(t, err)

	activated, err := svc.ActivateRecoveredDevice(ctx, chat.ActivateRecoveredDeviceParams{
		RegisterDeviceParams: chat.RegisterDeviceParams{
			DeviceID:              restoredDeviceID,
			UserID:                ownerID,
			DeviceLabel:           "new browser",
			IdentityKeyPublic:     restored.IdentityKeyPublic,
			SignedPrekeyID:        restored.SignedPrekeyID,
			SignedPrekeyPublic:    restored.SignedPrekeyPublic,
			SignedPrekeySignature: restored.SignedPrekeySignature,
		},
		ReplaceDeviceID: temporaryDeviceID,
	})
	require.NoError(t, err)
	assert.Equal(t, restoredDeviceID, activated.DeviceID)
	assert.Equal(t, "new browser", activated.DeviceLabel)

	var restoredActive, temporaryActive bool
	err = pool.QueryRow(ctx, `SELECT revoked_at IS NULL FROM user_devices WHERE id = $1`, restoredDeviceID).Scan(&restoredActive)
	require.NoError(t, err)
	err = pool.QueryRow(ctx, `SELECT revoked_at IS NULL FROM user_devices WHERE id = $1`, temporaryDeviceID).Scan(&temporaryActive)
	require.NoError(t, err)
	assert.True(t, restoredActive)
	assert.False(t, temporaryActive)

	_, err = svc.ActivateRecoveredDevice(ctx, chat.ActivateRecoveredDeviceParams{
		RegisterDeviceParams: chat.RegisterDeviceParams{
			DeviceID:              otherDeviceID,
			UserID:                ownerID,
			IdentityKeyPublic:     []byte("attempted overwrite"),
			SignedPrekeyID:        1,
			SignedPrekeyPublic:    []byte("attempted prekey"),
			SignedPrekeySignature: []byte("attempted signature"),
		},
	})
	require.ErrorIs(t, err, chat.ErrE2EERecoveryDeviceOwnership)

	var otherActive bool
	err = pool.QueryRow(ctx, `SELECT revoked_at IS NULL FROM user_devices WHERE id = $1`, otherDeviceID).Scan(&otherActive)
	require.NoError(t, err)
	assert.True(t, otherActive)
}

func TestIntegration_ClearDMConversationHistory_HardDeletesMessagesAndKeepsDM(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	userA := seedChatUserWithAttrs(t, ctx, pool, "Clear Actor", "member", "active")
	userB := seedChatUserWithAttrs(t, ctx, pool, "Clear Peer", "member", "active")

	dm, err := svc.CreateOrOpenDirectMessage(ctx, userA, userB)
	require.NoError(t, err)
	conversationID := dm.DM.ConversationID

	_, err = pool.Exec(ctx,
		`UPDATE channel_members
		    SET notification_level = $3
		  WHERE channel_id = $1
		    AND user_id = $2`,
		conversationID,
		userA,
		int16(packetspb.NotificationLevel_NOTIFICATION_LEVEL_MENTIONS_ONLY),
	)
	require.NoError(t, err)

	root, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   conversationID,
		SenderID:    userA,
		ClientMsgID: "root-" + uuid.NewString(),
		Body:        "root message",
	})
	require.NoError(t, err)

	reply, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:           conversationID,
		SenderID:            userB,
		ClientMsgID:         "reply-" + uuid.NewString(),
		Body:                "reply message",
		ThreadRootMessageID: root.MessageID,
	})
	require.NoError(t, err)

	_, err = svc.SaveMessage(ctx, userA, root.MessageID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `
		INSERT INTO message_mentions (message_id, user_id)
		VALUES ($1, $2)`,
		root.MessageID,
		userB,
	)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `
		INSERT INTO message_entities (message_id, ordinal, kind, target_id, label, href, start_offset, end_offset)
		VALUES ($1, 0, 'user', $2, 'Clear Peer', '', 0, 10)`,
		root.MessageID,
		userB,
	)
	require.NoError(t, err)
	_, err = svc.AddReaction(ctx, chat.ReactionParams{
		ChannelID:  conversationID,
		MessageID:  root.MessageID,
		UserID:     userB,
		Emoji:      ":+1:",
		ClientOpID: "react-" + uuid.NewString(),
	})
	require.NoError(t, err)

	_, err = pool.Exec(ctx, `
		INSERT INTO message_attachment (conversation_id, message_id, file_name, file_size, mime_type, storage_key, uploaded_by)
		VALUES ($1, $2, 'root.txt', 12, 'text/plain', 'chat/root.txt', $3)`,
		conversationID,
		root.MessageID,
		userA,
	)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `
		INSERT INTO thread_reads (root_message_id, user_id, last_read_thread_seq)
		VALUES ($1, $2, 1)`,
		root.MessageID,
		userA,
	)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `
		INSERT INTO notifications (user_id, type, title, body, channel_id, message_id, thread_root_message_id)
		VALUES ($1, 'mention', 'Mention', 'body should be deleted', $2, $3, NULL),
		       ($1, 'thread_reply', 'Thread', 'thread body should be deleted', $2, $4, $3)`,
		userA,
		conversationID,
		root.MessageID,
		reply.MessageID,
	)
	require.NoError(t, err)

	result, err := svc.ClearDMConversationHistory(ctx, chat.ClearDMConversationHistoryParams{
		ConversationID: conversationID,
		ActorID:        userA,
	})
	require.NoError(t, err)
	assert.Equal(t, conversationID, result.ConversationID)
	assert.Equal(t, int32(2), result.DeletedMessagesCount)

	countRows := func(query string, args ...any) int {
		t.Helper()
		var count int
		err := pool.QueryRow(ctx, query, args...).Scan(&count)
		require.NoError(t, err)
		return count
	}
	assert.Equal(t, 0, countRows(`SELECT COUNT(*) FROM messages WHERE channel_id = $1`, conversationID))
	assert.Equal(t, 0, countRows(`SELECT COUNT(*) FROM message_saves`))
	assert.Equal(t, 0, countRows(`SELECT COUNT(*) FROM reactions`))
	assert.Equal(t, 0, countRows(`SELECT COUNT(*) FROM reaction_counts`))
	assert.Equal(t, 0, countRows(`SELECT COUNT(*) FROM message_mentions`))
	assert.Equal(t, 0, countRows(`SELECT COUNT(*) FROM message_entities`))
	assert.Equal(t, 0, countRows(`SELECT COUNT(*) FROM message_attachment`))
	assert.Equal(t, 0, countRows(`SELECT COUNT(*) FROM thread_summaries`))
	assert.Equal(t, 0, countRows(`SELECT COUNT(*) FROM thread_reads`))
	assert.Equal(t, 0, countRows(`SELECT COUNT(*) FROM notifications WHERE channel_id = $1`, conversationID))

	var memberCount int
	err = pool.QueryRow(ctx,
		`SELECT COUNT(*)
		   FROM channel_members
		  WHERE channel_id = $1
		    AND is_archived = false`,
		conversationID,
	).Scan(&memberCount)
	require.NoError(t, err)
	assert.Equal(t, 2, memberCount)

	var notificationLevel int16
	err = pool.QueryRow(ctx,
		`SELECT notification_level
		   FROM channel_members
		  WHERE channel_id = $1
		    AND user_id = $2`,
		conversationID,
		userA,
	).Scan(&notificationLevel)
	require.NoError(t, err)
	assert.Equal(t, int16(packetspb.NotificationLevel_NOTIFICATION_LEVEL_MENTIONS_ONLY), notificationLevel)

	storedEvents, err := store.ListEventsAfterSeq(ctx, 0, 20)
	require.NoError(t, err)
	var clearEvent *packetspb.DmHistoryClearedEvent
	for _, stored := range storedEvents {
		if stored.EventType == "dm_history_cleared" {
			clearEvent = stored.Proto.GetDmHistoryCleared()
			break
		}
	}
	require.NotNil(t, clearEvent)
	assert.Equal(t, conversationID.String(), clearEvent.GetConversationId())
	assert.Equal(t, userA.String(), clearEvent.GetClearedByUserId())
	assert.Equal(t, int32(2), clearEvent.GetDeletedMessagesCount())

	next, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   conversationID,
		SenderID:    userB,
		ClientMsgID: "after-clear-" + uuid.NewString(),
		Body:        "new start",
	})
	require.NoError(t, err)
	assert.Greater(t, next.ChannelSeq, reply.ChannelSeq)

	secondClear, err := svc.ClearDMConversationHistory(ctx, chat.ClearDMConversationHistoryParams{
		ConversationID: conversationID,
		ActorID:        userB,
	})
	require.NoError(t, err)
	assert.Equal(t, int32(1), secondClear.DeletedMessagesCount)
}

func TestIntegration_ClearDMConversationHistory_RejectsUnsupportedOrUnauthorized(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	userA := seedChatUserWithAttrs(t, ctx, pool, "Clear A", "member", "active")
	userB := seedChatUserWithAttrs(t, ctx, pool, "Clear B", "member", "active")
	outsider := seedChatUserWithAttrs(t, ctx, pool, "Clear Outsider", "member", "active")

	dm, err := svc.CreateOrOpenDirectMessage(ctx, userA, userB)
	require.NoError(t, err)

	_, err = svc.ClearDMConversationHistory(ctx, chat.ClearDMConversationHistoryParams{
		ConversationID: dm.DM.ConversationID,
		ActorID:        outsider,
	})
	assert.ErrorIs(t, err, chat.ErrNotMember)

	channelID := seedChannelForUser(t, ctx, pool, userA, "clear unsupported")
	_, err = svc.ClearDMConversationHistory(ctx, chat.ClearDMConversationHistoryParams{
		ConversationID: channelID,
		ActorID:        userA,
	})
	assert.ErrorIs(t, err, chat.ErrClearHistoryUnsupported)
}

func TestIntegration_CreateOrOpenDirectMessage_SelfUsesSingleMemberConversation(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	var selfID uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'Ada', 'member')
		 RETURNING id`,
		"ada_"+uuid.New().String()+"@example.com",
	).Scan(&selfID)
	require.NoError(t, err)

	created, err := svc.CreateOrOpenDirectMessage(ctx, selfID, selfID)
	require.NoError(t, err)
	assert.Equal(t, selfID, created.DM.UserID)
	assert.Equal(t, "Ada", created.DM.DisplayName)
	assert.Equal(t, "dm", created.DM.Visibility)
	require.Len(t, created.DirectDeliveries, 1)
	assert.Equal(t, selfID.String(), created.DirectDeliveries[0].UserID)
	require.NotNil(t, created.DirectDeliveries[0].Event.GetConversationUpserted())
	assert.Equal(t, selfID.String(), created.DirectDeliveries[0].Event.GetConversationUpserted().GetConversation().GetTopic())

	second, err := svc.CreateOrOpenDirectMessage(ctx, selfID, selfID)
	require.NoError(t, err)
	assert.Equal(t, created.DM.ConversationID, second.DM.ConversationID)
	assert.Empty(t, second.DirectDeliveries)

	var memberCount int
	err = pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM channel_members WHERE channel_id = $1`,
		created.DM.ConversationID,
	).Scan(&memberCount)
	require.NoError(t, err)
	assert.Equal(t, 1, memberCount)
}

func TestIntegration_CreateOrOpenDirectMessage_ReopensArchivedPair(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	var selfID uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'Ada', 'member')
		 RETURNING id`,
		"ada_"+uuid.New().String()+"@example.com",
	).Scan(&selfID)
	require.NoError(t, err)

	var otherID uuid.UUID
	err = pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'Bob', 'member')
		 RETURNING id`,
		"bob_"+uuid.New().String()+"@example.com",
	).Scan(&otherID)
	require.NoError(t, err)

	created, err := svc.CreateOrOpenDirectMessage(ctx, selfID, otherID)
	require.NoError(t, err)
	require.Len(t, created.DirectDeliveries, 2)

	_, err = svc.LeaveConversation(ctx, selfID, created.DM.ConversationID)
	require.NoError(t, err)

	reopened, err := svc.CreateOrOpenDirectMessage(ctx, selfID, otherID)
	require.NoError(t, err)
	assert.Equal(t, created.DM.ConversationID, reopened.DM.ConversationID)
	require.Len(t, reopened.DirectDeliveries, 2)

	var archivedCount int
	err = pool.QueryRow(ctx, `
		SELECT COUNT(*)
		  FROM channel_members
		 WHERE channel_id = $1
		   AND is_archived = true`,
		reopened.DM.ConversationID,
	).Scan(&archivedCount)
	require.NoError(t, err)
	assert.Equal(t, 0, archivedCount)
}

func TestIntegration_CreateOrOpenDirectMessage_ReusesArchivedDMChannel(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	var selfID uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'Ada', 'member')
		 RETURNING id`,
		"ada_"+uuid.New().String()+"@example.com",
	).Scan(&selfID)
	require.NoError(t, err)

	var otherID uuid.UUID
	err = pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'Bob', 'member')
		 RETURNING id`,
		"bob_"+uuid.New().String()+"@example.com",
	).Scan(&otherID)
	require.NoError(t, err)

	created, err := svc.CreateOrOpenDirectMessage(ctx, selfID, otherID)
	require.NoError(t, err)

	_, err = pool.Exec(ctx, `UPDATE channels SET is_archived = true WHERE id = $1`, created.DM.ConversationID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `
		UPDATE channel_members
		   SET is_archived = true
		 WHERE channel_id = $1
		   AND user_id = $2`,
		created.DM.ConversationID, selfID,
	)
	require.NoError(t, err)

	reopened, err := svc.CreateOrOpenDirectMessage(ctx, selfID, otherID)
	require.NoError(t, err)
	assert.Equal(t, created.DM.ConversationID, reopened.DM.ConversationID)

	var dmChannelCount int
	err = pool.QueryRow(ctx, `SELECT COUNT(*) FROM channels WHERE kind = 'dm'`).Scan(&dmChannelCount)
	require.NoError(t, err)
	assert.Equal(t, 1, dmChannelCount)
}

func TestIntegration_LeaveConversation_RejectsSelfDm(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	var selfID uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'Ada', 'member')
		 RETURNING id`,
		"ada_"+uuid.New().String()+"@example.com",
	).Scan(&selfID)
	require.NoError(t, err)

	created, err := svc.CreateOrOpenDirectMessage(ctx, selfID, selfID)
	require.NoError(t, err)

	_, err = svc.LeaveConversation(ctx, selfID, created.DM.ConversationID)
	require.ErrorIs(t, err, chat.ErrSelfDMProtected)

	var archivedCount int
	err = pool.QueryRow(ctx, `
		SELECT COUNT(*)
		  FROM channel_members
		 WHERE channel_id = $1
		   AND is_archived = true`,
		created.DM.ConversationID,
	).Scan(&archivedCount)
	require.NoError(t, err)
	assert.Equal(t, 0, archivedCount)
}

func TestIntegration_SendMessage_ReopensArchivedDMPeerWithUnread(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	var userA uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'User A', 'member')
		 RETURNING id`,
		"usera_"+uuid.New().String()+"@example.com",
	).Scan(&userA)
	require.NoError(t, err)

	var userB uuid.UUID
	err = pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'User B', 'member')
		 RETURNING id`,
		"userb_"+uuid.New().String()+"@example.com",
	).Scan(&userB)
	require.NoError(t, err)

	dm, err := svc.CreateOrOpenDirectMessage(ctx, userA, userB)
	require.NoError(t, err)

	_, err = pool.Exec(ctx,
		`INSERT INTO user_presence (user_id, status) VALUES ($1, 'online')
		 ON CONFLICT (user_id) DO UPDATE SET status = EXCLUDED.status`,
		userB,
	)
	require.NoError(t, err)

	_, err = svc.LeaveConversation(ctx, userA, dm.DM.ConversationID)
	require.NoError(t, err)

	sendResult, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   dm.DM.ConversationID,
		SenderID:    userB,
		ClientMsgID: uuid.New().String(),
		Body:        "hello after leave",
	})
	require.NoError(t, err)

	var isArchived bool
	err = pool.QueryRow(ctx,
		`SELECT is_archived FROM channel_members WHERE channel_id = $1 AND user_id = $2`,
		dm.DM.ConversationID, userA,
	).Scan(&isArchived)
	require.NoError(t, err)
	assert.False(t, isArchived)

	var sawUpsert bool
	var upsertPresence packetspb.PresenceStatus
	for _, delivery := range sendResult.DirectDeliveries {
		if delivery.UserID != userA.String() || delivery.Event == nil {
			continue
		}
		switch delivery.Event.GetEventType() {
		case packetspb.EventType_EVENT_TYPE_CONVERSATION_UPSERTED:
			sawUpsert = true
			upsertPresence = delivery.Event.GetConversationUpserted().GetConversation().GetPresence()
		}
	}
	assert.True(t, sawUpsert)
	assert.Equal(t, packetspb.PresenceStatus_PRESENCE_STATUS_ONLINE, upsertPresence)

	messages, _, err := svc.ListMessagePage(ctx, userA, dm.DM.ConversationID, nil, 20)
	require.NoError(t, err)
	require.Len(t, messages, 1)
	assert.Equal(t, "hello after leave", messages[0].Body)
}

func TestIntegration_SendMessage_MessageAlertForDirectMessagePeer(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	var userA uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'User A', 'member')
		 RETURNING id`,
		"usera_"+uuid.New().String()+"@example.com",
	).Scan(&userA)
	require.NoError(t, err)

	var userB uuid.UUID
	err = pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'User B', 'member')
		 RETURNING id`,
		"userb_"+uuid.New().String()+"@example.com",
	).Scan(&userB)
	require.NoError(t, err)

	dm, err := svc.CreateOrOpenDirectMessage(ctx, userA, userB)
	require.NoError(t, err)

	result, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   dm.DM.ConversationID,
		SenderID:    userA,
		ClientMsgID: uuid.New().String(),
		Body:        "hello dm",
	})
	require.NoError(t, err)
	alertDeliveries := filterDirectDeliveriesByType(result.DirectDeliveries, packetspb.EventType_EVENT_TYPE_MESSAGE_ALERT)
	require.Len(t, alertDeliveries, 1)
	assert.Equal(t, userB.String(), alertDeliveries[0].UserID)

	readCounterDeliveries := filterDirectDeliveriesByType(result.DirectDeliveries, packetspb.EventType_EVENT_TYPE_READ_COUNTER_UPDATED)
	require.Len(t, readCounterDeliveries, 2)
}

func TestIntegration_SendMessage_MessageAlertForDirectMessageHonorsHardMute(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	var userA uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'User A', 'member')
		 RETURNING id`,
		"usera_"+uuid.New().String()+"@example.com",
	).Scan(&userA)
	require.NoError(t, err)

	var userB uuid.UUID
	err = pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'User B', 'member')
		 RETURNING id`,
		"userb_"+uuid.New().String()+"@example.com",
	).Scan(&userB)
	require.NoError(t, err)

	dm, err := svc.CreateOrOpenDirectMessage(ctx, userA, userB)
	require.NoError(t, err)
	setChannelMemberNotificationLevel(t, ctx, pool, dm.DM.ConversationID, userB, int16(packetspb.NotificationLevel_NOTIFICATION_LEVEL_NOTHING))

	result, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   dm.DM.ConversationID,
		SenderID:    userA,
		ClientMsgID: uuid.New().String(),
		Body:        "hello muted dm",
	})
	require.NoError(t, err)
	assert.Empty(t, filterDirectDeliveriesByType(result.DirectDeliveries, packetspb.EventType_EVENT_TYPE_MESSAGE_ALERT))
	readCounterDeliveries := filterDirectDeliveriesByType(result.DirectDeliveries, packetspb.EventType_EVENT_TYPE_READ_COUNTER_UPDATED)
	require.Len(t, readCounterDeliveries, 2)
}

func TestIntegration_SendMessage_MessageAlertForDirectMessageAllowsMentionsOnly(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	var userA uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'User A', 'member')
		 RETURNING id`,
		"usera_"+uuid.New().String()+"@example.com",
	).Scan(&userA)
	require.NoError(t, err)

	var userB uuid.UUID
	err = pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'User B', 'member')
		 RETURNING id`,
		"userb_"+uuid.New().String()+"@example.com",
	).Scan(&userB)
	require.NoError(t, err)

	dm, err := svc.CreateOrOpenDirectMessage(ctx, userA, userB)
	require.NoError(t, err)
	setChannelMemberNotificationLevel(t, ctx, pool, dm.DM.ConversationID, userB, int16(packetspb.NotificationLevel_NOTIFICATION_LEVEL_MENTIONS_ONLY))

	result, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   dm.DM.ConversationID,
		SenderID:    userA,
		ClientMsgID: uuid.New().String(),
		Body:        "hello dm mentions only",
	})
	require.NoError(t, err)
	alertDeliveries := filterDirectDeliveriesByType(result.DirectDeliveries, packetspb.EventType_EVENT_TYPE_MESSAGE_ALERT)
	require.Len(t, alertDeliveries, 1)
	assert.Equal(t, userB.String(), alertDeliveries[0].UserID)
}

func TestIntegration_LeaveConversation_ArchivesMembershipAndIsIdempotent(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	userID, channelID := seedUserAndChannel(t, ctx, pool)

	_, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    userID,
		ClientMsgID: uuid.New().String(),
		Body:        "history should remain",
	})
	require.NoError(t, err)

	first, err := svc.LeaveConversation(ctx, userID, channelID)
	require.NoError(t, err)
	require.Len(t, first.DirectDeliveries, 1)
	require.NotNil(t, first.DirectDeliveries[0].Event)
	assert.Equal(t, packetspb.EventType_EVENT_TYPE_CONVERSATION_REMOVED, first.DirectDeliveries[0].Event.GetEventType())

	second, err := svc.LeaveConversation(ctx, userID, channelID)
	require.NoError(t, err)
	require.Len(t, second.DirectDeliveries, 0)

	var isArchived bool
	err = pool.QueryRow(ctx,
		`SELECT is_archived FROM channel_members WHERE channel_id = $1 AND user_id = $2`,
		channelID, userID,
	).Scan(&isArchived)
	require.NoError(t, err)
	assert.True(t, isArchived)

	var msgCount int
	err = pool.QueryRow(ctx, `SELECT COUNT(*) FROM messages WHERE channel_id = $1`, channelID).Scan(&msgCount)
	require.NoError(t, err)
	assert.Equal(t, 1, msgCount)

	_, _, err = svc.ListMessagePage(ctx, userID, channelID, nil, 20)
	require.Error(t, err)
	assert.True(t, errors.Is(err, chat.ErrNotMember))
}

func TestIntegration_RemoveConversationMember_PublicAdminOrOwnerArchivesMembershipAndRevokesAccess(t *testing.T) {
	for _, role := range []string{"admin", "owner"} {
		t.Run(role, func(t *testing.T) {
			pool, _ := testdb.New(t)
			ctx := context.Background()

			store := events.NewStore(pool)
			svc := chat.NewService(pool, store)

			requesterID := seedChatUserWithAttrs(t, ctx, pool, "Requester "+role, role, "active")
			targetID := seedChatUserWithAttrs(t, ctx, pool, "Target "+role, "member", "active")
			channelID := seedChannelForUserWithVisibility(t, ctx, pool, requesterID, "Public "+role, "public")
			_, err := pool.Exec(ctx,
				`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`,
				channelID, targetID,
			)
			require.NoError(t, err)

			result, err := svc.RemoveConversationMember(ctx, requesterID, role, channelID, targetID)
			require.NoError(t, err)
			removedDeliveries := filterDirectDeliveriesByType(result.DirectDeliveries, packetspb.EventType_EVENT_TYPE_CONVERSATION_REMOVED)
			require.Len(t, removedDeliveries, 1)
			assert.Equal(t, targetID.String(), removedDeliveries[0].UserID)
			require.NotNil(t, removedDeliveries[0].Event)
			assert.Equal(
				t,
				packetspb.ConversationRemovedReason_CONVERSATION_REMOVED_REASON_ACCESS_REVOKED,
				removedDeliveries[0].Event.GetConversationRemoved().GetReason(),
			)

			var isArchived bool
			err = pool.QueryRow(ctx,
				`SELECT is_archived FROM channel_members WHERE channel_id = $1 AND user_id = $2`,
				channelID, targetID,
			).Scan(&isArchived)
			require.NoError(t, err)
			assert.True(t, isArchived)

			var rowCount int
			err = pool.QueryRow(ctx,
				`SELECT COUNT(*) FROM channel_members WHERE channel_id = $1 AND user_id = $2`,
				channelID, targetID,
			).Scan(&rowCount)
			require.NoError(t, err)
			assert.Equal(t, 1, rowCount)

			var body string
			err = pool.QueryRow(ctx,
				`SELECT body FROM messages WHERE channel_id = $1 ORDER BY channel_seq DESC LIMIT 1`,
				channelID,
			).Scan(&body)
			require.NoError(t, err)
			assert.Equal(t, "@Target "+role+" was removed from this channel by @Requester "+role, body)
		})
	}
}

func TestIntegration_RemoveConversationMember_PublicMemberForbidden(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	requesterID := seedChatUserWithAttrs(t, ctx, pool, "Requester", "member", "active")
	targetID := seedChatUserWithAttrs(t, ctx, pool, "Target", "member", "active")
	channelID := seedChannelForUserWithVisibility(t, ctx, pool, requesterID, "Public", "public")
	_, err := pool.Exec(ctx,
		`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`,
		channelID, targetID,
	)
	require.NoError(t, err)

	_, err = svc.RemoveConversationMember(ctx, requesterID, "member", channelID, targetID)
	require.ErrorIs(t, err, chat.ErrRemoveMemberForbidden)

	var isArchived bool
	err = pool.QueryRow(ctx,
		`SELECT is_archived FROM channel_members WHERE channel_id = $1 AND user_id = $2`,
		channelID, targetID,
	).Scan(&isArchived)
	require.NoError(t, err)
	assert.False(t, isArchived)
}

func TestIntegration_RemoveConversationMember_PrivateMemberArchivesMembership(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	requesterID := seedChatUserWithAttrs(t, ctx, pool, "Requester", "member", "active")
	targetID := seedChatUserWithAttrs(t, ctx, pool, "Target", "member", "active")
	channelID := seedChannelForUserWithVisibility(t, ctx, pool, requesterID, "Private", "private")
	_, err := pool.Exec(ctx,
		`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`,
		channelID, targetID,
	)
	require.NoError(t, err)

	result, err := svc.RemoveConversationMember(ctx, requesterID, "member", channelID, targetID)
	require.NoError(t, err)
	removedDeliveries := filterDirectDeliveriesByType(result.DirectDeliveries, packetspb.EventType_EVENT_TYPE_CONVERSATION_REMOVED)
	require.Len(t, removedDeliveries, 1)
	assert.Equal(t, targetID.String(), removedDeliveries[0].UserID)
	require.NotNil(t, removedDeliveries[0].Event)
	assert.Equal(
		t,
		packetspb.ConversationRemovedReason_CONVERSATION_REMOVED_REASON_ACCESS_REVOKED,
		removedDeliveries[0].Event.GetConversationRemoved().GetReason(),
	)

	var isArchived bool
	err = pool.QueryRow(ctx,
		`SELECT is_archived FROM channel_members WHERE channel_id = $1 AND user_id = $2`,
		channelID, targetID,
	).Scan(&isArchived)
	require.NoError(t, err)
	assert.True(t, isArchived)

	var body string
	err = pool.QueryRow(ctx,
		`SELECT body FROM messages WHERE channel_id = $1 ORDER BY channel_seq DESC LIMIT 1`,
		channelID,
	).Scan(&body)
	require.NoError(t, err)
	assert.Equal(t, "@Target was removed from this channel by @Requester", body)
}

func TestIntegration_RemoveConversationMember_PrivateNonMemberRequesterRejected(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	creatorID := seedChatUserWithAttrs(t, ctx, pool, "Creator", "member", "active")
	requesterID := seedChatUserWithAttrs(t, ctx, pool, "Requester", "member", "active")
	targetID := seedChatUserWithAttrs(t, ctx, pool, "Target", "member", "active")
	channelID := seedChannelForUserWithVisibility(t, ctx, pool, creatorID, "Private", "private")
	_, err := pool.Exec(ctx,
		`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`,
		channelID, targetID,
	)
	require.NoError(t, err)

	_, err = svc.RemoveConversationMember(ctx, requesterID, "member", channelID, targetID)
	require.ErrorIs(t, err, chat.ErrNotMember)

	var isArchived bool
	err = pool.QueryRow(ctx,
		`SELECT is_archived FROM channel_members WHERE channel_id = $1 AND user_id = $2`,
		channelID, targetID,
	).Scan(&isArchived)
	require.NoError(t, err)
	assert.False(t, isArchived)
}

func TestIntegration_RemoveConversationMember_RejectsSelfRemoval(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	userID, channelID := seedUserAndChannel(t, ctx, pool)

	_, err := svc.RemoveConversationMember(ctx, userID, "admin", channelID, userID)
	require.ErrorIs(t, err, chat.ErrRemoveMemberForbidden)

	var isArchived bool
	err = pool.QueryRow(ctx,
		`SELECT is_archived FROM channel_members WHERE channel_id = $1 AND user_id = $2`,
		channelID, userID,
	).Scan(&isArchived)
	require.NoError(t, err)
	assert.False(t, isArchived)
}

func TestIntegration_ListAvailablePublicChannels_ExcludesJoinedPrivateArchivedAndDM(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	var userID uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'Self', 'member')
		 RETURNING id`,
		"self_"+uuid.New().String()+"@example.com",
	).Scan(&userID)
	require.NoError(t, err)

	var publicJoinedID uuid.UUID
	err = pool.QueryRow(ctx,
		`INSERT INTO channels (kind, visibility, name, created_by)
		 VALUES ('channel', 'public', 'Joined', $1)
		 RETURNING id`,
		userID,
	).Scan(&publicJoinedID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`, publicJoinedID, userID)
	require.NoError(t, err)

	var publicAvailableOne uuid.UUID
	err = pool.QueryRow(ctx,
		`INSERT INTO channels (kind, visibility, name, created_by)
		 VALUES ('channel', 'public', 'Alpha', $1)
		 RETURNING id`,
		userID,
	).Scan(&publicAvailableOne)
	require.NoError(t, err)

	var publicAvailableTwo uuid.UUID
	err = pool.QueryRow(ctx,
		`INSERT INTO channels (kind, visibility, name, created_by)
		 VALUES ('channel', 'public', 'Zulu', $1)
		 RETURNING id`,
		userID,
	).Scan(&publicAvailableTwo)
	require.NoError(t, err)

	_, err = pool.Exec(ctx,
		`INSERT INTO channels (kind, visibility, name, created_by)
		 VALUES ('channel', 'private', 'Private', $1),
		        ('dm', 'dm', '', $1),
		        ('channel', 'public', 'Archived', $1)`,
		userID,
	)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE channels SET is_archived = true WHERE name = 'Archived'`)
	require.NoError(t, err)

	channels, err := svc.ListAvailablePublicChannels(ctx, userID)
	require.NoError(t, err)
	require.Len(t, channels, 2)
	assert.Equal(t, publicAvailableOne, channels[0].ID)
	assert.Equal(t, publicAvailableTwo, channels[1].ID)
}

func TestIntegration_JoinPublicChannels_JoinsInRequestedOrder(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	var userID uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'Self', 'member')
		 RETURNING id`,
		"self_"+uuid.New().String()+"@example.com",
	).Scan(&userID)
	require.NoError(t, err)

	var channelA uuid.UUID
	err = pool.QueryRow(ctx,
		`INSERT INTO channels (kind, visibility, name, created_by)
		 VALUES ('channel', 'public', 'Alpha', $1)
		 RETURNING id`,
		userID,
	).Scan(&channelA)
	require.NoError(t, err)

	var channelB uuid.UUID
	err = pool.QueryRow(ctx,
		`INSERT INTO channels (kind, visibility, name, created_by)
		 VALUES ('channel', 'public', 'Beta', $1)
		 RETURNING id`,
		userID,
	).Scan(&channelB)
	require.NoError(t, err)

	joined, err := svc.JoinPublicChannels(ctx, userID, []uuid.UUID{channelB, channelA, channelB})
	require.NoError(t, err)
	require.Len(t, joined, 2)
	assert.Equal(t, channelB, joined[0].ID)
	assert.Equal(t, channelA, joined[1].ID)

	var memberCount int
	err = pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM channel_members
		  WHERE user_id = $1 AND channel_id IN ($2, $3)`,
		userID, channelA, channelB,
	).Scan(&memberCount)
	require.NoError(t, err)
	assert.Equal(t, 2, memberCount)
}

func TestIntegration_JoinPublicChannels_RestoresArchivedMembership(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	var userID uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'Self', 'member')
		 RETURNING id`,
		"self_"+uuid.New().String()+"@example.com",
	).Scan(&userID)
	require.NoError(t, err)

	var channelID uuid.UUID
	err = pool.QueryRow(ctx,
		`INSERT INTO channels (kind, visibility, name, created_by)
		 VALUES ('channel', 'public', 'Alpha', $1)
		 RETURNING id`,
		userID,
	).Scan(&channelID)
	require.NoError(t, err)

	_, err = pool.Exec(ctx,
		`INSERT INTO channel_members (channel_id, user_id, is_archived) VALUES ($1, $2, true)`,
		channelID, userID,
	)
	require.NoError(t, err)

	joined, err := svc.JoinPublicChannels(ctx, userID, []uuid.UUID{channelID})
	require.NoError(t, err)
	require.Len(t, joined, 1)
	assert.Equal(t, channelID, joined[0].ID)

	var isArchived bool
	err = pool.QueryRow(ctx,
		`SELECT is_archived FROM channel_members WHERE channel_id = $1 AND user_id = $2`,
		channelID, userID,
	).Scan(&isArchived)
	require.NoError(t, err)
	assert.False(t, isArchived)
}

func TestIntegration_InviteToChannel_PrivateRestoresArchivedMembership(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	var requesterID uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'Requester', 'member')
		 RETURNING id`,
		"requester_"+uuid.New().String()+"@example.com",
	).Scan(&requesterID)
	require.NoError(t, err)

	var targetID uuid.UUID
	err = pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'Target', 'member')
		 RETURNING id`,
		"target_"+uuid.New().String()+"@example.com",
	).Scan(&targetID)
	require.NoError(t, err)

	var channelID uuid.UUID
	err = pool.QueryRow(ctx,
		`INSERT INTO channels (kind, visibility, name, created_by)
		 VALUES ('channel', 'private', 'Private', $1)
		 RETURNING id`,
		requesterID,
	).Scan(&channelID)
	require.NoError(t, err)

	_, err = pool.Exec(ctx,
		`INSERT INTO channel_members (channel_id, user_id, is_archived)
		 VALUES ($1, $2, false), ($1, $3, true)`,
		channelID, requesterID, targetID,
	)
	require.NoError(t, err)

	result, err := svc.InviteToChannel(ctx, requesterID, channelID, targetID)
	require.NoError(t, err)
	require.NotEmpty(t, result.DirectDeliveries)
	require.NotNil(t, result.DirectDeliveries[0].Event)
	assert.Equal(t, packetspb.EventType_EVENT_TYPE_CONVERSATION_UPSERTED, result.DirectDeliveries[0].Event.GetEventType())

	var isArchived bool
	err = pool.QueryRow(ctx,
		`SELECT is_archived FROM channel_members WHERE channel_id = $1 AND user_id = $2`,
		channelID, targetID,
	).Scan(&isArchived)
	require.NoError(t, err)
	assert.False(t, isArchived)

	var body string
	err = pool.QueryRow(ctx,
		`SELECT body FROM messages WHERE channel_id = $1 ORDER BY channel_seq DESC LIMIT 1`,
		channelID,
	).Scan(&body)
	require.NoError(t, err)
	assert.Equal(t, "@Target was added to this channel by @Requester", body)

	rows, err := pool.Query(ctx,
		`SELECT label, target_id
		   FROM message_entities me
		   JOIN messages m ON m.id = me.message_id
		  WHERE m.channel_id = $1
		  ORDER BY m.channel_seq DESC, me.ordinal ASC
		  LIMIT 2`,
		channelID,
	)
	require.NoError(t, err)
	defer rows.Close()

	type entityRow struct {
		label  string
		target uuid.UUID
	}
	entities := make([]entityRow, 0, 2)
	for rows.Next() {
		var entity entityRow
		require.NoError(t, rows.Scan(&entity.label, &entity.target))
		entities = append(entities, entity)
	}
	require.NoError(t, rows.Err())
	require.Len(t, entities, 2)
	assert.Equal(t, "@Target", entities[0].label)
	assert.Equal(t, targetID, entities[0].target)
	assert.Equal(t, "@Requester", entities[1].label)
	assert.Equal(t, requesterID, entities[1].target)

	second, err := svc.InviteToChannel(ctx, requesterID, channelID, targetID)
	require.NoError(t, err)
	assert.Equal(t, 0, len(filterDirectDeliveriesByType(second.DirectDeliveries, packetspb.EventType_EVENT_TYPE_READ_COUNTER_UPDATED)))

	var messageCount int
	err = pool.QueryRow(ctx, `SELECT COUNT(*) FROM messages WHERE channel_id = $1`, channelID).Scan(&messageCount)
	require.NoError(t, err)
	assert.Equal(t, 1, messageCount)
}

func TestIntegration_InviteToChannel_RejectsArchivedConversation(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	requesterID := seedChatUserWithAttrs(t, ctx, pool, "Requester", "member", "active")
	targetID := seedChatUserWithAttrs(t, ctx, pool, "Target", "member", "active")

	var channelID uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO channels (kind, visibility, name, created_by, is_archived)
		 VALUES ('channel', 'private', 'Archived private', $1, true)
		 RETURNING id`,
		requesterID,
	).Scan(&channelID)
	require.NoError(t, err)

	_, err = pool.Exec(ctx,
		`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`,
		channelID, requesterID,
	)
	require.NoError(t, err)

	_, err = svc.InviteToChannel(ctx, requesterID, channelID, targetID)
	require.ErrorIs(t, err, chat.ErrConversationArchived)

	var membershipCount int
	err = pool.QueryRow(ctx,
		`SELECT COUNT(*)
		   FROM channel_members
		  WHERE channel_id = $1
		    AND user_id = $2`,
		channelID, targetID,
	).Scan(&membershipCount)
	require.NoError(t, err)
	assert.Equal(t, 0, membershipCount)
}

func TestIntegration_InviteToChannel_RejectsUnsupportedConversationTarget(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	requesterID := seedChatUserWithAttrs(t, ctx, pool, "Requester", "member", "active")
	targetID := seedChatUserWithAttrs(t, ctx, pool, "Target", "member", "active")

	var conversationID uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO channels (kind, visibility, name, created_by)
		 VALUES ('dm', 'dm', '', $1)
		 RETURNING id`,
		requesterID,
	).Scan(&conversationID)
	require.NoError(t, err)

	_, err = pool.Exec(ctx,
		`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`,
		conversationID, requesterID,
	)
	require.NoError(t, err)

	_, err = svc.InviteToChannel(ctx, requesterID, conversationID, targetID)
	require.ErrorIs(t, err, chat.ErrInviteUnsupportedTarget)

	var membershipCount int
	err = pool.QueryRow(ctx,
		`SELECT COUNT(*)
		   FROM channel_members
		  WHERE channel_id = $1
		    AND user_id = $2`,
		conversationID, targetID,
	).Scan(&membershipCount)
	require.NoError(t, err)
	assert.Equal(t, 0, membershipCount)
}

func TestIntegration_AddReaction_RejectsChannelMismatch(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	userID, channel1 := seedUserAndChannel(t, ctx, pool)
	channel2 := seedChannelForUser(t, ctx, pool, userID, "second")

	msg, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channel1,
		SenderID:    userID,
		ClientMsgID: uuid.New().String(),
		Body:        "hello",
	})
	require.NoError(t, err)

	_, err = svc.AddReaction(ctx, chat.ReactionParams{
		ChannelID:  channel2,
		MessageID:  msg.MessageID,
		UserID:     userID,
		Emoji:      "👍",
		ClientOpID: uuid.New().String(),
	})
	require.Error(t, err)
	assert.True(t, errors.Is(err, chat.ErrMessageNotFound))
}

func TestIntegration_SubscribeThread_RejectsChannelMismatch(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	userID, channel1 := seedUserAndChannel(t, ctx, pool)
	channel2 := seedChannelForUser(t, ctx, pool, userID, "other")

	root, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channel1,
		SenderID:    userID,
		ClientMsgID: uuid.New().String(),
		Body:        "root",
	})
	require.NoError(t, err)

	_, err = svc.SubscribeThread(ctx, chat.SubscribeThreadParams{
		ChannelID:           channel2,
		ThreadRootMessageID: root.MessageID,
		RequesterID:         userID,
		LastThreadSeq:       0,
	})
	require.Error(t, err)
	assert.True(t, errors.Is(err, chat.ErrInvalidThread))
}

func TestIntegration_SendMessage_EmitsWorkspaceEvent(t *testing.T) {
	pool, connStr := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	bus := events.NewBus(zap.NewNop())
	svc := chat.NewService(pool, store)

	l := events.NewListener(events.ListenerConfig{
		DSN:             connStr,
		CatchUpBatch:    100,
		RetryBackoff:    100 * time.Millisecond,
		RetryBackoffMax: 500 * time.Millisecond,
	}, store, bus, zap.NewNop())
	lctx, lcancel := context.WithCancel(ctx)
	stopped := make(chan struct{})
	go func() { defer close(stopped); l.Run(lctx) }()
	t.Cleanup(func() { lcancel(); <-stopped })

	time.Sleep(300 * time.Millisecond)

	_, evtCh, unsub := bus.Subscribe(nil, 32)
	t.Cleanup(unsub)

	userID, channelID := seedUserAndChannel(t, ctx, pool)

	_, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    userID,
		ClientMsgID: uuid.New().String(),
		Body:        "event test",
	})
	require.NoError(t, err)

	select {
	case evt := <-evtCh:
		assert.Equal(t, packetspb.EventType_EVENT_TYPE_MESSAGE_CREATED, evt.GetEventType())
		assert.Equal(t, channelID.String(), evt.GetConversationId())
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for message_created event")
	}
}

func TestIntegration_UpdateReadCursor_ResolvesRootMentionsAndPreservesThreadNotifications(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	authorID, channelID := seedUserAndChannel(t, ctx, pool)

	var mentionedUserID uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'Mentioned', 'member')
		 RETURNING id`,
		"mentioned_"+uuid.New().String()+"@example.com",
	).Scan(&mentionedUserID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`, channelID, mentionedUserID)
	require.NoError(t, err)

	msg, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    authorID,
		ClientMsgID: uuid.New().String(),
		Body:        "hello @Mentioned",
		Entities: []chat.MessageEntity{
			{
				Kind:     chat.MessageEntityKindUser,
				TargetID: mentionedUserID,
				Label:    "@Mentioned",
				Href:     "",
				Start:    6,
				End:      16,
			},
		},
	})
	require.NoError(t, err)
	notificationDeliveries := filterDirectDeliveriesByType(msg.DirectDeliveries, packetspb.EventType_EVENT_TYPE_NOTIFICATION_ADDED)
	require.Len(t, notificationDeliveries, 1)
	assert.Equal(t, mentionedUserID.String(), notificationDeliveries[0].UserID)
	mentionNotification := notificationDeliveries[0].Event.GetNotificationAdded().GetNotification()
	require.NotNil(t, mentionNotification)
	assert.Equal(t, msg.MessageID.String(), mentionNotification.GetMessageId())
	assert.Empty(t, mentionNotification.GetThreadRootMessageId())
	readCounterDeliveries := filterDirectDeliveriesByType(msg.DirectDeliveries, packetspb.EventType_EVENT_TYPE_READ_COUNTER_UPDATED)
	require.Len(t, readCounterDeliveries, 2)

	threadRoot, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    mentionedUserID,
		ClientMsgID: uuid.New().String(),
		Body:        "thread root",
	})
	require.NoError(t, err)

	threadReply, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:           channelID,
		SenderID:            authorID,
		ClientMsgID:         uuid.New().String(),
		Body:                "thread @Mentioned",
		ThreadRootMessageID: threadRoot.MessageID,
		Entities: []chat.MessageEntity{
			{
				Kind:     chat.MessageEntityKindUser,
				TargetID: mentionedUserID,
				Label:    "@Mentioned",
				Href:     "",
				Start:    7,
				End:      17,
			},
		},
	})
	require.NoError(t, err)
	threadNotificationDeliveries := filterDirectDeliveriesByType(threadReply.DirectDeliveries, packetspb.EventType_EVENT_TYPE_NOTIFICATION_ADDED)
	require.Len(t, threadNotificationDeliveries, 2)
	for _, delivery := range threadNotificationDeliveries {
		assert.Equal(t, mentionedUserID.String(), delivery.UserID)
		notification := delivery.Event.GetNotificationAdded().GetNotification()
		require.NotNil(t, notification)
		assert.Equal(t, threadReply.MessageID.String(), notification.GetMessageId())
		assert.Equal(t, threadRoot.MessageID.String(), notification.GetThreadRootMessageId())
	}

	var unresolvedBefore int
	err = pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND resolved_at IS NULL`,
		mentionedUserID,
	).Scan(&unresolvedBefore)
	require.NoError(t, err)
	require.Equal(t, 3, unresolvedBefore)

	ack, err := svc.UpdateReadCursor(ctx, chat.UpdateReadCursorParams{
		ChannelID:   channelID,
		UserID:      mentionedUserID,
		LastReadSeq: threadReply.ChannelSeq,
	})
	require.NoError(t, err)
	assert.Equal(t, channelID, ack.ChannelID)
	assert.Equal(t, threadReply.ChannelSeq, ack.LastReadSeq)
	assert.Equal(t, int32(0), ack.Counter.UnreadMessages)
	assert.Equal(t, int32(0), ack.Counter.UnreadMentions)
	assert.True(t, ack.Counter.HasUnreadThreadReplies)
	require.Len(t, ack.DirectDeliveries, 2)

	var unresolvedAfter int
	err = pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND resolved_at IS NULL`,
		mentionedUserID,
	).Scan(&unresolvedAfter)
	require.NoError(t, err)
	assert.Equal(t, 2, unresolvedAfter)

	var unresolvedRootNotifications int
	err = pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM notifications
		  WHERE user_id = $1
		    AND resolved_at IS NULL
		    AND thread_root_message_id IS NULL`,
		mentionedUserID,
	).Scan(&unresolvedRootNotifications)
	require.NoError(t, err)
	assert.Equal(t, 0, unresolvedRootNotifications)

	var unresolvedThreadNotifications int
	err = pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM notifications
		  WHERE user_id = $1
		    AND resolved_at IS NULL
		    AND thread_root_message_id = $2`,
		mentionedUserID, threadRoot.MessageID,
	).Scan(&unresolvedThreadNotifications)
	require.NoError(t, err)
	assert.Equal(t, 2, unresolvedThreadNotifications)

	var resolvedEvents int
	err = pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM workspace_events WHERE event_type = 'notification_resolved' AND channel_id = $1`,
		channelID,
	).Scan(&resolvedEvents)
	require.NoError(t, err)
	assert.Equal(t, 0, resolvedEvents)

	var addedEvents int
	err = pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM workspace_events WHERE event_type = 'notification_added' AND channel_id = $1`,
		channelID,
	).Scan(&addedEvents)
	require.NoError(t, err)
	assert.Equal(t, 0, addedEvents)

	var readCounterEvents int
	err = pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM workspace_events WHERE event_type = 'read_counter_updated' AND channel_id = $1`,
		channelID,
	).Scan(&readCounterEvents)
	require.NoError(t, err)
	assert.Equal(t, 0, readCounterEvents)
}

func TestIntegration_EditMessage_NewMentionCreatesSingleNotification(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	authorID, channelID := seedUserAndChannel(t, ctx, pool)

	var mentionedUserID uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'Mentioned', 'member')
		 RETURNING id`,
		"mentioned_edit_"+uuid.New().String()+"@example.com",
	).Scan(&mentionedUserID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`, channelID, mentionedUserID)
	require.NoError(t, err)
	setChannelMemberNotificationLevel(t, ctx, pool, channelID, mentionedUserID, int16(packetspb.NotificationLevel_NOTIFICATION_LEVEL_MENTIONS_ONLY))

	sent, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    authorID,
		ClientMsgID: uuid.New().String(),
		Body:        "plain message",
	})
	require.NoError(t, err)
	require.Empty(t, filterDirectDeliveriesByType(sent.DirectDeliveries, packetspb.EventType_EVENT_TYPE_NOTIFICATION_ADDED))

	editResult, err := svc.EditMessage(ctx, chat.EditMessageParams{
		MessageID: sent.MessageID,
		ActorID:   authorID,
		Body:      "plain @Mentioned",
		Entities: []chat.MessageEntity{
			{
				Kind:     chat.MessageEntityKindUser,
				TargetID: mentionedUserID,
				Label:    "@Mentioned",
				Href:     "",
				Start:    6,
				End:      16,
			},
		},
	})
	require.NoError(t, err)
	notificationDeliveries := filterDirectDeliveriesByType(editResult.DirectDeliveries, packetspb.EventType_EVENT_TYPE_NOTIFICATION_ADDED)
	require.Len(t, notificationDeliveries, 1)
	assert.Equal(t, mentionedUserID.String(), notificationDeliveries[0].UserID)

	var mentionRows int
	err = pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM message_mentions WHERE message_id = $1 AND user_id = $2`,
		sent.MessageID,
		mentionedUserID,
	).Scan(&mentionRows)
	require.NoError(t, err)
	assert.Equal(t, 1, mentionRows)

	editResult, err = svc.EditMessage(ctx, chat.EditMessageParams{
		MessageID: sent.MessageID,
		ActorID:   authorID,
		Body:      "plain @Mentioned again",
		Entities: []chat.MessageEntity{
			{
				Kind:     chat.MessageEntityKindUser,
				TargetID: mentionedUserID,
				Label:    "@Mentioned",
				Href:     "",
				Start:    6,
				End:      16,
			},
		},
	})
	require.NoError(t, err)
	require.Empty(t, filterDirectDeliveriesByType(editResult.DirectDeliveries, packetspb.EventType_EVENT_TYPE_NOTIFICATION_ADDED))
}

func TestIntegration_SubscribeThread_AdvancesThreadReadState(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	userID, channelID := seedUserAndChannel(t, ctx, pool)

	root, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    userID,
		ClientMsgID: uuid.New().String(),
		Body:        "root",
	})
	require.NoError(t, err)

	for i := 0; i < 2; i++ {
		_, err := svc.SendMessage(ctx, chat.SendMessageParams{
			ChannelID:           channelID,
			SenderID:            userID,
			ClientMsgID:         uuid.New().String(),
			Body:                "reply",
			ThreadRootMessageID: root.MessageID,
		})
		require.NoError(t, err)
	}

	resp, err := svc.SubscribeThread(ctx, chat.SubscribeThreadParams{
		ChannelID:           channelID,
		ThreadRootMessageID: root.MessageID,
		RequesterID:         userID,
		LastThreadSeq:       0,
	})
	require.NoError(t, err)
	assert.Equal(t, int64(2), resp.CurrentThreadSeq)
	require.Len(t, resp.DirectDeliveries, 1)
	assert.Equal(t, userID.String(), resp.DirectDeliveries[0].UserID)
	assert.Equal(t, packetspb.EventType_EVENT_TYPE_READ_COUNTER_UPDATED, resp.DirectDeliveries[0].Event.GetEventType())
	readCounter := resp.DirectDeliveries[0].Event.GetReadCounterUpdated()
	require.NotNil(t, readCounter)
	require.NotNil(t, readCounter.Counter)
	assert.Equal(t, int32(0), readCounter.Counter.UnreadMessages)
	assert.False(t, readCounter.Counter.HasUnreadThreadReplies)

	var lastReadThreadSeq int64
	err = pool.QueryRow(ctx,
		`SELECT last_read_thread_seq FROM thread_reads WHERE root_message_id = $1 AND user_id = $2`,
		root.MessageID, userID,
	).Scan(&lastReadThreadSeq)
	require.NoError(t, err)
	assert.Equal(t, int64(2), lastReadThreadSeq)
}

func TestIntegration_SubscribeThread_WithZeroReplies_ReturnsEmptyReplayAndNoError(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	userID, channelID := seedUserAndChannel(t, ctx, pool)

	root, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    userID,
		ClientMsgID: uuid.New().String(),
		Body:        "root without replies",
	})
	require.NoError(t, err)

	resp, err := svc.SubscribeThread(ctx, chat.SubscribeThreadParams{
		ChannelID:           channelID,
		ThreadRootMessageID: root.MessageID,
		RequesterID:         userID,
		LastThreadSeq:       0,
	})
	require.NoError(t, err)
	assert.Equal(t, int64(0), resp.CurrentThreadSeq)
	assert.Len(t, resp.Replay, 0)
	require.Len(t, resp.DirectDeliveries, 1)
	assert.Equal(t, packetspb.EventType_EVENT_TYPE_READ_COUNTER_UPDATED, resp.DirectDeliveries[0].Event.GetEventType())
}

func TestIntegration_SubscribeThread_ReplayIncludesEntities(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	userID, channelID := seedUserAndChannel(t, ctx, pool)

	root, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    userID,
		ClientMsgID: uuid.New().String(),
		Body:        "root",
	})
	require.NoError(t, err)

	_, err = svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:           channelID,
		SenderID:            userID,
		ClientMsgID:         uuid.New().String(),
		Body:                "hi @Test User",
		ThreadRootMessageID: root.MessageID,
		Entities: []chat.MessageEntity{
			{
				Kind:     chat.MessageEntityKindUser,
				TargetID: userID,
				Label:    "@Test User",
				Href:     "",
				Start:    3,
				End:      13,
			},
		},
	})
	require.NoError(t, err)

	resp, err := svc.SubscribeThread(ctx, chat.SubscribeThreadParams{
		ChannelID:           channelID,
		ThreadRootMessageID: root.MessageID,
		RequesterID:         userID,
		LastThreadSeq:       0,
	})
	require.NoError(t, err)
	require.Len(t, resp.Replay, 1)
	require.Len(t, resp.Replay[0].GetEntities(), 1)
	assert.Equal(t, packetspb.MessageEntityKind_MESSAGE_ENTITY_KIND_USER, resp.Replay[0].GetEntities()[0].GetKind())
	assert.Equal(t, userID.String(), resp.Replay[0].GetEntities()[0].GetTargetId())
	assert.Equal(t, "@Test User", resp.Replay[0].GetEntities()[0].GetLabel())
	assert.Equal(t, []string{userID.String()}, resp.Replay[0].GetMentionedUserIds())
}

func TestIntegration_SubscribeThread_ReplayIncludesReactionsAndMyReactions(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	userID, channelID := seedUserAndChannel(t, ctx, pool)

	root, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    userID,
		ClientMsgID: uuid.New().String(),
		Body:        "root",
	})
	require.NoError(t, err)

	replyAuthorID := createMemberInChannel(t, ctx, pool, channelID, "Replier")

	reply, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:           channelID,
		SenderID:            replyAuthorID,
		ClientMsgID:         uuid.New().String(),
		Body:                "reply with emoji",
		ThreadRootMessageID: root.MessageID,
	})
	require.NoError(t, err)

	_, err = svc.AddReaction(ctx, chat.ReactionParams{
		ChannelID:  channelID,
		MessageID:  reply.MessageID,
		UserID:     userID,
		Emoji:      ":+1:",
		ClientOpID: uuid.New().String(),
	})
	require.NoError(t, err)
	_, err = svc.AddReaction(ctx, chat.ReactionParams{
		ChannelID:  channelID,
		MessageID:  reply.MessageID,
		UserID:     replyAuthorID,
		Emoji:      ":+1:",
		ClientOpID: uuid.New().String(),
	})
	require.NoError(t, err)
	_, err = svc.AddReaction(ctx, chat.ReactionParams{
		ChannelID:  channelID,
		MessageID:  reply.MessageID,
		UserID:     replyAuthorID,
		Emoji:      "🔥",
		ClientOpID: uuid.New().String(),
	})
	require.NoError(t, err)

	resp, err := svc.SubscribeThread(ctx, chat.SubscribeThreadParams{
		ChannelID:           channelID,
		ThreadRootMessageID: root.MessageID,
		RequesterID:         userID,
		LastThreadSeq:       0,
	})
	require.NoError(t, err)
	require.Len(t, resp.Replay, 1)
	assert.Equal(t, []string{":+1:"}, resp.Replay[0].GetMyReactions())
	assert.Len(t, resp.Replay[0].GetReactions(), 2)
	assert.Equal(t, ":+1:", resp.Replay[0].GetReactions()[0].GetEmoji())
	assert.Equal(t, int32(2), resp.Replay[0].GetReactions()[0].GetCount())
	assert.Equal(t, "🔥", resp.Replay[0].GetReactions()[1].GetEmoji())
	assert.Equal(t, int32(1), resp.Replay[0].GetReactions()[1].GetCount())
}

func TestIntegration_ThreadReplies_DoNotIncreaseUnreadMessages_AndSubscribeClearsThreadUnread(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	authorID, channelID := seedUserAndChannel(t, ctx, pool)

	var replierID uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'Replier', 'member')
		 RETURNING id`,
		"replier_"+uuid.New().String()+"@example.com",
	).Scan(&replierID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`, channelID, replierID)
	require.NoError(t, err)

	root, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    authorID,
		ClientMsgID: uuid.New().String(),
		Body:        "root",
	})
	require.NoError(t, err)

	_, err = svc.UpdateReadCursor(ctx, chat.UpdateReadCursorParams{
		ChannelID:   channelID,
		UserID:      authorID,
		LastReadSeq: root.ChannelSeq,
	})
	require.NoError(t, err)

	_, err = svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:           channelID,
		SenderID:            replierID,
		ClientMsgID:         uuid.New().String(),
		Body:                "thread reply",
		ThreadRootMessageID: root.MessageID,
	})
	require.NoError(t, err)

	ackBeforeSubscribe, err := svc.UpdateReadCursor(ctx, chat.UpdateReadCursorParams{
		ChannelID:   channelID,
		UserID:      authorID,
		LastReadSeq: root.ChannelSeq,
	})
	require.NoError(t, err)
	assert.Equal(t, int32(0), ackBeforeSubscribe.Counter.UnreadMessages)
	assert.True(t, ackBeforeSubscribe.Counter.HasUnreadThreadReplies)

	subscribeResp, err := svc.SubscribeThread(ctx, chat.SubscribeThreadParams{
		ChannelID:           channelID,
		ThreadRootMessageID: root.MessageID,
		RequesterID:         authorID,
		LastThreadSeq:       0,
	})
	require.NoError(t, err)
	require.Len(t, subscribeResp.DirectDeliveries, 1)
	assert.Equal(t, packetspb.EventType_EVENT_TYPE_READ_COUNTER_UPDATED, subscribeResp.DirectDeliveries[0].Event.GetEventType())
	updated := subscribeResp.DirectDeliveries[0].Event.GetReadCounterUpdated()
	require.NotNil(t, updated)
	require.NotNil(t, updated.Counter)
	assert.Equal(t, int32(0), updated.Counter.UnreadMessages)
	assert.False(t, updated.Counter.HasUnreadThreadReplies)
}

func TestIntegration_SendMessage_ThreadRepliesNotifyOnlyThreadMembers(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	rootAuthorID, channelID := seedUserAndChannel(t, ctx, pool)

	createMember := func(name string) uuid.UUID {
		var userID uuid.UUID
		err := pool.QueryRow(ctx,
			`INSERT INTO users (email, password_hash, display_name, role)
			 VALUES ($1, 'x', $2, 'member')
			 RETURNING id`,
			strings.ToLower(name)+"_"+uuid.New().String()+"@example.com",
			name,
		).Scan(&userID)
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`, channelID, userID)
		require.NoError(t, err)
		return userID
	}

	threadReplierID := createMember("ThreadReplier")
	bystanderID := createMember("Bystander")

	root, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    rootAuthorID,
		ClientMsgID: uuid.New().String(),
		Body:        "root",
	})
	require.NoError(t, err)

	reply, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:           channelID,
		SenderID:            threadReplierID,
		ClientMsgID:         uuid.New().String(),
		Body:                "thread reply",
		ThreadRootMessageID: root.MessageID,
	})
	require.NoError(t, err)

	assert.Empty(t, filterDirectDeliveriesByType(reply.DirectDeliveries, packetspb.EventType_EVENT_TYPE_MESSAGE_ALERT))

	threadNotifications := filterDirectDeliveriesByType(reply.DirectDeliveries, packetspb.EventType_EVENT_TYPE_NOTIFICATION_ADDED)
	require.Len(t, threadNotifications, 1)
	assert.Equal(t, rootAuthorID.String(), threadNotifications[0].UserID)
	threadNotification := threadNotifications[0].Event.GetNotificationAdded().GetNotification()
	require.NotNil(t, threadNotification)
	assert.Equal(t, packetspb.NotificationType_NOTIFICATION_TYPE_THREAD_REPLY, threadNotification.GetType())
	assert.Equal(t, reply.MessageID.String(), threadNotification.GetMessageId())
	assert.Equal(t, root.MessageID.String(), threadNotification.GetThreadRootMessageId())

	for _, delivery := range reply.DirectDeliveries {
		if delivery.UserID == bystanderID.String() && delivery.Event != nil {
			assert.Equal(t, packetspb.EventType_EVENT_TYPE_READ_COUNTER_UPDATED, delivery.Event.GetEventType())
		}
	}
}

func TestIntegration_SendMessage_ThreadRepliesDoNotNotifyReadOnlyOpeners(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	rootAuthorID, channelID := seedUserAndChannel(t, ctx, pool)

	createMember := func(name string) uuid.UUID {
		var userID uuid.UUID
		err := pool.QueryRow(ctx,
			`INSERT INTO users (email, password_hash, display_name, role)
			 VALUES ($1, 'x', $2, 'member')
			 RETURNING id`,
			strings.ToLower(name)+"_"+uuid.New().String()+"@example.com",
			name,
		).Scan(&userID)
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`, channelID, userID)
		require.NoError(t, err)
		return userID
	}

	threadReaderID := createMember("ThreadReader")
	threadReplierID := createMember("ThreadReplier")
	bystanderID := createMember("Bystander")

	root, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    rootAuthorID,
		ClientMsgID: uuid.New().String(),
		Body:        "root",
	})
	require.NoError(t, err)

	subscribeResp, err := svc.SubscribeThread(ctx, chat.SubscribeThreadParams{
		ChannelID:           channelID,
		ThreadRootMessageID: root.MessageID,
		RequesterID:         threadReaderID,
		LastThreadSeq:       0,
	})
	require.NoError(t, err)
	assert.Equal(t, int64(0), subscribeResp.CurrentThreadSeq)

	reply, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:           channelID,
		SenderID:            threadReplierID,
		ClientMsgID:         uuid.New().String(),
		Body:                "thread reply",
		ThreadRootMessageID: root.MessageID,
	})
	require.NoError(t, err)

	threadNotifications := filterDirectDeliveriesByType(reply.DirectDeliveries, packetspb.EventType_EVENT_TYPE_NOTIFICATION_ADDED)
	require.Len(t, threadNotifications, 1)

	notificationRecipients := make([]string, 0, len(threadNotifications))
	for _, delivery := range threadNotifications {
		notificationRecipients = append(notificationRecipients, delivery.UserID)
		require.NotNil(t, delivery.Event.GetNotificationAdded())
		assert.Equal(t, packetspb.NotificationType_NOTIFICATION_TYPE_THREAD_REPLY, delivery.Event.GetNotificationAdded().GetNotification().GetType())
	}
	assert.ElementsMatch(t, []string{rootAuthorID.String()}, notificationRecipients)

	readCounterDeliveries := filterDirectDeliveriesByType(reply.DirectDeliveries, packetspb.EventType_EVENT_TYPE_READ_COUNTER_UPDATED)
	var readerCounter *packetspb.UnreadCounter
	var bystanderCounter *packetspb.UnreadCounter
	for _, delivery := range readCounterDeliveries {
		if delivery.UserID == threadReaderID.String() {
			readerCounter = delivery.Event.GetReadCounterUpdated().GetCounter()
		}
		if delivery.UserID == bystanderID.String() {
			bystanderCounter = delivery.Event.GetReadCounterUpdated().GetCounter()
		}
	}
	require.NotNil(t, readerCounter)
	assert.True(t, readerCounter.HasUnreadThreadReplies)
	require.NotNil(t, bystanderCounter)
	assert.False(t, bystanderCounter.HasUnreadThreadReplies)
}

func TestIntegration_SendMessage_ThreadRepliesNotifyPriorReplyAuthors(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	rootAuthorID, channelID := seedUserAndChannel(t, ctx, pool)

	createMember := func(name string) uuid.UUID {
		var userID uuid.UUID
		err := pool.QueryRow(ctx,
			`INSERT INTO users (email, password_hash, display_name, role)
			 VALUES ($1, 'x', $2, 'member')
			 RETURNING id`,
			strings.ToLower(name)+"_"+uuid.New().String()+"@example.com",
			name,
		).Scan(&userID)
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`, channelID, userID)
		require.NoError(t, err)
		return userID
	}

	firstReplierID := createMember("FirstReplier")
	secondReplierID := createMember("SecondReplier")

	root, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    rootAuthorID,
		ClientMsgID: uuid.New().String(),
		Body:        "root",
	})
	require.NoError(t, err)

	_, err = svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:           channelID,
		SenderID:            firstReplierID,
		ClientMsgID:         uuid.New().String(),
		Body:                "first reply",
		ThreadRootMessageID: root.MessageID,
	})
	require.NoError(t, err)

	reply, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:           channelID,
		SenderID:            secondReplierID,
		ClientMsgID:         uuid.New().String(),
		Body:                "second reply",
		ThreadRootMessageID: root.MessageID,
	})
	require.NoError(t, err)

	threadNotifications := filterDirectDeliveriesByType(reply.DirectDeliveries, packetspb.EventType_EVENT_TYPE_NOTIFICATION_ADDED)
	require.Len(t, threadNotifications, 2)

	notificationRecipients := make([]string, 0, len(threadNotifications))
	for _, delivery := range threadNotifications {
		notificationRecipients = append(notificationRecipients, delivery.UserID)
		require.NotNil(t, delivery.Event.GetNotificationAdded())
		assert.Equal(t, packetspb.NotificationType_NOTIFICATION_TYPE_THREAD_REPLY, delivery.Event.GetNotificationAdded().GetNotification().GetType())
	}
	assert.ElementsMatch(t, []string{rootAuthorID.String(), firstReplierID.String()}, notificationRecipients)
}

func TestIntegration_ListRecentMessages_ReturnsConversationHistory(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	userID, channelID := seedUserAndChannel(t, ctx, pool)

	first, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    userID,
		ClientMsgID: uuid.New().String(),
		Body:        "first",
	})
	require.NoError(t, err)

	_, err = svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    userID,
		ClientMsgID: uuid.New().String(),
		Body:        "second",
	})
	require.NoError(t, err)

	history, err := svc.ListRecentMessages(ctx, userID, channelID, 50)
	require.NoError(t, err)
	require.Len(t, history, 2)
	assert.Equal(t, "first", history[0].Body)
	assert.Equal(t, "second", history[1].Body)
	assert.Equal(t, first.ChannelSeq, history[0].ChannelSeq)
	assert.Equal(t, "Test User", history[0].SenderName)
}

func TestIntegration_ListRecentMessages_IncludesReactions(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	userID, channelID := seedUserAndChannel(t, ctx, pool)

	var peerID uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'Peer User', 'member')
		 RETURNING id`,
		"peer_"+uuid.New().String()+"@example.com",
	).Scan(&peerID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`, channelID, peerID)
	require.NoError(t, err)

	msg, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    peerID,
		ClientMsgID: uuid.New().String(),
		Body:        "with reaction",
	})
	require.NoError(t, err)

	_, err = svc.AddReaction(ctx, chat.ReactionParams{
		ChannelID:  channelID,
		MessageID:  msg.MessageID,
		UserID:     userID,
		Emoji:      ":+1:",
		ClientOpID: uuid.New().String(),
	})
	require.NoError(t, err)

	history, err := svc.ListRecentMessages(ctx, userID, channelID, 50)
	require.NoError(t, err)
	require.Len(t, history, 1)
	require.Equal(t, "with reaction", history[0].Body)
	require.Equal(t, []string{":+1:"}, history[0].MyReactions)
	require.Len(t, history[0].Reactions, 1)
	assert.Equal(t, ":+1:", history[0].Reactions[0].Emoji)
	assert.Equal(t, int32(1), history[0].Reactions[0].Count)
}

func TestIntegration_ListMessagePage_PaginatesByCursor(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	userID, channelID := seedUserAndChannel(t, ctx, pool)

	for _, body := range []string{"one", "two", "three", "four", "five"} {
		_, err := svc.SendMessage(ctx, chat.SendMessageParams{
			ChannelID:   channelID,
			SenderID:    userID,
			ClientMsgID: uuid.New().String(),
			Body:        body,
		})
		require.NoError(t, err)
	}

	firstPage, hasMore, err := svc.ListMessagePage(ctx, userID, channelID, nil, 2)
	require.NoError(t, err)
	require.True(t, hasMore)
	require.Len(t, firstPage, 2)
	assert.Equal(t, "four", firstPage[0].Body)
	assert.Equal(t, "five", firstPage[1].Body)

	before := firstPage[0].ChannelSeq
	secondPage, hasMore, err := svc.ListMessagePage(ctx, userID, channelID, &before, 2)
	require.NoError(t, err)
	require.True(t, hasMore)
	require.Len(t, secondPage, 2)
	assert.Equal(t, "two", secondPage[0].Body)
	assert.Equal(t, "three", secondPage[1].Body)

	before = secondPage[0].ChannelSeq
	lastPage, hasMore, err := svc.ListMessagePage(ctx, userID, channelID, &before, 2)
	require.NoError(t, err)
	require.False(t, hasMore)
	require.Len(t, lastPage, 1)
	assert.Equal(t, "one", lastPage[0].Body)
}

func TestIntegration_ListMessagePage_RejectsNonMember(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	userID, channelID := seedUserAndChannel(t, ctx, pool)
	otherUserID, _ := seedUserAndChannel(t, ctx, pool)

	_, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    userID,
		ClientMsgID: uuid.New().String(),
		Body:        "visible to members only",
	})
	require.NoError(t, err)

	_, _, err = svc.ListMessagePage(ctx, otherUserID, channelID, nil, 20)
	require.Error(t, err)
	assert.True(t, errors.Is(err, chat.ErrNotMember))
}

func TestIntegration_ListMessagePage_IncludesThreadReplyCountForRoots(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	userID, channelID := seedUserAndChannel(t, ctx, pool)

	root, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    userID,
		ClientMsgID: uuid.New().String(),
		Body:        "root message",
	})
	require.NoError(t, err)

	_, err = svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:           channelID,
		SenderID:            userID,
		ClientMsgID:         uuid.New().String(),
		Body:                "reply message",
		ThreadRootMessageID: root.MessageID,
	})
	require.NoError(t, err)

	page, hasMore, err := svc.ListMessagePage(ctx, userID, channelID, nil, 50)
	require.NoError(t, err)
	require.False(t, hasMore)
	require.Len(t, page, 1)
	assert.Equal(t, "root message", page[0].Body)
	assert.Equal(t, int32(1), page[0].ThreadReplyCount)
}

func TestIntegration_MessageAttachment_UploadAndLinkToMessage(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)
	minioClient := testdb.NewMinio(t)
	svc.ConfigureAttachments(minioClient, 50)

	userID, channelID := seedUserAndChannel(t, ctx, pool)

	uploaded, err := svc.UploadMessageAttachment(ctx, chat.UploadMessageAttachmentParams{
		ConversationID: channelID,
		ActorID:        userID,
		FileName:       "clip.mp4",
		MimeType:       "video/mp4",
		Size:           int64(len("video-bytes")),
		Body:           strings.NewReader("video-bytes"),
	}, nil)
	require.NoError(t, err)
	require.NotEqual(t, uuid.Nil, uploaded.ID)

	sent, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:     channelID,
		SenderID:      userID,
		ClientMsgID:   uuid.New().String(),
		Body:          "",
		AttachmentIDs: []uuid.UUID{uploaded.ID},
	})
	require.NoError(t, err)

	page, hasMore, err := svc.ListMessagePage(ctx, userID, channelID, nil, 50)
	require.NoError(t, err)
	require.False(t, hasMore)
	require.Len(t, page, 1)
	require.Len(t, page[0].Attachments, 1)
	assert.Equal(t, uploaded.ID, page[0].Attachments[0].ID)
	assert.Equal(t, "clip.mp4", page[0].Attachments[0].FileName)
	assert.Equal(t, sent.MessageID, page[0].ID)

	body, _, _, fileName, err := svc.DownloadMessageAttachment(ctx, userID, sent.MessageID, uploaded.ID)
	require.NoError(t, err)
	defer body.Close()
	raw, err := io.ReadAll(body)
	require.NoError(t, err)
	assert.Equal(t, "video-bytes", string(raw))
	assert.Equal(t, "clip.mp4", fileName)
}

func TestIntegration_MessageAttachment_ThreadReplayIncludesAttachments(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)
	minioClient := testdb.NewMinio(t)
	svc.ConfigureAttachments(minioClient, 50)

	userID, channelID := seedUserAndChannel(t, ctx, pool)

	root, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    userID,
		ClientMsgID: uuid.New().String(),
		Body:        "root",
	})
	require.NoError(t, err)

	uploaded, err := svc.UploadMessageAttachment(ctx, chat.UploadMessageAttachmentParams{
		ConversationID: channelID,
		ActorID:        userID,
		FileName:       "voice.ogg",
		MimeType:       "audio/ogg",
		Size:           int64(len("audio")),
		Body:           strings.NewReader("audio"),
	}, nil)
	require.NoError(t, err)

	_, err = svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:           channelID,
		SenderID:            userID,
		ClientMsgID:         uuid.New().String(),
		Body:                "",
		ThreadRootMessageID: root.MessageID,
		AttachmentIDs:       []uuid.UUID{uploaded.ID},
	})
	require.NoError(t, err)

	resp, err := svc.SubscribeThread(ctx, chat.SubscribeThreadParams{
		ChannelID:           channelID,
		ThreadRootMessageID: root.MessageID,
		RequesterID:         userID,
		LastThreadSeq:       0,
	})
	require.NoError(t, err)
	require.Len(t, resp.Replay, 1)
	require.Len(t, resp.Replay[0].Attachments, 1)
	assert.Equal(t, uploaded.ID.String(), resp.Replay[0].Attachments[0].AttachmentId)
	assert.Equal(t, "voice.ogg", resp.Replay[0].Attachments[0].FileName)
}

func TestIntegration_MessageAttachment_SendRejectsWrongOwner(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)
	minioClient := testdb.NewMinio(t)
	svc.ConfigureAttachments(minioClient, 50)

	userID, channelID := seedUserAndChannel(t, ctx, pool)
	otherUserID, _ := seedUserAndChannel(t, ctx, pool)
	_, err := pool.Exec(ctx, `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, channelID, otherUserID)
	require.NoError(t, err)

	uploaded, err := svc.UploadMessageAttachment(ctx, chat.UploadMessageAttachmentParams{
		ConversationID: channelID,
		ActorID:        userID,
		FileName:       "doc.txt",
		MimeType:       "text/plain",
		Size:           int64(len("doc")),
		Body:           strings.NewReader("doc"),
	}, nil)
	require.NoError(t, err)

	_, err = svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:     channelID,
		SenderID:      otherUserID,
		ClientMsgID:   uuid.New().String(),
		Body:          "steal",
		AttachmentIDs: []uuid.UUID{uploaded.ID},
	})
	require.Error(t, err)
	assert.True(t, errors.Is(err, chat.ErrAttachmentOwnership))
}

func TestIntegration_ListUnreadFeed_DedupesMentionsAndIncludesThreadReplies(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)
	authorID, channelID := seedUserAndChannel(t, ctx, pool)

	var recipientID uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'Target', 'member')
		 RETURNING id`,
		"target_"+uuid.New().String()+"@example.com",
	).Scan(&recipientID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`, channelID, recipientID)
	require.NoError(t, err)

	rootResult, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    recipientID,
		ClientMsgID: uuid.New().String(),
		Body:        "thread root",
	})
	require.NoError(t, err)

	genericResult, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    authorID,
		ClientMsgID: uuid.New().String(),
		Body:        "plain unread",
	})
	require.NoError(t, err)

	_, err = svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    authorID,
		ClientMsgID: uuid.New().String(),
		Body:        "hello @Target",
		Entities: []chat.MessageEntity{
			{
				Kind:     chat.MessageEntityKindUser,
				TargetID: recipientID,
				Label:    "@Target",
				Start:    6,
				End:      13,
			},
		},
	})
	require.NoError(t, err)

	threadResult, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:           channelID,
		SenderID:            authorID,
		ClientMsgID:         uuid.New().String(),
		Body:                "thread reply",
		ThreadRootMessageID: rootResult.MessageID,
	})
	require.NoError(t, err)

	items, err := svc.ListUnreadFeed(ctx, recipientID)
	require.NoError(t, err)
	require.Len(t, items, 3)

	var genericCount int
	var mentionCount int
	var threadCount int
	for _, item := range items {
		switch item.Kind {
		case "message":
			genericCount++
			assert.Equal(t, genericResult.MessageID, item.MessageID)
		case "mention":
			mentionCount++
			assert.Equal(t, channelID, item.ConversationID)
			assert.Equal(t, uuid.Nil, item.ThreadRootMessageID)
		case "thread":
			threadCount++
			assert.Equal(t, threadResult.MessageID, item.MessageID)
			assert.Equal(t, rootResult.MessageID, item.ThreadRootMessageID)
		}
	}
	assert.Equal(t, 1, genericCount)
	assert.Equal(t, 1, mentionCount)
	assert.Equal(t, 1, threadCount)
}

func TestIntegration_ListUnreadFeed_MentionsOnlyIncludesMentionsAndThreadsButNotGenericMessages(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)
	authorID, channelID := seedUserAndChannel(t, ctx, pool)

	var recipientID uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'Target', 'member')
		 RETURNING id`,
		"mentions_only_"+uuid.New().String()+"@example.com",
	).Scan(&recipientID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`, channelID, recipientID)
	require.NoError(t, err)
	setChannelMemberNotificationLevel(t, ctx, pool, channelID, recipientID, int16(packetspb.NotificationLevel_NOTIFICATION_LEVEL_MENTIONS_ONLY))
	setChannelMemberNotificationLevel(t, ctx, pool, channelID, recipientID, int16(packetspb.NotificationLevel_NOTIFICATION_LEVEL_MENTIONS_ONLY))

	rootResult, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    recipientID,
		ClientMsgID: uuid.New().String(),
		Body:        "thread root",
	})
	require.NoError(t, err)

	_, err = svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    authorID,
		ClientMsgID: uuid.New().String(),
		Body:        "plain unread",
	})
	require.NoError(t, err)

	mentionResult, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    authorID,
		ClientMsgID: uuid.New().String(),
		Body:        "hello @Target",
		Entities: []chat.MessageEntity{
			{
				Kind:     chat.MessageEntityKindUser,
				TargetID: recipientID,
				Label:    "@Target",
				Start:    6,
				End:      13,
			},
		},
	})
	require.NoError(t, err)

	threadResult, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:           channelID,
		SenderID:            authorID,
		ClientMsgID:         uuid.New().String(),
		Body:                "thread reply",
		ThreadRootMessageID: rootResult.MessageID,
	})
	require.NoError(t, err)

	items, err := svc.ListUnreadFeed(ctx, recipientID)
	require.NoError(t, err)
	require.Len(t, items, 2)

	kinds := make([]string, 0, len(items))
	for _, item := range items {
		kinds = append(kinds, item.Kind)
	}
	assert.ElementsMatch(t, []string{"mention", "thread"}, kinds)
	for _, item := range items {
		assert.NotEqual(t, "message", item.Kind)
		if item.Kind == "mention" {
			assert.Equal(t, mentionResult.MessageID, item.MessageID)
			assert.Equal(t, uuid.Nil, item.ThreadRootMessageID)
		}
		if item.Kind == "thread" {
			assert.Equal(t, threadResult.MessageID, item.MessageID)
			assert.Equal(t, rootResult.MessageID, item.ThreadRootMessageID)
		}
	}
}

func TestIntegration_ListUnreadFeed_HiddenChannelRootMessagesAreExcluded(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)

	authorID := seedChatUserWithAttrs(t, ctx, pool, "Hidden Author", "member", "active")
	recipientID := seedChatUserWithAttrs(t, ctx, pool, "Hidden Recipient", "member", "active")

	var hiddenChannelID uuid.UUID
	err := pool.QueryRow(ctx, `
		INSERT INTO channels (kind, visibility, name, created_by, hidden)
		VALUES ('channel', 'private', 'hidden-thread-space', $1, true)
		RETURNING id`,
		authorID,
	).Scan(&hiddenChannelID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2), ($1, $3)`, hiddenChannelID, authorID, recipientID)
	require.NoError(t, err)

	_, err = svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   hiddenChannelID,
		SenderID:    authorID,
		ClientMsgID: uuid.New().String(),
		Body:        "hidden root message",
	})
	require.NoError(t, err)

	items, err := svc.ListUnreadFeed(ctx, recipientID)
	require.NoError(t, err)
	assert.Empty(t, items)
}

func TestIntegration_ListUnreadFeed_LegacyNotificationsKeepStableIDs(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)
	userID, channelID := seedUserAndChannel(t, ctx, pool)

	var notificationID uuid.UUID
	err := pool.QueryRow(ctx, `
		INSERT INTO notifications (user_id, type, title, body, channel_id, is_read, created_at)
		VALUES ($1, 'mention', 'Mention', 'legacy notification', $2, false, now())
		RETURNING id`,
		userID, channelID,
	).Scan(&notificationID)
	require.NoError(t, err)

	firstItems, err := svc.ListUnreadFeed(ctx, userID)
	require.NoError(t, err)
	require.Len(t, firstItems, 1)

	secondItems, err := svc.ListUnreadFeed(ctx, userID)
	require.NoError(t, err)
	require.Len(t, secondItems, 1)

	expectedID := "mention:" + notificationID.String()
	assert.Equal(t, expectedID, firstItems[0].ID)
	assert.Equal(t, expectedID, secondItems[0].ID)
	assert.Equal(t, uuid.Nil, firstItems[0].MessageID)
}

func TestIntegration_ResolveNotification_ResolvesOnlyTargetNotification(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)
	authorID, channelID := seedUserAndChannel(t, ctx, pool)

	var recipientID uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'Target', 'member')
		 RETURNING id`,
		"resolve_notification_"+uuid.New().String()+"@example.com",
	).Scan(&recipientID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`, channelID, recipientID)
	require.NoError(t, err)
	setChannelMemberNotificationLevel(t, ctx, pool, channelID, recipientID, int16(packetspb.NotificationLevel_NOTIFICATION_LEVEL_MENTIONS_ONLY))

	first, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    authorID,
		ClientMsgID: uuid.New().String(),
		Body:        "hello @Target",
		Entities: []chat.MessageEntity{{
			Kind:     chat.MessageEntityKindUser,
			TargetID: recipientID,
			Label:    "@Target",
			Start:    6,
			End:      13,
		}},
	})
	require.NoError(t, err)
	second, err := svc.SendMessage(ctx, chat.SendMessageParams{
		ChannelID:   channelID,
		SenderID:    authorID,
		ClientMsgID: uuid.New().String(),
		Body:        "again @Target",
		Entities: []chat.MessageEntity{{
			Kind:     chat.MessageEntityKindUser,
			TargetID: recipientID,
			Label:    "@Target",
			Start:    6,
			End:      13,
		}},
	})
	require.NoError(t, err)

	items, err := svc.ListUnreadFeed(ctx, recipientID)
	require.NoError(t, err)
	require.Len(t, items, 2)
	require.NotEqual(t, uuid.Nil, items[0].NotificationID)
	require.NotEqual(t, items[0].NotificationID, items[1].NotificationID)

	result, err := svc.ResolveNotification(ctx, chat.ResolveNotificationParams{
		NotificationID: items[0].NotificationID,
		UserID:         recipientID,
	})
	require.NoError(t, err)
	assert.True(t, result.Resolved)
	require.Len(t, result.DirectDeliveries, 1)

	remaining, err := svc.ListUnreadFeed(ctx, recipientID)
	require.NoError(t, err)
	require.Len(t, remaining, 1)
	assert.Equal(t, items[1].NotificationID, remaining[0].NotificationID)
	assert.ElementsMatch(t, []uuid.UUID{first.MessageID, second.MessageID}, []uuid.UUID{items[0].MessageID, items[1].MessageID})
}

func TestIntegration_ListMessageContext_ReturnsMessagesAroundTarget(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)
	userID, channelID := seedUserAndChannel(t, ctx, pool)

	var targetMessageID uuid.UUID
	for idx, body := range []string{"one", "two", "three", "four", "five"} {
		result, err := svc.SendMessage(ctx, chat.SendMessageParams{
			ChannelID:   channelID,
			SenderID:    userID,
			ClientMsgID: uuid.New().String(),
			Body:        body,
		})
		require.NoError(t, err)
		if idx == 2 {
			targetMessageID = result.MessageID
		}
	}

	messages, err := svc.ListMessageContext(ctx, userID, channelID, targetMessageID, 1, 1)
	require.NoError(t, err)
	require.Len(t, messages, 3)
	assert.Equal(t, targetMessageID, messages[1].ID)
	assert.Equal(t, []string{"two", "three", "four"}, []string{
		messages[0].Body,
		messages[1].Body,
		messages[2].Body,
	})
}
