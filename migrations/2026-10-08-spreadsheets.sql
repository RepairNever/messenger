BEGIN;
ALTER TABLE document ADD COLUMN kind text NOT NULL DEFAULT 'markdown';
ALTER TABLE document ADD CONSTRAINT chk_document_kind CHECK (kind IN ('markdown', 'spreadsheet'));
ALTER TABLE document ADD CONSTRAINT chk_document_spreadsheet_markdown CHECK (kind <> 'spreadsheet' OR content_markdown IS NULL);
ALTER TABLE document_history ADD COLUMN kind text NOT NULL DEFAULT 'markdown';
ALTER TABLE document_history ADD COLUMN workbook_json jsonb;
ALTER TABLE document_history ADD COLUMN spreadsheet_revision bigint;
ALTER TABLE document_history ADD COLUMN spreadsheet_structure_epoch bigint;
ALTER TABLE document_history ADD CONSTRAINT chk_document_history_kind CHECK (kind IN ('markdown', 'spreadsheet'));
ALTER TABLE document_history ADD CONSTRAINT chk_document_history_content CHECK (
    (kind = 'markdown' AND workbook_json IS NULL AND spreadsheet_revision IS NULL AND spreadsheet_structure_epoch IS NULL)
    OR (kind = 'spreadsheet' AND content_markdown IS NULL AND workbook_json IS NOT NULL AND jsonb_typeof(workbook_json) = 'object'
        AND spreadsheet_revision IS NOT NULL AND spreadsheet_revision >= 0
        AND spreadsheet_structure_epoch IS NOT NULL AND spreadsheet_structure_epoch >= 0)
);

-- Spreadsheet documents use browser-authored snapshots and server-owned versions.
CREATE OR REPLACE FUNCTION prevent_document_kind_change() RETURNS trigger AS $$
BEGIN
    IF NEW.kind IS DISTINCT FROM OLD.kind THEN
        RAISE EXCEPTION 'document kind is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_document_kind_immutable ON document;
CREATE TRIGGER trg_document_kind_immutable BEFORE UPDATE OF kind ON document
    FOR EACH ROW EXECUTE FUNCTION prevent_document_kind_change();

CREATE TABLE IF NOT EXISTS document_spreadsheet (
    document_id uuid PRIMARY KEY REFERENCES document(id) ON DELETE CASCADE,
    workbook_json jsonb NOT NULL CHECK (jsonb_typeof(workbook_json) = 'object'),
    revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740991),
    structure_epoch bigint NOT NULL DEFAULT 0 CHECK (structure_epoch BETWEEN 0 AND 9007199254740991),
    epoch_start_revision bigint NOT NULL DEFAULT 0 CHECK (epoch_start_revision >= 0 AND epoch_start_revision <= revision),
    last_event_seq bigint NOT NULL DEFAULT 0 CHECK (last_event_seq >= 0)
);

CREATE TABLE IF NOT EXISTS document_spreadsheet_cell_version (
    document_id uuid NOT NULL REFERENCES document_spreadsheet(document_id) ON DELETE CASCADE,
    sheet_id text NOT NULL CHECK (length(sheet_id) BETWEEN 1 AND 128),
    row_index integer NOT NULL CHECK (row_index >= 0),
    column_index integer NOT NULL CHECK (column_index >= 0),
    last_revision bigint NOT NULL CHECK (last_revision > 0),
    PRIMARY KEY (document_id, sheet_id, row_index, column_index)
);

-- Permanent compact receipts deliberately have no FK to prunable events/history.
CREATE TABLE IF NOT EXISTS document_spreadsheet_operation (
    document_id uuid NOT NULL REFERENCES document_spreadsheet(document_id) ON DELETE CASCADE,
    operation_id text NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 128),
    actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
    outcome text NOT NULL CHECK (outcome IN ('accepted', 'conflict')),
    revision bigint NOT NULL CHECK (revision >= 0),
    structure_epoch bigint NOT NULL CHECK (structure_epoch >= 0),
    event_seq bigint NOT NULL DEFAULT 0 CHECK (event_seq >= 0),
    code text NOT NULL DEFAULT '',
    message text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (document_id, operation_id)
);
ALTER TABLE workspace_events
  DROP CONSTRAINT IF EXISTS workspace_events_event_type_check;

ALTER TABLE workspace_events
  ADD CONSTRAINT workspace_events_event_type_check
  CHECK (event_type IN (
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
    'secret_history_invalidated',
    'task_comment_created',
    'spreadsheet_changed'
  ));

COMMIT;
