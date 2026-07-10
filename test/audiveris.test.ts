import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { brokenSheetsOf, convertScore, totalSheetsOf, type OmrRunOptions } from '../src/audiveris';

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
});
