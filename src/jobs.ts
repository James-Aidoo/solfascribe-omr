/**
 * The job store: uploads become QUEUED jobs, one worker drains them through Audiveris
 * (OMR is memory-hungry — concurrency 1 unless configured), and results live just long
 * enough to be collected. Privacy is a feature of the shape: the uploaded score and its
 * outputs are TRANSIENT — the input is deleted the moment its run ends, the outputs on
 * client request or by the TTL sweeper, and nothing is retained or logged beyond the
 * in-memory manifest. The engine's OWN log directory is swept too when the operator
 * names it (`audiverisLogDirectory`): Audiveris writes a per-run log holding the input
 * path and OCR'd lyric fragments, which would otherwise outlive every job (security
 * review 2026-09-15).
 */
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { convertScore, type OmrResult, type OmrRunOptions } from './audiveris.js';
import {
  MAGIC_BYTE_COUNT,
  inspectInput,
  pdfPageCountOf,
  redactPaths,
  safeInputFilenameOf,
  type InputRefusal,
} from './inputGuards.js';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface Job {
  id: string;
  /** The uploaded file's name — echoed back so a client can label its result. */
  scoreName: string;
  /** The sanitized on-disk name the upload was stored under — Audiveris names its
   *  outputs after the input file, so movement filenames stay natural. */
  inputFilename: string;
  status: JobStatus;
  createdAt: number;
  result?: OmrResult;
  workDirectory: string;
  /** When the conversion ENDED (done or failed) — null while queued/running. The TTL runs
   *  from here, not from creation: a job's collection window must not be eaten by its own
   *  conversion time (a 15-minute run against a 20-minute creation-anchored TTL left five
   *  minutes to collect — and a client that reconnects after a network drop needs the full
   *  window; owner incident 2026-08-18). */
  finishedAt: number | null;
}

export interface JobStoreOptions {
  /** Parent directory for per-job working directories. */
  workRoot: string;
  omr: OmrRunOptions;
  /** How long a finished job's files survive before the sweeper removes them. */
  jobTtlMs: number;
  /** How many jobs may run concurrently (default 1 — Audiveris is memory-hungry). */
  concurrency?: number;
  /** Queue-depth cap (default 25): each queued job holds an upload on disk behind a
   *  slow worker, so an unbounded queue is a cheap disk-fill DoS (review note). A
   *  submission over the cap is refused — the route answers 429. */
  maxQueuedJobs?: number;
  /** Cap on jobs alive in ANY state (default 40): finished jobs keep their outputs for
   *  the collection window, so fast-failing uploads could otherwise fill the disk
   *  through the queue cap (security review 2026-09-15). */
  maxLiveJobs?: number;
  /** The most pages a PDF may declare (default 60): a book rasterized at 400 DPI is the
   *  one input that can push the engine's heap past a home machine. */
  maxPdfPages?: number;
  /** The engine's own log directory, swept after every run (files newer than the run's
   *  start). Unset = not swept — say so in the privacy statement if you host this. */
  audiverisLogDirectory?: string;
  /** Path roots to strip from anything that leaves the service (the failure detail and
   *  the log tail): the work root, the engine's install path, the operator's home. */
  redactedPathRoots?: readonly string[];
}

/**
 * Remove every leftover per-job directory under the work root. The job manifest lives
 * only in memory, so after a crash or restart anything still on disk is unreachable —
 * an orphan that would otherwise outlive the "uploads are transient" promise (it
 * matters most when the work root is a persistent volume). Call once at boot.
 */
export async function removeOrphanedWork(workRoot: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(workRoot, { withFileTypes: true });
  } catch {
    return 0; // no work root yet — nothing orphaned
  }
  let removedCount = 0;
  for (const entry of entries) {
    await rm(join(workRoot, entry.name), { recursive: true, force: true });
    removedCount++;
  }
  return removedCount;
}

/** Thrown when the queue is full — the HTTP layer maps it to 429. */
export class QueueFullError extends Error {
  constructor() {
    super('The conversion queue is full — try again shortly.');
  }
}

/** Thrown when the upload is refused before the engine ever sees it — the HTTP layer
 *  maps it to 415 (a format the service does not read) or 422 (too many pages). */
export class RefusedUploadError extends Error {
  constructor(
    readonly reason: InputRefusal,
    message: string,
  ) {
    super(message);
  }
}

/** Audiveris names each run's log by its start instant: `20260914T093700.log`. */
export const ENGINE_LOG_FILENAME = /^\d{8}T\d{6}\.log$/;

/** Remove a directory with a few retries: on Windows a file the JVM still holds open
 *  refuses deletion for a moment after the process is killed. */
async function removeDirectoryWithRetries(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

export class JobStore {
  private readonly jobs = new Map<string, Job>();
  private readonly queue: string[] = [];
  private readonly runningJobs = new Map<string, { abort: AbortController; done: Promise<void> }>();
  /** Directories of submissions still streaming in — owned, but not yet in `jobs`. The
   *  sweeper must not treat them as orphans: an upload takes seconds to minutes and the
   *  sweep runs every minute, and on Linux `rm -rf` of an open file succeeds, so the
   *  stream's next write would land in a deleted directory (review 2026-09-15). */
  private readonly pendingDirectories = new Set<string>();
  private readonly options: JobStoreOptions;

  constructor(options: JobStoreOptions) {
    this.options = options;
  }

  /** Persist an in-memory upload, enqueue it, and kick the worker (tests, small callers). */
  async submit(scoreName: string, fileBytes: Buffer): Promise<Job> {
    return this.submitFrom(scoreName, async (path) => writeFile(path, fileBytes));
  }

  /** Stream an upload straight to disk — the HTTP layer never holds a whole file in
   *  memory, so N slow uploads cost N file handles, not N × the size limit in RAM. */
  async submitStream(scoreName: string, upload: Readable): Promise<Job> {
    return this.submitFrom(scoreName, async (path) => pipeline(upload, createWriteStream(path)));
  }

  private async submitFrom(
    scoreName: string,
    writeUpload: (path: string) => Promise<void>,
  ): Promise<Job> {
    // Both caps count the uploads still streaming in: the check runs before the body
    // arrives, and a body can take minutes, so without them any number of slow uploads
    // passes a cap of one (review round 2, 2026-09-15 — five admitted against a cap of 1).
    const pendingCount = this.pendingDirectories.size;
    if (this.queue.length + pendingCount >= (this.options.maxQueuedJobs ?? 25))
      throw new QueueFullError();
    if (this.jobs.size + pendingCount >= (this.options.maxLiveJobs ?? 40))
      throw new QueueFullError();
    const id = randomUUID();
    const workDirectory = join(this.options.workRoot, id);
    this.pendingDirectories.add(id);
    try {
      await mkdir(join(workDirectory, 'out'), { recursive: true });
      const uploadPath = join(workDirectory, 'upload.bin');
      await writeUpload(uploadPath);
      const inputFilename = await this.admitUpload(scoreName, uploadPath);
      const job: Job = {
        id,
        scoreName,
        inputFilename,
        status: 'queued',
        createdAt: Date.now(),
        finishedAt: null,
        workDirectory,
      };
      this.jobs.set(id, job);
      this.queue.push(id);
      void this.drainQueue();
      return job;
    } catch (error) {
      await removeDirectoryWithRetries(workDirectory);
      throw error;
    } finally {
      this.pendingDirectories.delete(id);
    }
  }

  /** The guards, then the rename to the engine-facing name: the leading bytes must be
   *  the named format's, and a PDF must not declare more pages than the cap. */
  private async admitUpload(scoreName: string, uploadPath: string): Promise<string> {
    const leadingBytes = await leadingBytesOf(uploadPath);
    const inspection = inspectInput(scoreName, leadingBytes);
    if (!inspection.ok) throw new RefusedUploadError(inspection.reason, inspection.message);
    if (inspection.extension === 'pdf') {
      const pageCount = pdfPageCountOf(await readFile(uploadPath));
      const maxPdfPages = this.options.maxPdfPages ?? 60;
      if (pageCount > maxPdfPages) {
        throw new RefusedUploadError(
          'too-many-pages',
          `This PDF has ${pageCount} pages; the service reads up to ${maxPdfPages} at a time — split the book.`,
        );
      }
    }
    const inputFilename = safeInputFilenameOf(scoreName, inspection.extension);
    await rename(uploadPath, join(dirname(uploadPath), inputFilename));
    return inputFilename;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** The absolute path of one of a DONE job's movement files, or null. Filenames come
   *  from the job's own manifest, never from the URL verbatim — no path traversal. */
  movementPathOf(id: string, filename: string): string | null {
    const job = this.jobs.get(id);
    if (job?.status !== 'done') return null;
    const movement = job.result?.movements.find((entry) => entry.filename === filename);
    return movement ? join(job.workDirectory, 'out', movement.filename) : null;
  }

  /** Remove a job and its files (client says "collected" — or the TTL sweeper does).
   *  Deleting a RUNNING job kills the engine's process tree first and waits for it, so
   *  the files it held open can actually go; the manifest entry is dropped only once the
   *  directory is gone, so a failed removal is never an unreachable orphan (security
   *  review 2026-09-15 — before, the entry went first and a Windows EBUSY stranded the
   *  directory until the next boot). */
  async delete(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job) return false;
    const running = this.runningJobs.get(id);
    if (running) {
      running.abort.abort();
      await running.done;
    }
    await removeDirectoryWithRetries(job.workDirectory);
    this.jobs.delete(id);
    return true;
  }

  /** Delete every finished job whose COLLECTION WINDOW has passed, and any directory on
   *  disk that no job owns. The window opens when the conversion ends (`finishedAt`), so
   *  a long run can never eat its own window. One job's failure never stops the sweep —
   *  an unhandled rejection here used to take the whole service down. Call periodically. */
  async sweepExpired(now = Date.now()): Promise<number> {
    let sweptCount = 0;
    for (const job of [...this.jobs.values()]) {
      const finished = job.status === 'done' || job.status === 'failed';
      if (finished && now - (job.finishedAt ?? job.createdAt) > this.options.jobTtlMs) {
        try {
          await this.delete(job.id);
          sweptCount++;
        } catch (error) {
          console.warn(`[jobs] sweep could not remove a job: ${describeError(error)}`);
        }
      }
    }
    sweptCount += await this.removeUnownedDirectories();
    return sweptCount;
  }

  /** Directories under the work root that no live job owns — a removal that failed
   *  earlier, or a leftover from a crash mid-submit. */
  private async removeUnownedDirectories(): Promise<number> {
    let entries;
    try {
      entries = await readdir(this.options.workRoot, { withFileTypes: true });
    } catch {
      return 0;
    }
    let removedCount = 0;
    for (const entry of entries) {
      if (this.jobs.has(entry.name) || this.pendingDirectories.has(entry.name)) continue;
      try {
        await removeDirectoryWithRetries(join(this.options.workRoot, entry.name));
        removedCount++;
      } catch (error) {
        console.warn(`[jobs] sweep could not remove an unowned directory: ${describeError(error)}`);
      }
    }
    return removedCount;
  }

  private async drainQueue(): Promise<void> {
    const concurrency = this.options.concurrency ?? 1;
    while (this.runningJobs.size < concurrency && this.queue.length > 0) {
      const id = this.queue.shift()!;
      const job = this.jobs.get(id);
      if (!job) continue; // deleted while queued
      job.status = 'running';
      const abort = new AbortController();
      const done = this.runJob(job, abort.signal).finally(() => {
        this.runningJobs.delete(id);
        void this.drainQueue();
      });
      this.runningJobs.set(id, { abort, done });
    }
  }

  private async runJob(job: Job, abortSignal: AbortSignal): Promise<void> {
    const startedAt = Date.now();
    const inputPath = join(job.workDirectory, job.inputFilename);
    try {
      const result = await convertScore(
        inputPath,
        join(job.workDirectory, 'out'),
        this.options.omr,
        abortSignal,
      );
      job.result = this.redacted(result);
      job.status = result.status;
    } catch (error) {
      job.result = this.redacted({
        status: 'failed',
        movements: [],
        failure: { class: 'omr-failed', detail: describeError(error) },
        logTail: '',
      });
      job.status = 'failed';
    } finally {
      job.finishedAt = Date.now();
      // The upload is needed only by the run: it goes the moment the run ends, so the
      // collection window holds outputs alone, never the score that was uploaded.
      await unlink(inputPath).catch(() => undefined);
      await this.sweepEngineLogs(startedAt);
    }
  }

  /** The engine's own per-run log files newer than this run's start — and ONLY files
   *  named the way Audiveris names them (`20260914T093700.log`), so a mistyped directory
   *  (the profile root, say) loses nothing else. A log the engine still holds open at
   *  this moment stays until the operator deletes it by hand (deploy/home/README.md): the
   *  next run's window opens at ITS start, so it will not see this one. With a
   *  concurrency above one, a sibling run's live log is inside the window too — the
   *  engine is at concurrency 1 everywhere this service is deployed. */
  private async sweepEngineLogs(startedAt: number): Promise<void> {
    const directory = this.options.audiverisLogDirectory;
    if (!directory) return;
    let entries;
    try {
      entries = await readdir(directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!ENGINE_LOG_FILENAME.test(entry)) continue;
      const path = join(directory, entry);
      try {
        const fileStat = await stat(path);
        if (fileStat.isFile() && fileStat.mtimeMs >= startedAt - 1000) await unlink(path);
      } catch {
        // Held open by the engine, or already gone — see the note above.
      }
    }
  }

  /** Nothing that leaves the service names this machine's directories. */
  private redacted(result: OmrResult): OmrResult {
    const roots = this.options.redactedPathRoots ?? [];
    return {
      ...result,
      logTail: redactPaths(result.logTail, roots),
      ...(result.failure
        ? { failure: { ...result.failure, detail: redactPaths(result.failure.detail, roots) } }
        : {}),
    };
  }
}

/** An error's message for the failure detail — the class name plus the message, which
 *  the store redacts before it leaves; never a stack. */
function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** The first bytes of a file on disk, for the format sniff. */
async function leadingBytesOf(path: string): Promise<Uint8Array> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(MAGIC_BYTE_COUNT);
    const { bytesRead } = await handle.read(buffer, 0, MAGIC_BYTE_COUNT, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
