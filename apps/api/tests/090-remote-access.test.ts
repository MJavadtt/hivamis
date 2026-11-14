import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * The owner (2026-11-14; ADR-129): «بیرون از فضای شرکت کسی نمی‌تواند به سرور متصل بشود و از آن استفاده
 * کند، این موضوع استفاده از پروژه را برای همکاران دورکار غیر ممکن می‌کند» — and chose a port opened on
 * the office router. What is on the internet is HTTPS only, with a certificate that renews itself.
 */

const ROOT = path.resolve(__dirname, '../../..');
const run = promisify(execFile);
const compose = readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
const caddyfile = readFileSync(path.join(ROOT, 'infrastructure/docker/Caddyfile'), 'utf8');
const service = (name: string) => {
  const m = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:\\n|^\\S)`, 'm').exec(compose);
  expect(m, name).not.toBeNull();
  return m![1]!;
};

async function remote(args: string[], env: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hivamis-remote-'));
  try {
    const file = path.join(dir, '.env');
    writeFileSync(file, env);
    const r = await run('bash', [path.join(ROOT, 'infrastructure/hivamis'), 'remote', ...args], { env: { ...process.env, HIVAMIS_DRY_RUN: '1', HIVAMIS_ENV_FILE: file } }).catch((e) => e);
    return { code: r.code ?? 0, out: String(r.stdout ?? ''), err: String(r.stderr ?? '') };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const OFFICE = 'COMPOSE_PROFILES=ai\nCORS_ORIGIN=http://192.168.5.201:8080\nPUBLIC_APP_URL=http://192.168.5.201:8080\n';

describe('The way in from outside the office (ADR-129)', () => {
  it('is a proxy that is off until asked for, on ports 80 and 443, keeping its certificates', () => {
    const proxy = service('proxy');
    expect(proxy).toMatch(/image: caddy:\d+\.\d+\.\d+-alpine/);
    expect(proxy).toContain('profiles: [https]');
    for (const p of ["'${HTTP_PORT:-80}:80'", "'${HTTPS_PORT:-443}:443'"]) expect(proxy).toContain(p);
    expect(proxy).toContain('./infrastructure/docker/Caddyfile:/etc/caddy/Caddyfile:ro');
    expect(proxy).toContain('caddy-data:/data');
    expect(compose).toMatch(/^volumes:\n(?:  #.*\n|  [\w-]+:\n)*  caddy-data:$/m);
    // The office's own way in stays as it was.
    expect(service('web')).toContain("'${WEB_PORT:-8080}:80'");
  });

  it('serves PUBLIC_HOST over HTTPS, the API in one hop and the rest from the web container, with no admin endpoint', () => {
    expect(caddyfile).toMatch(/^\{\n(?:\t#.*\n)*\tadmin off\n\}/m);
    expect(caddyfile).toContain('{$PUBLIC_HOST} {');
    expect(caddyfile).toMatch(/handle \/api\/\* \{\n\t\treverse_proxy api:4000\n\t\}/);
    expect(caddyfile).toMatch(/handle \{\n\t\treverse_proxy web:80\n\t\}/);
    expect(caddyfile).toContain('Strict-Transport-Security "max-age=31536000"');
    // One hop to the API either way, so the client's own address is the one rate limits count.
    expect(service('api')).toContain('TRUST_PROXY: ${TRUST_PROXY:-1}');
  });

  it('`remote HOST` names it, allows it beside the office address, adds the profile and starts the proxy', async () => {
    const r = await remote(['CRM.Example.ir'], OFFICE);
    expect(r.code).toBe(0);
    const at = (t: string) => { const i = r.out.indexOf(t); expect(i, t).toBeGreaterThan(-1); return i; };
    at('PUBLIC_HOST=crm.example.ir');
    at('s|^PUBLIC_APP_URL=.*|PUBLIC_APP_URL=https://crm.example.ir|');
    at('s|^CORS_ORIGIN=.*|CORS_ORIGIN=https://crm.example.ir,http://192.168.5.201:8080|');
    at('s|^COMPOSE_PROFILES=.*|COMPOSE_PROFILES=ai,https|');
    expect(at('COMPOSE_PROFILES=ai,https')).toBeLessThan(at('up -d proxy api'));
    expect(r.err).toContain('forward TCP ports 80 and 443');
    expect(r.err).toContain('an A record for crm.example.ir');
  });

  it('refuses an address that is not a host name', async () => {
    for (const bad of ['https://crm.example.ir', 'crm.example.ir:443', 'crm example', '.ir', 'a..ir']) {
      const r = await remote([bad], OFFICE);
      expect([bad, r.code]).toEqual([bad, 1]);
      expect(r.out).not.toContain('up -d');
    }
  });

  it('`remote off` takes the profile and the proxy away, and links go back to the office address', async () => {
    const r = await remote(['off'], 'COMPOSE_PROFILES=ai,https\nPUBLIC_HOST=crm.example.ir\nCORS_ORIGIN=https://crm.example.ir,http://192.168.5.201:8080\nPUBLIC_APP_URL=https://crm.example.ir\n');
    expect(r.code).toBe(0);
    expect(r.out).toContain('s|^COMPOSE_PROFILES=.*|COMPOSE_PROFILES=ai|');
    expect(r.out).toContain('rm -sf proxy');
    expect(r.out).toContain('s|^CORS_ORIGIN=.*|CORS_ORIGIN=http://192.168.5.201:8080|');
    expect(r.out).toContain('s|^PUBLIC_APP_URL=.*|PUBLIC_APP_URL=http://192.168.5.201:8080|');
  });
});
