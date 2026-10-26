import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  brokenSheetsOf,
  convertScore,
  totalSheetsOf,
  validateJavaMaxHeap,
  type OmrRunOptions,
} from '../src/audiveris';

const FAKE: readonly string[] = ['node', join(process.cwd(), 'fake-audiveris', 'fake.mjs')];
const options = (timeoutMs = 30_000): OmrRunOptions => ({ audiverisCommand: FAKE, timeoutMs });

const temporaryDirectories: string[] = [];
async function scenarioInput(scenario: string): Promise<{ inputPath: string; outDirectory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'omr-test-'));
  temporaryDirectories.push(directory);
  const inputPath = join(directory, `${scenario}.pdf`);
  await writeFile(inputPath, `${scenario}\n(fake score)`);
  return { inputPath, outDirectory: join(directory, 'out') };
}
afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('convertScore — the corpus-taught contract', () => {
  it('a clean book exports one movement', async () => {
    const { inputPath, outDirectory } = await scenarioInput('ok');
    const result = await convertScore(inputPath, outDirectory, options());
    expect(result.status).toBe('done');
    expect(result.movements.map((movement) => movement.filename)).toEqual(['ok/ok.mxl']);
    expect(result.excludedSheets).toBeUndefined();
  });

  it('a movement-split book returns EVERY movement, name-sorted (never just the first)', async () => {
    const { inputPath, outDirectory } = await scenarioInput('movements');
    const result = await convertScore(inputPath, outDirectory, options());
    expect(result.status).toBe('done');
    expect(result.movements.map((movement) => movement.filename)).toEqual([
      'movements/movements.mvt1.mxl',
      'movements/movements.mvt2.mxl',
    ]);
  });

  it('a broken sheet triggers ONE salvage retry excluding it — the rest of the book survives', async () => {
    const { inputPath, outDirectory } = await scenarioInput('badsheet');
    const result = await convertScore(inputPath, outDirectory, options());
    expect(result.status).toBe('done');
    expect(result.movements.map((movement) => movement.filename)).toEqual(['badsheet/badsheet.mxl']);
    expect(result.excludedSheets).toEqual([2]); // the client must tell its user pages are missing
  });

  it('a rhythm-analysis abort is named explicitly — no retry can help', async () => {
    const { inputPath, outDirectory } = await scenarioInput('rhythms');
    const result = await convertScore(inputPath, outDirectory, options());
    expect(result.status).toBe('failed');
    expect(result.failure?.class).toBe('rhythm-analysis-abort');
    expect(result.logTail).toContain('no correct rhythm');
  });

  it('a rhythm abort still classifies as one when the log also carries WARN-level exception names', async () => {
    const { inputPath, outDirectory } = await scenarioInput('rhythms-noisy');
    const result = await convertScore(inputPath, outDirectory, options());
    expect(result.status).toBe('failed');
    expect(result.failure?.class).toBe('rhythm-analysis-abort');
  });

  it('the crash branch stays LAST: a rhythm abort followed by a fatal line is still the rhythm abort', async () => {
    const { inputPath, outDirectory } = await scenarioInput('rhythms-then-fatal');
    const result = await convertScore(inputPath, outDirectory, options());
    expect(result.failure?.class).toBe('rhythm-analysis-abort');
  });

  it('… and an unreadable input followed by a fatal line is still the unreadable input', async () => {
    const { inputPath, outDirectory } = await scenarioInput('unreadable-then-fatal');
    const result = await convertScore(inputPath, outDirectory, options());
    expect(result.failure?.class).toBe('unreadable-input');
  });

  it('WARN-level exception names alone are not a crash — "produced no output" is the answer', async () => {
    const { inputPath, outDirectory } = await scenarioInput('warn-noise-only');
    const result = await convertScore(inputPath, outDirectory, options());
    expect(result.failure?.class).toBe('omr-failed');
    expect(result.failure?.detail).toContain('produced no output');
  });

  it('heap exhaustion outranks the rhythm class — rhythm noise and then an OOM is the OOM', async () => {
    const { inputPath, outDirectory } = await scenarioInput('rhythms-then-oom');
    const result = await convertScore(inputPath, outDirectory, options());
    expect(result.failure?.detail).toContain('out of memory');
  });

  it('heap exhaustion and a fatal crash are named, not left unclassified', async () => {
    const oom = await scenarioInput('oom');
    const oomResult = await convertScore(oom.inputPath, oom.outDirectory, options());
    expect(oomResult.failure?.class).toBe('omr-failed');
    expect(oomResult.failure?.detail).toContain('out of memory');
    const crash = await scenarioInput('crash');
    const crashResult = await convertScore(crash.inputPath, crash.outDirectory, options());
    expect(crashResult.failure?.detail).toContain('crashed');
  });

  it('an unreadable input is classified as such', async () => {
    const { inputPath, outDirectory } = await scenarioInput('garbage');
    const result = await convertScore(inputPath, outDirectory, options());
    expect(result.status).toBe('failed');
    expect(result.failure?.class).toBe('unreadable-input');
  });

  it('a hung run is killed and reported as a timeout', async () => {
    const { inputPath, outDirectory } = await scenarioInput('slow');
    const result = await convertScore(inputPath, outDirectory, options(500));
    expect(result.status).toBe('failed');
    expect(result.failure?.class).toBe('timeout');
  });

  it('the timeout kill reaches the engine’s CHILD too — a launcher over a JVM leaves nothing behind', async () => {
    // The wedged-pair incident: killing the shim left the JVM running past the budget.
    // On Windows this pin cannot bite: libuv puts every Node child in a job object with
    // kill-on-close, so a plain kill of the fake launcher already takes its grandchild
    // down — the real Audiveris.exe has no such job object. The POSIX run (CI is
    // ubuntu-latest) is the one that proves the process-group kill.
    const { inputPath, outDirectory } = await scenarioInput('slowtree');
    const result = await convertScore(inputPath, outDirectory, options(1500));
    expect(result.failure?.class).toBe('timeout');
    const { readFile } = await import('node:fs/promises');
    const grandchildPid = Number(await readFile(`${inputPath}.grandchild-pid`, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 500));
    let alive = true;
    try {
      process.kill(grandchildPid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it('an abort (a deleted job) ends the run at once and says so', async () => {
    const { inputPath, outDirectory } = await scenarioInput('slow');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const startedAt = Date.now();
    const result = await convertScore(inputPath, outDirectory, options(30_000), controller.signal);
    expect(Date.now() - startedAt).toBeLessThan(4000);
    expect(result.status).toBe('failed');
    expect(result.failure?.detail).toContain('deleted');
  });
});

describe('large pages (#14) — a page the engine refuses is retried once at a fitted DPI', () => {
  it('an ordinary book is read at 400 DPI in one pass, with no note', async () => {
    const { inputPath, outDirectory } = await scenarioInput('ok');
    const result = await convertScore(inputPath, outDirectory, options());
    expect(result.status).toBe('done');
    expect(result.logTail).toContain('[fake] pdfResolution=400');
    expect(result.logTail).not.toContain('retry at');
    expect(result.notes).toBeUndefined();
  });

  it('Abode: refused at 400 DPI, retried ONCE at 308 from the logged size, and the notes say so', async () => {
    const { inputPath, outDirectory } = await scenarioInput('large-pages');
    const result = await convertScore(inputPath, outDirectory, options());
    expect(result.status).toBe('done');
    expect(result.movements.map((movement) => movement.filename)).toEqual(['large-pages/large-pages.mxl']);
    expect(result.excludedSheets).toBeUndefined(); // retried, not salvaged away
    expect(result.logTail).toContain('retry at 308 DPI');
    expect(result.logTail).not.toContain('salvage retry');
    expect(result.notes).toEqual([
      "The pages are large (12.6 × 16.6 in), so they were read at 308 DPI instead of 400 to stay under the scan engine's 20-megapixel page limit.",
    ]);
  });

  it('a refusal without its `Loaded image` line still fits, from the count alone', async () => {
    const { inputPath, outDirectory } = await scenarioInput('large-pages-no-size');
    const result = await convertScore(inputPath, outDirectory, options());
    expect(result.status).toBe('done');
    expect(result.logTail).toContain('retry at 308 DPI');
    expect(result.notes).toEqual([expect.stringMatching(/^The pages are large, so they were read at 308 DPI/)]);
  });

  it('a page too large even at 300 DPI fails as page-too-large, naming the size the log reported — no retry', async () => {
    const { inputPath, outDirectory } = await scenarioInput('poster');
    const result = await convertScore(inputPath, outDirectory, options());
    expect(result.status).toBe('failed');
    expect(result.failure?.class).toBe('page-too-large');
    expect(result.failure?.detail).toContain('24.0 × 36.0 in (9600 × 14400 pixels at 400 DPI)');
    expect(result.failure?.detail).toContain('even at 300 DPI');
    expect(result.logTail).not.toContain('retry');
  });

  it('a TIMED-OUT pass is never refitted, even with a refusal in its log — the job ends at one timeout', async () => {
    const { inputPath, outDirectory } = await scenarioInput('large-pages-then-hang');
    const result = await convertScore(inputPath, outDirectory, options(1500));
    expect(result.failure?.class).toBe('timeout');
    expect(result.logTail).not.toContain('retry at');
    expect(result.logTail.match(/\[fake\] pdfResolution=/g)).toHaveLength(1);
  });

  it('an image over the limit fails as page-too-large — no DPI can shrink it, and salvage must not run', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'omr-test-'));
    temporaryDirectories.push(directory);
    const inputPath = join(directory, 'too-large-image.png');
    await writeFile(inputPath, 'too-large-image.png');
    const result = await convertScore(inputPath, join(directory, 'out'), options());
    expect(result.failure?.class).toBe('page-too-large');
    expect(result.failure?.detail).toContain('image is larger');
    expect(result.logTail).not.toContain('salvage retry');
  });
});

describe('JVM heap sizing — the OMR_JAVA_MAX_HEAP knob', () => {
  it('a configured heap reaches the engine process as AUDIVERIS_OPTS (the fake echoes it)', async () => {
    const { inputPath, outDirectory } = await scenarioInput('ok');
    const result = await convertScore(inputPath, outDirectory, {
      ...options(),
      javaMaxHeap: '6g',
    });
    expect(result.status).toBe('done');
    expect(result.logTail).toContain('AUDIVERIS_OPTS=-Xmx6g');
  });

  it('no configured heap means no AUDIVERIS_OPTS override — the engine default stands', async () => {
    const { inputPath, outDirectory } = await scenarioInput('ok');
    const result = await convertScore(inputPath, outDirectory, options());
    expect(result.status).toBe('done');
    expect(result.logTail).not.toContain('AUDIVERIS_OPTS=');
  });

  it('validateJavaMaxHeap accepts -Xmx grammar and rejects everything else, loudly', () => {
    expect(validateJavaMaxHeap('6g')).toBe('6g');
    expect(validateJavaMaxHeap('4096m')).toBe('4096m');
    expect(validateJavaMaxHeap('512K')).toBe('512K');
    expect(validateJavaMaxHeap('8589934592')).toBe('8589934592'); // bare bytes are legal
    for (const bad of ['', '6 g', '-Xmx6g', '6gb', 'lots', '1.5g']) {
      expect(() => validateJavaMaxHeap(bad)).toThrow(/OMR_JAVA_MAX_HEAP/);
    }
  });
});

describe('log parsing helpers', () => {
  it('extracts broken sheets — including the REAL 5.10.2 log shapes', () => {
    // The real batch log (verified against the corpus's Bue m'ani): the ordinal lives in
    // the book tag, not after the word "sheet".
    expect(brokenSheetsOf("INFO  [Bue_m'ani#2]  SheetStub 1194 | Sheet Bue_m'ani#2 flagged as invalid.")).toEqual([2]);
    expect(brokenSheetsOf("WARN  [Bue_m'ani#2]  Book 2044 | Error processing stub")).toEqual([2]);
    // The fake/simple shapes still parse.
    expect(brokenSheetsOf('Sheet #2 flagged invalid — export aborted')).toEqual([2]);
    expect(brokenSheetsOf('Error processing on sheet 3\nsheet #5 invalid')).toEqual([3, 5]);
    expect(brokenSheetsOf('all sheets fine')).toEqual([]);
    // Negated phrasing must not exclude a healthy page from the salvage (review note).
    expect(brokenSheetsOf('sheet #4 processed without error')).toEqual([]);
    expect(brokenSheetsOf('no error on sheet 6')).toEqual([]);
  });

  it('extracts the total sheet count — stated, or the highest ordinal the run touched', () => {
    expect(totalSheetsOf('Book badsheet has 3 sheets')).toBe(3);
    expect(totalSheetsOf('sheets: 12')).toBe(12);
    // The real batch log states no total; stub/sheet/image ordinals carry it.
    expect(totalSheetsOf('End of Stub#1\nStored /sheet#2/sheet#2.xml\nLoaded image #2')).toBe(2);
    expect(totalSheetsOf('nothing here')).toBeNull();
  });

  it('a hostile long line is read in linear time (review 2026-10-26: 40,000 digits took 3.8 s)', () => {
    // 100,000 characters: instant when linear, about 25 s if a quadratic pattern came back —
    // long enough to fail the bound, short enough to fail rather than hang the suite.
    const hostileLines = [
      '1'.repeat(100_000),
      `${'1'.repeat(50_000)}${' '.repeat(50_000)}`,
      `sheet ${' '.repeat(100_000)}`,
      `Sheet #${'9'.repeat(100_000)} flagged as invalid`,
      'stub #1 '.repeat(12_500),
    ];
    for (const line of hostileLines) {
      const startedAt = Date.now();
      totalSheetsOf(line);
      brokenSheetsOf(line);
      expect(Date.now() - startedAt).toBeLessThan(1000);
    }
  });
});
