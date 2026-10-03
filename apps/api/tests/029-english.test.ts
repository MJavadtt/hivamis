import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { app, closeApp, login } from './helpers.js';
import catalogue from '@hiva/contracts/i18n/en.json' with { type: 'json' };
import { localizeError, requestLocale } from '../src/lib/i18n.js';

/**
 * Hivamis task 7: the API answers in the language the request asks for. Messages are written in
 * Persian where they are raised and stay Persian in logs and the audit trail; an English request gets
 * them in English, values and all.
 */
async function ask(url: string, lang: string | undefined, token?: string, method: 'GET' | 'POST' = 'GET', payload?: unknown) {
  const res = await (await app()).inject({
    method, url: `/api/v1${url}`, payload: payload as never,
    headers: { ...(lang ? { 'accept-language': lang } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  return { status: res.statusCode, error: res.json().error as { code: string; message: string; details?: any } };
}

describe('Answers in the reader’s language', () => {
  let sales: string;
  beforeAll(async () => { sales = await login('sales@hiva.local'); });
  afterAll(async () => { await closeApp(); });

  it('has English for every message and label the API and the contracts put in front of people', async () => {
    // The extractor lives with the catalogue, outside this package; loaded at run time, not compiled here.
    const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../packages/contracts/scripts/i18n-keys.mts');
    const { serverKeys } = (await import(pathToFileURL(script).href)) as { serverKeys: () => Map<string, string> };
    const missing = [...serverKeys()].filter(([k]) => (catalogue as Record<string, string>)[k] === undefined);
    expect(missing).toEqual([]);
  });

  it('reads the language from Accept-Language, Persian unless English comes first', () => {
    expect(requestLocale(undefined)).toBe('fa');
    expect(requestLocale('en')).toBe('en');
    expect(requestLocale('en-GB,en;q=0.9')).toBe('en');
    expect(requestLocale('fa-IR,fa;q=0.9,en;q=0.8')).toBe('fa');
    expect(requestLocale('de;q=1, en;q=0.5, fa;q=0.4')).toBe('en');
    expect(requestLocale('fa;q=0.2, en;q=0.9')).toBe('en');
    expect(requestLocale('de, fr')).toBe('fa');
  });

  it('answers a plain error in English when asked, and in Persian otherwise', async () => {
    expect((await ask('/auth/me', 'en')).error).toMatchObject({ code: 'UNAUTHORIZED', message: 'Authentication required' });
    expect((await ask('/auth/me', undefined)).error.message).toBe('احراز هویت لازم است');
  });

  it('translates a composed message with the value inside it', async () => {
    const en = await ask('/users', 'en', sales, 'POST', {});
    expect(en.status).toBe(403);
    expect(en.error.message).toMatch(/^This operation requires the “.+” permission$/);
    const fa = await ask('/users', 'fa', sales, 'POST', {});
    expect(fa.error.message).toMatch(/^برای این عملیات به دسترسی/);
  });

  it('translates the words inside an error’s details, not its data', () => {
    const out = localizeError({
      message: 'فرم دارای خطاست.',
      details: { issues: [{ path: 'title', message: '«عنوان» الزامی است' }], guard: 'brief.complete', name: 'پیش‌نویس', rule: 'Doc_H §13 — شروع اجرای پروژه' },
    }, 'en');
    expect(out.message).toBe('The form has errors.');
    expect((out.details as any).issues[0]).toEqual({ path: 'title', message: '“Title” is required' });
    expect((out.details as any).name).toBe('پیش‌نویس'); // data, not words: left alone
    expect((out.details as any).rule).toBe('Doc_H §13 — starting project delivery');
    expect(localizeError({ message: 'فرم دارای خطاست.' }, 'fa').message).toBe('فرم دارای خطاست.');
  });
});
