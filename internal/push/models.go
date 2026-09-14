package push

// SubscribeRequest is the JSON body for POST /api/push/subscribe.
type SubscribeRequest struct {
	Endpoint  string `json:"endpoint"`
	KeyP256dh string `json:"key_p256dh"`
	KeyAuth   string `json:"key_auth"`
	UserAgent string `json:"user_agent"`
}

// UnsubscribeRequest is the JSON body for DELETE /api/push/subscribe.
type UnsubscribeRequest struct {
	Endpoint string `json:"endpoint"`
}

// VAPIDKeyResponse is the JSON body for GET /api/push/vapid-key.
type VAPIDKeyResponse struct {
	PublicKey string `json:"publicKey"`
}

// PushPayload is the JSON payload sent inside a Web Push message.
// Keep this minimal — it is visible on lock screens.
type PushPayload struct {
	Type           string `json:"type"`
	Title          string `json:"title"`
	Body           string `json:"body"`
	ConversationID string `json:"conversationId,omitempty"`
	MessageID      string `json:"messageId,omitempty"`
	ThreadRootID   string `json:"threadRootMessageId,omitempty"`
	Tag            string `json:"tag,omitempty"`
	URL            string `json:"url"`
}
