-- name: ListMessageEntitiesByMessageIDs :many
SELECT message_id, kind, target_id, label, href, start_offset, end_offset
FROM message_entities
WHERE message_id = ANY($1::uuid[])
ORDER BY message_id ASC, ordinal ASC;
