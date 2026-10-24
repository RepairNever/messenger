package config

import (
	"os"
	"testing"

	"github.com/stretchr/testify/require"
)

func productionConfig(t *testing.T) *Config {
	t.Helper()
	cfg, err := Load()
	require.NoError(t, err)
	cfg.Env = "production"
	cfg.DatabaseURL = "postgres://msgnr:sensitive-db-password@postgres:5432/msgnr?sslmode=require"
	cfg.JWTSecret = "a-generated-secret-with-at-least-32-bytes"
	cfg.MinioEndpoint = "storage.example.test:9000"
	cfg.MinioAccessKey = "msgnr-service"
	cfg.MinioSecretKey = "sensitive-storage-password"
	cfg.CORSAllowedOrigins = "https://chat.example.test,tauri://localhost"
	return cfg
}

func TestValidateProduction(t *testing.T) {
	t.Chdir(t.TempDir())
	base := productionConfig(t)
	require.NoError(t, base.Validate())

	tests := []struct {
		name   string
		change func(*Config)
		want   string
	}{
		{"missing database", func(c *Config) { c.DatabaseURL = "" }, "DATABASE_URL"},
		{"malformed database", func(c *Config) { c.DatabaseURL = "postgres://user:sensitive-value@bad%host/db" }, "DATABASE_URL"},
		{"default database", func(c *Config) { c.DatabaseURL = "postgres://msgnr:msgnr@localhost/msgnr?sslmode=disable" }, "DATABASE_URL"},
		{"short JWT secret", func(c *Config) { c.JWTSecret = "sensitive-value" }, "JWT_SECRET"},
		{"blank JWT secret", func(c *Config) { c.JWTSecret = "" }, "JWT_SECRET"},
		{"blank storage endpoint", func(c *Config) { c.MinioEndpoint = "" }, "MINIO_ENDPOINT"},
		{"default access key", func(c *Config) { c.MinioAccessKey = "minioadmin" }, "MINIO_ACCESS_KEY"},
		{"default storage secret", func(c *Config) { c.MinioSecretKey = "minioadmin" }, "MINIO_SECRET_KEY"},
		{"blank storage secret", func(c *Config) { c.MinioSecretKey = "" }, "MINIO_SECRET_KEY"},
		{"blank bucket", func(c *Config) { c.MinioBucket = "" }, "MINIO_BUCKET"},
		{"wildcard CORS", func(c *Config) { c.CORSAllowedOrigins = "*" }, "CORS_ALLOWED_ORIGINS"},
		{"mixed wildcard CORS", func(c *Config) { c.CORSAllowedOrigins += ",*" }, "CORS_ALLOWED_ORIGINS"},
		{"blank CORS", func(c *Config) { c.CORSAllowedOrigins = "" }, "CORS_ALLOWED_ORIGINS"},
		{"CORS path", func(c *Config) { c.CORSAllowedOrigins = "https://chat.example.test/" }, "CORS_ALLOWED_ORIGINS"},
		{"CORS user info", func(c *Config) { c.CORSAllowedOrigins = "https://user:pass@chat.example.test" }, "CORS_ALLOWED_ORIGINS"},
		{"CORS trailing comma", func(c *Config) { c.CORSAllowedOrigins += "," }, "CORS_ALLOWED_ORIGINS"},
		{"invalid port", func(c *Config) { c.Port = "65536" }, "PORT"},
		{"duplicate ports", func(c *Config) { c.MetricsPort = c.Port }, "METRICS_PORT"},
		{"duplicate numeric ports", func(c *Config) { c.MetricsPort = "0" + c.Port }, "METRICS_PORT"},
		{"invalid pool", func(c *Config) { c.DBMinConns = c.DBMaxConns + 1 }, "DB_MIN_CONNS"},
		{"zero shutdown timeout", func(c *Config) { c.HTTPShutdownTimeout = 0 }, "HTTP timeouts"},
		{"unknown environment", func(c *Config) { c.Env = "produciton" }, "ENV"},
		{"partial LiveKit credentials", func(c *Config) { c.LiveKitAPIKey = "api-key" }, "LIVEKIT_API_SECRET"},
		{"partial VAPID credentials", func(c *Config) { c.VAPIDPublicKey = "public-key" }, "VAPID_PRIVATE_KEY"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := *base
			tt.change(&cfg)
			err := cfg.Validate()
			require.ErrorContains(t, err, tt.want)
			require.NotContains(t, err.Error(), "sensitive-value")
			require.NotContains(t, err.Error(), "sensitive-db-password")
			require.NotContains(t, err.Error(), "sensitive-storage-password")
		})
	}
}

func TestValidateOptionalServices(t *testing.T) {
	t.Chdir(t.TempDir())
	cfg := productionConfig(t)
	cfg.LiveKitURL = "wss://calls.example.test"
	cfg.LiveKitAPIKey = "production-key"
	cfg.LiveKitAPISecret = "production-secret"
	cfg.VAPIDPublicKey = "public-key"
	cfg.VAPIDPrivateKey = "private-key"
	cfg.VAPIDSubject = "mailto:admin@example.test"
	require.NoError(t, cfg.Validate())
	cfg.LiveKitURL = "ws://calls.example.test"
	require.ErrorContains(t, cfg.Validate(), "LIVEKIT_URL")
	cfg.LiveKitURL = "wss://calls.example.test"
	cfg.LiveKitAPISecret = "secret"
	require.ErrorContains(t, cfg.Validate(), "LIVEKIT_API_SECRET")
	cfg.LiveKitAPISecret = "production-secret"
	cfg.VAPIDSubject = "admin@example.test"
	require.ErrorContains(t, cfg.Validate(), "VAPID_SUBJECT")
}

func TestValidateDevelopmentDefaults(t *testing.T) {
	t.Chdir(t.TempDir())
	cfg, err := Load()
	require.NoError(t, err)
	cfg.Env = "development"
	require.NoError(t, cfg.Validate())
}

func TestLoadEmptyEnvOverridesFile(t *testing.T) {
	t.Chdir(t.TempDir())
	require.NoError(t, os.WriteFile(".env", []byte("JWT_SECRET=file-secret\nPORT=8000\n"), 0600))
	t.Setenv("JWT_SECRET", "")
	t.Setenv("PORT", "8181")
	cfg, err := Load()
	require.NoError(t, err)
	require.Empty(t, cfg.JWTSecret)
	require.Equal(t, "8181", cfg.Port)
	require.ErrorContains(t, cfg.Validate(), "JWT_SECRET")
}

func TestLoadDoesNotReusePreviousEnvFile(t *testing.T) {
	t.Chdir(t.TempDir())
	require.NoError(t, os.WriteFile(".env", []byte("PORT=8000\n"), 0600))
	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, "8000", cfg.Port)
	require.NoError(t, os.Remove(".env"))
	cfg, err = Load()
	require.NoError(t, err)
	require.Equal(t, "8080", cfg.Port)
}

func TestLoadRejectsMalformedEnvFile(t *testing.T) {
	t.Chdir(t.TempDir())
	require.NoError(t, os.WriteFile(".env", []byte("JWT_SECRET='unterminated\n"), 0600))
	_, err := Load()
	require.Error(t, err)
}
