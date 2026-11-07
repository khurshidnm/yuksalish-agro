#!/usr/bin/env bash
# Writes .env.production: fresh secrets, the domain, and memory settings for this server.
#
#   infra/init-env.sh agropanel.uz   first time. Refuses to touch a file that already exists.
#   infra/init-env.sh --resize           after a server upgrade: only the memory settings change.
#
# Passwords are only written once, on purpose. New ones would not match the database already created.
set -euo pipefail

# shellcheck source=infra/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$YAP_ROOT"

usage() {
  echo "usage: infra/init-env.sh <domain>   or   infra/init-env.sh --resize" >&2
  exit 2
}

# Sets KEY=VALUE in the env file, in place, keeping every other line and the file's mode.
set_value() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp "$ENV_FILE.XXXXXX")"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    awk -v key="$key" -v value="$value" 'index($0, key "=") == 1 { print key "=" value; next } { print }' "$ENV_FILE" > "$tmp"
  else
    cat "$ENV_FILE" > "$tmp"
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

clamp() {
  local value="$1" low="$2" high="$3"
  ((value < low)) && value="$low"
  ((value > high)) && value="$high"
  echo "$value"
}

# Shares of the server's memory, capped by what the pilot sizing gives each part: Postgres gets at most
# the 16 GB of the spec's database server. The API is one Node process that gains nothing from more
# than 4 GB. What is left stays for the operating system, its disk cache and image builds.
write_sizing() {
  local ram db api redis shared
  ram="${YAP_RAM_MB:-$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo)}"
  db="$(clamp $((ram * 45 / 100)) 1024 16384)"
  api="$(clamp $((ram * 25 / 100)) 768 4096)"
  redis="$(clamp $((ram * 5 / 100)) 256 1024)"
  shared=$((db / 4))

  set_value DB_MEM_LIMIT "${db}m"
  set_value API_MEM_LIMIT "${api}m"
  set_value API_HEAP_MB "$((api * 75 / 100))"
  set_value REDIS_MEM_LIMIT "${redis}m"
  set_value REDIS_MAXMEMORY "$((redis * 60 / 100))mb"
  set_value WEB_MEM_LIMIT 256m
  set_value CADDY_MEM_LIMIT 256m
  set_value PG_SHARED_BUFFERS "${shared}MB"
  set_value PG_EFFECTIVE_CACHE_SIZE "$((db * 3 / 4))MB"
  # Up to 100 connections, each of which may sort twice at the same moment.
  set_value PG_WORK_MEM "$(clamp $(((db - shared) / 200)) 4 64)MB"
  set_value PG_MAINTENANCE_WORK_MEM "$(clamp $((db / 16)) 64 1024)MB"
  echo "Memory settings written for a server with $ram MB: Postgres ${db} MB, API ${api} MB, Redis ${redis} MB."
}

domain="${1:-}"
[[ -n "$domain" ]] || usage

if [[ "$domain" == "--resize" ]]; then
  [[ -f "$ENV_FILE" ]] || { echo "$ENV_FILE does not exist yet." >&2; exit 1; }
  write_sizing
  echo "Run infra/deploy.sh to apply them. The database restarts once, for a few seconds."
  exit 0
fi

domain="${domain#https://}"
domain="${domain%/}"
if [[ ! "$domain" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; then
  echo "'$domain' does not look like a domain name. Example: agropanel.uz" >&2
  exit 2
fi
if [[ -e "$ENV_FILE" ]]; then
  echo "$ENV_FILE already exists, and nothing was changed. Its passwords belong to the database that" >&2
  echo "was created with them. To only change the memory settings: infra/init-env.sh --resize" >&2
  exit 1
fi

(umask 077 && cp infra/env.production.example "$ENV_FILE")
for secret in POSTGRES_PASSWORD YAP_APP_PASSWORD YAP_AI_PASSWORD REDIS_PASSWORD JWT_SECRET; do
  set_value "$secret" "$(openssl rand -hex 32)"
done
set_value DOMAIN "$domain"
set_value WEB_ORIGIN "https://$domain"
set_value VITE_SITE_URL "https://$domain"
write_sizing

cat <<DONE

Wrote $ENV_FILE with new secrets, readable by root only.
Now open it and fill in three things:
  PLATFORM_ADMIN_PHONE     your phone, exactly like +998901234567
  PLATFORM_ADMIN_PASSWORD  at least 12 characters, inside the single quotes
  BACKUP_OFFSITE           where backups go off this server: see docs/deployment.md
Then run: infra/deploy.sh
DONE
