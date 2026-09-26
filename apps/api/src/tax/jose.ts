/**
 * The two envelopes سامانهٔ مؤدیان expects (roadmap #32), with Node's own crypto — no new
 * dependency. A JWS (RS256) signs with the taxpayer's private key, carrying the certificate
 * (`x5c`) and the signing time (`sigT`, declared critical); a JWE (RSA-OAEP-256 key wrap,
 * A256GCM content) encrypts for the authority's public key named by `kid`. Both compact.
 */
import { createCipheriv, createDecipheriv, constants, privateDecrypt, publicEncrypt, randomBytes, sign, verify } from 'node:crypto';

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const unb64u = (s: string) => Buffer.from(s, 'base64url');

export function jwsSign(payload: unknown, privateKeyPem: string, certificateBase64?: string, now = new Date()): string {
  const header: Record<string, unknown> = { alg: 'RS256', typ: 'jose', cty: 'text/plain', sigT: now.toISOString().replace(/\.\d{3}Z$/, 'Z'), crit: ['sigT'] };
  if (certificateBase64) header.x5c = [certificateBase64];
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  return `${input}.${b64u(sign('RSA-SHA256', Buffer.from(input), privateKeyPem))}`;
}

export function jwsVerify(jws: string, publicKeyPem: string): { header: any; payload: any } | null {
  const [h, p, s] = jws.split('.');
  if (!h || !p || !s) return null;
  if (!verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKeyPem, unb64u(s))) return null;
  return { header: JSON.parse(unb64u(h).toString('utf8')), payload: JSON.parse(unb64u(p).toString('utf8')) };
}

export function jweEncrypt(plaintext: string, publicKeyPem: string, kid: string): string {
  const header = b64u(JSON.stringify({ alg: 'RSA-OAEP-256', enc: 'A256GCM', kid }));
  const cek = randomBytes(32), iv = randomBytes(12);
  const wrapped = publicEncrypt({ key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, cek);
  const cipher = createCipheriv('aes-256-gcm', cek, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(header, 'ascii'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [header, b64u(wrapped), b64u(iv), b64u(ciphertext), b64u(cipher.getAuthTag())].join('.');
}

export function jweDecrypt(jwe: string, privateKeyPem: string): { header: any; plaintext: string } {
  const [h, k, iv, ct, tag] = jwe.split('.');
  const cek = privateDecrypt({ key: privateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, unb64u(k!));
  const decipher = createDecipheriv('aes-256-gcm', cek, unb64u(iv!), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(h!, 'ascii'));
  decipher.setAuthTag(unb64u(tag!));
  return { header: JSON.parse(unb64u(h!).toString('utf8')), plaintext: Buffer.concat([decipher.update(unb64u(ct!)), decipher.final()]).toString('utf8') };
}
