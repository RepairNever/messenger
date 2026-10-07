package botapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"

	"msgnr/internal/tasks"
)

func (s *Service) createBotTask(ctx context.Context, actorID uuid.UUID, req taskWriteRequest) (any, error) {
	if strings.TrimSpace(req.Template) == "" {
		return nil, fmt.Errorf("%w: template is required", tasks.ErrBadRequest)
	}
	templates, err := s.tasksSvc.ListTemplates(ctx, false)
	if err != nil {
		return nil, err
	}
	var templateID uuid.UUID
	prefixes := make([]string, 0, len(templates))
	for _, template := range templates {
		prefixes = append(prefixes, template.Prefix)
		if template.Prefix == req.Template {
			templateID = template.ID
		}
	}
	if templateID == uuid.Nil {
		return nil, fmt.Errorf("%w: unknown template %q; valid templates: %s", tasks.ErrBadRequest, req.Template, taskCandidates(prefixes))
	}
	statusID, err := s.resolveBotTaskStatus(ctx, req.Status)
	if err != nil {
		return nil, err
	}
	var parentID *uuid.UUID
	if req.ParentPublicID != nil {
		parent, err := s.ResolveTaskByPublicID(ctx, *req.ParentPublicID)
		if err != nil {
			if errors.Is(err, tasks.ErrNotFound) {
				return nil, fmt.Errorf("%w: parent task", tasks.ErrNotFound)
			}
			return nil, err
		}
		parentID = &parent.ID
	}
	defs, err := s.tasksSvc.ListFields(ctx, templateID, false)
	if err != nil {
		return nil, err
	}
	values, err := s.resolveBotTaskFields(ctx, defs, req.FieldValues)
	if err != nil {
		return nil, err
	}
	var title string
	if req.Title != nil {
		title = strings.TrimSpace(*req.Title)
	}
	description := botTaskDescription(req.Description)
	task, err := s.tasksSvc.CreateTask(ctx, tasks.CreateTaskParams{
		TemplateID: templateID, Title: title, Description: description,
		ParentTaskID: parentID, StatusID: statusID, ActorID: actorID,
		FieldValues: mergedBotTaskFields(defs, nil, values),
	})
	if err != nil {
		return nil, err
	}
	return s.IntegrationTask(ctx, task.PublicID)
}

func (s *Service) updateBotTask(ctx context.Context, actorID uuid.UUID, publicID string, req taskWriteRequest) (any, error) {
	current, err := s.ResolveTaskByPublicID(ctx, publicID)
	if err != nil {
		return nil, err
	}
	defs, err := s.tasksSvc.ListFields(ctx, current.TemplateID, false)
	if err != nil {
		return nil, err
	}
	values, err := s.resolveBotTaskFields(ctx, defs, req.FieldValues)
	if err != nil {
		return nil, err
	}
	statusID := current.StatusID
	if req.Status != nil {
		statusID, err = s.resolveBotTaskStatus(ctx, req.Status)
		if err != nil {
			return nil, err
		}
	}
	title := current.Title
	if req.Title != nil {
		title = *req.Title
	}
	description := current.Description
	if len(req.Description) > 0 {
		description = botTaskDescription(req.Description)
	}
	_, err = s.tasksSvc.UpdateTask(ctx, current.ID, tasks.UpdateTaskParams{
		Title: title, Description: description, StatusID: statusID, ActorID: actorID,
		FieldValues: mergedBotTaskFields(defs, current.FieldValues, values),
	})
	if err != nil {
		return nil, err
	}
	return s.IntegrationTask(ctx, current.PublicID)
}

func botTaskDescription(raw json.RawMessage) *string {
	var description *string
	// decodeTaskWrite has already validated that this is a string or null.
	_ = json.Unmarshal(raw, &description)
	if description == nil {
		return nil
	}
	value := strings.TrimSpace(*description)
	if value == "" {
		return nil
	}
	return &value
}

func (s *Service) resolveBotTaskStatus(ctx context.Context, requested *string) (uuid.UUID, error) {
	statuses, err := s.tasksSvc.ListStatuses(ctx, false)
	if err != nil {
		return uuid.Nil, err
	}
	if requested == nil {
		if len(statuses) == 0 {
			return uuid.Nil, fmt.Errorf("%w: no active task statuses configured", tasks.ErrBadRequest)
		}
		return statuses[0].ID, nil
	}
	code := strings.TrimSpace(*requested)
	candidates := make([]string, 0, len(statuses))
	var matched uuid.UUID
	matches := 0
	for _, status := range statuses {
		if status.Code == code {
			return status.ID, nil
		}
		candidates = append(candidates, fmt.Sprintf("%s (%s)", status.Code, status.Name))
		if strings.EqualFold(status.Code, code) {
			matched = status.ID
			matches++
		}
	}
	if matches == 1 {
		return matched, nil
	}
	reason := "unknown"
	if matches > 1 {
		reason = "ambiguous"
	}
	return uuid.Nil, fmt.Errorf("%w: %s status %q; valid statuses: %s", tasks.ErrBadRequest, reason, code, taskCandidates(candidates))
}

func taskCandidates(candidates []string) string {
	if len(candidates) > 50 {
		return strings.Join(candidates[:50], ", ") + ", …"
	}
	if len(candidates) == 0 {
		return "(none)"
	}
	return strings.Join(candidates, ", ")
}

// Only supplied entries go through the stricter bot validation. Untouched
// historical values retain their exact stored columns and enum version pins.
func mergedBotTaskFields(defs []tasks.FieldRow, current []tasks.FieldValueRow, changes map[uuid.UUID]*tasks.FieldValueInput) []tasks.FieldValueInput {
	active := make(map[uuid.UUID]bool, len(defs))
	for _, def := range defs {
		active[def.ID] = true
	}
	values := make(map[uuid.UUID]tasks.FieldValueInput, len(current))
	for _, row := range current {
		if !active[row.FieldDefinitionID] || !botTaskFieldHasStoredValue(row) {
			continue
		}
		values[row.FieldDefinitionID] = tasks.FieldValueInput{
			FieldDefinitionID: row.FieldDefinitionID,
			ValueText:         row.ValueText, ValueNumber: row.ValueNumber,
			ValueUserID: row.ValueUserID, ValueDate: row.ValueDate,
			ValueDatetime: row.ValueDatetime, ValueJSON: row.ValueJSON,
			EnumDictionaryID: row.EnumDictionaryID, EnumVersion: row.EnumVersion,
		}
	}
	for id, value := range changes {
		if value == nil {
			delete(values, id)
		} else {
			values[id] = *value
		}
	}
	merged := make([]tasks.FieldValueInput, 0, len(values))
	for _, def := range defs {
		if value, ok := values[def.ID]; ok {
			merged = append(merged, value)
		}
	}
	return merged
}

func botTaskFieldHasStoredValue(row tasks.FieldValueRow) bool {
	return row.ValueText != nil || row.ValueNumber != nil || row.ValueUserID != nil ||
		row.ValueDate != nil || row.ValueDatetime != nil || len(row.ValueJSON) > 0
}
