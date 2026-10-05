package chat

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// The entity-count guards run before any database access, so a zero-value
// Service is safe here: the call must fail with ErrInvalidMessageEntity long
// before the (nil) pool would be touched.

func TestSendMessage_RejectsTooManyEntities(t *testing.T) {
	svc := &Service{}

	_, err := svc.SendMessage(context.Background(), SendMessageParams{
		ChannelID:   uuid.New(),
		SenderID:    uuid.New(),
		ClientMsgID: "entity-limit-test",
		Body:        "x",
		Entities:    tooManyEntities(),
	})

	require.True(t, errors.Is(err, ErrInvalidMessageEntity), "expected ErrInvalidMessageEntity, got %v", err)
}

func TestEditMessage_RejectsTooManyEntities(t *testing.T) {
	svc := &Service{}

	_, err := svc.EditMessage(context.Background(), EditMessageParams{
		MessageID: uuid.New(),
		ActorID:   uuid.New(),
		Body:      "x",
		Entities:  tooManyEntities(),
	})

	require.True(t, errors.Is(err, ErrInvalidMessageEntity), "expected ErrInvalidMessageEntity, got %v", err)
}

func tooManyEntities() []MessageEntity {
	entities := make([]MessageEntity, MaxMessageEntities+1)
	for i := range entities {
		entities[i] = MessageEntity{Kind: MessageEntityKindTask, TargetID: uuid.New(), Label: "x", Start: 0, End: 1}
	}
	return entities
}
