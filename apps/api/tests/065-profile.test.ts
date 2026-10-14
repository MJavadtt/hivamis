import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import { app, call, closeApp, expectOk, get, login, patch, post } from './helpers.js';
import { prisma } from '../src/db.js';
import { avatarUrl } from '../src/profile/avatars.js';

/**
 * Audit F-6: the profile. A photo arrives as whatever a phone makes — a JPEG with its camera, its
 * place and its orientation in EXIF — and is kept as a 512px WebP with none of that. It is shown
 * from a signed address a plain <img> can load, and only while it is the person's photo. The words
 * are the person's own, within limits, and every change is audited.
 */

async function upload(token: string, body: Buffer, type: string, name = 'me.jpg') {
  const boundary = '----avatar';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`), body, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await (await app()).inject({ method: 'POST', url: '/api/v1/me/avatar', payload, headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` } });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
/** Fetch a photo the way an <img> does: no session at all. */
const fetchImage = async (url: string) => {
  const res = await (await app()).inject({ method: 'GET', url });
  return { status: res.statusCode, type: res.headers['content-type'], cache: res.headers['cache-control'], body: res.rawPayload };
};

/** A phone's photo: 1200×800 on its side (orientation 6), with its camera and a place on Earth. */
const phonePhoto = () => sharp({ create: { width: 1200, height: 800, channels: 3, background: '#7a69f2' } })
  .jpeg()
  .withExif({ IFD0: { Make: 'PhoneCo', Model: 'Phone 12', Orientation: '6' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '35/1 41/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '51/1 25/1 0/1' } })
  .toBuffer();

/** A PNG whose header claims 50,000 × 50,000 pixels: a decompression bomb, refused before decoding. */
function hugePng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(50_000, 0); ihdr.writeUInt32BE(50_000, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])), chunk('IEND', Buffer.alloc(0))]);
}

describe('The profile (audit F-6)', () => {
  let designer: string, admin: string, pmo: string, designerId: string, first: string;

  beforeAll(async () => {
    [designer, admin, pmo] = await Promise.all(['designer', 'admin', 'pmo'].map((u) => login(`${u}@hiva.local`)));
    designerId = (await prisma.user.findFirstOrThrow({ where: { email: 'designer@hiva.local' } })).id;
  });
  afterAll(closeApp);

  it('keeps a phone photo as a 512px WebP with nothing of its metadata, shown from a signed address', async () => {
    const photo = await phonePhoto();
    expect((await sharp(photo).metadata()).exif).toBeDefined();
    const r = await upload(designer, photo, 'image/jpeg');
    expect(r.status).toBe(200);
    first = r.body.avatarUrl;
    expect(first).toMatch(/^\/api\/v1\/avatars\/[0-9a-f-]{36}\?exp=\d+&sig=[\w-]+$/);

    const img = await fetchImage(first);
    expect(img).toMatchObject({ status: 200, type: 'image/webp' });
    expect(img.cache).toMatch(/^private, max-age=\d+, immutable$/);
    const meta = await sharp(img.body).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 512, height: 512 });
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect(img.body.includes(Buffer.from('PhoneCo'))).toBe(false);

    // Audited; and not one of the organisation's files.
    expect(await prisma.auditEvent.count({ where: { entityType: 'user', entityId: designerId, action: 'UPDATE', actorId: designerId } })).toBeGreaterThan(0);
    const docId = /avatars\/([^?]+)/.exec(first)![1]!;
    expect(expectOk(await get('/documents', admin), 'documents').some((d: any) => d.id === docId)).toBe(false);
  });

  it('refuses what is not a readable picture of a sane size, and a link that is forged or out of date', async () => {
    expect((await upload(designer, Buffer.from('%PDF-1.4'), 'application/pdf', 'x.pdf')).body.error.code).toBe('UNSUPPORTED_TYPE');
    expect((await upload(designer, Buffer.from('not a png at all'), 'image/png', 'x.png')).body.error.code).toBe('UNSUPPORTED_IMAGE');
    expect((await upload(designer, hugePng(), 'image/png', 'bomb.png')).body.error.code).toBe('UNSUPPORTED_IMAGE');

    const forged = first.replace(/sig=[\w-]+/, 'sig=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect((await fetchImage(forged)).status).toBe(403);
    const stale = first.replace(/exp=\d+/, `exp=${Date.now() - 1000}`);
    expect((await fetchImage(stale)).status).toBe(403);
    // A document that is nobody's photo is not served, even at an address signed for it.
    const me = await prisma.user.findUniqueOrThrow({ where: { id: designerId } });
    const doc = await prisma.document.create({ data: { organizationId: me.organizationId, fileName: 'contract.pdf', storedName: 'x.pdf', mimeType: 'application/pdf', sizeBytes: 1, uploadedById: designerId } });
    expect((await fetchImage(avatarUrl(doc.id)!)).status).toBe(404);
  });

  it('shows the photo wherever the person is: the directory, their page, the top bar, the chat', async () => {
    expect(expectOk(await get('/people', pmo), 'people').find((p: any) => p.id === designerId).avatarUrl).toMatch(/^\/api\/v1\/avatars\//);
    expect(expectOk(await get(`/people/${designerId}`, pmo), 'person').avatarUrl).toMatch(/^\/api\/v1\/avatars\//);
    expect(expectOk(await get('/auth/me', designer), 'me').avatarUrl).toMatch(/^\/api\/v1\/avatars\//);
    const pmoId = (await prisma.user.findFirstOrThrow({ where: { email: 'pmo@hiva.local' } })).id;
    const c = expectOk(await post('/chat/conversations', pmo, { kind: 'DIRECT', memberIds: [designerId] }), 'direct').id;
    const m = expectOk(await post(`/chat/conversations/${c}/messages`, designer, { body: 'سلام' }), 'send');
    expect(m.author.avatarUrl).toMatch(/^\/api\/v1\/avatars\//);
    expect(expectOk(await get('/chat/conversations', pmo), 'list').find((x: any) => x.id === c).peer.avatarUrl).toMatch(/^\/api\/v1\/avatars\//);
    expect(expectOk(await get(`/chat/conversations/${c}`, pmo), 'detail').members.find((x: any) => x.id === pmoId).avatarUrl).toBeNull();
  });

  it('lets go of the old photo when it is replaced, and an administrator of users may take one down', async () => {
    const r = await upload(designer, await sharp({ create: { width: 300, height: 300, channels: 4, background: '#00000000' } }).png().toBuffer(), 'image/png', 'me.png');
    expect(r.status).toBe(200);
    expect((await fetchImage(first)).status).toBe(404);
    expect((await fetchImage(r.body.avatarUrl)).status).toBe(200);

    expect((await call('DELETE', `/users/${designerId}/avatar`, { token: pmo })).status).toBe(403);
    expectOk(await call('DELETE', `/users/${designerId}/avatar`, { token: admin }), 'take down');
    expect(expectOk(await get(`/people/${designerId}`, pmo), 'person').avatarUrl).toBeNull();
    expect((await fetchImage(r.body.avatarUrl)).status).toBe(404);
    const adminId = (await prisma.user.findFirstOrThrow({ where: { email: 'admin@hiva.local' } })).id;
    expect(await prisma.auditEvent.count({ where: { entityType: 'user', entityId: designerId, actorId: adminId, action: 'UPDATE' } })).toBe(1);
  });

  it('keeps the words the person writes within their limits, audited', async () => {
    const saved = expectOk(await patch('/me/about', designer, {
      bio: 'طراح هویت بصری؛ عاشق تایپوگرافی فارسی.', pronouncedName: 'بِهراد مِهرنیا', skills: ['تایپوگرافی', 'Figma', 'Figma'], links: ['https://www.behance.net/behrad'],
    }), 'save');
    expect(saved).toMatchObject({ skills: ['تایپوگرافی', 'Figma'], links: ['https://www.behance.net/behrad'] });
    expect(expectOk(await get(`/people/${designerId}`, pmo), 'person')).toMatchObject({ bio: 'طراح هویت بصری؛ عاشق تایپوگرافی فارسی.', pronouncedName: 'بِهراد مِهرنیا' });
    expect((await patch('/me/about', designer, { bio: 'ب'.repeat(501) })).status).toBe(400);
    expect((await patch('/me/about', designer, { links: ['http://example.com'] })).status).toBe(400);
    expect((await patch('/me/about', designer, { links: ['javascript:alert(1)'] })).status).toBe(400);
    expect((await patch('/me/about', designer, { links: Array.from({ length: 6 }, (_, i) => `https://e.com/${i}`) })).status).toBe(400);
    // A blank note clears it.
    expect(expectOk(await patch('/me/about', designer, { bio: '   ' }), 'clear').bio).toBeNull();
    // And the database holds the line whatever the application does.
    await expect(prisma.user.update({ where: { id: designerId }, data: { bio: 'ب'.repeat(501) } })).rejects.toThrow(/users_profile_check/);
  });
});
