/**
 * A fixed source in every result. Audiveris writes the absolute path of the file it read —
 * which here includes the job's random folder — into each MusicXML's `<source>` and its
 * `source-file` miscellaneous field. A client that keys a score by its content (SolfaScribe
 * does, so a user's edits find their score again) then sees two scans of one PDF as two
 * different scores, and the result carries a server path nobody should see.
 *
 * So each finished `.mxl` is rewritten: both fields become `SCAN_SOURCE`, and the zip is
 * written again with fixed timestamps and a fixed compression level, so the same music is
 * the same bytes. Only Node's zlib is needed — the container is small and flat.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';

interface ZipEntry {
  name: string;
  data: Buffer;
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;
/** 1980-01-01 00:00:00 in MS-DOS form: the zip format's earliest date. */
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = (0 << 9) | (1 << 5) | 1;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32Of(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** The entries of a zip, or null when the bytes are not a zip this reader understands. */
function readZipEntries(zip: Buffer): ZipEntry[] | null {
  let endOffset = -1;
  for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 22 - 0xffff); offset--) {
    if (zip.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) return null;
  const entryCount = zip.readUInt16LE(endOffset + 10);
  let cursor = zip.readUInt32LE(endOffset + 16);
  const entries: ZipEntry[] = [];
  try {
    for (let index = 0; index < entryCount; index++) {
      if (zip.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_HEADER) return null;
      const method = zip.readUInt16LE(cursor + 10);
      const compressedSize = zip.readUInt32LE(cursor + 20);
      const nameLength = zip.readUInt16LE(cursor + 28);
      const extraLength = zip.readUInt16LE(cursor + 30);
      const commentLength = zip.readUInt16LE(cursor + 32);
      const localOffset = zip.readUInt32LE(cursor + 42);
      const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
      if (zip.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER) return null;
      const dataStart =
        localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
      const stored = zip.subarray(dataStart, dataStart + compressedSize);
      if (method !== STORED && method !== DEFLATED) return null;
      entries.push({ name, data: method === STORED ? Buffer.from(stored) : inflateRawSync(stored) });
      cursor += 46 + nameLength + extraLength + commentLength;
    }
  } catch {
    return null;
  }
  return entries;
}

/** A zip with fixed timestamps, flags and compression: the same entries give the same bytes. */
function writeZipEntries(entries: readonly ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const crc = crc32Of(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_FILE_HEADER, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(DEFLATED, 8);
    local.writeUInt16LE(FIXED_DOS_TIME, 10);
    local.writeUInt16LE(FIXED_DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_DIRECTORY_HEADER, 0);
    central.writeUInt16LE(20, 4); // version made by
    local.copy(central, 6, 4, 30); // version needed … name length: the same fields, same offsets
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

/**
 * The one value written into both fields for every job. It is constant so the key a client
 * derives from the file never depends on the upload's name (a renamed copy of one PDF is the
 * same score), and no user file name is recorded in a result. It is PATH-SHAPED on purpose:
 * clients such as SolfaScribe print a `<source>` in the score header unless it looks like a
 * file path, and a bare name would be printed.
 */
export const SCAN_SOURCE = '/scan/input.pdf';

const escapeXmlText = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The two places Audiveris writes the input's path, both set to `SCAN_SOURCE`. */
export function withFixedSource(xml: string): string {
  const escaped = escapeXmlText(SCAN_SOURCE);
  return xml
    .replace(/<source>[^<]*<\/source>/g, () => `<source>${escaped}</source>`)
    .replace(
      /(<miscellaneous-field\s+name="source-file">)[^<]*(<\/miscellaneous-field>)/g,
      (_match, opening: string, closing: string) => `${opening}${escaped}${closing}`,
    );
}

/**
 * The `.mxl` with its source fixed to `SCAN_SOURCE`. A file that is not a zip this
 * reader understands comes back as null — the caller leaves it as the engine wrote it.
 */
export function mxlWithFixedSource(mxl: Buffer): Buffer | null {
  const entries = readZipEntries(mxl);
  if (!entries) return null;
  return writeZipEntries(
    entries.map((entry) =>
      entry.name.toLowerCase().endsWith('.xml') && !entry.name.startsWith('META-INF/')
        ? { name: entry.name, data: Buffer.from(withFixedSource(entry.data.toString('utf8')), 'utf8') }
        : entry,
    ),
  );
}
