#!/usr/bin/env bash
# Restore a backup made by infra/backup.sh.
#
#   infra/restore.sh db <file>        restore the database
#   infra/restore.sh files <folder>   restore uploaded files: the newest full archive and all that follow
#   infra/restore.sh files <file>     restore the files of one archive
#   infra/restore.sh config <file>    put .env.production back, on a new server
#   infra/restore.sh verify <folder>  check the checksums of the newest set of files, and change nothing
#
# RESTORE_DB=yap_drill restores into a separate database and touches nothing live. Use it to
# check a backup: an untested backup is only a hope. RESTORE_DROP=yes then removes it again, which is
# what infra/backup-cron.sh check does. Restoring over the live database `yap` needs
# RESTORE_CONFIRM=yes. The backup is first restored beside the live database, and only a complete
# restore replaces it, so a damaged backup cannot harm what is running. The old database is kept
# under another name until you drop it. See docs/deployment.md.
#
# Settings, from the environment or .env.production: BACKUP_PASSPHRASE_FILE, default /etc/yap/backup.key,
# and BACKUP_RESERVE_MB, default 1024. And ENV_FILE, COMPOSE_PROJECT, COMPOSE_FILE (see lib.sh).
set -euo pipefail

# shellcheck source=infra/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$YAP_ROOT"

what="${1:-}"
file="${2:-}"
passphrase_file="$(setting BACKUP_PASSPHRASE_FILE /etc/yap/backup.key)"
database="${RESTORE_DB:-yap}"

if [[ ( "$what" != "db" && "$what" != "files" && "$what" != "config" && "$what" != "verify" ) || ! -r "$file" ]]; then
  echo "usage: infra/restore.sh db|files|config <backup file>, or files|verify <backup folder>" >&2
  exit 2
fi
if [[ ! -r "$passphrase_file" ]]; then
  echo "BACKUP_PASSPHRASE_FILE must name a readable file" >&2
  exit 2
fi
if [[ ! "$database" =~ ^[a-z_][a-z0-9_]*$ ]]; then
  echo "RESTORE_DB may hold small letters, digits and underscores only" >&2
  exit 2
fi
decrypt() { openssl enc -d -aes-256-cbc -pbkdf2 -pass "file:$passphrase_file" -in "$1"; }
psql_admin() { compose exec -T db psql -U yap -d postgres -v ON_ERROR_STOP=1 -q "$@"; }

# A copy damaged on its way here is named now, not halfway through a restore.
check_sum() {
  [[ -r "$1.sha256" ]] || return 0
  if [[ "$(sha256_of "$1")" != "$(cut -d' ' -f1 "$1.sha256")" ]]; then
    echo "$1 is damaged: it does not match its checksum." >&2
    return 1
  fi
}

# The newest set of files in a folder, oldest archive first: a full archive and every later one.
newest_set() {
  ls -1 "$1" | grep -E '^yap-files-[0-9]{8}T[0-9]{6}Z-(full|changes)\.tar\.gz\.enc$' | LC_ALL=C sort |
    awk -v folder="${1%/}" '
      /-full\./ { count = 0; found = 1 }
      { set[++count] = $0 }
      END { for (i = 1; found && i <= count; i++) print folder "/" set[i] }'
}

if [[ -d "$file" ]]; then
  if [[ "$what" == "db" || "$what" == "config" ]]; then
    echo "infra/restore.sh $what needs one backup file, not a folder." >&2
    exit 2
  fi
  archives="$(newest_set "$file")"
  if [[ -z "$archives" ]]; then
    echo "There is no full archive of the files in $file." >&2
    exit 1
  fi
else
  if [[ "$what" == "verify" ]]; then
    echo "infra/restore.sh verify needs a folder." >&2
    exit 2
  fi
  archives="$file"
fi

if [[ "$what" == "verify" ]]; then
  checked=0
  damaged=0
  while IFS= read -r archive; do
    checked=$((checked + 1))
    check_sum "$archive" || damaged=$((damaged + 1))
  done <<< "$archives"
  echo "Checked $checked archive(s) of the newest set of files: $damaged damaged."
  ((damaged == 0))
  exit
fi

if [[ "$what" == "db" || "$what" == "config" ]]; then
  check_sum "$file"
fi

if [[ "$what" == "config" ]]; then
  if [[ -e "$ENV_FILE" && "${RESTORE_CONFIRM:-}" != "yes" ]]; then
    echo "$ENV_FILE already exists. Set RESTORE_CONFIRM=yes to replace it." >&2
    exit 2
  fi
  (umask 077 && decrypt "$file" > "$ENV_FILE.tmp")
  mv "$ENV_FILE.tmp" "$ENV_FILE"
  echo "Settings restored to $ENV_FILE."
  exit 0
fi

if [[ "$what" == "files" ]]; then
  # Each archive holds its own files, so a bad one does not stop the rest from coming back.
  restored=0
  failed=""
  while IFS= read -r archive <&3; do
    if check_sum "$archive" && decrypt "$archive" | in_files_volume tar -C /data/storage -xzf -; then
      restored=$((restored + 1))
    else
      failed="$failed $archive"
    fi
  done 3<<< "$archives"
  echo "Files restored from $restored archive(s)."
  if [[ -n "$failed" ]]; then
    echo "These could not be read, so the files inside them are missing:$failed" >&2
    exit 1
  fi
  exit 0
fi

if [[ "$database" == "yap" && "${RESTORE_CONFIRM:-}" != "yes" ]]; then
  echo "This replaces the live database. Set RESTORE_CONFIRM=yes to go ahead." >&2
  exit 2
fi

if ! is_running db; then
  echo "Starting the database."
  compose up -d db
fi
for _ in $(seq 1 60); do
  compose exec -T db pg_isready -U yap -d postgres -q && break
  sleep 2
done

stamp="$(date -u +%Y%m%dT%H%M%S)"
staging="$database"
if [[ "$database" == "yap" ]]; then
  staging="yap_restore_$stamp"
fi

drop_staging() { psql_admin -c "DROP DATABASE IF EXISTS \"$staging\" WITH (FORCE)" || true; }

# A restore sits beside the live database on the same disk, and running that disk out of room would stop
# the live database as well.
reserve_mb="$(setting BACKUP_RESERVE_MB 1024)"
db_free_mb="$(compose exec -T db df -Pk /var/lib/postgresql/data | awk 'NR == 2 { print int($4 / 1024) }')"
db_size_mb="$(compose exec -T db psql -U yap -d postgres -tAc "select (coalesce(sum(pg_database_size(datname)), 0) / 1048576)::bigint from pg_database where datname = 'yap'")"
if ((db_free_mb < db_size_mb + reserve_mb)); then
  echo "Only $db_free_mb MB is free for the database. A restore needs about $db_size_mb MB, and $reserve_mb MB must stay free." >&2
  exit 1
fi

psql_admin -c "DROP DATABASE IF EXISTS \"$staging\" WITH (FORCE)"
psql_admin -c "CREATE DATABASE \"$staging\""
trap drop_staging EXIT
echo "Restoring into $staging. Nothing live is touched yet."
if ! decrypt "$file" | compose exec -T db pg_restore -U yap -d "$staging" --no-owner --exit-on-error; then
  echo "The restore failed: the backup is damaged, or the key is wrong. The live database was not touched." >&2
  exit 1
fi

if ! counts="$(compose exec -T db psql -U yap -d "$staging" -tA -F ' ' -c "select (select count(*) from pg_tables where schemaname = 'public'), (select count(*) from tenants), (select count(*) from users)")"; then
  echo "The restore finished, but the result is not this app's database. The live database was not touched." >&2
  exit 1
fi
read -r tables tenants users <<< "$counts"
echo "The backup holds $tables tables, $tenants tenant(s), $users user(s)."
if ((users == 0)); then
  echo "A real database always has a user, so this backup is not usable. The live database was not touched." >&2
  exit 1
fi

if [[ "$database" != "yap" ]]; then
  if [[ "${RESTORE_DROP:-}" == "yes" ]]; then
    echo "Database restored into $database, and removed again."
    exit 0
  fi
  trap - EXIT
  echo "Database restored into $database. Remove it when you are done:"
  echo "  docker compose -p $PROJECT -f docker-compose.prod.yml --env-file $ENV_FILE exec -T db psql -U yap -d postgres -c 'DROP DATABASE \"$database\"'"
  exit 0
fi

stopped=""
for service in web api; do
  if is_running "$service"; then
    stopped="$stopped $service"
  fi
done
restart_stopped() {
  if [[ -n "$stopped" ]]; then
    # shellcheck disable=SC2086
    compose up -d $stopped
  fi
}
trap restart_stopped EXIT
if [[ -n "$stopped" ]]; then
  # shellcheck disable=SC2086
  compose stop $stopped
fi

previous="yap_before_restore_$stamp"
psql_admin -o /dev/null <<SQL
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'yap' AND pid <> pg_backend_pid();
BEGIN;
ALTER DATABASE yap RENAME TO "$previous";
ALTER DATABASE "$staging" RENAME TO yap;
COMMIT;
SQL
echo "Database restored into yap. The old one is kept as $previous. When all is well, remove it:"
echo "  docker compose -p $PROJECT -f docker-compose.prod.yml --env-file $ENV_FILE exec -T db psql -U yap -d postgres -c 'DROP DATABASE \"$previous\"'"
