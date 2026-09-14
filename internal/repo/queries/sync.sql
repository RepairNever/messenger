-- name: GetPersistedUserSyncCursor :one
SELECT COALESCE((
  SELECT persisted_event_seq
  FROM user_sync_cursors
  WHERE user_id = @user_id
), 0)::bigint AS persisted_event_seq;

-- name: UpsertUserSyncCursor :one
INSERT INTO user_sync_cursors (
  user_id,
  persisted_event_seq,
  updated_at
)
VALUES (
  @user_id,
  @persisted_event_seq,
  now()
)
ON CONFLICT (user_id) DO UPDATE
SET
  persisted_event_seq = GREATEST(user_sync_cursors.persisted_event_seq, EXCLUDED.persisted_event_seq),
  updated_at = now()
RETURNING *;

-- name: GetLatestWorkspaceEventSeq :one
SELECT COALESCE(MAX(event_seq), 0)::bigint AS latest_seq
FROM workspace_events;

-- name: GetWorkspaceEventFloorSeq :one
SELECT COALESCE(MIN(event_seq), 0)::bigint AS floor_seq
FROM workspace_events;

-- name: PruneWorkspaceEventsBefore :execrows
DELETE FROM workspace_events
WHERE occurred_at < @cutoff;
