package storage

import (
	"context"
	"fmt"
	"io"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"

	"msgnr/internal/config"
)

// MinioClient wraps the minio-go client and implements the Storage interface.
type MinioClient struct {
	client *minio.Client
	bucket string
}

// New creates a MinioClient from the application configuration.
// It ensures the configured bucket exists (creating it if necessary).
func New(cfg *config.Config) (*MinioClient, error) {
	mc, err := minio.New(cfg.MinioEndpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.MinioAccessKey, cfg.MinioSecretKey, ""),
		Secure: cfg.MinioUseSSL,
	})
	if err != nil {
		return nil, fmt.Errorf("storage: init minio client: %w", err)
	}

	ctx := context.Background()
	exists, err := mc.BucketExists(ctx, cfg.MinioBucket)
	if err != nil {
		return nil, fmt.Errorf("storage: check bucket existence: %w", err)
	}
	if !exists {
		if err := mc.MakeBucket(ctx, cfg.MinioBucket, minio.MakeBucketOptions{}); err != nil {
			return nil, fmt.Errorf("storage: create bucket %q: %w", cfg.MinioBucket, err)
		}
	}

	return &MinioClient{client: mc, bucket: cfg.MinioBucket}, nil
}

// NewWithParams creates a MinioClient with explicit parameters. Useful in
// tests where a testcontainer provides the endpoint at runtime.
func NewWithParams(endpoint, accessKey, secretKey, bucket string, useSSL bool) (*MinioClient, error) {
	mc, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(accessKey, secretKey, ""),
		Secure: useSSL,
	})
	if err != nil {
		return nil, fmt.Errorf("storage: init minio client: %w", err)
	}

	ctx := context.Background()
	exists, err := mc.BucketExists(ctx, bucket)
	if err != nil {
		return nil, fmt.Errorf("storage: check bucket existence: %w", err)
	}
	if !exists {
		if err := mc.MakeBucket(ctx, bucket, minio.MakeBucketOptions{}); err != nil {
			return nil, fmt.Errorf("storage: create bucket %q: %w", bucket, err)
		}
	}

	return &MinioClient{client: mc, bucket: bucket}, nil
}

// PutObject implements Storage.
func (c *MinioClient) PutObject(ctx context.Context, key string, r io.Reader, size int64, mimeType string) error {
	_, err := c.client.PutObject(ctx, c.bucket, key, r, size, minio.PutObjectOptions{
		ContentType: mimeType,
	})
	if err != nil {
		return fmt.Errorf("storage: put object %q: %w", key, err)
	}
	return nil
}

// GetObject implements Storage.
func (c *MinioClient) GetObject(ctx context.Context, key string) (io.ReadCloser, int64, string, error) {
	obj, err := c.client.GetObject(ctx, c.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, 0, "", fmt.Errorf("storage: get object %q: %w", key, err)
	}

	info, err := obj.Stat()
	if err != nil {
		obj.Close()
		return nil, 0, "", fmt.Errorf("storage: stat object %q: %w", key, err)
	}

	return obj, info.Size, info.ContentType, nil
}

// DeleteObject implements Storage. Deleting a non-existent key is treated as
// a no-op (idempotent).
func (c *MinioClient) DeleteObject(ctx context.Context, key string) error {
	err := c.client.RemoveObject(ctx, c.bucket, key, minio.RemoveObjectOptions{})
	if err != nil {
		// minio-go returns an error for NotFound; treat as success.
		resp := minio.ToErrorResponse(err)
		if resp.Code == "NoSuchKey" {
			return nil
		}
		return fmt.Errorf("storage: delete object %q: %w", key, err)
	}
	return nil
}
