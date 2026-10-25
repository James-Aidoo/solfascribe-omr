/**
 * Page size → rasterization settings (service repo #14, large pages).
 *
 * Audiveris rasterizes each PDF page at `ImageLoading.pdfResolution` DPI and then refuses
 * any sheet whose image exceeds `LoadStep.maxPixelCount` pixels (20,000,000 by default):
 * "Too large image: 33,580,644 pixels (vs 20,000,000 max)". The sheet is flagged invalid
 * and, with every sheet of a book refused, nothing is exported. At the service's 400 DPI
 * an A4 or Letter page is 15–16 megapixels and fits; the owner's "Abode nyinaa wura"
 * (12.6 × 16.6 in) is 33.6 MP and did not, nor would any A3, tabloid or large scan.
 *
 * The rule (measured 2026-10-25 — see README "Large pages"): read the page sizes from the
 * PDF before the run; keep 400 DPI when every page fits the engine's limit, otherwise use
 * the highest whole DPI at which the LARGEST page fits, down to a floor of 300 DPI, and
 * say so in the job's notes. A PDF that would not fit even at 300 DPI fails at once with
 * a message naming its page size, before the engine is spawned.
 *
 * Why 300 is a floor and not a suggestion: below it the engine reads small symbols worse
 * (its own guidance), and SolfaScribe's lyric channel fits the MusicXML's declared scale
 * between 0.7 and 1.2 of what Audiveris writes — a scale that tracks 300 / DPI — so
 * 300–400 DPI keeps that fit in range, where 250 DPI and below would not.
 */
import { inflateSync } from 'node:zlib';

/** The engine's own pixel limit — Audiveris's `LoadStep.maxPixelCount` default. */
export const ENGINE_MAX_PIXEL_COUNT = 20_000_000;
/** The tuned resolution (README "A measured, minimal tuned invocation"). */
export const PREFERRED_PDF_RESOLUTION = 400;
/** The lowest resolution the service will ask for (see the module note). */
export const MINIMUM_PDF_RESOLUTION = 300;

const POINTS_PER_INCH = 72;

export interface PageSizeInPoints {
  width: number;
  height: number;
}

/**
 * The pixels one page becomes at `dotsPerInch`, exactly as PDFBox's `renderImageWithDPI`
 * sizes its image: each side `floor(points × dpi / 72)`. Rotation swaps the sides and
 * leaves the product alone.
 */
export function pixelCountAt(page: PageSizeInPoints, dotsPerInch: number): number {
  const scale = dotsPerInch / POINTS_PER_INCH;
  const widthPixels = Math.max(Math.floor(page.width * scale), 1);
  const heightPixels = Math.max(Math.floor(page.height * scale), 1);
  return widthPixels * heightPixels;
}

export type RasterPlan =
  | {
      kind: 'scan';
      /** The DPI to pass as `ImageLoading.pdfResolution`. */
      pdfResolution: number;
      /** A sentence for the job's notes when the run departs from 400 DPI. */
      note?: string;
    }
  | { kind: 'too-large'; detail: string };

/** The plan for a PDF whose page sizes could not be read (or a plain image input): the
 *  tuned 400 DPI, with the logged-size retry as the backstop (`planFromTooLargeLog`). */
export const DEFAULT_RASTER_PLAN: RasterPlan = { kind: 'scan', pdfResolution: PREFERRED_PDF_RESOLUTION };

/** Every page fits at this DPI. */
function everyPageFitsAt(pages: readonly PageSizeInPoints[], dotsPerInch: number): boolean {
  return pages.every((page) => pixelCountAt(page, dotsPerInch) <= ENGINE_MAX_PIXEL_COUNT);
}

/** The page that becomes the most pixels — the one that sets the resolution. */
function largestPageOf(pages: readonly PageSizeInPoints[]): PageSizeInPoints {
  return pages.reduce((largest, page) =>
    pixelCountAt(page, PREFERRED_PDF_RESOLUTION) > pixelCountAt(largest, PREFERRED_PDF_RESOLUTION)
      ? page
      : largest,
  );
}

/** "12.6 × 16.6 in" — the size a person would measure with a ruler. */
export function describePageSize(page: PageSizeInPoints): string {
  const inches = (points: number) => (points / POINTS_PER_INCH).toFixed(1);
  return `${inches(page.width)} × ${inches(page.height)} in`;
}

const megapixels = (pixelCount: number) => (pixelCount / 1_000_000).toFixed(1);

/**
 * The settings for one PDF, from the sizes of its pages: 400 DPI when every page fits the
 * engine's limit; else the highest whole DPI ≥ 300 at which every page fits, with a note;
 * else a refusal that names the largest page. No pages read → the default plan.
 */
export function rasterPlanFor(pages: readonly PageSizeInPoints[]): RasterPlan {
  if (pages.length === 0 || everyPageFitsAt(pages, PREFERRED_PDF_RESOLUTION)) return DEFAULT_RASTER_PLAN;
  const largestPage = largestPageOf(pages);
  for (let dotsPerInch = PREFERRED_PDF_RESOLUTION - 1; dotsPerInch >= MINIMUM_PDF_RESOLUTION; dotsPerInch--) {
    if (everyPageFitsAt(pages, dotsPerInch)) {
      return {
        kind: 'scan',
        pdfResolution: dotsPerInch,
        note: `The pages are large (${describePageSize(largestPage)}), so they were read at ${dotsPerInch} DPI instead of ${PREFERRED_PDF_RESOLUTION} to stay under the scan engine's ${megapixels(ENGINE_MAX_PIXEL_COUNT)}-megapixel page limit.`,
      };
    }
  }
  return {
    kind: 'too-large',
    detail: `The largest page of this PDF is ${describePageSize(largestPage)}; even at ${MINIMUM_PDF_RESOLUTION} DPI it would be ${megapixels(pixelCountAt(largestPage, MINIMUM_PDF_RESOLUTION))} megapixels, over the scan engine's ${megapixels(ENGINE_MAX_PIXEL_COUNT)}-megapixel page limit. Scale the PDF to A3 or Tabloid size or smaller and try again.`,
  };
}

/**
 * The backstop when the PDF scan missed a page's size (a box held by reference, an object
 * stream the scan could not inflate) and the engine refused a sheet anyway. Its log names
 * the pixel count at the resolution it was given; the sides scale with the DPI, so the
 * fitted DPI is `dpi × √(limit / count)`, one lower for the floor() on each side. Null when
 * the log names no refusal; a refusal plan when even the floor would not fit.
 */
export function planFromTooLargeLog(log: string, attemptedResolution: number): RasterPlan | null {
  let largestCount = 0;
  for (const match of log.matchAll(/Too large image:?\s*([\d,.\s]+?)\s*pixels/gi)) {
    largestCount = Math.max(largestCount, Number(match[1]!.replace(/[^\d]/g, '')));
  }
  if (largestCount <= ENGINE_MAX_PIXEL_COUNT) return null;
  const fittedResolution =
    Math.floor(attemptedResolution * Math.sqrt(ENGINE_MAX_PIXEL_COUNT / largestCount)) - 1;
  if (fittedResolution < MINIMUM_PDF_RESOLUTION) {
    return {
      kind: 'too-large',
      detail: `A page of this file is ${megapixels(largestCount)} megapixels at ${attemptedResolution} DPI, too large for the scan engine's ${megapixels(ENGINE_MAX_PIXEL_COUNT)}-megapixel page limit even at ${MINIMUM_PDF_RESOLUTION} DPI. Scale it to A3 or Tabloid size or smaller and try again.`,
    };
  }
  return {
    kind: 'scan',
    pdfResolution: fittedResolution,
    note: `The pages are large, so they were read at ${fittedResolution} DPI instead of ${PREFERRED_PDF_RESOLUTION} to stay under the scan engine's ${megapixels(ENGINE_MAX_PIXEL_COUNT)}-megapixel page limit.`,
  };
}

/* ------------------------------ reading the page sizes ------------------------------ */

const NUMBER = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)`;
const BOX_PATTERN = (name: string) =>
  new RegExp(String.raw`/${name}\s*\[\s*(${NUMBER})\s+(${NUMBER})\s+(${NUMBER})\s+(${NUMBER})\s*\]`);
const MEDIA_BOX = BOX_PATTERN('MediaBox');
const CROP_BOX = BOX_PATTERN('CropBox');
const PAGE_TYPE = /\/Type\s*\/Page(?![s\w])/;
const PAGES_TYPE = /\/Type\s*\/Pages\b/;
const USER_UNIT = new RegExp(String.raw`/UserUnit\s+(${NUMBER})`);

interface Rectangle {
  left: number;
  bottom: number;
  right: number;
  top: number;
}

function rectangleOf(match: RegExpExecArray | null): Rectangle | null {
  if (!match) return null;
  const [x1, y1, x2, y2] = match.slice(1, 5).map(Number) as [number, number, number, number];
  return {
    left: Math.min(x1, x2),
    bottom: Math.min(y1, y2),
    right: Math.max(x1, x2),
    top: Math.max(y1, y2),
  };
}

/** What PDFBox renders: the crop box clipped to the media box (the crop box defaults to it). */
function renderedBoxOf(mediaBox: Rectangle, cropBox: Rectangle | null): Rectangle {
  if (!cropBox) return mediaBox;
  const clipped = {
    left: Math.max(mediaBox.left, cropBox.left),
    bottom: Math.max(mediaBox.bottom, cropBox.bottom),
    right: Math.min(mediaBox.right, cropBox.right),
    top: Math.min(mediaBox.top, cropBox.top),
  };
  return clipped.right > clipped.left && clipped.top > clipped.bottom ? clipped : mediaBox;
}

/** The dictionaries of every object in the file: the plain `N G obj … endobj` bodies, plus
 *  the objects packed into Flate-compressed object streams (PDF 1.5+ writers hide pages
 *  there). An object stream that will not inflate is skipped — the log backstop covers it. */
function objectBodiesOf(text: string): string[] {
  const bodies: string[] = [];
  for (const match of text.matchAll(/\d+\s+\d+\s+obj\b([\s\S]*?)\bendobj\b/g)) {
    const body = match[1]!;
    bodies.push(body);
    if (/\/Type\s*\/ObjStm\b/.test(body)) bodies.push(...objectStreamMembersOf(body));
  }
  return bodies;
}

function objectStreamMembersOf(body: string): string[] {
  const streamStart = /stream\r?\n/.exec(body);
  const streamEnd = body.lastIndexOf('endstream');
  if (!streamStart || streamEnd < 0 || !/\/FlateDecode\b/.test(body)) return [];
  const header = body.slice(0, streamStart.index);
  const firstOffset = Number(/\/First\s+(\d+)/.exec(header)?.[1] ?? NaN);
  if (!Number.isFinite(firstOffset)) return [];
  let decoded: string;
  try {
    const compressed = Buffer.from(body.slice(streamStart.index + streamStart[0].length, streamEnd), 'latin1');
    decoded = inflateSync(compressed, { finishFlush: 2 /* Z_SYNC_FLUSH: tolerate a trailing EOL */ }).toString('latin1');
  } catch {
    return [];
  }
  const offsets = [...decoded.slice(0, firstOffset).matchAll(/\d+\s+(\d+)/g)].map((pair) => Number(pair[1]));
  return offsets.map((offset, index) =>
    decoded.slice(firstOffset + offset, index + 1 < offsets.length ? firstOffset + offsets[index + 1]! : undefined),
  );
}

/**
 * The rendered size of every page the file's bytes show, in points. Approximate on
 * purpose, like `pdfPageCountOf`: a page whose box is inherited takes the largest box any
 * page-tree node declares (the conservative direction — a larger box only lowers the DPI),
 * and a box held by indirect reference is not followed. What the scan misses, the log
 * backstop catches.
 */
export function pdfPageSizesOf(bytes: Uint8Array): PageSizeInPoints[] {
  const bodies = objectBodiesOf(Buffer.from(bytes).toString('latin1'));
  let inheritedBox: Rectangle | null = null;
  for (const body of bodies) {
    if (!PAGES_TYPE.test(body)) continue;
    const box = rectangleOf(MEDIA_BOX.exec(body));
    if (box && (!inheritedBox || areaOf(box) > areaOf(inheritedBox))) inheritedBox = box;
  }
  const sizes: PageSizeInPoints[] = [];
  for (const body of bodies) {
    if (!PAGE_TYPE.test(body)) continue;
    const mediaBox = rectangleOf(MEDIA_BOX.exec(body)) ?? inheritedBox;
    if (!mediaBox) continue;
    const rendered = renderedBoxOf(mediaBox, rectangleOf(CROP_BOX.exec(body)));
    const userUnit = Number(USER_UNIT.exec(body)?.[1] ?? 1) || 1;
    sizes.push({
      width: (rendered.right - rendered.left) * userUnit,
      height: (rendered.top - rendered.bottom) * userUnit,
    });
  }
  return sizes;
}

function areaOf(box: Rectangle): number {
  return (box.right - box.left) * (box.top - box.bottom);
}
