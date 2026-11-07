#!/usr/bin/env bash
# What cron runs (/etc/cron.d/yap-backup, from server-setup.sh): take a backup, copy everything new off
# this server, and speak up if something failed. A backup that stops quietly is found out on the
# worst day, so every failure is logged and sent to Telegram if BACKUP_ALERT_CHAT_ID is set.
#
#   infra/backup-cron.sh db       the database and the settings file
#   infra/backup-cron.sh files    uploaded files
#   infra/backup-cron.sh check    prove the backups work: restore the newest dump into a throwaway
#                                 database, then remove it, and check the newest set of files
#
# Running it by hand is the way to test the whole chain.
#
# A passing check pings BACKUP_HEARTBEAT_URL, if set. That needs an address of its own: the API pings
# HEARTBEAT_URL every minute, which would hide this one. No ping for a day then means that the backups,
# cron or the whole server have died, and none of those can say so for themselves.
set -uo pipefail

# shellcheck source=infra/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$YAP_ROOT" || exit 1

what="${1:-}"
if [[ "$what" != "db" && "$what" != "files" && "$what" != "check" ]]; then
  echo "usage: infra/backup-cron.sh db|files|check" >&2
  exit 2
fi

# Before the first deploy there is nothing to back up, and that is not a failure.
if [[ ! -r "$ENV_FILE" ]] || ! docker volume inspect "${PROJECT}_db" > /dev/null 2>&1; then
  echo "$(date -Is) nothing deployed yet, skipping"
  exit 0
fi

mkdir -p "$STATE_DIR"
status_file="$STATE_DIR/backup-status"

# Remembers KEY=time for infra/status.sh.
remember() {
  local key="$1" tmp
  tmp="$(mktemp "$status_file.XXXXXX")" || return 0
  grep -v "^$key=" "$status_file" > "$tmp" 2> /dev/null || true
  printf '%s=%s\n' "$key" "$(date -Is)" >> "$tmp"
  mv "$tmp" "$status_file"
}

# The address may hold a secret, so it goes through a config on stdin, like the bot token.
ping_watcher() {
  local url
  url="$(setting BACKUP_HEARTBEAT_URL)"
  [[ -n "$url" ]] || return 0
  printf 'url = "%s"\n' "$url" | curl -fsS --max-time 20 -K - -o /dev/null ||
    echo "$(date -Is) could not reach BACKUP_HEARTBEAT_URL" >&2
}

alert() {
  echo "$(date -Is) FAILED: $1" >&2
  telegram_send "YAP backup on $(hostname): $1"
}

failed=0
backup_dir="$(setting BACKUP_DIR /var/backups/yap)"

# Waits for a running deploy, when containers may be restarting. A deploy takes its own backup first,
# and refuses to start while one of these runs, so the two never meet. Backups may run side by side.
exec 9> "$STATE_DIR/deploy.lock"
if ! flock -s -w 3600 9; then
  alert "a deploy has held things up for an hour, so this backup was skipped. Check: infra/status.sh"
  exit 1
fi

# A first full archive of the files can outlast the six hours until the next run.
exec 8> "$STATE_DIR/backup-$what.lock"
if ! flock -n 8; then
  echo "$(date -Is) the previous $what run is still going, so this one is skipped"
  exit 0
fi

# Once more after a minute, so that a restart or a busy moment does not cost six hours.
try_backup() {
  infra/backup.sh "$1" && return 0
  echo "$(date -Is) the $1 backup failed, and it gets one more try" >&2
  sleep "${BACKUP_RETRY_SECONDS:-60}"
  infra/backup.sh "$1"
}

run_backup() {
  if try_backup "$what"; then
    remember "last_$what"
  else
    alert "the $what backup failed. See /var/log/yap/backup.log"
    failed=1
  fi
  if [[ "$what" == "db" ]]; then
    infra/backup.sh config || {
      alert "the copy of the settings file failed. See /var/log/yap/backup.log"
      failed=1
    }
  fi
}

copy_offsite() {
  local offsite
  offsite="$(setting BACKUP_OFFSITE)"
  # So the backup machine can install the rules once. It must never run the copy that keeps arriving here:
  # whoever breaks into this server could replace it (docs/deployment.md, step 6).
  cp infra/backup-prune.sh "$backup_dir/yap-backup-prune.sh"
  case "$offsite" in
    "")
      alert "BACKUP_OFFSITE is not set, so backups stay on this disk only"
      failed=1
      ;;
    pull)
      echo "$(date -Is) BACKUP_OFFSITE=pull: another machine fetches these"
      ;;
    *)
      if offsite_push --exclude='*.tmp' --include='yap-*' --exclude='*' "$backup_dir/" "${offsite%/}/"; then
        remember last_offsite
        echo "$(date -Is) copied to $offsite"
        # Nothing else looks after a mounted disk.
        if [[ "$offsite" == /* ]]; then
          infra/backup-prune.sh "$offsite" || alert "old backups on $offsite could not be pruned"
        fi
      else
        alert "copying backups to $offsite failed, so the newest ones exist on this server only"
        failed=1
      fi
      ;;
  esac
}

# Only a restore shows that a backup works. Anything less finds a dead one on the day it is needed.
run_check() {
  local newest hours
  # shellcheck disable=SC2012 # the names are ours, and hold the time
  newest="$(ls -1 "$backup_dir"/yap-db-*.dump.enc 2> /dev/null | LC_ALL=C sort | tail -n 1)"
  if [[ -z "$newest" ]]; then
    alert "there is no database backup in $backup_dir"
    failed=1
    return
  fi
  hours=$((($(date +%s) - $(stat -c %Y "$newest")) / 3600))
  if ((hours > 7)); then
    alert "the newest database backup is $hours hours old, so backups have stopped. See /var/log/yap/backup.log"
    failed=1
  fi
  if RESTORE_DB=yap_backup_check RESTORE_DROP=yes infra/restore.sh db "$newest"; then
    touch "$newest.proven"
  else
    alert "$(basename "$newest") could not be restored, so the backups may be useless. See /var/log/yap/backup.log and run: infra/backup-cron.sh check"
    failed=1
  fi
  if [[ "$(setting STORAGE_DRIVER local)" == "local" ]] && ! infra/restore.sh verify "$backup_dir"; then
    alert "the files backup in $backup_dir is missing or damaged. See /var/log/yap/backup.log"
    failed=1
  fi
  if ((failed == 0)); then
    remember last_check
    ping_watcher
    echo "$(date -Is) backup check passed: $(basename "$newest") restored, and the newest set of files is whole"
  fi
}

if [[ "$what" == "check" ]]; then
  run_check
else
  run_backup
  copy_offsite
fi

used="$(df -P "$backup_dir" | awk 'NR == 2 { gsub("%", "", $5); print $5 }')"
if ((used >= 90)); then
  alert "the disk holding $backup_dir is $used% full"
fi

exit "$failed"
