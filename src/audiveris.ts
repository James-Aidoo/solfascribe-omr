/**
 * Audiveris orchestration — the whole point of this service, and deliberately THIN:
 * run the OMR engine, hand back every MusicXML it produced, and when it fails, say
 * HOW it failed in a machine-readable way. No post-processing, no musical opinions;
 * whatever a client wants to do with the raw MusicXML is the client's business.
 *
 * The operational contract comes from running a real 29-score corpus through
 * Audiveris 5.10.2:
 *  - A book may export several MOVEMENT files (`<base>.mvt1.mxl`, …) when the engine
 *    can't bridge a page break — all of them are the result, never just the first.
 *  - Audiveris refuses to export a WHOLE book when one sheet fails; retrying with
 *    `-sheets` excluding the broken pages salvages the rest (per-sheet salvage).
 *  - Some scores abort inside Audiveris's own rhythm analysis ("no correct rhythm") —
 *    unreachable by any retry; clients need this failure class called out explicitly.
 */
import { spawn } from 'node:child_process';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface OmrRunOptions {
  /** The Audiveris invocation, e.g. `['/opt/audiveris/bin/Audiveris']` — or a fake
   *  binary in tests (`['node', 'fake-audiveris/fake.mjs']`). */
  audiverisCommand: readonly string[];
  /** Kill the OMR run after this long — scans of dense books can hang. */
  timeoutMs: number;
}

export interface MovementFile {
  /** Filename relative to the job's output directory (safe to expose to clients). */
  filename: string;
  bytes: number;
}

export type OmrFailureClass =
  /** Audiveris's rhythm analysis gave up ("no correct rhythm") — a retry cannot help;
   *  the source needs re-engraving or a cleaner scan. */
  | 'rhythm-analysis-abort'
  /** The input couldn't be read as a score at all (corrupt file, unsupported format). */
  | 'unreadable-input'
  /** The run exceeded the time budget and was killed. */
  | 'timeout'
  /** Audiveris ended without output for a reason we couldn't classify — the log tail
   *  is the best available diagnosis. */
  | 'omr-failed';

export interface OmrResult {
  status: 'done' | 'failed';
  /** Every MusicXML the run produced (one per movement; usually exactly one). */
  movements: MovementFile[];
  /** Present when per-sheet salvage was applied: the 1-based sheets EXCLUDED to save
   *  the rest of the book. The client should tell its user these pages are missing. */
  excludedSheets?: number[];
  failure?: { class: OmrFailureClass; detail: string };
  /** The last portion of the combined stdout/stderr — enough context to diagnose
   *  without shipping megabytes of log. */
  logTail: string;
}

const LOG_TAIL_CHARS = 4000;
/** Salvage is for BOOKS (tens of pages); a log-derived "total" beyond this is nonsense
 *  and must not size an allocation (the value comes from untrusted text). */
const MAX_SALVAGE_SHEETS = 2000;

interface ProcessOutcome {
  log: string;
  timedOut: boolean;
}

/** Run one Audiveris invocation to completion (or timeout), capturing its combined log. */
function runProcess(
  command: readonly string[],
  processArguments: readonly string[],
  timeoutMs: number,
): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    const [executable, ...leadingArguments] = command;
    const child = spawn(executable!, [...leadingArguments, ...processArguments], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => (log += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (log += chunk.toString('utf8')));
    const finish = () => {
      clearTimeout(timer);
      resolve({ log, timedOut });
    };
    child.on('close', finish);
    child.on('error', (error) => {
      log += `\n[spawn error] ${String(error)}`;
      finish();
    });
  });
}

/** Every .mxl under `directory` (recursive — Audiveris nests output in a book folder),
 *  reported relative to it and name-sorted so movement order is stable. */
async function collectMovements(directory: string): Promise<MovementFile[]> {
  const movements: MovementFile[] = [];
  async function walk(current: string, relativePrefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return; // the output directory may not exist when the run produced nothing
    }
    for (const entry of entries) {
      const relative = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(current, entry.name), relative);
      else if (entry.name.toLowerCase().endsWith('.mxl')) {
        const fileStat = await stat(join(current, entry.name));
        movements.push({ filename: relative, bytes: fileStat.size });
      }
    }
  }
  await walk(directory, '');
  return movements.sort((left, right) => left.filename.localeCompare(right.filename));
}

/**
 * The 1-based sheets the log reports as broken. The REAL 5.10.2 batch log carries the
 * sheet ordinal inside the book tag — `Sheet Bue_m'ani#2 flagged as invalid.` /
 * `WARN [Bue_m'ani#2] … Error processing stub` — so the number is read from `#N` (or a
 * bare "sheet N") on any line that reports the breakage. Negated phrasings ("without
 * error", "no error") don't count: over-excluding a healthy page would silently shrink
 * the salvaged book (review note).
 */
export function brokenSheetsOf(log: string): number[] {
  const sheets = new Set<number>();
  for (const line of log.split(/\r?\n/)) {
    if (/without error|no error/i.test(line)) continue;
    const reportsBreakage =
      /flagged as invalid|error processing stub/i.test(line) ||
      (/\b(?:invalid|error)\b/i.test(line) && /sheet/i.test(line));
    if (!reportsBreakage) continue;
    const match = /#(\d+)/.exec(line) ?? /sheet\s+(\d+)/i.exec(line);
    if (match) sheets.add(Number(match[1]));
  }
  return [...sheets].sort((left, right) => left - right);
}

/** The book's total sheet count: a stated total when the log gives one, else the highest
 *  stub/sheet/image ordinal the run touched (the batch log states no total; every sheet
 *  leaves `Stub#N` / `sheet#N` / `image #N` traces). */
export function totalSheetsOf(log: string): number | null {
  const stated = /(\d+)\s+sheets?\b/i.exec(log) ?? /sheets?\s*[:=]\s*(\d+)/i.exec(log);
  if (stated) return Number(stated[1]);
  let highestOrdinal = 0;
  for (const match of log.matchAll(/(?:stub|sheet|image)\s*#(\d+)/gi)) {
    highestOrdinal = Math.max(highestOrdinal, Number(match[1]));
  }
  return highestOrdinal > 0 ? highestOrdinal : null;
}

function classifyFailure(log: string, timedOut: boolean): { class: OmrFailureClass; detail: string } {
  if (timedOut) return { class: 'timeout', detail: 'The OMR run exceeded its time budget.' };
  if (/no correct rhythm|voice excess/i.test(log))
    return {
      class: 'rhythm-analysis-abort',
      detail:
        "Audiveris's rhythm analysis gave up on this score — a retry cannot help; it needs a cleaner scan or re-engraving.",
    };
  if (/could not load|cannot read|unsupported|not a valid|no such file/i.test(log))
    return { class: 'unreadable-input', detail: 'The input could not be read as a score.' };
  return { class: 'omr-failed', detail: 'Audiveris produced no output — see the log tail.' };
}

/** One Audiveris pass over the input; `sheets` restricts which pages are processed. */
async function runOnce(
  inputPath: string,
  outputDirectory: string,
  options: OmrRunOptions,
  sheets?: readonly number[],
): Promise<{ outcome: ProcessOutcome; movements: MovementFile[] }> {
  await mkdir(outputDirectory, { recursive: true });
  // One argv entry PER sheet number: unambiguous under args4j's int-array handler,
  // where a single space-joined token depends on the handler splitting it (review note).
  const sheetArguments =
    sheets && sheets.length > 0 ? ['-sheets', ...sheets.map(String)] : [];
  const outcome = await runProcess(
    options.audiverisCommand,
    ['-batch', '-export', ...sheetArguments, '-output', outputDirectory, inputPath],
    options.timeoutMs,
  );
  return { outcome, movements: await collectMovements(outputDirectory) };
}

/**
 * Convert one score: a full pass first; when the book exports nothing because
 * individual sheets are broken, ONE salvage retry excluding exactly those sheets.
 * The result always says what happened — movements, exclusions, or a failure class.
 */
export async function convertScore(
  inputPath: string,
  outputDirectory: string,
  options: OmrRunOptions,
): Promise<OmrResult> {
  const fullPass = await runOnce(inputPath, outputDirectory, options);
  const logTailOf = (log: string) => log.slice(-LOG_TAIL_CHARS);
  if (fullPass.movements.length > 0) {
    return { status: 'done', movements: fullPass.movements, logTail: logTailOf(fullPass.outcome.log) };
  }

  // Per-sheet salvage: Audiveris refuses whole-book export over one broken page. When
  // the log names the broken sheets AND the total, retry on the healthy complement.
  // The total is capped: it is parsed from a log line, and allocating an unbounded
  // array from untrusted text would be a self-inflicted out-of-memory (review note).
  const brokenSheets = brokenSheetsOf(fullPass.outcome.log);
  const totalSheets = totalSheetsOf(fullPass.outcome.log);
  const salvageable =
    !fullPass.outcome.timedOut &&
    brokenSheets.length > 0 &&
    totalSheets !== null &&
    totalSheets <= MAX_SALVAGE_SHEETS;
  if (salvageable) {
    const healthySheets = Array.from({ length: totalSheets }, (_, index) => index + 1).filter(
      (sheetNumber) => !brokenSheets.includes(sheetNumber),
    );
    if (healthySheets.length > 0) {
      const salvagePass = await runOnce(inputPath, outputDirectory, options, healthySheets);
      const combinedLog = `${fullPass.outcome.log}\n--- salvage retry (sheets ${healthySheets.join(', ')}) ---\n${salvagePass.outcome.log}`;
      if (salvagePass.movements.length > 0) {
        return {
          status: 'done',
          movements: salvagePass.movements,
          excludedSheets: brokenSheets,
          logTail: combinedLog.slice(-LOG_TAIL_CHARS),
        };
      }
      return {
        status: 'failed',
        movements: [],
        failure: classifyFailure(combinedLog, salvagePass.outcome.timedOut),
        logTail: combinedLog.slice(-LOG_TAIL_CHARS),
      };
    }
  }

  return {
    status: 'failed',
    movements: [],
    failure: classifyFailure(fullPass.outcome.log, fullPass.outcome.timedOut),
    logTail: logTailOf(fullPass.outcome.log),
  };
}
