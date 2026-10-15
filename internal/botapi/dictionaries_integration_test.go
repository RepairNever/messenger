//go:build integration

package botapi_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"msgnr/internal/tasks"
)

func dictionaryItemsPath(id uuid.UUID) string {
	return "/api/bot/v1/dictionaries/" + id.String() + "/items"
}

func dictionarySnapshot(t *testing.T, env *botTestEnv) string {
	t.Helper()
	var snapshot string
	err := env.pool.QueryRow(context.Background(), `SELECT jsonb_build_object(
		'dictionaries', (SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM enum_dictionary d),
		'versions', (SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM enum_dictionary_version v),
		'items', (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM enum_dictionary_version_item i)
	)::text`).Scan(&snapshot)
	require.NoError(t, err)
	return snapshot
}

func TestIntegration_BotAPI_DictionaryItemsCreate(t *testing.T) {
	f := newTaskWriteFixture(t)
	env, ctx := f.env, context.Background()
	_, err := env.tasks.UpdateDictionarySettings(ctx, f.dictionary.ID, true, false)
	require.NoError(t, err)
	originalVersions, err := env.tasks.ListDictionaryVersions(ctx, f.dictionary.ID)
	require.NoError(t, err)
	require.Len(t, originalVersions, 1)
	originalItems, err := env.tasks.GetDictionaryVersionItems(ctx, originalVersions[0].ID, "", 0, nil)
	require.NoError(t, err)
	// Removing an item creates another version, so a bot append must target
	// the current version while preserving the historical snapshot.
	current, err := env.tasks.CreateDictionaryVersion(ctx, f.dictionary.ID, []tasks.DictionaryItemInput{
		{ValueCode: "todo", ValueName: "To Do", SortOrder: 1, IsActive: true},
		{ValueCode: "done", ValueName: "Done", SortOrder: 2, IsActive: true},
	}, f.human)
	require.NoError(t, err)
	require.NotEqual(t, originalVersions[0].ID, current.ID)

	status, item := env.do(t, http.MethodPost, dictionaryItemsPath(f.dictionary.ID), env.token, map[string]any{"value": " \tНовый этап\n "})
	require.Equal(t, http.StatusCreated, status, "response: %#v", item)
	itemID, err := uuid.Parse(item["id"].(string))
	require.NoError(t, err)
	assert.NotEqual(t, uuid.Nil, itemID)
	assert.Equal(t, map[string]any{
		"id":                    itemID.String(),
		"dictionary_version_id": current.ID.String(),
		"value_code":            "Новый этап",
		"value_name":            "Новый этап",
		"sort_order":            float64(3),
		"is_active":             true,
	}, item)
	versions, err := env.tasks.ListDictionaryVersions(ctx, f.dictionary.ID)
	require.NoError(t, err)
	assert.Len(t, versions, 2, "appending an item must not create a new version")
	dictionary, err := env.tasks.GetDictionary(ctx, f.dictionary.ID)
	require.NoError(t, err)
	assert.Equal(t, current.Version, dictionary.CurrentVersion)
	stored, err := env.tasks.GetDictionaryVersionItems(ctx, current.ID, "", 0, nil)
	require.NoError(t, err)
	require.Len(t, stored, 3)
	assert.Equal(t, itemID, stored[2].ID)
	historical, err := env.tasks.GetDictionaryVersionItems(ctx, originalVersions[0].ID, "", 0, nil)
	require.NoError(t, err)
	assert.Equal(t, originalItems, historical)

	t.Run("public setting is discoverable", func(t *testing.T) {
		status, config := env.do(t, http.MethodGet, "/api/bot/v1/tasks/config", env.token, nil)
		require.Equal(t, http.StatusOK, status)
		templates := config["templates"].([]any)
		require.Len(t, templates, 1)
		found := 0
		for _, raw := range templates[0].(map[string]any)["fields"].([]any) {
			field := raw.(map[string]any)
			if field["code"] == "state" || field["code"] == "states" {
				assert.Equal(t, map[string]any{
					"id": f.dictionary.ID.String(), "code": f.dictionary.Code,
					"is_public": true, "current_version": float64(current.Version),
				}, field["dictionary"])
				found++
			}
		}
		assert.Equal(t, 2, found)
	})

	t.Run("new values work in task create and update", func(t *testing.T) {
		status, created := env.do(t, http.MethodPost, "/api/bot/v1/tasks", env.token,
			f.createBody("New dictionary value", taskWriteField("state", item["value_code"]), taskWriteField("states", []any{item["value_code"]})))
		require.Equal(t, http.StatusCreated, status, "response: %#v", created)
		fields := taskWriteFields(t, created)
		assert.Equal(t, "Новый этап", fields["state"]["value_text"])
		assert.Equal(t, []any{"Новый этап"}, fields["states"]["value_json"])
		assert.Equal(t, float64(current.Version), fields["state"]["enum_version"])
		taskWriteAssertReadBack(t, env, created)

		status, next := env.do(t, http.MethodPost, dictionaryItemsPath(f.dictionary.ID), env.token, map[string]any{"value": "Готово"})
		require.Equal(t, http.StatusCreated, status, "response: %#v", next)
		assert.Equal(t, current.ID.String(), next["dictionary_version_id"])
		assert.Equal(t, float64(4), next["sort_order"])
		status, updated := env.do(t, http.MethodPatch, "/api/bot/v1/tasks/"+created["public_id"].(string), env.token, map[string]any{
			"field_values": []any{taskWriteField("state", next["value_code"]), taskWriteField("states", []any{item["value_code"], next["value_code"]})},
		})
		require.Equal(t, http.StatusOK, status, "response: %#v", updated)
		fields = taskWriteFields(t, updated)
		assert.Equal(t, "Готово", fields["state"]["value_text"])
		assert.Equal(t, []any{"Новый этап", "Готово"}, fields["states"]["value_json"])
		assert.Equal(t, float64(current.Version), fields["states"]["enum_version"])
		taskWriteAssertReadBack(t, env, updated)
	})

	t.Run("empty dictionary bootstraps its first version as the bot", func(t *testing.T) {
		empty, err := env.tasks.CreateDictionary(ctx, tasks.CreateDictionaryParams{Code: "bot_empty", Name: "Bot empty", IsPublic: true})
		require.NoError(t, err)
		status, created := env.do(t, http.MethodPost, dictionaryItemsPath(empty.ID), env.token, map[string]any{"value": "First"})
		require.Equal(t, http.StatusCreated, status, "response: %#v", created)
		versions, err := env.tasks.ListDictionaryVersions(ctx, empty.ID)
		require.NoError(t, err)
		require.Len(t, versions, 1)
		assert.Equal(t, versions[0].ID.String(), created["dictionary_version_id"])
		assert.Equal(t, empty.CurrentVersion+1, versions[0].Version)
		assert.Equal(t, env.botID, versions[0].CreatedBy)
		assert.Equal(t, float64(1), created["sort_order"])
		updated, err := env.tasks.GetDictionary(ctx, empty.ID)
		require.NoError(t, err)
		assert.Equal(t, versions[0].Version, updated.CurrentVersion)
		stored, err := env.tasks.GetDictionaryVersionItems(ctx, versions[0].ID, "", 0, nil)
		require.NoError(t, err)
		require.Len(t, stored, 1)
		assert.Equal(t, "First", stored[0].ValueCode)
		assert.Equal(t, "First", stored[0].ValueName)
		assert.True(t, stored[0].IsActive)
	})
}

func TestIntegration_BotAPI_DictionaryItemsErrors(t *testing.T) {
	env, ctx := newBotEnv(t), context.Background()
	public, err := env.tasks.CreateDictionary(ctx, tasks.CreateDictionaryParams{Code: "public", Name: "Public", IsPublic: true})
	require.NoError(t, err)
	_, err = env.tasks.CreateDictionaryVersion(ctx, public.ID, []tasks.DictionaryItemInput{
		{ValueCode: "Known", ValueName: "Known label", SortOrder: 1, IsActive: true},
		{ValueCode: "Inactive", ValueName: "Inactive label", SortOrder: 2, IsActive: false},
	}, env.botID)
	require.NoError(t, err)
	private, err := env.tasks.CreateDictionary(ctx, tasks.CreateDictionaryParams{Code: "private", Name: "Private"})
	require.NoError(t, err)
	path := dictionaryItemsPath(public.ID)

	t.Run("strict request body", func(t *testing.T) {
		for _, tc := range []struct{ name, raw string }{
			{"empty body", ""}, {"whitespace body", " \n\t"}, {"invalid JSON", `{"value":`},
			{"null body", `null`}, {"array body", `[]`}, {"string body", `"new"`},
			{"missing value", `{}`}, {"null value", `{"value":null}`}, {"blank value", `{"value":" \t\n "}`},
			{"too long value", `{"value":"` + strings.Repeat("я", 65) + `"}`},
			{"number value", `{"value":42}`}, {"bool value", `{"value":true}`},
			{"array value", `{"value":["new"]}`}, {"object value", `{"value":{"name":"new"}}`},
			{"wrong case key", `{"Value":"new"}`},
			{"unknown field", `{"value":"new","value_code":"code"}`},
			{"cannot set label", `{"value":"new","value_name":"label"}`},
			{"cannot set activity", `{"value":"new","is_active":false}`},
			{"trailing object", `{"value":"new"}{}`}, {"trailing null", `{"value":"new"} null`},
			{"trailing invalid JSON", `{"value":"new"} invalid`},
		} {
			t.Run(tc.name, func(t *testing.T) {
				before := dictionarySnapshot(t, env)
				status, body := taskWriteRaw(t, env, http.MethodPost, path, tc.raw)
				assert.Equal(t, http.StatusBadRequest, status, "response: %#v", body)
				assert.NotEmpty(t, body["error"])
				assert.Equal(t, before, dictionarySnapshot(t, env), "rejected requests must not change dictionary state")
			})
		}
	})

	t.Run("permissions conflicts paths and methods", func(t *testing.T) {
		for _, tc := range []struct {
			name, method, path, token, value string
			status                           int
		}{
			{"private dictionary", http.MethodPost, dictionaryItemsPath(private.ID), env.token, "New", http.StatusForbidden},
			{"unknown dictionary", http.MethodPost, dictionaryItemsPath(uuid.New()), env.token, "New", http.StatusNotFound},
			{"invalid dictionary ID", http.MethodPost, "/api/bot/v1/dictionaries/not-a-uuid/items", env.token, "New", http.StatusBadRequest},
			{"nil dictionary ID", http.MethodPost, dictionaryItemsPath(uuid.Nil), env.token, "New", http.StatusBadRequest},
			{"duplicate code", http.MethodPost, path, env.token, "Known", http.StatusConflict},
			{"trimmed duplicate code", http.MethodPost, path, env.token, " \tKnown\n", http.StatusConflict},
			{"inactive duplicate code", http.MethodPost, path, env.token, "Inactive", http.StatusConflict},
			{"missing token", http.MethodPost, path, "", "New", http.StatusUnauthorized},
			{"invalid token", http.MethodPost, path, "wrong-token", "New", http.StatusUnauthorized},
			{"missing path", http.MethodPost, "/api/bot/v1/dictionaries/", env.token, "New", http.StatusNotFound},
			{"missing items path", http.MethodPost, "/api/bot/v1/dictionaries/" + public.ID.String(), env.token, "New", http.StatusNotFound},
			{"unknown operation", http.MethodPost, "/api/bot/v1/dictionaries/" + public.ID.String() + "/versions", env.token, "New", http.StatusNotFound},
			{"extra path", http.MethodPost, path + "/extra", env.token, "New", http.StatusNotFound},
			{"trailing slash", http.MethodPost, path + "/", env.token, "New", http.StatusNotFound},
			{"no get", http.MethodGet, path, env.token, "New", http.StatusMethodNotAllowed},
			{"no put", http.MethodPut, path, env.token, "New", http.StatusMethodNotAllowed},
			{"no patch", http.MethodPatch, path, env.token, "New", http.StatusMethodNotAllowed},
			{"no delete", http.MethodDelete, path, env.token, "New", http.StatusMethodNotAllowed},
		} {
			t.Run(tc.name, func(t *testing.T) {
				before := dictionarySnapshot(t, env)
				status, body := env.do(t, tc.method, tc.path, tc.token, map[string]any{"value": tc.value})
				assert.Equal(t, tc.status, status, "response: %#v", body)
				assert.NotEmpty(t, body["error"])
				assert.Equal(t, before, dictionarySnapshot(t, env))
			})
		}
	})

	t.Run("revoked tokens and blocked bots cannot write", func(t *testing.T) {
		before := dictionarySnapshot(t, env)
		_, err := env.pool.Exec(ctx, `UPDATE integration_token SET revoked_at = now() WHERE user_id = $1`, env.botID)
		require.NoError(t, err)
		status, body := env.do(t, http.MethodPost, path, env.token, map[string]any{"value": "Revoked"})
		assert.Equal(t, http.StatusUnauthorized, status)
		assert.Equal(t, "invalid token", body["error"])
		_, err = env.pool.Exec(ctx, `UPDATE integration_token SET revoked_at = NULL WHERE user_id = $1`, env.botID)
		require.NoError(t, err)
		_, err = env.pool.Exec(ctx, `UPDATE users SET status = 'blocked' WHERE id = $1`, env.botID)
		require.NoError(t, err)
		status, body = env.do(t, http.MethodPost, path, env.token, map[string]any{"value": "Blocked"})
		assert.Equal(t, http.StatusUnauthorized, status)
		assert.Equal(t, "invalid token", body["error"])
		assert.Equal(t, before, dictionarySnapshot(t, env))
		_, err = env.pool.Exec(ctx, `UPDATE users SET status = 'active' WHERE id = $1`, env.botID)
		require.NoError(t, err)
	})

	// The existing service compares codes exactly, preserving case. A label
	// may also equal another item's label without being a duplicate code.
	for _, value := range []string{"known", "Known label", strings.Repeat("я", 64)} {
		status, body := env.do(t, http.MethodPost, path, env.token, map[string]any{"value": " \t" + value + "\n "})
		require.Equal(t, http.StatusCreated, status, "response: %#v", body)
		assert.Equal(t, value, body["value_code"])
	}
}
