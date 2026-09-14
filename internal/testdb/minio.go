// Package testdb helpers for Minio integration tests.
package testdb

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"

	"msgnr/internal/storage"
)

const (
	minioUser   = "minioadmin"
	minioPass   = "minioadmin"
	minioBucket = "test-attachments"
)

// NewMinio spins up a minio/minio container for integration tests and returns
// a ready-to-use *storage.MinioClient. The container is terminated at cleanup.
func NewMinio(t *testing.T) *storage.MinioClient {
	t.Helper()

	ctx := context.Background()

	req := testcontainers.ContainerRequest{
		Image:        "minio/minio:latest",
		ExposedPorts: []string{"9000/tcp"},
		Env: map[string]string{
			"MINIO_ROOT_USER":     minioUser,
			"MINIO_ROOT_PASSWORD": minioPass,
		},
		Cmd: []string{"server", "/data"},
		WaitingFor: wait.ForHTTP("/minio/health/live").
			WithPort("9000/tcp").
			WithStartupTimeout(60 * time.Second),
	}

	ctr, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: req,
		Started:          true,
	})
	if err != nil {
		t.Fatalf("testdb: start minio container: %v", err)
	}
	t.Cleanup(func() {
		if err := ctr.Terminate(context.Background()); err != nil {
			t.Logf("testdb: terminate minio container: %v", err)
		}
	})

	host, err := ctr.Host(ctx)
	if err != nil {
		t.Fatalf("testdb: minio host: %v", err)
	}
	port, err := ctr.MappedPort(ctx, "9000/tcp")
	if err != nil {
		t.Fatalf("testdb: minio port: %v", err)
	}

	endpoint := fmt.Sprintf("%s:%s", host, port.Port())

	client, err := storage.NewWithParams(endpoint, minioUser, minioPass, minioBucket, false)
	if err != nil {
		t.Fatalf("testdb: create minio client: %v", err)
	}
	return client
}
