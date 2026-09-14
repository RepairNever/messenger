package ws

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	packetspb "msgnr/internal/gen/proto"
)

func TestNegotiateCapabilities_AcceptsTransportHeartbeat(t *testing.T) {
	accepted := negotiateCapabilities([]packetspb.FeatureCapability{
		packetspb.FeatureCapability_FEATURE_CAPABILITY_THREADS,
		packetspb.FeatureCapability_FEATURE_CAPABILITY_TRANSPORT_HEARTBEAT,
		packetspb.FeatureCapability_FEATURE_CAPABILITY_UNSPECIFIED,
	})

	assert.Equal(t, []packetspb.FeatureCapability{
		packetspb.FeatureCapability_FEATURE_CAPABILITY_THREADS,
		packetspb.FeatureCapability_FEATURE_CAPABILITY_TRANSPORT_HEARTBEAT,
	}, accepted)
}

func TestHandleDomainPayload_TransportHeartbeatReturnsCorrelatedAck(t *testing.T) {
	srv := newTestServer(nil)
	outbound := make(chan outboundMsg, 1)
	enqueue := func(env *packetspb.Envelope) bool {
		outbound <- outboundMsg{env: env}
		return true
	}

	srv.handleDomainPayload(
		context.Background(),
		&packetspb.Envelope{
			RequestId:       "heartbeat-request",
			TraceId:         "heartbeat-trace",
			ProtocolVersion: protocolVersion,
			Payload: &packetspb.Envelope_TransportHeartbeatRequest{
				TransportHeartbeatRequest: &packetspb.TransportHeartbeatRequest{},
			},
		},
		testPrincipal(),
		uuid.New(),
		false,
		outbound,
		enqueue,
	)

	msg := <-outbound
	require.NotNil(t, msg.env)
	assert.Equal(t, "heartbeat-request", msg.env.GetRequestId())
	assert.Equal(t, "heartbeat-trace", msg.env.GetTraceId())
	assert.NotNil(t, msg.env.GetTransportHeartbeatAck())
}
