package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWithCORSPreservesEndpointVaryHeader(t *testing.T) {
	handler := withCORS(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Add("Vary", "Authorization")
		w.WriteHeader(http.StatusOK)
	}), "https://chat.example.test")

	request := httptest.NewRequest(http.MethodGet, "/api/messages/example/attachments/example/thumbnail/v1", nil)
	request.Header.Set("Origin", "https://chat.example.test")
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if got := recorder.Header().Values("Vary"); len(got) != 2 || got[0] != "Origin" || got[1] != "Authorization" {
		t.Fatalf("Vary headers = %v, want [Origin Authorization]", got)
	}
}
