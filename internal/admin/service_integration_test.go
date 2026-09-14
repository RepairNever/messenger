//go:build integration

package admin_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"msgnr/internal/admin"
	"msgnr/internal/testdb"
)

type deleteTrackingAttachmentStorage struct {
	mu   sync.Mutex
	keys []string
}

func (s *deleteTrackingAttachmentStorage) DeleteObject(_ context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.keys = append(s.keys, key)
	return nil
}

func (s *deleteTrackingAttachmentStorage) deletedKeys() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.keys...)
}

func hashToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

func seedAdminUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, role string) uuid.UUID {
	t.Helper()

	var userID uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', $2, $3)
		 RETURNING id`,
		"admin_test_"+uuid.NewString()+"@example.com",
		"User "+role,
		role,
	).Scan(&userID)
	require.NoError(t, err)
	return userID
}

func TestIntegration_CreateChannel_AddAllUsers(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	adminID := seedAdminUser(t, ctx, pool, "admin")
	memberOne := seedAdminUser(t, ctx, pool, "member")
	memberTwo := seedAdminUser(t, ctx, pool, "member")

	svc := admin.NewService(pool)

	channel, err := svc.CreateChannel(ctx, admin.CreateChannelParams{
		Name:        "all-hands",
		Visibility:  "public",
		CreatedBy:   adminID,
		AddAllUsers: true,
	})
	require.NoError(t, err)

	members, err := svc.ListChannelMembers(ctx, channel.ID)
	require.NoError(t, err)
	require.Len(t, members, 3)

	memberIDs := []uuid.UUID{members[0].ID, members[1].ID, members[2].ID}
	assert.ElementsMatch(t, []uuid.UUID{adminID, memberOne, memberTwo}, memberIDs)

	var eventType string
	err = pool.QueryRow(ctx,
		`SELECT event_type FROM workspace_events WHERE channel_id = $1 ORDER BY event_seq DESC LIMIT 1`,
		channel.ID,
	).Scan(&eventType)
	require.NoError(t, err)
	assert.Equal(t, "conversation_upserted", eventType)
}

func TestIntegration_DeleteChannelCleansUpAttachmentOriginalAndThumbnail(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	adminID := seedAdminUser(t, ctx, pool, "admin")
	svc := admin.NewService(pool)
	storage := &deleteTrackingAttachmentStorage{}
	svc.ConfigureMessageAttachmentStorage(storage)

	channel, err := svc.CreateChannel(ctx, admin.CreateChannelParams{
		Name:       "cleanup-attachments",
		Visibility: "public",
		CreatedBy:  adminID,
	})
	require.NoError(t, err)

	_, err = pool.Exec(ctx, `
		INSERT INTO message_attachment (
			conversation_id, message_id, file_name, file_size, mime_type, storage_key,
			thumbnail_storage_key, thumbnail_mime_type, thumbnail_file_size, thumbnail_version,
			uploaded_by
		) VALUES (
			$1, NULL, 'photo.png', 12, 'image/png', 'chat/admin/original.png',
			'chat/admin/thumbnail-v1.jpg', 'image/jpeg', 9, 1,
			$2
		)`,
		channel.ID, adminID,
	)
	require.NoError(t, err)

	require.NoError(t, svc.DeleteChannel(ctx, channel.ID))
	require.Eventually(t, func() bool {
		return len(storage.deletedKeys()) == 2
	}, time.Second, 10*time.Millisecond)
	assert.ElementsMatch(t,
		[]string{"chat/admin/original.png", "chat/admin/thumbnail-v1.jpg"},
		storage.deletedKeys(),
	)
}

func TestIntegration_CreateChannel_AddAllUsersSkipsBots(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	adminID := seedAdminUser(t, ctx, pool, "admin")
	memberID := seedAdminUser(t, ctx, pool, "member")
	botID := seedAdminUser(t, ctx, pool, "bot")

	svc := admin.NewService(pool)

	channel, err := svc.CreateChannel(ctx, admin.CreateChannelParams{
		Name:        "human-only",
		Visibility:  "public",
		CreatedBy:   adminID,
		AddAllUsers: true,
	})
	require.NoError(t, err)

	members, err := svc.ListChannelMembers(ctx, channel.ID)
	require.NoError(t, err)
	require.Len(t, members, 2)

	memberIDs := []uuid.UUID{members[0].ID, members[1].ID}
	assert.ElementsMatch(t, []uuid.UUID{adminID, memberID}, memberIDs)
	assert.NotContains(t, memberIDs, botID)
}

func TestIntegration_CreateChannel_AddsCreatorMembership(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	adminID := seedAdminUser(t, ctx, pool, "admin")
	memberID := seedAdminUser(t, ctx, pool, "member")
	svc := admin.NewService(pool)

	channel, err := svc.CreateChannel(ctx, admin.CreateChannelParams{
		Name:       "ops",
		Visibility: "private",
		CreatedBy:  adminID,
		MemberIDs:  []uuid.UUID{memberID},
	})
	require.NoError(t, err)

	members, err := svc.ListChannelMembers(ctx, channel.ID)
	require.NoError(t, err)
	require.Len(t, members, 2)
	memberIDs := []uuid.UUID{members[0].ID, members[1].ID}
	assert.ElementsMatch(t, []uuid.UUID{adminID, memberID}, memberIDs)
}

func TestIntegration_CreateChannel_PrivateRequiresMemberIds(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	adminID := seedAdminUser(t, ctx, pool, "admin")
	svc := admin.NewService(pool)

	_, err := svc.CreateChannel(ctx, admin.CreateChannelParams{
		Name:       "ops-no-members",
		Visibility: "private",
		CreatedBy:  adminID,
	})
	require.Error(t, err)
	assert.ErrorIs(t, err, admin.ErrBadRequest)
}

func TestIntegration_CreateChannel_CreatesInviteNotificationForAddedMember(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	adminID := seedAdminUser(t, ctx, pool, "admin")
	memberID := seedAdminUser(t, ctx, pool, "member")
	svc := admin.NewService(pool)

	channel, err := svc.CreateChannel(ctx, admin.CreateChannelParams{
		Name:       "secret",
		Visibility: "public",
		CreatedBy:  adminID,
		MemberIDs:  []uuid.UUID{memberID},
	})
	require.NoError(t, err)

	members, err := svc.ListChannelMembers(ctx, channel.ID)
	require.NoError(t, err)
	require.Len(t, members, 2)
	memberIDs := []uuid.UUID{members[0].ID, members[1].ID}
	assert.ElementsMatch(t, []uuid.UUID{adminID, memberID}, memberIDs)

	var notificationCount int
	err = pool.QueryRow(ctx,
		`SELECT COUNT(*)::int
		   FROM notifications
		  WHERE user_id = $1
		    AND channel_id = $2
		    AND type = 'system'`,
		memberID, channel.ID,
	).Scan(&notificationCount)
	require.NoError(t, err)
	assert.Equal(t, 1, notificationCount)
}

func TestIntegration_ListChannels_ExcludesDirectMessages(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	adminID := seedAdminUser(t, ctx, pool, "admin")

	var publicChannelID uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO channels (kind, visibility, name, created_by)
		 VALUES ('channel', 'public', 'general', $1)
		 RETURNING id`,
		adminID,
	).Scan(&publicChannelID)
	require.NoError(t, err)

	var dmChannelID uuid.UUID
	err = pool.QueryRow(ctx,
		`INSERT INTO channels (kind, visibility, topic, created_by)
		 VALUES ('dm', 'dm', $1, $2)
		 RETURNING id`,
		uuid.NewString(),
		adminID,
	).Scan(&dmChannelID)
	require.NoError(t, err)

	svc := admin.NewService(pool)

	channels, err := svc.ListChannels(ctx)
	require.NoError(t, err)

	require.Len(t, channels, 1)
	assert.Equal(t, publicChannelID, channels[0].ID)
	assert.NotEqual(t, dmChannelID, channels[0].ID)
	assert.Equal(t, "channel", channels[0].Kind)
}

func TestIntegration_UpdateBotUserStoresAndReplacesIntegrationToken(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	botID := seedAdminUser(t, ctx, pool, "bot")
	svc := admin.NewService(pool)

	updated, err := svc.UpdateUser(ctx, botID, admin.UpdateUserParams{
		DisplayName:      "Bot User",
		Email:            "bot_update_" + uuid.NewString() + "@example.com",
		Role:             "bot",
		IntegrationToken: "first-token",
	})
	require.NoError(t, err)
	assert.Equal(t, "bot", updated.Role)

	var firstHash string
	err = pool.QueryRow(ctx,
		`SELECT token_hash
		   FROM integration_token
		  WHERE user_id = $1
		    AND revoked_at IS NULL`,
		botID,
	).Scan(&firstHash)
	require.NoError(t, err)
	assert.Equal(t, hashToken("first-token"), firstHash)

	_, err = svc.UpdateUser(ctx, botID, admin.UpdateUserParams{
		DisplayName:      "Bot User",
		Email:            updated.Email,
		Role:             "bot",
		IntegrationToken: "second-token",
	})
	require.NoError(t, err)

	var activeCount int
	err = pool.QueryRow(ctx,
		`SELECT COUNT(*)::int
		   FROM integration_token
		  WHERE user_id = $1
		    AND revoked_at IS NULL`,
		botID,
	).Scan(&activeCount)
	require.NoError(t, err)
	assert.Equal(t, 1, activeCount)

	var secondHash string
	err = pool.QueryRow(ctx,
		`SELECT token_hash
		   FROM integration_token
		  WHERE user_id = $1
		    AND revoked_at IS NULL`,
		botID,
	).Scan(&secondHash)
	require.NoError(t, err)
	assert.Equal(t, hashToken("second-token"), secondHash)
}

func TestIntegration_UpdateUserRevokesIntegrationTokenWhenLeavingBotRole(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	botID := seedAdminUser(t, ctx, pool, "bot")
	svc := admin.NewService(pool)

	_, err := svc.UpdateUser(ctx, botID, admin.UpdateUserParams{
		DisplayName:      "Bot User",
		Email:            "bot_leave_" + uuid.NewString() + "@example.com",
		Role:             "bot",
		IntegrationToken: "bot-token",
	})
	require.NoError(t, err)

	_, err = svc.UpdateUser(ctx, botID, admin.UpdateUserParams{
		DisplayName: "Former Bot",
		Email:       "former_bot_" + uuid.NewString() + "@example.com",
		Role:        "member",
	})
	require.NoError(t, err)

	var activeCount int
	err = pool.QueryRow(ctx,
		`SELECT COUNT(*)::int
		   FROM integration_token
		  WHERE user_id = $1
		    AND revoked_at IS NULL`,
		botID,
	).Scan(&activeCount)
	require.NoError(t, err)
	assert.Equal(t, 0, activeCount)
}
