/**
 * Large pages (service repo #14): read from the engine's own refusal, never from the PDF.
 *
 * Audiveris rasterizes each PDF page at `ImageLoading.pdfResolution` DPI and refuses any
 * sheet whose image exceeds `LoadStep.maxPixelCount` pixels (20,000,000 by default). With
 * every sheet of a book refused, nothing is exported. At the service's 400 DPI an A4 or
 * Letter page is 15–16 megapixels and fits; the owner's "Abode nyinaa wura" (12.6 × 16.6 in)
 * is 33.6 MP and did not, nor would any A3, tabloid or large scan.
 *
 * The rule (measured 2026-10-25 — README "Large pages"): every run starts at 400 DPI. When
 * the engine refuses a sheet as too large, its log names what it loaded —
 * `Loaded image #2 5052x6647` and `Too large image: 33,580,644 pixels (vs 20,000,000 max)` —
 * and the book is retried ONCE at the highest whole DPI at which the largest refused page
 * fits, never below 300. A page that would not fit even at 300 DPI fails as
 * `page-too-large`, naming the size the log reported.
 *
 * The service deliberately parses no PDF itself (security review 2026-10-26): an earlier
 * draft read page boxes from the upload, and a few hundred kilobytes of crafted bytes could
 * freeze the event loop or inflate gigabytes. The engine's log is the only input here, and
 * it is read in one linear pass: capped in length, line by line, long lines skipped, and
 * every pattern bounded so no backtracking can grow with the input.
 *
 * Why 300 is a floor: below it the engine reads small symbols worse (its own guidance), and
 * SolfaScribe's lyric channel fits the MusicXML's declared scale between 0.7 and 1.2 of what
 * Audiveris writes — a scale that tracks 300 / DPI — so 300–400 DPI keeps that fit in range.
 */

/** The engine's own pixel limit — Audiveris's `LoadStep.maxPixelCount` default. */
export const ENGINE_MAX_PIXEL_COUNT = 20_000_000;
/** The tuned resolution every run starts at (README "A measured, minimal tuned invocation"). */
export const PREFERRED_PDF_RESOLUTION = 400;
/** The lowest resolution the service will ask for (see the module note). */
export const MINIMUM_PDF_RESOLUTION = 300;

/** Only this much of the log is read: refusals come from the load step, early in a sheet,
 *  and a book of the service's 60-page cap logs well under this. */
export const MAX_LOG_CHARS_READ = 16_000_000;
/** The lines the refusal and load messages sit on are about 130 characters; anything far
 *  longer is not one of them and is skipped unread. */
const MAX_LINE_CHARS = 1_000;

const TOO_LARGE_LINE = /Too large image:?\s{0,4}([\d,.   ]{1,24}?)\s{0,4}pixels/;
const LOADED_IMAGE_LINE = /Loaded image\s{0,4}#\d{1,6}\s{1,4}(\d{1,7})\s{0,2}x\s{0,2}(\d{1,7})\b/;

export interface ImageSizeInPixels {
  widthPixels: number;
  heightPixels: number;
}

/** The largest sheet the engine refused: its pixel count, and its sides when the log's
 *  `Loaded image` line for it was found. */
export interface TooLargeRefusal {
  pixelCount: number;
  size?: ImageSizeInPixels;
}

export type LargePageRetry =
  | {
      kind: 'retry';
      /** The DPI to pass as `ImageLoading.pdfResolution` on the one retry. */
      pdfResolution: number;
      /** A sentence for the job's notes. */
      note: string;
    }
  | { kind: 'too-large'; detail: string };

/** Visit each line of the first `MAX_LOG_CHARS_READ` characters, skipping long lines —
 *  one linear pass with `indexOf`, no regular expression over the whole text. */
function forEachShortLine(log: string, visit: (line: string) => void): void {
  const text = log.length > MAX_LOG_CHARS_READ ? log.slice(0, MAX_LOG_CHARS_READ) : log;
  let lineStart = 0;
  while (lineStart < text.length) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd < 0) lineEnd = text.length;
    if (lineEnd - lineStart <= MAX_LINE_CHARS) visit(text.slice(lineStart, lineEnd));
    lineStart = lineEnd + 1;
  }
}

/** `33,580,644` (or `33.580.644`, `33 580 644`) → 33580644; null when it is no number. */
function pixelCountOf(written: string): number | null {
  const digits = written.replace(/\D/g, '');
  if (digits.length === 0 || digits.length > 15) return null;
  return Number(digits);
}

/**
 * The largest refused sheet in the log, or null when the engine refused none. Its sides
 * come from the `Loaded image #N WxH` line whose product is the refused count (the engine
 * logs the load before it checks the size).
 */
export function largestTooLargeRefusalOf(log: string): TooLargeRefusal | null {
  let largestCount = 0;
  const loadedSizesByCount = new Map<number, ImageSizeInPixels>();
  forEachShortLine(log, (line) => {
    if (line.includes('Too large image')) {
      const written = TOO_LARGE_LINE.exec(line)?.[1];
      const count = written === undefined ? null : pixelCountOf(written);
      if (count !== null && count > largestCount) largestCount = count;
    } else if (line.includes('Loaded image')) {
      const match = LOADED_IMAGE_LINE.exec(line);
      if (!match) return;
      const size = { widthPixels: Number(match[1]), heightPixels: Number(match[2]) };
      loadedSizesByCount.set(size.widthPixels * size.heightPixels, size);
    }
  });
  if (largestCount <= ENGINE_MAX_PIXEL_COUNT) return null;
  const size = loadedSizesByCount.get(largestCount);
  return size ? { pixelCount: largestCount, size } : { pixelCount: largestCount };
}

/**
 * The pixels the refused page could become at `dotsPerInch`, an upper bound. PDFBox sizes
 * each side `floor(points × dpi / 72)`, so a side logged as S pixels at the attempted DPI was
 * under S + 1 before the floor. Without the sides, a square page of the same count stands in.
 */
function pixelCountAtMost(refusal: TooLargeRefusal, dotsPerInch: number, attemptedResolution: number): number {
  const scale = dotsPerInch / attemptedResolution;
  if (refusal.size) {
    return (
      Math.floor((refusal.size.widthPixels + 1) * scale) * Math.floor((refusal.size.heightPixels + 1) * scale)
    );
  }
  return ((Math.sqrt(refusal.pixelCount) + 1) * scale) ** 2;
}

/** The highest whole DPI at which the refused page fits: `attempted × √(limit / count)`,
 *  floored, then lowered while the upper bound still exceeds the limit. Below the floor
 *  when even 300 DPI would not do. */
function fittedResolutionFor(refusal: TooLargeRefusal, attemptedResolution: number): number {
  let dotsPerInch = Math.floor(attemptedResolution * Math.sqrt(ENGINE_MAX_PIXEL_COUNT / refusal.pixelCount));
  while (
    dotsPerInch >= MINIMUM_PDF_RESOLUTION &&
    pixelCountAtMost(refusal, dotsPerInch, attemptedResolution) > ENGINE_MAX_PIXEL_COUNT
  ) {
    dotsPerInch--;
  }
  return dotsPerInch;
}

const LIMIT_IN_MEGAPIXELS = ENGINE_MAX_PIXEL_COUNT / 1_000_000;

/** "12.6 × 16.6 in" — the size a person would measure with a ruler — from the sides the
 *  engine logged; null when the log gave none. */
function inchesOf(refusal: TooLargeRefusal, attemptedResolution: number): string | null {
  if (!refusal.size) return null;
  const inches = (pixels: number) => (pixels / attemptedResolution).toFixed(1);
  return `${inches(refusal.size.widthPixels)} × ${inches(refusal.size.heightPixels)} in`;
}

/** "12.6 × 16.6 in (5052 × 6647 pixels at 400 DPI)", or "33.6 megapixels at 400 DPI" when
 *  the log gave no sides. */
function describeRefusedPage(refusal: TooLargeRefusal, attemptedResolution: number): string {
  const inches = inchesOf(refusal, attemptedResolution);
  if (!inches || !refusal.size) {
    return `${(refusal.pixelCount / 1_000_000).toFixed(1)} megapixels at ${attemptedResolution} DPI`;
  }
  return `${inches} (${refusal.size.widthPixels} × ${refusal.size.heightPixels} pixels at ${attemptedResolution} DPI)`;
}

/**
 * What to do after a pass at `attemptedResolution` exported nothing: null when the log names
 * no too-large refusal (the run's own failure stands); else one retry at the fitted DPI with
 * a note for the user, or `too-large` when even 300 DPI would not fit.
 */
export function largePageRetryOf(log: string, attemptedResolution: number): LargePageRetry | null {
  const refusal = largestTooLargeRefusalOf(log);
  if (!refusal) return null;
  const fittedResolution = fittedResolutionFor(refusal, attemptedResolution);
  if (fittedResolution < MINIMUM_PDF_RESOLUTION) {
    return {
      kind: 'too-large',
      detail: `A page of this PDF is ${describeRefusedPage(refusal, attemptedResolution)}; even at ${MINIMUM_PDF_RESOLUTION} DPI it would be over the scan engine's ${LIMIT_IN_MEGAPIXELS}-megapixel page limit. Scale the PDF to A3 or Tabloid size or smaller and try again.`,
    };
  }
  const inches = inchesOf(refusal, attemptedResolution);
  const pagesAre = inches ? `The pages are large (${inches})` : 'The pages are large';
  return {
    kind: 'retry',
    pdfResolution: fittedResolution,
    note: `${pagesAre}, so they were read at ${fittedResolution} DPI instead of ${attemptedResolution} to stay under the scan engine's ${LIMIT_IN_MEGAPIXELS}-megapixel page limit.`,
  };
}
