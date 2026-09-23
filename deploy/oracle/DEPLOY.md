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
  rejected, a support ticket sometimes revives it. (The card check is a ~$1 ORACLE
  authorization that some banks decline by default — ask the bank to allow it.)
- **The home region is permanent** — you choose it at signup and can never move the
  tenancy. A1 capacity in popular regions (Frankfurt, Ashburn, Phoenix) is chronically
  scarce for free-tier users. Pick a **low-demand region** you can accept the latency
  to (e.g. Marseille, Stockholm, Osaka, Johannesburg — check current chatter before
  choosing); it dramatically improves your odds in step 4.

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

## 3. Choose the edge — how the world reaches the service

The service container never touches a host port; something in front of it does. Two
overlays, picked by `OMR_EDGE` in `deploy/oracle/.env`:

- **`tunnel` — a Cloudflare named tunnel** ([`docker-compose.tunnel.yml`](./docker-compose.tunnel.yml)).
  A `cloudflared` container dials OUT to Cloudflare and serves the hostname from the
  compose network. The VM opens **no port**, mints **no certificate**, and sits behind
  Cloudflare's proxying and whatever rate limit the zone carries; the hostname's CNAME is
  the only thing that moves when the service changes hosts, so the app's URL never
  changes. This is the SolfaScribe instance's choice (2026-09-23): it is the same model
  the home path already runs, and the cutover from the laptop is one DNS flip with the
  reverse as the rollback. It needs a Cloudflare zone for the hostname.
- **`caddy` — Caddy with Let's Encrypt** ([`docker-compose.caddy.yml`](./docker-compose.caddy.yml)).
  Automatic HTTPS on the VM's own ports 80/443, a plain A record. The generic path for
  a host without Cloudflare. Two firewalls to open, a certificate to keep renewing,
  and the VM's IP is the hostname's address.

## 4. Create the instance — expect "out of capacity"

Compute → Instances → **Create instance**:

- **Image**: Ubuntu 24.04 (aarch64).
- **Shape**: `VM.Standard.A1.Flex`, **exactly 2 OCPU and 12 GB memory** — the
  Always-Free ceiling. More is not free; less starves the JVM.
- **Networking**: the default VCN it offers is fine; **assign a public IPv4 address**
  (the tunnel edge needs it only so you can SSH in).
- **SSH keys**: upload your public key (the `.pub` file, e.g. `~/.ssh/id_ed25519.pub`).

The trap: clicking Create frequently fails with **"Out of capacity"**. This is
normal for A1 and can persist for days in busy regions. What works: retry at odd
hours, try every availability domain the region has, and just keep clicking — people
script this, but a few manual retries a day usually lands within a week in a
low-demand region. (This is the main reason step 1 said to pick one.)

## 5. Note the public IP

Instance page → **Public IP address**. Call it `203.0.113.7` below.

## 6. The VCN security list — the console half of the firewall

Traffic to the VM passes **two** firewalls: the VCN security list (Oracle console)
and iptables on the instance (`setup.sh` handles that one). Instance page → its subnet
→ the subnet's **security list** (usually "Default Security List for …"):

- **Both edges**: port **22** already has a rule; tighten its source from `0.0.0.0/0`
  to **your own IP** (`<your-ip>/32`) while you are here.
- **Tunnel edge**: that is all. The connector dials out; nothing inbound is needed.
- **Caddy edge**: **Add Ingress Rules** — source `0.0.0.0/0`, protocol TCP, destination
  port **80** (Let's Encrypt HTTP-01 validation + HTTPS redirect), and the same for
  port **443**.

## 7. Run setup.sh on the VM

```bash
ssh ubuntu@203.0.113.7
curl -fsSL https://raw.githubusercontent.com/James-Aidoo/solfascribe-omr/main/deploy/oracle/setup.sh | sudo bash
```

The first run installs Docker + the compose plugin, enables unattended-upgrades,
clones the repo to `/opt/solfascribe-omr` — then **stops and asks you to create the
`.env` file**. Create it for your edge (`CORS_ORIGIN` is REQUIRED in both: the web
app's origin(s), comma-separated — the service's own default is `*`, a local-dev value
never meant for a public host, security review 2026-09-15):

```bash
# tunnel edge
sudo tee /opt/solfascribe-omr/deploy/oracle/.env >/dev/null <<'EOF'
OMR_EDGE=tunnel
CORS_ORIGIN=https://app.example.com
EOF

# caddy edge
sudo tee /opt/solfascribe-omr/deploy/oracle/.env >/dev/null <<'EOF'
OMR_EDGE=caddy
OMR_DOMAIN=omr.example.com
CORS_ORIGIN=https://app.example.com
EOF
```

Then do step 8 for your edge and run the script again; it is idempotent (re-running
pulls the latest repo and rebuilds). The **first** `docker compose up --build` compiles
Audiveris from source — expect 10–20 minutes.

To update later: `sudo bash /opt/solfascribe-omr/deploy/oracle/setup.sh` again.

## 8a. Tunnel edge — the connector's two files, then the DNS flip

The tunnel is created on a machine that holds your Cloudflare account certificate
(`cloudflared tunnel login` once, with a browser — the home path's README has it), not
on the VM:

```bash
cloudflared tunnel create solfascribe-omr-oci
# → "Tunnel credentials written to ~/.cloudflared/<tunnel-id>.json" and the id
```

The `.json` is a **secret** — move it with `scp`, never paste it anywhere:

```bash
scp ~/.cloudflared/<tunnel-id>.json ubuntu@203.0.113.7:/tmp/
ssh ubuntu@203.0.113.7
sudo mkdir -p /opt/solfascribe-omr/deploy/oracle/cloudflared
sudo mv /tmp/<tunnel-id>.json /opt/solfascribe-omr/deploy/oracle/cloudflared/
sudo cp /opt/solfascribe-omr/deploy/oracle/cloudflared/config.example.yml \
        /opt/solfascribe-omr/deploy/oracle/cloudflared/config.yml
sudo nano /opt/solfascribe-omr/deploy/oracle/cloudflared/config.yml   # the id (twice) and the hostname
sudo bash /opt/solfascribe-omr/deploy/oracle/setup.sh
```

`setup.sh` hands the folder to the connector's own user and starts it; its log must
say `Registered tunnel connection` (`docker compose … logs cloudflared`), and on the
machine with the certificate `cloudflared tunnel info solfascribe-omr-oci` lists the
connector. Nothing serves the hostname yet — the CNAME still points wherever it did.

**The cutover** is one command on the machine with the certificate, and it is also
the rollback (run it with the other tunnel's name):

```bash
cloudflared tunnel route dns --overwrite-dns solfascribe-omr-oci omr.example.com
```

`--overwrite-dns` is what lets it replace a CNAME that already points at another
tunnel. Then step 9.

## 8b. Caddy edge — a hostname the certificate can be minted for

Caddy needs a hostname to get its Let's Encrypt certificate. Either:

- **Your own domain**: add an A record `omr.example.com → 203.0.113.7`, and set
  `OMR_DOMAIN=omr.example.com` in `.env`. If the zone is on Cloudflare, the record must
  be **DNS-only** (grey cloud): HTTP-01 validation and Caddy's own certificate do not
  work through the proxy.
- **No domain — sslip.io fallback**: `OMR_DOMAIN=203.0.113.7.sslip.io`. Any
  `<ip>.sslip.io` name resolves to that IP with zero DNS setup, and HTTP-01
  certificate issuance works against it.

Changed `.env`? `sudo bash setup.sh` again.

## 9. Verify

```bash
curl https://omr.example.com/healthz
# → {"ok":true}
```

If it hangs on the Caddy edge: VCN rule missing (step 6) or iptables not applied
(re-run `setup.sh`); if TLS fails: DNS not propagated yet, or port 80 blocked (HTTP-01
needs it). On the tunnel edge a 502 from Cloudflare means the connector is up but
cannot reach `omr:8480` — `docker compose … ps` should show the service healthy.

Then one **real scan**, and two checks on it, both about things assumed rather than
proven on this image:

- **OCR found its language files**: the exported MusicXML names its parts
  (`<part-name>` is not "Voice") and carries the title. A wordless export with every
  part named "Voice" means Tesseract's models were not where `TESSDATA_PREFIX` says
  (the compose file points it at Ubuntu's package folder) — the engine says nothing
  when they are missing, and the home path lost three days to exactly this.
- **The engine's log is swept**: `docker compose … exec omr find /home/omr -name
  '*.log'` lists nothing. If it lists a log elsewhere, point `AUDIVERIS_LOG_DIR` there
  (the compose file assumes Audiveris's Linux convention).

## 10. Point SolfaScribe at it

On the SolfaScribe side the scan feature is env-gated on the service URL at build
time — `VITE_OMR_SERVICE_URL=https://omr.example.com pnpm build` (or the build
variable in the Cloudflare dashboard). Nothing else to flip: the feature turns itself
on when the URL is present. On the tunnel edge with the hostname the app already
uses, there is nothing to change at all — the CNAME flip in step 8a did it.

## Data handling — what actually happens to uploads

Stated because the consent story depends on it, and verified against the code:

- An uploaded score lives on the VM **only for the job's lifetime**: the client
  deletes the job when it has collected the MusicXML (`DELETE /jobs/:id` removes the
  files immediately), and the TTL sweeper removes anything not collected after
  **20 minutes** (`JOB_TTL_MS`, counted from the moment the conversion ends).
- The uploaded file itself is deleted **the moment its run ends** — the collection
  window holds the MusicXML outputs alone.
- Audiveris writes its own per-run log (it holds the input path and OCR'd lyric
  fragments); with `AUDIVERIS_LOG_DIR` set — the compose file sets it — that log is
  deleted when the run ends (step 9 checks the path).
- The job manifest is **in-memory only** — nothing about a score is written to any
  database or log store. If the container restarts, the service **wipes all leftover
  job files at boot** (the manifest that knew about them is gone, so they would
  otherwise be unreachable orphans on the volume).
- Request logs (container stdout) carry job UUIDs and routes, not score names or
  content.

So the honest user-facing sentence is: *"Your score is uploaded to our conversion
server, processed, and deleted — it exists there for minutes, is never stored
permanently, and is never shared."*
