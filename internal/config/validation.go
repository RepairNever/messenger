package config

import (
	"errors"
	"net/url"
	"strconv"
	"strings"
)

// Validate checks startup settings without including credential values in errors.
// Load remains usable by tools and tests that only need configuration defaults.
func (c *Config) Validate() error {
	var problems []error
	check := func(valid bool, message string) {
		if !valid {
			problems = append(problems, errors.New(message))
		}
	}
	for name, value := range map[string]string{"PORT": c.Port, "METRICS_PORT": c.MetricsPort} {
		port, err := strconv.Atoi(value)
		check(err == nil && port > 0 && port <= 65535, name+" must be a port between 1 and 65535")
	}
	serverPort, _ := strconv.Atoi(c.Port)
	metricsPort, _ := strconv.Atoi(c.MetricsPort)
	check(serverPort != metricsPort, "PORT and METRICS_PORT must be different")
	check(c.HTTPReadTimeout > 0 && c.HTTPWriteTimeout > 0 && c.HTTPIdleTimeout > 0 && c.HTTPShutdownTimeout > 0,
		"HTTP timeouts must be positive")
	check(c.DBMaxConns > 0 && c.DBMinConns >= 0 && c.DBMinConns <= c.DBMaxConns,
		"DB_MAX_CONNS must be positive and DB_MIN_CONNS must be between zero and DB_MAX_CONNS")
	check(c.DBConnectTimeout > 0, "DB_CONNECT_TIMEOUT must be positive")
	check(c.JWTAccessTokenTTL > 0 && c.JWTRefreshTokenTTL > 0, "JWT token lifetimes must be positive")
	check(c.Env == "production" || c.Env == "prod" || c.IsDev(), "ENV must be production, prod, development or dev")
	if c.IsDev() {
		return errors.Join(problems...)
	}

	dbURL, err := url.Parse(c.DatabaseURL)
	check(err == nil && dbURL.Host != "" && (dbURL.Scheme == "postgres" || dbURL.Scheme == "postgresql"),
		"DATABASE_URL must be a PostgreSQL connection URL")
	check(c.DatabaseURL != "postgres://msgnr:msgnr@localhost/msgnr?sslmode=disable",
		"DATABASE_URL must be configured for production")
	check(len(strings.TrimSpace(c.JWTSecret)) >= 32, "JWT_SECRET must contain at least 32 bytes; generate it with openssl rand -hex 32")
	check(strings.TrimSpace(c.MinioEndpoint) != "", "MINIO_ENDPOINT is required")
	check(strings.TrimSpace(c.MinioAccessKey) != "" && c.MinioAccessKey != "minioadmin", "MINIO_ACCESS_KEY must use non-default credentials")
	check(strings.TrimSpace(c.MinioSecretKey) != "" && c.MinioSecretKey != "minioadmin", "MINIO_SECRET_KEY must use non-default credentials")
	check(strings.TrimSpace(c.MinioBucket) != "", "MINIO_BUCKET is required")
	check(c.AttachmentMaxSizeMB > 0 && c.AvatarMaxSizeMB > 0, "attachment and avatar size limits must be positive")

	originsValid := strings.TrimSpace(c.CORSAllowedOrigins) != ""
	for _, origin := range strings.Split(c.CORSAllowedOrigins, ",") {
		origin = strings.TrimSpace(origin)
		u, err := url.Parse(origin)
		if err != nil || strings.Contains(origin, "*") || u.Scheme == "" || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
			originsValid = false
		}
	}
	check(originsValid, "CORS_ALLOWED_ORIGINS must list explicit origins without wildcards, paths or trailing slashes")

	if c.LiveKitAPIKey != "" || c.LiveKitAPISecret != "" {
		check(strings.TrimSpace(c.LiveKitAPIKey) != "" && c.LiveKitAPIKey != "devkey" && c.LiveKitAPIKey != "your-livekit-api-key",
			"LIVEKIT_API_KEY must use non-default credentials when calls are configured")
		check(strings.TrimSpace(c.LiveKitAPISecret) != "" && c.LiveKitAPISecret != "secret" && c.LiveKitAPISecret != "your-livekit-api-secret",
			"LIVEKIT_API_SECRET must use non-default credentials when calls are configured")
		u, err := url.Parse(c.LiveKitURL)
		check(err == nil && u.Scheme == "wss" && u.Host != "" && u.User == nil, "LIVEKIT_URL must be a public wss:// URL when calls are configured")
	}
	if c.VAPIDPublicKey != "" || c.VAPIDPrivateKey != "" {
		check(strings.TrimSpace(c.VAPIDPublicKey) != "" && strings.TrimSpace(c.VAPIDPrivateKey) != "", "VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set together")
		u, err := url.Parse(c.VAPIDSubject)
		check(err == nil && ((u.Scheme == "mailto" && u.Opaque != "") || (u.Scheme == "https" && u.Host != "")),
			"VAPID_SUBJECT must be a mailto: or https:// URL when push is configured")
	}
	return errors.Join(problems...)
}
