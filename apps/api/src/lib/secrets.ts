/**
 * Audit SEC-7: a secret copied from an example file is not a secret.
 *
 * `.env.example` ships `JWT_SECRET=CHANGE_ME_generate_with_openssl_rand_base64_48` — 46 characters,
 * which the old `min(32)` accepted. An installation set up by copying the file signed its tokens with
 * a key anyone holding the repository knows. The values below are what the example files carry; the
 * API refuses to start on any of them, on anything marked CHANGE_ME, and — for the secrets the
 * operator generates rather than receives from a vendor — on anything with too little variety to have
 * come from a generator. Kept here, not in env.ts, so a test can hold it against the example files.
 */

/** Secrets the operator generates. A vendor's key is checked only against the placeholders. */
export const GENERATED_SECRETS = ['JWT_SECRET', 'ESIGN_WEBHOOK_SECRET', 'MESSENGER_WEBHOOK_SECRET'] as const;
export const VENDOR_SECRETS = [
  'ANTHROPIC_API_KEY', 'EMBEDDING_API_KEY', 'TRANSCRIPTION_API_KEY', 'ESIGN_API_KEY', 'SMS_API_KEY',
  'GOOGLE_CLIENT_SECRET', 'VAPID_PRIVATE_KEY',
] as const;

/** What the example files ship (apps/api/.env.example, .env.docker.example) — tests/041 keeps this true. */
export const EXAMPLE_VALUES = new Set(['CHANGE_ME_generate_with_openssl_rand_base64_48', 'CHANGE_ME']);

export const GENERATE_HINT = 'generate one with: openssl rand -base64 48';

/** Why `value` cannot serve as the secret `name`, or null when it can. An empty optional secret is off, not weak. */
export function secretProblem(name: string, value: string | undefined): string | null {
  if (value === undefined || value === '') return null;
  if (/^change_?me/i.test(value) || EXAMPLE_VALUES.has(value)) {
    return `${name} is the placeholder from the example file — ${GENERATE_HINT}`;
  }
  if ((GENERATED_SECRETS as readonly string[]).includes(name) && new Set(value).size < 16) {
    return `${name} has fewer than 16 distinct characters; it was not made by a generator — ${GENERATE_HINT}`;
  }
  return null;
}

/** The database password the compose file builds into DATABASE_URL from POSTGRES_PASSWORD. */
export function databaseUrlProblem(url: string): string | null {
  try {
    const password = decodeURIComponent(new URL(url).password);
    if (/^change_?me/i.test(password) || EXAMPLE_VALUES.has(password)) {
      return `the database password (POSTGRES_PASSWORD) is the placeholder from the example file — ${GENERATE_HINT}`;
    }
  } catch { /* not a URL we can read; the connection will say so */ }
  return null;
}
