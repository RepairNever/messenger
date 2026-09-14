package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

const namespace = "msgnr"

var (
	WebSocketConnections = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "websocket_connections_total",
			Help:      "Total WebSocket connections by status (accepted, rejected).",
		},
		[]string{"status"},
	)

	ActiveWebSocketConnections = promauto.NewGauge(
		prometheus.GaugeOpts{
			Namespace: namespace,
			Name:      "websocket_connections_active",
			Help:      "Current number of active WebSocket connections.",
		},
	)

	MessagesReceived = promauto.NewCounter(
		prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "messages_received_total",
			Help:      "Total WebSocket messages received from clients.",
		},
	)

	MessagesSent = promauto.NewCounter(
		prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "messages_sent_total",
			Help:      "Total WebSocket messages sent to clients.",
		},
	)

	DBConnsAcquired = promauto.NewGauge(
		prometheus.GaugeOpts{
			Namespace: namespace,
			Name:      "db_connections_acquired",
			Help:      "Current number of acquired database connections.",
		},
	)

	DBQueryDuration = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Namespace: namespace,
			Name:      "db_query_duration_seconds",
			Help:      "Database query duration in seconds.",
			Buckets:   []float64{.001, .005, .01, .025, .05, .1, .25, .5, 1},
		},
		[]string{"op"},
	)

	HTTPRequestsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "http_requests_total",
			Help:      "Total HTTP requests by method, path, and status code.",
		},
		[]string{"method", "path", "status"},
	)

	HTTPRequestDuration = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Namespace: namespace,
			Name:      "http_request_duration_seconds",
			Help:      "HTTP request duration in seconds.",
			Buckets:   prometheus.DefBuckets,
		},
		[]string{"method", "path"},
	)

	AuthLoginTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "auth_login_total",
			Help:      "Total login attempts by status (success, invalid_credentials, blocked, error).",
		},
		[]string{"status"},
	)

	AuthRefreshTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "auth_refresh_total",
			Help:      "Total token refresh attempts by status (success, invalid, blocked, error).",
		},
		[]string{"status"},
	)

	AuthLogoutTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "auth_logout_total",
			Help:      "Total logout attempts by status (success, error).",
		},
		[]string{"status"},
	)

	WsAuthTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "ws_auth_total",
			Help:      "Total WS auth attempts by status (success, unauthenticated, forbidden, error).",
		},
		[]string{"status"},
	)

	WsLiveEventAuthTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "ws_live_event_auth_total",
			Help:      "Total live WS event authorization decisions by result.",
		},
		[]string{"result"},
	)

	// Event outbox / store metrics
	EventOutboxAppendedTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "event_outbox_appended_total",
			Help:      "Total event append attempts by status (success, error).",
		},
		[]string{"status"},
	)

	EventNotifyTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "event_notify_total",
			Help:      "Total pg_notify calls by status (success, error).",
		},
		[]string{"status"},
	)

	// Listener metrics
	EventListenerNotificationsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "event_listener_notifications_total",
			Help:      "Total notifications received by the listener by status (ok, parse_error, fetch_error).",
		},
		[]string{"status"},
	)

	EventListenerLagSeq = promauto.NewGauge(
		prometheus.GaugeOpts{
			Namespace: namespace,
			Name:      "event_listener_lag_seq",
			Help:      "Difference between latest DB event_seq and last delivered event_seq.",
		},
	)

	// Bus metrics
	EventBusPublishTotal = promauto.NewCounter(
		prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "event_bus_publish_total",
			Help:      "Total events published to the in-process event bus.",
		},
	)

	EventBusSubscribers = promauto.NewGauge(
		prometheus.GaugeOpts{
			Namespace: namespace,
			Name:      "event_bus_subscribers",
			Help:      "Current number of active event bus subscribers.",
		},
	)

	EventBusDroppedTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "event_bus_dropped_total",
			Help:      "Total events dropped by the bus by reason (overflow).",
		},
		[]string{"reason"},
	)

	// WS fanout metrics
	WsOutboundOverflowTotal = promauto.NewCounter(
		prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "ws_outbound_overflow_total",
			Help:      "Total WS sessions closed due to outbound queue overflow.",
		},
	)

	WsServerEventsSentTotal = promauto.NewCounter(
		prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "ws_server_events_sent_total",
			Help:      "Total ServerEvent frames sent to WS clients.",
		},
	)

	WsFanoutDroppedTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "ws_fanout_dropped_total",
			Help:      "Total WS fanout deliveries dropped by reason.",
		},
		[]string{"reason"},
	)

	WsSessionDesyncTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "ws_session_desync_total",
			Help:      "Total WS sessions forced to reconnect because realtime fanout became unreliable.",
		},
		[]string{"reason"},
	)
)
