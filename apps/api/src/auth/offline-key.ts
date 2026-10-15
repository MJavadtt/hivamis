import { createHmac } from 'node:crypto';
import { env } from '../env.js';

/**
 * The key a device encrypts its offline copy of the app's data with (audit F-7), for one sign-in:
 * derived from the session family, so every refresh of that sign-in gives the same key and a new
 * sign-in another. Never stored on the server; the page keeps it as a key it cannot read back out.
 */
export const offlineKeyFor = (familyId: string) =>
  createHmac('sha256', env.JWT_SECRET).update(`offline-cache:${familyId}`).digest('base64url');
