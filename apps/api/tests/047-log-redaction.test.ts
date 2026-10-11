import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
import { LOG_REDACT } from '../src/lib/log.js';

/** Audit SEC-11: what the API logs never carries a password, a code, a token or a signature. */
describe('Log redaction (audit SEC-11)', () => {
  it('hides every credential a request or its body could carry, wherever it is logged', () => {
    const lines: string[] = [];
    const sink = new Writable({ write(chunk, _enc, done) { lines.push(String(chunk)); done(); } });
    const log = pino({ redact: LOG_REDACT }, sink);
    const secrets = {
      password: 'pw-SECRET-1', newPassword: 'pw-SECRET-2', currentPassword: 'pw-SECRET-3',
      refreshToken: 'rt-SECRET-4', code: '987654', ticket: 'tk-SECRET-5', token: 'tok-SECRET-6',
    };
    log.info({
      req: {
        headers: { authorization: 'Bearer at-SECRET-7', cookie: 'hiva_refresh=rc-SECRET-8; hiva_oauth=on-SECRET-9', 'x-hiva-signature': 'sha256=sig-SECRET-10' },
        body: secrets,
      },
      res: { headers: { 'set-cookie': 'hiva_refresh=rc-SECRET-11; HttpOnly' } },
    }, 'request');
    log.info({ body: secrets }, 'a body logged on its own');
    const out = lines.join('');
    expect(out).not.toMatch(/SECRET|987654/);
    expect(out.match(/\[Redacted\]/g)!.length).toBe(4 + 7 + 7);
  });
});
