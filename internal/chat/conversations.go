package chat

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/types/known/timestamppb"

	packetspb "msgnr/internal/gen/proto"
	"msgnr/internal/gen/queries"
	"msgnr/internal/userstatus"
)

const (
	ConversationEncryptionNone             = "none"
	ConversationEncryptionDMPairwiseSignal = "dm_pairwise_signal_v1"
	MessageContentPlaintext                = "plaintext"
	MessageContentDMPairwiseSignal         = "dm_pairwise_signal_v1"
)

// ListDMCandidates returns active users except the requester.
func (s *Service) ListDMCandidates(ctx context.Context, requesterID uuid.UUID) ([]DMCandidate, error) {
	rows, err := s.q.ListDMCandidates(ctx, requesterID)
	if err != nil {
		return nil, fmt.Errorf("chat.ListDMCandidates query: %w", err)
	}

	candidates := make([]DMCandidate, 0, len(rows))
	for _, row := range rows {
		candidates = append(candidates, DMCandidate{
			UserID:      row.ID,
			DisplayName: row.DisplayName,
			Email:       row.Email,
			AvatarURL:   row.AvatarUrl,
			CustomStatus: userstatus.ActiveFromNullTime(
				row.CustomStatusText,
				row.CustomStatusEmoji,
				row.CustomStatusExpiresAt,
				time.Now().UTC(),
			),
		})
	}
	return candidates, nil
}

// ListAvailablePublicChannels returns public channels where requester is not an
// active member (archived memberships are considered joinable).
func (s *Service) ListAvailablePublicChannels(ctx context.Context, requesterID uuid.UUID) ([]JoinableChannel, error) {
	rows, err := s.q.ListAvailablePublicChannels(ctx, requesterID)
	if err != nil {
		return nil, fmt.Errorf("chat.ListAvailablePublicChannels query: %w", err)
	}

	channels := make([]JoinableChannel, 0, len(rows))
	for _, row := range rows {
		channels = append(channels, JoinableChannel{
			ID:             row.ID,
			Kind:           row.Kind,
			Visibility:     row.Visibility,
			Name:           row.Name,
			LastActivityAt: row.LastActivityAt,
		})
	}
	return channels, nil
}

// ListConversationMembers returns active members for a conversation.
func (s *Service) ListConversationMembers(ctx context.Context, requesterID, conversationID uuid.UUID) ([]ConversationMember, error) {
	isMember, err := s.q.IsChannelMember(ctx, queries.IsChannelMemberParams{
		ChannelID: conversationID,
		UserID:    requesterID,
	})
	if err != nil {
		return nil, fmt.Errorf("chat.ListConversationMembers membership check: %w", err)
	}
	if !isMember {
		return nil, ErrNotMember
	}

	rows, err := s.q.ListConversationMembers(ctx, conversationID)
	if err != nil {
		return nil, fmt.Errorf("chat.ListConversationMembers query: %w", err)
	}

	members := make([]ConversationMember, 0, len(rows))
	for _, row := range rows {
		members = append(members, ConversationMember{
			UserID:      row.ID,
			DisplayName: row.DisplayName,
			Email:       row.Email,
			AvatarURL:   row.AvatarUrl,
			CustomStatus: userstatus.ActiveFromNullTime(
				row.CustomStatusText,
				row.CustomStatusEmoji,
				row.CustomStatusExpiresAt,
				time.Now().UTC(),
			),
		})
	}
	return members, nil
}

func (s *Service) SearchTagEntities(ctx context.Context, requesterID, conversationID uuid.UUID, query string) (TagSearchResult, error) {
	isMember, err := s.q.IsChannelMember(ctx, queries.IsChannelMemberParams{
		ChannelID: conversationID,
		UserID:    requesterID,
	})
	if err != nil {
		return TagSearchResult{}, fmt.Errorf("chat.SearchTagEntities membership check: %w", err)
	}
	if !isMember {
		return TagSearchResult{}, ErrNotMember
	}

	query = strings.TrimSpace(query)
	likeQuery := "%" + query + "%"

	result := TagSearchResult{
		Users:     make([]TagSearchUserResult, 0, 5),
		Tasks:     make([]TagSearchTaskResult, 0, 5),
		Documents: make([]TagSearchDocumentResult, 0, 5),
	}

	if query != "" {
		userRows, err := s.q.SearchTagUsersFiltered(ctx, queries.SearchTagUsersFilteredParams{
			ConversationID: conversationID,
			RequesterID:    requesterID,
			LikeQuery:      likeQuery,
		})
		if err != nil {
			return TagSearchResult{}, fmt.Errorf("chat.SearchTagEntities users: %w", err)
		}
		for _, row := range userRows {
			result.Users = append(result.Users, TagSearchUserResult{
				UserID:      row.ID,
				DisplayName: row.DisplayName,
				Email:       row.Email,
				AvatarURL:   row.AvatarUrl,
				CustomStatus: userstatus.ActiveFromNullTime(
					row.CustomStatusText,
					row.CustomStatusEmoji,
					row.CustomStatusExpiresAt,
					time.Now().UTC(),
				),
				Presence: row.Presence,
			})
		}

		taskRows, err := s.q.SearchTagTasksFiltered(ctx, likeQuery)
		if err != nil {
			return TagSearchResult{}, fmt.Errorf("chat.SearchTagEntities tasks: %w", err)
		}
		for _, row := range taskRows {
			result.Tasks = append(result.Tasks, TagSearchTaskResult{
				TaskID:    row.ID,
				PublicID:  row.PublicID,
				Title:     row.Title,
				UpdatedAt: row.UpdatedAt,
			})
		}

		documentRows, err := s.q.SearchTagDocumentsFiltered(ctx, queries.SearchTagDocumentsFilteredParams{
			RequesterID: requesterID,
			LikeQuery:   likeQuery,
		})
		if err != nil {
			return TagSearchResult{}, fmt.Errorf("chat.SearchTagEntities documents: %w", err)
		}
		for _, row := range documentRows {
			result.Documents = append(result.Documents, TagSearchDocumentResult{
				DocumentID: row.ID,
				Title:      row.Title,
				UpdatedAt:  row.UpdatedAt,
			})
		}
		return result, nil
	}

	userRows, err := s.q.SearchTagUsersRecent(ctx, queries.SearchTagUsersRecentParams{
		ConversationID: conversationID,
		RequesterID:    requesterID,
	})
	if err != nil {
		return TagSearchResult{}, fmt.Errorf("chat.SearchTagEntities users: %w", err)
	}
	for _, row := range userRows {
		result.Users = append(result.Users, TagSearchUserResult{
			UserID:      row.ID,
			DisplayName: row.DisplayName,
			Email:       row.Email,
			AvatarURL:   row.AvatarUrl,
			CustomStatus: userstatus.ActiveFromNullTime(
				row.CustomStatusText,
				row.CustomStatusEmoji,
				row.CustomStatusExpiresAt,
				time.Now().UTC(),
			),
			Presence: row.Presence,
		})
	}

	taskRows, err := s.q.SearchTagTasksRecent(ctx)
	if err != nil {
		return TagSearchResult{}, fmt.Errorf("chat.SearchTagEntities tasks: %w", err)
	}
	for _, row := range taskRows {
		result.Tasks = append(result.Tasks, TagSearchTaskResult{
			TaskID:    row.ID,
			PublicID:  row.PublicID,
			Title:     row.Title,
			UpdatedAt: row.UpdatedAt,
		})
	}

	documentRows, err := s.q.SearchTagDocumentsRecent(ctx, requesterID)
	if err != nil {
		return TagSearchResult{}, fmt.Errorf("chat.SearchTagEntities documents: %w", err)
	}
	for _, row := range documentRows {
		result.Documents = append(result.Documents, TagSearchDocumentResult{
			DocumentID: row.ID,
			Title:      row.Title,
			UpdatedAt:  row.UpdatedAt,
		})
	}

	return result, nil
}

// ListActiveCallMembers returns active participants for the current active call in a conversation.
func (s *Service) ListActiveCallMembers(ctx context.Context, requesterID, conversationID uuid.UUID) ([]ConversationMember, error) {
	isMember, err := s.q.IsChannelMember(ctx, queries.IsChannelMemberParams{
		ChannelID: conversationID,
		UserID:    requesterID,
	})
	if err != nil {
		return nil, fmt.Errorf("chat.ListActiveCallMembers membership check: %w", err)
	}
	if !isMember {
		return nil, ErrNotMember
	}

	rows, err := s.q.ListActiveCallMembers(ctx, conversationID)
	if err != nil {
		return nil, fmt.Errorf("chat.ListActiveCallMembers query: %w", err)
	}

	members := make([]ConversationMember, 0, len(rows))
	for _, row := range rows {
		members = append(members, ConversationMember{
			UserID:      row.MemberID,
			DisplayName: row.DisplayName,
			Email:       row.Email,
			AvatarURL:   row.AvatarUrl,
			CustomStatus: userstatus.ActiveFromNullTime(
				row.CustomStatusText,
				row.CustomStatusEmoji,
				row.CustomStatusExpiresAt,
				time.Now().UTC(),
			),
		})
	}
	return members, nil
}

// JoinPublicChannels adds requester membership to eligible public channels and
// returns joined channels in the same order as requested IDs.
func (s *Service) JoinPublicChannels(ctx context.Context, requesterID uuid.UUID, channelIDs []uuid.UUID) ([]JoinableChannel, error) {
	if len(channelIDs) == 0 {
		return []JoinableChannel{}, nil
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("chat.JoinPublicChannels begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	joined := make([]JoinableChannel, 0, len(channelIDs))
	seen := make(map[uuid.UUID]struct{}, len(channelIDs))

	for _, channelID := range channelIDs {
		if _, ok := seen[channelID]; ok {
			continue
		}
		seen[channelID] = struct{}{}

		if _, err := tx.Exec(ctx, `
				INSERT INTO channel_members (channel_id, user_id)
				SELECT c.id, $2
				  FROM channels c
				 WHERE c.id = $1
				   AND c.kind = 'channel'
				   AND c.visibility = 'public'
				   AND c.is_archived = false
				ON CONFLICT (channel_id, user_id) DO UPDATE
				    SET is_archived = false`,
			channelID,
			requesterID,
		); err != nil {
			return nil, fmt.Errorf("chat.JoinPublicChannels insert member: %w", err)
		}

		var channel JoinableChannel
		err := tx.QueryRow(ctx, `
			SELECT c.id,
			       c.kind,
			       c.visibility,
			       COALESCE(NULLIF(c.name, ''), c.kind) AS name,
			       c.last_activity_at
			  FROM channels c
				  JOIN channel_members cm
				    ON cm.channel_id = c.id
				   AND cm.user_id = $2
				   AND cm.is_archived = false
				 WHERE c.id = $1
				   AND c.kind = 'channel'
				   AND c.visibility = 'public'
			   AND c.is_archived = false`,
			channelID,
			requesterID,
		).Scan(
			&channel.ID,
			&channel.Kind,
			&channel.Visibility,
			&channel.Name,
			&channel.LastActivityAt,
		)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				continue
			}
			return nil, fmt.Errorf("chat.JoinPublicChannels fetch channel: %w", err)
		}

		joined = append(joined, channel)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("chat.JoinPublicChannels commit: %w", err)
	}
	return joined, nil
}

// LeaveConversation archives requester membership from an existing
// conversation. The conversation and messages are preserved.
func (s *Service) LeaveConversation(ctx context.Context, requesterID, conversationID uuid.UUID) (LeaveConversationResult, error) {
	isSelfDM, err := s.q.IsSelfDMConversation(ctx, queries.IsSelfDMConversationParams{
		RequesterID:    requesterID,
		ConversationID: conversationID,
	})
	if err != nil {
		return LeaveConversationResult{}, fmt.Errorf("chat.LeaveConversation self dm check: %w", err)
	}
	if isSelfDM {
		return LeaveConversationResult{}, ErrSelfDMProtected
	}

	rowsAffected, err := s.q.ArchiveConversationMembership(ctx, queries.ArchiveConversationMembershipParams{
		ConversationID: conversationID,
		RequesterID:    requesterID,
	})
	if err != nil {
		return LeaveConversationResult{}, fmt.Errorf("chat.LeaveConversation archive membership: %w", err)
	}
	if rowsAffected == 0 {
		hasMembership, err := s.q.HasConversationMembership(ctx, queries.HasConversationMembershipParams{
			ConversationID: conversationID,
			UserID:         requesterID,
		})
		if err != nil {
			return LeaveConversationResult{}, fmt.Errorf("chat.LeaveConversation membership lookup: %w", err)
		}
		if !hasMembership {
			return LeaveConversationResult{}, ErrNotMember
		}
		// Already archived: treat as idempotent success with no duplicate removal event.
		return LeaveConversationResult{}, nil
	}
	return LeaveConversationResult{
		DirectDeliveries: []DirectDelivery{
			buildConversationRemovedDelivery(requesterID, conversationID, packetspb.ConversationRemovedReason_CONVERSATION_REMOVED_REASON_ARCHIVED),
		},
	}, nil
}

// RemoveConversationMember archives targetUserID's active membership from a
// public/private channel. Public channels require a workspace admin/owner;
// private channels allow any active member to remove another active member.
func (s *Service) RemoveConversationMember(ctx context.Context, requesterID uuid.UUID, requesterRole string, conversationID, targetUserID uuid.UUID) (RemoveConversationMemberResult, error) {
	if requesterID == targetUserID {
		return RemoveConversationMemberResult{}, ErrRemoveMemberForbidden
	}

	channel, err := s.q.GetRemovableChannelByID(ctx, conversationID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return RemoveConversationMemberResult{}, ErrNotPublicChannel
		}
		return RemoveConversationMemberResult{}, fmt.Errorf("chat.RemoveConversationMember fetch channel: %w", err)
	}
	if channel.IsArchived {
		return RemoveConversationMemberResult{}, ErrConversationArchived
	}
	if channel.Kind != "channel" || (channel.Visibility != "public" && channel.Visibility != "private") {
		return RemoveConversationMemberResult{}, ErrRemoveUnsupportedTarget
	}

	switch channel.Visibility {
	case "public":
		if requesterRole != "admin" && requesterRole != "owner" {
			return RemoveConversationMemberResult{}, ErrRemoveMemberForbidden
		}
	case "private":
		isMember, err := s.q.IsChannelMember(ctx, queries.IsChannelMemberParams{
			ChannelID: conversationID,
			UserID:    requesterID,
		})
		if err != nil {
			return RemoveConversationMemberResult{}, fmt.Errorf("chat.RemoveConversationMember requester membership check: %w", err)
		}
		if !isMember {
			return RemoveConversationMemberResult{}, ErrNotMember
		}
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return RemoveConversationMemberResult{}, fmt.Errorf("chat.RemoveConversationMember begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	commandTag, err := tx.Exec(ctx, `
		UPDATE channel_members
		   SET is_archived = true
		 WHERE channel_id = $1
		   AND user_id = $2
		   AND is_archived = false`,
		conversationID,
		targetUserID,
	)
	if err != nil {
		return RemoveConversationMemberResult{}, fmt.Errorf("chat.RemoveConversationMember archive target membership: %w", err)
	}
	rowsAffected := commandTag.RowsAffected()
	if rowsAffected == 0 {
		hasMembership, err := s.q.HasConversationMembership(ctx, queries.HasConversationMembershipParams{
			ConversationID: conversationID,
			UserID:         targetUserID,
		})
		if err != nil {
			return RemoveConversationMemberResult{}, fmt.Errorf("chat.RemoveConversationMember target membership lookup: %w", err)
		}
		if !hasMembership {
			return RemoveConversationMemberResult{}, ErrNotMember
		}
		return RemoveConversationMemberResult{}, nil
	}

	noticeDeliveries, err := s.createMembershipChangeNoticeTx(ctx, tx, conversationID, requesterID, targetUserID, membershipNoticeRemoved)
	if err != nil {
		return RemoveConversationMemberResult{}, fmt.Errorf("chat.RemoveConversationMember create membership notice: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return RemoveConversationMemberResult{}, fmt.Errorf("chat.RemoveConversationMember commit: %w", err)
	}

	return RemoveConversationMemberResult{
		DirectDeliveries: append([]DirectDelivery{
			buildConversationRemovedDelivery(targetUserID, conversationID, packetspb.ConversationRemovedReason_CONVERSATION_REMOVED_REASON_ACCESS_REVOKED),
		}, noticeDeliveries...),
	}, nil
}

// CreateOrOpenDirectMessage returns the existing 1:1 DM for the pair or creates it.
func (s *Service) CreateOrOpenDirectMessage(ctx context.Context, requesterID, targetUserID uuid.UUID) (CreateDMResult, error) {
	if targetUserID == uuid.Nil {
		return CreateDMResult{}, ErrInvalidDMTarget
	}

	target, err := s.lookupActiveDMUser(ctx, targetUserID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return CreateDMResult{}, ErrBlockedDMTarget
		}
		return CreateDMResult{}, fmt.Errorf("chat.CreateOrOpenDirectMessage lookup target: %w", err)
	}

	if requesterID == targetUserID {
		existing, restoredRows, foundExisting, err := s.findAndRestoreExistingDirectMessage(ctx, requesterID, targetUserID, ConversationEncryptionNone)
		if err != nil {
			return CreateDMResult{}, fmt.Errorf("chat.CreateOrOpenDirectMessage restore existing self dm: %w", err)
		}
		if foundExisting {
			existing.UserID = requesterID
			existing.DisplayName = target.DisplayName
			existing.Email = target.Email
			existing.AvatarURL = target.AvatarURL
			existing.CustomStatus = target.CustomStatus

			result := CreateDMResult{DM: existing}
			if restoredRows > 0 {
				self, err := s.lookupActiveDMUser(ctx, requesterID)
				if err != nil {
					return CreateDMResult{}, fmt.Errorf("chat.CreateOrOpenDirectMessage lookup self requester: %w", err)
				}
				result.DirectDeliveries = s.buildDMConversationUpsertedDeliveries(existing.ConversationID, self, self, existing.EncryptionMode)
			}
			return result, nil
		}

		self, err := s.lookupActiveDMUser(ctx, requesterID)
		if err != nil {
			return CreateDMResult{}, fmt.Errorf("chat.CreateOrOpenDirectMessage lookup self requester: %w", err)
		}

		conversationID, err := s.createDMTx(ctx, requesterID, []uuid.UUID{requesterID}, ConversationEncryptionNone, uuid.Nil)
		if err != nil {
			return CreateDMResult{}, err
		}

		dm := DirectMessage{
			ConversationID: conversationID,
			UserID:         self.UserID,
			DisplayName:    self.DisplayName,
			Email:          self.Email,
			AvatarURL:      self.AvatarURL,
			CustomStatus:   self.CustomStatus,
			Kind:           "dm",
			Visibility:     "dm",
			EncryptionMode: ConversationEncryptionNone,
		}
		deliveries := s.buildDMConversationUpsertedDeliveries(conversationID, self, self, ConversationEncryptionNone)
		return CreateDMResult{DM: dm, DirectDeliveries: deliveries}, nil
	}

	existing, restoredRows, foundExisting, err := s.findAndRestoreExistingDirectMessage(ctx, requesterID, targetUserID, ConversationEncryptionNone)
	if err != nil {
		return CreateDMResult{}, fmt.Errorf("chat.CreateOrOpenDirectMessage restore existing: %w", err)
	}
	if foundExisting {
		existing.UserID = target.UserID
		existing.DisplayName = target.DisplayName
		existing.Email = target.Email
		existing.AvatarURL = target.AvatarURL
		existing.CustomStatus = target.CustomStatus

		result := CreateDMResult{DM: existing}
		if restoredRows > 0 {
			requester, err := s.lookupActiveDMUser(ctx, requesterID)
			if err != nil {
				return CreateDMResult{}, fmt.Errorf("chat.CreateOrOpenDirectMessage lookup requester: %w", err)
			}
			result.DirectDeliveries = s.buildDMConversationUpsertedDeliveries(existing.ConversationID, requester, target, existing.EncryptionMode)
		}
		return result, nil
	}

	// Look up requester profile so we can build the recipient's sidebar entry.
	requester, err := s.lookupActiveDMUser(ctx, requesterID)
	if err != nil {
		return CreateDMResult{}, fmt.Errorf("chat.CreateOrOpenDirectMessage lookup requester: %w", err)
	}

	conversationID, err := s.createDMTx(ctx, requesterID, []uuid.UUID{requesterID, targetUserID}, ConversationEncryptionNone, uuid.Nil)
	if err != nil {
		return CreateDMResult{}, err
	}

	dm := DirectMessage{
		ConversationID: conversationID,
		UserID:         target.UserID,
		DisplayName:    target.DisplayName,
		Email:          target.Email,
		AvatarURL:      target.AvatarURL,
		CustomStatus:   target.CustomStatus,
		Kind:           "dm",
		Visibility:     "dm",
		EncryptionMode: ConversationEncryptionNone,
	}
	deliveries := s.buildDMConversationUpsertedDeliveries(conversationID, requester, target, ConversationEncryptionNone)
	return CreateDMResult{DM: dm, DirectDeliveries: deliveries}, nil
}

// CreateOrOpenEncryptedDirectMessage creates or opens the encrypted sibling of
// an existing plaintext DM. It never mutates the plaintext DM.
func (s *Service) CreateOrOpenEncryptedDirectMessage(ctx context.Context, requesterID, sourceConversationID uuid.UUID) (CreateDMResult, error) {
	if sourceConversationID == uuid.Nil {
		return CreateDMResult{}, ErrInvalidDMTarget
	}

	var targetUserID uuid.UUID
	err := s.pool.QueryRow(ctx, `
		SELECT COALESCE(dm_peer.user_id, $2::uuid)
		  FROM channels c
		  JOIN channel_members cm_self
		    ON cm_self.channel_id = c.id
		   AND cm_self.user_id = $2
		   AND cm_self.is_archived = false
		  LEFT JOIN LATERAL (
		    SELECT cm_other.user_id
		      FROM channel_members cm_other
		     WHERE cm_other.channel_id = c.id
		       AND cm_other.user_id <> $2
		       AND cm_other.is_archived = false
		     ORDER BY cm_other.created_at ASC
		     LIMIT 1
		  ) dm_peer ON true
		 WHERE c.id = $1
		   AND c.kind = 'dm'
		   AND c.visibility = 'dm'
		   AND c.encryption_mode = 'none'
		   AND c.hidden = false
		   AND c.is_archived = false`,
		sourceConversationID,
		requesterID,
	).Scan(&targetUserID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return CreateDMResult{}, ErrNotMember
		}
		return CreateDMResult{}, fmt.Errorf("chat.CreateOrOpenEncryptedDirectMessage source dm: %w", err)
	}

	target, err := s.lookupActiveDMUser(ctx, targetUserID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return CreateDMResult{}, ErrBlockedDMTarget
		}
		return CreateDMResult{}, fmt.Errorf("chat.CreateOrOpenEncryptedDirectMessage lookup target: %w", err)
	}
	requester, err := s.lookupActiveDMUser(ctx, requesterID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return CreateDMResult{}, ErrBlockedDMTarget
		}
		return CreateDMResult{}, fmt.Errorf("chat.CreateOrOpenEncryptedDirectMessage lookup requester: %w", err)
	}

	existing, restoredRows, foundExisting, err := s.findAndRestoreExistingDirectMessage(ctx, requesterID, targetUserID, ConversationEncryptionDMPairwiseSignal)
	if err != nil {
		return CreateDMResult{}, fmt.Errorf("chat.CreateOrOpenEncryptedDirectMessage restore existing: %w", err)
	}
	if foundExisting {
		existing.UserID = target.UserID
		existing.DisplayName = target.DisplayName
		existing.Email = target.Email
		existing.AvatarURL = target.AvatarURL
		existing.CustomStatus = target.CustomStatus

		result := CreateDMResult{DM: existing}
		if restoredRows > 0 {
			result.DirectDeliveries = s.buildDMConversationUpsertedDeliveries(existing.ConversationID, requester, target, existing.EncryptionMode)
		}
		return result, nil
	}

	participants := []uuid.UUID{requesterID, targetUserID}
	if requesterID == targetUserID {
		participants = []uuid.UUID{requesterID}
	}
	conversationID, err := s.createDMTx(ctx, requesterID, participants, ConversationEncryptionDMPairwiseSignal, sourceConversationID)
	if err != nil {
		return CreateDMResult{}, err
	}

	dm := DirectMessage{
		ConversationID: conversationID,
		UserID:         target.UserID,
		DisplayName:    target.DisplayName,
		Email:          target.Email,
		AvatarURL:      target.AvatarURL,
		CustomStatus:   target.CustomStatus,
		Kind:           "dm",
		Visibility:     "dm",
		EncryptionMode: ConversationEncryptionDMPairwiseSignal,
	}
	deliveries := s.buildDMConversationUpsertedDeliveries(conversationID, requester, target, ConversationEncryptionDMPairwiseSignal)
	return CreateDMResult{DM: dm, DirectDeliveries: deliveries}, nil
}

// createDMTx persists a new DM channel with the given participants inside a
// dedicated transaction and returns the new conversation ID. participantIDs may
// contain one entry (self-DM) or two (peer DM). The creator is always
// requesterID; duplicates are de-duplicated so the caller can safely pass the
// self-DM pair [requesterID, requesterID] without violating the primary key on
// channel_members.
func (s *Service) createDMTx(ctx context.Context, creatorID uuid.UUID, participantIDs []uuid.UUID, encryptionMode string, startedFromChannelID uuid.UUID) (uuid.UUID, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return uuid.Nil, fmt.Errorf("chat.createDMTx begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var conversationID uuid.UUID
	var startedFrom any
	if startedFromChannelID != uuid.Nil {
		startedFrom = startedFromChannelID
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO channels (kind, visibility, name, created_by, encryption_mode, encrypted_started_from_channel_id)
		VALUES ('dm', 'dm', '', $1, $2, $3)
		RETURNING id`,
		creatorID,
		encryptionMode,
		startedFrom,
	).Scan(&conversationID); err != nil {
		return uuid.Nil, fmt.Errorf("chat.createDMTx insert channel: %w", err)
	}

	seen := make(map[uuid.UUID]struct{}, len(participantIDs))
	for _, uid := range participantIDs {
		if _, dup := seen[uid]; dup {
			continue
		}
		seen[uid] = struct{}{}
		if _, err := tx.Exec(ctx,
			`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`,
			conversationID, uid,
		); err != nil {
			return uuid.Nil, fmt.Errorf("chat.createDMTx insert member: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return uuid.Nil, fmt.Errorf("chat.createDMTx commit: %w", err)
	}
	return conversationID, nil
}

func (s *Service) restoreArchivedDMPeerTx(
	ctx context.Context,
	tx pgx.Tx,
	channelID, senderID uuid.UUID,
) (*DMCandidate, error) {
	var peer DMCandidate
	var customStatusText string
	var customStatusEmoji string
	var customStatusExpiresAt sql.NullTime
	err := tx.QueryRow(ctx, `
		WITH dm AS (
			SELECT id
			  FROM channels
			 WHERE id = $1
			   AND kind = 'dm'
			   AND visibility = 'dm'
		),
		restored AS (
			UPDATE channel_members cm
			   SET is_archived = false
			  FROM dm
			 WHERE cm.channel_id = dm.id
			   AND cm.user_id <> $2
			   AND cm.is_archived = true
			RETURNING cm.user_id
		)
		SELECT u.id,
		       u.display_name,
		       u.email,
		       u.avatar_url,
		       u.custom_status_text,
		       u.custom_status_emoji,
		       u.custom_status_expires_at,
		       COALESCE(up.status, 'offline')
		  FROM restored r
		  JOIN users u ON u.id = r.user_id
		  LEFT JOIN user_presence up ON up.user_id = u.id
		 LIMIT 1`,
		channelID, senderID,
	).Scan(
		&peer.UserID,
		&peer.DisplayName,
		&peer.Email,
		&peer.AvatarURL,
		&customStatusText,
		&customStatusEmoji,
		&customStatusExpiresAt,
		&peer.Presence,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	peer.CustomStatus = userstatus.ActiveFromNullTime(customStatusText, customStatusEmoji, customStatusExpiresAt, time.Now().UTC())
	return &peer, nil
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
	case ConversationEncryptionDMPairwiseSignal:
		return packetspb.ConversationEncryptionMode_CONVERSATION_ENCRYPTION_MODE_DM_PAIRWISE_SIGNAL_V1
	default:
		return packetspb.ConversationEncryptionMode_CONVERSATION_ENCRYPTION_MODE_NONE
	}
}

func (s *Service) lookupActiveDMUser(ctx context.Context, userID uuid.UUID) (DMCandidate, error) {
	row, err := s.q.LookupActiveDMUser(ctx, userID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return DMCandidate{}, sql.ErrNoRows
		}
		return DMCandidate{}, err
	}
	return DMCandidate{
		UserID:      row.ID,
		DisplayName: row.DisplayName,
		Email:       row.Email,
		AvatarURL:   row.AvatarUrl,
		CustomStatus: userstatus.ActiveFromNullTime(
			row.CustomStatusText,
			row.CustomStatusEmoji,
			row.CustomStatusExpiresAt,
			time.Now().UTC(),
		),
		Presence: row.Presence,
	}, nil
}

func (s *Service) findAndRestoreExistingDirectMessage(
	ctx context.Context,
	requesterID, targetUserID uuid.UUID,
	encryptionMode string,
) (DirectMessage, int64, bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return DirectMessage{}, 0, false, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var dm DirectMessage
	if requesterID == targetUserID {
		err = tx.QueryRow(ctx, `
			SELECT c.id, c.kind, c.visibility, c.encryption_mode
			  FROM channels c
			  JOIN channel_members cm
			    ON cm.channel_id = c.id
			   AND cm.user_id = $1
			 WHERE c.kind = 'dm'
			   AND c.visibility = 'dm'
			   AND c.encryption_mode = $2
			   AND (
				SELECT COUNT(*)
				  FROM channel_members cm2
				 WHERE cm2.channel_id = c.id
			   ) = 1
			 LIMIT 1`,
			requesterID,
			encryptionMode,
		).Scan(&dm.ConversationID, &dm.Kind, &dm.Visibility, &dm.EncryptionMode)
	} else {
		err = tx.QueryRow(ctx, `
			SELECT c.id, c.kind, c.visibility, c.encryption_mode
			  FROM channels c
			  JOIN channel_members cm1
			    ON cm1.channel_id = c.id
			   AND cm1.user_id = $1
			  JOIN channel_members cm2
			    ON cm2.channel_id = c.id
			   AND cm2.user_id = $2
			 WHERE c.kind = 'dm'
			   AND c.visibility = 'dm'
			   AND c.encryption_mode = $3
			   AND (
			   	SELECT COUNT(*)
			   	  FROM channel_members cm
			   	 WHERE cm.channel_id = c.id
			   ) = 2
			 LIMIT 1`,
			requesterID, targetUserID, encryptionMode,
		).Scan(&dm.ConversationID, &dm.Kind, &dm.Visibility, &dm.EncryptionMode)
	}
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return DirectMessage{}, 0, false, nil
		}
		return DirectMessage{}, 0, false, err
	}

	updateResult, err := tx.Exec(ctx, `
		UPDATE channel_members
		   SET is_archived = false
		 WHERE channel_id = $1
		   AND user_id IN ($2, $3)
		   AND is_archived = true`,
		dm.ConversationID,
		requesterID,
		targetUserID,
	)
	if err != nil {
		return DirectMessage{}, 0, false, err
	}

	if err := tx.Commit(ctx); err != nil {
		return DirectMessage{}, 0, false, err
	}
	return dm, updateResult.RowsAffected(), true, nil
}

// buildDMConversationUpsertedDeliveries builds two direct-delivery
// conversation_upserted events for a freshly created DM — one per participant.
// For a self-DM, it returns a single viewer-relative event for the owner.
// Each event is viewer-relative: the Title and Topic reflect the other user,
// or the viewer for self-DM, so the frontend sidebar shows the correct display
// name and can look up the peer by user_id (stored in Topic).
func (s *Service) buildDMConversationUpsertedDeliveries(
	conversationID uuid.UUID,
	requester, target DMCandidate,
	encryptionMode string,
) []DirectDelivery {
	now := timestamppb.Now()
	memberCount := int32(2)
	if requester.UserID == target.UserID {
		memberCount = 1
	}
	build := func(recipientID, peerID uuid.UUID, peerName, peerEmail, peerPresence string) DirectDelivery {
		title := peerName
		if title == "" {
			title = peerEmail
		}
		summary := &packetspb.ConversationSummary{
			ConversationId:   conversationID.String(),
			ConversationType: packetspb.ConversationType_CONVERSATION_TYPE_DM,
			Title:            title,
			Topic:            peerID.String(), // frontend uses Topic to identify the DM peer
			LastActivityAt:   now,
			MemberCount:      memberCount,
			Presence:         mapPresenceStatus(peerPresence),
			EncryptionMode:   mapConversationEncryptionMode(encryptionMode),
		}
		evt := &packetspb.ServerEvent{
			EventType:      packetspb.EventType_EVENT_TYPE_CONVERSATION_UPSERTED,
			ConversationId: conversationID.String(),
			OccurredAt:     now,
			Payload: &packetspb.ServerEvent_ConversationUpserted{
				ConversationUpserted: &packetspb.ConversationUpsertedEvent{
					Conversation: summary,
				},
			},
		}
		return DirectDelivery{UserID: recipientID.String(), Event: evt}
	}

	if requester.UserID == target.UserID {
		return []DirectDelivery{
			build(requester.UserID, requester.UserID, requester.DisplayName, requester.Email, requester.Presence),
		}
	}

	return []DirectDelivery{
		build(requester.UserID, target.UserID, target.DisplayName, target.Email, target.Presence),
		build(target.UserID, requester.UserID, requester.DisplayName, requester.Email, requester.Presence),
	}
}

// InviteToChannel adds targetUserID to a public/private channel on behalf of
// requesterID (who must already be a member). The operation is idempotent —
// if the target is already a member but archived, membership is restored. A
// conversation_upserted DirectDelivery is always returned so the caller can
// push a real-time sidebar update to the invited user.
func (s *Service) InviteToChannel(ctx context.Context, requesterID, channelID, targetUserID uuid.UUID) (InviteToChannelResult, error) {
	// 1. Verify requester is a member.
	isMember, err := s.q.IsChannelMember(ctx, queries.IsChannelMemberParams{
		ChannelID: channelID,
		UserID:    requesterID,
	})
	if err != nil {
		return InviteToChannelResult{}, fmt.Errorf("chat.InviteToChannel membership check: %w", err)
	}
	if !isMember {
		return InviteToChannelResult{}, ErrNotMember
	}

	// 2. Verify channel supports invites (public/private channels only).
	channelRow, err := s.q.GetInvitableChannelByID(ctx, channelID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return InviteToChannelResult{}, ErrNotPublicChannel
		}
		return InviteToChannelResult{}, fmt.Errorf("chat.InviteToChannel fetch channel: %w", err)
	}
	channel := JoinableChannel{
		ID:             channelRow.ID,
		Kind:           channelRow.Kind,
		Visibility:     channelRow.Visibility,
		Name:           channelRow.Name,
		LastActivityAt: channelRow.LastActivityAt,
	}
	if channelRow.IsArchived {
		return InviteToChannelResult{}, ErrConversationArchived
	}
	if channel.Kind != "channel" || (channel.Visibility != "public" && channel.Visibility != "private") {
		return InviteToChannelResult{}, ErrInviteUnsupportedTarget
	}

	// 3. Verify target user exists and is active.
	if _, err := s.q.GetInviteTargetUserByID(ctx, targetUserID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return InviteToChannelResult{}, fmt.Errorf("chat.InviteToChannel target user not found: %w", sql.ErrNoRows)
		}
		return InviteToChannelResult{}, fmt.Errorf("chat.InviteToChannel fetch target user: %w", err)
	}

	// 4. Insert or restore membership (idempotent).
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return InviteToChannelResult{}, fmt.Errorf("chat.InviteToChannel begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var wasActiveMember bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			  FROM channel_members
			 WHERE channel_id = $1
			   AND user_id = $2
			   AND is_archived = false
		)`,
		channelID,
		targetUserID,
	).Scan(&wasActiveMember); err != nil {
		return InviteToChannelResult{}, fmt.Errorf("chat.InviteToChannel check active membership: %w", err)
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO channel_members (channel_id, user_id)
		VALUES ($1, $2)
		ON CONFLICT (channel_id, user_id) DO UPDATE
		    SET is_archived = false`,
		channelID,
		targetUserID,
	); err != nil {
		return InviteToChannelResult{}, fmt.Errorf("chat.InviteToChannel upsert member: %w", err)
	}

	var noticeDeliveries []DirectDelivery
	if !wasActiveMember {
		noticeDeliveries, err = s.createMembershipChangeNoticeTx(ctx, tx, channelID, requesterID, targetUserID, membershipNoticeAdded)
		if err != nil {
			return InviteToChannelResult{}, fmt.Errorf("chat.InviteToChannel create membership notice: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return InviteToChannelResult{}, fmt.Errorf("chat.InviteToChannel commit: %w", err)
	}

	// 5. Build a real-time delivery for the invited user so their sidebar
	//    immediately shows the new channel without waiting for re-bootstrap.
	delivery := buildChannelConversationUpsertedDelivery(targetUserID, channel)
	return InviteToChannelResult{
		DirectDeliveries: append([]DirectDelivery{delivery}, noticeDeliveries...),
	}, nil
}

// buildChannelConversationUpsertedDelivery constructs a conversation_upserted
// DirectDelivery for a channel, to be pushed to a user.
func buildChannelConversationUpsertedDelivery(recipientID uuid.UUID, channel JoinableChannel) DirectDelivery {
	now := timestamppb.Now()
	conversationType := packetspb.ConversationType_CONVERSATION_TYPE_CHANNEL_PUBLIC
	if channel.Visibility == "private" {
		conversationType = packetspb.ConversationType_CONVERSATION_TYPE_CHANNEL_PRIVATE
	}
	summary := &packetspb.ConversationSummary{
		ConversationId:   channel.ID.String(),
		ConversationType: conversationType,
		Title:            channel.Name,
		LastActivityAt:   timestamppb.New(channel.LastActivityAt),
	}
	evt := &packetspb.ServerEvent{
		EventType:      packetspb.EventType_EVENT_TYPE_CONVERSATION_UPSERTED,
		ConversationId: channel.ID.String(),
		OccurredAt:     now,
		Payload: &packetspb.ServerEvent_ConversationUpserted{
			ConversationUpserted: &packetspb.ConversationUpsertedEvent{
				Conversation: summary,
			},
		},
	}
	return DirectDelivery{UserID: recipientID.String(), Event: evt}
}

func buildConversationRemovedDelivery(
	recipientID, conversationID uuid.UUID,
	reason packetspb.ConversationRemovedReason,
) DirectDelivery {
	now := timestamppb.Now()
	evt := &packetspb.ServerEvent{
		EventType:      packetspb.EventType_EVENT_TYPE_CONVERSATION_REMOVED,
		ConversationId: conversationID.String(),
		OccurredAt:     now,
		Payload: &packetspb.ServerEvent_ConversationRemoved{
			ConversationRemoved: &packetspb.ConversationRemovedEvent{
				ConversationId: conversationID.String(),
				Reason:         reason,
			},
		},
	}
	return DirectDelivery{UserID: recipientID.String(), Event: evt}
}
