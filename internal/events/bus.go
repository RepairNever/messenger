package events

import (
	"sync"
	"sync/atomic"

	"go.uber.org/zap"
	packetspb "msgnr/internal/gen/proto"
	"msgnr/internal/metrics"
)

// FilterFn is a predicate applied to every published event.
// Return true to deliver the event to the subscriber.
type FilterFn func(evt *packetspb.ServerEvent) bool

// OverflowFn is invoked when a subscriber channel is full and an event cannot
// be delivered.
type OverflowFn func(evt *packetspb.ServerEvent)

// subscription holds the state for a single subscriber.
type subscription struct {
	id         uint64
	ch         chan *packetspb.ServerEvent
	filter     FilterFn
	onOverflow OverflowFn
}

// Bus is an in-process pub/sub hub for ServerEvents.
// It is safe for concurrent use.
type Bus struct {
	mu   sync.RWMutex
	subs map[uint64]*subscription
	next atomic.Uint64
	log  *zap.Logger
}

// NewBus creates an idle Bus.
func NewBus(log *zap.Logger) *Bus {
	return &Bus{
		subs: make(map[uint64]*subscription),
		log:  log,
	}
}

// Subscribe registers a new subscriber with the given filter and channel
// buffer size. It returns:
//   - subID  – opaque identifier for Unsubscribe
//   - ch     – receive-only channel delivering matching events
//   - cancel – call to remove the subscription and close ch
//
// filter may be nil to receive every event.
func (b *Bus) Subscribe(filter FilterFn, bufferSize int) (uint64, <-chan *packetspb.ServerEvent, func()) {
	return b.SubscribeWithOverflow(filter, bufferSize, nil)
}

// SubscribeWithOverflow registers a new subscriber and invokes onOverflow when
// the subscriber buffer is full during Publish.
func (b *Bus) SubscribeWithOverflow(filter FilterFn, bufferSize int, onOverflow OverflowFn) (uint64, <-chan *packetspb.ServerEvent, func()) {
	id := b.next.Add(1)
	ch := make(chan *packetspb.ServerEvent, bufferSize)

	sub := &subscription{id: id, ch: ch, filter: filter, onOverflow: onOverflow}

	b.mu.Lock()
	b.subs[id] = sub
	count := len(b.subs)
	b.mu.Unlock()

	metrics.EventBusSubscribers.Set(float64(count))

	cancel := func() { b.Unsubscribe(id) }
	return id, ch, cancel
}

// Unsubscribe removes the subscription identified by subID and closes its
// channel.
func (b *Bus) Unsubscribe(subID uint64) {
	b.mu.Lock()
	sub, ok := b.subs[subID]
	if ok {
		delete(b.subs, subID)
	}
	count := len(b.subs)
	b.mu.Unlock()

	if ok {
		close(sub.ch)
		metrics.EventBusSubscribers.Set(float64(count))
	}
}

// Publish fans out evt to every subscriber whose filter accepts it.
// Delivery is non-blocking: if a subscriber channel is full the event is
// dropped and the overflow metric is incremented.
func (b *Bus) Publish(evt *packetspb.ServerEvent) {
	metrics.EventBusPublishTotal.Inc()

	b.mu.RLock()
	subs := make([]*subscription, 0, len(b.subs))
	for _, s := range b.subs {
		subs = append(subs, s)
	}
	b.mu.RUnlock()

	for _, sub := range subs {
		if sub.filter != nil && !sub.filter(evt) {
			continue
		}
		select {
		case sub.ch <- evt:
		default:
			metrics.EventBusDroppedTotal.WithLabelValues("overflow").Inc()
			b.log.Warn("event bus: subscriber channel full, dropping event",
				zap.Uint64("sub_id", sub.id),
				zap.Int64("event_seq", evt.GetEventSeq()),
				zap.String("event_type", evt.GetEventType().String()),
			)
			if sub.onOverflow != nil {
				sub.onOverflow(evt)
			}
		}
	}
}

// SubscriberCount returns the current number of active subscriptions.
func (b *Bus) SubscriberCount() int {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return len(b.subs)
}
