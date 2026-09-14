CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- Workspace  (singleton; drives first-page-only fields in BootstrapResponse)
-- ---------------------------------------------------------------------------

-- P2 fix: singleton enforced via a dummy column with UNIQUE + CHECK.
-- Only one row is ever allowed.
CREATE TABLE IF NOT EXISTS workspace (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- singleton guard: only one row allowed
  singleton  BOOLEAN     NOT NULL DEFAULT true UNIQUE CHECK (singleton = true)
);

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT        NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,
  display_name  TEXT        NOT NULL DEFAULT '',
  avatar_url    TEXT        NOT NULL DEFAULT '',
  custom_status_text TEXT   NOT NULL DEFAULT '',
  custom_status_emoji TEXT  NOT NULL DEFAULT '',
  custom_status_expires_at TIMESTAMPTZ,
  -- mirrors WorkspaceRole enum: owner | admin | member | bot
  role                TEXT        NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'bot')),
  status              TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
  need_change_password BOOLEAN    NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_custom_status_complete CHECK (
    (
      custom_status_expires_at IS NULL
      AND btrim(custom_status_text) = ''
      AND btrim(custom_status_emoji) = ''
    )
    OR (
      custom_status_expires_at IS NOT NULL
      AND btrim(custom_status_text) <> ''
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_users_custom_status_expires_at
  ON users(custom_status_expires_at)
  WHERE custom_status_expires_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Dayoffs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dayoffs (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leave_type  TEXT        NOT NULL CHECK (leave_type IN ('vacation', 'sick_leave', 'personal_day')),
  start_date  DATE        NOT NULL,
  end_date    DATE        NOT NULL,
  note        TEXT        NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_dayoffs_date_order CHECK (end_date >= start_date),
  CONSTRAINT chk_dayoffs_note_length CHECK (char_length(note) <= 1000),
  CONSTRAINT dayoffs_no_overlapping_ranges EXCLUDE USING gist (
    user_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  )
);

CREATE INDEX IF NOT EXISTS idx_dayoffs_user_date_range
  ON dayoffs(user_id, start_date, end_date);

-- ---------------------------------------------------------------------------
-- Auth
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS refresh_sessions (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT        NOT NULL,
  user_agent TEXT,
  ip_addr    TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id)
);

CREATE INDEX IF NOT EXISTS idx_refresh_sessions_user_id    ON refresh_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_sessions_expires_at ON refresh_sessions(expires_at);

CREATE TABLE IF NOT EXISTS integration_token (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT        NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at   TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,

  CONSTRAINT chk_integration_token_hash_nonempty CHECK (btrim(token_hash) <> '')
);

CREATE INDEX IF NOT EXISTS idx_integration_token_user_id
  ON integration_token(user_id);

CREATE INDEX IF NOT EXISTS idx_integration_token_active_lookup
  ON integration_token(token_hash)
  WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_integration_token_active_user
  ON integration_token(user_id)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Channels (conversations)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS channels (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- kind:       dm | channel
  -- visibility: dm | public | private  (mirrors ConversationType)
  kind             TEXT        NOT NULL CHECK (kind IN ('dm', 'channel')),
  visibility       TEXT        NOT NULL CHECK (visibility IN ('dm', 'public', 'private')),
  name             TEXT,
  topic            TEXT        NOT NULL DEFAULT '',
  is_archived      BOOLEAN     NOT NULL DEFAULT false,
  created_by       UUID        NOT NULL REFERENCES users(id),
  -- monotonic per-channel counter; incremented atomically on each new message
  next_seq         BIGINT      NOT NULL DEFAULT 0,
  -- updated on every new message; drives sidebar sort (last_activity_at DESC)
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- hidden channels back non-sidebar surfaces such as task comment threads
  hidden           BOOLEAN     NOT NULL DEFAULT false,
  encryption_mode  TEXT        NOT NULL DEFAULT 'none'
    CHECK (encryption_mode IN ('none', 'dm_pairwise_signal_v1')),
  encrypted_started_from_channel_id UUID REFERENCES channels(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id         UUID        NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id            UUID        NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  -- per-member notification level: 0=ALL, 1=MENTIONS_ONLY, 2=NOTHING
  notification_level SMALLINT    NOT NULL DEFAULT 0,
  -- soft leave flag: archived members keep history but lose active access
  is_archived        BOOLEAN     NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_members_user_id ON channel_members(user_id);
CREATE INDEX IF NOT EXISTS idx_channel_members_active_user
  ON channel_members(user_id, channel_id)
  WHERE is_archived = false;
CREATE INDEX IF NOT EXISTS idx_channel_members_active_channel
  ON channel_members(channel_id, user_id)
  WHERE is_archived = false;

CREATE INDEX IF NOT EXISTS idx_channels_visible_activity
  ON channels(last_activity_at DESC, id)
  WHERE hidden = false AND is_archived = false;

-- ---------------------------------------------------------------------------
-- Messages
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS messages (
  id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id       UUID    NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  channel_seq      BIGINT  NOT NULL,
  sender_id        UUID    NOT NULL REFERENCES users(id),
  client_msg_id    TEXT    NOT NULL,
  body             TEXT    NOT NULL,
  content_mode     TEXT    NOT NULL DEFAULT 'plaintext'
    CHECK (content_mode IN ('plaintext', 'dm_pairwise_signal_v1')),
  sender_device_id UUID,
  forwarded_from_message_id UUID,
  forwarded_from_sender_id  UUID    REFERENCES users(id),
  forwarded_from_sender_name TEXT,
  forwarded_from_conversation_kind TEXT,
  forwarded_from_conversation_title TEXT,
  forwarded_from_thread_title TEXT,
  -- NULL for channel-level messages; FK to root message for thread replies
  thread_root_id   UUID    REFERENCES messages(id) ON DELETE CASCADE,
  -- monotonic within a thread; 0 for non-thread messages
  thread_seq       BIGINT  NOT NULL DEFAULT 0,
  -- true when body contains @everyone / @channel mention
  mention_everyone BOOLEAN NOT NULL DEFAULT false,
  edited_at        TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (channel_id, channel_seq),

  -- thread consistency invariant:
  --   non-thread messages → thread_root_id IS NULL     AND thread_seq = 0
  --   thread replies      → thread_root_id IS NOT NULL AND thread_seq > 0
  CONSTRAINT chk_thread_consistency CHECK (
    (thread_root_id IS NULL     AND thread_seq = 0) OR
    (thread_root_id IS NOT NULL AND thread_seq > 0)
  ),

  CONSTRAINT chk_forward_metadata CHECK (
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
  )
);

-- channel timeline lookup
CREATE INDEX IF NOT EXISTS idx_messages_channel_seq
  ON messages(channel_id, channel_seq);

-- thread timeline lookup
CREATE INDEX IF NOT EXISTS idx_messages_thread_root
  ON messages(thread_root_id)
  WHERE thread_root_id IS NOT NULL;

-- monotonic thread_seq uniqueness within a thread
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_thread_seq
  ON messages(thread_root_id, thread_seq)
  WHERE thread_root_id IS NOT NULL;

-- idempotency: dedup SendMessageRequest by (channel, sender, client_msg_id)
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_msg_id
  ON messages(channel_id, sender_id, client_msg_id);

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_messages_body_trgm
  ON messages USING gin (body gin_trgm_ops)
  WHERE content_mode = 'plaintext';

-- ---------------------------------------------------------------------------
-- DM E2EE device and recipient envelope metadata
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- Message attachments
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS message_attachment (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID          NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  message_id      UUID          REFERENCES messages(id) ON DELETE CASCADE,
  file_name       VARCHAR(1024) NOT NULL,
  file_size       BIGINT        NOT NULL,
  mime_type       VARCHAR(255)  NOT NULL,
  storage_key     VARCHAR(2048) NOT NULL,
  thumbnail_storage_key VARCHAR(2048),
  thumbnail_mime_type   VARCHAR(255),
  thumbnail_file_size   BIGINT,
  thumbnail_version     SMALLINT,
  uploaded_by     UUID          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),

  CONSTRAINT chk_message_attachment_file_size CHECK (file_size >= 0),
  CONSTRAINT chk_message_attachment_file_name CHECK (btrim(file_name) <> ''),
  CONSTRAINT chk_message_attachment_storage_key CHECK (btrim(storage_key) <> ''),
  CONSTRAINT chk_message_attachment_thumbnail_metadata CHECK (
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
  )
);

-- message render query path
CREATE INDEX IF NOT EXISTS idx_message_attachment_message_id
  ON message_attachment (message_id, created_at ASC)
  WHERE message_id IS NOT NULL;

-- staged attachment lookup path (pre-send)
CREATE INDEX IF NOT EXISTS idx_message_attachment_staged
  ON message_attachment (conversation_id, uploaded_by, created_at ASC)
  WHERE message_id IS NULL;

-- Enforce linked attachment message/channel consistency at the DB layer.
-- CHECK constraints cannot reference other tables, so this uses a trigger.
CREATE OR REPLACE FUNCTION check_message_attachment_same_conversation()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.message_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM messages m
      WHERE m.id = NEW.message_id
        AND m.channel_id = NEW.conversation_id
    ) THEN
      RAISE EXCEPTION
        'attachment % message % does not belong to conversation %',
        NEW.id, NEW.message_id, NEW.conversation_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_message_attachment_same_conversation ON message_attachment;
CREATE TRIGGER trg_message_attachment_same_conversation
  BEFORE INSERT OR UPDATE OF message_id, conversation_id ON message_attachment
  FOR EACH ROW
  WHEN (NEW.message_id IS NOT NULL)
  EXECUTE FUNCTION check_message_attachment_same_conversation();

-- P1 fix: enforce that thread replies belong to the same channel as their root.
-- CHECK cannot reference another table, so a trigger is required.
CREATE OR REPLACE FUNCTION check_thread_same_channel()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.thread_root_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM messages
       WHERE id = NEW.thread_root_id
         AND channel_id = NEW.channel_id
    ) THEN
      RAISE EXCEPTION
        'thread_root_id % does not belong to channel %',
        NEW.thread_root_id, NEW.channel_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_messages_thread_same_channel
  BEFORE INSERT OR UPDATE ON messages
  FOR EACH ROW
  WHEN (NEW.thread_root_id IS NOT NULL)
  EXECUTE FUNCTION check_thread_same_channel();

-- ---------------------------------------------------------------------------
-- Thread summaries
-- ---------------------------------------------------------------------------

-- One row per thread root; updated atomically when a reply is inserted.
-- next_thread_seq is the counter used to assign thread_seq to new replies,
-- analogous to channels.next_seq for channel-level messages.
CREATE TABLE IF NOT EXISTS thread_summaries (
  root_message_id    UUID    PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  channel_id         UUID    NOT NULL    REFERENCES channels(id) ON DELETE CASCADE,
  reply_count        INT     NOT NULL DEFAULT 0,
  next_thread_seq    BIGINT  NOT NULL DEFAULT 1,
  last_reply_at      TIMESTAMPTZ,
  last_reply_user_id UUID    REFERENCES users(id)
);

-- ---------------------------------------------------------------------------
-- Mentions
-- ---------------------------------------------------------------------------

-- P1 fix: channel_id removed; always derived via JOIN messages to prevent
-- divergence between mention.channel_id and message.channel_id.
--
-- One row per (message, mentioned user). @everyone is NOT stored here;
-- signalled by messages.mention_everyone = true.
--
-- unread_mentions query:
--   SELECT COUNT(*) FROM message_mentions mm
--   JOIN messages m ON m.id = mm.message_id
--   JOIN message_reads mr ON mr.channel_id = m.channel_id
--                        AND mr.user_id    = mm.user_id
--   WHERE mm.user_id = $1
--     AND m.channel_id = $2
--     AND m.channel_seq > mr.last_read_seq
CREATE TABLE IF NOT EXISTS message_mentions (
  message_id UUID        NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    UUID        NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);

-- lookup mentions per user; channel resolved via messages join
CREATE INDEX IF NOT EXISTS idx_message_mentions_user
  ON message_mentions(user_id);

-- ---------------------------------------------------------------------------
-- Message entities
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS message_entities (
  message_id  UUID        NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  ordinal     INT         NOT NULL CHECK (ordinal >= 0),
  kind        TEXT        NOT NULL CHECK (kind IN ('user', 'task', 'document')),
  target_id   UUID        NOT NULL,
  label       TEXT        NOT NULL CHECK (btrim(label) <> ''),
  href        TEXT        NOT NULL DEFAULT '',
  start_offset INT        NOT NULL CHECK (start_offset >= 0),
  end_offset   INT        NOT NULL CHECK (end_offset > start_offset),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_message_entities_message
  ON message_entities(message_id, ordinal);

-- ---------------------------------------------------------------------------
-- Saved messages
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS message_saves (
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id UUID        NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  saved_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (user_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_message_saves_user_saved_at
  ON message_saves(user_id, saved_at DESC);

-- ---------------------------------------------------------------------------
-- Reactions
-- ---------------------------------------------------------------------------

-- One row per (message, user, emoji); source of truth for reaction ownership.
CREATE TABLE IF NOT EXISTS reactions (
  message_id UUID        NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    UUID        NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  emoji      TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);

-- Materialized aggregate; updated atomically with reactions in the same transaction.
-- Drives ReactionAggregate{emoji, count} in MessageEvent and ReactionUpdatedEvent.
CREATE TABLE IF NOT EXISTS reaction_counts (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  count      INT  NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (message_id, emoji)
);

-- ---------------------------------------------------------------------------
-- Read cursors
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS message_reads (
  channel_id    UUID    NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id       UUID    NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  last_read_seq BIGINT  NOT NULL DEFAULT 0 CHECK (last_read_seq >= 0),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS thread_reads (
  root_message_id      UUID        NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id              UUID        NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  last_read_thread_seq BIGINT      NOT NULL DEFAULT 0 CHECK (last_read_thread_seq >= 0),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (root_message_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS notifications (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- mirrors NotificationType enum
  type        TEXT        NOT NULL CHECK (type IN (
                'mention', 'thread_reply', 'call_invite', 'call_missed', 'system'
              )),
  title       TEXT        NOT NULL DEFAULT '',
  body        TEXT        NOT NULL DEFAULT '',
  channel_id  UUID        REFERENCES channels(id) ON DELETE SET NULL,
  message_id  UUID        REFERENCES messages(id) ON DELETE SET NULL,
  thread_root_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  is_read     BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_unresolved
  ON notifications(user_id, created_at DESC)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_message_id
  ON notifications(message_id)
  WHERE message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_thread_root_message_id
  ON notifications(thread_root_message_id)
  WHERE thread_root_message_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Calls
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS calls (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id   UUID        NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  status       TEXT        NOT NULL CHECK (status IN ('active', 'ended')),
  livekit_room TEXT        NOT NULL,
  created_by   UUID        NOT NULL REFERENCES users(id),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at     TIMESTAMPTZ,
  next_hand_raise_sequence BIGINT NOT NULL DEFAULT 0 CHECK (next_hand_raise_sequence >= 0)
);

-- at most one active call per channel
CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_one_active_per_channel
  ON calls(channel_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS call_participants (
  call_id   UUID        NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  user_id   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at   TIMESTAMPTZ,
  hand_raised_sequence BIGINT CHECK (hand_raised_sequence IS NULL OR hand_raised_sequence > 0),
  PRIMARY KEY (call_id, user_id)
);

-- mirrors CallInviteSummary / InviteState
CREATE TABLE IF NOT EXISTS call_invites (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id         UUID        NOT NULL REFERENCES calls(id)    ON DELETE CASCADE,
  channel_id      UUID        NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  inviter_id      UUID        NOT NULL REFERENCES users(id),
  invitee_id      UUID        NOT NULL REFERENCES users(id),
  -- mirrors InviteState enum
  state           TEXT        NOT NULL DEFAULT 'created'
                    CHECK (state IN ('created', 'accepted', 'rejected', 'cancelled', 'expired')),
  -- mirrors InviteCancelReason enum
  cancel_reason   TEXT        CHECK (cancel_reason IN ('cancelled', 'expired', 'rejected')),
  cancelled_by_id UUID        REFERENCES users(id),
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- P2 fix: enforce valid state/reason/cancelled_by combinations from protocol state machine:
  --   created | accepted | rejected → no cancel fields
  --   cancelled                     → reason='cancelled', cancelled_by required
  --   expired                       → reason='expired',   no cancelled_by
  CONSTRAINT chk_invite_state_reason CHECK (
    (state IN ('created', 'accepted', 'rejected')
      AND cancel_reason    IS NULL
      AND cancelled_by_id  IS NULL)
    OR
    (state = 'cancelled'
      AND cancel_reason    = 'cancelled'
      AND cancelled_by_id  IS NOT NULL)
    OR
    (state = 'expired'
      AND cancel_reason    = 'expired'
      AND cancelled_by_id  IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_call_invites_invitee_active
  ON call_invites(invitee_id)
  WHERE state = 'created';

-- ---------------------------------------------------------------------------
-- Presence
-- ---------------------------------------------------------------------------

-- Durable effective presence plus persistent manual away preference.
-- last_active_at is updated by websocket auth/heartbeat/manual presence actions
-- and survives offline transitions for "last seen" style UI.
CREATE TABLE IF NOT EXISTS user_presence (
  user_id          UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status           TEXT        NOT NULL DEFAULT 'offline'
                     CHECK (status IN ('online', 'away', 'offline')),
  preferred_status TEXT        NOT NULL DEFAULT 'online'
                     CHECK (preferred_status IN ('online', 'away')),
  last_active_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ws_presence_leases (
  connection_id     UUID        PRIMARY KEY,
  user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  auth_session_id   UUID        NOT NULL REFERENCES refresh_sessions(id) ON DELETE CASCADE,
  heartbeat_capable BOOLEAN     NOT NULL DEFAULT false,
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ws_presence_leases_user
  ON ws_presence_leases(user_id);

CREATE INDEX IF NOT EXISTS idx_ws_presence_leases_heartbeat
  ON ws_presence_leases(heartbeat_capable, last_heartbeat_at);

-- ---------------------------------------------------------------------------
-- Bootstrap sessions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bootstrap_sessions (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_instance_id TEXT        NOT NULL,
  snapshot_seq       BIGINT      NOT NULL,
  include_archived   BOOLEAN     NOT NULL DEFAULT false,
  expires_at         TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bootstrap_sessions_user
  ON bootstrap_sessions(user_id, expires_at);

CREATE TABLE IF NOT EXISTS bootstrap_session_items (
  session_id       UUID        NOT NULL REFERENCES bootstrap_sessions(id) ON DELETE CASCADE,
  page_index       INT         NOT NULL CHECK (page_index >= 0),
  conversation_id  UUID        NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  ordinal          INT         NOT NULL CHECK (ordinal >= 0),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_bootstrap_session_items_page
  ON bootstrap_session_items(session_id, page_index, ordinal);

CREATE TABLE IF NOT EXISTS user_sync_cursors (
  user_id              UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  persisted_event_seq  BIGINT      NOT NULL DEFAULT 0 CHECK (persisted_event_seq >= 0),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Global event log  (enables SyncSinceRequest; acts as transactional outbox)
-- ---------------------------------------------------------------------------

-- Append-only. event_seq is the globally monotonic counter referenced by
-- ServerEvent.event_seq. pg_notify is called in the same transaction so
-- the listener never receives a seq before the row is committed.
--
-- Coherence between event_type and payload is enforced at the application
-- layer via a single AppendEvent(ctx, tx, evt) function.
CREATE SEQUENCE IF NOT EXISTS workspace_event_seq_seq START 1;

CREATE TABLE IF NOT EXISTS workspace_events (
  event_seq   BIGINT      PRIMARY KEY DEFAULT nextval('workspace_event_seq_seq'),
  event_id    UUID        NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  -- constrained to the exact set of EventType values (mirrors proto enum)
  event_type  TEXT        NOT NULL CHECK (event_type IN (
                'conversation_upserted',
                'conversation_removed',
                'membership_changed',
                'message_created',
                'message_updated',
                'message_deleted',
                'read_counter_updated',
                'notification_added',
                'notification_resolved',
                'call_invite_created',
                'call_invite_cancelled',
                'call_state_changed',
                'user_call_presence_changed',
                'thread_summary_updated',
                'reaction_updated',
                'user_identity_updated',
                'task_status_changed',
                'dm_history_cleared',
                'call_raised_hands_changed',
                'secret_history_invalidated'
              )),
  channel_id  UUID        REFERENCES channels(id) ON DELETE SET NULL,
  payload     JSONB       NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspace_events_seq
  ON workspace_events(event_seq);
CREATE INDEX IF NOT EXISTS idx_workspace_events_channel
  ON workspace_events(channel_id, event_seq);
CREATE INDEX IF NOT EXISTS idx_workspace_events_occurred
  ON workspace_events(occurred_at);

-- ---------------------------------------------------------------------------
-- Task Tracker — Phase 1
-- (DDL kept here for sqlc schema awareness; applied via task_tracker_phase1.sql)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS task_template (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    prefix      varchar(32) NOT NULL,
    sort_order  integer     NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    deleted_at  timestamptz NULL,
    created_by  uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    updated_by  uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

    CONSTRAINT uq_task_template_prefix        UNIQUE (prefix),
    CONSTRAINT chk_task_template_prefix_nonempty CHECK (btrim(prefix) <> ''),
    CONSTRAINT chk_task_template_prefix_az    CHECK (prefix ~ '^[A-Z]+$')
);

CREATE TABLE IF NOT EXISTS task_template_sequence (
    template_id uuid    PRIMARY KEY REFERENCES task_template(id) ON DELETE RESTRICT,
    last_value  bigint  NOT NULL DEFAULT 0,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task_status (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    code        varchar(64) NOT NULL,
    name        varchar(255) NOT NULL,
    sort_order  integer     NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    deleted_at  timestamptz NULL,
    created_by  uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

    CONSTRAINT uq_task_status_code           UNIQUE (code),
    CONSTRAINT chk_task_status_code_nonempty  CHECK (btrim(code) <> ''),
    CONSTRAINT chk_task_status_name_nonempty  CHECK (btrim(name) <> '')
);

CREATE TABLE IF NOT EXISTS enum_dictionary (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    code            varchar(64) NOT NULL,
    name            varchar(255) NOT NULL,
    is_public       boolean     NOT NULL DEFAULT false,
    participates_in_filtration boolean NOT NULL DEFAULT false,
    current_version integer     NOT NULL DEFAULT 1,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT uq_enum_dictionary_code            UNIQUE (code),
    CONSTRAINT chk_enum_dictionary_code_nonempty  CHECK (btrim(code) <> ''),
    CONSTRAINT chk_enum_dictionary_name_nonempty  CHECK (btrim(name) <> ''),
    CONSTRAINT chk_enum_dictionary_version_pos    CHECK (current_version > 0)
);

CREATE TABLE IF NOT EXISTS enum_dictionary_version (
    id            uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
    dictionary_id uuid    NOT NULL REFERENCES enum_dictionary(id) ON DELETE RESTRICT,
    version       integer NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    created_by    uuid    NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

    CONSTRAINT uq_enum_dictionary_version UNIQUE (dictionary_id, version),
    CONSTRAINT chk_enum_dictionary_version_pos CHECK (version > 0)
);

CREATE TABLE IF NOT EXISTS enum_dictionary_version_item (
    id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    dictionary_version_id uuid        NOT NULL REFERENCES enum_dictionary_version(id) ON DELETE RESTRICT,
    value_code            varchar(64) NOT NULL,
    value_name            varchar(255) NOT NULL,
    sort_order            integer     NOT NULL DEFAULT 0,
    is_active             boolean     NOT NULL DEFAULT true,

    CONSTRAINT uq_enum_version_item_code UNIQUE (dictionary_version_id, value_code),
    CONSTRAINT chk_enum_item_code_nonempty CHECK (btrim(value_code) <> ''),
    CONSTRAINT chk_enum_item_name_nonempty CHECK (btrim(value_name) <> '')
);

-- ---------------------------------------------------------------------------
-- Task Tracker — Phase 2
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS task_field_definition (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id         uuid        NOT NULL REFERENCES task_template(id) ON DELETE RESTRICT,
    code                varchar(64) NOT NULL,
    name                varchar(255) NOT NULL,
    type                varchar(32) NOT NULL,
    required            boolean     NOT NULL DEFAULT false,
    sort_order          integer     NOT NULL DEFAULT 0,
    enum_dictionary_id  uuid        NULL REFERENCES enum_dictionary(id) ON DELETE RESTRICT,
    field_role          varchar(32) NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    deleted_at          timestamptz NULL,

    CONSTRAINT chk_task_field_code_nonempty
        CHECK (btrim(code) <> ''),
    CONSTRAINT chk_task_field_code_identifier
        CHECK (code ~ '^[a-z][a-z0-9_]*$'),
    CONSTRAINT chk_task_field_name_nonempty
        CHECK (btrim(name) <> ''),
    CONSTRAINT chk_task_field_type
        CHECK (type IN ('text','number','user','users','enum','multi_enum','date','datetime')),
    CONSTRAINT chk_task_field_role
        CHECK (field_role IS NULL OR field_role IN ('assignee')),
    CONSTRAINT chk_task_field_assignee_type
        CHECK (
            field_role IS NULL
            OR (field_role = 'assignee' AND type IN ('user','users'))
        ),
    CONSTRAINT chk_task_field_enum_dict
        CHECK (
            (type IN ('enum','multi_enum') AND enum_dictionary_id IS NOT NULL)
            OR (type NOT IN ('enum','multi_enum') AND enum_dictionary_id IS NULL)
        )
);

-- Active code must be unique within a template (allows reuse after soft-delete)
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_field_definition_template_code_active
    ON task_field_definition (template_id, code)
    WHERE deleted_at IS NULL;

-- At most one active assignee field per template
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_field_definition_one_assignee
    ON task_field_definition (template_id)
    WHERE field_role = 'assignee' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_task_field_definition_template_sort
    ON task_field_definition (template_id, sort_order, code);

-- ---------------------------------------------------------------------------
-- Task Tracker — Phase 3: task instances + field values
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Generic trigger function that sets updated_at = now() on any UPDATE.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_TABLE_NAME = 'task'
       AND current_setting('msgnr.preserve_task_updated_at', true) = 'on' THEN
        RETURN NEW;
    END IF;
    IF TG_TABLE_NAME = 'document'
       AND current_setting('msgnr.preserve_document_updated_at', true) = 'on' THEN
        RETURN NEW;
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

DO $$ BEGIN
    CREATE TRIGGER trg_dayoffs_set_updated_at
    BEFORE UPDATE ON dayoffs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Prevent changing prefix once tasks exist for that template.
CREATE OR REPLACE FUNCTION prevent_template_prefix_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.prefix IS DISTINCT FROM OLD.prefix THEN
        IF EXISTS (SELECT 1 FROM task WHERE template_id = OLD.id LIMIT 1) THEN
            RAISE EXCEPTION 'cannot change template prefix: tasks already exist for template %', OLD.id
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DO $$ BEGIN
    CREATE TRIGGER trg_task_template_prevent_prefix_change
    BEFORE UPDATE OF prefix ON task_template
    FOR EACH ROW EXECUTE FUNCTION prevent_template_prefix_change();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS task (
    id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    public_id                varchar(64) NOT NULL,
    template_id              uuid        NOT NULL REFERENCES task_template(id) ON DELETE RESTRICT,
    discussion_channel_id    uuid        NULL REFERENCES channels(id) ON DELETE SET NULL,
    template_snapshot_prefix varchar(32) NOT NULL,
    sequence_number          bigint      NOT NULL,
    title                    text        NOT NULL,
    description              text        NULL,
    status_id                uuid        NOT NULL REFERENCES task_status(id) ON DELETE RESTRICT,
    parent_task_id           uuid        NULL REFERENCES task(id) ON DELETE RESTRICT,
    created_by               uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    updated_by               uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT uq_task_public_id           UNIQUE (public_id),
    CONSTRAINT uq_task_template_sequence   UNIQUE (template_id, sequence_number),
    CONSTRAINT chk_task_title_nonempty     CHECK (btrim(title) <> '')
);

CREATE INDEX IF NOT EXISTS idx_task_template_id              ON task (template_id);
CREATE INDEX IF NOT EXISTS idx_task_status_id                ON task (status_id);
CREATE INDEX IF NOT EXISTS idx_task_parent_task_id           ON task (parent_task_id);
CREATE INDEX IF NOT EXISTS idx_task_created_at               ON task (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_updated_at               ON task (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_template_snapshot_prefix ON task (template_snapshot_prefix);
CREATE INDEX IF NOT EXISTS idx_task_title_trgm               ON task USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_task_description_trgm         ON task USING gin (description gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_task_public_id_trgm           ON task USING gin (public_id gin_trgm_ops);

CREATE TABLE IF NOT EXISTS task_description_history (
    id          uuid         NOT NULL DEFAULT gen_random_uuid(),
    public_id   varchar(64)  NOT NULL REFERENCES task(public_id) ON DELETE CASCADE,
    title       text         NOT NULL,
    description text         NULL,
    edited_by   uuid         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at  timestamptz  NOT NULL DEFAULT now(),

    CONSTRAINT chk_task_description_history_title_nonempty CHECK (btrim(title) <> '')
);

CREATE INDEX IF NOT EXISTS idx_task_description_history_public_created
    ON task_description_history (public_id, created_at DESC);

-- Append-only, field-level task history. Values are JSON so a historical row
-- remains readable even when a task field evolves after the change.
CREATE TABLE IF NOT EXISTS task_change_history (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id      uuid        NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    actor_id     uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    change_kind  varchar(32) NOT NULL,
    field_key    varchar(128) NOT NULL,
    field_name   varchar(255) NOT NULL,
    field_type   varchar(64) NOT NULL,
    before_value jsonb       NOT NULL DEFAULT 'null'::jsonb,
    after_value  jsonb       NOT NULL DEFAULT 'null'::jsonb,
    created_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT chk_task_change_history_kind
        CHECK (change_kind IN ('created', 'field')),
    CONSTRAINT chk_task_change_history_field_key_nonempty
        CHECK (btrim(field_key) <> ''),
    CONSTRAINT chk_task_change_history_field_name_nonempty
        CHECK (btrim(field_name) <> '')
);

CREATE INDEX IF NOT EXISTS idx_task_change_history_task_created
    ON task_change_history (task_id, created_at DESC, id DESC);

-- Atomically allocate the next sequence number for a template and set public_id.
-- Also blocks inserts against a soft-deleted template.
CREATE OR REPLACE FUNCTION assign_task_public_id()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_prefix     varchar(32);
    v_deleted_at timestamptz;
    v_next_seq   bigint;
BEGIN
    SELECT prefix, deleted_at INTO v_prefix, v_deleted_at
    FROM task_template WHERE id = NEW.template_id FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'template not found: %', NEW.template_id USING ERRCODE = '23503';
    END IF;
    IF v_deleted_at IS NOT NULL THEN
        RAISE EXCEPTION 'cannot create task: template % has been deleted', NEW.template_id
            USING ERRCODE = '23514';
    END IF;

    INSERT INTO task_template_sequence (template_id, last_value)
    VALUES (NEW.template_id, 1)
    ON CONFLICT (template_id) DO UPDATE
        SET last_value = task_template_sequence.last_value + 1,
            updated_at = now()
    RETURNING last_value INTO v_next_seq;

    NEW.sequence_number          := v_next_seq;
    NEW.template_snapshot_prefix := v_prefix;
    NEW.public_id                := v_prefix || '-' || v_next_seq;
    RETURN NEW;
END;
$$;

DO $$ BEGIN
    CREATE TRIGGER trg_task_assign_public_id
    BEFORE INSERT ON task
    FOR EACH ROW EXECUTE FUNCTION assign_task_public_id();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Reject inserts/updates that reference a soft-deleted status.
CREATE OR REPLACE FUNCTION validate_task_status_not_deleted()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_deleted_at timestamptz;
BEGIN
    IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.status_id IS DISTINCT FROM OLD.status_id) THEN
        SELECT deleted_at INTO v_deleted_at FROM task_status WHERE id = NEW.status_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'status not found: %', NEW.status_id USING ERRCODE = '23503';
        END IF;
        IF v_deleted_at IS NOT NULL THEN
            RAISE EXCEPTION 'cannot use deleted status: %', NEW.status_id USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DO $$ BEGIN
    CREATE TRIGGER trg_task_validate_status
    BEFORE INSERT OR UPDATE OF status_id ON task
    FOR EACH ROW EXECUTE FUNCTION validate_task_status_not_deleted();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Enforce max one level of subtask nesting.
CREATE OR REPLACE FUNCTION validate_task_parent_rules()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_parent_parent_id uuid;
BEGIN
    IF NEW.parent_task_id IS NULL THEN RETURN NEW; END IF;
    IF NEW.parent_task_id = NEW.id THEN
        RAISE EXCEPTION 'task cannot be its own parent' USING ERRCODE = '23514';
    END IF;
    SELECT parent_task_id INTO v_parent_parent_id FROM task WHERE id = NEW.parent_task_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'parent task not found: %', NEW.parent_task_id USING ERRCODE = '23503';
    END IF;
    IF v_parent_parent_id IS NOT NULL THEN
        RAISE EXCEPTION 'subtasks cannot be nested deeper than one level' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

DO $$ BEGIN
    CREATE TRIGGER trg_task_validate_parent
    BEFORE INSERT OR UPDATE OF parent_task_id ON task
    FOR EACH ROW EXECUTE FUNCTION validate_task_parent_rules();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TRIGGER trg_task_set_updated_at
    BEFORE UPDATE ON task
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS task_field_value (
    id                  uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id             uuid         NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    field_definition_id uuid         NOT NULL REFERENCES task_field_definition(id) ON DELETE RESTRICT,
    value_text          text         NULL,
    value_number        numeric(20,6) NULL,
    value_user_id       uuid         NULL,
    value_date          date         NULL,
    value_datetime      timestamptz  NULL,
    value_json          jsonb        NULL,
    enum_dictionary_id  uuid         NULL REFERENCES enum_dictionary(id) ON DELETE RESTRICT,
    enum_version        integer      NULL,
    created_at          timestamptz  NOT NULL DEFAULT now(),
    updated_at          timestamptz  NOT NULL DEFAULT now(),

    CONSTRAINT uq_task_field_value_task_field      UNIQUE (task_id, field_definition_id),
    CONSTRAINT chk_task_field_value_enum_version   CHECK (enum_version IS NULL OR enum_version > 0),
    CONSTRAINT fk_task_field_value_enum_version
        FOREIGN KEY (enum_dictionary_id, enum_version)
        REFERENCES enum_dictionary_version (dictionary_id, version)
        ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_task_field_value_task_id             ON task_field_value (task_id);
CREATE INDEX IF NOT EXISTS idx_task_field_value_field_definition_id ON task_field_value (field_definition_id);
CREATE INDEX IF NOT EXISTS idx_task_field_value_value_user_id       ON task_field_value (value_user_id);
CREATE INDEX IF NOT EXISTS idx_task_field_value_value_json_gin      ON task_field_value USING gin (value_json);

DO $$ BEGIN
    CREATE TRIGGER trg_task_field_value_set_updated_at
    BEFORE UPDATE ON task_field_value
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Task Tracker — Phase 6: attachments + comments
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS task_staged_attachment (
    id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    file_name    varchar(1024) NOT NULL,
    file_size    bigint        NOT NULL,
    mime_type    varchar(255)  NOT NULL,
    storage_key  varchar(2048) NOT NULL,
    uploaded_by  uuid          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at   timestamptz   NOT NULL DEFAULT now(),

    CONSTRAINT chk_task_staged_attachment_file_size    CHECK (file_size >= 0),
    CONSTRAINT chk_task_staged_attachment_file_name    CHECK (btrim(file_name) <> ''),
    CONSTRAINT chk_task_staged_attachment_storage_key  CHECK (btrim(storage_key) <> '')
);

CREATE INDEX IF NOT EXISTS idx_task_staged_attachment_uploaded_by
    ON task_staged_attachment (uploaded_by, created_at ASC);

CREATE TABLE IF NOT EXISTS task_attachment (
    id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id      uuid          NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    file_name    varchar(1024) NOT NULL,
    file_size    bigint        NOT NULL,
    mime_type    varchar(255)  NOT NULL,
    storage_key  varchar(2048) NOT NULL,
    uploaded_by  uuid          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at   timestamptz   NOT NULL DEFAULT now(),

    CONSTRAINT chk_task_attachment_file_size    CHECK (file_size >= 0),
    CONSTRAINT chk_task_attachment_file_name    CHECK (btrim(file_name) <> ''),
    CONSTRAINT chk_task_attachment_storage_key  CHECK (btrim(storage_key) <> '')
);

CREATE INDEX IF NOT EXISTS idx_task_attachment_task_id
    ON task_attachment (task_id, created_at ASC);

CREATE TABLE IF NOT EXISTS task_comment (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id    uuid        NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    author_id  uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    thread_root_message_id uuid NULL REFERENCES messages(id) ON DELETE SET NULL,
    body       text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Allow attachment-only comments (body may be empty string).
ALTER TABLE task_comment DROP CONSTRAINT IF EXISTS chk_task_comment_body;

CREATE INDEX IF NOT EXISTS idx_task_comment_task_created_at
    ON task_comment (task_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_task_comment_thread_root_message_id
    ON task_comment (thread_root_message_id)
    WHERE thread_root_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_task_comment_body_trgm
    ON task_comment USING gin (body gin_trgm_ops);

CREATE TABLE IF NOT EXISTS task_comment_attachment (
    id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id      uuid          NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    comment_id   uuid          NULL REFERENCES task_comment(id) ON DELETE CASCADE,
    file_name    varchar(1024) NOT NULL,
    file_size    bigint        NOT NULL,
    mime_type    varchar(255)  NOT NULL,
    storage_key  varchar(2048) NOT NULL,
    uploaded_by  uuid          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at   timestamptz   NOT NULL DEFAULT now(),

    CONSTRAINT chk_task_comment_attachment_file_size    CHECK (file_size >= 0),
    CONSTRAINT chk_task_comment_attachment_file_name    CHECK (btrim(file_name) <> ''),
    CONSTRAINT chk_task_comment_attachment_storage_key  CHECK (btrim(storage_key) <> '')
);

CREATE INDEX IF NOT EXISTS idx_task_comment_attachment_staged
    ON task_comment_attachment (task_id, uploaded_by, created_at ASC)
    WHERE comment_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_task_comment_attachment_comment_id
    ON task_comment_attachment (comment_id, created_at ASC)
    WHERE comment_id IS NOT NULL;

CREATE OR REPLACE FUNCTION check_task_comment_attachment_task_match()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.comment_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1
            FROM task_comment c
            WHERE c.id = NEW.comment_id
              AND c.task_id = NEW.task_id
        ) THEN
            RAISE EXCEPTION
                'task comment attachment % comment % does not belong to task %',
                NEW.id, NEW.comment_id, NEW.task_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_task_comment_attachment_task_match ON task_comment_attachment;
CREATE TRIGGER trg_task_comment_attachment_task_match
    BEFORE INSERT OR UPDATE OF comment_id, task_id ON task_comment_attachment
    FOR EACH ROW
    WHEN (NEW.comment_id IS NOT NULL)
    EXECUTE FUNCTION check_task_comment_attachment_task_match();

DROP TRIGGER IF EXISTS trg_task_comment_prevent_body_update ON task_comment;
DROP FUNCTION IF EXISTS prevent_task_comment_body_update();

DO $$ BEGIN
    CREATE TRIGGER trg_task_comment_set_updated_at
    BEFORE UPDATE ON task_comment
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Push Subscriptions (Web Push / VAPID)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    TEXT        NOT NULL UNIQUE,
  key_p256dh  TEXT        NOT NULL,
  key_auth    TEXT        NOT NULL,
  user_agent  TEXT        NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
  ON push_subscriptions(user_id);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_last_used
  ON push_subscriptions(last_used);

-- ---------------------------------------------------------------------------
-- Documents / Teamspaces
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS teamspace (
    id            uuid         NOT NULL DEFAULT gen_random_uuid(),
    name          text         NOT NULL,
    owner_user_id uuid         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    is_private    boolean      NOT NULL DEFAULT false,
    deleted_at    timestamptz  NULL,
    created_at    timestamptz  NOT NULL DEFAULT now(),
    updated_at    timestamptz  NOT NULL DEFAULT now(),

    CONSTRAINT pk_teamspace PRIMARY KEY (id),
    CONSTRAINT chk_teamspace_name_nonempty CHECK (btrim(name) <> '')
);

CREATE INDEX IF NOT EXISTS idx_teamspace_owner_user_id ON teamspace (owner_user_id);
CREATE INDEX IF NOT EXISTS idx_teamspace_public_name ON teamspace (is_private, lower(name));

DO $$ BEGIN
    CREATE TRIGGER trg_teamspace_set_updated_at
    BEFORE UPDATE ON teamspace
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS teamspace_member (
    teamspace_id uuid        NOT NULL REFERENCES teamspace(id) ON DELETE CASCADE,
    user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT pk_teamspace_member PRIMARY KEY (teamspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_teamspace_member_user_id ON teamspace_member (user_id, joined_at DESC);

CREATE TABLE IF NOT EXISTS document (
    id                 uuid         NOT NULL DEFAULT gen_random_uuid(),
    teamspace_id       uuid         NOT NULL REFERENCES teamspace(id) ON DELETE CASCADE,
    parent_document_id uuid         NULL REFERENCES document(id) ON DELETE CASCADE,
    title              text         NOT NULL,
    content_markdown   text         NULL,
    created_by         uuid         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    updated_by         uuid         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at         timestamptz  NOT NULL DEFAULT now(),
    updated_at         timestamptz  NOT NULL DEFAULT now(),
    archived_at        timestamptz  NULL,

    CONSTRAINT pk_document PRIMARY KEY (id),
    CONSTRAINT chk_document_title_nonempty CHECK (btrim(title) <> '')
);

CREATE INDEX IF NOT EXISTS idx_document_teamspace_id ON document (teamspace_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_document_parent_document_id ON document (parent_document_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_document_active_title ON document (teamspace_id, archived_at, lower(title));
CREATE INDEX IF NOT EXISTS idx_document_active_title_trgm
    ON document USING gin (title gin_trgm_ops)
    WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_document_active_content_trgm
    ON document USING gin (content_markdown gin_trgm_ops)
    WHERE archived_at IS NULL AND content_markdown IS NOT NULL;

CREATE TABLE IF NOT EXISTS document_favorite (
    user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    document_id  uuid        NOT NULL REFERENCES document(id) ON DELETE CASCADE,
    favorited_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT pk_document_favorite PRIMARY KEY (user_id, document_id)
);

CREATE INDEX IF NOT EXISTS idx_document_favorite_user_favorited_at
    ON document_favorite (user_id, favorited_at DESC, document_id);

CREATE INDEX IF NOT EXISTS idx_document_favorite_document_id
    ON document_favorite (document_id);

DO $$ BEGIN
    CREATE TRIGGER trg_document_set_updated_at
    BEFORE UPDATE ON document
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION check_document_parent_teamspace_match()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_parent_teamspace_id uuid;
BEGIN
    IF NEW.parent_document_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT teamspace_id INTO v_parent_teamspace_id
    FROM document
    WHERE id = NEW.parent_document_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'parent document not found: %', NEW.parent_document_id USING ERRCODE = '23503';
    END IF;

    IF v_parent_teamspace_id <> NEW.teamspace_id THEN
        RAISE EXCEPTION 'parent document % belongs to different teamspace', NEW.parent_document_id
            USING ERRCODE = '23514';
    END IF;

    IF NEW.parent_document_id = NEW.id THEN
        RAISE EXCEPTION 'document cannot be its own parent' USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_document_parent_teamspace_match ON document;
CREATE TRIGGER trg_document_parent_teamspace_match
    BEFORE INSERT OR UPDATE OF teamspace_id, parent_document_id ON document
    FOR EACH ROW EXECUTE FUNCTION check_document_parent_teamspace_match();

CREATE TABLE IF NOT EXISTS document_attachment (
    id           uuid          NOT NULL DEFAULT gen_random_uuid(),
    document_id  uuid          NOT NULL REFERENCES document(id) ON DELETE CASCADE,
    file_name    varchar(1024) NOT NULL,
    file_size    bigint        NOT NULL,
    mime_type    varchar(255)  NOT NULL,
    storage_key  varchar(2048) NOT NULL,
    uploaded_by  uuid          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at   timestamptz   NOT NULL DEFAULT now(),

    CONSTRAINT pk_document_attachment PRIMARY KEY (id),
    CONSTRAINT chk_document_attachment_file_size CHECK (file_size >= 0),
    CONSTRAINT chk_document_attachment_file_name CHECK (btrim(file_name) <> ''),
    CONSTRAINT chk_document_attachment_storage_key CHECK (btrim(storage_key) <> '')
);

CREATE INDEX IF NOT EXISTS idx_document_attachment_document_id
    ON document_attachment (document_id, created_at ASC);

CREATE TABLE IF NOT EXISTS document_history (
    id               uuid         NOT NULL DEFAULT gen_random_uuid(),
    document_id      uuid         NOT NULL REFERENCES document(id) ON DELETE CASCADE,
    title            text         NOT NULL,
    content_markdown text         NULL,
    edited_by        uuid         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at       timestamptz  NOT NULL DEFAULT now(),

    CONSTRAINT pk_document_history PRIMARY KEY (id),
    CONSTRAINT chk_document_history_title_nonempty CHECK (btrim(title) <> '')
);

CREATE INDEX IF NOT EXISTS idx_document_history_document_id
    ON document_history (document_id, created_at DESC);
