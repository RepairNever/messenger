package ws

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gobwas/ws"
	"github.com/gobwas/ws/wsutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"

	packetspb "msgnr/internal/gen/proto"
)

// TestHandleWebSocket_ConnectionRateLimitDeliversErrorEnvelope floods one
// connection past the advertised per-connection burst and verifies the peer
// actually receives the terminal ERROR_CODE_RATE_LIMITED envelope. The read
// loop exits right after queueing that envelope, so this also guards the
// bounded flush in connection teardown: without it the envelope used to die
// when conn.Close() outran the writer goroutine.
func TestHandleWebSocket_ConnectionRateLimitDeliversErrorEnvelope(t *testing.T) {
	srv := newTestServer(nil)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	conn, _, _, err := ws.Dialer{Timeout: 5 * time.Second}.Dial(
		context.Background(), "ws://"+strings.TrimPrefix(ts.URL, "http://")+"/ws")
	require.NoError(t, err)
	defer conn.Close()

	// Reader: watch for the terminal rate-limit error envelope. All other
	// replies (protocol-violation errors for the junk payloads) are drained
	// so the writer goroutine never wedges on a full outbound queue.
	rateLimited := make(chan *packetspb.Error, 1)
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		for {
			data, op, err := wsutil.ReadServerData(conn)
			if err != nil {
				return
			}
			if op != ws.OpBinary {
				continue
			}
			var env packetspb.Envelope
			if proto.Unmarshal(data, &env) != nil {
				continue
			}
			if errPb := env.GetError(); errPb != nil && errPb.GetCode() == packetspb.ErrorCode_ERROR_CODE_RATE_LIMITED {
				rateLimited <- errPb
				return
			}
		}
	}()

	// Writer: exceed the per-connection burst. The deadline bounds the loop
	// once the server stops reading (connection is being torn down).
	_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	for i := 0; i < PerConnectionBurst+10; i++ {
		if err := wsutil.WriteMessage(conn, ws.StateClientSide, ws.OpBinary, []byte("junk")); err != nil {
			break
		}
	}

	select {
	case errPb := <-rateLimited:
		assert.Equal(t, uint32(rateLimitRetryAfterMs), errPb.GetRetryAfterMs())
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for rate limit error envelope")
	}
	<-readDone
}
