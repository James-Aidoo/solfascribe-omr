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

## API

| Route | Meaning |
| ----- | ------- |
| `POST /jobs` (multipart file) | Submit a score → `202 { jobId }` (conversion is async; scores take seconds to minutes) |
| `GET /jobs/:id` | `{ status, scoreName, movements[], excludedSheets?, failure?, logTail? }` |
| `GET /jobs/:id/files/:name` | One movement's MusicXML bytes |
| `DELETE /jobs/:id` | Remove the job and its files immediately |

## Privacy

Uploads are **transient by design**: a job's files live only until the client deletes the
job or the TTL sweeper does (default 15 minutes). Nothing is retained, logged beyond an
in-memory manifest, or sent anywhere else. If you host this for others, say the same to
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

Configuration (environment): `AUDIVERIS_CMD`, `PORT` (8480), `OMR_TIMEOUT_MS` (10 min),
`JOB_TTL_MS` (15 min), `WORK_ROOT`, `CORS_ORIGIN` (`*`), `MAX_UPLOAD_MB` (40),
`OMR_CONCURRENCY` (1 — OMR is memory-hungry; raise it only with the RAM to match).

## Development

`npm test` runs the suite against a **fake Audiveris** (`fake-audiveris/fake.mjs`) that
reproduces each corpus-taught scenario — movement splits, broken-sheet salvage, the
rhythm-analysis abort, timeouts — so CI needs no Java. `npm run verify` adds typecheck.

## Licence

The service code is MIT. The Docker image builds and bundles Audiveris, which is
**AGPL-3.0** — see [NOTICE.md](./NOTICE.md).
