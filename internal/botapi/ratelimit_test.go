package botapi

import (
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
)

func TestTokenBucketLimiter_BurstThenRefill(t *testing.T) {
	l := newTokenBucketLimiter(10, 2)
	base := time.Now()
	l.now = func() time.Time { return base }

	id := uuid.New()
	assert.True(t, l.allow(id), "first token")
	assert.True(t, l.allow(id), "second token (burst)")
	assert.False(t, l.allow(id), "burst exhausted")

	// 100ms at 10 rps refills exactly one token.
	base = base.Add(100 * time.Millisecond)
	assert.True(t, l.allow(id), "refilled one token")
	assert.False(t, l.allow(id))

	// A long gap caps tokens at burst.
	base = base.Add(10 * time.Second)
	assert.True(t, l.allow(id))
	assert.True(t, l.allow(id))
	assert.False(t, l.allow(id))

	// Users are isolated.
	other := uuid.New()
	assert.True(t, l.allow(other))
}

func TestTokenBucketLimiter_Concurrency(t *testing.T) {
	l := newTokenBucketLimiter(1000, 10)
	id := uuid.New()
	var mu sync.Mutex
	granted := 0
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if l.allow(id) {
				mu.Lock()
				granted++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	assert.Equal(t, 10, granted, "exactly the burst is granted regardless of goroutine count")
}

func TestPollCounter_CapsAndReleases(t *testing.T) {
	c := newPollCounter(2)
	id := uuid.New()
	assert.True(t, c.acquire(id))
	assert.True(t, c.acquire(id))
	assert.False(t, c.acquire(id), "third concurrent poll rejected")

	c.release(id)
	assert.True(t, c.acquire(id), "released slot reusable")
	c.release(id)
	c.release(id)

	// Slot bookkeeping is per user.
	other := uuid.New()
	assert.True(t, c.acquire(other))
	c.release(other)
	c.release(other) // double release must not underflow another user
	assert.True(t, c.acquire(id))
	assert.True(t, c.acquire(id))
	assert.False(t, c.acquire(id))
}

func TestValidClientMsgID(t *testing.T) {
	assert.True(t, validClientMsgID("bot-evt-4512"))
	assert.True(t, validClientMsgID("a"))
	assert.True(t, validClientMsgID("A.b_c:d~e-f"))
	assert.True(t, validClientMsgID("trigger:DEV-42.001"))

	assert.False(t, validClientMsgID(""), "empty")
	assert.False(t, validClientMsgID("has space"))
	assert.False(t, validClientMsgID("слова"))
	assert.False(t, validClientMsgID("bad@symbol"))
	assert.False(t, validClientMsgID(strings.Repeat("a", 129)))
}

func TestService_CloseIsIdempotentAndWakesParkedPolls(t *testing.T) {
	svc := testService()

	woken := make(chan struct{})
	go func() {
		<-svc.stopCh
		close(woken)
	}()

	svc.Close()
	select {
	case <-woken:
	case <-time.After(time.Second):
		t.Fatal("Close did not signal stop channel")
	}

	// Second Close must not panic on the closed channel.
	svc.Close()

	// A parked poll after Close returns immediately (false = not woken by event).
	parked := make(chan bool)
	_, eventCh, unsubscribe := svc.bus.SubscribeWithOverflow(nil, 16, nil)
	defer unsubscribe()
	go func() { parked <- svc.park(t.Context(), time.Now().Add(5*time.Second), eventCh) }()
	select {
	case got := <-parked:
		assert.False(t, got, "park after Close must return without an event")
	case <-time.After(time.Second):
		t.Fatal("park blocked after Close")
	}
}
