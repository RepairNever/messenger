ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS next_hand_raise_sequence BIGINT NOT NULL DEFAULT 0
  CHECK (next_hand_raise_sequence >= 0);

ALTER TABLE call_participants
  ADD COLUMN IF NOT EXISTS hand_raised_sequence BIGINT
  CHECK (hand_raised_sequence IS NULL OR hand_raised_sequence > 0);

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
    'call_raised_hands_changed'
  ));
