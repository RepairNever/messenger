//go:build integration

package botapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"msgnr/internal/tasks"
)

// Each test group shares one database, so validation tables can cover both
// create and update without provisioning a container for each rejected input.
type taskWriteFixture struct {
	env        *botTestEnv
	human      uuid.UUID
	otherHuman uuid.UUID
	template   tasks.TemplateRow
	open       tasks.StatusRow
	done       tasks.StatusRow
	dictionary tasks.DictionaryRow
	version    int32
	fields     map[string]tasks.FieldRow
}

func newTaskWriteFixture(t *testing.T) *taskWriteFixture {
	t.Helper()
	env := newBotEnv(t)
	ctx := context.Background()
	f := &taskWriteFixture{env: env, fields: map[string]tasks.FieldRow{}}
	f.human = env.seedHuman(t, "Write Owner")
	f.otherHuman = env.seedHuman(t, "Write Reviewer")
	var err error
	f.template, err = env.tasks.CreateTemplate(ctx, tasks.CreateTemplateParams{Prefix: "WRITE", SortOrder: 10, ActorID: f.human})
	require.NoError(t, err)
	f.open, err = env.tasks.CreateStatus(ctx, tasks.CreateStatusParams{Code: "write_open", Name: "A Open", SortOrder: 10, ActorID: f.human})
	require.NoError(t, err)
	f.done, err = env.tasks.CreateStatus(ctx, tasks.CreateStatusParams{Code: "write_done", Name: "Z Done", SortOrder: 10, ActorID: f.human})
	require.NoError(t, err)
	f.dictionary, err = env.tasks.CreateDictionary(ctx, tasks.CreateDictionaryParams{Code: "write_state", Name: "Write state"})
	require.NoError(t, err)
	version, err := env.tasks.CreateDictionaryVersion(ctx, f.dictionary.ID, []tasks.DictionaryItemInput{
		{ValueCode: "todo", ValueName: "To Do", SortOrder: 1, IsActive: true},
		{ValueCode: "done", ValueName: "Done", SortOrder: 2, IsActive: true},
		{ValueCode: "inactive", ValueName: "Inactive", SortOrder: 3, IsActive: false},
	}, f.human)
	require.NoError(t, err)
	f.version = int32(version.Version)
	for i, field := range []struct{ code, kind string }{
		{"note", "text"}, {"estimate", "number"}, {"owner", "user"}, {"reviewers", "users"},
		{"state", "enum"}, {"states", "multi_enum"}, {"due", "date"}, {"starts", "datetime"},
	} {
		p := tasks.CreateFieldParams{TemplateID: f.template.ID, Code: field.code, Name: field.code, Type: field.kind, SortOrder: i + 1}
		if field.kind == "enum" || field.kind == "multi_enum" {
			p.EnumDictionaryID = &f.dictionary.ID
		}
		if field.code == "owner" {
			role := "assignee"
			p.FieldRole = &role
		}
		created, err := env.tasks.CreateField(ctx, p)
		require.NoError(t, err)
		f.fields[field.code] = created
	}
	return f
}

func (f *taskWriteFixture) createBody(title string, fields ...map[string]any) map[string]any {
	return map[string]any{"template": f.template.Prefix, "title": title, "field_values": fields}
}

func taskWriteField(code string, value any) map[string]any {
	return map[string]any{"code": code, "value": value}
}

func taskWriteFields(t *testing.T, body map[string]any) map[string]map[string]any {
	t.Helper()
	raw, ok := body["fields"].([]any)
	require.True(t, ok, "fields must be an array: %#v", body)
	out := make(map[string]map[string]any, len(raw))
	for _, value := range raw {
		field := value.(map[string]any)
		out[field["code"].(string)] = field
	}
	return out
}

func taskWriteAssertReadBack(t *testing.T, env *botTestEnv, body map[string]any) {
	t.Helper()
	status, got := env.do(t, http.MethodGet, "/api/bot/v1/tasks/"+body["public_id"].(string), env.token, nil)
	require.Equal(t, http.StatusOK, status)
	assert.Equal(t, body, got, "the post-commit write DTO must match the read endpoint")
}

func taskWriteRaw(t *testing.T, env *botTestEnv, method, path, raw string) (int, map[string]any) {
	t.Helper()
	req, err := http.NewRequest(method, env.ts.URL+path, strings.NewReader(raw))
	require.NoError(t, err)
	req.Header.Set("Authorization", "Bearer "+env.token)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	var body map[string]any
	require.NoError(t, json.Unmarshal(data, &body), "body: %s", data)
	return resp.StatusCode, body
}

// Include complete task/value/history rows and the sequence allocator. A
// validation failure must not merely return 400 after partially applying a write.
func taskWriteSnapshot(t *testing.T, env *botTestEnv) string {
	t.Helper()
	var snapshot string
	err := env.pool.QueryRow(context.Background(), `SELECT jsonb_build_object(
		'tasks', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM task t),
		'values', (SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM task_field_value v),
		'history', (SELECT jsonb_agg(to_jsonb(h) ORDER BY id) FROM task_change_history h),
		'descriptions', (SELECT jsonb_agg(to_jsonb(h) ORDER BY id) FROM task_description_history h),
		'sequences', (SELECT jsonb_agg(to_jsonb(s) ORDER BY template_id) FROM task_template_sequence s),
		'events', (SELECT jsonb_agg(to_jsonb(e) ORDER BY event_seq) FROM workspace_events e)
	)::text`).Scan(&snapshot)
	require.NoError(t, err)
	return snapshot
}

func TestIntegration_BotAPI_TaskWriteDiscovery(t *testing.T) {
	f := newTaskWriteFixture(t)
	env, ctx := f.env, context.Background()

	t.Run("configuration ordering and active metadata", func(t *testing.T) {
		for _, prefix := range []string{"ZZZ", "AAA", "REMOVED"} {
			template, err := env.tasks.CreateTemplate(ctx, tasks.CreateTemplateParams{Prefix: prefix, SortOrder: 10, ActorID: f.human})
			require.NoError(t, err)
			if prefix == "REMOVED" {
				_, err = env.pool.Exec(ctx, `UPDATE task_template SET deleted_at = now() WHERE id = $1`, template.ID)
				require.NoError(t, err)
			}
		}
		deleted, err := env.tasks.CreateField(ctx, tasks.CreateFieldParams{TemplateID: f.template.ID, Code: "removed", Name: "Removed", Type: "text", SortOrder: 1})
		require.NoError(t, err)
		_, err = env.tasks.SoftDeleteField(ctx, f.template.ID, deleted.ID)
		require.NoError(t, err)
		_, err = env.pool.Exec(ctx, `UPDATE task_field_definition SET sort_order = 1 WHERE template_id = $1 AND deleted_at IS NULL`, f.template.ID)
		require.NoError(t, err)
		removedStatus, err := env.tasks.CreateStatus(ctx, tasks.CreateStatusParams{Code: "removed_status", Name: "Removed", SortOrder: 0, ActorID: f.human})
		require.NoError(t, err)
		_, err = env.tasks.SoftDeleteStatus(ctx, removedStatus.ID)
		require.NoError(t, err)

		status, body := env.do(t, http.MethodGet, "/api/bot/v1/tasks/config", env.token, nil)
		require.Equal(t, http.StatusOK, status)
		templates := body["templates"].([]any)
		require.Len(t, templates, 3)
		assert.Equal(t, "AAA", templates[0].(map[string]any)["prefix"])
		assert.Equal(t, "WRITE", templates[1].(map[string]any)["prefix"])
		assert.Equal(t, "ZZZ", templates[2].(map[string]any)["prefix"])
		fields := templates[1].(map[string]any)["fields"].([]any)
		require.Len(t, fields, 8)
		var codes []string
		for _, raw := range fields {
			field := raw.(map[string]any)
			code := field["code"].(string)
			codes = append(codes, code)
			assert.Equal(t, f.fields[code].Type, field["type"])
			assert.Equal(t, false, field["required"])
			if code == "owner" {
				assert.Equal(t, "assignee", field["field_role"])
			} else {
				assert.NotContains(t, field, "field_role")
			}
			if code == "state" || code == "states" {
				assert.Equal(t, map[string]any{"id": f.dictionary.ID.String(), "code": "write_state", "current_version": float64(f.version)}, field["dictionary"])
				assert.NotContains(t, field["dictionary"], "items")
			} else {
				assert.NotContains(t, field, "dictionary")
			}
		}
		assert.Equal(t, []string{"due", "estimate", "note", "owner", "reviewers", "starts", "state", "states"}, codes, "equal sort orders use field code as tie-breaker")
		statuses := body["statuses"].([]any)
		require.Len(t, statuses, 2)
		assert.Equal(t, "write_open", statuses[0].(map[string]any)["code"])
		assert.Equal(t, "write_done", statuses[1].(map[string]any)["code"])
		assert.Equal(t, float64(10), statuses[0].(map[string]any)["sort_order"])
	})

	t.Run("user search is literal case insensitive and human only", func(t *testing.T) {
		alice := env.seedHuman(t, "Alice Example")
		emailOnly := env.seedHuman(t, "Email Match")
		_, err := env.pool.Exec(ctx, `UPDATE users SET email = 'unique.lookup@example.com' WHERE id = $1`, emailOnly)
		require.NoError(t, err)
		blocked := env.seedHuman(t, "Alice Blocked")
		_, err = env.pool.Exec(ctx, `UPDATE users SET status = 'blocked' WHERE id = $1`, blocked)
		require.NoError(t, err)
		for _, tc := range []struct {
			query string
			id    uuid.UUID
		}{{"  aLiCe  ", alice}, {"unique.LOOKUP", emailOnly}} {
			status, body := env.do(t, http.MethodGet, "/api/bot/v1/users?q="+url.QueryEscape(tc.query), env.token, nil)
			require.Equal(t, http.StatusOK, status)
			users := body["users"].([]any)
			require.Len(t, users, 1)
			user := users[0].(map[string]any)
			assert.Equal(t, tc.id.String(), user["user_id"])
			assert.Len(t, user, 3)
			assert.Contains(t, user, "display_name")
			assert.Contains(t, user, "email")
		}
		literal := env.seedHuman(t, "Literal X%Y_Z\\W")
		for _, query := range []string{"X%", "Y_", "Z\\"} {
			status, body := env.do(t, http.MethodGet, "/api/bot/v1/users?q="+url.QueryEscape(query), env.token, nil)
			require.Equal(t, http.StatusOK, status)
			users := body["users"].([]any)
			require.Len(t, users, 1, "SQL wildcard characters must be literal substring characters")
			assert.Equal(t, literal.String(), users[0].(map[string]any)["user_id"])
		}
		status, body := env.do(t, http.MethodGet, "/api/bot/v1/users?q=Helpful", env.token, nil)
		require.Equal(t, http.StatusOK, status)
		assert.Empty(t, body["users"], "bot principals are excluded")
		for _, query := range []string{"a", "é", "  界  "} {
			status, body = env.do(t, http.MethodGet, "/api/bot/v1/users?q="+url.QueryEscape(query), env.token, nil)
			assert.Equal(t, http.StatusBadRequest, status)
			assert.Equal(t, "query must be at least 2 characters", body["error"])
		}
		status, _ = env.do(t, http.MethodGet, "/api/bot/v1/users?q="+url.QueryEscape("界面"), env.token, nil)
		assert.Equal(t, http.StatusOK, status, "two Unicode runes are a valid query")
	})

	t.Run("user limit clamps and stable display name ordering", func(t *testing.T) {
		blank := env.seedHuman(t, "")
		for i := 0; i < 55; i++ {
			env.seedHuman(t, "Paging Human")
		}
		for _, path := range []string{"/api/bot/v1/users", "/api/bot/v1/users?q=", "/api/bot/v1/users?q=%20%09%20"} {
			status, body := env.do(t, http.MethodGet, path, env.token, nil)
			require.Equal(t, http.StatusOK, status)
			users := body["users"].([]any)
			assert.Len(t, users, 20)
			assert.Equal(t, blank.String(), users[0].(map[string]any)["user_id"])
			assert.Equal(t, "", users[0].(map[string]any)["display_name"], "blank names do not fall back to email")
		}
		for _, tc := range []struct {
			limit string
			count int
		}{{"0", 1}, {"-1", 1}, {"1", 1}, {"1000", 50}} {
			status, body := env.do(t, http.MethodGet, "/api/bot/v1/users?q=Paging&limit="+tc.limit, env.token, nil)
			require.Equal(t, http.StatusOK, status)
			users := body["users"].([]any)
			require.Len(t, users, tc.count)
			var previous string
			for _, raw := range users {
				id := raw.(map[string]any)["user_id"].(string)
				if previous != "" {
					assert.Less(t, previous, id, "same display name is sorted by UUID")
				}
				previous = id
			}
		}
		status, body := env.do(t, http.MethodGet, "/api/bot/v1/users?limit=bad", env.token, nil)
		assert.Equal(t, http.StatusBadRequest, status)
		assert.Equal(t, "invalid limit", body["error"])
	})

	t.Run("auth and methods", func(t *testing.T) {
		for _, endpoint := range []struct{ method, path string }{
			{http.MethodGet, "/api/bot/v1/tasks/config"}, {http.MethodGet, "/api/bot/v1/users"},
			{http.MethodPost, "/api/bot/v1/tasks"}, {http.MethodPatch, "/api/bot/v1/tasks/WRITE-999"},
		} {
			for _, tc := range []struct{ token, message string }{{"", "missing token"}, {"wrong-token", "invalid token"}} {
				status, body := env.do(t, endpoint.method, endpoint.path, tc.token, map[string]any{})
				assert.Equal(t, http.StatusUnauthorized, status)
				assert.Equal(t, tc.message, body["error"])
			}
		}
		for _, endpoint := range []struct{ method, path string }{
			{http.MethodPost, "/api/bot/v1/tasks/config"}, {http.MethodPatch, "/api/bot/v1/users"},
			{http.MethodGet, "/api/bot/v1/tasks"}, {http.MethodPut, "/api/bot/v1/tasks/WRITE-999"},
		} {
			status, body := env.do(t, endpoint.method, endpoint.path, env.token, map[string]any{})
			assert.Equal(t, http.StatusMethodNotAllowed, status)
			assert.Equal(t, "method not allowed", body["error"])
		}
	})
}

func TestIntegration_BotAPI_TaskWritesAndMerge(t *testing.T) {
	f := newTaskWriteFixture(t)
	env, ctx := f.env, context.Background()
	request := f.createBody("  Created through bot  ",
		taskWriteField("note", "Note text"), taskWriteField("estimate", json.RawMessage("1.23456e2")),
		taskWriteField("owner", strings.ToUpper(f.human.String())), taskWriteField("reviewers", []string{f.human.String(), f.otherHuman.String()}),
		taskWriteField("state", "  To Do  "), taskWriteField("states", []string{"To Do", "DONE"}),
		taskWriteField("due", "2024-02-29"), taskWriteField("starts", "2026-10-07T15:04:05+03:00"),
	)
	request["description"] = "  Initial description  "
	status, body := env.do(t, http.MethodPost, "/api/bot/v1/tasks", env.token, request)
	require.Equal(t, http.StatusCreated, status, "response: %#v", body)
	publicID := body["public_id"].(string)
	assert.True(t, strings.HasPrefix(publicID, "WRITE-"))
	assert.Equal(t, "Created through bot", body["title"])
	assert.Equal(t, "Initial description", body["description"])
	assert.Equal(t, "write_open", body["status"].(map[string]any)["code"], "default status uses sort order then name")
	fields := taskWriteFields(t, body)
	assert.Equal(t, "Note text", fields["note"]["value_text"])
	assert.Equal(t, "123.456000", fields["estimate"]["value_number"])
	assert.Equal(t, f.human.String(), fields["owner"]["value_user_id"])
	assert.Equal(t, []any{f.human.String(), f.otherHuman.String()}, fields["reviewers"]["value_json"])
	assert.Equal(t, "todo", fields["state"]["value_text"])
	assert.Equal(t, []any{"todo", "done"}, fields["states"]["value_json"])
	assert.Equal(t, f.dictionary.ID.String(), fields["state"]["enum_dictionary_id"])
	assert.Equal(t, float64(f.version), fields["state"]["enum_version"])
	assert.Equal(t, float64(f.version), fields["states"]["enum_version"])
	assert.Equal(t, "2024-02-29", fields["due"]["value_date"])
	starts, err := time.Parse(time.RFC3339, fields["starts"]["value_datetime"].(string))
	require.NoError(t, err)
	assert.True(t, starts.Equal(time.Date(2026, 10, 7, 12, 4, 5, 0, time.UTC)))
	taskWriteAssertReadBack(t, env, body)
	var taskID, createdBy, updatedBy uuid.UUID
	err = env.pool.QueryRow(ctx, `SELECT id, created_by, updated_by FROM task WHERE public_id = $1`, publicID).Scan(&taskID, &createdBy, &updatedBy)
	require.NoError(t, err)
	assert.Equal(t, env.botID, createdBy)
	assert.Equal(t, env.botID, updatedBy)
	var wrongActors, events int
	err = env.pool.QueryRow(ctx, `SELECT count(*) FROM task_change_history WHERE task_id = $1 AND actor_id <> $2`, taskID, env.botID).Scan(&wrongActors)
	require.NoError(t, err)
	assert.Zero(t, wrongActors)
	err = env.pool.QueryRow(ctx, `SELECT count(*) FROM workspace_events`).Scan(&events)
	require.NoError(t, err)
	assert.Zero(t, events, "task writes emit no persisted workspace events")
	path := "/api/bot/v1/tasks/" + publicID

	t.Run("title and null title or status keep other state", func(t *testing.T) {
		status, updated := env.do(t, http.MethodPatch, path, env.token, map[string]any{"title": "  Renamed  "})
		require.Equal(t, http.StatusOK, status)
		assert.Equal(t, "Renamed", updated["title"])
		assert.Equal(t, body["description"], updated["description"])
		assert.Equal(t, body["fields"], updated["fields"])
		taskWriteAssertReadBack(t, env, updated)
		before := taskWriteSnapshot(t, env)
		status, unchanged := env.do(t, http.MethodPatch, path, env.token, map[string]any{"title": nil, "status": nil, "field_values": []any{}})
		require.Equal(t, http.StatusOK, status)
		assert.Equal(t, updated, unchanged)
		assert.Equal(t, before, taskWriteSnapshot(t, env), "explicit empty field list preserves timestamp, rows, and history")
	})

	t.Run("description and individual values merge and clear", func(t *testing.T) {
		status, updated := env.do(t, http.MethodPatch, path, env.token, map[string]any{
			"description": nil, "status": "  WRITE_DONE  ",
			"field_values": []any{taskWriteField("note", "Updated note"), taskWriteField("estimate", nil)},
		})
		require.Equal(t, http.StatusOK, status, "response: %#v", updated)
		assert.Nil(t, updated["description"])
		assert.Equal(t, "write_done", updated["status"].(map[string]any)["code"])
		got := taskWriteFields(t, updated)
		assert.Equal(t, "Updated note", got["note"]["value_text"])
		assert.Nil(t, got["estimate"]["value_number"])
		assert.Equal(t, fields["owner"], got["owner"])
		assert.Equal(t, fields["states"], got["states"])
		taskWriteAssertReadBack(t, env, updated)
		status, updated = env.do(t, http.MethodPatch, path, env.token, map[string]any{
			"description":  "  New description  ",
			"field_values": []any{taskWriteField("reviewers", []any{}), taskWriteField("states", []any{}), taskWriteField("state", nil)},
		})
		require.Equal(t, http.StatusOK, status)
		assert.Equal(t, "New description", updated["description"])
		got = taskWriteFields(t, updated)
		assert.Nil(t, got["reviewers"]["value_json"])
		assert.Nil(t, got["states"]["value_json"])
		assert.Nil(t, got["state"]["value_text"])
		assert.Equal(t, "Updated note", got["note"]["value_text"])
		taskWriteAssertReadBack(t, env, updated)
		status, updated = env.do(t, http.MethodPatch, path, env.token, map[string]any{"description": " \t "})
		require.Equal(t, http.StatusOK, status)
		assert.Nil(t, updated["description"])
		before := taskWriteSnapshot(t, env)
		status, unchanged := env.do(t, http.MethodPatch, path, env.token, map[string]any{})
		require.Equal(t, http.StatusOK, status)
		assert.Equal(t, updated, unchanged)
		assert.Equal(t, before, taskWriteSnapshot(t, env), "empty PATCH is a database no-op")
	})

	t.Run("hierarchy and unset optional create values", func(t *testing.T) {
		childReq := f.createBody("Child", taskWriteField("note", nil), taskWriteField("reviewers", []string{}), taskWriteField("states", []string{}))
		childReq["parent_public_id"] = publicID
		childReq["description"] = " \n "
		childReq["status"] = "write_done"
		status, child := env.do(t, http.MethodPost, "/api/bot/v1/tasks", env.token, childReq)
		require.Equal(t, http.StatusCreated, status)
		assert.Equal(t, publicID, child["parent_public_id"])
		assert.Nil(t, child["description"])
		for _, field := range taskWriteFields(t, child) {
			assert.Nil(t, field["value_json"])
			assert.Nil(t, field["value_text"])
		}
		taskWriteAssertReadBack(t, env, child)
		var valueCount int
		err := env.pool.QueryRow(ctx, `SELECT count(*) FROM task_field_value WHERE task_id = (SELECT id FROM task WHERE public_id = $1)`, child["public_id"]).Scan(&valueCount)
		require.NoError(t, err)
		assert.Zero(t, valueCount, "null and empty arrays create no stored optional value rows")
		for _, tc := range []struct {
			parent  string
			status  int
			message string
		}{
			{"WRITE-999999", http.StatusNotFound, "not found: parent task"},
			{child["public_id"].(string), http.StatusBadRequest, "bad request: parent task is already a subtask"},
		} {
			before := taskWriteSnapshot(t, env)
			request := f.createBody("Rejected child")
			request["parent_public_id"] = tc.parent
			status, got := env.do(t, http.MethodPost, "/api/bot/v1/tasks", env.token, request)
			assert.Equal(t, tc.status, status)
			assert.Equal(t, tc.message, got["error"])
			assert.Equal(t, before, taskWriteSnapshot(t, env))
		}
	})

	err = env.pool.QueryRow(ctx, `SELECT count(*) FROM task_change_history WHERE task_id = $1 AND actor_id <> $2`, taskID, env.botID).Scan(&wrongActors)
	require.NoError(t, err)
	assert.Zero(t, wrongActors, "all bot changes retain the authenticated actor")
	err = env.pool.QueryRow(ctx, `SELECT updated_by FROM task WHERE id = $1`, taskID).Scan(&updatedBy)
	require.NoError(t, err)
	assert.Equal(t, env.botID, updatedBy)
}

func TestIntegration_BotAPI_TaskWriteValidation(t *testing.T) {
	f := newTaskWriteFixture(t)
	env, ctx := f.env, context.Background()
	status, current := env.do(t, http.MethodPost, "/api/bot/v1/tasks", env.token, f.createBody("Existing task", taskWriteField("note", "Unchanged")))
	require.Equal(t, http.StatusCreated, status)
	path := "/api/bot/v1/tasks/" + current["public_id"].(string)
	blocked := env.seedHuman(t, "Blocked assignee")
	_, err := env.pool.Exec(ctx, `UPDATE users SET status = 'blocked' WHERE id = $1`, blocked)
	require.NoError(t, err)

	t.Run("strict JSON decoding", func(t *testing.T) {
		for _, tc := range []struct{ name, raw, message string }{
			{"empty", "", "invalid request body"}, {"null", "null", "invalid request body"},
			{"array", "[]", "invalid request body"}, {"string", `"hello"`, "invalid request body"},
			{"trailing object", `{} {}`, "invalid request body"}, {"trailing null", `{} null`, "invalid request body"},
			{"trailing garbage", `{} trailing`, "invalid request body"}, {"malformed", `{`, "invalid request body"},
			{"description shape", `{"description":123}`, "invalid request body"},
			{"title shape", `{"title":123}`, "invalid request body"},
			{"status shape", `{"status":false}`, "invalid request body"},
			{"field list shape", `{"field_values":{}}`, "invalid request body"},
			{"field entry null", `{"field_values":[null]}`, "invalid request body"},
			{"field entry array", `{"field_values":[[]]}`, "invalid request body"},
			{"field code shape", `{"field_values":[{"code":123,"value":null}]}`, "invalid request body"},
			{"missing field value", `{"field_values":[{"code":"note"}]}`, `bad request: value is required for field "note"`},
			{"unknown key", `{"priority":"high"}`, "bad request: unknown key priority"},
			{"case variant", `{"Title":"hello"}`, "bad request: unknown key Title"},
			{"unknown entry key", `{"field_values":[{"code":"note","value":"x","enum_version":1}]}`, "bad request: unknown key enum_version"},
		} {
			t.Run(tc.name, func(t *testing.T) {
				for _, endpoint := range []struct{ method, path string }{{http.MethodPost, "/api/bot/v1/tasks"}, {http.MethodPatch, path}} {
					before := taskWriteSnapshot(t, env)
					status, body := taskWriteRaw(t, env, endpoint.method, endpoint.path, tc.raw)
					assert.Equal(t, http.StatusBadRequest, status)
					assert.Equal(t, tc.message, body["error"])
					assert.Equal(t, before, taskWriteSnapshot(t, env), "rejected decoding must leave all task state untouched")
				}
			})
		}
		for _, key := range []string{"parent_public_id", "template", "public_id"} {
			before := taskWriteSnapshot(t, env)
			status, body := env.do(t, http.MethodPatch, path, env.token, map[string]any{key: nil})
			assert.Equal(t, http.StatusBadRequest, status)
			assert.Equal(t, "bad request: "+key+" is not updatable", body["error"])
			assert.Equal(t, before, taskWriteSnapshot(t, env))
		}
		status, body := taskWriteRaw(t, env, http.MethodPatch, path, " {} \n\t ")
		require.Equal(t, http.StatusOK, status, "trailing whitespace is permitted")
		assert.Equal(t, current, body)
		before := taskWriteSnapshot(t, env)
		status, body = env.do(t, http.MethodPatch, path, env.token, map[string]any{"field_values": nil})
		require.Equal(t, http.StatusOK, status)
		assert.Equal(t, current, body)
		assert.Equal(t, before, taskWriteSnapshot(t, env))
	})

	t.Run("known fields and user validation reject before writes", func(t *testing.T) {
		unknownUser := uuid.NewString()
		for _, tc := range []struct {
			code    string
			value   any
			message string
		}{
			{"missing", "value", "valid fields:"}, {"NOTE", "value", "valid fields:"},
			{"note", 1, "string"}, {"estimate", true, "number"}, {"owner", []string{f.human.String()}, "string"},
			{"reviewers", f.human.String(), "array"}, {"reviewers", []any{1}, "array"},
			{"state", []string{"todo"}, "string"}, {"states", "todo", "array"}, {"states", []any{false}, "array"},
			{"due", "2023-02-29", "date"}, {"due", "2026-2-09", "date"}, {"due", 123, "string"},
			{"starts", "2026-10-07 12:00:00", "datetime"}, {"starts", false, "string"},
			{"starts", "2026-10-07T1:00:00Z", "datetime"}, {"starts", "2026-10-07T12:00:00,5Z", "datetime"},
			{"owner", "bad-uuid", "user"}, {"owner", unknownUser, "bad request: unknown user " + unknownUser},
			{"owner", env.botID.String(), "bad request: unknown user " + env.botID.String()},
			{"reviewers", []string{f.human.String(), blocked.String()}, "bad request: unknown user " + blocked.String()},
			{"reviewers", []string{f.human.String(), strings.ToUpper(f.human.String())}, fmt.Sprintf("bad request: duplicate user %q in field %q", f.human.String(), "reviewers")},
			{"state", "missing", "valid values:"}, {"state", "inactive", "valid values:"},
			{"states", []string{"To Do", "to do"}, `bad request: duplicate value "todo" in field "states"`},
		} {
			t.Run(tc.code+" "+fmt.Sprint(tc.value), func(t *testing.T) {
				for _, endpoint := range []struct{ method, path string }{{http.MethodPost, "/api/bot/v1/tasks"}, {http.MethodPatch, path}} {
					request := map[string]any{"field_values": []any{taskWriteField(tc.code, tc.value)}}
					if endpoint.method == http.MethodPost {
						request["template"], request["title"] = "WRITE", "Must not be created"
					} else {
						request["title"] = "Must not be changed"
					}
					before := taskWriteSnapshot(t, env)
					status, body := env.do(t, endpoint.method, endpoint.path, env.token, request)
					assert.Equal(t, http.StatusBadRequest, status, "response: %#v", body)
					assert.Contains(t, body["error"], tc.message)
					assert.Equal(t, before, taskWriteSnapshot(t, env))
				}
			})
		}
		for _, request := range []map[string]any{
			{"title": "Missing template"}, {"template": " ", "title": "Blank template"},
			{"template": "write", "title": "Wrong case template"}, {"template": "UNKNOWN", "title": "Unknown template"},
			{"template": "WRITE", "title": "  "}, {"template": "WRITE", "title": "Unknown status", "status": "UNKNOWN"},
			f.createBody("Duplicate code", taskWriteField("note", nil), taskWriteField("note", "x")),
		} {
			before := taskWriteSnapshot(t, env)
			status, body := env.do(t, http.MethodPost, "/api/bot/v1/tasks", env.token, request)
			assert.Equal(t, http.StatusBadRequest, status, "response: %#v", body)
			assert.Equal(t, before, taskWriteSnapshot(t, env))
			if _, present := request["template"]; !present || request["template"] == " " {
				assert.Equal(t, "bad request: template is required", body["error"])
			}
		}
		status, body := env.do(t, http.MethodPatch, "/api/bot/v1/tasks/WRITE-999999", env.token, map[string]any{})
		assert.Equal(t, http.StatusNotFound, status)
		assert.Equal(t, "not found: task", body["error"])
	})

	t.Run("numbers are exact after normalization", func(t *testing.T) {
		for _, tc := range []struct {
			input  any
			stored string
		}{
			{json.RawMessage("99999999999999.999999"), "99999999999999.999999"},
			{"-99999999999999.999999", "-99999999999999.999999"},
			{"1.2300000", "1.230000"}, {json.RawMessage("1.23e2"), "123.000000"},
			{"1000000e-12", "0.000001"}, {"0e100000", "0.000000"}, {"000001.2500000", "1.250000"},
		} {
			t.Run(fmt.Sprint(tc.input), func(t *testing.T) {
				status, body := env.do(t, http.MethodPatch, path, env.token, map[string]any{"field_values": []any{taskWriteField("estimate", tc.input)}})
				require.Equal(t, http.StatusOK, status, "response: %#v", body)
				assert.Equal(t, tc.stored, taskWriteFields(t, body)["estimate"]["value_number"])
				taskWriteAssertReadBack(t, env, body)
			})
		}
		for _, input := range []any{
			json.RawMessage("0.1234567"), "99999999999999.9999991", json.RawMessage("100000000000000"),
			"-100000000000000", "1e14", "1e-7", "1e100000", "NaN", "Infinity", "1/2", "", "1.2.3",
		} {
			before := taskWriteSnapshot(t, env)
			status, body := env.do(t, http.MethodPost, "/api/bot/v1/tasks", env.token, f.createBody("Rejected number", taskWriteField("estimate", input)))
			assert.Equal(t, http.StatusBadRequest, status, "input: %#v, response: %#v", input, body)
			assert.Contains(t, body["error"], "number")
			assert.Equal(t, before, taskWriteSnapshot(t, env))
		}
	})

	t.Run("required fields including empty no-op fail atomically", func(t *testing.T) {
		_, err := env.tasks.UpdateField(ctx, f.template.ID, f.fields["reviewers"].ID, tasks.UpdateFieldParams{Name: "Reviewers", Required: true})
		require.NoError(t, err)
		for _, request := range []map[string]any{{}, {"field_values": []any{}}, {"field_values": []any{taskWriteField("reviewers", nil)}}, {"field_values": []any{taskWriteField("reviewers", []string{})}}} {
			before := taskWriteSnapshot(t, env)
			status, body := env.do(t, http.MethodPatch, path, env.token, request)
			assert.Equal(t, http.StatusBadRequest, status)
			assert.Equal(t, `bad request: required field "reviewers" is missing`, body["error"])
			assert.Equal(t, before, taskWriteSnapshot(t, env))
		}
		for _, request := range []map[string]any{
			f.createBody("Missing required"), f.createBody("Null required", taskWriteField("reviewers", nil)),
			f.createBody("Empty required", taskWriteField("reviewers", []string{})),
		} {
			before := taskWriteSnapshot(t, env)
			status, body := env.do(t, http.MethodPost, "/api/bot/v1/tasks", env.token, request)
			assert.Equal(t, http.StatusBadRequest, status)
			assert.Equal(t, `bad request: required field "reviewers" is missing`, body["error"])
			assert.Equal(t, before, taskWriteSnapshot(t, env))
		}
		status, _ = env.do(t, http.MethodPatch, path, env.token, map[string]any{"field_values": []any{taskWriteField("reviewers", []string{f.human.String()})}})
		require.Equal(t, http.StatusOK, status)
		before := taskWriteSnapshot(t, env)
		status, body := env.do(t, http.MethodPatch, path, env.token, map[string]any{"field_values": []any{taskWriteField("reviewers", nil)}})
		assert.Equal(t, http.StatusBadRequest, status)
		assert.Equal(t, `bad request: required field "reviewers" is missing`, body["error"])
		assert.Equal(t, before, taskWriteSnapshot(t, env))
	})

	t.Run("no active statuses configured", func(t *testing.T) {
		_, err := env.pool.Exec(ctx, `UPDATE task_status SET deleted_at = now()`)
		require.NoError(t, err)
		before := taskWriteSnapshot(t, env)
		status, body := env.do(t, http.MethodPost, "/api/bot/v1/tasks", env.token, f.createBody("No default status"))
		assert.Equal(t, http.StatusBadRequest, status)
		assert.Equal(t, "bad request: no active task statuses configured", body["error"])
		assert.Equal(t, before, taskWriteSnapshot(t, env))
	})
}

func TestIntegration_BotAPI_TaskWriteHistoryAndResolution(t *testing.T) {
	f := newTaskWriteFixture(t)
	env, ctx := f.env, context.Background()

	t.Run("untouched historical values and cleanup", func(t *testing.T) {
		text := "todo"
		legacy, err := env.tasks.CreateTask(ctx, tasks.CreateTaskParams{
			TemplateID: f.template.ID, Title: "  Legacy title  ", StatusID: f.open.ID, ActorID: f.human,
			FieldValues: []tasks.FieldValueInput{
				{FieldDefinitionID: f.fields["state"].ID, ValueText: &text, EnumDictionaryID: &f.dictionary.ID, EnumVersion: &f.version},
				{FieldDefinitionID: f.fields["states"].ID, ValueJSON: json.RawMessage(`["todo"]`), EnumDictionaryID: &f.dictionary.ID, EnumVersion: &f.version},
				{FieldDefinitionID: f.fields["owner"].ID, ValueUserID: &f.otherHuman},
				{FieldDefinitionID: f.fields["reviewers"].ID, ValueJSON: json.RawMessage(fmt.Sprintf(`[%q]`, f.otherHuman.String()))},
			},
		})
		require.NoError(t, err)
		_, err = env.tasks.CreateDictionaryVersion(ctx, f.dictionary.ID, []tasks.DictionaryItemInput{{ValueCode: "new", ValueName: "New", SortOrder: 1, IsActive: true}}, f.human)
		require.NoError(t, err)
		_, err = env.pool.Exec(ctx, `UPDATE users SET status = 'blocked' WHERE id = $1`, f.otherHuman)
		require.NoError(t, err)
		stale, err := env.tasks.CreateField(ctx, tasks.CreateFieldParams{TemplateID: f.template.ID, Code: "stale", Name: "Stale", Type: "text", SortOrder: 20})
		require.NoError(t, err)
		blank, err := env.tasks.CreateField(ctx, tasks.CreateFieldParams{TemplateID: f.template.ID, Code: "blank", Name: "Blank", Type: "users", SortOrder: 21})
		require.NoError(t, err)
		metadataOnly, err := env.tasks.CreateField(ctx, tasks.CreateFieldParams{TemplateID: f.template.ID, Code: "metadata", Name: "Metadata", Type: "enum", EnumDictionaryID: &f.dictionary.ID, SortOrder: 22})
		require.NoError(t, err)
		_, err = env.pool.Exec(ctx, `INSERT INTO task_field_value (task_id, field_definition_id, value_text) VALUES ($1, $2, 'Old definition')`, legacy.ID, stale.ID)
		require.NoError(t, err)
		_, err = env.pool.Exec(ctx, `INSERT INTO task_field_value (task_id, field_definition_id) VALUES ($1, $2)`, legacy.ID, blank.ID)
		require.NoError(t, err)
		_, err = env.pool.Exec(ctx, `INSERT INTO task_field_value (task_id, field_definition_id, enum_dictionary_id, enum_version) VALUES ($1, $2, $3, $4)`, legacy.ID, metadataOnly.ID, f.dictionary.ID, f.version)
		require.NoError(t, err)
		_, err = env.tasks.SoftDeleteField(ctx, f.template.ID, stale.ID)
		require.NoError(t, err)
		path := "/api/bot/v1/tasks/" + legacy.PublicID
		status, before := env.do(t, http.MethodGet, path, env.token, nil)
		require.Equal(t, http.StatusOK, status)
		status, cleaned := env.do(t, http.MethodPatch, path, env.token, map[string]any{})
		require.Equal(t, http.StatusOK, status, "response: %#v", cleaned)
		assert.Equal(t, "Legacy title", cleaned["title"], "even an empty patch inherits service title normalization")
		expectedFields := taskWriteFields(t, before)
		expectedFields["metadata"]["enum_dictionary_id"] = nil
		expectedFields["metadata"]["enum_version"] = nil
		assert.Equal(t, expectedFields, taskWriteFields(t, cleaned), "cleanup preserves values and clears metadata on valueless enum rows")
		var dropped, spuriousBlankHistory int
		err = env.pool.QueryRow(ctx, `SELECT count(*) FROM task_field_value WHERE task_id = $1 AND field_definition_id = ANY($2::uuid[])`, legacy.ID, []uuid.UUID{stale.ID, blank.ID, metadataOnly.ID}).Scan(&dropped)
		require.NoError(t, err)
		assert.Zero(t, dropped, "inactive-definition and genuinely all-NULL rows are removed")
		err = env.pool.QueryRow(ctx, `SELECT count(*) FROM task_change_history WHERE task_id = $1 AND field_key = $2`, legacy.ID, "field:"+blank.ID.String()).Scan(&spuriousBlankHistory)
		require.NoError(t, err)
		assert.Zero(t, spuriousBlankHistory, "cleanup must not manufacture an empty array field change")
		taskWriteAssertReadBack(t, env, cleaned)
		status, updated := env.do(t, http.MethodPatch, path, env.token, map[string]any{"title": "Keep historical assignments"})
		require.Equal(t, http.StatusOK, status)
		fields := taskWriteFields(t, updated)
		assert.Equal(t, "todo", fields["state"]["value_text"])
		assert.Equal(t, float64(f.version), fields["state"]["enum_version"])
		assert.Equal(t, []any{"todo"}, fields["states"]["value_json"])
		assert.Equal(t, float64(f.version), fields["states"]["enum_version"])
		assert.Equal(t, f.otherHuman.String(), fields["owner"]["value_user_id"])
		assert.Equal(t, []any{f.otherHuman.String()}, fields["reviewers"]["value_json"])
		taskWriteAssertReadBack(t, env, updated)
		beforeState := taskWriteSnapshot(t, env)
		status, unchanged := env.do(t, http.MethodPatch, path, env.token, map[string]any{"field_values": []any{}})
		require.Equal(t, http.StatusOK, status)
		assert.Equal(t, updated, unchanged)
		assert.Equal(t, beforeState, taskWriteSnapshot(t, env))
		for _, field := range []map[string]any{taskWriteField("state", "To Do"), taskWriteField("owner", f.otherHuman.String())} {
			before := taskWriteSnapshot(t, env)
			status, failure := env.do(t, http.MethodPatch, path, env.token, map[string]any{"field_values": []any{field}})
			assert.Equal(t, http.StatusBadRequest, status, "current write validation still applies when callers explicitly resupply a legacy value")
			if field["code"] == "state" {
				assert.Contains(t, failure["error"], "valid values:")
				assert.Contains(t, failure["error"], "new (New)")
			} else {
				assert.Equal(t, "bad request: unknown user "+f.otherHuman.String(), failure["error"])
			}
			assert.Equal(t, before, taskWriteSnapshot(t, env))
		}
	})

	t.Run("status exact code wins and fallback ambiguity is rejected", func(t *testing.T) {
		lower, err := env.tasks.CreateStatus(ctx, tasks.CreateStatusParams{Code: "mixed", Name: "Lower", SortOrder: 20, ActorID: f.human})
		require.NoError(t, err)
		for i := 0; i < 55; i++ {
			_, err = env.tasks.CreateStatus(ctx, tasks.CreateStatusParams{Code: fmt.Sprintf("bulk_status_%02d", i), Name: fmt.Sprintf("Bulk status %02d", i), SortOrder: i + 30, ActorID: f.human})
			require.NoError(t, err)
		}
		_, err = env.tasks.CreateStatus(ctx, tasks.CreateStatusParams{Code: "MIXED", Name: "Upper", SortOrder: 100, ActorID: f.human})
		require.NoError(t, err)
		tail, err := env.tasks.CreateStatus(ctx, tasks.CreateStatusParams{Code: "tail_status", Name: "Tail", SortOrder: 101, ActorID: f.human})
		require.NoError(t, err)
		request := f.createBody("Exact status")
		request["status"] = "mixed"
		status, body := env.do(t, http.MethodPost, "/api/bot/v1/tasks", env.token, request)
		require.Equal(t, http.StatusCreated, status)
		assert.Equal(t, lower.ID.String(), body["status"].(map[string]any)["id"])
		path := "/api/bot/v1/tasks/" + body["public_id"].(string)
		status, updated := env.do(t, http.MethodPatch, path, env.token, map[string]any{"status": "TAIL_STATUS"})
		require.Equal(t, http.StatusOK, status)
		assert.Equal(t, tail.ID.String(), updated["status"].(map[string]any)["id"], "case-insensitive resolution considers statuses after the 50-candidate display cap")
		for _, statusInput := range []string{"MiXeD", "A Open"} {
			before := taskWriteSnapshot(t, env)
			status, failure := env.do(t, http.MethodPatch, path, env.token, map[string]any{"status": statusInput})
			assert.Equal(t, http.StatusBadRequest, status)
			assert.Contains(t, failure["error"], "valid statuses:")
			assert.Contains(t, failure["error"], "write_open")
			assert.Contains(t, failure["error"], "…")
			assert.NotContains(t, failure["error"], "bulk_status_54")
			assert.Equal(t, before, taskWriteSnapshot(t, env))
		}
	})

	t.Run("current active enum scope exact precedence and all-match resolution", func(t *testing.T) {
		items := []tasks.DictionaryItemInput{
			{ValueCode: "todo", ValueName: "To Do", SortOrder: 1, IsActive: true},
			{ValueCode: "code", ValueName: "Exact", SortOrder: 2, IsActive: true},
			{ValueCode: "CODE", ValueName: "Upper", SortOrder: 3, IsActive: true},
			{ValueCode: "alias", ValueName: "code", SortOrder: 4, IsActive: true},
			{ValueCode: "ambiguous_a", ValueName: "Shared Label", SortOrder: 5, IsActive: true},
		}
		for i := 0; i < 55; i++ {
			items = append(items, tasks.DictionaryItemInput{ValueCode: fmt.Sprintf("bulk_%02d", i), ValueName: fmt.Sprintf("Bulk %02d", i), SortOrder: i + 10, IsActive: true})
		}
		items = append(items,
			tasks.DictionaryItemInput{ValueCode: "ambiguous_b", ValueName: "Shared Label", SortOrder: 100, IsActive: true},
			tasks.DictionaryItemInput{ValueCode: "last", ValueName: "Last Match", SortOrder: 101, IsActive: true},
			tasks.DictionaryItemInput{ValueCode: "inactive", ValueName: "Inactive", SortOrder: 102, IsActive: false},
		)
		version, err := env.tasks.CreateDictionaryVersion(ctx, f.dictionary.ID, items, f.human)
		require.NoError(t, err)
		for _, tc := range []struct{ input, canonical string }{{"code", "code"}, {"CODE", "CODE"}, {"Last Match", "last"}, {"LAST", "last"}} {
			status, body := env.do(t, http.MethodPost, "/api/bot/v1/tasks", env.token, f.createBody("Resolved enum", taskWriteField("state", tc.input)))
			require.Equal(t, http.StatusCreated, status, "response: %#v", body)
			field := taskWriteFields(t, body)["state"]
			assert.Equal(t, tc.canonical, field["value_text"])
			assert.Equal(t, float64(version.Version), field["enum_version"])
			taskWriteAssertReadBack(t, env, body)
		}
		for _, input := range []string{"CoDe", "Shared Label", "inactive", "missing"} {
			before := taskWriteSnapshot(t, env)
			status, body := env.do(t, http.MethodPost, "/api/bot/v1/tasks", env.token, f.createBody("Rejected enum", taskWriteField("state", input)))
			assert.Equal(t, http.StatusBadRequest, status, "input: %s, response: %#v", input, body)
			assert.Contains(t, body["error"], "valid values:")
			assert.Contains(t, body["error"], "…", "candidate errors cap their list after 50 even though resolution sees every item")
			assert.NotContains(t, body["error"], "Bulk 54", "late candidates must not leak past the display cap")
			assert.Equal(t, before, taskWriteSnapshot(t, env))
		}
		status, body := env.do(t, http.MethodPost, "/api/bot/v1/tasks", env.token, f.createBody("Canonical duplicate", taskWriteField("states", []string{"To Do", "to do"})))
		assert.Equal(t, http.StatusBadRequest, status)
		assert.Equal(t, `bad request: duplicate value "todo" in field "states"`, body["error"])
	})
}
