#!/usr/bin/env bash
# Encrypted backups, spec 20.3: database every 6 hours, files daily, kept 90 days.
#
#   infra/backup.sh db      dump the database
#   infra/backup.sh files   archive uploaded files (STORAGE_DRIVER=local only)
#
# Cron, as a user allowed to run docker:
#   0 */6 * * *  cd /opt/yap && BACKUP_PASSPHRASE_FILE=/etc/yap/backup.key infra/backup.sh db
#   30 2 * * *   cd /opt/yap && BACKUP_PASSPHRASE_FILE=/etc/yap/backup.key infra/backup.sh files
#
# Environment:
#   BACKUP_PASSPHRASE_FILE  required. Losing this file makes every backup unreadable.
#   BACKUP_DIR              default /var/backups/yap. Copy it off this server: see docs/deployment.md.
#   RETENTION_DAYS          default 90
#   COMPOSE_FILE, ENV_FILE, COMPOSE_PROJECT   default docker-compose.prod.yml, .env.production, yap-prod
set -euo pipefail

what="${1:-}"
backup_dir="${BACKUP_DIR:-/var/backups/yap}"
retention_days="${RETENTION_DAYS:-90}"
passphrase_file="${BACKUP_PASSPHRASE_FILE:-}"
compose=(docker compose -p "${COMPOSE_PROJECT:-yap-prod}" -f "${COMPOSE_FILE:-docker-compose.prod.yml}" --env-file "${ENV_FILE:-.env.production}")

if [[ "$what" != "db" && "$what" != "files" ]]; then
  echo "usage: infra/backup.sh db|files" >&2
  exit 2
fi
if [[ -z "$passphrase_file" || ! -r "$passphrase_file" ]]; then
  echo "BACKUP_PASSPHRASE_FILE must name a readable file: backups are always encrypted (spec 20.1)" >&2
  exit 2
fi

mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
encrypt() { openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$passphrase_file"; }

if [[ "$what" == "db" ]]; then
  target="$backup_dir/yap-db-$stamp.dump.enc"
  "${compose[@]}" exec -T db pg_dump -U yap -d yap -Fc | encrypt > "$target.tmp"
else
  target="$backup_dir/yap-files-$stamp.tar.gz.enc"
  "${compose[@]}" exec -T api tar -C /data/storage -czf - . | encrypt > "$target.tmp"
fi

# Only a finished dump gets its final name, so a failed run can never look like a good backup.
mv "$target.tmp" "$target"
find "$backup_dir" -maxdepth 1 -name 'yap-*' -type f -mtime "+$retention_days" -delete
echo "$target ($(wc -c < "$target" | tr -d ' ') bytes)"
