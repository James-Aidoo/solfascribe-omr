#!/usr/bin/env bash
# One-shot (and safely re-runnable) setup for the production OMR VM:
# Oracle Cloud Ampere A1, Ubuntu 24.04, arm64. Run as root: sudo bash setup.sh
#
#   1. Docker Engine + compose plugin (Docker's official apt repo — arm64 native)
#   2. unattended-upgrades, so the box patches itself
#   3. Clone (or update) this repo; read deploy/oracle/.env — OMR_EDGE picks the edge
#   4. The edge's own needs: iptables 80/443 for Caddy; the connector's files for the tunnel
#   5. `docker compose up -d --build` with the edge's overlay
#
# ┌────────────────────────────────────────────────────────────────────────────────┐
# │ FIREWALL — THIS SCRIPT IS ONLY HALF OF IT (Caddy edge).                        │
# │ Oracle's Ubuntu images ship restrictive iptables rules (everything but 22      │
# │ rejected) — handled below for OMR_EDGE=caddy. But traffic is ALSO filtered by  │
# │ the VCN security list in the Oracle console, which this script cannot touch:   │
# │ for the Caddy edge you must add ingress rules for TCP 80 and 443 there too, or │
# │ nothing reaches the VM. The tunnel edge needs NEITHER: the connector dials out. │
# │ See DEPLOY.md step 6.                                                          │
# └────────────────────────────────────────────────────────────────────────────────┘

set -euo pipefail

REPOSITORY_URL="https://github.com/James-Aidoo/solfascribe-omr.git"
CHECKOUT_DIRECTORY="/opt/solfascribe-omr"
DEPLOY_DIRECTORY="${CHECKOUT_DIRECTORY}/deploy/oracle"
BASE_COMPOSE_FILE="${DEPLOY_DIRECTORY}/docker-compose.yml"
ENVIRONMENT_FILE="${DEPLOY_DIRECTORY}/.env"
CONNECTOR_DIRECTORY="${DEPLOY_DIRECTORY}/cloudflared"
# The cloudflared image runs its connector as this unprivileged user; the mounted config and
# credentials must be readable by it and by nobody else on the VM.
CONNECTOR_UID=65532

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo bash $0" >&2
  exit 1
fi

echo "== 1/5 Docker Engine + compose plugin =="
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

echo "== 2/5 unattended-upgrades =="
apt-get install -y unattended-upgrades
# The stock 20auto-upgrades already enables the daily security run; make sure it exists.
if [ ! -f /etc/apt/apt.conf.d/20auto-upgrades ]; then
  printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' \
    > /etc/apt/apt.conf.d/20auto-upgrades
fi
systemctl enable --now unattended-upgrades

echo "== 3/5 repo + the edge choice =="
if [ -d "${CHECKOUT_DIRECTORY}/.git" ]; then
  git -C "${CHECKOUT_DIRECTORY}" pull --ff-only
else
  git clone "${REPOSITORY_URL}" "${CHECKOUT_DIRECTORY}"
fi
if [ ! -f "${ENVIRONMENT_FILE}" ]; then
  cat >&2 <<MESSAGE

${ENVIRONMENT_FILE} is missing. Create it with the edge that reaches the service and the
web app's origin(s) — then re-run this script; it is safe to repeat.

  A Cloudflare named tunnel (no port opened, no certificate — DEPLOY.md step 8a):
    OMR_EDGE=tunnel
    CORS_ORIGIN=https://app.example.com

  Caddy with Let's Encrypt on the VM's own 80/443 (DEPLOY.md step 8b):
    OMR_EDGE=caddy
    OMR_DOMAIN=omr.example.com          # or <this-VM-public-IP>.sslip.io
    CORS_ORIGIN=https://app.example.com
MESSAGE
  exit 1
fi
EDGE="$(grep -oP '(?<=^OMR_EDGE=).*' "${ENVIRONMENT_FILE}" | tr -d '[:space:]' || true)"
EDGE="${EDGE:-caddy}"
case "${EDGE}" in
  caddy | tunnel) echo "edge: ${EDGE}" ;;
  *)
    echo "OMR_EDGE=${EDGE} in ${ENVIRONMENT_FILE} — it must be 'tunnel' or 'caddy'." >&2
    exit 1
    ;;
esac
OVERLAY_COMPOSE_FILE="${DEPLOY_DIRECTORY}/docker-compose.${EDGE}.yml"

echo "== 4/5 the edge's own needs =="
if [ "${EDGE}" = "caddy" ]; then
  echo "instance firewall: allow 80/443 (Oracle images reject them by default)"
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
  echo "REMINDER: the Oracle VCN security list must ALSO allow ingress TCP 80/443 (console work — DEPLOY.md step 6)."
else
  echo "the connector's files"
  if [ ! -f "${CONNECTOR_DIRECTORY}/config.yml" ] || ! ls "${CONNECTOR_DIRECTORY}"/*.json >/dev/null 2>&1; then
    cat >&2 <<MESSAGE

${CONNECTOR_DIRECTORY}/ needs the connector's two files (DEPLOY.md step 8a):
  config.yml        — copy config.example.yml beside it and fill in the tunnel id + hostname
  <tunnel-id>.json  — the credentials \`cloudflared tunnel create\` wrote on the machine that
                      holds your account certificate; copy it here with scp, never paste it
Then re-run this script.
MESSAGE
    exit 1
  fi
  # The connector (uid 65532 in its image) must read them; nobody else on the VM should.
  chown -R "${CONNECTOR_UID}:${CONNECTOR_UID}" "${CONNECTOR_DIRECTORY}"
  chmod 700 "${CONNECTOR_DIRECTORY}"
  chmod 600 "${CONNECTOR_DIRECTORY}"/*.json
  chmod 644 "${CONNECTOR_DIRECTORY}/config.yml"
  echo "connector files in place, readable by the connector alone"
fi

echo "== 5/5 compose up (${EDGE} edge) =="
docker compose -f "${BASE_COMPOSE_FILE}" -f "${OVERLAY_COMPOSE_FILE}" up -d --build

echo
echo "Done. First image build takes a while (Audiveris compiles from source)."
echo "Check:  docker compose -f ${BASE_COMPOSE_FILE} -f ${OVERLAY_COMPOSE_FILE} ps"
if [ "${EDGE}" = "caddy" ]; then
  echo "Then:   curl https://$(grep -oP '(?<=^OMR_DOMAIN=).*' "${ENVIRONMENT_FILE}")/healthz"
else
  echo "Then:   docker compose -f ${BASE_COMPOSE_FILE} -f ${OVERLAY_COMPOSE_FILE} logs cloudflared   # 'Registered tunnel connection'"
  echo "        and, once the hostname routes to this tunnel, curl https://<hostname>/healthz"
fi
