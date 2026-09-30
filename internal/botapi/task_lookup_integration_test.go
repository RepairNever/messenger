//go:build integration

package botapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"msgnr/internal/tasks"
)

func (e *botTestEnv) lookupTasks(t *testing.T, path string) []map[string]any {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, e.ts.URL+path, nil)
	require.NoError(t, err)
	req.Header.Set("Authorization", "Bearer "+e.token)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var out []map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
	require.NotNil(t, out, "empty lookups must return [] rather than null")
	return out
}

func TestIntegration_BotAPI_TasksByVersion(t *testing.T) {
	env := newBotEnv(t)
	ctx := context.Background()
	human := env.seedHuman(t, "Release Owner")
	label := "Trade Financial API v1.113.0"
	escapedLabel := "Release / 100% + %2F #1 ?"
	items := []tasks.DictionaryItemInput{
		{ValueCode: "v113", ValueName: label, SortOrder: 1, IsActive: true},
		{ValueCode: "v113_alias", ValueName: label, SortOrder: 2, IsActive: true},
		{ValueCode: "rc", ValueName: label + " RC", SortOrder: 3, IsActive: true},
		{ValueCode: "unused", ValueName: "Unused release", SortOrder: 4, IsActive: true},
		{ValueCode: "escaped", ValueName: escapedLabel, SortOrder: 5, IsActive: true},
	}
	dict, err := env.tasks.CreateDictionary(ctx, tasks.CreateDictionaryParams{Code: "version", Name: "Version"})
	require.NoError(t, err)
	version, err := env.tasks.CreateDictionaryVersion(ctx, dict.ID, items, human)
	require.NoError(t, err)
	enumVersion := int32(version.Version)
	template, err := env.tasks.CreateTemplate(ctx, tasks.CreateTemplateParams{Prefix: "REL", SortOrder: 1, ActorID: human})
	require.NoError(t, err)
	status, err := env.tasks.CreateStatus(ctx, tasks.CreateStatusParams{Code: "release_open", Name: "Open", SortOrder: 1, ActorID: human})
	require.NoError(t, err)
	field, err := env.tasks.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: template.ID, Code: "version", Name: "Version", Type: "multi_enum", SortOrder: 1,
		EnumDictionaryID: &dict.ID,
	})
	require.NoError(t, err)
	createTask := func(title string, codes ...string) tasks.TaskResponse {
		t.Helper()
		raw, err := json.Marshal(codes)
		require.NoError(t, err)
		description := "Release task description"
		task, err := env.tasks.CreateTask(ctx, tasks.CreateTaskParams{
			TemplateID: template.ID, Title: title, Description: &description, StatusID: status.ID, ActorID: human,
			FieldValues: []tasks.FieldValueInput{{
				FieldDefinitionID: field.ID, ValueJSON: raw, EnumDictionaryID: &dict.ID, EnumVersion: &enumVersion,
			}},
		})
		require.NoError(t, err)
		return task
	}
	older := createTask("Linked release task", "v113")
	newer := createTask("Multiple matching versions", "v113", "v113_alias", "rc")
	createTask("Only a longer label", "rc")
	escaped := createTask("Reserved characters", "escaped")

	// Task lookup remains organization-wide even without discussion membership.
	foreignChannel := env.seedPublicChannel(t, human, "release-discussion")
	env.addMember(t, foreignChannel, human)
	_, err = env.pool.Exec(ctx, `UPDATE task SET discussion_channel_id = $2 WHERE id = $1`, older.ID, foreignChannel)
	require.NoError(t, err)
	// Preserve fixture timestamps rather than letting the update trigger reset them.
	tx, err := env.pool.Begin(ctx)
	require.NoError(t, err)
	defer tx.Rollback(ctx)
	_, err = tx.Exec(ctx, `SET LOCAL msgnr.preserve_task_updated_at = 'on'`)
	require.NoError(t, err)
	base := time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC)
	_, err = tx.Exec(ctx, `UPDATE task SET updated_at = $2 WHERE id = $1`, older.ID, base)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `UPDATE task SET updated_at = $2 WHERE id = $1`, newer.ID, base.Add(time.Hour))
	require.NoError(t, err)
	require.NoError(t, tx.Commit(ctx))
	var botMember bool
	err = env.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2)`, foreignChannel, env.botID).Scan(&botMember)
	require.NoError(t, err)
	assert.False(t, botMember)

	for _, query := range []string{label, strings.ToUpper(label), "  " + label + "  "} {
		t.Run(query, func(t *testing.T) {
			found := env.lookupTasks(t, "/api/bot/v1/tasks/by-enum/version/value/"+url.PathEscape(query))
			require.Len(t, found, 2, "whole-label matches must be deduplicated")
			assert.Equal(t, newer.PublicID, found[0]["public_id"])
			assert.Equal(t, older.PublicID, found[1]["public_id"])
			for _, item := range found {
				statusCode, individual := env.do(t, http.MethodGet, "/api/bot/v1/tasks/"+item["public_id"].(string), env.token, nil)
				require.Equal(t, http.StatusOK, statusCode)
				assert.Equal(t, individual, item, "lookup DTO must match individual task reads")
			}
		})
	}
	found := env.lookupTasks(t, "/api/bot/v1/tasks/by-enum/version/value/V113")
	require.Len(t, found, 2, "enum item codes are also matched case-insensitively")
	found = env.lookupTasks(t, "/api/bot/v1/tasks/by-enum/version/value/"+url.PathEscape(escapedLabel))
	require.Len(t, found, 1)
	assert.Equal(t, escaped.PublicID, found[0]["public_id"], "decode the path label exactly once")
	for _, query := range []string{"Unknown release", "Unused release", "Trade Financial API"} {
		assert.Empty(t, env.lookupTasks(t, "/api/bot/v1/tasks/by-enum/version/value/"+url.PathEscape(query)))
	}
	assert.Empty(t, env.lookupTasks(t, "/api/bot/v1/tasks/by-enum/unknown/value/"+url.PathEscape(label)))
	assert.Empty(t, env.lookupTasks(t, "/api/bot/v1/tasks/by-enum/VERSION/value/"+url.PathEscape(label)), "dictionary code matching is case-sensitive")

	// Renaming dictionary items leaves historical labels discoverable.
	items[0].ValueName = "Renamed release"
	items[1].ValueName = "Renamed release"
	_, err = env.tasks.CreateDictionaryVersion(ctx, dict.ID, items, human)
	require.NoError(t, err)
	assert.Len(t, env.lookupTasks(t, "/api/bot/v1/tasks/by-enum/version/value/"+url.PathEscape(label)), 2)
}

func TestIntegration_BotAPI_TasksByVersionErrors(t *testing.T) {
	env := newBotEnv(t)
	path := "/api/bot/v1/tasks/by-enum/version/value/release"
	for _, tc := range []struct {
		token string
		error string
	}{
		{"", "missing token"},
		{"wrong-token", "invalid token"},
	} {
		status, body := env.do(t, http.MethodGet, path, tc.token, nil)
		assert.Equal(t, http.StatusUnauthorized, status)
		assert.Equal(t, map[string]any{"error": tc.error}, body)
	}
	status, body := env.do(t, http.MethodPost, path, env.token, nil)
	assert.Equal(t, http.StatusMethodNotAllowed, status)
	assert.Equal(t, "method not allowed", body["error"])
	for _, invalid := range []string{
		"/api/bot/v1/tasks/by-enum/",
		"/api/bot/v1/tasks/by-enum/version/release",
		"/api/bot/v1/tasks/by-enum/%20/value/release",
		"/api/bot/v1/tasks/by-enum/version/value/",
		"/api/bot/v1/tasks/by-enum/version/value/%20%09",
		"/api/bot/v1/tasks/by-enum/version/value/release/extra",
	} {
		t.Run(invalid, func(t *testing.T) {
			status, body := env.do(t, http.MethodGet, invalid, env.token, nil)
			assert.Equal(t, http.StatusBadRequest, status)
			assert.Equal(t, map[string]any{"error": "invalid enum lookup path"}, body)
		})
	}
	_, err := env.pool.Exec(context.Background(), `UPDATE integration_token SET revoked_at = now() WHERE user_id = $1`, env.botID)
	require.NoError(t, err)
	status, body = env.do(t, http.MethodGet, path, env.token, nil)
	assert.Equal(t, http.StatusUnauthorized, status)
	assert.Equal(t, map[string]any{"error": "invalid token"}, body)
}
