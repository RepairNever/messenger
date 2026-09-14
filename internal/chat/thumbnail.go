package chat

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"os"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

const (
	thumbnailVersion         int16 = 1
	thumbnailMaxLongEdge           = 720
	thumbnailMaxSourceBytes  int64 = 50 * 1024 * 1024
	thumbnailMaxSourcePixels int64 = 25_000_000
	thumbnailMaxOutputBytes        = 4 * 1024 * 1024
)

var (
	errUnsupportedThumbnailImage = errors.New("unsupported image format for thumbnail")
	errThumbnailSourceTooLarge   = errors.New("image source exceeds thumbnail byte limit")
	errThumbnailImageTooLarge    = errors.New("image exceeds thumbnail pixel limit")
	errThumbnailOutputTooLarge   = errors.New("thumbnail output exceeds byte limit")
)

// generatedImageThumbnail is a safely-sized image derivative ready to be
// stored with an attachment. Extension does not include a leading dot.
type generatedImageThumbnail struct {
	Data      []byte
	MimeType  string
	Extension string
	Width     int
	Height    int
}

// generateImageThumbnail reads a JPEG, PNG, WebP, or GIF image and returns a
// thumbnail whose longest edge is at most thumbnailMaxLongEdge. GIF thumbnails
// intentionally use only the first frame. Images with transparent pixels are
// encoded as PNG; all other thumbnails are encoded as JPEG.
//
// The source is spooled to a bounded temporary file so its dimensions can be
// checked before the decoder allocates memory for its pixels, without keeping a
// second full copy of the original image in memory. It independently caps both
// source bytes and decoded pixels so callers cannot bypass attachment limits.
func generateImageThumbnail(source io.Reader) (generatedImageThumbnail, error) {
	sourceFile, err := spoolThumbnailSource(source, thumbnailMaxSourceBytes)
	if err != nil {
		return generatedImageThumbnail{}, err
	}
	defer func() {
		_ = sourceFile.Close()
		_ = os.Remove(sourceFile.Name())
	}()

	config, format, err := image.DecodeConfig(sourceFile)
	if err != nil {
		if format == "" {
			return generatedImageThumbnail{}, fmt.Errorf("%w: %v", errUnsupportedThumbnailImage, err)
		}
		return generatedImageThumbnail{}, fmt.Errorf("decode thumbnail image configuration: %w", err)
	}
	if !isThumbnailSourceFormat(format) {
		return generatedImageThumbnail{}, fmt.Errorf("%w: %s", errUnsupportedThumbnailImage, format)
	}
	if err := validateThumbnailSourceDimensions(config.Width, config.Height); err != nil {
		return generatedImageThumbnail{}, err
	}
	if _, err := sourceFile.Seek(0, io.SeekStart); err != nil {
		return generatedImageThumbnail{}, fmt.Errorf("rewind thumbnail source: %w", err)
	}

	decoded, err := decodeThumbnailSource(sourceFile, format)
	if err != nil {
		return generatedImageThumbnail{}, err
	}
	bounds := decoded.Bounds()
	if err := validateThumbnailSourceDimensions(bounds.Dx(), bounds.Dy()); err != nil {
		return generatedImageThumbnail{}, err
	}
	hasTransparency := imageHasTransparency(decoded)

	width, height := thumbnailDimensions(bounds.Dx(), bounds.Dy())
	resized := image.NewNRGBA(image.Rect(0, 0, width, height))
	draw.CatmullRom.Scale(resized, resized.Bounds(), decoded, bounds, draw.Over, nil)

	output := thumbnailOutputBuffer{limit: thumbnailMaxOutputBytes}
	thumbnail := generatedImageThumbnail{
		Width:  width,
		Height: height,
	}
	if hasTransparency {
		if err := png.Encode(&output, resized); err != nil {
			return generatedImageThumbnail{}, fmt.Errorf("encode PNG thumbnail: %w", err)
		}
		thumbnail.MimeType = "image/png"
		thumbnail.Extension = "png"
	} else {
		if err := jpeg.Encode(&output, resized, &jpeg.Options{Quality: 85}); err != nil {
			return generatedImageThumbnail{}, fmt.Errorf("encode JPEG thumbnail: %w", err)
		}
		thumbnail.MimeType = "image/jpeg"
		thumbnail.Extension = "jpg"
	}
	thumbnail.Data = output.Bytes()
	return thumbnail, nil
}

func spoolThumbnailSource(source io.Reader, maxBytes int64) (_ *os.File, resultErr error) {
	if maxBytes < 0 {
		return nil, fmt.Errorf("invalid thumbnail source byte limit: %d", maxBytes)
	}

	file, err := os.CreateTemp("", "msgnr-chat-thumbnail-*")
	if err != nil {
		return nil, fmt.Errorf("create thumbnail source spool: %w", err)
	}
	defer func() {
		if resultErr == nil {
			return
		}
		_ = file.Close()
		_ = os.Remove(file.Name())
	}()

	written, err := io.Copy(file, io.LimitReader(source, maxBytes+1))
	if err != nil {
		return nil, fmt.Errorf("spool thumbnail source: %w", err)
	}
	if written > maxBytes {
		return nil, fmt.Errorf("%w: limit %d bytes", errThumbnailSourceTooLarge, maxBytes)
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return nil, fmt.Errorf("rewind thumbnail source spool: %w", err)
	}
	return file, nil
}

func isThumbnailSourceFormat(format string) bool {
	switch format {
	case "jpeg", "png", "webp", "gif":
		return true
	default:
		return false
	}
}

func validateThumbnailSourceDimensions(width, height int) error {
	if width <= 0 || height <= 0 {
		return fmt.Errorf("%w: non-positive dimensions", errUnsupportedThumbnailImage)
	}
	if int64(width) > thumbnailMaxSourcePixels/int64(height) {
		return fmt.Errorf("%w: %dx%d", errThumbnailImageTooLarge, width, height)
	}
	return nil
}

func decodeThumbnailSource(source io.Reader, format string) (image.Image, error) {
	if format == "gif" {
		// image/gif.Decode returns the first frame without decoding later frames.
		decoded, err := gif.Decode(source)
		if err != nil {
			return nil, fmt.Errorf("decode GIF thumbnail source: %w", err)
		}
		return decoded, nil
	}

	decoded, decodedFormat, err := image.Decode(source)
	if err != nil {
		return nil, fmt.Errorf("decode thumbnail source: %w", err)
	}
	if decodedFormat != format {
		return nil, fmt.Errorf("%w: decoder format mismatch", errUnsupportedThumbnailImage)
	}
	return decoded, nil
}

func thumbnailDimensions(width, height int) (int, int) {
	if width <= thumbnailMaxLongEdge && height <= thumbnailMaxLongEdge {
		return width, height
	}
	if width >= height {
		return thumbnailMaxLongEdge, atLeastOne(int(int64(height) * thumbnailMaxLongEdge / int64(width)))
	}
	return atLeastOne(int(int64(width) * thumbnailMaxLongEdge / int64(height))), thumbnailMaxLongEdge
}

func atLeastOne(value int) int {
	if value < 1 {
		return 1
	}
	return value
}

func imageHasTransparency(source image.Image) bool {
	bounds := source.Bounds()
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			_, _, _, alpha := source.At(x, y).RGBA()
			if alpha != 0xffff {
				return true
			}
		}
	}
	return false
}

type thumbnailOutputBuffer struct {
	bytes.Buffer
	limit int
}

func (b *thumbnailOutputBuffer) Write(data []byte) (int, error) {
	if len(data) == 0 {
		return 0, nil
	}
	remaining := b.limit - b.Len()
	if remaining <= 0 {
		return 0, errThumbnailOutputTooLarge
	}
	if len(data) > remaining {
		_, _ = b.Buffer.Write(data[:remaining])
		return remaining, errThumbnailOutputTooLarge
	}
	return b.Buffer.Write(data)
}
