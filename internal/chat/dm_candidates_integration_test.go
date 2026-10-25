//go:build integration

package chat

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"msgnr/internal/auth"
	"msgnr/internal/config"
	"msgnr/internal/events"
	"msgnr/internal/testdb"
)

func TestIntegration_Handler_DMCandidatesE2EECapability(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	self := seedReactionTestUser(t, ctx, pool, "Self")
	blocked := seedReactionTestUser(t, ctx, pool, "Blocked")
	_, err := pool.Exec(ctx, `UPDATE users SET status = 'blocked' WHERE id = $1`, blocked)
	require.NoError(t, err)
	cases := []struct {
		name    string
		revoked []bool
		want    bool
	}{
		{"A no devices", nil, false},
		{"B revoked only", []bool{true}, false},
		{"C active", []bool{false}, true},
		{"D mixed", []bool{true, false}, true},
		{"E multiple active", []bool{false, false}, true},
	}
	ids := make([]uuid.UUID, len(cases))
	for i, tc := range cases {
		ids[i] = seedReactionTestUser(t, ctx, pool, tc.name)
		for _, revoked := range tc.revoked {
			_, err := pool.Exec(ctx, `
				INSERT INTO user_devices (user_id, identity_key_public, signed_prekey_id,
				    signed_prekey_public, signed_prekey_signature, revoked_at)
				VALUES ($1, 'key', 1, 'prekey', 'signature', CASE WHEN $2 THEN now() END)`, ids[i], revoked)
			require.NoError(t, err)
		}
	}
	handler := NewHandler(NewService(pool, events.NewStore(pool)), nil, &config.Config{})
	response := httptest.NewRecorder()
	handler.listDMCandidates(response, httptest.NewRequest(http.MethodGet, "/api/dm-candidates", nil), auth.Principal{UserID: self})
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var candidates []struct {
		UserID        string `json:"user_id"`
		DisplayName   string `json:"display_name"`
		HasE2EEDevice *bool  `json:"has_e2ee_device"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &candidates))
	require.Len(t, candidates, len(cases))
	for i, candidate := range candidates {
		assert.Equal(t, ids[i].String(), candidate.UserID)
		assert.Equal(t, cases[i].name, candidate.DisplayName)
		require.NotNil(t, candidate.HasE2EEDevice, "false must be serialized explicitly")
		assert.Equal(t, cases[i].want, *candidate.HasE2EEDevice)
	}
}
