#!/usr/bin/env bash
set -euo pipefail
umask 077

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
production_env_path="${MSGNR_PROD_ENV_FILE:-${repo_root}/.env.prod}"

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 chat.example.com owner@example.com" >&2
  exit 1
fi
app_domain="$1"
owner_email="$2"
if [[ ! "$app_domain" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
  echo 'Domain must be a hostname without https://, a port or a path' >&2
  exit 1
fi
if [[ ! "$owner_email" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
  echo 'Provide a valid owner email address' >&2
  exit 1
fi
if [[ -e "$production_env_path" ]]; then
  echo "Refusing to replace existing configuration: ${production_env_path}" >&2
  exit 1
fi

# A partial server checkout must fail before Docker can create bind-source directories.
for required_file in compose-prod.yml migrations/schema.sql etc/prod/initdb.sql etc/prod/init-storage.sh web/Dockerfile web/nginx.conf web/web_client.tar.gz; do
  if [[ ! -f "${repo_root}/${required_file}" || ! -r "${repo_root}/${required_file}" ]]; then
    echo "Required deployment file is missing, unreadable or is not a regular file: ${repo_root}/${required_file}" >&2
    echo 'Sync the complete repository before configuring production.' >&2
    exit 1
  fi
done
command -v openssl >/dev/null
command -v docker >/dev/null

# Node's built-in crypto generates a standard P-256 VAPID keypair, with no npm install.
vapid_keys="$(docker run --rm node:22-alpine node -e '
  const crypto = require("node:crypto");
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const key = privateKey.export({ format: "jwk" });
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(key.x, "base64url"), Buffer.from(key.y, "base64url")]);
  console.log("VAPID_PUBLIC_KEY=" + pub.toString("base64url"));
  console.log("VAPID_PRIVATE_KEY=" + key.d);
')"
if [[ "$vapid_keys" != VAPID_PUBLIC_KEY=* || "$vapid_keys" != *VAPID_PRIVATE_KEY=* ]]; then
  echo 'Failed to generate VAPID keys' >&2
  exit 1
fi

# noclobber also protects against two setup processes overwriting each other.
set -o noclobber
cat > "$production_env_path" <<EOF
# Generated for compose-prod.yml. Keep this file and the persistent volumes.
APP_DOMAIN=${app_domain}
WORKSPACE_NAME=Msgnr
INITIAL_OWNER_EMAIL=${owner_email}
INITIAL_OWNER_NAME=Administrator
INITIAL_OWNER_PASSWORD=$(openssl rand -hex 24)
POSTGRES_PASSWORD=$(openssl rand -hex 32)
APP_DB_PASSWORD=$(openssl rand -hex 32)
JWT_SECRET=$(openssl rand -hex 32)
REDIS_PASSWORD=$(openssl rand -hex 32)
MINIO_ROOT_USER=msgnr-storage-root
MINIO_ROOT_PASSWORD=$(openssl rand -hex 32)
MINIO_ACCESS_KEY=msgnr-attachments
MINIO_SECRET_KEY=$(openssl rand -hex 32)
MINIO_BUCKET=task-attachments
LIVEKIT_API_KEY=$(openssl rand -hex 16)
LIVEKIT_API_SECRET=$(openssl rand -hex 32)
${vapid_keys}
WEB_HOST_PORT=8080
BACKEND_HOST_PORT=9090
METRICS_HOST_PORT=9190
REDIS_HOST_PORT=16379
EOF

chmod 600 "$production_env_path"
echo "Created ${production_env_path}"
echo "Owner login: ${owner_email}"
echo 'The initial owner password is INITIAL_OWNER_PASSWORD in that file.'
echo 'Start from the repository root:'
printf 'docker compose --env-file %q -f compose-prod.yml up -d --build --wait\n' "$production_env_path"
