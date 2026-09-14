package chat

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDecodeE2EEDeviceRequestRejectsUnknownTrailingAndOversizedBodies(t *testing.T) {
	t.Parallel()

	for name, body := range map[string]string{
		"unknown field":  `{"device_id":"device","private_key":"must not be accepted"}`,
		"trailing value": `{"device_id":"device"} {}`,
		"oversized body": `{"device_label":"` + strings.Repeat("x", int(maxE2EEDeviceRequestBytes)) + `"}`,
	} {
		t.Run(name, func(t *testing.T) {
			request := httptest.NewRequest("POST", "/api/e2ee/devices", strings.NewReader(body))
			response := httptest.NewRecorder()
			var payload registerE2EEDeviceRequest

			if err := decodeE2EEDeviceRequest(response, request, &payload); err == nil {
				t.Fatal("expected invalid E2EE device request to be rejected")
			}
		})
	}
}
