package events

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseNotificationPayload_Valid(t *testing.T) {
	cases := []struct {
		payload  string
		expected int64
	}{
		{"1", 1},
		{"42", 42},
		{"9999999999", 9999999999},
	}

	for _, tc := range cases {
		seq, err := parseNotificationPayload(tc.payload)
		require.NoError(t, err, "payload=%q", tc.payload)
		assert.Equal(t, tc.expected, seq)
	}
}

func TestListener_HandlePresenceNotification(t *testing.T) {
	called := make(chan PresenceNotification, 1)
	listener := &Listener{}
	listener.SetPresenceHandler(func(update PresenceNotification) {
		called <- update
	})

	require.NoError(t, listener.handlePresenceNotification(`{"user_id":"user-2","effective_presence":1,"last_active_at":"2026-07-22T00:00:00Z"}`))
	select {
	case update := <-called:
		assert.Equal(t, "user-2", update.UserID)
		assert.EqualValues(t, 1, update.EffectivePresence)
		assert.Equal(t, time.Date(2026, 7, 22, 0, 0, 0, 0, time.UTC), update.LastActiveAt)
	default:
		t.Fatal("presence handler was not called")
	}

	assert.Error(t, listener.handlePresenceNotification(`{"effective_presence":1}`))
	assert.Error(t, listener.handlePresenceNotification(`not-json`))
}

func TestParseNotificationPayload_Invalid(t *testing.T) {
	cases := []string{
		"",
		"abc",
		"1.5",
		"12 34",
		"{}",
	}

	for _, payload := range cases {
		_, err := parseNotificationPayload(payload)
		assert.Error(t, err, "expected error for payload=%q", payload)
	}
}
