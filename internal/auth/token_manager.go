package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

var (
	ErrTokenExpired   = errors.New("token expired")
	ErrTokenInvalid   = errors.New("token invalid")
	ErrTokenMalformed = errors.New("token malformed")
)

// AccessClaims are the JWT payload fields for access tokens.
type AccessClaims struct {
	UserID             string `json:"sub"`
	Role               string `json:"role"`
	SessionID          string `json:"sid"`
	NeedChangePassword bool   `json:"need_change_password,omitempty"`
	jwt.RegisteredClaims
}

// TokenManager issues and verifies access tokens and opaque refresh tokens.
type TokenManager struct {
	secret    []byte
	accessTTL time.Duration
}

func NewTokenManager(secret string, accessTTL time.Duration) *TokenManager {
	return &TokenManager{
		secret:    []byte(secret),
		accessTTL: accessTTL,
	}
}

// IssueAccessToken returns a signed JWT for the given user/session.
func (m *TokenManager) IssueAccessToken(userID, role, sessionID string, needChangePassword bool) (string, error) {
	now := time.Now()
	claims := AccessClaims{
		UserID:             userID,
		Role:               role,
		SessionID:          sessionID,
		NeedChangePassword: needChangePassword,
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "msgnr",
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(m.accessTTL)),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(m.secret)
}

// VerifyAccessToken validates the JWT and returns its claims.
func (m *TokenManager) VerifyAccessToken(tokenStr string) (*AccessClaims, error) {
	token, err := jwt.ParseWithClaims(tokenStr, &AccessClaims{}, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return m.secret, nil
	})
	if err != nil {
		if errors.Is(err, jwt.ErrTokenExpired) {
			return nil, ErrTokenExpired
		}
		if errors.Is(err, jwt.ErrTokenMalformed) {
			return nil, ErrTokenMalformed
		}
		return nil, ErrTokenInvalid
	}

	claims, ok := token.Claims.(*AccessClaims)
	if !ok || !token.Valid {
		return nil, ErrTokenInvalid
	}
	return claims, nil
}

// GenerateRefreshToken returns a cryptographically random opaque token string.
func GenerateRefreshToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("failed to generate refresh token: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// HashRefreshToken returns the SHA-256 hex digest of the raw token.
// Only the hash is stored in the database.
func HashRefreshToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// HashPassword returns a bcrypt hash of the password.
func HashPassword(password string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	return string(b), err
}

// CheckPassword compares a plaintext password against a bcrypt hash.
func CheckPassword(password, hash string) error {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password))
}
