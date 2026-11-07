#!/usr/bin/env bash
# Every backup is encrypted with the backup key, so a wrong saved copy is only found out on the day it
# is needed, unless something proves it first. This never prints the key, and what you enter stays hidden.
#
#   infra/backup-key.sh check     enter the key from your saved copy, and hear whether it matches
#   infra/backup-key.sh show      where the key is, its fingerprint, and whether the copy has been proved
#   infra/backup-key.sh restore   on a new server: put your saved copy in place of the key made here
#   infra/backup-key.sh create    make a key if there is none. infra/server-setup.sh runs this
#
# The fingerprint is a short name for the key. Keep it with your copy: on a new server it shows at once
# whether the key went in right. It is stored beside the key too, and it gives nothing away.
#
# Settings, from the environment or .env.production: BACKUP_PASSPHRASE_FILE, default /etc/yap/backup.key.
set -euo pipefail

# shellcheck source=infra/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

what="${1:-}"
key_file="$(setting BACKUP_PASSPHRASE_FILE /etc/yap/backup.key)"
backup_dir="$(setting BACKUP_DIR /var/backups/yap)"

need_key() {
  if [[ ! -r "$key_file" ]]; then
    echo "$key_file cannot be read. Run this as root, on the server." >&2
    exit 2
  fi
}

fingerprint() { key_fingerprint < "$key_file"; }

save_fingerprint() {
  fingerprint > "$key_file.fingerprint"
  chmod 600 "$key_file.fingerprint"
}

# Spaces around a pasted key are the copying, not the key.
ask_for_key() {
  local entered=""
  IFS= read -r -s -p "Paste or type the backup key from your saved copy, then press Enter: " entered || true
  echo >&2
  entered="${entered#"${entered%%[![:space:]]*}"}"
  printf '%s' "${entered%"${entered##*[![:space:]]}"}"
}

create_key() {
  if [[ -s "$key_file" ]]; then
    save_fingerprint
    echo "Backup key already there, left as it is. Its fingerprint is $(fingerprint)"
    return
  fi
  (umask 077 && openssl rand -hex 32 > "$key_file")
  save_fingerprint
  echo "New backup key in $key_file. Its fingerprint is $(fingerprint)"
}

show_key() {
  local state
  need_key
  state="$(backup_key_state)"
  echo "The backup key is in $key_file. Its fingerprint is $(fingerprint)"
  case "$state" in
    proven*) echo "Your saved copy was proved on ${state#proven }." ;;
    changed) echo "This is not the key that fingerprint was saved for, so it has been changed. Older backups need the old key." ;;
    *) echo "Nobody has proved a saved copy of it yet. Run: infra/backup-key.sh check" ;;
  esac
}

check_key() {
  local entered key
  need_key
  key="$(head -n 1 "$key_file")"
  entered="$(ask_for_key)"
  if [[ -z "$entered" ]]; then
    echo "Nothing was entered, so nothing has been proved." >&2
    exit 1
  fi
  if [[ "$entered" != "$key" ]]; then
    echo "It does NOT match: your saved copy could not read a single backup." >&2
    echo "You entered ${#entered} characters, and the key has ${#key}." >&2
    echo "  What you entered has the fingerprint $(printf '%s' "$entered" | key_fingerprint)" >&2
    echo "  The key on this server has           $(fingerprint)" >&2
    echo "Save the key again from: cat $key_file" >&2
    echo "Then run this again." >&2
    exit 1
  fi
  mkdir -p "$STATE_DIR"
  printf '%s %s\n' "$(fingerprint)" "$(date +%F)" > "$STATE_DIR/backup-key-proven"
  save_fingerprint
  echo "It matches. Your saved copy can read the backups. Its fingerprint is $(fingerprint)"
}

restore_key() {
  local entered
  # shellcheck disable=SC2012 # only whether there is one
  if [[ -n "$(ls -1 "$backup_dir" 2> /dev/null | grep -E '^yap-(db|config)-.*\.enc$' | head -n 1)" && "${RESTORE_CONFIRM:-}" != "yes" ]]; then
    echo "Backups were made on this server, and this replaces the key they may need." >&2
    echo "On a new server with copied backups that is right: run it with RESTORE_CONFIRM=yes" >&2
    exit 2
  fi
  entered="$(ask_for_key)"
  if ((${#entered} < 32)); then
    echo "That is ${#entered} characters, too short to be the key. Nothing was changed." >&2
    exit 1
  fi
  (umask 077 && printf '%s\n' "$entered" > "$key_file.new")
  mv "$key_file.new" "$key_file"
  save_fingerprint
  echo "The key is in place. Its fingerprint is $(fingerprint)"
  echo "That must be the fingerprint you saved with the key. If it is not, the key went in wrong: run this again."
}

case "$what" in
  create) create_key ;;
  show) show_key ;;
  check) check_key ;;
  restore) restore_key ;;
  *)
    echo "usage: infra/backup-key.sh check|show|restore|create" >&2
    exit 2
    ;;
esac
