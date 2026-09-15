/**
 * The REST face — four routes and nothing clever:
 *
 *   POST   /jobs                 multipart upload (field "score") → 202 { jobId }
 *   GET    /jobs/:id             → { status, scoreName, movements[], excludedSheets?,
 *                                    failure?, logTail? }
 *   GET    /jobs/:id/files/:name → one movement's MusicXML bytes
 *   DELETE /jobs/:id             → remove the job and its files immediately
 *
 * Configuration is environment-only (12-factor): AUDIVERIS_CMD, HOST, PORT,
 * OMR_TIMEOUT_MS, JOB_TTL_MS, WORK_ROOT, CORS_ORIGIN, MAX_UPLOAD_MB, OMR_CONCURRENCY,
 * OMR_JAVA_MAX_HEAP, MAX_QUEUED_JOBS, MAX_LIVE_JOBS, MAX_PDF_PAGES, AUDIVERIS_LOG_DIR.
 */
import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { createReadStream } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateJavaMaxHeap } from './audiveris.js';
import { JobStore, QueueFullError, RefusedUploadError, removeOrphanedWork } from './jobs.js';

/** CORS_ORIGIN is comma-separated — the app lives on more than one origin (production +
 *  the `next` staging preview). Found the hard way (2026-08-29): a scan from staging
 *  uploaded fine (multipart POST needs no preflight), the service accepted and RAN the
 *  job, and the browser then discarded the 202 because the single allowed origin did not
 *  match — "Failed to fetch" for the reader, an orphaned queued job per retry for the
 *  host. Unset stays '*' (local dev). */
export function corsOriginsOf(rawOrigins: string | undefined): string | string[] {
  if (!rawOrigins) return '*';
  const origins = rawOrigins
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');
  return origins.length === 1 ? origins[0]! : origins;
}

/** The HTTP status an upload refusal maps to: 415 for a format the service does not
 *  read, 422 for a PDF that declares more pages than the cap. Pure; pinned through the
 *  routes in test/server.test.ts. */
export function statusOfRefusal(error: RefusedUploadError): 415 | 422 {
  return error.reason === 'too-many-pages' ? 422 : 415;
}

const environment = process.env;
const configuration = {
  // 127.0.0.1 by default: the home deployment is reached through the tunnel, which dials
  // localhost, and a wider bind was reachable from any LAN the laptop joined (security
  // review 2026-09-15). The Docker image sets HOST=0.0.0.0, where the container is the
  // boundary.
  host: environment.HOST ?? '127.0.0.1',
  port: Number(environment.PORT ?? 8480),
  // Space-separated so a wrapper like `node fake.mjs` works; quote-free paths only —
  // point AUDIVERIS_CMD at a shim script if the install path contains spaces (the shim
  // must `exec` the real binary, or a timeout SIGKILL lands on the shim and orphans
  // the JVM; note Node ≥ 22 refuses to spawn .bat/.cmd directly).
  audiverisCommand: (environment.AUDIVERIS_CMD ?? 'audiveris').split(' '),
  // 15 min (was 10): the tuned 400-DPI rasterization makes runs ~40-70% longer, so a
  // score that used to finish in 7 minutes would newly time out at the old default.
  timeoutMs: Number(environment.OMR_TIMEOUT_MS ?? 15 * 60 * 1000),
  jobTtlMs: Number(environment.JOB_TTL_MS ?? 20 * 60 * 1000),
  workRoot: environment.WORK_ROOT ?? join(tmpdir(), 'solfascribe-omr'),
  corsOrigin: corsOriginsOf(environment.CORS_ORIGIN),
  maxUploadBytes: Number(environment.MAX_UPLOAD_MB ?? 40) * 1024 * 1024,
  concurrency: Number(environment.OMR_CONCURRENCY ?? 1),
  maxQueuedJobs: Number(environment.MAX_QUEUED_JOBS ?? 25),
  maxLiveJobs: Number(environment.MAX_LIVE_JOBS ?? 40),
  maxPdfPages: Number(environment.MAX_PDF_PAGES ?? 60),
  // The engine's own log directory (Audiveris writes one file per run there, holding the
  // input path and OCR'd text); swept after every run when named. Windows:
  // %APPDATA%\AudiverisLtd\audiveris\log — see deploy/home/README.md.
  audiverisLogDirectory: environment.AUDIVERIS_LOG_DIR || undefined,
  // JVM max heap for the Audiveris run ("6g", "4096m"). Unset keeps the engine default
  // (5.10.2 bakes -Xmx8g into its start script — fine on a ≥16 GB host, oversized for
  // smaller boxes; the 12 GB Oracle deploy sets 6g — see deploy/oracle/docker-compose.yml).
  javaMaxHeap: environment.OMR_JAVA_MAX_HEAP
    ? validateJavaMaxHeap(environment.OMR_JAVA_MAX_HEAP)
    : undefined,
};

export function buildServer(store: JobStore) {
  const server = Fastify({
    logger: true,
    // A slow-loris upload holds a file handle, not memory (uploads stream to disk), but it
    // must still end: the whole request must ARRIVE inside requestTimeout, and the
    // readers are on mobile links — five minutes lets a 40 MB upload through at about
    // 1 Mbit/s sustained, where two minutes needed nearly three.
    connectionTimeout: 310_000,
    requestTimeout: 300_000,
  });
  void server.register(cors, { origin: configuration.corsOrigin });
  void server.register(multipart, { limits: { fileSize: configuration.maxUploadBytes, files: 1 } });

  // Every 5xx answers one fixed sentence: Node's own error messages carry absolute paths
  // (a full disk names the temp directory and the user), and the log has the real one.
  server.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (statusCode >= 500) {
      request.log.error(error);
      return reply.code(500).send({ error: 'The conversion service hit an internal error.' });
    }
    return reply.code(statusCode).send({ error: error.message });
  });

  server.get('/healthz', async () => ({ ok: true }));

  server.post('/jobs', async (request, reply) => {
    const upload = await request.file();
    if (!upload) return reply.code(400).send({ error: 'Send the score as a multipart file field.' });
    try {
      const job = await store.submitStream(upload.filename || 'score.pdf', upload.file);
      // A truncated stream (the size limit) surfaces here as the multipart plugin's flag.
      if (upload.file.truncated) {
        await store.delete(job.id);
        return reply.code(413).send({ error: 'The file is larger than this service accepts.' });
      }
      return await reply.code(202).send({ jobId: job.id });
    } catch (error) {
      if (error instanceof QueueFullError) return reply.code(429).send({ error: error.message });
      if (error instanceof RefusedUploadError) {
        return reply.code(statusOfRefusal(error)).send({ error: error.message });
      }
      throw error;
    }
  });

  server.get('/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = store.get(id);
    if (!job) return reply.code(404).send({ error: 'No such job (it may have expired).' });
    return {
      status: job.status,
      scoreName: job.scoreName,
      movements: job.result?.movements ?? [],
      ...(job.result?.excludedSheets ? { excludedSheets: job.result.excludedSheets } : {}),
      ...(job.result?.failure ? { failure: job.result.failure } : {}),
      ...(job.result && job.status === 'failed' ? { logTail: job.result.logTail } : {}),
    };
  });

  server.get('/jobs/:id/files/:name', async (request, reply) => {
    const { id, name } = request.params as { id: string; name: string };
    // The name round-trips through the job's own manifest — never trusted as a path.
    // Fastify has ALREADY percent-decoded the param; decoding again double-decoded
    // %-containing names (a literal % even threw) — review blocker.
    const movementPath = store.movementPathOf(id, name);
    if (!movementPath) return reply.code(404).send({ error: 'No such movement file.' });
    return reply
      .header('content-type', 'application/vnd.recordare.musicxml')
      .send(createReadStream(movementPath));
  });

  server.delete('/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const deleted = await store.delete(id);
    return reply.code(deleted ? 204 : 404).send();
  });

  return server;
}

/** Entry point: clear orphans, build the store, start the sweeper, listen. */
async function main() {
  // The manifest is in-memory, so any files left in the work root by a previous run
  // (crash, restart) are unreachable — remove them before accepting work, or they'd
  // outlive the transient-files promise on a persistent volume.
  await removeOrphanedWork(configuration.workRoot);
  const store = new JobStore({
    workRoot: configuration.workRoot,
    jobTtlMs: configuration.jobTtlMs,
    concurrency: configuration.concurrency,
    maxQueuedJobs: configuration.maxQueuedJobs,
    maxLiveJobs: configuration.maxLiveJobs,
    maxPdfPages: configuration.maxPdfPages,
    audiverisLogDirectory: configuration.audiverisLogDirectory,
    // The three roots a leaked message could name: where jobs live, where the engine is
    // installed, and the operator's own profile.
    redactedPathRoots: [
      configuration.workRoot,
      dirname(configuration.audiverisCommand[configuration.audiverisCommand.length - 1] ?? ''),
      homedir(),
    ],
    omr: {
      audiverisCommand: configuration.audiverisCommand,
      timeoutMs: configuration.timeoutMs,
      javaMaxHeap: configuration.javaMaxHeap,
    },
  });
  setInterval(() => void store.sweepExpired(), 60 * 1000).unref();
  const server = buildServer(store);
  await server.listen({ port: configuration.port, host: configuration.host });
}

// Only auto-start when run directly (tests import buildServer without listening).
// pathToFileURL handles the Windows drive-letter/slash forms a hand-built string gets wrong.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
