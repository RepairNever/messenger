package config

import (
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLoad_Defaults(t *testing.T) {
	cfg, err := Load()
	require.NoError(t, err)
	assert.Equal(t, "8080", cfg.Port)
	assert.Equal(t, "postgres://msgnr:msgnr@localhost/msgnr?sslmode=disable", cfg.DatabaseURL)
	assert.Equal(t, "change-me-in-production", cfg.JWTSecret)
	assert.Equal(t, 10*365*24*time.Hour, cfg.JWTRefreshTokenTTL)
	assert.Equal(t, int32(20), cfg.DBMaxConns)
	assert.Equal(t, int32(2), cfg.DBMinConns)
	assert.Equal(t, 1000, cfg.SyncEventLimit)
	assert.Equal(t, 500, cfg.MaxSyncBatch)
	assert.Equal(t, 100, cfg.BootstrapDefaultPageSize)
	assert.Equal(t, 50, cfg.ChatHistoryPageSize)
	assert.Equal(t, 50, cfg.TaskGroupPortionDefaultLimit)
	assert.Equal(t, 200, cfg.TaskGroupPortionMaxLimit)
	assert.Equal(t, 20, cfg.TaskDescriptionHistoryLimit)
	assert.Equal(t, 25, cfg.DocumentHistoryLimit)
	assert.Equal(t, "9090", cfg.MetricsPort)
	assert.Equal(t, "*", cfg.CORSAllowedOrigins)
}

func TestLoad_EnvOverrides(t *testing.T) {
	os.Setenv("PORT", "9000")
	os.Setenv("DATABASE_URL", "postgres://test:123@localhost/testdb?sslmode=disable")
	os.Setenv("JWT_SECRET", "test-secret")
	os.Setenv("SYNC_EVENT_LIMIT", "500")
	os.Setenv("CHAT_HISTORY_PAGE_SIZE", "80")
	os.Setenv("TASK_GROUP_PORTION_DEFAULT_LIMIT", "77")
	os.Setenv("TASK_GROUP_PORTION_MAX_LIMIT", "155")
	os.Setenv("TASK_DESCRIPTION_HISTORY_LIMIT", "33")
	os.Setenv("DOCUMENT_HISTORY_LIMIT", "44")
	defer func() {
		os.Unsetenv("PORT")
		os.Unsetenv("DATABASE_URL")
		os.Unsetenv("JWT_SECRET")
		os.Unsetenv("SYNC_EVENT_LIMIT")
		os.Unsetenv("CHAT_HISTORY_PAGE_SIZE")
		os.Unsetenv("TASK_GROUP_PORTION_DEFAULT_LIMIT")
		os.Unsetenv("TASK_GROUP_PORTION_MAX_LIMIT")
		os.Unsetenv("TASK_DESCRIPTION_HISTORY_LIMIT")
		os.Unsetenv("DOCUMENT_HISTORY_LIMIT")
	}()

	cfg, err := Load()
	require.NoError(t, err)
	assert.Equal(t, "9000", cfg.Port)
	assert.Equal(t, "postgres://test:123@localhost/testdb?sslmode=disable", cfg.DatabaseURL)
	assert.Equal(t, "test-secret", cfg.JWTSecret)
	assert.Equal(t, 500, cfg.SyncEventLimit)
	assert.Equal(t, 80, cfg.ChatHistoryPageSize)
	assert.Equal(t, 77, cfg.TaskGroupPortionDefaultLimit)
	assert.Equal(t, 155, cfg.TaskGroupPortionMaxLimit)
	assert.Equal(t, 33, cfg.TaskDescriptionHistoryLimit)
	assert.Equal(t, 44, cfg.DocumentHistoryLimit)
}

func TestIsDev(t *testing.T) {
	os.Setenv("ENV", "dev")
	defer os.Unsetenv("ENV")

	cfg, err := Load()
	require.NoError(t, err)
	assert.True(t, cfg.IsDev())
}
