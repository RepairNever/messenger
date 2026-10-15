BEGIN;

CREATE TABLE IF NOT EXISTS conversation_unread_revisions (
  channel_id UUID NOT NULL,
  user_id    UUID NOT NULL,
  revision   BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  PRIMARY KEY (channel_id, user_id),
  FOREIGN KEY (channel_id, user_id) REFERENCES channel_members(channel_id, user_id) ON DELETE CASCADE
);

COMMIT;
