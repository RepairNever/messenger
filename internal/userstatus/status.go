package userstatus

import (
	"database/sql"
	"strings"
	"time"
	"unicode/utf8"

	"google.golang.org/protobuf/types/known/timestamppb"
	packetspb "msgnr/internal/gen/proto"
)

const (
	MaxTextRunes  = 120
	MaxEmojiRunes = 32
)

type Status struct {
	Text      string
	Emoji     string
	ExpiresAt time.Time
}

type Body struct {
	Text      string    `json:"text"`
	Emoji     string    `json:"emoji"`
	ExpiresAt time.Time `json:"expires_at"`
}

func NormalizeText(value string) string {
	return strings.TrimSpace(value)
}

func NormalizeEmoji(value string) string {
	return strings.TrimSpace(value)
}

func IsTextTooLong(value string) bool {
	return utf8.RuneCountInString(value) > MaxTextRunes
}

func IsEmojiTooLong(value string) bool {
	return utf8.RuneCountInString(value) > MaxEmojiRunes
}

func Active(text, emoji string, expiresAt *time.Time, now time.Time) *Status {
	text = NormalizeText(text)
	emoji = NormalizeEmoji(emoji)
	if text == "" || expiresAt == nil || !expiresAt.After(now) {
		return nil
	}
	return &Status{
		Text:      text,
		Emoji:     emoji,
		ExpiresAt: expiresAt.UTC(),
	}
}

func ActiveFromNullTime(text, emoji string, expiresAt sql.NullTime, now time.Time) *Status {
	if !expiresAt.Valid {
		return nil
	}
	return Active(text, emoji, &expiresAt.Time, now)
}

func ToBody(status *Status) *Body {
	if status == nil {
		return nil
	}
	return &Body{
		Text:      status.Text,
		Emoji:     status.Emoji,
		ExpiresAt: status.ExpiresAt,
	}
}

func ToProto(status *Status) *packetspb.UserCustomStatus {
	if status == nil {
		return nil
	}
	return &packetspb.UserCustomStatus{
		Text:      status.Text,
		Emoji:     status.Emoji,
		ExpiresAt: timestamppb.New(status.ExpiresAt),
	}
}
