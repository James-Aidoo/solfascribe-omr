import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JobStore, QueueFullError } from '../src/jobs';

const FAKE: readonly string[] = ['node', join(process.cwd(), 'fake-audiveris', 'fake.mjs')];

const workRoots: string[] = [];
async function makeStore(jobTtlMs = 60_000): Promise<JobStore> {
  const workRoot = await mkdtemp(join(tmpdir(), 'omr-jobs-'));
  workRoots.push(workRoot);
  return new JobStore({
    workRoot,
    jobTtlMs,
    omr: { audiverisCommand: FAKE, timeoutMs: 30_000 },
  });
}
afterEach(async () => {
  for (const workRoot of workRoots.splice(0)) await rm(workRoot, { recursive: true, force: true });
});

/** Poll until the job leaves the queue/running states (the fake engine is fast). */
async function waitForFinish(store: JobStore, id: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = store.get(id)?.status;
    if (status === 'done' || status === 'failed') return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('job never finished');
}

describe('JobStore — queue, results, and transient files', () => {
  it('a submitted score runs to done with its movement manifest', async () => {
    const store = await makeStore();
    // The scenario travels in the CONTENT (uploads are always stored as input.pdf).
    const job = await store.submit('ok.pdf', Buffer.from('ok\n(fake score)'));
    expect(store.get(job.id)?.status).toMatch(/queued|running/);
    await waitForFinish(store, job.id);
    const finished = store.get(job.id)!;
    expect(finished.status).toBe('done');
    expect(finished.result?.movements.map((movement) => movement.filename)).toEqual(['ok/ok.mxl']);
  });

  it('refuses a submission when the queue is at its cap (the 429 path)', async () => {
    const workRoot = await mkdtemp(join(tmpdir(), 'omr-jobs-'));
    workRoots.push(workRoot);
    const store = new JobStore({
      workRoot,
      jobTtlMs: 60_000,
      maxQueuedJobs: 0,
      omr: { audiverisCommand: FAKE, timeoutMs: 30_000 },
    });
    await expect(store.submit('ok.pdf', Buffer.from('ok\n'))).rejects.toBeInstanceOf(
      QueueFullError,
    );
  });

  it('stores the upload under a sanitized name (spaces and separators become underscores)', async () => {
    const store = await makeStore();
    const job = await store.submit('Enso Nyame Ye.pdf', Buffer.from('ok\n(fake score)'));
    expect(store.get(job.id)?.inputFilename).toBe('Enso_Nyame_Ye.pdf');
    // Separators are gone entirely, so the stored file cannot escape the work directory
    // (leftover dots are inert without a separator to segment them).
    const traversal = await store.submit('../evil/../name.pdf', Buffer.from('ok\n(fake)'));
    expect(store.get(traversal.id)?.inputFilename).not.toMatch(/[\\/]/);
  });

  it('movementPathOf serves only manifest filenames — no path traversal', async () => {
    const store = await makeStore();
    const job = await store.submit('ok.pdf', Buffer.from('ok\n(fake score)'));
    await waitForFinish(store, job.id);
    expect(store.movementPathOf(job.id, 'ok/ok.mxl')).toBeTruthy();
    expect(store.movementPathOf(job.id, '../input.pdf')).toBeNull();
    expect(store.movementPathOf(job.id, 'ok/../../input.pdf')).toBeNull();
  });

  it('delete removes the job AND its files (the privacy contract)', async () => {
    const store = await makeStore();
    const job = await store.submit('ok.pdf', Buffer.from('ok\n(fake score)'));
    await waitForFinish(store, job.id);
    const workDirectory = store.get(job.id)!.workDirectory;
    expect(existsSync(workDirectory)).toBe(true);
    expect(await store.delete(job.id)).toBe(true);
    expect(store.get(job.id)).toBeUndefined();
    expect(existsSync(workDirectory)).toBe(false);
  });

  it('the TTL sweeper removes finished jobs past their time', async () => {
    const store = await makeStore(1); // everything finished is instantly "old"
    const job = await store.submit('ok.pdf', Buffer.from('ok\n(fake score)'));
    await waitForFinish(store, job.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await store.sweepExpired()).toBe(1);
    expect(store.get(job.id)).toBeUndefined();
  });

  it('a failed conversion carries its failure class through the job', async () => {
    const store = await makeStore();
    const job = await store.submit('rhythms.pdf', Buffer.from('rhythms\n(fake score)'));
    await waitForFinish(store, job.id);
    const finished = store.get(job.id)!;
    expect(finished.status).toBe('failed');
    expect(finished.result?.failure?.class).toBe('rhythm-analysis-abort');
  });
});
