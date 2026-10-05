package ws

import (
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gobwas/ws"
	"github.com/gobwas/ws/wsutil"
	"golang.org/x/time/rate"
)

// Inbound protection limits. These mirror the RateLimitPolicy advertised in
// ServerHello; the two must never drift, so the policy block in
// handleWebSocket reads these constants.
const (
	// MaxEnvelopeBytes caps a single WebSocket data message. Frames declaring
	// a larger payload are rejected before any bytes are buffered.
	MaxEnvelopeBytes = int64(1 << 20)
	// PerConnectionRPS / PerConnectionBurst apply to every envelope on one
	// transport, including the unauthenticated hello/auth exchange.
	PerConnectionRPS   = 50
	PerConnectionBurst = 100
	// PerUserRPS / PerUserBurst aggregate all transports of one account.
	PerUserRPS   = 200
	PerUserBurst = 400
)

// ErrMessageTooLarge is returned by readClientDataLimited when the peer sends
// a data message exceeding the size cap. The connection must be closed after
// this error: the oversized payload may still be in flight on the socket.
var ErrMessageTooLarge = errors.New("websocket message exceeds maximum allowed size")

// readClientDataLimited reads the next client data message handling control
// frames like wsutil.ReadClientData, but refuses to buffer more than maxBytes.
// The frame header is inspected before reading the payload, so an oversized
// frame never reaches memory. Data frames of any opcode are returned to the
// caller (opcode included) so that protocol violations — e.g. text frames
// where the envelope contract requires binary — stay visible to the server
// loop instead of being silently drained.
func readClientDataLimited(rw io.ReadWriter, maxBytes int64) ([]byte, ws.OpCode, error) {
	controlHandler := wsutil.ControlFrameHandler(rw, ws.StateServerSide)
	rd := wsutil.Reader{
		Source:          rw,
		State:           ws.StateServerSide,
		CheckUTF8:       true,
		SkipHeaderCheck: false,
		OnIntermediate:  controlHandler,
	}
	for {
		hdr, err := rd.NextFrame()
		if err != nil {
			return nil, 0, err
		}
		if hdr.OpCode.IsControl() {
			if err := controlHandler(hdr, &rd); err != nil {
				return nil, 0, err
			}
			continue
		}
		if hdr.Length > maxBytes {
			// Do not drain: the declared payload may be arbitrarily larger
			// than the cap and reading it all would stall the connection.
			return nil, hdr.OpCode, ErrMessageTooLarge
		}
		// Fragmented messages must respect the cap across all frames, so read
		// through a limiter that allows one extra byte for detection.
		limited := io.LimitReader(&rd, maxBytes+1)
		bts, err := io.ReadAll(limited)
		if err == nil && int64(len(bts)) > maxBytes {
			err = ErrMessageTooLarge
		}
		return bts, hdr.OpCode, err
	}
}

// userRateLimiterIdleTTL is how long a per-user limiter survives after the
// account's last authenticated message. userRateLimiterSweepInterval is how
// often the sweeper looks for expired entries.
const (
	userRateLimiterIdleTTL       = 10 * time.Minute
	userRateLimiterSweepInterval = time.Minute
)

// userRateLimiters bounds the memory spent on per-user limiters: an entry is
// created on the account's first authenticated message and swept once the
// account has been inactive longer than userRateLimiterIdleTTL. Entries are
// deliberately NOT dropped on disconnect: a single-session client that
// exhausts its burst and reconnects must not start every connection with a
// fresh burst, or the per-user policy would never bite.
type userRateLimiters struct {
	limiters sync.Map // string (user id) -> *userRateLimiterEntry
	now      func() time.Time
}

type userRateLimiterEntry struct {
	limiter  *rate.Limiter
	lastUsed atomic.Int64 // unix nanos, refreshed on every get
}

func newUserRateLimiters() userRateLimiters {
	return userRateLimiters{now: time.Now}
}

func (u *userRateLimiters) get(userID string) *rate.Limiter {
	entryAny, _ := u.limiters.LoadOrStore(userID, &userRateLimiterEntry{
		limiter: rate.NewLimiter(rate.Limit(PerUserRPS), PerUserBurst),
	})
	entry := entryAny.(*userRateLimiterEntry)
	entry.lastUsed.Store(u.clock().UnixNano())
	return entry.limiter
}

// sweepIdle drops limiters of accounts inactive for longer than ttl. A race
// with a concurrent get can drop a just-used limiter: the running session
// keeps its local pointer, so enforcement is unaffected, and the next get
// re-creates the entry — fresh-burst semantics identical to a real expiry.
func (u *userRateLimiters) sweepIdle(ttl time.Duration) {
	cutoff := u.clock().Add(-ttl).UnixNano()
	u.limiters.Range(func(key, value any) bool {
		if value.(*userRateLimiterEntry).lastUsed.Load() < cutoff {
			u.limiters.CompareAndDelete(key, value)
		}
		return true
	})
}

func (u *userRateLimiters) clock() time.Time {
	if u.now == nil {
		return time.Now()
	}
	return u.now()
}

// newConnectionRateLimiter returns the per-transport inbound limiter. The
// burst absorbs legitimate UI bursts (bootstrap pages, bulk read cursors)
// while the steady-state rate matches the advertised policy.
func newConnectionRateLimiter() *rate.Limiter {
	return rate.NewLimiter(rate.Limit(PerConnectionRPS), PerConnectionBurst)
}

// rateLimitRetryAfter is the delay suggested to clients that hit the limit.
const rateLimitRetryAfterMs = 1000

// terminalErrorFlushTimeout bounds how long connection teardown waits for the
// writer goroutine to deliver a queued terminal error envelope (oversized
// frame, rate limit) before the socket is force-closed underneath it.
const terminalErrorFlushTimeout = 2 * time.Second
