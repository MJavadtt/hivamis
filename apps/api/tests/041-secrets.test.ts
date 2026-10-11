import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { GENERATED_SECRETS, VENDOR_SECRETS, databaseUrlProblem, secretProblem } from '../src/lib/secrets.js';

/**
 * Audit SEC-7: the API will not start on a secret copied from an example file, nor on one too plain to
 * have come from a generator — and says how to make a real one.
 */
const API = path.resolve(__dirname, '..');
const ROOT = path.resolve(API, '../..');
const valuesIn = (file: string) => Object.fromEntries(readFileSync(file, 'utf8').split('\n')
  .map((l) => /^([A-Z_]+)=(.*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m).map((m) => [m[1]!, m[2]!.replace(/^"|"$/g, '')]));

describe('Secrets (audit SEC-7)', () => {
  it('refuses every secret the example files ship, so a copied file cannot start an installation', () => {
    for (const file of [path.join(API, '.env.example'), path.join(ROOT, '.env.docker.example')]) {
      const values = valuesIn(file);
      for (const name of [...GENERATED_SECRETS, ...VENDOR_SECRETS]) {
        if (values[name]) expect(secretProblem(name, values[name]), `${path.basename(file)} ${name}`).not.toBeNull();
      }
      if (values.POSTGRES_PASSWORD) expect(databaseUrlProblem(`postgresql://hiva:${values.POSTGRES_PASSWORD}@db:5432/hiva_os`)).not.toBeNull();
    }
  });

  it('tells a placeholder from a weak secret from a real one, and leaves an unset optional key alone', () => {
    expect(secretProblem('JWT_SECRET', 'CHANGE_ME_generate_with_openssl_rand_base64_48')).toMatch(/placeholder.*openssl rand -base64 48/);
    expect(secretProblem('JWT_SECRET', 'changeme-please-really-0123456789abcdefghijklmnop')).toMatch(/placeholder/);
    expect(secretProblem('JWT_SECRET', 'a'.repeat(64))).toMatch(/fewer than 16 distinct/);
    expect(secretProblem('JWT_SECRET', 'abcabcabcabcabcabcabcabcabcabcabcabc')).toMatch(/fewer than 16 distinct/);
    expect(secretProblem('JWT_SECRET', 'Zx9q2Lk8vB3nM7tR5yW1pC6hJ4fG0dS2aE8uI3oK7lQ=')).toBeNull();
    // A vendor's key is what the vendor issued: only a placeholder is refused, not its alphabet.
    expect(secretProblem('SMS_API_KEY', '0123456789abcdef0123')).toBeNull();
    expect(secretProblem('SMS_API_KEY', 'CHANGE_ME')).toMatch(/placeholder/);
    expect(secretProblem('MESSENGER_WEBHOOK_SECRET', '')).toBeNull();
    expect(databaseUrlProblem('postgresql://hiva:CHANGE_ME@db:5432/hiva_os')).toMatch(/POSTGRES_PASSWORD/);
    expect(databaseUrlProblem('postgresql://hiva:s3cr3t-Xy9@db:5432/hiva_os')).toBeNull();
  });

  it('stops the API at start with the command that makes a real secret', () => {
    let out = '';
    try {
      execFileSync(path.join(API, 'node_modules/.bin/tsx'), ['-e', "import('./src/env.js')"], {
        cwd: API, env: { ...process.env, JWT_SECRET: 'CHANGE_ME_generate_with_openssl_rand_base64_48', DATABASE_URL: 'postgresql://x@localhost/y' }, stdio: 'pipe',
      });
    } catch (e) { out = String((e as { stderr?: Buffer }).stderr ?? ''); }
    expect(out).toContain('JWT_SECRET is the placeholder');
    expect(out).toContain('openssl rand -base64 48');
  });
});
