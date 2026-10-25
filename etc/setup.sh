#!/bin/bash

set -e

SERVICE_NAME="msgnr"
BINARY="/opt/msgnr/server-linux"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
SERVICE_USER="msgnr"
WORK_DIR="/opt/msgnr"

# Must run as root
if [[ $EUID -ne 0 ]]; then
    echo "Error: This script must be run as root" >&2
    exit 1
fi

echo "Setting up ${SERVICE_NAME} service..."

# Create dedicated system user if it doesn't exist
if ! id "${SERVICE_USER}" &>/dev/null; then
    useradd --system --no-create-home --shell /usr/sbin/nologin "${SERVICE_USER}"
    echo "Created system user: ${SERVICE_USER}"
fi

# Ensure required files/dirs exist
if [[ ! -x "${BINARY}" ]]; then
    echo "Error: binary not found or not executable: ${BINARY}" >&2
    exit 1
fi

if [[ ! -d "${WORK_DIR}" ]]; then
    echo "Error: working directory not found: ${WORK_DIR}" >&2
    exit 1
fi



# Ensure binary is executable
chmod 755 "${BINARY}"

# Set working directory ownership
chown -R "${SERVICE_USER}:${SERVICE_USER}" "/opt/ai-orchestrator"

# Create systemd service unit
cat > "${SERVICE_FILE}" <<EOF_UNIT
[Unit]
Description=AI Orchestrator Service
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${WORK_DIR}
ExecStart=${BINARY}
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
EOF_UNIT

echo "Created service file: ${SERVICE_FILE}"

# Reload systemd, enable and start the service
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

echo ""
echo "Done. Service status:"
systemctl status "${SERVICE_NAME}" --no-pager