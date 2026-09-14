package httputil

import (
	"encoding/json"
	"net/http"
	"strings"
)

func BearerToken(r *http.Request) string {
	value := r.Header.Get("Authorization")
	if after, ok := strings.CutPrefix(value, "Bearer "); ok {
		return strings.TrimSpace(after)
	}
	return ""
}

func WriteJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func ErrorBody(msg string) map[string]string {
	return map[string]string{"error": msg}
}

func MethodNotAllowed(w http.ResponseWriter) {
	WriteJSON(w, http.StatusMethodNotAllowed, ErrorBody("method not allowed"))
}
