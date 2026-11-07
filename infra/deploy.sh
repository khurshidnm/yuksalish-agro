#!/usr/bin/env bash
# Goes live, or updates, in one command. Run it as root:
#
#   infra/deploy.sh              deploy what is checked out here
#   infra/deploy.sh --rollback   go back to the images and Caddyfile from before the last deploy
#
# The order: preflight, a backup if a database exists, remember the running images and Caddyfile, build,
# start, wait for health, then a smoke check through the public address. If starting or checking fails,
# it goes back to what it remembered and says what that could and could not undo.
#
# Exit codes: 0 deployed. 1 failed and rolled back, or nothing to roll back to. 2 refused before
# touching anything. 3 failed, and the rollback failed too.
#
# Optional settings, from the environment:
#   DEPLOY_PULL=no       build without fetching newer base images
#   UP_TIMEOUT=420       seconds to wait for the stack to start, longer for a slow migration
#   SMOKE_TIMEOUT=240    seconds the public address gets to answer, a first certificate included
set -uo pipefail

# A dropped SSH connection must not stop a deploy halfway. It carries on, and the log has the ending.
trap '' HUP

# shellcheck source=infra/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$YAP_ROOT" || exit 1

mode=deploy
case "${1:-}" in
  "") ;;
  --rollback) mode=rollback ;;
  *)
    echo "usage: infra/deploy.sh [--rollback]" >&2
    exit 2
    ;;
esac

umask 027
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
log_dir="${YAP_LOG_DIR:-/var/log/yap}"
if ! mkdir -p "$STATE_DIR" "$log_dir" 2> /dev/null; then
  echo "Cannot write to $STATE_DIR or $log_dir. Run this as root." >&2
  exit 2
fi
log_file="$log_dir/deploy-$stamp.log"
exec > >(tee -a "$log_file") 2>&1
tee_pid=$!

leave() {
  local code="$1"
  exec > /dev/null 2>&1
  wait "$tee_pid" 2> /dev/null
  exit "$code"
}

say() { printf '\n==> %s\n' "$*"; }

exec 9> "$STATE_DIR/deploy.lock"
if ! flock -n 9; then
  echo "Another deploy or a backup is running. Wait for it to finish, then run this again."
  leave 2
fi

compose_command
image_prefix="$(setting YAP_IMAGE_PREFIX yap)"
hold_repo="$image_prefix-rollback"
images_list="$STATE_DIR/images-$stamp.list"
# Caddy reads this copy of infra/Caddyfile, which only this script writes (see docker-compose.tls.yml).
# A file that loads but sends the site nowhere passes every check until the smoke check, and going back
# has to be able to put the old one in its place while the checkout stays as it is.
live_caddyfile="$STATE_DIR/Caddyfile"
up_timeout="${UP_TIMEOUT:-420}"
smoke_timeout="${SMOKE_TIMEOUT:-240}"
origin="$(setting WEB_ORIGIN)"
domain="$(setting DOMAIN)"
commit="$(git -c safe.directory='*' rev-parse --short HEAD 2> /dev/null || echo unknown)"

first_deploy=yes
if docker volume inspect "${PROJECT}_db" > /dev/null 2>&1; then
  first_deploy=no
fi
backup_file=""
migrations_before=""
have_images=no
failure=""

migration_count() {
  compose exec -T db psql -U yap -d yap -tAc 'select count(*) from drizzle.__drizzle_migrations' 2> /dev/null | tr -d '[:space:]'
}

service_state() {
  local id
  id="$(compose ps -a -q "$1" 2> /dev/null | head -n 1)"
  [[ -n "$id" ]] || {
    echo missing
    return
  }
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2> /dev/null || echo missing
}

wait_healthy() {
  local deadline=$((SECONDS + $1)) waiting service state
  shift
  while :; do
    waiting=""
    for service in "$@"; do
      state="$(service_state "$service")"
      [[ "$state" == "healthy" ]] || waiting="$waiting $service=$state"
    done
    [[ -n "$waiting" ]] || return 0
    if ((SECONDS >= deadline)); then
      failure="these services did not become healthy:$waiting"
      return 1
    fi
    sleep 3
  done
}

stack_services=(api web)
if tls_enabled; then
  stack_services+=(caddy)
fi

# Tags what is running now, so a rollback does not depend on any tag that the build moves.
remember_images() {
  local config service id image_id ref
  # `config --images <service>` also lists dependencies, in no fixed order, so it cannot be used here.
  config="$(compose config --format json)"
  : > "$images_list"
  for service in $(jq -r '.services | keys[]' <<< "$config"); do
    [[ "$service" != "migrate" ]] || continue
    id="$(compose ps -a -q "$service" 2> /dev/null | head -n 1)"
    [[ -n "$id" ]] || continue
    image_id="$(docker inspect -f '{{.Image}}' "$id")"
    ref="$(jq -r --arg service "$service" '.services[$service].image' <<< "$config")"
    docker tag "$image_id" "$hold_repo/$service:$stamp"
    printf '%s %s %s\n' "$service" "$ref" "$hold_repo/$service:$stamp" >> "$images_list"
    echo "  $service: $hold_repo/$service:$stamp"
  done
  [[ -s "$images_list" ]] && have_images=yes
  if [[ -r "$live_caddyfile" ]]; then
    cp "$live_caddyfile" "${images_list%.list}.Caddyfile"
  fi
  if [[ -r "$STATE_DIR/last-deploy" ]]; then
    cp "$STATE_DIR/last-deploy" "${images_list%.list}.deploy"
  fi
}

build_images() {
  local service pull=(--pull)
  [[ "$(setting DEPLOY_PULL yes)" == "yes" ]] || pull=()
  # One at a time: two builds at once can run a small server out of memory.
  for service in db migrate web; do
    say "Building $service"
    if ! compose build "${pull[@]}" "$service"; then
      if ((${#pull[@]} == 0)); then
        return 1
      fi
      echo "Could not build with fresh base images. Trying with the ones already here."
      compose build "$service" || return 1
    fi
  done
  if [[ "$(setting DEPLOY_PULL yes)" == "yes" ]]; then
    local third_party="redis"
    tls_enabled && third_party="$third_party caddy"
    # shellcheck disable=SC2086
    compose pull -q $third_party || echo "Could not fetch newer Redis or Caddy images. Keeping the ones here."
  fi
}

# Replaces the file Caddy reads, and says whether it changed. A rename, so a running Caddy never sees half a
# file. It also means a running container keeps the old file, so a change needs a new container.
install_caddyfile() {
  cmp -s "$1" "$live_caddyfile" && return 1
  cp "$1" "$live_caddyfile.new" && mv "$live_caddyfile.new" "$live_caddyfile"
}

# Compose cannot see a change inside a mounted file, and Caddy holds its configuration in memory, so a new
# file would quietly never take effect.
restart_caddy() {
  "${COMPOSE_CMD[@]}" up -d --no-deps --no-build --pull never --force-recreate caddy
}

caddy_changed=no
take_new_caddyfile() {
  tls_enabled || return 0
  if install_caddyfile infra/Caddyfile; then
    caddy_changed=yes
  fi
}

refresh_caddy() {
  # A Caddy that was not running before this deploy was started a moment ago, with the new file.
  [[ "$caddy_changed" == "yes" ]] && grep -q '^caddy ' "$images_list" 2> /dev/null || return 0
  say "infra/Caddyfile has changed, so restarting Caddy. Open connections drop for a moment"
  restart_caddy
}

# --- The smoke check ----------------------------------------------------------------------------

smoke_args=()

# Trusts Caddy's own CA when a test asks for local certificates. Everything else needs a real one.
prepare_smoke() {
  if tls_enabled && [[ "$(setting CADDY_GLOBAL)" == *local_certs* ]]; then
    local root_ca="$STATE_DIR/local-ca.crt"
    compose exec -T caddy cat /data/caddy/pki/authorities/local/root.crt > "$root_ca" 2> /dev/null || true
    smoke_args=(--cacert "$root_ca")
  fi
}

# Prints the HTTP status. The body goes to $smoke_body, and the headers to $smoke_headers.
fetch() {
  curl -sS --connect-timeout 5 --max-time 20 -o "$smoke_body" -D "$smoke_headers" -w '%{http_code}' "${smoke_args[@]}" "$@"
}

smoke_once() {
  local status
  status="$(fetch "$@" "$origin/api/health" 2>&1)" || {
    failure="$origin/api/health did not answer: $status"
    return 1
  }
  if [[ "$status" != "200" ]] || ! grep -q '"status":"ok"' "$smoke_body"; then
    failure="$origin/api/health answered $status: $(head -c 200 "$smoke_body")"
    return 1
  fi
  status="$(fetch "$@" "$origin/" 2>&1)" || {
    failure="the public page did not answer: $status"
    return 1
  }
  if [[ "$status" != "200" ]] || ! grep -qi '<html' "$smoke_body"; then
    failure="the public page answered $status instead of a web page"
    return 1
  fi
  status="$(fetch "$@" "$origin/app" 2>&1)" || {
    failure="the app did not answer: $status"
    return 1
  }
  if [[ "$status" != "200" ]] || ! grep -qi 'id="root"' "$smoke_body"; then
    failure="the app answered $status instead of its page"
    return 1
  fi
  # A wrong password goes the whole way: nginx, the API and the database, and must be refused properly.
  status="$(fetch "$@" -X POST -H 'content-type: application/json' \
    -d '{"phone":"+998000000000","password":"deploy-smoke-check"}' "$origin/api/v1/auth/login" 2>&1)" || {
    failure="sign-in did not answer: $status"
    return 1
  }
  # Enough deploys in 15 minutes lock this made-up phone, and that is a proper refusal too.
  if ! [[ "$status" =~ ^(401|423)$ ]] || ! grep -Eq 'INVALID_CREDENTIALS|ACCOUNT_LOCKED' "$smoke_body"; then
    failure="a wrong password got $status instead of a proper refusal: $(head -c 200 "$smoke_body")"
    return 1
  fi
  if tls_enabled && ! grep -qi '^strict-transport-security:' "$smoke_headers"; then
    failure="the answer through Caddy has no Strict-Transport-Security header"
    return 1
  fi
}

smoke_check() {
  local started=$SECONDS limit="${1:-$smoke_timeout}" address=""
  smoke_body="$(mktemp)"
  smoke_headers="$(mktemp)"
  say "Smoke check through $origin"
  if tls_enabled && [[ -n "$domain" ]]; then
    address="$domain:$(setting TLS_HTTPS_PORT 443):127.0.0.1"
  fi
  while :; do
    prepare_smoke
    if smoke_once; then
      rm -f "$smoke_body" "$smoke_headers"
      echo "Health, public page, app and sign-in all answered through $origin."
      return 0
    fi
    local public_failure="$failure"
    # Some providers cannot route a server to its own public address. After a minute, ask for the same
    # name through this server itself, so a network quirk cannot throw away a working version.
    if [[ -n "$address" ]] && ((SECONDS - started >= 60 || SECONDS - started >= limit)) && smoke_once --resolve "$address"; then
      rm -f "$smoke_body" "$smoke_headers"
      echo "The public address failed: $public_failure"
      echo
      echo "WARNING: everything works from inside this server, but its public address did not answer"
      echo "from here. Some providers cannot loop back, so this may be nothing. Open $origin on your"
      echo "phone now, away from the farm's Wi-Fi. If it does not load, look at the provider's firewall."
      return 0
    fi
    if ((SECONDS - started >= limit)); then
      failure="$public_failure"
      rm -f "$smoke_body" "$smoke_headers"
      return 1
    fi
    sleep 5
  done
}

# Docker's published ports skip the firewall, so anything published beyond 80 and 443 is exposed.
check_exposure() {
  local exposed
  exposed="$(docker ps --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Names}} {{.Ports}}' |
    grep -E '(0\.0\.0\.0|\[::\]):[0-9]+->' | grep -Ev "(0\.0\.0\.0|\[::\]):($(setting TLS_HTTP_PORT 80)|$(setting TLS_HTTPS_PORT 443))->" || true)"
  if [[ -n "$exposed" ]]; then
    echo
    echo "WARNING: a port is open to the internet that should not be:"
    echo "$exposed"
  fi
}

# Never fails the deploy: the site works without Telegram. It only says so, at the end, where it is read.
check_telegram() {
  local words
  [[ -n "$(setting TELEGRAM_BOT_TOKEN)" ]] || return 0
  say "Asking Telegram about the bot, from inside the API container"
  if ! words="$(telegram_words "$(telegram_check_api)")"; then
    echo
    echo "WARNING: $words"
    return 1
  fi
  echo "$words"
  say "Waiting 35 seconds to see whether another program is polling the same Telegram bot"
  sleep 35
  if compose logs --since 2m api 2>&1 | grep -q 'terminated by other getUpdates'; then
    echo
    echo "WARNING: another program is polling this Telegram bot. It is most likely a development server"
    echo "on a laptop. Stop it, or messages will be lost: each poller takes some of them."
    return 1
  fi
  echo "No second poller showed up in 35 seconds."
}

show_evidence() {
  say "What the containers said"
  compose ps -a --format 'table {{.Service}}\t{{.Status}}'
  local service
  for service in "${stack_services[@]}"; do
    echo "--- $service (last lines)"
    compose logs --no-color --no-log-prefix --tail 15 "$service" 2>&1 | cut -c1-300
  done
}

# Says in one line why `up` stopped, when the containers can tell.
why_up_failed() {
  local id code cause
  id="$(compose ps -a -q migrate 2> /dev/null | head -n 1)"
  code="$(docker inspect -f '{{.State.ExitCode}}' "$id" 2> /dev/null)"
  if [[ -n "$code" && "$code" != "0" ]]; then
    cause="$(compose logs --no-color --no-log-prefix migrate 2>&1 | grep -m 1 -E '^[[:space:]]*(\[cause\]: )?[A-Za-z]*[Ee]rror: ' | cut -c1-200)"
    echo "the database migration failed. ${cause:-See the log below.}"
    return
  fi
  if [[ "$(service_state api)" != "healthy" ]]; then
    echo "the API did not start. Its last lines are below."
    return
  fi
  echo "the stack did not start within $up_timeout seconds."
}

# --- Going back ---------------------------------------------------------------------------------

# Removes our own tags and copies, and nothing else.
forget_images() {
  local list="$1" hold
  while read -r _ _ hold; do
    docker image rm "$hold" > /dev/null 2>&1 || true
  done < "$list"
  rm -f "$list" "${list%.list}.Caddyfile" "${list%.list}.deploy"
}

# status.sh names what last-deploy holds, so it must not go on naming what was just undone.
note_rollback() {
  local back undone
  back="$(grep '^commit=' "${1%.list}.deploy" 2> /dev/null | cut -d= -f2-)"
  undone="$(grep '^commit=' "$STATE_DIR/last-deploy" 2> /dev/null | cut -d= -f2-)"
  printf 'commit=%s\nrolled_back_at=%s\nundoing=%s\n' "${back:-unknown}" "$(date -Is)" "${undone:-unknown}" > "$STATE_DIR/last-deploy"
}

restore_images() {
  local list="$1" service ref hold caddyfile="${1%.list}.Caddyfile" caddy_back=no
  while read -r service ref hold; do
    docker tag "$hold" "$ref" || return 1
  done < "$list"
  if tls_enabled && [[ -r "$caddyfile" ]] && install_caddyfile "$caddyfile"; then
    caddy_back=yes
    echo "Putting back the Caddyfile from before this deploy."
  fi
  # `up` runs migrate from the old image as well. It finds nothing to do: migrations it does not know
  # are simply left alone.
  timeout "$up_timeout" "${COMPOSE_CMD[@]}" up -d --no-build --pull never || return 1
  [[ "$caddy_back" == "no" ]] || restart_caddy
}

what_stays() {
  local migrations_after ran
  migrations_after="$(migration_count)"
  echo "What the rollback could not undo:"
  if [[ -n "$migrations_before" && -n "$migrations_after" && "$migrations_after" != "$migrations_before" ]]; then
    ran=$((migrations_after - migrations_before))
    echo "  - $ran database migration(s) ran and stay in the database. Migrations have no undo. The"
    echo "    previous version was not written for them, so watch it closely. If it misbehaves, put the"
    echo "    database back with the commands below."
  else
    echo "  - No database migration ran in this deploy, so the database is as it was."
  fi
  echo "  - The code on disk is still the new one (commit $commit), and so are .env.production and the"
  echo "    compose files. Only the running images and the Caddyfile Caddy reads went back. The next"
  echo "    deploy takes infra/Caddyfile as it stands in the checkout again."
  echo "  - Anything people saved while the new version ran stays saved."
  if [[ -n "$backup_file" ]]; then
    echo
    echo "To put the database back exactly as it was before this deploy (this loses what was saved since):"
    echo "  RESTORE_CONFIRM=yes infra/restore.sh db $backup_file"
  fi
}

report_failure() {
  local reason="$1" rollback_failure
  echo
  echo "============================================================================="
  echo "DEPLOY FAILED: $reason"
  echo "============================================================================="
  show_evidence

  if [[ "$have_images" != "yes" ]]; then
    say "What happened"
    echo "No earlier version was running, so there is nothing to go back to. The containers were left"
    echo "as they are, so you can read their logs. Fix the problem and run infra/deploy.sh again."
    echo "Full log: $log_file"
    leave 1
  fi

  say "Rolling back to the images from before this deploy"
  if restore_images "$images_list" && wait_healthy 180 "${stack_services[@]}" && smoke_check 60; then
    say "What happened"
    echo "The new version failed: $reason"
    echo "The site is back on the previous version, and it passed the same smoke check."
    echo
    what_stays
    forget_images "$images_list"
    echo
    echo "Full log: $log_file"
    leave 1
  fi

  rollback_failure="$failure"
  say "What happened"
  echo "The new version failed: $reason"
  echo "THE ROLLBACK FAILED TOO: $rollback_failure"
  echo "The site is probably down. Look at the containers: ${COMPOSE_CMD[*]} ps -a"
  echo
  what_stays
  echo
  echo "Full log: $log_file"
  leave 3
}

# --- A manual rollback --------------------------------------------------------------------------

if [[ "$mode" == "rollback" ]]; then
  # shellcheck disable=SC2012
  list="$(ls -1t "$STATE_DIR"/images-*.list 2> /dev/null | head -n 1)"
  if [[ -z "$list" ]]; then
    echo "No earlier images are remembered here, so there is nothing to go back to."
    leave 1
  fi
  say "Going back to the images in $list, and the Caddyfile from then"
  cat "$list"
  if restore_images "$list" && wait_healthy 180 "${stack_services[@]}" && smoke_check 60; then
    say "Done"
    echo "The site is on the earlier images, and it passed the smoke check."
    echo "This does not undo database migrations, and the code on disk has not changed. The next"
    echo "infra/deploy.sh builds what is checked out here again, Caddyfile included."
    note_rollback "$list"
    forget_images "$list"
    leave 0
  fi
  echo "The rollback failed: $failure"
  show_evidence
  leave 3
fi

# --- The deploy ---------------------------------------------------------------------------------

say "Preflight"
if ! infra/preflight.sh; then
  echo
  echo "Deploy refused. Nothing was changed. Log: $log_file"
  leave 2
fi

if [[ "$first_deploy" == "yes" ]]; then
  say "This is the first deploy: no database yet, so no backup is needed"
else
  say "A database exists, so backing it up first"
  if [[ "$(service_state db)" != "healthy" ]]; then
    "${COMPOSE_CMD[@]}" up -d db && wait_healthy 120 db
  fi
  if ! backup_output="$(infra/backup.sh db)"; then
    echo
    echo "Deploy refused: the backup failed, and going on without one is not safe. Nothing was changed."
    leave 2
  fi
  echo "$backup_output"
  backup_file="${backup_output%% *}"
  infra/backup.sh config || echo "Could not copy the settings file. Carrying on: the database backup is what matters here."
  migrations_before="$(migration_count)"
  say "Remembering the running images"
  remember_images
fi

if ! build_images; then
  echo
  echo "============================================================================="
  echo "DEPLOY FAILED: the build failed."
  echo "The running site was not touched. It is still on the previous version."
  echo "Full log: $log_file"
  echo "============================================================================="
  leave 1
fi

pending=0
if [[ "$first_deploy" == "no" && -n "$migrations_before" ]]; then
  pending=$(($(find apps/api/drizzle -maxdepth 1 -name '*.sql' | wc -l) - migrations_before))
fi
if ((pending > 0)); then
  say "$pending new database migration(s). Stopping the API first, so the old code never meets the new schema"
  "${COMPOSE_CMD[@]}" stop -t 30 api
fi

take_new_caddyfile

say "Starting the new version"
if ! timeout "$up_timeout" "${COMPOSE_CMD[@]}" up -d --no-build --pull never; then
  report_failure "$(why_up_failed)"
fi

if ! refresh_caddy; then
  report_failure "Caddy did not restart with the new infra/Caddyfile"
fi

say "Waiting for health"
if ! wait_healthy 180 "${stack_services[@]}"; then
  report_failure "$failure"
fi

if ! smoke_check; then
  report_failure "the smoke check failed: $failure"
fi

check_exposure
check_telegram

# The last two sets of images stay, and older ones go. Only our own tags are removed.
# shellcheck disable=SC2012
for old in $(ls -1t "$STATE_DIR"/images-*.list 2> /dev/null | tail -n +3); do
  forget_images "$old"
done
printf 'commit=%s\ndeployed_at=%s\n' "$commit" "$(date -Is)" > "$STATE_DIR/last-deploy"

say "Done"
echo "Commit $commit is live at $origin."
[[ -z "$backup_file" ]] || echo "Backup from just before this deploy: $backup_file"
[[ "$have_images" != "yes" ]] || echo "To go back to the previous images: infra/deploy.sh --rollback"
echo "Full log: $log_file"
leave 0
