/**
 * Profile photos (audit F-6). Whatever arrives — a phone's JPEG with its location in EXIF, a PNG, a
 * WebP — is decoded, turned upright, cut to a 512px square and written anew as WebP: nothing of the
 * original's metadata survives, and what is served is only ever bytes this server encoded.
 *
 * A photo is shown with a plain <img>, which cannot carry the session, so its address is signed: a
 * link that holds for a day or two, the same all day so the browser can keep it.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import sharp from 'sharp';
import { AVATAR_SIZE } from '@hiva/contracts';
import { env } from '../env.js';

const DAY_MS = 86_400_000;
/** A large enough picture for any camera, small enough that no file can make the decoder balloon. */
const MAX_INPUT_PIXELS = 40_000_000;

export async function reencodeAvatar(input: Buffer): Promise<Buffer> {
  return sharp(input, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS, animated: false })
    // Upright as it was taken, before the orientation tag goes with the rest of the metadata.
    .rotate()
    .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: 'attention' })
    .webp({ quality: 82 })
    .toBuffer();
}

const sign = (id: string, exp: number) => createHmac('sha256', env.JWT_SECRET).update(`avatar:${id}:${exp}`).digest('base64url');

/** Where a photo is shown from: until the end of tomorrow (UTC), so one address serves all day. */
export function avatarUrl(documentId: string | null | undefined, now = Date.now()): string | null {
  if (!documentId) return null;
  const exp = (Math.floor(now / DAY_MS) + 2) * DAY_MS;
  return `/api/v1/avatars/${documentId}?exp=${exp}&sig=${sign(documentId, exp)}`;
}

export function validAvatarLink(id: string, exp: number, sig: string, now = Date.now()): boolean {
  if (!Number.isFinite(exp) || exp < now) return false;
  const want = Buffer.from(sign(id, exp));
  const got = Buffer.from(sig);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** A person as the pages show them: with their photo's address in place of its document id. */
export const withAvatar = <T extends { avatarDocumentId?: string | null }>({ avatarDocumentId, ...rest }: T) =>
  ({ ...rest, avatarUrl: avatarUrl(avatarDocumentId) }) as Omit<T, 'avatarDocumentId'> & { avatarUrl: string | null };
