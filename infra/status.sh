#!/usr/bin/env bash
# One look at the whole stack. It only reads, so it is safe to run at any time:
#
#   infra/status.sh
#
# Exit code 0 means nothing needs attention.
set -uo pipefail

# shellcheck source=infra/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$YAP_ROOT" || exit 1

problems=0
good() { printf '  ok    %s\n' "$1"; }
bad() {
  printf '  LOOK  %s\n' "$1"
  problems=$((problems + 1))
}

# Hours since a file was last changed, or nothing if there is no such file.
age_hours() {
  [[ -n "${1:-}" && -e "$1" ]] || return 0
  echo $((($(date +%s) - $(stat -c %Y "$1")) / 3600))
}

origin="$(setting WEB_ORIGIN)"
domain="$(setting DOMAIN)"
backup_dir="$(setting BACKUP_DIR /var/backups/yap)"
offsite="$(setting BACKUP_OFFSITE)"
telegram_token="$(setting TELEGRAM_BOT_TOKEN)"

echo "Containers"
services="db redis api web"
tls_enabled && services="$services caddy"
for service in $services; do
  id="$(compose ps -q "$service" 2> /dev/null | head -n 1)"
  state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2> /dev/null)"
  state="${state:-not running}"
  if [[ "$state" == "healthy" ]]; then
    good "$service"
  else
    bad "$service is $state. See its log: docker compose -p $PROJECT -f docker-compose.prod.yml --env-file $ENV_FILE logs --tail 50 $service"
  fi
done

echo
echo "The site"
if [[ -n "$origin" ]]; then
  if status="$(curl -sS --connect-timeout 5 --max-time 15 -o /dev/null -w '%{http_code}' "$origin/api/health" 2>&1)" && [[ "$status" == "200" ]]; then
    good "$origin answers"
  else
    bad "$origin/api/health gave: $(head -n 1 <<< "$status"). From inside the server this may be the provider's routing, so try your phone too."
  fi
fi
# From inside the API container, because only the server itself gets told what is failing. Not from the
# terminal: under `timeout` a program that reads it is stopped, and this would wait for nothing.
compose_command
deep="$(timeout 20 "${COMPOSE_CMD[@]}" exec -T api node -e "fetch('http://127.0.0.1:4000/api/health/deep', { signal: AbortSignal.timeout(10000) }).then((r) => r.json()).then((r) => console.log(r.failing.join(', ') || 'ok'))" < /dev/null 2> /dev/null | tail -n 1)"
if [[ "$deep" == "ok" && -n "$telegram_token" ]]; then
  good "Deep health check: database, Redis, background worker, urgent alerts, Telegram and disk"
elif [[ "$deep" == "ok" ]]; then
  good "Deep health check: database, Redis, background worker and disk"
elif [[ -n "$deep" ]]; then
  bad "The deep health check is failing: $deep. Its log: docker compose -p $PROJECT -f docker-compose.prod.yml --env-file $ENV_FILE logs --tail 50 api"
else
  bad "The API gave no answer to the deep health check."
fi
if tls_enabled && [[ -n "$domain" ]]; then
  port="$(setting TLS_HTTPS_PORT 443)"
  expires="$(echo | timeout 10 openssl s_client -connect "127.0.0.1:$port" -servername "$domain" 2> /dev/null | openssl x509 -noout -enddate 2> /dev/null | cut -d= -f2)"
  if [[ -z "$expires" ]]; then
    bad "No certificate is being served for $domain. See the log of the caddy service."
  else
    days=$((($(date -d "$expires" +%s) - $(date +%s)) / 86400))
    if [[ "$(setting CADDY_GLOBAL)" == *local_certs* ]]; then
      good "Local test certificate. Browsers do not trust it."
    elif ((days < 14)); then
      bad "The certificate expires in $days days, and it should have renewed by itself at 30."
    else
      good "Certificate valid for $days more days"
    fi
  fi
fi
if [[ -r "$STATE_DIR/last-deploy" ]]; then
  good "Last deploy: $(tr '\n' ' ' < "$STATE_DIR/last-deploy")"
fi

echo
echo "Automatic deploys"
if ! auto_deploy="$("$YAP_ROOT/infra/auto-deploy.sh" status 2>&1)"; then
  looks="$(grep -c '^  LOOK  ' <<< "$auto_deploy")"
  problems=$((problems + (looks > 0 ? looks : 1)))
fi
echo "$auto_deploy"

echo
echo "Backups"
check_backup() {
  local label="$1" pattern="$2" limit_hours="$3" newest age
  # shellcheck disable=SC2012,SC2086 # the pattern is meant to expand
  newest="$(ls -1t "$backup_dir"/$pattern 2> /dev/null | head -n 1)"
  age="$(age_hours "$newest")"
  if [[ -z "$newest" ]]; then
    bad "No $label backup in $backup_dir yet"
  elif ((age > limit_hours)); then
    bad "The newest $label backup is $age hours old. See /var/log/yap/backup.log"
  else
    good "Newest $label backup: $age hours old, $(du -h "$newest" | cut -f1)"
  fi
}
check_backup database 'yap-db-*.enc' 7
if [[ "$(setting STORAGE_DRIVER local)" == "local" ]]; then
  check_backup files 'yap-files-*.enc' 7
fi
last_check="$(grep '^last_check=' "$STATE_DIR/backup-status" 2> /dev/null | cut -d= -f2-)"
if [[ -z "$last_check" ]]; then
  bad "No backup has been restored for real yet. It runs every night at 03:15. To run it now: infra/backup-cron.sh check"
else
  hours=$((($(date +%s) - $(date -d "$last_check" +%s)) / 3600))
  if ((hours > 26)); then
    bad "The last real restore check passed $hours hours ago. See /var/log/yap/backup.log"
  else
    good "A real restore of the newest backup passed $hours hours ago"
  fi
fi
key_state="$(backup_key_state)"
case "$key_state" in
  proven*) good "The saved copy of the backup key was proved on ${key_state#proven }" ;;
  changed) bad "The backup key has changed since its fingerprint was saved, so older backups need the old key. If you did not change it, find out why." ;;
  unproved) bad "Nobody has proved the saved copy of the backup key. Run: infra/backup-key.sh check" ;;
  *) bad "The backup key cannot be read. Run this as root." ;;
esac
last_offsite="$(grep '^last_offsite=' "$STATE_DIR/backup-status" 2> /dev/null | cut -d= -f2-)"
if [[ "$offsite" == "pull" ]]; then
  bad "BACKUP_OFFSITE=pull: this server cannot tell whether another machine fetches the backups. Check there."
elif [[ -z "$last_offsite" ]]; then
  bad "No copy has reached $offsite yet. Test it: infra/backup-cron.sh db"
else
  hours=$((($(date +%s) - $(date -d "$last_offsite" +%s)) / 3600))
  if ((hours > 7)); then
    bad "The last copy off this server was $hours hours ago. See /var/log/yap/backup.log"
  else
    good "Last copy off this server: $hours hours ago, to $offsite"
  fi
fi

echo
echo "The watchdog"
if [[ ! -r "${YAP_WATCHDOG_CRON:-/etc/cron.d/yap-watchdog}" ]]; then
  bad "It is not installed, so a frozen API would stay frozen. Run: bash infra/server-setup.sh"
else
  watchdog_restarts=0
  watchdog_restarted_at=0
  watchdog_gave_up=0
  if [[ -r "$STATE_DIR/watchdog" ]]; then
    read -r _ watchdog_restarts watchdog_restarted_at watchdog_gave_up < "$STATE_DIR/watchdog"
  fi
  if ((watchdog_gave_up > 0)); then
    bad "The API stopped answering, and $watchdog_restarts restarts did not cure it, so the watchdog has stopped. See /var/log/yap/watchdog.log"
  elif (($(date +%s) - watchdog_restarted_at < 7 * 86400)); then
    bad "The API froze and was restarted on $(date -d "@$watchdog_restarted_at" '+%F at %H:%M'). A freeze is a fault worth reporting. See /var/log/yap/watchdog.log"
  else
    good "Installed, with no restart in the last 7 days"
  fi
fi

echo
echo "The server"
used="$(df -P "$(docker info --format '{{.DockerRootDir}}' 2> /dev/null || echo /)" 2> /dev/null | awk 'NR == 2 { gsub("%", "", $5); print $5 }')"
if [[ ! "$used" =~ ^[0-9]+$ ]]; then
  bad "The disk could not be read, so nobody knows how full it is. Look with: df -h"
elif ((used >= 85)); then
  bad "The disk is $used% full"
else
  good "Disk $used% full"
fi
swap_used="$(awk '/^SwapTotal:/ { t = $2 } /^SwapFree:/ { f = $2 } END { print int((t - f) / 1024) }' /proc/meminfo)"
mem_free="$(awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo)"
if ((mem_free < 300)); then
  bad "Only $mem_free MB of memory is available, with $swap_used MB in swap"
else
  good "$mem_free MB of memory available, $swap_used MB in swap"
fi
if [[ -f /var/run/reboot-required ]]; then
  good "A reboot is due for updates. It happens by itself at 04:30."
fi

if [[ -z "$telegram_token" ]]; then
  bad "TELEGRAM_BOT_TOKEN is empty, so no alert can leave the app: a fire shows only to someone looking at it. Put the token from @BotFather in $ENV_FILE, then run infra/deploy.sh"
else
  if words="$(telegram_words "$(telegram_check_api)")"; then
    good "$words"
  else
    bad "$words"
  fi
  if compose logs --since 1h api 2>&1 | grep -q 'terminated by other getUpdates'; then
    bad "Another program is polling the Telegram bot. Is a development server running on a laptop?"
  else
    good "Telegram: no second poller in the last hour"
  fi
fi

echo
if ((problems > 0)); then
  echo "$problems thing(s) to look at."
  exit 1
fi
echo "All good."
