//go:build integration

package botapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"msgnr/internal/documents"
)

func (e *botTestEnv) documentTeamspace(t *testing.T, includeBot bool) uuid.UUID {
	t.Helper()
	owner := e.seedHuman(t, "Document Owner")
	_, err := e.pool.Exec(context.Background(), `UPDATE users SET role = 'admin' WHERE id = $1`, owner)
	require.NoError(t, err)
	var members []uuid.UUID
	if includeBot {
		members = append(members, e.botID)
	}
	space, err := e.documents.CreateTeamspace(context.Background(), documents.CreateTeamspaceParams{
		Name: "Bot reports", ActorID: owner, MemberIDs: members,
	}, "admin")
	require.NoError(t, err)
	return space.ID
}

func TestIntegration_BotAPI_CreateDocument(t *testing.T) {
	env := newBotEnv(t)
	teamspaceID := env.documentTeamspace(t, true)
	// Reports may exceed the chat message limit; preserve Markdown verbatim.
	markdown := "\n# Report\n\n" + strings.Repeat("- **Finding**: Привет 世界\n", 2000) + "\n"
	status, body := env.do(t, http.MethodPost, "/api/bot/v1/documents", env.token, map[string]any{
		"title": "  Generated report  ", "description": markdown,
		"teamspace_id": teamspaceID, "parent_id": nil,
		"actor_id": uuid.New(), "created_by": uuid.New(),
	})
	require.Equal(t, http.StatusCreated, status, "%v", body)
	require.Len(t, body, 5)
	id, err := uuid.Parse(body["id"].(string))
	require.NoError(t, err)
	assert.NotEqual(t, uuid.Nil, id)
	assert.Equal(t, "Generated report", body["title"])
	assert.Equal(t, markdown, body["description"])
	assert.Contains(t, body, "parent_id")
	assert.Nil(t, body["parent_id"])
	assert.Equal(t, "/documents/"+id.String(), body["url"])

	doc, err := env.documents.GetDocument(context.Background(), id, env.botID)
	require.NoError(t, err)
	assert.Equal(t, teamspaceID, doc.TeamspaceID)
	assert.Equal(t, env.botID, doc.CreatedBy)
	assert.Equal(t, env.botID, doc.UpdatedBy)
	require.NotNil(t, doc.ContentMarkdown)
	assert.Equal(t, markdown, *doc.ContentMarkdown)

	status, child := env.do(t, http.MethodPost, "/api/bot/v1/documents", env.token, map[string]any{
		"title": "Child report", "description": "", "teamspace_id": teamspaceID, "parent_id": id,
	})
	require.Equal(t, http.StatusCreated, status, "%v", child)
	assert.Equal(t, id.String(), child["parent_id"])
	assert.Equal(t, "", child["description"])
	childID := uuid.MustParse(child["id"].(string))
	doc, err = env.documents.GetDocument(context.Background(), childID, env.botID)
	require.NoError(t, err)
	require.NotNil(t, doc.ParentDocumentID)
	assert.Equal(t, id, *doc.ParentDocumentID)
	assert.Equal(t, teamspaceID, doc.TeamspaceID)

	// Omitted optional values retain the integration endpoint's null semantics.
	status, empty := env.do(t, http.MethodPost, "/api/bot/v1/documents", env.token, map[string]any{
		"title": "Empty report", "teamspace_id": teamspaceID,
	})
	require.Equal(t, http.StatusCreated, status, "%v", empty)
	assert.Contains(t, empty, "description")
	assert.Nil(t, empty["description"])
	assert.Contains(t, empty, "parent_id")
	assert.Nil(t, empty["parent_id"])
}

func TestIntegration_BotAPI_CreateDocumentValidationAndAuth(t *testing.T) {
	env := newBotEnv(t)
	teamspaceID := env.documentTeamspace(t, true)
	valid := map[string]any{"title": "Report", "teamspace_id": teamspaceID}
	for _, token := range []string{"", "wrong-token"} {
		status, body := env.do(t, http.MethodPost, "/api/bot/v1/documents", token, valid)
		assert.Equal(t, http.StatusUnauthorized, status)
		assert.NotEmpty(t, body["error"])
	}
	status, body := env.do(t, http.MethodGet, "/api/bot/v1/documents", env.token, nil)
	assert.Equal(t, http.StatusMethodNotAllowed, status)
	assert.NotEmpty(t, body["error"])

	for _, tc := range []struct {
		name  string
		field string
		value any
	}{
		{"missing title", "title", nil},
		{"blank title", "title", " \n\t"},
		{"non-string title", "title", 123},
		{"missing teamspace", "teamspace_id", nil},
		{"null teamspace", "teamspace_id", json.RawMessage(`null`)},
		{"malformed teamspace", "teamspace_id", "not-a-uuid"},
		{"empty teamspace", "teamspace_id", ""},
		{"zero teamspace", "teamspace_id", uuid.Nil},
		{"malformed parent", "parent_id", "not-a-uuid"},
		{"empty parent", "parent_id", ""},
		{"zero parent", "parent_id", uuid.Nil},
		{"non-string description", "description", 123},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := map[string]any{"title": "Report", "teamspace_id": teamspaceID}
			if tc.value == nil {
				delete(request, tc.field)
			} else {
				request[tc.field] = tc.value
			}
			status, body := env.do(t, http.MethodPost, "/api/bot/v1/documents", env.token, request)
			assert.Equal(t, http.StatusBadRequest, status, "%v", body)
			assert.NotEmpty(t, body["error"])
		})
	}
	for _, raw := range []string{"", `{`, `[]`, `null`} {
		req, err := http.NewRequest(http.MethodPost, env.ts.URL+"/api/bot/v1/documents", strings.NewReader(raw))
		require.NoError(t, err)
		req.Header.Set("Authorization", "Bearer "+env.token)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		var body map[string]any
		err = json.NewDecoder(resp.Body).Decode(&body)
		resp.Body.Close()
		require.NoError(t, err)
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode, "body: %s", raw)
		assert.NotEmpty(t, body["error"])
	}
	var count int
	require.NoError(t, env.pool.QueryRow(context.Background(), `SELECT count(*) FROM document`).Scan(&count))
	assert.Zero(t, count, "rejected requests must not create documents")
}

func TestIntegration_BotAPI_CreateDocumentTeamspaceAccess(t *testing.T) {
	env := newBotEnv(t)
	teamspaceID := env.documentTeamspace(t, true)
	otherTeamspaceID := env.documentTeamspace(t, true)
	privateTeamspaceID := env.documentTeamspace(t, false)
	missingParentID := uuid.New()
	parent, err := env.documents.CreateDocument(context.Background(), documents.CreateDocumentParams{
		Title: "Parent", TeamspaceID: otherTeamspaceID, ActorID: env.botID,
	})
	require.NoError(t, err)

	for _, tc := range []struct {
		name        string
		teamspaceID uuid.UUID
		parentID    *uuid.UUID
		status      int
		error       string
	}{
		{"non-member", privateTeamspaceID, nil, http.StatusForbidden, "forbidden: teamspace"},
		{"parent cannot grant membership", privateTeamspaceID, &parent.ID, http.StatusForbidden, "forbidden: teamspace"},
		{"parent teamspace mismatch", teamspaceID, &parent.ID, http.StatusBadRequest, "bad request: parent document belongs to another teamspace"},
		{"unknown teamspace", uuid.New(), nil, http.StatusNotFound, "not found: teamspace"},
		{"unknown parent", teamspaceID, &missingParentID, http.StatusNotFound, "not found: parent document"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status, body := env.do(t, http.MethodPost, "/api/bot/v1/documents", env.token, map[string]any{
				"title": "Report", "teamspace_id": tc.teamspaceID, "parent_id": tc.parentID,
			})
			assert.Equal(t, tc.status, status, "%v", body)
			assert.Equal(t, map[string]any{"error": tc.error}, body)
		})
	}
	var count int
	require.NoError(t, env.pool.QueryRow(context.Background(), `SELECT count(*) FROM document`).Scan(&count))
	assert.Equal(t, 1, count, "rejected requests must leave only the seeded parent")
}
