import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { JobStore, QueueFullError, RefusedUploadError, removeOrphanedWork } from '../src/jobs';

const FAKE: readonly string[] = ['node', join(process.cwd(), 'fake-audiveris', 'fake.mjs')];

/** A fake score the guards admit: PDF leading bytes, then the scenario the fake engine
 *  keys off (it reads the scenario from the FILENAME; the content is decoration). */
function fakePdf(scenario: string): Buffer {
  return Buffer.from(`%PDF-1.4\n${scenario}\n(fake score)`, 'latin1');
}

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
    const job = await store.submit('ok.pdf', fakePdf('ok'));
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
    await expect(store.submit('ok.pdf', fakePdf('ok'))).rejects.toBeInstanceOf(
      QueueFullError,
    );
  });

  it('stores the upload under a sanitized name (spaces and separators become underscores)', async () => {
    const store = await makeStore();
    const job = await store.submit('Enso Nyame Ye.pdf', fakePdf('ok'));
    expect(store.get(job.id)?.inputFilename).toBe('Enso_Nyame_Ye.pdf');
    // Only the last path segment's stem survives, so the stored file cannot escape the
    // work directory.
    const traversal = await store.submit('../evil/../name.pdf', fakePdf('ok'));
    expect(store.get(traversal.id)?.inputFilename).toBe('name.pdf');
  });

  it('movementPathOf serves only manifest filenames — no path traversal', async () => {
    const store = await makeStore();
    const job = await store.submit('ok.pdf', fakePdf('ok'));
    await waitForFinish(store, job.id);
    expect(store.movementPathOf(job.id, 'ok/ok.mxl')).toBeTruthy();
    expect(store.movementPathOf(job.id, '../input.pdf')).toBeNull();
    expect(store.movementPathOf(job.id, 'ok/../../input.pdf')).toBeNull();
  });

  it('delete removes the job AND its files (the privacy contract)', async () => {
    const store = await makeStore();
    const job = await store.submit('ok.pdf', fakePdf('ok'));
    await waitForFinish(store, job.id);
    const workDirectory = store.get(job.id)!.workDirectory;
    expect(existsSync(workDirectory)).toBe(true);
    expect(await store.delete(job.id)).toBe(true);
    expect(store.get(job.id)).toBeUndefined();
    expect(existsSync(workDirectory)).toBe(false);
  });

  it('the TTL sweeper removes finished jobs past their time', async () => {
    const store = await makeStore(1); // everything finished is instantly "old"
    const job = await store.submit('ok.pdf', fakePdf('ok'));
    await waitForFinish(store, job.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await store.sweepExpired()).toBe(1);
    expect(store.get(job.id)).toBeUndefined();
  });

  it('the collection window opens at FINISH, not at creation — a long run cannot eat it', async () => {
    // A conversion as long as the TTL itself used to leave a zero-width window: the sweep
    // measured from createdAt, so the result could be deleted the moment it appeared
    // (owner incident 2026-08-18 — a reconnecting client needs the full window).
    const store = await makeStore(60_000);
    const job = await store.submit('ok.pdf', fakePdf('ok'));
    await waitForFinish(store, job.id);
    const finished = store.get(job.id)!;
    expect(finished.finishedAt).not.toBeNull();
    // Pretend the job was CREATED ages ago but finished just now: it must survive.
    finished.createdAt = Date.now() - 10 * 60_000;
    expect(await store.sweepExpired()).toBe(0);
    expect(store.get(job.id)).toBeDefined();
    // Once the FINISH is older than the TTL, it goes.
    finished.finishedAt = Date.now() - 2 * 60_000;
    expect(await store.sweepExpired()).toBe(1);
  });

  it('removeOrphanedWork clears leftover job directories at boot (the restart gap)', async () => {
    const workRoot = await mkdtemp(join(tmpdir(), 'omr-jobs-'));
    workRoots.push(workRoot);
    // Two stranded job directories from a "previous run" — the in-memory manifest that
    // knew about them is gone, so only a boot-time sweep can honour the privacy promise.
    for (const orphanId of ['orphan-a', 'orphan-b']) {
      await mkdir(join(workRoot, orphanId, 'out'), { recursive: true });
      await writeFile(join(workRoot, orphanId, 'input.pdf'), 'stranded upload');
    }
    expect(await removeOrphanedWork(workRoot)).toBe(2);
    expect(existsSync(join(workRoot, 'orphan-a'))).toBe(false);
    expect(existsSync(join(workRoot, 'orphan-b'))).toBe(false);
    expect(existsSync(workRoot)).toBe(true); // the root itself survives for new jobs
  });

  it('removeOrphanedWork on a missing work root is a quiet no-op', async () => {
    expect(await removeOrphanedWork(join(tmpdir(), 'omr-never-created'))).toBe(0);
  });

  it('a failed conversion carries its failure class through the job', async () => {
    const store = await makeStore();
    const job = await store.submit('rhythms.pdf', fakePdf('rhythms'));
    await waitForFinish(store, job.id);
    const finished = store.get(job.id)!;
    expect(finished.status).toBe('failed');
    expect(finished.result?.failure?.class).toBe('rhythm-analysis-abort');
  });

  it('the upload is deleted the moment its run ends — the collection window holds outputs only', async () => {
    const store = await makeStore();
    const job = await store.submit('ok.pdf', fakePdf('ok'));
    await waitForFinish(store, job.id);
    expect(existsSync(join(job.workDirectory, 'ok.pdf'))).toBe(false);
    expect(existsSync(join(job.workDirectory, 'out', 'ok', 'ok.mxl'))).toBe(true);
  });
});

describe('JobStore — the guards at the door (security review 2026-09-15)', () => {
  it('refuses a file whose bytes are not the named format, with nothing left on disk', async () => {
    const workRoot = await mkdtemp(join(tmpdir(), 'omr-jobs-'));
    workRoots.push(workRoot);
    const store = new JobStore({ workRoot, jobTtlMs: 60_000, omr: { audiverisCommand: FAKE, timeoutMs: 30_000 } });
    await expect(store.submit('book.pdf', Buffer.from('PK\u0003\u0004 a zip'))).rejects.toMatchObject({
      reason: 'content-does-not-match-extension',
    });
    await expect(store.submit('book.omr', fakePdf('ok'))).rejects.toBeInstanceOf(RefusedUploadError);
    expect((await readdir(workRoot)).length).toBe(0);
  });

  it('refuses a PDF that declares more pages than the cap, and admits one at the cap', async () => {
    const workRoot = await mkdtemp(join(tmpdir(), 'omr-jobs-'));
    workRoots.push(workRoot);
    const store = new JobStore({
      workRoot,
      jobTtlMs: 60_000,
      maxPdfPages: 2,
      omr: { audiverisCommand: FAKE, timeoutMs: 30_000 },
    });
    const pages = (count: number) =>
      Buffer.from(`%PDF-1.4\nok\n${'<< /Type /Page >>\n'.repeat(count)}`, 'latin1');
    await expect(store.submit('ok.pdf', pages(3))).rejects.toMatchObject({ reason: 'too-many-pages' });
    const admitted = await store.submit('ok.pdf', pages(2));
    await waitForFinish(store, admitted.id);
    expect(store.get(admitted.id)?.status).toBe('done');
  });

  it('refuses a submission when jobs alive in any state reach the live cap', async () => {
    const workRoot = await mkdtemp(join(tmpdir(), 'omr-jobs-'));
    workRoots.push(workRoot);
    const store = new JobStore({
      workRoot,
      jobTtlMs: 60_000,
      maxLiveJobs: 1,
      omr: { audiverisCommand: FAKE, timeoutMs: 30_000 },
    });
    const first = await store.submit('ok.pdf', fakePdf('ok'));
    await waitForFinish(store, first.id); // finished, still alive for its window
    await expect(store.submit('ok.pdf', fakePdf('ok'))).rejects.toBeInstanceOf(QueueFullError);
  });

  /** Five clients open an upload at once, stall after the header, then finish: how many
   *  does a store with these caps admit, and what is left on disk? */
  async function slowUploadFleet(caps: { maxQueuedJobs?: number; maxLiveJobs?: number }) {
    const workRoot = await mkdtemp(join(tmpdir(), 'omr-jobs-'));
    workRoots.push(workRoot);
    const store = new JobStore({
      workRoot,
      jobTtlMs: 60_000,
      ...caps,
      omr: { audiverisCommand: FAKE, timeoutMs: 30_000 },
    });
    const uploads = Array.from({ length: 5 }, () => new Readable({ read() {} }));
    const submissions = uploads.map((upload) =>
      store.submitStream('ok.pdf', upload).then(
        () => 'admitted' as const,
        (error: unknown) => (error instanceof QueueFullError ? ('refused' as const) : error),
      ),
    );
    for (const upload of uploads) upload.push(Buffer.from('%PDF-1.4\n', 'latin1'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const upload of uploads) {
      upload.push(Buffer.from('ok\n(fake score)', 'latin1'));
      upload.push(null);
    }
    const outcomes = await Promise.all(submissions);
    for (const job of store.liveJobsForTests()) await waitForFinish(store, job.id);
    return {
      admitted: outcomes.filter((outcome) => outcome === 'admitted').length,
      refused: outcomes.filter((outcome) => outcome === 'refused').length,
      directoriesOnDisk: (await readdir(workRoot)).length,
    };
  }

  it('uploads still streaming in count against the QUEUE cap — a slow-upload fleet cannot pass a cap of one', async () => {
    expect(await slowUploadFleet({ maxQueuedJobs: 1 })).toEqual({
      admitted: 1,
      refused: 4,
      directoriesOnDisk: 1, // the refused four left nothing on disk
    });
  });

  it('uploads still streaming in count against the LIVE cap too', async () => {
    expect(await slowUploadFleet({ maxLiveJobs: 1 })).toEqual({
      admitted: 1,
      refused: 4,
      directoriesOnDisk: 1,
    });
  });

  it('the caps COUNT the streaming uploads — a cap of two admits exactly two (not "refuse while any streams")', async () => {
    expect(await slowUploadFleet({ maxQueuedJobs: 2 })).toEqual({
      admitted: 2,
      refused: 3,
      directoriesOnDisk: 2,
    });
    expect(await slowUploadFleet({ maxLiveJobs: 2 })).toEqual({
      admitted: 2,
      refused: 3,
      directoriesOnDisk: 2,
    });
  });

  it('deleting a RUNNING job kills the engine and removes the directory before the entry goes', async () => {
    const store = await makeStore();
    const job = await store.submit('slow.pdf', fakePdf('slow'));
    for (let attempt = 0; attempt < 100 && store.get(job.id)?.status !== 'running'; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(store.get(job.id)?.status).toBe('running');
    const startedAt = Date.now();
    expect(await store.delete(job.id)).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(4000); // the 5 s fake did not run to its end
    expect(store.get(job.id)).toBeUndefined();
    expect(existsSync(job.workDirectory)).toBe(false);
  });

  it('the sweeper removes directories no job owns, and one failure never stops the sweep', async () => {
    const workRoot = await mkdtemp(join(tmpdir(), 'omr-jobs-'));
    workRoots.push(workRoot);
    const store = new JobStore({ workRoot, jobTtlMs: 60_000, omr: { audiverisCommand: FAKE, timeoutMs: 30_000 } });
    await mkdir(join(workRoot, 'left-behind-by-a-crash'), { recursive: true });
    await writeFile(join(workRoot, 'left-behind-by-a-crash', 'score.pdf'), 'x');
    expect(await store.sweepExpired()).toBe(1);
    expect(existsSync(join(workRoot, 'left-behind-by-a-crash'))).toBe(false);
  });

  it('nothing that leaves the service names this machine’s directories', async () => {
    const workRoot = await mkdtemp(join(tmpdir(), 'omr-jobs-'));
    workRoots.push(workRoot);
    const missingEngine = join(workRoot, 'engine', 'Audiveris.exe');
    const store = new JobStore({
      workRoot,
      jobTtlMs: 60_000,
      redactedPathRoots: [workRoot],
      omr: { audiverisCommand: [missingEngine], timeoutMs: 30_000 },
    });
    const job = await store.submit('ok.pdf', fakePdf('ok'));
    await waitForFinish(store, job.id);
    const result = store.get(job.id)!.result!;
    expect(result.status).toBe('failed');
    const everything = `${result.logTail} ${result.failure?.detail ?? ''}`;
    expect(everything).not.toContain(workRoot);
    expect(everything).not.toContain(workRoot.replace(/\\/g, '/'));
  });

  it('sweeps the engine’s own log directory after a run — only files newer than the run', async () => {
    const workRoot = await mkdtemp(join(tmpdir(), 'omr-jobs-'));
    workRoots.push(workRoot);
    const engineLogs = join(workRoot, 'engine-logs');
    await mkdir(engineLogs, { recursive: true });
    const oldLog = join(engineLogs, '20260101T000000.log');
    await writeFile(oldLog, 'from long ago');
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const { utimes } = await import('node:fs/promises');
    await utimes(oldLog, past, past);
    const store = new JobStore({
      workRoot,
      jobTtlMs: 60_000,
      audiverisLogDirectory: engineLogs,
      omr: { audiverisCommand: FAKE, timeoutMs: 30_000 },
    });
    // The run's own log: written as the run starts (the engine opens it first thing), so
    // its mtime falls inside the sweep's window — the window opens one second before
    // the run, for exactly this ordering.
    const runLog = join(engineLogs, '20260915T120000.log');
    await writeFile(runLog, 'Book x | input C:/somewhere/score.pdf');
    // A file that is NOT an engine log — the operator pointed the variable at the wrong
    // directory — is never touched, however new it is.
    const strayFile = join(engineLogs, 'settings.json');
    await writeFile(strayFile, '{}');
    expect(existsSync(runLog)).toBe(true);
    const job = await store.submit('ok.pdf', fakePdf('ok'));
    await waitForFinish(store, job.id);
    expect(existsSync(runLog)).toBe(false);
    expect(existsSync(oldLog)).toBe(true);
    expect(existsSync(strayFile)).toBe(true);
  });

  it('a sweep that fires while an upload is still streaming in leaves that upload alone', async () => {
    const store = await makeStore();
    // A slow client: the PDF header arrives, then nothing for a while, then the rest.
    const upload = new Readable({
      read() {
        /* pushed by hand below */
      },
    });
    const submission = store.submitStream('ok.pdf', upload);
    upload.push(Buffer.from('%PDF-1.4\n', 'latin1'));
    await new Promise((resolve) => setTimeout(resolve, 50)); // the directory + header are on disk
    // The minute sweep fires mid-upload: nothing in `jobs` owns the directory yet.
    await store.sweepExpired();
    const [pendingDirectory] = await readdir(workRoots[workRoots.length - 1]!);
    expect(pendingDirectory).toBeDefined();
    expect(existsSync(join(workRoots[workRoots.length - 1]!, pendingDirectory!, 'out'))).toBe(true);
    upload.push(Buffer.from('ok\n(fake score)', 'latin1'));
    upload.push(null);
    const job = await submission;
    await waitForFinish(store, job.id);
    expect(store.get(job.id)?.status).toBe('done');
  });
});

