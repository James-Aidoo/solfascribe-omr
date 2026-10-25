import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  ENGINE_MAX_PIXEL_COUNT,
  pdfPageSizesOf,
  pixelCountAt,
  planFromTooLargeLog,
  rasterPlanFor,
} from '../src/pageRaster';

const A4 = { width: 595.28, height: 841.89 };
const LETTER = { width: 612, height: 792 };
const A3 = { width: 841.89, height: 1190.55 };
const TABLOID = { width: 792, height: 1224 };
// The owner's "Abode nyinaa wura" (issue #14): two pages, 12.6 × 16.3 and 12.6 × 16.6 in.
const ABODE_PAGES = [
  { width: 909.4488, height: 1170.446 },
  { width: 909.4488, height: 1196.623 },
];
const POSTER = { width: 24 * 72, height: 36 * 72 };

describe('pixelCountAt — the engine’s own arithmetic', () => {
  it('matches the counts the real engine logged for Abode at 400 DPI, to the pixel', () => {
    // "Too large image: 32,848,104 pixels" and "33,580,644 pixels" (5.11.0, 2026-10-25).
    expect(pixelCountAt(ABODE_PAGES[0]!, 400)).toBe(32_848_104);
    expect(pixelCountAt(ABODE_PAGES[1]!, 400)).toBe(33_580_644);
  });

  it('is the same for a rotated page (the sides swap, the product does not)', () => {
    expect(pixelCountAt({ width: A3.height, height: A3.width }, 400)).toBe(pixelCountAt(A3, 400));
  });
});

describe('rasterPlanFor — page size → resolution', () => {
  it('A4 and Letter keep the tuned 400 DPI, with no note — nothing changes for them', () => {
    expect(rasterPlanFor([A4, A4, A4])).toEqual({ kind: 'scan', pdfResolution: 400 });
    expect(rasterPlanFor([LETTER])).toEqual({ kind: 'scan', pdfResolution: 400 });
  });

  it('no readable page sizes → the default 400 (the log backstop covers what the scan missed)', () => {
    expect(rasterPlanFor([])).toEqual({ kind: 'scan', pdfResolution: 400 });
  });

  it('Abode is read at 308 DPI — the highest at which its largest page fits — and the note says so', () => {
    const plan = rasterPlanFor(ABODE_PAGES);
    expect(plan).toMatchObject({ kind: 'scan', pdfResolution: 308 });
    expect(pixelCountAt(ABODE_PAGES[1]!, 308)).toBeLessThanOrEqual(ENGINE_MAX_PIXEL_COUNT);
    expect(pixelCountAt(ABODE_PAGES[1]!, 309)).toBeGreaterThan(ENGINE_MAX_PIXEL_COUNT);
    expect(plan.kind === 'scan' && plan.note).toBe(
      "The pages are large (12.6 × 16.6 in), so they were read at 308 DPI instead of 400 to stay under the scan engine's 20.0-megapixel page limit.",
    );
  });

  it('the LARGEST page sets the resolution for the whole book, wherever it sits', () => {
    expect(rasterPlanFor([A4, A4, ABODE_PAGES[1]!, A4])).toMatchObject({ pdfResolution: 308 });
  });

  it('A3 and Tabloid fit between 300 and 400', () => {
    expect(rasterPlanFor([A3])).toMatchObject({ kind: 'scan', pdfResolution: 321 });
    expect(rasterPlanFor([TABLOID])).toMatchObject({ kind: 'scan', pdfResolution: 327 });
  });

  it('300 DPI is a hard floor: a page that just fits there is read at 300, one point larger is refused', () => {
    expect(rasterPlanFor([{ width: 1073.5, height: 1073.5 }])).toMatchObject({ pdfResolution: 300 });
    const refused = rasterPlanFor([{ width: 1074, height: 1074 }]);
    expect(refused.kind).toBe('too-large');
  });

  it('a poster is refused with its size and what to do about it', () => {
    const plan = rasterPlanFor([A4, POSTER]);
    expect(plan.kind).toBe('too-large');
    expect(plan.kind === 'too-large' && plan.detail).toBe(
      "The largest page of this PDF is 24.0 × 36.0 in; even at 300 DPI it would be 77.8 megapixels, over the scan engine's 20.0-megapixel page limit. Scale the PDF to A3 or Tabloid size or smaller and try again.",
    );
  });
});

describe('planFromTooLargeLog — the backstop, from the engine’s own refusal', () => {
  const realLog = [
    'WARN  [abode#1]                 SheetStub 411  | Too large image: 32,848,104 pixels (vs 20,000,000 max)',
    'INFO  [abode#1]                 SheetStub 1194 | Sheet abode#1 flagged as invalid.',
    'WARN  [abode#2]                 SheetStub 411  | Too large image: 33,580,644 pixels (vs 20,000,000 max)',
  ].join('\n');

  it('fits the LARGEST refused page, one DPI under the square-root estimate', () => {
    expect(planFromTooLargeLog(realLog, 400)).toMatchObject({ kind: 'scan', pdfResolution: 307 });
  });

  it('a log without a refusal → null, so the run’s own failure stands', () => {
    expect(planFromTooLargeLog('Could not export since transcription did not complete', 400)).toBeNull();
  });

  it('a refusal that would need less than 300 DPI → too-large', () => {
    const plan = planFromTooLargeLog('Too large image: 80,000,000 pixels (vs 20,000,000 max)', 400);
    expect(plan?.kind).toBe('too-large');
  });
});

describe('pdfPageSizesOf — page sizes from the bytes', () => {
  const pdf = (...objects: string[]) =>
    Buffer.from(
      `%PDF-1.7\n${objects.map((body, index) => `${index + 1} 0 obj\n${body}\nendobj\n`).join('')}%%EOF\n`,
      'latin1',
    );

  it('reads each page’s MediaBox and ignores the page-tree node', () => {
    const bytes = pdf(
      '<< /Type /Pages /Kids [2 0 R 3 0 R] /Count 2 /MediaBox [0 0 612 792] >>',
      '<< /Type /Page /Parent 1 0 R /MediaBox [0 0 909.4488 1170.446] >>',
      '<< /Type /Page /Parent 1 0 R /MediaBox [0 0 909.4488 1196.623] >>',
    );
    expect(pdfPageSizesOf(bytes)).toEqual(ABODE_PAGES);
  });

  it('a page with no box of its own inherits the page tree’s', () => {
    const bytes = pdf('<< /Type /Pages /Kids [2 0 R] /Count 1 /MediaBox [0 0 842 1191] >>', '<< /Type /Page /Parent 1 0 R >>');
    expect(pdfPageSizesOf(bytes)).toEqual([{ width: 842, height: 1191 }]);
  });

  it('the CropBox, clipped to the MediaBox, is what renders; /UserUnit scales it', () => {
    const bytes = pdf(
      '<< /Type /Page /MediaBox [0 0 1000 1000] /CropBox [100 100 700 900] >>',
      '<< /Type /Page /MediaBox [0 0 600 800] /CropBox [-50 -50 2000 2000] >>',
      '<< /Type /Page /MediaBox [0 0 612 792] /UserUnit 2 >>',
    );
    expect(pdfPageSizesOf(bytes)).toEqual([
      { width: 600, height: 800 },
      { width: 600, height: 800 },
      { width: 1224, height: 1584 },
    ]);
  });

  it('finds pages packed into a Flate-compressed object stream', () => {
    const members = ['<< /Type /Page /MediaBox [0 0 792 1224] >>', '<< /Type /Font /Subtype /Type1 >>'];
    const header = `10 0 11 ${members[0]!.length} `;
    const packed = deflateSync(Buffer.from(header + members.join(''), 'latin1'));
    const objectStream = Buffer.concat([
      Buffer.from(
        `%PDF-1.7\n5 0 obj\n<< /Type /ObjStm /N 2 /First ${header.length} /Filter /FlateDecode /Length ${packed.length} >>\nstream\n`,
        'latin1',
      ),
      packed,
      Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'),
    ]);
    expect(pdfPageSizesOf(objectStream)).toEqual([TABLOID]);
  });

  it('a file it cannot read yields no sizes, never a throw', () => {
    expect(pdfPageSizesOf(Buffer.from('not a pdf at all'))).toEqual([]);
    expect(
      pdfPageSizesOf(Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /ObjStm /First 4 /Filter /FlateDecode >>\nstream\nxx\nendstream\nendobj\n', 'latin1')),
    ).toEqual([]);
  });
});
