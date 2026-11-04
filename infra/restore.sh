#!/usr/bin/env bash
# Restore a backup made by infra/backup.sh.
#
#   infra/restore.sh db <file>      restore the database
#   infra/restore.sh files <file>   restore uploaded files
#
# RESTORE_DB=yap_drill restores into a separate database and touches nothing live. Use it to
# check a backup: an untested backup is only a hope. Restoring over the live database `yap`
# needs RESTORE_CONFIRM=yes and stops the API first. See docs/deployment.md.
#
# Environment: BACKUP_PASSPHRASE_FILE (required), COMPOSE_FILE, ENV_FILE, COMPOSE_PROJECT.
set -euo pipefail

what="${1:-}"
file="${2:-}"
passphrase_file="${BACKUP_PASSPHRASE_FILE:-}"
database="${RESTORE_DB:-yap}"
compose=(docker compose -p "${COMPOSE_PROJECT:-yap-prod}" -f "${COMPOSE_FILE:-docker-compose.prod.yml}" --env-file "${ENV_FILE:-.env.production}")

if [[ ( "$what" != "db" && "$what" != "files" ) || ! -r "$file" ]]; then
  echo "usage: infra/restore.sh db|files <backup file>" >&2
  exit 2
fi
if [[ -z "$passphrase_file" || ! -r "$passphrase_file" ]]; then
  echo "BACKUP_PASSPHRASE_FILE must name a readable file" >&2
  exit 2
fi
decrypt() { openssl enc -d -aes-256-cbc -pbkdf2 -pass "file:$passphrase_file" -in "$file"; }

if [[ "$what" == "files" ]]; then
  decrypt | "${compose[@]}" exec -T api tar -C /data/storage -xzf -
  echo "Files restored."
  exit 0
fi

if [[ "$database" == "yap" ]]; then
  if [[ "${RESTORE_CONFIRM:-}" != "yes" ]]; then
    echo "This replaces the live database. Set RESTORE_CONFIRM=yes to go ahead." >&2
    exit 2
  fi
  "${compose[@]}" stop api web
else
  "${compose[@]}" exec -T db psql -U yap -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$database\""
fi

decrypt | "${compose[@]}" exec -T db pg_restore -U yap -d "$database" --clean --if-exists --no-owner --exit-on-error
echo "Database restored into $database."

if [[ "$database" == "yap" ]]; then
  "${compose[@]}" up -d api web
fi
