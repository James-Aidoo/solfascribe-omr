# Home hosting — the free, no-card path

Run the service on your own machine (plain Node driving a real Audiveris install — no
Docker needed) and publish it at `omr.<your-domain>` through a **Cloudflare named tunnel**
(free; your outbound connection, no ports opened, real HTTPS at the edge).

The honest trade: **the service is up when the machine is.** Right for a pilot where the
operator is also the main user; wrong for serving strangers around the clock — that is
what the [Oracle production path](../oracle/DEPLOY.md) is for.

## One-time setup

1. Install a real Audiveris (the portable/installer build is fine) and note its launcher
   path — no spaces, or point `AUDIVERIS_CMD` at a shim.
2. `cp deploy/home/home.env.example deploy/home/home.env` and fill it in
   (`home.env` is gitignored — machine paths never enter the repo).
3. The tunnel (once, with your browser for the login):

   ```powershell
   cloudflared tunnel login                       # pick your domain's zone
   cloudflared tunnel create solfascribe-omr      # note the tunnel id
   cloudflared tunnel route dns solfascribe-omr omr.<your-domain>
   # copy deploy/home/cloudflared-config.example.yml to %USERPROFILE%\.cloudflared\config.yml
   # and fill in the tunnel id + credentials path
   ```

4. Run both (two terminals, or the scheduled tasks below):

   ```powershell
   powershell -File deploy/home/start-home.ps1    # the service on :8480
   cloudflared tunnel run solfascribe-omr         # the edge connection
   ```

5. Verify from anywhere: `https://omr.<your-domain>/healthz`.

## Auto-start at logon (optional)

Two routes; the Startup folder needs no admin rights:

- **Startup folder** (no admin): drop a `solfascribe-omr.cmd` into
  `shell:startup` that hidden-launches both `start-home.ps1` and
  `cloudflared tunnel run solfascribe-omr` via `Start-Process -WindowStyle Hidden`.
- **Scheduled tasks** (needs an elevated shell):

  ```powershell
  schtasks /Create /TN "solfascribe-omr service" /SC ONLOGON /TR "powershell -WindowStyle Hidden -File <repo>\deploy\home\start-home.ps1"
  schtasks /Create /TN "solfascribe-omr tunnel"  /SC ONLOGON /TR "cloudflared tunnel run solfascribe-omr"
  ```

## Wiring the web app

Set `VITE_OMR_SERVICE_URL=https://omr.<your-domain>` in the web app's build environment
and redeploy — the PDF door lights up. Retention on the home machine is the service's own
discipline: per-job files, a 15-minute TTL sweep, and a boot-time orphan wipe.
