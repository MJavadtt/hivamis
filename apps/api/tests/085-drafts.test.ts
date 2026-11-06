import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { call, closeApp, get, login, put } from './helpers.js';

/**
 * ADR-122 (the owner, 2026-11-06): what a person typed and has not saved is kept for them, until the
 * form is saved or they delete it — and only for them.
 */
const draft = (over: Record<string, unknown> = {}) => ({
  key: '/leads#ثبت سرنخ جدید', title: 'ثبت سرنخ جدید', path: '/leads',
  fields: { 'نام سرنخ': { label: 'نام سرنخ', value: 'کمپین پاییز', base: '' } }, ...over,
});

describe('Drafts (ADR-122)', () => {
  const T: Record<string, string> = {};
  beforeAll(async () => {
    T.sales = await login('sales@hiva.local');
    T.designer = await login('designer@hiva.local');
    T.admin = await login('admin@hiva.local');
  }, 60_000);
  afterAll(closeApp);

  it('keeps a draft, and one per place however often it is saved', async () => {
    const first = await put('/me/drafts', T.sales, draft());
    expect(first.status).toBe(200);
    const second = await put('/me/drafts', T.sales, draft({ fields: { 'نام سرنخ': { label: 'نام سرنخ', value: 'کمپین زمستان', base: '' } } }));
    expect(second.body.id).toBe(first.body.id);
    const mine = await get('/me/drafts', T.sales);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0]).toMatchObject({ key: draft().key, title: 'ثبت سرنخ جدید', path: '/leads' });
    expect(mine.body[0].fields['نام سرنخ'].value).toBe('کمپین زمستان');
  });

  it('is nobody else’s to read or delete, the system administrator included', async () => {
    const { body } = await put('/me/drafts', T.sales, draft({ key: '/briefs#خصوصی' }));
    for (const token of [T.designer, T.admin]) {
      expect((await get('/me/drafts', token)).body.some((d: { id: string }) => d.id === body.id)).toBe(false);
      expect((await call('DELETE', `/me/drafts/${body.id}`, { token })).status).toBe(404);
    }
    // The same place is a different draft for someone else.
    expect((await put('/me/drafts', T.designer, draft({ key: '/briefs#خصوصی' }))).body.id).not.toBe(body.id);
  });

  it('goes when its owner deletes it', async () => {
    const { body } = await put('/me/drafts', T.sales, draft({ key: '/tasks#یادداشت' }));
    expect((await call('DELETE', `/me/drafts/${body.id}`, { token: T.sales })).status).toBe(204);
    expect((await get('/me/drafts', T.sales)).body.some((d: { id: string }) => d.id === body.id)).toBe(false);
    expect((await call('DELETE', `/me/drafts/${body.id}`, { token: T.sales })).status).toBe(404);
  });

  it('refuses what is not a draft, and what is too large to keep', async () => {
    expect((await put('/me/drafts', T.sales, draft({ path: 'https://elsewhere.example' }))).status).toBe(400);
    const huge = await put('/me/drafts', T.sales, draft({ key: '/x', fields: { a: { label: 'a', value: 'x'.repeat(300 * 1024) } } }));
    expect(huge.status).toBe(413);
    expect(huge.body.error.code).toBe('DRAFT_TOO_LARGE');
  });
});
