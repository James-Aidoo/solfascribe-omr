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

A brand-new account can spend its first hours (sometimes a day) behind a banner reading
"Your account provisioning is in progress", with the upgrade page hidden until it clears.
Do not wait for it: Always Free works on the un-upgraded account, so create the instance
(step 4) first and come back here when the banner is gone. The upgrade itself takes
Oracle a day or two to confirm by email; the card sees a ~$100 authorization that is
reversed at once.

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

## 4. Create the instance — the network first, then the machine

The console's create-instance wizard offers to make a network inline, but with that
choice its public-address toggle is greyed out ("You must select a public subnet to
assign a public IPv4 address" — the form cannot inspect a subnet that does not exist
yet), and the plain "Create VCN" dialog makes an empty shell with no gateway and no
subnets. So, as lived on 2026-09-23:

**4a. The network, with the VCN wizard.** Menu → Networking → Virtual cloud networks →
**Start VCN Wizard** → **Create VCN with Internet Connectivity** → Start VCN Wizard.
Name it (say `solfascribe-vcn`), keep every default (10.0.0.0/16, a public and a private
subnet, DNS on, no tags) → Next → Create. It builds the VCN, an internet gateway, the
route table and the default security list (port 22 open) in one go.

**4b. The machine.** Menu → Compute → Instances → **Create instance**, a wizard of five
sections:

- **Basic information**: a name; leave the compartment and the availability domain. In
  _Image and shape_ click **Change shape FIRST**: Virtual machine → Ampere →
  `VM.Standard.A1.Flex`, **exactly 2 OCPUs and 12 GB** (the "Always Free-eligible" label
  shows; more is not free, less starves the JVM). Then **Change image**: **Canonical
  Ubuntu 24.04** — the plain family row, not "Minimal". The row holds both processor
  builds and the console picks the aarch64 one for the shape you set (expand the row's
  triangle to see the build's name; only the Minimal edition is listed per processor).
  Leave the _Advanced options_ (metadata service, cloud-init, agents) alone.
- **Security**: both switches off.
- **Networking**: give the VNIC a name; **Select existing virtual cloud network** → the
  wizard's VCN → the subnet whose name begins with "public subnet"; switch
  **Automatically assign public IPv4 address** ON (it is live now); IPv6 off. Under
  **Add SSH keys** choose **Paste public keys** and paste your `.pub` line (e.g. the
  content of `~/.ssh/id_ed25519.pub`) — not "Generate a key pair for me", which hands
  the private key to the browser instead of the machine you will SSH from.
- **Storage**: defaults (the ~50 GB boot volume is inside the free 200 GB).
- **Review**: shape 2 OCPU / 12 GB, image Ubuntu 24.04 aarch64, public IPv4 yes →
  **Create**. "Provisioning" turns to "Running" within a couple of minutes.

The trap: clicking Create can fail with **"Out of capacity"**. This is normal for A1
and can persist for days in busy regions. Oracle's own remedies, in order: another
availability domain (if the region has more than one), wait and retry (odd hours, a few
times a day), and the Pay-As-You-Go upgrade of step 2. The wizard keeps your entries
when you go back, so a retry is one more click. (This is the main reason step 1 said to
pick a low-demand region.)

## 5. Note the public IP

Instance page → **Public IP address**. Call it `203.0.113.7` below.

## 6. The VCN security list — the console half of the firewall

Traffic to the VM passes **two** firewalls: the VCN security list (Oracle console)
and iptables on the instance (`setup.sh` handles that one). Instance page → its subnet
→ the subnet's **security list** (usually "Default Security List for …"):

- **Both edges**: port **22** already has a rule open to the world. Narrow its source to
  `<your-ip>/32` ONLY if your address is fixed. On a connection whose public address
  rotates without notice (carrier-grade NAT: Starlink, most mobile and many home ISPs)
  that rule locks you out at the next rotation, with the console's serial connection as
  the only way back. Leave it open otherwise — Oracle's Ubuntu images take keys only,
  never passwords, and the tunnel edge exposes nothing else.
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
Audiveris from source — expect 15–30 minutes on the 2-OCPU A1.

Two things a fresh box does: right after first boot it may still be running its own
updates, and the script stops on "Could not get lock" / "Waiting for cache lock" — wait
two minutes and run it again; and if the SSH session drops during the build, the build
dies with it — reconnect and run the script again, Docker keeps every finished layer
and resumes from there.

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
machine with the certificate `cloudflared tunnel info <tunnel-id>` lists a
`linux_arm64` connector at the VM's address. Nothing serves the hostname yet — the
CNAME still points wherever it did.

**Address tunnels by id, never by name**, in every cloudflared command. The laptop's
cloudflared 2026.7.2 resolved the NAME `solfascribe-omr-oci` to the older
`solfascribe-omr` tunnel (2026-09-23): `tunnel info` printed the wrong tunnel's
connector, and `route dns` reported the hostname "already configured" and wrote
nothing — both looking like success. `cloudflared tunnel list` prints the ids, and the
NAME line of `tunnel info <id>` is the check that the id was the right one.

**The cutover** is one command on the machine with the certificate, and it is also
the rollback (run it with the other tunnel's id):

```bash
cloudflared tunnel route dns --overwrite-dns <tunnel-id> omr.example.com
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
cannot reach `omr:8480` — `docker compose … ps` should show the service healthy — and
a Cloudflare error 1033 means no connector is registered for the tunnel the CNAME
names (wrong id in step 8a, or the connector is down).

Then one **real scan** of a score with words under the notes, and two checks on it.
Both were assumptions until 2026-09-24, when the first Oracle scans failed both:

- **OCR works**: the scan shows its lyrics, and the exported MusicXML names its parts
  (`<part-name>` is not "Voice") and carries the title. A wordless result means the
  engine could not use its language file, and the engine's own log says so in ONE line
  — `TesseractOrder. Could not initialize TessBaseAPI languages: eng in legacy mode` —
  with nothing else complaining. Audiveris runs Tesseract in legacy mode, so the file
  must come from the `tesseract-ocr/tessdata` repository; the image fetches exactly
  that one, pinned and checksummed (Dockerfile). Ubuntu's `tesseract-ocr-eng` package,
  which the first image installed instead, ships the LSTM-only "fast" model, and the
  legacy engine refuses it. The engine's log on a failing box is under the folder the
  next check names.
- **The engine's log is swept**: from `deploy/oracle/`,
  `sudo docker compose -f docker-compose.yml -f docker-compose.tunnel.yml exec omr find /home/omr -name '*.log'`
  lists nothing. Run it from that directory: from anywhere else compose finds no file
  and the command prints nothing either, so an empty answer means something only
  there. Audiveris on Linux writes its per-run log under
  `~/.cache/AudiverisLtd/audiveris/log/`, which is what `AUDIVERIS_LOG_DIR` names; the
  data-home path first assumed there swept nothing.

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
