package search

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"msgnr/internal/auth"
)

type stubSearchService struct {
	results         []MessageResult
	err             error
	lastRequesterID uuid.UUID
	lastQuery       string
	lastLimit       int
}

func (s *stubSearchService) SearchMessages(_ context.Context, requesterID uuid.UUID, query string, _ *uuid.UUID, limit int) ([]MessageResult, error) {
	s.lastRequesterID = requesterID
	s.lastQuery = query
	s.lastLimit = limit
	return s.results, s.err
}

func TestSearchMessagesRejectsShortQuery(t *testing.T) {
	h := NewHandler(nil, nil, nil)
	req := httptest.NewRequest("GET", "/api/search/messages?q=x", nil)
	rec := httptest.NewRecorder()

	h.searchMessages(rec, req, auth.Principal{})

	require.Equal(t, 400, rec.Code)
	assert.Contains(t, rec.Body.String(), "q must be at least 2 characters")
}

func TestSearchMessagesRejectsInvalidConversationID(t *testing.T) {
	h := NewHandler(nil, nil, nil)
	req := httptest.NewRequest("GET", "/api/search/messages?q=needle&conversation_id=bad", nil)
	rec := httptest.NewRecorder()

	h.searchMessages(rec, req, auth.Principal{})

	require.Equal(t, 400, rec.Code)
	assert.Contains(t, rec.Body.String(), "invalid conversation_id")
}

func TestSearchMessagesRejectsInvalidLimit(t *testing.T) {
	h := NewHandler(nil, nil, nil)
	req := httptest.NewRequest("GET", "/api/search/messages?q=needle&limit=zero", nil)
	rec := httptest.NewRecorder()

	h.searchMessages(rec, req, auth.Principal{})

	require.Equal(t, 400, rec.Code)
	assert.Contains(t, rec.Body.String(), "limit must be")
}

func TestSearchMessagesDefaultsZeroLimitAndMapsSuccess(t *testing.T) {
	svc := &stubSearchService{
		results: []MessageResult{{
			Source:              MessageSourceTaskComment,
			ID:                  "task-comment:comment-1",
			Body:                "needle task comment",
			CreatedAt:           time.Date(2026, 5, 12, 0, 0, 0, 0, time.UTC),
			ActorID:             "user-1",
			ActorName:           "Ada",
			TaskID:              "task-1",
			TaskPublicID:        "TASK-1",
			TaskTitle:           "Fix search",
			TaskCommentID:       "comment-1",
			ThreadRootMessageID: "root-1",
		}},
	}
	h := NewHandler(svc, nil, nil)
	principal := auth.Principal{UserID: uuid.MustParse("00000000-0000-0000-0000-000000000123")}
	req := httptest.NewRequest("GET", "/api/search/messages?q=needle&limit=0", nil)
	rec := httptest.NewRecorder()

	h.searchMessages(rec, req, principal)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, principal.UserID, svc.lastRequesterID)
	assert.Equal(t, "needle", svc.lastQuery)
	assert.Equal(t, defaultMessageSearchLimit, svc.lastLimit)
	assert.Contains(t, rec.Body.String(), `"total_count":1`)
	assert.Contains(t, rec.Body.String(), `"source":"task_comment"`)
	assert.NotContains(t, rec.Body.String(), `"message_id"`)
	assert.Contains(t, rec.Body.String(), `"thread_root_message_id":"root-1"`)
}
