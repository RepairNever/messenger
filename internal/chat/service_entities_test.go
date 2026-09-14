package chat

import (
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestMentionedUserIDsFromEntities_DeduplicatesUsers(t *testing.T) {
	userID := uuid.New()
	otherUserID := uuid.New()

	got := mentionedUserIDsFromEntities([]MessageEntity{
		{Kind: MessageEntityKindUser, TargetID: userID},
		{Kind: MessageEntityKindTask, TargetID: uuid.New()},
		{Kind: MessageEntityKindUser, TargetID: userID},
		{Kind: MessageEntityKindUser, TargetID: otherUserID},
	})

	require.Equal(t, []uuid.UUID{userID, otherUserID}, got)
}

func TestValidateEntityHref(t *testing.T) {
	require.NoError(t, validateEntityHref("/tasks/dev-1", "/tasks/dev-1"))
	require.Error(t, validateEntityHref("/tasks/dev-2", "/tasks/dev-1"))
	require.Error(t, validateEntityHref("", "/tasks/dev-1"))
}
