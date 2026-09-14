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
    'dm_history_cleared'
  ));
