#!/usr/bin/env bash
# Puts the newest commit on main live by itself, once its tests have passed on GitHub. Cron runs one look
# every five minutes, from /etc/cron.d/yap-auto-deploy. Run it as root:
#
#   infra/auto-deploy.sh install     check that it can work here, then turn it on
#   infra/auto-deploy.sh status      what it did last, and what it is waiting for
#   infra/auto-deploy.sh pause       deploy nothing until resume: for a restore, or a day that must stay quiet
#   infra/auto-deploy.sh resume
#   infra/auto-deploy.sh retry       try once more, now, a commit whose deploy failed
#   infra/auto-deploy.sh uninstall   turn it off. infra/deploy.sh by hand works as before
#   infra/auto-deploy.sh run         one look, as cron does it
#
# One look fetches the branch. Its newest commit goes live once the GitHub check named in AUTO_DEPLOY_CHECK
# has passed on it, through infra/deploy.sh, which backs up, builds, starts, smoke-checks, and goes back by
# itself if the new version fails. Older commits are never deployed, and a commit that is live already, or
# older than what is live, is left alone. So a rollback by hand stays until the next push.
#
# A failed deploy is not tried again by itself, because each try takes a backup and a long build on a small
# server: the next push gets its own try, or `retry` runs it again. After a failed deploy the checkout goes
# back to the commit that runs, so the scripts cron runs from here match the running version. If going back
# failed too, it pauses itself and leaves everything as it is for a person.
#
# It never deploys over files someone changed by hand in this checkout, and it waits while a backup or a
# deploy by hand holds the deploy lock. It writes to /var/log/yap/auto-deploy.log only when something
# happens, and to Telegram as well when TELEGRAM_BOT_TOKEN and BACKUP_ALERT_CHAT_ID are set.
#
# Settings, in .env.production or the environment, all optional:
#   AUTO_DEPLOY_BRANCH   default main
#   AUTO_DEPLOY_CHECK    default tests: the job in .github/workflows/ci.yml that has to pass
#   AUTO_DEPLOY_REPO     owner/name on GitHub. Empty: worked out from the origin remote
#   MIN_RAM_MB           read by preflight, for a server smaller than its usual minimum
set -uo pipefail

# shellcheck source=infra/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

CRON_FILE="${YAP_AUTO_DEPLOY_CRON:-/etc/cron.d/yap-auto-deploy}"
LOG_DIR="${YAP_LOG_DIR:-/var/log/yap}"
STATE_FILE="$STATE_DIR/auto-deploy"
PAUSE_FILE="$STATE_DIR/auto-deploy.paused"
LOOKED_FILE="$STATE_DIR/auto-deploy.looked"
# Under cron nobody can type a password, so a fetch that wants one fails at once instead of waiting.
export GIT_TERMINAL_PROMPT=0

stamp() { date '+%Y-%m-%dT%H:%M:%S%z'; }
say() { printf '%s %s\n' "$(stamp)" "$*"; }
short() { printf '%s' "${1:0:7}"; }
in_repo() { git -c safe.directory='*' -C "$YAP_ROOT" "$@"; }

# The images run the code as a non-root user, and Docker COPY keeps each file's mode. Under this
# script's umask 027 a checkout writes files only root can read, so it checks out under 022: the code
# is public on GitHub anyway. Untracked files, .env.production among them, are not touched.
checkout_code() { (umask 022 && in_repo checkout --quiet -B "$1" "$2"); }

tell() {
  say "$1"
  telegram_send "YAP deploy on $(hostname): $1"
}

branch() { setting AUTO_DEPLOY_BRANCH main; }
check_name() { setting AUTO_DEPLOY_CHECK tests; }

# owner/name from an address on GitHub, and nothing for any other.
github_repo_of() {
  local pattern='^(https://|ssh://git@|git@)github\.com[:/]([^/]+)/([^/]+)$'
  [[ "$1" =~ $pattern ]] || return 0
  printf '%s/%s' "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]%.git}"
}

repo() {
  local given
  given="$(setting AUTO_DEPLOY_REPO)"
  if [[ -n "$given" ]]; then
    printf '%s' "$given"
  else
    github_repo_of "$(in_repo remote get-url origin 2> /dev/null)"
  fi
}

# --- What it remembers --------------------------------------------------------------------------
#
# One commit, the newest on the branch when it last looked, and where that commit stands:
#   waiting        for its check on GitHub, or for the deploy lock
#   tests-failed   its check failed. Looked at again, so a re-run that passes still deploys it
#   blocked        files here were changed by hand. Looked at again, so it deploys once they are undone
#   deploying      infra/deploy.sh is running. Found at the start of a look, it was interrupted
#   live           it went live, or what is live already holds it
#   refused        infra/deploy.sh refused before touching anything. Only `retry` tries again
#   deploy-failed  infra/deploy.sh failed. Only `retry` tries again

state() { grep "^$1=" "$STATE_FILE" 2> /dev/null | head -n 1 | cut -d= -f2-; }

# Returns 1 when the commit already stood there, so that nothing is said twice.
remember() {
  if [[ "$(state commit)" == "$1" && "$(state outcome)" == "$2" ]]; then
    return 1
  fi
  printf 'commit=%s\noutcome=%s\nsince=%s\nnote=%s\n' "$1" "$2" "$(date +%s)" "${3:-}" > "$STATE_FILE.new" &&
    mv "$STATE_FILE.new" "$STATE_FILE"
}

pause() { printf '%s, %s\n' "$(stamp)" "$1" > "$PAUSE_FILE"; }

# What deploy.sh last put live, as it wrote it: a short commit.
live_commit() {
  local live
  live="$(grep '^commit=' "$STATE_DIR/last-deploy" 2> /dev/null | head -n 1 | cut -d= -f2-)"
  printf '%s' "${live:-unknown}"
}

# True when what is live is this commit or holds it, so a deploy would change nothing or go backwards.
already_live() {
  local live
  live="$(in_repo rev-parse --verify --quiet "$(live_commit)^{commit}" 2> /dev/null)" || return 1
  in_repo merge-base --is-ancestor "$1" "$live"
}

# Fetches the branch and prints its newest commit.
fetch_branch() {
  in_repo -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60 fetch --quiet --no-tags origin \
    "+refs/heads/$1:refs/remotes/origin/$1" || return 1
  in_repo rev-parse "refs/remotes/origin/$1"
}

# What GitHub says of the check on one commit: success, another conclusion such as failure, or running,
# none (not started, or never will be) or unreachable. No sign-in: the repository is public, and an
# address may ask 60 times an hour.
check_of() {
  local name answer
  name="$(jq -rn --arg name "$(check_name)" '$name | @uri')"
  answer="$(curl -fsS --connect-timeout 10 --max-time 20 -H 'Accept: application/vnd.github+json' \
    "${GITHUB_API:-https://api.github.com}/repos/$(repo)/commits/$1/check-runs?check_name=$name&filter=latest" 2> /dev/null)" || {
    echo unreachable
    return
  }
  jq -r '[.check_runs[]?] | sort_by(.id) | last
    | if . == null then "none" elif .status != "completed" then "running" else (.conclusion // "none") end' <<< "$answer" 2> /dev/null ||
    echo unreachable
}

# Tracked files changed here, and commits here that GitHub does not have.
hand_changes() {
  in_repo status --porcelain --untracked-files=no
  in_repo log --format='commit %h %s' HEAD --not --remotes
}

# A backup holds the deploy lock shared, and a deploy holds it alone. Either way, not now.
deploy_lock_free() { flock -n "$STATE_DIR/deploy.lock" true; }

# The line of deploy.sh's output that says why it stopped.
reason_in() {
  local line
  line="$(grep -m 1 -E '^(DEPLOY FAILED: |  FAIL  |Deploy refused: )' "$1")"
  line="${line#DEPLOY FAILED: }"
  line="${line#  FAIL  }"
  line="${line#Deploy refused: }"
  line="${line%.}"
  printf '%s' "${line:-it gave no reason, so see its log}"
}

go_back() {
  checkout_code "$1" "$2" ||
    say "Could not check out $(short "$2") again. Look: git -C $YAP_ROOT status"
}

# --- One deploy ---------------------------------------------------------------------------------

deploy() {
  local branch="$1" tip="$2" previous output code reason log subject
  previous="$(in_repo rev-parse HEAD)"
  subject="$(in_repo log -1 --format=%s "$tip")"
  if ! checkout_code "$branch" "$tip"; then
    remember "$tip" refused "git could not check it out"
    tell "Not deploying $(short "$tip"): git could not check it out in $YAP_ROOT. Look: git -C $YAP_ROOT status"
    return
  fi
  in_repo branch --quiet --set-upstream-to="origin/$branch" "$branch" 2> /dev/null || true
  remember "$tip" deploying
  say "Deploying $(short "$tip") from $branch, over $(short "$previous"): $subject"

  output="$(mktemp)"
  # Closing descriptor 8 keeps this script's own lock out of everything the deploy starts.
  if [[ -t 1 ]]; then
    "$YAP_ROOT/infra/deploy.sh" 8>&- 2>&1 | tee "$output"
    code=${PIPESTATUS[0]}
  else
    "$YAP_ROOT/infra/deploy.sh" > "$output" 2>&1 8>&-
    code=$?
  fi
  reason="$(reason_in "$output")"
  log="$(grep -Eo '[^ ]*deploy-[0-9]{8}T[0-9]{6}Z\.log' "$output" | tail -n 1)"
  log="${log:-$LOG_DIR}"

  case "$code" in
    0)
      remember "$tip" live
      tell "$(short "$tip") is live: $subject"
      ;;
    2)
      go_back "$branch" "$previous"
      if grep -q 'Another deploy or a backup is running' "$output"; then
        remember "$tip" waiting "the deploy lock"
        say "A backup or another deploy started first. $(short "$tip") goes at a later look."
      else
        remember "$tip" refused "$reason"
        tell "Did not deploy $(short "$tip"): $reason. Nothing was changed, and the site stays on $(live_commit). Log: $log. Once that is fixed: infra/auto-deploy.sh retry"
      fi
      ;;
    3)
      remember "$tip" deploy-failed "$reason, and going back failed too"
      pause "after the deploy of $(short "$tip") failed and going back failed too"
      tell "THE SITE IS PROBABLY DOWN. The deploy of $(short "$tip") failed ($reason), and going back failed too. Automatic deploys are paused, and the checkout was left as it is. Look now: infra/status.sh, and the log $log"
      ;;
    *)
      go_back "$branch" "$previous"
      remember "$tip" deploy-failed "$reason"
      tell "The deploy of $(short "$tip") failed: $reason. The site runs $(live_commit), as before. Log: $log. It is not tried again by itself: push a fix, or run infra/auto-deploy.sh retry"
      ;;
  esac
  rm -f "$output"
}

# --- One look -----------------------------------------------------------------------------------

look() {
  local branch tip verdict changes
  exec 8> "$STATE_DIR/auto-deploy.lock"
  flock -n 8 || return 0
  [[ ! -e "$PAUSE_FILE" ]] || return 0
  branch="$(branch)"

  # Only a look starts a deploy, and no other look is running, so this one never finished.
  if [[ "$(state outcome)" == "deploying" ]]; then
    remember "$(state commit)" deploy-failed "it stopped halfway, perhaps in a reboot"
    tell "The deploy of $(short "$(state commit)") stopped halfway, perhaps in a reboot, so it is not certain what runs. It is not tried again by itself. Look: infra/status.sh, then run infra/auto-deploy.sh retry"
    return 0
  fi

  # A network that is away says nothing here. status.sh notices when no look has worked for an hour.
  tip="$(fetch_branch "$branch" 2> /dev/null)" || return 0
  date +%s > "$LOOKED_FILE"

  if already_live "$tip"; then
    remember "$tip" live && say "$(short "$tip"), the newest on $branch, is live."
    return 0
  fi
  if [[ "$(state commit)" == "$tip" ]]; then
    case "$(state outcome)" in
      live | refused | deploy-failed) return 0 ;;
    esac
  fi

  verdict="$(check_of "$tip")"
  case "$verdict" in
    success) ;;
    running | none | unreachable)
      remember "$tip" waiting "$verdict" && say "$(short "$tip") on $branch goes live once its tests pass on GitHub."
      return 0
      ;;
    *)
      remember "$tip" tests-failed "$verdict" &&
        tell "Not deploying $(short "$tip"): its tests on GitHub ended in $verdict. The site stays on $(live_commit). Push a fix, or re-run the tests on GitHub if they failed by chance."
      return 0
      ;;
  esac

  changes="$(hand_changes)"
  if [[ -n "$changes" ]]; then
    remember "$tip" blocked "$(head -n 3 <<< "$changes" | tr '\n' ' ')" &&
      tell "Not deploying $(short "$tip"): someone changed these by hand in $YAP_ROOT, and no deploy goes over them: $(head -n 5 <<< "$changes" | tr '\n' ' ')- Put them in a commit through GitHub, or undo them, and the next look deploys."
    return 0
  fi

  deploy_lock_free || return 0
  deploy "$branch" "$tip"
}

# --- For people ---------------------------------------------------------------------------------

# In the shape of infra/status.sh, which shows it. Exit code 1 when something needs a person.
show_status() {
  local outcome commit note since minutes looked now problems=0
  ok() { printf '  ok    %s\n' "$1"; }
  look_at() {
    printf '  LOOK  %s\n' "$1"
    problems=$((problems + 1))
  }

  if [[ ! -r "$CRON_FILE" ]]; then
    ok "Off. Updates go live by hand, with infra/deploy.sh. To turn this on: infra/auto-deploy.sh install"
    return 0
  fi
  now="$(date +%s)"
  outcome="$(state outcome)"
  commit="$(short "$(state commit)")"
  note="$(state note)"
  since="$(state since)"
  minutes=$(((now - ${since:-$now}) / 60))
  looked="$(cat "$LOOKED_FILE" 2> /dev/null)"

  if [[ -e "$PAUSE_FILE" ]]; then
    look_at "Paused since $(cat "$PAUSE_FILE"). To start again: infra/auto-deploy.sh resume"
  fi
  if [[ -z "$looked" ]]; then
    look_at "It has never fetched $(branch) from GitHub. To see why: git -C $YAP_ROOT fetch origin $(branch)"
  elif ((now - looked > 3600)); then
    look_at "It has not reached GitHub for $(((now - looked) / 3600)) hour(s), so nothing new can go live. To see why: git -C $YAP_ROOT fetch origin $(branch)"
  fi
  case "$outcome" in
    live) ok "On for $(branch), every 5 minutes. Its newest commit, $commit, is live." ;;
    "") ok "On for $(branch), every 5 minutes. The first look comes within 5 minutes." ;;
    waiting)
      if ((minutes < 120)); then
        ok "On for $(branch). $commit is waiting for its tests on GitHub, for $minutes min so far."
      else
        look_at "$commit has waited $((minutes / 60)) hours for its tests on GitHub ($note). Look at the Actions tab of the repository: a run may be stuck, or the commit skipped CI."
      fi
      ;;
    deploying) ok "Deploying $commit, for $minutes min so far. The newest log in $LOG_DIR shows how far it is." ;;
    tests-failed) look_at "The tests of $commit failed on GitHub ($note), so it is not deployed. The site stays on $(live_commit)." ;;
    blocked) look_at "$commit is not deployed: files in $YAP_ROOT were changed by hand ($note). See: git -C $YAP_ROOT status" ;;
    refused) look_at "infra/deploy.sh refused $commit before changing anything: $note. Once that is fixed: infra/auto-deploy.sh retry" ;;
    deploy-failed) look_at "The deploy of $commit failed: $note. The site runs $(live_commit). Once that is fixed: infra/auto-deploy.sh retry" ;;
  esac
  ((problems == 0))
}

do_install() {
  local branch repo tip verdict changes preflight tool line
  branch="$(branch)"
  if [[ ! -w "$(dirname "$CRON_FILE")" ]] || ! mkdir -p "$LOG_DIR" 2> /dev/null; then
    echo "Cannot write $CRON_FILE or $LOG_DIR. Run this as root."
    return 2
  fi
  for tool in curl flock git jq; do
    if ! command -v "$tool" > /dev/null 2>&1; then
      echo "$tool is missing. Run: bash infra/server-setup.sh"
      return 2
    fi
  done

  repo="$(repo)"
  if [[ -z "$repo" ]]; then
    echo "origin is $(in_repo remote get-url origin 2> /dev/null || echo 'not set'), which is not on GitHub, so there is nothing to watch."
    echo "Point it at the repository on GitHub, then run this again:"
    echo "  git -C $YAP_ROOT remote set-url origin https://github.com/OWNER/NAME.git"
    return 2
  fi
  echo "Fetching $branch from $(in_repo remote get-url origin)"
  if ! tip="$(fetch_branch "$branch")"; then
    echo "Could not fetch $branch, so cron could not either and nothing would ever deploy. The error is above."
    return 2
  fi
  date +%s > "$LOOKED_FILE"

  changes="$(hand_changes)"
  if [[ -n "$changes" ]]; then
    echo "These were changed by hand in $YAP_ROOT, and no deploy goes over them:"
    while IFS= read -r line; do
      echo "  $line"
    done <<< "$changes"
    echo "Put them in a commit through GitHub, or undo them, then run this again."
    return 2
  fi

  echo "Running preflight, as every deploy does first"
  if ! preflight="$("$YAP_ROOT/infra/preflight.sh" 2>&1)"; then
    echo "$preflight"
    echo
    echo "Preflight refuses this server now, so it would refuse every automatic deploy too. Fix that first."
    echo "On a server smaller than the usual minimum, put MIN_RAM_MB in $ENV_FILE."
    return 2
  fi

  cat > "$CRON_FILE" << CRON
# Written by infra/auto-deploy.sh install. To turn it off: infra/auto-deploy.sh uninstall
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
*/5 * * * * root $YAP_ROOT/infra/auto-deploy.sh run >> $LOG_DIR/auto-deploy.log 2>&1
CRON
  chmod 644 "$CRON_FILE"

  echo
  echo "Automatic deploys are on: every 5 minutes for $branch, once \"$(check_name)\" passes on github.com/$repo."
  verdict="$(check_of "$tip")"
  if already_live "$tip"; then
    echo "The newest commit on $branch, $(short "$tip"), is live already."
  elif [[ "$verdict" == "success" ]]; then
    echo "The newest commit on $branch, $(short "$tip"), passed its tests and is not live: it deploys within 5 minutes."
  else
    echo "The newest commit on $branch, $(short "$tip"), is not live. Its tests on GitHub: $verdict. It deploys once they pass."
  fi
  if [[ -e "$PAUSE_FILE" ]]; then
    echo "They are paused, though, since $(cat "$PAUSE_FILE"). To start them: infra/auto-deploy.sh resume"
  fi
  echo "What it does goes to $LOG_DIR/auto-deploy.log, and to Telegram when BACKUP_ALERT_CHAT_ID is set."
  echo "To see where it stands: infra/auto-deploy.sh status"
}

retry() {
  if [[ -e "$PAUSE_FILE" ]]; then
    echo "Automatic deploys are paused, since $(cat "$PAUSE_FILE"). Run infra/auto-deploy.sh resume first."
    return 1
  fi
  case "$(state outcome)" in
    refused | deploy-failed) remember "$(state commit)" waiting "a retry" ;;
  esac
  look
  show_status
}

usage() {
  echo "usage: infra/auto-deploy.sh install | status | pause | resume | retry | uninstall | run" >&2
}

main() {
  cd "$YAP_ROOT" || exit 1
  umask 027
  if ! mkdir -p "$STATE_DIR" 2> /dev/null; then
    echo "Cannot write to $STATE_DIR. Run this as root." >&2
    exit 2
  fi
  case "${1:-}" in
    run) look ;;
    install) do_install ;;
    uninstall)
      rm -f "$CRON_FILE"
      echo "Automatic deploys are off. infra/deploy.sh by hand works as before."
      ;;
    status) show_status ;;
    pause)
      pause "${2:-paused by hand}"
      echo "Paused. A deploy already running finishes. Nothing more deploys until: infra/auto-deploy.sh resume"
      ;;
    resume)
      rm -f "$PAUSE_FILE"
      echo "Resumed. The next look comes within 5 minutes."
      ;;
    retry) retry ;;
    *)
      usage
      exit 2
      ;;
  esac
}

# Sourced by the tests for its functions. Run, it reads the whole of main before starting, so a checkout
# that replaces this file halfway through cannot change what runs.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
  exit
fi
