package events

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	packetspb "msgnr/internal/gen/proto"
)

func TestBuildServerEventFromStored_DecodesMessageCreated(t *testing.T) {
	occurredAt := time.Unix(1700000000, 0).UTC()
	payload := []byte(`{
		"conversationId":"c1",
		"messageId":"m1",
		"senderId":"u1",
		"body":"hello",
		"channelSeq":"12"
	}`)

	evt, err := buildServerEventFromStored(
		"message_created",
		"11111111-1111-1111-1111-111111111111",
		"22222222-2222-2222-2222-222222222222",
		occurredAt,
		payload,
	)
	require.NoError(t, err)
	require.NotNil(t, evt)
	assert.Equal(t, packetspb.EventType_EVENT_TYPE_MESSAGE_CREATED, evt.GetEventType())
	require.NotNil(t, evt.GetMessageCreated())
	assert.Equal(t, "m1", evt.GetMessageCreated().GetMessageId())
	assert.Equal(t, "22222222-2222-2222-2222-222222222222", evt.GetConversationId())
}

func TestBuildServerEventFromStored_RejectsTypePayloadMismatch(t *testing.T) {
	_, err := buildServerEventFromStored(
		"message_created",
		"11111111-1111-1111-1111-111111111111",
		"",
		time.Now().UTC(),
		[]byte(`{"channelSeq":"not-an-int64"}`),
	)
	require.Error(t, err)
}

func TestBuildServerEventFromStored_DecodesUserIdentityUpdated(t *testing.T) {
	occurredAt := time.Unix(1700001000, 0).UTC()
	payload := []byte(`{
		"userId":"u1",
		"displayName":"Ada",
		"avatarUrl":"/api/public/avatars/avatars/u1/a.png"
	}`)

	evt, err := buildServerEventFromStored(
		"user_identity_updated",
		"33333333-3333-3333-3333-333333333333",
		"",
		occurredAt,
		payload,
	)
	require.NoError(t, err)
	require.NotNil(t, evt)
	assert.Equal(t, packetspb.EventType_EVENT_TYPE_USER_IDENTITY_UPDATED, evt.GetEventType())
	require.NotNil(t, evt.GetUserIdentityUpdated())
	assert.Equal(t, "u1", evt.GetUserIdentityUpdated().GetUserId())
	assert.Equal(t, "Ada", evt.GetUserIdentityUpdated().GetDisplayName())
}

func TestBuildServerEventFromStored_DecodesTaskStatusChanged(t *testing.T) {
	occurredAt := time.Unix(1700002000, 0).UTC()
	payload := []byte(`{
		"taskId":"task-1",
		"publicId":"BUG-1",
		"fromStatusId":"st-1",
		"toStatusId":"st-2",
		"updatedBy":"user-1",
		"updatedAt":"2026-03-18T12:00:00Z"
	}`)

	evt, err := buildServerEventFromStored(
		"task_status_changed",
		"44444444-4444-4444-4444-444444444444",
		"",
		occurredAt,
		payload,
	)
	require.NoError(t, err)
	require.NotNil(t, evt)
	assert.Equal(t, packetspb.EventType_EVENT_TYPE_TASK_STATUS_CHANGED, evt.GetEventType())
	require.NotNil(t, evt.GetTaskStatusChanged())
	assert.Equal(t, "task-1", evt.GetTaskStatusChanged().GetTaskId())
	assert.Equal(t, "BUG-1", evt.GetTaskStatusChanged().GetPublicId())
}

func TestBuildServerEventFromStored_DecodesUserCallPresenceChanged(t *testing.T) {
	occurredAt := time.Unix(1700003000, 0).UTC()
	payload := []byte(`{
		"userId":"user-7",
		"activeCallCount":2
	}`)

	evt, err := buildServerEventFromStored(
		"user_call_presence_changed",
		"55555555-5555-5555-5555-555555555555",
		"",
		occurredAt,
		payload,
	)
	require.NoError(t, err)
	require.NotNil(t, evt)
	assert.Equal(t, packetspb.EventType_EVENT_TYPE_USER_CALL_PRESENCE_CHANGED, evt.GetEventType())
	require.NotNil(t, evt.GetUserCallPresenceChanged())
	assert.Equal(t, "user-7", evt.GetUserCallPresenceChanged().GetUserId())
	assert.Equal(t, int32(2), evt.GetUserCallPresenceChanged().GetActiveCallCount())
	assert.Empty(t, evt.GetConversationId())
}

func TestSecretHistoryInvalidatedCodecAndValidation(t *testing.T) {
	evt, err := buildServerEventFromStored("secret_history_invalidated", "refresh", "conversation", time.Now(), []byte(`{"conversationId":"conversation"}`))
	require.NoError(t, err)
	require.NotNil(t, evt.GetSecretHistoryInvalidated())
	assert.Equal(t, "conversation", evt.GetSecretHistoryInvalidated().GetConversationId())
	require.NoError(t, ValidateEventTypePayload("secret_history_invalidated", evt))
	require.Error(t, ValidateEventTypePayload("secret_history_invalidated", &packetspb.ServerEvent{EventType: packetspb.EventType_EVENT_TYPE_SECRET_HISTORY_INVALIDATED}))
}

func TestTaskCommentCreatedCodecAndValidation(t *testing.T) {
	payload := []byte(`{
		"taskId":"task-9",
		"publicId":"DEV-42",
		"commentId":"comment-1",
		"authorId":"user-1",
		"authorName":"Ada",
		"body":"looks good",
		"attachmentCount":2,
		"discussionChannelId":"chan-1",
		"threadRootMessageId":"msg-1"
	}`)

	evt, err := buildServerEventFromStored("task_comment_created", "66666666-6666-6666-6666-666666666666", "chan-1", time.Unix(1700004000, 0).UTC(), payload)
	require.NoError(t, err)
	require.NotNil(t, evt)
	assert.Equal(t, packetspb.EventType_EVENT_TYPE_TASK_COMMENT_CREATED, evt.GetEventType())
	assert.Equal(t, "chan-1", evt.GetConversationId())
	require.NotNil(t, evt.GetTaskCommentCreated())
	got := evt.GetTaskCommentCreated()
	assert.Equal(t, "task-9", got.GetTaskId())
	assert.Equal(t, "DEV-42", got.GetPublicId())
	assert.Equal(t, "comment-1", got.GetCommentId())
	assert.Equal(t, "user-1", got.GetAuthorId())
	assert.Equal(t, "Ada", got.GetAuthorName())
	assert.Equal(t, "looks good", got.GetBody())
	assert.Equal(t, int32(2), got.GetAttachmentCount())
	assert.Equal(t, "chan-1", got.GetDiscussionChannelId())
	assert.Equal(t, "msg-1", got.GetThreadRootMessageId())
	require.NoError(t, ValidateEventTypePayload("task_comment_created", evt))
	require.Error(t, ValidateEventTypePayload("task_comment_created", &packetspb.ServerEvent{EventType: packetspb.EventType_EVENT_TYPE_TASK_COMMENT_CREATED}))
}
