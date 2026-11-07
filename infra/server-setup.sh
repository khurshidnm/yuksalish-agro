#!/usr/bin/env bash
# Prepares a fresh Ubuntu 24.04 server, once, as root:
#
#   bash infra/server-setup.sh
#
# It is safe to run again: each step looks at what is there first, and existing keys are never replaced.
#
#   - Docker from Docker's own apt repository, with a limit on log size
#   - a firewall that allows SSH, 80 and 443 and nothing else
#   - automatic security updates, with a reboot at 04:30 when a kernel fix needs one
#   - fail2ban for SSH
#   - swap if memory is small, and the kernel settings Redis asks for
#   - the time zone, and a synchronised clock (two-factor codes depend on it)
#   - the backup key and folder, and the cron entry for backups
#   - a watchdog that restarts an API that has frozen, which Docker does not do
#
# Optional settings, from the environment:
#   YAP_AUTO_REBOOT=no   install security updates, but leave rebooting to you
set -euo pipefail
trap 'echo >&2; echo "server-setup stopped at line $LINENO. What it finished stays finished, so fix the problem and run it again." >&2' ERR

if [[ "$EUID" -ne 0 ]]; then
  echo "Run this as root: sudo bash infra/server-setup.sh" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DEBIAN_FRONTEND=noninteractive
# A fresh server is often busy with its first update, so wait for the lock rather than fail.
APT=(apt-get -y -o DPkg::Lock::Timeout=300 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)

# Docker's signing key. The fingerprint is published at docs.docker.com/engine/install/ubuntu.
DOCKER_KEY_FINGERPRINT=9DC858229FC7DD38854AE2D88D81803C0EBFCD88

summary=()
done_step() {
  echo "  $1"
  summary+=("ok       $1")
}
skipped() {
  echo "  SKIPPED: $1"
  summary+=("SKIPPED  $1")
}
step() { printf '\n==> %s\n' "$1"; }

has_systemd() { [[ -d /run/systemd/system ]]; }

check_system() {
  step "Checking the system"
  # shellcheck source=/dev/null
  source /etc/os-release
  if [[ "${ID:-}" != "ubuntu" ]]; then
    echo "This script is for Ubuntu 24.04, and this is ${PRETTY_NAME:-unknown}." >&2
    exit 1
  fi
  if [[ "${VERSION_ID:-}" != "24.04" ]]; then
    echo "  WARNING: written and tested for Ubuntu 24.04, and this is $VERSION_ID. Carrying on."
  fi
  done_step "$PRETTY_NAME, $(dpkg --print-architecture)"
}

install_packages() {
  step "Installing updates and tools"
  "${APT[@]}" update
  "${APT[@]}" upgrade
  "${APT[@]}" install ca-certificates cron curl dnsutils fail2ban git gnupg iproute2 jq logrotate \
    nano openssh-client openssl rsync tzdata ufw unattended-upgrades util-linux
  done_step "System updated and tools installed"
}

configure_time() {
  step "Setting the clock"
  if has_systemd; then
    timedatectl set-timezone Asia/Tashkent
    systemctl enable --now cron > /dev/null
    # Some providers' images use chrony, and installing timesyncd would remove it.
    if systemctl is-active --quiet chrony ntp ntpsec 2> /dev/null; then
      done_step "Time zone Asia/Tashkent, and this server already runs its own time service"
      return
    fi
    "${APT[@]}" install systemd-timesyncd
    if timedatectl set-ntp true; then
      done_step "Time zone Asia/Tashkent, clock synchronised by systemd-timesyncd"
    else
      skipped "Clock synchronisation could not be turned on. Check it with: timedatectl"
    fi
  else
    ln -sf /usr/share/zoneinfo/Asia/Tashkent /etc/localtime
    echo Asia/Tashkent > /etc/timezone
    skipped "Clock synchronisation (no systemd here)"
  fi
}

install_docker() {
  step "Installing Docker"
  if command -v docker > /dev/null 2>&1 && docker compose version > /dev/null 2>&1; then
    done_step "Docker is already installed: $(docker --version)"
    return
  fi
  local package fingerprint
  # Ubuntu's own packages conflict with Docker's.
  for package in docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc; do
    if dpkg -s "$package" > /dev/null 2>&1; then
      "${APT[@]}" remove "$package"
    fi
  done
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  fingerprint="$(gpg --show-keys --with-colons /etc/apt/keyrings/docker.asc | awk -F: '$1 == "fpr" { print $10; exit }')"
  if [[ "$fingerprint" != "$DOCKER_KEY_FINGERPRINT" ]]; then
    rm -f /etc/apt/keyrings/docker.asc
    echo "The key from download.docker.com has the wrong fingerprint: $fingerprint. Stopping." >&2
    exit 1
  fi
  # shellcheck source=/dev/null
  source /etc/os-release
  cat > /etc/apt/sources.list.d/docker.sources <<SOURCES
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
SOURCES
  "${APT[@]}" update
  "${APT[@]}" install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  done_step "Docker installed from Docker's repository: $(docker --version)"
}

configure_docker() {
  step "Configuring Docker"
  local file=/etc/docker/daemon.json settings merged candidate
  # live-restore keeps the containers running while Docker itself restarts or updates. The size limit
  # covers anything started outside the compose files, which set their own. Build cache that would
  # otherwise grow with every update is capped too.
  settings='{"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"5"},"live-restore":true,"builder":{"gc":{"enabled":true,"defaultKeepStorage":"10GB"}}}'
  mkdir -p /etc/docker
  if [[ -s "$file" ]]; then
    merged="$(jq -S --argjson want "$settings" '. * $want' "$file")"
  else
    merged="$(jq -S . <<< "$settings")"
  fi
  if [[ -s "$file" && "$merged" == "$(jq -S . "$file")" ]]; then
    done_step "Docker log limit and live-restore already set"
  else
    candidate="$(mktemp)"
    printf '%s\n' "$merged" > "$candidate"
    # A file Docker cannot read would stop it from starting at all.
    if command -v dockerd > /dev/null 2>&1 && ! dockerd --validate --config-file="$candidate" > /dev/null 2>&1; then
      rm -f "$candidate"
      echo "Docker does not accept the new $file. It was left as it is." >&2
      exit 1
    fi
    mv "$candidate" "$file"
    chmod 644 "$file"
    if has_systemd; then
      # With containers running, a reload is enough, and it keeps them up.
      if [[ -n "$(docker ps -q 2> /dev/null)" ]]; then
        systemctl reload docker
      else
        systemctl restart docker
      fi
    fi
    done_step "Docker logs limited to 5 files of 10 MB for each container, and live-restore is on"
  fi
  if has_systemd; then
    systemctl enable --now docker containerd > /dev/null
    done_step "Docker starts on boot"
  else
    skipped "Starting Docker at boot (no systemd here)"
  fi
}

# Every port sshd listens on, and the one this very session came in on: blocking it would lock you out.
ssh_ports() {
  local ports=""
  if [[ -n "${SSH_CONNECTION:-}" ]]; then
    ports="$(awk '{ print $4 }' <<< "$SSH_CONNECTION")"
  fi
  if command -v sshd > /dev/null 2>&1; then
    mkdir -p /run/sshd
    ports="$ports $(sshd -T 2> /dev/null | awk '$1 == "port" { print $2 }' | tr '\n' ' ')"
  fi
  ports="$(tr -s ' ' '\n' <<< "$ports" | grep -E '^[0-9]+$' | sort -un | tr '\n' ' ' || true)"
  echo "${ports:-22}"
}

configure_firewall() {
  step "Configuring the firewall"
  local port ports
  ports="$(ssh_ports)"
  ports="${ports% }"
  # The firewall only guards what Docker does not publish: Docker's published ports go around it. That
  # is fine here, because only Caddy publishes anything to the outside, on 80 and 443. The web container
  # stays on loopback. deploy.sh warns if anything else ever appears.
  ufw default deny incoming > /dev/null
  ufw default allow outgoing > /dev/null
  for port in $ports; do
    ufw allow "$port/tcp" comment 'SSH' > /dev/null
  done
  ufw allow 80/tcp comment 'HTTP, for certificates and the redirect to HTTPS' > /dev/null
  ufw allow 443/tcp comment 'HTTPS' > /dev/null
  if ufw --force enable > /dev/null 2>&1; then
    done_step "Firewall on: SSH ($ports), 80 and 443 only"
  else
    skipped "Firewall rules written, but it could not start here (it needs a real kernel)"
  fi
}

configure_updates() {
  step "Turning on automatic security updates"
  local reboot=true
  [[ "${YAP_AUTO_REBOOT:-yes}" != "no" ]] || reboot=false
  cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
CONF
  # A kernel fix only counts after a reboot. The containers come back by themselves, and 04:30 keeps
  # clear of the backups at 00:00, 00:30, 06:00 and 06:30, and of the restore check at 03:15.
  cat > /etc/apt/apt.conf.d/52yap-unattended-upgrades <<CONF
Unattended-Upgrade::Automatic-Reboot "$reboot";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
CONF
  if has_systemd; then
    systemctl enable --now unattended-upgrades > /dev/null
    systemctl enable --now apt-daily.timer apt-daily-upgrade.timer > /dev/null
  fi
  done_step "Security updates install by themselves. Reboot when needed: $reboot, at 04:30"
}

configure_fail2ban() {
  step "Turning on fail2ban for SSH"
  local ignore="127.0.0.1/8 ::1" client ports
  ports="$(ssh_ports | tr -s ' ' ',' | sed 's/,$//')"
  # The address you are working from is never banned, so a few mistyped passwords cannot lock you out.
  if [[ -n "${SSH_CONNECTION:-}" ]]; then
    client="$(awk '{ print $1 }' <<< "$SSH_CONNECTION")"
    ignore="$ignore $client"
  fi
  cat > /etc/fail2ban/jail.d/yap.local <<CONF
[DEFAULT]
ignoreip = $ignore
bantime = 1h
findtime = 10m
maxretry = 5

[sshd]
enabled = true
port = $ports
backend = systemd
# All ports, so a ban still works if the SSH port moves later. The app is not affected: Docker's
# published ports do not pass through the chain this ban lives in.
banaction = nftables[type=allports]
CONF
  if has_systemd; then
    systemctl enable fail2ban > /dev/null
    systemctl restart fail2ban
    done_step "fail2ban watches SSH: 5 failures in 10 minutes means a ban of 1 hour"
  else
    skipped "fail2ban configured, but it needs systemd to run"
  fi
}

configure_memory() {
  step "Checking memory and swap"
  local ram_mb free_gb size_gb
  ram_mb="$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo)"
  cat > /etc/sysctl.d/60-yap.conf <<'CONF'
# Redis asks for this, or a background save can fail when memory is short.
vm.overcommit_memory = 1
# Use swap only when memory is really short: the database must not be pushed out.
vm.swappiness = 10
CONF
  if sysctl -q -p /etc/sysctl.d/60-yap.conf > /dev/null 2>&1; then
    done_step "Kernel memory settings applied"
  else
    skipped "Kernel memory settings written, but they could not be applied here"
  fi

  if [[ -n "$(swapon --show --noheadings 2> /dev/null)" ]]; then
    done_step "Swap is already on"
    return
  fi
  if ((ram_mb >= 9000)); then
    done_step "$ram_mb MB of memory, so no swap is needed"
    return
  fi
  free_gb="$(df -Pk / | awk 'NR == 2 { print int($4 / 1048576) }')"
  size_gb=4
  ((free_gb >= 30)) || size_gb=2
  if ((free_gb < 10)); then
    skipped "Swap: only $free_gb GB of disk is free"
    return
  fi
  if [[ ! -f /swapfile ]]; then
    fallocate -l "${size_gb}G" /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=$((size_gb * 1024)) status=none
    chmod 600 /swapfile
    mkswap /swapfile > /dev/null
  fi
  if swapon /swapfile 2> /dev/null; then
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    done_step "Swap file of $(($(stat -c %s /swapfile) / 1073741824)) GB, because this server has $ram_mb MB of memory"
  else
    rm -f /swapfile
    skipped "Swap could not be turned on here (it needs a real kernel)"
  fi
}

configure_backups() {
  step "Preparing backups"
  install -d -m 700 /etc/yap /var/backups/yap
  install -d -m 755 /var/log/yap /var/lib/yap
  done_step "$(BACKUP_PASSPHRASE_FILE=/etc/yap/backup.key "$REPO_ROOT/infra/backup-key.sh" create)"
  if [[ ! -s /etc/yap/backup_ssh_key ]]; then
    ssh-keygen -q -t ed25519 -N '' -C "yap-backup@$(hostname)" -f /etc/yap/backup_ssh_key
    done_step "New SSH key for copying backups off this server"
  else
    done_step "SSH key for backups already there, left as it is"
  fi

  cat > /etc/cron.d/yap-backup <<CRON
# Written by infra/server-setup.sh. Spec 20.3 asks for the database every 6 hours and files daily. Files
# only take what is new, so they run as often as the database, and a lost disk costs 6 hours of both.
# Times are this server's own: Asia/Tashkent.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
0 */6 * * * root $REPO_ROOT/infra/backup-cron.sh db >> /var/log/yap/backup.log 2>&1
30 */6 * * * root $REPO_ROOT/infra/backup-cron.sh files >> /var/log/yap/backup.log 2>&1
15 3 * * * root $REPO_ROOT/infra/backup-cron.sh check >> /var/log/yap/backup.log 2>&1
CRON
  chmod 644 /etc/cron.d/yap-backup
  cat > /etc/logrotate.d/yap <<'CONF'
/var/log/yap/*.log {
  weekly
  rotate 8
  compress
  missingok
  notifempty
}
CONF
  done_step "Backups scheduled in /etc/cron.d/yap-backup"
}

configure_watchdog() {
  step "Installing the watchdog"
  cat > /etc/cron.d/yap-watchdog <<CRON
# Written by infra/server-setup.sh. Docker restarts a dead API, not a frozen one: see infra/watchdog.sh.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
* * * * * root $REPO_ROOT/infra/watchdog.sh >> /var/log/yap/watchdog.log 2>&1
CRON
  chmod 644 /etc/cron.d/yap-watchdog
  done_step "Watchdog scheduled in /etc/cron.d/yap-watchdog: three failed health checks restart the API"
}

check_system
install_packages
configure_time
install_docker
configure_docker
configure_firewall
configure_updates
configure_fail2ban
configure_memory
configure_backups
configure_watchdog

step "Summary"
printf '  %s\n' "${summary[@]}"

cat <<NEXT

Two things to do now:

1. Save the backup key somewhere that is not this server, such as a password manager. Without it no
   backup can ever be read, and if this server dies, this is the only copy:
     cat /etc/yap/backup.key
   Save its fingerprint beside it: $(cat /etc/yap/backup.key.fingerprint)
   Then prove the saved copy, by entering it from where you saved it and not from this screen:
     $REPO_ROOT/infra/backup-key.sh check

2. Give this public key to the machine that will receive the backups (docs/deployment.md, Backups):
     cat /etc/yap/backup_ssh_key.pub

Then create the settings file:
     cd $REPO_ROOT && infra/init-env.sh your.domain.uz
NEXT
if [[ -f /var/run/reboot-required ]]; then
  echo
  echo "Updates installed just now need a reboot. Run: reboot"
fi
