package documents

import (
	"bytes"
	"errors"
	"io"
	"testing"
)

func TestCountingReader_StopsAtConfiguredLimit(t *testing.T) {
	reader := &countingReader{
		r:        bytes.NewReader([]byte("abcdef")),
		maxBytes: 4,
	}

	payload, err := io.ReadAll(reader)
	if !errors.Is(err, errAttachmentTooLarge) {
		t.Fatalf("expected errAttachmentTooLarge, got %v", err)
	}
	if string(payload) != "abcd" {
		t.Fatalf("expected payload to stop at limit, got %q", string(payload))
	}
	if reader.BytesRead() != 4 {
		t.Fatalf("expected counted bytes to stop at 4, got %d", reader.BytesRead())
	}
}
