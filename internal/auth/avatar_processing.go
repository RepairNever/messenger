package auth

import (
	"bytes"
	"image"
	imagedraw "image/draw"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"

	"golang.org/x/image/draw"
	"golang.org/x/image/webp"
)

const avatarOutputSize = 256

type decoderFn func(io.Reader) (image.Image, error)

var avatarDecoders = map[string]decoderFn{
	"image/jpeg": jpeg.Decode,
	"image/png":  png.Decode,
	"image/webp": webp.Decode,
	"image/gif":  gif.Decode,
}

func normalizeAvatarImage(payload []byte) ([]byte, string, error) {
	mimeType := http.DetectContentType(payload)

	decoded, err := decodeAvatar(payload, mimeType)
	if err != nil {
		return nil, "", err
	}

	bounds := decoded.Bounds()
	width := bounds.Dx()
	height := bounds.Dy()
	if width == 0 || height == 0 {
		return nil, "", ErrAvatarBadRequest
	}

	side := width
	if height < side {
		side = height
	}
	srcMinX := bounds.Min.X + (width-side)/2
	srcMinY := bounds.Min.Y + (height-side)/2

	cropped := image.NewRGBA(image.Rect(0, 0, side, side))
	imagedraw.Draw(cropped, cropped.Bounds(), decoded, image.Pt(srcMinX, srcMinY), imagedraw.Src)

	resized := image.NewRGBA(image.Rect(0, 0, avatarOutputSize, avatarOutputSize))
	draw.CatmullRom.Scale(resized, resized.Bounds(), cropped, cropped.Bounds(), draw.Over, nil)

	var out bytes.Buffer
	encoder := png.Encoder{CompressionLevel: png.BestCompression}
	if err := encoder.Encode(&out, resized); err != nil {
		return nil, "", ErrAvatarBadRequest
	}
	return out.Bytes(), "image/png", nil
}

func decodeAvatar(payload []byte, mimeType string) (image.Image, error) {
	decoder, ok := avatarDecoders[mimeType]
	if !ok {
		return nil, ErrAvatarUnsupported
	}
	img, err := decoder(bytes.NewReader(payload))
	if err != nil {
		return nil, ErrAvatarBadRequest
	}
	return img, nil
}
