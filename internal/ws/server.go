package ws

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gobwas/ws"
	"github.com/gobwas/ws/wsutil"
	"github.com/google/uuid"
	"go.uber.org/zap"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	"msgnr/internal/auth"
	"msgnr/internal/bootstrap"
	"msgnr/internal/calls"
	"msgnr/internal/chat"
	"msgnr/internal/config"
	"msgnr/internal/database"
	"msgnr/internal/documents"
	"msgnr/internal/events"
	packetspb "msgnr/internal/gen/proto"
	"msgnr/internal/logger"
	"msgnr/internal/metrics"
	syncsvc "msgnr/internal/sync"
	"msgnr/internal/tasks"
	"msgnr/internal/userstatus"
)

const protocolVersion uint32 = 1

const (
	taskCollabSyncMagic0    = 0x54 // 'T'
	taskCollabSyncMagic1    = 0x44 // 'D'
	taskCollabSyncProtocolV = 1
	defaultPresenceLeaseTTL = 90 * time.Second
	defaultPresenceSweepInt = 15 * time.Second
)

type taskCollabSyncFrameType byte

const (
	taskCollabSyncFrameTypeUpdate      taskCollabSyncFrameType = 1
	taskCollabSyncFrameTypeStateVector taskCollabSyncFrameType = 2
	taskCollabSyncFrameTypeStateUpdate taskCollabSyncFrameType = 3
	taskCollabSyncFrameTypeFullState   taskCollabSyncFrameType = 4
)

type collabEntityKind string

const (
	collabEntityTask     collabEntityKind = "task"
	collabEntityDocument collabEntityKind = "document"
)

func markdownSignatureForLog(input string) string {
	hasher := fnv.New32a()
	_, _ = hasher.Write([]byte(input))
	preview := input
	if len(preview) > 80 {
		preview = preview[:80]
	}
	preview = strings.ReplaceAll(preview, "\n", "\\n")
	return fmt.Sprintf("len=%d,hash=%d,preview=%q", len(input), hasher.Sum32(), preview)
}

func conversationMemberSummaryFromChat(member chat.ConversationMember) *packetspb.ConversationMemberSummary {
	return &packetspb.ConversationMemberSummary{
		UserId:       member.UserID.String(),
		DisplayName:  member.DisplayName,
		Email:        member.Email,
		AvatarUrl:    member.AvatarURL,
		CustomStatus: userstatus.ToProto(member.CustomStatus),
	}
}

var supportedCapabilities = map[packetspb.FeatureCapability]struct{}{
	packetspb.FeatureCapability_FEATURE_CAPABILITY_THREADS:              {},
	packetspb.FeatureCapability_FEATURE_CAPABILITY_REACTIONS:            {},
	packetspb.FeatureCapability_FEATURE_CAPABILITY_TYPING:               {},
	packetspb.FeatureCapability_FEATURE_CAPABILITY_PRESENCE:             {},
	packetspb.FeatureCapability_FEATURE_CAPABILITY_BOOTSTRAP_PAGINATION: {},
	packetspb.FeatureCapability_FEATURE_CAPABILITY_SYNC_SINCE:           {},
	packetspb.FeatureCapability_FEATURE_CAPABILITY_CALL_INVITES:         {},
	packetspb.FeatureCapability_FEATURE_CAPABILITY_INVITE_ACTIONS:       {},
	packetspb.FeatureCapability_FEATURE_CAPABILITY_PRESENCE_HEARTBEAT:   {},
	packetspb.FeatureCapability_FEATURE_CAPABILITY_TRANSPORT_HEARTBEAT:  {},
}

// outboundMsg is an item placed on the per-session outbound queue.
// A nil proto signals the writer goroutine to shut down.
type outboundMsg struct {
	env *packetspb.Envelope
}

type presenceSnapshot struct {
	status       packetspb.PresenceStatus
	lastActiveAt time.Time
}

type sessionState struct {
	mu                      sync.RWMutex
	windowActive            bool
	conversationCacheReady  bool
	authorizedConversations map[string]struct{}
	disconnectOnce          sync.Once
	disconnect              func(reason string)
}

type collabRoom struct {
	subscribers map[chan outboundMsg]struct{}
	snapshot    []byte
}

func newSessionState(authorizedConversationIDs []uuid.UUID, cacheReady bool, disconnect func(reason string)) *sessionState {
	authorized := make(map[string]struct{}, len(authorizedConversationIDs))
	for _, conversationID := range authorizedConversationIDs {
		authorized[conversationID.String()] = struct{}{}
	}
	return &sessionState{
		windowActive:            true,
		conversationCacheReady:  cacheReady,
		authorizedConversations: authorized,
		disconnect:              disconnect,
	}
}

func (s *sessionState) setWindowActive(active bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.windowActive = active
}

func (s *sessionState) hasActiveWindow() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.windowActive
}

func (s *sessionState) cacheReady() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.conversationCacheReady
}

func (s *sessionState) hasConversation(conversationID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := s.authorizedConversations[conversationID]
	return ok
}

func (s *sessionState) allowConversation(conversationID string) {
	if conversationID == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.authorizedConversations == nil {
		s.authorizedConversations = make(map[string]struct{})
	}
	s.authorizedConversations[conversationID] = struct{}{}
}

func (s *sessionState) revokeConversation(conversationID string) {
	if conversationID == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.authorizedConversations, conversationID)
}

func (s *sessionState) applyAuthorizationEvent(userID string, evt *packetspb.ServerEvent) {
	if evt == nil {
		return
	}
	conversationID := evt.GetConversationId()
	switch payload := evt.Payload.(type) {
	case *packetspb.ServerEvent_ConversationUpserted:
		if payload.ConversationUpserted != nil {
			s.allowConversation(conversationID)
		}
	case *packetspb.ServerEvent_ConversationRemoved:
		if payload.ConversationRemoved != nil {
			s.revokeConversation(conversationID)
		}
	case *packetspb.ServerEvent_MembershipChanged:
		if payload.MembershipChanged == nil || payload.MembershipChanged.GetUserId() != userID {
			return
		}
		switch payload.MembershipChanged.GetAction() {
		case packetspb.MembershipAction_MEMBERSHIP_ACTION_ADDED,
			packetspb.MembershipAction_MEMBERSHIP_ACTION_JOINED:
			s.allowConversation(conversationID)
		case packetspb.MembershipAction_MEMBERSHIP_ACTION_LEFT,
			packetspb.MembershipAction_MEMBERSHIP_ACTION_REMOVED:
			s.revokeConversation(conversationID)
		}
	}
}

func (s *sessionState) disconnectWithReason(reason string) {
	s.disconnectOnce.Do(func() {
		if s.disconnect != nil {
			s.disconnect(reason)
		}
	})
}

// PushNotifier is called for DirectDeliveries targeting users with no active
// WebSocket sessions. Implementations send Web Push notifications.
type PushNotifier interface {
	PushChatDeliveries(deliveries []chat.DirectDelivery)
	PushCallDeliveries(deliveries []calls.DirectDelivery)
}

// Server handles WebSocket connections and wires each authenticated session
// to the event Bus for async server-push delivery.
type Server struct {
	db                    *database.DB
	config                *config.Config
	authSvc               *auth.Service
	bootstrapSvc          *bootstrap.Service
	callSvc               *calls.Service
	chatSvc               *chat.Service
	tasksSvc              *tasks.Service
	documentsSvc          *documents.Service
	syncSvc               *syncsvc.Service
	bus                   *events.Bus
	eventStore            *events.Store
	authorizeEvent        func(ctx context.Context, principal auth.Principal, evt *packetspb.ServerEvent) bool
	log                   *zap.Logger
	sessionMu             sync.RWMutex
	sessionsByUser        map[string]map[chan outboundMsg]*sessionState
	typingMu              sync.Mutex
	typingExpiry          map[string]time.Time
	collabMu              sync.RWMutex
	collabRooms           map[string]*collabRoom
	collabRoomsBySession  map[chan outboundMsg]map[string]struct{}
	pushNotifier          PushNotifier // optional; nil means push disabled
	presenceLeaseTTL      time.Duration
	presenceSweepInterval time.Duration
}

// NewServer creates a Server. bus may be nil during tests that don't exercise
// the fanout path.
func NewServer(db *database.DB, cfg *config.Config, authSvc *auth.Service, bootstrapSvc *bootstrap.Service, callSvc *calls.Service, chatSvc *chat.Service, syncSvc *syncsvc.Service, bus *events.Bus) *Server {
	srv := &Server{
		db:           db,
		config:       cfg,
		authSvc:      authSvc,
		bootstrapSvc: bootstrapSvc,
		callSvc:      callSvc,
		chatSvc:      chatSvc,
		syncSvc:      syncSvc,
		bus:          bus,
		eventStore:   events.NewStore(db.Pool),
		authorizeEvent: func(ctx context.Context, principal auth.Principal, evt *packetspb.ServerEvent) bool {
			return authSvc.CanReceiveEvent(ctx, principal, evt)
		},
		log:                   logger.Logger,
		sessionsByUser:        make(map[string]map[chan outboundMsg]*sessionState),
		typingExpiry:          make(map[string]time.Time),
		collabRooms:           make(map[string]*collabRoom),
		collabRoomsBySession:  make(map[chan outboundMsg]map[string]struct{}),
		presenceLeaseTTL:      defaultPresenceLeaseTTL,
		presenceSweepInterval: defaultPresenceSweepInt,
	}
	srv.startPresenceLeaseSweeper()
	return srv
}

func (s *Server) Handler() http.HandlerFunc {
	return s.handleWebSocket
}

func (s *Server) presenceLeaseTTLValue() time.Duration {
	if s.presenceLeaseTTL > 0 {
		return s.presenceLeaseTTL
	}
	return defaultPresenceLeaseTTL
}

func (s *Server) presenceSweepIntervalValue() time.Duration {
	if s.presenceSweepInterval > 0 {
		return s.presenceSweepInterval
	}
	return defaultPresenceSweepInt
}

func (s *Server) startPresenceLeaseSweeper() {
	if s == nil || s.db == nil || s.db.Pool == nil {
		return
	}
	interval := s.presenceSweepIntervalValue()
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for range ticker.C {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			if err := s.expireStalePresenceLeases(ctx); err != nil {
				s.log.Error("ws presence: lease sweep failed", zap.Error(err))
			}
			cancel()
		}
	}()
}

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, _, _, err := ws.UpgradeHTTP(r, w)
	if err != nil {
		metrics.WebSocketConnections.WithLabelValues("rejected").Inc()
		s.log.Warn("WebSocket upgrade failed",
			zap.String("remote_addr", r.RemoteAddr),
			zap.Error(err))
		return
	}
	metrics.ActiveWebSocketConnections.Inc()
	metrics.WebSocketConnections.WithLabelValues("accepted").Inc()
	defer metrics.ActiveWebSocketConnections.Dec()

	s.log.Info("WebSocket connected", zap.String("remote_addr", r.RemoteAddr))

	outboundQueueMax := s.config.WsOutboundQueueMax
	// outboundCh carries frames to the single writer goroutine.
	// We reserve a small headroom so that an overflow error frame can always
	// be enqueued before we close.
	const overflowHeadroom = 4
	outboundCh := make(chan outboundMsg, outboundQueueMax+overflowHeadroom)

	// writerDone is closed when the writer goroutine exits.
	writerDone := make(chan struct{})

	// Writer goroutine: single writer to the socket serialises all frames.
	go func() {
		defer close(writerDone)
		for msg := range outboundCh {
			if err := s.writeEnvelope(conn, msg.env); err != nil {
				s.log.Debug("ws writer: write error",
					zap.String("remote_addr", r.RemoteAddr),
					zap.Error(err))
				// Drain and exit; the reader loop will also notice the broken conn.
				for range outboundCh {
				}
				return
			}
		}
	}()

	// enqueue tries to put env on the outbound queue without blocking.
	// Returns false if the queue is full.
	enqueue := func(env *packetspb.Envelope) bool {
		select {
		case outboundCh <- outboundMsg{env: env}:
			return true
		default:
			return false
		}
	}

	var (
		helloComplete               bool
		authComplete                bool
		principal                   auth.Principal
		unsubscribe                 func()
		fanoutDone                  <-chan struct{}
		unregisterSession           func()
		presenceConnectionID        = uuid.New()
		presenceLeaseRefreshCapable bool
	)

	defer func() {
		_ = conn.Close()
		// Stop event subscriptions before closing the outbound channel so
		// the fanout goroutine cannot write after close.
		if unsubscribe != nil {
			unsubscribe()
		}
		if unregisterSession != nil {
			unregisterSession()
		}
		s.removeCollabSession(outboundCh)
		if authComplete {
			presenceCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			if err := s.removePresenceLease(presenceCtx, presenceConnectionID); err != nil {
				s.log.Error("ws auth: failed to remove presence lease", zap.Error(err))
			} else if snapshot, changed, err := s.recomputePresence(presenceCtx, principal.UserID); err != nil {
				s.log.Error("ws auth: failed to recompute presence on disconnect", zap.Error(err))
			} else if changed {
				s.broadcastPresence(presenceCtx, principal.UserID, snapshot)
			}
			cancel()
		}
		if fanoutDone != nil {
			<-fanoutDone
		}
		close(outboundCh)
		<-writerDone
		s.log.Info("WebSocket disconnected",
			zap.String("remote_addr", r.RemoteAddr),
			zap.String("user_id", func() string {
				if authComplete {
					return principal.UserID.String()
				}
				return ""
			}()),
		)
	}()

	for {
		msg, op, err := wsutil.ReadClientData(conn)
		if err != nil {
			s.log.Debug("WebSocket read error",
				zap.String("remote_addr", r.RemoteAddr),
				zap.Error(err))
			break
		}

		metrics.MessagesReceived.Inc()

		if op != ws.OpBinary {
			enqueue(s.buildErrorEnvelope("", "", packetspb.ErrorCode_ERROR_CODE_BAD_REQUEST, "binary protobuf envelope required", 0))
			continue
		}

		var env packetspb.Envelope
		if err := proto.Unmarshal(msg, &env); err != nil {
			enqueue(s.buildErrorEnvelope("", "", packetspb.ErrorCode_ERROR_CODE_BAD_REQUEST, "invalid protobuf envelope", 0))
			continue
		}

		if env.GetProtocolVersion() != protocolVersion {
			enqueue(s.buildErrorEnvelope(env.GetRequestId(), env.GetTraceId(), packetspb.ErrorCode_ERROR_CODE_BAD_REQUEST, "unsupported protocol_version", 0))
			continue
		}

		// State 1: Hello handshake
		if !helloComplete {
			clientHelloPayload, ok := env.GetPayload().(*packetspb.Envelope_ClientHello)
			if !ok || clientHelloPayload.ClientHello == nil {
				if !enqueue(s.buildErrorEnvelope(env.GetRequestId(), env.GetTraceId(), packetspb.ErrorCode_ERROR_CODE_BAD_REQUEST, "expected client_hello as first envelope", 0)) {
					break
				}
				continue
			}

			accepted := negotiateCapabilities(clientHelloPayload.ClientHello.GetCapabilities())
			presenceLeaseRefreshCapable = hasCapability(accepted, packetspb.FeatureCapability_FEATURE_CAPABILITY_PRESENCE_HEARTBEAT) ||
				hasCapability(accepted, packetspb.FeatureCapability_FEATURE_CAPABILITY_TRANSPORT_HEARTBEAT)
			serverHello := &packetspb.ServerHello{
				Server:          "msgnr",
				ProtocolVersion: protocolVersion,
				RateLimitPolicy: &packetspb.RateLimitPolicy{
					MaxEnvelopeBytes:   1 << 20,
					PerConnectionRps:   50,
					PerConnectionBurst: 100,
					PerUserRps:         200,
					PerUserBurst:       400,
					OutboundQueueMax:   uint32(s.config.WsOutboundQueueMax),
					MaxSyncBatch:       uint32(s.config.MaxSyncBatch),
				},
				AcceptedCapabilities: accepted,
			}
			resp := &packetspb.Envelope{
				RequestId:       env.GetRequestId(),
				TraceId:         env.GetTraceId(),
				ProtocolVersion: protocolVersion,
				Payload:         &packetspb.Envelope_ServerHello{ServerHello: serverHello},
			}
			if !enqueue(resp) {
				break
			}
			helloComplete = true
			continue
		}

		// State 2: Auth step — required before any other payload
		if !authComplete {
			authReqPayload, ok := env.GetPayload().(*packetspb.Envelope_AuthRequest)
			if !ok || authReqPayload.AuthRequest == nil {
				metrics.WsAuthTotal.WithLabelValues("unauthenticated").Inc()
				s.log.Info("ws auth: non-auth payload before AuthRequest",
					zap.String("remote_addr", r.RemoteAddr),
				)
				enqueue(s.buildErrorEnvelope(env.GetRequestId(), env.GetTraceId(), packetspb.ErrorCode_ERROR_CODE_UNAUTHENTICATED, "AuthRequest required", 0))
				break
			}

			p, err := s.authSvc.VerifyAccess(r.Context(), authReqPayload.AuthRequest.GetAccessToken())
			if err != nil {
				code := packetspb.ErrorCode_ERROR_CODE_UNAUTHENTICATED
				errMsg := "unauthenticated"
				status := "unauthenticated"
				if errors.Is(err, auth.ErrUserBlocked) {
					code = packetspb.ErrorCode_ERROR_CODE_FORBIDDEN
					errMsg = "account blocked"
					status = "forbidden"
				}
				metrics.WsAuthTotal.WithLabelValues(status).Inc()
				s.log.Info("ws auth: failed",
					zap.String("remote_addr", r.RemoteAddr),
					zap.Error(err),
				)
				enqueue(s.buildErrorEnvelope(env.GetRequestId(), env.GetTraceId(), code, errMsg, 0))
				break
			}

			principal = p
			authComplete = true
			metrics.WsAuthTotal.WithLabelValues("success").Inc()
			s.log.Info("ws auth: success",
				zap.String("remote_addr", r.RemoteAddr),
				zap.String("user_id", principal.UserID.String()),
				zap.String("session_id", principal.SessionID.String()),
			)

			persistedEventSeq := int64(0)
			if s.syncSvc != nil {
				cursor, cursorErr := s.syncSvc.GetPersistedCursor(r.Context(), principal.UserID)
				if cursorErr != nil {
					s.log.Error("ws auth: failed to load persisted cursor",
						zap.String("user_id", principal.UserID.String()),
						zap.Error(cursorErr),
					)
				} else {
					persistedEventSeq = cursor
				}
			}

			resp := &packetspb.Envelope{
				RequestId:       env.GetRequestId(),
				TraceId:         env.GetTraceId(),
				ProtocolVersion: protocolVersion,
				Payload: &packetspb.Envelope_AuthResponse{
					AuthResponse: &packetspb.AuthResponse{
						Ok:                true,
						UserId:            principal.UserID.String(),
						SessionId:         principal.SessionID.String(),
						PersistedEventSeq: persistedEventSeq,
						UserRole:          mapWorkspaceRole(principal.Role),
					},
				},
			}
			if !enqueue(resp) {
				break
			}

			sessionCacheCtx, sessionCacheCancel := context.WithTimeout(context.Background(), 2*time.Second)
			authorizedConversationIDs, cacheReady := s.loadSessionConversationAccess(sessionCacheCtx, principal.UserID)
			sessionCacheCancel()
			state := newSessionState(authorizedConversationIDs, cacheReady, func(reason string) {
				s.log.Warn("ws session: forcing reconnect after fanout desync",
					zap.String("user_id", principal.UserID.String()),
					zap.String("session_id", principal.SessionID.String()),
					zap.String("reason", reason),
				)
				_ = conn.Close()
			})

			unregisterSession = s.registerUserSession(principal.UserID.String(), outboundCh, state)
			// Register as an event bus subscriber after successful auth.
			if s.bus != nil {
				unsubscribe, fanoutDone = s.startEventFanout(conn, principal, outboundCh, outboundQueueMax, state)
			}
			presenceCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			if err := s.touchPresenceLease(presenceCtx, presenceConnectionID, principal.UserID, principal.SessionID, presenceLeaseRefreshCapable); err != nil {
				s.log.Error("ws auth: failed to touch presence lease", zap.Error(err))
			} else if snapshot, changed, err := s.recomputePresence(presenceCtx, principal.UserID); err != nil {
				s.log.Error("ws auth: failed to recompute presence", zap.Error(err))
			} else if changed {
				s.broadcastPresence(presenceCtx, principal.UserID, snapshot)
			}
			cancel()
			continue
		}

		// State 3: Authenticated — domain payload dispatch.
		s.handleDomainPayload(r.Context(), &env, principal, presenceConnectionID, presenceLeaseRefreshCapable, outboundCh, enqueue)
	}
}

// startEventFanout subscribes to the Bus and launches a goroutine that
// forwards received ServerEvents to outboundCh. It returns an unsubscribe
// function; calling it stops the fanout goroutine and removes the subscription.
func (s *Server) startEventFanout(
	conn net.Conn,
	principal auth.Principal,
	outboundCh chan outboundMsg,
	queueMax int,
	state *sessionState,
) (func(), <-chan struct{}) {
	var desyncOnce sync.Once
	handleSessionDesync := func(reason string, evt *packetspb.ServerEvent) {
		desyncOnce.Do(func() {
			metrics.WsSessionDesyncTotal.WithLabelValues(reason).Inc()
			fields := []zap.Field{
				zap.String("session_id", principal.SessionID.String()),
				zap.String("user_id", principal.UserID.String()),
				zap.String("reason", reason),
			}
			if evt != nil {
				fields = append(fields,
					zap.Int64("event_seq", evt.GetEventSeq()),
					zap.String("event_type", evt.GetEventType().String()),
				)
			}
			s.log.Warn("ws fanout: session desynced, forcing reconnect", fields...)
			if state != nil {
				state.disconnectWithReason(reason)
				return
			}
			_ = conn.Close()
		})
	}

	filter := func(evt *packetspb.ServerEvent) bool {
		if state != nil && s.authSvc != nil {
			allowed, result := s.authSvc.CanReceiveEventWithConversationAccess(
				principal,
				evt,
				state.hasConversation,
				state.allowConversation,
			)
			if allowed {
				metrics.WsLiveEventAuthTotal.WithLabelValues(result).Inc()
				return true
			}

			cacheReady := state.cacheReady()
			isCallParticipantEvent := evt.GetCallStateChanged() != nil || evt.GetCallRaisedHandsChanged() != nil
			shouldFallback := !cacheReady || evt.GetConversationUpserted() != nil || isCallParticipantEvent
			if result == "conversation_cache_miss" && shouldFallback && s.authorizeEvent != nil {
				ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
				allowed = s.authorizeEvent(ctx, principal, evt)
				timeoutErr := ctx.Err()
				cancel()
				if allowed {
					if conversationID := evt.GetConversationId(); conversationID != "" && !isCallParticipantEvent {
						state.allowConversation(conversationID)
					}
					label := "allowed_fallback_cache_miss"
					if !cacheReady {
						label = "allowed_fallback_cache_unavailable"
					}
					metrics.WsLiveEventAuthTotal.WithLabelValues(label).Inc()
					return true
				}
				if timeoutErr == context.DeadlineExceeded {
					metrics.WsLiveEventAuthTotal.WithLabelValues("fallback_timeout").Inc()
					s.log.Warn("ws fanout: event auth fallback timed out",
						zap.String("session_id", principal.SessionID.String()),
						zap.String("user_id", principal.UserID.String()),
						zap.Int64("event_seq", evt.GetEventSeq()),
						zap.String("event_type", evt.GetEventType().String()),
					)
					return false
				}
				metrics.WsLiveEventAuthTotal.WithLabelValues("fallback_denied").Inc()
				return false
			}

			metrics.WsLiveEventAuthTotal.WithLabelValues(result).Inc()
			return false
		}

		if s.authorizeEvent == nil {
			metrics.WsLiveEventAuthTotal.WithLabelValues("denied_no_authorizer").Inc()
			return false
		}
		ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		allowed := s.authorizeEvent(ctx, principal, evt)
		timeoutErr := ctx.Err()
		cancel()
		if allowed {
			metrics.WsLiveEventAuthTotal.WithLabelValues("allowed_fallback_only").Inc()
			return true
		}
		if timeoutErr == context.DeadlineExceeded {
			metrics.WsLiveEventAuthTotal.WithLabelValues("fallback_timeout").Inc()
			s.log.Warn("ws fanout: event auth fallback timed out",
				zap.String("session_id", principal.SessionID.String()),
				zap.String("user_id", principal.UserID.String()),
				zap.Int64("event_seq", evt.GetEventSeq()),
				zap.String("event_type", evt.GetEventType().String()),
			)
			return false
		}
		metrics.WsLiveEventAuthTotal.WithLabelValues("fallback_denied").Inc()
		return false
	}
	_, eventCh, unsubscribe := s.bus.SubscribeWithOverflow(filter, s.config.EventBusSubscriberBuffer, func(evt *packetspb.ServerEvent) {
		metrics.WsFanoutDroppedTotal.WithLabelValues("event_bus_overflow").Inc()
		handleSessionDesync("event_bus_overflow", evt)
	})
	done := make(chan struct{})

	go func() {
		defer close(done)
		sessionID := principal.SessionID.String()
		userID := principal.UserID.String()

		for evt := range eventCh {
			deliveredEvt := s.filterEncryptedEventForUser(userID, evt)
			if state != nil {
				state.applyAuthorizationEvent(userID, deliveredEvt)
			}
			env := &packetspb.Envelope{
				ProtocolVersion: protocolVersion,
				Payload: &packetspb.Envelope_ServerEvent{
					ServerEvent: deliveredEvt,
				},
			}

			select {
			case outboundCh <- outboundMsg{env: env}:
				metrics.WsServerEventsSentTotal.Inc()
				s.log.Debug("ws fanout: delivered event",
					zap.String("session_id", sessionID),
					zap.String("user_id", userID),
					zap.Int64("event_seq", deliveredEvt.GetEventSeq()),
					zap.String("event_type", deliveredEvt.GetEventType().String()),
				)
			default:
				// outboundCh is full — send overflow error then close.
				metrics.WsOutboundOverflowTotal.Inc()
				metrics.WsFanoutDroppedTotal.WithLabelValues("outbound_overflow").Inc()
				s.log.Warn("ws fanout: outbound queue overflow, closing session",
					zap.String("session_id", sessionID),
					zap.String("user_id", userID),
					zap.Int("queue_max", queueMax),
				)
				// Best-effort: try to enqueue the backpressure error frame.
				select {
				case outboundCh <- outboundMsg{env: s.buildErrorEnvelope("", "", packetspb.ErrorCode_ERROR_CODE_BACKPRESSURE_OVERFLOW, "outbound queue overflow", 0)}:
				default:
				}
				handleSessionDesync("outbound_overflow", evt)
				return
			}
		}
	}()

	return unsubscribe, done
}

// buildErrorEnvelope constructs an error Envelope without writing to the conn.
func (s *Server) buildErrorEnvelope(
	requestID string,
	traceID string,
	code packetspb.ErrorCode,
	message string,
	retryAfterMs uint32,
) *packetspb.Envelope {
	return &packetspb.Envelope{
		RequestId:       requestID,
		TraceId:         traceID,
		ProtocolVersion: protocolVersion,
		Payload: &packetspb.Envelope_Error{
			Error: &packetspb.Error{
				Code:         code,
				Message:      message,
				RetryAfterMs: retryAfterMs,
			},
		},
	}
}

func (s *Server) writeEnvelope(conn net.Conn, env *packetspb.Envelope) error {
	body, err := proto.Marshal(env)
	if err != nil {
		return err
	}
	if err := wsutil.WriteServerMessage(conn, ws.OpBinary, body); err != nil {
		return err
	}
	metrics.MessagesSent.Inc()
	return nil
}

func (s *Server) loadSessionConversationAccess(ctx context.Context, userID uuid.UUID) ([]uuid.UUID, bool) {
	if s.authSvc == nil {
		return nil, false
	}
	conversationIDs, err := s.authSvc.ListAuthorizedConversationIDs(ctx, userID)
	if err != nil {
		s.log.Warn("ws auth: failed to initialize session conversation cache",
			zap.String("user_id", userID.String()),
			zap.Error(err),
		)
		return nil, false
	}
	return conversationIDs, true
}

func (s *Server) registerUserSession(userID string, outboundCh chan outboundMsg, state *sessionState) func() {
	s.sessionMu.Lock()
	defer s.sessionMu.Unlock()
	if s.sessionsByUser[userID] == nil {
		s.sessionsByUser[userID] = make(map[chan outboundMsg]*sessionState)
	}
	if state == nil {
		state = newSessionState(nil, false, nil)
	}
	s.sessionsByUser[userID][outboundCh] = state
	return func() {
		s.sessionMu.Lock()
		defer s.sessionMu.Unlock()
		sessions := s.sessionsByUser[userID]
		delete(sessions, outboundCh)
		if len(sessions) == 0 {
			delete(s.sessionsByUser, userID)
		}
	}
}

func (s *Server) setSessionWindowActive(userID string, outboundCh chan outboundMsg, active bool) {
	s.sessionMu.Lock()
	defer s.sessionMu.Unlock()
	sessions := s.sessionsByUser[userID]
	if sessions == nil {
		return
	}
	state, ok := sessions[outboundCh]
	if !ok || state == nil {
		return
	}
	state.setWindowActive(active)
}

// SetPushNotifier configures the optional push notifier. Must be called
// before the server starts accepting connections.
func (s *Server) SetPushNotifier(pn PushNotifier) {
	s.pushNotifier = pn
}

// SetTasksService configures the task service used by task-description collab.
func (s *Server) SetTasksService(tasksSvc *tasks.Service) {
	s.tasksSvc = tasksSvc
}

// SetDocumentsService configures the document service used by document-content collab.
func (s *Server) SetDocumentsService(documentsSvc *documents.Service) {
	s.documentsSvc = documentsSvc
}

// HasActiveSessions returns true if the given user has at least one
// authenticated WebSocket session connected right now.
func (s *Server) HasActiveSessions(userID string) bool {
	s.sessionMu.RLock()
	defer s.sessionMu.RUnlock()
	return len(s.sessionsByUser[userID]) > 0
}

// HasActiveWindowSessions returns true if at least one authenticated websocket
// session for the user reports its chat window as active (focused + visible).
func (s *Server) HasActiveWindowSessions(userID string) bool {
	s.sessionMu.RLock()
	defer s.sessionMu.RUnlock()
	for _, state := range s.sessionsByUser[userID] {
		if state != nil && state.hasActiveWindow() {
			return true
		}
	}
	return false
}

func (s *Server) sendDirectEnvelope(userIDs []string, env *packetspb.Envelope) {
	s.sessionMu.RLock()
	type directTarget struct {
		userID string
		ch     chan outboundMsg
		state  *sessionState
	}
	targets := make([]directTarget, 0)
	for _, userID := range userIDs {
		for ch, state := range s.sessionsByUser[userID] {
			targets = append(targets, directTarget{userID: userID, ch: ch, state: state})
		}
	}
	s.sessionMu.RUnlock()

	evt := env.GetServerEvent()
	for _, target := range targets {
		targetEnv := env
		targetEvt := evt
		if evt != nil {
			targetEvt = s.filterEncryptedEventForUser(target.userID, evt)
			targetEnv = envelopeWithServerEvent(env, targetEvt)
		}
		if targetEvt != nil && target.state != nil {
			target.state.applyAuthorizationEvent(target.userID, targetEvt)
		}
		select {
		case target.ch <- outboundMsg{env: targetEnv}:
		default:
			metrics.WsFanoutDroppedTotal.WithLabelValues("direct_overflow").Inc()
			if targetEvt != nil {
				s.log.Warn("ws direct fanout: outbound queue overflow, forcing reconnect",
					zap.String("user_id", target.userID),
					zap.String("event_type", targetEvt.GetEventType().String()),
				)
			}
			metrics.WsSessionDesyncTotal.WithLabelValues("direct_overflow").Inc()
			if target.state != nil {
				target.state.disconnectWithReason("direct_overflow")
			}
		}
	}
}

func envelopeWithServerEvent(env *packetspb.Envelope, evt *packetspb.ServerEvent) *packetspb.Envelope {
	if env.GetServerEvent() == evt {
		return env
	}
	return &packetspb.Envelope{
		RequestId:       env.GetRequestId(),
		TraceId:         env.GetTraceId(),
		ProtocolVersion: env.GetProtocolVersion(),
		Payload:         &packetspb.Envelope_ServerEvent{ServerEvent: evt},
	}
}

func (s *Server) filterEncryptedEventForUser(userID string, evt *packetspb.ServerEvent) *packetspb.ServerEvent {
	msg := evt.GetMessageCreated()
	if msg == nil ||
		msg.GetContentMode() != packetspb.MessageContentMode_MESSAGE_CONTENT_MODE_DM_PAIRWISE_SIGNAL_V1 ||
		msg.GetEncryptedDmPayload() == nil {
		return evt
	}
	if s.chatSvc == nil {
		return chat.StripEncryptedEventPayloads(evt)
	}
	parsedUserID, err := uuid.Parse(userID)
	if err != nil {
		return chat.StripEncryptedEventPayloads(evt)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	filtered, err := s.chatSvc.FilterEncryptedEventPayloadsForUser(ctx, evt, parsedUserID)
	cancel()
	if err != nil {
		s.log.Warn("ws: failed to filter encrypted dm payloads",
			zap.String("user_id", userID),
			zap.Error(err),
		)
		return chat.StripEncryptedEventPayloads(evt)
	}
	return filtered
}

func cloneTaskCollabBytes(src []byte) []byte {
	if len(src) == 0 {
		return nil
	}
	out := make([]byte, len(src))
	copy(out, src)
	return out
}

// decodeTaskCollabSyncFrame returns a payload view into the caller-owned buffer.
// Callers must clone it before storing beyond the scope of the current handler.
func decodeTaskCollabSyncFrame(payload []byte) (taskCollabSyncFrameType, []byte, bool) {
	if len(payload) < 4 ||
		payload[0] != taskCollabSyncMagic0 ||
		payload[1] != taskCollabSyncMagic1 ||
		payload[2] != taskCollabSyncProtocolV {
		return 0, nil, false
	}
	frameType := taskCollabSyncFrameType(payload[3])
	return frameType, payload[4:], true
}

func isKnownTaskCollabSyncFrameType(frameType taskCollabSyncFrameType) bool {
	switch frameType {
	case taskCollabSyncFrameTypeUpdate,
		taskCollabSyncFrameTypeStateVector,
		taskCollabSyncFrameTypeStateUpdate,
		taskCollabSyncFrameTypeFullState:
		return true
	default:
		return false
	}
}

func collabRoomKey(kind collabEntityKind, entityID string) string {
	return string(kind) + ":" + entityID
}

func (s *Server) joinCollabRoom(kind collabEntityKind, entityID string, session chan outboundMsg) ([]byte, int32) {
	roomKey := collabRoomKey(kind, entityID)
	s.collabMu.Lock()
	defer s.collabMu.Unlock()

	room := s.collabRooms[roomKey]
	if room == nil {
		room = &collabRoom{
			subscribers: make(map[chan outboundMsg]struct{}),
		}
		s.collabRooms[roomKey] = room
	}
	room.subscribers[session] = struct{}{}

	if s.collabRoomsBySession[session] == nil {
		s.collabRoomsBySession[session] = make(map[string]struct{})
	}
	s.collabRoomsBySession[session][roomKey] = struct{}{}

	return cloneTaskCollabBytes(room.snapshot), int32(len(room.subscribers))
}

func (s *Server) leaveCollabRoom(kind collabEntityKind, entityID string, session chan outboundMsg) {
	roomKey := collabRoomKey(kind, entityID)
	s.collabMu.Lock()
	defer s.collabMu.Unlock()

	room := s.collabRooms[roomKey]
	if room != nil {
		delete(room.subscribers, session)
		if len(room.subscribers) == 0 {
			delete(s.collabRooms, roomKey)
		}
	}

	roomSet := s.collabRoomsBySession[session]
	if roomSet != nil {
		delete(roomSet, roomKey)
		if len(roomSet) == 0 {
			delete(s.collabRoomsBySession, session)
		}
	}
}

func (s *Server) removeCollabSession(session chan outboundMsg) {
	s.collabMu.Lock()
	defer s.collabMu.Unlock()

	roomSet := s.collabRoomsBySession[session]
	if roomSet == nil {
		return
	}

	for roomKey := range roomSet {
		room := s.collabRooms[roomKey]
		if room == nil {
			continue
		}
		delete(room.subscribers, session)
		if len(room.subscribers) == 0 {
			delete(s.collabRooms, roomKey)
		}
	}
	delete(s.collabRoomsBySession, session)
}

func (s *Server) isCollabSubscribed(kind collabEntityKind, entityID string, session chan outboundMsg) bool {
	roomKey := collabRoomKey(kind, entityID)
	s.collabMu.RLock()
	defer s.collabMu.RUnlock()
	room := s.collabRooms[roomKey]
	if room == nil {
		return false
	}
	_, ok := room.subscribers[session]
	return ok
}

func (s *Server) collabRecipients(kind collabEntityKind, entityID string, exclude chan outboundMsg) []chan outboundMsg {
	roomKey := collabRoomKey(kind, entityID)
	s.collabMu.RLock()
	defer s.collabMu.RUnlock()

	room := s.collabRooms[roomKey]
	if room == nil {
		return nil
	}
	out := make([]chan outboundMsg, 0, len(room.subscribers))
	for session := range room.subscribers {
		if session == exclude {
			continue
		}
		out = append(out, session)
	}
	return out
}

func (s *Server) collabSubscriberCount(kind collabEntityKind, entityID string) int {
	roomKey := collabRoomKey(kind, entityID)
	s.collabMu.RLock()
	defer s.collabMu.RUnlock()
	room := s.collabRooms[roomKey]
	if room == nil {
		return 0
	}
	return len(room.subscribers)
}

func (s *Server) setCollabRoomSnapshot(kind collabEntityKind, entityID string, session chan outboundMsg, snapshot []byte) bool {
	roomKey := collabRoomKey(kind, entityID)
	s.collabMu.Lock()
	defer s.collabMu.Unlock()

	room := s.collabRooms[roomKey]
	if room == nil {
		return false
	}
	if _, ok := room.subscribers[session]; !ok {
		return false
	}
	room.snapshot = cloneTaskCollabBytes(snapshot)
	return true
}

func (s *Server) joinTaskCollabRoom(taskID string, session chan outboundMsg) ([]byte, int32) {
	return s.joinCollabRoom(collabEntityTask, taskID, session)
}

func (s *Server) leaveTaskCollabRoom(taskID string, session chan outboundMsg) {
	s.leaveCollabRoom(collabEntityTask, taskID, session)
}

func (s *Server) isTaskCollabSubscribed(taskID string, session chan outboundMsg) bool {
	return s.isCollabSubscribed(collabEntityTask, taskID, session)
}

func (s *Server) taskCollabRecipients(taskID string, exclude chan outboundMsg) []chan outboundMsg {
	return s.collabRecipients(collabEntityTask, taskID, exclude)
}

func (s *Server) taskCollabSubscriberCount(taskID string) int {
	return s.collabSubscriberCount(collabEntityTask, taskID)
}

func (s *Server) setTaskCollabRoomSnapshot(taskID string, session chan outboundMsg, snapshot []byte) bool {
	return s.setCollabRoomSnapshot(collabEntityTask, taskID, session, snapshot)
}

func (s *Server) documentCollabSubscriberCount(documentID string) int {
	return s.collabSubscriberCount(collabEntityDocument, documentID)
}

func (s *Server) setDocumentCollabRoomSnapshot(documentID string, session chan outboundMsg, snapshot []byte) bool {
	return s.setCollabRoomSnapshot(collabEntityDocument, documentID, session, snapshot)
}

func (s *Server) taskCollabSubscribeResponse(taskID string, session chan outboundMsg, persistedMarkdown string) *packetspb.TaskDescriptionCollabSubscribeResponse {
	roomSnapshot, subscriberCount := s.joinTaskCollabRoom(taskID, session)
	return &packetspb.TaskDescriptionCollabSubscribeResponse{
		TaskId:            taskID,
		PersistedMarkdown: persistedMarkdown,
		SubscriberCount:   subscriberCount,
		RoomSnapshot:      roomSnapshot,
	}
}

func (s *Server) documentCollabSubscribeResponse(documentID string, session chan outboundMsg, persistedMarkdown string) *packetspb.DocumentContentCollabSubscribeResponse {
	roomSnapshot, subscriberCount := s.joinCollabRoom(collabEntityDocument, documentID, session)
	return &packetspb.DocumentContentCollabSubscribeResponse{
		DocumentId:        documentID,
		PersistedMarkdown: persistedMarkdown,
		SubscriberCount:   subscriberCount,
		RoomSnapshot:      roomSnapshot,
	}
}

func (s *Server) sendDirectServerEvents(deliveries []chat.DirectDelivery) {
	var pushDeliveries []chat.DirectDelivery
	for _, delivery := range deliveries {
		if delivery.UserID == "" || delivery.Event == nil {
			continue
		}
		s.sendDirectEnvelope([]string{delivery.UserID}, &packetspb.Envelope{
			ProtocolVersion: protocolVersion,
			Payload: &packetspb.Envelope_ServerEvent{
				ServerEvent: delivery.Event,
			},
		})
		if s.pushNotifier != nil && s.shouldPushChatDelivery(delivery) {
			pushDeliveries = append(pushDeliveries, delivery)
		}
	}
	if len(pushDeliveries) > 0 {
		go s.pushNotifier.PushChatDeliveries(pushDeliveries)
	}
}

func (s *Server) shouldPushChatDelivery(delivery chat.DirectDelivery) bool {
	if delivery.UserID == "" || delivery.Event == nil {
		return false
	}
	switch delivery.Event.GetEventType() {
	case packetspb.EventType_EVENT_TYPE_MESSAGE_ALERT,
		packetspb.EventType_EVENT_TYPE_NOTIFICATION_ADDED:
		return !s.HasActiveWindowSessions(delivery.UserID)
	default:
		return false
	}
}

func (s *Server) sendDirectCallServerEvents(deliveries []calls.DirectDelivery) {
	var offlineDeliveries []calls.DirectDelivery
	for _, delivery := range deliveries {
		if delivery.UserID == "" || delivery.Event == nil {
			continue
		}
		s.sendDirectEnvelope([]string{delivery.UserID}, &packetspb.Envelope{
			ProtocolVersion: protocolVersion,
			Payload: &packetspb.Envelope_ServerEvent{
				ServerEvent: delivery.Event,
			},
		})
		if s.pushNotifier != nil && !s.HasActiveSessions(delivery.UserID) {
			offlineDeliveries = append(offlineDeliveries, delivery)
		}
	}
	if len(offlineDeliveries) > 0 {
		go s.pushNotifier.PushCallDeliveries(offlineDeliveries)
	}
}

// SendCallDirectServerEvents pushes direct, non-sequenced call events to active sessions.
func (s *Server) SendCallDirectServerEvents(deliveries []calls.DirectDelivery) {
	s.sendDirectCallServerEvents(deliveries)
}

// SendChatDirectServerEvents pushes direct, non-sequenced chat events to active sessions.
// Used by the chat HTTP handler to deliver conversation_upserted events after DM creation.
func (s *Server) SendChatDirectServerEvents(deliveries []chat.DirectDelivery) {
	s.sendDirectServerEvents(deliveries)
}

// SendForcePasswordChange pushes a force_password_change event directly to all
// active sessions of the given user. The event carries no sequence number and
// is not persisted to the event log.
func (s *Server) SendForcePasswordChange(userID string) {
	evt := &packetspb.ServerEvent{
		EventType: packetspb.EventType_EVENT_TYPE_FORCE_PASSWORD_CHANGE,
		Payload: &packetspb.ServerEvent_ForcePasswordChange{
			ForcePasswordChange: &packetspb.ForcePasswordChangeEvent{
				UserId: userID,
			},
		},
	}
	s.sendDirectEnvelope([]string{userID}, &packetspb.Envelope{
		ProtocolVersion: protocolVersion,
		Payload:         &packetspb.Envelope_ServerEvent{ServerEvent: evt},
	})
}

// SendTaskStatusChanged pushes a task status transition directly to all active
// websocket sessions. The event is intentionally non-sequenced and not
// persisted in workspace_events.
func (s *Server) SendTaskStatusChanged(
	taskID, publicID, fromStatusID, toStatusID, updatedBy string,
	updatedAt time.Time,
) {
	evt := &packetspb.ServerEvent{
		EventType: packetspb.EventType_EVENT_TYPE_TASK_STATUS_CHANGED,
		Payload: &packetspb.ServerEvent_TaskStatusChanged{
			TaskStatusChanged: &packetspb.TaskStatusChangedEvent{
				TaskId:       taskID,
				PublicId:     publicID,
				FromStatusId: fromStatusID,
				ToStatusId:   toStatusID,
				UpdatedBy:    updatedBy,
				UpdatedAt:    timestamppb.New(updatedAt.UTC()),
			},
		},
	}

	s.sessionMu.RLock()
	userIDs := make([]string, 0, len(s.sessionsByUser))
	for userID := range s.sessionsByUser {
		userIDs = append(userIDs, userID)
	}
	s.sessionMu.RUnlock()

	if len(userIDs) == 0 {
		return
	}
	s.sendDirectEnvelope(userIDs, &packetspb.Envelope{
		ProtocolVersion: protocolVersion,
		Payload:         &packetspb.Envelope_ServerEvent{ServerEvent: evt},
	})
}

func (s *Server) sharedUserIDs(ctx context.Context, userID uuid.UUID) ([]string, error) {
	rows, err := s.db.Pool.Query(ctx, `
		SELECT DISTINCT cm_other.user_id
		  FROM channel_members cm_self
		  JOIN channel_members cm_other
		    ON cm_other.channel_id = cm_self.channel_id
		   AND cm_other.is_archived = false
		 WHERE cm_self.user_id = $1
		   AND cm_self.is_archived = false`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	recipients := make([]string, 0)
	for rows.Next() {
		var recipient uuid.UUID
		if err := rows.Scan(&recipient); err != nil {
			return nil, err
		}
		recipients = append(recipients, recipient.String())
	}
	return recipients, rows.Err()
}

func (s *Server) conversationMemberIDs(ctx context.Context, conversationID, excludeUserID uuid.UUID) ([]string, error) {
	rows, err := s.db.Pool.Query(ctx, `
		SELECT user_id
		  FROM channel_members
		 WHERE channel_id = $1
		   AND is_archived = false
		   AND user_id <> $2`,
		conversationID, excludeUserID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	recipients := make([]string, 0)
	for rows.Next() {
		var recipient uuid.UUID
		if err := rows.Scan(&recipient); err != nil {
			return nil, err
		}
		recipients = append(recipients, recipient.String())
	}
	return recipients, rows.Err()
}

func (s *Server) touchPresenceLease(
	ctx context.Context,
	connectionID, userID, authSessionID uuid.UUID,
	heartbeatCapable bool,
) error {
	if s == nil || s.db == nil || s.db.Pool == nil {
		return nil
	}
	if _, err := s.db.Pool.Exec(ctx, `
		INSERT INTO user_presence (user_id, status, preferred_status, last_active_at, updated_at)
		VALUES ($1, 'offline', 'online', now(), now())
		ON CONFLICT (user_id) DO UPDATE
		    SET last_active_at = now()`,
		userID,
	); err != nil {
		return err
	}
	if _, err := s.db.Pool.Exec(ctx, `
		INSERT INTO ws_presence_leases (
			connection_id,
			user_id,
			auth_session_id,
			heartbeat_capable,
			last_heartbeat_at,
			created_at,
			updated_at
		)
		VALUES ($1, $2, $3, $4, now(), now(), now())
		ON CONFLICT (connection_id) DO UPDATE
		    SET user_id = EXCLUDED.user_id,
		        auth_session_id = EXCLUDED.auth_session_id,
		        heartbeat_capable = EXCLUDED.heartbeat_capable,
		        last_heartbeat_at = now(),
		        updated_at = now()`,
		connectionID, userID, authSessionID, heartbeatCapable,
	); err != nil {
		return err
	}
	return nil
}

func (s *Server) removePresenceLease(ctx context.Context, connectionID uuid.UUID) error {
	if s == nil || s.db == nil || s.db.Pool == nil {
		return nil
	}
	_, err := s.db.Pool.Exec(ctx, `DELETE FROM ws_presence_leases WHERE connection_id = $1`, connectionID)
	return err
}

func (s *Server) setPreferredPresence(ctx context.Context, userID uuid.UUID, status packetspb.PresenceStatus) error {
	if s == nil || s.db == nil || s.db.Pool == nil {
		return nil
	}
	if _, err := s.db.Pool.Exec(ctx, `
		INSERT INTO user_presence (user_id, status, preferred_status, last_active_at, updated_at)
		VALUES ($1, 'offline', $2, now(), now())
		ON CONFLICT (user_id) DO UPDATE
		    SET preferred_status = EXCLUDED.preferred_status,
		        last_active_at = now(),
		        updated_at = now()`,
		userID, preferredPresenceStatusToDB(status),
	); err != nil {
		return err
	}
	return nil
}

func (s *Server) recomputePresence(ctx context.Context, userID uuid.UUID) (presenceSnapshot, bool, error) {
	if s == nil || s.db == nil || s.db.Pool == nil {
		return presenceSnapshot{}, false, nil
	}

	tx, err := s.db.Pool.Begin(ctx)
	if err != nil {
		return presenceSnapshot{}, false, err
	}
	defer func() {
		_ = tx.Rollback(ctx)
	}()

	if _, err := tx.Exec(ctx, `
		INSERT INTO user_presence (user_id, status, preferred_status, last_active_at, updated_at)
		VALUES ($1, 'offline', 'online', now(), now())
		ON CONFLICT (user_id) DO NOTHING`,
		userID,
	); err != nil {
		return presenceSnapshot{}, false, err
	}

	var currentStatus string
	var preferredStatus string
	var lastActiveAt time.Time
	if err := tx.QueryRow(ctx, `
		SELECT status, preferred_status, last_active_at
		  FROM user_presence
		 WHERE user_id = $1
		 FOR UPDATE`,
		userID,
	).Scan(&currentStatus, &preferredStatus, &lastActiveAt); err != nil {
		return presenceSnapshot{}, false, err
	}

	cutoff := time.Now().Add(-s.presenceLeaseTTLValue())
	if _, err := tx.Exec(ctx, `
		DELETE FROM ws_presence_leases
		 WHERE user_id = $1
		   AND heartbeat_capable = true
		   AND last_heartbeat_at < $2`,
		userID, cutoff,
	); err != nil {
		return presenceSnapshot{}, false, err
	}

	var activeLeaseCount int
	if err := tx.QueryRow(ctx, `
		SELECT COUNT(*)
		  FROM ws_presence_leases
		 WHERE user_id = $1`,
		userID,
	).Scan(&activeLeaseCount); err != nil {
		return presenceSnapshot{}, false, err
	}

	nextStatus := "offline"
	if activeLeaseCount > 0 {
		if preferredStatus == "away" {
			nextStatus = "away"
		} else {
			nextStatus = "online"
		}
	}

	if currentStatus != nextStatus {
		if _, err := tx.Exec(ctx, `
			UPDATE user_presence
			   SET status = $2,
			       updated_at = now()
			 WHERE user_id = $1`,
			userID, nextStatus,
		); err != nil {
			return presenceSnapshot{}, false, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return presenceSnapshot{}, false, err
	}

	return presenceSnapshot{
		status:       mapPresenceStatus(nextStatus),
		lastActiveAt: lastActiveAt,
	}, currentStatus != nextStatus, nil
}

func (s *Server) expireStalePresenceLeases(ctx context.Context) error {
	if s == nil || s.db == nil || s.db.Pool == nil {
		return nil
	}

	cutoff := time.Now().Add(-s.presenceLeaseTTLValue())
	rows, err := s.db.Pool.Query(ctx, `
		WITH expired AS (
			DELETE FROM ws_presence_leases
			 WHERE heartbeat_capable = true
			   AND last_heartbeat_at < $1
			 RETURNING user_id
		)
		SELECT DISTINCT user_id
		  FROM expired`,
		cutoff,
	)
	if err != nil {
		return err
	}
	defer rows.Close()

	var userIDs []uuid.UUID
	for rows.Next() {
		var userID uuid.UUID
		if err := rows.Scan(&userID); err != nil {
			return err
		}
		userIDs = append(userIDs, userID)
	}
	if err := rows.Err(); err != nil {
		return err
	}

	for _, userID := range userIDs {
		snapshot, changed, err := s.recomputePresence(ctx, userID)
		if err != nil {
			return err
		}
		if changed {
			s.broadcastPresence(ctx, userID, snapshot)
		}
	}

	return nil
}

func (s *Server) broadcastPresence(ctx context.Context, userID uuid.UUID, snapshot presenceSnapshot) {
	s.broadcastPresenceLocal(ctx, userID, snapshot)
	if s.eventStore == nil {
		return
	}
	if err := s.eventStore.NotifyPresence(ctx, events.PresenceNotification{
		UserID:            userID.String(),
		EffectivePresence: int32(snapshot.status),
		LastActiveAt:      snapshot.lastActiveAt.UTC(),
	}); err != nil {
		s.log.Warn("ws: failed to notify cross-instance presence update", zap.String("user_id", userID.String()), zap.Error(err))
	}
}

// HandlePresenceNotification forwards an update emitted by another backend to
// sessions connected to this process. It deliberately does not notify again.
func (s *Server) HandlePresenceNotification(update events.PresenceNotification) {
	userID, err := uuid.Parse(update.UserID)
	if err != nil {
		s.log.Warn("ws: ignored presence update with invalid user id", zap.String("user_id", update.UserID), zap.Error(err))
		return
	}
	status := packetspb.PresenceStatus(update.EffectivePresence)
	if status != packetspb.PresenceStatus_PRESENCE_STATUS_ONLINE &&
		status != packetspb.PresenceStatus_PRESENCE_STATUS_AWAY &&
		status != packetspb.PresenceStatus_PRESENCE_STATUS_OFFLINE {
		s.log.Warn("ws: ignored presence update with invalid status", zap.Int32("status", update.EffectivePresence))
		return
	}
	s.broadcastPresenceLocal(context.Background(), userID, presenceSnapshot{
		status:       status,
		lastActiveAt: update.LastActiveAt,
	})
}

func (s *Server) broadcastPresenceLocal(ctx context.Context, userID uuid.UUID, snapshot presenceSnapshot) {
	recipients, err := s.sharedUserIDs(ctx, userID)
	if err != nil {
		s.log.Error("ws: sharedUserIDs presence error", zap.Error(err))
		return
	}
	var lastActiveAt *timestamppb.Timestamp
	if !snapshot.lastActiveAt.IsZero() {
		lastActiveAt = timestamppb.New(snapshot.lastActiveAt.UTC())
	}
	env := &packetspb.Envelope{
		ProtocolVersion: protocolVersion,
		Payload: &packetspb.Envelope_PresenceEvent{
			PresenceEvent: &packetspb.PresenceEvent{
				UserId:            userID.String(),
				EffectivePresence: snapshot.status,
				LastActiveAt:      lastActiveAt,
			},
		},
	}
	s.sendDirectEnvelope(recipients, env)
}

func (s *Server) sendDirectMessagePresenceSnapshot(ctx context.Context, userID uuid.UUID, enqueue func(*packetspb.Envelope) bool) {
	if s == nil || s.db == nil || s.db.Pool == nil {
		return
	}
	rows, err := s.db.Pool.Query(ctx, `
		SELECT DISTINCT up.user_id, up.status, up.last_active_at
		  FROM channel_members cm_self
		  JOIN channels c ON c.id = cm_self.channel_id AND c.kind = 'dm'
		  JOIN channel_members cm_other
		    ON cm_other.channel_id = cm_self.channel_id
		   AND cm_other.is_archived = false
		   AND cm_other.user_id <> cm_self.user_id
		  JOIN user_presence up ON up.user_id = cm_other.user_id
		 WHERE cm_self.user_id = $1
		   AND cm_self.is_archived = false`, userID)
	if err != nil {
		s.log.Warn("ws: failed to load DM presence snapshot", zap.String("user_id", userID.String()), zap.Error(err))
		return
	}
	defer rows.Close()

	for rows.Next() {
		var peerID uuid.UUID
		var status string
		var lastActiveAt time.Time
		if err := rows.Scan(&peerID, &status, &lastActiveAt); err != nil {
			s.log.Warn("ws: failed to scan DM presence snapshot", zap.Error(err))
			return
		}
		if !enqueue(presenceEnvelope(peerID, presenceSnapshot{
			status:       mapPresenceStatus(status),
			lastActiveAt: lastActiveAt,
		})) {
			return
		}
	}
	if err := rows.Err(); err != nil {
		s.log.Warn("ws: failed to load DM presence snapshot", zap.String("user_id", userID.String()), zap.Error(err))
	}
}

func presenceEnvelope(userID uuid.UUID, snapshot presenceSnapshot) *packetspb.Envelope {
	var lastActiveAt *timestamppb.Timestamp
	if !snapshot.lastActiveAt.IsZero() {
		lastActiveAt = timestamppb.New(snapshot.lastActiveAt.UTC())
	}
	return &packetspb.Envelope{
		ProtocolVersion: protocolVersion,
		Payload: &packetspb.Envelope_PresenceEvent{
			PresenceEvent: &packetspb.PresenceEvent{
				UserId:            userID.String(),
				EffectivePresence: snapshot.status,
				LastActiveAt:      lastActiveAt,
			},
		},
	}
}

func (s *Server) handleTypingRequest(ctx context.Context, principal auth.Principal, req *packetspb.TypingRequest, badReq func(string), forbidden func(string)) {
	conversationID, err := uuid.Parse(req.GetConversationId())
	if err != nil {
		badReq("typing_request: invalid conversation_id")
		return
	}
	var isMember bool
	if err := s.db.Pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			  FROM channel_members
			 WHERE channel_id = $1
			   AND user_id = $2
			   AND is_archived = false
		)`,
		conversationID, principal.UserID,
	).Scan(&isMember); err != nil {
		badReq("typing_request: membership check failed")
		return
	}
	if !isMember {
		forbidden("not a member of this channel")
		return
	}

	recipients, err := s.conversationMemberIDs(ctx, conversationID, principal.UserID)
	if err != nil {
		badReq("typing_request: member lookup failed")
		return
	}

	env := &packetspb.Envelope{
		ProtocolVersion: protocolVersion,
		Payload: &packetspb.Envelope_TypingEvent{
			TypingEvent: &packetspb.TypingEvent{
				ConversationId:      req.GetConversationId(),
				UserId:              principal.UserID.String(),
				ThreadRootMessageId: req.GetThreadRootMessageId(),
				IsTyping:            req.GetIsTyping(),
			},
		},
	}

	if req.GetIsTyping() {
		expiresAt := time.Now().Add(5 * time.Second)
		env.GetTypingEvent().ExpiresAt = timestamppb.New(expiresAt)
		key := fmt.Sprintf("%s|%s|%s", req.GetConversationId(), req.GetThreadRootMessageId(), principal.UserID.String())
		s.typingMu.Lock()
		s.typingExpiry[key] = expiresAt
		s.typingMu.Unlock()

		go s.expireTyping(key, req.GetConversationId(), req.GetThreadRootMessageId(), principal.UserID, expiresAt)
	} else {
		s.clearTyping(req.GetConversationId(), req.GetThreadRootMessageId(), principal.UserID)
	}

	s.sendDirectEnvelope(recipients, env)
}

func (s *Server) clearTyping(conversationID, threadRootMessageID string, userID uuid.UUID) {
	key := fmt.Sprintf("%s|%s|%s", conversationID, threadRootMessageID, userID.String())
	s.typingMu.Lock()
	delete(s.typingExpiry, key)
	s.typingMu.Unlock()
}

func (s *Server) expireTyping(key string, conversationIDText, threadRootMessageID string, userID uuid.UUID, expiresAt time.Time) {
	timer := time.NewTimer(time.Until(expiresAt))
	defer timer.Stop()
	<-timer.C

	s.typingMu.Lock()
	current, ok := s.typingExpiry[key]
	if !ok || !current.Equal(expiresAt) {
		s.typingMu.Unlock()
		return
	}
	delete(s.typingExpiry, key)
	s.typingMu.Unlock()

	conversationID, err := uuid.Parse(conversationIDText)
	if err != nil {
		return
	}
	recipients, err := s.conversationMemberIDs(context.Background(), conversationID, userID)
	if err != nil {
		return
	}

	env := &packetspb.Envelope{
		ProtocolVersion: protocolVersion,
		Payload: &packetspb.Envelope_TypingEvent{
			TypingEvent: &packetspb.TypingEvent{
				ConversationId:      conversationIDText,
				UserId:              userID.String(),
				ThreadRootMessageId: threadRootMessageID,
				IsTyping:            false,
			},
		},
	}
	s.sendDirectEnvelope(recipients, env)
}

func preferredPresenceStatusToDB(status packetspb.PresenceStatus) string {
	switch status {
	case packetspb.PresenceStatus_PRESENCE_STATUS_ONLINE:
		return "online"
	case packetspb.PresenceStatus_PRESENCE_STATUS_AWAY:
		return "away"
	default:
		return "online"
	}
}

func mapPresenceStatus(raw string) packetspb.PresenceStatus {
	switch raw {
	case "online":
		return packetspb.PresenceStatus_PRESENCE_STATUS_ONLINE
	case "away":
		return packetspb.PresenceStatus_PRESENCE_STATUS_AWAY
	case "offline":
		return packetspb.PresenceStatus_PRESENCE_STATUS_OFFLINE
	default:
		return packetspb.PresenceStatus_PRESENCE_STATUS_UNSPECIFIED
	}
}

func mapWorkspaceRole(raw string) packetspb.WorkspaceRole {
	switch raw {
	case "owner":
		return packetspb.WorkspaceRole_WORKSPACE_ROLE_OWNER
	case "admin":
		return packetspb.WorkspaceRole_WORKSPACE_ROLE_ADMIN
	case "member":
		return packetspb.WorkspaceRole_WORKSPACE_ROLE_MEMBER
	default:
		return packetspb.WorkspaceRole_WORKSPACE_ROLE_UNSPECIFIED
	}
}

// handleDomainPayload dispatches authenticated domain payloads (State 3).
func (s *Server) handleDomainPayload(
	ctx context.Context,
	env *packetspb.Envelope,
	principal auth.Principal,
	presenceConnectionID uuid.UUID,
	presenceLeaseRefreshCapable bool,
	outboundCh chan outboundMsg,
	enqueue func(*packetspb.Envelope) bool,
) {
	reqID := env.GetRequestId()
	traceID := env.GetTraceId()

	badReq := func(msg string) {
		enqueue(s.buildErrorEnvelope(reqID, traceID, packetspb.ErrorCode_ERROR_CODE_BAD_REQUEST, msg, 0))
	}
	forbidden := func(msg string) {
		enqueue(s.buildErrorEnvelope(reqID, traceID, packetspb.ErrorCode_ERROR_CODE_FORBIDDEN, msg, 0))
	}

	switch p := env.GetPayload().(type) {
	case *packetspb.Envelope_BootstrapRequest:
		req := p.BootstrapRequest
		if req == nil || s.bootstrapSvc == nil {
			badReq("bootstrap_request: missing payload")
			return
		}
		resp, err := s.bootstrapSvc.Bootstrap(ctx, principal, req)
		if err != nil {
			switch {
			case errors.Is(err, bootstrap.ErrSessionExpired):
				enqueue(s.buildErrorEnvelope(reqID, traceID, packetspb.ErrorCode_ERROR_CODE_BOOTSTRAP_EXPIRED, "bootstrap session expired", 0))
			case errors.Is(err, bootstrap.ErrInvalidRequest), errors.Is(err, bootstrap.ErrInvalidPageToken), errors.Is(err, bootstrap.ErrSessionMismatch):
				badReq("bootstrap_request: invalid session or page token")
			default:
				s.log.Error("ws: Bootstrap error", zap.Error(err), zap.String("user_id", principal.UserID.String()))
				badReq("bootstrap_request: internal error")
			}
			return
		}
		enqueue(&packetspb.Envelope{
			RequestId:       reqID,
			TraceId:         traceID,
			ProtocolVersion: protocolVersion,
			Payload: &packetspb.Envelope_BootstrapResponse{
				BootstrapResponse: resp,
			},
		})

	case *packetspb.Envelope_SyncSinceRequest:
		req := p.SyncSinceRequest
		if req == nil || s.syncSvc == nil {
			badReq("sync_since_request: missing payload")
			return
		}
		resp, err := s.syncSvc.SyncSince(ctx, principal, req)
		if err != nil {
			s.log.Error("ws: SyncSince error", zap.Error(err), zap.String("user_id", principal.UserID.String()))
			badReq("sync_since_request: internal error")
			return
		}
		enqueue(&packetspb.Envelope{
			RequestId:       reqID,
			TraceId:         traceID,
			ProtocolVersion: protocolVersion,
			Payload: &packetspb.Envelope_SyncSinceResponse{
				SyncSinceResponse: resp,
			},
		})

	case *packetspb.Envelope_AckRequest:
		req := p.AckRequest
		if req == nil || s.syncSvc == nil {
			badReq("ack_request: missing payload")
			return
		}
		resp, err := s.syncSvc.Ack(ctx, principal, req)
		if err != nil {
			badReq("ack_request: invalid last_applied_event_seq")
			return
		}
		enqueue(&packetspb.Envelope{
			RequestId:       reqID,
			TraceId:         traceID,
			ProtocolVersion: protocolVersion,
			Payload: &packetspb.Envelope_AckResponse{
				AckResponse: resp,
			},
		})

	case *packetspb.Envelope_SendMessageRequest:
		req := p.SendMessageRequest
		if req == nil {
			badReq("send_message_request: missing payload")
			return
		}
		channelID, err := uuid.Parse(req.GetConversationId())
		if err != nil {
			badReq("send_message_request: invalid conversation_id")
			return
		}
		var threadRootID uuid.UUID
		if req.GetThreadRootMessageId() != "" {
			if threadRootID, err = uuid.Parse(req.GetThreadRootMessageId()); err != nil {
				badReq("send_message_request: invalid thread_root_message_id")
				return
			}
		}
		var contentMode string
		switch req.GetContentMode() {
		case packetspb.MessageContentMode_MESSAGE_CONTENT_MODE_PLAINTEXT:
			contentMode = chat.MessageContentPlaintext
		case packetspb.MessageContentMode_MESSAGE_CONTENT_MODE_DM_PAIRWISE_SIGNAL_V1:
			contentMode = chat.MessageContentDMPairwiseSignal
		default:
			badReq("send_message_request: unsupported content_mode")
			return
		}
		var senderDeviceID uuid.UUID
		if req.GetSenderDeviceId() != "" {
			if senderDeviceID, err = uuid.Parse(req.GetSenderDeviceId()); err != nil {
				badReq("send_message_request: invalid sender_device_id")
				return
			}
		}
		encryptedPayloads := make([]chat.EncryptedDMRecipientPayload, 0)
		if req.GetEncryptedDmPayload() != nil {
			for _, rawPayload := range req.GetEncryptedDmPayload().GetRecipients() {
				if rawPayload == nil {
					badReq("send_message_request: invalid encrypted_dm_payload")
					return
				}
				recipientDeviceID, err := uuid.Parse(rawPayload.GetRecipientDeviceId())
				if err != nil {
					badReq("send_message_request: invalid recipient_device_id")
					return
				}
				payloadSenderDeviceID, err := uuid.Parse(rawPayload.GetSenderDeviceId())
				if err != nil {
					badReq("send_message_request: invalid payload sender_device_id")
					return
				}
				encryptedPayloads = append(encryptedPayloads, chat.EncryptedDMRecipientPayload{
					RecipientDeviceID: recipientDeviceID,
					SenderDeviceID:    payloadSenderDeviceID,
					Algorithm:         rawPayload.GetAlgorithm(),
					SessionMessage:    append([]byte(nil), rawPayload.GetSessionMessage()...),
					MetadataAAD:       append([]byte(nil), rawPayload.GetMetadataAad()...),
				})
			}
		}
		attachmentIDs := make([]uuid.UUID, 0, len(req.GetAttachmentIds()))
		for _, rawID := range req.GetAttachmentIds() {
			attachmentID, err := uuid.Parse(rawID)
			if err != nil {
				badReq("send_message_request: invalid attachment_ids")
				return
			}
			attachmentIDs = append(attachmentIDs, attachmentID)
		}
		entities := make([]chat.MessageEntity, 0, len(req.GetEntities()))
		for _, rawEntity := range req.GetEntities() {
			if rawEntity == nil {
				badReq("send_message_request: invalid entities")
				return
			}
			targetID, err := uuid.Parse(rawEntity.GetTargetId())
			if err != nil {
				badReq("send_message_request: invalid entities")
				return
			}
			var kind chat.MessageEntityKind
			switch rawEntity.GetKind() {
			case packetspb.MessageEntityKind_MESSAGE_ENTITY_KIND_USER:
				kind = chat.MessageEntityKindUser
			case packetspb.MessageEntityKind_MESSAGE_ENTITY_KIND_TASK:
				kind = chat.MessageEntityKindTask
			case packetspb.MessageEntityKind_MESSAGE_ENTITY_KIND_DOCUMENT:
				kind = chat.MessageEntityKindDocument
			default:
				badReq("send_message_request: invalid entities")
				return
			}
			entities = append(entities, chat.MessageEntity{
				Kind:     kind,
				TargetID: targetID,
				Label:    rawEntity.GetLabel(),
				Href:     rawEntity.GetHref(),
				Start:    rawEntity.GetStart(),
				End:      rawEntity.GetEnd(),
			})
		}

		result, err := s.chatSvc.SendMessage(ctx, chat.SendMessageParams{
			ChannelID:           channelID,
			SenderID:            principal.UserID,
			ClientMsgID:         req.GetClientMsgId(),
			Body:                req.GetBody(),
			Entities:            entities,
			ThreadRootMessageID: threadRootID,
			AttachmentIDs:       attachmentIDs,
			ContentMode:         contentMode,
			SenderDeviceID:      senderDeviceID,
			EncryptedDMPayloads: encryptedPayloads,
		})
		if err != nil {
			if errors.Is(err, chat.ErrNotMember) {
				forbidden("not a member of this channel")
				return
			}
			if errors.Is(err, chat.ErrMessageNotFound) || errors.Is(err, chat.ErrInvalidThread) {
				badReq("send_message_request: invalid thread root message")
				return
			}
			if errors.Is(err, chat.ErrEncryptedMessagesUnsupported) {
				badReq("send_message_request: encrypted dm payload required")
				return
			}
			if errors.Is(err, chat.ErrInvalidEncryptedPayload) {
				badReq("send_message_request: invalid encrypted dm payload")
				return
			}
			if errors.Is(err, chat.ErrAttachmentNotFound) ||
				errors.Is(err, chat.ErrAttachmentNotStaged) ||
				errors.Is(err, chat.ErrAttachmentOwnership) ||
				errors.Is(err, chat.ErrInvalidAttachment) ||
				errors.Is(err, chat.ErrInvalidMessageEntity) ||
				errors.Is(err, chat.ErrEmptyMessage) {
				badReq("send_message_request: invalid attachments or body")
				return
			}
			s.log.Error("ws: SendMessage error", zap.Error(err), zap.String("user_id", principal.UserID.String()))
			badReq("send_message_request: internal error")
			return
		}

		resp := &packetspb.Envelope{
			RequestId:       reqID,
			TraceId:         traceID,
			ProtocolVersion: protocolVersion,
			Payload: &packetspb.Envelope_SendMessageAck{
				SendMessageAck: &packetspb.SendMessageAck{
					ConversationId: req.GetConversationId(),
					MessageId:      result.MessageID.String(),
					ChannelSeq:     result.ChannelSeq,
					CreatedAt:      result.CreatedAt,
					ClientMsgId:    result.ClientMsgID,
					Deduped:        result.Deduped,
				},
			},
		}
		enqueue(resp)
		s.sendDirectServerEvents(result.DirectDeliveries)

	case *packetspb.Envelope_CreateCallRequest:
		req := p.CreateCallRequest
		if req == nil || s.callSvc == nil {
			badReq("create_call_request: missing payload")
			return
		}
		conversationID, err := uuid.Parse(req.GetConversationId())
		if err != nil {
			badReq("create_call_request: invalid conversation_id")
			return
		}
		inviteeIDs := make([]uuid.UUID, 0, len(req.GetInviteeUserIds()))
		for _, raw := range req.GetInviteeUserIds() {
			inviteeID, err := uuid.Parse(raw)
			if err != nil {
				badReq("create_call_request: invalid invitee_user_ids")
				return
			}
			inviteeIDs = append(inviteeIDs, inviteeID)
		}

		result, err := s.callSvc.CreateCall(ctx, calls.CreateCallParams{
			ConversationID: conversationID,
			InitiatorID:    principal.UserID,
			InitiatorRole:  principal.Role,
			InviteeUserIDs: inviteeIDs,
		})
		if err != nil {
			switch {
			case errors.Is(err, calls.ErrNotMember):
				forbidden("not a member of this conversation")
			case errors.Is(err, calls.ErrCallAlreadyActive):
				enqueue(s.buildErrorEnvelope(reqID, traceID, packetspb.ErrorCode_ERROR_CODE_CALL_ALREADY_ACTIVE, "call already active", 0))
			case errors.Is(err, calls.ErrBadRequest):
				badReq("create_call_request: invalid request")
			default:
				s.log.Error("ws: CreateCall error", zap.Error(err), zap.String("user_id", principal.UserID.String()))
				badReq("create_call_request: internal error")
			}
			return
		}

		enqueue(&packetspb.Envelope{
			RequestId:       reqID,
			TraceId:         traceID,
			ProtocolVersion: protocolVersion,
			Payload: &packetspb.Envelope_CreateCallResponse{
				CreateCallResponse: &packetspb.CreateCallResponse{
					CallId:         result.CallID.String(),
					ConversationId: result.ConversationID.String(),
					Status:         result.Status,
				},
			},
		})
		s.sendDirectCallServerEvents(result.DirectDeliveries)

	case *packetspb.Envelope_InviteCallMembersRequest:
		req := p.InviteCallMembersRequest
		if req == nil || s.callSvc == nil {
			badReq("invite_call_members_request: missing payload")
			return
		}
		conversationID, err := uuid.Parse(req.GetConversationId())
		if err != nil {
			badReq("invite_call_members_request: invalid conversation_id")
			return
		}
		inviteeIDs := make([]uuid.UUID, 0, len(req.GetInviteeUserIds()))
		for _, raw := range req.GetInviteeUserIds() {
			inviteeID, err := uuid.Parse(raw)
			if err != nil {
				badReq("invite_call_members_request: invalid invitee_user_ids")
				return
			}
			inviteeIDs = append(inviteeIDs, inviteeID)
		}

		result, err := s.callSvc.InviteCallMembers(ctx, calls.InviteCallMembersParams{
			ConversationID: conversationID,
			ActorID:        principal.UserID,
			ActorRole:      principal.Role,
			InviteeUserIDs: inviteeIDs,
		})
		if err != nil {
			switch {
			case errors.Is(err, calls.ErrNotMember):
				forbidden("not a member of this conversation")
			case errors.Is(err, calls.ErrForbiddenAction):
				forbidden("forbidden call action")
			case errors.Is(err, calls.ErrCallNotActive):
				enqueue(s.buildErrorEnvelope(reqID, traceID, packetspb.ErrorCode_ERROR_CODE_CALL_NOT_ACTIVE, "call is not active", 0))
			case errors.Is(err, calls.ErrBadRequest):
				badReq("invite_call_members_request: invalid request")
			default:
				s.log.Error("ws: InviteCallMembers error", zap.Error(err), zap.String("user_id", principal.UserID.String()))
				badReq("invite_call_members_request: internal error")
			}
			return
		}

		invitedUserIDs := make([]string, 0, len(result.InvitedUserIDs))
		for _, id := range result.InvitedUserIDs {
			invitedUserIDs = append(invitedUserIDs, id.String())
		}
		skippedUserIDs := make([]string, 0, len(result.SkippedUserIDs))
		for _, id := range result.SkippedUserIDs {
			skippedUserIDs = append(skippedUserIDs, id.String())
		}

		enqueue(&packetspb.Envelope{
			RequestId:       reqID,
			TraceId:         traceID,
			ProtocolVersion: protocolVersion,
			Payload: &packetspb.Envelope_InviteCallMembersResponse{
				InviteCallMembersResponse: &packetspb.InviteCallMembersResponse{
					CallId:         result.CallID.String(),
					ConversationId: result.ConversationID.String(),
					InvitedUserIds: invitedUserIDs,
					SkippedUserIds: skippedUserIDs,
				},
			},
		})
		s.sendDirectCallServerEvents(result.DirectDeliveries)

	case *packetspb.Envelope_ListConversationMembersRequest:
		req := p.ListConversationMembersRequest
		if req == nil || s.chatSvc == nil {
			badReq("list_conversation_members_request: missing payload")
			return
		}
		conversationID, err := uuid.Parse(req.GetConversationId())
		if err != nil {
			badReq("list_conversation_members_request: invalid conversation_id")
			return
		}

		members, err := s.chatSvc.ListConversationMembers(ctx, principal.UserID, conversationID)
		if err != nil {
			if errors.Is(err, chat.ErrNotMember) {
				forbidden("not a member of this conversation")
				return
			}
			s.log.Error("ws: ListConversationMembers error", zap.Error(err), zap.String("user_id", principal.UserID.String()))
			badReq("list_conversation_members_request: internal error")
			return
		}

		respMembers := make([]*packetspb.ConversationMemberSummary, 0, len(members))
		for _, member := range members {
			respMembers = append(respMembers, conversationMemberSummaryFromChat(member))
		}

		enqueue(&packetspb.Envelope{
			RequestId:       reqID,
			TraceId:         traceID,
			ProtocolVersion: protocolVersion,
			Payload: &packetspb.Envelope_ListConversationMembersResponse{
				ListConversationMembersResponse: &packetspb.ListConversationMembersResponse{
					Members: respMembers,
				},
			},
		})

	case *packetspb.Envelope_ListActiveCallMembersRequest:
		req := p.ListActiveCallMembersRequest
		if req == nil || s.chatSvc == nil {
			badReq("list_active_call_members_request: missing payload")
			return
		}
		conversationID, err := uuid.Parse(req.GetConversationId())
		if err != nil {
			badReq("list_active_call_members_request: invalid conversation_id")
			return
		}

		members, err := s.chatSvc.ListActiveCallMembers(ctx, principal.UserID, conversationID)
		if err != nil {
			if errors.Is(err, chat.ErrNotMember) {
				forbidden("not a member of this conversation")
				return
			}
			s.log.Error("ws: ListActiveCallMembers error", zap.Error(err), zap.String("user_id", principal.UserID.String()))
			badReq("list_active_call_members_request: internal error")
			return
		}

		respMembers := make([]*packetspb.ConversationMemberSummary, 0, len(members))
		for _, member := range members {
			respMembers = append(respMembers, conversationMemberSummaryFromChat(member))
		}

		enqueue(&packetspb.Envelope{
			RequestId:       reqID,
			TraceId:         traceID,
			ProtocolVersion: protocolVersion,
			Payload: &packetspb.Envelope_ListActiveCallMembersResponse{
				ListActiveCallMembersResponse: &packetspb.ListActiveCallMembersResponse{
					Members: respMembers,
				},
			},
		})

	case *packetspb.Envelope_JoinCallTokenRequest:
		req := p.JoinCallTokenRequest
		if req == nil || s.callSvc == nil {
			badReq("join_call_token_request: missing payload")
			return
		}
		conversationID, err := uuid.Parse(req.GetConversationId())
		if err != nil {
			badReq("join_call_token_request: invalid conversation_id")
			return
		}

		result, err := s.callSvc.JoinCallToken(ctx, calls.JoinCallTokenParams{
			ConversationID: conversationID,
			UserID:         principal.UserID,
		})
		if err != nil {
			switch {
			case errors.Is(err, calls.ErrNotMember):
				forbidden("not a member of this conversation")
			case errors.Is(err, calls.ErrCallNotActive):
				badReq("join_call_token_request: call is not active")
			case errors.Is(err, calls.ErrBadRequest):
				badReq("join_call_token_request: invalid request")
			default:
				s.log.Error("ws: JoinCallToken error", zap.Error(err), zap.String("user_id", principal.UserID.String()))
				badReq("join_call_token_request: internal error")
			}
			return
		}

		enqueue(&packetspb.Envelope{
			RequestId:       reqID,
			TraceId:         traceID,
			ProtocolVersion: protocolVersion,
			Payload: &packetspb.Envelope_JoinCallTokenResponse{
				JoinCallTokenResponse: &packetspb.JoinCallTokenResponse{
					LivekitUrl:   result.LiveKitURL,
					LivekitToken: result.LiveKitToken,
					LivekitRoom:  result.LiveKitRoom,
					CallId:       result.CallID.String(),
					RaisedHands:  result.RaisedHands,
				},
			},
		})

	case *packetspb.Envelope_SetCallHandRaisedRequest:
		req := p.SetCallHandRaisedRequest
		if req == nil || s.callSvc == nil {
			badReq("set_call_hand_raised_request: missing payload")
			return
		}
		callID, err := uuid.Parse(req.GetCallId())
		if err != nil {
			badReq("set_call_hand_raised_request: invalid call_id")
			return
		}
		result, err := s.callSvc.SetHandRaised(ctx, calls.SetHandRaisedParams{
			CallID:  callID,
			ActorID: principal.UserID,
			Raised:  req.GetRaised(),
		})
		if err != nil {
			switch {
			case errors.Is(err, calls.ErrCallNotActive):
				enqueue(s.buildErrorEnvelope(reqID, traceID, packetspb.ErrorCode_ERROR_CODE_CALL_NOT_ACTIVE, "call is not active", 0))
			case errors.Is(err, calls.ErrForbiddenAction), errors.Is(err, calls.ErrNotMember):
				forbidden("not an active participant in this call")
			case errors.Is(err, calls.ErrBadRequest):
				badReq("set_call_hand_raised_request: invalid request")
			default:
				s.log.Error("ws: SetCallHandRaised error", zap.Error(err), zap.String("user_id", principal.UserID.String()))
				badReq("set_call_hand_raised_request: internal error")
			}
			return
		}
		enqueue(&packetspb.Envelope{
			RequestId:       reqID,
			TraceId:         traceID,
			ProtocolVersion: protocolVersion,
			Payload: &packetspb.Envelope_SetCallHandRaisedResponse{
				SetCallHandRaisedResponse: &packetspb.SetCallHandRaisedResponse{
					CallId:         result.CallID.String(),
					ConversationId: result.ConversationID.String(),
					RaisedHands:    result.RaisedHands,
				},
			},
		})

	case *packetspb.Envelope_AcceptCallInviteRequest:
		req := p.AcceptCallInviteRequest
		if req == nil || s.callSvc == nil {
			badReq("accept_call_invite_request: missing payload")
			return
		}
		inviteID, err := uuid.Parse(req.GetInviteId())
		if err != nil {
			badReq("accept_call_invite_request: invalid invite_id")
			return
		}

		result, err := s.callSvc.AcceptInvite(ctx, calls.InviteActionParams{
			InviteID:           inviteID,
			ActorID:            principal.UserID,
			ActorRole:          principal.Role,
			LeaveExistingCalls: req.GetLeaveExistingCalls(),
		})
		if err != nil {
			switch {
			case errors.Is(err, calls.ErrInviteNotActive):
				enqueue(s.buildErrorEnvelope(reqID, traceID, packetspb.ErrorCode_ERROR_CODE_INVITE_NOT_ACTIVE, "invite is not active", 0))
			case errors.Is(err, calls.ErrForbiddenAction):
				forbidden("forbidden invite action")
			case errors.Is(err, calls.ErrBadRequest), errors.Is(err, calls.ErrInviteNotFound):
				badReq("accept_call_invite_request: invalid invite")
			default:
				s.log.Error("ws: AcceptInvite error", zap.Error(err), zap.String("user_id", principal.UserID.String()))
				badReq("accept_call_invite_request: internal error")
			}
			return
		}

		enqueue(&packetspb.Envelope{
			RequestId:       reqID,
			TraceId:         traceID,
			ProtocolVersion: protocolVersion,
			Payload: &packetspb.Envelope_CallInviteActionAck{
				CallInviteActionAck: &packetspb.CallInviteActionAck{
					Ok:             true,
					InviteId:       result.InviteID.String(),
					ResultingState: result.ResultingState,
					Applied:        result.Applied,
				},
			},
		})
		s.sendDirectCallServerEvents(result.DirectDeliveries)

	case *packetspb.Envelope_RejectCallInviteRequest:
		req := p.RejectCallInviteRequest
		if req == nil || s.callSvc == nil {
			badReq("reject_call_invite_request: missing payload")
			return
		}
		inviteID, err := uuid.Parse(req.GetInviteId())
		if err != nil {
			badReq("reject_call_invite_request: invalid invite_id")
			return
		}

		result, err := s.callSvc.RejectInvite(ctx, calls.InviteActionParams{
			InviteID:  inviteID,
			ActorID:   principal.UserID,
			ActorRole: principal.Role,
		})
		if err != nil {
			switch {
			case errors.Is(err, calls.ErrInviteNotActive):
				enqueue(s.buildErrorEnvelope(reqID, traceID, packetspb.ErrorCode_ERROR_CODE_INVITE_NOT_ACTIVE, "invite is not active", 0))
			case errors.Is(err, calls.ErrForbiddenAction):
				forbidden("forbidden invite action")
			case errors.Is(err, calls.ErrBadRequest), errors.Is(err, calls.ErrInviteNotFound):
				badReq("reject_call_invite_request: invalid invite")
			default:
				s.log.Error("ws: RejectInvite error", zap.Error(err), zap.String("user_id", principal.UserID.String()))
				badReq("reject_call_invite_request: internal error")
			}
			return
		}

		enqueue(&packetspb.Envelope{
			RequestId:       reqID,
			TraceId:         traceID,
			ProtocolVersion: protocolVersion,
			Payload: &packetspb.Envelope_CallInviteActionAck{
				CallInviteActionAck: &packetspb.CallInviteActionAck{
					Ok:             true,
					InviteId:       result.InviteID.String(),
					ResultingState: result.ResultingState,
					Applied:        result.Applied,
				},
			},
		})
		s.sendDirectCallServerEvents(result.DirectDeliveries)

	case *packetspb.Envelope_CancelCallInviteRequest:
		req := p.CancelCallInviteRequest
		if req == nil || s.callSvc == nil {
			badReq("cancel_call_invite_request: missing payload")
			return
		}
		inviteID, err := uuid.Parse(req.GetInviteId())
		if err != nil {
			badReq("cancel_call_invite_request: invalid invite_id")
			return
		}

		result, err := s.callSvc.CancelInvite(ctx, calls.InviteActionParams{
			InviteID:  inviteID,
			ActorID:   principal.UserID,
			ActorRole: principal.Role,
		})
		if err != nil {
			switch {
			case errors.Is(err, calls.ErrForbiddenAction):
				forbidden("forbidden invite action")
			case errors.Is(err, calls.ErrBadRequest), errors.Is(err, calls.ErrInviteNotFound):
				badReq("cancel_call_invite_request: invalid invite")
			default:
				s.log.Error("ws: CancelInvite error", zap.Error(err), zap.String("user_id", principal.UserID.String()))
				badReq("cancel_call_invite_request: internal error")
			}
			return
		}

		enqueue(&packetspb.Envelope{
			RequestId:       reqID,
			TraceId:         traceID,
			ProtocolVersion: protocolVersion,
			Payload: &packetspb.Envelope_CallInviteActionAck{
				CallInviteActionAck: &packetspb.CallInviteActionAck{
					Ok:             true,
					InviteId:       result.InviteID.String(),
					ResultingState: result.ResultingState,
					Applied:        result.Applied,
				},
			},
		})
		s.sendDirectCallServerEvents(result.DirectDeliveries)

	case *packetspb.Envelope_UpdateReadCursorRequest:
		req := p.UpdateReadCursorRequest
		if req == nil {
			badReq("update_read_cursor_request: missing payload")
			return
		}
		channelID, err := uuid.Parse(req.GetConversationId())
		if err != nil {
			badReq("update_read_cursor_request: invalid conversation_id")
			return
		}

		result, err := s.chatSvc.UpdateReadCursor(ctx, chat.UpdateReadCursorParams{
			ChannelID:   channelID,
			UserID:      principal.UserID,
			LastReadSeq: req.GetLastReadSeq(),
		})
		if err != nil {
			if errors.Is(err, chat.ErrNotMember) {
				forbidden("not a member of this channel")
				return
			}
			s.log.Error("ws: UpdateReadCursor error", zap.Error(err))
			badReq("update_read_cursor_request: internal error")
			return
		}

		enqueue(&packetspb.Envelope{
			RequestId:       reqID,
			TraceId:         traceID,
			ProtocolVersion: protocolVersion,
			Payload: &packetspb.Envelope_ReadCursorAck{
				ReadCursorAck: &packetspb.ReadCursorAck{
					ConversationId: result.ChannelID.String(),
					LastReadSeq:    result.LastReadSeq,
				},
			},
		})
		s.sendDirectServerEvents(result.DirectDeliveries)

	case *packetspb.Envelope_SetPresenceRequest:
		req := p.SetPresenceRequest
		if req == nil {
			badReq("set_presence_request: missing payload")
			return
		}
		if req.GetDesiredPresence() != packetspb.PresenceStatus_PRESENCE_STATUS_ONLINE &&
			req.GetDesiredPresence() != packetspb.PresenceStatus_PRESENCE_STATUS_AWAY {
			badReq("set_presence_request: invalid desired_presence")
			return
		}
		if err := s.setPreferredPresence(ctx, principal.UserID, req.GetDesiredPresence()); err != nil {
			s.log.Error("ws: SetPresence error", zap.Error(err))
			badReq("set_presence_request: internal error")
			return
		}
		snapshot, changed, err := s.recomputePresence(ctx, principal.UserID)
		if err != nil {
			s.log.Error("ws: SetPresence recompute error", zap.Error(err))
			badReq("set_presence_request: internal error")
			return
		}
		if changed {
			s.broadcastPresence(ctx, principal.UserID, snapshot)
		}

	case *packetspb.Envelope_PresenceHeartbeatRequest:
		req := p.PresenceHeartbeatRequest
		if req == nil {
			badReq("presence_heartbeat_request: missing payload")
			return
		}
		if err := s.touchPresenceLease(ctx, presenceConnectionID, principal.UserID, principal.SessionID, presenceLeaseRefreshCapable); err != nil {
			s.log.Error("ws: PresenceHeartbeat error", zap.Error(err))
			badReq("presence_heartbeat_request: internal error")
			return
		}
		snapshot, changed, err := s.recomputePresence(ctx, principal.UserID)
		if err != nil {
			s.log.Error("ws: PresenceHeartbeat recompute error", zap.Error(err))
			badReq("presence_heartbeat_request: internal error")
			return
		}
		if changed {
			s.broadcastPresence(ctx, principal.UserID, snapshot)
		}

	case *packetspb.Envelope_TransportHeartbeatRequest:
		if p.TransportHeartbeatRequest == nil {
			badReq("transport_heartbeat_request: missing payload")
			return
		}
		// A correlated acknowledgement proves that the client and server can
		// exchange data in both directions, so it is also the authoritative
		// refresh for this connection's presence lease.
		if err := s.touchPresenceLease(ctx, presenceConnectionID, principal.UserID, principal.SessionID, presenceLeaseRefreshCapable); err != nil {
			s.log.Error("ws: TransportHeartbeat presence refresh error", zap.Error(err))
			badReq("transport_heartbeat_request: internal error")
			return
		}
		snapshot, changed, err := s.recomputePresence(ctx, principal.UserID)
		if err != nil {
			s.log.Error("ws: TransportHeartbeat presence recompute error", zap.Error(err))
			badReq("transport_heartbeat_request: internal error")
			return
		}
		if changed {
			s.broadcastPresence(ctx, principal.UserID, snapshot)
		}
		enqueue(&packetspb.Envelope{
			RequestId:       reqID,
			TraceId:         traceID,
			ProtocolVersion: protocolVersion,
			Payload: &packetspb.Envelope_TransportHeartbeatAck{
				TransportHeartbeatAck: &packetspb.TransportHeartbeatAck{},
			},
		})
		s.sendDirectMessagePresenceSnapshot(ctx, principal.UserID, enqueue)

	case *packetspb.Envelope_SetClientWindowActivityRequest:
		req := p.SetClientWindowActivityRequest
		if req == nil {
			badReq("set_client_window_activity_request: missing payload")
			return
		}
		s.setSessionWindowActive(principal.UserID.String(), outboundCh, req.GetIsActive())

	case *packetspb.Envelope_TypingRequest:
		req := p.TypingRequest
		if req == nil {
			badReq("typing_request: missing payload")
			return
		}
		s.handleTypingRequest(ctx, principal, req, badReq, forbidden)

	case *packetspb.Envelope_AddReactionRequest:
		req := p.AddReactionRequest
		if req == nil {
			badReq("add_reaction_request: missing payload")
			return
		}
		channelID, err := uuid.Parse(req.GetConversationId())
		if err != nil {
			badReq("add_reaction_request: invalid conversation_id")
			return
		}
		msgID, err := uuid.Parse(req.GetMessageId())
		if err != nil {
			badReq("add_reaction_request: invalid message_id")
			return
		}

		result, err := s.chatSvc.AddReaction(ctx, chat.ReactionParams{
			ChannelID:  channelID,
			MessageID:  msgID,
			UserID:     principal.UserID,
			Emoji:      req.GetEmoji(),
			ClientOpID: req.GetClientOpId(),
		})
		if err != nil {
			if errors.Is(err, chat.ErrNotMember) {
				forbidden("not a member of this channel")
				return
			}
			if errors.Is(err, chat.ErrMessageNotFound) {
				badReq("add_reaction_request: message not found")
				return
			}
			if errors.Is(err, chat.ErrEncryptedMessageUnsupported) {
				badReq("add_reaction_request: encrypted message reactions are not available")
				return
			}
			s.log.Error("ws: AddReaction error", zap.Error(err))
			badReq("add_reaction_request: internal error")
			return
		}

		enqueue(&packetspb.Envelope{
			RequestId:       reqID,
			TraceId:         traceID,
			ProtocolVersion: protocolVersion,
			Payload: &packetspb.Envelope_ReactionAck{
				ReactionAck: &packetspb.ReactionAck{
					Ok:         result.OK,
					MessageId:  result.MessageID.String(),
					Emoji:      result.Emoji,
					ClientOpId: result.ClientOpID,
					Applied:    result.Applied,
				},
			},
		})

	case *packetspb.Envelope_RemoveReactionRequest:
		req := p.RemoveReactionRequest
		if req == nil {
			badReq("remove_reaction_request: missing payload")
			return
		}
		channelID, err := uuid.Parse(req.GetConversationId())
		if err != nil {
			badReq("remove_reaction_request: invalid conversation_id")
			return
		}
		msgID, err := uuid.Parse(req.GetMessageId())
		if err != nil {
			badReq("remove_reaction_request: invalid message_id")
			return
		}

		result, err := s.chatSvc.RemoveReaction(ctx, chat.ReactionParams{
			ChannelID:  channelID,
			MessageID:  msgID,
			UserID:     principal.UserID,
			Emoji:      req.GetEmoji(),
			ClientOpID: req.GetClientOpId(),
		})
		if err != nil {
			if errors.Is(err, chat.ErrNotMember) {
				forbidden("not a member of this channel")
				return
			}
			if errors.Is(err, chat.ErrMessageNotFound) {
				badReq("remove_reaction_request: message not found")
				return
			}
			if errors.Is(err, chat.ErrEncryptedMessageUnsupported) {
				badReq("remove_reaction_request: encrypted message reactions are not available")
				return
			}
			s.log.Error("ws: RemoveReaction error", zap.Error(err))
			badReq("remove_reaction_request: internal error")
			return
		}

		enqueue(&packetspb.Envelope{
			RequestId:       reqID,
			TraceId:         traceID,
			ProtocolVersion: protocolVersion,
			Payload: &packetspb.Envelope_ReactionAck{
				ReactionAck: &packetspb.ReactionAck{
					Ok:         result.OK,
					MessageId:  result.MessageID.String(),
					Emoji:      result.Emoji,
					ClientOpId: result.ClientOpID,
					Applied:    result.Applied,
				},
			},
		})

	case *packetspb.Envelope_SubscribeThreadRequest:
		req := p.SubscribeThreadRequest
		if req == nil {
			badReq("subscribe_thread_request: missing payload")
			return
		}
		channelID, err := uuid.Parse(req.GetConversationId())
		if err != nil {
			badReq("subscribe_thread_request: invalid conversation_id")
			return
		}
		threadRootID, err := uuid.Parse(req.GetThreadRootMessageId())
		if err != nil {
			badReq("subscribe_thread_request: invalid thread_root_message_id")
			return
		}

		result, err := s.chatSvc.SubscribeThread(ctx, chat.SubscribeThreadParams{
			ChannelID:           channelID,
			ThreadRootMessageID: threadRootID,
			RequesterID:         principal.UserID,
			LastThreadSeq:       req.GetLastThreadSeq(),
		})
		if err != nil {
			if errors.Is(err, chat.ErrNotMember) {
				forbidden("not a member of this channel")
				return
			}
			if errors.Is(err, chat.ErrMessageNotFound) || errors.Is(err, chat.ErrInvalidThread) {
				badReq("subscribe_thread_request: invalid thread root message")
				return
			}
			s.log.Error("ws: SubscribeThread error", zap.Error(err))
			badReq("subscribe_thread_request: internal error")
			return
		}

		enqueue(&packetspb.Envelope{
			RequestId:       reqID,
			TraceId:         traceID,
			ProtocolVersion: protocolVersion,
			Payload: &packetspb.Envelope_SubscribeThreadResponse{
				SubscribeThreadResponse: &packetspb.SubscribeThreadResponse{
					ConversationId:      req.GetConversationId(),
					ThreadRootMessageId: req.GetThreadRootMessageId(),
					CurrentThreadSeq:    result.CurrentThreadSeq,
					Replay:              result.Replay,
					ReplyCount:          result.ReplyCount,
				},
			},
		})
		s.sendDirectServerEvents(result.DirectDeliveries)

	case *packetspb.Envelope_SetNotificationLevelRequest:
		req := p.SetNotificationLevelRequest
		if req == nil {
			badReq("set_notification_level_request: missing payload")
			return
		}
		channelID, err := uuid.Parse(req.GetConversationId())
		if err != nil {
			badReq("set_notification_level_request: invalid conversation_id")
			return
		}

		result, err := s.chatSvc.SetNotificationLevel(ctx, chat.SetNotificationLevelParams{
			ChannelID: channelID,
			UserID:    principal.UserID,
			Level:     req.GetLevel(),
		})
		if err != nil {
			if errors.Is(err, chat.ErrNotMember) {
				forbidden("not a member of this channel")
				return
			}
			if errors.Is(err, chat.ErrInvalidNotificationLevel) {
				badReq("set_notification_level_request: level must be 0, 1, or 2")
				return
			}
			s.log.Error("ws: SetNotificationLevel error", zap.Error(err))
			badReq("set_notification_level_request: internal error")
			return
		}

		enqueue(&packetspb.Envelope{
			RequestId:       reqID,
			TraceId:         traceID,
			ProtocolVersion: protocolVersion,
			Payload: &packetspb.Envelope_SetNotificationLevelResponse{
				SetNotificationLevelResponse: &packetspb.SetNotificationLevelResponse{
					Level: result.Level,
				},
			},
		})
		s.sendDirectServerEvents(result.DirectDeliveries)

	case *packetspb.Envelope_TaskDescriptionCollabSubscribeRequest:
		req := p.TaskDescriptionCollabSubscribeRequest
		if req == nil || s.tasksSvc == nil {
			badReq("task_description_collab_subscribe_request: missing payload")
			return
		}
		taskID, err := uuid.Parse(req.GetTaskId())
		if err != nil {
			badReq("task_description_collab_subscribe_request: invalid task_id")
			return
		}
		description, err := s.tasksSvc.GetTaskDescription(ctx, taskID)
		if err != nil {
			if errors.Is(err, tasks.ErrNotFound) {
				forbidden("task not found")
				return
			}
			s.log.Error("ws: TaskDescriptionCollabSubscribe error", zap.Error(err), zap.String("user_id", principal.UserID.String()))
			badReq("task_description_collab_subscribe_request: internal error")
			return
		}
		persistedMarkdown := ""
		if description != nil {
			persistedMarkdown = *description
		}
		subscribeResp := s.taskCollabSubscribeResponse(taskID.String(), outboundCh, persistedMarkdown)
		s.log.Info("ws task collab subscribe",
			zap.String("task_id", taskID.String()),
			zap.String("user_id", principal.UserID.String()),
			zap.String("session_id", principal.SessionID.String()),
			zap.String("persisted_sig", markdownSignatureForLog(persistedMarkdown)),
			zap.Int32("subscribers", subscribeResp.GetSubscriberCount()),
			zap.Int("room_snapshot_bytes", len(subscribeResp.GetRoomSnapshot())),
		)
		enqueue(&packetspb.Envelope{
			RequestId:       reqID,
			TraceId:         traceID,
			ProtocolVersion: protocolVersion,
			Payload: &packetspb.Envelope_TaskDescriptionCollabSubscribeResponse{
				TaskDescriptionCollabSubscribeResponse: subscribeResp,
			},
		})

	case *packetspb.Envelope_TaskDescriptionCollabUnsubscribeRequest:
		req := p.TaskDescriptionCollabUnsubscribeRequest
		if req == nil {
			badReq("task_description_collab_unsubscribe_request: missing payload")
			return
		}
		taskID, err := uuid.Parse(req.GetTaskId())
		if err != nil {
			badReq("task_description_collab_unsubscribe_request: invalid task_id")
			return
		}
		s.leaveTaskCollabRoom(taskID.String(), outboundCh)
		s.log.Info("ws task collab unsubscribe",
			zap.String("task_id", taskID.String()),
			zap.String("user_id", principal.UserID.String()),
			zap.String("session_id", principal.SessionID.String()),
			zap.Int("subscribers", s.taskCollabSubscriberCount(taskID.String())),
		)

	case *packetspb.Envelope_TaskDescriptionCollabMessage:
		req := p.TaskDescriptionCollabMessage
		if req == nil {
			badReq("task_description_collab_message: missing payload")
			return
		}
		taskID, err := uuid.Parse(req.GetTaskId())
		if err != nil {
			badReq("task_description_collab_message: invalid task_id")
			return
		}
		if req.GetKind() != packetspb.TaskDescriptionCollabMessageKind_TASK_DESCRIPTION_COLLAB_MESSAGE_KIND_SYNC &&
			req.GetKind() != packetspb.TaskDescriptionCollabMessageKind_TASK_DESCRIPTION_COLLAB_MESSAGE_KIND_AWARENESS {
			badReq("task_description_collab_message: invalid kind")
			return
		}
		if req.GetKind() == packetspb.TaskDescriptionCollabMessageKind_TASK_DESCRIPTION_COLLAB_MESSAGE_KIND_SYNC {
			frameType, framePayload, framed := decodeTaskCollabSyncFrame(req.GetPayload())
			if framed && !isKnownTaskCollabSyncFrameType(frameType) {
				badReq("task_description_collab_message: invalid sync frame")
				return
			}
			if framed && frameType == taskCollabSyncFrameTypeFullState {
				taskIDText := taskID.String()
				if !s.setTaskCollabRoomSnapshot(taskIDText, outboundCh, framePayload) {
					forbidden("not subscribed to task")
					return
				}
				// FULL_STATE frames update the server's late-join snapshot cache only.
				// Active peers converge via the regular incremental UPDATE frame that
				// is sent for the same local document change.
				s.log.Info("ws task collab snapshot cache",
					zap.String("task_id", taskIDText),
					zap.String("user_id", principal.UserID.String()),
					zap.String("session_id", principal.SessionID.String()),
					zap.Int("snapshot_bytes", len(framePayload)),
				)
				return
			}
		}
		taskIDText := taskID.String()
		if !s.isTaskCollabSubscribed(taskIDText, outboundCh) {
			forbidden("not subscribed to task")
			return
		}
		outEnv := &packetspb.Envelope{
			ProtocolVersion: protocolVersion,
			Payload: &packetspb.Envelope_TaskDescriptionCollabMessage{
				TaskDescriptionCollabMessage: &packetspb.TaskDescriptionCollabMessage{
					TaskId:  taskIDText,
					Kind:    req.GetKind(),
					Payload: req.GetPayload(),
				},
			},
		}
		recipients := s.taskCollabRecipients(taskIDText, outboundCh)
		s.log.Info("ws task collab relay",
			zap.String("task_id", taskIDText),
			zap.String("user_id", principal.UserID.String()),
			zap.String("session_id", principal.SessionID.String()),
			zap.String("kind", req.GetKind().String()),
			zap.Int("payload_bytes", len(req.GetPayload())),
			zap.Int("recipients", len(recipients)),
		)
		for _, recipient := range recipients {
			select {
			case recipient <- outboundMsg{env: outEnv}:
			default:
			}
		}

	case *packetspb.Envelope_DocumentContentCollabSubscribeRequest:
		req := p.DocumentContentCollabSubscribeRequest
		if req == nil || s.documentsSvc == nil {
			badReq("document_content_collab_subscribe_request: missing payload")
			return
		}
		documentID, err := uuid.Parse(req.GetDocumentId())
		if err != nil {
			badReq("document_content_collab_subscribe_request: invalid document_id")
			return
		}
		content, err := s.documentsSvc.GetDocumentContent(ctx, documentID, principal.UserID)
		if err != nil {
			if errors.Is(err, documents.ErrNotFound) || errors.Is(err, documents.ErrForbidden) {
				forbidden("document not found")
				return
			}
			s.log.Error("ws: DocumentContentCollabSubscribe error", zap.Error(err), zap.String("user_id", principal.UserID.String()))
			badReq("document_content_collab_subscribe_request: internal error")
			return
		}
		persistedMarkdown := ""
		if content != nil {
			persistedMarkdown = *content
		}
		subscribeResp := s.documentCollabSubscribeResponse(documentID.String(), outboundCh, persistedMarkdown)
		s.log.Info("ws document collab subscribe",
			zap.String("document_id", documentID.String()),
			zap.String("user_id", principal.UserID.String()),
			zap.String("session_id", principal.SessionID.String()),
			zap.String("persisted_sig", markdownSignatureForLog(persistedMarkdown)),
			zap.Int32("subscribers", subscribeResp.GetSubscriberCount()),
			zap.Int("room_snapshot_bytes", len(subscribeResp.GetRoomSnapshot())),
		)
		enqueue(&packetspb.Envelope{
			RequestId:       reqID,
			TraceId:         traceID,
			ProtocolVersion: protocolVersion,
			Payload: &packetspb.Envelope_DocumentContentCollabSubscribeResponse{
				DocumentContentCollabSubscribeResponse: subscribeResp,
			},
		})

	case *packetspb.Envelope_DocumentContentCollabUnsubscribeRequest:
		req := p.DocumentContentCollabUnsubscribeRequest
		if req == nil {
			badReq("document_content_collab_unsubscribe_request: missing payload")
			return
		}
		documentID, err := uuid.Parse(req.GetDocumentId())
		if err != nil {
			badReq("document_content_collab_unsubscribe_request: invalid document_id")
			return
		}
		s.leaveCollabRoom(collabEntityDocument, documentID.String(), outboundCh)
		s.log.Info("ws document collab unsubscribe",
			zap.String("document_id", documentID.String()),
			zap.String("user_id", principal.UserID.String()),
			zap.String("session_id", principal.SessionID.String()),
			zap.Int("subscribers", s.documentCollabSubscriberCount(documentID.String())),
		)

	case *packetspb.Envelope_DocumentContentCollabMessage:
		req := p.DocumentContentCollabMessage
		if req == nil {
			badReq("document_content_collab_message: missing payload")
			return
		}
		documentID, err := uuid.Parse(req.GetDocumentId())
		if err != nil {
			badReq("document_content_collab_message: invalid document_id")
			return
		}
		if req.GetKind() != packetspb.DocumentContentCollabMessageKind_DOCUMENT_CONTENT_COLLAB_MESSAGE_KIND_SYNC &&
			req.GetKind() != packetspb.DocumentContentCollabMessageKind_DOCUMENT_CONTENT_COLLAB_MESSAGE_KIND_AWARENESS {
			badReq("document_content_collab_message: invalid kind")
			return
		}
		if req.GetKind() == packetspb.DocumentContentCollabMessageKind_DOCUMENT_CONTENT_COLLAB_MESSAGE_KIND_SYNC {
			frameType, framePayload, framed := decodeTaskCollabSyncFrame(req.GetPayload())
			if framed && !isKnownTaskCollabSyncFrameType(frameType) {
				badReq("document_content_collab_message: invalid sync frame")
				return
			}
			if framed && frameType == taskCollabSyncFrameTypeFullState {
				documentIDText := documentID.String()
				if !s.setDocumentCollabRoomSnapshot(documentIDText, outboundCh, framePayload) {
					forbidden("not subscribed to document")
					return
				}
				s.log.Info("ws document collab snapshot cache",
					zap.String("document_id", documentIDText),
					zap.String("user_id", principal.UserID.String()),
					zap.String("session_id", principal.SessionID.String()),
					zap.Int("snapshot_bytes", len(framePayload)),
				)
				return
			}
		}
		documentIDText := documentID.String()
		if !s.isCollabSubscribed(collabEntityDocument, documentIDText, outboundCh) {
			forbidden("not subscribed to document")
			return
		}
		outEnv := &packetspb.Envelope{
			ProtocolVersion: protocolVersion,
			Payload: &packetspb.Envelope_DocumentContentCollabMessage{
				DocumentContentCollabMessage: &packetspb.DocumentContentCollabMessage{
					DocumentId: documentIDText,
					Kind:       req.GetKind(),
					Payload:    req.GetPayload(),
				},
			},
		}
		recipients := s.collabRecipients(collabEntityDocument, documentIDText, outboundCh)
		s.log.Info("ws document collab relay",
			zap.String("document_id", documentIDText),
			zap.String("user_id", principal.UserID.String()),
			zap.String("session_id", principal.SessionID.String()),
			zap.String("kind", req.GetKind().String()),
			zap.Int("payload_bytes", len(req.GetPayload())),
			zap.Int("recipients", len(recipients)),
		)
		for _, recipient := range recipients {
			select {
			case recipient <- outboundMsg{env: outEnv}:
			default:
			}
		}

	default:
		enqueue(s.buildErrorEnvelope(reqID, traceID, packetspb.ErrorCode_ERROR_CODE_BAD_REQUEST, "unsupported payload type", 0))
	}
}

func negotiateCapabilities(clientCaps []packetspb.FeatureCapability) []packetspb.FeatureCapability {
	accepted := make([]packetspb.FeatureCapability, 0, len(clientCaps))
	for _, cap := range clientCaps {
		if _, ok := supportedCapabilities[cap]; ok {
			accepted = append(accepted, cap)
		}
	}
	return accepted
}

func hasCapability(caps []packetspb.FeatureCapability, target packetspb.FeatureCapability) bool {
	for _, cap := range caps {
		if cap == target {
			return true
		}
	}
	return false
}
