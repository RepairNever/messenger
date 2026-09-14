package bootstrap

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"google.golang.org/protobuf/types/known/timestamppb"

	"msgnr/internal/auth"
	"msgnr/internal/config"
	packetspb "msgnr/internal/gen/proto"
	"msgnr/internal/gen/queries"
	"msgnr/internal/userstatus"
)

var (
	ErrInvalidRequest   = errors.New("invalid bootstrap request")
	ErrInvalidPageToken = errors.New("invalid bootstrap page token")
	ErrSessionExpired   = errors.New("bootstrap session expired")
	ErrSessionMismatch  = errors.New("bootstrap session mismatch")
)

type Service struct {
	cfg  *config.Config
	pool *pgxpool.Pool
	q    *queries.Queries
}

type pageToken struct {
	PageIndex   int `json:"page_index"`
	NextOrdinal int `json:"next_ordinal"`
}

type bootstrapSelfSummary struct {
	UserID                uuid.UUID
	DisplayName           string
	AvatarURL             string
	CustomStatusText      string
	CustomStatusEmoji     string
	CustomStatusExpiresAt sql.NullTime
	Role                  string
}

func NewService(pool *pgxpool.Pool, cfg *config.Config) *Service {
	return &Service{
		cfg:  cfg,
		pool: pool,
		q:    queries.New(stdlib.OpenDBFromPool(pool)),
	}
}

func (s *Service) Bootstrap(ctx context.Context, principal auth.Principal, req *packetspb.BootstrapRequest) (*packetspb.BootstrapResponse, error) {
	if req == nil || req.GetClientInstanceId() == "" {
		return nil, ErrInvalidRequest
	}
	if _, err := s.q.DeleteExpiredBootstrapSessions(ctx); err != nil {
		return nil, fmt.Errorf("bootstrap cleanup: %w", err)
	}

	if req.GetBootstrapSessionId() == "" {
		return s.bootstrapFirstPage(ctx, principal, req)
	}
	return s.bootstrapContinuation(ctx, principal, req)
}

func (s *Service) bootstrapFirstPage(ctx context.Context, principal auth.Principal, req *packetspb.BootstrapRequest) (*packetspb.BootstrapResponse, error) {
	pageSize := s.clampPageSize(req.GetPageSizeHint())
	snapshotSeq, err := s.q.GetLatestWorkspaceEventSeq(ctx)
	if err != nil {
		return nil, fmt.Errorf("bootstrap latest seq: %w", err)
	}

	total, err := s.q.CountBootstrapConversations(ctx, queries.CountBootstrapConversationsParams{
		UserID:          principal.UserID,
		IncludeArchived: req.GetIncludeArchived(),
	})
	if err != nil {
		return nil, fmt.Errorf("bootstrap count conversations: %w", err)
	}

	conversationIDs, err := s.q.ListBootstrapConversationIDs(ctx, queries.ListBootstrapConversationIDsParams{
		UserID:          principal.UserID,
		IncludeArchived: req.GetIncludeArchived(),
	})
	if err != nil {
		return nil, fmt.Errorf("bootstrap list conversations: %w", err)
	}

	session, err := s.q.CreateBootstrapSession(ctx, queries.CreateBootstrapSessionParams{
		UserID:           principal.UserID,
		ClientInstanceID: req.GetClientInstanceId(),
		SnapshotSeq:      snapshotSeq,
		IncludeArchived:  req.GetIncludeArchived(),
		ExpiresAt:        time.Now().UTC().Add(s.cfg.BootstrapSessionTTL),
	})
	if err != nil {
		return nil, fmt.Errorf("bootstrap create session: %w", err)
	}

	if err := s.insertSessionItems(ctx, session.ID, conversationIDs, pageSize); err != nil {
		return nil, err
	}

	stats, err := s.q.GetBootstrapSessionStats(ctx, session.ID)
	if err != nil {
		return nil, fmt.Errorf("bootstrap session stats: %w", err)
	}
	return s.buildResponse(ctx, principal.UserID, session, 0, total, stats)
}

func (s *Service) bootstrapContinuation(ctx context.Context, principal auth.Principal, req *packetspb.BootstrapRequest) (*packetspb.BootstrapResponse, error) {
	sessionID, err := uuid.Parse(req.GetBootstrapSessionId())
	if err != nil {
		return nil, ErrInvalidRequest
	}
	session, err := s.q.GetBootstrapSession(ctx, sessionID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrInvalidRequest
		}
		return nil, fmt.Errorf("bootstrap get session: %w", err)
	}

	if session.UserID != principal.UserID || session.ClientInstanceID != req.GetClientInstanceId() {
		return nil, ErrSessionMismatch
	}
	if time.Now().UTC().After(session.ExpiresAt) {
		return nil, ErrSessionExpired
	}
	if req.GetPageToken() == "" {
		return nil, ErrInvalidPageToken
	}

	token, err := decodePageToken(req.GetPageToken())
	if err != nil || token.PageIndex <= 0 {
		return nil, ErrInvalidPageToken
	}

	stats, err := s.q.GetBootstrapSessionStats(ctx, session.ID)
	if err != nil {
		return nil, fmt.Errorf("bootstrap session stats: %w", err)
	}
	if token.PageIndex > stats.MaxPageIndex {
		return nil, ErrInvalidPageToken
	}
	firstOrdinal, err := s.q.GetBootstrapPageFirstOrdinal(ctx, queries.GetBootstrapPageFirstOrdinalParams{
		SessionID: session.ID,
		PageIndex: token.PageIndex,
	})
	if err != nil {
		return nil, fmt.Errorf("bootstrap page first ordinal: %w", err)
	}
	if firstOrdinal < 0 || firstOrdinal != token.NextOrdinal {
		return nil, ErrInvalidPageToken
	}

	resp, err := s.buildResponse(ctx, principal.UserID, session, token.PageIndex, stats.TotalItems, stats)
	if err != nil {
		return nil, err
	}
	return resp, nil
}

func (s *Service) buildResponse(ctx context.Context, userID uuid.UUID, session queries.BootstrapSession, pageIndex int, total int, stats queries.GetBootstrapSessionStatsRow) (*packetspb.BootstrapResponse, error) {
	if pageIndex > stats.MaxPageIndex && stats.TotalItems > 0 {
		return nil, ErrInvalidPageToken
	}

	conversations, err := s.q.ListBootstrapConversationsPage(ctx, queries.ListBootstrapConversationsPageParams{
		SessionID: session.ID,
		PageIndex: pageIndex,
	})
	if err != nil {
		return nil, fmt.Errorf("bootstrap page conversations: %w", err)
	}
	unread, err := s.q.ListBootstrapUnreadCountersForPage(ctx, queries.ListBootstrapUnreadCountersForPageParams{
		SessionID: session.ID,
		PageIndex: pageIndex,
	})
	if err != nil {
		return nil, fmt.Errorf("bootstrap page unread: %w", err)
	}
	presence, err := s.q.ListBootstrapPresenceForPage(ctx, queries.ListBootstrapPresenceForPageParams{
		SessionID: session.ID,
		PageIndex: pageIndex,
	})
	if err != nil {
		return nil, fmt.Errorf("bootstrap page presence: %w", err)
	}

	resp := &packetspb.BootstrapResponse{
		SnapshotSeq:                 session.SnapshotSeq,
		Conversations:               make([]*packetspb.ConversationSummary, 0, len(conversations)),
		Unread:                      make([]*packetspb.UnreadCounter, 0, len(unread)),
		Presence:                    make([]*packetspb.PresenceEvent, 0, len(presence)),
		HasMore:                     pageIndex < stats.MaxPageIndex,
		BootstrapSessionId:          session.ID.String(),
		BootstrapExpiresAt:          timestamppb.New(session.ExpiresAt),
		PageIndex:                   uint32(pageIndex),
		PageSizeEffective:           uint32(len(conversations)),
		EstimatedTotalConversations: uint32(total),
	}

	for _, row := range conversations {
		resp.Conversations = append(resp.Conversations, &packetspb.ConversationSummary{
			ConversationId:     row.ConversationID.String(),
			ConversationType:   mapConversationType(row.ConversationType),
			Title:              row.Title,
			Topic:              row.Topic,
			IsArchived:         row.IsArchived,
			NotificationLevel:  packetspb.NotificationLevel(row.NotificationLevel),
			LastMessageSeq:     row.LastMessageSeq,
			LastMessagePreview: row.LastMessagePreview,
			LastActivityAt:     timestamppb.New(row.LastActivityAt),
			MemberCount:        int32(row.MemberCount),
			Presence:           mapPresenceStatus(row.Presence),
			EncryptionMode:     mapConversationEncryptionMode(row.EncryptionMode),
		})
	}

	for _, row := range unread {
		resp.Unread = append(resp.Unread, &packetspb.UnreadCounter{
			ConversationId:         row.ConversationID.String(),
			UnreadMessages:         int32(row.UnreadMessages),
			UnreadMentions:         int32(row.UnreadMentions),
			HasUnreadThreadReplies: row.HasUnreadThreadReplies,
			LastReadSeq:            row.LastReadSeq,
		})
	}

	for _, row := range presence {
		resp.Presence = append(resp.Presence, &packetspb.PresenceEvent{
			UserId:            row.UserID.String(),
			EffectivePresence: mapPresenceStatus(row.Status),
			LastActiveAt:      timestamppb.New(row.LastActiveAt),
		})
	}

	if pageIndex == 0 {
		if err := s.fillFirstPageFields(ctx, userID, resp); err != nil {
			return nil, err
		}
	}
	if resp.HasMore {
		nextOrdinal := 0
		if len(conversations) > 0 {
			nextOrdinal = conversations[len(conversations)-1].Ordinal + 1
		}
		resp.NextPageToken = encodePageToken(pageToken{
			PageIndex:   pageIndex + 1,
			NextOrdinal: nextOrdinal,
		})
	}

	return resp, nil
}

func (s *Service) fillFirstPageFields(ctx context.Context, userID uuid.UUID, resp *packetspb.BootstrapResponse) error {
	workspace, err := s.q.GetBootstrapWorkspaceSummary(ctx, userID)
	if err == nil {
		resp.Workspace = &packetspb.WorkspaceSummary{
			WorkspaceId:   workspace.WorkspaceID.String(),
			WorkspaceName: workspace.WorkspaceName,
			SelfUser: &packetspb.UserSummary{
				UserId:       workspace.SelfUserID.String(),
				DisplayName:  workspace.SelfDisplayName,
				AvatarUrl:    workspace.SelfAvatarUrl,
				CustomStatus: userstatus.ToProto(userstatus.ActiveFromNullTime(workspace.SelfCustomStatusText, workspace.SelfCustomStatusEmoji, workspace.SelfCustomStatusExpiresAt, time.Now().UTC())),
			},
			SelfRole: mapWorkspaceRole(workspace.SelfRole),
		}
		resp.UserRole = mapWorkspaceRole(workspace.SelfRole)
	} else if errors.Is(err, sql.ErrNoRows) {
		selfSummary, fallbackErr := s.loadBootstrapSelfSummary(ctx, userID)
		if fallbackErr != nil {
			return fmt.Errorf("bootstrap self summary fallback: %w", fallbackErr)
		}
		resp.Workspace = &packetspb.WorkspaceSummary{
			WorkspaceName: "Workspace",
			SelfUser: &packetspb.UserSummary{
				UserId:       selfSummary.UserID.String(),
				DisplayName:  selfSummary.DisplayName,
				AvatarUrl:    selfSummary.AvatarURL,
				CustomStatus: userstatus.ToProto(userstatus.ActiveFromNullTime(selfSummary.CustomStatusText, selfSummary.CustomStatusEmoji, selfSummary.CustomStatusExpiresAt, time.Now().UTC())),
			},
			SelfRole: mapWorkspaceRole(selfSummary.Role),
		}
		resp.UserRole = mapWorkspaceRole(selfSummary.Role)
	} else {
		return fmt.Errorf("bootstrap workspace summary: %w", err)
	}

	activeCalls, err := s.q.ListBootstrapActiveCalls(ctx, userID)
	if err != nil {
		return fmt.Errorf("bootstrap active calls: %w", err)
	}
	resp.ActiveCalls = make([]*packetspb.ActiveCallSummary, 0, len(activeCalls))
	for _, row := range activeCalls {
		raisedHands, err := s.listCallRaisedHands(ctx, row.ID)
		if err != nil {
			return fmt.Errorf("bootstrap raised hands for call %s: %w", row.ID, err)
		}
		resp.ActiveCalls = append(resp.ActiveCalls, &packetspb.ActiveCallSummary{
			CallId:           row.ID.String(),
			ConversationId:   row.ChannelID.String(),
			Status:           mapCallStatus(row.Status),
			ParticipantCount: int32(row.ParticipantCount),
			RaisedHands:      raisedHands,
		})
	}

	pendingInvites, err := s.q.ListBootstrapPendingInvites(ctx, userID)
	if err != nil {
		return fmt.Errorf("bootstrap pending invites: %w", err)
	}
	resp.PendingInvites = make([]*packetspb.CallInviteSummary, 0, len(pendingInvites))
	for _, row := range pendingInvites {
		resp.PendingInvites = append(resp.PendingInvites, &packetspb.CallInviteSummary{
			InviteId:       row.ID.String(),
			CallId:         row.CallID.String(),
			ConversationId: row.ChannelID.String(),
			InviterUserId:  row.InviterID.String(),
			CreatedAt:      timestamppb.New(row.CreatedAt),
			ExpiresAt:      timestamppb.New(row.ExpiresAt),
			State:          mapInviteState(row.State),
		})
	}

	userCallPresence, err := s.q.ListBootstrapUserCallPresence(ctx)
	if err != nil {
		return fmt.Errorf("bootstrap user call presence: %w", err)
	}
	resp.UserCallPresence = make([]*packetspb.UserCallPresenceSummary, 0, len(userCallPresence))
	for _, row := range userCallPresence {
		resp.UserCallPresence = append(resp.UserCallPresence, &packetspb.UserCallPresenceSummary{
			UserId:          row.UserID.String(),
			ActiveCallCount: int32(row.ActiveCallCount),
		})
	}

	notifications, err := s.q.ListBootstrapNotifications(ctx, userID)
	if err != nil {
		return fmt.Errorf("bootstrap notifications: %w", err)
	}
	resp.Notifications = make([]*packetspb.NotificationSummary, 0, len(notifications))
	for _, row := range notifications {
		conversationID := ""
		if row.ChannelID.Valid {
			conversationID = row.ChannelID.UUID.String()
		}
		messageID := ""
		if row.MessageID.Valid {
			messageID = row.MessageID.UUID.String()
		}
		threadRootMessageID := ""
		if row.ThreadRootMessageID.Valid {
			threadRootMessageID = row.ThreadRootMessageID.UUID.String()
		}
		resp.Notifications = append(resp.Notifications, &packetspb.NotificationSummary{
			NotificationId:      row.ID.String(),
			Type:                mapNotificationType(row.Type),
			Title:               row.Title,
			Body:                row.Body,
			ConversationId:      conversationID,
			IsRead:              row.IsRead,
			CreatedAt:           timestamppb.New(row.CreatedAt),
			MessageId:           messageID,
			ThreadRootMessageId: threadRootMessageID,
		})
	}

	return nil
}

func (s *Service) listCallRaisedHands(ctx context.Context, callID uuid.UUID) ([]*packetspb.CallRaisedHand, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT user_id,
		       ROW_NUMBER() OVER (ORDER BY hand_raised_sequence ASC)::int
		  FROM call_participants
		 WHERE call_id = $1
		   AND left_at IS NULL
		   AND hand_raised_sequence IS NOT NULL
		 ORDER BY hand_raised_sequence ASC`, callID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	hands := make([]*packetspb.CallRaisedHand, 0, 4)
	for rows.Next() {
		var userID uuid.UUID
		var position int
		if err := rows.Scan(&userID, &position); err != nil {
			return nil, err
		}
		hands = append(hands, &packetspb.CallRaisedHand{
			UserId:   userID.String(),
			Position: int32(position),
		})
	}
	return hands, rows.Err()
}

func (s *Service) loadBootstrapSelfSummary(ctx context.Context, userID uuid.UUID) (bootstrapSelfSummary, error) {
	const query = `
SELECT id, display_name, avatar_url, custom_status_text, custom_status_emoji, custom_status_expires_at, role
FROM users
WHERE id = $1
`
	var summary bootstrapSelfSummary
	err := s.pool.QueryRow(ctx, query, userID).Scan(
		&summary.UserID,
		&summary.DisplayName,
		&summary.AvatarURL,
		&summary.CustomStatusText,
		&summary.CustomStatusEmoji,
		&summary.CustomStatusExpiresAt,
		&summary.Role,
	)
	return summary, err
}

func (s *Service) clampPageSize(hint uint32) int {
	pageSize := int(hint)
	if pageSize == 0 {
		pageSize = s.cfg.BootstrapDefaultPageSize
	}
	if pageSize < 1 {
		pageSize = 1
	}
	if s.cfg.BootstrapMaxPageSize > 0 && pageSize > s.cfg.BootstrapMaxPageSize {
		return s.cfg.BootstrapMaxPageSize
	}
	return pageSize
}

func (s *Service) insertSessionItems(ctx context.Context, sessionID uuid.UUID, conversationIDs []uuid.UUID, pageSize int) error {
	if len(conversationIDs) == 0 {
		return nil
	}

	batch := &pgx.Batch{}
	for ordinal, conversationID := range conversationIDs {
		batch.Queue(
			`INSERT INTO bootstrap_session_items (session_id, page_index, conversation_id, ordinal)
			 VALUES ($1, $2, $3, $4)`,
			sessionID,
			ordinal/pageSize,
			conversationID,
			ordinal,
		)
	}

	results := s.pool.SendBatch(ctx, batch)
	defer results.Close()
	for range conversationIDs {
		if _, err := results.Exec(); err != nil {
			return fmt.Errorf("bootstrap insert session items: %w", err)
		}
	}
	return nil
}

func encodePageToken(token pageToken) string {
	body, _ := json.Marshal(token)
	return base64.RawURLEncoding.EncodeToString(body)
}

func decodePageToken(raw string) (pageToken, error) {
	var token pageToken
	body, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return token, err
	}
	if err := json.Unmarshal(body, &token); err != nil {
		return token, err
	}
	return token, nil
}

func mapConversationType(raw string) packetspb.ConversationType {
	switch raw {
	case "dm":
		return packetspb.ConversationType_CONVERSATION_TYPE_DM
	case "channel_public":
		return packetspb.ConversationType_CONVERSATION_TYPE_CHANNEL_PUBLIC
	case "channel_private":
		return packetspb.ConversationType_CONVERSATION_TYPE_CHANNEL_PRIVATE
	default:
		return packetspb.ConversationType_CONVERSATION_TYPE_UNSPECIFIED
	}
}

func mapPresenceStatus(raw string) packetspb.PresenceStatus {
	switch raw {
	case "online":
		return packetspb.PresenceStatus_PRESENCE_STATUS_ONLINE
	case "away":
		return packetspb.PresenceStatus_PRESENCE_STATUS_AWAY
	case "offline":
		return packetspb.PresenceStatus_PRESENCE_STATUS_OFFLINE
	default:
		return packetspb.PresenceStatus_PRESENCE_STATUS_UNSPECIFIED
	}
}

func mapConversationEncryptionMode(raw string) packetspb.ConversationEncryptionMode {
	switch raw {
	case "dm_pairwise_signal_v1":
		return packetspb.ConversationEncryptionMode_CONVERSATION_ENCRYPTION_MODE_DM_PAIRWISE_SIGNAL_V1
	default:
		return packetspb.ConversationEncryptionMode_CONVERSATION_ENCRYPTION_MODE_NONE
	}
}

func mapWorkspaceRole(raw string) packetspb.WorkspaceRole {
	switch raw {
	case "owner":
		return packetspb.WorkspaceRole_WORKSPACE_ROLE_OWNER
	case "admin":
		return packetspb.WorkspaceRole_WORKSPACE_ROLE_ADMIN
	case "member":
		return packetspb.WorkspaceRole_WORKSPACE_ROLE_MEMBER
	default:
		return packetspb.WorkspaceRole_WORKSPACE_ROLE_UNSPECIFIED
	}
}

func mapCallStatus(raw string) packetspb.CallStatus {
	switch raw {
	case "active":
		return packetspb.CallStatus_CALL_STATUS_ACTIVE
	case "ended":
		return packetspb.CallStatus_CALL_STATUS_ENDED
	default:
		return packetspb.CallStatus_CALL_STATUS_UNSPECIFIED
	}
}

func mapInviteState(raw string) packetspb.InviteState {
	switch raw {
	case "created":
		return packetspb.InviteState_INVITE_STATE_CREATED
	case "accepted":
		return packetspb.InviteState_INVITE_STATE_ACCEPTED
	case "rejected":
		return packetspb.InviteState_INVITE_STATE_REJECTED
	case "cancelled":
		return packetspb.InviteState_INVITE_STATE_CANCELLED
	case "expired":
		return packetspb.InviteState_INVITE_STATE_EXPIRED
	default:
		return packetspb.InviteState_INVITE_STATE_UNSPECIFIED
	}
}

func mapNotificationType(raw string) packetspb.NotificationType {
	switch raw {
	case "mention":
		return packetspb.NotificationType_NOTIFICATION_TYPE_MENTION
	case "thread_reply":
		return packetspb.NotificationType_NOTIFICATION_TYPE_THREAD_REPLY
	case "call_invite":
		return packetspb.NotificationType_NOTIFICATION_TYPE_CALL_INVITE
	case "call_missed":
		return packetspb.NotificationType_NOTIFICATION_TYPE_CALL_MISSED
	case "system":
		return packetspb.NotificationType_NOTIFICATION_TYPE_SYSTEM
	default:
		return packetspb.NotificationType_NOTIFICATION_TYPE_UNSPECIFIED
	}
}
