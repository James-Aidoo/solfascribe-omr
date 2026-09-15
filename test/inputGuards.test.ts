import { describe, expect, it } from 'vitest';
import {
  allowedExtensionOf,
  extensionFamilyOfMagic,
  inspectInput,
  pdfPageCountOf,
  redactPaths,
  safeInputFilenameOf,
} from '../src/inputGuards';

const PDF = Buffer.from('%PDF-1.4\n%âãÏÓ\n', 'latin1');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const TIFF = Buffer.from([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0]);
const ZIP = Buffer.from('PK\u0003\u0004rest', 'latin1');

describe('inspectInput — only score formats, and only when the bytes agree with the name', () => {
  it('accepts each allowed format under its own extension, case-insensitively', () => {
    expect(inspectInput('score.pdf', PDF)).toEqual({ ok: true, extension: 'pdf' });
    expect(inspectInput('SCORE.PDF', PDF)).toEqual({ ok: true, extension: 'pdf' });
    expect(inspectInput('page.png', PNG)).toEqual({ ok: true, extension: 'png' });
    expect(inspectInput('page.jpg', JPEG)).toEqual({ ok: true, extension: 'jpg' });
    expect(inspectInput('page.jpeg', JPEG)).toEqual({ ok: true, extension: 'jpeg' });
    expect(inspectInput('page.tif', TIFF)).toEqual({ ok: true, extension: 'tif' });
    expect(inspectInput('page.tiff', TIFF)).toEqual({ ok: true, extension: 'tiff' });
  });

  it('refuses the engine’s wider input surface by extension — .omr books, images it would also open', () => {
    expect(inspectInput('book.omr', ZIP)).toMatchObject({ ok: false, reason: 'unsupported-extension' });
    expect(inspectInput('page.bmp', PNG)).toMatchObject({ ok: false, reason: 'unsupported-extension' });
    expect(inspectInput('noextension', PDF)).toMatchObject({ ok: false, reason: 'unsupported-extension' });
  });

  it('refuses a file whose bytes are not what its name claims', () => {
    expect(inspectInput('book.pdf', ZIP)).toMatchObject({
      ok: false,
      reason: 'content-does-not-match-extension',
    });
    expect(inspectInput('page.png', JPEG)).toMatchObject({ ok: false });
    expect(inspectInput('score.pdf', Buffer.alloc(0))).toMatchObject({ ok: false });
    expect(extensionFamilyOfMagic(ZIP)).toBeNull();
    expect(allowedExtensionOf('x.PdF')).toBe('pdf');
  });
});

describe('pdfPageCountOf — pages, never the page tree', () => {
  it('counts /Type /Page objects and excludes /Type /Pages', () => {
    const pdf = Buffer.from(
      '%PDF-1.4\n1 0 obj << /Type /Catalog >>\n2 0 obj << /Type /Pages /Count 3 >>\n' +
        '3 0 obj << /Type /Page >>\n4 0 obj <</Type/Page>>\n5 0 obj << /Type  /Page /Parent 2 0 R >>\n',
      'latin1',
    );
    expect(pdfPageCountOf(pdf)).toBe(3);
    expect(pdfPageCountOf(Buffer.from('%PDF-1.4\n', 'latin1'))).toBe(0);
  });
});

describe('safeInputFilenameOf — the on-disk name the engine sees', () => {
  it('keeps a readable stem, forces the proven extension, and neutralizes hostile names', () => {
    expect(safeInputFilenameOf('Enso Nyame Ye.PDF', 'pdf')).toBe('Enso_Nyame_Ye.pdf');
    expect(safeInputFilenameOf('../evil/../name.pdf', 'pdf')).toBe('name.pdf');
    expect(safeInputFilenameOf('a:b*c?d"e<f>g|h.jpeg', 'jpeg')).toBe('a_b_c_d_e_f_g_h.jpeg');
    expect(safeInputFilenameOf('..', 'pdf')).toBe('score.pdf');
    expect(safeInputFilenameOf('', 'png')).toBe('score.png');
  });

  it('never yields a Windows device name — PRN.pdf would block or write nowhere', () => {
    for (const name of ['PRN.pdf', 'con', 'Nul.pdf', 'COM1.pdf', 'lpt9.tiff', 'aux.PDF']) {
      expect(safeInputFilenameOf(name, 'pdf')).toBe('score.pdf');
    }
    expect(safeInputFilenameOf('console.pdf', 'pdf')).toBe('console.pdf'); // not reserved
  });
});

describe('redactPaths — the machine’s layout never leaves the service', () => {
  it('replaces every root in either slash direction, and ignores empty or tiny roots', () => {
    const text =
      'Input "C:\\Users\\someone\\AppData\\Local\\Temp\\solfascribe-omr\\abc\\score.pdf" ' +
      'and C:/Users/someone/AppData/Local/Temp/solfascribe-omr/abc/out; cmd D:\\tools\\Audiveris\\Audiveris.exe';
    const redacted = redactPaths(text, [
      'C:\\Users\\someone\\AppData\\Local\\Temp\\solfascribe-omr',
      'D:/tools/Audiveris',
      '',
      'C:',
    ]);
    expect(redacted).toBe(
      'Input "<redacted>\\abc\\score.pdf" and <redacted>/abc/out; cmd <redacted>\\Audiveris.exe',
    );
  });
});
