CREATE EXTENSION IF NOT EXISTS btree_gist;

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

DROP TRIGGER IF EXISTS trg_dayoffs_set_updated_at ON dayoffs;
CREATE TRIGGER trg_dayoffs_set_updated_at
  BEFORE UPDATE ON dayoffs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
