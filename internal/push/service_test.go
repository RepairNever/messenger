package push

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"

	"msgnr/internal/chat"
	"msgnr/internal/config"
	packetspb "msgnr/internal/gen/proto"
)

func newQueueOnlyPushServiceForTest() *Service {
	return &Service{
		cfg: &config.Config{
			VAPIDPublicKey:  "test-public-key",
			VAPIDPrivateKey: "test-private-key",
		},
		log:       zap.NewNop(),
		enqueueCh: make(chan pushJob, 4),
		stopCh:    make(chan struct{}),
	}
}

func TestPushChatDeliveriesUsesNotificationMessageTargets(t *testing.T) {
	svc := newQueueOnlyPushServiceForTest()

	svc.PushChatDeliveries([]chat.DirectDelivery{{
		UserID: "user-1",
		Event: &packetspb.ServerEvent{
			EventType:      packetspb.EventType_EVENT_TYPE_NOTIFICATION_ADDED,
			ConversationId: "channel-1",
			Payload: &packetspb.ServerEvent_NotificationAdded{
				NotificationAdded: &packetspb.NotificationAddedEvent{
					UserId: "user-1",
					Notification: &packetspb.NotificationSummary{
						NotificationId:      "notification-1",
						Type:                packetspb.NotificationType_NOTIFICATION_TYPE_THREAD_REPLY,
						Title:               "Thread reply",
						Body:                "reply",
						ConversationId:      "channel-1",
						MessageId:           "reply-1",
						ThreadRootMessageId: "root-1",
					},
				},
			},
		},
	}})

	var job pushJob
	select {
	case job = <-svc.enqueueCh:
	case <-time.After(time.Second):
		require.FailNow(t, "expected push job to be enqueued")
	}
	assert.Equal(t, "user-1", job.userID)
	assert.Equal(t, "channel-1", job.payload.ConversationID)
	assert.Equal(t, "reply-1", job.payload.MessageID)
	assert.Equal(t, "root-1", job.payload.ThreadRootID)
}

func TestPushChatDeliveriesMessageAlertCarriesThreadRoot(t *testing.T) {
	svc := newQueueOnlyPushServiceForTest()

	svc.PushChatDeliveries([]chat.DirectDelivery{{
		UserID: "user-1",
		Event: &packetspb.ServerEvent{
			EventType:      packetspb.EventType_EVENT_TYPE_MESSAGE_ALERT,
			ConversationId: "channel-1",
			Payload: &packetspb.ServerEvent_MessageAlert{
				MessageAlert: &packetspb.MessageAlertEvent{
					ConversationId:      "channel-1",
					MessageId:           "reply-1",
					ThreadRootMessageId: "root-1",
					SenderName:          "Bob",
					Body:                "reply",
				},
			},
		},
	}})

	var job pushJob
	select {
	case job = <-svc.enqueueCh:
	case <-time.After(time.Second):
		require.FailNow(t, "expected push job to be enqueued")
	}
	assert.Equal(t, "user-1", job.userID)
	assert.Equal(t, "channel-1", job.payload.ConversationID)
	assert.Equal(t, "reply-1", job.payload.MessageID)
	assert.Equal(t, "root-1", job.payload.ThreadRootID)
}
