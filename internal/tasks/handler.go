package tasks

import (
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"msgnr/internal/auth"
)

// Handler exposes task-tracker admin REST endpoints.
// All routes require admin or owner role.
type Handler struct {
	svc                      *Service
	authSvc                  *auth.Service
	statusChangeNotifier     TaskStatusChangeNotifier
	log                      *zap.Logger
	maxAttachSizeMB          int // maximum allowed attachment file size in megabytes
	groupPortionDefaultLimit int
	groupPortionMaxLimit     int
}

const maxTaskAttachmentBatchFiles = 50

// TaskStatusChangeNotifier broadcasts task status transitions to live clients.
type TaskStatusChangeNotifier interface {
	SendTaskStatusChanged(taskID, publicID, fromStatusID, toStatusID, updatedBy string, updatedAt time.Time)
}

func NewHandler(
	svc *Service,
	authSvc *auth.Service,
	log *zap.Logger,
	maxAttachSizeMB int,
	groupPortionDefaultLimit int,
	groupPortionMaxLimit int,
) *Handler {
	if maxAttachSizeMB <= 0 {
		maxAttachSizeMB = 50
	}
	if groupPortionDefaultLimit <= 0 {
		groupPortionDefaultLimit = 50
	}
	if groupPortionMaxLimit <= 0 {
		groupPortionMaxLimit = 200
	}
	if groupPortionDefaultLimit > groupPortionMaxLimit {
		groupPortionDefaultLimit = groupPortionMaxLimit
	}
	return &Handler{
		svc:                      svc,
		authSvc:                  authSvc,
		log:                      log,
		maxAttachSizeMB:          maxAttachSizeMB,
		groupPortionDefaultLimit: groupPortionDefaultLimit,
		groupPortionMaxLimit:     groupPortionMaxLimit,
	}
}

func (h *Handler) SetStatusChangeNotifier(notifier TaskStatusChangeNotifier) {
	h.statusChangeNotifier = notifier
}

// RegisterRoutes mounts all task-tracker routes on mux.
func (h *Handler) RegisterRoutes(mux *http.ServeMux) {
	// Templates (collection + reorder must come before the trailing-slash wildcard)
	mux.HandleFunc("/api/admin/task-templates", h.adminOnly(h.templates))
	mux.HandleFunc("/api/admin/task-templates/reorder", h.adminOnly(h.templatesReorder))
	// All item-level template routes (GET/PATCH/DELETE :id, plus /fields sub-routes)
	mux.HandleFunc("/api/admin/task-templates/", h.adminOnly(h.templatesRouter))

	// Statuses
	mux.HandleFunc("/api/admin/task-statuses", h.adminOnly(h.statuses))
	mux.HandleFunc("/api/admin/task-statuses/reorder", h.adminOnly(h.statusesReorder))
	mux.HandleFunc("/api/admin/task-statuses/", h.adminOnly(h.statusesItem))

	// Enum dictionaries
	mux.HandleFunc("/api/admin/enums", h.adminOnly(h.enums))
	mux.HandleFunc("/api/admin/enums/", h.adminOnly(h.enumsItem))

	// Config endpoints — available to all authenticated users.
	// These mirror the admin GET routes so that non-admin users can load the
	// data they need to use the task tracker (templates, statuses, fields,
	// enum dictionary versions/items). Public dictionaries also allow member
	// item creation under /api/tasks/config/enums/:id/items.
	mux.HandleFunc("/api/tasks/config/templates", h.requireAuth(h.configTemplates))
	mux.HandleFunc("/api/tasks/config/templates/", h.requireAuth(h.configTemplatesRouter))
	mux.HandleFunc("/api/tasks/config/statuses", h.requireAuth(h.configStatuses))
	mux.HandleFunc("/api/tasks/config/enums", h.requireAuth(h.configEnums))
	mux.HandleFunc("/api/tasks/config/enums/", h.requireAuth(h.configEnumsItem))

	// Users — public listing for any authenticated user (used by task field inputs)
	mux.HandleFunc("/api/users", h.requireAuth(h.usersList))

	// Tasks (any authenticated user)
	mux.HandleFunc("/api/tasks", h.requireAuth(h.tasksCollection))
	mux.HandleFunc("/api/tasks/grouped", h.requireAuth(h.tasksGroupedCollection))
	mux.HandleFunc("/api/tasks/staged-attachments", h.requireAuth(h.taskStagedAttachments))
	mux.HandleFunc("/api/tasks/staged-attachments/", h.requireAuth(h.taskStagedAttachmentItem))
	mux.HandleFunc("/api/tasks/status/", h.requireAuth(h.tasksStatusRouter))
	mux.HandleFunc("/api/tasks/", h.requireAuth(h.tasksItem))
}

// authHandler is the unified signature for all handlers that receive an
// authenticated principal. Both requireAuth and adminOnly wrap this type so
// every handler accesses the principal the same way — via the p parameter —
// regardless of which middleware protected the route.
type authHandler func(w http.ResponseWriter, r *http.Request, p auth.Principal)

func markdownSignatureForLog(value *string) string {
	if value == nil {
		return "null"
	}
	raw := *value
	hasher := fnv.New32a()
	_, _ = hasher.Write([]byte(raw))
	preview := raw
	if len(preview) > 80 {
		preview = preview[:80]
	}
	preview = strings.ReplaceAll(preview, "\n", "\\n")
	return fmt.Sprintf("len=%d,hash=%d,preview=%q", len(raw), hasher.Sum32(), preview)
}

// =========================================================
// Templates
// =========================================================

// GET /api/admin/task-templates[?include_deleted=true]
// POST /api/admin/task-templates
func (h *Handler) templates(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	switch r.Method {
	case http.MethodGet:
		includeDeleted := r.URL.Query().Get("include_deleted") == "true"
		rows, err := h.svc.ListTemplates(r.Context(), includeDeleted)
		if err != nil {
			h.internalError(w, "list templates", err)
			return
		}
		writeJSON(w, http.StatusOK, rows)

	case http.MethodPost:
		var req struct {
			Prefix    string `json:"prefix"`
			SortOrder int    `json:"sort_order"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errBody("invalid request body"))
			return
		}
		row, err := h.svc.CreateTemplate(r.Context(), CreateTemplateParams{
			Prefix:    req.Prefix,
			SortOrder: req.SortOrder,
			ActorID:   p.UserID,
		})
		if err != nil {
			h.serviceError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, row)

	default:
		methodNotAllowed(w)
	}
}

// POST /api/admin/task-templates/reorder
func (h *Handler) templatesReorder(w http.ResponseWriter, r *http.Request, _ auth.Principal) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var req struct {
		IDs []uuid.UUID `json:"ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || len(req.IDs) == 0 {
		writeJSON(w, http.StatusBadRequest, errBody("ids array required"))
		return
	}
	if err := h.svc.ReorderTemplates(r.Context(), req.IDs); err != nil {
		h.serviceError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// templatesRouter dispatches all /api/admin/task-templates/:id[/...] paths.
// Path structure:
//
//	/api/admin/task-templates/:id                  → templatesItem
//	/api/admin/task-templates/:id/fields           → fields
//	/api/admin/task-templates/:id/fields/reorder   → fieldsReorder
//	/api/admin/task-templates/:id/fields/:field_id → fieldsItem
func (h *Handler) templatesRouter(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/admin/task-templates/")
	parts := strings.SplitN(rest, "/", 3) // [templateID, "fields", fieldID]

	templateID, err := uuid.Parse(parts[0])
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("invalid template id"))
		return
	}

	if len(parts) == 1 {
		h.templatesItem(w, r, p, templateID)
		return
	}
	if parts[1] != "fields" {
		writeJSON(w, http.StatusNotFound, errBody("not found"))
		return
	}
	if len(parts) == 2 {
		h.fields(w, r, templateID)
		return
	}
	if parts[2] == "reorder" {
		h.fieldsReorder(w, r, templateID)
		return
	}
	fieldID, err := uuid.Parse(parts[2])
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("invalid field id"))
		return
	}
	h.fieldsItem(w, r, templateID, fieldID)
}

// GET /api/admin/task-templates/:id
// PATCH /api/admin/task-templates/:id
// DELETE /api/admin/task-templates/:id
func (h *Handler) templatesItem(w http.ResponseWriter, r *http.Request, p auth.Principal, id uuid.UUID) {
	switch r.Method {
	case http.MethodGet:
		row, err := h.svc.GetTemplate(r.Context(), id)
		if err != nil {
			h.serviceError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, row)

	case http.MethodPatch:
		var req struct {
			Prefix    string `json:"prefix"`
			SortOrder *int   `json:"sort_order"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errBody("invalid request body"))
			return
		}
		row, err := h.svc.UpdateTemplate(r.Context(), id, UpdateTemplateParams{
			Prefix:    req.Prefix,
			SortOrder: req.SortOrder,
			ActorID:   p.UserID,
		})
		if err != nil {
			h.serviceError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, row)

	case http.MethodDelete:
		row, err := h.svc.SoftDeleteTemplate(r.Context(), id, p.UserID)
		if err != nil {
			h.serviceError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, row)

	default:
		methodNotAllowed(w)
	}
}

// =========================================================
// Field definitions
// =========================================================

// GET /api/admin/task-templates/:id/fields[?include_deleted=true]
// POST /api/admin/task-templates/:id/fields
func (h *Handler) fields(w http.ResponseWriter, r *http.Request, templateID uuid.UUID) {
	switch r.Method {
	case http.MethodGet:
		includeDeleted := r.URL.Query().Get("include_deleted") == "true"
		rows, err := h.svc.ListFields(r.Context(), templateID, includeDeleted)
		if err != nil {
			h.internalError(w, "list fields", err)
			return
		}
		writeJSON(w, http.StatusOK, rows)

	case http.MethodPost:
		var req struct {
			Code             string     `json:"code"`
			Name             string     `json:"name"`
			Type             string     `json:"type"`
			Required         bool       `json:"required"`
			SortOrder        int        `json:"sort_order"`
			EnumDictionaryID *uuid.UUID `json:"enum_dictionary_id"`
			FieldRole        *string    `json:"field_role"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errBody("invalid request body"))
			return
		}
		row, err := h.svc.CreateField(r.Context(), CreateFieldParams{
			TemplateID:       templateID,
			Code:             req.Code,
			Name:             req.Name,
			Type:             req.Type,
			Required:         req.Required,
			SortOrder:        req.SortOrder,
			EnumDictionaryID: req.EnumDictionaryID,
			FieldRole:        req.FieldRole,
		})
		if err != nil {
			h.serviceError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, row)

	default:
		methodNotAllowed(w)
	}
}

// POST /api/admin/task-templates/:id/fields/reorder
func (h *Handler) fieldsReorder(w http.ResponseWriter, r *http.Request, templateID uuid.UUID) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var req struct {
		IDs []uuid.UUID `json:"ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || len(req.IDs) == 0 {
		writeJSON(w, http.StatusBadRequest, errBody("ids array required"))
		return
	}
	if err := h.svc.ReorderFields(r.Context(), templateID, req.IDs); err != nil {
		h.serviceError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// GET /api/admin/task-templates/:id/fields/:field_id
// PATCH /api/admin/task-templates/:id/fields/:field_id
// DELETE /api/admin/task-templates/:id/fields/:field_id
func (h *Handler) fieldsItem(w http.ResponseWriter, r *http.Request, templateID, fieldID uuid.UUID) {
	switch r.Method {
	case http.MethodGet:
		row, err := h.svc.GetField(r.Context(), templateID, fieldID)
		if err != nil {
			h.serviceError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, row)

	case http.MethodPatch:
		var req struct {
			Name     string `json:"name"`
			Required bool   `json:"required"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errBody("invalid request body"))
			return
		}
		row, err := h.svc.UpdateField(r.Context(), templateID, fieldID, UpdateFieldParams{
			Name:     req.Name,
			Required: req.Required,
		})
		if err != nil {
			h.serviceError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, row)

	case http.MethodDelete:
		row, err := h.svc.SoftDeleteField(r.Context(), templateID, fieldID)
		if err != nil {
			h.serviceError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, row)

	default:
		methodNotAllowed(w)
	}
}

// =========================================================
// Statuses
// =========================================================

// GET /api/admin/task-statuses[?include_deleted=true]
// POST /api/admin/task-statuses
func (h *Handler) statuses(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	switch r.Method {
	case http.MethodGet:
		includeDeleted := r.URL.Query().Get("include_deleted") == "true"
		rows, err := h.svc.ListStatuses(r.Context(), includeDeleted)
		if err != nil {
			h.internalError(w, "list statuses", err)
			return
		}
		writeJSON(w, http.StatusOK, rows)

	case http.MethodPost:
		var req struct {
			Code      string `json:"code"`
			Name      string `json:"name"`
			SortOrder int    `json:"sort_order"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errBody("invalid request body"))
			return
		}
		row, err := h.svc.CreateStatus(r.Context(), CreateStatusParams{
			Code:      req.Code,
			Name:      req.Name,
			SortOrder: req.SortOrder,
			ActorID:   p.UserID,
		})
		if err != nil {
			h.serviceError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, row)

	default:
		methodNotAllowed(w)
	}
}

// POST /api/admin/task-statuses/reorder
func (h *Handler) statusesReorder(w http.ResponseWriter, r *http.Request, _ auth.Principal) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var req struct {
		IDs []uuid.UUID `json:"ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || len(req.IDs) == 0 {
		writeJSON(w, http.StatusBadRequest, errBody("ids array required"))
		return
	}
	if err := h.svc.ReorderStatuses(r.Context(), req.IDs); err != nil {
		h.serviceError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// GET /api/admin/task-statuses/:id
// PATCH /api/admin/task-statuses/:id
// DELETE /api/admin/task-statuses/:id
func (h *Handler) statusesItem(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	id, ok := parseUUID(w, r, "/api/admin/task-statuses/")
	if !ok {
		return
	}
	switch r.Method {
	case http.MethodGet:
		row, err := h.svc.GetStatus(r.Context(), id)
		if err != nil {
			h.serviceError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, row)

	case http.MethodPatch:
		var req struct {
			Code string `json:"code"`
			Name string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errBody("invalid request body"))
			return
		}
		row, err := h.svc.UpdateStatus(r.Context(), id, UpdateStatusParams{
			Code:    req.Code,
			Name:    req.Name,
			ActorID: p.UserID,
		})
		if err != nil {
			h.serviceError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, row)

	case http.MethodDelete:
		row, err := h.svc.SoftDeleteStatus(r.Context(), id)
		if err != nil {
			h.serviceError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, row)

	default:
		methodNotAllowed(w)
	}
}

// =========================================================
// Enum dictionaries
// =========================================================

// GET /api/admin/enums
// POST /api/admin/enums
func (h *Handler) enums(w http.ResponseWriter, r *http.Request, _ auth.Principal) {
	switch r.Method {
	case http.MethodGet:
		rows, err := h.svc.ListDictionaries(r.Context())
		if err != nil {
			h.internalError(w, "list dictionaries", err)
			return
		}
		writeJSON(w, http.StatusOK, rows)

	case http.MethodPost:
		var req struct {
			Code                     string `json:"code"`
			Name                     string `json:"name"`
			IsPublic                 bool   `json:"is_public"`
			ParticipatesInFiltration bool   `json:"participates_in_filtration"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errBody("invalid request body"))
			return
		}
		row, err := h.svc.CreateDictionary(r.Context(), CreateDictionaryParams{
			Code:                     req.Code,
			Name:                     req.Name,
			IsPublic:                 req.IsPublic,
			ParticipatesInFiltration: req.ParticipatesInFiltration,
		})
		if err != nil {
			h.serviceError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, row)

	default:
		methodNotAllowed(w)
	}
}

// Routes under /api/admin/enums/:id[/versions[/:vid]]
func (h *Handler) enumsItem(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	// Trim prefix and split remaining path segments.
	rest := strings.TrimPrefix(r.URL.Path, "/api/admin/enums/")
	parts := strings.SplitN(rest, "/", 3)

	dictID, err := uuid.Parse(parts[0])
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("invalid dictionary id"))
		return
	}

	// /api/admin/enums/:id
	if len(parts) == 1 {
		h.enumItem(w, r, dictID)
		return
	}

	if parts[1] != "versions" {
		writeJSON(w, http.StatusNotFound, errBody("not found"))
		return
	}

	// /api/admin/enums/:id/versions
	if len(parts) == 2 {
		h.enumVersions(w, r, p, dictID)
		return
	}

	// /api/admin/enums/:id/versions/:vid
	versionID, err := uuid.Parse(parts[2])
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("invalid version id"))
		return
	}
	h.enumVersionItems(w, r, versionID)
}

// GET /api/admin/enums/:id
// PATCH /api/admin/enums/:id
func (h *Handler) enumItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	switch r.Method {
	case http.MethodGet:
		row, err := h.svc.GetDictionary(r.Context(), id)
		if err != nil {
			h.serviceError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, row)

	case http.MethodPatch:
		var req struct {
			IsPublic                 bool `json:"is_public"`
			ParticipatesInFiltration bool `json:"participates_in_filtration"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errBody("invalid request body"))
			return
		}
		row, err := h.svc.UpdateDictionarySettings(r.Context(), id, req.IsPublic, req.ParticipatesInFiltration)
		if err != nil {
			h.serviceError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, row)

	default:
		methodNotAllowed(w)
	}
}

// GET /api/admin/enums/:id/versions
// POST /api/admin/enums/:id/versions  (save items; may reuse latest version)
func (h *Handler) enumVersions(w http.ResponseWriter, r *http.Request, p auth.Principal, dictID uuid.UUID) {
	switch r.Method {
	case http.MethodGet:
		rows, err := h.svc.ListDictionaryVersions(r.Context(), dictID)
		if err != nil {
			h.serviceError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, rows)

	case http.MethodPost:
		var req struct {
			Items []DictionaryItemInput `json:"items"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errBody("invalid request body"))
			return
		}
		ver, err := h.svc.CreateDictionaryVersion(r.Context(), dictID, req.Items, p.UserID)
		if err != nil {
			h.serviceError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, ver)

	default:
		methodNotAllowed(w)
	}
}

// GET /api/admin/enums/:id/versions/:vid
func (h *Handler) enumVersionItems(w http.ResponseWriter, r *http.Request, versionID uuid.UUID) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	search := strings.TrimSpace(r.URL.Query().Get("search"))
	limit := queryIntNonNegative(r.URL.Query().Get("limit"), 0)
	items, err := h.svc.GetDictionaryVersionItems(r.Context(), versionID, search, limit, nil)
	if err != nil {
		h.serviceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, items)
}

// =========================================================
// Users (public, non-admin)
// =========================================================

// GET /api/users
func (h *Handler) usersList(w http.ResponseWriter, r *http.Request, _ auth.Principal) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	rows, err := h.svc.ListUsers(r.Context())
	if err != nil {
		h.internalError(w, "list users", err)
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

// =========================================================
// Tasks (Phase 3)
// =========================================================

// GET /api/tasks  — list with search / filter / sort / grouping
// POST /api/tasks — create
func (h *Handler) tasksCollection(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	switch r.Method {
	case http.MethodGet:
		params, err := parseListTasksParams(r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errBody(err.Error()))
			return
		}
		resp, err := h.svc.ListTasks(r.Context(), params)
		if err != nil {
			h.internalError(w, "list tasks", err)
			return
		}
		writeJSON(w, http.StatusOK, resp)

	case http.MethodPost:
		var req struct {
			TemplateID          uuid.UUID         `json:"template_id"`
			Title               string            `json:"title"`
			Description         *string           `json:"description"`
			StatusID            uuid.UUID         `json:"status_id"`
			FieldValues         []FieldValueInput `json:"field_values"`
			StagedAttachmentIDs []uuid.UUID       `json:"staged_attachment_ids"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errBody("invalid request body"))
			return
		}
		resp, err := h.svc.CreateTask(r.Context(), CreateTaskParams{
			TemplateID:          req.TemplateID,
			Title:               req.Title,
			Description:         req.Description,
			StatusID:            req.StatusID,
			FieldValues:         req.FieldValues,
			StagedAttachmentIDs: req.StagedAttachmentIDs,
			ActorID:             p.UserID,
		})
		if err != nil {
			h.serviceError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, resp)

	default:
		methodNotAllowed(w)
	}
}

// GET /api/tasks/grouped — grouped-by-status initial payload
func (h *Handler) tasksGroupedCollection(w http.ResponseWriter, r *http.Request, _ auth.Principal) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	params, err := parseTaskFilterParams(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errBody(err.Error()))
		return
	}
	limit := clampInt(
		queryInt(r.URL.Query().Get("limit"), h.groupPortionDefaultLimit),
		1,
		h.groupPortionMaxLimit,
	)
	resp, err := h.svc.ListTasksGrouped(r.Context(), params, limit)
	if err != nil {
		h.internalError(w, "list grouped tasks", err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// GET /api/tasks/status/:id/portion — grouped-by-status incremental page
func (h *Handler) tasksStatusRouter(w http.ResponseWriter, r *http.Request, _ auth.Principal) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}

	rest := strings.TrimPrefix(r.URL.Path, "/api/tasks/status/")
	statusRaw, after, ok := strings.Cut(rest, "/")
	if !ok || statusRaw == "" {
		writeJSON(w, http.StatusBadRequest, errBody("invalid status id"))
		return
	}
	if after != "portion" {
		writeJSON(w, http.StatusNotFound, errBody("not found"))
		return
	}
	statusID, err := uuid.Parse(statusRaw)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("invalid status id"))
		return
	}

	params, err := parseTaskFilterParams(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errBody(err.Error()))
		return
	}
	offset := queryIntNonNegative(r.URL.Query().Get("offset"), 0)
	limit := clampInt(
		queryInt(r.URL.Query().Get("limit"), h.groupPortionDefaultLimit),
		1,
		h.groupPortionMaxLimit,
	)
	resp, err := h.svc.ListTasksStatusPortion(r.Context(), params, statusID, offset, limit)
	if err != nil {
		h.internalError(w, "list grouped status portion", err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// GET /api/tasks/:id
// PATCH /api/tasks/:id
// PATCH /api/tasks/:id/title
// GET /api/tasks/:id/history
// GET /api/tasks/:id/description/history
// PATCH /api/tasks/:id/description
// PATCH /api/tasks/:id/status
// PATCH /api/tasks/:id/fields/:field_id
// POST /api/tasks/:id/subtasks
// GET|POST /api/tasks/:id/attachments
// DELETE /api/tasks/:id/attachments/:aid
// GET /api/tasks/:id/attachments/:aid/download
// GET|POST /api/tasks/:id/comments
// POST /api/tasks/:id/comments/attachments
// DELETE /api/tasks/:id/comments/attachments/:aid
// GET /api/tasks/:id/comments/:comment_id/attachments/:aid/download
func (h *Handler) tasksItem(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	// Strip the /api/tasks/ prefix to get the remainder of the path.
	rest := strings.TrimPrefix(r.URL.Path, "/api/tasks/")

	// Route /api/tasks/:id/subtasks
	if rawID, ok := strings.CutSuffix(rest, "/subtasks"); ok {
		id, err := uuid.Parse(rawID)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errBody("invalid id"))
			return
		}
		h.subtasksCollection(w, r, p, id)
		return
	}

	// Route /api/tasks/:id/status
	if rawID, ok := strings.CutSuffix(rest, "/status"); ok {
		id, err := uuid.Parse(rawID)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errBody("invalid id"))
			return
		}
		h.taskStatusItem(w, r, p, id)
		return
	}

	// Route /api/tasks/:id/title
	if rawID, ok := strings.CutSuffix(rest, "/title"); ok {
		id, err := uuid.Parse(rawID)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errBody("invalid id"))
			return
		}
		h.taskTitleItem(w, r, p, id)
		return
	}

	// Route /api/tasks/:id/description/history
	if rawID, ok := strings.CutSuffix(rest, "/description/history"); ok {
		id, err := uuid.Parse(rawID)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errBody("invalid id"))
			return
		}
		h.taskDescriptionHistoryItem(w, r, p, id)
		return
	}

	// Route /api/tasks/:id/history
	if rawID, ok := strings.CutSuffix(rest, "/history"); ok {
		id, err := uuid.Parse(rawID)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errBody("invalid id"))
			return
		}
		h.taskChangeHistoryItem(w, r, p, id)
		return
	}

	// Route /api/tasks/:id/description
	if rawID, ok := strings.CutSuffix(rest, "/description"); ok {
		id, err := uuid.Parse(rawID)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errBody("invalid id"))
			return
		}
		h.taskDescriptionItem(w, r, p, id)
		return
	}

	// Route /api/tasks/:id/fields/:field_id
	if len(rest) > 36 && rest[36] == '/' {
		if fieldIDRaw, ok := strings.CutPrefix(rest[36:], "/fields/"); ok {
			if strings.Contains(fieldIDRaw, "/") || fieldIDRaw == "" {
				writeJSON(w, http.StatusNotFound, errBody("not found"))
				return
			}
			taskID, err := uuid.Parse(rest[:36])
			if err != nil {
				writeJSON(w, http.StatusBadRequest, errBody("invalid id"))
				return
			}
			fieldID, err := uuid.Parse(fieldIDRaw)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, errBody("invalid field id"))
				return
			}
			h.taskFieldItem(w, r, p, taskID, fieldID)
			return
		}
	}

	// Route /api/tasks/:id/comments[/...]
	// Route /api/tasks/:id/attachments[/...]
	// A UUID is exactly 36 characters. We only match if the path segment after
	// the UUID is exactly "/comments" or "/attachments" (or nested paths), so
	// we never accidentally match a UUID that contains these substrings.
	if len(rest) > 36 && rest[36] == '/' {
		if after, ok := strings.CutPrefix(rest[36:], "/comments"); ok {
			taskID, err := uuid.Parse(rest[:36])
			if err != nil {
				writeJSON(w, http.StatusBadRequest, errBody("invalid id"))
				return
			}
			h.taskCommentsRouter(w, r, p, taskID, after)
			return
		}
		if after, ok := strings.CutPrefix(rest[36:], "/attachments"); ok {
			taskID, err := uuid.Parse(rest[:36])
			if err != nil {
				writeJSON(w, http.StatusBadRequest, errBody("invalid id"))
				return
			}
			h.taskAttachmentsRouter(w, r, p, taskID, after)
			return
		}
	}

	switch r.Method {
	case http.MethodGet:
		if id, err := uuid.Parse(rest); err == nil {
			resp, err := h.svc.GetTask(r.Context(), id)
			if err != nil {
				h.serviceError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, resp)
			return
		}
		if strings.Contains(rest, "/") || strings.TrimSpace(rest) == "" {
			writeJSON(w, http.StatusBadRequest, errBody("invalid id"))
			return
		}
		resp, err := h.svc.GetTaskByPublicID(r.Context(), rest)
		if err != nil {
			h.serviceError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, resp)

	case http.MethodPatch:
		id, err := uuid.Parse(rest)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errBody("invalid id"))
			return
		}
		var req struct {
			Title       string            `json:"title"`
			Description *string           `json:"description"`
			StatusID    uuid.UUID         `json:"status_id"`
			FieldValues []FieldValueInput `json:"field_values"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errBody("invalid request body"))
			return
		}
		resp, err := h.svc.UpdateTask(r.Context(), id, UpdateTaskParams{
			Title:       req.Title,
			Description: req.Description,
			StatusID:    req.StatusID,
			FieldValues: req.FieldValues,
			ActorID:     p.UserID,
		})
		if err != nil {
			h.serviceError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, resp)

	default:
		methodNotAllowed(w)
	}
}

// PATCH /api/tasks/:id/title
func (h *Handler) taskTitleItem(w http.ResponseWriter, r *http.Request, p auth.Principal, id uuid.UUID) {
	if r.Method != http.MethodPatch {
		methodNotAllowed(w)
		return
	}

	var req struct {
		Title             string `json:"title"`
		IfUnmodifiedSince string `json:"if_unmodified_since"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("invalid request body"))
		return
	}

	lockToken := strings.TrimSpace(req.IfUnmodifiedSince)
	if lockToken == "" {
		lockToken = strings.TrimSpace(r.Header.Get("If-Unmodified-Since"))
	}
	if lockToken == "" {
		writeJSON(w, http.StatusBadRequest, errBody("if_unmodified_since is required"))
		return
	}
	ifUnmodifiedSince, err := parseRFC3339Timestamp(lockToken)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("invalid if_unmodified_since"))
		return
	}

	resp, err := h.svc.UpdateTaskTitle(r.Context(), id, UpdateTaskTitleParams{
		Title:             req.Title,
		IfUnmodifiedSince: ifUnmodifiedSince,
		ActorID:           p.UserID,
	})
	if err != nil {
		h.serviceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// GET /api/tasks/:id/description/history
func (h *Handler) taskDescriptionHistoryItem(w http.ResponseWriter, r *http.Request, _ auth.Principal, id uuid.UUID) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	resp, err := h.svc.ListTaskDescriptionHistory(r.Context(), id)
	if err != nil {
		h.serviceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// GET /api/tasks/:id/history
func (h *Handler) taskChangeHistoryItem(w http.ResponseWriter, r *http.Request, _ auth.Principal, id uuid.UUID) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	limit := clampInt(queryInt(r.URL.Query().Get("limit"), 50), 1, 100)
	resp, err := h.svc.ListTaskChangeHistory(r.Context(), id, r.URL.Query().Get("cursor"), limit)
	if err != nil {
		h.serviceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// PATCH /api/tasks/:id/description
func (h *Handler) taskDescriptionItem(w http.ResponseWriter, r *http.Request, p auth.Principal, id uuid.UUID) {
	if r.Method != http.MethodPatch {
		methodNotAllowed(w)
		return
	}

	var req struct {
		Description   *string `json:"description"`
		ForceSnapshot bool    `json:"force_snapshot"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("invalid request body"))
		return
	}
	h.log.Info("tasks: description patch request",
		zap.String("task_id", id.String()),
		zap.String("user_id", p.UserID.String()),
		zap.String("description_sig", markdownSignatureForLog(req.Description)),
		zap.Bool("force_snapshot", req.ForceSnapshot),
	)

	resp, err := h.svc.UpdateTaskDescription(r.Context(), id, UpdateTaskDescriptionParams{
		Description:   req.Description,
		ActorID:       p.UserID,
		ForceSnapshot: req.ForceSnapshot,
	})
	if err != nil {
		h.serviceError(w, err)
		return
	}
	h.log.Info("tasks: description patch response",
		zap.String("task_id", id.String()),
		zap.String("user_id", p.UserID.String()),
		zap.String("description_sig", markdownSignatureForLog(resp.TaskRow.Description)),
		zap.String("updated_at", resp.TaskRow.UpdatedAt.UTC().Format(time.RFC3339Nano)),
	)
	writeJSON(w, http.StatusOK, resp)
}

// PATCH /api/tasks/:id/status
func (h *Handler) taskStatusItem(w http.ResponseWriter, r *http.Request, p auth.Principal, id uuid.UUID) {
	if r.Method != http.MethodPatch {
		methodNotAllowed(w)
		return
	}

	var req struct {
		StatusID uuid.UUID `json:"status_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("invalid request body"))
		return
	}

	resp, previousStatusID, err := h.svc.UpdateTaskStatus(r.Context(), id, UpdateTaskStatusParams{
		StatusID: req.StatusID,
		ActorID:  p.UserID,
	})
	if err != nil {
		h.serviceError(w, err)
		return
	}

	if h.statusChangeNotifier != nil && previousStatusID != resp.StatusID {
		h.statusChangeNotifier.SendTaskStatusChanged(
			resp.ID.String(),
			resp.PublicID,
			previousStatusID.String(),
			resp.StatusID.String(),
			p.UserID.String(),
			resp.UpdatedAt,
		)
	}
	writeJSON(w, http.StatusOK, resp)
}

// PATCH /api/tasks/:id/fields/:field_id
func (h *Handler) taskFieldItem(w http.ResponseWriter, r *http.Request, p auth.Principal, taskID, fieldID uuid.UUID) {
	if r.Method != http.MethodPatch {
		methodNotAllowed(w)
		return
	}

	var req struct {
		ValueText        *string         `json:"value_text"`
		ValueNumber      *string         `json:"value_number"`
		ValueUserID      *uuid.UUID      `json:"value_user_id"`
		ValueDate        *string         `json:"value_date"`
		ValueDatetime    *time.Time      `json:"value_datetime"`
		ValueJSON        json.RawMessage `json:"value_json"`
		EnumDictionaryID *uuid.UUID      `json:"enum_dictionary_id"`
		EnumVersion      *int32          `json:"enum_version"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("invalid request body"))
		return
	}

	resp, err := h.svc.UpdateTaskFieldValue(r.Context(), taskID, fieldID, UpdateTaskFieldValueParams{
		ValueText:        req.ValueText,
		ValueNumber:      req.ValueNumber,
		ValueUserID:      req.ValueUserID,
		ValueDate:        req.ValueDate,
		ValueDatetime:    req.ValueDatetime,
		ValueJSON:        req.ValueJSON,
		EnumDictionaryID: req.EnumDictionaryID,
		EnumVersion:      req.EnumVersion,
		ActorID:          p.UserID,
	})
	if err != nil {
		h.serviceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// POST /api/tasks/:id/subtasks
func (h *Handler) subtasksCollection(w http.ResponseWriter, r *http.Request, p auth.Principal, parentID uuid.UUID) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var req struct {
		TemplateID  uuid.UUID         `json:"template_id"`
		Title       string            `json:"title"`
		Description *string           `json:"description"`
		StatusID    uuid.UUID         `json:"status_id"`
		FieldValues []FieldValueInput `json:"field_values"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("invalid request body"))
		return
	}
	resp, err := h.svc.CreateTask(r.Context(), CreateTaskParams{
		TemplateID:   req.TemplateID,
		ParentTaskID: &parentID,
		Title:        req.Title,
		Description:  req.Description,
		StatusID:     req.StatusID,
		FieldValues:  req.FieldValues,
		ActorID:      p.UserID,
	})
	if err != nil {
		h.serviceError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, resp)
}

// =========================================================
// Attachments (Phase 6)
// =========================================================

// taskAttachmentsRouter dispatches attachment sub-routes for a given task.
//
//	suffix == ""                 → GET (list) or POST (single upload)
//	suffix == "/batch"           → POST (grouped upload)
//	suffix == "/:aid"            → DELETE
//	suffix == "/:aid/download" → GET (proxy download)
func (h *Handler) taskAttachmentsRouter(w http.ResponseWriter, r *http.Request, p auth.Principal, taskID uuid.UUID, suffix string) {
	// Strip leading slash.
	suffix = strings.TrimPrefix(suffix, "/")

	if suffix == "" {
		// GET /api/tasks/:id/attachments
		// POST /api/tasks/:id/attachments
		switch r.Method {
		case http.MethodGet:
			rows, err := h.svc.ListAttachments(r.Context(), taskID)
			if err != nil {
				h.serviceError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, rows)

		case http.MethodPost:
			h.taskAttachmentUpload(w, r, p, taskID)

		default:
			methodNotAllowed(w)
		}
		return
	}
	if suffix == "batch" {
		if r.Method != http.MethodPost {
			methodNotAllowed(w)
			return
		}
		h.taskAttachmentBatchUpload(w, r, p, taskID)
		return
	}

	// suffix is now "<attachmentID>" or "<attachmentID>/download"
	parts := strings.SplitN(suffix, "/", 2)
	attachID, err := uuid.Parse(parts[0])
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("invalid attachment id"))
		return
	}

	if len(parts) == 2 && parts[1] == "download" {
		// GET /api/tasks/:id/attachments/:aid/download
		if r.Method != http.MethodGet {
			methodNotAllowed(w)
			return
		}
		h.taskAttachmentDownload(w, r, taskID, attachID)
		return
	}

	// DELETE /api/tasks/:id/attachments/:aid
	if r.Method != http.MethodDelete {
		methodNotAllowed(w)
		return
	}
	if err := h.svc.DeleteAttachment(r.Context(), taskID, attachID, p.UserID); err != nil {
		h.serviceError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) taskStagedAttachments(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}

	file, header, mimeType, err := parseMultipartFilePart(r, h.maxAttachSizeMB)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errBody(err.Error()))
		return
	}
	defer file.Close()

	row, err := h.svc.UploadTaskStagedAttachment(r.Context(), UploadTaskStagedAttachmentParams{
		ActorID:  p.UserID,
		FileName: header.Filename,
		MimeType: mimeType,
		Size:     header.Size,
		Body:     file,
	}, h.maxAttachSizeMB)
	if err != nil {
		h.serviceError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, row)
}

func (h *Handler) taskStagedAttachmentItem(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/tasks/staged-attachments/")
	parts := strings.SplitN(rest, "/", 2)
	attachmentID, err := uuid.Parse(parts[0])
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("invalid attachment id"))
		return
	}

	if len(parts) == 2 && parts[1] == "download" {
		if r.Method != http.MethodGet {
			methodNotAllowed(w)
			return
		}
		h.taskStagedAttachmentDownload(w, r, p.UserID, attachmentID)
		return
	}

	if r.Method != http.MethodDelete {
		methodNotAllowed(w)
		return
	}
	if err := h.svc.DeleteTaskStagedAttachment(r.Context(), p.UserID, attachmentID); err != nil {
		h.serviceError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) taskStagedAttachmentDownload(w http.ResponseWriter, r *http.Request, actorID, attachmentID uuid.UUID) {
	body, size, mimeType, fileName, err := h.svc.DownloadTaskStagedAttachment(r.Context(), actorID, attachmentID)
	if err != nil {
		h.serviceError(w, err)
		return
	}
	defer body.Close()

	w.Header().Set("Content-Type", mimeType)
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	w.Header().Set("Content-Disposition", `attachment; filename="`+sanitiseHeaderValue(fileName)+`"`)
	w.WriteHeader(http.StatusOK)
	io.Copy(w, body) //nolint:errcheck
}

func parseMultipartFilePart(r *http.Request, maxAttachSizeMB int) (multipart.File, *multipart.FileHeader, string, error) {
	maxBytes := int64(maxAttachSizeMB) * 1024 * 1024
	formLimit := maxBytes + 2*1024*1024
	if err := r.ParseMultipartForm(formLimit); err != nil {
		return nil, nil, "", fmt.Errorf("failed to parse multipart form: %w", err)
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		return nil, nil, "", errors.New("missing 'file' field in form")
	}

	mimeType := header.Header.Get("Content-Type")
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	return file, header, mimeType, nil
}

// taskAttachmentUpload handles multipart file uploads.
//
// Size enforcement: header.Size is client-provided and cannot be trusted.
// Instead, we wrap the part reader in an io.LimitReader capped at maxBytes+1
// and count actual bytes streamed. If the count reaches maxBytes+1 the file is
// over the limit and we reject the request (deleting the orphaned object).
func (h *Handler) taskAttachmentUpload(w http.ResponseWriter, r *http.Request, p auth.Principal, taskID uuid.UUID) {
	maxBytes := int64(h.maxAttachSizeMB) * 1024 * 1024
	file, header, mimeType, err := parseMultipartFilePart(r, h.maxAttachSizeMB)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errBody(err.Error()))
		return
	}
	defer file.Close()

	// Wrap in a counting reader limited to maxBytes+1. If the full limit is
	// consumed we know the client sent more than maxBytes.
	cr := &countingReader{r: io.LimitReader(file, maxBytes+1)}

	row, err := h.svc.UploadAttachment(r.Context(), UploadAttachmentParams{
		TaskID:   taskID,
		ActorID:  p.UserID,
		FileName: header.Filename,
		MimeType: mimeType,
		// Size=-1 tells the service/Minio to use streaming mode; the real size
		// is filled in after the upload from the counting reader.
		Size: -1,
		Body: cr,
	}, h.maxAttachSizeMB, cr)
	if err != nil {
		h.serviceError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, row)
}

type multipartTaskAttachmentFile struct {
	file     multipart.File
	header   *multipart.FileHeader
	mimeType string
}

// taskAttachmentBatchUpload accepts all files selected in one picker or drop
// action. It returns per-file failures while the successful files produce one
// grouped history entry.
func (h *Handler) taskAttachmentBatchUpload(w http.ResponseWriter, r *http.Request, p auth.Principal, taskID uuid.UUID) {
	files, err := parseMultipartTaskAttachmentFiles(w, r, h.maxAttachSizeMB)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errBody(err.Error()))
		return
	}
	defer func() {
		for _, item := range files {
			_ = item.file.Close()
		}
	}()

	maxBytes := int64(h.maxAttachSizeMB) * 1024 * 1024
	items := make([]UploadAttachmentBatchItem, 0, len(files))
	for _, item := range files {
		counter := &countingReader{r: io.LimitReader(item.file, maxBytes+1)}
		items = append(items, UploadAttachmentBatchItem{
			FileName: item.header.Filename,
			MimeType: item.mimeType,
			Size:     -1,
			Body:     counter,
			Counter:  counter,
		})
	}

	result, err := h.svc.UploadAttachments(r.Context(), UploadAttachmentsParams{
		TaskID:      taskID,
		ActorID:     p.UserID,
		Attachments: items,
	}, h.maxAttachSizeMB)
	if err != nil {
		h.serviceError(w, err)
		return
	}
	if len(result.Attachments) > 0 {
		writeJSON(w, http.StatusCreated, result)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func parseMultipartTaskAttachmentFiles(
	w http.ResponseWriter,
	r *http.Request,
	maxAttachSizeMB int,
) ([]multipartTaskAttachmentFile, error) {
	maxBytes := int64(maxAttachSizeMB) * 1024 * 1024
	formLimit := int64(maxTaskAttachmentBatchFiles)*(maxBytes+2*1024*1024) + 2*1024*1024
	r.Body = http.MaxBytesReader(w, r.Body, formLimit)
	if err := r.ParseMultipartForm(formLimit); err != nil {
		return nil, fmt.Errorf("failed to parse multipart form: %w", err)
	}
	headers := r.MultipartForm.File["files"]
	if len(headers) == 0 {
		return nil, errors.New("missing 'files' field in form")
	}
	if len(headers) > maxTaskAttachmentBatchFiles {
		return nil, fmt.Errorf("too many attachments (maximum %d)", maxTaskAttachmentBatchFiles)
	}

	files := make([]multipartTaskAttachmentFile, 0, len(headers))
	for _, header := range headers {
		file, err := header.Open()
		if err != nil {
			for _, opened := range files {
				_ = opened.file.Close()
			}
			return nil, fmt.Errorf("open attachment: %w", err)
		}
		mimeType := header.Header.Get("Content-Type")
		if mimeType == "" {
			mimeType = "application/octet-stream"
		}
		files = append(files, multipartTaskAttachmentFile{
			file: file, header: header, mimeType: mimeType,
		})
	}
	return files, nil
}

// countingReader wraps an io.Reader and tracks how many bytes have been read.
// It implements tasks.ByteCounter so the service can read the final count after
// streaming completes.
type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}

// BytesRead implements tasks.ByteCounter.
func (c *countingReader) BytesRead() int64 { return c.n }

// taskAttachmentDownload proxies the object from Minio to the HTTP response.
func (h *Handler) taskAttachmentDownload(w http.ResponseWriter, r *http.Request, taskID, attachID uuid.UUID) {
	body, size, mimeType, fileName, err := h.svc.DownloadAttachment(r.Context(), taskID, attachID)
	if err != nil {
		h.serviceError(w, err)
		return
	}
	defer body.Close()

	w.Header().Set("Content-Type", mimeType)
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	w.Header().Set("Content-Disposition", `attachment; filename="`+sanitiseHeaderValue(fileName)+`"`)
	w.WriteHeader(http.StatusOK)
	// Stream the body. Ignore write errors (client may have disconnected).
	io.Copy(w, body) //nolint:errcheck
}

// sanitiseHeaderValue removes characters that are illegal in HTTP header values.
func sanitiseHeaderValue(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r == '"' || r == '\\' || r <= 0x1f || r == 0x7f {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// =========================================================
// Comments (Phase 6)
// =========================================================

// taskCommentsRouter dispatches comment sub-routes for a given task.
//
//	suffix == ""                                   → GET (list) or POST (create comment)
//	suffix == "/attachments"                       → POST (upload staged attachment)
//	suffix == "/attachments/:aid"                  → DELETE (remove staged attachment)
//	suffix == "/:comment_id"                       → PUT (update comment)
//	suffix == "/:comment_id/thread"                → POST (ensure chat thread)
//	suffix == "/:comment_id/attachments/:aid/download" → GET (download linked attachment)
func (h *Handler) taskCommentsRouter(w http.ResponseWriter, r *http.Request, p auth.Principal, taskID uuid.UUID, suffix string) {
	suffix = strings.TrimPrefix(suffix, "/")
	if suffix == "" {
		h.taskComments(w, r, p, taskID)
		return
	}

	parts := strings.Split(suffix, "/")
	if len(parts) >= 1 && parts[0] == "attachments" {
		switch {
		case len(parts) == 1:
			if r.Method != http.MethodPost {
				methodNotAllowed(w)
				return
			}
			h.taskCommentAttachmentUpload(w, r, p, taskID)
			return
		case len(parts) == 2:
			if r.Method != http.MethodDelete {
				methodNotAllowed(w)
				return
			}
			attachmentID, err := uuid.Parse(parts[1])
			if err != nil {
				writeJSON(w, http.StatusBadRequest, errBody("invalid attachment id"))
				return
			}
			if err := h.svc.DeleteStagedCommentAttachment(r.Context(), taskID, p.UserID, attachmentID); err != nil {
				h.serviceError(w, err)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		default:
			writeJSON(w, http.StatusNotFound, errBody("not found"))
			return
		}
	}

	if len(parts) == 4 && parts[1] == "attachments" && parts[3] == "download" {
		commentID, err := uuid.Parse(parts[0])
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errBody("invalid comment id"))
			return
		}
		attachmentID, err := uuid.Parse(parts[2])
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errBody("invalid attachment id"))
			return
		}
		if r.Method != http.MethodGet {
			methodNotAllowed(w)
			return
		}
		h.taskCommentAttachmentDownload(w, r, taskID, commentID, attachmentID)
		return
	}

	if len(parts) == 2 && parts[1] == "thread" {
		commentID, err := uuid.Parse(parts[0])
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errBody("invalid comment id"))
			return
		}
		if r.Method != http.MethodPost {
			methodNotAllowed(w)
			return
		}
		h.taskCommentThreadEnsure(w, r, p, taskID, commentID)
		return
	}

	if len(parts) == 1 {
		commentID, err := uuid.Parse(parts[0])
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errBody("invalid comment id"))
			return
		}
		if r.Method != http.MethodPut {
			methodNotAllowed(w)
			return
		}
		h.taskCommentUpdate(w, r, p, taskID, commentID)
		return
	}

	writeJSON(w, http.StatusNotFound, errBody("not found"))
}

func (h *Handler) taskCommentThreadEnsure(w http.ResponseWriter, r *http.Request, p auth.Principal, taskID, commentID uuid.UUID) {
	row, err := h.svc.EnsureCommentThread(r.Context(), taskID, commentID, p.UserID)
	if err != nil {
		h.serviceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, row)
}

func (h *Handler) taskCommentAttachmentUpload(w http.ResponseWriter, r *http.Request, p auth.Principal, taskID uuid.UUID) {
	maxBytes := int64(h.maxAttachSizeMB) * 1024 * 1024
	formLimit := maxBytes + 2*1024*1024
	if err := r.ParseMultipartForm(formLimit); err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("failed to parse multipart form: "+err.Error()))
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("missing 'file' field in form"))
		return
	}
	defer file.Close()

	if header.Size < 0 {
		writeJSON(w, http.StatusBadRequest, errBody("unable to determine file size"))
		return
	}
	if header.Size > maxBytes {
		writeJSON(w, http.StatusBadRequest, errBody(fmt.Sprintf("file exceeds maximum allowed size of %d MB", h.maxAttachSizeMB)))
		return
	}

	mimeType := header.Header.Get("Content-Type")
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}

	row, err := h.svc.UploadCommentAttachment(r.Context(), UploadCommentAttachmentParams{
		TaskID:   taskID,
		ActorID:  p.UserID,
		FileName: header.Filename,
		MimeType: mimeType,
		Size:     header.Size,
		Body:     file,
	}, h.maxAttachSizeMB)
	if err != nil {
		h.serviceError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, row)
}

func (h *Handler) taskCommentAttachmentDownload(w http.ResponseWriter, r *http.Request, taskID, commentID, attachmentID uuid.UUID) {
	body, size, mimeType, fileName, err := h.svc.DownloadCommentAttachment(r.Context(), taskID, commentID, attachmentID)
	if err != nil {
		h.serviceError(w, err)
		return
	}
	defer body.Close()

	w.Header().Set("Content-Type", mimeType)
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	w.Header().Set("Content-Disposition", `attachment; filename="`+sanitiseHeaderValue(fileName)+`"`)
	w.WriteHeader(http.StatusOK)
	io.Copy(w, body) //nolint:errcheck
}

// GET /api/tasks/:id/comments
// POST /api/tasks/:id/comments
func (h *Handler) taskComments(w http.ResponseWriter, r *http.Request, p auth.Principal, taskID uuid.UUID) {
	switch r.Method {
	case http.MethodGet:
		rows, err := h.svc.ListComments(r.Context(), taskID)
		if err != nil {
			h.serviceError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, rows)

	case http.MethodPost:
		body, attachmentIDs, ok := decodeTaskCommentMutationRequest(w, r)
		if !ok {
			return
		}
		row, err := h.svc.CreateComment(r.Context(), taskID, p.UserID, body, attachmentIDs...)
		if err != nil {
			h.serviceError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, row)

	default:
		methodNotAllowed(w)
	}
}

func (h *Handler) taskCommentUpdate(w http.ResponseWriter, r *http.Request, p auth.Principal, taskID, commentID uuid.UUID) {
	body, attachmentIDs, ok := decodeTaskCommentMutationRequest(w, r)
	if !ok {
		return
	}
	row, err := h.svc.UpdateComment(r.Context(), taskID, commentID, p.UserID, body, attachmentIDs...)
	if err != nil {
		h.serviceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, row)
}

func decodeTaskCommentMutationRequest(w http.ResponseWriter, r *http.Request) (string, []uuid.UUID, bool) {
	var req struct {
		Body          *string  `json:"body"`
		AttachmentIDs []string `json:"attachment_ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("invalid request body"))
		return "", nil, false
	}
	body := ""
	if req.Body != nil {
		body = *req.Body
	}
	attachmentIDs := make([]uuid.UUID, 0, len(req.AttachmentIDs))
	for _, rawID := range req.AttachmentIDs {
		attachmentID, err := uuid.Parse(rawID)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errBody("invalid attachment_ids"))
			return "", nil, false
		}
		attachmentIDs = append(attachmentIDs, attachmentID)
	}
	return body, attachmentIDs, true
}

// =========================================================
// Read-only config endpoints (all authenticated users)
// =========================================================

// GET /api/tasks/config/templates
func (h *Handler) configTemplates(w http.ResponseWriter, r *http.Request, _ auth.Principal) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	rows, err := h.svc.ListTemplates(r.Context(), false)
	if err != nil {
		h.internalError(w, "list templates", err)
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

// configTemplatesRouter dispatches /api/tasks/config/templates/:id[/fields[/...]]
// Only GET operations are permitted; write attempts receive 405.
func (h *Handler) configTemplatesRouter(w http.ResponseWriter, r *http.Request, _ auth.Principal) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/tasks/config/templates/")
	parts := strings.SplitN(rest, "/", 3)

	templateID, err := uuid.Parse(parts[0])
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("invalid template id"))
		return
	}

	// /api/tasks/config/templates/:id/fields[/...]
	if len(parts) >= 2 && parts[1] == "fields" {
		if r.Method != http.MethodGet {
			methodNotAllowed(w)
			return
		}
		includeDeleted := r.URL.Query().Get("include_deleted") == "true"
		rows, err := h.svc.ListFields(r.Context(), templateID, includeDeleted)
		if err != nil {
			h.internalError(w, "list fields", err)
			return
		}
		writeJSON(w, http.StatusOK, rows)
		return
	}

	writeJSON(w, http.StatusNotFound, errBody("not found"))
}

// GET /api/tasks/config/statuses
func (h *Handler) configStatuses(w http.ResponseWriter, r *http.Request, _ auth.Principal) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	rows, err := h.svc.ListStatuses(r.Context(), false)
	if err != nil {
		h.internalError(w, "list statuses", err)
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

// GET /api/tasks/config/enums
func (h *Handler) configEnums(w http.ResponseWriter, r *http.Request, _ auth.Principal) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	rows, err := h.svc.ListFilterableDictionaries(r.Context())
	if err != nil {
		h.internalError(w, "list filterable dictionaries", err)
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

// Routes under /api/tasks/config/enums/:id[/versions[/:vid]|/items]
func (h *Handler) configEnumsItem(w http.ResponseWriter, r *http.Request, p auth.Principal) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/tasks/config/enums/")
	parts := strings.SplitN(rest, "/", 3)

	dictID, err := uuid.Parse(parts[0])
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("invalid dictionary id"))
		return
	}

	if len(parts) == 1 {
		if r.Method != http.MethodGet {
			methodNotAllowed(w)
			return
		}
		// GET /api/tasks/config/enums/:id — return the dictionary itself
		row, err := h.svc.GetDictionary(r.Context(), dictID)
		if err != nil {
			h.serviceError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, row)
		return
	}

	if parts[1] == "items" {
		if len(parts) != 2 {
			writeJSON(w, http.StatusNotFound, errBody("not found"))
			return
		}
		if r.Method != http.MethodPost {
			methodNotAllowed(w)
			return
		}
		var req struct {
			Value string `json:"value"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errBody("invalid request body"))
			return
		}
		item, err := h.svc.CreatePublicDictionaryItem(r.Context(), dictID, req.Value, p.UserID)
		if err != nil {
			h.serviceError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, item)
		return
	}

	if parts[1] != "versions" {
		writeJSON(w, http.StatusNotFound, errBody("not found"))
		return
	}

	// GET /api/tasks/config/enums/:id/versions
	if len(parts) == 2 {
		if r.Method != http.MethodGet {
			methodNotAllowed(w)
			return
		}
		rows, err := h.svc.ListDictionaryVersions(r.Context(), dictID)
		if err != nil {
			h.serviceError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, rows)
		return
	}

	// GET /api/tasks/config/enums/:id/versions/:vid
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	versionID, err := uuid.Parse(parts[2])
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("invalid version id"))
		return
	}
	search := strings.TrimSpace(r.URL.Query().Get("search"))
	limit := queryIntNonNegative(r.URL.Query().Get("limit"), 0)
	valueCodes := append([]string{}, r.URL.Query()["value_code"]...)
	valueCodes = append(valueCodes, r.URL.Query()["value_code[]"]...)
	items, err := h.svc.GetDictionaryVersionItems(r.Context(), versionID, search, limit, valueCodes)
	if err != nil {
		h.serviceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, items)
}

// =========================================================
// Middleware
// =========================================================

// requireAuth verifies a Bearer token and passes the authenticated principal
// to the handler. Any authenticated user (all roles) is allowed.
func (h *Handler) requireAuth(next authHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := bearerToken(r)
		if token == "" {
			writeJSON(w, http.StatusUnauthorized, errBody("missing token"))
			return
		}
		principal, err := h.authSvc.VerifyAccess(r.Context(), token)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, errBody("invalid or expired token"))
			return
		}
		next(w, r, principal)
	}
}

// adminOnly verifies a Bearer token and enforces the admin or owner role.
// The verified principal is passed directly to the handler as a parameter —
// consistent with requireAuth and avoiding any implicit context look-up.
func (h *Handler) adminOnly(next authHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := bearerToken(r)
		if token == "" {
			writeJSON(w, http.StatusUnauthorized, errBody("missing token"))
			return
		}
		principal, err := h.authSvc.VerifyAccess(r.Context(), token)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, errBody("invalid or expired token"))
			return
		}
		if principal.Role != "admin" && principal.Role != "owner" {
			writeJSON(w, http.StatusForbidden, errBody("admin role required"))
			return
		}
		next(w, r, principal)
	}
}

// =========================================================
// Helpers
// =========================================================

func parseUUID(w http.ResponseWriter, r *http.Request, prefix string) (uuid.UUID, bool) {
	raw := strings.TrimPrefix(r.URL.Path, prefix)
	id, err := uuid.Parse(raw)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("invalid id"))
		return uuid.UUID{}, false
	}
	return id, true
}

func parseRFC3339Timestamp(raw string) (time.Time, error) {
	if ts, err := time.Parse(time.RFC3339Nano, raw); err == nil {
		return ts, nil
	}
	return time.Parse(time.RFC3339, raw)
}

func (h *Handler) serviceError(w http.ResponseWriter, err error) {
	var titleConflict *TaskTitleConflictError
	switch {
	case errors.As(err, &titleConflict):
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": titleConflict.Error(),
			"latest": map[string]any{
				"title":      titleConflict.LatestTitle,
				"updated_at": titleConflict.LatestUpdatedAt,
			},
		})
	case errors.Is(err, ErrNotFound):
		writeJSON(w, http.StatusNotFound, errBody(err.Error()))
	case errors.Is(err, ErrForbidden):
		writeJSON(w, http.StatusForbidden, errBody(err.Error()))
	case errors.Is(err, ErrConflict):
		writeJSON(w, http.StatusConflict, errBody(err.Error()))
	case errors.Is(err, ErrBadRequest):
		writeJSON(w, http.StatusBadRequest, errBody(err.Error()))
	default:
		h.internalError(w, "", err)
	}
}

func (h *Handler) internalError(w http.ResponseWriter, msg string, err error) {
	if msg != "" {
		h.log.Error("tasks: "+msg, zap.Error(err))
	} else {
		h.log.Error("tasks: internal error", zap.Error(err))
	}
	writeJSON(w, http.StatusInternalServerError, errBody("internal error"))
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body)
}

func errBody(msg string) map[string]string {
	return map[string]string{"error": msg}
}

func bearerToken(r *http.Request) string {
	v := r.Header.Get("Authorization")
	if after, ok := strings.CutPrefix(v, "Bearer "); ok {
		return strings.TrimSpace(after)
	}
	return ""
}

func methodNotAllowed(w http.ResponseWriter) {
	writeJSON(w, http.StatusMethodNotAllowed, errBody("method not allowed"))
}

// =========================================================
// Phase 4: query-param parsing for GET /api/tasks
// =========================================================

// parseListTasksParams reads all supported query parameters from the request and
// returns a populated ListTasksParams.  It rejects unknown sort_by values to
// give callers an early 400 rather than a silent no-op.
//
// Query parameter contract:
//
//	search                              full-text ILIKE across public_id/title/description
//	status_id   (repeatable)            filter by status UUID(s)
//	prefix      (repeatable)            filter by template_snapshot_prefix
//	include_subtasks                    include subtasks when true; default false
//	created_from                        inclusive created_at lower date bound (YYYY-MM-DD)
//	created_to                          inclusive created_at upper date bound (YYYY-MM-DD)
//	sort_by                             id|title|status|created_at|updated_at|<field-def-uuid>
//	sort_order                          desc (default) | asc
//	page                                1-based page number (default 1)
//	page_size                           results per group page (default 20, max 100)
//
// Custom-field filters (field_definition_id must be a valid UUID):
//
//	field_<id>_user    (repeatable)     filter user/users field by user UUID(s)
//	field_<id>_enum    (repeatable)     filter enum/multi_enum field by value code(s)
//	field_<id>_date_from                lower date bound (YYYY-MM-DD)
//	field_<id>_date_to                  upper date bound (YYYY-MM-DD)
//	dictionary_<id>_enum (repeatable)   filter any filter-enabled dictionary-backed enum field by value code(s)
func parseListTasksParams(r *http.Request) (ListTasksParams, error) {
	q := r.URL.Query()

	// --- pagination ---
	page := queryInt(q.Get("page"), 1)
	pageSize := queryInt(q.Get("page_size"), defaultPageSize)

	// --- sort ---
	sortBy := q.Get("sort_by")
	if err := validateSortBy(sortBy); err != nil {
		return ListTasksParams{}, err
	}
	sortOrder := strings.ToLower(strings.TrimSpace(q.Get("sort_order")))
	sortDesc, err := parseSortDesc(sortOrder)
	if err != nil {
		return ListTasksParams{}, err
	}

	params, err := parseTaskFilterParams(r)
	if err != nil {
		return ListTasksParams{}, err
	}
	params.Page = page
	params.PageSize = pageSize
	params.SortBy = sortBy
	params.SortDesc = sortDesc
	return params, nil
}

// parseTaskFilterParams parses task list filters shared by:
//   - GET /api/tasks
//   - GET /api/tasks/grouped
//   - GET /api/tasks/status/:id/portion
func parseTaskFilterParams(r *http.Request) (ListTasksParams, error) {
	q := r.URL.Query()

	statusIDs, err := parseUUIDs(q["status_id"])
	if err != nil {
		return ListTasksParams{}, errors.New("invalid status_id: " + err.Error())
	}

	fieldFilters, err := parseFieldFilters(q)
	if err != nil {
		return ListTasksParams{}, err
	}
	dictionaryFilters := parseDictionaryFilters(q)
	createdFrom, createdTo, err := parseCreatedDateFilters(q.Get("created_from"), q.Get("created_to"))
	if err != nil {
		return ListTasksParams{}, err
	}

	return ListTasksParams{
		Search:            strings.TrimSpace(q.Get("search")),
		StatusIDs:         statusIDs,
		Prefixes:          q["prefix"],
		IncludeSubtasks:   queryBool(q.Get("include_subtasks"), false),
		CreatedFrom:       createdFrom,
		CreatedTo:         createdTo,
		FieldFilters:      fieldFilters,
		DictionaryFilters: dictionaryFilters,
	}, nil
}

func parseCreatedDateFilters(rawFrom, rawTo string) (*time.Time, *time.Time, error) {
	createdFrom, err := parseCreatedDateFilter(rawFrom, "created_from")
	if err != nil {
		return nil, nil, err
	}
	createdTo, err := parseCreatedDateFilter(rawTo, "created_to")
	if err != nil {
		return nil, nil, err
	}
	if createdTo != nil {
		upper := createdTo.AddDate(0, 0, 1)
		createdTo = &upper
	}
	if createdFrom != nil && createdTo != nil && !createdFrom.Before(*createdTo) {
		return nil, nil, errors.New("created_from must be before or equal to created_to")
	}
	return createdFrom, createdTo, nil
}

func parseCreatedDateFilter(raw, name string) (*time.Time, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, nil
	}
	parsed, err := time.ParseInLocation(time.DateOnly, trimmed, time.UTC)
	if err != nil {
		return nil, errors.New("invalid " + name + ": must be YYYY-MM-DD")
	}
	return &parsed, nil
}

// parseFieldFilters scans all query params looking for keys of the form
// "field_<uuid>_user", "field_<uuid>_enum", "field_<uuid>_date_from",
// "field_<uuid>_date_to" and groups them by field definition ID.
func parseFieldFilters(q map[string][]string) ([]FieldFilter, error) {
	byField := map[uuid.UUID]*FieldFilter{}

	ensure := func(id uuid.UUID) *FieldFilter {
		if _, ok := byField[id]; !ok {
			ff := &FieldFilter{FieldDefinitionID: id}
			byField[id] = ff
		}
		return byField[id]
	}

	for key, vals := range q {
		if !strings.HasPrefix(key, "field_") {
			continue
		}
		rest := strings.TrimPrefix(key, "field_")

		// Determine suffix: _user, _enum, _date_from, _date_to.
		// UUID is 36 chars; suffix starts at index 36.
		if len(rest) < 37 || rest[36] != '_' {
			continue
		}
		rawID := rest[:36]
		suffix := rest[37:]

		fieldID, err := uuid.Parse(rawID)
		if err != nil {
			continue // ignore unknown keys
		}

		ff := ensure(fieldID)
		switch suffix {
		case "user":
			ids, err := parseUUIDs(vals)
			if err != nil {
				return nil, errors.New("invalid field_" + rawID + "_user: " + err.Error())
			}
			ff.UserIDs = append(ff.UserIDs, ids...)

		case "enum":
			ff.EnumCodes = append(ff.EnumCodes, trimNonEmptyValues(vals)...)

		case "date_from":
			v := vals[0]
			ff.DateFrom = &v

		case "date_to":
			v := vals[0]
			ff.DateTo = &v
		}
	}

	out := make([]FieldFilter, 0, len(byField))
	for _, ff := range byField {
		out = append(out, *ff)
	}
	return out, nil
}

func trimNonEmptyValues(vals []string) []string {
	out := make([]string, 0, len(vals))
	for _, val := range vals {
		trimmed := strings.TrimSpace(val)
		if trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func parseDictionaryFilters(q map[string][]string) []DictionaryFilter {
	byDictionary := map[uuid.UUID]*DictionaryFilter{}

	ensure := func(id uuid.UUID) *DictionaryFilter {
		if _, ok := byDictionary[id]; !ok {
			df := &DictionaryFilter{DictionaryID: id}
			byDictionary[id] = df
		}
		return byDictionary[id]
	}

	for key, vals := range q {
		if !strings.HasPrefix(key, "dictionary_") {
			continue
		}
		rest := strings.TrimPrefix(key, "dictionary_")
		if len(rest) < 37 || rest[36] != '_' {
			continue
		}
		rawID := rest[:36]
		suffix := rest[37:]
		if suffix != "enum" {
			continue
		}
		dictionaryID, err := uuid.Parse(rawID)
		if err != nil {
			continue
		}
		df := ensure(dictionaryID)
		df.EnumCodes = append(df.EnumCodes, trimNonEmptyValues(vals)...)
	}

	out := make([]DictionaryFilter, 0, len(byDictionary))
	for _, df := range byDictionary {
		if len(df.EnumCodes) > 0 {
			out = append(out, *df)
		}
	}
	return out
}

// validateSortBy rejects values that are neither a known system column nor a
// valid UUID (which would refer to a numeric custom field).
func validateSortBy(sortBy string) error {
	if sortBy == "" {
		return nil
	}
	if _, ok := systemSortColumns[sortBy]; ok {
		return nil
	}
	if _, err := uuid.Parse(sortBy); err == nil {
		return nil
	}
	return errors.New("invalid sort_by value: must be id|title|status|created_at|updated_at or a field-definition UUID")
}

func parseSortDesc(sortOrder string) (bool, error) {
	switch sortOrder {
	case "", "desc":
		return true, nil
	case "asc":
		return false, nil
	default:
		return false, errors.New("invalid sort_order value: must be asc or desc")
	}
}

// parseUUIDs converts a slice of raw strings to []uuid.UUID.
func parseUUIDs(raw []string) ([]uuid.UUID, error) {
	out := make([]uuid.UUID, 0, len(raw))
	for _, s := range raw {
		id, err := uuid.Parse(s)
		if err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, nil
}

// queryInt parses a query-param string as int, returning fallback on failure.
func queryInt(s string, fallback int) int {
	if s == "" {
		return fallback
	}
	v, err := strconv.Atoi(s)
	if err != nil || v < 1 {
		return fallback
	}
	return v
}

// queryIntNonNegative parses a non-negative query-param int, returning fallback on failure.
func queryIntNonNegative(s string, fallback int) int {
	if s == "" {
		return fallback
	}
	v, err := strconv.Atoi(s)
	if err != nil || v < 0 {
		return fallback
	}
	return v
}

func queryBool(s string, fallback bool) bool {
	if s == "" {
		return fallback
	}
	v, err := strconv.ParseBool(s)
	if err != nil {
		return fallback
	}
	return v
}

func clampInt(v, min, max int) int {
	if v < min {
		return min
	}
	if v > max {
		return max
	}
	return v
}
