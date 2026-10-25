---
title: SolfaScribe OMR
emoji: 🎼
colorFrom: red
colorTo: yellow
sdk: docker
app_port: 8480
pinned: false
---

# solfascribe-omr

A thin, self-hostable **optical music recognition service**: a PDF or image score goes
in, raw MusicXML comes out. It is [Audiveris](https://github.com/Audiveris/audiveris) in
a box, plus the operational lessons of running a real 29-score corpus through it —
and deliberately nothing more. No post-processing, no musical opinions: whatever a
client does with the MusicXML is the client's business.

Built as the conversion companion of [SolfaScribe](https://github.com/James-Aidoo/SolfaScribe)
(staff notation → tonic sol-fa), but it speaks plain HTTP and MusicXML — any client works.

## What "the operational lessons" means

- **Movement splits are surfaced, never swallowed.** Audiveris sometimes splits a book at
  a page break it can't bridge and exports several `.mvtN.mxl` files. The job manifest
  lists every movement; a naive wrapper returning "the file" silently loses whole pieces.
- **Per-sheet salvage.** Audiveris refuses to export a whole book when one page fails.
  When the log names the broken sheets, the service retries once on the healthy pages and
  reports `excludedSheets` — so the client can tell its user exactly which pages are
  missing instead of failing the whole score.
- **Honest failure classes.** `rhythm-analysis-abort` (Audiveris's own rhythm step gave
  up — no retry can help), `unreadable-input`, `page-too-large` (below), `timeout`,
  `omr-failed` — each with a log tail for diagnosis.
- **A measured, minimal tuned invocation.** Every run whose pages fit (next point) passes
  `-constant org.audiveris.omr.image.ImageLoading.pdfResolution=400` (PDF rasterization
  at 400 DPI instead of Audiveris's default 300 — the engine's own recommendation for
  small symbols). It was the single winner of an A/B sweep over real corpus scores
  (2026-08-14): bar-length misreads down (13→4 on one score, 27→25 on the other), fewer
  downstream diagnostics, more lyrics attached to notes, at the cost of ~40–70% longer
  runs. Six other candidate options (lyrics-above-staff, implicit tuplets, shared-head
  dots, global binarization, poor-input profile, explicit OCR language) measured neutral
  or worse and are deliberately NOT set — the rationale lives with the constant in
  `src/audiveris.ts`.
- **Large pages are read at a fitted resolution, never refused for their size alone.**
  Audiveris refuses any sheet whose image is over 20,000,000 pixels
  (`org.audiveris.omr.step.LoadStep.maxPixelCount`) — and with every sheet refused it exports
  nothing. At 400 DPI an A4 or Letter page is 15–16 MP and fits, but an A3 page is 31 MP,
  Tabloid 30 MP, and the 12.6 × 16.6 in scan that found this (#14) 33.6 MP. So the service
  reads each PDF's page sizes before the run and picks ONE resolution for the book:
  - every page fits at 400 DPI → 400, exactly as before (ordinary scores see no change);
  - otherwise → the highest whole DPI at which the **largest** page fits, down to **300**,
    and the job's `notes` say so ("…read at 308 DPI instead of 400…");
  - a page that would not fit even at 300 DPI (over about 222 square inches — larger
    than 13 × 17 in; a poster, say) → the job fails at once as `page-too-large`, naming the page size, before the
    engine is spawned.

  Why fitting the DPI rather than raising the engine's pixel limit: both were measured on
  that score (2026-10-25, Audiveris 5.11.0, the production VM, scored with SolfaScribe's
  own checks). At 308 DPI it read the same 41 bars and 503 notes as at 400 DPI with the
  limit raised to 34 MP, with 3 bar-length misreads against 4, 212 lyric syllables against
  215 — and took 173 s against 405 s, at a 1.7 GB peak against 2.6 GB. Twice the time buys
  nothing, and on a large-format book it is the difference between finishing inside the
  15-minute budget and not. The floor is 300 because below it the engine reads small
  symbols worse (its own guidance) and because the declared MusicXML scale tracks
  300 / DPI, which SolfaScribe's lyric fitter only searches from 0.7 to 1.2 — 300–400 DPI
  stays inside that range. Should the size scan miss a page (a box held by reference),
  the engine's own "Too large image: N pixels" refusal is caught and the book retried once
  at the resolution N implies; an IMAGE upload over the limit fails as `page-too-large`
  (no DPI setting shrinks an image). The arithmetic and its tests: `src/pageRaster.ts`,
  `test/pageRaster.test.ts`.

## API

| Route | Meaning |
| ----- | ------- |
| `POST /jobs` (multipart file) | Submit a score → `202 { jobId }` (conversion is async; scores take seconds to minutes) |
| `GET /jobs/:id` | `{ status, scoreName, movements[], excludedSheets?, notes?, failure?, logTail? }` — `notes` are sentences for the user about how the score was read (today: a lowered resolution for large pages) |
| `GET /jobs/:id/files/:name` | One movement's MusicXML bytes |
| `DELETE /jobs/:id` | Remove the job and its files immediately |

## Privacy

Uploads are **transient by design**: the uploaded file is deleted the moment its
conversion ends; the outputs live only until the client deletes the job or the TTL sweeper
does (default 20 minutes); the service wipes any orphaned job files at boot and sweeps
directories no job owns on every pass. **Audiveris keeps its own per-run log** (holding the
input path and OCR'd text) in its user data directory — set `AUDIVERIS_LOG_DIR` to that
directory and the service deletes each run's log when the run ends; leave it unset and
that log outlives every job, which you must then say in your privacy statement. Nothing
else is retained, logged beyond an in-memory manifest, or sent anywhere. Failure details
and log tails have the machine's own paths (work root, engine install, home directory)
redacted before they leave the service. If you host this for others, say the same to your
users — the scores are theirs.

## Running

```bash
docker build -t solfascribe-omr .
docker run -p 8480:8480 solfascribe-omr
```

Or directly against a local Audiveris install (development):

```bash
npm install
AUDIVERIS_CMD="/path/to/Audiveris" npm start
```

Configuration (environment): `AUDIVERIS_CMD`, `HOST` (`127.0.0.1` — the service binds to
loopback unless told otherwise; the Docker image sets `0.0.0.0`, where the container is the
boundary), `PORT` (8480), `OMR_TIMEOUT_MS` (15 min — sized for the tuned 400-DPI
rasterization, which runs ~40-70% longer than the old 300), `JOB_TTL_MS` (20 min),
`WORK_ROOT`, `CORS_ORIGIN` (`*`; comma-separated for several origins), `MAX_UPLOAD_MB`
(40), `MAX_PDF_PAGES` (60 — a PDF whose page objects count past the cap is refused with 422; the
count is a plain scan of the file, which a PDF that packs its pages into object streams
under-counts, so the cap is a guard against the honest large book, not a bound; a book
rasterized at 400 DPI is the one input that can push the engine's heap past a small
host), `OMR_CONCURRENCY` (1 — OMR is memory-hungry; raise it only with the RAM to match),
`MAX_QUEUED_JOBS` (25 — a full queue answers 429), `MAX_LIVE_JOBS` (40 — jobs in any
state, finished ones included, so fast-failing uploads cannot fill the disk through the
queue cap), `AUDIVERIS_LOG_DIR` (unset — the engine's own log directory, swept after every
run; see Privacy), `OMR_JAVA_MAX_HEAP` (unset — caps the engine JVM's heap, e.g. `6g`;
Audiveris 5.10.2's start script baked in `-Xmx8g`, oversized for hosts under 16 GB, and
5.11.0's bakes none, leaving the JVM a quarter of the memory it sees — set it either way;
note that the jpackage `.exe` launcher on Windows ignores this knob; see
deploy/home/README.md), `GDK_SCALE` (the Docker image sets `1`; **required** with
Audiveris 5.11.0 on any host without GTK — unset, 5.11 probes the screen's scale through
libgtk-3 at start-up and dies with `UnsatisfiedLinkError` before reading a page).

What the service accepts: a `.pdf`, `.png`, `.jpg`/`.jpeg` or `.tif`/`.tiff` whose leading
bytes are that format's — anything else is refused with 415 before the engine is spawned
(Audiveris would happily open `.omr` books and every ImageIO format, a far wider surface of
native decoders than a score upload needs). A timed-out or deleted run has its whole
process tree killed, launcher and JVM both.

**Deploying publicly?** The service itself enforces upload size and page count, a queue
and a live-job cap, transient files, format sniffing, and manifest-only file serving — but
it ships with no authentication and `CORS_ORIGIN=*`. Front it with your own auth/rate
limiting, set `CORS_ORIGIN` to your app's origin, size the work-root disk for
`MAX_LIVE_JOBS × MAX_UPLOAD_MB`, and **run it under an account with nothing to lose**: the
engine's native decoders parse whatever the internet sends. The Docker image already runs
as an unprivileged user; on a bare host, use a dedicated low-privilege account.

### Hugging Face Spaces (now PRO-only)

The repo still runs as a **Docker Space** (the YAML block at the top of this file is the
Space metadata; the container user is UID 1000 as Spaces requires) — but as of mid-2026
Docker Spaces **require a paid Hugging Face plan**; the free CPU tier this section was
written for no longer exists. If you have PRO: New Space → SDK Docker → push this repo →
the service answers at `https://<user>-solfascribe-omr.hf.space`. Without it, use the
free **home-hosting path** below.

## Deploying

Two documented paths, both free:

- **Dev / pilot (free, no card)**: run it on your own machine behind a Cloudflare named
  tunnel — [`deploy/home/`](./deploy/home/README.md). Up when the machine is; the right
  trade while the operator is also the main user. (Hugging Face Docker Spaces, the old
  free dev path, went PRO-only in mid-2026 — the section above.)
- **Production**: an Oracle Cloud Always-Free Ampere A1 VM (2 OCPU / 12 GB, arm64)
  with the edge of your choice — the same Cloudflare named tunnel the home path uses (no
  port opened, no certificate; the SolfaScribe instance's choice) or Caddy with automatic
  HTTPS on the VM's own ports — the whole bundle (compose files, Caddyfile, connector
  config, idempotent `setup.sh`, and an honest step-by-step including Oracle's signup and
  capacity friction) lives in [`deploy/oracle/`](./deploy/oracle/DEPLOY.md). CI builds
  the image on a native arm64 runner so every PR proves that target keeps working.

## Development

`npm test` runs the suite against a **fake Audiveris** (`fake-audiveris/fake.mjs`) that
reproduces each corpus-taught scenario — movement splits, broken-sheet salvage, the
rhythm-analysis abort, timeouts — so CI needs no Java. `npm run verify` adds typecheck.

## Licence

The service code is MIT. The Docker image builds and bundles Audiveris, which is
**AGPL-3.0** — see [NOTICE.md](./NOTICE.md).
