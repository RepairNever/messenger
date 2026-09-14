package chat

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/proto"

	packetspb "msgnr/internal/gen/proto"
	"msgnr/internal/gen/queries"
)

const encryptedDMEnvelopeAlgorithm = "dm-p256-aesgcm-v1"

const (
	maxE2EEDeviceLabelRunes      = 256
	maxE2EEDeviceKeyMaterialSize = 16 * 1024
)

type RegisterDeviceParams struct {
	DeviceID              uuid.UUID
	UserID                uuid.UUID
	DeviceLabel           string
	IdentityKeyPublic     []byte
	SignedPrekeyID        int
	SignedPrekeyPublic    []byte
	SignedPrekeySignature []byte
}

type UserDeviceBundle struct {
	DeviceID              uuid.UUID
	UserID                uuid.UUID
	DeviceLabel           string
	IdentityKeyPublic     []byte
	SignedPrekeyID        int
	SignedPrekeyPublic    []byte
	SignedPrekeySignature []byte
}

type ActivateRecoveredDeviceParams struct {
	RegisterDeviceParams
	ReplaceDeviceID uuid.UUID
}

func validateRegisterDeviceParams(p RegisterDeviceParams, requireDeviceID bool) error {
	if (requireDeviceID && p.DeviceID == uuid.Nil) || p.UserID == uuid.Nil || p.SignedPrekeyID < 0 {
		return ErrInvalidDMTarget
	}
	if utf8.RuneCountInString(strings.TrimSpace(p.DeviceLabel)) > maxE2EEDeviceLabelRunes {
		return ErrInvalidDMTarget
	}
	if len(p.IdentityKeyPublic) == 0 || len(p.IdentityKeyPublic) > maxE2EEDeviceKeyMaterialSize {
		return ErrInvalidDMTarget
	}
	if len(p.SignedPrekeyPublic) == 0 || len(p.SignedPrekeyPublic) > maxE2EEDeviceKeyMaterialSize {
		return ErrInvalidDMTarget
	}
	if len(p.SignedPrekeySignature) == 0 || len(p.SignedPrekeySignature) > maxE2EEDeviceKeyMaterialSize {
		return ErrInvalidDMTarget
	}
	return nil
}

func userDeviceBundleFromRow(row pgx.Row) (UserDeviceBundle, error) {
	var device UserDeviceBundle
	err := row.Scan(
		&device.DeviceID,
		&device.UserID,
		&device.DeviceLabel,
		&device.IdentityKeyPublic,
		&device.SignedPrekeyID,
		&device.SignedPrekeyPublic,
		&device.SignedPrekeySignature,
	)
	if err != nil {
		return UserDeviceBundle{}, err
	}
	return device, nil
}

func (s *Service) RegisterDevice(ctx context.Context, p RegisterDeviceParams) (UserDeviceBundle, error) {
	if p.DeviceID == uuid.Nil {
		p.DeviceID = uuid.New()
	}
	if err := validateRegisterDeviceParams(p, true); err != nil {
		return UserDeviceBundle{}, err
	}
	row, err := s.q.UpsertUserDevice(ctx, queries.UpsertUserDeviceParams{
		ID:                    p.DeviceID,
		UserID:                p.UserID,
		DeviceLabel:           strings.TrimSpace(p.DeviceLabel),
		IdentityKeyPublic:     append([]byte(nil), p.IdentityKeyPublic...),
		SignedPrekeyID:        p.SignedPrekeyID,
		SignedPrekeyPublic:    append([]byte(nil), p.SignedPrekeyPublic...),
		SignedPrekeySignature: append([]byte(nil), p.SignedPrekeySignature...),
	})
	if err != nil {
		return UserDeviceBundle{}, fmt.Errorf("chat.RegisterDevice: %w", err)
	}
	return UserDeviceBundle{
		DeviceID:              row.ID,
		UserID:                row.UserID,
		DeviceLabel:           row.DeviceLabel,
		IdentityKeyPublic:     row.IdentityKeyPublic,
		SignedPrekeyID:        row.SignedPrekeyID,
		SignedPrekeyPublic:    row.SignedPrekeyPublic,
		SignedPrekeySignature: row.SignedPrekeySignature,
	}, nil
}

// ActivateRecoveredDevice restores a user's existing public device identity and
// retires a different temporary identity created on the importing browser.
// Private recovery material never reaches this service.
func (s *Service) ActivateRecoveredDevice(ctx context.Context, p ActivateRecoveredDeviceParams) (UserDeviceBundle, error) {
	if p.ReplaceDeviceID == p.DeviceID {
		p.ReplaceDeviceID = uuid.Nil
	}
	if err := validateRegisterDeviceParams(p.RegisterDeviceParams, true); err != nil {
		return UserDeviceBundle{}, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return UserDeviceBundle{}, fmt.Errorf("chat.ActivateRecoveredDevice begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	deviceIDs := []uuid.UUID{p.DeviceID}
	if p.ReplaceDeviceID != uuid.Nil {
		deviceIDs = append(deviceIDs, p.ReplaceDeviceID)
	}
	sort.Slice(deviceIDs, func(i, j int) bool {
		return deviceIDs[i].String() < deviceIDs[j].String()
	})

	owners := make(map[uuid.UUID]uuid.UUID, len(deviceIDs))
	for _, deviceID := range deviceIDs {
		if _, seen := owners[deviceID]; seen {
			continue
		}
		var ownerID uuid.UUID
		err := tx.QueryRow(ctx, `SELECT user_id FROM user_devices WHERE id = $1 FOR UPDATE`, deviceID).Scan(&ownerID)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return UserDeviceBundle{}, fmt.Errorf("chat.ActivateRecoveredDevice lock device: %w", err)
		}
		owners[deviceID] = ownerID
	}
	if ownerID, exists := owners[p.DeviceID]; exists && ownerID != p.UserID {
		return UserDeviceBundle{}, ErrE2EERecoveryDeviceOwnership
	}
	if ownerID, exists := owners[p.ReplaceDeviceID]; p.ReplaceDeviceID != uuid.Nil && exists && ownerID != p.UserID {
		return UserDeviceBundle{}, ErrE2EERecoveryDeviceOwnership
	}

	device, err := userDeviceBundleFromRow(tx.QueryRow(ctx, `
		INSERT INTO user_devices (
			id,
			user_id,
			device_label,
			identity_key_public,
			signed_prekey_id,
			signed_prekey_public,
			signed_prekey_signature,
			last_seen_at,
			revoked_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, now(), NULL)
		ON CONFLICT (id) DO UPDATE
			SET device_label = EXCLUDED.device_label,
				identity_key_public = EXCLUDED.identity_key_public,
				signed_prekey_id = EXCLUDED.signed_prekey_id,
				signed_prekey_public = EXCLUDED.signed_prekey_public,
				signed_prekey_signature = EXCLUDED.signed_prekey_signature,
				last_seen_at = now(),
				revoked_at = NULL
		WHERE user_devices.user_id = EXCLUDED.user_id
		RETURNING id,
			user_id,
			device_label,
			identity_key_public,
			signed_prekey_id,
			signed_prekey_public,
			signed_prekey_signature`,
		p.DeviceID,
		p.UserID,
		strings.TrimSpace(p.DeviceLabel),
		append([]byte(nil), p.IdentityKeyPublic...),
		p.SignedPrekeyID,
		append([]byte(nil), p.SignedPrekeyPublic...),
		append([]byte(nil), p.SignedPrekeySignature...),
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return UserDeviceBundle{}, ErrE2EERecoveryDeviceOwnership
	}
	if err != nil {
		return UserDeviceBundle{}, fmt.Errorf("chat.ActivateRecoveredDevice activate device: %w", err)
	}

	if p.ReplaceDeviceID != uuid.Nil {
		if _, err := tx.Exec(ctx, `
			UPDATE user_devices
			   SET revoked_at = now()
			 WHERE id = $1
			   AND user_id = $2
			   AND revoked_at IS NULL`,
			p.ReplaceDeviceID,
			p.UserID,
		); err != nil {
			return UserDeviceBundle{}, fmt.Errorf("chat.ActivateRecoveredDevice revoke temporary device: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return UserDeviceBundle{}, fmt.Errorf("chat.ActivateRecoveredDevice commit: %w", err)
	}
	return device, nil
}

func (s *Service) ListEncryptedDMDevices(ctx context.Context, requesterID, conversationID uuid.UUID) ([]UserDeviceBundle, error) {
	rows, err := s.q.ListActiveConversationDevices(ctx, queries.ListActiveConversationDevicesParams{
		RequesterID:    requesterID,
		ConversationID: conversationID,
	})
	if err != nil {
		return nil, fmt.Errorf("chat.ListEncryptedDMDevices: %w", err)
	}
	out := make([]UserDeviceBundle, 0, len(rows))
	for _, row := range rows {
		out = append(out, UserDeviceBundle{
			DeviceID:              row.ID,
			UserID:                row.UserID,
			DeviceLabel:           row.DeviceLabel,
			IdentityKeyPublic:     row.IdentityKeyPublic,
			SignedPrekeyID:        row.SignedPrekeyID,
			SignedPrekeyPublic:    row.SignedPrekeyPublic,
			SignedPrekeySignature: row.SignedPrekeySignature,
		})
	}
	return out, nil
}

func (s *Service) requiredEncryptedDMRecipientDevices(ctx context.Context, requesterID, conversationID uuid.UUID) (map[uuid.UUID]uuid.UUID, error) {
	rows, err := s.q.ListActiveConversationDevices(ctx, queries.ListActiveConversationDevicesParams{
		RequesterID:    requesterID,
		ConversationID: conversationID,
	})
	if err != nil {
		return nil, fmt.Errorf("chat.requiredEncryptedDMRecipientDevices: %w", err)
	}
	var memberCount int
	if err := s.pool.QueryRow(ctx, `
		SELECT COUNT(*)::int
		  FROM channel_members
		 WHERE channel_id = $1
		   AND is_archived = false`,
		conversationID,
	).Scan(&memberCount); err != nil {
		return nil, fmt.Errorf("chat.requiredEncryptedDMRecipientDevices member count: %w", err)
	}
	out := make(map[uuid.UUID]uuid.UUID, len(rows))
	usersWithDevices := make(map[uuid.UUID]struct{})
	for _, row := range rows {
		out[row.ID] = row.UserID
		usersWithDevices[row.UserID] = struct{}{}
	}
	if memberCount == 0 || len(usersWithDevices) < memberCount {
		return nil, ErrInvalidEncryptedPayload
	}
	return out, nil
}

func (s *Service) activeUserDeviceIDs(ctx context.Context, userID, requestedDeviceID uuid.UUID) (map[uuid.UUID]struct{}, error) {
	out := make(map[uuid.UUID]struct{})
	if requestedDeviceID != uuid.Nil {
		active, err := s.q.IsActiveUserDevice(ctx, queries.IsActiveUserDeviceParams{
			DeviceID: requestedDeviceID,
			UserID:   userID,
		})
		if err != nil {
			return nil, fmt.Errorf("chat.activeUserDeviceIDs check requested device: %w", err)
		}
		if active {
			out[requestedDeviceID] = struct{}{}
		}
		return out, nil
	}

	rows, err := s.pool.Query(ctx, `
		SELECT id
		  FROM user_devices
		 WHERE user_id = $1
		   AND revoked_at IS NULL`,
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("chat.activeUserDeviceIDs query: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var deviceID uuid.UUID
		if err := rows.Scan(&deviceID); err != nil {
			return nil, fmt.Errorf("chat.activeUserDeviceIDs scan: %w", err)
		}
		out[deviceID] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("chat.activeUserDeviceIDs rows: %w", err)
	}
	return out, nil
}

func (s *Service) FilterEncryptedEventPayloadsForUser(ctx context.Context, evt *packetspb.ServerEvent, userID uuid.UUID) (*packetspb.ServerEvent, error) {
	msg := evt.GetMessageCreated()
	if msg == nil || msg.GetContentMode() != packetspb.MessageContentMode_MESSAGE_CONTENT_MODE_DM_PAIRWISE_SIGNAL_V1 {
		return evt, nil
	}
	payload := msg.GetEncryptedDmPayload()
	if payload == nil || len(payload.GetRecipients()) == 0 {
		return evt, nil
	}

	allowedDeviceIDs, err := s.activeUserDeviceIDs(ctx, userID, uuid.Nil)
	if err != nil {
		return nil, err
	}
	filtered := proto.Clone(evt).(*packetspb.ServerEvent)
	filteredPayload := filtered.GetMessageCreated().GetEncryptedDmPayload()
	recipients := filteredPayload.GetRecipients()
	filteredRecipients := recipients[:0]
	for _, recipient := range recipients {
		recipientDeviceID, err := uuid.Parse(recipient.GetRecipientDeviceId())
		if err != nil {
			continue
		}
		if _, ok := allowedDeviceIDs[recipientDeviceID]; ok {
			filteredRecipients = append(filteredRecipients, recipient)
		}
	}
	filteredPayload.Recipients = filteredRecipients
	return filtered, nil
}

func StripEncryptedEventPayloads(evt *packetspb.ServerEvent) *packetspb.ServerEvent {
	msg := evt.GetMessageCreated()
	if msg == nil || msg.GetContentMode() != packetspb.MessageContentMode_MESSAGE_CONTENT_MODE_DM_PAIRWISE_SIGNAL_V1 || msg.GetEncryptedDmPayload() == nil {
		return evt
	}
	filtered := proto.Clone(evt).(*packetspb.ServerEvent)
	filtered.GetMessageCreated().EncryptedDmPayload = &packetspb.EncryptedDMMessagePayload{}
	return filtered
}
