package chat

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Purge before removing messages: notification FKs otherwise become NULL and
// lose the association needed to remove their historical event payloads.
// Transaction-local SQL keeps the collected IDs scoped to this operation.
func (s *Service) purgeSecretMessageTracesTx(ctx context.Context, tx pgx.Tx, target messageMutationTarget) error {
	_, err := tx.Exec(ctx, `
		WITH targets AS MATERIALIZED (
		  SELECT id FROM messages WHERE id = $1 OR thread_root_id = $1
		), traces AS MATERIALIZED (
		  SELECT id::text AS id FROM targets
		  UNION SELECT id::text FROM message_attachment WHERE message_id IN (SELECT id FROM targets)
		  UNION SELECT id::text FROM notifications
		    WHERE message_id IN (SELECT id FROM targets) OR thread_root_message_id IN (SELECT id FROM targets)
		), purge_events AS (
		  DELETE FROM workspace_events e
		  WHERE EXISTS (SELECT 1 FROM traces t WHERE strpos(e.payload::text, t.id) > 0)
		)
		DELETE FROM notifications
		WHERE message_id IN (SELECT id FROM targets) OR thread_root_message_id IN (SELECT id FROM targets)`, target.MessageID)
	if err != nil {
		return fmt.Errorf("remove stored events and notifications: %w", err)
	}
	return nil
}

// Keep DB references until object removal succeeds. A failed request can be
// retried after restart without a permanent message tombstone or cleanup log.
// DeleteObject must be idempotent (including an already missing object).
func (s *Service) deleteSecretAttachmentObjects(ctx context.Context, attachments []MessageAttachment) error {
	seen := make(map[string]bool)
	for _, attachment := range attachments {
		for _, key := range []string{attachment.StorageKey, attachment.ThumbnailStorageKey} {
			key = strings.TrimSpace(key)
			if key == "" || seen[key] {
				continue
			}
			seen[key] = true
			if s.attachmentStore == nil {
				return ErrAttachmentStoreUnavailable
			}
			var err error
			for attempt := 0; attempt < 3; attempt++ {
				err = s.attachmentStore.DeleteObject(ctx, key)
				if err == nil {
					break
				}
				if attempt < 2 {
					timer := time.NewTimer(time.Duration(attempt+1) * 100 * time.Millisecond)
					select {
					case <-ctx.Done():
						timer.Stop()
						return ctx.Err()
					case <-timer.C:
					}
				}
			}
			if err != nil {
				return ErrSecretMessagePurgeIncomplete
			}
		}
	}
	return nil
}
