-- name: UpsertPushSubscription :one
INSERT INTO push_subscriptions (user_id, endpoint, key_p256dh, key_auth, user_agent)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (endpoint) DO UPDATE
  SET user_id    = EXCLUDED.user_id,
      key_p256dh = EXCLUDED.key_p256dh,
      key_auth   = EXCLUDED.key_auth,
      user_agent = EXCLUDED.user_agent,
      last_used  = now()
RETURNING *;

-- name: DeletePushSubscriptionByUserAndEndpoint :exec
DELETE FROM push_subscriptions
WHERE user_id = $1 AND endpoint = $2;

-- name: DeletePushSubscriptionByEndpoint :exec
DELETE FROM push_subscriptions
WHERE endpoint = $1;

-- name: ListPushSubscriptionsByUser :many
SELECT * FROM push_subscriptions
WHERE user_id = $1
ORDER BY created_at;

-- name: TouchPushSubscriptionLastUsed :exec
UPDATE push_subscriptions
SET last_used = now()
WHERE id = $1;

-- name: DeleteStalePushSubscriptions :exec
DELETE FROM push_subscriptions
WHERE last_used < $1;
