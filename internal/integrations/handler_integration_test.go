//go:build integration

package integrations

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"msgnr/internal/documents"
	"msgnr/internal/tasks"
	"msgnr/internal/testdb"
)

func seedUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, role, status string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role, status)
		 VALUES ($1, 'x', $2, $3, $4)
		 RETURNING id`,
		"integration_"+uuid.NewString()+"@example.com",
		role+" user",
		role,
		status,
	).Scan(&id)
	if err != nil {
		t.Fatalf("seed user: %v", err)
	}
	return id
}

func seedToken(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID uuid.UUID, raw string, revoked bool) {
	t.Helper()
	var revokedAt any
	if revoked {
		revokedAt = time.Now().UTC()
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO integration_token (user_id, token_hash, revoked_at)
		 VALUES ($1, $2, $3)`,
		userID,
		hashToken(raw),
		revokedAt,
	); err != nil {
		t.Fatalf("seed token: %v", err)
	}
}

func newHandler(pool *pgxpool.Pool) *Handler {
	taskSvc := tasks.NewService(pool, nil)
	documentSvc := documents.NewService(pool, nil)
	return NewHandler(NewService(pool, taskSvc, documentSvc, zap.NewNop()), zap.NewNop())
}

func newMux(pool *pgxpool.Pool) *http.ServeMux {
	mux := http.NewServeMux()
	newHandler(pool).RegisterRoutes(mux)
	return mux
}

func seedTask(t *testing.T, ctx context.Context, pool *pgxpool.Pool, actorID uuid.UUID) tasks.TaskResponse {
	t.Helper()
	svc := tasks.NewService(pool, nil)
	template, err := svc.CreateTemplate(ctx, tasks.CreateTemplateParams{
		Prefix:    "INT",
		SortOrder: 1,
		ActorID:   actorID,
	})
	if err != nil {
		t.Fatalf("create template: %v", err)
	}
	status, err := svc.CreateStatus(ctx, tasks.CreateStatusParams{
		Code:      "open",
		Name:      "Open",
		SortOrder: 1,
		ActorID:   actorID,
	})
	if err != nil {
		t.Fatalf("create status: %v", err)
	}
	field, err := svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: template.ID,
		Code:       "summary",
		Name:       "Summary",
		Type:       "text",
		Required:   true,
		SortOrder:  1,
	})
	if err != nil {
		t.Fatalf("create field: %v", err)
	}
	description := "Task description"
	value := "Field value"
	taskRow, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID:  template.ID,
		Title:       "Integration task",
		Description: &description,
		StatusID:    status.ID,
		FieldValues: []tasks.FieldValueInput{{
			FieldDefinitionID: field.ID,
			ValueText:         &value,
		}},
		ActorID: actorID,
	})
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	return taskRow
}

func seedTeamspace(t *testing.T, ctx context.Context, pool *pgxpool.Pool, ownerID uuid.UUID, memberIDs ...uuid.UUID) documents.TeamspaceRow {
	t.Helper()
	svc := documents.NewService(pool, nil)
	var role string
	if err := pool.QueryRow(ctx, `SELECT role FROM users WHERE id = $1`, ownerID).Scan(&role); err != nil {
		t.Fatalf("get teamspace owner role: %v", err)
	}
	row, err := svc.CreateTeamspace(ctx, documents.CreateTeamspaceParams{
		Name:      "Docs " + uuid.NewString(),
		MemberIDs: memberIDs,
		ActorID:   ownerID,
	}, role)
	if err != nil {
		t.Fatalf("create teamspace: %v", err)
	}
	return row
}

func seedDocument(t *testing.T, ctx context.Context, pool *pgxpool.Pool, actorID, teamspaceID uuid.UUID, parentID *uuid.UUID, title string) documents.DocumentResponse {
	t.Helper()
	svc := documents.NewService(pool, nil)
	description := title + " description"
	row, err := svc.CreateDocument(ctx, documents.CreateDocumentParams{
		TeamspaceID:      teamspaceID,
		ParentDocumentID: parentID,
		Title:            title,
		ContentMarkdown:  &description,
		ActorID:          actorID,
	})
	if err != nil {
		t.Fatalf("create document: %v", err)
	}
	return row
}

func seedStatusRow(t *testing.T, ctx context.Context, svc *tasks.Service, actorID uuid.UUID, code, name string) tasks.StatusRow {
	t.Helper()
	row, err := svc.CreateStatus(ctx, tasks.CreateStatusParams{
		Code:      code,
		Name:      name,
		SortOrder: 1,
		ActorID:   actorID,
	})
	if err != nil {
		t.Fatalf("create status: %v", err)
	}
	return row
}

func seedTemplateRow(t *testing.T, ctx context.Context, svc *tasks.Service, actorID uuid.UUID, prefix string) tasks.TemplateRow {
	t.Helper()
	row, err := svc.CreateTemplate(ctx, tasks.CreateTemplateParams{
		Prefix:    prefix,
		SortOrder: 1,
		ActorID:   actorID,
	})
	if err != nil {
		t.Fatalf("create template: %v", err)
	}
	return row
}

func seedDictionaryVersion(
	t *testing.T,
	ctx context.Context,
	svc *tasks.Service,
	actorID uuid.UUID,
	code string,
	items []tasks.DictionaryItemInput,
) (tasks.DictionaryRow, tasks.DictionaryVersionRow) {
	t.Helper()
	dict, err := svc.CreateDictionary(ctx, tasks.CreateDictionaryParams{
		Code: code,
		Name: strings.ToUpper(code[:1]) + code[1:],
	})
	if err != nil {
		t.Fatalf("create dictionary: %v", err)
	}
	ver, err := svc.CreateDictionaryVersion(ctx, dict.ID, items, actorID)
	if err != nil {
		t.Fatalf("create dictionary version: %v", err)
	}
	return dict, ver
}

func seedEnumField(
	t *testing.T,
	ctx context.Context,
	svc *tasks.Service,
	templateID uuid.UUID,
	code string,
	name string,
	fieldType string,
	dictID uuid.UUID,
	sortOrder int,
) tasks.FieldRow {
	t.Helper()
	row, err := svc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID:       templateID,
		Code:             code,
		Name:             name,
		Type:             fieldType,
		SortOrder:        sortOrder,
		EnumDictionaryID: &dictID,
	})
	if err != nil {
		t.Fatalf("create field: %v", err)
	}
	return row
}

func seedLookupTask(
	t *testing.T,
	ctx context.Context,
	svc *tasks.Service,
	actorID uuid.UUID,
	templateID uuid.UUID,
	statusID uuid.UUID,
	title string,
	fieldValues []tasks.FieldValueInput,
) tasks.TaskResponse {
	t.Helper()
	row, err := svc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID:  templateID,
		Title:       title,
		StatusID:    statusID,
		FieldValues: fieldValues,
		ActorID:     actorID,
	})
	if err != nil {
		t.Fatalf("create lookup task: %v", err)
	}
	return row
}

func setTaskUpdatedAt(t *testing.T, ctx context.Context, pool *pgxpool.Pool, taskID uuid.UUID, updatedAt time.Time) {
	t.Helper()
	if _, err := pool.Exec(ctx, `UPDATE task SET updated_at = $2 WHERE id = $1`, taskID, updatedAt); err != nil {
		t.Fatalf("set task updated_at: %v", err)
	}
}

func strPtr(s string) *string { return &s }

func assertIntegrationTaskSummary(t *testing.T, resp integrationTaskResponseDTO, task tasks.TaskResponse, status tasks.StatusRow) {
	t.Helper()
	if resp.PublicID != task.PublicID {
		t.Fatalf("expected public_id %q, got %q", task.PublicID, resp.PublicID)
	}
	if resp.Status.ID != status.ID || resp.Status.Code != status.Code || resp.Status.Name != status.Name {
		t.Fatalf("expected status %+v, got %+v", status, resp.Status)
	}
}

func TestHandler_GetTaskByPublicID(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	mux := newMux(pool)
	taskSvc := tasks.NewService(pool, nil)

	actorID := seedUser(t, ctx, pool, "admin", "active")
	botID := seedUser(t, ctx, pool, "bot", "active")
	seedToken(t, ctx, pool, botID, "task-token", false)
	taskRow := seedTask(t, ctx, pool, actorID)
	status, err := taskSvc.GetStatus(ctx, taskRow.StatusID)
	if err != nil {
		t.Fatalf("get status: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/integrations/tasks/"+taskRow.PublicID, nil)
	req.Header.Set("Authorization", "Bearer task-token")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var payload map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode raw response: %v", err)
	}
	if raw, exists := payload["subtasks"]; !exists || string(raw) != "[]" {
		t.Fatalf("expected present, empty subtasks array, got %s", rec.Body.String())
	}
	if _, exists := payload["parent_public_id"]; exists {
		t.Fatalf("expected top-level task to omit parent_public_id, got %s", rec.Body.String())
	}

	var resp integrationTaskResponseDTO
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	assertIntegrationTaskSummary(t, resp, taskRow, status)
	if resp.Title != taskRow.Title {
		t.Fatalf("expected title %q, got %q", taskRow.Title, resp.Title)
	}
	if resp.Description == nil || *resp.Description != "Task description" {
		t.Fatalf("expected description to map, got %+v", resp.Description)
	}
	if len(resp.Fields) != 1 {
		t.Fatalf("expected one field, got %d", len(resp.Fields))
	}
	if resp.Fields[0].Code != "summary" || resp.Fields[0].ValueText == nil || *resp.Fields[0].ValueText != "Field value" {
		t.Fatalf("expected field metadata and value to map, got %+v", resp.Fields[0])
	}
}

func TestHandler_GetTaskByPublicID_Subtasks(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	mux := newMux(pool)
	taskSvc := tasks.NewService(pool, nil)

	actorID := seedUser(t, ctx, pool, "admin", "active")
	botID := seedUser(t, ctx, pool, "bot", "active")
	seedToken(t, ctx, pool, botID, "subtask-token", false)
	template := seedTemplateRow(t, ctx, taskSvc, actorID, "INTS")
	open := seedStatusRow(t, ctx, taskSvc, actorID, "open", "Open")
	done := seedStatusRow(t, ctx, taskSvc, actorID, "done", "Done")

	createTask := func(title string, statusID uuid.UUID, parentID *uuid.UUID) tasks.TaskResponse {
		t.Helper()
		row, err := taskSvc.CreateTask(ctx, tasks.CreateTaskParams{
			TemplateID:   template.ID,
			ParentTaskID: parentID,
			Title:        title,
			StatusID:     statusID,
			ActorID:      actorID,
		})
		if err != nil {
			t.Fatalf("create task %q: %v", title, err)
		}
		return row
	}
	parent := createTask("Parent task", open.ID, nil)
	later := createTask("Open later child", open.ID, &parent.ID)
	earlier := createTask("Completed earlier child", done.ID, &parent.ID)
	base := time.Date(2026, 10, 5, 10, 0, 0, 0, time.UTC)
	for _, child := range []struct {
		id        uuid.UUID
		createdAt time.Time
	}{
		{later.ID, base.Add(time.Hour)},
		{earlier.ID, base},
	} {
		if _, err := pool.Exec(ctx, `UPDATE task SET created_at = $2 WHERE id = $1`, child.id, child.createdAt); err != nil {
			t.Fatalf("set child created_at: %v", err)
		}
	}

	getTask := func(t *testing.T, publicID string) map[string]json.RawMessage {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/api/integrations/tasks/"+publicID, nil)
		req.Header.Set("Authorization", "Bearer subtask-token")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 for %q, got %d: %s", publicID, rec.Code, rec.Body.String())
		}
		var payload map[string]json.RawMessage
		if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		return payload
	}

	t.Run("parent returns pointers in created_at order including completed child", func(t *testing.T) {
		payload := getTask(t, parent.PublicID)
		if _, exists := payload["parent_public_id"]; exists {
			t.Fatalf("expected parent task to omit parent_public_id, got %s", payload["parent_public_id"])
		}
		raw, exists := payload["subtasks"]
		if !exists || string(raw) == "null" {
			t.Fatalf("expected present subtasks array, got %s", raw)
		}
		var subtasks []map[string]json.RawMessage
		if err := json.Unmarshal(raw, &subtasks); err != nil {
			t.Fatalf("decode subtasks: %v", err)
		}
		if len(subtasks) != 2 {
			t.Fatalf("expected two subtasks, got %s", raw)
		}
		for i, expected := range []tasks.TaskResponse{earlier, later} {
			item := subtasks[i]
			if len(item) != 2 || item["public_id"] == nil || item["title"] == nil {
				t.Fatalf("expected exactly public_id and title on subtask %d, got %+v", i, item)
			}
			var publicID, title string
			if err := json.Unmarshal(item["public_id"], &publicID); err != nil {
				t.Fatalf("decode subtask public_id: %v", err)
			}
			if err := json.Unmarshal(item["title"], &title); err != nil {
				t.Fatalf("decode subtask title: %v", err)
			}
			if publicID != expected.PublicID || title != expected.Title {
				t.Fatalf("expected subtask %d to be %q (%q), got %q (%q)", i, expected.PublicID, expected.Title, publicID, title)
			}
		}
	})

	for _, child := range []tasks.TaskResponse{earlier, later} {
		t.Run("subtask "+child.PublicID+" resolves with parent pointer", func(t *testing.T) {
			payload := getTask(t, child.PublicID)
			if raw, exists := payload["subtasks"]; !exists || string(raw) != "[]" {
				t.Fatalf("expected present, empty subtasks array, got %s", raw)
			}
			raw, exists := payload["parent_public_id"]
			if !exists {
				t.Fatal("expected subtask to include parent_public_id")
			}
			var parentPublicID string
			if err := json.Unmarshal(raw, &parentPublicID); err != nil {
				t.Fatalf("decode parent_public_id: %v", err)
			}
			if parentPublicID != parent.PublicID {
				t.Fatalf("expected parent_public_id %q, got %q", parent.PublicID, parentPublicID)
			}
		})
	}
}

func TestHandler_GetTaskByPublicID_IncludesDeletedStatus(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	mux := newMux(pool)
	taskSvc := tasks.NewService(pool, nil)

	actorID := seedUser(t, ctx, pool, "admin", "active")
	botID := seedUser(t, ctx, pool, "bot", "active")
	seedToken(t, ctx, pool, botID, "task-token", false)

	template := seedTemplateRow(t, ctx, taskSvc, actorID, "INTD")
	status := seedStatusRow(t, ctx, taskSvc, actorID, "done", "Done")
	field, err := taskSvc.CreateField(ctx, tasks.CreateFieldParams{
		TemplateID: template.ID,
		Code:       "summary",
		Name:       "Summary",
		Type:       "text",
		Required:   true,
		SortOrder:  1,
	})
	if err != nil {
		t.Fatalf("create field: %v", err)
	}
	taskRow := seedLookupTask(t, ctx, taskSvc, actorID, template.ID, status.ID, "Deleted status task", []tasks.FieldValueInput{{
		FieldDefinitionID: field.ID,
		ValueText:         strPtr("Still readable"),
	}})
	if _, err := taskSvc.SoftDeleteStatus(ctx, status.ID); err != nil {
		t.Fatalf("soft delete status: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/integrations/tasks/"+taskRow.PublicID, nil)
	req.Header.Set("Authorization", "Bearer task-token")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp integrationTaskResponseDTO
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	assertIntegrationTaskSummary(t, resp, taskRow, status)
}

func TestHandler_GetTaskByPublicIDNotFound(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	mux := newMux(pool)

	botID := seedUser(t, ctx, pool, "bot", "active")
	seedToken(t, ctx, pool, botID, "task-token", false)

	req := httptest.NewRequest(http.MethodGet, "/api/integrations/tasks/INT-999", nil)
	req.Header.Set("Authorization", "Bearer task-token")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestHandler_FindTasksByEnumValue_SingleEnumByCode(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	mux := newMux(pool)
	taskSvc := tasks.NewService(pool, nil)

	actorID := seedUser(t, ctx, pool, "admin", "active")
	botID := seedUser(t, ctx, pool, "bot", "active")
	seedToken(t, ctx, pool, botID, "enum-token", false)

	status := seedStatusRow(t, ctx, taskSvc, actorID, "open", "Open")
	dict, ver := seedDictionaryVersion(t, ctx, taskSvc, actorID, "priority", []tasks.DictionaryItemInput{
		{ValueCode: "high", ValueName: "High", SortOrder: 1, IsActive: true},
		{ValueCode: "low", ValueName: "Low", SortOrder: 2, IsActive: true},
	})
	template := seedTemplateRow(t, ctx, taskSvc, actorID, "ENUMA")
	field := seedEnumField(t, ctx, taskSvc, template.ID, "priority", "Priority", "enum", dict.ID, 1)
	enumVersion := int32(ver.Version)

	match := seedLookupTask(t, ctx, taskSvc, actorID, template.ID, status.ID, "High priority", []tasks.FieldValueInput{{
		FieldDefinitionID: field.ID,
		ValueText:         strPtr("high"),
		EnumDictionaryID:  &dict.ID,
		EnumVersion:       &enumVersion,
	}})
	seedLookupTask(t, ctx, taskSvc, actorID, template.ID, status.ID, "Low priority", []tasks.FieldValueInput{{
		FieldDefinitionID: field.ID,
		ValueText:         strPtr("low"),
		EnumDictionaryID:  &dict.ID,
		EnumVersion:       &enumVersion,
	}})
	if _, err := taskSvc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID:   template.ID,
		ParentTaskID: &match.ID,
		Title:        "Lookup match child",
		StatusID:     status.ID,
		ActorID:      actorID,
	}); err != nil {
		t.Fatalf("create lookup match child: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/integrations/tasks/by-enum/priority/value/high", nil)
	req.Header.Set("Authorization", "Bearer enum-token")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var payload []map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode raw lookup response: %v", err)
	}
	if len(payload) != 1 {
		t.Fatalf("expected one lookup task, got %s", rec.Body.String())
	}
	if len(payload[0]) != 5 {
		t.Fatalf("expected lookup to preserve its original five keys, got %s", rec.Body.String())
	}
	for _, key := range []string{"public_id", "title", "description", "status", "fields"} {
		if _, exists := payload[0][key]; !exists {
			t.Fatalf("expected lookup key %q, got %s", key, rec.Body.String())
		}
	}

	var resp []integrationTaskResponseDTO
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(resp) != 1 {
		t.Fatalf("expected one task, got %d", len(resp))
	}
	assertIntegrationTaskSummary(t, resp[0], match, status)
	if resp[0].Title != match.Title {
		t.Fatalf("expected matched title %q, got %q", match.Title, resp[0].Title)
	}
	if len(resp[0].Fields) != 1 || resp[0].Fields[0].Code != "priority" {
		t.Fatalf("expected enum field metadata in response, got %+v", resp[0].Fields)
	}
	if resp[0].Fields[0].ValueText == nil || *resp[0].Fields[0].ValueText != "high" {
		t.Fatalf("expected enum value_text to map, got %+v", resp[0].Fields[0])
	}
}

func TestHandler_FindTasksByEnumValue_MultiEnumByNameCaseInsensitive(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	mux := newMux(pool)
	taskSvc := tasks.NewService(pool, nil)

	actorID := seedUser(t, ctx, pool, "admin", "active")
	botID := seedUser(t, ctx, pool, "bot", "active")
	seedToken(t, ctx, pool, botID, "enum-token", false)

	status := seedStatusRow(t, ctx, taskSvc, actorID, "open", "Open")
	dict, ver := seedDictionaryVersion(t, ctx, taskSvc, actorID, "labels", []tasks.DictionaryItemInput{
		{ValueCode: "backend", ValueName: "Back End", SortOrder: 1, IsActive: true},
		{ValueCode: "frontend", ValueName: "Front End", SortOrder: 2, IsActive: true},
	})
	template := seedTemplateRow(t, ctx, taskSvc, actorID, "ENUMB")
	field := seedEnumField(t, ctx, taskSvc, template.ID, "labels", "Labels", "multi_enum", dict.ID, 1)
	enumVersion := int32(ver.Version)

	rawValue := json.RawMessage(`["backend"]`)
	match := seedLookupTask(t, ctx, taskSvc, actorID, template.ID, status.ID, "Backend task", []tasks.FieldValueInput{{
		FieldDefinitionID: field.ID,
		ValueJSON:         rawValue,
		EnumDictionaryID:  &dict.ID,
		EnumVersion:       &enumVersion,
	}})

	req := httptest.NewRequest(http.MethodGet, "/api/integrations/tasks/by-enum/labels/value/"+url.PathEscape("BACK END"), nil)
	req.Header.Set("Authorization", "Bearer enum-token")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp []integrationTaskResponseDTO
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(resp) != 1 || resp[0].Title != match.Title {
		t.Fatalf("expected one multi-enum match, got %+v", resp)
	}
	assertIntegrationTaskSummary(t, resp[0], match, status)
	if string(resp[0].Fields[0].ValueJSON) != string(rawValue) {
		t.Fatalf("expected raw multi-enum value_json, got %s", string(resp[0].Fields[0].ValueJSON))
	}
}

func TestHandler_FindTasksByEnumValue_DuplicateNameDedupesAndOrders(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	mux := newMux(pool)
	taskSvc := tasks.NewService(pool, nil)

	actorID := seedUser(t, ctx, pool, "admin", "active")
	botID := seedUser(t, ctx, pool, "bot", "active")
	seedToken(t, ctx, pool, botID, "enum-token", false)

	status := seedStatusRow(t, ctx, taskSvc, actorID, "open", "Open")
	dict, ver := seedDictionaryVersion(t, ctx, taskSvc, actorID, "environment", []tasks.DictionaryItemInput{
		{ValueCode: "prod_a", ValueName: "Production", SortOrder: 1, IsActive: true},
		{ValueCode: "prod_b", ValueName: "Production", SortOrder: 2, IsActive: true},
		{ValueCode: "stage", ValueName: "Staging", SortOrder: 3, IsActive: true},
	})
	template := seedTemplateRow(t, ctx, taskSvc, actorID, "ENUMC")
	enumField := seedEnumField(t, ctx, taskSvc, template.ID, "env_primary", "Primary Env", "enum", dict.ID, 1)
	multiField := seedEnumField(t, ctx, taskSvc, template.ID, "env_secondary", "Secondary Env", "multi_enum", dict.ID, 2)
	enumVersion := int32(ver.Version)

	deduped := seedLookupTask(t, ctx, taskSvc, actorID, template.ID, status.ID, "Deduped task", []tasks.FieldValueInput{
		{
			FieldDefinitionID: enumField.ID,
			ValueText:         strPtr("prod_a"),
			EnumDictionaryID:  &dict.ID,
			EnumVersion:       &enumVersion,
		},
		{
			FieldDefinitionID: multiField.ID,
			ValueJSON:         json.RawMessage(`["prod_b"]`),
			EnumDictionaryID:  &dict.ID,
			EnumVersion:       &enumVersion,
		},
	})
	newest := seedLookupTask(t, ctx, taskSvc, actorID, template.ID, status.ID, "Newest task", []tasks.FieldValueInput{{
		FieldDefinitionID: enumField.ID,
		ValueText:         strPtr("prod_b"),
		EnumDictionaryID:  &dict.ID,
		EnumVersion:       &enumVersion,
	}})
	seedLookupTask(t, ctx, taskSvc, actorID, template.ID, status.ID, "Non match", []tasks.FieldValueInput{{
		FieldDefinitionID: enumField.ID,
		ValueText:         strPtr("stage"),
		EnumDictionaryID:  &dict.ID,
		EnumVersion:       &enumVersion,
	}})

	base := time.Date(2026, 4, 16, 10, 0, 0, 0, time.UTC)
	setTaskUpdatedAt(t, ctx, pool, deduped.ID, base.Add(1*time.Hour))
	setTaskUpdatedAt(t, ctx, pool, newest.ID, base.Add(2*time.Hour))

	req := httptest.NewRequest(http.MethodGet, "/api/integrations/tasks/by-enum/environment/value/"+url.PathEscape("production"), nil)
	req.Header.Set("Authorization", "Bearer enum-token")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp []integrationTaskResponseDTO
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(resp) != 2 {
		t.Fatalf("expected two deduped matches, got %d: %s", len(resp), rec.Body.String())
	}
	assertIntegrationTaskSummary(t, resp[0], newest, status)
	assertIntegrationTaskSummary(t, resp[1], deduped, status)
	if resp[0].Title != newest.Title || resp[1].Title != deduped.Title {
		t.Fatalf("expected updated_at desc ordering, got %+v", resp)
	}
}

func TestHandler_FindTasksByEnumValue_ReturnsEmptyArrayForMissingData(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	mux := newMux(pool)
	taskSvc := tasks.NewService(pool, nil)

	actorID := seedUser(t, ctx, pool, "admin", "active")
	botID := seedUser(t, ctx, pool, "bot", "active")
	seedToken(t, ctx, pool, botID, "enum-token", false)

	status := seedStatusRow(t, ctx, taskSvc, actorID, "open", "Open")
	dictNoUsage, _ := seedDictionaryVersion(t, ctx, taskSvc, actorID, "unused", []tasks.DictionaryItemInput{
		{ValueCode: "high", ValueName: "High", SortOrder: 1, IsActive: true},
	})
	dictWithUsage, ver := seedDictionaryVersion(t, ctx, taskSvc, actorID, "priority", []tasks.DictionaryItemInput{
		{ValueCode: "high", ValueName: "High", SortOrder: 1, IsActive: true},
		{ValueCode: "low", ValueName: "Low", SortOrder: 2, IsActive: true},
	})
	template := seedTemplateRow(t, ctx, taskSvc, actorID, "ENUMD")
	field := seedEnumField(t, ctx, taskSvc, template.ID, "priority", "Priority", "enum", dictWithUsage.ID, 1)
	enumVersion := int32(ver.Version)
	seedLookupTask(t, ctx, taskSvc, actorID, template.ID, status.ID, "Low priority", []tasks.FieldValueInput{{
		FieldDefinitionID: field.ID,
		ValueText:         strPtr("low"),
		EnumDictionaryID:  &dictWithUsage.ID,
		EnumVersion:       &enumVersion,
	}})

	testCases := []struct {
		name string
		path string
	}{
		{
			name: "unknown enum code",
			path: "/api/integrations/tasks/by-enum/missing/value/high",
		},
		{
			name: "unknown enum item",
			path: "/api/integrations/tasks/by-enum/priority/value/missing",
		},
		{
			name: "enum exists but no template uses it",
			path: "/api/integrations/tasks/by-enum/" + dictNoUsage.Code + "/value/high",
		},
		{
			name: "template uses enum but no task matches",
			path: "/api/integrations/tasks/by-enum/priority/value/high",
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tc.path, nil)
			req.Header.Set("Authorization", "Bearer enum-token")
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)

			if rec.Code != http.StatusOK {
				t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
			}
			if body := strings.TrimSpace(rec.Body.String()); body != "[]" {
				t.Fatalf("expected empty array body, got %q", body)
			}
		})
	}
}

func TestHandler_FindTasksByEnumValue_HistoricalVersionLookup(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	mux := newMux(pool)
	taskSvc := tasks.NewService(pool, nil)

	actorID := seedUser(t, ctx, pool, "admin", "active")
	botID := seedUser(t, ctx, pool, "bot", "active")
	seedToken(t, ctx, pool, botID, "enum-token", false)

	status := seedStatusRow(t, ctx, taskSvc, actorID, "open", "Open")
	dict, oldVer := seedDictionaryVersion(t, ctx, taskSvc, actorID, "release", []tasks.DictionaryItemInput{
		{ValueCode: "legacy_code", ValueName: "Legacy Name", SortOrder: 1, IsActive: true},
	})
	template := seedTemplateRow(t, ctx, taskSvc, actorID, "ENUME")
	field := seedEnumField(t, ctx, taskSvc, template.ID, "release", "Release", "enum", dict.ID, 1)
	oldEnumVersion := int32(oldVer.Version)

	match := seedLookupTask(t, ctx, taskSvc, actorID, template.ID, status.ID, "Legacy task", []tasks.FieldValueInput{{
		FieldDefinitionID: field.ID,
		ValueText:         strPtr("legacy_code"),
		EnumDictionaryID:  &dict.ID,
		EnumVersion:       &oldEnumVersion,
	}})

	_, err := taskSvc.CreateDictionaryVersion(ctx, dict.ID, []tasks.DictionaryItemInput{
		{ValueCode: "current_code", ValueName: "Current Name", SortOrder: 1, IsActive: true},
	}, actorID)
	if err != nil {
		t.Fatalf("create newer dictionary version: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/integrations/tasks/by-enum/release/value/"+url.PathEscape("legacy name"), nil)
	req.Header.Set("Authorization", "Bearer enum-token")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp []integrationTaskResponseDTO
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(resp) != 1 || resp[0].Title != match.Title {
		t.Fatalf("expected historical version match, got %+v", resp)
	}
	assertIntegrationTaskSummary(t, resp[0], match, status)
}

func TestHandler_FindTasksByEnumValue_InvalidPath(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	mux := newMux(pool)

	botID := seedUser(t, ctx, pool, "bot", "active")
	seedToken(t, ctx, pool, botID, "enum-token", false)

	testCases := []string{
		"/api/integrations/tasks/by-enum/",
		"/api/integrations/tasks/by-enum/priority/high",
		"/api/integrations/tasks/by-enum/priority/value/",
		"/api/integrations/tasks/by-enum/priority/value/high/extra",
	}

	for _, path := range testCases {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Authorization", "Bearer enum-token")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)

		if rec.Code != http.StatusBadRequest {
			t.Fatalf("path %q: expected 400, got %d: %s", path, rec.Code, rec.Body.String())
		}
	}
}

func TestHandler_IntegrationTokenAuthFailures(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	mux := newMux(pool)

	actorID := seedUser(t, ctx, pool, "admin", "active")
	taskRow := seedTask(t, ctx, pool, actorID)

	revokedBotID := seedUser(t, ctx, pool, "bot", "active")
	blockedBotID := seedUser(t, ctx, pool, "bot", "blocked")
	memberID := seedUser(t, ctx, pool, "member", "active")
	seedToken(t, ctx, pool, revokedBotID, "revoked-token", true)
	seedToken(t, ctx, pool, blockedBotID, "blocked-token", false)
	seedToken(t, ctx, pool, memberID, "member-token", false)

	testCases := []struct {
		name  string
		token string
	}{
		{name: "unknown token", token: "missing-token"},
		{name: "revoked token", token: "revoked-token"},
		{name: "blocked bot token", token: "blocked-token"},
		{name: "non-bot token", token: "member-token"},
	}

	for _, tc := range testCases {
		for _, path := range []string{
			"/api/integrations/tasks/" + taskRow.PublicID,
			"/api/integrations/tasks/by-enum/priority/value/high",
		} {
			t.Run(tc.name+" "+path, func(t *testing.T) {
				req := httptest.NewRequest(http.MethodGet, path, nil)
				req.Header.Set("Authorization", "Bearer "+tc.token)
				rec := httptest.NewRecorder()
				mux.ServeHTTP(rec, req)

				if rec.Code != http.StatusUnauthorized {
					t.Fatalf("expected 401, got %d: %s", rec.Code, rec.Body.String())
				}
			})
		}
	}
}

func TestHandler_CreateAndGetDocument(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	mux := newMux(pool)

	ownerID := seedUser(t, ctx, pool, "admin", "active")
	botID := seedUser(t, ctx, pool, "bot", "active")
	seedToken(t, ctx, pool, botID, "doc-token", false)
	teamspace := seedTeamspace(t, ctx, pool, ownerID, botID)

	body := bytes.NewBufferString(`{"title":"Spec","description":"Document body","parent_id":null,"teamspace_id":"` + teamspace.ID.String() + `"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/integrations/documents", body)
	req.Header.Set("Authorization", "Bearer doc-token")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}

	var created integrationDocumentResponseDTO
	if err := json.NewDecoder(rec.Body).Decode(&created); err != nil {
		t.Fatalf("decode create response: %v", err)
	}
	if created.Title != "Spec" || created.Description == nil || *created.Description != "Document body" {
		t.Fatalf("unexpected create response: %+v", created)
	}

	getReq := httptest.NewRequest(http.MethodGet, "/api/integrations/documents/"+created.ID.String(), nil)
	getReq.Header.Set("Authorization", "Bearer doc-token")
	getRec := httptest.NewRecorder()
	mux.ServeHTTP(getRec, getReq)

	if getRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", getRec.Code, getRec.Body.String())
	}

	var fetched integrationDocumentResponseDTO
	if err := json.NewDecoder(getRec.Body).Decode(&fetched); err != nil {
		t.Fatalf("decode get response: %v", err)
	}
	if fetched.ID != created.ID || fetched.Title != created.Title {
		t.Fatalf("unexpected fetched document: %+v", fetched)
	}
}

func TestHandler_CreateDocumentRejectsParentTeamspaceMismatch(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	mux := newMux(pool)

	ownerID := seedUser(t, ctx, pool, "admin", "active")
	botID := seedUser(t, ctx, pool, "bot", "active")
	seedToken(t, ctx, pool, botID, "doc-token", false)
	teamspaceA := seedTeamspace(t, ctx, pool, ownerID, botID)
	teamspaceB := seedTeamspace(t, ctx, pool, ownerID, botID)
	parent := seedDocument(t, ctx, pool, ownerID, teamspaceA.ID, nil, "Parent")

	body := bytes.NewBufferString(`{"title":"Child","description":"Bad","parent_id":"` + parent.ID.String() + `","teamspace_id":"` + teamspaceB.ID.String() + `"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/integrations/documents", body)
	req.Header.Set("Authorization", "Bearer doc-token")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestHandler_GetDocumentForbiddenWhenBotNotMember(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	mux := newMux(pool)

	ownerID := seedUser(t, ctx, pool, "member", "active")
	botID := seedUser(t, ctx, pool, "bot", "active")
	seedToken(t, ctx, pool, botID, "doc-token", false)
	teamspace := seedTeamspace(t, ctx, pool, ownerID)
	document := seedDocument(t, ctx, pool, ownerID, teamspace.ID, nil, "Hidden")

	req := httptest.NewRequest(http.MethodGet, "/api/integrations/documents/"+document.ID.String(), nil)
	req.Header.Set("Authorization", "Bearer doc-token")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d: %s", rec.Code, rec.Body.String())
	}
}
