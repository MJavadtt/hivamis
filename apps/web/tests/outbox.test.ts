import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enqueue, listOutbox, pendingCount, removeItem, resetOutboxStore, updateItem } from '../src/lib/outbox';
import { requeue, syncOutbox } from '../src/lib/sync';
import { setAccessToken } from '../src/lib/api';

const form = { formCode: 'E37_QC_UNIT', formNameFa: 'فرم QC اولیه واحد اجرایی', data: { note: 'سر صحنه' }, asDraft: false };

beforeEach(async () => {
  resetOutboxStore();
  localStorage.clear();
  setAccessToken('test-token');
  for (const i of await listOutbox()) await removeItem(i.id);
});

describe('the offline outbox', () => {
  it('keeps a form typed with no signal, and sends it when the network returns', async () => {
    const item = await enqueue(form);
    expect(item.state).toBe('QUEUED');
    expect(pendingCount(await listOutbox())).toBe(1);

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 's1', code: 'FRM-000042' }), { status: 201, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await syncOutbox();

    expect(result).toEqual({ sent: 1, rejected: 0, waiting: 0 });
    const [stored] = await listOutbox();
    expect(stored!.state).toBe('SENT');
    expect(stored!.submissionCode).toBe('FRM-000042');
    expect(pendingCount(await listOutbox())).toBe(0);

    // The device's key travelled with it, so a retry cannot file it twice.
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.clientKey).toBe(item.id);
    expect(body.formCode).toBe('E37_QC_UNIT');
  });

  it('keeps a refusal in the person’s own words instead of dropping the form', async () => {
    await enqueue(form);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'GOVERNANCE_RULE_VIOLATION', message: 'پروژه بسته شده است', details: { rule: 'project.closed' } } }),
      { status: 422, headers: { 'content-type': 'application/json' } },
    )));

    const result = await syncOutbox();
    expect(result.rejected).toBe(1);
    const [item] = await listOutbox();
    expect(item!.state).toBe('REJECTED');
    expect(item!.errorFa).toContain('پروژه بسته شده است');
    expect(item!.errorCode).toBe('GOVERNANCE_RULE_VIOLATION');
    // It is still here: only a person decides whether to fix it or throw it away.
    expect(pendingCount(await listOutbox())).toBe(1);

    await requeue(item!);
    expect((await listOutbox())[0]!.state).toBe('QUEUED');
    expect((await listOutbox())[0]!.errorFa).toBeUndefined();
  });

  it('waits rather than losing anything when the server cannot be reached at all', async () => {
    await enqueue(form);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));

    const result = await syncOutbox();
    expect(result).toEqual({ sent: 0, rejected: 0, waiting: 1 });
    const [item] = await listOutbox();
    expect(item!.state).toBe('QUEUED');
    expect(item!.attempts).toBe(1);        // counted, so a stuck item is visible
    expect(item!.data).toEqual({ note: 'سر صحنه' });
  });

  it('treats a replay the server recognises as the same form, not a second one', async () => {
    const item = await enqueue(form);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ id: 's1', code: 'FRM-000042', duplicateOf: 'FRM-000042' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));
    await syncOutbox();
    const [stored] = await listOutbox();
    expect(stored!.state).toBe('SENT');
    expect(stored!.submissionCode).toBe('FRM-000042');
    expect(stored!.id).toBe(item.id);
  });

  it('sends the oldest form first, so the order they were filled in is the order they are filed', async () => {
    const first = await enqueue({ ...form, formNameFa: 'اول' });
    await updateItem(first.id, { createdAt: Date.now() - 60_000 });
    await enqueue({ ...form, formNameFa: 'دوم' });

    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      seen.push(JSON.parse(String(init.body)).clientKey);
      return new Response(JSON.stringify({ code: 'X' }), { status: 201, headers: { 'content-type': 'application/json' } });
    }));
    await syncOutbox();
    expect(seen[0]).toBe(first.id);
  });
});
