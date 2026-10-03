/**
 * Web Push without a library (roadmap #49): the payload encrypted to the phone's key as RFC 8291
 * says (aes128gcm, RFC 8188), and the request signed as RFC 8292 (VAPID) says. No account with any
 * push service is needed — the phone's browser names the service, and the service trusts the
 * signature of the key the subscription was made with.
 */
import { createCipheriv, createECDH, createHmac, createPrivateKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

export const b64u = {
  encode: (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url'),
  decode: (s: string) => Buffer.from(s.replace(/=+$/, ''), 'base64url'),
};

const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();

export interface Subscriber { p256dh: string; auth: string }

/**
 * RFC 8291 §3: an ECDH secret with the phone's key, the phone's auth secret mixed in, a content key
 * and nonce from a fresh salt; one record, padded with the final-record delimiter.
 * `sender` and `salt` are given only by tests reproducing the RFC's example.
 */
export function encrypt(payload: Buffer, to: Subscriber, fixed?: { senderPrivate: Buffer; salt: Buffer }): Buffer {
  const uaPublic = b64u.decode(to.p256dh), authSecret = b64u.decode(to.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error('p256dh is not an uncompressed P-256 point');
  if (authSecret.length !== 16) throw new Error('auth secret must be 16 bytes');
  const ecdh = createECDH('prime256v1');
  if (fixed) ecdh.setPrivateKey(fixed.senderPrivate); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const salt = fixed?.salt ?? randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hmac(hmac(authSecret, ecdhSecret), Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

/* ── VAPID ───────────────────────────────────────────────────────────────────────────────── */

export interface VapidKeys { publicKey: string; privateKey: string }

/** A new application-server key pair, as base64url: the public key uncompressed, the private scalar. */
export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pub = publicKey.export({ format: 'jwk' }), priv = privateKey.export({ format: 'jwk' });
  return {
    publicKey: b64u.encode(Buffer.concat([Buffer.from([4]), b64u.decode(pub.x!), b64u.decode(pub.y!)])),
    privateKey: priv.d!,
  };
}

function keyObject(keys: VapidKeys): KeyObject {
  const pub = b64u.decode(keys.publicKey);
  return createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64u.encode(pub.subarray(1, 33)), y: b64u.encode(pub.subarray(33, 65)) } });
}

/** RFC 8292: a JWT for the push service's origin, signed ES256, good for twelve hours. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): string {
  const enc = (o: object) => b64u.encode(Buffer.from(JSON.stringify(o)));
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })}`;
  const signature = sign('sha256', Buffer.from(unsigned), { key: keyObject(keys), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64u.encode(signature)}, k=${keys.publicKey}`;
}
