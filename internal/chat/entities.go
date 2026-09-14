package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	packetspb "msgnr/internal/gen/proto"
)

// detectMentionEveryone returns true if the message body contains a channel-wide
// mention shortcut. Kept in one place so send/edit paths cannot drift.
func detectMentionEveryone(body string) bool {
	return strings.Contains(body, "@everyone") || strings.Contains(body, "@channel")
}

// uuidsToStrings converts a slice of UUIDs to their canonical string form while
// preserving input order. Returns a non-nil empty slice so proto fields are
// serialized as an empty list rather than null.
func uuidsToStrings(ids []uuid.UUID) []string {
	result := make([]string, 0, len(ids))
	for _, id := range ids {
		result = append(result, id.String())
	}
	return result
}

func normalizeJSONValue(v any) ([]byte, error) {
	switch value := v.(type) {
	case nil:
		return nil, nil
	case []byte:
		return value, nil
	case string:
		return []byte(value), nil
	case json.RawMessage:
		return value, nil
	default:
		b, err := json.Marshal(value)
		if err != nil {
			return nil, err
		}
		return b, nil
	}
}

func (s *Service) loadMessageEntitiesByMessageIDs(ctx context.Context, messageIDs []uuid.UUID) (map[string][]MessageEntity, error) {
	result := make(map[string][]MessageEntity, len(messageIDs))
	if len(messageIDs) == 0 {
		return result, nil
	}

	rows, err := s.q.ListMessageEntitiesByMessageIDs(ctx, messageIDs)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		result[row.MessageID.String()] = append(result[row.MessageID.String()], MessageEntity{
			Kind:     MessageEntityKind(row.Kind),
			TargetID: row.TargetID,
			Label:    row.Label,
			Href:     row.Href,
			Start:    int32(row.StartOffset),
			End:      int32(row.EndOffset),
		})
	}
	return result, nil
}

func (s *Service) loadMessageEntitiesByMessageIDsTx(ctx context.Context, q queryer, messageIDs []uuid.UUID) (map[string][]MessageEntity, error) {
	result := make(map[string][]MessageEntity, len(messageIDs))
	if len(messageIDs) == 0 {
		return result, nil
	}

	rows, err := q.Query(ctx, `
		SELECT message_id, kind, target_id, label, href, start_offset, end_offset
		  FROM message_entities
		 WHERE message_id = ANY($1::uuid[])
		 ORDER BY message_id ASC, ordinal ASC`,
		messageIDs,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var (
			messageID uuid.UUID
			entity    MessageEntity
		)
		if err := rows.Scan(&messageID, &entity.Kind, &entity.TargetID, &entity.Label, &entity.Href, &entity.Start, &entity.End); err != nil {
			return nil, err
		}
		result[messageID.String()] = append(result[messageID.String()], entity)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *Service) insertMessageEntitiesTx(ctx context.Context, tx pgx.Tx, messageID uuid.UUID, entities []MessageEntity) error {
	if _, err := tx.Exec(ctx, `DELETE FROM message_entities WHERE message_id = $1`, messageID); err != nil {
		return err
	}
	if len(entities) == 0 {
		return nil
	}

	batch := &pgx.Batch{}
	for idx, entity := range entities {
		batch.Queue(`
			INSERT INTO message_entities (message_id, ordinal, kind, target_id, label, href, start_offset, end_offset)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
			messageID, idx, entity.Kind, entity.TargetID, entity.Label, entity.Href, entity.Start, entity.End,
		)
	}
	results := tx.SendBatch(ctx, batch)
	closeResults := true
	defer func() {
		if closeResults {
			_ = results.Close()
		}
	}()
	for range entities {
		if _, err := results.Exec(); err != nil {
			return err
		}
	}
	if err := results.Close(); err != nil {
		return err
	}
	closeResults = false
	return nil
}

func normalizeTaskHref(publicID string) string {
	return "/tasks/" + strings.ToLower(strings.TrimSpace(publicID))
}

func normalizeDocumentHref(documentID uuid.UUID) string {
	return "/documents/" + documentID.String()
}

func validateEntityHref(raw string, expected string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fmt.Errorf("href is required")
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return err
	}
	actual := parsed.Path
	if parsed.RawQuery != "" {
		actual += "?" + parsed.RawQuery
	}
	if parsed.Fragment != "" {
		actual += "#" + parsed.Fragment
	}
	if actual != expected {
		return fmt.Errorf("expected href %q", expected)
	}
	return nil
}

func mentionedUserIDsFromEntities(entities []MessageEntity) []uuid.UUID {
	seen := make(map[uuid.UUID]struct{}, len(entities))
	result := make([]uuid.UUID, 0, len(entities))
	for _, entity := range entities {
		if entity.Kind != MessageEntityKindUser {
			continue
		}
		if _, ok := seen[entity.TargetID]; ok {
			continue
		}
		seen[entity.TargetID] = struct{}{}
		result = append(result, entity.TargetID)
	}
	return result
}

func toProtoMessageEntityKind(kind MessageEntityKind) packetspb.MessageEntityKind {
	switch kind {
	case MessageEntityKindUser:
		return packetspb.MessageEntityKind_MESSAGE_ENTITY_KIND_USER
	case MessageEntityKindTask:
		return packetspb.MessageEntityKind_MESSAGE_ENTITY_KIND_TASK
	case MessageEntityKindDocument:
		return packetspb.MessageEntityKind_MESSAGE_ENTITY_KIND_DOCUMENT
	default:
		return packetspb.MessageEntityKind_MESSAGE_ENTITY_KIND_UNSPECIFIED
	}
}

func toProtoMessageEntities(entities []MessageEntity) []*packetspb.MessageEntity {
	if len(entities) == 0 {
		return nil
	}
	result := make([]*packetspb.MessageEntity, 0, len(entities))
	for _, entity := range entities {
		result = append(result, &packetspb.MessageEntity{
			Kind:     toProtoMessageEntityKind(entity.Kind),
			TargetId: entity.TargetID.String(),
			Label:    entity.Label,
			Href:     entity.Href,
			Start:    entity.Start,
			End:      entity.End,
		})
	}
	return result
}

func toProtoReactionAggregates(items []ReactionAggregate) []*packetspb.ReactionAggregate {
	if len(items) == 0 {
		return nil
	}
	result := make([]*packetspb.ReactionAggregate, 0, len(items))
	for _, item := range items {
		result = append(result, &packetspb.ReactionAggregate{
			Emoji: item.Emoji,
			Count: item.Count,
		})
	}
	return result
}

func (s *Service) validateAndNormalizeMessageEntities(
	ctx context.Context,
	q queryer,
	conversationID uuid.UUID,
	actorID uuid.UUID,
	body string,
	entities []MessageEntity,
) ([]MessageEntity, error) {
	if len(entities) == 0 {
		return nil, nil
	}

	runes := []rune(body)
	normalized := make([]MessageEntity, 0, len(entities))
	for _, entity := range entities {
		entity.Label = strings.TrimSpace(entity.Label)
		if entity.Label == "" || entity.TargetID == uuid.Nil {
			return nil, ErrInvalidMessageEntity
		}
		if entity.Start < 0 || entity.End <= entity.Start || int(entity.End) > len(runes) {
			return nil, ErrInvalidMessageEntity
		}
		substr := string(runes[entity.Start:entity.End])
		if substr != entity.Label {
			return nil, ErrInvalidMessageEntity
		}

		switch entity.Kind {
		case MessageEntityKindUser:
			var isMember bool
			err := q.QueryRow(ctx, `
				SELECT EXISTS (
					SELECT 1
					  FROM channel_members cm
					  JOIN users u ON u.id = cm.user_id
					 WHERE cm.channel_id = $1
					   AND cm.user_id = $2
					   AND cm.is_archived = false
					   AND u.status = 'active'
				)`,
				conversationID,
				entity.TargetID,
			).Scan(&isMember)
			if err != nil {
				return nil, fmt.Errorf("chat.validateAndNormalizeMessageEntities user check: %w", err)
			}
			if !isMember {
				return nil, ErrInvalidMessageEntity
			}
			entity.Href = ""
		case MessageEntityKindTask:
			var publicID string
			err := q.QueryRow(ctx, `SELECT public_id FROM task WHERE id = $1`, entity.TargetID).Scan(&publicID)
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, ErrInvalidMessageEntity
			}
			if err != nil {
				return nil, fmt.Errorf("chat.validateAndNormalizeMessageEntities task check: %w", err)
			}
			expectedHref := normalizeTaskHref(publicID)
			if err := validateEntityHref(entity.Href, expectedHref); err != nil {
				return nil, ErrInvalidMessageEntity
			}
			entity.Href = expectedHref
		case MessageEntityKindDocument:
			var documentID uuid.UUID
			err := q.QueryRow(ctx, `
				SELECT d.id
				  FROM document d
				  JOIN teamspace_member tm
				    ON tm.teamspace_id = d.teamspace_id
				   AND tm.user_id = $2
				 WHERE d.id = $1
				   AND d.archived_at IS NULL`,
				entity.TargetID,
				actorID,
			).Scan(&documentID)
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, ErrInvalidMessageEntity
			}
			if err != nil {
				return nil, fmt.Errorf("chat.validateAndNormalizeMessageEntities document check: %w", err)
			}
			expectedHref := normalizeDocumentHref(documentID)
			if err := validateEntityHref(entity.Href, expectedHref); err != nil {
				return nil, ErrInvalidMessageEntity
			}
			entity.Href = expectedHref
		default:
			return nil, ErrInvalidMessageEntity
		}
		normalized = append(normalized, entity)
	}

	sort.Slice(normalized, func(i, j int) bool {
		if normalized[i].Start != normalized[j].Start {
			return normalized[i].Start < normalized[j].Start
		}
		return normalized[i].End < normalized[j].End
	})
	for idx := 1; idx < len(normalized); idx++ {
		if normalized[idx-1].End > normalized[idx].Start {
			return nil, ErrInvalidMessageEntity
		}
	}
	return normalized, nil
}
