#!/usr/bin/env bash
# Checks this server and .env.production before a deploy, and refuses if something would go wrong.
# It changes nothing, so it is safe to run at any time:
#
#   infra/preflight.sh
#
# Exit code 0 means go ahead. WARN lines do not stop a deploy. FAIL lines do.
#
# Optional settings, from the environment:
#   MIN_DISK_GB, MIN_RAM_MB   defaults 15 and 3500
#   YAP_SERVER_IP             this server's public address, if it cannot be worked out
set -uo pipefail

# shellcheck source=infra/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$YAP_ROOT" || exit 1

failures=0
warnings=0

section() { printf '\n%s\n' "$1"; }
pass() { printf '  ok    %s\n' "$1"; }
note() { [[ -z "${1:-}" ]] || printf '        %s\n' "$1"; }
warn() {
  printf '  WARN  %s\n' "$1"
  note "${2:-}"
  warnings=$((warnings + 1))
}
fail() {
  printf '  FAIL  %s\n' "$1"
  note "${2:-}"
  failures=$((failures + 1))
}

finish() {
  echo
  if ((failures > 0)); then
    echo "Preflight refused: $failures problem(s) to fix, $warnings warning(s). Nothing was changed."
    exit 1
  fi
  echo "Preflight passed with $warnings warning(s)."
  exit 0
}

# --- Docker -------------------------------------------------------------------------------------

section "Docker"
if ! command -v docker > /dev/null 2>&1; then
  fail "Docker is not installed." "Run: bash infra/server-setup.sh"
  finish
fi
if ! docker info > /dev/null 2>&1; then
  fail "Docker is not running, or this user may not use it." "Run this as root. If it still fails: systemctl status docker"
  finish
fi
if ! docker compose version > /dev/null 2>&1; then
  fail "The Docker Compose plugin is missing." "Run: bash infra/server-setup.sh"
  finish
fi
pass "Docker $(docker version --format '{{.Server.Version}}'), $(docker compose version --short 2> /dev/null | sed 's/^/Compose /')"
missing_tools=""
for tool in curl flock git jq openssl rsync ssh; do
  command -v "$tool" > /dev/null 2>&1 || missing_tools="$missing_tools $tool"
done
if [[ -n "$missing_tools" ]]; then
  fail "These tools are missing:$missing_tools" "Run: bash infra/server-setup.sh"
fi

first_deploy=yes
if docker volume inspect "${PROJECT}_db" > /dev/null 2>&1; then
  first_deploy=no
fi

# --- .env.production ----------------------------------------------------------------------------

section "Settings in $ENV_FILE"
if [[ ! -r "$ENV_FILE" ]]; then
  fail "$ENV_FILE does not exist." "Run: infra/init-env.sh <your domain>"
  finish
fi
if grep -q $'\r' "$ENV_FILE"; then
  fail "The file has Windows line endings, which would become part of every value." "Run: sed -i 's/\\r\$//' $ENV_FILE"
  finish
fi
mode="$(stat -c '%a' "$ENV_FILE" 2> /dev/null || stat -f '%Lp' "$ENV_FILE")"
if [[ "$mode" != "600" && "$mode" != "400" ]]; then
  fail "The file holds every password but other users can read it (mode $mode)." "Run: chmod 600 $ENV_FILE"
fi
duplicates="$(grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE" | sort | uniq -d | tr -d '=' | tr '\n' ' ')"
if [[ -n "$duplicates" ]]; then
  fail "These settings appear twice, and only the last line counts: $duplicates" "Keep one line for each."
fi

SECRET_HELP="Get a good one with: openssl rand -hex 32"
SECRETS="POSTGRES_PASSWORD YAP_APP_PASSWORD YAP_AI_PASSWORD REDIS_PASSWORD JWT_SECRET"

# True for values like 00000000 or deadbeefdeadbeef, which pass as hex but are not random.
is_repeating() {
  local value="$1" period chunk repeated
  for ((period = 1; period <= 16; period++)); do
    chunk="${value:0:period}"
    repeated=""
    while ((${#repeated} < ${#value})); do
      repeated="$repeated$chunk"
    done
    [[ "${repeated:0:${#value}}" != "$value" ]] || return 0
  done
  return 1
}

check_secret() {
  local name="$1" value lowered
  value="$(setting "$name")"
  lowered="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
  if [[ -z "$value" ]]; then
    fail "$name is empty." "$SECRET_HELP"
  elif [[ "$lowered" =~ (change|example|secret|passw|sample|your|todo|replace|dev|xxx) ]]; then
    fail "$name still looks like an example value." "$SECRET_HELP"
  elif [[ ! "$value" =~ ^[0-9a-fA-F]+$ ]]; then
    fail "$name is not hex. It goes inside a connection URL, where other characters break." "$SECRET_HELP"
  elif ((${#value} < 32)); then
    fail "$name is too short: ${#value} characters, and it needs at least 32." "$SECRET_HELP"
  elif is_repeating "$lowered"; then
    fail "$name is a repeating pattern, not a random value." "$SECRET_HELP"
  else
    pass "$name"
  fi
}

for name in $SECRETS; do
  check_secret "$name"
done
repeated="$(for name in $SECRETS; do setting "$name"; echo; done | grep . | sort | uniq -d | wc -l | tr -d ' ')"
if ((repeated > 0)); then
  fail "Two of the secrets have the same value. Each one must be different." "$SECRET_HELP"
fi

tls_mode="$(setting TLS_MODE caddy)"
domain="$(setting DOMAIN)"
origin="$(setting WEB_ORIGIN)"
https_port="$(setting TLS_HTTPS_PORT 443)"
caddy_global="$(setting CADDY_GLOBAL)"

case "$tls_mode" in
  caddy | external) ;;
  *) fail "TLS_MODE is '$tls_mode'. It must be caddy or external." ;;
esac

expected_origin="https://$domain"
[[ "$https_port" == "443" ]] || expected_origin="https://$domain:$https_port"

domain_ok=no
if [[ -z "$domain" ]]; then
  fail "DOMAIN is empty." "Set it to the name people will type, for example app.yuksalish.uz."
elif [[ "$domain" == *example* ]]; then
  fail "DOMAIN is still an example: $domain"
elif [[ ! "$domain" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ || "$domain" =~ ^[0-9.]+$ ]]; then
  fail "DOMAIN is not a domain name: $domain" "A name only, in small letters, with no https:// and no slash. An IP address cannot get a certificate."
else
  domain_ok=yes
  pass "DOMAIN $domain"
fi

# Compared with DOMAIN only once DOMAIN itself is right, so that one mistake gives one message.
origin_ok=no
if [[ -z "$origin" ]]; then
  fail "WEB_ORIGIN is empty." "Set it to $expected_origin"
elif [[ "$origin" == *example* ]]; then
  fail "WEB_ORIGIN is still an example: $origin" "Set it to $expected_origin"
elif [[ "$origin" != https://* ]]; then
  fail "WEB_ORIGIN must start with https://, and it is $origin" "Over plain HTTP nobody stays signed in, because the session cookie is marked Secure."
elif [[ "$domain_ok" == "yes" && "$origin" != "$expected_origin" ]]; then
  fail "WEB_ORIGIN does not match DOMAIN: $origin" "It must be exactly $expected_origin, with no slash at the end."
else
  origin_ok=yes
  pass "WEB_ORIGIN $origin"
fi

site_url="$(setting VITE_SITE_URL)"
if [[ -z "$site_url" ]]; then
  warn "VITE_SITE_URL is empty, so the public pages have no canonical links or sitemap." "Set it to $expected_origin, then deploy."
elif [[ "$origin_ok" == "yes" && "$site_url" != "$origin" ]]; then
  fail "VITE_SITE_URL ($site_url) is not the same as WEB_ORIGIN ($origin)."
fi

admin_phone="$(setting PLATFORM_ADMIN_PHONE)"
admin_password="$(setting PLATFORM_ADMIN_PASSWORD)"
admin_raw="$(env_raw PLATFORM_ADMIN_PASSWORD || true)"
if [[ "$first_deploy" == "yes" ]]; then
  if [[ -z "$admin_phone" || -z "$admin_password" ]]; then
    fail "PLATFORM_ADMIN_PHONE and PLATFORM_ADMIN_PASSWORD are needed on the first deploy." "Without them no account exists, and nobody can sign in."
  fi
fi
if [[ -n "$admin_phone" && ! "$admin_phone" =~ ^\+[0-9]{9,15}$ ]]; then
  fail "PLATFORM_ADMIN_PHONE must be written like +998901234567, with no spaces." "It is stored as written, while sign-in looks for this form, so any other form could never sign in."
fi
if [[ -n "$admin_password" ]]; then
  if ((${#admin_password} < 12)); then
    fail "PLATFORM_ADMIN_PASSWORD is too short: ${#admin_password} characters, and it needs at least 12." "With fewer, the database step stops and the app does not start."
  fi
  if [[ "$admin_password" == *'$'* && "$admin_raw" != \'* ]]; then
    fail "PLATFORM_ADMIN_PASSWORD holds a \$ and has no single quotes around it." "Compose would read it as a variable and store a different password. Write it as: PLATFORM_ADMIN_PASSWORD='...'"
  fi
  if [[ "$admin_raw" == \'* && "$admin_raw" != *\' ]]; then
    fail "PLATFORM_ADMIN_PASSWORD has an opening single quote but no closing one."
  fi
fi
if [[ "$first_deploy" == "no" && -n "$admin_password" ]]; then
  warn "PLATFORM_ADMIN_PASSWORD is still in the file." "The admin already exists and it is not used any more. Remove both PLATFORM_ADMIN lines."
fi

gemini_key="$(setting GEMINI_API_KEY)"
anthropic_key="$(setting ANTHROPIC_API_KEY)"
provider="$(setting AI_PROVIDER)"
if [[ -n "$gemini_key" && "$(setting GEMINI_PAID_TIER)" != "true" ]]; then
  fail "GEMINI_API_KEY is set, but GEMINI_PAID_TIER is not true." "On the free tier Google may use prompts and answers, which spec 15.2 forbids. Use a billing-enabled project, then set GEMINI_PAID_TIER=true, or leave the key empty."
fi
case "$provider" in
  "" | gemini | claude) ;;
  *) fail "AI_PROVIDER is '$provider'. It must be gemini, claude or empty." ;;
esac
if [[ -n "$gemini_key" && -n "$anthropic_key" && -z "$provider" ]]; then
  warn "Both AI keys are set and AI_PROVIDER is empty, so Gemini is used." "Set AI_PROVIDER to choose."
fi
if [[ -n "$gemini_key" || -n "$anthropic_key" ]]; then
  warn "An AI key is set: what a question needs is sent to a provider outside Uzbekistan." "Review this against the personal data rules before relying on it. See docs/deployment.md."
fi

telegram_token="$(setting TELEGRAM_BOT_TOKEN)"
if [[ -n "$telegram_token" ]]; then
  if [[ ! "$telegram_token" =~ ^[0-9]+:[A-Za-z0-9_-]{20,}$ ]]; then
    fail "TELEGRAM_BOT_TOKEN does not look like a bot token." "It looks like 123456789:ABC..., and comes from @BotFather."
  else
    warn "TELEGRAM_BOT_TOKEN is set. Only one program may poll a bot at a time." "If this token is also in a laptop's .env, stop that development server now, or the two will take each other's messages."
    telegram_answer="$(telegram_check_here)"
    if telegram_message="$(telegram_words "$telegram_answer")"; then
      pass "$telegram_message"
    elif [[ "$telegram_answer" == refused* && "$first_deploy" == "yes" ]]; then
      fail "Telegram refuses TELEGRAM_BOT_TOKEN." "$telegram_message"
    else
      # An update must not wait for Telegram: the site works without it.
      warn "Telegram does not work from this server." "$telegram_message"
    fi
  fi
fi

storage="$(setting STORAGE_DRIVER local)"
case "$storage" in
  local) pass "Files are kept on this server and included in the backups" ;;
  s3)
    missing=""
    for name in S3_ENDPOINT S3_ACCESS_KEY S3_SECRET_KEY; do
      [[ -n "$(setting "$name")" ]] || missing="$missing $name"
    done
    if [[ -n "$missing" ]]; then
      fail "STORAGE_DRIVER=s3 needs:$missing"
    else
      warn "Files are in S3, so backup.sh does not cover them." "Use the store's own versioning or replication, in Uzbekistan."
    fi
    ;;
  *) fail "STORAGE_DRIVER is '$storage'. It must be local or s3." ;;
esac

if compose_output="$(compose config -q 2>&1)"; then
  pass "Docker Compose accepts the configuration"
else
  fail "Docker Compose refuses the configuration:" "$compose_output"
fi

# A Caddyfile that cannot load would take the site down. Better to refuse it here than to go back later.
if [[ "$tls_mode" == "caddy" && "$domain_ok" == "yes" ]]; then
  # A plain `docker run`, because `compose run` would create the project's volumes and network. That
  # would break the promise that this script changes nothing, and make a new server look deployed.
  # The values come from compose, so that this checks exactly what Caddy will be given.
  caddy_config="$(compose config --format json 2> /dev/null)"
  caddy_output="$(docker run --rm -e "DOMAIN=$domain" \
    -e "CADDY_GLOBAL=$(jq -r '.services.caddy.environment.CADDY_GLOBAL // ""' <<< "$caddy_config")" \
    -v "$YAP_ROOT/infra/Caddyfile:/etc/caddy/Caddyfile:ro" "$(jq -r '.services.caddy.image' <<< "$caddy_config")" \
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1)"
  if grep -q 'Valid configuration' <<< "$caddy_output"; then
    pass "Caddy accepts infra/Caddyfile"
  elif grep -q 'adapting config' <<< "$caddy_output"; then
    fail "Caddy refuses infra/Caddyfile:" "$(grep 'adapting config' <<< "$caddy_output" | tail -n 1 | cut -c1-300)"
  else
    warn "Could not run Caddy to check infra/Caddyfile, so it was not checked." "$(tail -n 1 <<< "$caddy_output" | cut -c1-300)"
  fi
fi

# --- The domain ---------------------------------------------------------------------------------

lookup() {
  local type="$1" resolver answer
  if command -v dig > /dev/null 2>&1; then
    for resolver in ${YAP_DNS_SERVER:-1.1.1.1 8.8.8.8}; do
      answer="$(dig +short +time=3 +tries=1 "@$resolver" "$domain" "$type" 2> /dev/null | grep -E '^[0-9a-fA-F:.]+$' | grep -E '[.:]' || true)"
      if [[ -n "$answer" ]]; then
        printf '%s\n' "$answer"
        return
      fi
    done
    dig +short +time=3 +tries=1 "$domain" "$type" 2> /dev/null | grep -E '^[0-9a-fA-F:.]+$' | grep -E '[.:]' || true
  elif [[ "$type" == "A" ]]; then
    getent ahostsv4 "$domain" 2> /dev/null | awk '{ print $1 }' | sort -u
  fi
}

server_addresses() {
  if [[ -n "${YAP_SERVER_IP:-}" ]]; then
    echo "$YAP_SERVER_IP"
    return
  fi
  ip -o addr show scope global 2> /dev/null | awk '{ sub(/\/.*/, "", $4); print $4 }'
  local service
  for service in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
    if curl -fsS --max-time 5 "$service" 2> /dev/null | grep -E '^[0-9a-fA-F:.]+$'; then
      return
    fi
  done
}

section "The domain"
if [[ "$tls_mode" == "external" ]]; then
  pass "TLS_MODE=external: your own proxy answers for $domain, so the name is not checked here"
elif [[ "$caddy_global" == *local_certs* ]]; then
  warn "CADDY_GLOBAL asks for local test certificates. Browsers will not trust this site." "That is right for a test on a laptop, and wrong for a real server. Clear CADDY_GLOBAL."
elif [[ -z "$domain" ]]; then
  fail "No DOMAIN to check."
else
  a_records="$(lookup A)"
  aaaa_records="$(lookup AAAA)"
  addresses="$(server_addresses)"
  if [[ -z "$a_records" ]]; then
    fail "$domain has no A record, so it points nowhere." "Add an A record for it at your domain registrar. A new record can take from minutes to a few hours to appear."
  elif [[ -z "$addresses" ]]; then
    warn "Could not work out this server's public address, so cannot tell whether $domain points here." "It points at: $(echo "$a_records" | tr '\n' ' '). To check it anyway, set YAP_SERVER_IP."
  else
    matched=""
    while IFS= read -r record; do
      if printf '%s\n' "$addresses" | grep -qxF "$record"; then
        matched="$record"
      fi
    done <<< "$a_records"
    if [[ -z "$matched" ]]; then
      fail "$domain does not point at this server." "It points at: $(echo "$a_records" | tr '\n' ' '), and this server is: $(echo "$addresses" | tr '\n' ' '). Fix the A record. A CDN or proxy in front of it must be switched off, too: Caddy needs to answer directly, and personal data must not leave Uzbekistan."
    else
      pass "$domain points at this server ($matched)"
    fi
  fi
  if [[ -n "$aaaa_records" ]]; then
    warn "$domain also has an AAAA (IPv6) record: $(echo "$aaaa_records" | tr '\n' ' ')" "This stack answers on IPv4 only. Remove the AAAA record, or certificates and some visitors may fail."
  fi
fi

# --- Ports --------------------------------------------------------------------------------------

section "Ports"
check_port() {
  local port="$1" purpose="$2" holder
  if docker ps --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Ports}}' | grep -Eq "[:.]$port->"; then
    pass "Port $port ($purpose) is held by this stack already"
  elif holder="$(ss -H -ltnp "sport = :$port" 2> /dev/null)" && [[ -n "$holder" ]]; then
    fail "Port $port ($purpose) is taken by something else." "$(echo "$holder" | awk '{ print $4, $6 }' | head -n 2 | tr '\n' ' ')"
  else
    pass "Port $port ($purpose) is free"
  fi
}
if ! command -v ss > /dev/null 2>&1; then
  warn "The ss tool is missing, so ports could not be checked." "Run: apt-get install -y iproute2"
else
  check_port "$(setting WEB_PORT 8080)" "web, on loopback"
  if [[ "$tls_mode" == "caddy" ]]; then
    check_port "$(setting TLS_HTTP_PORT 80)" "HTTP"
    check_port "$https_port" "HTTPS"
  fi
fi

# --- Room ---------------------------------------------------------------------------------------

free_gb() {
  local path="$1"
  while [[ ! -e "$path" && "$path" != "/" ]]; do
    path="$(dirname "$path")"
  done
  df -Pk "$path" | awk 'NR == 2 { printf "%d", $4 / 1048576 }'
}

to_mb() {
  case "$1" in
    *[gG]) echo $((${1%?} * 1024)) ;;
    *[mM]) echo "${1%?}" ;;
    *) echo 0 ;;
  esac
}

section "Disk and memory"
min_disk="${MIN_DISK_GB:-15}"
docker_root="$(docker info --format '{{.DockerRootDir}}')"
docker_free="$(free_gb "$docker_root")"
if ((docker_free < min_disk)); then
  fail "Only $docker_free GB free for Docker in $docker_root, and it needs $min_disk GB." "Make room or grow the disk. Images and a build need that much."
else
  pass "$docker_free GB free for Docker"
fi

min_ram="${MIN_RAM_MB:-3500}"
ram_mb="$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo)"
swap_mb="$(awk '/^SwapTotal:/ { print int($2 / 1024) }' /proc/meminfo)"
if ((ram_mb < min_ram)); then
  fail "This server has $ram_mb MB of memory, and the stack needs at least $min_ram MB." "Choose a bigger server. The pilot sizing is in docs/deployment.md."
elif ((ram_mb < 7000)); then
  warn "This server has $ram_mb MB of memory. It will run, but builds are slow and there is little room." "8 GB or more is better. The pilot sizing is in docs/deployment.md."
else
  pass "$ram_mb MB of memory"
fi
if ((ram_mb < 9000 && swap_mb == 0)); then
  warn "No swap on a server this small: a build could end in processes being killed." "server-setup.sh creates a swap file."
fi

limits_mb=0
for pair in DB_MEM_LIMIT:3g API_MEM_LIMIT:2g REDIS_MEM_LIMIT:512m WEB_MEM_LIMIT:256m; do
  limits_mb=$((limits_mb + $(to_mb "$(setting "${pair%:*}" "${pair#*:}")")))
done
[[ "$tls_mode" == "caddy" ]] && limits_mb=$((limits_mb + $(to_mb "$(setting CADDY_MEM_LIMIT 256m)")))
if ((limits_mb > ram_mb)); then
  fail "The memory limits add up to $limits_mb MB, more than this server's $ram_mb MB." "Run: infra/init-env.sh --resize"
elif ((limits_mb * 3 < ram_mb)); then
  warn "The memory limits add up to $limits_mb MB on a server with $ram_mb MB, so most of it sits unused." "To use it: infra/init-env.sh --resize, then deploy."
else
  pass "Memory limits add up to $limits_mb MB"
fi

# --- Backups ------------------------------------------------------------------------------------

section "Backups"
key_file="$(setting BACKUP_PASSPHRASE_FILE /etc/yap/backup.key)"
backup_dir="$(setting BACKUP_DIR /var/backups/yap)"
offsite="$(setting BACKUP_OFFSITE)"
cron_file="${YAP_CRON_FILE:-/etc/cron.d/yap-backup}"

if [[ ! -r "$key_file" ]]; then
  fail "The backup key $key_file cannot be read." "server-setup.sh creates it. Run this script as root."
elif (($(wc -c < "$key_file") < 32)); then
  fail "The backup key $key_file is too short." "Get one with: openssl rand -hex 32"
else
  pass "Backup key $key_file"
  case "$(backup_key_state)" in
    changed) warn "The backup key has changed since its fingerprint was saved, so older backups need the old key." "If you did not change it, find out why. Then save the new key, and run: infra/backup-key.sh check" ;;
    unproved) warn "Nobody has proved the saved copy of the backup key." "Run: infra/backup-key.sh check" ;;
  esac
fi
if [[ ! -d "$backup_dir" || ! -w "$backup_dir" ]]; then
  fail "The backup folder $backup_dir does not exist or cannot be written." "server-setup.sh creates it."
else
  backup_free="$(free_gb "$backup_dir")"
  if ((backup_free < 5)); then
    fail "Only $backup_free GB free for backups in $backup_dir." "Make room or grow the disk."
  else
    pass "Backup folder $backup_dir, $backup_free GB free"
  fi
fi
if [[ ! -r "$cron_file" ]]; then
  fail "Backups are not scheduled: $cron_file is missing." "Run: bash infra/server-setup.sh"
elif ! grep -q 'backup-cron.sh check' "$cron_file"; then
  fail "$cron_file is out of date: nothing would check that the backups can be restored." "Run: bash infra/server-setup.sh"
else
  pass "Backups are scheduled in $cron_file"
fi
if [[ -n "$telegram_token" && -z "$(setting BACKUP_ALERT_CHAT_ID)" ]]; then
  warn "BACKUP_ALERT_CHAT_ID is empty, so a failed backup only reaches the log." "Set it to a Telegram chat. See Backups in docs/deployment.md."
fi
if [[ -z "$(setting BACKUP_HEARTBEAT_URL)" ]]; then
  warn "BACKUP_HEARTBEAT_URL is empty, so nothing outside this server would notice dead backups." "See Check on day one in docs/deployment.md."
fi
if [[ -z "$(setting HEARTBEAT_URL)" ]]; then
  warn "HEARTBEAT_URL is empty, so nothing outside this server would notice if it died." "See Check on day one in docs/deployment.md."
fi
for name in HEARTBEAT_URL BACKUP_HEARTBEAT_URL; do
  value="$(setting "$name")"
  if [[ -n "$value" && ! "$value" =~ ^https?://[^[:space:]\"]+$ ]]; then
    fail "$name does not look like a web address."
  fi
done
for name in RETENTION_KEEP_LAST RETENTION_DAILY RETENTION_WEEKLY RETENTION_MONTHLY RETENTION_FILE_SETS FILES_FULL_EVERY_DAYS BACKUP_RESERVE_MB; do
  value="$(setting "$name")"
  if [[ -n "$value" && ! "$value" =~ ^[0-9]+$ ]]; then
    fail "$name is '$value'. It must be a whole number, or empty for the default."
  fi
done
for name in RETENTION_KEEP_LAST RETENTION_FILE_SETS; do
  if [[ "$(setting "$name")" == "0" ]]; then
    fail "$name is 0, which would keep no backups at all."
  fi
done

check_offsite_copy() {
  local marker output reason
  marker="$(mktemp)"
  date -u +%FT%TZ > "$marker"
  if output="$(offsite_push "$marker" "${offsite%/}/.yap-offsite-test" 2>&1)"; then
    pass "Backups can reach $offsite (a test file was written there)"
  else
    # The first real line says why. SSH's note about a new host is not an error, and the last lines
    # are only rsync saying that it stopped.
    reason="$(echo "$output" | grep -v '^Warning: Permanently added' | head -n 1) Check that the machine is on, and that it has the key from $(setting BACKUP_SSH_KEY /etc/yap/backup_ssh_key).pub."
    if [[ "$first_deploy" == "yes" ]]; then
      fail "Could not write to BACKUP_OFFSITE ($offsite)." "$reason"
    else
      warn "Could not write to BACKUP_OFFSITE ($offsite) just now." "$reason"
    fi
  fi
  rm -f "$marker"
}

case "$offsite" in
  "")
    fail "BACKUP_OFFSITE is not set, so backups would stay on this disk." "A backup on the same disk does not survive losing that disk. Set it to a machine in Uzbekistan: see Backups in docs/deployment.md."
    ;;
  pull)
    warn "BACKUP_OFFSITE=pull: this server cannot see whether another machine really fetches the backups." "Check on that machine every week. See Backups in docs/deployment.md."
    ;;
  /*)
    if [[ ! -d "$offsite" ]]; then
      fail "BACKUP_OFFSITE is $offsite, and that folder does not exist."
    elif [[ "$(df -P "$offsite" | awk 'NR == 2 { print $1 }')" == "$(df -P "$backup_dir" 2> /dev/null | awk 'NR == 2 { print $1 }')" ]]; then
      fail "BACKUP_OFFSITE ($offsite) is on the same disk as the backups." "That does not protect against losing this disk."
    else
      check_offsite_copy
    fi
    ;;
  *:*)
    check_offsite_copy
    ;;
  *)
    fail "BACKUP_OFFSITE is '$offsite', which is not user@host:path, a /path, or pull."
    ;;
esac

# --- The watchdog -------------------------------------------------------------------------------

section "The watchdog"
if [[ -r "${YAP_WATCHDOG_CRON:-/etc/cron.d/yap-watchdog}" ]]; then
  pass "A frozen API gets restarted"
else
  warn "The watchdog is not installed, so a frozen API would stay frozen." "Run: bash infra/server-setup.sh"
fi

# --- The clock ----------------------------------------------------------------------------------

section "Clock"
if command -v timedatectl > /dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
  if [[ "$(timedatectl show -p NTPSynchronized --value 2> /dev/null)" == "yes" ]]; then
    pass "The clock is synchronised"
  else
    warn "The clock is not synchronised." "Two-factor codes depend on the right time. Check: timedatectl"
  fi
else
  warn "Could not check the clock here (no systemd)." "Two-factor codes depend on the right time."
fi

finish
