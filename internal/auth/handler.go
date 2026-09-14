package auth

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"go.uber.org/zap"
	"msgnr/internal/httputil"
	"msgnr/internal/logger"
	"msgnr/internal/userstatus"
)

// Handler exposes HTTP auth endpoints.
type Handler struct {
	svc *Service
	log *zap.Logger
}

func NewHandler(svc *Service) *Handler {
	return &Handler{svc: svc, log: logger.Logger}
}

// RegisterRoutes registers /api/auth/* on the given mux.
func (h *Handler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/auth/login", h.login)
	mux.HandleFunc("/api/auth/refresh", h.refresh)
	mux.HandleFunc("/api/auth/logout", h.logout)
	mux.HandleFunc("/api/auth/profile", h.profile)
	mux.HandleFunc("/api/auth/custom-status", h.customStatus)
	mux.HandleFunc("/api/auth/avatar", h.avatar)
	mux.HandleFunc("/api/public/avatars/", h.publicAvatar)
	mux.HandleFunc("/api/auth/change-password", h.changePassword)
}

// ---- request / response types ----

type loginRequest struct {
	Email      string `json:"email"`
	Password   string `json:"password"`
	DeviceName string `json:"device_name"`
}

type loginResponse struct {
	AccessToken  string   `json:"access_token"`
	RefreshToken string   `json:"refresh_token"`
	ExpiresInSec int64    `json:"expires_in_sec"`
	User         userBody `json:"user"`
}

type userBody struct {
	ID                 string           `json:"id"`
	Email              string           `json:"email"`
	DisplayName        string           `json:"display_name"`
	AvatarURL          string           `json:"avatar_url"`
	CustomStatus       *userstatus.Body `json:"custom_status"`
	Role               string           `json:"role"`
	NeedChangePassword bool             `json:"need_change_password,omitempty"`
}

type changePasswordRequest struct {
	NewPassword string `json:"new_password"`
}

type refreshRequest struct {
	RefreshToken string `json:"refresh_token"`
}

type refreshResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresInSec int64  `json:"expires_in_sec"`
}

type updateProfileRequest struct {
	DisplayName string `json:"display_name"`
	Email       string `json:"email"`
}

type setCustomStatusRequest struct {
	Text      string    `json:"text"`
	Emoji     string    `json:"emoji"`
	ExpiresAt time.Time `json:"expires_at"`
}

type profileResponse struct {
	User userBody `json:"user"`
}

type logoutRequest struct {
	RefreshToken string `json:"refresh_token"`
}

// ---- handlers ----

func (h *Handler) login(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
		return
	}

	var req loginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Email == "" || req.Password == "" {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid request body"))
		return
	}

	userAgent := r.UserAgent()
	ipAddr := realIP(r)

	pair, info, err := h.svc.Login(r.Context(), req.Email, req.Password, userAgent, ipAddr)
	if err != nil {
		switch {
		case errors.Is(err, ErrInvalidCredentials):
			httputil.WriteJSON(w, http.StatusUnauthorized, httputil.ErrorBody("invalid credentials"))
		case errors.Is(err, ErrBotUserUnsupported):
			httputil.WriteJSON(w, http.StatusUnauthorized, httputil.ErrorBody("invalid credentials"))
		case errors.Is(err, ErrUserBlocked):
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("account blocked"))
		default:
			h.log.Error("login error", zap.Error(err))
			httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		}
		return
	}

	httputil.WriteJSON(w, http.StatusOK, loginResponse{
		AccessToken:  pair.AccessToken,
		RefreshToken: pair.RefreshToken,
		ExpiresInSec: int64(pair.ExpiresIn.Seconds()),
		User:         toUserBody(info),
	})
}

func (h *Handler) refresh(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
		return
	}

	var req refreshRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.RefreshToken == "" {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid request body"))
		return
	}

	pair, err := h.svc.Refresh(r.Context(), req.RefreshToken, r.UserAgent(), realIP(r))
	if err != nil {
		switch {
		case errors.Is(err, ErrInvalidCredentials), errors.Is(err, ErrSessionNotFound), errors.Is(err, ErrBotUserUnsupported):
			httputil.WriteJSON(w, http.StatusUnauthorized, httputil.ErrorBody("invalid or expired refresh token"))
		case errors.Is(err, ErrUserBlocked):
			httputil.WriteJSON(w, http.StatusForbidden, httputil.ErrorBody("account blocked"))
		default:
			h.log.Error("refresh error", zap.Error(err))
			httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		}
		return
	}

	httputil.WriteJSON(w, http.StatusOK, refreshResponse{
		AccessToken:  pair.AccessToken,
		RefreshToken: pair.RefreshToken,
		ExpiresInSec: int64(pair.ExpiresIn.Seconds()),
	})
}

func (h *Handler) logout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
		return
	}

	var req logoutRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.RefreshToken == "" {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid request body"))
		return
	}

	if err := h.svc.Logout(r.Context(), req.RefreshToken); err != nil {
		h.log.Error("logout error", zap.Error(err))
		httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) profile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPatch {
		httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
		return
	}

	token := httputil.BearerToken(r)
	if token == "" {
		httputil.WriteJSON(w, http.StatusUnauthorized, httputil.ErrorBody("missing authorization"))
		return
	}

	principal, err := h.svc.VerifyAccess(r.Context(), token)
	if err != nil {
		httputil.WriteJSON(w, http.StatusUnauthorized, httputil.ErrorBody("invalid or expired token"))
		return
	}

	if r.Method == http.MethodGet {
		info, err := h.svc.GetProfile(r.Context(), principal.UserID)
		if err != nil {
			h.log.Error("getProfile error", zap.Error(err))
			httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
			return
		}
		httputil.WriteJSON(w, http.StatusOK, profileResponse{User: toUserBody(info)})
		return
	}

	var req updateProfileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid request body"))
		return
	}

	info, err := h.svc.UpdateProfile(r.Context(), principal.UserID, req.DisplayName, req.Email)
	if err != nil {
		switch {
		case errors.Is(err, ErrProfileConflict):
			httputil.WriteJSON(w, http.StatusConflict, httputil.ErrorBody(err.Error()))
		case errors.Is(err, ErrProfileBadRequest):
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody(err.Error()))
		default:
			h.log.Error("updateProfile error", zap.Error(err))
			httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		}
		return
	}

	httputil.WriteJSON(w, http.StatusOK, profileResponse{User: toUserBody(info)})
}

func (h *Handler) avatar(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
		return
	}

	token := httputil.BearerToken(r)
	if token == "" {
		httputil.WriteJSON(w, http.StatusUnauthorized, httputil.ErrorBody("missing authorization"))
		return
	}

	principal, err := h.svc.VerifyAccess(r.Context(), token)
	if err != nil {
		httputil.WriteJSON(w, http.StatusUnauthorized, httputil.ErrorBody("invalid or expired token"))
		return
	}

	switch r.Method {
	case http.MethodDelete:
		info, err := h.svc.RemoveAvatar(r.Context(), principal.UserID)
		if err != nil {
			switch {
			case errors.Is(err, ErrAvatarNotConfigured):
				httputil.WriteJSON(w, http.StatusServiceUnavailable, httputil.ErrorBody("avatar service unavailable"))
			default:
				h.log.Error("removeAvatar error", zap.Error(err))
				httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
			}
			return
		}
		httputil.WriteJSON(w, http.StatusOK, profileResponse{User: toUserBody(info)})
		return

	case http.MethodPost:
		// Allow a small multipart overhead margin while enforcing avatar payload limits.
		maxBodyBytes := h.svc.AvatarMaxBytes() + (1 << 20)
		r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
		if err := r.ParseMultipartForm(maxBodyBytes); err != nil {
			if isRequestTooLarge(err) {
				httputil.WriteJSON(w, http.StatusRequestEntityTooLarge, httputil.ErrorBody("avatar file exceeds maximum allowed size"))
				return
			}
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("failed to parse multipart form"))
			return
		}
		file, _, err := r.FormFile("avatar")
		if err != nil {
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("missing avatar file"))
			return
		}
		defer file.Close()

		info, err := h.svc.UploadAvatar(r.Context(), principal.UserID, file)
		if err != nil {
			switch {
			case errors.Is(err, ErrAvatarTooLarge):
				httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("avatar file exceeds maximum allowed size"))
			case errors.Is(err, ErrAvatarUnsupported):
				httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("unsupported avatar format"))
			case errors.Is(err, ErrAvatarBadRequest):
				httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid avatar image"))
			case errors.Is(err, ErrAvatarNotConfigured):
				httputil.WriteJSON(w, http.StatusServiceUnavailable, httputil.ErrorBody("avatar service unavailable"))
			default:
				h.log.Error("uploadAvatar error", zap.Error(err))
				httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
			}
			return
		}

		httputil.WriteJSON(w, http.StatusOK, profileResponse{User: toUserBody(info)})
	}
}

func (h *Handler) customStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut && r.Method != http.MethodDelete {
		httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
		return
	}

	token := httputil.BearerToken(r)
	if token == "" {
		httputil.WriteJSON(w, http.StatusUnauthorized, httputil.ErrorBody("missing authorization"))
		return
	}

	principal, err := h.svc.VerifyAccess(r.Context(), token)
	if err != nil {
		httputil.WriteJSON(w, http.StatusUnauthorized, httputil.ErrorBody("invalid or expired token"))
		return
	}

	if r.Method == http.MethodDelete {
		info, err := h.svc.ClearCustomStatus(r.Context(), principal.UserID)
		if err != nil {
			h.log.Error("clearCustomStatus error", zap.Error(err))
			httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
			return
		}
		httputil.WriteJSON(w, http.StatusOK, profileResponse{User: toUserBody(info)})
		return
	}

	var req setCustomStatusRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("invalid request body"))
		return
	}

	info, err := h.svc.SetCustomStatus(r.Context(), principal.UserID, req.Text, req.Emoji, req.ExpiresAt)
	if err != nil {
		switch {
		case errors.Is(err, ErrProfileBadRequest):
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody(err.Error()))
		default:
			h.log.Error("setCustomStatus error", zap.Error(err))
			httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		}
		return
	}

	httputil.WriteJSON(w, http.StatusOK, profileResponse{User: toUserBody(info)})
}

func isRequestTooLarge(err error) bool {
	var maxBytesErr *http.MaxBytesError
	if errors.As(err, &maxBytesErr) {
		return true
	}
	return strings.Contains(strings.ToLower(err.Error()), "request body too large")
}

func (h *Handler) publicAvatar(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
		return
	}

	escapedPath := r.URL.EscapedPath()
	storageKeyEscaped := strings.TrimPrefix(escapedPath, "/api/public/avatars/")
	if storageKeyEscaped == escapedPath || storageKeyEscaped == "" {
		httputil.WriteJSON(w, http.StatusNotFound, httputil.ErrorBody("not found"))
		return
	}
	storageKey, err := url.PathUnescape(storageKeyEscaped)
	if err != nil || strings.TrimSpace(storageKey) == "" {
		httputil.WriteJSON(w, http.StatusNotFound, httputil.ErrorBody("not found"))
		return
	}

	body, size, mimeType, err := h.svc.DownloadPublicAvatar(r.Context(), storageKey)
	if err != nil {
		switch {
		case errors.Is(err, ErrAvatarNotFound):
			httputil.WriteJSON(w, http.StatusNotFound, httputil.ErrorBody("not found"))
		case errors.Is(err, ErrAvatarNotConfigured):
			httputil.WriteJSON(w, http.StatusServiceUnavailable, httputil.ErrorBody("avatar service unavailable"))
		default:
			h.log.Error("publicAvatar error", zap.Error(err))
			httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		}
		return
	}
	defer body.Close()

	if mimeType == "" {
		mimeType = "image/png"
	}
	w.Header().Set("Content-Type", mimeType)
	if size > 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	}
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.WriteHeader(http.StatusOK)
	io.Copy(w, body) //nolint:errcheck
}

func toUserBody(info UserInfo) userBody {
	return userBody{
		ID:                 info.ID.String(),
		Email:              info.Email,
		DisplayName:        info.DisplayName,
		AvatarURL:          info.AvatarURL,
		CustomStatus:       userstatus.ToBody(info.CustomStatus),
		Role:               info.Role,
		NeedChangePassword: info.NeedChangePassword,
	}
}

func (h *Handler) changePassword(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httputil.WriteJSON(w, http.StatusMethodNotAllowed, httputil.ErrorBody("method not allowed"))
		return
	}

	token := httputil.BearerToken(r)
	if token == "" {
		httputil.WriteJSON(w, http.StatusUnauthorized, httputil.ErrorBody("missing authorization"))
		return
	}

	principal, err := h.svc.VerifyAccess(r.Context(), token)
	if err != nil {
		httputil.WriteJSON(w, http.StatusUnauthorized, httputil.ErrorBody("invalid or expired token"))
		return
	}

	var req changePasswordRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.NewPassword == "" {
		httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody("new_password is required"))
		return
	}

	if err := h.svc.ChangePassword(r.Context(), principal.UserID, req.NewPassword); err != nil {
		switch {
		case errors.Is(err, ErrPasswordChangeFailed):
			httputil.WriteJSON(w, http.StatusBadRequest, httputil.ErrorBody(err.Error()))
		default:
			h.log.Error("change password error", zap.Error(err))
			httputil.WriteJSON(w, http.StatusInternalServerError, httputil.ErrorBody("internal error"))
		}
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func realIP(r *http.Request) string {
	if ip := r.Header.Get("X-Real-IP"); ip != "" {
		return ip
	}
	if ip := r.Header.Get("X-Forwarded-For"); ip != "" {
		return ip
	}
	return r.RemoteAddr
}
