package integrations

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"

	"msgnr/internal/documents"
	"msgnr/internal/tasks"
)

func TestMapIntegrationTaskResponse(t *testing.T) {
	fieldID := uuid.New()
	userID := uuid.New()
	statusID := uuid.New()
	now := time.Now().UTC().Round(time.Second)
	description := "Task description"
	publicID := "INT-42"
	valueText := "hello"
	valueDate := "2026-03-25"
	valueNumber := "42"
	rawJSON := json.RawMessage(`["a","b"]`)
	enumID := uuid.New()
	enumVersion := int32(3)

	resp := mapIntegrationTaskResponse(tasks.TaskResponse{
		TaskRow: tasks.TaskRow{
			PublicID:    publicID,
			Title:       "Task title",
			Description: &description,
			StatusID:    statusID,
		},
		FieldValues: []tasks.FieldValueRow{{
			FieldDefinitionID: fieldID,
			ValueText:         &valueText,
			ValueNumber:       &valueNumber,
			ValueUserID:       &userID,
			ValueDate:         &valueDate,
			ValueDatetime:     &now,
			ValueJSON:         rawJSON,
			EnumDictionaryID:  &enumID,
			EnumVersion:       &enumVersion,
		}},
	}, integrationTaskStatusDTO{
		ID:   statusID,
		Code: "open",
		Name: "Open",
	}, []tasks.FieldRow{{
		ID:       fieldID,
		Code:     "summary",
		Name:     "Summary",
		Type:     "text",
		Required: true,
	}})

	if resp.PublicID != publicID {
		t.Fatalf("expected public_id to map")
	}
	if resp.Title != "Task title" {
		t.Fatalf("expected title to map")
	}
	if resp.Description == nil || *resp.Description != description {
		t.Fatalf("expected description to map")
	}
	if resp.Status.ID != statusID || resp.Status.Code != "open" || resp.Status.Name != "Open" {
		t.Fatalf("expected status to map, got %+v", resp.Status)
	}
	if len(resp.Fields) != 1 {
		t.Fatalf("expected one field, got %d", len(resp.Fields))
	}
	field := resp.Fields[0]
	if field.Code != "summary" || field.Name != "Summary" || field.Type != "text" || !field.Required {
		t.Fatalf("expected field metadata to map: %+v", field)
	}
	if field.ValueText == nil || *field.ValueText != valueText {
		t.Fatalf("expected value_text to map")
	}
	if field.ValueNumber == nil || *field.ValueNumber != valueNumber {
		t.Fatalf("expected value_number to map")
	}
	if field.ValueUserID == nil || *field.ValueUserID != userID {
		t.Fatalf("expected value_user_id to map")
	}
	if field.ValueDate == nil || *field.ValueDate != valueDate {
		t.Fatalf("expected value_date to map")
	}
	if field.ValueDatetime == nil || !field.ValueDatetime.Equal(now) {
		t.Fatalf("expected value_datetime to map")
	}
	if string(field.ValueJSON) != string(rawJSON) {
		t.Fatalf("expected value_json to map, got %s", string(field.ValueJSON))
	}
	if field.EnumDictionaryID == nil || *field.EnumDictionaryID != enumID {
		t.Fatalf("expected enum_dictionary_id to map")
	}
	if field.EnumVersion == nil || *field.EnumVersion != enumVersion {
		t.Fatalf("expected enum_version to map")
	}
}

func TestMapIntegrationTaskResponseHierarchyJSON(t *testing.T) {
	parentPublicID := "INT-1"
	for _, tt := range []struct {
		name         string
		task         tasks.TaskResponse
		wantSubtasks string
		wantParent   bool
	}{
		{name: "nil subtasks", wantSubtasks: "[]"},
		{
			name:         "empty subtasks",
			task:         tasks.TaskResponse{Subtasks: []tasks.TaskSubtaskSummary{}},
			wantSubtasks: "[]",
		},
		{
			name: "parent preserves loaded order and exposes only pointers",
			task: tasks.TaskResponse{Subtasks: []tasks.TaskSubtaskSummary{
				{
					TaskRow:   tasks.TaskRow{PublicID: "INT-3", Title: "First child", StatusID: uuid.New(), CreatedAt: time.Now()},
					Assignees: []tasks.TaskAssigneeSummary{{DisplayName: "Assignee"}},
				},
				{TaskRow: tasks.TaskRow{PublicID: "INT-2", Title: "Second child"}},
			}},
			wantSubtasks: `[{"public_id":"INT-3","title":"First child"},{"public_id":"INT-2","title":"Second child"}]`,
		},
		{
			name:         "subtask includes parent and empty array",
			task:         tasks.TaskResponse{ParentPublicID: &parentPublicID},
			wantSubtasks: "[]",
			wantParent:   true,
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			resp := mapIntegrationTaskResponse(tt.task, integrationTaskStatusDTO{}, nil)
			data, err := json.Marshal(resp)
			if err != nil {
				t.Fatalf("marshal response: %v", err)
			}
			var payload map[string]json.RawMessage
			if err := json.Unmarshal(data, &payload); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if got := string(payload["subtasks"]); got != tt.wantSubtasks {
				t.Fatalf("expected subtasks %s, got %s", tt.wantSubtasks, got)
			}
			parent, present := payload["parent_public_id"]
			if present != tt.wantParent {
				t.Fatalf("expected parent_public_id presence %t, got %s", tt.wantParent, data)
			}
			if tt.wantParent && string(parent) != `"INT-1"` {
				t.Fatalf("expected parent_public_id INT-1, got %s", parent)
			}
		})
	}
}

func TestMapIntegrationDocumentResponse(t *testing.T) {
	parentID := uuid.New()
	description := "Document body"

	resp := mapIntegrationDocumentResponse(documents.DocumentResponse{
		ID:               uuid.New(),
		ParentDocumentID: &parentID,
		Title:            "Spec",
		ContentMarkdown:  &description,
	})

	if resp.ParentID == nil || *resp.ParentID != parentID {
		t.Fatalf("expected parent id to map")
	}
	if resp.Title != "Spec" {
		t.Fatalf("expected title to map")
	}
	if resp.Description == nil || *resp.Description != description {
		t.Fatalf("expected description to map")
	}
}

func TestMapIntegrationDocumentResponseNilDescription(t *testing.T) {
	resp := mapIntegrationDocumentResponse(documents.DocumentResponse{
		ID:    uuid.New(),
		Title: "Spec",
	})

	if resp.Description != nil {
		t.Fatalf("expected nil description, got %+v", resp.Description)
	}
}
