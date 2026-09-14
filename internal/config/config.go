package config

import (
	"time"

	"github.com/spf13/viper"
)

type Config struct {
	Env  string `mapstructure:"ENV"`
	Port string `mapstructure:"PORT"`

	// HTTP server timeouts
	HTTPReadTimeout     time.Duration `mapstructure:"HTTP_READ_TIMEOUT"`
	HTTPWriteTimeout    time.Duration `mapstructure:"HTTP_WRITE_TIMEOUT"`
	HTTPIdleTimeout     time.Duration `mapstructure:"HTTP_IDLE_TIMEOUT"`
	HTTPShutdownTimeout time.Duration `mapstructure:"HTTP_SHUTDOWN_TIMEOUT"`

	// Database
	DatabaseURL         string        `mapstructure:"DATABASE_URL"`
	DBMaxConns          int32         `mapstructure:"DB_MAX_CONNS"`
	DBMinConns          int32         `mapstructure:"DB_MIN_CONNS"`
	DBMaxConnLifetime   time.Duration `mapstructure:"DB_MAX_CONN_LIFETIME"`
	DBMaxConnIdleTime   time.Duration `mapstructure:"DB_MAX_CONN_IDLE_TIME"`
	DBHealthCheckPeriod time.Duration `mapstructure:"DB_HEALTH_CHECK_PERIOD"`
	DBConnectTimeout    time.Duration `mapstructure:"DB_CONNECT_TIMEOUT"`

	// Auth
	JWTSecret          string        `mapstructure:"JWT_SECRET"`
	JWTAccessTokenTTL  time.Duration `mapstructure:"JWT_ACCESS_TOKEN_TTL"`
	JWTRefreshTokenTTL time.Duration `mapstructure:"JWT_REFRESH_TOKEN_TTL"`

	// LiveKit
	LiveKitURL           string        `mapstructure:"LIVEKIT_URL"`
	LiveKitAPIKey        string        `mapstructure:"LIVEKIT_API_KEY"`
	LiveKitAPISecret     string        `mapstructure:"LIVEKIT_API_SECRET"`
	LiveKitWebhookSecret string        `mapstructure:"LIVEKIT_WEBHOOK_SECRET"`
	CallInviteTTL        time.Duration `mapstructure:"CALL_INVITE_TTL"`

	// Sync / event log thresholds (plan §8)
	SyncEventLimit      int `mapstructure:"SYNC_EVENT_LIMIT"`
	SyncRetentionWindow int `mapstructure:"SYNC_RETENTION_WINDOW"` // hours
	MaxSyncBatch        int `mapstructure:"MAX_SYNC_BATCH"`

	// Phase 3: event pipeline
	WsOutboundQueueMax        int           `mapstructure:"WS_OUTBOUND_QUEUE_MAX"`
	EventBusSubscriberBuffer  int           `mapstructure:"EVENT_BUS_SUBSCRIBER_BUFFER"`
	EventListenerCatchupBatch int           `mapstructure:"EVENT_LISTENER_CATCHUP_BATCH"`
	EventListenerRetryBackoff time.Duration `mapstructure:"EVENT_LISTENER_RETRY_BACKOFF"`

	// Bootstrap pagination
	BootstrapDefaultPageSize int           `mapstructure:"BOOTSTRAP_DEFAULT_PAGE_SIZE"`
	BootstrapMaxPageSize     int           `mapstructure:"BOOTSTRAP_MAX_PAGE_SIZE"`
	BootstrapSessionTTL      time.Duration `mapstructure:"BOOTSTRAP_SESSION_TTL"`

	// Chat history pagination
	ChatHistoryPageSize int `mapstructure:"CHAT_HISTORY_PAGE_SIZE"`

	// Task tracker grouped-mode pagination
	TaskGroupPortionDefaultLimit int `mapstructure:"TASK_GROUP_PORTION_DEFAULT_LIMIT"`
	TaskGroupPortionMaxLimit     int `mapstructure:"TASK_GROUP_PORTION_MAX_LIMIT"`
	TaskDescriptionHistoryLimit  int `mapstructure:"TASK_DESCRIPTION_HISTORY_LIMIT"`
	DocumentHistoryLimit         int `mapstructure:"DOCUMENT_HISTORY_LIMIT"`

	// Minio / Object Storage
	MinioEndpoint       string `mapstructure:"MINIO_ENDPOINT"`
	MinioAccessKey      string `mapstructure:"MINIO_ACCESS_KEY"`
	MinioSecretKey      string `mapstructure:"MINIO_SECRET_KEY"`
	MinioUseSSL         bool   `mapstructure:"MINIO_USE_SSL"`
	MinioBucket         string `mapstructure:"MINIO_BUCKET"`
	AttachmentMaxSizeMB int    `mapstructure:"ATTACHMENT_MAX_SIZE_MB"`
	AvatarMaxSizeMB     int    `mapstructure:"AVATAR_MAX_SIZE_MB"`

	// Push notifications (VAPID / Web Push)
	VAPIDPublicKey      string        `mapstructure:"VAPID_PUBLIC_KEY"`
	VAPIDPrivateKey     string        `mapstructure:"VAPID_PRIVATE_KEY"`
	VAPIDSubject        string        `mapstructure:"VAPID_SUBJECT"` // mailto: or https: URL
	PushRateLimitWindow time.Duration `mapstructure:"PUSH_RATE_LIMIT_WINDOW"`
	PushTTLSeconds      int           `mapstructure:"PUSH_TTL_SECONDS"`

	// Observability
	MetricsPort string `mapstructure:"METRICS_PORT"`

	// CORS
	CORSAllowedOrigins string `mapstructure:"CORS_ALLOWED_ORIGINS"` // comma-separated origins or "*"
}

func (c *Config) IsDev() bool {
	return c.Env == "dev" || c.Env == "development"
}

func Load() (*Config, error) {
	viper.SetConfigFile(".env")
	viper.AutomaticEnv()

	viper.SetDefault("ENV", "production")
	viper.SetDefault("PORT", "8080")

	viper.SetDefault("HTTP_READ_TIMEOUT", 10*time.Second)
	viper.SetDefault("HTTP_WRITE_TIMEOUT", 30*time.Second)
	viper.SetDefault("HTTP_IDLE_TIMEOUT", 60*time.Second)
	viper.SetDefault("HTTP_SHUTDOWN_TIMEOUT", 30*time.Second)

	viper.SetDefault("DATABASE_URL", "postgres://msgnr:msgnr@localhost/msgnr?sslmode=disable")
	viper.SetDefault("DB_MAX_CONNS", 20)
	viper.SetDefault("DB_MIN_CONNS", 2)
	viper.SetDefault("DB_MAX_CONN_LIFETIME", 30*time.Minute)
	viper.SetDefault("DB_MAX_CONN_IDLE_TIME", 5*time.Minute)
	viper.SetDefault("DB_HEALTH_CHECK_PERIOD", 1*time.Minute)
	viper.SetDefault("DB_CONNECT_TIMEOUT", 10*time.Second)

	viper.SetDefault("JWT_SECRET", "change-me-in-production")
	viper.SetDefault("JWT_ACCESS_TOKEN_TTL", 1*time.Hour)
	viper.SetDefault("JWT_REFRESH_TOKEN_TTL", 10*365*24*time.Hour)

	viper.SetDefault("LIVEKIT_URL", "ws://localhost:7880")
	viper.SetDefault("LIVEKIT_API_KEY", "")
	viper.SetDefault("LIVEKIT_API_SECRET", "")
	viper.SetDefault("LIVEKIT_WEBHOOK_SECRET", "")
	viper.SetDefault("CALL_INVITE_TTL", 60*time.Second)

	viper.SetDefault("SYNC_EVENT_LIMIT", 1000)
	viper.SetDefault("SYNC_RETENTION_WINDOW", 72) // 72 hours
	viper.SetDefault("MAX_SYNC_BATCH", 500)

	viper.SetDefault("WS_OUTBOUND_QUEUE_MAX", 1024)
	viper.SetDefault("EVENT_BUS_SUBSCRIBER_BUFFER", 256)
	viper.SetDefault("EVENT_LISTENER_CATCHUP_BATCH", 500)
	viper.SetDefault("EVENT_LISTENER_RETRY_BACKOFF", 1*time.Second)

	viper.SetDefault("BOOTSTRAP_DEFAULT_PAGE_SIZE", 100)
	viper.SetDefault("BOOTSTRAP_MAX_PAGE_SIZE", 200)
	viper.SetDefault("BOOTSTRAP_SESSION_TTL", 5*time.Minute)
	viper.SetDefault("CHAT_HISTORY_PAGE_SIZE", 50)
	viper.SetDefault("TASK_GROUP_PORTION_DEFAULT_LIMIT", 50)
	viper.SetDefault("TASK_GROUP_PORTION_MAX_LIMIT", 200)
	viper.SetDefault("TASK_DESCRIPTION_HISTORY_LIMIT", 20)
	viper.SetDefault("DOCUMENT_HISTORY_LIMIT", 25)

	viper.SetDefault("MINIO_ENDPOINT", "localhost:9000")
	viper.SetDefault("MINIO_ACCESS_KEY", "minioadmin")
	viper.SetDefault("MINIO_SECRET_KEY", "minioadmin")
	viper.SetDefault("MINIO_USE_SSL", false)
	viper.SetDefault("MINIO_BUCKET", "task-attachments")
	viper.SetDefault("ATTACHMENT_MAX_SIZE_MB", 50)
	viper.SetDefault("AVATAR_MAX_SIZE_MB", 5)

	viper.SetDefault("VAPID_PUBLIC_KEY", "")
	viper.SetDefault("VAPID_PRIVATE_KEY", "")
	viper.SetDefault("VAPID_SUBJECT", "")
	viper.SetDefault("PUSH_RATE_LIMIT_WINDOW", 1*time.Second)
	viper.SetDefault("PUSH_TTL_SECONDS", 60)

	viper.SetDefault("METRICS_PORT", "9090")
	viper.SetDefault("CORS_ALLOWED_ORIGINS", "*")

	// Read .env file if present; ignore missing file
	viper.ReadInConfig()

	var cfg Config
	if err := viper.Unmarshal(&cfg); err != nil {
		return nil, err
	}

	return &cfg, nil
}
