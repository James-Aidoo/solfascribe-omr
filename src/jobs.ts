/**
 * The job store: uploads become QUEUED jobs, one worker drains them through Audiveris
 * (OMR is memory-hungry — concurrency 1 unless configured), and results live just long
 * enough to be collected. Privacy is a feature of the shape: the uploaded score and its
 * outputs are TRANSIENT — deleted on client request or by the TTL sweeper, never
 * retained, never logged beyond the in-memory manifest.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { convertScore, type OmrResult, type OmrRunOptions } from './audiveris.js';

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
}

/** A filesystem-safe version of the upload's name — path separators, whitespace,
 *  shell-hostile characters, and control characters (the class uses \u escapes only;
 *  a literal control byte in a regex once slipped in unseen) become underscores; the
 *  extension survives. A degenerate name falls back to "score.pdf". */
function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\s\u0000-\u001f-]+/g, '_').trim();
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'score.pdf' : cleaned;
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
}

/** Thrown when the queue is full — the HTTP layer maps it to 429. */
export class QueueFullError extends Error {
  constructor() {
    super('The conversion queue is full — try again shortly.');
  }
}

export class JobStore {
  private readonly jobs = new Map<string, Job>();
  private readonly queue: string[] = [];
  private runningCount = 0;
  private readonly options: JobStoreOptions;

  constructor(options: JobStoreOptions) {
    this.options = options;
  }

  /** Persist the upload, enqueue it, and kick the worker. */
  async submit(scoreName: string, fileBytes: Buffer): Promise<Job> {
    if (this.queue.length >= (this.options.maxQueuedJobs ?? 25)) throw new QueueFullError();
    const id = randomUUID();
    const workDirectory = join(this.options.workRoot, id);
    const inputFilename = sanitizeFilename(scoreName);
    await mkdir(join(workDirectory, 'out'), { recursive: true });
    await writeFile(join(workDirectory, inputFilename), fileBytes);
    const job: Job = {
      id,
      scoreName,
      inputFilename,
      status: 'queued',
      createdAt: Date.now(),
      workDirectory,
    };
    this.jobs.set(id, job);
    this.queue.push(id);
    void this.drainQueue();
    return job;
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
   *  Deleting a RUNNING job removes its files at once (the privacy contract) but lets
   *  the subprocess finish into the void — its runtime is already bounded by the OMR
   *  timeout, so a kill-on-delete isn't worth the plumbing (review note, accepted). */
  async delete(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job) return false;
    this.jobs.delete(id);
    await rm(job.workDirectory, { recursive: true, force: true });
    return true;
  }

  /** Delete every finished job older than the TTL. Call periodically. */
  async sweepExpired(now = Date.now()): Promise<number> {
    let sweptCount = 0;
    for (const job of [...this.jobs.values()]) {
      const finished = job.status === 'done' || job.status === 'failed';
      if (finished && now - job.createdAt > this.options.jobTtlMs) {
        await this.delete(job.id);
        sweptCount++;
      }
    }
    return sweptCount;
  }

  private async drainQueue(): Promise<void> {
    const concurrency = this.options.concurrency ?? 1;
    while (this.runningCount < concurrency && this.queue.length > 0) {
      const id = this.queue.shift()!;
      const job = this.jobs.get(id);
      if (!job) continue; // deleted while queued
      this.runningCount++;
      job.status = 'running';
      void this.runJob(job).finally(() => {
        this.runningCount--;
        void this.drainQueue();
      });
    }
  }

  private async runJob(job: Job): Promise<void> {
    try {
      const result = await convertScore(
        join(job.workDirectory, job.inputFilename),
        join(job.workDirectory, 'out'),
        this.options.omr,
      );
      job.result = result;
      job.status = result.status;
    } catch (error) {
      job.result = {
        status: 'failed',
        movements: [],
        failure: { class: 'omr-failed', detail: String(error) },
        logTail: '',
      };
      job.status = 'failed';
    }
  }
}
