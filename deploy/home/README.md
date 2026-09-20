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

## Keep the machine safe — read this before publishing the tunnel

The service runs a Java OMR engine with **native PDF and image decoders on whatever the
internet uploads**, and the security review of 2026-09-15 rated running it under your own
account the one critical finding in the estate. Three things, in order:

1. **Run it under an account with nothing to lose.** Create a standard (non-administrator)
   local user — Settings → Accounts → Other users → Add — and run `start-home.ps1` and
   the Audiveris install as that user. Your own profile, browser sessions and the tunnel
   credentials in `%USERPROFILE%\.cloudflared` are then out of the engine's reach. The
   recipe that works on Windows 11, from an admin PowerShell (`omr` is the account):

   ```powershell
   schtasks /Create /TN "SolfaScribe OMR" /SC ONSTART /RU omr /RP * /RL LIMITED /TR "cmd /c powershell -NoProfile -ExecutionPolicy Bypass -File D:\solfascribe-omr\deploy\home\start-home.ps1 > D:\solfascribe-omr\deploy\home\omr-service.log 2>&1"
   schtasks /Run /TN "SolfaScribe OMR"
   schtasks /Query /TN "SolfaScribe OMR" /V /FO LIST | Select-String "Status|Last Result"   # 267009 = running
   ```

   Three things a standard account lacks, each of which stopped the task once: it needs
   the **"Log on as a batch job"** right (`secpol.msc` → Local Policies → User Rights
   Assignment → add the user; `schtasks /Create` warns "Batch logon privilege needs to be
   enabled" without it), its PowerShell refuses script files until the action carries
   **`-ExecutionPolicy Bypass`**, and its profile is unreadable from your account, so
   point the task's log at a folder both can read. Set `AUDIVERIS_LOG_DIR` in `home.env`
   to THAT user's `%APPDATA%\AudiverisLtd\audiveris\log`, and keep `cloudflared` under
   your own account (its Startup entry then starts only the tunnel). Alternatively run
   the repo's Docker image (it already runs as an unprivileged user) with only
   `127.0.0.1:8480` published, and keep `cloudflared` on the host.

   **The OCR language files must be reachable by that account.** Audiveris reads Tesseract's
   `*.traineddata` from the profile's `AppData\Roaming\AudiverisLtdudiveris\config	essdata`
   — a folder the new account does not have — and says nothing when it finds none: every
   scan then exports no lyrics, no credits and every part named "Voice" (2026-09-20, three
   days of it). Put the standard `tessdata` models (never `tessdata_best`) in a folder every
   account can read and set `TESSDATA_PREFIX=<that folder>` in `home.env`; the engine honours
   it. The check: an export whose parts are all named "Voice" has no OCR.

2. **Bind to loopback.** The service now defaults to `HOST=127.0.0.1`; the tunnel dials
   `localhost:8480`, so nothing needs a wider bind. Remove any Windows Firewall inbound
   rule that allowed `node.exe` on the Public profile (Windows Defender Firewall →
   Advanced settings → Inbound Rules → "Node.js JavaScript Runtime" → Disable or Delete):
   with the old `0.0.0.0` bind that rule let any LAN the laptop joined reach the service
   directly, around Cloudflare.
3. **Rate-limit at the edge.** Cloudflare → the zone → Security → Security rules → Rate
   limiting rules: hostname `omr.<your-domain>`, path starts with `/jobs`, method `POST`,
   more than 5 requests per 10 seconds per IP → Block. A conversion takes minutes; no
   reader posts five in ten seconds. (On the Free plan the zone allows ONE rate-limiting
   rule; if the till's rule already uses it, widen that rule's hostname expression to
   cover both hosts instead.)

Also set `AUDIVERIS_LOG_DIR` in `home.env` to Audiveris's own log directory —
`%APPDATA%\AudiverisLtd\audiveris\log` on Windows — so each run's engine log (it holds
the input path and OCR'd lyric fragments) is deleted when the run ends. Delete what is
already there once by hand: that directory kept a log per run since the service went live.
`OMR_JAVA_MAX_HEAP` does not reach the jpackage `Audiveris.exe` launcher (only the Gradle
start script reads `AUDIVERIS_OPTS`), and neither does `JAVA_TOOL_OPTIONS`: the launcher
bakes `-Xmx8G` into `app/Audiveris.cfg`, the JVM parses `JAVA_TOOL_OPTIONS` first and the
command line last, so the 8 GB wins — while the "Picked up JAVA_TOOL_OPTIONS" line prints
regardless (a false confirmation). `_JAVA_OPTIONS` is parsed AFTER the command line and
does win: set `_JAVA_OPTIONS=-Xmx6g` in `home.env`. Prove it once against the bundled
runtime — `$env:_JAVA_OPTIONS='-Xmx6g'; & '<Audiveris>\runtime\bin\java.exe' -Xmx8G
-XX:+PrintFlagsFinal -version | Select-String MaxHeapSize` must print `6442450944`.
(Editing the `java-options` line in `app/Audiveris.cfg` is the other way.)

## Wiring the web app

Set `VITE_OMR_SERVICE_URL=https://omr.<your-domain>` in the web app's build environment
and redeploy — the PDF door lights up. Retention on the home machine is the service's own
discipline: the upload deleted when its run ends, per-job outputs, a 20-minute TTL sweep,
the engine's log swept per run (with `AUDIVERIS_LOG_DIR` set), and a boot-time orphan
wipe.
