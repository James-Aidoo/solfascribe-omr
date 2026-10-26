import { describe, expect, it } from 'vitest';
import {
  ENGINE_MAX_PIXEL_COUNT,
  largePageRetryOf,
  largestTooLargeRefusalOf,
  MAX_LOG_CHARS_READ,
} from '../src/largePages';

/** The real 5.11.0 log of Abode at 400 DPI (the 2026-10-25 control run on the VM). */
const ABODE_LOG = [
  'INFO  [abode#1]                 SheetStub 1278 | Loaded image #1 5052x6502 from /work/in/abode.pdf',
  'WARN  [abode#1]                 SheetStub 411  | Too large image: 32,848,104 pixels (vs 20,000,000 max)',
  'INFO  [abode#1]                 SheetStub 1194 | Sheet abode#1 flagged as invalid.',
  'INFO  [abode#2]                 SheetStub 1278 | Loaded image #2 5052x6647 from /work/in/abode.pdf',
  'WARN  [abode#2]                 SheetStub 411  | Too large image: 33,580,644 pixels (vs 20,000,000 max)',
  'INFO  [abode#2]                 SheetStub 1194 | Sheet abode#2 flagged as invalid.',
].join('\n');

/** PDFBox's own arithmetic for a page of `points` at `dotsPerInch`: floor(points × dpi / 72). */
const pixelsAt = (widthPoints: number, heightPoints: number, dotsPerInch: number) =>
  Math.floor((widthPoints * dotsPerInch) / 72) * Math.floor((heightPoints * dotsPerInch) / 72);

describe('largestTooLargeRefusalOf — the engine’s refusal, read from its log', () => {
  it('takes the LARGEST refused sheet, with the sides its `Loaded image` line gave', () => {
    expect(largestTooLargeRefusalOf(ABODE_LOG)).toEqual({
      pixelCount: 33_580_644,
      size: { widthPixels: 5052, heightPixels: 6647 },
    });
  });

  it('the largest refusal wins wherever it sits in the log', () => {
    const lines = ABODE_LOG.split('\n');
    const largestFirst = [...lines.slice(3), ...lines.slice(0, 3)].join('\n');
    expect(largestTooLargeRefusalOf(largestFirst)?.pixelCount).toBe(33_580_644);
  });

  it('a log without a refusal → null, so the run’s own failure stands', () => {
    expect(largestTooLargeRefusalOf('Loaded image #1 3890x5006 from x.pdf\nCould not export')).toBeNull();
  });

  it('reads the count however it is grouped, and ignores a count under the limit', () => {
    expect(largestTooLargeRefusalOf('Too large image: 33.580.644 pixels')?.pixelCount).toBe(33_580_644);
    expect(largestTooLargeRefusalOf('Too large image 33580644 pixels')?.pixelCount).toBe(33_580_644);
    expect(largestTooLargeRefusalOf('Too large image: 19,999,999 pixels')).toBeNull();
  });
});

describe('largePageRetryOf — the fitted resolution', () => {
  it('Abode is retried at 308 DPI, the highest at which its largest page really fits', () => {
    expect(largePageRetryOf(ABODE_LOG, 400)).toEqual({
      kind: 'retry',
      pdfResolution: 308,
      note: "The pages are large (12.6 × 16.6 in), so they were read at 308 DPI instead of 400 to stay under the scan engine's 20-megapixel page limit.",
    });
    // Checked against PDFBox's arithmetic on the page's real size (909.4488 × 1196.623 pt).
    expect(pixelsAt(909.4488, 1196.623, 308)).toBeLessThanOrEqual(ENGINE_MAX_PIXEL_COUNT);
    expect(pixelsAt(909.4488, 1196.623, 309)).toBeGreaterThan(ENGINE_MAX_PIXEL_COUNT);
  });

  it('the fitted DPI always fits, whatever fraction the floor on each side dropped', () => {
    // A3, Tabloid, and sides that sit just under a whole pixel at 400 DPI.
    for (const [widthPoints, heightPoints] of [
      [841.89, 1190.55],
      [792, 1224],
      [935.99, 1159.19],
      [1007.99, 1007.99],
      // Here the plain square-root estimate (373 DPI) is one too high: 3761 × 5318 =
      // 20,000,998 pixels. Only the check against the logged sides brings it to 372.
      [726, 1026.7092],
    ] as const) {
      const widthPixels = Math.floor((widthPoints * 400) / 72);
      const heightPixels = Math.floor((heightPoints * 400) / 72);
      const log = `Loaded image #1 ${widthPixels}x${heightPixels}\nToo large image: ${widthPixels * heightPixels} pixels`;
      const retry = largePageRetryOf(log, 400);
      expect(retry?.kind).toBe('retry');
      if (retry?.kind !== 'retry') continue;
      expect(pixelsAt(widthPoints, heightPoints, retry.pdfResolution)).toBeLessThanOrEqual(ENGINE_MAX_PIXEL_COUNT);
      expect(retry.pdfResolution).toBeGreaterThanOrEqual(300);
    }
  });

  it('300 DPI is the floor: a page that fits there is retried at 300, a larger one is refused with its size', () => {
    // 14.9 × 14.9 in: 5962 px a side at 400 DPI; at 300 DPI 4471 × 4471 = 19,989,841.
    const fitsAtFloor = largePageRetryOf('Loaded image #1 5962x5962\nToo large image: 35,545,444 pixels', 400);
    expect(fitsAtFloor).toMatchObject({ kind: 'retry', pdfResolution: 300 });
    const poster = largePageRetryOf('Loaded image #1 9600x14400\nToo large image: 138,240,000 pixels', 400);
    expect(poster).toEqual({
      kind: 'too-large',
      detail:
        "A page of this PDF is 24.0 × 36.0 in (9600 × 14400 pixels at 400 DPI); even at 300 DPI it would be over the scan engine's 20-megapixel page limit. Scale the PDF to A3 or Tabloid size or smaller and try again.",
    });
  });

  it('without the sides, the count alone names the page in megapixels', () => {
    expect(largePageRetryOf('Too large image: 80,000,000 pixels', 400)).toMatchObject({
      kind: 'too-large',
      detail: expect.stringContaining('A page of this PDF is 80.0 megapixels at 400 DPI'),
    });
  });
});

describe('the log is read in linear time, and only so much of it', () => {
  it('hostile megabyte-long lines and a flood of near-miss lines finish in well under a second', () => {
    const hostileLogs = [
      '1'.repeat(2_000_000),
      `Too large image: ${'1'.repeat(2_000_000)}`,
      `Too large image: ${'1,'.repeat(1_000_000)} pixels`,
      'Too large image: 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 x\n'.repeat(30_000),
      'Loaded image #1 1111111x\n'.repeat(80_000),
      `${'Too large image '.repeat(60)}\n`.repeat(2_000),
    ];
    for (const log of hostileLogs) {
      const startedAt = Date.now();
      largePageRetryOf(log, 400);
      expect(Date.now() - startedAt).toBeLessThan(1000);
    }
  });

  it('a refusal on a line too long to be the engine’s is not read', () => {
    expect(largestTooLargeRefusalOf(`${'x'.repeat(2_000)} Too large image: 33,580,644 pixels`)).toBeNull();
  });

  it('nothing past the read cap is read', () => {
    const padding = `${'INFO  filler line\n'.repeat(Math.ceil(MAX_LOG_CHARS_READ / 18))}`;
    expect(largestTooLargeRefusalOf(`${padding}Too large image: 33,580,644 pixels`)).toBeNull();
    expect(largestTooLargeRefusalOf(`Too large image: 33,580,644 pixels\n${padding}`)?.pixelCount).toBe(33_580_644);
  });
});
