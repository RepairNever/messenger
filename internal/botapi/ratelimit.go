package botapi

import (
	"sync"
	"time"

	"github.com/google/uuid"
)

// tokenBucketLimiter is a mutex-guarded per-user token bucket. Hand-rolled on
// purpose: golang.org/x/time/rate is only an indirect dependency today and
// importing it would promote it to direct for no benefit.
type tokenBucketLimiter struct {
	mu      sync.Mutex
	buckets map[uuid.UUID]*tokenBucket
	rps     float64
	burst   float64
	now     func() time.Time
}

type tokenBucket struct {
	tokens float64
	last   time.Time
}

func newTokenBucketLimiter(rps, burst int) *tokenBucketLimiter {
	return &tokenBucketLimiter{
		buckets: make(map[uuid.UUID]*tokenBucket),
		rps:     float64(rps),
		burst:   float64(burst),
		now:     time.Now,
	}
}

func (l *tokenBucketLimiter) allow(id uuid.UUID) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()
	b, ok := l.buckets[id]
	if !ok {
		b = &tokenBucket{tokens: l.burst, last: now}
		l.buckets[id] = b
	}
	elapsed := now.Sub(b.last).Seconds()
	if elapsed > 0 {
		b.tokens += elapsed * l.rps
		if b.tokens > l.burst {
			b.tokens = l.burst
		}
		b.last = now
	}
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// pollCounter caps concurrent long-polling requests per bot user.
type pollCounter struct {
	mu     sync.Mutex
	counts map[uuid.UUID]int
	max    int
}

func newPollCounter(max int) *pollCounter {
	return &pollCounter{
		counts: make(map[uuid.UUID]int),
		max:    max,
	}
}

func (c *pollCounter) acquire(id uuid.UUID) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.counts[id] >= c.max {
		return false
	}
	c.counts[id]++
	return true
}

func (c *pollCounter) release(id uuid.UUID) {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := c.counts[id] - 1
	if n <= 0 {
		delete(c.counts, id)
	} else {
		c.counts[id] = n
	}
}
