package chat

import (
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"msgnr/internal/auth"
	"msgnr/internal/config"
)

func TestListConversationMessages_InvalidConversationID(t *testing.T) {
	h := NewHandler(nil, nil, &config.Config{ChatHistoryPageSize: 50})
	req := httptest.NewRequest("GET", "/api/messages?conversation_id=not-a-uuid", nil)
	rec := httptest.NewRecorder()

	h.listConversationMessages(rec, req, auth.Principal{})

	require.Equal(t, 400, rec.Code)
	assert.Contains(t, rec.Body.String(), "invalid conversation_id")
}

func TestListConversationMessages_InvalidBeforeChannelSeq(t *testing.T) {
	h := NewHandler(nil, nil, &config.Config{ChatHistoryPageSize: 50})
	req := httptest.NewRequest("GET", "/api/messages?conversation_id=89d8e95f-bfd1-4476-a6d9-9856c0ec7c4f&before_channel_seq=bad", nil)
	rec := httptest.NewRecorder()

	h.listConversationMessages(rec, req, auth.Principal{})

	require.Equal(t, 400, rec.Code)
	assert.Contains(t, rec.Body.String(), "invalid before_channel_seq")
}

func TestListConversationMessages_RejectsNonPositiveBeforeChannelSeq(t *testing.T) {
	h := NewHandler(nil, nil, &config.Config{ChatHistoryPageSize: 50})
	req := httptest.NewRequest("GET", "/api/messages?conversation_id=89d8e95f-bfd1-4476-a6d9-9856c0ec7c4f&before_channel_seq=0", nil)
	rec := httptest.NewRecorder()

	h.listConversationMessages(rec, req, auth.Principal{})

	require.Equal(t, 400, rec.Code)
	assert.Contains(t, rec.Body.String(), "before_channel_seq must be")
}

func TestListMessageReactionUsers_InvalidConversationID(t *testing.T) {
	h := NewHandler(nil, nil, &config.Config{ChatHistoryPageSize: 50})
	req := httptest.NewRequest("GET", "/api/messages/reaction-users?conversation_id=bad&message_id=89d8e95f-bfd1-4476-a6d9-9856c0ec7c4f&emoji=%F0%9F%91%8D", nil)
	rec := httptest.NewRecorder()

	h.listMessageReactionUsers(rec, req, auth.Principal{})

	require.Equal(t, 400, rec.Code)
	assert.Contains(t, rec.Body.String(), "invalid conversation_id")
}

func TestListMessageReactionUsers_InvalidMessageID(t *testing.T) {
	h := NewHandler(nil, nil, &config.Config{ChatHistoryPageSize: 50})
	req := httptest.NewRequest("GET", "/api/messages/reaction-users?conversation_id=89d8e95f-bfd1-4476-a6d9-9856c0ec7c4f&message_id=bad&emoji=%F0%9F%91%8D", nil)
	rec := httptest.NewRecorder()

	h.listMessageReactionUsers(rec, req, auth.Principal{})

	require.Equal(t, 400, rec.Code)
	assert.Contains(t, rec.Body.String(), "invalid message_id")
}

func TestListMessageReactionUsers_RequiresEmoji(t *testing.T) {
	h := NewHandler(nil, nil, &config.Config{ChatHistoryPageSize: 50})
	req := httptest.NewRequest("GET", "/api/messages/reaction-users?conversation_id=89d8e95f-bfd1-4476-a6d9-9856c0ec7c4f&message_id=cc6510e3-d428-4043-a70f-56855762f8f6&emoji=%20%20", nil)
	rec := httptest.NewRecorder()

	h.listMessageReactionUsers(rec, req, auth.Principal{})

	require.Equal(t, 400, rec.Code)
	assert.Contains(t, rec.Body.String(), "emoji is required")
}

func TestListActiveCallMembers_InvalidConversationID(t *testing.T) {
	h := NewHandler(nil, nil, &config.Config{ChatHistoryPageSize: 50})
	req := httptest.NewRequest("GET", "/api/conversations/active-call-members?conversation_id=bad", nil)
	rec := httptest.NewRecorder()

	h.listActiveCallMembers(rec, req, auth.Principal{})

	require.Equal(t, 400, rec.Code)
	assert.Contains(t, rec.Body.String(), "invalid conversation_id")
}

func TestMatchesETag(t *testing.T) {
	const etag = `"chat-thumbnail-v1-attachment-42"`

	assert.True(t, matchesETag(etag, etag))
	assert.True(t, matchesETag(`"other", `+etag, etag))
	assert.True(t, matchesETag("*", etag))
	assert.False(t, matchesETag(`"other"`, etag))
}
