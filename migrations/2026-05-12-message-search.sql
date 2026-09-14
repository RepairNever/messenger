CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_messages_body_trgm
  ON messages USING gin (body gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_task_comment_body_trgm
  ON task_comment USING gin (body gin_trgm_ops);
