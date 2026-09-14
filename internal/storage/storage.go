package storage

import (
	"context"
	"io"
)

// Storage is the interface for object storage operations used by the task
// tracker's attachment feature. An abstraction is used so that integration
// tests can inject a real Minio container or a future in-memory fake.
type Storage interface {
	// PutObject uploads r (of the given size in bytes and MIME type) under key.
	PutObject(ctx context.Context, key string, r io.Reader, size int64, mimeType string) error

	// GetObject retrieves an object by key, returning the body, its size, and
	// the MIME type that was stored with it.
	// The caller is responsible for closing the returned ReadCloser.
	GetObject(ctx context.Context, key string) (body io.ReadCloser, size int64, mimeType string, err error)

	// DeleteObject removes the object identified by key.
	// Implementations must be idempotent: deleting a non-existent key is not
	// an error.
	DeleteObject(ctx context.Context, key string) error
}
