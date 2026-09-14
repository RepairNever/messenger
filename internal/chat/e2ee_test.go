package chat

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	packetspb "msgnr/internal/gen/proto"
)

func TestStripEncryptedEventPayloadsClonesAndRemovesRecipients(t *testing.T) {
	evt := &packetspb.ServerEvent{
		EventSeq:  42,
		EventType: packetspb.EventType_EVENT_TYPE_MESSAGE_CREATED,
		Payload: &packetspb.ServerEvent_MessageCreated{
			MessageCreated: &packetspb.MessageEvent{
				ContentMode: packetspb.MessageContentMode_MESSAGE_CONTENT_MODE_DM_PAIRWISE_SIGNAL_V1,
				EncryptedDmPayload: &packetspb.EncryptedDMMessagePayload{
					Recipients: []*packetspb.EncryptedDMRecipientPayload{
						{RecipientDeviceId: "device-a", SessionMessage: []byte("a")},
						{RecipientDeviceId: "device-b", SessionMessage: []byte("b")},
					},
				},
			},
		},
	}

	filtered := StripEncryptedEventPayloads(evt)

	require.NotNil(t, filtered)
	assert.Len(t, evt.GetMessageCreated().GetEncryptedDmPayload().GetRecipients(), 2)
	assert.Empty(t, filtered.GetMessageCreated().GetEncryptedDmPayload().GetRecipients())
	assert.Equal(t, evt.GetEventSeq(), filtered.GetEventSeq())
}

func TestStripEncryptedEventPayloadsLeavesPlaintextEventUntouched(t *testing.T) {
	evt := &packetspb.ServerEvent{
		EventType: packetspb.EventType_EVENT_TYPE_MESSAGE_CREATED,
		Payload: &packetspb.ServerEvent_MessageCreated{
			MessageCreated: &packetspb.MessageEvent{
				ContentMode: packetspb.MessageContentMode_MESSAGE_CONTENT_MODE_PLAINTEXT,
			},
		},
	}

	assert.Same(t, evt, StripEncryptedEventPayloads(evt))
}
