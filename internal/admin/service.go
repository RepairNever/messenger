package admin

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"go.uber.org/zap"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/types/known/timestamppb"

	"msgnr/internal/auth"
	"msgnr/internal/events"
	packetspb "msgnr/internal/gen/proto"
	"msgnr/internal/gen/queries"
)

var (
	ErrNotFound   = errors.New("not found")
	ErrConflict   = errors.New("already exists")
	ErrBadRequest = errors.New("bad request")
)

// UserRow is the admin-facing user representation (no password hash).
type UserRow struct {
	ID                 uuid.UUID `json:"id"`
	Email              string    `json:"email"`
	DisplayName        string    `json:"display_name"`
	AvatarURL          string    `json:"avatar_url"`
	Role               string    `json:"role"`
	Status             string    `json:"status"`
	NeedChangePassword bool      `json:"need_change_password"`
	CreatedAt          time.Time `json:"created_at"`
}

// ChannelRow is the admin-facing channel representation.
type ChannelRow struct {
	ID         uuid.UUID `json:"id"`
	Kind       string    `json:"kind"`
	Visibility string    `json:"visibility"`
	Name       *string   `json:"name"`
	IsArchived bool      `json:"is_archived"`
	CreatedBy  uuid.UUID `json:"created_by"`
	CreatedAt  time.Time `json:"created_at"`
}

// MemberRow is a channel member with user details.
type MemberRow struct {
	ID          uuid.UUID `json:"id"`
	Email       string    `json:"email"`
	DisplayName string    `json:"display_name"`
	AvatarURL   string    `json:"avatar_url"`
	Role        string    `json:"role"`
	Status      string    `json:"status"`
	JoinedAt    time.Time `json:"joined_at"`
}

// CreateUserParams holds input for user creation.
type CreateUserParams struct {
	Email              string
	Password           string
	DisplayName        string
	Role               string
	NeedChangePassword bool
}

// UpdateUserParams holds input for user update.
// Password is optional: empty string means no change.
type UpdateUserParams struct {
	DisplayName      string
	Email            string
	Role             string
	Password         string
	IntegrationToken string
}

// CreateChannelParams holds input for channel creation.
type CreateChannelParams struct {
	Name        string
	Visibility  string
	CreatedBy   uuid.UUID
	AddAllUsers bool
	MemberIDs   []uuid.UUID
}

// Service implements admin business logic.
type Service struct {
	pool                   *pgxpool.Pool
	db                     *sql.DB
	q                      *queries.Queries
	eventStore             *events.Store
	messageAttachmentStore messageAttachmentStorage
	log                    *zap.Logger
}

// messageAttachmentStorage is the object-store subset needed when an admin
// deletion cascades chat attachment rows.
type messageAttachmentStorage interface {
	DeleteObject(ctx context.Context, key string) error
}

func NewService(pool *pgxpool.Pool) *Service {
	sqlDB := stdlib.OpenDBFromPool(pool)
	return &Service{
		pool:       pool,
		db:         sqlDB,
		q:          queries.New(sqlDB),
		eventStore: events.NewStore(pool),
		log:        zap.NewNop(),
	}
}

// ConfigureMessageAttachmentStorage enables cleanup of chat attachment
// originals and generated thumbnails after an admin channel deletion.
func (s *Service) ConfigureMessageAttachmentStorage(store messageAttachmentStorage) {
	s.messageAttachmentStore = store
}

// SetLogger configures logging for best-effort post-commit object cleanup.
func (s *Service) SetLogger(log *zap.Logger) {
	if log == nil {
		s.log = zap.NewNop()
		return
	}
	s.log = log
}

// ---- Users ----

func (s *Service) ListUsers(ctx context.Context) ([]UserRow, error) {
	rows, err := s.q.AdminListUsers(ctx)
	if err != nil {
		return nil, fmt.Errorf("admin: list users: %w", err)
	}
	out := make([]UserRow, len(rows))
	for i, r := range rows {
		out[i] = mapUserRow(userRowSource{
			ID:                 r.ID,
			Email:              r.Email,
			DisplayName:        r.DisplayName,
			AvatarURL:          r.AvatarUrl,
			Role:               r.Role,
			Status:             r.Status,
			NeedChangePassword: r.NeedChangePassword,
			CreatedAt:          r.CreatedAt,
		})
	}
	return out, nil
}

func (s *Service) CreateUser(ctx context.Context, p CreateUserParams) (UserRow, error) {
	if p.Email == "" || p.Password == "" {
		return UserRow{}, fmt.Errorf("%w: email and password required", ErrBadRequest)
	}
	if p.Role == "" {
		p.Role = "member"
	}
	if p.Role != "member" && p.Role != "admin" && p.Role != "bot" {
		return UserRow{}, fmt.Errorf("%w: role must be member, admin, or bot", ErrBadRequest)
	}

	hash, err := auth.HashPassword(p.Password)
	if err != nil {
		return UserRow{}, fmt.Errorf("admin: hash password: %w", err)
	}

	row, err := s.q.AdminCreateUser(ctx, queries.AdminCreateUserParams{
		Email:              p.Email,
		PasswordHash:       hash,
		DisplayName:        p.DisplayName,
		Role:               p.Role,
		NeedChangePassword: p.NeedChangePassword,
	})
	if err != nil {
		if isUniqueViolation(err) {
			return UserRow{}, fmt.Errorf("%w: email already in use", ErrConflict)
		}
		return UserRow{}, fmt.Errorf("admin: create user: %w", err)
	}
	return mapUserRow(userRowSource{
		ID:                 row.ID,
		Email:              row.Email,
		DisplayName:        row.DisplayName,
		AvatarURL:          row.AvatarUrl,
		Role:               row.Role,
		Status:             row.Status,
		NeedChangePassword: row.NeedChangePassword,
		CreatedAt:          row.CreatedAt,
	}), nil
}

func (s *Service) UpdateUser(ctx context.Context, id uuid.UUID, p UpdateUserParams) (UserRow, error) {
	if p.Email == "" {
		return UserRow{}, fmt.Errorf("%w: email is required", ErrBadRequest)
	}
	if p.Role != "member" && p.Role != "admin" && p.Role != "bot" {
		return UserRow{}, fmt.Errorf("%w: role must be member, admin, or bot", ErrBadRequest)
	}
	integrationToken := strings.TrimSpace(p.IntegrationToken)
	if integrationToken != "" && p.Role != "bot" {
		return UserRow{}, fmt.Errorf("%w: integration_token is only allowed for bot users", ErrBadRequest)
	}

	passwordHash := ""
	if p.Password != "" {
		hash, err := auth.HashPassword(p.Password)
		if err != nil {
			return UserRow{}, fmt.Errorf("admin: hash password: %w", err)
		}
		passwordHash = hash
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return UserRow{}, fmt.Errorf("admin: begin update user tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var row UserRow
	if err := tx.QueryRow(ctx,
		`UPDATE users
		    SET display_name  = $2,
		        email         = $3,
		        role          = $4,
		        password_hash = CASE WHEN $5::text <> '' THEN $5::text ELSE password_hash END,
		        updated_at    = now()
		  WHERE id = $1
		  RETURNING id, email, display_name, avatar_url, role, status, need_change_password, created_at`,
		id,
		p.DisplayName,
		p.Email,
		p.Role,
		passwordHash,
	).Scan(
		&row.ID,
		&row.Email,
		&row.DisplayName,
		&row.AvatarURL,
		&row.Role,
		&row.Status,
		&row.NeedChangePassword,
		&row.CreatedAt,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return UserRow{}, ErrNotFound
		}
		if isUniqueViolation(err) {
			return UserRow{}, fmt.Errorf("%w: email already in use", ErrConflict)
		}
		return UserRow{}, fmt.Errorf("admin: update user: %w", err)
	}

	if row.Role != "bot" || integrationToken != "" {
		if _, err := tx.Exec(ctx,
			`UPDATE integration_token
			    SET revoked_at = now()
			  WHERE user_id = $1
			    AND revoked_at IS NULL`,
			id,
		); err != nil {
			return UserRow{}, fmt.Errorf("admin: revoke integration tokens: %w", err)
		}
	}

	if row.Role == "bot" && integrationToken != "" {
		if _, err := tx.Exec(ctx,
			`INSERT INTO integration_token (user_id, token_hash)
			 VALUES ($1, $2)`,
			id,
			auth.HashRefreshToken(integrationToken),
		); err != nil {
			if isUniqueViolation(err) {
				return UserRow{}, fmt.Errorf("%w: integration token already in use", ErrConflict)
			}
			return UserRow{}, fmt.Errorf("admin: insert integration token: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return UserRow{}, fmt.Errorf("admin: commit update user tx: %w", err)
	}

	return row, nil
}

func (s *Service) BlockUser(ctx context.Context, id uuid.UUID) (UserRow, error) {
	return s.setUserStatus(ctx, id, "blocked")
}

func (s *Service) UnblockUser(ctx context.Context, id uuid.UUID) (UserRow, error) {
	return s.setUserStatus(ctx, id, "active")
}

func (s *Service) setUserStatus(ctx context.Context, id uuid.UUID, status string) (UserRow, error) {
	row, err := s.q.AdminSetUserStatus(ctx, queries.AdminSetUserStatusParams{
		ID:     id,
		Status: status,
	})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return UserRow{}, ErrNotFound
		}
		return UserRow{}, fmt.Errorf("admin: set user status: %w", err)
	}
	return mapUserRow(userRowSource{
		ID:                 row.ID,
		Email:              row.Email,
		DisplayName:        row.DisplayName,
		AvatarURL:          row.AvatarUrl,
		Role:               row.Role,
		Status:             row.Status,
		NeedChangePassword: row.NeedChangePassword,
		CreatedAt:          row.CreatedAt,
	}), nil
}

func (s *Service) SetNeedChangePassword(ctx context.Context, id uuid.UUID, val bool) (UserRow, error) {
	row, err := s.q.AdminSetNeedChangePassword(ctx, queries.AdminSetNeedChangePasswordParams{
		ID:                 id,
		NeedChangePassword: val,
	})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return UserRow{}, ErrNotFound
		}
		return UserRow{}, fmt.Errorf("admin: set need_change_password: %w", err)
	}
	return mapUserRow(userRowSource{
		ID:                 row.ID,
		Email:              row.Email,
		DisplayName:        row.DisplayName,
		AvatarURL:          row.AvatarUrl,
		Role:               row.Role,
		Status:             row.Status,
		NeedChangePassword: row.NeedChangePassword,
		CreatedAt:          row.CreatedAt,
	}), nil
}

// ---- Channels ----

func (s *Service) ListChannels(ctx context.Context) ([]ChannelRow, error) {
	rows, err := s.q.AdminListChannels(ctx)
	if err != nil {
		return nil, fmt.Errorf("admin: list channels: %w", err)
	}
	out := make([]ChannelRow, len(rows))
	for i, r := range rows {
		out[i] = toChannelRow(r.ID, r.Kind, r.Visibility, r.Name, r.IsArchived, r.CreatedBy, r.CreatedAt)
	}
	return out, nil
}

func (s *Service) CreateChannel(ctx context.Context, p CreateChannelParams) (ChannelRow, error) {
	if p.Name == "" {
		return ChannelRow{}, fmt.Errorf("%w: name required", ErrBadRequest)
	}
	if p.Visibility == "" {
		p.Visibility = "public"
	}
	if p.Visibility != "public" && p.Visibility != "private" {
		return ChannelRow{}, fmt.Errorf("%w: visibility must be public or private", ErrBadRequest)
	}
	if p.Visibility == "private" && p.AddAllUsers {
		return ChannelRow{}, fmt.Errorf("%w: add_all_users is not allowed for private channels", ErrBadRequest)
	}
	if p.Visibility == "private" && len(p.MemberIDs) == 0 {
		return ChannelRow{}, fmt.Errorf("%w: private channels require at least one member", ErrBadRequest)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ChannelRow{}, fmt.Errorf("admin: begin create channel tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var (
		rowID         uuid.UUID
		rowKind       string
		rowVisibility string
		rowName       sql.NullString
		rowArchived   bool
		rowCreatedBy  uuid.UUID
		rowCreatedAt  time.Time
	)
	err = tx.QueryRow(ctx,
		`INSERT INTO channels (kind, visibility, name, created_by)
		 VALUES ('channel', $1, $2, $3)
		 RETURNING id, kind, visibility, name, is_archived, created_by, created_at`,
		p.Visibility,
		p.Name,
		p.CreatedBy,
	).Scan(&rowID, &rowKind, &rowVisibility, &rowName, &rowArchived, &rowCreatedBy, &rowCreatedAt)
	if err != nil {
		return ChannelRow{}, fmt.Errorf("admin: create channel: %w", err)
	}
	row := toChannelRow(rowID, rowKind, rowVisibility, rowName, rowArchived, rowCreatedBy, rowCreatedAt)

	if _, err := tx.Exec(ctx,
		`INSERT INTO channel_members (channel_id, user_id)
		 VALUES ($1, $2)
		 ON CONFLICT DO NOTHING`,
		row.ID, p.CreatedBy,
	); err != nil {
		return ChannelRow{}, fmt.Errorf("admin: add creator channel member: %w", err)
	}

	if p.AddAllUsers {
		if _, err := tx.Exec(ctx,
			`INSERT INTO channel_members (channel_id, user_id)
			 SELECT $1, u.id
			 FROM users u
			 WHERE u.role <> 'bot'
			 ON CONFLICT DO NOTHING`,
			row.ID,
		); err != nil {
			return ChannelRow{}, fmt.Errorf("admin: add all channel members: %w", err)
		}
	}

	for _, memberID := range p.MemberIDs {
		if _, err := tx.Exec(ctx,
			`INSERT INTO channel_members (channel_id, user_id)
			 VALUES ($1, $2)
			 ON CONFLICT DO NOTHING`,
			row.ID, memberID,
		); err != nil {
			return ChannelRow{}, fmt.Errorf("admin: add selected channel members: %w", err)
		}
	}

	var memberCount int32
	if err := tx.QueryRow(ctx, `SELECT COUNT(*)::int FROM channel_members WHERE channel_id = $1`, row.ID).Scan(&memberCount); err != nil {
		return ChannelRow{}, fmt.Errorf("admin: count channel members: %w", err)
	}

	// NotificationLevel intentionally omitted: this is a broadcast event
	// delivered to all members. The per-member notification level is only
	// populated in the bootstrap snapshot (which is per-user).
	summary := &packetspb.ConversationSummary{
		ConversationId:     row.ID.String(),
		ConversationType:   visibilityToConversationType(row.Visibility),
		Title:              stringValue(row.Name),
		Topic:              "",
		IsArchived:         row.IsArchived,
		LastMessageSeq:     0,
		LastMessagePreview: "",
		LastActivityAt:     timestamppb.New(row.CreatedAt),
		MemberCount:        memberCount,
	}
	upserted := &packetspb.ConversationUpsertedEvent{Conversation: summary}
	payloadJSON, err := protojson.Marshal(upserted)
	if err != nil {
		return ChannelRow{}, fmt.Errorf("admin: marshal conversation upserted: %w", err)
	}
	stored, err := s.eventStore.AppendEventTx(ctx, tx, events.AppendParams{
		EventID:     uuid.NewString(),
		EventType:   "conversation_upserted",
		ChannelID:   row.ID.String(),
		PayloadJSON: payloadJSON,
		ProtoPayload: &packetspb.ServerEvent{
			EventType:      packetspb.EventType_EVENT_TYPE_CONVERSATION_UPSERTED,
			ConversationId: row.ID.String(),
			OccurredAt:     timestamppb.New(row.CreatedAt),
			Payload: &packetspb.ServerEvent_ConversationUpserted{
				ConversationUpserted: upserted,
			},
		},
	})
	if err != nil {
		return ChannelRow{}, fmt.Errorf("admin: append conversation upserted event: %w", err)
	}
	if err := s.eventStore.NotifyEventTx(ctx, tx, stored.Seq); err != nil {
		return ChannelRow{}, fmt.Errorf("admin: notify conversation upserted event: %w", err)
	}

	seen := make(map[uuid.UUID]struct{}, len(p.MemberIDs))
	for _, memberID := range p.MemberIDs {
		if memberID == p.CreatedBy {
			continue
		}
		if _, exists := seen[memberID]; exists {
			continue
		}
		seen[memberID] = struct{}{}
		if err := s.createChannelInviteNotificationTx(ctx, tx, row, memberID); err != nil {
			return ChannelRow{}, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return ChannelRow{}, fmt.Errorf("admin: commit create channel: %w", err)
	}
	return row, nil
}

func (s *Service) DeleteChannel(ctx context.Context, id uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("admin: begin delete channel: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	attachmentKeys, err := listMessageAttachmentObjectKeysForChannelDelete(ctx, tx, id)
	if err != nil {
		return fmt.Errorf("admin: list channel attachment keys: %w", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM channels WHERE id = $1`, id); err != nil {
		return fmt.Errorf("admin: delete channel: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("admin: commit delete channel: %w", err)
	}

	s.cleanupDeletedMessageAttachmentObjects(attachmentKeys)
	return nil
}

func listMessageAttachmentObjectKeysForChannelDelete(ctx context.Context, tx pgx.Tx, channelID uuid.UUID) ([]string, error) {
	rows, err := tx.Query(ctx, `
		SELECT storage_key, thumbnail_storage_key
		  FROM message_attachment
		 WHERE conversation_id = $1`, channelID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	keys := make([]string, 0)
	seen := make(map[string]struct{})
	for rows.Next() {
		var storageKey string
		var thumbnailStorageKey sql.NullString
		if err := rows.Scan(&storageKey, &thumbnailStorageKey); err != nil {
			return nil, err
		}
		for _, key := range []string{storageKey, thumbnailStorageKey.String} {
			key = strings.TrimSpace(key)
			if key == "" {
				continue
			}
			if _, exists := seen[key]; exists {
				continue
			}
			seen[key] = struct{}{}
			keys = append(keys, key)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return keys, nil
}

func (s *Service) cleanupDeletedMessageAttachmentObjects(keys []string) {
	if s.messageAttachmentStore == nil || len(keys) == 0 {
		return
	}

	go func() {
		for _, key := range keys {
			var referenced bool
			if err := s.pool.QueryRow(context.Background(), `
				SELECT EXISTS (
					SELECT 1
					  FROM message_attachment
					 WHERE storage_key = $1
					    OR thumbnail_storage_key = $1
				)`, key).Scan(&referenced); err != nil {
				s.log.Warn("admin channel attachment reference check failed",
					zap.String("reason", "database"),
					zap.Error(err))
				continue
			}
			if referenced {
				continue
			}
			if err := s.messageAttachmentStore.DeleteObject(context.Background(), key); err != nil {
				s.log.Warn("admin channel attachment cleanup failed",
					zap.String("reason", "storage_delete"),
					zap.Error(err))
			}
		}
	}()
}

func (s *Service) RenameChannel(ctx context.Context, channelID uuid.UUID, name string) (ChannelRow, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return ChannelRow{}, fmt.Errorf("%w: name required", ErrBadRequest)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ChannelRow{}, fmt.Errorf("admin: begin rename channel tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var (
		rowID         uuid.UUID
		rowKind       string
		rowVisibility string
		rowName       sql.NullString
		rowOldName    sql.NullString
		rowArchived   bool
		rowCreatedBy  uuid.UUID
		rowCreatedAt  time.Time
	)
	err = tx.QueryRow(ctx, `SELECT name FROM channels WHERE id = $1`, channelID).Scan(&rowOldName)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ChannelRow{}, ErrNotFound
		}
		return ChannelRow{}, fmt.Errorf("admin: load channel name: %w", err)
	}

	err = tx.QueryRow(ctx,
		`UPDATE channels
		 SET name = $1
		 WHERE id = $2
		 RETURNING id, kind, visibility, name, is_archived, created_by, created_at`,
		name,
		channelID,
	).Scan(&rowID, &rowKind, &rowVisibility, &rowName, &rowArchived, &rowCreatedBy, &rowCreatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ChannelRow{}, ErrNotFound
		}
		return ChannelRow{}, fmt.Errorf("admin: rename channel: %w", err)
	}
	row := toChannelRow(rowID, rowKind, rowVisibility, rowName, rowArchived, rowCreatedBy, rowCreatedAt)
	oldTitle := ""
	if rowOldName.Valid {
		oldTitle = rowOldName.String
	}
	newTitle := name

	var memberCount int32
	if err := tx.QueryRow(ctx, `SELECT COUNT(*)::int FROM channel_members WHERE channel_id = $1`, channelID).Scan(&memberCount); err != nil {
		return ChannelRow{}, fmt.Errorf("admin: count channel members: %w", err)
	}

	// NotificationLevel intentionally omitted: broadcast event (see CreateChannel).
	summary := &packetspb.ConversationSummary{
		ConversationId:     row.ID.String(),
		ConversationType:   visibilityToConversationType(row.Visibility),
		Title:              stringValue(row.Name),
		Topic:              "",
		IsArchived:         row.IsArchived,
		LastMessageSeq:     0,
		LastMessagePreview: "",
		LastActivityAt:     timestamppb.New(time.Now()),
		MemberCount:        memberCount,
	}
	upserted := &packetspb.ConversationUpsertedEvent{Conversation: summary}
	payloadJSON, err := protojson.Marshal(upserted)
	if err != nil {
		return ChannelRow{}, fmt.Errorf("admin: marshal conversation upserted: %w", err)
	}
	stored, err := s.eventStore.AppendEventTx(ctx, tx, events.AppendParams{
		EventID:     uuid.NewString(),
		EventType:   "conversation_upserted",
		ChannelID:   row.ID.String(),
		PayloadJSON: payloadJSON,
		ProtoPayload: &packetspb.ServerEvent{
			EventType:      packetspb.EventType_EVENT_TYPE_CONVERSATION_UPSERTED,
			ConversationId: row.ID.String(),
			OccurredAt:     timestamppb.New(time.Now()),
			Payload: &packetspb.ServerEvent_ConversationUpserted{
				ConversationUpserted: upserted,
			},
		},
	})
	if err != nil {
		return ChannelRow{}, fmt.Errorf("admin: append conversation upserted event: %w", err)
	}
	if err := s.eventStore.NotifyEventTx(ctx, tx, stored.Seq); err != nil {
		return ChannelRow{}, fmt.Errorf("admin: notify conversation upserted event: %w", err)
	}

	memberRows, err := s.q.AdminListChannelMembers(ctx, channelID)
	if err != nil {
		return ChannelRow{}, fmt.Errorf("admin: list channel members for rename notification: %w", err)
	}
	notificationTitle := fmt.Sprintf("Channel renamed: %s", newTitle)
	notificationBody := fmt.Sprintf("Channel name changed from \"%s\" to \"%s\".", oldTitle, newTitle)
	for _, member := range memberRows {
		if err := s.createChannelNotificationTx(
			ctx,
			tx,
			row,
			member.ID,
			notificationTitle,
			notificationBody,
		); err != nil {
			return ChannelRow{}, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return ChannelRow{}, fmt.Errorf("admin: commit rename channel: %w", err)
	}
	return row, nil
}

// ---- Members ----

func (s *Service) ListChannelMembers(ctx context.Context, channelID uuid.UUID) ([]MemberRow, error) {
	rows, err := s.q.AdminListChannelMembers(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("admin: list channel members: %w", err)
	}
	out := make([]MemberRow, len(rows))
	for i, r := range rows {
		out[i] = MemberRow{
			ID:          r.ID,
			Email:       r.Email,
			DisplayName: r.DisplayName,
			AvatarURL:   r.AvatarUrl,
			Role:        r.Role,
			Status:      r.Status,
			JoinedAt:    r.JoinedAt,
		}
	}
	return out, nil
}

func (s *Service) AddChannelMember(ctx context.Context, channelID, userID uuid.UUID) error {
	if err := s.q.AdminAddChannelMember(ctx, queries.AdminAddChannelMemberParams{
		ChannelID: channelID,
		UserID:    userID,
	}); err != nil {
		return fmt.Errorf("admin: add channel member: %w", err)
	}
	return nil
}

func (s *Service) RemoveChannelMember(ctx context.Context, channelID, userID uuid.UUID) error {
	if err := s.q.AdminRemoveChannelMember(ctx, queries.AdminRemoveChannelMemberParams{
		ChannelID: channelID,
		UserID:    userID,
	}); err != nil {
		return fmt.Errorf("admin: remove channel member: %w", err)
	}
	return nil
}

func (s *Service) createChannelInviteNotificationTx(ctx context.Context, tx pgx.Tx, channel ChannelRow, userID uuid.UUID) error {
	var notificationID uuid.UUID
	var createdAt time.Time
	channelName := stringValue(channel.Name)
	if channelName == "" {
		channelName = "private-channel"
	}
	title := fmt.Sprintf("Added to #%s", channelName)
	body := "You were added to a private channel."

	if err := tx.QueryRow(ctx,
		`INSERT INTO notifications (user_id, type, title, body, channel_id, is_read, created_at)
		 VALUES ($1, 'system', $2, $3, $4, false, now())
		 RETURNING id, created_at`,
		userID, title, body, channel.ID,
	).Scan(&notificationID, &createdAt); err != nil {
		return fmt.Errorf("admin: create channel notification: %w", err)
	}

	notification := &packetspb.NotificationSummary{
		NotificationId: notificationID.String(),
		Type:           packetspb.NotificationType_NOTIFICATION_TYPE_SYSTEM,
		Title:          title,
		Body:           body,
		ConversationId: channel.ID.String(),
		IsRead:         false,
		CreatedAt:      timestamppb.New(createdAt),
	}
	added := &packetspb.NotificationAddedEvent{
		Notification: notification,
		UserId:       userID.String(),
	}
	payloadJSON, err := protojson.Marshal(added)
	if err != nil {
		return fmt.Errorf("admin: marshal channel notification event: %w", err)
	}
	stored, err := s.eventStore.AppendEventTx(ctx, tx, events.AppendParams{
		EventID:     uuid.NewString(),
		EventType:   "notification_added",
		ChannelID:   channel.ID.String(),
		PayloadJSON: payloadJSON,
		ProtoPayload: &packetspb.ServerEvent{
			EventType:      packetspb.EventType_EVENT_TYPE_NOTIFICATION_ADDED,
			ConversationId: channel.ID.String(),
			OccurredAt:     timestamppb.New(createdAt),
			Payload: &packetspb.ServerEvent_NotificationAdded{
				NotificationAdded: added,
			},
		},
	})
	if err != nil {
		return fmt.Errorf("admin: append channel notification event: %w", err)
	}
	if err := s.eventStore.NotifyEventTx(ctx, tx, stored.Seq); err != nil {
		return fmt.Errorf("admin: notify channel notification event: %w", err)
	}
	return nil
}

func (s *Service) createChannelNotificationTx(ctx context.Context, tx pgx.Tx, channel ChannelRow, userID uuid.UUID, title, body string) error {
	var notificationID uuid.UUID
	var createdAt time.Time
	if err := tx.QueryRow(ctx,
		`INSERT INTO notifications (user_id, type, title, body, channel_id, is_read, created_at)
		 VALUES ($1, 'system', $2, $3, $4, false, now())
		 RETURNING id, created_at`,
		userID, title, body, channel.ID,
	).Scan(&notificationID, &createdAt); err != nil {
		return fmt.Errorf("admin: create channel notification: %w", err)
	}

	notification := &packetspb.NotificationSummary{
		NotificationId: notificationID.String(),
		Type:           packetspb.NotificationType_NOTIFICATION_TYPE_SYSTEM,
		Title:          title,
		Body:           body,
		ConversationId: channel.ID.String(),
		IsRead:         false,
		CreatedAt:      timestamppb.New(createdAt),
	}
	added := &packetspb.NotificationAddedEvent{
		Notification: notification,
		UserId:       userID.String(),
	}
	payloadJSON, err := protojson.Marshal(added)
	if err != nil {
		return fmt.Errorf("admin: marshal channel notification event: %w", err)
	}
	stored, err := s.eventStore.AppendEventTx(ctx, tx, events.AppendParams{
		EventID:     uuid.NewString(),
		EventType:   "notification_added",
		ChannelID:   channel.ID.String(),
		PayloadJSON: payloadJSON,
		ProtoPayload: &packetspb.ServerEvent{
			EventType:      packetspb.EventType_EVENT_TYPE_NOTIFICATION_ADDED,
			ConversationId: channel.ID.String(),
			OccurredAt:     timestamppb.New(createdAt),
			Payload: &packetspb.ServerEvent_NotificationAdded{
				NotificationAdded: added,
			},
		},
	})
	if err != nil {
		return fmt.Errorf("admin: append channel notification event: %w", err)
	}
	if err := s.eventStore.NotifyEventTx(ctx, tx, stored.Seq); err != nil {
		return fmt.Errorf("admin: notify channel notification event: %w", err)
	}
	return nil
}

// ---- helpers ----

func toChannelRow(id uuid.UUID, kind, visibility string, name sql.NullString, isArchived bool, createdBy uuid.UUID, createdAt time.Time) ChannelRow {
	row := ChannelRow{
		ID:         id,
		Kind:       kind,
		Visibility: visibility,
		IsArchived: isArchived,
		CreatedBy:  createdBy,
		CreatedAt:  createdAt,
	}
	if name.Valid {
		row.Name = &name.String
	}
	return row
}

type userRowSource struct {
	ID                 uuid.UUID
	Email              string
	DisplayName        string
	AvatarURL          string
	Role               string
	Status             string
	NeedChangePassword bool
	CreatedAt          time.Time
}

func mapUserRow(src userRowSource) UserRow {
	return UserRow{
		ID:                 src.ID,
		Email:              src.Email,
		DisplayName:        src.DisplayName,
		AvatarURL:          src.AvatarURL,
		Role:               src.Role,
		Status:             src.Status,
		NeedChangePassword: src.NeedChangePassword,
		CreatedAt:          src.CreatedAt,
	}
}

func isUniqueViolation(err error) bool {
	// pgconn.PgError code 23505 = unique_violation
	type pgErr interface{ SQLState() string }
	var pe pgErr
	if errors.As(err, &pe) {
		return pe.SQLState() == "23505"
	}
	return false
}

func visibilityToConversationType(visibility string) packetspb.ConversationType {
	switch visibility {
	case "private":
		return packetspb.ConversationType_CONVERSATION_TYPE_CHANNEL_PRIVATE
	default:
		return packetspb.ConversationType_CONVERSATION_TYPE_CHANNEL_PUBLIC
	}
}

func stringValue(name *string) string {
	if name == nil {
		return ""
	}
	return *name
}
