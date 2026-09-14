package integrations

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"msgnr/internal/auth"
	"msgnr/internal/documents"
	"msgnr/internal/tasks"
)

var ErrUnauthorized = errors.New("unauthorized")

const enumLookupResultLimit = 200

type Service struct {
	pool      *pgxpool.Pool
	tasks     *tasks.Service
	documents *documents.Service
	log       *zap.Logger
}

type integrationTaskResponseDTO struct {
	PublicID    string                            `json:"public_id"`
	Title       string                            `json:"title"`
	Description *string                           `json:"description"`
	Status      integrationTaskStatusDTO          `json:"status"`
	Fields      []integrationTaskFieldResponseDTO `json:"fields"`
}

type integrationTaskStatusDTO struct {
	ID   uuid.UUID `json:"id"`
	Code string    `json:"code"`
	Name string    `json:"name"`
}

type integrationTaskFieldResponseDTO struct {
	ID               uuid.UUID       `json:"id"`
	Code             string          `json:"code"`
	Name             string          `json:"name"`
	Type             string          `json:"type"`
	Required         bool            `json:"required"`
	ValueText        *string         `json:"value_text"`
	ValueNumber      *string         `json:"value_number"`
	ValueUserID      *uuid.UUID      `json:"value_user_id"`
	ValueDate        *string         `json:"value_date"`
	ValueDatetime    *time.Time      `json:"value_datetime"`
	ValueJSON        json.RawMessage `json:"value_json"`
	EnumDictionaryID *uuid.UUID      `json:"enum_dictionary_id"`
	EnumVersion      *int32          `json:"enum_version"`
}

type integrationDocumentResponseDTO struct {
	ID          uuid.UUID  `json:"id"`
	ParentID    *uuid.UUID `json:"parent_id"`
	Title       string     `json:"title"`
	Description *string    `json:"description"`
}

type CreateDocumentParams struct {
	Title       string
	Description *string
	ParentID    *uuid.UUID
	TeamspaceID uuid.UUID
	ActorID     uuid.UUID
}

func NewService(pool *pgxpool.Pool, tasksSvc *tasks.Service, documentsSvc *documents.Service, log *zap.Logger) *Service {
	if log == nil {
		log = zap.NewNop()
	}
	return &Service{
		pool:      pool,
		tasks:     tasksSvc,
		documents: documentsSvc,
		log:       log,
	}
}

func (s *Service) VerifyToken(ctx context.Context, rawToken string) (auth.Principal, error) {
	token := strings.TrimSpace(rawToken)
	if token == "" {
		return auth.Principal{}, ErrUnauthorized
	}

	var (
		tokenID uuid.UUID
		userID  uuid.UUID
	)
	err := s.pool.QueryRow(ctx,
		`SELECT it.id, it.user_id
		   FROM integration_token it
		   JOIN users u ON u.id = it.user_id
		  WHERE it.token_hash = $1
		    AND it.revoked_at IS NULL
		    AND u.role = 'bot'
		    AND u.status = 'active'`,
		hashToken(token),
	).Scan(&tokenID, &userID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return auth.Principal{}, ErrUnauthorized
		}
		return auth.Principal{}, fmt.Errorf("integrations: lookup token: %w", err)
	}

	if err := s.touchTokenLastUsed(ctx, tokenID); err != nil {
		s.log.Warn("integrations: touch token last_used_at failed", zap.String("token_id", tokenID.String()), zap.Error(err))
	}

	return auth.Principal{
		UserID: userID,
		Role:   "bot",
	}, nil
}

func (s *Service) touchTokenLastUsed(ctx context.Context, tokenID uuid.UUID) error {
	if _, err := s.pool.Exec(ctx,
		`UPDATE integration_token
		    SET last_used_at = now()
		  WHERE id = $1`,
		tokenID,
	); err != nil {
		return fmt.Errorf("integrations: touch token: %w", err)
	}
	return nil
}

func (s *Service) GetTask(ctx context.Context, publicID string) (integrationTaskResponseDTO, error) {
	taskRow, err := s.tasks.GetTaskByPublicID(ctx, publicID)
	if err != nil {
		return integrationTaskResponseDTO{}, err
	}
	fieldsByTemplateID := make(map[uuid.UUID][]tasks.FieldRow, 1)
	statusesByID, err := s.loadIntegrationStatuses(ctx)
	if err != nil {
		return integrationTaskResponseDTO{}, err
	}
	return s.mapIntegrationTask(ctx, taskRow, fieldsByTemplateID, statusesByID)
}

func (s *Service) FindTasksByEnumValue(ctx context.Context, enumCode, enumValue string) ([]integrationTaskResponseDTO, error) {
	taskRows, err := s.tasks.FindTasksByEnumValue(ctx, enumCode, enumValue, enumLookupResultLimit)
	if err != nil {
		return nil, err
	}

	resp := make([]integrationTaskResponseDTO, 0, len(taskRows))
	fieldsByTemplateID := make(map[uuid.UUID][]tasks.FieldRow)
	statusesByID, err := s.loadIntegrationStatuses(ctx)
	if err != nil {
		return nil, err
	}
	for _, taskRow := range taskRows {
		item, err := s.mapIntegrationTask(ctx, taskRow, fieldsByTemplateID, statusesByID)
		if err != nil {
			return nil, err
		}
		resp = append(resp, item)
	}
	return resp, nil
}

func (s *Service) CreateDocument(ctx context.Context, params CreateDocumentParams) (integrationDocumentResponseDTO, error) {
	row, err := s.documents.CreateDocument(ctx, documents.CreateDocumentParams{
		TeamspaceID:      params.TeamspaceID,
		ParentDocumentID: params.ParentID,
		Title:            params.Title,
		ContentMarkdown:  params.Description,
		ActorID:          params.ActorID,
	})
	if err != nil {
		return integrationDocumentResponseDTO{}, err
	}
	return mapIntegrationDocumentResponse(row), nil
}

func (s *Service) GetDocument(ctx context.Context, documentID, actorID uuid.UUID) (integrationDocumentResponseDTO, error) {
	row, err := s.documents.GetDocument(ctx, documentID, actorID)
	if err != nil {
		return integrationDocumentResponseDTO{}, err
	}
	return mapIntegrationDocumentResponse(row), nil
}

func (s *Service) mapIntegrationTask(
	ctx context.Context,
	taskRow tasks.TaskResponse,
	fieldsByTemplateID map[uuid.UUID][]tasks.FieldRow,
	statusesByID map[uuid.UUID]integrationTaskStatusDTO,
) (integrationTaskResponseDTO, error) {
	fields, ok := fieldsByTemplateID[taskRow.TemplateID]
	if !ok {
		var err error
		fields, err = s.tasks.ListFields(ctx, taskRow.TemplateID, false)
		if err != nil {
			return integrationTaskResponseDTO{}, fmt.Errorf("integrations: list task fields: %w", err)
		}
		fieldsByTemplateID[taskRow.TemplateID] = fields
	}
	status, ok := statusesByID[taskRow.StatusID]
	if !ok {
		return integrationTaskResponseDTO{}, fmt.Errorf("integrations: status %s not found for task %s", taskRow.StatusID, taskRow.ID)
	}
	return mapIntegrationTaskResponse(taskRow, status, fields), nil
}

func (s *Service) loadIntegrationStatuses(ctx context.Context) (map[uuid.UUID]integrationTaskStatusDTO, error) {
	rows, err := s.tasks.ListStatuses(ctx, true)
	if err != nil {
		return nil, fmt.Errorf("integrations: list statuses: %w", err)
	}
	statusesByID := make(map[uuid.UUID]integrationTaskStatusDTO, len(rows))
	for _, row := range rows {
		statusesByID[row.ID] = integrationTaskStatusDTO{
			ID:   row.ID,
			Code: row.Code,
			Name: row.Name,
		}
	}
	return statusesByID, nil
}

func mapIntegrationTaskResponse(
	taskRow tasks.TaskResponse,
	status integrationTaskStatusDTO,
	fields []tasks.FieldRow,
) integrationTaskResponseDTO {
	valuesByFieldID := make(map[uuid.UUID]tasks.FieldValueRow, len(taskRow.FieldValues))
	for _, value := range taskRow.FieldValues {
		valuesByFieldID[value.FieldDefinitionID] = value
	}

	resp := integrationTaskResponseDTO{
		PublicID:    taskRow.PublicID,
		Title:       taskRow.Title,
		Description: taskRow.Description,
		Status:      status,
		Fields:      make([]integrationTaskFieldResponseDTO, 0, len(fields)),
	}
	for _, field := range fields {
		value := valuesByFieldID[field.ID]
		resp.Fields = append(resp.Fields, integrationTaskFieldResponseDTO{
			ID:               field.ID,
			Code:             field.Code,
			Name:             field.Name,
			Type:             field.Type,
			Required:         field.Required,
			ValueText:        value.ValueText,
			ValueNumber:      value.ValueNumber,
			ValueUserID:      value.ValueUserID,
			ValueDate:        value.ValueDate,
			ValueDatetime:    value.ValueDatetime,
			ValueJSON:        cloneRawMessage(value.ValueJSON),
			EnumDictionaryID: value.EnumDictionaryID,
			EnumVersion:      value.EnumVersion,
		})
	}
	return resp
}

func mapIntegrationDocumentResponse(row documents.DocumentResponse) integrationDocumentResponseDTO {
	return integrationDocumentResponseDTO{
		ID:          row.ID,
		ParentID:    row.ParentDocumentID,
		Title:       row.Title,
		Description: row.ContentMarkdown,
	}
}

func cloneRawMessage(value json.RawMessage) json.RawMessage {
	// A zero-length raw message represents "no JSON value" in our field-value
	// mapping; valid stored JSON payloads are always non-empty bytes.
	if len(value) == 0 {
		return nil
	}
	return append(json.RawMessage(nil), value...)
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
