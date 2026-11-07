#!/usr/bin/env bash
# Encrypted backups, spec 20.3.
#
#   infra/backup.sh db       dump the database
#   infra/backup.sh files    save the uploaded files no backup holds yet (STORAGE_DRIVER=local only)
#   infra/backup.sh config   keep .env.production: JWT_SECRET is needed to read 2FA secrets after a restore
#
# server-setup.sh schedules these through infra/backup-cron.sh, which also copies them off this server.
#
# Photos neither shrink nor change, so a nightly archive of all of them would fill the disk with copies. A
# full archive starts a set, every 90 days, and each later run adds a small archive of what is new since.
# The archives of a set do not depend on each other: a damaged one loses only the files inside it.
# files-manifest-<stamp> lists what a set holds. Losing it costs nothing but a new full archive.
#
# Every backup is read back in full before it gets its final name, and its checksum is stored beside it,
# so a file with a final name is a good backup and the backup machine can tell if its copy is damaged.
#
# Settings, from the environment or from .env.production:
#   BACKUP_PASSPHRASE_FILE  default /etc/yap/backup.key. Losing this file makes every backup unreadable.
#   BACKUP_DIR              default /var/backups/yap
#   BACKUP_RESERVE_MB       default 1024. Left free on the disk, which Postgres shares with the backups.
#   FILES_FULL_EVERY_DAYS   default 90
#   RETENTION_*             see infra/backup-prune.sh
# And from the environment: ENV_FILE, COMPOSE_PROJECT, COMPOSE_FILE (see lib.sh).
set -euo pipefail

# shellcheck source=infra/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$YAP_ROOT"

what="${1:-}"
backup_dir="$(setting BACKUP_DIR /var/backups/yap)"
passphrase_file="$(setting BACKUP_PASSPHRASE_FILE /etc/yap/backup.key)"
reserve_mb="$(setting BACKUP_RESERVE_MB 1024)"
full_every_days="$(setting FILES_FULL_EVERY_DAYS 90)"

if [[ "$what" != "db" && "$what" != "files" && "$what" != "config" ]]; then
  echo "usage: infra/backup.sh db|files|config" >&2
  exit 2
fi

umask 077
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"

# Before anything that can fail, so a failing run still clears what has expired. That is also what lets
# the next run fit on a full disk. stdout stays for the last line, which deploy.sh reads.
infra/backup-prune.sh "$backup_dir" "$what" >&2 || echo "WARNING: old backups could not be pruned." >&2

if [[ ! -r "$passphrase_file" ]]; then
  echo "BACKUP_PASSPHRASE_FILE must name a readable file: backups are always encrypted (spec 20.1)" >&2
  exit 2
fi
if [[ "$what" == "files" && "$(setting STORAGE_DRIVER local)" != "local" ]]; then
  echo "STORAGE_DRIVER is not local, so there are no files here to back up."
  exit 0
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
trap 'rm -f "$backup_dir/yap-$what-$stamp"*.tmp' EXIT

encrypt() { openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$passphrase_file"; }
decrypt() { openssl enc -d -aes-256-cbc -pbkdf2 -pass "file:$passphrase_file" -in "$1"; }

free_mb() { df -Pk "$backup_dir" | awk 'NR == 2 { print int($4 / 1024) }'; }

# The newest backup whose name matches, without its folder. The name holds the time.
newest() {
  ls -1 "$backup_dir" | grep -E "$1" | LC_ALL=C sort | tail -n 1 || true
}

# Backups share a disk with Postgres, and a full disk stops the whole farm, so a backup that would leave
# too little room is not started. Old backups go first if that makes it fit.
make_room() {
  local need=$(($1 + reserve_mb))
  ((need > $(free_mb))) || return 0
  NEED_MB="$need" infra/backup-prune.sh "$backup_dir" "$what" >&2 || true
  if ((need > $(free_mb))); then
    echo "Only $(free_mb) MB is free in $backup_dir. This backup needs about $1 MB, and $reserve_mb MB must stay free for the database." >&2
    exit 1
  fi
}

backup_db() {
  local previous
  target="$backup_dir/yap-db-$stamp.dump.enc"
  previous="$(newest '^yap-db-.*\.dump\.enc$')"
  if [[ -n "$previous" ]]; then
    make_room $(($(wc -c < "$backup_dir/$previous") * 12 / 10 / 1048576 + 1))
  else
    make_room 0
  fi
  compose exec -T db pg_dump -U yap -d yap -Fc | encrypt > "$target.tmp"
  # Reads every block back. pg_restore --list would not do: the table of contents is at the start of the
  # file, so it passes a dump that has lost its end.
  decrypt "$target.tmp" | compose exec -T db pg_restore -f /dev/null
}

backup_config() {
  target="$backup_dir/yap-config-$stamp.env.enc"
  encrypt < "$ENV_FILE" > "$target.tmp"
  decrypt "$target.tmp" | cmp -s - "$ENV_FILE"
}

size_mb() {
  awk -F'\t' '{ bytes += $2 } END { printf "%d", bytes / 1048576 + 1 }' "$1"
}

manifest=""

backup_files() {
  local work="$backup_dir/yap-files-$stamp" kind=changes newest_full statuses
  local listing="$work.listing.tmp" todo="$work.todo.tmp" archived="$work.archived.tmp" saved="$work.saved.tmp"

  # The list comes first, and only what is on it is archived. Whatever is uploaded after this moment
  # belongs to the next run, so it cannot disturb this one. Times stop at the second, as they do in a tar
  # archive, or every file brought back by a restore would look changed.
  in_files_volume find /data/storage -ignore_readdir_race -type f -printf '%P\t%s\t%T@\n' |
    sed 's/\.[0-9]*$//' | LC_ALL=C sort > "$listing"

  newest_full="$(newest '^yap-files-.*-full\.tar\.gz\.enc$')"
  if [[ -n "$newest_full" ]]; then
    manifest="${newest_full#yap-files-}"
    manifest="$backup_dir/files-manifest-${manifest%%-*}"
  fi
  if [[ -z "$newest_full" || ! -r "$manifest" ]]; then
    kind=full
  elif [[ -n "$(find "$backup_dir/$newest_full" -mtime +"$full_every_days")" ]]; then
    if (($(size_mb "$listing") + reserve_mb < $(free_mb))); then
      kind=full
    else
      echo "WARNING: a new full archive of the files is due, but the disk has no room for it. The changes keep being saved." >&2
    fi
  fi

  if [[ "$kind" == "full" ]]; then
    cp "$listing" "$todo"
  else
    LC_ALL=C comm -13 "$manifest" "$listing" > "$todo"
  fi
  make_room "$(size_mb "$todo")"

  target="$backup_dir/yap-files-$stamp-$kind.tar.gz.enc"
  # A file that changes while it is read, such as an upload still arriving, is no failure: its size and
  # time no longer match the list, so the next run saves it again. Nor is one that has gone by then. Tar
  # reports those as 0 or 1. Only 2 is a real failure.
  set +e
  cut -f1 "$todo" |
    in_files_volume tar -C /data/storage --ignore-failed-read --warning=no-file-changed --warning=no-file-removed -czf - -T - |
    encrypt > "$target.tmp"
  statuses=("${PIPESTATUS[@]}")
  set -e
  if ((statuses[1] > 1 || statuses[2] != 0)); then
    echo "The archive of the files failed: tar ${statuses[1]}, openssl ${statuses[2]}." >&2
    exit 1
  fi

  # Counts what really went in, so a file tar could not read stays on the list for the next run.
  decrypt "$target.tmp" | tar -tzf - > "$archived"
  awk -F'\t' 'NR == FNR { archived[$0] = 1; next } $1 in archived' "$archived" "$todo" > "$saved"
  if (($(wc -l < "$todo") != $(wc -l < "$saved"))); then
    echo "WARNING: $(($(wc -l < "$todo") - $(wc -l < "$saved"))) file(s) could not be read. The next run tries them again." >&2
  fi

  if [[ "$kind" == "full" ]]; then
    LC_ALL=C sort "$saved" > "$work.manifest.tmp"
    manifest="$backup_dir/files-manifest-$stamp"
  else
    LC_ALL=C sort -u "$manifest" "$saved" > "$work.manifest.tmp"
  fi
  echo "$kind archive: $(wc -l < "$saved" | tr -d ' ') file(s)" >&2
}

"backup_$what"

# Only a finished, verified backup gets its final name, so a failed run can never look like a good one.
# The checksum follows it: a prune running beside this one removes any checksum without a backup.
checksum="$(sha256_of "$target.tmp")"
mv "$target.tmp" "$target"
printf '%s  %s\n' "$checksum" "$(basename "$target")" > "$target.sha256"
if [[ "$what" == "files" ]]; then
  mv "$backup_dir/yap-files-$stamp.manifest.tmp" "$manifest"
fi
echo "$target ($(wc -c < "$target" | tr -d ' ') bytes)"
