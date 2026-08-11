# Production deploy — Oracle Cloud Always-Free Ampere A1

The production instance runs on an Oracle Cloud **Always-Free Ampere A1** VM:
**2 OCPU / 12 GB RAM, arm64** — the free-tier ceiling since Oracle halved it in
June 2026 (enforced from 2026-08-18). That is enough for this service: one
conversion at a time with a 6 GB JVM heap (the arithmetic is in
[`docker-compose.yml`](./docker-compose.yml)).

This guide is honest about the friction. Oracle's free tier is genuinely free and
genuinely capable, but signup, capacity, and networking each have a trap.

## 1. Create the Oracle Cloud account

Sign up at [oracle.com/cloud/free](https://www.oracle.com/cloud/free/). Two things to
know going in:

- **Fraud review is common.** Perfectly legitimate signups get flagged and sit in a
  manual review queue — sometimes for days, occasionally rejected without a stated
  reason. Use a real name matching the card, a non-VPN connection, and patience. If
  rejected, a support ticket sometimes revives it.
- **The home region is permanent** — you choose it at signup and can never move the
  tenancy. A1 capacity in popular regions (Frankfurt, Ashburn, Phoenix) is chronically
  scarce for free-tier users. Pick a **low-demand region** you can accept the latency
  to (e.g. Marseille, Stockholm, Osaka, Johannesburg — check current chatter before
  choosing); it dramatically improves your odds in step 3.

## 2. Upgrade to Pay-As-You-Go immediately — then set a budget alert

Counter-intuitive but important: **upgrade the account to Pay-As-You-Go right away**
(Billing & Cost Management → Upgrade and Manage Payment). Reasons:

- Always-Free resources on a *trial/free-only* account are subject to **idle
  reclamation** — Oracle deletes underused instances. PAYG accounts keep Always-Free
  resources indefinitely, and the A1 shape at 2 OCPU / 12 GB stays inside the free
  allowance **on any account type**, so the expected bill is zero.
- PAYG accounts also get first pick when A1 capacity is tight.

PAYG means over-limit usage bills real money, so set the guard rail in the same
sitting — **create a budget alert**:

1. Console menu → **Billing & Cost Management → Budgets → Create Budget**.
2. Scope: the root compartment (the whole tenancy). Monthly budget amount: something
   tiny, e.g. **1** (in your billing currency) — you expect to spend 0.
3. Alert rule: **actual spend ≥ 50% of budget**, email to yourself. Add a second rule
   at 100% if you like.

Now anything that starts costing money emails you before it matters.

## 3. Create the instance — expect "out of capacity"

Compute → Instances → **Create instance**:

- **Image**: Ubuntu 24.04 (aarch64).
- **Shape**: `VM.Standard.A1.Flex`, **exactly 2 OCPU and 12 GB memory** — the
  Always-Free ceiling. More is not free; less starves the JVM.
- **Networking**: the default VCN it offers is fine; **assign a public IPv4 address**.
- **SSH keys**: upload your public key.

The trap: clicking Create frequently fails with **"Out of capacity"**. This is
normal for A1 and can persist for days in busy regions. What works: retry at odd
hours, try every availability domain the region has, and just keep clicking — people
script this, but a few manual retries a day usually lands within a week in a
low-demand region. (This is the main reason step 1 said to pick one.)

## 4. Note the public IP

Instance page → **Public IP address**. Call it `203.0.113.7` below.

## 5. Open the VCN security list — the console half of the firewall

Traffic to the VM passes **two** firewalls: the VCN security list (Oracle console)
and iptables on the instance (`setup.sh` handles that one). Do the console half now:

1. Instance page → its subnet → the subnet's **security list** (usually
   "Default Security List for …").
2. **Add Ingress Rules**:
   - Source `0.0.0.0/0`, protocol TCP, destination port **80** (Let's Encrypt HTTP-01
     validation + HTTPS redirect).
   - Source `0.0.0.0/0`, protocol TCP, destination port **443**.
   - Port **22** already has a rule; tighten its source from `0.0.0.0/0` to
     **your own IP** (`<your-ip>/32`) while you are here.

## 6. Run setup.sh on the VM

```bash
ssh ubuntu@203.0.113.7
curl -fsSL https://raw.githubusercontent.com/James-Aidoo/solfascribe-omr/main/deploy/oracle/setup.sh | sudo bash
```

The first run installs Docker + the compose plugin, enables unattended-upgrades,
opens 80/443 in the instance's iptables (Oracle images ship everything-but-22
rejected), clones the repo to `/opt/solfascribe-omr` — then **stops and asks you to
create the `.env` file** with the hostname from step 7. Create it and run the script
again; it is idempotent (re-running pulls the latest repo and rebuilds). The **first**
`docker compose up --build` compiles Audiveris from source — expect 10–20 minutes.

To update later: `sudo bash /opt/solfascribe-omr/deploy/oracle/setup.sh` again.

## 7. Point a hostname at it

Caddy needs a hostname to get its Let's Encrypt certificate. Either:

- **Your own domain**: add an A record `omr.example.com → 203.0.113.7`, and set
  `OMR_DOMAIN=omr.example.com` in `/opt/solfascribe-omr/deploy/oracle/.env`.
- **No domain — sslip.io fallback**: `OMR_DOMAIN=203.0.113.7.sslip.io`. Any
  `<ip>.sslip.io` name resolves to that IP with zero DNS setup, and HTTP-01
  certificate issuance works against it.

Changed `.env`? `sudo bash setup.sh` again (or
`sudo docker compose -f /opt/solfascribe-omr/deploy/oracle/docker-compose.yml up -d`).

## 8. Verify

```bash
curl https://omr.example.com/healthz
# → {"ok":true}
```

If it hangs: VCN rule missing (step 5) or iptables not applied (re-run setup.sh). If
TLS fails: DNS not propagated yet, or port 80 blocked (HTTP-01 needs it).

While you are in `.env` territory: for production, uncomment `CORS_ORIGIN` in
`docker-compose.yml` and set it to the web app's origin — the service ships `*`.

## 9. Point SolfaScribe at it

On the SolfaScribe side the scan feature is already env-gated — the only switch is
the service URL at build time:

```bash
VITE_OMR_SERVICE_URL=https://omr.example.com pnpm build
```

(or set it in the Pages workflow's env). Nothing else to flip — the feature turns
itself on when the URL is present.

## Data handling — what actually happens to uploads

Stated because the consent story depends on it, and verified against the code:

- An uploaded score lives on the VM **only for the job's lifetime**: the client
  deletes the job when it has collected the MusicXML (`DELETE /jobs/:id` removes the
  files immediately), and the TTL sweeper removes anything not collected after
  **15 minutes** (`JOB_TTL_MS`).
- The job manifest is **in-memory only** — nothing about a score is written to any
  database or log store. If the container restarts, the service **wipes all leftover
  job files at boot** (the manifest that knew about them is gone, so they would
  otherwise be unreachable orphans on the volume).
- Request logs (container stdout) carry job UUIDs and routes, not score names or
  content.

So the honest user-facing sentence is: *"Your score is uploaded to our conversion
server, processed, and deleted — it exists there for minutes, is never stored
permanently, and is never shared."*
