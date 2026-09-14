//go:build integration

package chat

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"msgnr/internal/auth"
	"msgnr/internal/config"
	"msgnr/internal/events"
	"msgnr/internal/testdb"
)

type integrationAttachmentObject struct {
	data     []byte
	mimeType string
}

type integrationAttachmentStorage struct {
	mu      sync.Mutex
	objects map[string]integrationAttachmentObject
	deleted []string
}

func newIntegrationAttachmentStorage() *integrationAttachmentStorage {
	return &integrationAttachmentStorage{objects: make(map[string]integrationAttachmentObject)}
}

func (s *integrationAttachmentStorage) PutObject(_ context.Context, key string, body io.Reader, size int64, mimeType string) error {
	data, err := io.ReadAll(body)
	if err != nil {
		return err
	}
	if int64(len(data)) != size {
		return fmt.Errorf("stored %d bytes, want %d", len(data), size)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.objects[key] = integrationAttachmentObject{data: append([]byte(nil), data...), mimeType: mimeType}
	return nil
}

func (s *integrationAttachmentStorage) GetObject(_ context.Context, key string) (io.ReadCloser, int64, string, error) {
	s.mu.Lock()
	object, ok := s.objects[key]
	s.mu.Unlock()
	if !ok {
		return nil, 0, "", errors.New("object not found")
	}
	return io.NopCloser(bytes.NewReader(object.data)), int64(len(object.data)), object.mimeType, nil
}

func (s *integrationAttachmentStorage) DeleteObject(_ context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.objects, key)
	s.deleted = append(s.deleted, key)
	return nil
}

func (s *integrationAttachmentStorage) hasObject(key string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.objects[key]
	return ok
}

func (s *integrationAttachmentStorage) deletedKeys() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.deleted...)
}

func seedThumbnailIntegrationUserAndChannel(t *testing.T, ctx context.Context, pool *pgxpool.Pool) (uuid.UUID, uuid.UUID) {
	t.Helper()

	var userID uuid.UUID
	err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name, role)
		 VALUES ($1, 'x', 'Thumbnail Test User', 'member')
		 RETURNING id`,
		"thumbnail_"+uuid.NewString()+"@example.com",
	).Scan(&userID)
	require.NoError(t, err)

	var channelID uuid.UUID
	err = pool.QueryRow(ctx,
		`INSERT INTO channels (kind, visibility, name, created_by)
		 VALUES ('channel', 'public', $1, $2)
		 RETURNING id`,
		"thumbnail-"+uuid.NewString(), userID,
	).Scan(&channelID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`, channelID, userID)
	require.NoError(t, err)

	return userID, channelID
}

func opaquePNGForThumbnailIntegrationTest(t *testing.T, width, height int) []byte {
	t.Helper()

	source := image.NewRGBA(image.Rect(0, 0, width, height))
	draw.Draw(source, source.Bounds(), image.NewUniform(color.RGBA{R: 0x1d, G: 0x6c, B: 0xb8, A: 0xff}), image.Point{}, draw.Src)
	var output bytes.Buffer
	require.NoError(t, png.Encode(&output, source))
	return output.Bytes()
}

func TestIntegration_MessageThumbnail_HandlerServesImmutableCachedImage(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	svc := NewService(pool, events.NewStore(pool))
	storage := newIntegrationAttachmentStorage()
	svc.ConfigureAttachments(storage, 50)
	userID, channelID := seedThumbnailIntegrationUserAndChannel(t, ctx, pool)

	source := opaquePNGForThumbnailIntegrationTest(t, 1440, 720)
	attachment, err := svc.UploadMessageAttachment(ctx, UploadMessageAttachmentParams{
		ConversationID: channelID,
		ActorID:        userID,
		FileName:       "photo.png",
		MimeType:       "image/png",
		Size:           int64(len(source)),
		Body:           bytes.NewReader(source),
	}, nil)
	require.NoError(t, err)
	require.NotEmpty(t, attachment.ThumbnailStorageKey)
	assert.Equal(t, "image/jpeg", attachment.ThumbnailMimeType)
	assert.NotZero(t, attachment.ThumbnailFileSize)
	assert.Equal(t, thumbnailVersion, attachment.ThumbnailVersion)

	sent, err := svc.SendMessage(ctx, SendMessageParams{
		ChannelID:     channelID,
		SenderID:      userID,
		ClientMsgID:   uuid.NewString(),
		AttachmentIDs: []uuid.UUID{attachment.ID},
	})
	require.NoError(t, err)

	h := NewHandler(svc, nil, &config.Config{ChatHistoryPageSize: 50})
	thumbnailURL := fmt.Sprintf("/api/messages/%s/attachments/%s/thumbnail/v1", sent.MessageID, attachment.ID)
	req := httptest.NewRequest(http.MethodGet, thumbnailURL, nil)
	rec := httptest.NewRecorder()
	h.messageItem(rec, req, auth.Principal{UserID: userID})

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "image/jpeg", rec.Header().Get("Content-Type"))
	assert.Equal(t, "private, max-age=2592000, immutable", rec.Header().Get("Cache-Control"))
	assert.Contains(t, rec.Header().Values("Vary"), "Authorization")
	etag := rec.Header().Get("ETag")
	require.NotEmpty(t, etag)
	decoded, err := jpeg.Decode(bytes.NewReader(rec.Body.Bytes()))
	require.NoError(t, err)
	assert.Equal(t, 720, decoded.Bounds().Dx())
	assert.Equal(t, 360, decoded.Bounds().Dy())

	cacheReq := httptest.NewRequest(http.MethodGet, thumbnailURL, nil)
	cacheReq.Header.Set("If-None-Match", etag)
	cacheRec := httptest.NewRecorder()
	h.messageItem(cacheRec, cacheReq, auth.Principal{UserID: userID})
	assert.Equal(t, http.StatusNotModified, cacheRec.Code)
	assert.Empty(t, cacheRec.Body.String())
}

func TestIntegration_CleanupDeletedAttachmentsKeepsSharedForwardedObjects(t *testing.T) {
	pool, _ := testdb.New(t)
	ctx := context.Background()

	svc := NewService(pool, events.NewStore(pool))
	storage := newIntegrationAttachmentStorage()
	svc.ConfigureAttachments(storage, 50)
	userID, channelID := seedThumbnailIntegrationUserAndChannel(t, ctx, pool)

	first, err := svc.SendMessage(ctx, SendMessageParams{
		ChannelID:   channelID,
		SenderID:    userID,
		ClientMsgID: uuid.NewString(),
		Body:        "source",
	})
	require.NoError(t, err)
	second, err := svc.SendMessage(ctx, SendMessageParams{
		ChannelID:   channelID,
		SenderID:    userID,
		ClientMsgID: uuid.NewString(),
		Body:        "forwarded",
	})
	require.NoError(t, err)

	const originalKey = "chat/shared/original.png"
	const thumbnailKey = "chat/shared/thumbnail-v1.jpg"
	require.NoError(t, storage.PutObject(ctx, originalKey, bytes.NewReader([]byte("original")), int64(len("original")), "image/png"))
	require.NoError(t, storage.PutObject(ctx, thumbnailKey, bytes.NewReader([]byte("thumbnail")), int64(len("thumbnail")), "image/jpeg"))

	var firstAttachmentID uuid.UUID
	err = pool.QueryRow(ctx, `
		INSERT INTO message_attachment (
			conversation_id, message_id, file_name, file_size, mime_type, storage_key,
			thumbnail_storage_key, thumbnail_mime_type, thumbnail_file_size, thumbnail_version,
			uploaded_by
		) VALUES ($1, $2, 'photo.png', 8, 'image/png', $3, $4, 'image/jpeg', 9, 1, $5)
		RETURNING id`,
		channelID, first.MessageID, originalKey, thumbnailKey, userID,
	).Scan(&firstAttachmentID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `
		INSERT INTO message_attachment (
			conversation_id, message_id, file_name, file_size, mime_type, storage_key,
			thumbnail_storage_key, thumbnail_mime_type, thumbnail_file_size, thumbnail_version,
			uploaded_by
		) VALUES ($1, $2, 'photo.png', 8, 'image/png', $3, $4, 'image/jpeg', 9, 1, $5)`,
		channelID, second.MessageID, originalKey, thumbnailKey, userID,
	)
	require.NoError(t, err)

	_, err = pool.Exec(ctx, `DELETE FROM message_attachment WHERE id = $1`, firstAttachmentID)
	require.NoError(t, err)
	svc.cleanupUnreferencedAttachmentObjects(ctx, []string{originalKey, thumbnailKey})
	assert.True(t, storage.hasObject(originalKey))
	assert.True(t, storage.hasObject(thumbnailKey))
	assert.Empty(t, storage.deletedKeys())

	_, err = pool.Exec(ctx, `DELETE FROM message_attachment WHERE message_id = $1`, second.MessageID)
	require.NoError(t, err)
	svc.cleanupUnreferencedAttachmentObjects(ctx, []string{originalKey, thumbnailKey})
	assert.False(t, storage.hasObject(originalKey))
	assert.False(t, storage.hasObject(thumbnailKey))
	assert.ElementsMatch(t, []string{originalKey, thumbnailKey}, storage.deletedKeys())
}
