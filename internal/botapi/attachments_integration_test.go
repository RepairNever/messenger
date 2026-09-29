//go:build integration

package botapi_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"mime"
	"net/http"
	"strconv"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"msgnr/internal/chat"
	"msgnr/internal/documents"
	"msgnr/internal/tasks"
)

type botAttachmentObject struct {
	data     []byte
	mimeType string
	readErr  error
}

// A shared store lets the HTTP tests exercise real domain authorization while
// also asserting that forbidden requests never open an object.
type botAttachmentStore struct {
	mu         sync.Mutex
	objects    map[string]botAttachmentObject
	getCalls   int
	closeCalls int
}

func newBotAttachmentStore() *botAttachmentStore {
	return &botAttachmentStore{objects: make(map[string]botAttachmentObject)}
}

func (s *botAttachmentStore) PutObject(_ context.Context, key string, body io.Reader, size int64, mimeType string) error {
	data, err := io.ReadAll(body)
	if err != nil {
		return err
	}
	if size != int64(len(data)) {
		return fmt.Errorf("object size mismatch")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.objects[key] = botAttachmentObject{data: data, mimeType: mimeType}
	return nil
}

func (s *botAttachmentStore) GetObject(_ context.Context, key string) (io.ReadCloser, int64, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.getCalls++
	obj, ok := s.objects[key]
	if !ok {
		return nil, 0, "", errors.New("object unavailable")
	}
	var reader io.Reader = bytes.NewReader(obj.data)
	if obj.readErr != nil {
		reader = io.MultiReader(bytes.NewReader(obj.data[:1]), botAttachmentErrorReader{obj.readErr})
	}
	return &botAttachmentReader{Reader: reader, close: func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.closeCalls++
	}}, int64(len(obj.data)), obj.mimeType, nil
}

func (s *botAttachmentStore) DeleteObject(_ context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.objects, key)
	return nil
}

func (s *botAttachmentStore) counts() (int, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.getCalls, s.closeCalls
}

func (s *botAttachmentStore) changeObject(key, mimeType string, readErr error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	obj := s.objects[key]
	obj.mimeType, obj.readErr = mimeType, readErr
	s.objects[key] = obj
}

type botAttachmentReader struct {
	io.Reader
	close func()
}

func (r *botAttachmentReader) Close() error { r.close(); return nil }

type botAttachmentErrorReader struct{ err error }

func (r botAttachmentErrorReader) Read([]byte) (int, error) { return 0, r.err }

func botAttachmentPNG(t *testing.T) []byte {
	t.Helper()
	var out bytes.Buffer
	require.NoError(t, png.Encode(&out, image.NewRGBA(image.Rect(0, 0, 2, 2))))
	return out.Bytes()
}

func attachmentPath(id uuid.UUID) string { return "/api/bot/v1/attachments/" + id.String() }

func (e *botTestEnv) rawAttachment(t *testing.T, id uuid.UUID) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, e.ts.URL+attachmentPath(id), nil)
	require.NoError(t, err)
	req.Header.Set("Authorization", "Bearer "+e.token)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func (e *botTestEnv) assertAttachment(t *testing.T, id uuid.UUID, data []byte, mimeType, fileName string) {
	t.Helper()
	getsBefore, closesBefore := e.attachments.counts()
	resp := e.rawAttachment(t, id)
	raw, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, resp.StatusCode, "body: %s", raw)
	assert.Equal(t, data, raw)
	assert.Equal(t, mimeType, resp.Header.Get("Content-Type"))
	assert.Equal(t, strconv.Itoa(len(data)), resp.Header.Get("Content-Length"))
	assert.Equal(t, "private, no-store", resp.Header.Get("Cache-Control"))
	assert.Equal(t, "nosniff", resp.Header.Get("X-Content-Type-Options"))
	disposition, params, err := mime.ParseMediaType(resp.Header.Get("Content-Disposition"))
	require.NoError(t, err)
	assert.Equal(t, "attachment", disposition)
	assert.Equal(t, fileName, params["filename"])
	getsAfter, closesAfter := e.attachments.counts()
	assert.Equal(t, getsBefore+1, getsAfter)
	assert.Equal(t, closesBefore+1, closesAfter, "download reader must be closed")
}

func (e *botTestEnv) assertAttachmentError(t *testing.T, id uuid.UUID, status int, message string) {
	t.Helper()
	getsBefore, _ := e.attachments.counts()
	got, body := e.do(t, http.MethodGet, attachmentPath(id), e.token, nil)
	assert.Equal(t, status, got)
	assert.Equal(t, map[string]any{"error": message}, body)
	getsAfter, _ := e.attachments.counts()
	assert.Equal(t, getsBefore, getsAfter, "rejected attachment must not open storage")
}

func assertAttachmentMetadata(t *testing.T, value any, id uuid.UUID, fileName, mimeType string, size int) {
	t.Helper()
	assert.Equal(t, map[string]any{
		"attachment_id": id.String(), "file_name": fileName,
		"mime_type": mimeType, "file_size": float64(size),
	}, value, "only public attachment metadata should be exposed")
}

func (e *botTestEnv) attachmentTask(t *testing.T, actor uuid.UUID) tasks.TaskResponse {
	t.Helper()
	ctx := context.Background()
	tpl, err := e.tasks.CreateTemplate(ctx, tasks.CreateTemplateParams{Prefix: "BAT", SortOrder: 1, ActorID: actor})
	require.NoError(t, err)
	status, err := e.tasks.CreateStatus(ctx, tasks.CreateStatusParams{Code: "bot_attachment_open", Name: "Open", SortOrder: 1, ActorID: actor})
	require.NoError(t, err)
	task, err := e.tasks.CreateTask(ctx, tasks.CreateTaskParams{TemplateID: tpl.ID, Title: "Attachment task", StatusID: status.ID, ActorID: actor})
	require.NoError(t, err)
	return task
}

func (e *botTestEnv) attachmentDocument(t *testing.T, actor uuid.UUID) documents.DocumentResponse {
	t.Helper()
	ctx := context.Background()
	// Only admins may add a bot to a teamspace through the domain service.
	_, err := e.pool.Exec(ctx, `UPDATE users SET role = 'admin' WHERE id = $1`, actor)
	require.NoError(t, err)
	space, err := e.documents.CreateTeamspace(ctx, documents.CreateTeamspaceParams{
		Name: "Attachment docs", ActorID: actor, MemberIDs: []uuid.UUID{e.botID},
	}, "admin")
	require.NoError(t, err)
	doc, err := e.documents.CreateDocument(ctx, documents.CreateDocumentParams{
		TeamspaceID: space.ID, Title: "Document with files", ActorID: actor,
	})
	require.NoError(t, err)
	return doc
}

func (e *botTestEnv) uploadDocumentFile(t *testing.T, doc documents.DocumentResponse, actor uuid.UUID, data []byte, name, mimeType string) *documents.DocumentAttachmentRow {
	t.Helper()
	a, err := e.documents.UploadAttachment(context.Background(), documents.UploadAttachmentParams{
		DocumentID: doc.ID, ActorID: actor, FileName: name, MimeType: mimeType, Size: int64(len(data)), Body: bytes.NewReader(data),
	}, 50, nil)
	require.NoError(t, err)
	return a
}

func TestIntegration_BotAPI_Attachments_Messages(t *testing.T) {
	env := newBotEnv(t)
	ctx := context.Background()
	human := env.seedHuman(t, "Attachment author")
	channel := env.seedPublicChannel(t, human, "attachments")
	env.addMember(t, channel, human)
	imageBytes := botAttachmentPNG(t)
	textBytes := []byte("A non-image attachment\n")
	files := []struct {
		name, mimeType string
		data           []byte
	}{
		{"diagram.png", "image/png", imageBytes},
		{"notes.txt", "text/plain", textBytes},
	}
	ids := make([]uuid.UUID, 0, len(files))
	for _, f := range files {
		a, err := env.chat.UploadMessageAttachment(ctx, chat.UploadMessageAttachmentParams{
			ConversationID: channel, ActorID: human, FileName: f.name, MimeType: f.mimeType, Size: int64(len(f.data)), Body: bytes.NewReader(f.data),
		}, nil)
		require.NoError(t, err)
		ids = append(ids, a.ID)
		// Even the uploader's channel members cannot download unlinked files.
		env.assertAttachmentError(t, a.ID, http.StatusNotFound, "not found")
	}
	msg, err := env.chat.SendMessage(ctx, chat.SendMessageParams{
		ChannelID: channel, SenderID: human, ClientMsgID: "attachments", Body: "Files", AttachmentIDs: ids,
	})
	require.NoError(t, err)
	for _, id := range ids {
		env.assertAttachmentError(t, id, http.StatusForbidden, "forbidden")
	}
	_, err = env.pool.Exec(ctx, `UPDATE channels SET visibility = 'private' WHERE id = $1`, channel)
	require.NoError(t, err)
	env.assertAttachmentError(t, ids[0], http.StatusForbidden, "forbidden")
	env.addMember(t, channel, env.botID)
	status, body := env.do(t, http.MethodGet, "/api/bot/v1/messages?conversation_id="+channel.String(), env.token, nil)
	require.Equal(t, http.StatusOK, status)
	messages := body["messages"].([]any)
	require.Len(t, messages, 1)
	metadata := messages[0].(map[string]any)["attachments"].([]any)
	require.Len(t, metadata, 2)
	for i, f := range files {
		assertAttachmentMetadata(t, metadata[i], ids[i], f.name, f.mimeType, len(f.data))
		discoveredID := uuid.MustParse(metadata[i].(map[string]any)["attachment_id"].(string))
		env.assertAttachment(t, discoveredID, f.data, f.mimeType, f.name)
	}
	// Message event protobuf JSON stays camelCase, including attachment IDs.
	status, body = env.do(t, http.MethodGet, "/api/bot/v1/events", env.token, nil)
	require.Equal(t, http.StatusOK, status)
	found := false
	for _, event := range eventsOf(body) {
		if event["event_type"] != "message_created" {
			continue
		}
		payload := event["payload"].(map[string]any)
		if payload["messageId"] == msg.MessageID.String() {
			attachments := payload["attachments"].([]any)
			require.Len(t, attachments, 2)
			assert.ElementsMatch(t, []string{ids[0].String(), ids[1].String()}, []string{
				attachments[0].(map[string]any)["attachmentId"].(string),
				attachments[1].(map[string]any)["attachmentId"].(string),
			})
			found = true
		}
	}
	assert.True(t, found, "message attachment IDs remain discoverable from events")
	_, err = env.pool.Exec(ctx, `UPDATE channel_members SET is_archived = true WHERE channel_id = $1 AND user_id = $2`, channel, env.botID)
	require.NoError(t, err)
	env.assertAttachmentError(t, ids[0], http.StatusForbidden, "forbidden")
	_, err = env.pool.Exec(ctx, `DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2`, channel, env.botID)
	require.NoError(t, err)
	env.assertAttachmentError(t, ids[0], http.StatusForbidden, "forbidden")
	env.addMember(t, channel, env.botID)
	_, err = env.pool.Exec(ctx, `DELETE FROM messages WHERE id = $1`, msg.MessageID)
	require.NoError(t, err)
	env.assertAttachmentError(t, ids[0], http.StatusNotFound, "not found")
}

func TestIntegration_BotAPI_Attachments_EncryptedDM(t *testing.T) {
	env := newBotEnv(t)
	ctx := context.Background()
	human := env.seedHuman(t, "DM author")
	dm, err := env.chat.CreateOrOpenDirectMessage(ctx, human, env.botID)
	require.NoError(t, err)
	data := botAttachmentPNG(t)
	a, err := env.chat.UploadMessageAttachment(ctx, chat.UploadMessageAttachmentParams{
		ConversationID: dm.DM.ConversationID, ActorID: human, FileName: "dm.png", MimeType: "image/png", Size: int64(len(data)), Body: bytes.NewReader(data),
	}, nil)
	require.NoError(t, err)
	msg, err := env.chat.SendMessage(ctx, chat.SendMessageParams{
		ChannelID: dm.DM.ConversationID, SenderID: human, ClientMsgID: "dm-file", Body: "File", AttachmentIDs: []uuid.UUID{a.ID},
	})
	require.NoError(t, err)
	env.assertAttachment(t, a.ID, data, "image/png", "dm.png")
	// Artificial memberships/data exercise the guard independently of the
	// normal encrypted-DM creation path, which excludes bots entirely.
	_, err = env.pool.Exec(ctx, `UPDATE channels SET encryption_mode = 'dm_pairwise_signal_v1' WHERE id = $1`, dm.DM.ConversationID)
	require.NoError(t, err)
	env.assertAttachmentError(t, a.ID, http.StatusForbidden, "forbidden")
	_, err = env.pool.Exec(ctx, `UPDATE channels SET encryption_mode = 'none' WHERE id = $1`, dm.DM.ConversationID)
	require.NoError(t, err)
	_, err = env.pool.Exec(ctx, `UPDATE messages SET content_mode = 'dm_pairwise_signal_v1' WHERE id = $1`, msg.MessageID)
	require.NoError(t, err)
	env.assertAttachmentError(t, a.ID, http.StatusForbidden, "forbidden")
}

func TestIntegration_BotAPI_Attachments_TaskComments(t *testing.T) {
	env := newBotEnv(t)
	ctx := context.Background()
	human := env.seedHuman(t, "Comment author")
	task := env.attachmentTask(t, human)
	path := "/api/bot/v1/tasks/" + task.PublicID + "/comments"
	status, body := env.do(t, http.MethodGet, path, env.token, nil)
	require.Equal(t, http.StatusOK, status)
	assert.Equal(t, []any{}, body["comments"])
	status, body = env.do(t, http.MethodPost, path, env.token, map[string]any{"body": "No files"})
	require.Equal(t, http.StatusCreated, status)
	assert.Equal(t, []any{}, body["attachments"])
	assert.Equal(t, float64(0), body["attachment_count"])
	imageBytes, textBytes := botAttachmentPNG(t), []byte("Comment file\n")
	imageFile, err := env.tasks.UploadCommentAttachment(ctx, tasks.UploadCommentAttachmentParams{
		TaskID: task.ID, ActorID: human, FileName: "comment.png", MimeType: "image/png", Size: int64(len(imageBytes)), Body: bytes.NewReader(imageBytes),
	}, 50)
	require.NoError(t, err)
	textFile, err := env.tasks.UploadCommentAttachment(ctx, tasks.UploadCommentAttachmentParams{
		TaskID: task.ID, ActorID: human, FileName: "comment.txt", MimeType: "text/plain", Size: int64(len(textBytes)), Body: bytes.NewReader(textBytes),
	}, 50)
	require.NoError(t, err)
	env.assertAttachmentError(t, imageFile.ID, http.StatusNotFound, "not found")
	comment, err := env.tasks.CreateComment(ctx, task.ID, human, "", imageFile.ID, textFile.ID)
	require.NoError(t, err)
	otherFile, err := env.tasks.UploadCommentAttachment(ctx, tasks.UploadCommentAttachmentParams{
		TaskID: task.ID, ActorID: human, FileName: "other.txt", MimeType: "text/plain", Size: int64(len(textBytes)), Body: bytes.NewReader(textBytes),
	}, 50)
	require.NoError(t, err)
	other, err := env.tasks.CreateComment(ctx, task.ID, human, "Another comment", otherFile.ID)
	require.NoError(t, err)
	// Events are notifications; follow the event's publicId to the list for IDs.
	status, body = env.do(t, http.MethodGet, "/api/bot/v1/events", env.token, nil)
	require.Equal(t, http.StatusOK, status)
	found := false
	for _, event := range eventsOf(body) {
		if event["event_type"] == "task_comment_created" {
			payload := event["payload"].(map[string]any)
			if payload["commentId"] == comment.ID.String() {
				assert.Equal(t, float64(2), payload["attachmentCount"])
				path = "/api/bot/v1/tasks/" + payload["publicId"].(string) + "/comments"
				found = true
			}
		}
	}
	require.True(t, found)
	status, body = env.do(t, http.MethodGet, path, env.token, nil)
	require.Equal(t, http.StatusOK, status)
	comments := body["comments"].([]any)
	require.Len(t, comments, 3)
	assert.Equal(t, []any{}, comments[0].(map[string]any)["attachments"])
	item := comments[1].(map[string]any)
	assert.Equal(t, comment.ID.String(), item["id"])
	assert.Equal(t, "", item["body"], "attachment-only comments are preserved")
	assert.Equal(t, float64(2), item["attachment_count"])
	metadata := item["attachments"].([]any)
	require.Len(t, metadata, 2)
	assertAttachmentMetadata(t, metadata[0], imageFile.ID, "comment.png", "image/png", len(imageBytes))
	assertAttachmentMetadata(t, metadata[1], textFile.ID, "comment.txt", "text/plain", len(textBytes))
	assert.Equal(t, other.ID.String(), comments[2].(map[string]any)["id"])
	otherMetadata := comments[2].(map[string]any)["attachments"].([]any)
	require.Len(t, otherMetadata, 1)
	assertAttachmentMetadata(t, otherMetadata[0], otherFile.ID, "other.txt", "text/plain", len(textBytes))
	for i, data := range [][]byte{imageBytes, textBytes} {
		a := metadata[i].(map[string]any)
		env.assertAttachment(t, uuid.MustParse(a["attachment_id"].(string)), data, a["mime_type"].(string), a["file_name"].(string))
	}
	thread, err := env.tasks.EnsureCommentThread(ctx, task.ID, comment.ID, human)
	require.NoError(t, err)
	_, err = env.pool.Exec(ctx, `UPDATE channel_members SET is_archived = true WHERE channel_id = $1 AND user_id = $2`, thread.ConversationID, env.botID)
	require.NoError(t, err)
	// Losing discussion access must not invent a task-comment ACL.
	env.assertAttachment(t, imageFile.ID, imageBytes, "image/png", "comment.png")
	status, body = env.do(t, http.MethodGet, path, env.token, nil)
	require.Equal(t, http.StatusOK, status)
	require.Len(t, body["comments"].([]any), 3)
	// Other task attachment kinds deliberately remain outside the contract.
	direct, err := env.tasks.UploadAttachment(ctx, tasks.UploadAttachmentParams{
		TaskID: task.ID, ActorID: human, FileName: "task.png", MimeType: "image/png", Size: int64(len(imageBytes)), Body: bytes.NewReader(imageBytes),
	}, 50, nil)
	require.NoError(t, err)
	env.assertAttachmentError(t, direct.ID, http.StatusNotFound, "not found")
	draft, err := env.tasks.UploadTaskStagedAttachment(ctx, tasks.UploadTaskStagedAttachmentParams{
		ActorID: human, FileName: "draft.png", MimeType: "image/png", Size: int64(len(imageBytes)), Body: bytes.NewReader(imageBytes),
	}, 50)
	require.NoError(t, err)
	env.assertAttachmentError(t, draft.ID, http.StatusNotFound, "not found")
	_, err = env.pool.Exec(ctx, `DELETE FROM task_comment WHERE id = $1`, comment.ID)
	require.NoError(t, err)
	env.assertAttachmentError(t, imageFile.ID, http.StatusNotFound, "not found")
}

func TestIntegration_BotAPI_Attachments_Documents(t *testing.T) {
	env := newBotEnv(t)
	ctx := context.Background()
	human := env.seedHuman(t, "Document author")
	doc := env.attachmentDocument(t, human)
	path := "/api/bot/v1/documents/" + doc.ID.String()
	status, body := env.do(t, http.MethodGet, path, env.token, nil)
	require.Equal(t, http.StatusOK, status)
	assert.Equal(t, []any{}, body["attachments"])
	imageBytes, textBytes := botAttachmentPNG(t), []byte("Document file\n")
	imageFile := env.uploadDocumentFile(t, doc, human, imageBytes, "document.png", "image/png")
	textName := "notes \"été\".txt"
	textFile := env.uploadDocumentFile(t, doc, human, textBytes, textName, "text/plain")
	status, body = env.do(t, http.MethodGet, path, env.token, nil)
	require.Equal(t, http.StatusOK, status)
	assert.Equal(t, doc.Title, body["title"])
	assert.Equal(t, doc.TeamspaceID.String(), body["teamspace_id"])
	metadata := body["attachments"].([]any)
	require.Len(t, metadata, 2)
	assertAttachmentMetadata(t, metadata[0], imageFile.ID, "document.png", "image/png", len(imageBytes))
	assertAttachmentMetadata(t, metadata[1], textFile.ID, textName, "text/plain", len(textBytes))
	for i, data := range [][]byte{imageBytes, textBytes} {
		a := metadata[i].(map[string]any)
		env.assertAttachment(t, uuid.MustParse(a["attachment_id"].(string)), data, a["mime_type"].(string), a["file_name"].(string))
	}
	// Storage metadata has precedence; when absent, fall back to the DB MIME.
	env.attachments.changeObject(imageFile.StorageKey, "image/x-png", nil)
	env.assertAttachment(t, imageFile.ID, imageBytes, "image/x-png", "document.png")
	env.attachments.changeObject(imageFile.StorageKey, "", nil)
	env.assertAttachment(t, imageFile.ID, imageBytes, "image/png", "document.png")
	_, err := env.pool.Exec(ctx, `UPDATE document_attachment SET mime_type = '', file_size = 999 WHERE id = $1`, imageFile.ID)
	require.NoError(t, err)
	env.assertAttachment(t, imageFile.ID, imageBytes, "application/octet-stream", "document.png")
	// The length comes from the actual object, not stale DB metadata.
	_, err = env.pool.Exec(ctx, `DELETE FROM teamspace_member WHERE teamspace_id = $1 AND user_id = $2`, doc.TeamspaceID, env.botID)
	require.NoError(t, err)
	env.assertAttachmentError(t, imageFile.ID, http.StatusForbidden, "forbidden")
	status, body = env.do(t, http.MethodGet, path, env.token, nil)
	assert.Equal(t, http.StatusForbidden, status)
	assert.NotContains(t, body, "attachments")
	assert.NotContains(t, body, "content_markdown")
	_, err = env.pool.Exec(ctx, `INSERT INTO teamspace_member (teamspace_id, user_id) VALUES ($1, $2)`, doc.TeamspaceID, env.botID)
	require.NoError(t, err)
	_, err = env.pool.Exec(ctx, `UPDATE document SET archived_at = now() WHERE id = $1`, doc.ID)
	require.NoError(t, err)
	env.assertAttachmentError(t, imageFile.ID, http.StatusNotFound, "not found")
	status, _ = env.do(t, http.MethodGet, path, env.token, nil)
	assert.Equal(t, http.StatusNotFound, status)
	_, err = env.pool.Exec(ctx, `UPDATE document SET archived_at = NULL WHERE id = $1`, doc.ID)
	require.NoError(t, err)
	_, err = env.pool.Exec(ctx, `UPDATE teamspace SET deleted_at = now() WHERE id = $1`, doc.TeamspaceID)
	require.NoError(t, err)
	env.assertAttachmentError(t, imageFile.ID, http.StatusNotFound, "not found")
	status, _ = env.do(t, http.MethodGet, path, env.token, nil)
	assert.Equal(t, http.StatusNotFound, status)
	_, err = env.pool.Exec(ctx, `DELETE FROM document WHERE id = $1`, doc.ID)
	require.NoError(t, err)
	env.assertAttachmentError(t, imageFile.ID, http.StatusNotFound, "not found")
}

func TestIntegration_BotAPI_Attachments_AuthAndErrors(t *testing.T) {
	env := newBotEnv(t)
	ctx := context.Background()
	human := env.seedHuman(t, "File author")
	doc := env.attachmentDocument(t, human)
	data := []byte("test file content")
	a := env.uploadDocumentFile(t, doc, human, data, "auth.txt", "text/plain")
	getsBefore, _ := env.attachments.counts()
	for _, tc := range []struct {
		name, method, path, token, message string
		status                             int
	}{
		{"missing token", http.MethodGet, attachmentPath(a.ID), "", "missing token", http.StatusUnauthorized},
		{"invalid token", http.MethodGet, attachmentPath(a.ID), "invalid", "invalid token", http.StatusUnauthorized},
		{"invalid id", http.MethodGet, "/api/bot/v1/attachments/invalid", env.token, "invalid attachment id", http.StatusBadRequest},
		{"empty id", http.MethodGet, "/api/bot/v1/attachments/", env.token, "invalid attachment id", http.StatusBadRequest},
		{"unknown id", http.MethodGet, attachmentPath(uuid.New()), env.token, "not found", http.StatusNotFound},
		{"extra path", http.MethodGet, attachmentPath(a.ID) + "/download", env.token, "not found", http.StatusNotFound},
		{"trailing slash", http.MethodGet, attachmentPath(a.ID) + "/", env.token, "not found", http.StatusNotFound},
		{"no upload", http.MethodPost, attachmentPath(a.ID), env.token, "method not allowed", http.StatusMethodNotAllowed},
		{"no delete", http.MethodDelete, attachmentPath(a.ID), env.token, "method not allowed", http.StatusMethodNotAllowed},
		{"no update", http.MethodPatch, attachmentPath(a.ID), env.token, "method not allowed", http.StatusMethodNotAllowed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status, body := env.do(t, tc.method, tc.path, tc.token, nil)
			assert.Equal(t, tc.status, status)
			assert.Equal(t, map[string]any{"error": tc.message}, body)
		})
	}
	_, err := env.pool.Exec(ctx, `UPDATE integration_token SET revoked_at = now() WHERE user_id = $1`, env.botID)
	require.NoError(t, err)
	status, body := env.do(t, http.MethodGet, attachmentPath(a.ID), env.token, nil)
	assert.Equal(t, http.StatusUnauthorized, status)
	assert.Equal(t, "invalid token", body["error"])
	_, err = env.pool.Exec(ctx, `UPDATE integration_token SET revoked_at = NULL WHERE user_id = $1`, env.botID)
	require.NoError(t, err)
	_, err = env.pool.Exec(ctx, `UPDATE users SET status = 'blocked' WHERE id = $1`, env.botID)
	require.NoError(t, err)
	status, body = env.do(t, http.MethodGet, attachmentPath(a.ID), env.token, nil)
	assert.Equal(t, http.StatusUnauthorized, status)
	assert.Equal(t, "invalid token", body["error"])
	getsAfter, _ := env.attachments.counts()
	assert.Equal(t, getsBefore, getsAfter, "auth/path/method failures never open storage")
	_, err = env.pool.Exec(ctx, `UPDATE users SET status = 'active' WHERE id = $1`, env.botID)
	require.NoError(t, err)
	env.assertAttachment(t, a.ID, data, "text/plain", "auth.txt")

	// The same UUID in an unlinked upload does not hide the linked document.
	task := env.attachmentTask(t, human)
	comment, err := env.tasks.CreateComment(ctx, task.ID, human, "Collision fixture")
	require.NoError(t, err)
	_, err = env.pool.Exec(ctx, `INSERT INTO task_comment_attachment
		(id, task_id, file_name, file_size, mime_type, storage_key, uploaded_by)
		VALUES ($1, $2, 'collision.txt', 10, 'text/plain', 'must-not-open', $3)`, a.ID, task.ID, human)
	require.NoError(t, err)
	env.assertAttachment(t, a.ID, data, "text/plain", "auth.txt")
	_, err = env.pool.Exec(ctx, `UPDATE task_comment_attachment SET comment_id = $1 WHERE id = $2`, comment.ID, a.ID)
	require.NoError(t, err)
	env.assertAttachmentError(t, a.ID, http.StatusInternalServerError, "internal error")
	_, err = env.pool.Exec(ctx, `DELETE FROM task_comment_attachment WHERE id = $1`, a.ID)
	require.NoError(t, err)
	// A missing storage object is an internal error, not an unknown DB ID.
	require.NoError(t, env.attachments.DeleteObject(ctx, a.StorageKey))
	status, body = env.do(t, http.MethodGet, attachmentPath(a.ID), env.token, nil)
	assert.Equal(t, http.StatusInternalServerError, status)
	assert.Equal(t, map[string]any{"error": "internal error"}, body)
}

func TestIntegration_BotAPI_Attachments_CopyFailureClosesReader(t *testing.T) {
	env := newBotEnv(t)
	human := env.seedHuman(t, "Read error author")
	doc := env.attachmentDocument(t, human)
	a := env.uploadDocumentFile(t, doc, human, []byte("more than one byte"), "error.txt", "text/plain")
	env.attachments.changeObject(a.StorageKey, "text/plain", errors.New("injected read failure"))
	_, closesBefore := env.attachments.counts()
	resp := env.rawAttachment(t, a.ID)
	raw, err := io.ReadAll(resp.Body)
	assert.Equal(t, http.StatusOK, resp.StatusCode, "headers were sent before the storage read failed")
	assert.ErrorIs(t, err, io.ErrUnexpectedEOF)
	assert.Equal(t, []byte("m"), raw, "a JSON error must not be appended to partial file bytes")
	_, closesAfter := env.attachments.counts()
	assert.Equal(t, closesBefore+1, closesAfter)
}
