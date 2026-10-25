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
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_RASTER_PLAN,
  ENGINE_MAX_PIXEL_COUNT,
  pdfPageSizesOf,
  planFromTooLargeLog,
  rasterPlanFor,
  type RasterPlan,
} from './pageRaster.js';

export interface OmrRunOptions {
  /** The Audiveris invocation, e.g. `['/opt/audiveris/bin/Audiveris']` — or a fake
   *  binary in tests (`['node', 'fake-audiveris/fake.mjs']`). */
  audiverisCommand: readonly string[];
  /** Kill the OMR run after this long — scans of dense books can hang. */
  timeoutMs: number;
  /** JVM max heap for the engine run, in `-Xmx` syntax (`6g`, `4096m`). Unset keeps the
   *  engine's own default: Audiveris 5.10.2 baked `-Xmx8g` into its start script (fine
   *  on a ≥16 GB host, oversized for smaller boxes); 5.11.0 bakes none, so its JVM
   *  takes a quarter of the memory it sees (a container's limit, when it has one). */
  javaMaxHeap?: string;
}

/** The `-Xmx` value grammar: digits plus an optional k/m/g unit. Validated at startup so
 *  a typo fails the boot loudly instead of failing every conversion quietly. */
const JAVA_HEAP_PATTERN = /^\d+[kKmMgG]?$/;

export function validateJavaMaxHeap(value: string): string {
  if (!JAVA_HEAP_PATTERN.test(value)) {
    throw new Error(
      `OMR_JAVA_MAX_HEAP must be digits with an optional k/m/g unit (like "6g" or "4096m"), got "${value}".`,
    );
  }
  return value;
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
  | 'omr-failed'
  /** A page is too large for the engine's pixel limit even at the lowest resolution the
   *  service will use (src/pageRaster.ts) — the file needs scaling down. The detail
   *  names the page size, written for the person who uploaded it. */
  | 'page-too-large';

export interface OmrResult {
  status: 'done' | 'failed';
  /** Every MusicXML the run produced (one per movement; usually exactly one). */
  movements: MovementFile[];
  /** Present when per-sheet salvage was applied: the 1-based sheets EXCLUDED to save
   *  the rest of the book. The client should tell its user these pages are missing. */
  excludedSheets?: number[];
  /** Sentences the client should pass on to its user about HOW the score was read —
   *  today, that large pages were read at a lower resolution than the tuned 400 DPI. */
  notes?: string[];
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
  /** The run was cut short by the caller (a deleted job), not by the clock. */
  aborted: boolean;
}

/**
 * Kill the engine AND everything it spawned. A plain `child.kill('SIGKILL')` only ever
 * reached the direct child: a launcher shim or the jpackage `.exe` died while the JVM
 * beneath it kept rasterizing for as long as it liked — the wedged-pair incident the
 * operations manual documents as a manual `Stop-Process` (security review 2026-09-15).
 * Windows: `taskkill /T` walks the tree. POSIX: the child was spawned as its own process
 * group (`detached`), so the negative pid signals the whole group.
 */
export function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on(
      'error',
      () => child.kill('SIGKILL'),
    );
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/** Run one Audiveris invocation to completion (or timeout, or abort), capturing its
 *  combined log. An abort (a client deleting its running job) kills the tree exactly as
 *  a timeout does; the outcome says which. */
function runProcess(
  command: readonly string[],
  processArguments: readonly string[],
  timeoutMs: number,
  environmentOverrides?: NodeJS.ProcessEnv,
  abortSignal?: AbortSignal,
): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    // An abort that landed before the spawn (a job deleted while its output directory
    // was still being made): a listener added to an already-aborted signal never fires,
    // so answer without spawning anything at all.
    if (abortSignal?.aborted) {
      resolve({ log: '', timedOut: false, aborted: true });
      return;
    }
    const [executable, ...leadingArguments] = command;
    const child = spawn(executable!, [...leadingArguments, ...processArguments], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: environmentOverrides ? { ...process.env, ...environmentOverrides } : undefined,
      // Its own process group on POSIX, so a kill can take the JVM down with the shim.
      detached: process.platform !== 'win32',
    });
    let log = '';
    let timedOut = false;
    let aborted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      killProcessTree(child);
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => (log += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (log += chunk.toString('utf8')));
    const finish = () => {
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', onAbort);
      resolve({ log, timedOut, aborted });
    };
    child.on('close', finish);
    child.on('error', (error) => {
      // The message can carry the command path; the caller redacts before it leaves.
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
  // Two engine deaths that used to fall into the unclassified bucket (the owner's
  // question of 2026-09-06, "what would cause the omr to fail for an unclassified
  // reason?"): the JVM running out of heap on a large book, and a plain crash. Heap
  // exhaustion is unambiguous and comes first. The crash test comes LAST and matches
  // only the fatal shape (`Exception in thread`): a SUCCESSFUL run logs
  // `java.lang.NullPointerException` lines as WARN noise from PartwiseBuilder (the
  // Love-is-a-Verb tuning log, 2026-08-17), so a bare exception name must never
  // outrank the corpus-taught classes below it.
  if (/OutOfMemoryError|GC overhead limit|Java heap space/i.test(log))
    return {
      class: 'omr-failed',
      detail:
        'Audiveris ran out of memory on this score — fewer pages, or a smaller page, may work.',
    };
  if (/no correct rhythm|voice excess/i.test(log))
    return {
      class: 'rhythm-analysis-abort',
      detail:
        "Audiveris's rhythm analysis gave up on this score — a retry cannot help; it needs a cleaner scan or re-engraving.",
    };
  if (/could not load|cannot read|unsupported|not a valid|no such file/i.test(log))
    return { class: 'unreadable-input', detail: 'The input could not be read as a score.' };
  if (/Exception in thread/i.test(log))
    return { class: 'omr-failed', detail: 'Audiveris crashed while reading this score.' };
  return { class: 'omr-failed', detail: 'Audiveris produced no output — see the log tail.' };
}


/**
 * Tuned engine constants, passed as `-constant KEY=VALUE` pairs (the only tuning
 * surface Audiveris exposes in batch; CLI constants are NOT persisted in batch mode, so
 * every run stays reproducible).
 *
 * `pdfResolution=400`: raise PDF rasterization from the default 300 DPI to 400 —
 * the engine's own guidance for scores with small symbols, and the ONE option that
 * measurably won an A/B sweep over this corpus (2026-08-14, two real scores,
 * 7 single-option arms + combined; see SolfaScribe agentWorkingDirectory/
 * audiveris-tuning/): bar-length defects 13→4 and 27→25, engine diagnostics
 * 34→23 and 49→42, source voice rows 8→6 on the closed-score sample, lyric
 * syllables 664→707 with stranded plain-text words 1→0 on the open-score sample.
 * Cost: ~40–70% longer runs, still within a 2g heap. Only affects PDF inputs;
 * plain image inputs ignore it. A PDF whose pages are too large for the engine's pixel
 * limit at 400 DPI is read at a fitted resolution instead (src/pageRaster.ts).
 *
 * Measured and rejected, for the record: `ProcessingSwitches.lyricsAboveStaff`
 * (rescued a few stranded lyric lines on one score but doubled voice rows and
 * +10 bar-length defects on the other), `implicitTuplets` (+6 bar-length),
 * `bothSharedHeadDots` (+1 bar-length), GLOBAL binarization and
 * `Profiles.defaultQuality=Poor` (both byte-identical no-ops on this corpus); and on
 * 2026-10-25 (ten scores, 5.10.2 and 5.11.0), 450/500/600 DPI — 500 and 600 need the
 * pixel limit raised for EVERY page, cost 1.9–3.1× the time, lost most text-layer lyrics
 * (the app's scale fit stops at 0.7 of the declared scale, which tracks 300 / DPI) and at
 * 600 three scores exported nothing — and `Profiles.defaultQuality=Synthetic` (neutral).
 */
function engineConstantsFor(pdfResolution: number): string[] {
  return ['-constant', `org.audiveris.omr.image.ImageLoading.pdfResolution=${pdfResolution}`];
}

/** One Audiveris pass over the input; `sheets` restricts which pages are processed. */
async function runOnce(
  inputPath: string,
  outputDirectory: string,
  options: OmrRunOptions,
  pdfResolution: number,
  sheets?: readonly number[],
  abortSignal?: AbortSignal,
): Promise<{ outcome: ProcessOutcome; movements: MovementFile[] }> {
  await mkdir(outputDirectory, { recursive: true });
  // One argv entry PER sheet number: unambiguous under args4j's int-array handler,
  // where a single space-joined token depends on the handler splitting it (review note).
  const sheetArguments =
    sheets && sheets.length > 0 ? ['-sheets', ...sheets.map(String)] : [];
  // The Gradle-generated Audiveris start script assembles the java command line as
  // `$DEFAULT_JVM_OPTS $JAVA_OPTS $AUDIVERIS_OPTS`, and HotSpot lets the LAST -Xmx win —
  // so AUDIVERIS_OPTS reliably overrides any -Xmx in DEFAULT_JVM_OPTS (5.10.2 baked in
  // -Xmx8g; 5.11.0 bakes none, so the JVM's own default of a quarter of the container's
  // memory applies unless this is set). JAVA_TOOL_OPTIONS would NOT work: the JVM
  // prepends it, so a baked value would win.
  const environmentOverrides = options.javaMaxHeap
    ? { AUDIVERIS_OPTS: `-Xmx${options.javaMaxHeap}` }
    : undefined;
  const outcome = await runProcess(
    options.audiverisCommand,
    [
      '-batch',
      '-export',
      ...engineConstantsFor(pdfResolution),
      ...sheetArguments,
      '-output',
      outputDirectory,
      inputPath,
    ],
    options.timeoutMs,
    environmentOverrides,
    abortSignal,
  );
  return { outcome, movements: await collectMovements(outputDirectory) };
}

const logTailOf = (log: string) => log.slice(-LOG_TAIL_CHARS);

const DELETED_WHILE_RUNNING: OmrResult = {
  status: 'failed',
  movements: [],
  failure: { class: 'omr-failed', detail: 'The job was deleted while it was running.' },
  logTail: '',
};

function pageTooLarge(detail: string, log: string): OmrResult {
  return { status: 'failed', movements: [], failure: { class: 'page-too-large', detail }, logTail: logTailOf(log) };
}

/** The plan for this input: a PDF's from its page sizes; anything else the default. An
 *  unreadable file falls back to the default — the engine's own refusal is the better
 *  diagnosis. */
async function rasterPlanOfInput(inputPath: string): Promise<RasterPlan> {
  if (!isPdfPath(inputPath)) return DEFAULT_RASTER_PLAN;
  try {
    return rasterPlanFor(pdfPageSizesOf(await readFile(inputPath)));
  } catch {
    return DEFAULT_RASTER_PLAN;
  }
}

const isPdfPath = (path: string) => /\.pdf$/i.test(path);

/** What one conversion has run so far: the pass that counts, the log of every pass, the
 *  resolution that pass used and the notes owed to the client. */
interface ConversionState {
  pass: { outcome: ProcessOutcome; movements: MovementFile[] };
  log: string;
  pdfResolution: number;
  notes: string[];
}

/**
 * Convert one score: read the PDF's page sizes and pick the resolution; a full pass;
 * when the engine still refused a page as too large (a size the scan could not read), ONE
 * pass at the resolution its log implies; when the book exports nothing because
 * individual sheets are broken, ONE salvage retry excluding exactly those sheets. The
 * result always says what happened — movements, exclusions, notes, or a failure class.
 */
export async function convertScore(
  inputPath: string,
  outputDirectory: string,
  options: OmrRunOptions,
  abortSignal?: AbortSignal,
): Promise<OmrResult> {
  const plan = await rasterPlanOfInput(inputPath);
  if (plan.kind === 'too-large') return pageTooLarge(plan.detail, '');
  const fullPass = await runOnce(inputPath, outputDirectory, options, plan.pdfResolution, undefined, abortSignal);
  if (fullPass.outcome.aborted) return DELETED_WHILE_RUNNING;
  let state: ConversionState = {
    pass: fullPass,
    log: fullPass.outcome.log,
    pdfResolution: plan.pdfResolution,
    notes: plan.note ? [plan.note] : [],
  };
  if (state.pass.movements.length === 0) {
    const refitted = await refitAfterTooLargeRefusal(inputPath, outputDirectory, options, state, abortSignal);
    if ('status' in refitted) return refitted;
    state = refitted;
  }
  if (state.pass.movements.length > 0) {
    return { status: 'done', movements: state.pass.movements, ...notesOf(state), logTail: logTailOf(state.log) };
  }
  return salvageBrokenSheets(inputPath, outputDirectory, options, state, abortSignal);
}

const notesOf = (state: ConversionState) => (state.notes.length > 0 ? { notes: state.notes } : {});

/**
 * The backstop for a page size the PDF scan could not read: the engine refused a sheet
 * as too large, and its log names the pixel count. A PDF gets one pass at the resolution
 * that fits; an image (whose pixels no setting changes) or a page too large even at the
 * floor fails as `page-too-large`. No refusal in the log → the state, unchanged.
 */
async function refitAfterTooLargeRefusal(
  inputPath: string,
  outputDirectory: string,
  options: OmrRunOptions,
  state: ConversionState,
  abortSignal?: AbortSignal,
): Promise<ConversionState | OmrResult> {
  const refit = planFromTooLargeLog(state.log, state.pdfResolution);
  if (!refit) return state;
  if (!isPdfPath(inputPath)) {
    return pageTooLarge(
      `This image is larger than the scan engine's ${ENGINE_MAX_PIXEL_COUNT / 1_000_000}-megapixel page limit — scale it down and try again.`,
      state.log,
    );
  }
  if (refit.kind === 'too-large') return pageTooLarge(refit.detail, state.log);
  const pass = await runOnce(inputPath, outputDirectory, options, refit.pdfResolution, undefined, abortSignal);
  if (pass.outcome.aborted) return DELETED_WHILE_RUNNING;
  return {
    pass,
    log: `${state.log}\n--- retry at ${refit.pdfResolution} DPI (a page was too large) ---\n${pass.outcome.log}`,
    pdfResolution: refit.pdfResolution,
    notes: refit.note ? [refit.note] : [],
  };
}

/**
 * Per-sheet salvage: Audiveris refuses whole-book export over one broken page. When the
 * log names the broken sheets AND the total, retry on the healthy complement. The total
 * is capped: it is parsed from a log line, and allocating an unbounded array from
 * untrusted text would be a self-inflicted out-of-memory (review note).
 */
async function salvageBrokenSheets(
  inputPath: string,
  outputDirectory: string,
  options: OmrRunOptions,
  state: ConversionState,
  abortSignal?: AbortSignal,
): Promise<OmrResult> {
  const passLog = state.pass.outcome.log;
  const brokenSheets = brokenSheetsOf(passLog);
  const totalSheets = totalSheetsOf(passLog);
  const salvageable =
    !state.pass.outcome.timedOut &&
    brokenSheets.length > 0 &&
    totalSheets !== null &&
    totalSheets <= MAX_SALVAGE_SHEETS;
  const healthySheets = salvageable
    ? Array.from({ length: totalSheets }, (_, index) => index + 1).filter(
        (sheetNumber) => !brokenSheets.includes(sheetNumber),
      )
    : [];
  if (healthySheets.length === 0) {
    return {
      status: 'failed',
      movements: [],
      ...notesOf(state),
      failure: classifyFailure(state.log, state.pass.outcome.timedOut),
      logTail: logTailOf(state.log),
    };
  }
  const salvagePass = await runOnce(
    inputPath,
    outputDirectory,
    options,
    state.pdfResolution,
    healthySheets,
    abortSignal,
  );
  const combinedLog = `${state.log}\n--- salvage retry (sheets ${healthySheets.join(', ')}) ---\n${salvagePass.outcome.log}`;
  if (salvagePass.movements.length > 0) {
    return {
      status: 'done',
      movements: salvagePass.movements,
      excludedSheets: brokenSheets,
      ...notesOf(state),
      logTail: logTailOf(combinedLog),
    };
  }
  return {
    status: 'failed',
    movements: [],
    ...notesOf(state),
    failure: classifyFailure(combinedLog, salvagePass.outcome.timedOut),
    logTail: logTailOf(combinedLog),
  };
}
