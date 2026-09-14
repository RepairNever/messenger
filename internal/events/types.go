package events

import (
	"fmt"
	"time"

	packetspb "msgnr/internal/gen/proto"
)

// StoredEvent is a row from workspace_events enriched with the decoded proto payload.
type StoredEvent struct {
	Seq        int64
	EventID    string
	EventType  string
	ChannelID  string // may be empty
	OccurredAt time.Time
	// Proto is the fully-constructed ServerEvent ready to fan out.
	Proto *packetspb.ServerEvent
}

// AppendParams holds the arguments for AppendEventTx.
type AppendParams struct {
	EventID      string // stable idempotency key (UUID)
	EventType    string // must match payload oneof case
	ChannelID    string // optional; empty → stored as NULL
	PayloadJSON  []byte // JSONB-encoded payload
	OccurredAt   time.Time
	ProtoPayload *packetspb.ServerEvent // pre-built proto; Seq/EventID filled in after insert
}

// eventTypeToProto maps DB text values to proto EventType.
var eventTypeToProto = map[string]packetspb.EventType{
	"conversation_upserted":      packetspb.EventType_EVENT_TYPE_CONVERSATION_UPSERTED,
	"conversation_removed":       packetspb.EventType_EVENT_TYPE_CONVERSATION_REMOVED,
	"membership_changed":         packetspb.EventType_EVENT_TYPE_MEMBERSHIP_CHANGED,
	"message_created":            packetspb.EventType_EVENT_TYPE_MESSAGE_CREATED,
	"message_updated":            packetspb.EventType_EVENT_TYPE_MESSAGE_UPDATED,
	"message_deleted":            packetspb.EventType_EVENT_TYPE_MESSAGE_DELETED,
	"read_counter_updated":       packetspb.EventType_EVENT_TYPE_READ_COUNTER_UPDATED,
	"notification_added":         packetspb.EventType_EVENT_TYPE_NOTIFICATION_ADDED,
	"notification_resolved":      packetspb.EventType_EVENT_TYPE_NOTIFICATION_RESOLVED,
	"call_invite_created":        packetspb.EventType_EVENT_TYPE_CALL_INVITE_CREATED,
	"call_invite_cancelled":      packetspb.EventType_EVENT_TYPE_CALL_INVITE_CANCELLED,
	"call_state_changed":         packetspb.EventType_EVENT_TYPE_CALL_STATE_CHANGED,
	"user_call_presence_changed": packetspb.EventType_EVENT_TYPE_USER_CALL_PRESENCE_CHANGED,
	"secret_history_invalidated": packetspb.EventType_EVENT_TYPE_SECRET_HISTORY_INVALIDATED,
	"dm_history_cleared":         packetspb.EventType_EVENT_TYPE_DM_HISTORY_CLEARED,
	"thread_summary_updated":     packetspb.EventType_EVENT_TYPE_THREAD_SUMMARY_UPDATED,
	"reaction_updated":           packetspb.EventType_EVENT_TYPE_REACTION_UPDATED,
	"user_identity_updated":      packetspb.EventType_EVENT_TYPE_USER_IDENTITY_UPDATED,
	"task_status_changed":        packetspb.EventType_EVENT_TYPE_TASK_STATUS_CHANGED,
	"call_raised_hands_changed":  packetspb.EventType_EVENT_TYPE_CALL_RAISED_HANDS_CHANGED,
}

// protoToEventType is the reverse of eventTypeToProto.
var protoToEventType = func() map[packetspb.EventType]string {
	m := make(map[packetspb.EventType]string, len(eventTypeToProto))
	for k, v := range eventTypeToProto {
		m[v] = k
	}
	return m
}()

// DBTextToProtoEventType converts a DB event_type string to the proto enum.
// Returns an error if the value is not recognised.
func DBTextToProtoEventType(dbText string) (packetspb.EventType, error) {
	v, ok := eventTypeToProto[dbText]
	if !ok {
		return packetspb.EventType_EVENT_TYPE_UNSPECIFIED, fmt.Errorf("unknown event_type %q", dbText)
	}
	return v, nil
}

// ProtoEventTypeToDBText converts a proto EventType to the DB text value.
// Returns an error if the value is not recognised.
func ProtoEventTypeToDBText(et packetspb.EventType) (string, error) {
	v, ok := protoToEventType[et]
	if !ok {
		return "", fmt.Errorf("unknown proto EventType %v", et)
	}
	return v, nil
}

// ValidateEventTypePayload checks that the event_type DB string matches the
// payload oneof case set on the ServerEvent.
func ValidateEventTypePayload(dbText string, evt *packetspb.ServerEvent) error {
	expected, err := DBTextToProtoEventType(dbText)
	if err != nil {
		return err
	}
	if evt.GetEventType() != expected {
		return fmt.Errorf("event_type mismatch: DB=%q proto=%v", dbText, evt.GetEventType())
	}
	// Verify the oneof payload case matches.
	switch expected {
	case packetspb.EventType_EVENT_TYPE_CONVERSATION_UPSERTED:
		if evt.GetConversationUpserted() == nil {
			return fmt.Errorf("event_type %q requires conversation_upserted payload", dbText)
		}
	case packetspb.EventType_EVENT_TYPE_CONVERSATION_REMOVED:
		if evt.GetConversationRemoved() == nil {
			return fmt.Errorf("event_type %q requires conversation_removed payload", dbText)
		}
	case packetspb.EventType_EVENT_TYPE_MEMBERSHIP_CHANGED:
		if evt.GetMembershipChanged() == nil {
			return fmt.Errorf("event_type %q requires membership_changed payload", dbText)
		}
	case packetspb.EventType_EVENT_TYPE_MESSAGE_CREATED:
		if evt.GetMessageCreated() == nil {
			return fmt.Errorf("event_type %q requires message_created payload", dbText)
		}
	case packetspb.EventType_EVENT_TYPE_MESSAGE_UPDATED:
		if evt.GetMessageUpdated() == nil {
			return fmt.Errorf("event_type %q requires message_updated payload", dbText)
		}
	case packetspb.EventType_EVENT_TYPE_MESSAGE_DELETED:
		if evt.GetMessageDeleted() == nil {
			return fmt.Errorf("event_type %q requires message_deleted payload", dbText)
		}
	case packetspb.EventType_EVENT_TYPE_READ_COUNTER_UPDATED:
		if evt.GetReadCounterUpdated() == nil {
			return fmt.Errorf("event_type %q requires read_counter_updated payload", dbText)
		}
	case packetspb.EventType_EVENT_TYPE_NOTIFICATION_ADDED:
		if evt.GetNotificationAdded() == nil {
			return fmt.Errorf("event_type %q requires notification_added payload", dbText)
		}
	case packetspb.EventType_EVENT_TYPE_NOTIFICATION_RESOLVED:
		if evt.GetNotificationResolved() == nil {
			return fmt.Errorf("event_type %q requires notification_resolved payload", dbText)
		}
	case packetspb.EventType_EVENT_TYPE_CALL_INVITE_CREATED:
		if evt.GetCallInviteCreated() == nil {
			return fmt.Errorf("event_type %q requires call_invite_created payload", dbText)
		}
	case packetspb.EventType_EVENT_TYPE_CALL_INVITE_CANCELLED:
		if evt.GetCallInviteCancelled() == nil {
			return fmt.Errorf("event_type %q requires call_invite_cancelled payload", dbText)
		}
	case packetspb.EventType_EVENT_TYPE_CALL_STATE_CHANGED:
		if evt.GetCallStateChanged() == nil {
			return fmt.Errorf("event_type %q requires call_state_changed payload", dbText)
		}
	case packetspb.EventType_EVENT_TYPE_CALL_RAISED_HANDS_CHANGED:
		if evt.GetCallRaisedHandsChanged() == nil {
			return fmt.Errorf("event_type %q requires call_raised_hands_changed payload", dbText)
		}
	case packetspb.EventType_EVENT_TYPE_USER_CALL_PRESENCE_CHANGED:
		if evt.GetUserCallPresenceChanged() == nil {
			return fmt.Errorf("event_type %q requires user_call_presence_changed payload", dbText)
		}
	case packetspb.EventType_EVENT_TYPE_THREAD_SUMMARY_UPDATED:
		if evt.GetThreadSummaryUpdated() == nil {
			return fmt.Errorf("event_type %q requires thread_summary_updated payload", dbText)
		}
	case packetspb.EventType_EVENT_TYPE_REACTION_UPDATED:
		if evt.GetReactionUpdated() == nil {
			return fmt.Errorf("event_type %q requires reaction_updated payload", dbText)
		}
	case packetspb.EventType_EVENT_TYPE_USER_IDENTITY_UPDATED:
		if evt.GetUserIdentityUpdated() == nil {
			return fmt.Errorf("event_type %q requires user_identity_updated payload", dbText)
		}
	case packetspb.EventType_EVENT_TYPE_TASK_STATUS_CHANGED:
		if evt.GetTaskStatusChanged() == nil {
			return fmt.Errorf("event_type %q requires task_status_changed payload", dbText)
		}
	case packetspb.EventType_EVENT_TYPE_SECRET_HISTORY_INVALIDATED:
		if evt.GetSecretHistoryInvalidated() == nil {
			return fmt.Errorf("event_type %q requires secret_history_invalidated payload", dbText)
		}
	case packetspb.EventType_EVENT_TYPE_DM_HISTORY_CLEARED:
		if evt.GetDmHistoryCleared() == nil {
			return fmt.Errorf("event_type %q requires dm_history_cleared payload", dbText)
		}
	}
	return nil
}
