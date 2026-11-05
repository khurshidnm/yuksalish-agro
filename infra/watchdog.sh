#!/usr/bin/env bash
# Docker restarts an API that has died, but not one that is alive and no longer answers. Cron runs this
# every minute (/etc/cron.d/yap-watchdog, from server-setup.sh). It asks the API itself for /api/health,
# so trouble in nginx or Caddy does not count against the API.
#
# Three failed checks in a row restart the api service. After three restarts that did not last it stops,
# says so once, and leaves the API to a person: what three restarts did not cure, a fourth will not. A
# restart has lasted when the API answers an hour or more after it, and the count then starts again.
#
# An API that is not running is left alone. Docker looks after a crash, and anything else was stopped
# on purpose, as infra/restore.sh does. A deploy replaces the API on purpose too, so nothing counts then.
#
# It remembers in $STATE_DIR/watchdog, which infra/status.sh reads, and logs to /var/log/yap/watchdog.log.
# Restarts go to the Telegram chat in BACKUP_ALERT_CHAT_ID, if set.
set -uo pipefail

# shellcheck source=infra/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$YAP_ROOT" || exit 1

failures_allowed=3
restarts_allowed=3
lasting_seconds=3600

log() { printf '%s %s\n' "$(date '+%FT%T%z')" "$1"; }

# Before the first deploy there is nothing to watch, and that is not worth a line every minute.
if [[ ! -r "$ENV_FILE" ]] || ! docker volume inspect "${PROJECT}_db" > /dev/null 2>&1; then
  exit 0
fi

mkdir -p "$STATE_DIR"

# A restart can outlast the minute, and a Docker that hangs must not pile up a run every minute.
exec 8> "$STATE_DIR/watchdog.lock"
flock -n 8 || exit 0

state_file="$STATE_DIR/watchdog"
failures=0
restarts=0
restarted_at=0
gave_up=0
if [[ -r "$state_file" ]]; then
  read -r failures restarts restarted_at gave_up < "$state_file"
fi

remember() {
  printf '%s %s %s %s\n' "$failures" "$restarts" "$restarted_at" "$gave_up" > "$state_file.tmp"
  mv "$state_file.tmp" "$state_file"
}

compose_command
id="$(timeout 30 "${COMPOSE_CMD[@]}" ps -q api 2> /dev/null | head -n 1)"
address=""
if [[ -n "$id" ]]; then
  address="$(timeout 30 docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$id" 2> /dev/null)"
fi
if [[ -z "$address" ]]; then
  failures=0
  remember
  exit 0
fi

if curl -fsS --max-time 10 -o /dev/null "http://$address:4000/api/health" 2> /dev/null; then
  if ((failures > 0 || gave_up > 0)); then
    log "the API answers again"
  fi
  failures=0
  gave_up=0
  if ((restarts > 0 && $(date +%s) - restarted_at >= lasting_seconds)); then
    restarts=0
  fi
  remember
  exit 0
fi

# Held only from here on, so that a healthy check can never make a deploy think something is running.
exec 9> "$STATE_DIR/deploy.lock"
if ! flock -n -s 9; then
  failures=0
  remember
  exit 0
fi

# It has said so, and every minute would fill the log.
if ((gave_up > 0)); then
  exit 0
fi

failures=$((failures + 1))
log "the API did not answer /api/health: $failures in a row"
if ((failures < failures_allowed)); then
  remember
  exit 0
fi

if ((restarts >= restarts_allowed)); then
  gave_up=1
  remember
  log "the API still does not answer after $restarts restarts, so the watchdog has stopped restarting it. It needs a person."
  telegram_send "YAP on $(hostname): the API is not answering, and $restarts restarts did not cure it, so the watchdog has stopped trying. Someone needs to look: infra/status.sh"
  exit 0
fi

# Remembered first, so that a run killed halfway cannot make this a loop without a limit.
failures=0
restarts=$((restarts + 1))
restarted_at="$(date +%s)"
remember
log "restarting the api service, restart $restarts of $restarts_allowed"
if timeout 120 "${COMPOSE_CMD[@]}" restart api; then
  log "the api service has restarted"
  telegram_send "YAP on $(hostname): the API stopped answering, so the watchdog restarted it (restart $restarts of $restarts_allowed). See /var/log/yap/watchdog.log"
else
  log "the restart failed"
  telegram_send "YAP on $(hostname): the API stopped answering, and the watchdog could not restart it. Someone needs to look: infra/status.sh"
fi
