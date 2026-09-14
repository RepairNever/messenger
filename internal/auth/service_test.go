package auth_test

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	"msgnr/internal/auth"
	packetspb "msgnr/internal/gen/proto"
	"msgnr/internal/gen/queries"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ---- in-memory fakes ----

type fakeSessionRepo struct {
	sessions map[string]queries.RefreshSession
}

func newFakeSessionRepo() *fakeSessionRepo {
	return &fakeSessionRepo{sessions: make(map[string]queries.RefreshSession)}
}

func (f *fakeSessionRepo) Create(ctx context.Context, p auth.CreateSessionParams) (queries.RefreshSession, error) {
	row := queries.RefreshSession{
		ID:        uuid.New(),
		UserID:    p.UserID,
		TokenHash: p.TokenHash,
		UserAgent: sql.NullString{String: p.UserAgent, Valid: p.UserAgent != ""},
		IpAddr:    sql.NullString{String: p.IPAddr, Valid: p.IPAddr != ""},
		ExpiresAt: p.ExpiresAt,
		CreatedAt: time.Now(),
	}
	f.sessions[p.TokenHash] = row
	return row, nil
}

func (f *fakeSessionRepo) GetActiveByTokenHash(ctx context.Context, tokenHash string) (queries.RefreshSession, error) {
	row, ok := f.sessions[tokenHash]
	if !ok || row.RevokedAt.Valid {
		return queries.RefreshSession{}, auth.ErrSessionNotFound
	}
	if row.ExpiresAt.Before(time.Now()) {
		return queries.RefreshSession{}, auth.ErrSessionNotFound
	}
	return row, nil
}

func (f *fakeSessionRepo) RotateToken(ctx context.Context, p auth.RotateSessionTokenParams) (queries.RefreshSession, error) {
	row, ok := f.sessions[p.OldTokenHash]
	if !ok || row.ID != p.ID || row.RevokedAt.Valid {
		return queries.RefreshSession{}, auth.ErrSessionNotFound
	}
	if row.ExpiresAt.Before(time.Now()) {
		return queries.RefreshSession{}, auth.ErrSessionNotFound
	}

	delete(f.sessions, p.OldTokenHash)
	row.TokenHash = p.NewTokenHash
	row.UserAgent = sql.NullString{String: p.UserAgent, Valid: p.UserAgent != ""}
	row.IpAddr = sql.NullString{String: p.IPAddr, Valid: p.IPAddr != ""}
	row.ExpiresAt = p.ExpiresAt
	f.sessions[p.NewTokenHash] = row
	return row, nil
}

func (f *fakeSessionRepo) RevokeByID(ctx context.Context, id uuid.UUID) error {
	for k, v := range f.sessions {
		if v.ID == id {
			v.RevokedAt = sql.NullTime{Time: time.Now(), Valid: true}
			f.sessions[k] = v
			return nil
		}
	}
	return nil
}

func (f *fakeSessionRepo) RevokeByTokenHash(ctx context.Context, tokenHash string) error {
	v, ok := f.sessions[tokenHash]
	if !ok {
		return nil
	}
	v.RevokedAt = sql.NullTime{Time: time.Now(), Valid: true}
	f.sessions[tokenHash] = v
	return nil
}

func (f *fakeSessionRepo) GetActiveByIDAndUser(ctx context.Context, sessionID, userID uuid.UUID) (queries.RefreshSession, error) {
	for _, row := range f.sessions {
		if row.ID != sessionID || row.UserID != userID {
			continue
		}
		if row.RevokedAt.Valid || row.ExpiresAt.Before(time.Now()) {
			return queries.RefreshSession{}, auth.ErrSessionNotFound
		}
		return row, nil
	}
	return queries.RefreshSession{}, auth.ErrSessionNotFound
}

type fakeUserRepo struct {
	byEmail map[string]queries.User
	byID    map[uuid.UUID]queries.User
}

func newFakeUserRepo() *fakeUserRepo {
	return &fakeUserRepo{
		byEmail: make(map[string]queries.User),
		byID:    make(map[uuid.UUID]queries.User),
	}
}

func (f *fakeUserRepo) add(u queries.User) {
	f.byEmail[u.Email] = u
	f.byID[u.ID] = u
}

func (f *fakeUserRepo) GetUserByEmail(ctx context.Context, email string) (queries.User, error) {
	u, ok := f.byEmail[email]
	if !ok {
		return queries.User{}, auth.ErrInvalidCredentials
	}
	return u, nil
}

func (f *fakeUserRepo) GetUserByID(ctx context.Context, id uuid.UUID) (queries.User, error) {
	u, ok := f.byID[id]
	if !ok {
		return queries.User{}, errors.New("user not found")
	}
	return u, nil
}

// ---- helpers ----

func makeActiveUser(email, password, role string) queries.User {
	hash, _ := auth.HashPassword(password)
	return queries.User{
		ID:           uuid.New(),
		Email:        email,
		PasswordHash: hash,
		DisplayName:  "Test User",
		Role:         role,
		Status:       "active",
	}
}

func newTestService(t *testing.T, users *fakeUserRepo, sessions *fakeSessionRepo) *auth.Service {
	t.Helper()
	mgr := auth.NewTokenManager("test-secret-key-32bytes-padding!!", time.Hour)
	return auth.NewService(mgr, sessions, users, nil, 7*24*time.Hour, nil)
}

// ---- tests ----

func TestLogin_Success(t *testing.T) {
	users := newFakeUserRepo()
	sessions := newFakeSessionRepo()
	u := makeActiveUser("alice@example.com", "password123", "member")
	users.add(u)

	svc := newTestService(t, users, sessions)
	pair, info, err := svc.Login(context.Background(), "alice@example.com", "password123", "TestAgent", "127.0.0.1")

	require.NoError(t, err)
	assert.NotEmpty(t, pair.AccessToken)
	assert.NotEmpty(t, pair.RefreshToken)
	assert.Equal(t, u.ID, info.ID)
	assert.Equal(t, "member", info.Role)
	assert.Positive(t, pair.ExpiresIn)
}

func TestLogin_WrongPassword(t *testing.T) {
	users := newFakeUserRepo()
	sessions := newFakeSessionRepo()
	users.add(makeActiveUser("bob@example.com", "correct", "member"))

	svc := newTestService(t, users, sessions)
	_, _, err := svc.Login(context.Background(), "bob@example.com", "wrong", "", "")

	assert.ErrorIs(t, err, auth.ErrInvalidCredentials)
}

func TestLogin_UnknownEmail(t *testing.T) {
	users := newFakeUserRepo()
	sessions := newFakeSessionRepo()
	svc := newTestService(t, users, sessions)

	_, _, err := svc.Login(context.Background(), "nobody@example.com", "pass", "", "")
	assert.ErrorIs(t, err, auth.ErrInvalidCredentials)
}

func TestLogin_BlockedUser(t *testing.T) {
	users := newFakeUserRepo()
	sessions := newFakeSessionRepo()
	u := makeActiveUser("blocked@example.com", "pass", "member")
	u.Status = "blocked"
	users.add(u)

	svc := newTestService(t, users, sessions)
	_, _, err := svc.Login(context.Background(), "blocked@example.com", "pass", "", "")
	assert.ErrorIs(t, err, auth.ErrUserBlocked)
}

func TestLogin_BotUserDenied(t *testing.T) {
	users := newFakeUserRepo()
	sessions := newFakeSessionRepo()
	u := makeActiveUser("bot@example.com", "pass", "bot")
	users.add(u)

	svc := newTestService(t, users, sessions)
	_, _, err := svc.Login(context.Background(), "bot@example.com", "pass", "", "")

	assert.ErrorIs(t, err, auth.ErrBotUserUnsupported)
}

func TestRefresh_Success_RotatesSession(t *testing.T) {
	users := newFakeUserRepo()
	sessions := newFakeSessionRepo()
	u := makeActiveUser("carol@example.com", "pass", "admin")
	users.add(u)

	svc := newTestService(t, users, sessions)
	pair1, _, err := svc.Login(context.Background(), "carol@example.com", "pass", "", "")
	require.NoError(t, err)

	pair2, err := svc.Refresh(context.Background(), pair1.RefreshToken, "", "")
	require.NoError(t, err)
	assert.NotEmpty(t, pair2.AccessToken)
	assert.NotEqual(t, pair1.RefreshToken, pair2.RefreshToken)

	principalBeforeRefresh, err := svc.VerifyAccess(context.Background(), pair1.AccessToken)
	require.NoError(t, err)
	principalAfterRefresh, err := svc.VerifyAccess(context.Background(), pair2.AccessToken)
	require.NoError(t, err)
	assert.Equal(t, principalBeforeRefresh.SessionID, principalAfterRefresh.SessionID)

	// Old refresh token must be revoked.
	_, err = svc.Refresh(context.Background(), pair1.RefreshToken, "", "")
	assert.ErrorIs(t, err, auth.ErrInvalidCredentials)
}

func TestRefresh_BotUserDenied(t *testing.T) {
	users := newFakeUserRepo()
	sessions := newFakeSessionRepo()
	u := makeActiveUser("bot-refresh@example.com", "pass", "bot")
	users.add(u)

	svc := newTestService(t, users, sessions)
	pair, _, err := svc.Login(context.Background(), "bot-refresh@example.com", "pass", "", "")
	require.ErrorIs(t, err, auth.ErrBotUserUnsupported)
	require.Empty(t, pair.RefreshToken)

	sessionID := uuid.New()
	rawRefresh := "raw-refresh-token"
	sessions.sessions[auth.HashRefreshToken(rawRefresh)] = queries.RefreshSession{
		ID:        sessionID,
		UserID:    u.ID,
		TokenHash: auth.HashRefreshToken(rawRefresh),
		ExpiresAt: time.Now().Add(time.Hour),
		CreatedAt: time.Now(),
	}

	_, err = svc.Refresh(context.Background(), rawRefresh, "", "")
	assert.ErrorIs(t, err, auth.ErrBotUserUnsupported)
}

func TestRefresh_InvalidToken(t *testing.T) {
	users := newFakeUserRepo()
	sessions := newFakeSessionRepo()
	svc := newTestService(t, users, sessions)

	_, err := svc.Refresh(context.Background(), "random-garbage-token", "", "")
	assert.ErrorIs(t, err, auth.ErrInvalidCredentials)
}

func TestRefresh_BlockedUser(t *testing.T) {
	users := newFakeUserRepo()
	sessions := newFakeSessionRepo()
	u := makeActiveUser("dave@example.com", "pass", "member")
	users.add(u)

	svc := newTestService(t, users, sessions)
	pair, _, err := svc.Login(context.Background(), "dave@example.com", "pass", "", "")
	require.NoError(t, err)

	// Block user after login.
	u.Status = "blocked"
	users.add(u)

	_, err = svc.Refresh(context.Background(), pair.RefreshToken, "", "")
	assert.ErrorIs(t, err, auth.ErrUserBlocked)
}

func TestGetProfile_Success(t *testing.T) {
	users := newFakeUserRepo()
	sessions := newFakeSessionRepo()
	u := makeActiveUser("profile@example.com", "pass", "member")
	users.add(u)

	svc := newTestService(t, users, sessions)
	info, err := svc.GetProfile(context.Background(), u.ID)
	require.NoError(t, err)
	assert.Equal(t, u.ID, info.ID)
	assert.Equal(t, u.Email, info.Email)
	assert.Equal(t, u.DisplayName, info.DisplayName)
	assert.Equal(t, u.Role, info.Role)
}

func TestLogout_RevokesSession(t *testing.T) {
	users := newFakeUserRepo()
	sessions := newFakeSessionRepo()
	u := makeActiveUser("eve@example.com", "pass", "member")
	users.add(u)

	svc := newTestService(t, users, sessions)
	pair, _, err := svc.Login(context.Background(), "eve@example.com", "pass", "", "")
	require.NoError(t, err)

	require.NoError(t, svc.Logout(context.Background(), pair.RefreshToken))

	// Refresh must fail after logout.
	_, err = svc.Refresh(context.Background(), pair.RefreshToken, "", "")
	assert.ErrorIs(t, err, auth.ErrInvalidCredentials)
}

func TestLogout_Idempotent(t *testing.T) {
	users := newFakeUserRepo()
	sessions := newFakeSessionRepo()
	svc := newTestService(t, users, sessions)

	// Logout with an unknown token must not error (idempotent).
	err := svc.Logout(context.Background(), "nonexistent-token")
	assert.NoError(t, err)
}

func TestVerifyAccess_Success(t *testing.T) {
	users := newFakeUserRepo()
	sessions := newFakeSessionRepo()
	u := makeActiveUser("frank@example.com", "pass", "owner")
	users.add(u)

	svc := newTestService(t, users, sessions)
	pair, _, err := svc.Login(context.Background(), "frank@example.com", "pass", "", "")
	require.NoError(t, err)

	principal, err := svc.VerifyAccess(context.Background(), pair.AccessToken)
	require.NoError(t, err)
	assert.Equal(t, u.ID, principal.UserID)
	assert.Equal(t, "owner", principal.Role)
}

func TestVerifyAccess_InvalidToken(t *testing.T) {
	users := newFakeUserRepo()
	sessions := newFakeSessionRepo()
	svc := newTestService(t, users, sessions)

	_, err := svc.VerifyAccess(context.Background(), "garbage")
	assert.Error(t, err)
}

func TestVerifyAccess_RevokedSession(t *testing.T) {
	users := newFakeUserRepo()
	sessions := newFakeSessionRepo()
	u := makeActiveUser("gary@example.com", "pass", "member")
	users.add(u)

	svc := newTestService(t, users, sessions)
	pair, _, err := svc.Login(context.Background(), "gary@example.com", "pass", "", "")
	require.NoError(t, err)

	require.NoError(t, svc.Logout(context.Background(), pair.RefreshToken))

	_, err = svc.VerifyAccess(context.Background(), pair.AccessToken)
	assert.ErrorIs(t, err, auth.ErrTokenInvalid)
}

func TestVerifyAccess_BlockedUser(t *testing.T) {
	users := newFakeUserRepo()
	sessions := newFakeSessionRepo()
	u := makeActiveUser("helen@example.com", "pass", "member")
	users.add(u)

	svc := newTestService(t, users, sessions)
	pair, _, err := svc.Login(context.Background(), "helen@example.com", "pass", "", "")
	require.NoError(t, err)

	u.Status = "blocked"
	users.add(u)

	_, err = svc.VerifyAccess(context.Background(), pair.AccessToken)
	assert.ErrorIs(t, err, auth.ErrUserBlocked)
}

func TestCanReceiveEvent_SelfScopedReadAndNotificationEvents(t *testing.T) {
	users := newFakeUserRepo()
	sessions := newFakeSessionRepo()
	u := makeActiveUser("ivy@example.com", "pass", "member")
	users.add(u)

	svc := newTestService(t, users, sessions)
	principal := auth.Principal{UserID: u.ID, SessionID: uuid.New(), Role: "member"}

	readEvt := &packetspb.ServerEvent{
		EventType: packetspb.EventType_EVENT_TYPE_READ_COUNTER_UPDATED,
		Payload: &packetspb.ServerEvent_ReadCounterUpdated{
			ReadCounterUpdated: &packetspb.ReadCounterUpdatedEvent{
				UserId: u.ID.String(),
			},
		},
	}
	assert.True(t, svc.CanReceiveEvent(context.Background(), principal, readEvt))

	otherUserID := uuid.New()
	readEvt.Payload = &packetspb.ServerEvent_ReadCounterUpdated{
		ReadCounterUpdated: &packetspb.ReadCounterUpdatedEvent{
			UserId: otherUserID.String(),
		},
	}
	assert.False(t, svc.CanReceiveEvent(context.Background(), principal, readEvt))

	notifEvt := &packetspb.ServerEvent{
		EventType: packetspb.EventType_EVENT_TYPE_NOTIFICATION_ADDED,
		Payload: &packetspb.ServerEvent_NotificationAdded{
			NotificationAdded: &packetspb.NotificationAddedEvent{
				UserId: u.ID.String(),
			},
		},
	}
	assert.True(t, svc.CanReceiveEvent(context.Background(), principal, notifEvt))

	notifEvt.Payload = &packetspb.ServerEvent_NotificationAdded{
		NotificationAdded: &packetspb.NotificationAddedEvent{
			UserId: otherUserID.String(),
		},
	}
	assert.False(t, svc.CanReceiveEvent(context.Background(), principal, notifEvt))
}
