-- name: CanReadSpreadsheet :one
SELECT EXISTS (
    SELECT 1 FROM document d
    JOIN teamspace t ON t.id = d.teamspace_id AND t.deleted_at IS NULL
    JOIN teamspace_member tm ON tm.teamspace_id = t.id AND tm.user_id = sqlc.arg(user_id)
    WHERE d.id = sqlc.arg(document_id) AND d.kind = 'spreadsheet' AND d.archived_at IS NULL
);
