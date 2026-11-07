#!/usr/bin/env bash
# Decides which backups stay and removes the rest. infra/backup.sh runs it before every backup, and the
# backup machine runs a copy of this one file, installed once by hand, which is why it needs nothing but
# bash and awk.
#
#   infra/backup-prune.sh <folder>                all types
#   infra/backup-prune.sh <folder> db config      only these
#
# Each type is judged alone, so a healthy type can never push out another type's backups:
#
#   db, config  the newest RETENTION_KEEP_LAST, plus the newest of each of the latest RETENTION_DAILY
#               days, RETENTION_WEEKLY weeks and RETENTION_MONTHLY months that have a backup
#   files       the newest RETENTION_FILE_SETS sets. A set is a full archive and the changes after it,
#               and it is only ever removed whole
#
# The rules count backups, not days, and they read the time from the file name. Only a newer backup can
# push an old one out, so when backups stop, or the clock jumps, nothing more is removed.
#
# The newest dump that infra/backup-cron.sh check has restored for real, marked by a .proven file, always
# stays: if later dumps turn out to be bad, it is the last one known to work.
#
# With NEED_MB set, and less than that free on the disk, older backups go early to make room for a new
# one, because a fresh backup is worth more than an old one. Files go first, a whole older set at a time.
# The newest set, the newest 3 dumps of a type and the proven dump stay, whatever the disk says.
set -uo pipefail

# On the main server the settings can be in .env.production. On the backup machine they come from the
# environment, or the defaults apply.
if [[ -r "$(dirname "${BASH_SOURCE[0]}")/lib.sh" ]]; then
  # shellcheck source=infra/lib.sh
  source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
else
  setting() {
    local value="${!1:-}"
    printf '%s' "${value:-${2:-}}"
  }
fi

keep_last="$(setting RETENTION_KEEP_LAST 8)"
daily="$(setting RETENTION_DAILY 14)"
# 15, because the oldest of them must always be over the 90 days of spec 20.3, whatever day this runs.
weekly="$(setting RETENTION_WEEKLY 15)"
monthly="$(setting RETENTION_MONTHLY 12)"
file_sets="$(setting RETENTION_FILE_SETS 2)"
need_mb="${NEED_MB:-0}"

folder="${1:-}"
if [[ ! -d "$folder" ]]; then
  echo "usage: infra/backup-prune.sh <folder> [db] [config] [files]" >&2
  exit 2
fi
folder="${folder%/}"
shift
if (($# == 0)); then
  set -- db config files
fi
for type in "$@"; do
  case "$type" in
    db | config | files) ;;
    *)
      echo "usage: infra/backup-prune.sh <folder> [db] [config] [files]" >&2
      exit 2
      ;;
  esac
done

# Zero here would mean keeping nothing, so a bad setting stops this script, not the backup that called it.
if [[ ! "$keep_last$file_sets" =~ ^[0-9]+$ || "$keep_last" -lt 1 || "$file_sets" -lt 1 ]]; then
  echo "RETENTION_KEEP_LAST and RETENTION_FILE_SETS must be whole numbers of 1 or more. Nothing was removed." >&2
  exit 2
fi
if [[ ! "$daily$weekly$monthly$need_mb" =~ ^[0-9]+$ ]]; then
  echo "RETENTION_DAILY, RETENTION_WEEKLY and RETENTION_MONTHLY must be whole numbers. Nothing was removed." >&2
  exit 2
fi

# The backups of one type, newest first. The name holds the time, so this order is the order they were taken.
names() {
  ls -1 "$folder" | grep -E "^yap-$1-[0-9]{8}T[0-9]{6}Z[.-].*\.enc$" | LC_ALL=C sort -r
}

newest_proven="$(ls -1 "$folder" | grep -E '^yap-db-.*\.enc\.proven$' | LC_ALL=C sort | tail -n 1)"
newest_proven="${newest_proven%.proven}"

remove() {
  rm -f "$folder/$1" "$folder/$1.sha256" "$folder/$1.proven"
  echo "removed $1"
}

# Reads names, newest first, and prints the ones no rule keeps. Weeks start on Monday: day 0 was a Thursday.
expired_dumps() {
  awk -v last="$keep_last" -v daily="$daily" -v weekly="$weekly" -v monthly="$monthly" '
    function day_number(y, m, d,    era, year_of_era, day_of_year) {
      y -= (m <= 2)
      era = int(y / 400)
      year_of_era = y - era * 400
      day_of_year = int((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
      return era * 146097 + year_of_era * 365 + int(year_of_era / 4) - int(year_of_era / 100) + day_of_year - 719468
    }
    {
      stamp = $0
      sub(/^yap-[a-z]+-/, "", stamp)
      day = substr(stamp, 1, 8)
      month = substr(stamp, 1, 6)
      week = int((day_number(substr(stamp, 1, 4) + 0, substr(stamp, 5, 2) + 0, substr(stamp, 7, 2) + 0) + 3) / 7)
      keep = NR <= last
      if (days_kept < daily && day != last_day) { days_kept++; last_day = day; keep = 1 }
      if (weeks_kept < weekly && week != last_week) { weeks_kept++; last_week = week; keep = 1 }
      if (months_kept < monthly && month != last_month) { months_kept++; last_month = month; keep = 1 }
      if (!keep) print
    }'
}

# Reads names, newest first, and prints everything behind the set that fills the quota.
expired_file_sets() {
  awk -v sets="$file_sets" '
    { if (fulls >= sets) print }
    /-full\./ { fulls++ }'
}

for type in "$@"; do
  if [[ "$type" == "files" ]]; then
    expired="$(names files | expired_file_sets)"
  else
    expired="$(names "$type" | expired_dumps)"
  fi
  for name in $expired; do
    [[ "$name" == "$newest_proven" ]] || remove "$name"
  done
done

free_mb() {
  df -Pk "$folder" | awk 'NR == 2 { print int($4 / 1024) }'
}

# What may go next when the disk is short.
spare() {
  local type oldest
  if (($(names files | grep -c -e '-full\.') >= 2)); then
    names files | LC_ALL=C sort | awk '/-full\./ { fulls++ } fulls < 2 { print }'
    return
  fi
  for type in db config; do
    oldest="$(names "$type" | grep -vxF "${newest_proven:-none}" | tail -n +4 | tail -n 1)"
    if [[ -n "$oldest" ]]; then
      echo "$oldest"
      return
    fi
  done
}

while (($(free_mb) < need_mb)); do
  victims="$(spare)"
  if [[ -z "$victims" ]]; then
    echo "The disk is short of room, and only the backups that must stay are left." >&2
    break
  fi
  echo "The disk is short of room, so this backup goes early:"
  for name in $victims; do
    remove "$name"
  done
done

# What a killed run leaves behind. A run in progress keeps writing, so its files are never a day old.
find "$folder" -maxdepth 1 -type f -name 'yap-*.tmp' -mtime +0 -exec rm -f {} +

for path in "$folder"/yap-*.sha256 "$folder"/yap-*.proven; do
  [[ -e "${path%.*}" ]] || rm -f "$path"
done
# The list of what a set holds is useless once the set is gone. Only the main server has these.
for path in "$folder"/files-manifest-*; do
  [[ -e "$folder/yap-files-${path##*-}-full.tar.gz.enc" ]] || rm -f "$path"
done
exit 0
