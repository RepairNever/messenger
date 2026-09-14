package tasks

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"msgnr/internal/auth"
)

func TestParseTaskFilterParams_IncludeSubtasks(t *testing.T) {
	t.Run("defaults to false when absent", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/tasks", nil)

		params, err := parseTaskFilterParams(req)
		require.NoError(t, err)
		assert.False(t, params.IncludeSubtasks)
	})

	t.Run("parses true when provided", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/tasks?include_subtasks=true", nil)

		params, err := parseTaskFilterParams(req)
		require.NoError(t, err)
		assert.True(t, params.IncludeSubtasks)
	})
}

func TestParseTaskFilterParams_DictionaryEnumFilters(t *testing.T) {
	dictID := uuid.New()
	req := httptest.NewRequest(
		"GET",
		"/api/tasks?dictionary_"+dictID.String()+"_enum=high&dictionary_"+dictID.String()+"_enum=low",
		nil,
	)

	params, err := parseTaskFilterParams(req)
	require.NoError(t, err)
	require.Len(t, params.DictionaryFilters, 1)
	assert.Equal(t, dictID, params.DictionaryFilters[0].DictionaryID)
	assert.ElementsMatch(t, []string{"high", "low"}, params.DictionaryFilters[0].EnumCodes)
}

func TestParseTaskFilterParams_CreatedDateFilters(t *testing.T) {
	req := httptest.NewRequest(
		http.MethodGet,
		"/api/tasks?created_from=2026-05-01&created_to=2026-05-03",
		nil,
	)

	params, err := parseTaskFilterParams(req)
	require.NoError(t, err)
	require.NotNil(t, params.CreatedFrom)
	require.NotNil(t, params.CreatedTo)
	assert.Equal(t, time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC), *params.CreatedFrom)
	assert.Equal(t, time.Date(2026, 5, 4, 0, 0, 0, 0, time.UTC), *params.CreatedTo)
}

func TestParseTaskFilterParams_InvalidCreatedDateFilters(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/tasks?created_from=2026-13-01", nil)

	_, err := parseTaskFilterParams(req)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid created_from")
}

func TestParseTaskFilterParams_InvertedCreatedDateFilters(t *testing.T) {
	req := httptest.NewRequest(
		http.MethodGet,
		"/api/tasks?created_from=2026-05-10&created_to=2026-05-01",
		nil,
	)

	_, err := parseTaskFilterParams(req)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "created_from must be before or equal to created_to")
}

func TestParseTaskFilterParams_TrimsFieldEnumFilters(t *testing.T) {
	fieldID := uuid.New()
	req := httptest.NewRequest(
		"GET",
		"/api/tasks?field_"+fieldID.String()+"_enum=%20high%20&field_"+fieldID.String()+"_enum=",
		nil,
	)

	params, err := parseTaskFilterParams(req)
	require.NoError(t, err)
	require.Len(t, params.FieldFilters, 1)
	assert.Equal(t, fieldID, params.FieldFilters[0].FieldDefinitionID)
	assert.Equal(t, []string{"high"}, params.FieldFilters[0].EnumCodes)
}

func TestParseListTasksParams_SortOrderValidation(t *testing.T) {
	t.Run("defaults to descending", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/tasks", nil)

		params, err := parseListTasksParams(req)
		require.NoError(t, err)
		assert.True(t, params.SortDesc)
	})

	t.Run("parses ascending", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/tasks?sort_order=asc", nil)

		params, err := parseListTasksParams(req)
		require.NoError(t, err)
		assert.False(t, params.SortDesc)
	})

	t.Run("rejects invalid values", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/tasks?sort_order=newest", nil)

		_, err := parseListTasksParams(req)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "invalid sort_order")
	})
}

func TestTaskCommentsRouter_InvalidUpdateCommentID(t *testing.T) {
	h := &Handler{}
	req := httptest.NewRequest(http.MethodPut, "/api/tasks/task/comments/not-a-uuid", strings.NewReader(`{"body":"x"}`))
	rec := httptest.NewRecorder()

	h.taskCommentsRouter(rec, req, auth.Principal{UserID: uuid.New()}, uuid.New(), "/not-a-uuid")

	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), "invalid comment id")
}

func TestTaskCommentUpdate_InvalidRequestBody(t *testing.T) {
	h := &Handler{}
	req := httptest.NewRequest(http.MethodPut, "/api/tasks/task/comments/"+uuid.NewString(), strings.NewReader(`{`))
	rec := httptest.NewRecorder()

	h.taskCommentUpdate(rec, req, auth.Principal{UserID: uuid.New()}, uuid.New(), uuid.New())

	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), "invalid request body")
}
