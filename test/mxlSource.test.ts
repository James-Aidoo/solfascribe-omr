import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { inflateRawSync } from 'node:zlib';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JobStore } from '../src/jobs';
import { SCAN_SOURCE, mxlWithFixedSource, withFixedSource } from '../src/mxlSource';

const FAKE: readonly string[] = ['node', join(process.cwd(), 'fake-audiveris', 'fake.mjs')];
const workRoots: string[] = [];
afterEach(async () => {
  for (const workRoot of workRoots.splice(0)) await rm(workRoot, { recursive: true, force: true });
});

interface Scanned {
  mxl: Buffer;
  jobId: string;
  workDirectory: string;
}

/** Run one upload through a store on the fake engine; return its first movement's bytes. */
async function scan(scoreName: string): Promise<Scanned> {
  const workRoot = await mkdtemp(join(tmpdir(), 'omr-source-'));
  workRoots.push(workRoot);
  const store = new JobStore({ workRoot, jobTtlMs: 60_000, omr: { audiverisCommand: FAKE, timeoutMs: 30_000 } });
  const job = await store.submit(scoreName, Buffer.from('%PDF-1.4\nscenario:sourced\n(fake)', 'latin1'));
  for (let attempt = 0; attempt < 200 && store.get(job.id)?.status !== 'done'; attempt++) {
    if (store.get(job.id)?.status === 'failed') throw new Error('job failed');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const path = store.movementPathOf(job.id, store.get(job.id)!.result!.movements[0]!.filename);
  expect(path).toBeTruthy();
  return { mxl: await readFile(path!), jobId: job.id, workDirectory: job.workDirectory };
}

const withoutEncodingDate = (xml: string) => xml.replace(/<encoding-date>[^<]*<\/encoding-date>/g, '');

describe('a result carries a fixed source, not the job folder', () => {
  it('two scans of one music under DIFFERENT upload names match apart from the encoding date, zip stamps included', async () => {
    const first = await scan('Adom No.pdf');
    await new Promise((resolve) => setTimeout(resolve, 2100)); // the fake stamps its zip with the clock
    const second = await scan('Ẹ̀nsọ Nyame & Yɛ.pdf');
    expect(first.jobId).not.toBe(second.jobId);
    expect(entriesOf(first.mxl).map(withoutEncodingDate)).toEqual(entriesOf(second.mxl).map(withoutEncodingDate));
    // Every entry carries the fixed 1980-01-01 stamp, so no clock reaches the container.
    expect(zipStampsOf(first.mxl)).toEqual(zipStampsOf(second.mxl));
    expect(zipStampsOf(first.mxl)).toEqual([[0, 33], [0, 33]]);
  });

  it('no job id or absolute path appears in any entry of a result', async () => {
    const { mxl, jobId, workDirectory } = await scan('Adom No.pdf');
    expect(entriesOf(mxl)).toHaveLength(2);
    for (const body of entriesOf(mxl)) {
      expect(body).not.toContain(jobId);
      expect(body).not.toContain(workDirectory);
      expect(body).not.toMatch(/[A-Za-z]:[\\/]|\/tmp\/|omr-source-/);
    }
  });

  it('writes the one constant in both fields whatever the upload is called (spaces, Unicode, an ampersand)', async () => {
    const { mxl } = await scan('Ẹ̀nsọ Nyame & Yɛ.pdf');
    const book = entriesOf(mxl).find((body) => body.includes('<source>'))!;
    expect(book).toContain(`<source>${SCAN_SOURCE}</source>`);
    expect(book).toContain(`<miscellaneous-field name="source-file">${SCAN_SOURCE}</miscellaneous-field>`);
    expect(book).not.toContain('Nyame');
  });

  it('the constant reads as a file path to the app, which hides a path from the printed header', () => {
    // Copied from SolfaScribe's looksLikeFilePath (packages/parsers/src/musicxml.ts): a
    // `<source>` matching either is left off the header. A bare file name would be printed.
    expect(/^[A-Za-z]:[\\/]/.test(SCAN_SOURCE) || /[\\/][^\\/]+\.[A-Za-z0-9]{2,5}$/.test(SCAN_SOURCE)).toBe(true);
    expect(/[\\/][^\\/]+\.[A-Za-z0-9]{2,5}$/.test('Enso_Nyame_Ye.pdf')).toBe(false);
  });
});

describe('withFixedSource', () => {
  it('rewrites both fields and nothing else', () => {
    const xml =
      '<source>/tmp/x/7f26/a.pdf</source><miscellaneous-field name="source-file">/tmp/x/7f26/a.pdf</miscellaneous-field><software>Audiveris</software>';
    expect(withFixedSource(xml)).toBe(
      '<source>' + SCAN_SOURCE + '</source><miscellaneous-field name="source-file">' + SCAN_SOURCE + '</miscellaneous-field><software>Audiveris</software>',
    );
  });

  it('leaves bytes that are not a zip alone (null)', () => {
    expect(mxlWithFixedSource(Buffer.from('<fake-mxl/>'))).toBeNull();
  });
});

interface RawEntry {
  body: Buffer;
  time: number;
  date: number;
}

/** Each entry of a zip, read from its central directory (the service's own reader is private). */
function rawEntriesOf(mxl: Buffer): RawEntry[] {
  const entries: RawEntry[] = [];
  const end = mxl.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = mxl.readUInt16LE(end + 10);
  let cursor = mxl.readUInt32LE(end + 16);
  for (let index = 0; index < count; index++) {
    const method = mxl.readUInt16LE(cursor + 10);
    const size = mxl.readUInt32LE(cursor + 20);
    const local = mxl.readUInt32LE(cursor + 42);
    const start = local + 30 + mxl.readUInt16LE(local + 26) + mxl.readUInt16LE(local + 28);
    const raw = mxl.subarray(start, start + size);
    entries.push({
      body: method === 8 ? inflateRawSync(raw) : raw,
      time: mxl.readUInt16LE(cursor + 12),
      date: mxl.readUInt16LE(cursor + 14),
    });
    cursor += 46 + mxl.readUInt16LE(cursor + 28) + mxl.readUInt16LE(cursor + 30) + mxl.readUInt16LE(cursor + 32);
  }
  return entries;
}

const entriesOf = (mxl: Buffer) => rawEntriesOf(mxl).map((entry) => entry.body.toString('utf8'));
const zipStampsOf = (mxl: Buffer) => rawEntriesOf(mxl).map((entry) => [entry.time, entry.date]);
