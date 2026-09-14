-- Store metadata for the immutable v1 thumbnail generated for newly uploaded
-- chat images. Existing attachment rows deliberately remain without one.
ALTER TABLE message_attachment
  ADD COLUMN IF NOT EXISTS thumbnail_storage_key VARCHAR(2048),
  ADD COLUMN IF NOT EXISTS thumbnail_mime_type VARCHAR(255),
  ADD COLUMN IF NOT EXISTS thumbnail_file_size BIGINT,
  ADD COLUMN IF NOT EXISTS thumbnail_version SMALLINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'chk_message_attachment_thumbnail_metadata'
       AND conrelid = 'message_attachment'::regclass
  ) THEN
    ALTER TABLE message_attachment
      ADD CONSTRAINT chk_message_attachment_thumbnail_metadata CHECK (
        (thumbnail_storage_key IS NULL
          AND thumbnail_mime_type IS NULL
          AND thumbnail_file_size IS NULL
          AND thumbnail_version IS NULL)
        OR (
          thumbnail_storage_key IS NOT NULL
          AND btrim(thumbnail_storage_key) <> ''
          AND thumbnail_mime_type IS NOT NULL
          AND btrim(thumbnail_mime_type) <> ''
          AND thumbnail_file_size IS NOT NULL
          AND thumbnail_file_size >= 0
          AND thumbnail_version IS NOT NULL
          AND thumbnail_version > 0
        )
      );
  END IF;
END
$$;
