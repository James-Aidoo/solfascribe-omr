#!/usr/bin/env bash
# One-shot (and safely re-runnable) setup for the production OMR VM:
# Oracle Cloud Ampere A1, Ubuntu 24.04, arm64. Run as root: sudo bash setup.sh
#
#   1. Docker Engine + compose plugin (Docker's official apt repo — arm64 native)
#   2. unattended-upgrades, so the box patches itself
#   3. Instance firewall: open 80/443 in iptables and persist the rules
#   4. Clone (or update) this repo and `docker compose up -d --build`
#
# ┌────────────────────────────────────────────────────────────────────────────────┐
# │ FIREWALL — THIS SCRIPT IS ONLY HALF OF IT.                                     │
# │ Oracle's Ubuntu images ship restrictive iptables rules (everything but 22      │
# │ rejected) — handled below. But traffic is ALSO filtered by the VCN security    │
# │ list in the Oracle console, which this script cannot touch: you must add       │
# │ ingress rules for TCP 80 and 443 there too, or nothing reaches the VM.        │
# │ See DEPLOY.md step 5.                                                          │
# └────────────────────────────────────────────────────────────────────────────────┘

set -euo pipefail

REPOSITORY_URL="https://github.com/James-Aidoo/solfascribe-omr.git"
CHECKOUT_DIRECTORY="/opt/solfascribe-omr"
COMPOSE_FILE="${CHECKOUT_DIRECTORY}/deploy/oracle/docker-compose.yml"
ENVIRONMENT_FILE="${CHECKOUT_DIRECTORY}/deploy/oracle/.env"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo bash $0" >&2
  exit 1
fi

echo "== 1/4 Docker Engine + compose plugin =="
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  echo "already installed: $(docker --version)"
else
  apt-get update
  apt-get install -y ca-certificates curl git
  install -m 0755 -d /etc/apt/keyrings
  if [ ! -f /etc/apt/keyrings/docker.asc ]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
  fi
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${VERSION_CODENAME}") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
fi

echo "== 2/4 unattended-upgrades =="
apt-get install -y unattended-upgrades
# The stock 20auto-upgrades already enables the daily security run; make sure it exists.
if [ ! -f /etc/apt/apt.conf.d/20auto-upgrades ]; then
  printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' \
    > /etc/apt/apt.conf.d/20auto-upgrades
fi
systemctl enable --now unattended-upgrades

echo "== 3/4 instance firewall: allow 80/443 (Oracle images reject them by default) =="
for port in 80 443; do
  # Idempotent: -C checks for the exact rule before -I inserts it. Insert at the TOP of
  # INPUT — Oracle's shipped ruleset ends in a blanket REJECT, so appending would bury
  # the rule behind it.
  if ! iptables -C INPUT -p tcp --dport "${port}" -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null; then
    iptables -I INPUT -p tcp --dport "${port}" -m conntrack --ctstate NEW -j ACCEPT
    echo "opened tcp/${port}"
  else
    echo "tcp/${port} already open"
  fi
done
# Persist across reboots. Oracle's Ubuntu images ship netfilter-persistent; install it
# if this box somehow lacks it (preseed the debconf prompts for a non-interactive run).
if ! command -v netfilter-persistent >/dev/null 2>&1; then
  echo iptables-persistent iptables-persistent/autosave_v4 boolean true | debconf-set-selections
  echo iptables-persistent iptables-persistent/autosave_v6 boolean true | debconf-set-selections
  apt-get install -y iptables-persistent
fi
netfilter-persistent save
echo "REMINDER: the Oracle VCN security list must ALSO allow ingress TCP 80/443 (console work — DEPLOY.md step 5)."

echo "== 4/4 repo + compose up =="
if [ -d "${CHECKOUT_DIRECTORY}/.git" ]; then
  git -C "${CHECKOUT_DIRECTORY}" pull --ff-only
else
  git clone "${REPOSITORY_URL}" "${CHECKOUT_DIRECTORY}"
fi
if [ ! -f "${ENVIRONMENT_FILE}" ]; then
  cat >&2 <<MESSAGE

${ENVIRONMENT_FILE} is missing. Create it with the hostname Caddy should serve:

    echo 'OMR_DOMAIN=omr.example.com' > ${ENVIRONMENT_FILE}

(or, without a domain, the sslip.io form: OMR_DOMAIN=<this-VM-public-IP>.sslip.io)
Then re-run this script — it is safe to repeat.
MESSAGE
  exit 1
fi
docker compose -f "${COMPOSE_FILE}" up -d --build

echo
echo "Done. First image build takes a while (Audiveris compiles from source)."
echo "Check:  docker compose -f ${COMPOSE_FILE} ps"
echo "Then:   curl https://\$(grep -oP '(?<=OMR_DOMAIN=).*' ${ENVIRONMENT_FILE})/healthz"
