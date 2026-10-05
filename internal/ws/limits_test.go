package ws

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"testing"
	"time"

	"github.com/gobwas/ws"
	"github.com/gobwas/ws/wsutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestReadClientDataLimited_AcceptsNormalMessage(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()

	go func() {
		_ = wsutil.WriteMessage(client, ws.StateClientSide, ws.OpBinary, []byte("hello"))
	}()

	msg, op, err := readClientDataLimited(server, MaxEnvelopeBytes)
	require.NoError(t, err)
	assert.Equal(t, ws.OpBinary, op)
	assert.Equal(t, []byte("hello"), msg)
}

func TestReadClientDataLimited_RejectsOversizedDeclaredFrame(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()

	go func() {
		// Header declaring a 4 GiB payload, followed by a few mask+payload
		// bytes. The server must bail out on the header alone.
		header := []byte{0x82, 0x80 | 127, 0, 0, 0, 0, 1, 0, 0, 0}
		mask := []byte{1, 2, 3, 4}
		_, err := client.Write(append(header, mask...))
		if err != nil {
			return
		}
		_, _ = client.Write(bytes.Repeat([]byte{0xAA}, 16))
	}()

	_, _, err := readClientDataLimited(server, MaxEnvelopeBytes)
	require.Error(t, err)
	assert.True(t, errors.Is(err, ErrMessageTooLarge))
}

func TestReadClientDataLimited_RejectsFragmentedMessageOverCap(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()

	const fragment1Len = 1024

	go func() {
		// Fragment 1: binary, not FIN, small declared length.
		_ = writeRawClientFrame(client, ws.OpBinary, false, make([]byte, fragment1Len))
		// Fragment 2: continuation, FIN, pushing the total over the cap.
		_ = writeRawClientFrame(client, ws.OpContinuation, true, make([]byte, MaxEnvelopeBytes))
	}()

	_, _, err := readClientDataLimited(server, MaxEnvelopeBytes)
	require.Error(t, err)
	assert.True(t, errors.Is(err, ErrMessageTooLarge))
}

func TestReadClientDataLimited_ControlFramesDoNotBlockData(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()

	go func() {
		// Unsolicited empty pong: handled (and discarded) without writing a
		// response, so the data frame behind it must still come through.
		_ = wsutil.WriteMessage(client, ws.StateClientSide, ws.OpPong, nil)
		_ = wsutil.WriteMessage(client, ws.StateClientSide, ws.OpBinary, []byte("after-pong"))
	}()

	msg, op, err := readClientDataLimited(server, MaxEnvelopeBytes)
	require.NoError(t, err)
	assert.Equal(t, ws.OpBinary, op)
	assert.Equal(t, []byte("after-pong"), msg)
}

func TestReadClientDataLimited_TextFrameIsReturnedToCaller(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()

	go func() {
		_ = wsutil.WriteMessage(client, ws.StateClientSide, ws.OpText, []byte("not-protobuf"))
	}()

	// Text frames are a protocol violation for this server, but the reader
	// must surface them (op included) instead of silently draining them, so
	// the server can answer with an error envelope.
	msg, op, err := readClientDataLimited(server, MaxEnvelopeBytes)
	require.NoError(t, err)
	assert.Equal(t, ws.OpText, op)
	assert.Equal(t, []byte("not-protobuf"), msg)
}

func TestReadClientDataLimited_RejectsOversizedTextFrame(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()

	go func() {
		_ = writeRawClientFrame(client, ws.OpText, true, make([]byte, MaxEnvelopeBytes+1))
	}()

	// The declared-length cap applies to every data opcode, not just binary.
	_, _, err := readClientDataLimited(server, MaxEnvelopeBytes)
	require.Error(t, err)
	assert.True(t, errors.Is(err, ErrMessageTooLarge))
}

// writeRawClientFrame writes a masked client frame without the wsutil
// conveniences so tests can control fragmentation and declared lengths.
func writeRawClientFrame(w io.Writer, op ws.OpCode, fin bool, payload []byte) error {
	first := byte(op)
	if fin {
		first |= 0x80
	}
	mask := [4]byte{0x11, 0x22, 0x33, 0x44}

	var header []byte
	length := len(payload)
	switch {
	case length <= 125:
		header = []byte{first, byte(0x80 | length)}
	case length <= 0xFFFF:
		header = []byte{first, 0x80 | 126, byte(length >> 8), byte(length)}
	default:
		header = make([]byte, 10)
		header[0] = first
		header[1] = 0x80 | 127
		binary.BigEndian.PutUint64(header[2:], uint64(length))
	}

	buffer := append([]byte{}, header...)
	buffer = append(buffer, mask[:]...)
	for i, b := range payload {
		buffer = append(buffer, b^mask[i%4])
	}
	_, err := w.Write(buffer)
	return err
}

func TestUserRateLimiters_IdentityAndSweep(t *testing.T) {
	base := time.Now()
	limiters := &userRateLimiters{now: func() time.Time { return base }}

	alice := limiters.get("alice")
	assert.Same(t, alice, limiters.get("alice"), "same user must reuse the limiter")
	bob := limiters.get("bob")
	assert.NotSame(t, alice, bob, "different users must not share a limiter")

	// Both entries are fresh: a sweep must not touch them.
	limiters.sweepIdle(userRateLimiterIdleTTL)
	assert.Same(t, alice, limiters.get("alice"), "recently used limiter survives the sweep")

	// Advance the clock past the TTL and refresh only bob: the idle alice
	// entry is dropped and the next get recreates it with a fresh burst,
	// while the active bob entry survives.
	limiters.now = func() time.Time { return base.Add(userRateLimiterIdleTTL + time.Minute) }
	limiters.get("bob")
	limiters.sweepIdle(userRateLimiterIdleTTL)
	assert.NotSame(t, alice, limiters.get("alice"), "idle limiter must be recreated fresh")
	assert.Same(t, bob, limiters.get("bob"), "active limiter must survive the sweep")
}
