package chat

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"mime"
	"path"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	packetspb "msgnr/internal/gen/proto"
	"msgnr/internal/gen/queries"
)

// ByteCounter reports bytes consumed by a streaming upload reader.
type ByteCounter interface {
	BytesRead() int64
}

type storedMessageThumbnail struct {
	StorageKey string
	MimeType   string
	FileSize   int64
	Version    int16
}

// UploadMessageAttachment stores a staged attachment for a conversation.
func (s *Service) UploadMessageAttachment(ctx context.Context, p UploadMessageAttachmentParams, counter ByteCounter) (*MessageAttachment, error) {
	if s.attachmentStore == nil {
		return nil, ErrAttachmentStoreUnavailable
	}
	if strings.TrimSpace(p.FileName) == "" {
		return nil, fmt.Errorf("%w: file_name is required", ErrInvalidAttachment)
	}
	if p.MimeType == "" {
		p.MimeType = "application/octet-stream"
	}
	if p.Size < 0 {
		return nil, fmt.Errorf("%w: file size must be provided", ErrInvalidAttachment)
	}

	isMember, err := s.q.IsChannelMember(ctx, queries.IsChannelMemberParams{
		ChannelID: p.ConversationID,
		UserID:    p.ActorID,
	})
	if err != nil {
		return nil, fmt.Errorf("chat.UploadMessageAttachment membership check: %w", err)
	}
	if !isMember {
		return nil, ErrNotMember
	}

	maxBytes := int64(s.attachmentMaxSizeMB) * 1024 * 1024
	if p.Size > maxBytes {
		return nil, fmt.Errorf("%w: file exceeds maximum allowed size of %d MB", ErrInvalidAttachment, s.attachmentMaxSizeMB)
	}

	attachmentID := uuid.New()
	safeName := sanitiseFileNameForStorageKey(p.FileName)
	storageKey := fmt.Sprintf("chat/%s/%s/%s", p.ConversationID, attachmentID, safeName)
	if err := s.attachmentStore.PutObject(ctx, storageKey, p.Body, p.Size, p.MimeType); err != nil {
		return nil, fmt.Errorf("chat.UploadMessageAttachment put object: %w", err)
	}

	actualSize := p.Size
	if counter != nil {
		actualSize = counter.BytesRead()
		if actualSize != p.Size {
			if err := s.attachmentStore.DeleteObject(ctx, storageKey); err != nil {
				s.log.Warn("chat.UploadMessageAttachment failed to delete orphaned object",
					zap.String("storage_key", storageKey),
					zap.Error(err))
			}
			return nil, fmt.Errorf("%w: uploaded size mismatch", ErrInvalidAttachment)
		}
	}
	if actualSize > maxBytes {
		if err := s.attachmentStore.DeleteObject(ctx, storageKey); err != nil {
			s.log.Warn("chat.UploadMessageAttachment failed to delete orphaned object",
				zap.String("storage_key", storageKey),
				zap.Error(err))
		}
		return nil, fmt.Errorf("%w: file exceeds maximum allowed size of %d MB", ErrInvalidAttachment, s.attachmentMaxSizeMB)
	}

	thumbnail, thumbnailErr := s.generateAndStoreMessageThumbnail(ctx, attachmentID, storageKey, p.MimeType, actualSize)
	if thumbnailErr != nil {
		s.logThumbnailGenerationFailure(attachmentID, actualSize, thumbnailErr)
	}

	created, err := s.q.CreateStagedMessageAttachment(ctx, queries.CreateStagedMessageAttachmentParams{
		ID:                  attachmentID,
		ConversationID:      p.ConversationID,
		FileName:            p.FileName,
		FileSize:            actualSize,
		MimeType:            p.MimeType,
		StorageKey:          storageKey,
		ThumbnailStorageKey: nullableString(thumbnail.StorageKey),
		ThumbnailMimeType:   nullableString(thumbnail.MimeType),
		ThumbnailFileSize:   nullableInt64(thumbnail.FileSize, thumbnail.StorageKey != ""),
		ThumbnailVersion:    nullableInt16(thumbnail.Version, thumbnail.StorageKey != ""),
		UploadedBy:          p.ActorID,
	})
	if err != nil {
		s.deleteOrphanedMessageAttachmentObjects(ctx, attachmentID, storageKey, thumbnail.StorageKey)
		return nil, fmt.Errorf("chat.UploadMessageAttachment insert row: %w", err)
	}

	attachment := messageAttachmentFromQuery(created)
	return &attachment, nil
}

// DeleteStagedMessageAttachment removes an unsent attachment uploaded by the actor.
func (s *Service) DeleteStagedMessageAttachment(ctx context.Context, actorID, attachmentID uuid.UUID) error {
	if s.attachmentStore == nil {
		return ErrAttachmentStoreUnavailable
	}

	row, err := s.getMessageAttachment(ctx, attachmentID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrAttachmentNotFound
		}
		return fmt.Errorf("chat.DeleteStagedMessageAttachment load row: %w", err)
	}
	if row.UploadedBy != actorID {
		return ErrAttachmentOwnership
	}
	if row.MessageID != uuid.Nil {
		return ErrAttachmentNotStaged
	}

	if err := s.q.DeleteStagedMessageAttachment(ctx, attachmentID); err != nil {
		return fmt.Errorf("chat.DeleteStagedMessageAttachment delete row: %w", err)
	}
	s.cleanupDeletedAttachments([]MessageAttachment{row})
	return nil
}

// DownloadMessageAttachment opens an attachment stream when the requester has
// access to the attachment's conversation and the attachment belongs to messageID.
func (s *Service) DownloadMessageAttachment(
	ctx context.Context,
	requesterID, messageID, attachmentID uuid.UUID,
) (body io.ReadCloser, size int64, mimeType, fileName string, err error) {
	if s.attachmentStore == nil {
		return nil, 0, "", "", ErrAttachmentStoreUnavailable
	}

	row, err := s.getMessageAttachment(ctx, attachmentID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, 0, "", "", ErrAttachmentNotFound
		}
		return nil, 0, "", "", fmt.Errorf("chat.DownloadMessageAttachment load row: %w", err)
	}
	if row.MessageID == uuid.Nil || row.MessageID != messageID {
		return nil, 0, "", "", ErrAttachmentNotFound
	}

	isMember, err := s.q.IsChannelMember(ctx, queries.IsChannelMemberParams{
		ChannelID: row.ConversationID,
		UserID:    requesterID,
	})
	if err != nil {
		return nil, 0, "", "", fmt.Errorf("chat.DownloadMessageAttachment membership check: %w", err)
	}
	if !isMember {
		return nil, 0, "", "", ErrNotMember
	}

	obj, objSize, objMimeType, err := s.attachmentStore.GetObject(ctx, row.StorageKey)
	if err != nil {
		return nil, 0, "", "", fmt.Errorf("chat.DownloadMessageAttachment get object: %w", err)
	}
	if objMimeType == "" {
		objMimeType = row.MimeType
	}
	return obj, objSize, objMimeType, row.FileName, nil
}

// DownloadMessageAttachmentThumbnail opens the v1 thumbnail for a linked
// image attachment when the requester is still a member of its conversation.
func (s *Service) DownloadMessageAttachmentThumbnail(
	ctx context.Context,
	requesterID, messageID, attachmentID uuid.UUID,
) (body io.ReadCloser, size int64, mimeType string, version int16, err error) {
	if s.attachmentStore == nil {
		return nil, 0, "", 0, ErrAttachmentStoreUnavailable
	}

	row, err := s.getMessageAttachment(ctx, attachmentID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, 0, "", 0, ErrAttachmentNotFound
		}
		return nil, 0, "", 0, fmt.Errorf("chat.DownloadMessageAttachmentThumbnail load row: %w", err)
	}
	if row.MessageID == uuid.Nil || row.MessageID != messageID || row.ThumbnailStorageKey == "" || row.ThumbnailVersion != thumbnailVersion {
		return nil, 0, "", 0, ErrAttachmentNotFound
	}

	isMember, err := s.q.IsChannelMember(ctx, queries.IsChannelMemberParams{
		ChannelID: row.ConversationID,
		UserID:    requesterID,
	})
	if err != nil {
		return nil, 0, "", 0, fmt.Errorf("chat.DownloadMessageAttachmentThumbnail membership check: %w", err)
	}
	if !isMember {
		return nil, 0, "", 0, ErrNotMember
	}

	obj, objSize, objMimeType, err := s.attachmentStore.GetObject(ctx, row.ThumbnailStorageKey)
	if err != nil {
		return nil, 0, "", 0, fmt.Errorf("chat.DownloadMessageAttachmentThumbnail get object: %w", err)
	}
	if objMimeType == "" {
		objMimeType = row.ThumbnailMimeType
	}
	return obj, objSize, objMimeType, row.ThumbnailVersion, nil
}

func (s *Service) lockAndValidateStagedAttachmentsTx(
	ctx context.Context,
	tx pgx.Tx,
	conversationID, senderID uuid.UUID,
	attachmentIDs []uuid.UUID,
) ([]MessageAttachment, error) {
	uniqueIDs := uniqueUUIDs(attachmentIDs)
	if len(uniqueIDs) == 0 {
		return []MessageAttachment{}, nil
	}

	// ORDER BY id enforces a deterministic lock order so concurrent sends
	// referencing overlapping attachment IDs cannot deadlock.
	rows, err := tx.Query(ctx, `
		SELECT id, conversation_id, message_id, file_name, file_size, mime_type, storage_key,
		       thumbnail_storage_key, thumbnail_mime_type, thumbnail_file_size, thumbnail_version,
		       uploaded_by, created_at
		  FROM message_attachment
		 WHERE id = ANY($1::uuid[])
		 ORDER BY id
		 FOR UPDATE`,
		uniqueIDs,
	)
	if err != nil {
		return nil, fmt.Errorf("chat.lockAndValidateStagedAttachmentsTx query: %w", err)
	}
	defer rows.Close()

	attachments := make([]MessageAttachment, 0, len(uniqueIDs))
	for rows.Next() {
		row, err := scanMessageAttachment(rows)
		if err != nil {
			return nil, fmt.Errorf("chat.lockAndValidateStagedAttachmentsTx scan: %w", err)
		}
		switch {
		case row.ConversationID != conversationID:
			return nil, ErrInvalidAttachment
		case row.UploadedBy != senderID:
			return nil, ErrAttachmentOwnership
		case row.MessageID != uuid.Nil:
			return nil, ErrAttachmentNotStaged
		}
		attachments = append(attachments, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("chat.lockAndValidateStagedAttachmentsTx rows: %w", err)
	}
	if len(attachments) != len(uniqueIDs) {
		return nil, ErrAttachmentNotFound
	}
	return attachments, nil
}

func (s *Service) loadMessageAttachmentsByMessageIDsTx(
	ctx context.Context,
	tx pgx.Tx,
	messageIDs []uuid.UUID,
) (map[uuid.UUID][]MessageAttachment, error) {
	result := make(map[uuid.UUID][]MessageAttachment)
	if len(messageIDs) == 0 {
		return result, nil
	}

	rows, err := tx.Query(ctx, `
		SELECT id, conversation_id, message_id, file_name, file_size, mime_type, storage_key,
		       thumbnail_storage_key, thumbnail_mime_type, thumbnail_file_size, thumbnail_version,
		       uploaded_by, created_at
		  FROM message_attachment
		 WHERE message_id = ANY($1::uuid[])
		 ORDER BY created_at ASC, id ASC`,
		messageIDs,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		row, err := scanMessageAttachment(rows)
		if err != nil {
			return nil, err
		}
		if row.MessageID == uuid.Nil {
			continue
		}
		result[row.MessageID] = append(result[row.MessageID], row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *Service) getMessageAttachment(ctx context.Context, attachmentID uuid.UUID) (MessageAttachment, error) {
	attachment, err := s.q.GetMessageAttachmentByID(ctx, attachmentID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return MessageAttachment{}, sql.ErrNoRows
		}
		return MessageAttachment{}, err
	}
	return messageAttachmentFromQuery(attachment), nil
}

type attachmentScanner interface {
	Scan(dest ...any) error
}

func scanMessageAttachment(scanner attachmentScanner) (MessageAttachment, error) {
	var item MessageAttachment
	var messageID uuid.NullUUID
	var thumbnailStorageKey sql.NullString
	var thumbnailMimeType sql.NullString
	var thumbnailFileSize sql.NullInt64
	var thumbnailVersionValue sql.NullInt16
	err := scanner.Scan(
		&item.ID,
		&item.ConversationID,
		&messageID,
		&item.FileName,
		&item.FileSize,
		&item.MimeType,
		&item.StorageKey,
		&thumbnailStorageKey,
		&thumbnailMimeType,
		&thumbnailFileSize,
		&thumbnailVersionValue,
		&item.UploadedBy,
		&item.CreatedAt,
	)
	if err != nil {
		return MessageAttachment{}, err
	}
	if messageID.Valid {
		item.MessageID = messageID.UUID
	}
	if thumbnailStorageKey.Valid {
		item.ThumbnailStorageKey = thumbnailStorageKey.String
	}
	if thumbnailMimeType.Valid {
		item.ThumbnailMimeType = thumbnailMimeType.String
	}
	if thumbnailFileSize.Valid {
		item.ThumbnailFileSize = thumbnailFileSize.Int64
	}
	if thumbnailVersionValue.Valid {
		item.ThumbnailVersion = thumbnailVersionValue.Int16
	}
	return item, nil
}

func messageAttachmentFromQuery(item queries.MessageAttachment) MessageAttachment {
	attachment := MessageAttachment{
		ID:             item.ID,
		ConversationID: item.ConversationID,
		FileName:       item.FileName,
		FileSize:       item.FileSize,
		MimeType:       item.MimeType,
		StorageKey:     item.StorageKey,
		UploadedBy:     item.UploadedBy,
		CreatedAt:      item.CreatedAt,
	}
	if item.MessageID.Valid {
		attachment.MessageID = item.MessageID.UUID
	}
	if item.ThumbnailStorageKey.Valid {
		attachment.ThumbnailStorageKey = item.ThumbnailStorageKey.String
	}
	if item.ThumbnailMimeType.Valid {
		attachment.ThumbnailMimeType = item.ThumbnailMimeType.String
	}
	if item.ThumbnailFileSize.Valid {
		attachment.ThumbnailFileSize = item.ThumbnailFileSize.Int64
	}
	if item.ThumbnailVersion.Valid {
		attachment.ThumbnailVersion = item.ThumbnailVersion.Int16
	}
	return attachment
}

func toProtoMessageAttachments(items []MessageAttachment) []*packetspb.MessageAttachment {
	if len(items) == 0 {
		return nil
	}
	out := make([]*packetspb.MessageAttachment, 0, len(items))
	for _, item := range items {
		out = append(out, &packetspb.MessageAttachment{
			AttachmentId:      item.ID.String(),
			FileName:          item.FileName,
			FileSize:          item.FileSize,
			MimeType:          item.MimeType,
			ThumbnailMimeType: item.ThumbnailMimeType,
			ThumbnailFileSize: item.ThumbnailFileSize,
			ThumbnailVersion:  int32(item.ThumbnailVersion),
		})
	}
	return out
}

func uniqueUUIDs(ids []uuid.UUID) []uuid.UUID {
	if len(ids) == 0 {
		return nil
	}
	seen := make(map[uuid.UUID]struct{}, len(ids))
	unique := make([]uuid.UUID, 0, len(ids))
	for _, id := range ids {
		if id == uuid.Nil {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		unique = append(unique, id)
	}
	return unique
}

func sanitiseFileNameForStorageKey(name string) string {
	name = strings.NewReplacer("/", "_", "\\", "_").Replace(name)
	var b strings.Builder
	for _, r := range name {
		if r <= 0x1f || r == 0x7f {
			continue
		}
		b.WriteRune(r)
	}
	result := b.String()
	if result == "" {
		return "file"
	}
	return result
}

func nullableString(value string) sql.NullString {
	return sql.NullString{String: value, Valid: strings.TrimSpace(value) != ""}
}

func nullableInt64(value int64, valid bool) sql.NullInt64 {
	return sql.NullInt64{Int64: value, Valid: valid}
}

func nullableInt16(value int16, valid bool) sql.NullInt16 {
	return sql.NullInt16{Int16: value, Valid: valid}
}

func isThumbnailCandidateMimeType(value string) bool {
	mediaType, _, err := mime.ParseMediaType(value)
	if err != nil {
		return false
	}
	switch strings.ToLower(mediaType) {
	case "image/jpeg", "image/png", "image/webp", "image/gif":
		return true
	default:
		return false
	}
}

func (s *Service) generateAndStoreMessageThumbnail(
	ctx context.Context,
	attachmentID uuid.UUID,
	storageKey, mimeType string,
	originalSize int64,
) (storedMessageThumbnail, error) {
	if !isThumbnailCandidateMimeType(mimeType) {
		return storedMessageThumbnail{}, nil
	}

	startedAt := time.Now()
	body, _, _, err := s.attachmentStore.GetObject(ctx, storageKey)
	if err != nil {
		return storedMessageThumbnail{}, fmt.Errorf("open original image: %w", err)
	}
	thumbnail, generationErr := generateImageThumbnail(body)
	closeErr := body.Close()
	if generationErr != nil {
		return storedMessageThumbnail{}, generationErr
	}
	if closeErr != nil {
		return storedMessageThumbnail{}, fmt.Errorf("close original image: %w", closeErr)
	}
	if len(thumbnail.Data) == 0 || thumbnail.MimeType == "" || thumbnail.Extension == "" {
		return storedMessageThumbnail{}, errors.New("thumbnail generator returned an empty result")
	}

	thumbnailKey := path.Join(path.Dir(storageKey), fmt.Sprintf("thumbnail-v%d.%s", thumbnailVersion, thumbnail.Extension))
	if err := s.attachmentStore.PutObject(ctx, thumbnailKey, bytes.NewReader(thumbnail.Data), int64(len(thumbnail.Data)), thumbnail.MimeType); err != nil {
		if cleanupErr := s.attachmentStore.DeleteObject(ctx, thumbnailKey); cleanupErr != nil {
			s.log.Warn("chat image thumbnail orphan cleanup failed",
				zap.String("attachment_id", attachmentID.String()),
				zap.String("reason", "thumbnail_storage"))
		}
		return storedMessageThumbnail{}, fmt.Errorf("store thumbnail: %w", err)
	}

	s.log.Info("chat image thumbnail generated",
		zap.String("attachment_id", attachmentID.String()),
		zap.Int64("input_bytes", originalSize),
		zap.Int64("output_bytes", int64(len(thumbnail.Data))),
		zap.Int("width", thumbnail.Width),
		zap.Int("height", thumbnail.Height),
		zap.Duration("duration", time.Since(startedAt)))
	return storedMessageThumbnail{
		StorageKey: thumbnailKey,
		MimeType:   thumbnail.MimeType,
		FileSize:   int64(len(thumbnail.Data)),
		Version:    thumbnailVersion,
	}, nil
}

func (s *Service) logThumbnailGenerationFailure(attachmentID uuid.UUID, inputBytes int64, err error) {
	reason := "processing"
	switch {
	case errors.Is(err, errUnsupportedThumbnailImage):
		reason = "unsupported"
	case errors.Is(err, errThumbnailSourceTooLarge):
		reason = "source_too_large"
	case errors.Is(err, errThumbnailImageTooLarge):
		reason = "image_too_large"
	}
	s.log.Warn("chat image thumbnail generation skipped",
		zap.String("attachment_id", attachmentID.String()),
		zap.Int64("input_bytes", inputBytes),
		zap.String("reason", reason))
}

func (s *Service) deleteOrphanedMessageAttachmentObjects(ctx context.Context, attachmentID uuid.UUID, keys ...string) {
	seen := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		if err := s.attachmentStore.DeleteObject(ctx, key); err != nil {
			s.log.Warn("chat message attachment orphan cleanup failed",
				zap.String("attachment_id", attachmentID.String()),
				zap.String("reason", "storage_delete"))
		}
	}
}

func (s *Service) listMessageAttachmentsForDeleteTargetTx(ctx context.Context, tx pgx.Tx, messageID uuid.UUID) ([]MessageAttachment, error) {
	rows, err := tx.Query(ctx, `
		SELECT ma.id,
		       ma.conversation_id,
		       ma.message_id,
		       ma.file_name,
		       ma.file_size,
		       ma.mime_type,
		       ma.storage_key,
		       ma.thumbnail_storage_key,
		       ma.thumbnail_mime_type,
		       ma.thumbnail_file_size,
		       ma.thumbnail_version,
		       ma.uploaded_by,
		       ma.created_at
		  FROM message_attachment ma
		 WHERE ma.message_id IN (
		   SELECT m.id
		     FROM messages m
		    WHERE m.id = $1
		       OR m.thread_root_id = $1
		 )
		 ORDER BY ma.created_at, ma.id`,
		messageID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]MessageAttachment, 0)
	for rows.Next() {
		row, err := scanMessageAttachment(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

func (s *Service) listMessageAttachmentsForConversationDeleteTx(ctx context.Context, tx pgx.Tx, conversationID uuid.UUID) ([]MessageAttachment, error) {
	rows, err := tx.Query(ctx, `
		SELECT ma.id,
		       ma.conversation_id,
		       ma.message_id,
		       ma.file_name,
		       ma.file_size,
		       ma.mime_type,
		       ma.storage_key,
		       ma.thumbnail_storage_key,
		       ma.thumbnail_mime_type,
		       ma.thumbnail_file_size,
		       ma.thumbnail_version,
		       ma.uploaded_by,
		       ma.created_at
		  FROM message_attachment ma
		  JOIN messages m ON m.id = ma.message_id
		 WHERE m.channel_id = $1
		 ORDER BY ma.created_at, ma.id`,
		conversationID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]MessageAttachment, 0)
	for rows.Next() {
		row, err := scanMessageAttachment(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

func (s *Service) cleanupDeletedAttachments(items []MessageAttachment) {
	if s.attachmentStore == nil || len(items) == 0 {
		return
	}

	keys := make([]string, 0, len(items)*2)
	seen := make(map[string]struct{}, len(items)*2)
	for _, item := range items {
		for _, key := range []string{item.StorageKey, item.ThumbnailStorageKey} {
			key = strings.TrimSpace(key)
			if key == "" {
				continue
			}
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			keys = append(keys, key)
		}
	}
	if len(keys) == 0 {
		return
	}

	go s.cleanupUnreferencedAttachmentObjects(context.Background(), keys)
}

func (s *Service) cleanupUnreferencedAttachmentObjects(ctx context.Context, objectKeys []string) {
	if s.attachmentStore == nil {
		return
	}
	for _, key := range objectKeys {
		var referenced bool
		if err := s.pool.QueryRow(ctx, `
				SELECT EXISTS (
					SELECT 1
					  FROM message_attachment
					 WHERE storage_key = $1
					    OR thumbnail_storage_key = $1
			)`, key).Scan(&referenced); err != nil {
			s.log.Warn("chat message attachment reference check failed",
				zap.String("reason", "database"),
				zap.Error(err))
			continue
		}
		if referenced {
			continue
		}
		if err := s.attachmentStore.DeleteObject(ctx, key); err != nil {
			s.log.Warn("chat.DeleteMessage attachment cleanup failed",
				zap.String("reason", "storage_delete"),
				zap.Error(err),
			)
		}
	}
}
