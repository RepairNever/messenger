package botapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"

	"msgnr/internal/auth"
	"msgnr/internal/httputil"
)

type taskFieldWrite struct {
	Code  string
	Value json.RawMessage
}

type taskWriteRequest struct {
	Template       string
	Title          *string
	Description    json.RawMessage
	ParentPublicID *string
	Status         *string
	FieldValues    []taskFieldWrite
}

var errInvalidTaskBody = errors.New("invalid request body")

// Validate raw object keys before decoding typed values: Go's struct decoder
// otherwise accepts differently cased keys and cannot distinguish omitted values.
func decodeTaskWrite(body io.Reader, update bool) (taskWriteRequest, error) {
	var req taskWriteRequest
	dec := json.NewDecoder(body)
	var raw json.RawMessage
	if err := dec.Decode(&raw); err != nil {
		return req, errInvalidTaskBody
	}
	var extra json.RawMessage
	if err := dec.Decode(&extra); err != io.EOF {
		return req, errInvalidTaskBody
	}
	obj, err := taskWriteObject(raw)
	if err != nil {
		return req, err
	}
	for _, key := range sortedTaskWriteKeys(obj) {
		switch key {
		case "template", "parent_public_id", "public_id":
			if update {
				return req, fmt.Errorf("bad request: %s is not updatable", key)
			}
			if key == "public_id" {
				return req, fmt.Errorf("bad request: unknown key %s", key)
			}
		case "title", "description", "status", "field_values":
		default:
			return req, fmt.Errorf("bad request: unknown key %s", key)
		}
	}
	for key, dest := range map[string]any{
		"template": &req.Template, "title": &req.Title,
		"parent_public_id": &req.ParentPublicID, "status": &req.Status,
	} {
		if value, ok := obj[key]; ok {
			if err := json.Unmarshal(value, dest); err != nil {
				return req, errInvalidTaskBody
			}
		}
	}
	if value, ok := obj["description"]; ok {
		var description *string
		if err := json.Unmarshal(value, &description); err != nil {
			return req, errInvalidTaskBody
		}
		req.Description = value
	}
	if value, ok := obj["field_values"]; ok {
		var entries []json.RawMessage
		if err := json.Unmarshal(value, &entries); err != nil {
			return req, errInvalidTaskBody
		}
		for _, entry := range entries {
			field, err := taskWriteObject(entry)
			if err != nil {
				return req, err
			}
			for _, key := range sortedTaskWriteKeys(field) {
				if key != "code" && key != "value" {
					return req, fmt.Errorf("bad request: unknown key %s", key)
				}
			}
			var code string
			if value, ok := field["code"]; ok {
				if err := json.Unmarshal(value, &code); err != nil {
					return req, errInvalidTaskBody
				}
			}
			value, ok := field["value"]
			if !ok {
				return req, fmt.Errorf("bad request: value is required for field %q", code)
			}
			req.FieldValues = append(req.FieldValues, taskFieldWrite{Code: code, Value: value})
		}
	}
	return req, nil
}

func taskWriteObject(raw json.RawMessage) (map[string]json.RawMessage, error) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil || obj == nil {
		return nil, errInvalidTaskBody
	}
	return obj, nil
}

func sortedTaskWriteKeys(obj map[string]json.RawMessage) []string {
	keys := make([]string, 0, len(obj))
	for key := range obj {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func (h *Handler) tasksCollection(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	if r.Method != http.MethodPost {
		h.methodNotAllowed(w)
		return
	}
	req, err := decodeTaskWrite(r.Body, false)
	if err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody(err.Error()))
		return
	}
	task, err := h.svc.createBotTask(r.Context(), p.UserID, req)
	if err != nil {
		h.taskServiceError(w, err)
		return
	}
	httputil.WriteJSON(w, http.StatusCreated, task)
}

func (h *Handler) taskUpdate(w http.ResponseWriter, r *http.Request, p auth.Principal, publicID string) {
	req, err := decodeTaskWrite(r.Body, true)
	if err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody(err.Error()))
		return
	}
	task, err := h.svc.updateBotTask(r.Context(), p.UserID, publicID, req)
	if err != nil {
		h.taskServiceError(w, err)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, task)
}
