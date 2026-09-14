package auth_test

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"msgnr/internal/auth"
)

func newTestTokenManager(ttl time.Duration) *auth.TokenManager {
	return auth.NewTokenManager("test-secret-key-32bytes-padding!!", ttl)
}

func TestIssueAndVerifyAccessToken(t *testing.T) {
	mgr := newTestTokenManager(time.Hour)

	token, err := mgr.IssueAccessToken("user-123", "member", "session-456", false)
	require.NoError(t, err)
	require.NotEmpty(t, token)

	claims, err := mgr.VerifyAccessToken(token)
	require.NoError(t, err)
	assert.Equal(t, "user-123", claims.UserID)
	assert.Equal(t, "member", claims.Role)
	assert.Equal(t, "session-456", claims.SessionID)
}

func TestVerifyAccessToken_Expired(t *testing.T) {
	mgr := newTestTokenManager(-time.Second)

	token, err := mgr.IssueAccessToken("user-123", "member", "session-456", false)
	require.NoError(t, err)

	_, err = mgr.VerifyAccessToken(token)
	assert.ErrorIs(t, err, auth.ErrTokenExpired)
}

func TestVerifyAccessToken_InvalidSignature(t *testing.T) {
	mgr := newTestTokenManager(time.Hour)

	token, err := mgr.IssueAccessToken("user-123", "member", "session-456", false)
	require.NoError(t, err)

	tampered := token[:len(token)-4] + "xxxx"
	_, err = mgr.VerifyAccessToken(tampered)
	assert.Error(t, err)
}

func TestVerifyAccessToken_Malformed(t *testing.T) {
	mgr := newTestTokenManager(time.Hour)
	_, err := mgr.VerifyAccessToken("not.a.valid.jwt.token")
	assert.Error(t, err)
}

func TestGenerateRefreshToken_Unique(t *testing.T) {
	a, err := auth.GenerateRefreshToken()
	require.NoError(t, err)
	b, err := auth.GenerateRefreshToken()
	require.NoError(t, err)
	assert.NotEqual(t, a, b)
	assert.Len(t, a, 64)
}

func TestHashRefreshToken_Deterministic(t *testing.T) {
	raw := "some-raw-token"
	h1 := auth.HashRefreshToken(raw)
	h2 := auth.HashRefreshToken(raw)
	assert.Equal(t, h1, h2)
	assert.NotEqual(t, raw, h1)
}

func TestHashPassword_And_Check(t *testing.T) {
	hash, err := auth.HashPassword("correct-password")
	require.NoError(t, err)

	assert.NoError(t, auth.CheckPassword("correct-password", hash))
	assert.Error(t, auth.CheckPassword("wrong-password", hash))
}
