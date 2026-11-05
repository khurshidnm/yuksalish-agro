# shellcheck shell=bash
# Shared by the scripts in infra/. Source it, do not run it. It stays compatible with bash 3.2,
# because backup.sh and restore.sh also run on a developer's Mac.
#
# Read from the environment, all optional:
#   ENV_FILE         default .env.production in the repository root
#   COMPOSE_PROJECT  default yap-prod
#   COMPOSE_FILE     use this one compose file instead of docker-compose.prod.yml (+ .tls.yml)
#   YAP_STATE_DIR    default /var/lib/yap: what the scripts remember between runs

YAP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$YAP_ROOT/.env.production}"
case "$ENV_FILE" in
  /*) ;;
  *) ENV_FILE="$PWD/$ENV_FILE" ;;
esac
PROJECT="${COMPOSE_PROJECT:-yap-prod}"
# shellcheck disable=SC2034 # used by the scripts that source this file
STATE_DIR="${YAP_STATE_DIR:-/var/lib/yap}"

# One value as docker compose reads it: surrounding quotes removed, a trailing " # comment" dropped.
dotenv_value() {
  local raw="$1"
  raw="${raw#"${raw%%[![:space:]]*}"}"
  case "$raw" in
    \'*)
      raw="${raw#\'}"
      printf '%s' "${raw%%\'*}"
      ;;
    \"*)
      raw="${raw#\"}"
      printf '%s' "${raw%%\"*}"
      ;;
    *)
      raw="${raw%%[[:space:]]#*}"
      raw="${raw%"${raw##*[![:space:]]}"}"
      printf '%s' "$raw"
      ;;
  esac
}

# Prints the text after KEY= in the env file, as written, quotes included. The file is never
# sourced: a password holding $(...) must stay a password. The last line for a key wins, as in compose.
env_raw() {
  local key="$1" line value="" found=1
  [[ -r "$ENV_FILE" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line#export }"
    if [[ "$line" == "$key="* ]]; then
      value="${line#*=}"
      found=0
    fi
  done < "$ENV_FILE"
  [[ "$found" -eq 0 ]] || return 1
  printf '%s' "$value"
}

env_lookup() {
  local raw
  raw="$(env_raw "$1")" || return 1
  dotenv_value "$raw"
}

# A setting: from the environment if it is there, as compose would take it, then from the env file,
# then the fallback.
setting() {
  local name="$1" fallback="${2:-}" value
  value="${!name:-}"
  if [[ -z "$value" ]]; then
    value="$(env_lookup "$name" || true)"
  fi
  printf '%s' "${value:-$fallback}"
}

# True when Caddy is part of this stack. A stack with no DOMAIN and no TLS_MODE has no TLS overlay,
# so backup.sh and restore.sh keep working on a local check stack.
tls_enabled() {
  local mode
  mode="$(setting TLS_MODE)"
  [[ "$mode" == "caddy" || ( -z "$mode" && -n "$(setting DOMAIN)" ) ]]
}

# Fills COMPOSE_CMD, for callers that need the command itself, such as `timeout`.
compose_command() {
  COMPOSE_CMD=(docker compose -p "$PROJECT" -f "${COMPOSE_FILE:-$YAP_ROOT/docker-compose.prod.yml}")
  if [[ -z "${COMPOSE_FILE:-}" ]] && tls_enabled; then
    COMPOSE_CMD+=(-f "$YAP_ROOT/docker-compose.tls.yml")
  fi
  COMPOSE_CMD+=(--env-file "$ENV_FILE")
}

compose() {
  compose_command
  "${COMPOSE_CMD[@]}" "$@"
}

is_running() {
  compose ps --status running --services 2> /dev/null | grep -qx "$1"
}

# Runs a command where the uploaded files are: in the API container, or a one-off one while it is down.
in_files_volume() {
  if is_running api; then
    compose exec -T api "$@"
  else
    local command="$1"
    shift
    compose run --rm --no-deps -T --entrypoint "$command" api "$@"
  fi
}

# Through openssl, because the backups need it anyway and it works the same on Linux and macOS.
sha256_of() {
  openssl dgst -sha256 < "$1" | awk '{ print $NF }'
}

# A short name for a key, to keep beside it: it tells two keys apart and gives neither away. Only the
# first line counts, because that is all openssl reads of a key file.
key_fingerprint() {
  head -n 1 | tr -d '\n' | openssl dgst -sha256 |
    awk '{ print substr($NF, 1, 4) "-" substr($NF, 5, 4) "-" substr($NF, 9, 4) }'
}

# What is known about the owner's saved copy of the backup key, from infra/backup-key.sh check:
#   proven <date> | unproved | changed (the key is not the one its fingerprint was saved for) | unreadable
backup_key_state() {
  local key_file fingerprint saved proven
  key_file="$(setting BACKUP_PASSPHRASE_FILE /etc/yap/backup.key)"
  if [[ ! -r "$key_file" ]]; then
    echo unreadable
    return
  fi
  fingerprint="$(key_fingerprint < "$key_file")"
  saved="$(cat "$key_file.fingerprint" 2> /dev/null || true)"
  proven="$(cat "$STATE_DIR/backup-key-proven" 2> /dev/null || true)"
  if [[ -n "$saved" && "$saved" != "$fingerprint" ]]; then
    echo changed
  elif [[ "${proven%% *}" == "$fingerprint" ]]; then
    echo "proven ${proven#* }"
  else
    echo unproved
  fi
}

# Sends a message to the chat that hears about this server, if one is set. The URL goes through a
# config on stdin, so the bot token never shows up in the process list.
telegram_send() {
  local token chat
  token="$(setting TELEGRAM_BOT_TOKEN)"
  chat="$(setting BACKUP_ALERT_CHAT_ID)"
  [[ -n "$token" && -n "$chat" ]] || return 0
  printf 'url = "%s/bot%s/sendMessage"\n' "${TELEGRAM_API:-https://api.telegram.org}" "$token" |
    curl -fsS --max-time 20 -K - -o /dev/null \
      --data-urlencode "chat_id=$chat" \
      --data-urlencode "text=$1" ||
    echo "$(date '+%FT%T%z') could not send the alert to Telegram" >&2
}

# Asks Telegram who the bot is, from inside the API container: that is where the bot runs, and the
# token never leaves it. Prints one line for telegram_words. getMe does not disturb the bot's polling.
telegram_check_api() {
  local answer
  compose_command
  answer="$(timeout 30 "${COMPOSE_CMD[@]}" exec -T api node - < "$YAP_ROOT/infra/telegram-check.js" 2> /dev/null | tail -n 1)"
  printf '%s\n' "${answer:-down}"
}

# The same question from this server itself, for preflight: on a first deploy there is no API
# container, and on an update the running one still holds the old token. The token goes through a
# config on stdin, and what curl says about a failure is thrown away.
telegram_check_here() {
  local body status code=0
  body="$(mktemp)"
  status="$(printf 'url = "%s/bot%s/getMe"\n' "${TELEGRAM_API:-https://api.telegram.org}" "$(setting TELEGRAM_BOT_TOKEN)" |
    curl -sS --connect-timeout 10 --max-time 15 -K - -o "$body" -w '%{http_code}' 2> /dev/null)" || code=$?
  if ((code != 0)); then
    echo "unreachable curl-error-$code"
  elif [[ "$status" == "200" ]] && grep -q '"ok":true' "$body"; then
    echo "ok $(sed -n 's/.*"username":"\([^"]*\)".*/\1/p' "$body")"
  elif [[ "$status" == "401" || "$status" == "404" ]]; then
    echo "refused $status"
  else
    echo "odd $status"
  fi
  rm -f "$body"
}

# Turns the answer of a check into plain words. Fails unless Telegram works.
telegram_words() {
  local no_news="Until this is fixed, no alert, daily summary or backup warning reaches anyone."
  case "$1" in
    ok\ *)
      echo "Telegram answers from this server, and the token belongs to @${1#ok }."
      return 0
      ;;
    refused\ *)
      echo "Telegram refuses the bot token: it was revoked or mistyped. Get the current one from @BotFather, put it in TELEGRAM_BOT_TOKEN in .env.production, and run infra/deploy.sh. $no_news"
      ;;
    unreachable\ *)
      echo "This server cannot reach Telegram (${1#unreachable }). The route out of the country may be blocked, or Telegram may be away for a moment. Ask the provider whether outgoing HTTPS to api.telegram.org is allowed. $no_news"
      ;;
    odd\ *)
      echo "Something unexpected answered for Telegram (HTTP ${1#odd }). Telegram may be having trouble, or a filter on the route out of the country may be answering in its place. Try again later, then ask the provider. $no_news"
      ;;
    *)
      echo "The API is not running, so Telegram could not be checked."
      ;;
  esac
  return 1
}

# Copies files off this server with rsync over SSH, or to a mounted disk.
#   offsite_push SOURCE... DESTINATION
offsite_push() {
  local key ssh_command known_hosts
  key="$(setting BACKUP_SSH_KEY /etc/yap/backup_ssh_key)"
  known_hosts="$(dirname "$key")/backup_known_hosts"
  ssh_command="ssh -i $key -o BatchMode=yes -o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$known_hosts"
  if [[ -n "$(setting BACKUP_SSH_PORT)" ]]; then
    ssh_command="$ssh_command -p $(setting BACKUP_SSH_PORT)"
  fi
  # --partial-dir and not --partial: a half-sent file must never sit under its final name.
  rsync -rt --mkpath --timeout=600 --partial-dir=.rsync-partial -e "$ssh_command" "$@"
}
