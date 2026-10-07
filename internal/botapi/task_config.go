package botapi

import (
	"fmt"
	"net/http"

	"github.com/google/uuid"

	"msgnr/internal/auth"
	"msgnr/internal/httputil"
)

type tasksConfigResponse struct {
	Templates []taskConfigTemplateDTO `json:"templates"`
	Statuses  []taskConfigStatusDTO   `json:"statuses"`
}

type taskConfigTemplateDTO struct {
	ID     uuid.UUID            `json:"id"`
	Prefix string               `json:"prefix"`
	Fields []taskConfigFieldDTO `json:"fields"`
}

type taskConfigFieldDTO struct {
	ID         uuid.UUID                `json:"id"`
	Code       string                   `json:"code"`
	Name       string                   `json:"name"`
	Type       string                   `json:"type"`
	Required   bool                     `json:"required"`
	Dictionary *taskConfigDictionaryDTO `json:"dictionary,omitempty"`
	FieldRole  *string                  `json:"field_role,omitempty"`
}

type taskConfigDictionaryDTO struct {
	ID             uuid.UUID `json:"id"`
	Code           string    `json:"code"`
	CurrentVersion int       `json:"current_version"`
}

type taskConfigStatusDTO struct {
	ID        uuid.UUID `json:"id"`
	Code      string    `json:"code"`
	Name      string    `json:"name"`
	SortOrder int       `json:"sort_order"`
}

func (h *Handler) tasksConfig(w http.ResponseWriter, r *http.Request, _ auth.Principal) {
	if r.Method != http.MethodGet {
		h.methodNotAllowed(w)
		return
	}

	templates, err := h.svc.tasksSvc.ListTemplates(r.Context(), false)
	if err != nil {
		h.internalError(w, "tasks config templates", err)
		return
	}
	statuses, err := h.svc.tasksSvc.ListStatuses(r.Context(), false)
	if err != nil {
		h.internalError(w, "tasks config statuses", err)
		return
	}
	dictionaries, err := h.svc.tasksSvc.ListDictionaries(r.Context())
	if err != nil {
		h.internalError(w, "tasks config dictionaries", err)
		return
	}
	dictionaryByID := make(map[uuid.UUID]taskConfigDictionaryDTO, len(dictionaries))
	for _, dictionary := range dictionaries {
		dictionaryByID[dictionary.ID] = taskConfigDictionaryDTO{
			ID: dictionary.ID, Code: dictionary.Code, CurrentVersion: dictionary.CurrentVersion,
		}
	}

	out := tasksConfigResponse{
		Templates: make([]taskConfigTemplateDTO, 0, len(templates)),
		Statuses:  make([]taskConfigStatusDTO, 0, len(statuses)),
	}
	for _, template := range templates {
		fields, err := h.svc.tasksSvc.ListFields(r.Context(), template.ID, false)
		if err != nil {
			h.internalError(w, "tasks config fields", err)
			return
		}
		item := taskConfigTemplateDTO{
			ID: template.ID, Prefix: template.Prefix, Fields: make([]taskConfigFieldDTO, 0, len(fields)),
		}
		for _, field := range fields {
			fieldDTO := taskConfigFieldDTO{
				ID: field.ID, Code: field.Code, Name: field.Name, Type: field.Type,
				Required: field.Required, FieldRole: field.FieldRole,
			}
			if field.Type == "enum" || field.Type == "multi_enum" {
				if field.EnumDictionaryID == nil {
					h.internalError(w, "tasks config dictionary", fmt.Errorf("enum field %s has no dictionary", field.ID))
					return
				}
				dictionary, ok := dictionaryByID[*field.EnumDictionaryID]
				if !ok {
					h.internalError(w, "tasks config dictionary", fmt.Errorf("enum dictionary %s not found", *field.EnumDictionaryID))
					return
				}
				fieldDTO.Dictionary = &dictionary
			}
			item.Fields = append(item.Fields, fieldDTO)
		}
		out.Templates = append(out.Templates, item)
	}
	for _, status := range statuses {
		out.Statuses = append(out.Statuses, taskConfigStatusDTO{
			ID: status.ID, Code: status.Code, Name: status.Name, SortOrder: status.SortOrder,
		})
	}
	httputil.WriteJSON(w, http.StatusOK, out)
}
