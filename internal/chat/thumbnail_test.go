package chat

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"os"
	"testing"
)

func TestGenerateImageThumbnailSupportedFormats(t *testing.T) {
	opaque := image.NewRGBA(image.Rect(0, 0, 1440, 720))
	fillImage(opaque, color.RGBA{R: 0x32, G: 0x78, B: 0xc8, A: 0xff})

	transparent := image.NewNRGBA(image.Rect(0, 0, 1000, 500))
	fillImage(transparent, color.NRGBA{R: 0xff, G: 0x80, B: 0x40, A: 0x7f})

	webp, err := base64.StdEncoding.DecodeString("UklGRrIBAABXRUJQVlA4TKUBAAAvSsAYAA8w//M///MfeJAkbXvaSG7m8Q3GfYSBJekwQztm/IcZlgwnmWImn2BK7aFmBtnVir6q//8VOkFE/xm4baTIu8c48ArEo6+B3zFKYln3pqClSCKX0begFTAXFOLXHSyF8cCNcZEG4OywuA4KVVfJCiArU7GAgJI8+lJP/OKMT/fBAjevg1cYB7YVkFuWga2lyPi5I0HFy5YTpWIHg0RZpkniRVW9odHAKOwosWuOGdxIyn2OvaCDvhg/we6TwadPBPbqBV58MsLmMJ8yZnOWk8SRz4N+QoyPL+MnamzMvcE1rHNEr91F9GKZPVUcS9w7PhhH36suB9qPeYb/oLk6cuTiJ0wOK3m5h1cKjW6EVZCYMK7dxcKCBdgP9HkKr9gkAO2P8GKZGWVdIAatQa+1IDpt6qyorVwdy01xdW8Jkfk6xjEXmVQQ+HQdFr6OKhIN34dXWq0+0qr6EJSCeeVLH9+gvGTLyqM65PQ44ihzlTXxQKjKbAvshXgir7Lil9w4L2bvMycmjQcqXaMCO6BlY28i+FOLzbfI1vEqxAhotocAAA==")
	if err != nil {
		t.Fatalf("decode WebP fixture: %v", err)
	}

	tests := []struct {
		name          string
		source        []byte
		wantMimeType  string
		wantExtension string
		wantWidth     int
		wantHeight    int
	}{
		{
			name:          "JPEG opaque",
			source:        encodeJPEG(t, opaque),
			wantMimeType:  "image/jpeg",
			wantExtension: "jpg",
			wantWidth:     720,
			wantHeight:    360,
		},
		{
			name:          "PNG transparent",
			source:        encodePNG(t, transparent),
			wantMimeType:  "image/png",
			wantExtension: "png",
			wantWidth:     720,
			wantHeight:    360,
		},
		{
			name:          "WebP opaque",
			source:        webp,
			wantMimeType:  "image/jpeg",
			wantExtension: "jpg",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			thumbnail, err := generateImageThumbnail(bytes.NewReader(tt.source))
			if err != nil {
				t.Fatalf("generateImageThumbnail() error = %v", err)
			}
			if thumbnail.MimeType != tt.wantMimeType {
				t.Errorf("MimeType = %q, want %q", thumbnail.MimeType, tt.wantMimeType)
			}
			if thumbnail.Extension != tt.wantExtension {
				t.Errorf("Extension = %q, want %q", thumbnail.Extension, tt.wantExtension)
			}
			if len(thumbnail.Data) == 0 {
				t.Fatal("thumbnail is empty")
			}

			decoded, _, err := image.Decode(bytes.NewReader(thumbnail.Data))
			if err != nil {
				t.Fatalf("decode generated thumbnail: %v", err)
			}
			bounds := decoded.Bounds()
			if bounds.Dx() > thumbnailMaxLongEdge || bounds.Dy() > thumbnailMaxLongEdge {
				t.Errorf("thumbnail dimensions = %dx%d, longest edge exceeds %d", bounds.Dx(), bounds.Dy(), thumbnailMaxLongEdge)
			}
			if tt.wantWidth != 0 && (bounds.Dx() != tt.wantWidth || bounds.Dy() != tt.wantHeight) {
				t.Errorf("thumbnail dimensions = %dx%d, want %dx%d", bounds.Dx(), bounds.Dy(), tt.wantWidth, tt.wantHeight)
			}
			if thumbnail.Width != bounds.Dx() || thumbnail.Height != bounds.Dy() {
				t.Errorf("reported dimensions = %dx%d, encoded dimensions = %dx%d", thumbnail.Width, thumbnail.Height, bounds.Dx(), bounds.Dy())
			}
		})
	}
}

func TestGenerateImageThumbnailUsesFirstGIFFrame(t *testing.T) {
	palette := color.Palette{color.RGBA{R: 0xff, A: 0xff}, color.RGBA{B: 0xff, A: 0xff}}
	first := image.NewPaletted(image.Rect(0, 0, 2, 2), palette)
	second := image.NewPaletted(image.Rect(0, 0, 2, 2), palette)
	for i := range second.Pix {
		second.Pix[i] = 1
	}

	var source bytes.Buffer
	if err := gif.EncodeAll(&source, &gif.GIF{Image: []*image.Paletted{first, second}, Delay: []int{1, 1}}); err != nil {
		t.Fatalf("encode GIF fixture: %v", err)
	}

	thumbnail, err := generateImageThumbnail(bytes.NewReader(source.Bytes()))
	if err != nil {
		t.Fatalf("generateImageThumbnail() error = %v", err)
	}
	if thumbnail.MimeType != "image/jpeg" {
		t.Fatalf("MimeType = %q, want image/jpeg", thumbnail.MimeType)
	}

	decoded, _, err := image.Decode(bytes.NewReader(thumbnail.Data))
	if err != nil {
		t.Fatalf("decode generated thumbnail: %v", err)
	}
	red, _, blue, _ := decoded.At(0, 0).RGBA()
	if red <= blue {
		t.Errorf("GIF thumbnail used a later frame: red = %d, blue = %d", red, blue)
	}
}

func TestGenerateImageThumbnailRejectsUnsupportedOrUnsafeSources(t *testing.T) {
	tests := []struct {
		name    string
		source  []byte
		wantErr error
	}{
		{
			name:    "unsupported format",
			source:  []byte("not an image"),
			wantErr: errUnsupportedThumbnailImage,
		},
		{
			name:    "too many source pixels",
			source:  pngHeader(5001, 5000),
			wantErr: errThumbnailImageTooLarge,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := generateImageThumbnail(bytes.NewReader(tt.source))
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("generateImageThumbnail() error = %v, want errors.Is(..., %v)", err, tt.wantErr)
			}
		})
	}
}

func TestSpoolThumbnailSourceCapsInputBytes(t *testing.T) {
	file, err := spoolThumbnailSource(bytes.NewReader([]byte("12345")), 4)
	if file != nil {
		_ = file.Close()
		_ = os.Remove(file.Name())
		t.Error("spoolThumbnailSource() file is non-nil, want nil")
	}
	if !errors.Is(err, errThumbnailSourceTooLarge) {
		t.Fatalf("spoolThumbnailSource() error = %v, want errors.Is(..., %v)", err, errThumbnailSourceTooLarge)
	}
}

func TestThumbnailOutputBufferCapsOutputBytes(t *testing.T) {
	output := thumbnailOutputBuffer{limit: 4}
	written, err := output.Write([]byte("12345"))
	if written != 4 {
		t.Errorf("Write() bytes written = %d, want 4", written)
	}
	if !errors.Is(err, errThumbnailOutputTooLarge) {
		t.Fatalf("Write() error = %v, want errors.Is(..., %v)", err, errThumbnailOutputTooLarge)
	}
	if got := output.String(); got != "1234" {
		t.Errorf("output = %q, want %q", got, "1234")
	}
}

func fillImage(dst drawImage, c color.Color) {
	bounds := dst.Bounds()
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			dst.Set(x, y, c)
		}
	}
}

type drawImage interface {
	image.Image
	Set(x, y int, c color.Color)
}

func encodeJPEG(t *testing.T, source image.Image) []byte {
	t.Helper()
	var output bytes.Buffer
	if err := jpeg.Encode(&output, source, nil); err != nil {
		t.Fatalf("encode JPEG fixture: %v", err)
	}
	return output.Bytes()
}

func encodePNG(t *testing.T, source image.Image) []byte {
	t.Helper()
	var output bytes.Buffer
	if err := png.Encode(&output, source); err != nil {
		t.Fatalf("encode PNG fixture: %v", err)
	}
	return output.Bytes()
}

func pngHeader(width, height uint32) []byte {
	header := []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}
	// Include the IHDR checksum bytes even though DecodeConfig does not need to
	// validate them; image format sniffing can buffer past the chunk body.
	chunk := make([]byte, 8+13+4)
	binary.BigEndian.PutUint32(chunk[:4], 13)
	copy(chunk[4:8], "IHDR")
	binary.BigEndian.PutUint32(chunk[8:12], width)
	binary.BigEndian.PutUint32(chunk[12:16], height)
	chunk[16] = 8 // bit depth
	chunk[17] = 2 // true-color
	binary.BigEndian.PutUint32(chunk[21:], crc32.ChecksumIEEE(chunk[4:21]))
	return append(header, chunk...)
}
