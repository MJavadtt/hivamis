import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * The owner's server report (2026-10-28): "parts of Docker had problems; many sections, the membership
 * button among them, did not show on the server." Three causes, each held here:
 *  - the API's image did not build — the lockfile disagreed with a package.json — so every upgrade
 *    stopped there and the server kept its old version;
 *  - thirty-one settings the API reads never reached its container, so the bot, the e-signature, the
 *    venues' SMS line and the rest stayed off whatever the settings file said;
 *  - a settings file written at install never learnt of the settings added since.
 */

const ROOT = path.resolve(__dirname, '../../..');
const run = promisify(execFile);
const read = (f: string) => readFileSync(path.join(ROOT, f), 'utf8');

/** Set by the image, or a test's stand-in for Google's own addresses — not an operator's setting. */
const NOT_FOR_COMPOSE = new Set([
  'HOST', 'STORAGE_DIR', 'PLAYWRIGHT_BROWSERS_PATH', 'EXTENSIONS_DIR',
  'GOOGLE_AUTH_URL', 'GOOGLE_TOKEN_URL', 'GOOGLE_JWKS_URL', 'GOOGLE_ISSUER',
]);

describe('The stack as the server builds it (owner’s server report, 2026-10-28)', () => {
  it('hands every setting the API reads to its container', () => {
    const schema = /const envSchema = z\.object\(\{([\s\S]*?)\n\}\);/.exec(read('apps/api/src/env.ts'))![1]!;
    const keys = [...schema.matchAll(/^ {2}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(80);
    const compose = read('docker-compose.yml');
    const api = /^ {2}api:\n([\s\S]*?)(?=^ {2}[\w-]+:\n)/m.exec(compose)![1]!;
    const missing = keys.filter((k) => !NOT_FOR_COMPOSE.has(k) && !new RegExp(`^ {6}${k}:`, 'm').test(api));
    expect(missing).toEqual([]);
    // An optional choice reaches the API as one of its values, never as an empty string it would refuse.
    for (const k of ['MESSENGER_MODE', 'ESIGN_MODE', 'MOADIAN_MODE', 'MESSENGER_TRANSPORT', 'PUSH_DELIVERY']) {
      expect(api).toMatch(new RegExp(`^ {6}${k}: \\$\\{${k}:-[a-z]+\\}$`, 'm'));
    }
  });

  it('builds from a lockfile that agrees with every package.json', () => {
    const lock = read('pnpm-lock.yaml');
    for (const dir of ['.', 'apps/api', 'apps/web', 'packages/contracts']) {
      const pkg = JSON.parse(read(path.join(dir, 'package.json'))) as Record<string, Record<string, string> | undefined>;
      const block = new RegExp(`^ {2}${dir.replace('.', '\\.')}:\\n([\\s\\S]*?)(?=^ {2}\\S|^\\S)`, 'm').exec(lock.slice(lock.indexOf('importers:')))?.[1] ?? '';
      for (const kind of ['dependencies', 'devDependencies'] as const) {
        for (const [name, wanted] of Object.entries(pkg[kind] ?? {})) {
          const quoted = name.startsWith('@') ? `'${name}'` : name;
          const at = block.indexOf(`\n      ${quoted}:\n`);
          expect(at, `${dir}: ${name} is not in the lockfile`).toBeGreaterThanOrEqual(0);
          const specifier = /specifier: (.+)/.exec(block.slice(at))![1]!.replace(/^'|'$/g, '');
          expect(`${dir}: ${name} ${specifier}`).toBe(`${dir}: ${name} ${wanted}`);
        }
      }
    }
  });

  it('adds to an older settings file the settings a new version reads, keeping what it holds', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hivamis-'));
    try {
      writeFileSync(path.join(dir, '.env'), 'POSTGRES_USER=hiva\nPOSTGRES_DB=hiva_os\nPOSTGRES_PASSWORD=kept\nSMS_MODE=kavenegar\n');
      const env = { ...process.env, HIVAMIS_DRY_RUN: '1', HIVAMIS_ENV_FILE: path.join(dir, '.env'), HIVAMIS_BACKUP_DIR: path.join(dir, 'b') };
      const r = await run('bash', [path.join(ROOT, 'infrastructure/hivamis'), 'upgrade'], { env });
      expect(r.stdout).toContain('echo MESSENGER_MODE=off >>');
      expect(r.stdout).toContain('echo SMS_SENDER= >>');
      // Nothing it already holds, and never the example's placeholder for a secret.
      expect(r.stdout).not.toContain('echo SMS_MODE=');
      expect(r.stdout).not.toContain('CHANGE_ME');
      expect(r.stdout.indexOf('MESSENGER_MODE=off')).toBeLessThan(r.stdout.search(/^\+ docker compose .* build$/m));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  it('says a failed build changed nothing, and builds through a mirror when one is named', () => {
    const script = read('infrastructure/hivamis');
    expect(script).toMatch(/compose build \\\n\s+\|\| die "the new version did not build, so nothing was restarted/);
    for (const f of ['infrastructure/docker/Dockerfile.api', 'infrastructure/docker/Dockerfile.web']) {
      expect(read(f)).toMatch(/ARG NPM_REGISTRY=https:\/\/registry\.npmjs\.org\/\nENV COREPACK_NPM_REGISTRY=\$NPM_REGISTRY/);
    }
    expect(read('infrastructure/docker/Dockerfile.api')).toContain('Acquire::Retries');
  });

  // The API's container started and never became ready: its query engine was built for OpenSSL 1.1.
  it('generates the query engine for the OpenSSL the runtime has, and refuses to build otherwise', () => {
    const [build, runtime] = read('infrastructure/docker/Dockerfile.api').split(/^FROM .* AS runtime$/m) as [string, string];
    const openssl = build.indexOf('apt-get install -y --no-install-recommends openssl');
    expect(openssl).toBeGreaterThan(0);
    expect(openssl).toBeLessThan(build.indexOf('prisma generate'));
    expect(build).toContain("find /out/node_modules -name 'libquery_engine-*openssl-3.0.x*' | grep -q .");
    expect(runtime).toMatch(/apt-get install[\s\S]*\bopenssl\b/);
    expect(read('.env.docker.example')).toMatch(/^NPM_REGISTRY=https:\/\/registry\.npmjs\.org\/$/m);
  });
});
