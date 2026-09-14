package auth

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakeAvatarStorage struct{}

func (fakeAvatarStorage) PutObject(context.Context, string, io.Reader, int64, string) error {
	return nil
}
func (fakeAvatarStorage) GetObject(context.Context, string) (io.ReadCloser, int64, string, error) {
	return io.NopCloser(bytes.NewReader(nil)), 0, "image/png", nil
}
func (fakeAvatarStorage) DeleteObject(context.Context, string) error { return nil }

func TestNormalizeAvatarImage_JPEGToSquarePNG(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 400, 200))
	fillRect(src, image.Rect(0, 0, 200, 200), color.RGBA{R: 220, A: 255})
	fillRect(src, image.Rect(200, 0, 400, 200), color.RGBA{B: 220, A: 255})

	var in bytes.Buffer
	require.NoError(t, jpeg.Encode(&in, src, &jpeg.Options{Quality: 90}))

	out, mimeType, err := normalizeAvatarImage(in.Bytes())
	require.NoError(t, err)
	assert.Equal(t, "image/png", mimeType)

	decoded, err := png.Decode(bytes.NewReader(out))
	require.NoError(t, err)
	assert.Equal(t, 256, decoded.Bounds().Dx())
	assert.Equal(t, 256, decoded.Bounds().Dy())
}

func TestNormalizeAvatarImage_GIFUsesFirstFrame(t *testing.T) {
	palette := color.Palette{
		color.RGBA{R: 255, A: 255},
		color.RGBA{B: 255, A: 255},
	}
	frame1 := image.NewPaletted(image.Rect(0, 0, 64, 64), palette)
	frame2 := image.NewPaletted(image.Rect(0, 0, 64, 64), palette)
	for i := range frame1.Pix {
		frame1.Pix[i] = 0 // red
		frame2.Pix[i] = 1 // blue
	}

	var in bytes.Buffer
	require.NoError(t, gif.EncodeAll(&in, &gif.GIF{
		Image: []*image.Paletted{frame1, frame2},
		Delay: []int{10, 10},
	}))

	out, _, err := normalizeAvatarImage(in.Bytes())
	require.NoError(t, err)
	decoded, err := png.Decode(bytes.NewReader(out))
	require.NoError(t, err)

	px := color.RGBAModel.Convert(decoded.At(32, 32)).(color.RGBA)
	assert.Greater(t, int(px.R), 200)
	assert.Less(t, int(px.G), 80)
	assert.Less(t, int(px.B), 80)
}

func TestNormalizeAvatarImage_UnsupportedFormat(t *testing.T) {
	_, _, err := normalizeAvatarImage([]byte("not-an-image"))
	assert.ErrorIs(t, err, ErrAvatarUnsupported)
}

func TestUploadAvatar_Validation(t *testing.T) {
	svc := &Service{}
	svc.ConfigureAvatars(fakeAvatarStorage{}, 1, nil)

	_, err := svc.UploadAvatar(context.Background(), uuid.New(), bytes.NewReader(make([]byte, svc.avatarMaxBytes+1)))
	assert.ErrorIs(t, err, ErrAvatarTooLarge)

	_, err = svc.UploadAvatar(context.Background(), uuid.New(), bytes.NewReader([]byte("plain text")))
	assert.ErrorIs(t, err, ErrAvatarUnsupported)

	truncatedPNG := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1A, '\n', 0x00, 0x00, 0x00}
	_, err = svc.UploadAvatar(context.Background(), uuid.New(), bytes.NewReader(truncatedPNG))
	assert.ErrorIs(t, err, ErrAvatarBadRequest)
}

func TestRemoveAvatar_NotConfigured(t *testing.T) {
	svc := &Service{}
	_, err := svc.RemoveAvatar(context.Background(), uuid.New())
	assert.ErrorIs(t, err, ErrAvatarNotConfigured)
}

func TestSanitiseAvatarStorageKey(t *testing.T) {
	key, err := sanitiseAvatarStorageKey("avatars/u1/a.png")
	require.NoError(t, err)
	assert.Equal(t, "avatars/u1/a.png", key)

	key, err = sanitiseAvatarStorageKey(" /avatars/u1/a.png ")
	require.NoError(t, err)
	assert.Equal(t, "avatars/u1/a.png", key)

	_, err = sanitiseAvatarStorageKey("../secret")
	assert.Error(t, err)

	_, err = sanitiseAvatarStorageKey(`avatars\\u1\\a.png`)
	assert.Error(t, err)
}

func TestStorageKeyFromAvatarURL(t *testing.T) {
	assert.Equal(t, "avatars/u1/a.png", storageKeyFromAvatarURL("/api/public/avatars/avatars/u1/a.png"))
	assert.Equal(t, "", storageKeyFromAvatarURL("/api/private/avatars/u1.png"))
	assert.Equal(t, "", storageKeyFromAvatarURL("/api/public/avatars/../escape.png"))
}

func fillRect(img *image.RGBA, rect image.Rectangle, c color.RGBA) {
	for y := rect.Min.Y; y < rect.Max.Y; y++ {
		for x := rect.Min.X; x < rect.Max.X; x++ {
			img.SetRGBA(x, y, c)
		}
	}
}
