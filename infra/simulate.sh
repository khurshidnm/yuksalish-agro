#!/usr/bin/env bash
# A simulated flock for a demo farm: every sheep wears a GPS collar and a rumen bolus, and their
# messages arrive as a LoRaWAN network server would post them (docs/tracking.md). Run it as root:
#
#   infra/simulate.sh start     fit the trackers, fill a week of history, then post live, day and night
#   infra/simulate.sh status    whether it runs, what it fitted, what arrived in the last hour
#   infra/simulate.sh logs      follow what the flock is doing
#   infra/simulate.sh stop      stop posting; the trackers and readings stay
#   infra/simulate.sh remove    stop, and take every simulated tracker and reading away
#
# It invents readings. Never start it on a farm that has real trackers, and remove it before real
# ones arrive. It survives reboots, and each deploy moves a running one to the new image. SIM_HISTORY_DAYS
# (1 to 7), SIM_MEM_LIMIT and SIM_HEAP_MB in .env.production tune it.
set -uo pipefail

# shellcheck source=infra/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$YAP_ROOT" || exit 1

sim() { compose --profile simulation "$@"; }
cli() { sim run --rm --no-deps -T tracking-sim tsx src/modules/tracking/simulator/cli.ts "$@"; }

case "${1:-}" in
  start)
    if ! sim up -d --no-build --no-deps tracking-sim; then
      echo "Could not start the simulator. Is the stack up? infra/status.sh" >&2
      exit 1
    fi
    echo "The simulator is starting. The first time it fills a week of history, which takes several minutes."
    echo "Follow it: infra/simulate.sh logs"
    ;;
  status)
    id="$(sim ps -q tracking-sim 2> /dev/null | head -n 1)"
    if [[ -n "$id" ]]; then
      echo "Running since $(docker inspect -f '{{.State.StartedAt}}' "$id" 2> /dev/null)."
    else
      echo "Not running."
    fi
    cli status
    ;;
  logs)
    sim logs --tail 50 -f tracking-sim
    ;;
  stop)
    sim stop tracking-sim && sim rm -f tracking-sim > /dev/null
    echo "Stopped. The simulated trackers and their readings stay until: infra/simulate.sh remove"
    ;;
  remove)
    sim stop tracking-sim > /dev/null 2>&1
    sim rm -f tracking-sim > /dev/null 2>&1
    cli remove
    ;;
  *)
    echo "usage: infra/simulate.sh start | status | logs | stop | remove" >&2
    exit 2
    ;;
esac
