/**
 * The REST face — four routes and nothing clever:
 *
 *   POST   /jobs                 multipart upload (field "score") → 202 { jobId }
 *   GET    /jobs/:id             → { status, scoreName, movements[], excludedSheets?,
 *                                    failure?, logTail? }
 *   GET    /jobs/:id/files/:name → one movement's MusicXML bytes
 *   DELETE /jobs/:id             → remove the job and its files immediately
 *
 * Configuration is environment-only (12-factor): AUDIVERIS_CMD, PORT, OMR_TIMEOUT_MS,
 * JOB_TTL_MS, WORK_ROOT, CORS_ORIGIN, MAX_UPLOAD_MB, OMR_CONCURRENCY.
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JobStore } from './jobs.js';

const environment = process.env;
const configuration = {
  port: Number(environment.PORT ?? 8480),
  // Space-separated so a wrapper like `node fake.mjs` works; quote-free paths only —
  // point AUDIVERIS_CMD at a shim script if the install path contains spaces.
  audiverisCommand: (environment.AUDIVERIS_CMD ?? 'audiveris').split(' '),
  timeoutMs: Number(environment.OMR_TIMEOUT_MS ?? 10 * 60 * 1000),
  jobTtlMs: Number(environment.JOB_TTL_MS ?? 15 * 60 * 1000),
  workRoot: environment.WORK_ROOT ?? join(tmpdir(), 'solfascribe-omr'),
  corsOrigin: environment.CORS_ORIGIN ?? '*',
  maxUploadBytes: Number(environment.MAX_UPLOAD_MB ?? 40) * 1024 * 1024,
  concurrency: Number(environment.OMR_CONCURRENCY ?? 1),
};

export function buildServer(store: JobStore) {
  const server = Fastify({ logger: true });
  void server.register(cors, { origin: configuration.corsOrigin });
  void server.register(multipart, { limits: { fileSize: configuration.maxUploadBytes } });

  server.get('/healthz', async () => ({ ok: true }));

  server.post('/jobs', async (request, reply) => {
    const upload = await request.file();
    if (!upload) return reply.code(400).send({ error: 'Send the score as a multipart file field.' });
    const fileBytes = await upload.toBuffer();
    const job = await store.submit(upload.filename || 'score.pdf', fileBytes);
    return reply.code(202).send({ jobId: job.id });
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
    const movementPath = store.movementPathOf(id, decodeURIComponent(name));
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

/** Entry point: build the store, start the sweeper, listen. */
async function main() {
  const store = new JobStore({
    workRoot: configuration.workRoot,
    jobTtlMs: configuration.jobTtlMs,
    concurrency: configuration.concurrency,
    omr: { audiverisCommand: configuration.audiverisCommand, timeoutMs: configuration.timeoutMs },
  });
  setInterval(() => void store.sweepExpired(), 60 * 1000).unref();
  const server = buildServer(store);
  await server.listen({ port: configuration.port, host: '0.0.0.0' });
}

// Only auto-start when run directly (tests import buildServer without listening).
// pathToFileURL handles the Windows drive-letter/slash forms a hand-built string gets wrong.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
