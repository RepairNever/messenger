-- name: UpsertUserDevice :one
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
VALUES (
  @id,
  @user_id,
  @device_label,
  @identity_key_public,
  @signed_prekey_id,
  @signed_prekey_public,
  @signed_prekey_signature,
  now(),
  NULL
)
ON CONFLICT (id) DO UPDATE
    SET device_label = EXCLUDED.device_label,
        identity_key_public = EXCLUDED.identity_key_public,
        signed_prekey_id = EXCLUDED.signed_prekey_id,
        signed_prekey_public = EXCLUDED.signed_prekey_public,
        signed_prekey_signature = EXCLUDED.signed_prekey_signature,
        last_seen_at = now(),
        revoked_at = NULL
WHERE user_devices.user_id = EXCLUDED.user_id
RETURNING *;

-- name: ListActiveConversationDevices :many
SELECT
  ud.id,
  ud.user_id,
  ud.device_label,
  ud.identity_key_public,
  ud.signed_prekey_id,
  ud.signed_prekey_public,
  ud.signed_prekey_signature,
  ud.created_at,
  ud.last_seen_at
FROM channels c
JOIN channel_members cm_self
  ON cm_self.channel_id = c.id
 AND cm_self.user_id = @requester_id
 AND cm_self.is_archived = false
JOIN channel_members cm
  ON cm.channel_id = c.id
 AND cm.is_archived = false
JOIN user_devices ud
  ON ud.user_id = cm.user_id
 AND ud.revoked_at IS NULL
WHERE c.id = @conversation_id
  AND c.kind = 'dm'
  AND c.visibility = 'dm'
  AND c.encryption_mode = 'dm_pairwise_signal_v1'
  AND c.hidden = false
  AND c.is_archived = false
ORDER BY ud.user_id, ud.created_at, ud.id;

-- name: IsActiveUserDevice :one
SELECT EXISTS (
  SELECT 1
  FROM user_devices
  WHERE id = @device_id
    AND user_id = @user_id
    AND revoked_at IS NULL
) AS is_active;

-- name: ListMessageRecipientCiphertexts :many
SELECT
  message_id,
  recipient_device_id,
  sender_device_id,
  algorithm,
  session_message,
  metadata_aad
FROM message_recipient_ciphertexts
WHERE message_id = ANY(@message_ids::uuid[])
ORDER BY message_id, recipient_device_id;
