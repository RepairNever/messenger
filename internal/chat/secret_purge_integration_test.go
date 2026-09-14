//go:build integration

package chat_test

import (
	"context"
	"errors"
	"io"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"msgnr/internal/chat"
	"msgnr/internal/events"
	"msgnr/internal/testdb"
)

type purgeObjectStore struct {
	failures int
	attempts int
	objects  map[string]bool
}

func (s *purgeObjectStore) PutObject(context.Context, string, io.Reader, int64, string) error { return nil }
func (s *purgeObjectStore) GetObject(context.Context, string) (io.ReadCloser, int64, string, error) {
	return nil, 0, "", errors.New("unused")
}
func (s *purgeObjectStore) DeleteObject(_ context.Context, key string) error {
	s.attempts++
	if s.failures > 0 {
		s.failures--
		return errors.New("storage unavailable")
	}
	delete(s.objects, key)
	return nil
}

func TestIntegration_SecretMessagePurge(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	store := events.NewStore(pool)
	svc := chat.NewService(pool, store)
	author := seedChatUserWithAttrs(t, ctx, pool, "Author", "member", "active")
	peer := seedChatUserWithAttrs(t, ctx, pool, "Peer", "member", "active")
	outsider := seedChatUserWithAttrs(t, ctx, pool, "Outsider", "member", "active")
	plain, err := svc.CreateOrOpenDirectMessage(ctx, author, peer)
	require.NoError(t, err)
	secret, err := svc.CreateOrOpenEncryptedDirectMessage(ctx, author, plain.DM.ConversationID)
	require.NoError(t, err)
	var devices []uuid.UUID
	for _, user := range []uuid.UUID{author, peer} {
		device, err := svc.RegisterDevice(ctx, chat.RegisterDeviceParams{UserID: user, IdentityKeyPublic: []byte("identity"), SignedPrekeyID: 1, SignedPrekeyPublic: []byte("prekey"), SignedPrekeySignature: []byte("signature")})
		require.NoError(t, err)
		devices = append(devices, device.DeviceID)
	}
	send := func() chat.SendMessageResult {
		var payloads []chat.EncryptedDMRecipientPayload
		for _, device := range devices {
			payloads = append(payloads, chat.EncryptedDMRecipientPayload{RecipientDeviceID: device, SenderDeviceID: devices[0], Algorithm: "dm-p256-aesgcm-v1", SessionMessage: []byte("opaque message")})
		}
		result, err := svc.SendMessage(ctx, chat.SendMessageParams{ChannelID: secret.DM.ConversationID, SenderID: author, ClientMsgID: uuid.NewString(), ContentMode: chat.MessageContentDMPairwiseSignal, SenderDeviceID: devices[0], EncryptedDMPayloads: payloads})
		require.NoError(t, err)
		return result
	}
	target := send()
	survivor := send()
	_, err = svc.SaveMessage(ctx, peer, target.MessageID)
	require.NoError(t, err)
	var notificationID uuid.UUID
	err = pool.QueryRow(ctx, `INSERT INTO notifications (user_id, type, channel_id, message_id, body) VALUES ($1, 'system', $2, $3, 'old notification') RETURNING id`, peer, secret.DM.ConversationID, target.MessageID).Scan(&notificationID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO workspace_events(event_type, channel_id, payload) VALUES ('notification_resolved', $1, jsonb_build_object('notificationId', $2::text))`, secret.DM.ConversationID, notificationID.String())
	require.NoError(t, err)
	// Legacy attachments must be purged even though current secret sends reject uploads.
	attachmentID := uuid.New()
	_, err = pool.Exec(ctx, `INSERT INTO message_attachment(id, conversation_id, message_id, file_name, file_size, mime_type, storage_key, thumbnail_storage_key, thumbnail_mime_type, thumbnail_file_size, thumbnail_version, uploaded_by) VALUES ($1,$2,$3,'legacy',3,'application/octet-stream','secret-object','secret-thumbnail','image/jpeg',3,1,$4)`, attachmentID, secret.DM.ConversationID, target.MessageID, author)
	require.NoError(t, err)
	objects := &purgeObjectStore{objects: map[string]bool{"secret-object": true, "secret-thumbnail": true}, failures: 3}
	svc.ConfigureAttachments(objects, 50)
	_, err = svc.DeleteMessage(ctx, chat.DeleteMessageParams{MessageID: target.MessageID, ActorID: outsider})
	require.ErrorIs(t, err, chat.ErrNotMember)
	assert.Zero(t, objects.attempts)
	_, err = svc.DeleteMessage(ctx, chat.DeleteMessageParams{MessageID: target.MessageID, ActorID: peer})
	require.ErrorIs(t, err, chat.ErrSecretMessagePurgeIncomplete)
	assert.Equal(t, 3, objects.attempts)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM messages WHERE id=$1`, target.MessageID).Scan(&count))
	assert.Equal(t, 1, count, "failed cleanup must leave references for retry")
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM notifications WHERE id=$1`, notificationID).Scan(&count))
	assert.Equal(t, 1, count, "purge must roll back on cleanup failure")
	// A new service represents a restart: cleanup is still retriable from DB state.
	svc = chat.NewService(pool, store)
	svc.ConfigureAttachments(objects, 50)
	objects.failures = 1
	result, err := svc.DeleteMessage(ctx, chat.DeleteMessageParams{MessageID: target.MessageID, ActorID: peer})
	require.NoError(t, err)
	assert.Equal(t, secret.DM.ConversationID, result.ChannelID)
	assert.Empty(t, objects.objects)
	assert.Equal(t, 6, objects.attempts)
	for _, table := range []string{"messages", "message_recipient_ciphertexts", "message_attachment", "message_saves"} {
		column := "message_id"
		if table == "messages" {
			column = "id"
		}
		require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM "+table+" WHERE "+column+"=$1", target.MessageID).Scan(&count))
		assert.Zero(t, count, table)
	}
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM notifications WHERE id=$1`, notificationID).Scan(&count))
	assert.Zero(t, count)
	for _, id := range []uuid.UUID{target.MessageID, attachmentID, notificationID} {
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspace_events WHERE strpos(payload::text,$1)>0`, id.String()).Scan(&count))
		assert.Zero(t, count, "no event trace of %s", id)
	}
	history, _, err := svc.ListMessagePage(ctx, peer, secret.DM.ConversationID, nil, 20, devices[1])
	require.NoError(t, err)
	require.Len(t, history, 1)
	assert.Equal(t, survivor.MessageID, history[0].ID)
	var refreshPayload string
	require.NoError(t, pool.QueryRow(ctx, `SELECT payload::text FROM workspace_events WHERE event_type='secret_history_invalidated' AND channel_id=$1`, secret.DM.ConversationID).Scan(&refreshPayload))
	assert.JSONEq(t, `{"conversationId":"`+secret.DM.ConversationID.String()+`"}`, refreshPayload)
	// The author can also purge, while plaintext messages remain author-only.
	_, err = svc.DeleteMessage(ctx, chat.DeleteMessageParams{MessageID: survivor.MessageID, ActorID: author})
	require.NoError(t, err)
	normal, err := svc.SendMessage(ctx, chat.SendMessageParams{ChannelID: plain.DM.ConversationID, SenderID: author, ClientMsgID: uuid.NewString(), Body: "ordinary message"})
	require.NoError(t, err)
	_, err = svc.DeleteMessage(ctx, chat.DeleteMessageParams{MessageID: normal.MessageID, ActorID: peer})
	require.ErrorIs(t, err, chat.ErrMessageNotAuthor)
	_, err = svc.DeleteMessage(ctx, chat.DeleteMessageParams{MessageID: normal.MessageID, ActorID: author})
	require.NoError(t, err)
}
