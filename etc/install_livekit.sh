#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-livekit}"
SERVICE_USER="${SERVICE_USER:-livekit}"
WORK_DIR="${WORK_DIR:-/opt/msgnr}"
BIN_PATH="/usr/local/bin/livekit-server"
CONFIG_PATH="${CONFIG_PATH:-${WORK_DIR}/livekit.yaml}"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

LIVEKIT_PORT="${LIVEKIT_PORT:-7880}"
LIVEKIT_UDP_START="${LIVEKIT_UDP_START:-50000}"
LIVEKIT_UDP_END="${LIVEKIT_UDP_END:-50100}"
LIVEKIT_WEBHOOK_URL="${LIVEKIT_WEBHOOK_URL:-http://localhost:8080/api/livekit/webhook}"
LIVEKIT_API_KEY="${LIVEKIT_API_KEY:-}"
LIVEKIT_API_SECRET="${LIVEKIT_API_SECRET:-}"
MSGNR_ENV_PATH="${MSGNR_ENV_PATH:-/opt/msgnr/.env}"
DO_OPEN_PORTS="${DO_OPEN_PORTS:-1}"
DO_RESTART_SERVICE="${DO_RESTART_SERVICE:-1}"

if [[ ${EUID} -ne 0 ]]; then
  echo "Error: must run as root." >&2
  exit 1
fi

if [[ ! "${LIVEKIT_API_KEY}" ]]; then
  LIVEKIT_API_KEY="msgnr_$(date +%s)_$(head -c 8 /dev/urandom | tr -dc 'a-z0-9')"
fi

if [[ ! "${LIVEKIT_API_SECRET}" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    LIVEKIT_API_SECRET="$(openssl rand -base64 32)"
  else
    LIVEKIT_API_SECRET="$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 48)"
  fi
fi

mkdir -p "${WORK_DIR}"

if ! id "${SERVICE_USER}" &>/dev/null; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "${SERVICE_USER}"
fi

chown -R "${SERVICE_USER}:${SERVICE_USER}" "${WORK_DIR}"

if command -v livekit-server >/dev/null 2>&1; then
  echo "LiveKit is already installed: $(command -v livekit-server)"
else
  if ! command -v curl >/dev/null 2>&1; then
    echo "Error: curl is required." >&2
    exit 1
  fi

  echo "Installing LiveKit server via get.livekit.io..."
  curl -sSL https://get.livekit.io | bash
  if ! command -v livekit-server >/dev/null 2>&1; then
    echo "Error: LiveKit installer completed, but livekit-server is still not in PATH." >&2
    echo "Check installer output and installation logs." >&2
    exit 1
  fi
fi

chown "${SERVICE_USER}:${SERVICE_USER}" "${BIN_PATH}"

cat > "${CONFIG_PATH}" <<EOF
port: ${LIVEKIT_PORT}
rtc:
  port_range_start: ${LIVEKIT_UDP_START}
  port_range_end: ${LIVEKIT_UDP_END}
keys:
  ${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}
webhook:
  api_key: ${LIVEKIT_API_KEY}
  urls:
    - ${LIVEKIT_WEBHOOK_URL}
EOF

cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=LiveKit SFU
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${WORK_DIR}
ExecStart=${BIN_PATH} --config ${CONFIG_PATH}
Restart=on-failure
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

chmod 600 "${CONFIG_PATH}"
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"

if [[ "${DO_RESTART_SERVICE}" == "1" ]]; then
  systemctl restart "${SERVICE_NAME}"
fi

if [[ "${DO_OPEN_PORTS}" == "1" ]]; then
  if command -v ufw >/dev/null 2>&1; then
    ufw allow "${LIVEKIT_PORT}/tcp" || true
    ufw allow "${LIVEKIT_UDP_START}:${LIVEKIT_UDP_END}/udp" || true
  fi
fi

if [[ -f "${MSGNR_ENV_PATH}" ]]; then
  {
    echo
    echo "# Added by install_livekit.sh"
    echo "LIVEKIT_URL=ws://$(hostname -I | awk '{print $1}' || true):${LIVEKIT_PORT}"
    echo "LIVEKIT_API_KEY=${LIVEKIT_API_KEY}"
    echo "LIVEKIT_API_SECRET=${LIVEKIT_API_SECRET}"
  } >> "${MSGNR_ENV_PATH}"
fi

systemctl status "${SERVICE_NAME}" --no-pager

cat <<EOF
LiveKit install complete.
Service: ${SERVICE_NAME}
Config: ${CONFIG_PATH}
Binary: ${BIN_PATH}

API Key: ${LIVEKIT_API_KEY}
API Secret: ${LIVEKIT_API_SECRET}
Webhook: ${LIVEKIT_WEBHOOK_URL}

If this is the first install, restart msgnr after updating LIVEKIT_* env vars.

To start manually from this script defaults:
  ${BIN_PATH} --config ${CONFIG_PATH}
EOF
