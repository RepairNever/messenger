  -- Optional DM E2EE foundation.
  -- Plaintext conversations/messages keep their existing defaults; encrypted DMs
  -- use separate dm_pairwise_signal_v1 conversation rows and opaque envelopes.

  ALTER TABLE channels
    ADD COLUMN IF NOT EXISTS encryption_mode TEXT NOT NULL DEFAULT 'none';

  ALTER TABLE channels
    ADD COLUMN IF NOT EXISTS encrypted_started_from_channel_id UUID REFERENCES channels(id);

  ALTER TABLE channels
    DROP CONSTRAINT IF EXISTS chk_channels_encryption_mode;

  ALTER TABLE channels
    ADD CONSTRAINT chk_channels_encryption_mode
    CHECK (encryption_mode IN ('none', 'dm_pairwise_signal_v1'));

  ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS content_mode TEXT NOT NULL DEFAULT 'plaintext';

  ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS sender_device_id UUID;

  ALTER TABLE messages
    DROP CONSTRAINT IF EXISTS chk_messages_content_mode;

  ALTER TABLE messages
    ADD CONSTRAINT chk_messages_content_mode
    CHECK (content_mode IN ('plaintext', 'dm_pairwise_signal_v1'));

  DROP INDEX IF EXISTS idx_messages_body_trgm;

  CREATE INDEX IF NOT EXISTS idx_messages_body_trgm
    ON messages USING gin (body gin_trgm_ops)
    WHERE content_mode = 'plaintext';

  CREATE TABLE IF NOT EXISTS user_devices (
    id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_label               TEXT        NOT NULL DEFAULT '',
    identity_key_public        BYTEA       NOT NULL,
    signed_prekey_id           INTEGER     NOT NULL,
    signed_prekey_public       BYTEA       NOT NULL,
    signed_prekey_signature    BYTEA       NOT NULL,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at               TIMESTAMPTZ,
    revoked_at                 TIMESTAMPTZ,
    CONSTRAINT chk_user_devices_identity_key_public_nonempty CHECK (octet_length(identity_key_public) > 0),
    CONSTRAINT chk_user_devices_signed_prekey_public_nonempty CHECK (octet_length(signed_prekey_public) > 0),
    CONSTRAINT chk_user_devices_signed_prekey_signature_nonempty CHECK (octet_length(signed_prekey_signature) > 0)
  );

  CREATE INDEX IF NOT EXISTS idx_user_devices_active_user
    ON user_devices(user_id, id)
    WHERE revoked_at IS NULL;

  CREATE TABLE IF NOT EXISTS device_one_time_prekeys (
    device_id     UUID        NOT NULL REFERENCES user_devices(id) ON DELETE CASCADE,
    prekey_id     INTEGER     NOT NULL,
    prekey_public BYTEA       NOT NULL,
    claimed_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (device_id, prekey_id),
    CONSTRAINT chk_device_one_time_prekeys_public_nonempty CHECK (octet_length(prekey_public) > 0)
  );

  CREATE INDEX IF NOT EXISTS idx_device_one_time_prekeys_unclaimed
    ON device_one_time_prekeys(device_id, prekey_id)
    WHERE claimed_at IS NULL;

  CREATE TABLE IF NOT EXISTS message_recipient_ciphertexts (
    message_id          UUID        NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    recipient_device_id UUID        NOT NULL REFERENCES user_devices(id) ON DELETE CASCADE,
    sender_device_id    UUID        NOT NULL REFERENCES user_devices(id) ON DELETE RESTRICT,
    algorithm           TEXT        NOT NULL,
    session_message     BYTEA       NOT NULL,
    metadata_aad        BYTEA       NOT NULL DEFAULT ''::bytea,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, recipient_device_id),
    CONSTRAINT chk_message_recipient_ciphertexts_algorithm_nonempty CHECK (btrim(algorithm) <> ''),
    CONSTRAINT chk_message_recipient_ciphertexts_session_message_nonempty CHECK (octet_length(session_message) > 0)
  );
