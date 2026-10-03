import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

export const DEV_PASSWORD = 'Hiva@Dev2026!';

let cached: FastifyInstance | null = null;

export async function app(): Promise<FastifyInstance> {
  if (!cached) {
    cached = await buildApp();
    await cached.ready();
  }
  return cached;
}

export async function closeApp(): Promise<void> {
  await cached?.close();
  cached = null;
  await prisma.$disconnect();
}

export async function login(email: string): Promise<string> {
  const a = await app();
  const res = await a.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: DEV_PASSWORD },
  });
  if (res.statusCode !== 200) {
    throw new Error(`login failed for ${email}: ${res.statusCode} ${res.body}`);
  }
  return res.json().accessToken as string;
}

export interface CallOptions {
  token?: string;
  payload?: unknown;
  query?: Record<string, string>;
}

export async function call(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  opts: CallOptions = {},
) {
  const a = await app();
  const res = await a.inject({
    method,
    url: url.startsWith('/api') ? url : `/api/v1${url}`,
    headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
    payload: opts.payload as never,
    query: opts.query,
  });
  let body: any = null;
  try { body = res.body ? JSON.parse(res.body) : null; } catch { body = res.body; }
  return { status: res.statusCode, body };
}

export const get = (url: string, token: string, query?: Record<string, string>) =>
  call('GET', url, { token, query });
export const post = (url: string, token: string, payload?: unknown) =>
  call('POST', url, { token, payload });
export const patch = (url: string, token: string, payload?: unknown) =>
  call('PATCH', url, { token, payload });
export const put = (url: string, token: string, payload?: unknown) =>
  call('PUT', url, { token, payload });

/** Drive an entity through the workflow engine. */
export const move = (entity: string, id: string, action: string, token: string, reason?: string, payload?: Record<string, unknown>) =>
  post(`/workflow/${entity}/${id}/transitions`, token, { action, reason, payload });

/** Assert helper that surfaces the API's Persian error message when a call fails. */
export function expectOk(res: { status: number; body: any }, context: string): any {
  if (res.status >= 400) {
    throw new Error(
      `${context} → HTTP ${res.status}: ${res.body?.error?.message ?? JSON.stringify(res.body)}` +
      (res.body?.error?.details ? `\n  details: ${JSON.stringify(res.body.error.details)}` : ''),
    );
  }
  return res.body;
}

/**
 * Upload one file through the real multipart endpoint, attached to whatever the fields name
 * (deliverableId, projectId…). The content must match the declared type's signature — the
 * server checks magic bytes, not the extension.
 */
export async function upload(
  token: string, file: { name: string; type: string; content: Buffer | string }, fields: Record<string, string> = {},
) {
  const a = await app();
  const boundary = `----hiva${Math.random().toString(36).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
  parts.push(typeof file.content === 'string' ? Buffer.from(file.content) : file.content);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const res = await a.inject({
    method: 'POST', url: '/api/v1/documents',
    headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(parts),
  });
  let body: any = null;
  try { body = res.body ? JSON.parse(res.body) : null; } catch { body = res.body; }
  return { status: res.statusCode, body };
}

/** The smallest file a PDF signature check accepts. */
export const tinyPdf = (title = 'Hiva') =>
  `%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n% ${title}\ntrailer<</Root 1 0 R>>\n%%EOF\n`;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf: Buffer) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** A real, stored (uncompressed) ZIP — what a unit hands over when the source file is a PSD. */
export function zipOf(entries: { name: string; content: Buffer | string }[]): Buffer {
  const locals: Buffer[] = []; const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = typeof e.content === 'string' ? Buffer.from(e.content) : e.content;
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}

let mobileSeq = 0;
/** A lead's required mobile number (Hivamis task 2), distinct per call so the duplicate check never trips by accident. */
export const mobile = () => `0901${String(++mobileSeq).padStart(7, '0')}`;
/** The plainest two-step source: a direct phone call — with its own mobile number. */
export const directLead = (channel: 'PHONE' | 'EXHIBITION' | 'EVENT' | 'CAMPAIGN' = 'PHONE') =>
  ({ source: 'DIRECT', sourceChannel: channel, phone: mobile() });
/** A lead a partner company sent, named for the first time or again. */
export const partnerLead = (name = 'شرکت معرف آزمون') => ({ source: 'PARTNER', sourcePartnerName: name, phone: mobile() });
