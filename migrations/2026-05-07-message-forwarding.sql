ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS forwarded_from_message_id UUID,
  ADD COLUMN IF NOT EXISTS forwarded_from_sender_id UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS forwarded_from_sender_name TEXT,
  ADD COLUMN IF NOT EXISTS forwarded_from_conversation_kind TEXT,
  ADD COLUMN IF NOT EXISTS forwarded_from_conversation_title TEXT,
  ADD COLUMN IF NOT EXISTS forwarded_from_thread_title TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_forward_metadata'
      AND conrelid = 'messages'::regclass
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT chk_forward_metadata CHECK (
        (
          forwarded_from_message_id IS NULL
          AND forwarded_from_sender_id IS NULL
          AND forwarded_from_sender_name IS NULL
          AND forwarded_from_conversation_kind IS NULL
          AND forwarded_from_conversation_title IS NULL
          AND forwarded_from_thread_title IS NULL
        ) OR (
          forwarded_from_message_id IS NOT NULL
          AND forwarded_from_sender_id IS NOT NULL
          AND btrim(forwarded_from_sender_name) <> ''
        )
      );
  END IF;
END $$;
