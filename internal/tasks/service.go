package tasks

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/sqlc-dev/pqtype"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	"msgnr/internal/events"
	packetspb "msgnr/internal/gen/proto"
	"msgnr/internal/gen/queries"
	"msgnr/internal/userstatus"
)

// pgErrCheckViolation is the Postgres SQLSTATE for check constraint violations.
const pgErrCheckViolation = "23514"

// descriptionPreviewLength is the maximum number of characters returned in
// the description_preview field for grouped/portion task list queries.
const descriptionPreviewLength = 280

// Sentinel errors returned by the service.
var (
	ErrNotFound   = errors.New("not found")
	ErrConflict   = errors.New("conflict")
	ErrBadRequest = errors.New("bad request")
	ErrForbidden  = errors.New("forbidden")
)

// TaskTitleConflictError carries the latest server title state when a title
// update fails optimistic-lock validation.
type TaskTitleConflictError struct {
	LatestTitle     string
	LatestUpdatedAt time.Time
}

func (e *TaskTitleConflictError) Error() string {
	return "conflict: task was modified"
}

func (e *TaskTitleConflictError) Unwrap() error {
	return ErrConflict
}

const prefixMaxLen = 32
const maxCommentAttachments = 10
const defaultTaskDescriptionHistoryLimit = 20
const defaultEnumTaskLookupLimit = 200
const taskDescriptionHistoryDebounce = 10 * time.Second

var (
	rePrefixValid             = regexp.MustCompile(`^[A-Z]+$`)
	reFieldCodeValid          = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)
	reTaskStagedAttachmentRef = regexp.MustCompile(`msgnr-staged-attachment://task/([^)\s]+)`)
)

// ---- Domain types ----

type TemplateRow struct {
	ID        uuid.UUID  `json:"id"`
	Prefix    string     `json:"prefix"`
	SortOrder int        `json:"sort_order"`
	DeletedAt *time.Time `json:"deleted_at,omitempty"`
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
	CreatedBy uuid.UUID  `json:"created_by"`
	UpdatedBy uuid.UUID  `json:"updated_by"`
}

type StatusRow struct {
	ID        uuid.UUID  `json:"id"`
	Code      string     `json:"code"`
	Name      string     `json:"name"`
	SortOrder int        `json:"sort_order"`
	DeletedAt *time.Time `json:"deleted_at,omitempty"`
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
	CreatedBy uuid.UUID  `json:"created_by"`
}

type DictionaryRow struct {
	ID                       uuid.UUID `json:"id"`
	Code                     string    `json:"code"`
	Name                     string    `json:"name"`
	IsPublic                 bool      `json:"is_public"`
	ParticipatesInFiltration bool      `json:"participates_in_filtration"`
	CurrentVersion           int       `json:"current_version"`
	CreatedAt                time.Time `json:"created_at"`
	UpdatedAt                time.Time `json:"updated_at"`
}

type DictionaryVersionRow struct {
	ID           uuid.UUID `json:"id"`
	DictionaryID uuid.UUID `json:"dictionary_id"`
	Version      int       `json:"version"`
	CreatedAt    time.Time `json:"created_at"`
	CreatedBy    uuid.UUID `json:"created_by"`
}

type DictionaryItemRow struct {
	ID                  uuid.UUID `json:"id"`
	DictionaryVersionID uuid.UUID `json:"dictionary_version_id"`
	ValueCode           string    `json:"value_code"`
	ValueName           string    `json:"value_name"`
	SortOrder           int       `json:"sort_order"`
	IsActive            bool      `json:"is_active"`
}

// ---- Input params ----

type CreateTemplateParams struct {
	Prefix    string
	SortOrder int
	ActorID   uuid.UUID
}

type UpdateTemplateParams struct {
	Prefix    string
	SortOrder *int
	ActorID   uuid.UUID
}

type CreateStatusParams struct {
	Code      string
	Name      string
	SortOrder int
	ActorID   uuid.UUID
}

// ActorID is carried for future audit trail support (task_status has no
// updated_by column yet; it will be added when history tracking is implemented).
type UpdateStatusParams struct {
	Code    string
	Name    string
	ActorID uuid.UUID
}

type CreateDictionaryParams struct {
	Code                     string
	Name                     string
	IsPublic                 bool
	ParticipatesInFiltration bool
}

type DictionaryItemInput struct {
	ValueCode string `json:"value_code"`
	ValueName string `json:"value_name"`
	SortOrder int    `json:"sort_order"`
	IsActive  bool   `json:"is_active"`
}

type dictionaryItemSaveMode int

const (
	dictionaryItemSaveModeCreateVersion dictionaryItemSaveMode = iota
	dictionaryItemSaveModeUpdateLatest
)

// ---- Field definition types ----

type FieldRow struct {
	ID               uuid.UUID  `json:"id"`
	TemplateID       uuid.UUID  `json:"template_id"`
	Code             string     `json:"code"`
	Name             string     `json:"name"`
	Type             string     `json:"type"`
	Required         bool       `json:"required"`
	SortOrder        int        `json:"sort_order"`
	EnumDictionaryID *uuid.UUID `json:"enum_dictionary_id,omitempty"`
	FieldRole        *string    `json:"field_role,omitempty"`
	DeletedAt        *time.Time `json:"deleted_at,omitempty"`
	CreatedAt        time.Time  `json:"created_at"`
	UpdatedAt        time.Time  `json:"updated_at"`
}

type CreateFieldParams struct {
	TemplateID       uuid.UUID
	Code             string
	Name             string
	Type             string
	Required         bool
	SortOrder        int
	EnumDictionaryID *uuid.UUID
	FieldRole        *string
}

type UpdateFieldParams struct {
	Name     string
	Required bool
}

// =========================================================
// Task domain types (Phase 3)
// =========================================================

// TaskRow is the task record returned by the service.
type TaskRow struct {
	ID                     uuid.UUID  `json:"id"`
	PublicID               string     `json:"public_id"`
	TemplateID             uuid.UUID  `json:"template_id"`
	DiscussionChannelID    *uuid.UUID `json:"discussion_channel_id,omitempty"`
	TemplateSnapshotPrefix string     `json:"template_snapshot_prefix"`
	SequenceNumber         int64      `json:"sequence_number"`
	Title                  string     `json:"title"`
	Description            *string    `json:"description,omitempty"`
	StatusID               uuid.UUID  `json:"status_id"`
	ParentTaskID           *uuid.UUID `json:"parent_task_id,omitempty"`
	CreatedBy              uuid.UUID  `json:"created_by"`
	UpdatedBy              uuid.UUID  `json:"updated_by"`
	CreatedAt              time.Time  `json:"created_at"`
	UpdatedAt              time.Time  `json:"updated_at"`
}

// FieldValueRow is one custom field value record.
type FieldValueRow struct {
	ID                uuid.UUID       `json:"id"`
	TaskID            uuid.UUID       `json:"task_id"`
	FieldDefinitionID uuid.UUID       `json:"field_definition_id"`
	ValueText         *string         `json:"value_text,omitempty"`
	ValueNumber       *string         `json:"value_number,omitempty"`
	ValueUserID       *uuid.UUID      `json:"value_user_id,omitempty"`
	ValueDate         *string         `json:"value_date,omitempty"`
	ValueDatetime     *time.Time      `json:"value_datetime,omitempty"`
	ValueJSON         json.RawMessage `json:"value_json,omitempty"`
	EnumDictionaryID  *uuid.UUID      `json:"enum_dictionary_id,omitempty"`
	EnumVersion       *int32          `json:"enum_version,omitempty"`
	CreatedAt         time.Time       `json:"created_at"`
	UpdatedAt         time.Time       `json:"updated_at"`
}

type TaskAssigneeSummary struct {
	ID           uuid.UUID        `json:"id"`
	DisplayName  string           `json:"display_name"`
	Email        string           `json:"email"`
	AvatarURL    string           `json:"avatar_url"`
	CustomStatus *userstatus.Body `json:"custom_status"`
}

type TaskSubtaskSummary struct {
	TaskRow
	Assignees []TaskAssigneeSummary `json:"assignees"`
}

// TaskResponse combines a task with its custom field values and subtasks.
// Subtasks is only populated for top-level tasks (ParentTaskID == nil).
// ParentPublicID is only populated for subtasks (ParentTaskID != nil).
type TaskResponse struct {
	TaskRow
	FieldValues    []FieldValueRow      `json:"field_values"`
	Subtasks       []TaskSubtaskSummary `json:"subtasks"`
	ParentPublicID *string              `json:"parent_public_id,omitempty"`
}

// TaskDescriptionHistoryEditor is a public editor snapshot in task history.
type TaskDescriptionHistoryEditor struct {
	ID           uuid.UUID        `json:"id"`
	DisplayName  string           `json:"display_name"`
	AvatarURL    string           `json:"avatar_url"`
	CustomStatus *userstatus.Body `json:"custom_status"`
}

// TaskDescriptionHistoryItem is one saved description snapshot.
type TaskDescriptionHistoryItem struct {
	PublicID    string                       `json:"public_id"`
	Title       string                       `json:"title"`
	Description *string                      `json:"description"`
	EditedBy    uuid.UUID                    `json:"edited_by"`
	CreatedAt   time.Time                    `json:"created_at"`
	Editor      TaskDescriptionHistoryEditor `json:"editor"`
}

// TaskHistoryActor is the current public presentation of the user who made a
// task change. Historical identity is stored by ID; avatar/name/status remain
// consistent with the rest of the task UI.
type TaskHistoryActor struct {
	ID           uuid.UUID        `json:"id"`
	DisplayName  string           `json:"display_name"`
	AvatarURL    string           `json:"avatar_url"`
	CustomStatus *userstatus.Body `json:"custom_status"`
}

// TaskChangeHistoryItem is one immutable task creation or field-change entry.
// BeforeValue and AfterValue contain JSON scalars or arrays appropriate to
// FieldType. Description values are Markdown strings.
type TaskChangeHistoryItem struct {
	ID          uuid.UUID        `json:"id"`
	ChangeKind  string           `json:"change_kind"`
	FieldKey    string           `json:"field_key"`
	FieldName   string           `json:"field_name"`
	FieldType   string           `json:"field_type"`
	BeforeValue json.RawMessage  `json:"before_value"`
	AfterValue  json.RawMessage  `json:"after_value"`
	CreatedAt   time.Time        `json:"created_at"`
	Actor       TaskHistoryActor `json:"actor"`
}

// TaskChangeHistoryPage is a cursor-paginated newest-first page.
type TaskChangeHistoryPage struct {
	Items      []TaskChangeHistoryItem `json:"items"`
	NextCursor string                  `json:"next_cursor,omitempty"`
}

// TaskHistoryAttachment is immutable file metadata captured in task history.
// It intentionally has no storage key: history must remain readable without
// making a removed attachment downloadable.
type TaskHistoryAttachment struct {
	ID       uuid.UUID `json:"id"`
	FileName string    `json:"file_name"`
	FileSize int64     `json:"file_size"`
	MimeType string    `json:"mime_type"`
}

// TaskHistoryCreatedValue carries details that belong to the initial task
// creation event. Staged attachments are represented here rather than as
// separate add events because they did not exist on an already-created task.
type TaskHistoryCreatedValue struct {
	Attachments []TaskHistoryAttachment `json:"attachments"`
}

// =========================================================
// Attachment + Comment domain types (Phase 6)
// =========================================================

// AttachmentRow is one file attachment record returned by the service.
// StorageKey is intentionally excluded from JSON serialisation — it is an
// internal Minio path that must never be exposed to API consumers.
type AttachmentRow struct {
	ID         uuid.UUID `json:"id"`
	TaskID     uuid.UUID `json:"task_id"`
	FileName   string    `json:"file_name"`
	FileSize   int64     `json:"file_size"`
	MimeType   string    `json:"mime_type"`
	StorageKey string    `json:"-"`
	UploadedBy uuid.UUID `json:"uploaded_by"`
	CreatedAt  time.Time `json:"created_at"`
}

// StagedAttachmentRow is a pre-task attachment uploaded while a create dialog
// draft is still unsaved. StorageKey is internal and must never be exposed.
type StagedAttachmentRow struct {
	ID         uuid.UUID `json:"id"`
	FileName   string    `json:"file_name"`
	FileSize   int64     `json:"file_size"`
	MimeType   string    `json:"mime_type"`
	StorageKey string    `json:"-"`
	UploadedBy uuid.UUID `json:"uploaded_by"`
	CreatedAt  time.Time `json:"created_at"`
}

// CommentRow is one comment record returned by the service.
type CommentRow struct {
	ID                  uuid.UUID              `json:"id"`
	TaskID              uuid.UUID              `json:"task_id"`
	AuthorID            uuid.UUID              `json:"author_id"`
	ThreadRootMessageID *uuid.UUID             `json:"thread_root_message_id,omitempty"`
	ThreadReplyCount    int                    `json:"thread_reply_count"`
	Body                string                 `json:"body"`
	CreatedAt           time.Time              `json:"created_at"`
	UpdatedAt           time.Time              `json:"updated_at"`
	Attachments         []CommentAttachmentRow `json:"attachments"`
}

// CommentThreadRow identifies the chat thread backing one task comment.
type CommentThreadRow struct {
	ConversationID      uuid.UUID `json:"conversation_id"`
	ThreadRootMessageID uuid.UUID `json:"thread_root_message_id"`
	ThreadReplyCount    int       `json:"reply_count"`
}

// CommentAttachmentRow is one file attachment record linked to a task comment.
// StorageKey is internal and must never be exposed to API consumers.
type CommentAttachmentRow struct {
	ID         uuid.UUID  `json:"id"`
	TaskID     uuid.UUID  `json:"task_id"`
	CommentID  *uuid.UUID `json:"comment_id,omitempty"`
	FileName   string     `json:"file_name"`
	FileSize   int64      `json:"file_size"`
	MimeType   string     `json:"mime_type"`
	StorageKey string     `json:"-"`
	UploadedBy uuid.UUID  `json:"uploaded_by"`
	CreatedAt  time.Time  `json:"created_at"`
}

// ByteCounter is satisfied by any reader wrapper that tracks bytes consumed.
// The handler passes a *countingReader; the service reads the final count after
// PutObject returns to verify the actual upload size.
type ByteCounter interface {
	BytesRead() int64
}

// UploadAttachmentParams carries inputs for uploading a file attachment.
// Size should be set to -1 when the caller cannot guarantee the value from the
// client (e.g. multipart header.Size); the service uses the ByteCounter to
// determine the real size after streaming.
type UploadAttachmentParams struct {
	TaskID   uuid.UUID
	ActorID  uuid.UUID
	FileName string
	MimeType string
	// Size is passed to the object store. Pass -1 to use streaming/chunked mode
	// when the true size is unknown upfront (the service will use ByteCounter).
	Size int64
	Body io.Reader
}

// UploadAttachmentBatchItem is one file in a grouped task attachment upload.
// Counter is optional for known sizes, and required when Size is -1.
type UploadAttachmentBatchItem struct {
	FileName string
	MimeType string
	Size     int64
	Body     io.Reader
	Counter  ByteCounter
}

// UploadAttachmentsParams holds the shared task and actor data for one picker
// or drop action. Successful items get one grouped history entry.
type UploadAttachmentsParams struct {
	TaskID      uuid.UUID
	ActorID     uuid.UUID
	Attachments []UploadAttachmentBatchItem
}

// AttachmentUploadError is a per-file failure returned by a batch upload.
// It is intentionally user-safe and never contains object-store details.
type AttachmentUploadError struct {
	FileName string `json:"file_name"`
	Message  string `json:"message"`
}

// AttachmentUploadResult reports successful task attachments alongside any
// independently failed files from the same picker or drop action.
type AttachmentUploadResult struct {
	Attachments []AttachmentRow         `json:"attachments"`
	Errors      []AttachmentUploadError `json:"errors"`
}

// UploadTaskStagedAttachmentParams carries inputs for pre-create image uploads.
type UploadTaskStagedAttachmentParams struct {
	ActorID  uuid.UUID
	FileName string
	MimeType string
	Size     int64
	Body     io.Reader
}

// UploadCommentAttachmentParams carries inputs for staged comment attachment upload.
type UploadCommentAttachmentParams struct {
	TaskID   uuid.UUID
	ActorID  uuid.UUID
	FileName string
	MimeType string
	Size     int64
	Body     io.Reader
}

// FieldValueInput is the typed-union input for one custom field value.
type FieldValueInput struct {
	FieldDefinitionID uuid.UUID       `json:"field_definition_id"`
	ValueText         *string         `json:"value_text"`
	ValueNumber       *string         `json:"value_number"`
	ValueUserID       *uuid.UUID      `json:"value_user_id"`
	ValueDate         *string         `json:"value_date"`
	ValueDatetime     *time.Time      `json:"value_datetime"`
	ValueJSON         json.RawMessage `json:"value_json"`
	EnumDictionaryID  *uuid.UUID      `json:"enum_dictionary_id"`
	EnumVersion       *int32          `json:"enum_version"`
}

// CreateTaskParams carries all inputs for task creation.
type CreateTaskParams struct {
	TemplateID          uuid.UUID
	ParentTaskID        *uuid.UUID // nil for top-level tasks
	Title               string
	Description         *string
	StatusID            uuid.UUID
	FieldValues         []FieldValueInput
	StagedAttachmentIDs []uuid.UUID
	ActorID             uuid.UUID
}

// UpdateTaskParams carries all inputs for a full task update.
// FieldValues replaces the entire set (replace-all semantics).
type UpdateTaskParams struct {
	Title       string
	Description *string
	StatusID    uuid.UUID
	FieldValues []FieldValueInput
	ActorID     uuid.UUID
}

// UpdateTaskTitleParams carries inputs for a title-only task update.
type UpdateTaskTitleParams struct {
	Title             string
	IfUnmodifiedSince time.Time
	ActorID           uuid.UUID
}

// UpdateTaskDescriptionParams carries inputs for a description-only task update.
type UpdateTaskDescriptionParams struct {
	Description   *string
	ActorID       uuid.UUID
	ForceSnapshot bool
}

// ---- Service ----

type Service struct {
	pool                    *pgxpool.Pool
	q                       *queries.Queries
	eventStore              *events.Store
	store                   Storage
	descriptionHistoryLimit int
}

// Storage is the interface the service uses for file object storage.
// It is satisfied by storage.MinioClient and by test fakes.
type Storage interface {
	PutObject(ctx context.Context, key string, r io.Reader, size int64, mimeType string) error
	GetObject(ctx context.Context, key string) (body io.ReadCloser, size int64, mimeType string, err error)
	DeleteObject(ctx context.Context, key string) error
}

func NewService(pool *pgxpool.Pool, store Storage) *Service {
	return &Service{
		pool:                    pool,
		q:                       queries.New(stdlib.OpenDBFromPool(pool)),
		eventStore:              events.NewStore(pool),
		store:                   store,
		descriptionHistoryLimit: defaultTaskDescriptionHistoryLimit,
	}
}

// SetDescriptionHistoryLimit overrides per-task retention cap.
func (s *Service) SetDescriptionHistoryLimit(limit int) {
	if limit <= 0 {
		s.descriptionHistoryLimit = defaultTaskDescriptionHistoryLimit
		return
	}
	s.descriptionHistoryLimit = limit
}

// =========================================================
// Templates
// =========================================================

func (s *Service) ListTemplates(ctx context.Context, includeDeleted bool) ([]TemplateRow, error) {
	rows, err := s.q.TaskTemplateList(ctx, includeDeleted)
	if err != nil {
		return nil, fmt.Errorf("tasks: list templates: %w", err)
	}
	return mapTemplates(rows), nil
}

func (s *Service) GetTemplate(ctx context.Context, id uuid.UUID) (TemplateRow, error) {
	row, err := s.q.TaskTemplateGet(ctx, id)
	if err != nil {
		return TemplateRow{}, mapNotFound(err, "template")
	}
	return mapTemplate(row), nil
}

func (s *Service) CreateTemplate(ctx context.Context, p CreateTemplateParams) (TemplateRow, error) {
	if err := validatePrefix(p.Prefix); err != nil {
		return TemplateRow{}, err
	}
	row, err := s.q.TaskTemplateCreate(ctx, queries.TaskTemplateCreateParams{
		Prefix:    p.Prefix,
		SortOrder: p.SortOrder,
		CreatedBy: p.ActorID,
	})
	if err != nil {
		return TemplateRow{}, mapUniqueViolation(err, "prefix already exists")
	}
	return mapTemplate(row), nil
}

func (s *Service) UpdateTemplate(ctx context.Context, id uuid.UUID, p UpdateTemplateParams) (TemplateRow, error) {
	if err := validatePrefix(p.Prefix); err != nil {
		return TemplateRow{}, err
	}

	// Always run inside a pgx transaction so that prefix and sort_order changes
	// are atomic. Using raw tx.Exec for both columns avoids the sql.DB/pgx.Tx
	// boundary mismatch (s.q runs on *sql.DB, which is outside a pgx transaction).
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return TemplateRow{}, fmt.Errorf("tasks: begin update template tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var sortOrder int
	if p.SortOrder != nil {
		sortOrder = *p.SortOrder
	}

	// WHERE deleted_at IS NULL guarantees the returned row is active, so
	// deleted_at is always NULL here — omit it from RETURNING to keep the scan
	// straightforward. TemplateRow.DeletedAt stays nil by zero-value.
	var row TemplateRow
	err = tx.QueryRow(ctx, `
		UPDATE task_template
		SET prefix     = $2,
		    updated_by = $3,
		    sort_order  = CASE WHEN $4 THEN $5::int ELSE sort_order END,
		    updated_at  = now()
		WHERE id = $1 AND deleted_at IS NULL
		RETURNING id, prefix, sort_order, created_at, updated_at, created_by, updated_by`,
		id, p.Prefix, p.ActorID,
		p.SortOrder != nil, sortOrder,
	).Scan(
		&row.ID, &row.Prefix, &row.SortOrder,
		&row.CreatedAt, &row.UpdatedAt,
		&row.CreatedBy, &row.UpdatedBy,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return TemplateRow{}, fmt.Errorf("%w: template", ErrNotFound)
		}
		if isUniqueViolation(err) {
			return TemplateRow{}, fmt.Errorf("%w: prefix already exists", ErrConflict)
		}
		if isCheckViolation(err) {
			return TemplateRow{}, fmt.Errorf("%w: %s", ErrBadRequest, err)
		}
		return TemplateRow{}, fmt.Errorf("tasks: update template: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return TemplateRow{}, fmt.Errorf("tasks: commit update template tx: %w", err)
	}
	return row, nil
}

func (s *Service) SoftDeleteTemplate(ctx context.Context, id uuid.UUID, actorID uuid.UUID) (TemplateRow, error) {
	row, err := s.q.TaskTemplateSoftDelete(ctx, queries.TaskTemplateSoftDeleteParams{
		ID:        id,
		UpdatedBy: actorID,
	})
	if err != nil {
		return TemplateRow{}, mapNotFound(err, "template")
	}
	return mapTemplate(row), nil
}

// ReorderTemplates assigns sort_order 1…N to the given template IDs in order.
// Runs in a single transaction; duplicate or unknown IDs are rejected.
func (s *Service) ReorderTemplates(ctx context.Context, ids []uuid.UUID) error {
	return s.reorderInTx(ctx, ids, tableTaskTemplate, nil)
}

// =========================================================
// Statuses
// =========================================================

func (s *Service) ListStatuses(ctx context.Context, includeDeleted bool) ([]StatusRow, error) {
	rows, err := s.q.TaskStatusList(ctx, includeDeleted)
	if err != nil {
		return nil, fmt.Errorf("tasks: list statuses: %w", err)
	}
	return mapStatuses(rows), nil
}

func (s *Service) GetStatus(ctx context.Context, id uuid.UUID) (StatusRow, error) {
	row, err := s.q.TaskStatusGet(ctx, id)
	if err != nil {
		return StatusRow{}, mapNotFound(err, "status")
	}
	return mapStatus(row), nil
}

func (s *Service) CreateStatus(ctx context.Context, p CreateStatusParams) (StatusRow, error) {
	if strings.TrimSpace(p.Code) == "" || strings.TrimSpace(p.Name) == "" {
		return StatusRow{}, fmt.Errorf("%w: code and name are required", ErrBadRequest)
	}
	row, err := s.q.TaskStatusCreate(ctx, queries.TaskStatusCreateParams{
		Code:      p.Code,
		Name:      p.Name,
		SortOrder: p.SortOrder,
		CreatedBy: p.ActorID,
	})
	if err != nil {
		return StatusRow{}, mapUniqueViolation(err, "code already exists")
	}
	return mapStatus(row), nil
}

func (s *Service) UpdateStatus(ctx context.Context, id uuid.UUID, p UpdateStatusParams) (StatusRow, error) {
	if strings.TrimSpace(p.Code) == "" || strings.TrimSpace(p.Name) == "" {
		return StatusRow{}, fmt.Errorf("%w: code and name are required", ErrBadRequest)
	}
	row, err := s.q.TaskStatusUpdate(ctx, queries.TaskStatusUpdateParams{
		ID:   id,
		Code: p.Code,
		Name: p.Name,
	})
	if err != nil {
		if isUniqueViolation(err) {
			return StatusRow{}, fmt.Errorf("%w: code already exists", ErrConflict)
		}
		return StatusRow{}, mapNotFound(err, "status")
	}
	return mapStatus(row), nil
}

func (s *Service) SoftDeleteStatus(ctx context.Context, id uuid.UUID) (StatusRow, error) {
	row, err := s.q.TaskStatusSoftDelete(ctx, id)
	if err != nil {
		return StatusRow{}, mapNotFound(err, "status")
	}
	return mapStatus(row), nil
}

// ReorderStatuses assigns sort_order 1…N to the given status IDs in order.
// Runs in a single transaction; duplicate or unknown IDs are rejected.
func (s *Service) ReorderStatuses(ctx context.Context, ids []uuid.UUID) error {
	return s.reorderInTx(ctx, ids, tableTaskStatus, nil)
}

// =========================================================
// Enum dictionaries
// =========================================================

func (s *Service) ListDictionaries(ctx context.Context) ([]DictionaryRow, error) {
	rows, err := s.q.EnumDictionaryList(ctx)
	if err != nil {
		return nil, fmt.Errorf("tasks: list dictionaries: %w", err)
	}
	return mapDictionaries(rows), nil
}

func (s *Service) ListFilterableDictionaries(ctx context.Context) ([]DictionaryRow, error) {
	rows, err := s.q.EnumDictionaryListFilterable(ctx)
	if err != nil {
		return nil, fmt.Errorf("tasks: list filterable dictionaries: %w", err)
	}
	return mapDictionaries(rows), nil
}

func (s *Service) GetDictionary(ctx context.Context, id uuid.UUID) (DictionaryRow, error) {
	row, err := s.q.EnumDictionaryGet(ctx, id)
	if err != nil {
		return DictionaryRow{}, mapNotFound(err, "dictionary")
	}
	return mapDictionary(row), nil
}

func (s *Service) CreateDictionary(ctx context.Context, p CreateDictionaryParams) (DictionaryRow, error) {
	if strings.TrimSpace(p.Code) == "" || strings.TrimSpace(p.Name) == "" {
		return DictionaryRow{}, fmt.Errorf("%w: code and name are required", ErrBadRequest)
	}
	row, err := s.q.EnumDictionaryCreate(ctx, queries.EnumDictionaryCreateParams{
		Code:                     p.Code,
		Name:                     p.Name,
		IsPublic:                 p.IsPublic,
		ParticipatesInFiltration: p.ParticipatesInFiltration,
	})
	if err != nil {
		return DictionaryRow{}, mapUniqueViolation(err, "code already exists")
	}
	return mapDictionary(row), nil
}

func (s *Service) UpdateDictionarySettings(
	ctx context.Context,
	id uuid.UUID,
	isPublic bool,
	participatesInFiltration bool,
) (DictionaryRow, error) {
	row, err := s.q.EnumDictionaryUpdateSettings(ctx, queries.EnumDictionaryUpdateSettingsParams{
		ID:                       id,
		IsPublic:                 isPublic,
		ParticipatesInFiltration: participatesInFiltration,
	})
	if err != nil {
		return DictionaryRow{}, mapNotFound(err, "dictionary")
	}
	return mapDictionary(row), nil
}

// CreateDictionaryVersion saves a full dictionary item snapshot. When the
// submission is additive relative to the latest version, the latest version is
// updated in place; otherwise a new version is created.
func (s *Service) CreateDictionaryVersion(
	ctx context.Context,
	dictID uuid.UUID,
	items []DictionaryItemInput,
	actorID uuid.UUID,
) (DictionaryVersionRow, error) {
	if len(items) == 0 {
		return DictionaryVersionRow{}, fmt.Errorf("%w: items list must not be empty", ErrBadRequest)
	}
	submittedByCode := make(map[string]DictionaryItemInput, len(items))
	for _, it := range items {
		if strings.TrimSpace(it.ValueCode) == "" || strings.TrimSpace(it.ValueName) == "" {
			return DictionaryVersionRow{}, fmt.Errorf("%w: every item needs a value_code and value_name", ErrBadRequest)
		}
		if _, exists := submittedByCode[it.ValueCode]; exists {
			return DictionaryVersionRow{}, fmt.Errorf("%w: duplicate value_code %q in submitted items", ErrConflict, it.ValueCode)
		}
		submittedByCode[it.ValueCode] = it
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return DictionaryVersionRow{}, fmt.Errorf("tasks: begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var currentVersion int
	if err := tx.QueryRow(ctx,
		`SELECT current_version
		   FROM enum_dictionary
		  WHERE id = $1
		  FOR UPDATE`,
		dictID,
	).Scan(&currentVersion); err != nil {
		return DictionaryVersionRow{}, mapNotFound(err, "dictionary")
	}

	latestVersion, latestItems, err := loadLatestDictionaryVersionTx(ctx, tx, dictID)
	if err != nil {
		return DictionaryVersionRow{}, err
	}

	saveMode := classifyDictionaryItemSaveMode(latestItems, submittedByCode)
	if latestVersion != nil && saveMode == dictionaryItemSaveModeUpdateLatest {
		if err := updateDictionaryItemsInLatestVersionTx(ctx, tx, latestVersion.ID, latestItems, submittedByCode); err != nil {
			return DictionaryVersionRow{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return DictionaryVersionRow{}, fmt.Errorf("tasks: commit dictionary item update tx: %w", err)
		}
		return mapDictionaryVersion(*latestVersion), nil
	}

	ver, err := createDictionaryVersionTx(ctx, tx, dictID, currentVersion+1, actorID, items)
	if err != nil {
		return DictionaryVersionRow{}, err
	}

	if _, err := tx.Exec(ctx,
		`UPDATE enum_dictionary
		    SET current_version = $2, updated_at = now()
		  WHERE id = $1`,
		dictID, ver.Version,
	); err != nil {
		return DictionaryVersionRow{}, fmt.Errorf("tasks: update dictionary current_version: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return DictionaryVersionRow{}, fmt.Errorf("tasks: commit version tx: %w", err)
	}
	return mapDictionaryVersion(ver), nil
}

func (s *Service) CreatePublicDictionaryItem(
	ctx context.Context,
	dictID uuid.UUID,
	value string,
	actorID uuid.UUID,
) (DictionaryItemRow, error) {
	trimmedValue := strings.TrimSpace(value)
	if trimmedValue == "" {
		return DictionaryItemRow{}, fmt.Errorf("%w: value is required", ErrBadRequest)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return DictionaryItemRow{}, fmt.Errorf("tasks: begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var dict queries.EnumDictionary
	err = tx.QueryRow(ctx, `
		SELECT id, code, name, is_public, current_version, created_at, updated_at
		FROM enum_dictionary
		WHERE id = $1
		FOR UPDATE
	`, dictID).Scan(
		&dict.ID,
		&dict.Code,
		&dict.Name,
		&dict.IsPublic,
		&dict.CurrentVersion,
		&dict.CreatedAt,
		&dict.UpdatedAt,
	)
	if err != nil {
		return DictionaryItemRow{}, mapNotFound(err, "dictionary")
	}
	if !dict.IsPublic {
		return DictionaryItemRow{}, fmt.Errorf("%w: dictionary is private", ErrForbidden)
	}

	latestVersion, latestItems, err := loadLatestDictionaryVersionTx(ctx, tx, dictID)
	if err != nil {
		return DictionaryItemRow{}, err
	}
	for _, item := range latestItems {
		if item.ValueCode == trimmedValue {
			return DictionaryItemRow{}, fmt.Errorf("%w: duplicate value_code %q in this version", ErrConflict, trimmedValue)
		}
	}

	if latestVersion != nil {
		var item queries.EnumDictionaryVersionItem
		err = tx.QueryRow(ctx, `
			INSERT INTO enum_dictionary_version_item
			    (dictionary_version_id, value_code, value_name, sort_order, is_active)
			VALUES ($1, $2, $3, $4, $5)
			RETURNING id, dictionary_version_id, value_code, value_name, sort_order, is_active
		`, latestVersion.ID, trimmedValue, trimmedValue, len(latestItems)+1, true).Scan(
			&item.ID,
			&item.DictionaryVersionID,
			&item.ValueCode,
			&item.ValueName,
			&item.SortOrder,
			&item.IsActive,
		)
		if err != nil {
			return DictionaryItemRow{}, mapUniqueViolation(err, fmt.Sprintf("duplicate value_code %q in this version", trimmedValue))
		}
		if err := tx.Commit(ctx); err != nil {
			return DictionaryItemRow{}, fmt.Errorf("tasks: commit public dictionary item tx: %w", err)
		}
		return mapDictionaryItem(item), nil
	}

	ver, err := createDictionaryVersionTx(ctx, tx, dictID, dict.CurrentVersion+1, actorID, []DictionaryItemInput{{
		ValueCode: trimmedValue,
		ValueName: trimmedValue,
		SortOrder: 1,
		IsActive:  true,
	}})
	if err != nil {
		return DictionaryItemRow{}, err
	}

	if _, err := tx.Exec(ctx, `
		UPDATE enum_dictionary
		SET current_version = $2, updated_at = now()
		WHERE id = $1
	`, dictID, ver.Version); err != nil {
		return DictionaryItemRow{}, fmt.Errorf("tasks: update dictionary current_version: %w", err)
	}

	var item queries.EnumDictionaryVersionItem
	err = tx.QueryRow(ctx, `
		SELECT id, dictionary_version_id, value_code, value_name, sort_order, is_active
		FROM enum_dictionary_version_item
		WHERE dictionary_version_id = $1
		ORDER BY sort_order ASC, value_name ASC
		LIMIT 1
	`, ver.ID).Scan(
		&item.ID,
		&item.DictionaryVersionID,
		&item.ValueCode,
		&item.ValueName,
		&item.SortOrder,
		&item.IsActive,
	)
	if err != nil {
		return DictionaryItemRow{}, fmt.Errorf("tasks: load created dictionary item: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return DictionaryItemRow{}, fmt.Errorf("tasks: commit public dictionary bootstrap tx: %w", err)
	}
	return mapDictionaryItem(item), nil
}

func (s *Service) ListDictionaryVersions(ctx context.Context, dictID uuid.UUID) ([]DictionaryVersionRow, error) {
	rows, err := s.q.EnumDictionaryVersionList(ctx, dictID)
	if err != nil {
		return nil, fmt.Errorf("tasks: list versions: %w", err)
	}
	return mapDictionaryVersions(rows), nil
}

func loadLatestDictionaryVersionTx(
	ctx context.Context,
	tx pgx.Tx,
	dictID uuid.UUID,
) (*queries.EnumDictionaryVersion, []queries.EnumDictionaryVersionItem, error) {
	var latest queries.EnumDictionaryVersion
	err := tx.QueryRow(ctx,
		`SELECT id, dictionary_id, version, created_at, created_by
		   FROM enum_dictionary_version
		  WHERE dictionary_id = $1
		  ORDER BY version DESC
		  LIMIT 1`,
		dictID,
	).Scan(&latest.ID, &latest.DictionaryID, &latest.Version, &latest.CreatedAt, &latest.CreatedBy)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil, nil
		}
		return nil, nil, fmt.Errorf("tasks: load latest dictionary version: %w", err)
	}

	rows, err := tx.Query(ctx,
		`SELECT id, dictionary_version_id, value_code, value_name, sort_order, is_active
		   FROM enum_dictionary_version_item
		  WHERE dictionary_version_id = $1
		  ORDER BY sort_order ASC, value_name ASC`,
		latest.ID,
	)
	if err != nil {
		return nil, nil, fmt.Errorf("tasks: load latest dictionary version items: %w", err)
	}
	defer rows.Close()

	items := make([]queries.EnumDictionaryVersionItem, 0)
	for rows.Next() {
		var item queries.EnumDictionaryVersionItem
		if err := rows.Scan(
			&item.ID,
			&item.DictionaryVersionID,
			&item.ValueCode,
			&item.ValueName,
			&item.SortOrder,
			&item.IsActive,
		); err != nil {
			return nil, nil, fmt.Errorf("tasks: scan latest dictionary version item: %w", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("tasks: iterate latest dictionary version items: %w", err)
	}

	return &latest, items, nil
}

func classifyDictionaryItemSaveMode(
	latestItems []queries.EnumDictionaryVersionItem,
	submittedByCode map[string]DictionaryItemInput,
) dictionaryItemSaveMode {
	// Existing items may change sort_order and is_active in place. Only removals
	// or value_name changes force a new version row.
	if len(latestItems) == 0 {
		return dictionaryItemSaveModeCreateVersion
	}
	for _, latest := range latestItems {
		submitted, ok := submittedByCode[latest.ValueCode]
		if !ok {
			return dictionaryItemSaveModeCreateVersion
		}
		if submitted.ValueName != latest.ValueName {
			return dictionaryItemSaveModeCreateVersion
		}
	}
	return dictionaryItemSaveModeUpdateLatest
}

func updateDictionaryItemsInLatestVersionTx(
	ctx context.Context,
	tx pgx.Tx,
	versionID uuid.UUID,
	latestItems []queries.EnumDictionaryVersionItem,
	submittedByCode map[string]DictionaryItemInput,
) error {
	latestByCode := make(map[string]queries.EnumDictionaryVersionItem, len(latestItems))
	for _, latest := range latestItems {
		latestByCode[latest.ValueCode] = latest
	}

	for _, latest := range latestItems {
		submitted := submittedByCode[latest.ValueCode]
		if _, err := tx.Exec(ctx,
			`UPDATE enum_dictionary_version_item
			    SET sort_order = $2,
			        is_active = $3
			  WHERE id = $1`,
			latest.ID,
			submitted.SortOrder,
			submitted.IsActive,
		); err != nil {
			return fmt.Errorf("tasks: update dictionary version item %s: %w", latest.ID, err)
		}
	}

	for code, submitted := range submittedByCode {
		if _, exists := latestByCode[code]; exists {
			continue
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO enum_dictionary_version_item
			 (dictionary_version_id, value_code, value_name, sort_order, is_active)
			 VALUES ($1, $2, $3, $4, $5)`,
			versionID,
			submitted.ValueCode,
			submitted.ValueName,
			submitted.SortOrder,
			submitted.IsActive,
		); err != nil {
			return mapUniqueViolation(
				err,
				fmt.Sprintf("duplicate value_code %q in this version", submitted.ValueCode),
			)
		}
	}

	return nil
}

func createDictionaryVersionTx(
	ctx context.Context,
	tx pgx.Tx,
	dictID uuid.UUID,
	version int,
	actorID uuid.UUID,
	items []DictionaryItemInput,
) (queries.EnumDictionaryVersion, error) {
	var ver queries.EnumDictionaryVersion
	err := tx.QueryRow(ctx,
		`INSERT INTO enum_dictionary_version (dictionary_id, version, created_by)
		 VALUES ($1, $2, $3)
		 RETURNING id, dictionary_id, version, created_at, created_by`,
		dictID, version, actorID,
	).Scan(&ver.ID, &ver.DictionaryID, &ver.Version, &ver.CreatedAt, &ver.CreatedBy)
	if err != nil {
		return queries.EnumDictionaryVersion{}, fmt.Errorf("tasks: insert version: %w", err)
	}

	for _, it := range items {
		_, err := tx.Exec(ctx,
			`INSERT INTO enum_dictionary_version_item
			 (dictionary_version_id, value_code, value_name, sort_order, is_active)
			 VALUES ($1, $2, $3, $4, $5)`,
			ver.ID, it.ValueCode, it.ValueName, it.SortOrder, it.IsActive,
		)
		if err != nil {
			return queries.EnumDictionaryVersion{}, mapUniqueViolation(
				err,
				fmt.Sprintf("duplicate value_code %q in this version", it.ValueCode),
			)
		}
	}

	return ver, nil
}

func (s *Service) GetDictionaryVersionItems(
	ctx context.Context,
	versionID uuid.UUID,
	search string,
	limit int,
	valueCodes []string,
) ([]DictionaryItemRow, error) {
	itemsByCode := make(map[string]DictionaryItemRow)
	orderedCodes := make([]string, 0)

	appendUnique := func(rows []DictionaryItemRow) {
		for _, row := range rows {
			if _, exists := itemsByCode[row.ValueCode]; exists {
				continue
			}
			itemsByCode[row.ValueCode] = row
			orderedCodes = append(orderedCodes, row.ValueCode)
		}
	}

	if len(valueCodes) > 0 {
		selectedRows, err := s.getDictionaryVersionItemsByCodes(ctx, versionID, valueCodes)
		if err != nil {
			return nil, err
		}
		appendUnique(selectedRows)
	}

	matchedRows, err := s.searchDictionaryVersionItems(ctx, versionID, search, limit)
	if err != nil {
		return nil, err
	}
	appendUnique(matchedRows)

	out := make([]DictionaryItemRow, 0, len(orderedCodes))
	for _, code := range orderedCodes {
		out = append(out, itemsByCode[code])
	}
	return out, nil
}

func (s *Service) getDictionaryVersionItemsByCodes(
	ctx context.Context,
	versionID uuid.UUID,
	valueCodes []string,
) ([]DictionaryItemRow, error) {
	normalized := make([]string, 0, len(valueCodes))
	seen := make(map[string]struct{}, len(valueCodes))
	for _, code := range valueCodes {
		trimmed := strings.TrimSpace(code)
		if trimmed == "" {
			continue
		}
		if _, exists := seen[trimmed]; exists {
			continue
		}
		seen[trimmed] = struct{}{}
		normalized = append(normalized, trimmed)
	}
	if len(normalized) == 0 {
		return nil, nil
	}

	rows, err := s.pool.Query(ctx, `
		SELECT id, dictionary_version_id, value_code, value_name, sort_order, is_active
		FROM enum_dictionary_version_item
		WHERE dictionary_version_id = $1
		  AND value_code = ANY($2::text[])
		ORDER BY sort_order ASC, value_name ASC
	`, versionID, normalized)
	if err != nil {
		return nil, fmt.Errorf("tasks: list version items by codes: %w", err)
	}
	defer rows.Close()

	out := make([]DictionaryItemRow, 0, len(normalized))
	for rows.Next() {
		var row queries.EnumDictionaryVersionItem
		if err := rows.Scan(
			&row.ID,
			&row.DictionaryVersionID,
			&row.ValueCode,
			&row.ValueName,
			&row.SortOrder,
			&row.IsActive,
		); err != nil {
			return nil, fmt.Errorf("tasks: scan version item by code: %w", err)
		}
		out = append(out, mapDictionaryItem(row))
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("tasks: iterate version items by code: %w", err)
	}
	return out, nil
}

func (s *Service) searchDictionaryVersionItems(
	ctx context.Context,
	versionID uuid.UUID,
	search string,
	limit int,
) ([]DictionaryItemRow, error) {
	search = strings.TrimSpace(search)

	var (
		rows pgx.Rows
		err  error
	)

	switch {
	case search == "" && limit > 0:
		rows, err = s.pool.Query(ctx, `
			SELECT id, dictionary_version_id, value_code, value_name, sort_order, is_active
			FROM enum_dictionary_version_item
			WHERE dictionary_version_id = $1
			ORDER BY sort_order ASC, value_name ASC
			LIMIT $2
		`, versionID, limit)
	case search == "":
		queryRows, queryErr := s.q.EnumDictionaryVersionItemList(ctx, versionID)
		if queryErr != nil {
			return nil, fmt.Errorf("tasks: list version items: %w", queryErr)
		}
		return mapDictionaryItems(queryRows), nil
	case limit > 0:
		rows, err = s.pool.Query(ctx, `
			SELECT id, dictionary_version_id, value_code, value_name, sort_order, is_active
			FROM enum_dictionary_version_item
			WHERE dictionary_version_id = $1
			  AND value_name ILIKE '%' || $2 || '%'
			ORDER BY sort_order ASC, value_name ASC
			LIMIT $3
		`, versionID, search, limit)
	default:
		rows, err = s.pool.Query(ctx, `
			SELECT id, dictionary_version_id, value_code, value_name, sort_order, is_active
			FROM enum_dictionary_version_item
			WHERE dictionary_version_id = $1
			  AND value_name ILIKE '%' || $2 || '%'
			ORDER BY sort_order ASC, value_name ASC
		`, versionID, search)
	}
	if err != nil {
		return nil, fmt.Errorf("tasks: search version items: %w", err)
	}
	defer rows.Close()

	out := make([]DictionaryItemRow, 0)
	for rows.Next() {
		var row queries.EnumDictionaryVersionItem
		if err := rows.Scan(
			&row.ID,
			&row.DictionaryVersionID,
			&row.ValueCode,
			&row.ValueName,
			&row.SortOrder,
			&row.IsActive,
		); err != nil {
			return nil, fmt.Errorf("tasks: scan searched version item: %w", err)
		}
		out = append(out, mapDictionaryItem(row))
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("tasks: iterate searched version items: %w", err)
	}
	return out, nil
}

// =========================================================
// Field definitions
// =========================================================

func (s *Service) ListFields(ctx context.Context, templateID uuid.UUID, includeDeleted bool) ([]FieldRow, error) {
	rows, err := s.q.TaskFieldList(ctx, queries.TaskFieldListParams{
		TemplateID: templateID,
		Column2:    includeDeleted,
	})
	if err != nil {
		return nil, fmt.Errorf("tasks: list fields: %w", err)
	}
	return mapFields(rows), nil
}

func (s *Service) GetField(ctx context.Context, templateID, id uuid.UUID) (FieldRow, error) {
	row, err := s.q.TaskFieldGet(ctx, queries.TaskFieldGetParams{
		ID:         id,
		TemplateID: templateID,
	})
	if err != nil {
		return FieldRow{}, mapNotFound(err, "field")
	}
	return mapField(row), nil
}

func (s *Service) CreateField(ctx context.Context, p CreateFieldParams) (FieldRow, error) {
	if err := validateFieldCode(p.Code); err != nil {
		return FieldRow{}, err
	}
	if strings.TrimSpace(p.Name) == "" {
		return FieldRow{}, fmt.Errorf("%w: name is required", ErrBadRequest)
	}
	if p.SortOrder < 1 {
		return FieldRow{}, fmt.Errorf("%w: sort_order must be >= 1", ErrBadRequest)
	}

	row, err := s.q.TaskFieldCreate(ctx, queries.TaskFieldCreateParams{
		TemplateID:       p.TemplateID,
		Code:             p.Code,
		Name:             p.Name,
		Type:             p.Type,
		Required:         p.Required,
		SortOrder:        p.SortOrder,
		EnumDictionaryID: nullUUID(p.EnumDictionaryID),
		FieldRole:        nullString(p.FieldRole),
	})
	if err != nil {
		return FieldRow{}, mapFieldCreateError(err)
	}
	return mapField(row), nil
}

func (s *Service) UpdateField(ctx context.Context, templateID, id uuid.UUID, p UpdateFieldParams) (FieldRow, error) {
	if strings.TrimSpace(p.Name) == "" {
		return FieldRow{}, fmt.Errorf("%w: name is required", ErrBadRequest)
	}
	row, err := s.q.TaskFieldUpdate(ctx, queries.TaskFieldUpdateParams{
		ID:         id,
		Name:       p.Name,
		Required:   p.Required,
		TemplateID: templateID,
	})
	if err != nil {
		return FieldRow{}, mapNotFound(err, "field")
	}
	return mapField(row), nil
}

func (s *Service) SoftDeleteField(ctx context.Context, templateID, id uuid.UUID) (FieldRow, error) {
	row, err := s.q.TaskFieldSoftDelete(ctx, queries.TaskFieldSoftDeleteParams{
		ID:         id,
		TemplateID: templateID,
	})
	if err != nil {
		return FieldRow{}, mapNotFound(err, "field")
	}
	return mapField(row), nil
}

// ReorderFields sets sort_order 1…N for the given field IDs, scoped to templateID.
func (s *Service) ReorderFields(ctx context.Context, templateID uuid.UUID, ids []uuid.UUID) error {
	return s.reorderInTx(ctx, ids, tableTaskFieldDef, &templateID)
}

// =========================================================
// Helpers
// =========================================================

func validatePrefix(prefix string) error {
	if strings.TrimSpace(prefix) == "" {
		return fmt.Errorf("%w: prefix is required", ErrBadRequest)
	}
	if len(prefix) > prefixMaxLen {
		return fmt.Errorf("%w: prefix must be at most %d characters", ErrBadRequest, prefixMaxLen)
	}
	if !rePrefixValid.MatchString(prefix) {
		return fmt.Errorf("%w: prefix must contain only uppercase Latin letters (A-Z)", ErrBadRequest)
	}
	return nil
}

// reorderTable is a typed allowlist of tables that reorderInTx may update.
// This prevents any SQL injection risk if a future caller passes untrusted input.
type reorderTable string

const (
	tableTaskTemplate reorderTable = "task_template"
	tableTaskStatus   reorderTable = "task_status"
	tableTaskFieldDef reorderTable = "task_field_definition"
)

// reorderInTx sets sort_order 1…N for the given IDs in a single transaction.
// Rejects duplicate IDs. When scopeID is non-nil, the UPDATE is additionally
// filtered by template_id = $3 — this prevents cross-template ID smuggling.
func (s *Service) reorderInTx(ctx context.Context, ids []uuid.UUID, table reorderTable, scopeID *uuid.UUID) error {
	if len(ids) == 0 {
		return nil
	}
	seen := make(map[uuid.UUID]struct{}, len(ids))
	for _, id := range ids {
		if _, dup := seen[id]; dup {
			return fmt.Errorf("%w: duplicate id %s in reorder list", ErrBadRequest, id)
		}
		seen[id] = struct{}{}
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("tasks: begin reorder tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// table is a typed constant — no user input reaches this format string.
	var stmt string
	if scopeID != nil {
		stmt = fmt.Sprintf(
			"UPDATE %s SET sort_order = $2, updated_at = now() WHERE id = $1 AND template_id = $3",
			table,
		)
	} else {
		stmt = fmt.Sprintf(
			"UPDATE %s SET sort_order = $2, updated_at = now() WHERE id = $1",
			table,
		)
	}

	for i, id := range ids {
		var execErr error
		if scopeID != nil {
			_, execErr = tx.Exec(ctx, stmt, id, i+1, *scopeID)
		} else {
			_, execErr = tx.Exec(ctx, stmt, id, i+1)
		}
		if execErr != nil {
			return fmt.Errorf("tasks: reorder %s %s: %w", table, id, execErr)
		}
	}

	return tx.Commit(ctx)
}

// mapNotFound converts sql.ErrNoRows to ErrNotFound.
func mapNotFound(err error, entity string) error {
	if errors.Is(err, sql.ErrNoRows) || errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: %s", ErrNotFound, entity)
	}
	return fmt.Errorf("tasks: %s: %w", entity, err)
}

// isUniqueViolation returns true for Postgres unique-constraint violations (23505).
func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// mapUniqueViolation wraps a unique-violation error as ErrConflict, or falls
// back to a generic wrap for other errors.
func mapUniqueViolation(err error, msg string) error {
	if isUniqueViolation(err) {
		return fmt.Errorf("%w: %s", ErrConflict, msg)
	}
	return fmt.Errorf("tasks: %w", err)
}

// isCheckViolation returns true for Postgres check-constraint violations (23514).
func isCheckViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == pgErrCheckViolation
}

// pgConstraintName extracts the constraint name from a Postgres error, or "".
func pgConstraintName(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.ConstraintName
	}
	return ""
}

// mapFieldCreateError maps DB errors from TaskFieldCreate to service errors.
// Differentiates between:
//   - check constraint violation → ErrBadRequest (bad type/enum/role config)
//   - unique violation on assignee index → ErrConflict "only one assignee field allowed"
//   - unique violation on code index → ErrConflict "field code already exists"
func mapFieldCreateError(err error) error {
	switch {
	case isCheckViolation(err):
		return fmt.Errorf("%w: invalid field configuration (check type, enum_dictionary_id, field_role combination)", ErrBadRequest)
	case isUniqueViolation(err):
		if pgConstraintName(err) == "uq_task_field_definition_one_assignee" {
			return fmt.Errorf("%w: only one assignee field is allowed per template", ErrConflict)
		}
		return fmt.Errorf("%w: field code already exists for this template", ErrConflict)
	default:
		return fmt.Errorf("tasks: %w", err)
	}
}

func validateFieldCode(code string) error {
	if !reFieldCodeValid.MatchString(strings.TrimSpace(code)) {
		return fmt.Errorf("%w: code must match ^[a-z][a-z0-9_]*$", ErrBadRequest)
	}
	return nil
}

// nullUUID converts *uuid.UUID to uuid.NullUUID for sqlc.
func nullUUID(u *uuid.UUID) uuid.NullUUID {
	if u == nil {
		return uuid.NullUUID{}
	}
	return uuid.NullUUID{UUID: *u, Valid: true}
}

// nullString converts *string to sql.NullString for sqlc.
func nullString(s *string) sql.NullString {
	if s == nil {
		return sql.NullString{}
	}
	return sql.NullString{String: *s, Valid: true}
}

func normalizeTaskTitle(title string) string {
	return strings.TrimSpace(title)
}

func normalizeTaskDescription(description *string) *string {
	if description == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*description)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func normalizeTaskDescriptionNullString(description *string) sql.NullString {
	return nullString(normalizeTaskDescription(description))
}

type comparableFieldValue struct {
	ValueText        sql.NullString
	ValueNumber      sql.NullString
	ValueUserID      uuid.NullUUID
	ValueDate        sql.NullString
	ValueDatetime    sql.NullTime
	ValueJSON        json.RawMessage
	ValueJSONValid   bool
	JSONComparable   bool
	EnumDictionaryID uuid.NullUUID
	EnumVersion      sql.NullInt32
}

func normalizeFieldValueInputForType(fieldType string, fv FieldValueInput) FieldValueInput {
	switch fieldType {
	case "users", "multi_enum":
		trimmed := bytes.TrimSpace(fv.ValueJSON)
		if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
			fv.ValueJSON = json.RawMessage("[]")
		}
	}
	return fv
}

func comparableFieldValueFromInput(fv FieldValueInput) comparableFieldValue {
	valueJSON, jsonComparable := canonicalJSONForCompare(fv.ValueJSON)
	return comparableFieldValue{
		ValueText:        nullString(fv.ValueText),
		ValueNumber:      nullString(fv.ValueNumber),
		ValueUserID:      nullUUID(fv.ValueUserID),
		ValueDate:        nullString(fv.ValueDate),
		ValueDatetime:    nullTimePtr(fv.ValueDatetime),
		ValueJSON:        valueJSON,
		ValueJSONValid:   len(valueJSON) > 0,
		JSONComparable:   jsonComparable,
		EnumDictionaryID: nullUUID(fv.EnumDictionaryID),
		EnumVersion:      nullInt32Ptr(fv.EnumVersion),
	}
}

func comparableFieldValueFromStored(row queries.TaskFieldValue) comparableFieldValue {
	date := sql.NullString{}
	if row.ValueDate.Valid {
		date = sql.NullString{String: row.ValueDate.Time.Format("2006-01-02"), Valid: true}
	}
	valueJSON, jsonComparable := canonicalJSONForCompare(row.ValueJson.RawMessage)
	return comparableFieldValue{
		ValueText:        row.ValueText,
		ValueNumber:      row.ValueNumber,
		ValueUserID:      row.ValueUserID,
		ValueDate:        date,
		ValueDatetime:    row.ValueDatetime,
		ValueJSON:        valueJSON,
		ValueJSONValid:   row.ValueJson.Valid,
		JSONComparable:   jsonComparable,
		EnumDictionaryID: row.EnumDictionaryID,
		EnumVersion:      row.EnumVersion,
	}
}

func comparableFieldValuesEqual(a, b comparableFieldValue) bool {
	return nullStringsEqual(a.ValueText, b.ValueText) &&
		nullNumericStringsEqual(a.ValueNumber, b.ValueNumber) &&
		nullUUIDsEqual(a.ValueUserID, b.ValueUserID) &&
		nullStringsEqual(a.ValueDate, b.ValueDate) &&
		nullTimesEqual(a.ValueDatetime, b.ValueDatetime) &&
		rawJSONEqual(a.ValueJSON, a.ValueJSONValid, a.JSONComparable, b.ValueJSON, b.ValueJSONValid, b.JSONComparable) &&
		nullUUIDsEqual(a.EnumDictionaryID, b.EnumDictionaryID) &&
		nullInt32Equal(a.EnumVersion, b.EnumVersion)
}

func taskFieldInputsEqual(existing []queries.TaskFieldValue, requested []FieldValueInput, fieldTypes map[uuid.UUID]string) bool {
	if len(existing) != len(requested) {
		return false
	}

	existingByField := make(map[uuid.UUID]queries.TaskFieldValue, len(existing))
	for _, row := range existing {
		existingByField[row.FieldDefinitionID] = row
	}

	requestedByField := make(map[uuid.UUID]FieldValueInput, len(requested))
	for _, fv := range requested {
		fieldType, ok := fieldTypes[fv.FieldDefinitionID]
		if !ok {
			return false
		}
		if _, seen := requestedByField[fv.FieldDefinitionID]; seen {
			return false
		}
		requestedByField[fv.FieldDefinitionID] = normalizeFieldValueInputForType(fieldType, fv)
	}

	if len(existingByField) != len(requestedByField) {
		return false
	}

	for fieldID, existingRow := range existingByField {
		requestedValue, ok := requestedByField[fieldID]
		if !ok {
			return false
		}
		if !comparableFieldValuesEqual(comparableFieldValueFromStored(existingRow), comparableFieldValueFromInput(requestedValue)) {
			return false
		}
	}

	return true
}

func validateFieldValueDefinitions(defs []queries.TaskFieldDefinition, inputs []FieldValueInput) error {
	known := make(map[uuid.UUID]struct{}, len(defs))
	for _, def := range defs {
		known[def.ID] = struct{}{}
	}
	seen := make(map[uuid.UUID]struct{}, len(inputs))
	for _, fv := range inputs {
		if _, ok := known[fv.FieldDefinitionID]; !ok {
			return fmt.Errorf("%w: unknown field %s", ErrBadRequest, fv.FieldDefinitionID)
		}
		if _, ok := seen[fv.FieldDefinitionID]; ok {
			return fmt.Errorf("%w: duplicate field %s", ErrBadRequest, fv.FieldDefinitionID)
		}
		seen[fv.FieldDefinitionID] = struct{}{}
	}
	return nil
}

func singleFieldUpdateInput(fieldDefinitionID uuid.UUID, p UpdateTaskFieldValueParams) FieldValueInput {
	return FieldValueInput{
		FieldDefinitionID: fieldDefinitionID,
		ValueText:         p.ValueText,
		ValueNumber:       p.ValueNumber,
		ValueUserID:       p.ValueUserID,
		ValueDate:         p.ValueDate,
		ValueDatetime:     p.ValueDatetime,
		ValueJSON:         p.ValueJSON,
		EnumDictionaryID:  p.EnumDictionaryID,
		EnumVersion:       p.EnumVersion,
	}
}

// ---- Mappers: queries → domain types ----

func mapTemplate(r queries.TaskTemplate) TemplateRow {
	t := TemplateRow{
		ID:        r.ID,
		Prefix:    r.Prefix,
		SortOrder: r.SortOrder,
		CreatedAt: r.CreatedAt,
		UpdatedAt: r.UpdatedAt,
		CreatedBy: r.CreatedBy,
		UpdatedBy: r.UpdatedBy,
	}
	if r.DeletedAt.Valid {
		t.DeletedAt = &r.DeletedAt.Time
	}
	return t
}

func mapTemplates(rows []queries.TaskTemplate) []TemplateRow {
	out := make([]TemplateRow, len(rows))
	for i, r := range rows {
		out[i] = mapTemplate(r)
	}
	return out
}

func mapStatus(r queries.TaskStatus) StatusRow {
	s := StatusRow{
		ID:        r.ID,
		Code:      r.Code,
		Name:      r.Name,
		SortOrder: r.SortOrder,
		CreatedAt: r.CreatedAt,
		UpdatedAt: r.UpdatedAt,
		CreatedBy: r.CreatedBy,
	}
	if r.DeletedAt.Valid {
		s.DeletedAt = &r.DeletedAt.Time
	}
	return s
}

func mapStatuses(rows []queries.TaskStatus) []StatusRow {
	out := make([]StatusRow, len(rows))
	for i, r := range rows {
		out[i] = mapStatus(r)
	}
	return out
}

func mapTaskListStatusSummary(r queries.TaskStatus) TaskListStatusSummary {
	return TaskListStatusSummary{
		ID:        r.ID,
		Code:      r.Code,
		Name:      r.Name,
		SortOrder: r.SortOrder,
	}
}

func mapDictionary(r queries.EnumDictionary) DictionaryRow {
	return DictionaryRow{
		ID:                       r.ID,
		Code:                     r.Code,
		Name:                     r.Name,
		IsPublic:                 r.IsPublic,
		ParticipatesInFiltration: r.ParticipatesInFiltration,
		CurrentVersion:           r.CurrentVersion,
		CreatedAt:                r.CreatedAt,
		UpdatedAt:                r.UpdatedAt,
	}
}

func mapDictionaries(rows []queries.EnumDictionary) []DictionaryRow {
	out := make([]DictionaryRow, len(rows))
	for i, r := range rows {
		out[i] = mapDictionary(r)
	}
	return out
}

func mapDictionaryVersion(r queries.EnumDictionaryVersion) DictionaryVersionRow {
	return DictionaryVersionRow{
		ID:           r.ID,
		DictionaryID: r.DictionaryID,
		Version:      r.Version,
		CreatedAt:    r.CreatedAt,
		CreatedBy:    r.CreatedBy,
	}
}

func mapDictionaryVersions(rows []queries.EnumDictionaryVersion) []DictionaryVersionRow {
	out := make([]DictionaryVersionRow, len(rows))
	for i, r := range rows {
		out[i] = mapDictionaryVersion(r)
	}
	return out
}

func mapDictionaryItem(r queries.EnumDictionaryVersionItem) DictionaryItemRow {
	return DictionaryItemRow{
		ID:                  r.ID,
		DictionaryVersionID: r.DictionaryVersionID,
		ValueCode:           r.ValueCode,
		ValueName:           r.ValueName,
		SortOrder:           r.SortOrder,
		IsActive:            r.IsActive,
	}
}

func mapDictionaryItems(rows []queries.EnumDictionaryVersionItem) []DictionaryItemRow {
	out := make([]DictionaryItemRow, len(rows))
	for i, r := range rows {
		out[i] = mapDictionaryItem(r)
	}
	return out
}

func mapField(r queries.TaskFieldDefinition) FieldRow {
	f := FieldRow{
		ID:         r.ID,
		TemplateID: r.TemplateID,
		Code:       r.Code,
		Name:       r.Name,
		Type:       r.Type,
		Required:   r.Required,
		SortOrder:  r.SortOrder,
		CreatedAt:  r.CreatedAt,
		UpdatedAt:  r.UpdatedAt,
	}
	if r.EnumDictionaryID.Valid {
		id := r.EnumDictionaryID.UUID
		f.EnumDictionaryID = &id
	}
	if r.FieldRole.Valid {
		f.FieldRole = &r.FieldRole.String
	}
	if r.DeletedAt.Valid {
		f.DeletedAt = &r.DeletedAt.Time
	}
	return f
}

func mapFields(rows []queries.TaskFieldDefinition) []FieldRow {
	out := make([]FieldRow, len(rows))
	for i, r := range rows {
		out[i] = mapField(r)
	}
	return out
}

func extractTaskStagedAttachmentRefs(description *string) ([]uuid.UUID, error) {
	if description == nil || !strings.Contains(*description, "msgnr-staged-attachment://task/") {
		return nil, nil
	}

	seen := map[uuid.UUID]struct{}{}
	out := make([]uuid.UUID, 0)
	matches := reTaskStagedAttachmentRef.FindAllStringSubmatch(*description, -1)
	for _, match := range matches {
		if len(match) < 2 {
			continue
		}
		id, err := uuid.Parse(match[1])
		if err != nil {
			return nil, fmt.Errorf("%w: invalid staged attachment reference", ErrBadRequest)
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}

	return out, nil
}

func validateTaskStagedAttachmentRequest(description *string, requested []uuid.UUID) ([]uuid.UUID, error) {
	referenced, err := extractTaskStagedAttachmentRefs(description)
	if err != nil {
		return nil, err
	}
	if len(referenced) == 0 {
		if len(requested) > 0 {
			return nil, fmt.Errorf("%w: staged attachment ids must be referenced by the description", ErrBadRequest)
		}
		return nil, nil
	}

	requestedSet := make(map[uuid.UUID]struct{}, len(requested))
	for _, id := range requested {
		requestedSet[id] = struct{}{}
	}
	if len(requestedSet) != len(referenced) {
		return nil, fmt.Errorf("%w: staged attachment ids do not match description references", ErrBadRequest)
	}
	for _, id := range referenced {
		if _, ok := requestedSet[id]; !ok {
			return nil, fmt.Errorf("%w: staged attachment ids do not match description references", ErrBadRequest)
		}
	}
	return referenced, nil
}

func rewriteTaskStagedAttachmentRefs(description *string, taskID uuid.UUID, ids []uuid.UUID) *string {
	if description == nil || len(ids) == 0 {
		return description
	}
	next := *description
	for _, id := range ids {
		next = strings.ReplaceAll(
			next,
			"msgnr-staged-attachment://task/"+id.String(),
			"msgnr-attachment://task/"+taskID.String()+"/"+id.String(),
		)
	}
	return &next
}

func scanTaskStagedAttachment(scanner interface {
	Scan(dest ...any) error
}) (StagedAttachmentRow, error) {
	var row StagedAttachmentRow
	err := scanner.Scan(
		&row.ID,
		&row.FileName,
		&row.FileSize,
		&row.MimeType,
		&row.StorageKey,
		&row.UploadedBy,
		&row.CreatedAt,
	)
	return row, err
}

func scanTaskAttachment(scanner interface {
	Scan(dest ...any) error
}) (AttachmentRow, error) {
	var row AttachmentRow
	err := scanner.Scan(
		&row.ID,
		&row.TaskID,
		&row.FileName,
		&row.FileSize,
		&row.MimeType,
		&row.StorageKey,
		&row.UploadedBy,
		&row.CreatedAt,
	)
	return row, err
}

// =========================================================
// Tasks — Phase 3
// =========================================================

// CreateTask creates a new task for the given template inside a transaction.
// The DB trigger handles public_id generation and blocks deleted templates/statuses.
func (s *Service) CreateTask(ctx context.Context, p CreateTaskParams) (TaskResponse, error) {
	if strings.TrimSpace(p.Title) == "" {
		return TaskResponse{}, fmt.Errorf("%w: title is required", ErrBadRequest)
	}

	// Verify the specific template exists and is not soft-deleted before opening
	// a transaction. This gives a clear app-level error rather than relying solely
	// on the DB trigger message. The trigger remains the authoritative enforcement.
	tpl, err := s.q.TaskTemplateGet(ctx, p.TemplateID)
	if err != nil {
		return TaskResponse{}, mapNotFound(err, "template")
	}
	if tpl.DeletedAt.Valid {
		return TaskResponse{}, fmt.Errorf("%w: template has been deleted", ErrBadRequest)
	}

	// Validate parent task if provided: it must exist and must not itself be a subtask.
	if p.ParentTaskID != nil {
		parent, err := s.q.TaskGet(ctx, *p.ParentTaskID)
		if err != nil {
			return TaskResponse{}, mapNotFound(err, "parent task")
		}
		if parent.ParentTaskID.Valid {
			return TaskResponse{}, fmt.Errorf("%w: parent task is already a subtask", ErrBadRequest)
		}
	}

	// Load active field definitions and validate required fields before any writes.
	defs, err := s.q.TaskFieldDefinitionListActive(ctx, p.TemplateID)
	if err != nil {
		return TaskResponse{}, fmt.Errorf("tasks: load field definitions: %w", err)
	}
	if err := validateRequiredFields(defs, p.FieldValues); err != nil {
		return TaskResponse{}, err
	}
	stagedAttachmentIDs, err := validateTaskStagedAttachmentRequest(p.Description, p.StagedAttachmentIDs)
	if err != nil {
		return TaskResponse{}, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return TaskResponse{}, fmt.Errorf("tasks: begin create task tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	createdHistoryAttachments := make([]TaskHistoryAttachment, 0, len(stagedAttachmentIDs))
	if len(stagedAttachmentIDs) > 0 {
		rows, err := tx.Query(ctx,
			`SELECT id, file_name, file_size, mime_type, storage_key, uploaded_by, created_at
			   FROM task_staged_attachment
			  WHERE uploaded_by = $1
			    AND id = ANY($2::uuid[])
			  FOR UPDATE`,
			p.ActorID,
			stagedAttachmentIDs,
		)
		if err != nil {
			return TaskResponse{}, fmt.Errorf("tasks: lock staged attachments: %w", err)
		}
		defer rows.Close()
		locked := make(map[uuid.UUID]StagedAttachmentRow, len(stagedAttachmentIDs))
		for rows.Next() {
			row, scanErr := scanTaskStagedAttachment(rows)
			if scanErr != nil {
				return TaskResponse{}, fmt.Errorf("tasks: scan staged attachment: %w", scanErr)
			}
			locked[row.ID] = row
		}
		if err := rows.Err(); err != nil {
			return TaskResponse{}, fmt.Errorf("tasks: iterate staged attachments: %w", err)
		}
		if len(locked) != len(stagedAttachmentIDs) {
			return TaskResponse{}, fmt.Errorf("%w: staged attachment not found", ErrBadRequest)
		}
		for _, id := range stagedAttachmentIDs {
			if !strings.HasPrefix(locked[id].MimeType, "image/") {
				return TaskResponse{}, fmt.Errorf("%w: only image staged attachments are supported", ErrBadRequest)
			}
			createdHistoryAttachments = append(createdHistoryAttachments, taskHistoryAttachmentFromStaged(locked[id]))
		}
	}

	taskID := uuid.New()
	description := rewriteTaskStagedAttachmentRefs(p.Description, taskID, stagedAttachmentIDs)

	// Raw pgx tx query mirrors the sqlc TaskCreate query. The sqlc-generated path
	// (s.q.TaskCreate) cannot join a pgx transaction because s.q is bound to a
	// *sql.DB pool. We keep the SQL aligned with the sqlc source while supplying
	// an explicit ID so staged attachment URLs can be finalized before insert.
	taskRow, err := scanTask(tx.QueryRow(ctx,
		`INSERT INTO task (id, template_id, parent_task_id, title, description, status_id, created_by, updated_by)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
		 RETURNING `+taskColumns,
		taskID, p.TemplateID, nullUUID(p.ParentTaskID), p.Title, nullString(description), p.StatusID, p.ActorID,
	))
	if err != nil {
		return TaskResponse{}, mapTaskWriteError(err)
	}

	if len(stagedAttachmentIDs) > 0 {
		if _, err := tx.Exec(ctx,
			`INSERT INTO task_attachment (id, task_id, file_name, file_size, mime_type, storage_key, uploaded_by, created_at)
			  SELECT id, $1, file_name, file_size, mime_type, storage_key, uploaded_by, created_at
			    FROM task_staged_attachment
			   WHERE uploaded_by = $2
			     AND id = ANY($3::uuid[])`,
			taskRow.ID,
			p.ActorID,
			stagedAttachmentIDs,
		); err != nil {
			return TaskResponse{}, fmt.Errorf("tasks: bind staged attachments: %w", err)
		}
		if _, err := tx.Exec(ctx,
			`DELETE FROM task_staged_attachment
			  WHERE uploaded_by = $1
			    AND id = ANY($2::uuid[])`,
			p.ActorID,
			stagedAttachmentIDs,
		); err != nil {
			return TaskResponse{}, fmt.Errorf("tasks: delete staged attachments: %w", err)
		}
	}

	fieldValues, err := upsertFieldValuesInTx(ctx, tx, taskRow.ID, p.FieldValues)
	if err != nil {
		return TaskResponse{}, err
	}
	if err := recordTaskChangeInTx(
		ctx, tx, taskRow.ID, p.ActorID,
		"created", "task", "Task", "created", nil,
		TaskHistoryCreatedValue{Attachments: createdHistoryAttachments},
	); err != nil {
		return TaskResponse{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return TaskResponse{}, fmt.Errorf("tasks: commit create task tx: %w", err)
	}
	return TaskResponse{TaskRow: taskRow, FieldValues: fieldValues}, nil
}

// GetTask fetches a task by ID with its custom field values.
// For top-level tasks (no parent) it also fetches the immediate subtasks.
// For subtasks it fetches the parent's public_id for breadcrumb display.
func (s *Service) GetTask(ctx context.Context, id uuid.UUID) (TaskResponse, error) {
	row, err := s.q.TaskGet(ctx, id)
	if err != nil {
		return TaskResponse{}, mapNotFound(err, "task")
	}
	task := mapTask(row)

	fvRows, err := s.q.TaskFieldValueList(ctx, id)
	if err != nil {
		return TaskResponse{}, fmt.Errorf("tasks: list field values: %w", err)
	}

	resp := TaskResponse{TaskRow: task, FieldValues: mapFieldValues(fvRows), Subtasks: []TaskSubtaskSummary{}}

	if task.ParentTaskID == nil {
		resp.Subtasks, err = s.GetSubtasks(ctx, id)
		if err != nil {
			return TaskResponse{}, err
		}
	} else {
		parent, err := s.q.TaskGet(ctx, *task.ParentTaskID)
		if err == nil {
			resp.ParentPublicID = &parent.PublicID
		}
	}

	return resp, nil
}

// GetTaskByPublicID fetches a task by public ID.
func (s *Service) GetTaskByPublicID(ctx context.Context, publicID string) (TaskResponse, error) {
	publicID = strings.TrimSpace(publicID)
	if publicID == "" {
		return TaskResponse{}, fmt.Errorf("%w: public_id is required", ErrBadRequest)
	}

	var id uuid.UUID
	if err := s.pool.QueryRow(
		ctx,
		`SELECT id FROM task WHERE public_id = $1`,
		publicID,
	).Scan(&id); err != nil {
		return TaskResponse{}, mapNotFound(err, "task")
	}
	return s.GetTask(ctx, id)
}

// FindTasksByEnumValue resolves the enum dictionary by code, matches the
// provided enum value against any historical dictionary version by exact
// case-insensitive code or name, and returns matching task snapshots ordered by
// task.updated_at DESC, task.id DESC.
//
// Missing dictionary, missing enum items, or no matching tasks all return an
// empty slice with no error. Subtasks and ParentPublicID are intentionally not
// hydrated because the integrations enum lookup only needs title, description,
// template_id, and field values.
func (s *Service) FindTasksByEnumValue(ctx context.Context, enumCode, enumValue string, limit int) ([]TaskResponse, error) {
	enumCode = strings.TrimSpace(enumCode)
	enumValue = strings.TrimSpace(enumValue)
	if enumCode == "" || enumValue == "" {
		return nil, fmt.Errorf("%w: enum_code and enum_value are required", ErrBadRequest)
	}
	if limit < 1 {
		limit = defaultEnumTaskLookupLimit
	}

	var dictID uuid.UUID
	// Match the stored code exactly after Go-side trimming so the unique index on
	// enum_dictionary.code stays usable. If legacy rows ever carry surrounding
	// spaces, they will need a data cleanup rather than a slower btrim(code) scan.
	if err := s.pool.QueryRow(ctx,
		`SELECT id
		   FROM enum_dictionary
		  WHERE code = $1`,
		enumCode,
	).Scan(&dictID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return []TaskResponse{}, nil
		}
		return nil, fmt.Errorf("tasks: find enum dictionary by code: %w", err)
	}

	rows, err := s.pool.Query(ctx, `
		SELECT DISTINCT evi.value_code
		  FROM enum_dictionary_version_item evi
		  JOIN enum_dictionary_version edv
		    ON edv.id = evi.dictionary_version_id
		 WHERE edv.dictionary_id = $1
		   AND (
		     lower(btrim(evi.value_code)) = lower($2)
		     OR lower(btrim(evi.value_name)) = lower($2)
		   )
	`, dictID, enumValue)
	if err != nil {
		return nil, fmt.Errorf("tasks: find matching enum codes: %w", err)
	}
	defer rows.Close()

	var matchedCodes []string
	for rows.Next() {
		var valueCode string
		if err := rows.Scan(&valueCode); err != nil {
			return nil, fmt.Errorf("tasks: scan matching enum code: %w", err)
		}
		matchedCodes = append(matchedCodes, valueCode)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("tasks: iterate matching enum codes: %w", err)
	}
	if len(matchedCodes) == 0 {
		return []TaskResponse{}, nil
	}

	taskRows, err := s.pool.Query(ctx, fmt.Sprintf(`
		SELECT DISTINCT %s
		  FROM task t
		  JOIN task_field_value tfv
		    ON tfv.task_id = t.id
		  JOIN task_field_definition tfd
		    ON tfd.id = tfv.field_definition_id
		 WHERE tfd.deleted_at IS NULL
		   AND tfd.enum_dictionary_id = $1
		   AND tfd.type IN ('enum', 'multi_enum')
		   AND (
		     (tfd.type = 'enum' AND tfv.value_text = ANY($2::text[]))
		     OR
		     (tfd.type = 'multi_enum' AND COALESCE(tfv.value_json, '[]'::jsonb) ?| $2::text[])
		   )
		 ORDER BY t.updated_at DESC, t.id DESC
		 LIMIT $3`, taskSelectColumns), dictID, matchedCodes, limit)
	if err != nil {
		return nil, fmt.Errorf("tasks: find tasks by enum value: %w", err)
	}
	defer taskRows.Close()

	var tasksByEnum []TaskRow
	var taskIDs []uuid.UUID
	for taskRows.Next() {
		task, err := scanOneTask(taskRows)
		if err != nil {
			return nil, fmt.Errorf("tasks: scan task by enum value: %w", err)
		}
		tasksByEnum = append(tasksByEnum, task)
		taskIDs = append(taskIDs, task.ID)
	}
	if err := taskRows.Err(); err != nil {
		return nil, fmt.Errorf("tasks: iterate tasks by enum value: %w", err)
	}
	if len(tasksByEnum) == 0 {
		return []TaskResponse{}, nil
	}

	fieldValuesByTaskID, err := s.listTaskFieldValuesByTaskIDs(ctx, taskIDs)
	if err != nil {
		return nil, err
	}

	out := make([]TaskResponse, 0, len(tasksByEnum))
	for _, task := range tasksByEnum {
		out = append(out, TaskResponse{
			TaskRow:     task,
			FieldValues: fieldValuesByTaskID[task.ID],
			Subtasks:    []TaskSubtaskSummary{},
		})
	}
	return out, nil
}

// GetTaskDescription fetches only a task description field.
func (s *Service) GetTaskDescription(ctx context.Context, id uuid.UUID) (*string, error) {
	row, err := s.q.TaskGet(ctx, id)
	if err != nil {
		return nil, mapNotFound(err, "task")
	}
	if !row.Description.Valid {
		return nil, nil
	}
	value := row.Description.String
	return &value, nil
}

// GetSubtasks returns all direct children of parentID ordered by creation time.
func (s *Service) GetSubtasks(ctx context.Context, parentID uuid.UUID) ([]TaskSubtaskSummary, error) {
	qrows, err := s.q.TaskSubtaskList(ctx, uuid.NullUUID{UUID: parentID, Valid: true})
	if err != nil {
		return nil, fmt.Errorf("tasks: get subtasks: %w", err)
	}
	assigneesByTaskID, err := s.loadSubtaskAssignees(ctx, qrows)
	if err != nil {
		return nil, err
	}
	out := make([]TaskSubtaskSummary, 0, len(qrows))
	for _, r := range qrows {
		out = append(out, TaskSubtaskSummary{
			TaskRow:   mapTask(r),
			Assignees: assigneesByTaskID[r.ID],
		})
	}
	return out, nil
}

func (s *Service) loadSubtaskAssignees(ctx context.Context, subtasks []queries.Task) (map[uuid.UUID][]TaskAssigneeSummary, error) {
	assigneesByTaskID := make(map[uuid.UUID][]TaskAssigneeSummary, len(subtasks))
	if len(subtasks) == 0 {
		return assigneesByTaskID, nil
	}

	taskIDs := make([]uuid.UUID, 0, len(subtasks))
	templateIDSet := make(map[uuid.UUID]struct{}, len(subtasks))
	templateIDByTaskID := make(map[uuid.UUID]uuid.UUID, len(subtasks))
	for _, subtask := range subtasks {
		taskIDs = append(taskIDs, subtask.ID)
		assigneesByTaskID[subtask.ID] = []TaskAssigneeSummary{}
		templateIDSet[subtask.TemplateID] = struct{}{}
		templateIDByTaskID[subtask.ID] = subtask.TemplateID
	}

	templateIDs := make([]uuid.UUID, 0, len(templateIDSet))
	for id := range templateIDSet {
		templateIDs = append(templateIDs, id)
	}

	type assigneeFieldDef struct {
		ID         uuid.UUID
		TemplateID uuid.UUID
		Type       string
	}

	fieldRows, err := s.pool.Query(ctx, `
		SELECT id, template_id, type
		FROM task_field_definition
		WHERE deleted_at IS NULL
		  AND field_role = 'assignee'
		  AND template_id = ANY($1::uuid[])
	`, uuidSliceToStrings(templateIDs))
	if err != nil {
		return nil, fmt.Errorf("tasks: list subtask assignee fields: %w", err)
	}
	defer fieldRows.Close()

	fieldDefsByTemplateID := make(map[uuid.UUID]assigneeFieldDef, len(templateIDs))
	fieldIDs := make([]uuid.UUID, 0, len(templateIDs))
	for fieldRows.Next() {
		var row assigneeFieldDef
		if err := fieldRows.Scan(&row.ID, &row.TemplateID, &row.Type); err != nil {
			return nil, fmt.Errorf("tasks: scan subtask assignee field: %w", err)
		}
		fieldDefsByTemplateID[row.TemplateID] = row
		fieldIDs = append(fieldIDs, row.ID)
	}
	if err := fieldRows.Err(); err != nil {
		return nil, fmt.Errorf("tasks: iterate subtask assignee fields: %w", err)
	}
	if len(fieldIDs) == 0 {
		return assigneesByTaskID, nil
	}

	type assigneeValueRow struct {
		TaskID            uuid.UUID
		FieldDefinitionID uuid.UUID
		ValueUserID       string
		ValueJSON         string
	}

	valueRows, err := s.pool.Query(ctx, `
		SELECT task_id,
		       field_definition_id,
		       COALESCE(value_user_id::text, ''),
		       COALESCE(value_json::text, '[]')
		FROM task_field_value
		WHERE task_id = ANY($1::uuid[])
		  AND field_definition_id = ANY($2::uuid[])
	`, uuidSliceToStrings(taskIDs), uuidSliceToStrings(fieldIDs))
	if err != nil {
		return nil, fmt.Errorf("tasks: list subtask assignee values: %w", err)
	}
	defer valueRows.Close()

	userIDSet := make(map[uuid.UUID]struct{})
	userIDsByTaskID := make(map[uuid.UUID][]uuid.UUID, len(subtasks))

	for valueRows.Next() {
		var row assigneeValueRow
		if err := valueRows.Scan(&row.TaskID, &row.FieldDefinitionID, &row.ValueUserID, &row.ValueJSON); err != nil {
			return nil, fmt.Errorf("tasks: scan subtask assignee value: %w", err)
		}

		templateID, ok := templateIDByTaskID[row.TaskID]
		if !ok {
			continue
		}
		fieldDef, found := fieldDefsByTemplateID[templateID]
		if !found || fieldDef.ID != row.FieldDefinitionID {
			continue
		}

		switch fieldDef.Type {
		case "user":
			if strings.TrimSpace(row.ValueUserID) == "" {
				continue
			}
			userID, err := uuid.Parse(row.ValueUserID)
			if err != nil {
				return nil, fmt.Errorf("tasks: parse subtask assignee user id: %w", err)
			}
			userIDsByTaskID[row.TaskID] = append(userIDsByTaskID[row.TaskID], userID)
			userIDSet[userID] = struct{}{}
		case "users":
			var rawIDs []string
			if err := json.Unmarshal([]byte(row.ValueJSON), &rawIDs); err != nil {
				return nil, fmt.Errorf("tasks: decode subtask assignee users: %w", err)
			}
			for _, rawID := range rawIDs {
				if strings.TrimSpace(rawID) == "" {
					continue
				}
				userID, err := uuid.Parse(rawID)
				if err != nil {
					return nil, fmt.Errorf("tasks: parse subtask assignee user id: %w", err)
				}
				userIDsByTaskID[row.TaskID] = append(userIDsByTaskID[row.TaskID], userID)
				userIDSet[userID] = struct{}{}
			}
		}
	}
	if err := valueRows.Err(); err != nil {
		return nil, fmt.Errorf("tasks: iterate subtask assignee values: %w", err)
	}

	if len(userIDSet) == 0 {
		return assigneesByTaskID, nil
	}

	userIDs := make([]uuid.UUID, 0, len(userIDSet))
	for id := range userIDSet {
		userIDs = append(userIDs, id)
	}

	userRows, err := s.pool.Query(ctx, `
		SELECT id, display_name, email, avatar_url,
		       custom_status_text, custom_status_emoji, custom_status_expires_at
		FROM users
		WHERE id = ANY($1::uuid[])
	`, uuidSliceToStrings(userIDs))
	if err != nil {
		return nil, fmt.Errorf("tasks: list subtask assignee users: %w", err)
	}
	defer userRows.Close()

	usersByID := make(map[uuid.UUID]TaskAssigneeSummary, len(userIDs))
	now := time.Now().UTC()
	for userRows.Next() {
		var (
			user                  TaskAssigneeSummary
			customStatusText      string
			customStatusEmoji     string
			customStatusExpiresAt sql.NullTime
		)
		if err := userRows.Scan(
			&user.ID,
			&user.DisplayName,
			&user.Email,
			&user.AvatarURL,
			&customStatusText,
			&customStatusEmoji,
			&customStatusExpiresAt,
		); err != nil {
			return nil, fmt.Errorf("tasks: scan subtask assignee user: %w", err)
		}
		user.CustomStatus = userstatus.ToBody(userstatus.ActiveFromNullTime(customStatusText, customStatusEmoji, customStatusExpiresAt, now))
		usersByID[user.ID] = user
	}
	if err := userRows.Err(); err != nil {
		return nil, fmt.Errorf("tasks: iterate subtask assignee users: %w", err)
	}

	for _, subtask := range subtasks {
		userIDsForTask := userIDsByTaskID[subtask.ID]
		if len(userIDsForTask) == 0 {
			continue
		}
		assignees := make([]TaskAssigneeSummary, 0, len(userIDsForTask))
		for _, userID := range userIDsForTask {
			user, ok := usersByID[userID]
			if !ok {
				continue
			}
			assignees = append(assignees, user)
		}
		assigneesByTaskID[subtask.ID] = assignees
	}

	return assigneesByTaskID, nil
}

// UpdateTask updates a task's system fields and replaces all field values
// (replace-all: values not in p.FieldValues are deleted).
func (s *Service) UpdateTask(ctx context.Context, id uuid.UUID, p UpdateTaskParams) (TaskResponse, error) {
	p.Title = normalizeTaskTitle(p.Title)
	p.Description = normalizeTaskDescription(p.Description)

	if p.Title == "" {
		return TaskResponse{}, fmt.Errorf("%w: title is required", ErrBadRequest)
	}

	// Load the task to get its template_id for required-field validation.
	// This also confirms the task exists before we open a transaction.
	existing, err := s.q.TaskGet(ctx, id)
	if err != nil {
		return TaskResponse{}, mapNotFound(err, "task")
	}

	defs, err := s.q.TaskFieldDefinitionListActive(ctx, existing.TemplateID)
	if err != nil {
		return TaskResponse{}, fmt.Errorf("tasks: load field definitions: %w", err)
	}
	if err := validateRequiredFields(defs, p.FieldValues); err != nil {
		return TaskResponse{}, err
	}
	if err := validateFieldValueDefinitions(defs, p.FieldValues); err != nil {
		return TaskResponse{}, err
	}
	fieldTypes := make(map[uuid.UUID]string, len(defs))
	fieldDefs := make(map[uuid.UUID]queries.TaskFieldDefinition, len(defs))
	for _, def := range defs {
		fieldTypes[def.ID] = def.Type
		fieldDefs[def.ID] = def
	}
	for i, fv := range p.FieldValues {
		p.FieldValues[i] = normalizeFieldValueInputForType(fieldTypes[fv.FieldDefinitionID], fv)
	}

	existingFieldValues, err := s.q.TaskFieldValueList(ctx, id)
	if err != nil {
		return TaskResponse{}, fmt.Errorf("tasks: list field values: %w", err)
	}
	if existing.Title == p.Title &&
		nullStringsEqual(existing.Description, normalizeTaskDescriptionNullString(p.Description)) &&
		existing.StatusID == p.StatusID &&
		taskFieldInputsEqual(existingFieldValues, p.FieldValues, fieldTypes) {
		return s.GetTask(ctx, id)
	}
	var beforeStatus, afterStatus any
	if existing.StatusID != p.StatusID {
		beforeStatus, err = s.taskHistoryStatusValue(ctx, existing.StatusID)
		if err != nil {
			return TaskResponse{}, err
		}
		afterStatus, err = s.taskHistoryStatusValue(ctx, p.StatusID)
		if err != nil {
			return TaskResponse{}, err
		}
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return TaskResponse{}, fmt.Errorf("tasks: begin update task tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Raw pgx tx query mirrors the sqlc TaskUpdate query. See CreateTask comment.
	var taskRow TaskRow
	taskRow, err = scanTask(tx.QueryRow(ctx,
		`UPDATE task
		 SET title = $2, description = $3, status_id = $4, updated_by = $5, updated_at = now()
		 WHERE id = $1
		 RETURNING `+taskColumns,
		id, p.Title, nullString(p.Description), p.StatusID, p.ActorID,
	))
	if err != nil {
		return TaskResponse{}, mapTaskWriteError(err)
	}

	updatedFieldValues, err := upsertFieldValuesInTx(ctx, tx, taskRow.ID, p.FieldValues)
	if err != nil {
		return TaskResponse{}, err
	}

	// Delete field values not present in the request (replace-all semantics).
	keepIDs := fieldDefinitionIDs(p.FieldValues)
	if _, err := tx.Exec(ctx,
		`DELETE FROM task_field_value
		 WHERE task_id = $1 AND field_definition_id != ALL($2::uuid[])`,
		taskRow.ID, keepIDs,
	); err != nil {
		return TaskResponse{}, fmt.Errorf("tasks: delete stale field values: %w", err)
	}

	beforeTask := mapTask(existing)
	if existing.Title != taskRow.Title {
		if err := recordTaskChangeInTx(
			ctx, tx, taskRow.ID, p.ActorID,
			"field", "title", "Title", "text", existing.Title, taskRow.Title,
		); err != nil {
			return TaskResponse{}, err
		}
	}
	if !nullStringsEqual(existing.Description, nullString(taskRow.Description)) {
		if err := recordTaskDescriptionChangeInTx(
			ctx, tx, taskRow.ID, p.ActorID,
			beforeTask.Description, taskRow.Description,
		); err != nil {
			return TaskResponse{}, err
		}
	}
	if existing.StatusID != taskRow.StatusID {
		if err := recordTaskChangeInTx(
			ctx, tx, taskRow.ID, p.ActorID,
			"field", "status", "Status", "status", beforeStatus, afterStatus,
		); err != nil {
			return TaskResponse{}, err
		}
	}

	beforeFields := make(map[uuid.UUID]FieldValueRow, len(existingFieldValues))
	for _, value := range existingFieldValues {
		beforeFields[value.FieldDefinitionID] = mapFieldValue(value)
	}
	afterFields := make(map[uuid.UUID]FieldValueRow, len(updatedFieldValues))
	for _, value := range updatedFieldValues {
		afterFields[value.FieldDefinitionID] = value
	}
	for fieldID, def := range fieldDefs {
		beforeValue, hadBefore := beforeFields[fieldID]
		afterValue, hasAfter := afterFields[fieldID]
		var beforePtr, afterPtr *FieldValueRow
		if hadBefore {
			beforePtr = &beforeValue
		}
		if hasAfter {
			afterPtr = &afterValue
		}
		beforeHistoryValue := taskHistoryFieldValue(def.Type, beforePtr)
		afterHistoryValue := taskHistoryFieldValue(def.Type, afterPtr)
		if taskHistoryValuesEqual(beforeHistoryValue, afterHistoryValue) {
			continue
		}
		if err := recordTaskChangeInTx(
			ctx, tx, taskRow.ID, p.ActorID,
			"field", "field:"+fieldID.String(), def.Name, def.Type,
			beforeHistoryValue, afterHistoryValue,
		); err != nil {
			return TaskResponse{}, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return TaskResponse{}, fmt.Errorf("tasks: commit update task tx: %w", err)
	}

	// Re-fetch the committed state from DB to return an accurate post-commit snapshot.
	return s.GetTask(ctx, taskRow.ID)
}

// UpdateTaskTitle updates a task title with optimistic-lock validation based
// on the last seen updated_at token.
func (s *Service) UpdateTaskTitle(ctx context.Context, id uuid.UUID, p UpdateTaskTitleParams) (TaskResponse, error) {
	title := normalizeTaskTitle(p.Title)
	if title == "" {
		return TaskResponse{}, fmt.Errorf("%w: title is required", ErrBadRequest)
	}
	if p.IfUnmodifiedSince.IsZero() {
		return TaskResponse{}, fmt.Errorf("%w: if_unmodified_since is required", ErrBadRequest)
	}
	current, err := s.q.TaskGet(ctx, id)
	if err != nil {
		return TaskResponse{}, mapNotFound(err, "task")
	}
	if current.Title == title {
		return s.GetTask(ctx, id)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return TaskResponse{}, fmt.Errorf("tasks: begin update task title tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	taskRow, err := scanTask(tx.QueryRow(ctx,
		`UPDATE task
		 SET title = $2, updated_by = $3, updated_at = now()
		 WHERE id = $1 AND updated_at = $4
		 RETURNING `+taskColumns,
		id, title, p.ActorID, p.IfUnmodifiedSince,
	))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			latest, getErr := s.q.TaskGet(ctx, id)
			if getErr != nil {
				return TaskResponse{}, mapNotFound(getErr, "task")
			}
			return TaskResponse{}, &TaskTitleConflictError{
				LatestTitle:     latest.Title,
				LatestUpdatedAt: latest.UpdatedAt,
			}
		}
		return TaskResponse{}, mapTaskWriteError(err)
	}
	if err := recordTaskChangeInTx(
		ctx, tx, taskRow.ID, p.ActorID,
		"field", "title", "Title", "text", current.Title, taskRow.Title,
	); err != nil {
		return TaskResponse{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return TaskResponse{}, fmt.Errorf("tasks: commit update task title tx: %w", err)
	}
	return s.GetTask(ctx, taskRow.ID)
}

// UpdateTaskDescription updates only task description and touch columns.
func (s *Service) UpdateTaskDescription(ctx context.Context, id uuid.UUID, p UpdateTaskDescriptionParams) (TaskResponse, error) {
	p.Description = normalizeTaskDescription(p.Description)

	current, err := s.q.TaskGet(ctx, id)
	if err != nil {
		return TaskResponse{}, mapNotFound(err, "task")
	}
	if nullStringsEqual(current.Description, normalizeTaskDescriptionNullString(p.Description)) {
		return s.GetTask(ctx, id)
	}
	beforeTask := mapTask(current)

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return TaskResponse{}, fmt.Errorf("tasks: begin update task description tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	taskRow, err := scanTask(tx.QueryRow(ctx,
		`UPDATE task
		 SET description = $2, updated_by = $3, updated_at = now()
		 WHERE id = $1
		 RETURNING `+taskColumns,
		id, nullString(p.Description), p.ActorID,
	))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return TaskResponse{}, fmt.Errorf("%w: task", ErrNotFound)
		}
		return TaskResponse{}, mapTaskWriteError(err)
	}
	if err := s.maybeCreateTaskDescriptionSnapshotInTx(ctx, tx, taskRow, p.ActorID, p.ForceSnapshot); err != nil {
		return TaskResponse{}, err
	}
	if err := recordTaskDescriptionChangeInTx(
		ctx, tx, taskRow.ID, p.ActorID,
		beforeTask.Description, taskRow.Description,
	); err != nil {
		return TaskResponse{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return TaskResponse{}, fmt.Errorf("tasks: commit update task description tx: %w", err)
	}

	return s.GetTask(ctx, taskRow.ID)
}

// ListTaskDescriptionHistory returns latest description snapshots for a task.
func (s *Service) ListTaskDescriptionHistory(ctx context.Context, id uuid.UUID) ([]TaskDescriptionHistoryItem, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT h.public_id, h.title, h.description, h.edited_by, h.created_at,
		        u.id, u.display_name, u.avatar_url,
		        u.custom_status_text, u.custom_status_emoji, u.custom_status_expires_at
		   FROM task t
		   LEFT JOIN task_description_history h ON h.public_id = t.public_id
		   LEFT JOIN users u ON u.id = h.edited_by
		  WHERE t.id = $1
		  ORDER BY h.created_at DESC NULLS LAST
		  LIMIT $2`,
		id, s.descriptionHistoryLimit,
	)
	if err != nil {
		return nil, fmt.Errorf("tasks: list description history: %w", err)
	}
	defer rows.Close()

	out := make([]TaskDescriptionHistoryItem, 0)
	hasTask := false
	for rows.Next() {
		var (
			publicID      sql.NullString
			title         sql.NullString
			desc          sql.NullString
			editedBy      uuid.NullUUID
			createdAt     sql.NullTime
			editorID      uuid.NullUUID
			editorName    sql.NullString
			editorAvatar  sql.NullString
			statusText    sql.NullString
			statusEmoji   sql.NullString
			statusExpires sql.NullTime
		)
		if err := rows.Scan(
			&publicID,
			&title,
			&desc,
			&editedBy,
			&createdAt,
			&editorID,
			&editorName,
			&editorAvatar,
			&statusText,
			&statusEmoji,
			&statusExpires,
		); err != nil {
			return nil, fmt.Errorf("tasks: scan description history row: %w", err)
		}
		hasTask = true
		// LEFT JOIN keeps one row when task exists but has no snapshots yet.
		if !publicID.Valid {
			continue
		}
		item := TaskDescriptionHistoryItem{
			PublicID:  publicID.String,
			Title:     title.String,
			EditedBy:  editedBy.UUID,
			CreatedAt: createdAt.Time,
			Editor: TaskDescriptionHistoryEditor{
				ID:           editorID.UUID,
				DisplayName:  editorName.String,
				AvatarURL:    editorAvatar.String,
				CustomStatus: userstatus.ToBody(userstatus.ActiveFromNullTime(statusText.String, statusEmoji.String, statusExpires, time.Now().UTC())),
			},
		}
		if desc.Valid {
			description := desc.String
			item.Description = &description
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("tasks: iterate description history rows: %w", err)
	}
	if !hasTask {
		return nil, fmt.Errorf("%w: task", ErrNotFound)
	}
	return out, nil
}

func (s *Service) maybeCreateTaskDescriptionSnapshotInTx(
	ctx context.Context,
	tx pgx.Tx,
	task TaskRow,
	actorID uuid.UUID,
	force bool,
) error {
	var (
		latestDescription sql.NullString
		latestRecent      bool
	)
	err := tx.QueryRow(ctx,
		`SELECT description,
		        created_at > (now() - interval '30 seconds') AS is_recent
		   FROM task_description_history
		  WHERE public_id = $1
		  ORDER BY created_at DESC, id DESC
		  LIMIT 1`,
		task.PublicID,
	).Scan(&latestDescription, &latestRecent)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("tasks: load latest description snapshot: %w", err)
	}
	hasLatest := err == nil
	nextDescription := nullString(task.Description)

	// Skip exact duplicates even in force mode: restoring to the already-latest
	// snapshot content should not create another adjacent copy.
	if hasLatest && nullStringsEqual(nextDescription, latestDescription) {
		return nil
	}
	if hasLatest && latestRecent && !force {
		return nil
	}

	if _, err := tx.Exec(ctx,
		`INSERT INTO task_description_history (public_id, title, description, edited_by)
		 VALUES ($1, $2, $3, $4)`,
		task.PublicID, task.Title, nextDescription, actorID,
	); err != nil {
		return fmt.Errorf("tasks: insert description snapshot: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`WITH ranked AS (
		     SELECT id,
		            row_number() OVER (ORDER BY created_at DESC, id DESC) AS rn
		       FROM task_description_history
		      WHERE public_id = $1
		  )
		  DELETE FROM task_description_history h
		   USING ranked r
		  WHERE h.id = r.id
		    AND r.rn > $2`,
		task.PublicID, s.descriptionHistoryLimit,
	); err != nil {
		return fmt.Errorf("tasks: prune description snapshots: %w", err)
	}
	return nil
}

type taskHistoryCursor struct {
	CreatedAt time.Time `json:"created_at"`
	ID        uuid.UUID `json:"id"`
}

func encodeTaskHistoryCursor(createdAt time.Time, id uuid.UUID) (string, error) {
	raw, err := json.Marshal(taskHistoryCursor{CreatedAt: createdAt, ID: id})
	if err != nil {
		return "", fmt.Errorf("tasks: encode history cursor: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func decodeTaskHistoryCursor(raw string) (*taskHistoryCursor, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid history cursor", ErrBadRequest)
	}
	var cursor taskHistoryCursor
	if err := json.Unmarshal(decoded, &cursor); err != nil || cursor.CreatedAt.IsZero() || cursor.ID == uuid.Nil {
		return nil, fmt.Errorf("%w: invalid history cursor", ErrBadRequest)
	}
	return &cursor, nil
}

func taskHistoryJSON(value any) (json.RawMessage, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("tasks: encode history value: %w", err)
	}
	return raw, nil
}

func recordTaskChangeInTx(
	ctx context.Context,
	tx pgx.Tx,
	taskID, actorID uuid.UUID,
	changeKind, fieldKey, fieldName, fieldType string,
	before, after any,
) error {
	beforeJSON, err := taskHistoryJSON(before)
	if err != nil {
		return err
	}
	afterJSON, err := taskHistoryJSON(after)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO task_change_history
		    (task_id, actor_id, change_kind, field_key, field_name, field_type, before_value, after_value)
		 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)`,
		taskID, actorID, changeKind, fieldKey, fieldName, fieldType,
		string(beforeJSON), string(afterJSON),
	); err != nil {
		return fmt.Errorf("tasks: insert task history: %w", err)
	}
	return nil
}

// recordTaskDescriptionChangeInTx coalesces rapid saves from the same editor
// into one provisional history item. The newest description change is locked
// before it is inspected, so another editor's intervening change is never
// overwritten or merged into a different editor's entry.
func recordTaskDescriptionChangeInTx(
	ctx context.Context,
	tx pgx.Tx,
	taskID, actorID uuid.UUID,
	before, after any,
) error {
	var (
		latestID       uuid.UUID
		latestForActor bool
	)
	err := tx.QueryRow(ctx,
		`SELECT id,
		        actor_id = $2 AND created_at > now() - INTERVAL '10 seconds'
		   FROM task_change_history
		  WHERE task_id = $1 AND field_key = 'description'
		  ORDER BY created_at DESC, id DESC
		  LIMIT 1
		  FOR UPDATE`,
		taskID, actorID,
	).Scan(&latestID, &latestForActor)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("tasks: get pending description history: %w", err)
	}
	if err == nil && latestForActor {
		afterJSON, err := taskHistoryJSON(after)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`UPDATE task_change_history
			    SET after_value = $2::jsonb, created_at = now()
			  WHERE id = $1`,
			latestID, string(afterJSON),
		); err != nil {
			return fmt.Errorf("tasks: update pending description history: %w", err)
		}
		return nil
	}

	return recordTaskChangeInTx(
		ctx, tx, taskID, actorID,
		"field", "description", "Description", "markdown", before, after,
	)
}

func taskHistoryFieldValue(fieldType string, value *FieldValueRow) any {
	if value == nil {
		return nil
	}
	switch fieldType {
	case "text", "enum":
		if value.ValueText == nil {
			return nil
		}
		return *value.ValueText
	case "number":
		if value.ValueNumber == nil {
			return nil
		}
		return *value.ValueNumber
	case "date":
		if value.ValueDate == nil {
			return nil
		}
		return *value.ValueDate
	case "datetime":
		if value.ValueDatetime == nil {
			return nil
		}
		return value.ValueDatetime.UTC().Format(time.RFC3339Nano)
	case "user":
		if value.ValueUserID == nil {
			return nil
		}
		return value.ValueUserID.String()
	case "users", "multi_enum":
		if len(value.ValueJSON) == 0 {
			return nil
		}
		var decoded any
		if err := json.Unmarshal(value.ValueJSON, &decoded); err != nil {
			return string(value.ValueJSON)
		}
		return decoded
	default:
		return nil
	}
}

func taskHistoryValuesEqual(left, right any) bool {
	leftJSON, leftErr := taskHistoryJSON(left)
	rightJSON, rightErr := taskHistoryJSON(right)
	return leftErr == nil && rightErr == nil && bytes.Equal(leftJSON, rightJSON)
}

func (s *Service) taskHistoryStatusValue(ctx context.Context, id uuid.UUID) (any, error) {
	status, err := s.q.TaskStatusGet(ctx, id)
	if err != nil {
		return nil, mapNotFound(err, "status")
	}
	return map[string]string{
		"id":   status.ID.String(),
		"name": status.Name,
	}, nil
}

// ListTaskChangeHistory returns a newest-first page of full task history.
func (s *Service) ListTaskChangeHistory(
	ctx context.Context,
	taskID uuid.UUID,
	cursorRaw string,
	limit int,
) (TaskChangeHistoryPage, error) {
	if _, err := s.q.TaskGet(ctx, taskID); err != nil {
		return TaskChangeHistoryPage{}, mapNotFound(err, "task")
	}
	cursor, err := decodeTaskHistoryCursor(cursorRaw)
	if err != nil {
		return TaskChangeHistoryPage{}, err
	}
	if limit < 1 {
		limit = 50
	}
	if limit > 100 {
		limit = 100
	}

	args := []any{taskID, limit + 1}
	where := "h.task_id = $1 AND (h.field_key <> 'description' OR h.created_at <= now() - INTERVAL '10 seconds')"
	if cursor != nil {
		args = []any{taskID, cursor.CreatedAt, cursor.ID, limit + 1}
		where += " AND (h.created_at, h.id) < ($2, $3)"
	}
	rows, err := s.pool.Query(ctx,
		`SELECT h.id, h.change_kind, h.field_key, h.field_name, h.field_type,
		        h.before_value, h.after_value, h.created_at,
		        u.id, u.display_name, u.avatar_url,
		        u.custom_status_text, u.custom_status_emoji, u.custom_status_expires_at
		   FROM task_change_history h
		   JOIN users u ON u.id = h.actor_id
		  WHERE `+where+`
		  ORDER BY h.created_at DESC, h.id DESC
		  LIMIT $`+fmt.Sprint(len(args)),
		args...,
	)
	if err != nil {
		return TaskChangeHistoryPage{}, fmt.Errorf("tasks: list task history: %w", err)
	}
	defer rows.Close()

	items := make([]TaskChangeHistoryItem, 0, limit+1)
	now := time.Now().UTC()
	for rows.Next() {
		var (
			item                                TaskChangeHistoryItem
			customStatusText, customStatusEmoji string
			customStatusExpiresAt               sql.NullTime
		)
		if err := rows.Scan(
			&item.ID, &item.ChangeKind, &item.FieldKey, &item.FieldName, &item.FieldType,
			&item.BeforeValue, &item.AfterValue, &item.CreatedAt,
			&item.Actor.ID, &item.Actor.DisplayName, &item.Actor.AvatarURL,
			&customStatusText, &customStatusEmoji, &customStatusExpiresAt,
		); err != nil {
			return TaskChangeHistoryPage{}, fmt.Errorf("tasks: scan task history: %w", err)
		}
		item.Actor.CustomStatus = userstatus.ToBody(userstatus.ActiveFromNullTime(
			customStatusText, customStatusEmoji, customStatusExpiresAt, now,
		))
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return TaskChangeHistoryPage{}, fmt.Errorf("tasks: iterate task history: %w", err)
	}

	page := TaskChangeHistoryPage{Items: items}
	if len(items) > limit {
		last := items[limit-1]
		next, err := encodeTaskHistoryCursor(last.CreatedAt, last.ID)
		if err != nil {
			return TaskChangeHistoryPage{}, err
		}
		page.Items = items[:limit]
		page.NextCursor = next
	}
	return page, nil
}

// UpdateTaskStatusParams carries inputs for a status-only task update.
type UpdateTaskStatusParams struct {
	StatusID uuid.UUID
	ActorID  uuid.UUID
}

// UpdateTaskStatus updates only a task status (plus audit/system fields).
// It returns the updated TaskResponse and the status ID that was in effect before the change.
func (s *Service) UpdateTaskStatus(ctx context.Context, id uuid.UUID, p UpdateTaskStatusParams) (TaskResponse, uuid.UUID, error) {
	before, err := s.q.TaskGet(ctx, id)
	if err != nil {
		return TaskResponse{}, uuid.UUID{}, mapNotFound(err, "task")
	}
	previousStatusID := before.StatusID
	if before.StatusID == p.StatusID {
		resp, err := s.GetTask(ctx, id)
		return resp, previousStatusID, err
	}
	beforeStatus, err := s.taskHistoryStatusValue(ctx, before.StatusID)
	if err != nil {
		return TaskResponse{}, uuid.UUID{}, err
	}
	afterStatus, err := s.taskHistoryStatusValue(ctx, p.StatusID)
	if err != nil {
		return TaskResponse{}, uuid.UUID{}, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return TaskResponse{}, uuid.UUID{}, fmt.Errorf("tasks: begin update task status tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	taskRow, err := scanTask(tx.QueryRow(ctx,
		`UPDATE task
		 SET status_id = $2, updated_by = $3, updated_at = now()
		 WHERE id = $1
		 RETURNING `+taskColumns,
		id, p.StatusID, p.ActorID,
	))
	if err != nil {
		return TaskResponse{}, uuid.UUID{}, mapTaskWriteError(err)
	}
	if err := recordTaskChangeInTx(
		ctx, tx, taskRow.ID, p.ActorID,
		"field", "status", "Status", "status", beforeStatus, afterStatus,
	); err != nil {
		return TaskResponse{}, uuid.UUID{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return TaskResponse{}, uuid.UUID{}, fmt.Errorf("tasks: commit update task status tx: %w", err)
	}

	resp, err := s.GetTask(ctx, taskRow.ID)
	return resp, previousStatusID, err
}

// UpdateTaskFieldValueParams carries inputs for a single custom field update.
type UpdateTaskFieldValueParams struct {
	ValueText        *string
	ValueNumber      *string
	ValueUserID      *uuid.UUID
	ValueDate        *string
	ValueDatetime    *time.Time
	ValueJSON        json.RawMessage
	EnumDictionaryID *uuid.UUID
	EnumVersion      *int32
	ActorID          uuid.UUID
}

// UpdateTaskFieldValue updates exactly one custom field value for a task.
func (s *Service) UpdateTaskFieldValue(
	ctx context.Context,
	taskID, fieldDefinitionID uuid.UUID,
	p UpdateTaskFieldValueParams,
) (FieldValueRow, error) {
	task, err := s.q.TaskGet(ctx, taskID)
	if err != nil {
		return FieldValueRow{}, mapNotFound(err, "task")
	}

	def, err := s.q.TaskFieldGet(ctx, queries.TaskFieldGetParams{
		TemplateID: task.TemplateID,
		ID:         fieldDefinitionID,
	})
	if err != nil {
		return FieldValueRow{}, mapNotFound(err, "field")
	}

	if err := validateSingleFieldValueInput(def.Type, p); err != nil {
		return FieldValueRow{}, err
	}
	p = normalizeSingleFieldValueInput(def.Type, p)
	existingFieldValue, found, err := s.getTaskFieldValue(ctx, taskID, fieldDefinitionID)
	if err != nil {
		return FieldValueRow{}, err
	}
	incoming := comparableFieldValueFromInput(singleFieldUpdateInput(fieldDefinitionID, p))
	if found && comparableFieldValuesEqual(comparableFieldValueFromStored(existingFieldValue), incoming) {
		return mapFieldValue(existingFieldValue), nil
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return FieldValueRow{}, fmt.Errorf("tasks: begin update task field tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	fv, err := upsertOneFieldValue(ctx, tx, taskID, FieldValueInput{
		FieldDefinitionID: fieldDefinitionID,
		ValueText:         p.ValueText,
		ValueNumber:       p.ValueNumber,
		ValueUserID:       p.ValueUserID,
		ValueDate:         p.ValueDate,
		ValueDatetime:     p.ValueDatetime,
		ValueJSON:         p.ValueJSON,
		EnumDictionaryID:  p.EnumDictionaryID,
		EnumVersion:       p.EnumVersion,
	})
	if err != nil {
		return FieldValueRow{}, err
	}
	var beforeValue *FieldValueRow
	if found {
		mapped := mapFieldValue(existingFieldValue)
		beforeValue = &mapped
	}
	beforeHistoryValue := taskHistoryFieldValue(def.Type, beforeValue)
	afterHistoryValue := taskHistoryFieldValue(def.Type, &fv)
	if !taskHistoryValuesEqual(beforeHistoryValue, afterHistoryValue) {
		if err := recordTaskChangeInTx(
			ctx, tx, taskID, p.ActorID,
			"field", "field:"+fieldDefinitionID.String(), def.Name, def.Type,
			beforeHistoryValue, afterHistoryValue,
		); err != nil {
			return FieldValueRow{}, err
		}
	}

	if _, err := tx.Exec(ctx,
		`UPDATE task SET updated_by = $2, updated_at = now() WHERE id = $1`,
		taskID, p.ActorID,
	); err != nil {
		return FieldValueRow{}, fmt.Errorf("tasks: touch task on field update: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return FieldValueRow{}, fmt.Errorf("tasks: commit update task field tx: %w", err)
	}

	return fv, nil
}

func validateSingleFieldValueInput(fieldType string, p UpdateTaskFieldValueParams) error {
	hasText := p.ValueText != nil
	hasNumber := p.ValueNumber != nil
	hasUser := p.ValueUserID != nil
	hasDate := p.ValueDate != nil
	hasDatetime := p.ValueDatetime != nil
	hasJSON := len(p.ValueJSON) > 0 && !bytes.Equal(bytes.TrimSpace(p.ValueJSON), []byte("null"))
	hasEnumMeta := p.EnumDictionaryID != nil || p.EnumVersion != nil

	switch fieldType {
	case "text":
		if hasNumber || hasUser || hasDate || hasDatetime || hasJSON || hasEnumMeta {
			return fmt.Errorf("%w: invalid payload for text field", ErrBadRequest)
		}
	case "number":
		if hasText || hasUser || hasDate || hasDatetime || hasJSON || hasEnumMeta {
			return fmt.Errorf("%w: invalid payload for number field", ErrBadRequest)
		}
	case "date":
		if hasText || hasNumber || hasUser || hasDatetime || hasJSON || hasEnumMeta {
			return fmt.Errorf("%w: invalid payload for date field", ErrBadRequest)
		}
	case "datetime":
		if hasText || hasNumber || hasUser || hasDate || hasJSON || hasEnumMeta {
			return fmt.Errorf("%w: invalid payload for datetime field", ErrBadRequest)
		}
	case "user":
		if hasText || hasNumber || hasDate || hasDatetime || hasJSON || hasEnumMeta {
			return fmt.Errorf("%w: invalid payload for user field", ErrBadRequest)
		}
	case "users":
		if hasText || hasNumber || hasUser || hasDate || hasDatetime || hasEnumMeta {
			return fmt.Errorf("%w: invalid payload for users field", ErrBadRequest)
		}
		if len(p.ValueJSON) == 0 {
			p.ValueJSON = json.RawMessage("[]")
		}
		if err := validateJSONArrayOfStrings(p.ValueJSON); err != nil {
			return err
		}
	case "enum":
		if hasNumber || hasUser || hasDate || hasDatetime || hasJSON {
			return fmt.Errorf("%w: invalid payload for enum field", ErrBadRequest)
		}
	case "multi_enum":
		if hasText || hasNumber || hasUser || hasDate || hasDatetime {
			return fmt.Errorf("%w: invalid payload for multi_enum field", ErrBadRequest)
		}
		if len(p.ValueJSON) == 0 {
			p.ValueJSON = json.RawMessage("[]")
		}
		if err := validateJSONArrayOfStrings(p.ValueJSON); err != nil {
			return err
		}
	default:
		return fmt.Errorf("%w: unsupported field type %q", ErrBadRequest, fieldType)
	}

	return nil
}

func normalizeSingleFieldValueInput(fieldType string, p UpdateTaskFieldValueParams) UpdateTaskFieldValueParams {
	switch fieldType {
	case "users", "multi_enum":
		if len(bytes.TrimSpace(p.ValueJSON)) == 0 || bytes.Equal(bytes.TrimSpace(p.ValueJSON), []byte("null")) {
			p.ValueJSON = json.RawMessage("[]")
		}
	}
	return p
}

func validateJSONArrayOfStrings(raw json.RawMessage) error {
	if len(raw) == 0 {
		return fmt.Errorf("%w: value_json must be a JSON array", ErrBadRequest)
	}
	var arr []string
	if err := json.Unmarshal(raw, &arr); err != nil {
		return fmt.Errorf("%w: value_json must be an array of strings", ErrBadRequest)
	}
	return nil
}

// =========================================================
// Task helpers
// =========================================================

// taskColumns is the explicit column list for task RETURNING / SELECT clauses.
// Explicit enumeration prevents silent column-order breakage if the schema
// gains new columns. Must stay in sync with scanTask's Scan call.
const taskColumns = `id, public_id, template_id, discussion_channel_id, template_snapshot_prefix, sequence_number,
	title, description, status_id, parent_task_id,
	created_by, updated_by, created_at, updated_at`

// validateRequiredFields checks that every required active field is present and
// carries at least one non-nil value column. A FieldValueInput that references a
// required field but has all value columns nil is treated as missing.
func validateRequiredFields(defs []queries.TaskFieldDefinition, inputs []FieldValueInput) error {
	provided := make(map[uuid.UUID]FieldValueInput, len(inputs))
	for _, fv := range inputs {
		provided[fv.FieldDefinitionID] = fv
	}
	for _, def := range defs {
		if !def.Required {
			continue
		}
		fv, ok := provided[def.ID]
		if !ok {
			return fmt.Errorf("%w: required field %q is missing", ErrBadRequest, def.Code)
		}
		if !fieldValueInputHasValue(fv) {
			return fmt.Errorf("%w: required field %q has no value", ErrBadRequest, def.Code)
		}
	}
	return nil
}

// fieldValueInputHasValue returns true when at least one value column is set.
func fieldValueInputHasValue(fv FieldValueInput) bool {
	return fv.ValueText != nil ||
		fv.ValueNumber != nil ||
		fv.ValueUserID != nil ||
		fv.ValueDate != nil ||
		fv.ValueDatetime != nil ||
		(len(fv.ValueJSON) > 0 && string(fv.ValueJSON) != "null")
}

// upsertFieldValuesInTx persists each FieldValueInput inside an open pgx transaction.
func upsertFieldValuesInTx(ctx context.Context, tx pgx.Tx, taskID uuid.UUID, inputs []FieldValueInput) ([]FieldValueRow, error) {
	out := make([]FieldValueRow, 0, len(inputs))
	for _, fv := range inputs {
		row, err := upsertOneFieldValue(ctx, tx, taskID, fv)
		if err != nil {
			return nil, fmt.Errorf("tasks: upsert field %s: %w", fv.FieldDefinitionID, err)
		}
		out = append(out, row)
	}
	return out, nil
}

func upsertOneFieldValue(ctx context.Context, tx pgx.Tx, taskID uuid.UUID, fv FieldValueInput) (FieldValueRow, error) {
	var rawJSON pqtype.NullRawMessage
	if len(fv.ValueJSON) > 0 && string(fv.ValueJSON) != "null" {
		rawJSON = pqtype.NullRawMessage{RawMessage: fv.ValueJSON, Valid: true}
	}

	var row FieldValueRow
	err := tx.QueryRow(ctx, `
		INSERT INTO task_field_value
		    (task_id, field_definition_id, value_text, value_number, value_user_id,
		     value_date, value_datetime, value_json, enum_dictionary_id, enum_version)
		VALUES ($1, $2, $3, $4::numeric, $5, $6::date, $7, $8, $9, $10)
		ON CONFLICT (task_id, field_definition_id) DO UPDATE SET
		    value_text         = EXCLUDED.value_text,
		    value_number       = EXCLUDED.value_number,
		    value_user_id      = EXCLUDED.value_user_id,
		    value_date         = EXCLUDED.value_date,
		    value_datetime     = EXCLUDED.value_datetime,
		    value_json         = EXCLUDED.value_json,
		    enum_dictionary_id = EXCLUDED.enum_dictionary_id,
		    enum_version       = EXCLUDED.enum_version,
		    updated_at         = now()
		RETURNING id, task_id, field_definition_id,
		          value_text, value_number::text, value_user_id,
		          value_date::text, value_datetime, value_json,
		          enum_dictionary_id, enum_version,
		          created_at, updated_at`,
		taskID,
		fv.FieldDefinitionID,
		nullString(fv.ValueText),
		nullString(fv.ValueNumber),
		nullUUID(fv.ValueUserID),
		nullString(fv.ValueDate),
		fv.ValueDatetime,
		rawJSON,
		nullUUID(fv.EnumDictionaryID),
		nullInt32Ptr(fv.EnumVersion),
	).Scan(
		&row.ID, &row.TaskID, &row.FieldDefinitionID,
		&row.ValueText, &row.ValueNumber, &row.ValueUserID,
		&row.ValueDate, &row.ValueDatetime, &row.ValueJSON,
		&row.EnumDictionaryID, &row.EnumVersion,
		&row.CreatedAt, &row.UpdatedAt,
	)
	if err != nil {
		return FieldValueRow{}, mapTaskWriteError(err)
	}
	return row, nil
}

func (s *Service) getTaskFieldValue(ctx context.Context, taskID, fieldDefinitionID uuid.UUID) (queries.TaskFieldValue, bool, error) {
	var row queries.TaskFieldValue
	err := s.pool.QueryRow(ctx,
		`SELECT id, task_id, field_definition_id,
		        value_text, value_number, value_user_id,
		        value_date, value_datetime, value_json,
		        enum_dictionary_id, enum_version,
		        created_at, updated_at
		   FROM task_field_value
		  WHERE task_id = $1 AND field_definition_id = $2`,
		taskID, fieldDefinitionID,
	).Scan(
		&row.ID, &row.TaskID, &row.FieldDefinitionID,
		&row.ValueText, &row.ValueNumber, &row.ValueUserID,
		&row.ValueDate, &row.ValueDatetime, &row.ValueJson,
		&row.EnumDictionaryID, &row.EnumVersion,
		&row.CreatedAt, &row.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return queries.TaskFieldValue{}, false, nil
		}
		return queries.TaskFieldValue{}, false, fmt.Errorf("tasks: get task field value: %w", err)
	}
	return row, true, nil
}

func (s *Service) listTaskFieldValuesByTaskIDs(ctx context.Context, taskIDs []uuid.UUID) (map[uuid.UUID][]FieldValueRow, error) {
	valuesByTaskID := make(map[uuid.UUID][]FieldValueRow, len(taskIDs))
	if len(taskIDs) == 0 {
		return valuesByTaskID, nil
	}
	for _, taskID := range taskIDs {
		valuesByTaskID[taskID] = []FieldValueRow{}
	}

	rows, err := s.pool.Query(ctx, `
		SELECT id, task_id, field_definition_id,
		       value_text, value_number, value_user_id,
		       value_date, value_datetime, value_json,
		       enum_dictionary_id, enum_version,
		       created_at, updated_at
		  FROM task_field_value
		 WHERE task_id = ANY($1::uuid[])
		 ORDER BY task_id ASC, field_definition_id ASC
	`, uuidSliceToStrings(taskIDs))
	if err != nil {
		return nil, fmt.Errorf("tasks: list field values by task ids: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var row queries.TaskFieldValue
		if err := rows.Scan(
			&row.ID, &row.TaskID, &row.FieldDefinitionID,
			&row.ValueText, &row.ValueNumber, &row.ValueUserID,
			&row.ValueDate, &row.ValueDatetime, &row.ValueJson,
			&row.EnumDictionaryID, &row.EnumVersion,
			&row.CreatedAt, &row.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("tasks: scan field value by task ids: %w", err)
		}
		valuesByTaskID[row.TaskID] = append(valuesByTaskID[row.TaskID], mapFieldValue(row))
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("tasks: iterate field values by task ids: %w", err)
	}
	return valuesByTaskID, nil
}

// scanner is the minimal interface shared by pgx.Row and pgx.Rows.
type scanner interface {
	Scan(dest ...any) error
}

// scanOneTask scans the taskSelectColumns columns from any scanner (pgx.Row or
// pgx.Rows). It is the single source of truth for task column order; both
// scanTask (single RETURNING row) and the ListTasks rows loop call it.
func scanOneTask(s scanner) (TaskRow, error) {
	var (
		id, templateID, statusID, createdBy, updatedBy uuid.UUID
		publicID, snapshotPrefix, title                string
		description                                    sql.NullString
		discussionChannelID, parentTaskID              uuid.NullUUID
		seqNum                                         int64
		createdAt, updatedAt                           time.Time
	)
	if err := s.Scan(
		&id, &publicID, &templateID, &discussionChannelID, &snapshotPrefix, &seqNum,
		&title, &description, &statusID,
		&parentTaskID, &createdBy, &updatedBy,
		&createdAt, &updatedAt,
	); err != nil {
		return TaskRow{}, err
	}
	t := TaskRow{
		ID:                     id,
		PublicID:               publicID,
		TemplateID:             templateID,
		TemplateSnapshotPrefix: snapshotPrefix,
		SequenceNumber:         seqNum,
		Title:                  title,
		StatusID:               statusID,
		CreatedBy:              createdBy,
		UpdatedBy:              updatedBy,
		CreatedAt:              createdAt,
		UpdatedAt:              updatedAt,
	}
	if description.Valid {
		t.Description = &description.String
	}
	if discussionChannelID.Valid {
		t.DiscussionChannelID = &discussionChannelID.UUID
	}
	if parentTaskID.Valid {
		t.ParentTaskID = &parentTaskID.UUID
	}
	return t, nil
}

// scanTask wraps scanOneTask for the single-row (RETURNING) case.
func scanTask(row pgx.Row) (TaskRow, error) {
	return scanOneTask(row)
}

// scanOneTaskWithTotal scans taskSelectColumns followed by the window-
// function column status_total in one Scan call.  Used by the ListTasks rows
// loop where the SELECT list is taskSelectColumns + status_total.
func scanOneTaskWithTotal(s scanner, statusTotal *int) (TaskRow, error) {
	var (
		id, templateID, statusID, createdBy, updatedBy uuid.UUID
		publicID, snapshotPrefix, title                string
		description                                    sql.NullString
		discussionChannelID, parentTaskID              uuid.NullUUID
		seqNum                                         int64
		createdAt, updatedAt                           time.Time
	)
	if err := s.Scan(
		&id, &publicID, &templateID, &discussionChannelID, &snapshotPrefix, &seqNum,
		&title, &description, &statusID,
		&parentTaskID, &createdBy, &updatedBy,
		&createdAt, &updatedAt,
		statusTotal,
	); err != nil {
		return TaskRow{}, err
	}
	t := TaskRow{
		ID:                     id,
		PublicID:               publicID,
		TemplateID:             templateID,
		TemplateSnapshotPrefix: snapshotPrefix,
		SequenceNumber:         seqNum,
		Title:                  title,
		StatusID:               statusID,
		CreatedBy:              createdBy,
		UpdatedBy:              updatedBy,
		CreatedAt:              createdAt,
		UpdatedAt:              updatedAt,
	}
	if description.Valid {
		t.Description = &description.String
	}
	if discussionChannelID.Valid {
		t.DiscussionChannelID = &discussionChannelID.UUID
	}
	if parentTaskID.Valid {
		t.ParentTaskID = &parentTaskID.UUID
	}
	return t, nil
}

// fieldDefinitionIDs extracts the FieldDefinitionID from each input.
func fieldDefinitionIDs(inputs []FieldValueInput) []uuid.UUID {
	ids := make([]uuid.UUID, 0, len(inputs))
	for _, fv := range inputs {
		ids = append(ids, fv.FieldDefinitionID)
	}
	return ids
}

// mapTaskWriteError maps DB errors to service errors.
func mapTaskWriteError(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("%w: task", ErrNotFound)
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case pgErrCheckViolation:
			return fmt.Errorf("%w: %s", ErrBadRequest, pgErr.Message)
		case "23503":
			return fmt.Errorf("%w: %s", ErrBadRequest, pgErr.Message)
		case "23505":
			return fmt.Errorf("%w: %s", ErrConflict, pgErr.Message)
		}
	}
	return fmt.Errorf("tasks: %w", err)
}

// ---- Mappers: queries → domain types ----

func mapTask(r queries.Task) TaskRow {
	t := TaskRow{
		ID:                     r.ID,
		PublicID:               r.PublicID,
		TemplateID:             r.TemplateID,
		TemplateSnapshotPrefix: r.TemplateSnapshotPrefix,
		SequenceNumber:         r.SequenceNumber,
		Title:                  r.Title,
		StatusID:               r.StatusID,
		CreatedBy:              r.CreatedBy,
		UpdatedBy:              r.UpdatedBy,
		CreatedAt:              r.CreatedAt,
		UpdatedAt:              r.UpdatedAt,
	}
	if r.Description.Valid {
		t.Description = &r.Description.String
	}
	if r.DiscussionChannelID.Valid {
		t.DiscussionChannelID = &r.DiscussionChannelID.UUID
	}
	if r.ParentTaskID.Valid {
		t.ParentTaskID = &r.ParentTaskID.UUID
	}
	return t
}

func mapFieldValue(r queries.TaskFieldValue) FieldValueRow {
	fv := FieldValueRow{
		ID:                r.ID,
		TaskID:            r.TaskID,
		FieldDefinitionID: r.FieldDefinitionID,
		CreatedAt:         r.CreatedAt,
		UpdatedAt:         r.UpdatedAt,
	}
	if r.ValueText.Valid {
		fv.ValueText = &r.ValueText.String
	}
	if r.ValueNumber.Valid {
		fv.ValueNumber = &r.ValueNumber.String
	}
	if r.ValueUserID.Valid {
		fv.ValueUserID = &r.ValueUserID.UUID
	}
	if r.ValueDate.Valid {
		d := r.ValueDate.Time.Format("2006-01-02")
		fv.ValueDate = &d
	}
	if r.ValueDatetime.Valid {
		fv.ValueDatetime = &r.ValueDatetime.Time
	}
	if r.ValueJson.Valid {
		fv.ValueJSON = r.ValueJson.RawMessage
	}
	if r.EnumDictionaryID.Valid {
		fv.EnumDictionaryID = &r.EnumDictionaryID.UUID
	}
	if r.EnumVersion.Valid {
		fv.EnumVersion = &r.EnumVersion.Int32
	}
	return fv
}

func mapFieldValues(rows []queries.TaskFieldValue) []FieldValueRow {
	out := make([]FieldValueRow, len(rows))
	for i, r := range rows {
		out[i] = mapFieldValue(r)
	}
	return out
}

// =========================================================
// Tasks — Phase 4: list with search / filter / sort / grouping
// =========================================================

const (
	defaultPageSize = 20
	maxPageSize     = 100
)

// sortColumn maps the public sort_by value to a safe SQL column expression.
// Values not in this map are assumed to be UUIDs for numeric custom fields.
var systemSortColumns = map[string]string{
	"id":         "t.id",
	"title":      "t.title",
	"status":     "ts.sort_order",
	"created_at": "t.created_at",
	"updated_at": "t.updated_at",
}

// FieldFilter targets a single custom field definition and carries exactly one
// kind of value condition (user IDs, enum codes, or a date range).
type FieldFilter struct {
	FieldDefinitionID uuid.UUID
	UserIDs           []uuid.UUID // for user / users fields
	EnumCodes         []string    // for enum / multi_enum fields
	DateFrom          *string     // inclusive lower bound (YYYY-MM-DD)
	DateTo            *string     // inclusive upper bound (YYYY-MM-DD)
}

// DictionaryFilter targets any active enum/multi_enum field backed by one
// filter-enabled enum dictionary.
type DictionaryFilter struct {
	DictionaryID uuid.UUID
	EnumCodes    []string
}

// ListTasksParams carries all inputs for the task list endpoint.
type ListTasksParams struct {
	Page     int // 1-based; default 1
	PageSize int // default 20; max 100

	Search          string      // ILIKE across public_id, title, description
	StatusIDs       []uuid.UUID // filter by one or more status IDs
	Prefixes        []string    // filter by template_snapshot_prefix
	IncludeSubtasks bool        // include tasks with parent_task_id when true
	CreatedFrom     *time.Time  // inclusive lower created_at bound
	CreatedTo       *time.Time  // exclusive upper created_at bound

	FieldFilters      []FieldFilter
	DictionaryFilters []DictionaryFilter

	SortBy   string // "id","title","status","created_at","updated_at", or UUID of numeric field
	SortDesc bool
}

// TaskGroup is one status bucket in the grouped response.
type TaskGroup struct {
	Status   StatusRow `json:"status"`
	Tasks    []TaskRow `json:"tasks"`
	Total    int       `json:"total"` // total matching tasks in this status
	Page     int       `json:"page"`
	PageSize int       `json:"page_size"`
}

// ListTasksResponse carries a globally sorted flat page for list mode while
// preserving the grouped payload shape used by older clients.
type ListTasksResponse struct {
	Tasks      []TaskRow   `json:"tasks"`
	Groups     []TaskGroup `json:"groups"`
	GrandTotal int         `json:"grand_total"`
}

// TaskListStatusSummary is the status shape used by grouped list endpoints.
type TaskListStatusSummary struct {
	ID        uuid.UUID `json:"id"`
	Code      string    `json:"code"`
	Name      string    `json:"name"`
	SortOrder int       `json:"sort_order"`
}

// TaskListItemCreator is the inline public creator payload for grouped items.
type TaskListItemCreator struct {
	ID           uuid.UUID        `json:"id"`
	DisplayName  string           `json:"display_name"`
	AvatarURL    string           `json:"avatar_url"`
	CustomStatus *userstatus.Body `json:"custom_status"`
}

// TaskGroupedItem is the lightweight item payload returned by grouped endpoints.
type TaskGroupedItem struct {
	ID                 uuid.UUID           `json:"id"`
	PublicID           string              `json:"public_id"`
	Title              string              `json:"title"`
	DescriptionPreview string              `json:"description_preview"`
	StatusID           uuid.UUID           `json:"status_id"`
	CreatedAt          time.Time           `json:"created_at"`
	UpdatedAt          time.Time           `json:"updated_at"`
	CreatedBy          TaskListItemCreator `json:"created_by"`
}

// TaskGroupedStatusBucket contains one status section in grouped response payloads.
type TaskGroupedStatusBucket struct {
	Status TaskListStatusSummary `json:"status"`
	Items  []TaskGroupedItem     `json:"items"`
	Total  int                   `json:"total"`
}

// ListTasksGroupedResponse is the response for GET /api/tasks/grouped.
type ListTasksGroupedResponse struct {
	StatusOrder    []string                           `json:"status_order"`
	GroupsByStatus map[string]TaskGroupedStatusBucket `json:"groups_by_status"`
	GrandTotal     int                                `json:"grand_total"`
	Limit          int                                `json:"limit"`
}

// ListTasksStatusPortionResponse is the response for GET /api/tasks/status/:id/portion.
type ListTasksStatusPortionResponse struct {
	StatusID   uuid.UUID         `json:"status_id"`
	Items      []TaskGroupedItem `json:"items"`
	Total      int               `json:"total"`
	Offset     int               `json:"offset"`
	Limit      int               `json:"limit"`
	NextOffset int               `json:"next_offset"`
	HasMore    bool              `json:"has_more"`
}

// ListTasks returns a globally sorted flat page plus status-grouped
// compatibility data with optional search, filters and sorting.
//
// Implementation uses two queries total regardless of status count:
//  1. Fetch all statuses (ordered by sort_order).
//  2. Fetch all matching tasks in the requested sort order with COUNT(*) OVER
//     (PARTITION BY t.status_id) as a window function so per-status totals come
//     for free. Global and per-group pagination are then applied in Go.
//
// Dynamic WHERE/ORDER BY is hand-written because sqlc cannot express variable
// filter predicates or sort columns. Every user-supplied value goes through
// a $N parameter; the only interpolated strings are validated constants
// (sort column names from systemSortColumns) or UUID values that have already
// been parsed by uuid.Parse.
func (s *Service) ListTasks(ctx context.Context, p ListTasksParams) (ListTasksResponse, error) {
	p = normalizeListParams(p)

	// 1. All statuses ordered by sort_order (includes deleted).
	statusRows, err := s.q.TaskStatusList(ctx, true)
	if err != nil {
		return ListTasksResponse{}, fmt.Errorf("tasks: list statuses for grouping: %w", err)
	}

	// Index statuses by ID for O(1) lookup during group assembly.
	statusByID := make(map[uuid.UUID]StatusRow, len(statusRows))
	for _, sr := range statusRows {
		statusByID[sr.ID] = mapStatus(sr)
	}

	// 2. Single query: all matching tasks + per-status count via window function.
	q, args := buildTaskQuery(p)
	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return ListTasksResponse{}, fmt.Errorf("tasks: list tasks: %w", err)
	}

	// rawGroup accumulates all rows for one status before pagination is applied.
	type rawGroup struct {
		total int
		tasks []TaskRow
	}
	byStatus := make(map[uuid.UUID]*rawGroup)
	allTasks := make([]TaskRow, 0)

	defer rows.Close()
	for rows.Next() {
		var statusTotal int
		t, err := scanOneTaskWithTotal(rows, &statusTotal)
		if err != nil {
			return ListTasksResponse{}, fmt.Errorf("tasks: scan task row: %w", err)
		}
		g := byStatus[t.StatusID]
		if g == nil {
			g = &rawGroup{total: statusTotal}
			byStatus[t.StatusID] = g
		}
		g.tasks = append(g.tasks, t)
		allTasks = append(allTasks, t)
	}
	if err := rows.Err(); err != nil {
		return ListTasksResponse{}, fmt.Errorf("tasks: iterate task rows: %w", err)
	}

	// 3. Assemble groups in status sort_order; apply per-group pagination in Go.
	offset := (p.Page - 1) * p.PageSize
	grandTotal := len(allTasks)
	flatPage := []TaskRow{}
	if offset < len(allTasks) {
		end := offset + p.PageSize
		if end > len(allTasks) {
			end = len(allTasks)
		}
		flatPage = allTasks[offset:end]
	}

	groups := make([]TaskGroup, 0, len(statusRows))

	for _, sr := range statusRows {
		st := statusByID[sr.ID]
		g := byStatus[sr.ID]

		// Always show active statuses; skip deleted ones with no matching tasks.
		if sr.DeletedAt.Valid && g == nil {
			continue
		}

		total := 0
		var page []TaskRow
		if g != nil {
			total = g.total
			end := offset + p.PageSize
			if offset < len(g.tasks) {
				if end > len(g.tasks) {
					end = len(g.tasks)
				}
				page = g.tasks[offset:end]
			}
		}
		if page == nil {
			page = []TaskRow{}
		}

		groups = append(groups, TaskGroup{
			Status:   st,
			Tasks:    page,
			Total:    total,
			Page:     p.Page,
			PageSize: p.PageSize,
		})
	}

	return ListTasksResponse{Tasks: flatPage, Groups: groups, GrandTotal: grandTotal}, nil
}

// ListTasksGrouped returns status buckets with a first portion of items
// per status and totals for every status in one call.
func (s *Service) ListTasksGrouped(ctx context.Context, p ListTasksParams, limit int) (ListTasksGroupedResponse, error) {
	if limit < 1 {
		limit = 1
	}

	statusRows, err := s.q.TaskStatusList(ctx, true)
	if err != nil {
		return ListTasksGroupedResponse{}, fmt.Errorf("tasks: list statuses for grouped payload: %w", err)
	}

	statusOrder := make([]string, 0, len(statusRows))
	groups := make(map[string]TaskGroupedStatusBucket, len(statusRows))
	for _, sr := range statusRows {
		statusID := sr.ID.String()
		statusOrder = append(statusOrder, statusID)
		groups[statusID] = TaskGroupedStatusBucket{
			Status: mapTaskListStatusSummary(sr),
			Items:  []TaskGroupedItem{},
			Total:  0,
		}
	}

	q, args := buildGroupedInitialQuery(p, limit)
	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return ListTasksGroupedResponse{}, fmt.Errorf("tasks: list grouped task rows: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var (
			item          TaskGroupedItem
			creatorID     uuid.UUID
			statusText    string
			statusEmoji   string
			statusExpires sql.NullTime
			rowNum        int
			statusTotal   int
		)
		if err := rows.Scan(
			&item.ID,
			&item.PublicID,
			&item.Title,
			&item.DescriptionPreview,
			&item.StatusID,
			&item.CreatedAt,
			&item.UpdatedAt,
			&creatorID,
			&item.CreatedBy.DisplayName,
			&item.CreatedBy.AvatarURL,
			&statusText,
			&statusEmoji,
			&statusExpires,
			&rowNum,
			&statusTotal,
		); err != nil {
			return ListTasksGroupedResponse{}, fmt.Errorf("tasks: scan grouped task row: %w", err)
		}
		item.CreatedBy.ID = creatorID
		item.CreatedBy.CustomStatus = userstatus.ToBody(userstatus.ActiveFromNullTime(statusText, statusEmoji, statusExpires, time.Now().UTC()))

		statusKey := item.StatusID.String()
		bucket, ok := groups[statusKey]
		if !ok {
			bucket = TaskGroupedStatusBucket{
				Status: TaskListStatusSummary{ID: item.StatusID},
				Items:  []TaskGroupedItem{},
			}
			statusOrder = append(statusOrder, statusKey)
		}
		bucket.Total = statusTotal
		bucket.Items = append(bucket.Items, item)
		groups[statusKey] = bucket
	}
	if err := rows.Err(); err != nil {
		return ListTasksGroupedResponse{}, fmt.Errorf("tasks: iterate grouped task rows: %w", err)
	}

	grandTotal := 0
	for _, bucket := range groups {
		grandTotal += bucket.Total
	}

	return ListTasksGroupedResponse{
		StatusOrder:    statusOrder,
		GroupsByStatus: groups,
		GrandTotal:     grandTotal,
		Limit:          limit,
	}, nil
}

// ListTasksStatusPortion returns the next paginated slice for one status bucket.
func (s *Service) ListTasksStatusPortion(
	ctx context.Context,
	p ListTasksParams,
	statusID uuid.UUID,
	offset int,
	limit int,
) (ListTasksStatusPortionResponse, error) {
	if offset < 0 {
		offset = 0
	}
	if limit < 1 {
		limit = 1
	}

	args := &argList{}
	where := buildWhereClause(p, args)
	statusPH := args.add(statusID)
	offsetPH := args.add(offset)
	limitPH := args.add(limit)
	whereWithStatus := where + fmt.Sprintf(" AND t.status_id = %s", statusPH)

	query := fmt.Sprintf(
		`WITH filtered AS (`+
			` SELECT t.id AS task_id, t.public_id, t.title, LEFT(COALESCE(t.description, ''), %d) AS description_preview, t.status_id, t.created_at, t.updated_at,`+
			` u.id AS created_by_id, u.display_name, u.avatar_url, u.custom_status_text, u.custom_status_emoji, u.custom_status_expires_at`+
			` FROM task t`+
			` JOIN task_status ts ON ts.id = t.status_id`+
			` JOIN users u ON u.id = t.created_by`+
			` %s`+
			`),`+
			` paged AS (`+
			` SELECT * FROM filtered`+
			` ORDER BY updated_at DESC, task_id DESC`+
			` OFFSET %s LIMIT %s`+
			`),`+
			` totals AS (`+
			` SELECT COUNT(*)::int AS total FROM filtered`+
			`)`+
			` SELECT totals.total, paged.task_id, paged.public_id, paged.title, paged.description_preview, paged.status_id, paged.created_at, paged.updated_at,`+
			` paged.created_by_id, paged.display_name, paged.avatar_url, paged.custom_status_text, paged.custom_status_emoji, paged.custom_status_expires_at`+
			` FROM totals LEFT JOIN paged ON TRUE`,
		descriptionPreviewLength, whereWithStatus, offsetPH, limitPH,
	)
	rows, err := s.pool.Query(ctx, query, args.values...)
	if err != nil {
		return ListTasksStatusPortionResponse{}, fmt.Errorf("tasks: list grouped status portion rows: %w", err)
	}
	defer rows.Close()

	items := make([]TaskGroupedItem, 0, limit)
	total := 0
	for rows.Next() {
		var (
			item          TaskGroupedItem
			totalRow      int
			taskID        uuid.NullUUID
			publicID      sql.NullString
			title         sql.NullString
			desc          sql.NullString
			statusIDDB    uuid.NullUUID
			createdAt     sql.NullTime
			updatedAt     sql.NullTime
			creatorID     uuid.NullUUID
			display       sql.NullString
			avatar        sql.NullString
			statusText    sql.NullString
			statusEmoji   sql.NullString
			statusExpires sql.NullTime
		)
		if err := rows.Scan(
			&totalRow,
			&taskID,
			&publicID,
			&title,
			&desc,
			&statusIDDB,
			&createdAt,
			&updatedAt,
			&creatorID,
			&display,
			&avatar,
			&statusText,
			&statusEmoji,
			&statusExpires,
		); err != nil {
			return ListTasksStatusPortionResponse{}, fmt.Errorf("tasks: scan grouped status portion row: %w", err)
		}
		total = totalRow
		if !publicID.Valid {
			continue
		}
		if taskID.Valid {
			item.ID = taskID.UUID
		}
		item.PublicID = publicID.String
		item.Title = title.String
		item.DescriptionPreview = desc.String
		if statusIDDB.Valid {
			item.StatusID = statusIDDB.UUID
		}
		if createdAt.Valid {
			item.CreatedAt = createdAt.Time
		}
		if updatedAt.Valid {
			item.UpdatedAt = updatedAt.Time
		}
		if creatorID.Valid {
			item.CreatedBy.ID = creatorID.UUID
		}
		item.CreatedBy.DisplayName = display.String
		item.CreatedBy.AvatarURL = avatar.String
		item.CreatedBy.CustomStatus = userstatus.ToBody(userstatus.ActiveFromNullTime(statusText.String, statusEmoji.String, statusExpires, time.Now().UTC()))
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return ListTasksStatusPortionResponse{}, fmt.Errorf("tasks: iterate grouped status portion rows: %w", err)
	}

	nextOffset := offset + len(items)
	if nextOffset > total {
		nextOffset = total
	}

	return ListTasksStatusPortionResponse{
		StatusID:   statusID,
		Items:      items,
		Total:      total,
		Offset:     offset,
		Limit:      limit,
		NextOffset: nextOffset,
		HasMore:    nextOffset < total,
	}, nil
}

// =========================================================
// ListTasks helpers
// =========================================================

func normalizeListParams(p ListTasksParams) ListTasksParams {
	if p.Page < 1 {
		p.Page = 1
	}
	switch {
	case p.PageSize < 1:
		p.PageSize = defaultPageSize
	case p.PageSize > maxPageSize:
		p.PageSize = maxPageSize
	}
	return p
}

// buildTaskQuery returns the full SELECT SQL and its bound args.
//
// The SELECT list is taskSelectColumns followed by the window-function column:
//
//	COUNT(*) OVER (PARTITION BY t.status_id) AS status_total
//
// Callers must scan taskSelectColumns first, then status_total.
func buildTaskQuery(p ListTasksParams) (string, []any) {
	args := &argList{}

	where := buildWhereClause(p, args)
	join, sortCol := buildSortExpr(p.SortBy, p.SortDesc, args)

	sql := fmt.Sprintf(
		`SELECT %s, COUNT(*) OVER (PARTITION BY t.status_id) AS status_total`+
			` FROM task t`+
			` JOIN task_status ts ON ts.id = t.status_id%s`+
			` %s`+
			` ORDER BY %s`,
		taskSelectColumns, join, where, sortCol,
	)
	return sql, args.values
}

// buildGroupedInitialQuery returns the grouped initial payload query and args.
// It keeps newest-first ordering within each status and limits each status
// bucket via ROW_NUMBER() windowing.
func buildGroupedInitialQuery(p ListTasksParams, limit int) (string, []any) {
	args := &argList{}
	where := buildWhereClause(p, args)
	limitPH := args.add(limit)

	sql := fmt.Sprintf(
		`WITH ranked AS (`+
			` SELECT t.id, t.public_id, t.title, LEFT(COALESCE(t.description, ''), %d) AS description_preview, t.status_id, t.created_at, t.updated_at,`+
			` u.id AS created_by_id, u.display_name, u.avatar_url, u.custom_status_text, u.custom_status_emoji, u.custom_status_expires_at,`+
			` ROW_NUMBER() OVER (PARTITION BY t.status_id ORDER BY t.updated_at DESC, t.id DESC) AS rn,`+
			` COUNT(*) OVER (PARTITION BY t.status_id) AS status_total`+
			` FROM task t`+
			` JOIN task_status ts ON ts.id = t.status_id`+
			` JOIN users u ON u.id = t.created_by`+
			` %s`+
			` )`+
			` SELECT id, public_id, title, description_preview, status_id, created_at, updated_at, created_by_id, display_name, avatar_url, custom_status_text, custom_status_emoji, custom_status_expires_at, rn, status_total`+
			` FROM ranked`+
			` WHERE rn <= %s`+
			` ORDER BY status_id ASC, rn ASC`,
		descriptionPreviewLength, where, limitPH,
	)
	return sql, args.values
}

// taskSelectColumns lists t.* columns in scan order — must stay in sync with
// scanOneTask's Scan call.
const taskSelectColumns = `t.id, t.public_id, t.template_id, t.discussion_channel_id, t.template_snapshot_prefix,` +
	` t.sequence_number, t.title, t.description, t.status_id, t.parent_task_id,` +
	` t.created_by, t.updated_by, t.created_at, t.updated_at`

// buildWhereClause constructs the WHERE fragment, appending bound values to args.
func buildWhereClause(p ListTasksParams, args *argList) string {
	clauses := []string{"1=1"}

	if p.Search != "" {
		ph := args.add("%" + p.Search + "%")
		clauses = append(clauses,
			fmt.Sprintf(`(t.public_id ILIKE %s OR t.title ILIKE %s OR t.description ILIKE %s)`, ph, ph, ph),
		)
	}

	if len(p.StatusIDs) > 0 {
		ph := args.add(uuidSliceToStrings(p.StatusIDs))
		clauses = append(clauses, fmt.Sprintf(`t.status_id = ANY(%s::uuid[])`, ph))
	}

	if len(p.Prefixes) > 0 {
		ph := args.add(p.Prefixes)
		clauses = append(clauses, fmt.Sprintf(`t.template_snapshot_prefix = ANY(%s::text[])`, ph))
	}

	if !p.IncludeSubtasks {
		clauses = append(clauses, `t.parent_task_id IS NULL`)
	}

	if p.CreatedFrom != nil {
		ph := args.add(*p.CreatedFrom)
		clauses = append(clauses, fmt.Sprintf(`t.created_at >= %s`, ph))
	}

	if p.CreatedTo != nil {
		ph := args.add(*p.CreatedTo)
		clauses = append(clauses, fmt.Sprintf(`t.created_at < %s`, ph))
	}

	for _, ff := range p.FieldFilters {
		if sub := buildFieldFilterSubquery(ff, args); sub != "" {
			clauses = append(clauses, fmt.Sprintf(`EXISTS (%s)`, sub))
		}
	}
	for _, df := range p.DictionaryFilters {
		if sub := buildDictionaryFilterSubquery(df, args); sub != "" {
			clauses = append(clauses, fmt.Sprintf(`EXISTS (%s)`, sub))
		}
	}

	return "WHERE " + strings.Join(clauses, " AND ")
}

// buildFieldFilterSubquery returns a correlated EXISTS sub-select for one
// FieldFilter, or "" if the filter carries no usable condition.
func buildFieldFilterSubquery(ff FieldFilter, args *argList) string {
	var conds []string

	fph := args.add(ff.FieldDefinitionID)
	base := fmt.Sprintf(
		`SELECT 1 FROM task_field_value tfv WHERE tfv.task_id = t.id AND tfv.field_definition_id = %s`,
		fph,
	)

	if len(ff.UserIDs) > 0 {
		// user field:  value_user_id in the list.
		// users field: value_json is a JSON array of UUID strings; ?| checks
		//              whether any of the text keys exist as top-level elements.
		ph := args.add(uuidSliceToStrings(ff.UserIDs))
		conds = append(conds,
			fmt.Sprintf(`(tfv.value_user_id = ANY(%s::uuid[]) OR tfv.value_json ?| %s::text[])`, ph, ph),
		)
	}

	if len(ff.EnumCodes) > 0 {
		// enum:       stored in value_text.
		// multi_enum: stored as a JSON array of code strings in value_json.
		ph := args.add(ff.EnumCodes)
		conds = append(conds,
			fmt.Sprintf(`(tfv.value_text = ANY(%s::text[]) OR tfv.value_json ?| %s::text[])`, ph, ph),
		)
	}

	if ff.DateFrom != nil {
		ph := args.add(*ff.DateFrom)
		conds = append(conds,
			fmt.Sprintf(`(tfv.value_date >= %s::date OR tfv.value_datetime >= %s::timestamptz)`, ph, ph),
		)
	}

	if ff.DateTo != nil {
		ph := args.add(*ff.DateTo)
		conds = append(conds,
			fmt.Sprintf(`(tfv.value_date <= %s::date OR tfv.value_datetime <= %s::timestamptz)`, ph, ph),
		)
	}

	if len(conds) == 0 {
		return ""
	}
	return base + " AND (" + strings.Join(conds, " AND ") + ")"
}

func buildDictionaryFilterSubquery(df DictionaryFilter, args *argList) string {
	if len(df.EnumCodes) == 0 {
		return ""
	}
	dictPH := args.add(df.DictionaryID)
	codesPH := args.add(df.EnumCodes)
	return fmt.Sprintf(
		`SELECT 1 FROM task_field_value tfv`+
			` JOIN task_field_definition tfd ON tfd.id = tfv.field_definition_id`+
			` JOIN enum_dictionary ed ON ed.id = tfd.enum_dictionary_id`+
			` WHERE tfv.task_id = t.id`+
			` AND tfd.deleted_at IS NULL`+
			` AND tfd.type IN ('enum', 'multi_enum')`+
			` AND tfd.enum_dictionary_id = %s`+
			` AND ed.participates_in_filtration = true`+
			` AND (tfv.value_text = ANY(%s::text[]) OR tfv.value_json ?| %s::text[])`,
		dictPH, codesPH, codesPH,
	)
}

// buildSortExpr returns the optional LEFT JOIN clause and the ORDER BY expression.
//
// When sortBy is a field-definition UUID, the UUID is passed as a bound
// parameter ($N) in the JOIN condition — never interpolated into the SQL string.
func buildSortExpr(sortBy string, desc bool, args *argList) (join, orderBy string) {
	dir := "ASC"
	if desc {
		dir = "DESC"
	}

	if sortBy == "id" {
		return "", systemSortColumns[sortBy] + " " + dir
	}

	if col, ok := systemSortColumns[sortBy]; ok {
		return "", col + " " + dir + " NULLS LAST, t.id " + dir
	}

	if sortBy != "" {
		if _, err := uuid.Parse(sortBy); err == nil {
			ph := args.add(sortBy) // UUID as bound parameter — no interpolation
			join = fmt.Sprintf(
				` LEFT JOIN task_field_value tfv_sort`+
					` ON tfv_sort.task_id = t.id AND tfv_sort.field_definition_id = %s`,
				ph,
			)
			return join, "tfv_sort.value_number " + dir + " NULLS LAST, t.updated_at DESC, t.id DESC"
		}
	}

	return "", "t.updated_at DESC, t.id DESC"
}

// argList is a small helper that accumulates bound values and assigns
// sequential $N placeholders, keeping buildWhereClause and its callees free
// of manual index arithmetic.
type argList struct {
	values []any
}

func (a *argList) add(v any) string {
	a.values = append(a.values, v)
	return fmt.Sprintf("$%d", len(a.values))
}

// uuidSliceToStrings converts []uuid.UUID to []string for pgx ANY() parameters.
func uuidSliceToStrings(ids []uuid.UUID) []string {
	s := make([]string, len(ids))
	for i, id := range ids {
		s[i] = id.String()
	}
	return s
}

// =========================================================
// Users (public, non-admin)
// =========================================================

// UserRow is the public view of a user returned to all authenticated users.
type UserRow struct {
	ID           string           `json:"id"`
	DisplayName  string           `json:"display_name"`
	Email        string           `json:"email"`
	AvatarURL    string           `json:"avatar_url"`
	CustomStatus *userstatus.Body `json:"custom_status"`
}

func (s *Service) ListUsers(ctx context.Context) ([]UserRow, error) {
	rows, err := s.q.ListActiveUsers(ctx)
	if err != nil {
		return nil, fmt.Errorf("tasks: list users: %w", err)
	}
	out := make([]UserRow, len(rows))
	now := time.Now().UTC()
	for i, r := range rows {
		out[i] = UserRow{
			ID:           r.ID.String(),
			DisplayName:  r.DisplayName,
			Email:        r.Email,
			AvatarURL:    r.AvatarUrl,
			CustomStatus: userstatus.ToBody(userstatus.ActiveFromNullTime(r.CustomStatusText, r.CustomStatusEmoji, r.CustomStatusExpiresAt, now)),
		}
	}
	return out, nil
}

// =========================================================
// Attachments (Phase 6)
// =========================================================

// UploadTaskStagedAttachment stores an image before a task exists. The row is
// later moved into task_attachment by CreateTask.
func (s *Service) UploadTaskStagedAttachment(
	ctx context.Context,
	p UploadTaskStagedAttachmentParams,
	maxSizeMB int,
) (*StagedAttachmentRow, error) {
	store, err := s.requireStore()
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(p.FileName) == "" {
		return nil, fmt.Errorf("%w: file_name is required", ErrBadRequest)
	}
	if p.Size < 0 {
		return nil, fmt.Errorf("%w: file size must be provided", ErrBadRequest)
	}
	if p.MimeType == "" {
		p.MimeType = "application/octet-stream"
	}
	if !strings.HasPrefix(p.MimeType, "image/") {
		return nil, fmt.Errorf("%w: only image attachments can be staged before task creation", ErrBadRequest)
	}

	maxBytes := int64(maxSizeMB) * 1024 * 1024
	if p.Size > maxBytes {
		return nil, fmt.Errorf("%w: file exceeds maximum allowed size of %d MB", ErrBadRequest, maxSizeMB)
	}

	payload, err := io.ReadAll(io.LimitReader(p.Body, maxBytes+1))
	if err != nil {
		return nil, fmt.Errorf("tasks: read staged attachment payload: %w", err)
	}
	actualSize := int64(len(payload))
	if actualSize > maxBytes {
		return nil, fmt.Errorf("%w: file exceeds maximum allowed size of %d MB", ErrBadRequest, maxSizeMB)
	}
	if p.Size != actualSize {
		return nil, fmt.Errorf("%w: uploaded file size does not match multipart metadata", ErrBadRequest)
	}

	attachmentID := uuid.New()
	safeFileName := sanitiseFileName(p.FileName)
	storageKey := fmt.Sprintf("tasks/staged/%s/%s", attachmentID, safeFileName)

	if err := store.PutObject(ctx, storageKey, bytes.NewReader(payload), actualSize, p.MimeType); err != nil {
		return nil, fmt.Errorf("tasks: upload staged attachment: %w", err)
	}

	row, err := s.q.TaskStagedAttachmentCreate(ctx, queries.TaskStagedAttachmentCreateParams{
		ID:         attachmentID,
		FileName:   p.FileName,
		FileSize:   actualSize,
		MimeType:   p.MimeType,
		StorageKey: storageKey,
		UploadedBy: p.ActorID,
	})
	if err != nil {
		s.deleteObjectBestEffort(ctx, store, storageKey)
		return nil, fmt.Errorf("tasks: create staged attachment record: %w", err)
	}
	out := mapTaskStagedAttachment(row)
	return &out, nil
}

func (s *Service) DownloadTaskStagedAttachment(ctx context.Context, actorID, attachmentID uuid.UUID) (io.ReadCloser, int64, string, string, error) {
	store, err := s.requireStore()
	if err != nil {
		return nil, 0, "", "", err
	}
	row, err := s.q.TaskStagedAttachmentGet(ctx, attachmentID)
	if err != nil {
		return nil, 0, "", "", mapNotFound(err, "attachment")
	}
	if row.UploadedBy != actorID {
		return nil, 0, "", "", fmt.Errorf("%w: attachment", ErrNotFound)
	}
	body, size, mimeType, err := store.GetObject(ctx, row.StorageKey)
	if err != nil {
		return nil, 0, "", "", fmt.Errorf("tasks: download staged attachment: %w", err)
	}
	return body, size, mimeType, row.FileName, nil
}

func (s *Service) DeleteTaskStagedAttachment(ctx context.Context, actorID, attachmentID uuid.UUID) error {
	store, err := s.requireStore()
	if err != nil {
		return err
	}
	row, err := s.q.TaskStagedAttachmentDelete(ctx, queries.TaskStagedAttachmentDeleteParams{
		ID:         attachmentID,
		UploadedBy: actorID,
	})
	if err != nil {
		return mapNotFound(err, "attachment")
	}
	s.deleteObjectBestEffort(ctx, store, row.StorageKey)
	return nil
}

// CleanupExpiredTaskStagedAttachments removes abandoned pre-create uploads
// older than ttl. Database rows are deleted before objects so users never see
// dangling metadata if object cleanup fails.
func (s *Service) CleanupExpiredTaskStagedAttachments(ctx context.Context, ttl time.Duration) (int, error) {
	store, err := s.requireStore()
	if err != nil {
		return 0, err
	}
	if ttl <= 0 {
		return 0, fmt.Errorf("%w: staged attachment ttl must be positive", ErrBadRequest)
	}

	cutoff := time.Now().UTC().Add(-ttl)
	rows, err := s.pool.Query(ctx,
		`DELETE FROM task_staged_attachment
		  WHERE created_at < $1
		  RETURNING id, file_name, file_size, mime_type, storage_key, uploaded_by, created_at`,
		cutoff,
	)
	if err != nil {
		return 0, fmt.Errorf("tasks: delete expired staged attachments: %w", err)
	}
	defer rows.Close()

	deleted := 0
	for rows.Next() {
		row, scanErr := scanTaskStagedAttachment(rows)
		if scanErr != nil {
			return deleted, fmt.Errorf("tasks: scan expired staged attachment: %w", scanErr)
		}
		s.deleteObjectBestEffort(ctx, store, row.StorageKey)
		deleted++
	}
	if err := rows.Err(); err != nil {
		return deleted, fmt.Errorf("tasks: iterate expired staged attachments: %w", err)
	}
	return deleted, nil
}

// UploadAttachment stores one file and records a one-file added history entry.
// It remains the compatibility API for callers that do not upload a picker
// selection as a batch.
func (s *Service) UploadAttachment(ctx context.Context, p UploadAttachmentParams, maxSizeMB int, counter ByteCounter) (*AttachmentRow, error) {
	result, err := s.UploadAttachments(ctx, UploadAttachmentsParams{
		TaskID:  p.TaskID,
		ActorID: p.ActorID,
		Attachments: []UploadAttachmentBatchItem{{
			FileName: p.FileName,
			MimeType: p.MimeType,
			Size:     p.Size,
			Body:     p.Body,
			Counter:  counter,
		}},
	}, maxSizeMB)
	if err != nil {
		return nil, err
	}
	if len(result.Attachments) == 1 {
		return &result.Attachments[0], nil
	}
	if len(result.Errors) > 0 {
		return nil, fmt.Errorf("%w: %s", ErrBadRequest, result.Errors[0].Message)
	}
	return nil, fmt.Errorf("tasks: attachment upload produced no result")
}

// UploadAttachments stores a group of attachments from one picker or drop
// action. Each invalid file is isolated, while all successful records and one
// immutable "Attachments added" history entry commit in a single transaction.
func (s *Service) UploadAttachments(
	ctx context.Context,
	p UploadAttachmentsParams,
	maxSizeMB int,
) (AttachmentUploadResult, error) {
	store, err := s.requireStore()
	if err != nil {
		return AttachmentUploadResult{}, err
	}
	if len(p.Attachments) == 0 {
		return AttachmentUploadResult{}, fmt.Errorf("%w: at least one attachment is required", ErrBadRequest)
	}
	if _, err := s.q.TaskGet(ctx, p.TaskID); err != nil {
		return AttachmentUploadResult{}, mapNotFound(err, "task")
	}

	result := AttachmentUploadResult{
		Attachments: make([]AttachmentRow, 0, len(p.Attachments)),
		Errors:      make([]AttachmentUploadError, 0),
	}
	for _, item := range p.Attachments {
		row, uploadErr := s.uploadAttachmentObject(ctx, store, p.TaskID, p.ActorID, item, maxSizeMB)
		if uploadErr != nil {
			result.Errors = append(result.Errors, AttachmentUploadError{
				FileName: item.FileName,
				Message:  attachmentUploadErrorMessage(uploadErr),
			})
			continue
		}
		result.Attachments = append(result.Attachments, row)
	}
	if len(result.Attachments) == 0 {
		return result, nil
	}

	committed := false
	defer func() {
		if committed {
			return
		}
		for _, row := range result.Attachments {
			s.deleteObjectBestEffort(ctx, store, row.StorageKey)
		}
	}()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AttachmentUploadResult{}, fmt.Errorf("tasks: begin attachment upload tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var lockedTaskID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT id FROM task WHERE id = $1 FOR KEY SHARE`, p.TaskID).Scan(&lockedTaskID); err != nil {
		return AttachmentUploadResult{}, mapNotFound(err, "task")
	}
	for index := range result.Attachments {
		row := &result.Attachments[index]
		if err := tx.QueryRow(ctx,
			`INSERT INTO task_attachment
			    (id, task_id, file_name, file_size, mime_type, storage_key, uploaded_by)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)
			 RETURNING created_at`,
			row.ID, row.TaskID, row.FileName, row.FileSize, row.MimeType, row.StorageKey, row.UploadedBy,
		).Scan(&row.CreatedAt); err != nil {
			return AttachmentUploadResult{}, fmt.Errorf("tasks: create attachment record: %w", err)
		}
	}
	if err := recordTaskChangeInTx(
		ctx, tx, p.TaskID, p.ActorID,
		"field", "attachments", "Attachments", "attachments_added", nil,
		taskHistoryAttachments(result.Attachments),
	); err != nil {
		return AttachmentUploadResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AttachmentUploadResult{}, fmt.Errorf("tasks: commit attachment upload tx: %w", err)
	}
	committed = true
	return result, nil
}

func (s *Service) uploadAttachmentObject(
	ctx context.Context,
	store Storage,
	taskID, actorID uuid.UUID,
	p UploadAttachmentBatchItem,
	maxSizeMB int,
) (AttachmentRow, error) {
	if strings.TrimSpace(p.FileName) == "" {
		return AttachmentRow{}, fmt.Errorf("%w: file_name is required", ErrBadRequest)
	}
	if p.MimeType == "" {
		p.MimeType = "application/octet-stream"
	}
	maxBytes := int64(maxSizeMB) * 1024 * 1024
	if p.Size >= 0 && p.Size > maxBytes {
		return AttachmentRow{}, fmt.Errorf("%w: file exceeds maximum allowed size of %d MB", ErrBadRequest, maxSizeMB)
	}

	attachmentID := uuid.New()
	storageKey := fmt.Sprintf("tasks/%s/%s/%s", taskID, attachmentID, sanitiseFileName(p.FileName))
	if err := store.PutObject(ctx, storageKey, p.Body, p.Size, p.MimeType); err != nil {
		return AttachmentRow{}, fmt.Errorf("tasks: upload attachment: %w", err)
	}

	actualSize := p.Size
	if p.Counter != nil {
		actualSize = p.Counter.BytesRead()
	}
	if actualSize > maxBytes {
		s.deleteObjectBestEffort(ctx, store, storageKey)
		return AttachmentRow{}, fmt.Errorf("%w: file exceeds maximum allowed size of %d MB", ErrBadRequest, maxSizeMB)
	}
	if actualSize < 0 {
		s.deleteObjectBestEffort(ctx, store, storageKey)
		return AttachmentRow{}, fmt.Errorf("%w: file size is required", ErrBadRequest)
	}

	return AttachmentRow{
		ID:         attachmentID,
		TaskID:     taskID,
		FileName:   p.FileName,
		FileSize:   actualSize,
		MimeType:   p.MimeType,
		StorageKey: storageKey,
		UploadedBy: actorID,
	}, nil
}

func attachmentUploadErrorMessage(err error) string {
	if errors.Is(err, ErrBadRequest) {
		return strings.TrimPrefix(err.Error(), ErrBadRequest.Error()+": ")
	}
	return "Upload failed"
}

// ListAttachments returns all attachments for a task in upload order.
func (s *Service) ListAttachments(ctx context.Context, taskID uuid.UUID) ([]AttachmentRow, error) {
	if _, err := s.q.TaskGet(ctx, taskID); err != nil {
		return nil, mapNotFound(err, "task")
	}
	rows, err := s.q.TaskAttachmentList(ctx, taskID)
	if err != nil {
		return nil, fmt.Errorf("tasks: list attachments: %w", err)
	}
	out := make([]AttachmentRow, len(rows))
	for i, r := range rows {
		out[i] = mapAttachment(r)
	}
	return out, nil
}

// DownloadAttachment retrieves the attachment metadata and opens an object
// stream. The caller is responsible for closing the returned ReadCloser.
func (s *Service) DownloadAttachment(ctx context.Context, taskID, attachmentID uuid.UUID) (io.ReadCloser, int64, string, string, error) {
	store, err := s.requireStore()
	if err != nil {
		return nil, 0, "", "", err
	}

	row, err := s.q.TaskAttachmentGet(ctx, attachmentID)
	if err != nil {
		return nil, 0, "", "", mapNotFound(err, "attachment")
	}
	if row.TaskID != taskID {
		return nil, 0, "", "", fmt.Errorf("%w: attachment", ErrNotFound)
	}

	body, size, mimeType, err := store.GetObject(ctx, row.StorageKey)
	if err != nil {
		return nil, 0, "", "", fmt.Errorf("tasks: download attachment: %w", err)
	}
	return body, size, mimeType, row.FileName, nil
}

// DeleteAttachment removes an attachment and records its immutable metadata in
// the same transaction. Object storage is cleaned up only after the metadata
// and audit event have committed.
//
// Ordering rationale: the DB row is deleted first. If the subsequent storage
// delete fails the object becomes an orphan (storage garbage), but the record
// is gone so users never see a dangling reference and downloads no longer
// return a 500. A DB failure after successful storage deletion would leave a
// record that points to a missing object — far worse, because every download
// attempt would then surface a storage error. The storage orphan path is
// self-contained and can be cleaned up by a background sweep if needed.
func (s *Service) DeleteAttachment(ctx context.Context, taskID, attachmentID, actorID uuid.UUID) error {
	store, err := s.requireStore()
	if err != nil {
		return err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("tasks: begin attachment delete tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	row, err := scanTaskAttachment(tx.QueryRow(ctx,
		`SELECT id, task_id, file_name, file_size, mime_type, storage_key, uploaded_by, created_at
		   FROM task_attachment
		  WHERE id = $1
		  FOR UPDATE`,
		attachmentID,
	))
	if err != nil {
		return mapNotFound(err, "attachment")
	}
	if row.TaskID != taskID {
		return fmt.Errorf("%w: attachment", ErrNotFound)
	}

	// Delete the DB record first.
	if _, err = tx.Exec(ctx,
		`DELETE FROM task_attachment WHERE id = $1 AND task_id = $2`,
		attachmentID, taskID,
	); err != nil {
		return fmt.Errorf("tasks: delete attachment record: %w", err)
	}
	if err := recordTaskChangeInTx(
		ctx, tx, taskID, actorID,
		"field", "attachments", "Attachments", "attachments_removed",
		taskHistoryAttachments([]AttachmentRow{row}), nil,
	); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("tasks: commit attachment delete tx: %w", err)
	}

	// Best-effort storage deletion. An orphaned object is a storage concern,
	// not a correctness concern for the API consumer.
	s.deleteObjectBestEffort(ctx, store, row.StorageKey)
	return nil
}

// =========================================================
// Comments (Phase 6)
// =========================================================

// UploadCommentAttachment stores a staged attachment for a task comment.
func (s *Service) UploadCommentAttachment(
	ctx context.Context,
	p UploadCommentAttachmentParams,
	maxSizeMB int,
) (*CommentAttachmentRow, error) {
	store, err := s.requireStore()
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(p.FileName) == "" {
		return nil, fmt.Errorf("%w: file_name is required", ErrBadRequest)
	}
	if p.Size < 0 {
		return nil, fmt.Errorf("%w: file size must be provided", ErrBadRequest)
	}
	if p.MimeType == "" {
		p.MimeType = "application/octet-stream"
	}

	maxBytes := int64(maxSizeMB) * 1024 * 1024
	if p.Size > maxBytes {
		return nil, fmt.Errorf("%w: file exceeds maximum allowed size of %d MB", ErrBadRequest, maxSizeMB)
	}

	if _, err := s.q.TaskGet(ctx, p.TaskID); err != nil {
		return nil, mapNotFound(err, "task")
	}

	// Read the request body with a hard cap and use the actual byte count for
	// storage and persistence. This avoids trusting client-declared multipart
	// sizes and prevents silent truncation on mismatched size claims.
	payload, err := io.ReadAll(io.LimitReader(p.Body, maxBytes+1))
	if err != nil {
		return nil, fmt.Errorf("tasks: read comment attachment payload: %w", err)
	}
	actualSize := int64(len(payload))
	if actualSize > maxBytes {
		return nil, fmt.Errorf("%w: file exceeds maximum allowed size of %d MB", ErrBadRequest, maxSizeMB)
	}
	if p.Size >= 0 && p.Size != actualSize {
		return nil, fmt.Errorf("%w: uploaded file size does not match multipart metadata", ErrBadRequest)
	}

	attachmentID := uuid.New()
	safeFileName := sanitiseFileName(p.FileName)
	storageKey := fmt.Sprintf("tasks/%s/comments/%s/%s", p.TaskID, attachmentID, safeFileName)

	if err := store.PutObject(ctx, storageKey, bytes.NewReader(payload), actualSize, p.MimeType); err != nil {
		return nil, fmt.Errorf("tasks: upload comment attachment: %w", err)
	}

	row, err := s.q.TaskCommentAttachmentCreate(ctx, queries.TaskCommentAttachmentCreateParams{
		ID:         attachmentID,
		TaskID:     p.TaskID,
		CommentID:  uuid.NullUUID{},
		FileName:   p.FileName,
		FileSize:   actualSize,
		MimeType:   p.MimeType,
		StorageKey: storageKey,
		UploadedBy: p.ActorID,
	})
	if err != nil {
		s.deleteObjectBestEffort(ctx, store, storageKey)
		return nil, fmt.Errorf("tasks: create comment attachment record: %w", err)
	}
	out := mapTaskCommentAttachment(row)
	return &out, nil
}

// DeleteStagedCommentAttachment deletes a staged (not yet linked) comment attachment.
// Only the original uploader may delete it.
func (s *Service) DeleteStagedCommentAttachment(ctx context.Context, taskID, actorID, attachmentID uuid.UUID) error {
	store, err := s.requireStore()
	if err != nil {
		return err
	}

	row, err := s.q.TaskCommentAttachmentGet(ctx, attachmentID)
	if err != nil {
		return mapNotFound(err, "attachment")
	}
	if row.TaskID != taskID {
		return fmt.Errorf("%w: attachment", ErrNotFound)
	}
	if row.UploadedBy != actorID {
		return fmt.Errorf("%w: attachment does not belong to user", ErrForbidden)
	}
	if row.CommentID.Valid {
		return fmt.Errorf("%w: attachment already linked to a comment", ErrBadRequest)
	}

	if _, err := s.q.TaskCommentAttachmentDeleteStaged(ctx, queries.TaskCommentAttachmentDeleteStagedParams{
		ID:     attachmentID,
		TaskID: taskID,
	}); err != nil {
		return mapNotFound(err, "attachment")
	}
	// Best-effort storage delete: the DB row is already removed, so a storage
	// failure leaves an orphan object but no broken API references.
	s.deleteObjectBestEffort(ctx, store, row.StorageKey)
	return nil
}

// DownloadCommentAttachment opens a linked comment attachment stream.
func (s *Service) DownloadCommentAttachment(
	ctx context.Context,
	taskID, commentID, attachmentID uuid.UUID,
) (io.ReadCloser, int64, string, string, error) {
	store, err := s.requireStore()
	if err != nil {
		return nil, 0, "", "", err
	}

	row, err := s.q.TaskCommentAttachmentGet(ctx, attachmentID)
	if err != nil {
		return nil, 0, "", "", mapNotFound(err, "attachment")
	}
	if row.TaskID != taskID {
		return nil, 0, "", "", fmt.Errorf("%w: attachment", ErrNotFound)
	}
	if !row.CommentID.Valid || row.CommentID.UUID != commentID {
		return nil, 0, "", "", fmt.Errorf("%w: attachment", ErrNotFound)
	}

	body, size, mimeType, err := store.GetObject(ctx, row.StorageKey)
	if err != nil {
		return nil, 0, "", "", fmt.Errorf("tasks: download comment attachment: %w", err)
	}
	if mimeType == "" {
		mimeType = row.MimeType
	}
	return body, size, mimeType, row.FileName, nil
}

// CreateComment adds a new comment to a task.
func (s *Service) CreateComment(ctx context.Context, taskID, authorID uuid.UUID, body string, attachmentIDs ...uuid.UUID) (*CommentRow, error) {
	body = strings.TrimSpace(body)
	attachmentIDs = uniqueUUIDs(attachmentIDs)
	if body == "" && len(attachmentIDs) == 0 {
		return nil, fmt.Errorf("%w: comment body or attachments are required", ErrBadRequest)
	}
	if len(attachmentIDs) > maxCommentAttachments {
		return nil, fmt.Errorf("%w: max %d attachments allowed", ErrBadRequest, maxCommentAttachments)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("tasks: begin create comment tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Lock the parent task row so delete cannot race between validation and
	// INSERT into task_comment.
	var marker int
	if err := tx.QueryRow(ctx, `SELECT 1 FROM task WHERE id = $1 FOR KEY SHARE`, taskID).Scan(&marker); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("%w: task", ErrNotFound)
		}
		return nil, fmt.Errorf("tasks: verify task in create comment tx: %w", err)
	}

	attachments := make([]CommentAttachmentRow, 0, len(attachmentIDs))
	if len(attachmentIDs) > 0 {
		rows, err := tx.Query(ctx, `
			SELECT id, task_id, comment_id, file_name, file_size, mime_type, storage_key, uploaded_by, created_at
			  FROM task_comment_attachment
			 WHERE id = ANY($1::uuid[])
			 FOR UPDATE`,
			attachmentIDs,
		)
		if err != nil {
			return nil, fmt.Errorf("tasks: lock comment attachments: %w", err)
		}
		attachmentsByID := make(map[uuid.UUID]CommentAttachmentRow, len(attachmentIDs))
		for rows.Next() {
			item, scanErr := scanTaskCommentAttachment(rows)
			if scanErr != nil {
				rows.Close()
				return nil, fmt.Errorf("tasks: scan comment attachment: %w", scanErr)
			}
			attachmentsByID[item.ID] = item
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("tasks: iterate comment attachment rows: %w", err)
		}
		if len(attachmentsByID) != len(attachmentIDs) {
			return nil, fmt.Errorf("%w: invalid attachment_ids", ErrBadRequest)
		}

		for _, attachmentID := range attachmentIDs {
			item := attachmentsByID[attachmentID]
			if item.TaskID != taskID {
				return nil, fmt.Errorf("%w: attachment does not belong to task", ErrBadRequest)
			}
			if item.UploadedBy != authorID {
				return nil, fmt.Errorf("%w: attachment does not belong to user", ErrForbidden)
			}
			if item.CommentID != nil {
				return nil, fmt.Errorf("%w: attachment already linked to a comment", ErrBadRequest)
			}
			attachments = append(attachments, item)
		}
	}

	var out CommentRow
	if err := tx.QueryRow(ctx, `
		INSERT INTO task_comment (task_id, author_id, body)
		VALUES ($1, $2, $3)
		RETURNING id, task_id, author_id, body, created_at, updated_at`,
		taskID,
		authorID,
		body,
	).Scan(
		&out.ID,
		&out.TaskID,
		&out.AuthorID,
		&out.Body,
		&out.CreatedAt,
		&out.UpdatedAt,
	); err != nil {
		return nil, fmt.Errorf("tasks: create comment in tx: %w", err)
	}

	if len(attachmentIDs) > 0 {
		tag, err := tx.Exec(ctx, `
			UPDATE task_comment_attachment
			   SET comment_id = $1
			 WHERE id = ANY($2::uuid[])
			   AND comment_id IS NULL`,
			out.ID,
			attachmentIDs,
		)
		if err != nil {
			return nil, fmt.Errorf("tasks: link comment attachments: %w", err)
		}
		if tag.RowsAffected() != int64(len(attachmentIDs)) {
			return nil, fmt.Errorf("%w: failed to link all attachments", ErrBadRequest)
		}

		out.Attachments = make([]CommentAttachmentRow, 0, len(attachments))
		for _, attachment := range attachments {
			commentID := out.ID
			attachment.CommentID = &commentID
			out.Attachments = append(out.Attachments, attachment)
		}
	} else {
		out.Attachments = []CommentAttachmentRow{}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("tasks: commit create comment tx: %w", err)
	}
	return &out, nil
}

// UpdateComment updates an existing task comment and replaces its attachment set.
func (s *Service) UpdateComment(ctx context.Context, taskID, commentID, actorID uuid.UUID, body string, attachmentIDs ...uuid.UUID) (*CommentRow, error) {
	body = strings.TrimSpace(body)
	attachmentIDs = uniqueUUIDs(attachmentIDs)
	if body == "" && len(attachmentIDs) == 0 {
		return nil, fmt.Errorf("%w: comment body or attachments are required", ErrBadRequest)
	}
	if len(attachmentIDs) > maxCommentAttachments {
		return nil, fmt.Errorf("%w: max %d attachments allowed", ErrBadRequest, maxCommentAttachments)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("tasks: begin update comment tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var taskMarker int
	if err := tx.QueryRow(ctx, `SELECT 1 FROM task WHERE id = $1 FOR KEY SHARE`, taskID).Scan(&taskMarker); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("%w: task", ErrNotFound)
		}
		return nil, fmt.Errorf("tasks: verify task in update comment tx: %w", err)
	}

	var authorID uuid.UUID
	var threadRootMessageID uuid.NullUUID
	if err := tx.QueryRow(ctx, `
		SELECT author_id, thread_root_message_id
		  FROM task_comment
		 WHERE id = $1
		   AND task_id = $2
		 FOR UPDATE`,
		commentID,
		taskID,
	).Scan(&authorID, &threadRootMessageID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("%w: comment", ErrNotFound)
		}
		return nil, fmt.Errorf("tasks: lock comment for update: %w", err)
	}
	if authorID != actorID {
		return nil, fmt.Errorf("%w: comment does not belong to user", ErrForbidden)
	}

	currentRows, err := tx.Query(ctx, `
		SELECT id, task_id, comment_id, file_name, file_size, mime_type, storage_key, uploaded_by, created_at
		  FROM task_comment_attachment
		 WHERE comment_id = $1
		 FOR UPDATE`,
		commentID,
	)
	if err != nil {
		return nil, fmt.Errorf("tasks: lock existing comment attachments: %w", err)
	}
	currentAttachments := make(map[uuid.UUID]CommentAttachmentRow)
	for currentRows.Next() {
		item, scanErr := scanTaskCommentAttachment(currentRows)
		if scanErr != nil {
			currentRows.Close()
			return nil, fmt.Errorf("tasks: scan existing comment attachment: %w", scanErr)
		}
		currentAttachments[item.ID] = item
	}
	currentRows.Close()
	if err := currentRows.Err(); err != nil {
		return nil, fmt.Errorf("tasks: iterate existing comment attachments: %w", err)
	}

	requestedByID := make(map[uuid.UUID]CommentAttachmentRow, len(attachmentIDs))
	if len(attachmentIDs) > 0 {
		rows, err := tx.Query(ctx, `
			SELECT id, task_id, comment_id, file_name, file_size, mime_type, storage_key, uploaded_by, created_at
			  FROM task_comment_attachment
			 WHERE id = ANY($1::uuid[])
			 FOR UPDATE`,
			attachmentIDs,
		)
		if err != nil {
			return nil, fmt.Errorf("tasks: lock requested comment attachments: %w", err)
		}
		for rows.Next() {
			item, scanErr := scanTaskCommentAttachment(rows)
			if scanErr != nil {
				rows.Close()
				return nil, fmt.Errorf("tasks: scan requested comment attachment: %w", scanErr)
			}
			requestedByID[item.ID] = item
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("tasks: iterate requested comment attachment rows: %w", err)
		}
		if len(requestedByID) != len(attachmentIDs) {
			return nil, fmt.Errorf("%w: invalid attachment_ids", ErrBadRequest)
		}
	}

	toLink := make([]uuid.UUID, 0, len(attachmentIDs))
	for _, attachmentID := range attachmentIDs {
		item := requestedByID[attachmentID]
		if item.TaskID != taskID {
			return nil, fmt.Errorf("%w: attachment does not belong to task", ErrBadRequest)
		}
		if item.UploadedBy != actorID {
			return nil, fmt.Errorf("%w: attachment does not belong to user", ErrForbidden)
		}
		if item.CommentID != nil && *item.CommentID != commentID {
			return nil, fmt.Errorf("%w: attachment already linked to a different comment", ErrBadRequest)
		}
		if item.CommentID == nil {
			toLink = append(toLink, attachmentID)
		}
	}

	removed := make([]CommentAttachmentRow, 0)
	for existingID, existing := range currentAttachments {
		if _, keep := requestedByID[existingID]; keep {
			continue
		}
		removed = append(removed, existing)
	}
	if len(removed) > 0 {
		if _, err := s.requireStore(); err != nil {
			return nil, err
		}
	}

	var updated CommentRow
	if err := tx.QueryRow(ctx, `
		UPDATE task_comment
		   SET body = $3
		 WHERE id = $1
		   AND task_id = $2
		RETURNING id, task_id, author_id, thread_root_message_id, body, created_at, updated_at`,
		commentID,
		taskID,
		body,
	).Scan(
		&updated.ID,
		&updated.TaskID,
		&updated.AuthorID,
		&threadRootMessageID,
		&updated.Body,
		&updated.CreatedAt,
		&updated.UpdatedAt,
	); err != nil {
		return nil, fmt.Errorf("tasks: update comment in tx: %w", err)
	}
	if threadRootMessageID.Valid {
		updated.ThreadRootMessageID = &threadRootMessageID.UUID
		var rootChannelID uuid.UUID
		var editedAt time.Time
		if err := tx.QueryRow(ctx, `
			UPDATE messages
			   SET body = $2,
			       edited_at = now()
			 WHERE id = $1
			RETURNING channel_id, edited_at`,
			threadRootMessageID.UUID,
			body,
		).Scan(&rootChannelID, &editedAt); err != nil {
			return nil, fmt.Errorf("tasks: update comment thread root: %w", err)
		}
		updatedEvt := &packetspb.MessageUpdatedEvent{
			ConversationId:  rootChannelID.String(),
			MessageId:       threadRootMessageID.UUID.String(),
			Body:            body,
			MentionEveryone: false,
			EditedAt:        timestamppb.New(editedAt),
		}
		updatedServerEvt := &packetspb.ServerEvent{
			EventType:      packetspb.EventType_EVENT_TYPE_MESSAGE_UPDATED,
			ConversationId: rootChannelID.String(),
			Payload:        &packetspb.ServerEvent_MessageUpdated{MessageUpdated: updatedEvt},
		}
		if err := s.appendAndNotifyTx(ctx, tx, "message_updated", rootChannelID.String(), updatedEvt, updatedServerEvt); err != nil {
			return nil, fmt.Errorf("tasks: emit comment thread root update: %w", err)
		}
	}

	if len(toLink) > 0 {
		tag, err := tx.Exec(ctx, `
			UPDATE task_comment_attachment
			   SET comment_id = $1
			 WHERE id = ANY($2::uuid[])
			   AND comment_id IS NULL`,
			commentID,
			toLink,
		)
		if err != nil {
			return nil, fmt.Errorf("tasks: link updated comment attachments: %w", err)
		}
		if tag.RowsAffected() != int64(len(toLink)) {
			return nil, fmt.Errorf("%w: failed to link all attachments", ErrBadRequest)
		}
	}

	if len(removed) > 0 {
		deleteIDs := make([]uuid.UUID, 0, len(removed))
		for _, attachment := range removed {
			deleteIDs = append(deleteIDs, attachment.ID)
		}
		tag, err := tx.Exec(ctx, `
			DELETE FROM task_comment_attachment
			 WHERE id = ANY($1::uuid[])
			   AND comment_id = $2`,
			deleteIDs,
			commentID,
		)
		if err != nil {
			return nil, fmt.Errorf("tasks: delete removed comment attachments: %w", err)
		}
		if tag.RowsAffected() != int64(len(deleteIDs)) {
			return nil, fmt.Errorf("%w: failed to delete all removed attachments", ErrBadRequest)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("tasks: commit update comment tx: %w", err)
	}

	if len(removed) > 0 {
		store, err := s.requireStore()
		if err != nil {
			return nil, err
		}
		for _, attachment := range removed {
			s.deleteObjectBestEffort(ctx, store, attachment.StorageKey)
		}
	}

	item, err := s.getCommentWithAttachments(ctx, taskID, commentID)
	if err != nil {
		return nil, err
	}
	return item, nil
}

// EnsureCommentThread lazily creates the hidden chat thread backing a task comment.
func (s *Service) EnsureCommentThread(ctx context.Context, taskID, commentID, actorID uuid.UUID) (*CommentThreadRow, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("tasks: begin ensure comment thread tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, taskID.String()); err != nil {
		return nil, fmt.Errorf("tasks: lock comment thread advisory key: %w", err)
	}

	var (
		publicID            string
		title               string
		discussionChannelID uuid.NullUUID
	)
	if err := tx.QueryRow(ctx, `
		SELECT public_id, title, discussion_channel_id
		  FROM task
		 WHERE id = $1`,
		taskID,
	).Scan(&publicID, &title, &discussionChannelID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("%w: task", ErrNotFound)
		}
		return nil, fmt.Errorf("tasks: lock task for comment thread: %w", err)
	}

	var (
		authorID            uuid.UUID
		threadRootMessageID uuid.NullUUID
		body                string
	)
	if err := tx.QueryRow(ctx, `
		SELECT author_id, thread_root_message_id, body
		  FROM task_comment
		 WHERE id = $1
		   AND task_id = $2
		 FOR UPDATE`,
		commentID,
		taskID,
	).Scan(&authorID, &threadRootMessageID, &body); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("%w: comment", ErrNotFound)
		}
		return nil, fmt.Errorf("tasks: lock comment for thread: %w", err)
	}

	channelID := discussionChannelID.UUID
	if !discussionChannelID.Valid {
		name := strings.TrimSpace(publicID)
		if name == "" {
			name = taskID.String()
		}
		if title = strings.TrimSpace(title); title != "" {
			name = name + " " + title
		}
		name = truncateUTF8Runes(name, 120)
		if err := tx.QueryRow(ctx, `
			INSERT INTO channels (kind, visibility, name, topic, created_by, hidden)
			VALUES ('channel', 'private', $1, 'Task comment threads', $2, true)
			RETURNING id`,
			name,
			actorID,
		).Scan(&channelID); err != nil {
			return nil, fmt.Errorf("tasks: create hidden task discussion channel: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO channel_members (channel_id, user_id)
			SELECT $1, u.id
			  FROM users u
			 WHERE u.status = 'active'
			   AND u.role <> 'bot'
			ON CONFLICT (channel_id, user_id) DO UPDATE
			    SET is_archived = false`,
			channelID,
		); err != nil {
			return nil, fmt.Errorf("tasks: add hidden task channel members: %w", err)
		}
		if _, err := tx.Exec(ctx, `SET LOCAL msgnr.preserve_task_updated_at = 'on'`); err != nil {
			return nil, fmt.Errorf("tasks: preserve task updated_at setting: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE task
			   SET discussion_channel_id = $2
			 WHERE id = $1`,
			taskID,
			channelID,
		); err != nil {
			return nil, fmt.Errorf("tasks: link hidden task discussion channel: %w", err)
		}
	} else {
		if _, err := tx.Exec(ctx, `
			INSERT INTO channel_members (channel_id, user_id)
			VALUES ($1, $2)
			ON CONFLICT (channel_id, user_id) DO UPDATE
			    SET is_archived = false`,
			channelID,
			actorID,
		); err != nil {
			return nil, fmt.Errorf("tasks: ensure requester task channel membership: %w", err)
		}
	}

	rootID := threadRootMessageID.UUID
	if !threadRootMessageID.Valid {
		var channelSeq int64
		var createdAt time.Time
		if err := tx.QueryRow(ctx, `
			WITH seq AS (
			    UPDATE channels
			       SET next_seq = next_seq + 1,
			           last_activity_at = now()
			     WHERE id = $1
			     RETURNING next_seq
			)
			INSERT INTO messages (channel_id, channel_seq, sender_id, client_msg_id, body,
			                      thread_root_id, thread_seq, mention_everyone, created_at)
			VALUES ($1, (SELECT next_seq FROM seq), $2, $3, $4, NULL, 0, false, now())
			RETURNING id, channel_seq, created_at`,
			channelID,
			authorID,
			"task-comment-root:"+commentID.String(),
			body,
		).Scan(&rootID, &channelSeq, &createdAt); err != nil {
			return nil, fmt.Errorf("tasks: create comment thread root: %w", err)
		}
		msgProto := &packetspb.MessageEvent{
			ConversationId: channelID.String(),
			MessageId:      rootID.String(),
			SenderId:       authorID.String(),
			Body:           body,
			ChannelSeq:     channelSeq,
			CreatedAt:      timestamppb.New(createdAt),
		}
		msgServerEvt := &packetspb.ServerEvent{
			EventType:      packetspb.EventType_EVENT_TYPE_MESSAGE_CREATED,
			ConversationId: channelID.String(),
			Payload:        &packetspb.ServerEvent_MessageCreated{MessageCreated: msgProto},
		}
		if err := s.appendAndNotifyTx(ctx, tx, "message_created", channelID.String(), msgProto, msgServerEvt); err != nil {
			return nil, fmt.Errorf("tasks: emit comment thread root event: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE task_comment
			   SET thread_root_message_id = $3
			 WHERE id = $1
			   AND task_id = $2`,
			commentID,
			taskID,
			rootID,
		); err != nil {
			return nil, fmt.Errorf("tasks: link comment thread root: %w", err)
		}
	}

	var replyCount int
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE((
			SELECT reply_count
			  FROM thread_summaries
			 WHERE root_message_id = $1
		), 0)::int`,
		rootID,
	).Scan(&replyCount); err != nil {
		return nil, fmt.Errorf("tasks: load comment thread reply count: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("tasks: commit ensure comment thread tx: %w", err)
	}

	return &CommentThreadRow{
		ConversationID:      channelID,
		ThreadRootMessageID: rootID,
		ThreadReplyCount:    replyCount,
	}, nil
}

func (s *Service) appendAndNotifyTx(
	ctx context.Context,
	tx pgx.Tx,
	eventType, channelID string,
	payload proto.Message,
	wrapper *packetspb.ServerEvent,
) error {
	payloadJSON, err := protojson.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal %s: %w", eventType, err)
	}
	stored, err := s.eventStore.AppendEventTx(ctx, tx, events.AppendParams{
		EventID:      uuid.New().String(),
		EventType:    eventType,
		ChannelID:    channelID,
		PayloadJSON:  payloadJSON,
		ProtoPayload: wrapper,
	})
	if err != nil {
		return fmt.Errorf("append %s: %w", eventType, err)
	}
	if err := s.eventStore.NotifyEventTx(ctx, tx, stored.Seq); err != nil {
		return fmt.Errorf("notify %s: %w", eventType, err)
	}
	return nil
}

func (s *Service) requireStore() (Storage, error) {
	if s.store == nil {
		return nil, fmt.Errorf("tasks: attachment storage unavailable")
	}
	return s.store, nil
}

func (s *Service) deleteObjectBestEffort(ctx context.Context, store Storage, storageKey string) {
	if store == nil {
		return
	}
	if err := store.DeleteObject(ctx, storageKey); err != nil {
		// Best-effort only: cleanup failure can leave an orphaned object, but
		// should not fail the higher-level operation after DB state is finalized.
		_ = err
	}
}

// ListComments returns all comments for a task in chronological order.
func (s *Service) ListComments(ctx context.Context, taskID uuid.UUID) ([]CommentRow, error) {
	if _, err := s.q.TaskGet(ctx, taskID); err != nil {
		return nil, mapNotFound(err, "task")
	}
	rows, err := s.q.TaskCommentListWithAttachments(ctx, taskID)
	if err != nil {
		return nil, fmt.Errorf("tasks: list comments: %w", err)
	}

	out := make([]CommentRow, 0, len(rows))
	for _, row := range rows {
		item, err := mapCommentListRow(row)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, nil
}

func (s *Service) getCommentWithAttachments(ctx context.Context, taskID, commentID uuid.UUID) (*CommentRow, error) {
	row, err := s.q.TaskCommentGetWithAttachments(ctx, queries.TaskCommentGetWithAttachmentsParams{
		TaskID: taskID,
		ID:     commentID,
	})
	if err != nil {
		return nil, mapNotFound(err, "comment")
	}
	item, err := mapCommentGetRow(row)
	if err != nil {
		return nil, err
	}
	return &item, nil
}

// uniqueUUIDs removes duplicate UUIDs while preserving the first-seen order.
func uniqueUUIDs(ids []uuid.UUID) []uuid.UUID {
	if len(ids) == 0 {
		return nil
	}
	seen := make(map[uuid.UUID]struct{}, len(ids))
	out := make([]uuid.UUID, 0, len(ids))
	for _, id := range ids {
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out
}

func normalizeJSONValue(v any) ([]byte, error) {
	switch value := v.(type) {
	case nil:
		return nil, nil
	case []byte:
		return value, nil
	case string:
		return []byte(value), nil
	case json.RawMessage:
		return value, nil
	default:
		b, err := json.Marshal(value)
		if err != nil {
			return nil, err
		}
		return b, nil
	}
}

type taskCommentAttachmentScanner interface {
	Scan(dest ...any) error
}

func scanTaskCommentAttachment(scanner taskCommentAttachmentScanner) (CommentAttachmentRow, error) {
	var item CommentAttachmentRow
	var commentID uuid.NullUUID
	if err := scanner.Scan(
		&item.ID,
		&item.TaskID,
		&commentID,
		&item.FileName,
		&item.FileSize,
		&item.MimeType,
		&item.StorageKey,
		&item.UploadedBy,
		&item.CreatedAt,
	); err != nil {
		return CommentAttachmentRow{}, err
	}
	if commentID.Valid {
		commentUUID := commentID.UUID
		item.CommentID = &commentUUID
	}
	return item, nil
}

// =========================================================
// Phase 6 mapper helpers
// =========================================================

func mapAttachment(r queries.TaskAttachment) AttachmentRow {
	return AttachmentRow{
		ID:         r.ID,
		TaskID:     r.TaskID,
		FileName:   r.FileName,
		FileSize:   r.FileSize,
		MimeType:   r.MimeType,
		StorageKey: r.StorageKey,
		UploadedBy: r.UploadedBy,
		CreatedAt:  r.CreatedAt,
	}
}

func taskHistoryAttachment(row AttachmentRow) TaskHistoryAttachment {
	return TaskHistoryAttachment{
		ID:       row.ID,
		FileName: row.FileName,
		FileSize: row.FileSize,
		MimeType: row.MimeType,
	}
}

func taskHistoryAttachmentFromStaged(row StagedAttachmentRow) TaskHistoryAttachment {
	return TaskHistoryAttachment{
		ID:       row.ID,
		FileName: row.FileName,
		FileSize: row.FileSize,
		MimeType: row.MimeType,
	}
}

func taskHistoryAttachments(rows []AttachmentRow) []TaskHistoryAttachment {
	items := make([]TaskHistoryAttachment, len(rows))
	for index, row := range rows {
		items[index] = taskHistoryAttachment(row)
	}
	return items
}

func mapTaskStagedAttachment(r queries.TaskStagedAttachment) StagedAttachmentRow {
	return StagedAttachmentRow{
		ID:         r.ID,
		FileName:   r.FileName,
		FileSize:   r.FileSize,
		MimeType:   r.MimeType,
		StorageKey: r.StorageKey,
		UploadedBy: r.UploadedBy,
		CreatedAt:  r.CreatedAt,
	}
}

func mapTaskCommentAttachment(r queries.TaskCommentAttachment) CommentAttachmentRow {
	var commentID *uuid.UUID
	if r.CommentID.Valid {
		id := r.CommentID.UUID
		commentID = &id
	}
	return CommentAttachmentRow{
		ID:         r.ID,
		TaskID:     r.TaskID,
		CommentID:  commentID,
		FileName:   r.FileName,
		FileSize:   r.FileSize,
		MimeType:   r.MimeType,
		StorageKey: r.StorageKey,
		UploadedBy: r.UploadedBy,
		CreatedAt:  r.CreatedAt,
	}
}

func mapCommentListRow(row queries.TaskCommentListWithAttachmentsRow) (CommentRow, error) {
	return mapCommentWithAttachments(
		row.ID,
		row.TaskID,
		row.AuthorID,
		row.ThreadRootMessageID,
		row.ThreadReplyCount,
		row.Body,
		row.CreatedAt,
		row.UpdatedAt,
		row.Attachments,
	)
}

func mapCommentGetRow(row queries.TaskCommentGetWithAttachmentsRow) (CommentRow, error) {
	return mapCommentWithAttachments(
		row.ID,
		row.TaskID,
		row.AuthorID,
		row.ThreadRootMessageID,
		row.ThreadReplyCount,
		row.Body,
		row.CreatedAt,
		row.UpdatedAt,
		row.Attachments,
	)
}

func mapCommentWithAttachments(
	id, taskID, authorID uuid.UUID,
	threadRootMessageID uuid.NullUUID,
	threadReplyCount int,
	body string,
	createdAt, updatedAt time.Time,
	attachments any,
) (CommentRow, error) {
	item := CommentRow{
		ID:               id,
		TaskID:           taskID,
		AuthorID:         authorID,
		ThreadReplyCount: threadReplyCount,
		Body:             body,
		CreatedAt:        createdAt,
		UpdatedAt:        updatedAt,
	}
	if threadRootMessageID.Valid {
		item.ThreadRootMessageID = &threadRootMessageID.UUID
	}
	attachmentsJSON, err := normalizeJSONValue(attachments)
	if err != nil {
		return CommentRow{}, fmt.Errorf("tasks: normalize comment attachments: %w", err)
	}
	if len(attachmentsJSON) > 0 {
		if err := json.Unmarshal(attachmentsJSON, &item.Attachments); err != nil {
			return CommentRow{}, fmt.Errorf("tasks: decode comment attachments: %w", err)
		}
	}
	if item.Attachments == nil {
		item.Attachments = []CommentAttachmentRow{}
	}
	return item, nil
}

// sanitiseFileName strips path separators and other problematic characters
// so that the file name is safe to embed in an object storage key.
func sanitiseFileName(name string) string {
	// Replace any forward/backslash with underscore.
	name = strings.NewReplacer("/", "_", "\\", "_").Replace(name)
	// Remove characters that are problematic in URLs / object keys.
	var b strings.Builder
	for _, r := range name {
		if r <= 0x1f || r == 0x7f {
			continue
		}
		b.WriteRune(r)
	}
	result := b.String()
	if result == "" {
		return "file"
	}
	return result
}

func nullStringsEqual(a, b sql.NullString) bool {
	if a.Valid != b.Valid {
		return false
	}
	if !a.Valid {
		return true
	}
	return a.String == b.String
}

func nullInt32Ptr(v *int32) sql.NullInt32 {
	if v == nil {
		return sql.NullInt32{}
	}
	return sql.NullInt32{Int32: *v, Valid: true}
}

func nullTimePtr(v *time.Time) sql.NullTime {
	if v == nil {
		return sql.NullTime{}
	}
	return sql.NullTime{Time: *v, Valid: true}
}

func nullUUIDsEqual(a, b uuid.NullUUID) bool {
	if a.Valid != b.Valid {
		return false
	}
	if !a.Valid {
		return true
	}
	return a.UUID == b.UUID
}

func nullInt32Equal(a, b sql.NullInt32) bool {
	if a.Valid != b.Valid {
		return false
	}
	if !a.Valid {
		return true
	}
	return a.Int32 == b.Int32
}

func nullTimesEqual(a, b sql.NullTime) bool {
	if a.Valid != b.Valid {
		return false
	}
	if !a.Valid {
		return true
	}
	return a.Time.Equal(b.Time)
}

func nullNumericStringsEqual(a, b sql.NullString) bool {
	if a.Valid != b.Valid {
		return false
	}
	if !a.Valid {
		return true
	}
	var left, right big.Rat
	if _, ok := left.SetString(a.String); !ok {
		return false
	}
	if _, ok := right.SetString(b.String); !ok {
		return false
	}
	return left.Cmp(&right) == 0
}

func canonicalJSONForCompare(raw json.RawMessage) (json.RawMessage, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil, true
	}
	var decoded any
	if err := json.Unmarshal(trimmed, &decoded); err != nil {
		return trimmed, false
	}
	canonical, err := json.Marshal(decoded)
	if err != nil {
		return trimmed, false
	}
	return canonical, true
}

func rawJSONEqual(a json.RawMessage, aValid, aComparable bool, b json.RawMessage, bValid, bComparable bool) bool {
	if aValid != bValid {
		return false
	}
	if !aValid {
		return true
	}
	if aComparable != bComparable {
		return false
	}
	if !aComparable {
		return bytes.Equal(a, b)
	}
	return bytes.Equal(a, b)
}

func truncateUTF8Runes(value string, maxRunes int) string {
	if maxRunes <= 0 || value == "" {
		return ""
	}
	if utf8.RuneCountInString(value) <= maxRunes {
		return value
	}
	runes := []rune(value)
	return string(runes[:maxRunes])
}
