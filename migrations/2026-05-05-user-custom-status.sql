ALTER TABLE users
  ADD COLUMN IF NOT EXISTS custom_status_text TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS custom_status_emoji TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS custom_status_expires_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_custom_status_complete'
      AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_custom_status_complete CHECK (
        (
          custom_status_expires_at IS NULL
          AND btrim(custom_status_text) = ''
          AND btrim(custom_status_emoji) = ''
        )
        OR (
          custom_status_expires_at IS NOT NULL
          AND btrim(custom_status_text) <> ''
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_custom_status_expires_at
  ON users(custom_status_expires_at)
  WHERE custom_status_expires_at IS NOT NULL;
