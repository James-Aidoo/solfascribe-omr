/**
 * The REST face, through Fastify's inject (no port): the status each refusal maps to,
 * the size limit's 413, the 5xx mask that keeps this machine's paths out of every
 * answer. The store is real and runs the fake engine; the upload cap is set tiny through
 * the environment BEFORE the server module loads (its configuration is read at import).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { JobStore } from '../src/jobs';

// About 1 KiB — a two-page fake PDF fits, a padded one does not.
process.env.MAX_UPLOAD_MB = '0.001';
const { buildServer } = await import('../src/server');

const FAKE: readonly string[] = ['node', join(process.cwd(), 'fake-audiveris', 'fake.mjs')];
const workRoots: string[] = [];
async function makeStore(options: { maxQueuedJobs?: number; maxPdfPages?: number } = {}) {
  const workRoot = await mkdtemp(join(tmpdir(), 'omr-server-'));
  workRoots.push(workRoot);
  return new JobStore({
    workRoot,
    jobTtlMs: 60_000,
    ...options,
    omr: { audiverisCommand: FAKE, timeoutMs: 30_000 },
  });
}
afterEach(async () => {
  for (const workRoot of workRoots.splice(0)) await rm(workRoot, { recursive: true, force: true });
});

/** One multipart body with a single file field, the way the app posts a score. */
function multipartUpload(filename: string, bytes: Buffer) {
  const boundary = 'omr-test-boundary';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="score"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    'latin1',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'latin1');
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([head, bytes, tail]),
  };
}

const pdfDeclaring = (pageCount: number, padding = 0) =>
  Buffer.from(
    `%PDF-1.4\nok\n${'/Type /Page\n'.repeat(pageCount)}${' '.repeat(padding)}`,
    'latin1',
  );

async function post(server: ReturnType<typeof buildServer>, filename: string, bytes: Buffer) {
  const { headers, payload } = multipartUpload(filename, bytes);
  return server.inject({ method: 'POST', url: '/jobs', headers, payload });
}

describe('POST /jobs — what each refusal answers', () => {
  let store: JobStore;
  beforeAll(async () => {
    store = await makeStore();
  });

  it('a score whose bytes are not the named format → 415, and nothing is queued', async () => {
    const server = buildServer(store);
    const response = await post(server, 'book.pdf', Buffer.from('PK\u0003\u0004 not a pdf'));
    expect(response.statusCode).toBe(415);
    expect(response.json().error).toContain('does not contain what its name says');
  });

  it('a PDF declaring more pages than the cap → 422', async () => {
    const server = buildServer(await makeStore({ maxPdfPages: 2 }));
    const response = await post(server, 'book.pdf', pdfDeclaring(3));
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toContain('3 pages');
  });

  it('an upload past the size limit → 413, and the truncated job is gone', async () => {
    const store = await makeStore();
    const server = buildServer(store);
    const response = await post(server, 'book.pdf', pdfDeclaring(1, 4096));
    expect(response.statusCode).toBe(413);
    // Nothing survives on disk or in the manifest.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(workRoots[workRoots.length - 1]!)).toEqual([]);
  });

  it('a full queue → 429', async () => {
    const server = buildServer(await makeStore({ maxQueuedJobs: 0 }));
    const response = await post(server, 'book.pdf', pdfDeclaring(1));
    expect(response.statusCode).toBe(429);
  });

  it('an admitted score → 202 with its job id', async () => {
    const server = buildServer(await makeStore());
    const response = await post(server, 'book.pdf', pdfDeclaring(1));
    expect(response.statusCode).toBe(202);
    expect(response.json().jobId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('the 5xx mask', () => {
  it('an internal error answers one fixed sentence — never the error text (which names paths)', async () => {
    const leaking = {
      get() {
        throw new Error('ENOSPC: no space left on device, open C:\\Users\\someone\\score.pdf');
      },
    } as unknown as JobStore;
    const server = buildServer(leaking);
    const response = await server.inject({ method: 'GET', url: '/jobs/any' });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('Users');
    expect(response.json()).toEqual({ error: 'The conversion service hit an internal error.' });
  });

  it('an unknown job → 404', async () => {
    const server = buildServer(await makeStore());
    const response = await server.inject({ method: 'GET', url: '/jobs/nope' });
    expect(response.statusCode).toBe(404);
  });
});
