package auth

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"path"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"go.uber.org/zap"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/types/known/timestamppb"

	"msgnr/internal/events"
	packetspb "msgnr/internal/gen/proto"
	"msgnr/internal/gen/queries"
	"msgnr/internal/metrics"
	"msgnr/internal/userstatus"
)

const (
	defaultAvatarMaxSizeMB = 5
	avatarPublicPathPrefix = "/api/public/avatars/"

	userProfileReturningCols = `id, email, display_name, avatar_url, custom_status_text, custom_status_emoji, custom_status_expires_at, role, need_change_password`
)

var (
	ErrInvalidCredentials   = errors.New("invalid credentials")
	ErrUserBlocked          = errors.New("user blocked")
	ErrBotUserUnsupported   = errors.New("bot users cannot use interactive auth")
	ErrProfileBadRequest    = errors.New("invalid profile update request")
	ErrProfileConflict      = errors.New("email already in use")
	ErrPasswordChangeFailed = errors.New("password change failed")

	ErrAvatarNotConfigured = errors.New("avatar storage is not configured")
	ErrAvatarBadRequest    = errors.New("invalid avatar image")
	ErrAvatarTooLarge      = errors.New("avatar file exceeds size limit")
	ErrAvatarUnsupported   = errors.New("unsupported avatar format")
	ErrAvatarNotFound      = errors.New("avatar not found")
)

// Principal holds the verified identity bound to a WS session.
type Principal struct {
	UserID    uuid.UUID
	Role      string
	SessionID uuid.UUID
}

// TokenPair is the result of a successful login or refresh.
type TokenPair struct {
	AccessToken  string
	RefreshToken string
	ExpiresIn    time.Duration
}

// UserInfo is returned to callers alongside the token pair on login.
type UserInfo struct {
	ID                 uuid.UUID
	Email              string
	DisplayName        string
	AvatarURL          string
	CustomStatus       *userstatus.Status
	Role               string
	NeedChangePassword bool
}

// UserRepo is the minimal read interface the service needs from the users table.
type UserRepo interface {
	GetUserByEmail(ctx context.Context, email string) (queries.User, error)
	GetUserByID(ctx context.Context, id uuid.UUID) (queries.User, error)
}

// SessionRepo is the interface the service needs for refresh session storage.
type SessionRepo interface {
	Create(ctx context.Context, p CreateSessionParams) (queries.RefreshSession, error)
	RotateToken(ctx context.Context, p RotateSessionTokenParams) (queries.RefreshSession, error)
	GetActiveByTokenHash(ctx context.Context, tokenHash string) (queries.RefreshSession, error)
	GetActiveByIDAndUser(ctx context.Context, sessionID, userID uuid.UUID) (queries.RefreshSession, error)
	RevokeByID(ctx context.Context, id uuid.UUID) error
	RevokeByTokenHash(ctx context.Context, tokenHash string) error
}

// AvatarStorage is the object storage subset required for avatar operations.
type AvatarStorage interface {
	PutObject(ctx context.Context, key string, r io.Reader, size int64, mimeType string) error
	GetObject(ctx context.Context, key string) (body io.ReadCloser, size int64, mimeType string, err error)
	DeleteObject(ctx context.Context, key string) error
}

// Service handles login, refresh, logout, and access-token verification.
type Service struct {
	tokens     *TokenManager
	sessions   SessionRepo
	users      UserRepo
	db         *pgxpool.Pool
	queries    *queries.Queries
	refreshTTL time.Duration
	log        *zap.Logger

	avatarStore    AvatarStorage
	avatarMaxBytes int64
	eventStore     *events.Store
}

func NewService(
	tokens *TokenManager,
	sessions SessionRepo,
	users UserRepo,
	db *pgxpool.Pool,
	refreshTTL time.Duration,
	log *zap.Logger,
) *Service {
	if log == nil {
		log = zap.NewNop()
	}

	var sqlDB *sql.DB
	var q *queries.Queries
	if db != nil {
		sqlDB = stdlib.OpenDBFromPool(db)
		q = queries.New(sqlDB)
	}

	return &Service{
		tokens:         tokens,
		sessions:       sessions,
		users:          users,
		db:             db,
		queries:        q,
		refreshTTL:     refreshTTL,
		log:            log,
		avatarMaxBytes: int64(defaultAvatarMaxSizeMB) * 1024 * 1024,
	}
}

func (s *Service) ConfigureAvatars(store AvatarStorage, maxSizeMB int, eventStore *events.Store) {
	s.avatarStore = store
	s.eventStore = eventStore
	if maxSizeMB <= 0 {
		maxSizeMB = defaultAvatarMaxSizeMB
	}
	s.avatarMaxBytes = int64(maxSizeMB) * 1024 * 1024
}

func (s *Service) AvatarMaxBytes() int64 {
	if s.avatarMaxBytes <= 0 {
		return int64(defaultAvatarMaxSizeMB) * 1024 * 1024
	}
	return s.avatarMaxBytes
}

// Login verifies credentials and issues a fresh token pair.
func (s *Service) Login(ctx context.Context, email, password, userAgent, ipAddr string) (TokenPair, UserInfo, error) {
	user, err := s.users.GetUserByEmail(ctx, email)
	if err != nil {
		metrics.AuthLoginTotal.WithLabelValues("invalid_credentials").Inc()
		s.log.Info("login: user not found", zap.String("email", email))
		return TokenPair{}, UserInfo{}, ErrInvalidCredentials
	}

	if err := CheckPassword(password, user.PasswordHash); err != nil {
		metrics.AuthLoginTotal.WithLabelValues("invalid_credentials").Inc()
		s.log.Info("login: bad password", zap.String("email", email))
		return TokenPair{}, UserInfo{}, ErrInvalidCredentials
	}

	if user.Status == "blocked" {
		metrics.AuthLoginTotal.WithLabelValues("blocked").Inc()
		s.log.Info("login: user blocked", zap.String("user_id", user.ID.String()))
		return TokenPair{}, UserInfo{}, ErrUserBlocked
	}
	if user.Role == "bot" {
		metrics.AuthLoginTotal.WithLabelValues("invalid_credentials").Inc()
		s.log.Info("login: bot user denied interactive auth", zap.String("user_id", user.ID.String()))
		return TokenPair{}, UserInfo{}, ErrBotUserUnsupported
	}

	pair, sessionID, err := s.issueTokenPair(ctx, user.ID, user.Role, userAgent, ipAddr, user.NeedChangePassword)
	if err != nil {
		metrics.AuthLoginTotal.WithLabelValues("error").Inc()
		return TokenPair{}, UserInfo{}, err
	}

	metrics.AuthLoginTotal.WithLabelValues("success").Inc()
	s.log.Info("login: success",
		zap.String("user_id", user.ID.String()),
		zap.String("session_id", sessionID.String()),
	)

	return pair, userInfoFromRow(user), nil
}

// Refresh rotates the refresh token in-place on the existing session row.
func (s *Service) Refresh(ctx context.Context, rawRefreshToken, userAgent, ipAddr string) (TokenPair, error) {
	tokenHash := HashRefreshToken(rawRefreshToken)

	session, err := s.sessions.GetActiveByTokenHash(ctx, tokenHash)
	if err != nil {
		metrics.AuthRefreshTotal.WithLabelValues("invalid").Inc()
		return TokenPair{}, ErrInvalidCredentials
	}

	user, err := s.users.GetUserByID(ctx, session.UserID)
	if err != nil {
		metrics.AuthRefreshTotal.WithLabelValues("error").Inc()
		return TokenPair{}, fmt.Errorf("refresh: lookup user: %w", err)
	}

	if user.Status == "blocked" {
		metrics.AuthRefreshTotal.WithLabelValues("blocked").Inc()
		s.log.Info("refresh: user blocked", zap.String("user_id", user.ID.String()))
		return TokenPair{}, ErrUserBlocked
	}
	if user.Role == "bot" {
		metrics.AuthRefreshTotal.WithLabelValues("invalid").Inc()
		s.log.Info("refresh: bot user denied interactive auth", zap.String("user_id", user.ID.String()))
		return TokenPair{}, ErrBotUserUnsupported
	}

	rawRefresh, err := GenerateRefreshToken()
	if err != nil {
		metrics.AuthRefreshTotal.WithLabelValues("error").Inc()
		return TokenPair{}, fmt.Errorf("refresh: generate refresh token: %w", err)
	}

	rotatedSession, err := s.sessions.RotateToken(ctx, RotateSessionTokenParams{
		ID:           session.ID,
		OldTokenHash: tokenHash,
		NewTokenHash: HashRefreshToken(rawRefresh),
		UserAgent:    userAgent,
		IPAddr:       ipAddr,
		ExpiresAt:    time.Now().Add(s.refreshTTL),
	})
	if err != nil {
		metrics.AuthRefreshTotal.WithLabelValues("error").Inc()
		if errors.Is(err, ErrSessionNotFound) {
			return TokenPair{}, ErrInvalidCredentials
		}
		return TokenPair{}, fmt.Errorf("refresh: rotate session token: %w", err)
	}

	accessToken, err := s.tokens.IssueAccessToken(user.ID.String(), user.Role, rotatedSession.ID.String(), user.NeedChangePassword)
	if err != nil {
		metrics.AuthRefreshTotal.WithLabelValues("error").Inc()
		return TokenPair{}, fmt.Errorf("refresh: sign access token: %w", err)
	}

	metrics.AuthRefreshTotal.WithLabelValues("success").Inc()
	s.log.Info("refresh: success",
		zap.String("user_id", user.ID.String()),
		zap.String("session_id", rotatedSession.ID.String()),
	)
	return TokenPair{
		AccessToken:  accessToken,
		RefreshToken: rawRefresh,
		ExpiresIn:    s.tokens.accessTTL,
	}, nil
}

func (s *Service) GetProfile(ctx context.Context, userID uuid.UUID) (UserInfo, error) {
	user, err := s.users.GetUserByID(ctx, userID)
	if err != nil {
		return UserInfo{}, err
	}

	return userInfoFromRow(user), nil
}

func (s *Service) UpdateProfile(ctx context.Context, userID uuid.UUID, displayName, email string) (UserInfo, error) {
	displayName = strings.TrimSpace(displayName)
	email = strings.TrimSpace(email)

	if displayName == "" && email == "" {
		return UserInfo{}, fmt.Errorf("%w: display_name or email is required", ErrProfileBadRequest)
	}
	if s.db == nil {
		return UserInfo{}, fmt.Errorf("%w: database is not configured", ErrProfileBadRequest)
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return UserInfo{}, fmt.Errorf("auth: begin update profile tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var row queries.User
	if err := scanUserRow(tx.QueryRow(
		ctx,
		`UPDATE users
		   SET email = COALESCE(NULLIF($1, ''), email),
		       display_name = COALESCE(NULLIF($2, ''), display_name),
		       updated_at = now()
		 WHERE id = $3
		 RETURNING `+userProfileReturningCols,
		email,
		displayName,
		userID,
	), &row); err != nil {
		if isEmailAlreadyInUse(err) {
			return UserInfo{}, ErrProfileConflict
		}
		return UserInfo{}, err
	}

	if err := s.appendUserIdentityUpdatedEventTx(ctx, tx, row.ID, row.DisplayName, row.AvatarUrl, customStatusFromRow(row)); err != nil {
		return UserInfo{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return UserInfo{}, fmt.Errorf("auth: commit update profile tx: %w", err)
	}

	return userInfoFromRow(row), nil
}

func (s *Service) UploadAvatar(ctx context.Context, userID uuid.UUID, payload io.Reader) (UserInfo, error) {
	if s.avatarStore == nil {
		return UserInfo{}, ErrAvatarNotConfigured
	}

	// Read max+1 bytes so we can detect payload overflow without accepting oversized uploads.
	buf, err := io.ReadAll(io.LimitReader(payload, s.avatarMaxBytes+1))
	if err != nil {
		return UserInfo{}, fmt.Errorf("auth: read avatar payload: %w", err)
	}
	if int64(len(buf)) > s.avatarMaxBytes {
		return UserInfo{}, ErrAvatarTooLarge
	}
	if len(buf) == 0 {
		return UserInfo{}, ErrAvatarBadRequest
	}

	normalizedPayload, mimeType, err := normalizeAvatarImage(buf)
	if err != nil {
		switch {
		case errors.Is(err, ErrAvatarUnsupported):
			return UserInfo{}, ErrAvatarUnsupported
		case errors.Is(err, ErrAvatarBadRequest):
			return UserInfo{}, ErrAvatarBadRequest
		default:
			return UserInfo{}, fmt.Errorf("auth: normalize avatar: %w", err)
		}
	}

	storageKey := fmt.Sprintf("avatars/%s/%s.png", userID.String(), uuid.NewString())
	if err := s.avatarStore.PutObject(ctx, storageKey, bytes.NewReader(normalizedPayload), int64(len(normalizedPayload)), mimeType); err != nil {
		return UserInfo{}, fmt.Errorf("auth: upload avatar object: %w", err)
	}

	publicURL := avatarPublicPathPrefix + storageKey
	info, oldAvatarURL, err := s.updateAvatarURL(ctx, userID, publicURL)
	if err != nil {
		s.deleteAvatarObjectBestEffort(ctx, storageKey)
		return UserInfo{}, err
	}

	if oldKey := storageKeyFromAvatarURL(oldAvatarURL); oldKey != "" && oldKey != storageKey {
		s.deleteAvatarObjectBestEffort(ctx, oldKey)
	}

	return info, nil
}

func (s *Service) RemoveAvatar(ctx context.Context, userID uuid.UUID) (UserInfo, error) {
	if s.avatarStore == nil {
		return UserInfo{}, ErrAvatarNotConfigured
	}
	if s.db == nil {
		return UserInfo{}, fmt.Errorf("%w: database is not configured", ErrProfileBadRequest)
	}

	info, oldAvatarURL, err := s.updateAvatarURL(ctx, userID, "")
	if err != nil {
		return UserInfo{}, err
	}

	if oldKey := storageKeyFromAvatarURL(oldAvatarURL); oldKey != "" {
		s.deleteAvatarObjectBestEffort(ctx, oldKey)
	}

	return info, nil
}

func (s *Service) DownloadPublicAvatar(ctx context.Context, storageKey string) (io.ReadCloser, int64, string, error) {
	if s.avatarStore == nil {
		return nil, 0, "", ErrAvatarNotConfigured
	}

	key, err := sanitiseAvatarStorageKey(storageKey)
	if err != nil {
		return nil, 0, "", ErrAvatarNotFound
	}

	body, size, mimeType, err := s.avatarStore.GetObject(ctx, key)
	if err != nil {
		return nil, 0, "", ErrAvatarNotFound
	}
	return body, size, mimeType, nil
}

func (s *Service) updateAvatarURL(ctx context.Context, userID uuid.UUID, avatarURL string) (UserInfo, string, error) {
	if s.db == nil {
		return UserInfo{}, "", fmt.Errorf("%w: database is not configured", ErrProfileBadRequest)
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return UserInfo{}, "", fmt.Errorf("auth: begin avatar update tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var oldAvatarURL string
	if err := tx.QueryRow(ctx, `SELECT avatar_url FROM users WHERE id = $1 FOR UPDATE`, userID).Scan(&oldAvatarURL); err != nil {
		return UserInfo{}, "", err
	}

	var row queries.User
	if err := scanUserRow(tx.QueryRow(ctx,
		`UPDATE users
		   SET avatar_url = $2,
		       updated_at = now()
		 WHERE id = $1
		 RETURNING `+userProfileReturningCols,
		userID,
		avatarURL,
	), &row); err != nil {
		return UserInfo{}, "", err
	}

	if err := s.appendUserIdentityUpdatedEventTx(ctx, tx, row.ID, row.DisplayName, row.AvatarUrl, customStatusFromRow(row)); err != nil {
		return UserInfo{}, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return UserInfo{}, "", fmt.Errorf("auth: commit avatar update tx: %w", err)
	}

	return userInfoFromRow(row), oldAvatarURL, nil
}

func (s *Service) SetCustomStatus(ctx context.Context, userID uuid.UUID, text, emoji string, expiresAt time.Time) (UserInfo, error) {
	text = userstatus.NormalizeText(text)
	emoji = userstatus.NormalizeEmoji(emoji)
	if text == "" {
		return UserInfo{}, fmt.Errorf("%w: status text is required", ErrProfileBadRequest)
	}
	if userstatus.IsTextTooLong(text) {
		return UserInfo{}, fmt.Errorf("%w: status text must be at most %d characters", ErrProfileBadRequest, userstatus.MaxTextRunes)
	}
	if userstatus.IsEmojiTooLong(emoji) {
		return UserInfo{}, fmt.Errorf("%w: status emoji must be at most %d characters", ErrProfileBadRequest, userstatus.MaxEmojiRunes)
	}
	if expiresAt.IsZero() || !expiresAt.After(time.Now().UTC()) {
		return UserInfo{}, fmt.Errorf("%w: status expiration must be in the future", ErrProfileBadRequest)
	}
	if s.db == nil {
		return UserInfo{}, fmt.Errorf("%w: database is not configured", ErrProfileBadRequest)
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return UserInfo{}, fmt.Errorf("auth: begin custom status update tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var row queries.User
	if err := scanUserRow(tx.QueryRow(ctx,
		`UPDATE users
		   SET custom_status_text = $2,
		       custom_status_emoji = $3,
		       custom_status_expires_at = $4,
		       updated_at = now()
		 WHERE id = $1
		 RETURNING `+userProfileReturningCols,
		userID,
		text,
		emoji,
		expiresAt.UTC(),
	), &row); err != nil {
		return UserInfo{}, err
	}

	if err := s.appendUserIdentityUpdatedEventTx(ctx, tx, row.ID, row.DisplayName, row.AvatarUrl, customStatusFromRow(row)); err != nil {
		return UserInfo{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return UserInfo{}, fmt.Errorf("auth: commit custom status update tx: %w", err)
	}
	return userInfoFromRow(row), nil
}

func (s *Service) ClearCustomStatus(ctx context.Context, userID uuid.UUID) (UserInfo, error) {
	if s.db == nil {
		return UserInfo{}, fmt.Errorf("%w: database is not configured", ErrProfileBadRequest)
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return UserInfo{}, fmt.Errorf("auth: begin custom status clear tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var row queries.User
	if err := scanUserRow(tx.QueryRow(ctx,
		`UPDATE users
		   SET custom_status_text = '',
		       custom_status_emoji = '',
		       custom_status_expires_at = NULL,
		       updated_at = now()
		 WHERE id = $1
		 RETURNING `+userProfileReturningCols,
		userID,
	), &row); err != nil {
		return UserInfo{}, err
	}

	if err := s.appendUserIdentityUpdatedEventTx(ctx, tx, row.ID, row.DisplayName, row.AvatarUrl, nil); err != nil {
		return UserInfo{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return UserInfo{}, fmt.Errorf("auth: commit custom status clear tx: %w", err)
	}
	return userInfoFromRow(row), nil
}

func (s *Service) appendUserIdentityUpdatedEventTx(ctx context.Context, tx pgx.Tx, userID uuid.UUID, displayName, avatarURL string, customStatus *userstatus.Status) error {
	if s.eventStore == nil {
		return nil
	}

	occurredAt := time.Now().UTC()
	payload := &packetspb.UserIdentityUpdatedEvent{
		UserId:       userID.String(),
		DisplayName:  displayName,
		AvatarUrl:    avatarURL,
		CustomStatus: userstatus.ToProto(customStatus),
	}
	payloadJSON, err := protojson.Marshal(payload)
	if err != nil {
		return fmt.Errorf("auth: marshal user_identity_updated payload: %w", err)
	}

	protoPayload := &packetspb.ServerEvent{
		EventType:  packetspb.EventType_EVENT_TYPE_USER_IDENTITY_UPDATED,
		OccurredAt: timestamppb.New(occurredAt),
		Payload: &packetspb.ServerEvent_UserIdentityUpdated{
			UserIdentityUpdated: payload,
		},
	}

	stored, err := s.eventStore.AppendEventTx(ctx, tx, events.AppendParams{
		EventID:      uuid.NewString(),
		EventType:    "user_identity_updated",
		ChannelID:    "",
		PayloadJSON:  payloadJSON,
		OccurredAt:   occurredAt,
		ProtoPayload: protoPayload,
	})
	if err != nil {
		return fmt.Errorf("auth: append user_identity_updated event: %w", err)
	}
	if err := s.eventStore.NotifyEventTx(ctx, tx, stored.Seq); err != nil {
		return fmt.Errorf("auth: notify user_identity_updated event: %w", err)
	}
	return nil
}

func customStatusFromRow(row queries.User) *userstatus.Status {
	return userstatus.ActiveFromNullTime(
		row.CustomStatusText,
		row.CustomStatusEmoji,
		row.CustomStatusExpiresAt,
		time.Now().UTC(),
	)
}

func scanUserRow(row pgx.Row, dest *queries.User) error {
	return row.Scan(
		&dest.ID,
		&dest.Email,
		&dest.DisplayName,
		&dest.AvatarUrl,
		&dest.CustomStatusText,
		&dest.CustomStatusEmoji,
		&dest.CustomStatusExpiresAt,
		&dest.Role,
		&dest.NeedChangePassword,
	)
}

func userInfoFromRow(row queries.User) UserInfo {
	return UserInfo{
		ID:                 row.ID,
		Email:              row.Email,
		DisplayName:        row.DisplayName,
		AvatarURL:          row.AvatarUrl,
		CustomStatus:       customStatusFromRow(row),
		Role:               row.Role,
		NeedChangePassword: row.NeedChangePassword,
	}
}

func storageKeyFromAvatarURL(avatarURL string) string {
	if !strings.HasPrefix(avatarURL, avatarPublicPathPrefix) {
		return ""
	}
	key, err := sanitiseAvatarStorageKey(strings.TrimPrefix(avatarURL, avatarPublicPathPrefix))
	if err != nil {
		return ""
	}
	return key
}

func sanitiseAvatarStorageKey(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", fmt.Errorf("empty avatar key")
	}
	if strings.Contains(trimmed, `\\`) {
		return "", fmt.Errorf("invalid avatar key")
	}
	for _, segment := range strings.Split(trimmed, "/") {
		if segment == ".." {
			return "", fmt.Errorf("invalid avatar key")
		}
	}

	cleaned := path.Clean("/" + trimmed)
	if cleaned == "/" {
		return "", fmt.Errorf("empty avatar key")
	}
	key := strings.TrimPrefix(cleaned, "/")
	if key == "" {
		return "", fmt.Errorf("invalid avatar key")
	}
	if !strings.HasPrefix(key, "avatars/") {
		return "", fmt.Errorf("invalid avatar key")
	}
	return key, nil
}

func (s *Service) deleteAvatarObjectBestEffort(ctx context.Context, storageKey string) {
	if s.avatarStore == nil || storageKey == "" {
		return
	}
	deleteCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := s.avatarStore.DeleteObject(deleteCtx, storageKey); err != nil {
		s.log.Warn("auth: failed to delete avatar object",
			zap.String("storage_key", storageKey),
			zap.Error(err),
		)
	}
}

func isEmailAlreadyInUse(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// Logout revokes the referenced refresh session. Idempotent (already revoked = no error).
func (s *Service) Logout(ctx context.Context, rawRefreshToken string) error {
	tokenHash := HashRefreshToken(rawRefreshToken)
	if err := s.sessions.RevokeByTokenHash(ctx, tokenHash); err != nil {
		metrics.AuthLogoutTotal.WithLabelValues("error").Inc()
		return fmt.Errorf("logout: revoke session: %w", err)
	}
	metrics.AuthLogoutTotal.WithLabelValues("success").Inc()
	return nil
}

// VerifyAccess validates an access JWT and returns the principal.
func (s *Service) VerifyAccess(ctx context.Context, accessToken string) (Principal, error) {
	claims, err := s.tokens.VerifyAccessToken(accessToken)
	if err != nil {
		return Principal{}, err
	}

	userID, err := uuid.Parse(claims.UserID)
	if err != nil {
		return Principal{}, ErrTokenInvalid
	}
	sessionID, err := uuid.Parse(claims.SessionID)
	if err != nil {
		return Principal{}, ErrTokenInvalid
	}

	if _, err := s.sessions.GetActiveByIDAndUser(ctx, sessionID, userID); err != nil {
		return Principal{}, ErrTokenInvalid
	}

	user, err := s.users.GetUserByID(ctx, userID)
	if err != nil {
		return Principal{}, ErrTokenInvalid
	}
	if user.Status == "blocked" {
		return Principal{}, ErrUserBlocked
	}
	if user.Role == "bot" {
		return Principal{}, ErrTokenInvalid
	}

	return Principal{
		UserID:    userID,
		Role:      claims.Role,
		SessionID: sessionID,
	}, nil
}

// ChangePassword hashes the new password and clears need_change_password for the user.
func (s *Service) ChangePassword(ctx context.Context, userID uuid.UUID, newPassword string) error {
	if strings.TrimSpace(newPassword) == "" {
		return fmt.Errorf("%w: password must not be empty", ErrPasswordChangeFailed)
	}
	if s.queries == nil {
		return fmt.Errorf("%w: database is not configured", ErrPasswordChangeFailed)
	}
	hash, err := HashPassword(newPassword)
	if err != nil {
		return fmt.Errorf("%w: hash password: %v", ErrPasswordChangeFailed, err)
	}
	if err := s.queries.UpdateUserPassword(ctx, queries.UpdateUserPasswordParams{
		ID:           userID,
		PasswordHash: hash,
	}); err != nil {
		return fmt.Errorf("%w: update password: %v", ErrPasswordChangeFailed, err)
	}
	return nil
}

// issueTokenPair creates a new refresh session and returns a token pair.
func (s *Service) issueTokenPair(ctx context.Context, userID uuid.UUID, role, userAgent, ipAddr string, needChangePassword bool) (TokenPair, uuid.UUID, error) {
	rawRefresh, err := GenerateRefreshToken()
	if err != nil {
		return TokenPair{}, uuid.Nil, fmt.Errorf("issue token pair: generate refresh: %w", err)
	}

	session, err := s.sessions.Create(ctx, CreateSessionParams{
		UserID:    userID,
		TokenHash: HashRefreshToken(rawRefresh),
		UserAgent: userAgent,
		IPAddr:    ipAddr,
		ExpiresAt: time.Now().Add(s.refreshTTL),
	})
	if err != nil {
		return TokenPair{}, uuid.Nil, fmt.Errorf("issue token pair: create session: %w", err)
	}

	accessToken, err := s.tokens.IssueAccessToken(userID.String(), role, session.ID.String(), needChangePassword)
	if err != nil {
		return TokenPair{}, uuid.Nil, fmt.Errorf("issue token pair: sign access token: %w", err)
	}

	return TokenPair{
		AccessToken:  accessToken,
		RefreshToken: rawRefresh,
		ExpiresIn:    s.tokens.accessTTL,
	}, session.ID, nil
}

// ListAuthorizedConversationIDs returns the active conversation ids visible to
// the user at the time the session cache is initialized.
func (s *Service) ListAuthorizedConversationIDs(ctx context.Context, userID uuid.UUID) ([]uuid.UUID, error) {
	if s.queries == nil {
		return nil, fmt.Errorf("auth: queries not configured")
	}
	return s.queries.ListBootstrapConversationIDs(ctx, queries.ListBootstrapConversationIDsParams{
		UserID:          userID,
		IncludeArchived: false,
	})
}

// CanReceiveEventWithConversationAccess checks event visibility using a
// session-local conversation access cache. Channel-scoped self-membership
// updates are always delivered so the cache can converge without a DB lookup.
func (s *Service) CanReceiveEventWithConversationAccess(
	principal Principal,
	evt *packetspb.ServerEvent,
	hasConversation func(conversationID string) bool,
	grantConversation func(conversationID string),
) (bool, string) {
	if payload := evt.GetReadCounterUpdated(); payload != nil {
		if payload.GetUserId() == principal.UserID.String() {
			return true, "allowed_self_scoped"
		}
		return false, "denied_self_scoped"
	}
	if payload := evt.GetNotificationAdded(); payload != nil {
		if payload.GetUserId() == principal.UserID.String() {
			return true, "allowed_self_scoped"
		}
		return false, "denied_self_scoped"
	}
	if payload := evt.GetNotificationResolved(); payload != nil {
		if payload.GetUserId() == principal.UserID.String() {
			return true, "allowed_self_scoped"
		}
		return false, "denied_self_scoped"
	}

	conversationID := evt.GetConversationId()
	if conversationID == "" {
		return true, "allowed_workspace"
	}

	if payload := evt.GetMembershipChanged(); payload != nil && payload.GetUserId() == principal.UserID.String() {
		switch payload.GetAction() {
		case packetspb.MembershipAction_MEMBERSHIP_ACTION_ADDED,
			packetspb.MembershipAction_MEMBERSHIP_ACTION_JOINED:
			if grantConversation != nil {
				grantConversation(conversationID)
			}
		}
		return true, "allowed_membership_self"
	}

	if hasConversation != nil && hasConversation(conversationID) {
		return true, "allowed_conversation_cache"
	}

	return false, "conversation_cache_miss"
}

// CanReceiveEvent checks if a principal is authorized to receive a given ServerEvent.
// For channel-scoped events (conversation_id set), it verifies channel membership.
// For workspace-wide events (conversation_id empty), all authenticated users can receive.
func (s *Service) CanReceiveEvent(ctx context.Context, principal Principal, evt *packetspb.ServerEvent) bool {
	if payload := evt.GetReadCounterUpdated(); payload != nil {
		return payload.GetUserId() == principal.UserID.String()
	}
	if payload := evt.GetNotificationAdded(); payload != nil {
		return payload.GetUserId() == principal.UserID.String()
	}
	if payload := evt.GetNotificationResolved(); payload != nil {
		return payload.GetUserId() == principal.UserID.String()
	}

	// Workspace-wide events: all authenticated users can receive
	conversationID := evt.GetConversationId()
	if conversationID == "" {
		return true
	}

	if s.queries == nil {
		return false
	}

	// Channel-scoped events: check membership
	channelID, err := uuid.Parse(conversationID)
	if err != nil {
		return false
	}

	_, err = s.queries.GetChannelMember(ctx, queries.GetChannelMemberParams{
		ChannelID: channelID,
		UserID:    principal.UserID,
	})
	if err == nil {
		return true
	}

	callIDValue := ""
	if callStateChanged := evt.GetCallStateChanged(); callStateChanged != nil {
		callIDValue = callStateChanged.GetCallId()
	} else if raisedHandsChanged := evt.GetCallRaisedHandsChanged(); raisedHandsChanged != nil {
		callIDValue = raisedHandsChanged.GetCallId()
	}
	if callIDValue == "" || s.db == nil {
		return false
	}

	callID, err := uuid.Parse(callIDValue)
	if err != nil {
		return false
	}

	var isParticipant bool
	if err := s.db.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM call_participants cp
			WHERE cp.call_id = $1
			  AND cp.user_id = $2
			  AND cp.left_at IS NULL
		)`, callID, principal.UserID).Scan(&isParticipant); err != nil {
		return false
	}
	return isParticipant
}
