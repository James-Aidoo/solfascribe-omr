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
  up — no retry can help), `unreadable-input`, `timeout`, `omr-failed` — each with a log
  tail for diagnosis.
- **A measured, minimal tuned invocation.** Every run passes
  `-constant org.audiveris.omr.image.ImageLoading.pdfResolution=400` (PDF rasterization
  at 400 DPI instead of Audiveris's default 300 — the engine's own recommendation for
  small symbols). It was the single winner of an A/B sweep over real corpus scores
  (2026-08-14): bar-length misreads down (13→4 on one score, 27→25 on the other), fewer
  downstream diagnostics, more lyrics attached to notes, at the cost of ~40–70% longer
  runs. Six other candidate options (lyrics-above-staff, implicit tuplets, shared-head
  dots, global binarization, poor-input profile, explicit OCR language) measured neutral
  or worse and are deliberately NOT set — the rationale lives with the constant in
  `src/audiveris.ts`.

## API

| Route | Meaning |
| ----- | ------- |
| `POST /jobs` (multipart file) | Submit a score → `202 { jobId }` (conversion is async; scores take seconds to minutes) |
| `GET /jobs/:id` | `{ status, scoreName, movements[], excludedSheets?, failure?, logTail? }` |
| `GET /jobs/:id/files/:name` | One movement's MusicXML bytes |
| `DELETE /jobs/:id` | Remove the job and its files immediately |

## Privacy

Uploads are **transient by design**: a job's files live only until the client deletes the
job or the TTL sweeper does (default 15 minutes), and the service wipes any orphaned job
files at boot (after a crash or restart, files whose in-memory manifest is gone would
otherwise linger unreachable). Nothing is retained, logged beyond an in-memory manifest,
or sent anywhere else. If you host this for others, say the same to
your users — the scores are theirs.

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

Configuration (environment): `AUDIVERIS_CMD`, `PORT` (8480), `OMR_TIMEOUT_MS` (15 min —
sized for the tuned 400-DPI rasterization, which runs ~40-70% longer than the old 300),
`JOB_TTL_MS` (20 min), `WORK_ROOT`, `CORS_ORIGIN` (`*`), `MAX_UPLOAD_MB` (40),
`OMR_CONCURRENCY` (1 — OMR is memory-hungry; raise it only with the RAM to match),
`MAX_QUEUED_JOBS` (25 — a full queue answers 429), `OMR_JAVA_MAX_HEAP` (unset — caps the
engine JVM's heap, e.g. `6g`; Audiveris 5.10.2's own start script bakes in `-Xmx8g`,
oversized for hosts under 16 GB).

**Deploying publicly?** The service itself enforces upload size, a queue cap, transient
files, and manifest-only file serving — but it ships with no authentication and
`CORS_ORIGIN=*`. Front it with your own auth/rate limiting, set `CORS_ORIGIN` to your
app's origin, and size the work-root disk for `MAX_QUEUED_JOBS × MAX_UPLOAD_MB`.

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
  behind Caddy with automatic HTTPS — the whole bundle (compose file, Caddyfile,
  idempotent `setup.sh`, and an honest step-by-step including Oracle's signup and
  capacity friction) lives in [`deploy/oracle/`](./deploy/oracle/DEPLOY.md). CI builds
  the image on a native arm64 runner so every PR proves that target keeps working.

## Development

`npm test` runs the suite against a **fake Audiveris** (`fake-audiveris/fake.mjs`) that
reproduces each corpus-taught scenario — movement splits, broken-sheet salvage, the
rhythm-analysis abort, timeouts — so CI needs no Java. `npm run verify` adds typecheck.

## Licence

The service code is MIT. The Docker image builds and bundles Audiveris, which is
**AGPL-3.0** — see [NOTICE.md](./NOTICE.md).
