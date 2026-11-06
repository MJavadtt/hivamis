import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { call, closeApp, login, upload } from './helpers.js';
import { prisma } from '../src/db.js';
import { kindOfFile } from '../src/annotations/service.js';

/**
 * ADR-123 (the owner, 2026-11-06): files mean PDF, JPEG, PNG, Excel, Word and the like — and the people
 * here work on Windows, in Photoshop and in Corel. The name settles the type, whatever the browser said;
 * the bytes must then agree with it, so widening what is accepted lets nothing else in.
 */
const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
const ole2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const exe = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const riff = (kind: string) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from(kind)]);
const OOXML = 'application/vnd.openxmlformats-officedocument';

describe('What may be attached (ADR-123)', () => {
  let token: string;
  let fields: Record<string, string>;
  const send = (name: string, type: string, content: Buffer | string) => upload(token, { name, type, content }, fields);

  beforeAll(async () => {
    token = await login('account.manager@hiva.local');
    const project = await prisma.project.findFirstOrThrow({ where: { deletedAt: null } });
    fields = { projectId: project.id };
  }, 60_000);
  afterAll(closeApp);

  it.each([
    ['a sheet from a machine without Office', 'قیمت.xlsx', 'application/octet-stream', zip, `${OOXML}.spreadsheetml.sheet`],
    ['a letter from a machine without Office', 'نامه.docx', 'application/octet-stream', zip, `${OOXML}.wordprocessingml.document`],
    ['an old sheet', 'old.xls', 'application/octet-stream', ole2, 'application/vnd.ms-excel'],
    ['a CSV Windows calls Excel', 'list.csv', 'application/vnd.ms-excel', 'نام,تلفن', 'text/csv'],
    ['a sheet saved as Unicode text', 'list.txt', 'text/plain', Buffer.from([0xff, 0xfe, 0x41, 0x00]), 'text/plain'],
    ['a ZIP as Windows names it', 'files.zip', 'application/x-zip-compressed', zip, 'application/zip'],
    ['a JPEG as old browsers name it', 'photo.JPG', 'image/pjpeg', jpeg, 'image/jpeg'],
  ])('takes %s', async (_what, name, declared, content, stored) => {
    const res = await send(name, declared, content);
    expect(res.status).toBe(201);
    expect(res.body.mimeType).toBe(stored);
  });

  it.each([
    ['poster.psd', Buffer.from('8BPS\x00\x01'), 'image/vnd.adobe.photoshop'],
    ['logo.ai', Buffer.from('%PDF-1.6'), 'application/illustrator'],
    ['logo-old.ai', Buffer.from('%!PS-Adobe-3.0'), 'application/illustrator'],
    ['print.eps', Buffer.from('%!PS-Adobe-3.0 EPSF-3.0'), 'application/postscript'],
    ['banner.cdr', riff('CDR9'), 'application/vnd.corel-draw'],
    ['banner-x7.cdr', zip, 'application/vnd.corel-draw'],
    ['scan.tif', Buffer.from([0x49, 0x49, 0x2a, 0x00]), 'image/tiff'],
    ['iphone.heic', Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic')]), 'image/heic'],
    ['spot.mov', Buffer.concat([Buffer.alloc(4), Buffer.from('ftypqt  ')]), 'video/quicktime'],
    ['voice.mp3', Buffer.from('ID3\x03'), 'audio/mpeg'],
    ['source.rar', Buffer.from('Rar!\x1a\x07'), 'application/vnd.rar'],
    ['source.7z', Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), 'application/x-7z-compressed'],
  ])('takes the studio’s %s', async (name, content, stored) => {
    const res = await send(name, 'application/octet-stream', content);
    expect(res.status).toBe(201);
    expect(res.body.mimeType).toBe(stored);
  });

  it.each([
    ['a program named as a PDF', 'invoice.pdf', 'application/pdf', exe],
    ['a program named as a sheet', 'prices.xlsx', 'application/octet-stream', exe],
    ['a program named as a Corel file', 'art.cdr', 'application/octet-stream', exe],
    ['a program by its own name', 'setup.exe', 'application/x-msdownload', exe],
    ['a program that says it is a PDF', 'setup.exe', 'application/pdf', exe],
    ['an SVG', 'x.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'],
    ['an SVG named as a PNG', 'x.png', 'image/png', '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'],
    ['an SVG sent as text', 'x.svg', 'text/plain', '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'],
    ['a page sent as text', 'x.html', 'text/plain', '<script>alert(1)</script>'],
    ['a script sent as text', 'run.bat', 'text/plain', 'del /q *'],
  ])('refuses %s', async (_what, name, declared, content) => {
    const res = await send(name, declared, content);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('UNSUPPORTED_TYPE');
  });

  it('says what is accepted, not the browser’s word for the file', async () => {
    const res = await send('setup.exe', 'application/x-msdownload', exe);
    expect(res.body.error.message).toContain('Excel');
    expect(res.body.error.message).not.toContain('x-msdownload');
  });

  it('hands over what cannot be shown, and offers it for neither preview nor annotation', async () => {
    const psd = await send('poster.psd', 'application/octet-stream', Buffer.from('8BPS\x00\x01'));
    expect((await call('GET', `/documents/${psd.body.id}/preview`, { token })).status).toBe(422);
    expect((await call('GET', `/documents/${psd.body.id}/download`, { token })).status).toBe(200);
    expect(['image/vnd.adobe.photoshop', 'image/tiff', 'image/heic', 'video/quicktime'].map(kindOfFile)).toEqual([null, null, null, null]);
    expect(['image/png', 'video/mp4', 'application/pdf'].map(kindOfFile)).toEqual(['image', 'video', 'pdf']);
  });
});
