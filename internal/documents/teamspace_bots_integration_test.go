//go:build integration

package documents

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"msgnr/internal/auth"
	"msgnr/internal/testdb"
)

func TestHandler_TeamspaceBotAdditions(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := NewService(pool, nil)
	h := NewHandler(svc, nil, nil, 50)

	for _, role := range []string{"member", "admin", "owner"} {
		for _, status := range []string{"active", "blocked"} {
			for _, method := range []string{http.MethodPost, http.MethodPatch} {
				t.Run(role+"/"+status+"/"+method, func(t *testing.T) {
					actorID := seedHandlerUser(t, ctx, pool, "Actor")
					botID := seedHandlerUser(t, ctx, pool, "Bot")
					humanID := seedHandlerUser(t, ctx, pool, "Human")
					_, err := pool.Exec(ctx, `UPDATE users SET role = $2 WHERE id = $1`, actorID, role)
					require.NoError(t, err)
					_, err = pool.Exec(ctx, `UPDATE users SET role = 'bot', status = $2 WHERE id = $1`, botID, status)
					require.NoError(t, err)

					var teamspaceID uuid.UUID
					if method == http.MethodPatch {
						space, err := svc.CreateTeamspace(ctx, CreateTeamspaceParams{
							Name: "Original", ActorID: actorID, MemberIDs: []uuid.UUID{humanID},
						}, role)
						require.NoError(t, err)
						teamspaceID = space.ID
					}
					payload, err := json.Marshal(map[string]any{
						"name": "Changed", "is_private": true, "member_ids": []uuid.UUID{botID},
					})
					require.NoError(t, err)
					req := httptest.NewRequest(method, "/api/documents/teamspaces", bytes.NewReader(payload))
					rec := httptest.NewRecorder()
					principal := auth.Principal{UserID: actorID, Role: role}
					if method == http.MethodPost {
						h.teamspacesCollection(rec, req, principal)
					} else {
						h.teamspaceItem(rec, req, principal, teamspaceID)
					}

					expectedStatus := http.StatusOK
					if method == http.MethodPost {
						expectedStatus = http.StatusCreated
					}
					if role == "member" {
						expectedStatus = http.StatusForbidden
					} else if status == "blocked" {
						expectedStatus = http.StatusBadRequest
					}
					require.Equal(t, expectedStatus, rec.Code, rec.Body.String())
					if expectedStatus < 400 {
						var result TeamspaceRow
						require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &result))
						ids, err := listTeamspaceMemberIDs(ctx, pool, result.ID)
						require.NoError(t, err)
						require.ElementsMatch(t, []uuid.UUID{actorID, botID}, ids)
					} else if method == http.MethodPost {
						var count int
						require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM teamspace WHERE owner_user_id = $1`, actorID).Scan(&count))
						require.Zero(t, count)
					} else {
						var name string
						var private bool
						require.NoError(t, pool.QueryRow(ctx, `SELECT name, is_private FROM teamspace WHERE id = $1`, teamspaceID).Scan(&name, &private))
						require.Equal(t, "Original", name)
						require.False(t, private)
						ids, err := listTeamspaceMemberIDs(ctx, pool, teamspaceID)
						require.NoError(t, err)
						require.ElementsMatch(t, []uuid.UUID{actorID, humanID}, ids)
					}
				})
			}
		}
	}
}

func TestIntegration_TeamspaceOwnerCanRetainExistingBots(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()
	svc := NewService(pool, nil)
	ownerID := seedHandlerUser(t, ctx, pool, "Teamspace owner")
	adminID := seedHandlerUser(t, ctx, pool, "Admin")
	botID := seedHandlerUser(t, ctx, pool, "Bot")
	humanID := seedHandlerUser(t, ctx, pool, "New human")
	_, err := pool.Exec(ctx, `UPDATE users SET role = 'bot' WHERE id = $1`, botID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE users SET role = 'admin' WHERE id = $1`, adminID)
	require.NoError(t, err)
	space, err := svc.CreateTeamspace(ctx, CreateTeamspaceParams{Name: "Docs", ActorID: ownerID}, "member")
	require.NoError(t, err)
	_, err = svc.UpdateTeamspace(ctx, space.ID, UpdateTeamspaceParams{
		Name: "Docs", ActorID: adminID, ActorRole: "admin", MemberIDs: []uuid.UUID{botID},
	})
	require.NoError(t, err)

	for _, status := range []string{"active", "blocked"} {
		_, err := pool.Exec(ctx, `UPDATE users SET status = $2 WHERE id = $1`, botID, status)
		require.NoError(t, err)
		updated, err := svc.UpdateTeamspace(ctx, space.ID, UpdateTeamspaceParams{
			Name: "Renamed", IsPrivate: true, ActorID: ownerID, ActorRole: "member",
			MemberIDs: []uuid.UUID{botID, humanID},
		})
		require.NoError(t, err)
		require.Equal(t, "Renamed", updated.Name)
		require.True(t, updated.IsPrivate)
		ids, err := listTeamspaceMemberIDs(ctx, pool, space.ID)
		require.NoError(t, err)
		require.ElementsMatch(t, []uuid.UUID{ownerID, botID, humanID}, ids)
	}
}
