package events

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
	packetspb "msgnr/internal/gen/proto"
)

func newTestBus() *Bus {
	return NewBus(zap.NewNop())
}

func makeEvent(seq int64, et packetspb.EventType) *packetspb.ServerEvent {
	return &packetspb.ServerEvent{
		EventSeq:  seq,
		EventType: et,
	}
}

func TestBus_SubscribeReceivesPublishedEvent(t *testing.T) {
	b := newTestBus()

	_, ch, cancel := b.Subscribe(nil, 8)
	defer cancel()

	evt := makeEvent(1, packetspb.EventType_EVENT_TYPE_MESSAGE_CREATED)
	b.Publish(evt)

	select {
	case got := <-ch:
		assert.Equal(t, int64(1), got.GetEventSeq())
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for event")
	}
}

func TestBus_UnsubscribeClosesChannel(t *testing.T) {
	b := newTestBus()

	_, ch, cancel := b.Subscribe(nil, 4)
	cancel()

	// Channel should be closed after unsubscribe.
	select {
	case _, ok := <-ch:
		assert.False(t, ok, "channel should be closed")
	case <-time.After(time.Second):
		t.Fatal("channel not closed after unsubscribe")
	}
}

func TestBus_FilterRoutesCorrectly(t *testing.T) {
	b := newTestBus()

	// Subscriber only wants MESSAGE_CREATED events.
	msgFilter := func(e *packetspb.ServerEvent) bool {
		return e.GetEventType() == packetspb.EventType_EVENT_TYPE_MESSAGE_CREATED
	}

	_, msgCh, cancelMsg := b.Subscribe(msgFilter, 4)
	defer cancelMsg()

	_, allCh, cancelAll := b.Subscribe(nil, 4)
	defer cancelAll()

	msgEvt := makeEvent(1, packetspb.EventType_EVENT_TYPE_MESSAGE_CREATED)
	reactEvt := makeEvent(2, packetspb.EventType_EVENT_TYPE_REACTION_UPDATED)

	b.Publish(msgEvt)
	b.Publish(reactEvt)

	// msgCh should receive only msgEvt.
	select {
	case got := <-msgCh:
		assert.Equal(t, packetspb.EventType_EVENT_TYPE_MESSAGE_CREATED, got.GetEventType())
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for msg event")
	}

	// msgCh should NOT receive reactEvt — assert no second delivery.
	select {
	case got := <-msgCh:
		t.Fatalf("unexpected event on filtered channel: %v", got)
	case <-time.After(20 * time.Millisecond):
		// expected: nothing
	}

	// allCh should receive both.
	recv := make([]*packetspb.ServerEvent, 0, 2)
	for i := 0; i < 2; i++ {
		select {
		case got := <-allCh:
			recv = append(recv, got)
		case <-time.After(time.Second):
			t.Fatalf("timed out waiting for event %d on allCh", i+1)
		}
	}
	require.Len(t, recv, 2)
}

func TestBus_OverflowDropsEventAndIncrementsMetric(t *testing.T) {
	b := newTestBus()

	// Buffer of 1; fill it immediately.
	_, ch, cancel := b.Subscribe(nil, 1)
	defer cancel()

	// First publish fills the buffer.
	b.Publish(makeEvent(1, packetspb.EventType_EVENT_TYPE_MESSAGE_CREATED))
	// Second publish overflows — must not block.
	b.Publish(makeEvent(2, packetspb.EventType_EVENT_TYPE_MESSAGE_CREATED))

	// Only event 1 should be delivered.
	select {
	case got := <-ch:
		assert.Equal(t, int64(1), got.GetEventSeq())
	case <-time.After(time.Second):
		t.Fatal("timed out")
	}

	select {
	case got := <-ch:
		t.Fatalf("unexpected second event: %v", got)
	case <-time.After(20 * time.Millisecond):
		// expected: nothing (overflow dropped it)
	}
}

func TestBus_SubscribeWithOverflowInvokesCallback(t *testing.T) {
	b := newTestBus()
	overflowed := make(chan *packetspb.ServerEvent, 1)

	_, _, cancel := b.SubscribeWithOverflow(nil, 1, func(evt *packetspb.ServerEvent) {
		select {
		case overflowed <- evt:
		default:
		}
	})
	defer cancel()

	b.Publish(makeEvent(1, packetspb.EventType_EVENT_TYPE_MESSAGE_CREATED))
	b.Publish(makeEvent(2, packetspb.EventType_EVENT_TYPE_MESSAGE_CREATED))

	select {
	case evt := <-overflowed:
		require.NotNil(t, evt)
		assert.Equal(t, int64(2), evt.GetEventSeq())
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for overflow callback")
	}
}

func TestBus_SubscriberCount(t *testing.T) {
	b := newTestBus()
	assert.Equal(t, 0, b.SubscriberCount())

	_, _, c1 := b.Subscribe(nil, 4)
	assert.Equal(t, 1, b.SubscriberCount())

	_, _, c2 := b.Subscribe(nil, 4)
	assert.Equal(t, 2, b.SubscriberCount())

	c1()
	assert.Equal(t, 1, b.SubscriberCount())

	c2()
	assert.Equal(t, 0, b.SubscriberCount())
}

func TestBus_MultipleUnsubscribeIsIdempotent(t *testing.T) {
	b := newTestBus()
	_, _, cancel := b.Subscribe(nil, 4)
	cancel()
	cancel() // second call must not panic
}
