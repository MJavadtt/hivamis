import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { METRO_CATALOGUE, metroSuggestedAmount } from '@hiva/contracts';
import { app, closeApp, get, login, patch, post, expectOk, upload, tinyPdf } from './helpers.js';
import { prisma } from '../src/db.js';
import { runMetroReminders } from '../src/metro/reminders.js';

/**
 * The owner (2026-11-17; ADR-135): a metro module like venues and rentals — Tehran's and Karaj's lines
 * and stations; trains of wagons carrying body, panel and handle spaces; bookings with amounts,
 * payments, notices, reports and files; every part added, edited and deleted.
 */
let T: Record<string, string>;
let lineId: string;
let spaces: { id: string; kind: string; quantity: number }[];
const del = async (url: string, token: string) => {
  const res = await (await app()).inject({ method: 'DELETE', url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });
  return { status: res.statusCode, body: res.json() };
};

beforeAll(async () => {
  await app();
  T = { pmo: await login('pmo@hiva.local'), sales: await login('sales@hiva.local'), designer: await login('designer@hiva.local'), finance: await login('finance@hiva.local') };
});
afterAll(closeApp);

describe('Metro inventory (ADR-135)', () => {
  it('starts with the map\'s seven lines and their stations, Line 5 to Karaj, interchanges marked', async () => {
    const lines = expectOk(await get('/metro/lines', T.pmo), 'lines') as { id: string; number: number; stations: number }[];
    expect(lines.map((l) => l.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const l of METRO_CATALOGUE) expect(lines.find((x) => x.number === l.number)!.stations, `line ${l.number}`).toBe(l.stations.length);
    const five = expectOk(await get(`/metro/lines/${lines.find((l) => l.number === 5)!.id}`, T.pmo), 'line 5');
    expect(five.stations.map((s: any) => s.nameFa)).toEqual(expect.arrayContaining(['کرج', 'گلشهر', 'تهران (صادقیه)']));
    expect(five.stations.find((s: any) => s.nameFa === 'تهران (صادقیه)').isInterchange).toBe(true);
    // Read again, nothing is made twice.
    expect((expectOk(await get('/metro/lines', T.pmo), 'again') as unknown[]).length).toBe(7);
    lineId = lines.find((l) => l.number === 3)!.id;
  });

  it('a train is made with its wagons and their body, panels and handles; each part edited, added and deleted', async () => {
    expect((await post(`/metro/lines/${lineId}/trains`, T.sales, { code: 'X' })).status).toBe(403);
    expectOk(await post(`/metro/lines/${lineId}/trains`, T.pmo, { code: '301', wagons: 3, template: { BODY: 1, KATIBEH: 6, HANDLE: 20 }, prices: { BODY: 300_000_000, KATIBEH: 5_000_000, HANDLE: 500_000 } }), 'train');
    expect((await post(`/metro/lines/${lineId}/trains`, T.pmo, { code: '301' })).status).toBe(409);
    let line = expectOk(await get(`/metro/lines/${lineId}`, T.pmo), 'line');
    const train = line.trains.find((t: any) => t.code === '301');
    expect(train.wagons.map((w: any) => w.number)).toEqual([1, 2, 3]);
    expect(train.wagons[0].spaces.map((s: any) => [s.kind, s.quantity]).sort()).toEqual([['BODY', 1], ['HANDLE', 20], ['KATIBEH', 6]]);
    spaces = train.wagons[0].spaces;

    const added = expectOk(await post(`/metro/trains/${train.id}/wagons`, T.pmo, { count: 1, template: { BODY: 0, KATIBEH: 4, HANDLE: 0 } }), 'wagon') as { id: string; number: number }[];
    expect(added[0]!.number).toBe(4);
    const extra = expectOk(await post(`/metro/wagons/${added[0]!.id}/spaces`, T.pmo, { kind: 'HANDLE', quantity: 10, monthlyPrice: 400_000, label: 'دستگیره‌های سمت راست' }), 'space');
    expectOk(await patch(`/metro/spaces/${extra.id}`, T.pmo, { quantity: 12 }), 'edit space');
    expectOk(await del(`/metro/spaces/${extra.id}`, T.pmo), 'delete space');
    expectOk(await patch(`/metro/wagons/${added[0]!.id}`, T.pmo, { notes: 'واگن تازه' }), 'edit wagon');
    expectOk(await del(`/metro/wagons/${added[0]!.id}`, T.pmo), 'delete wagon');

    const st = expectOk(await post(`/metro/lines/${lineId}/stations`, T.pmo, { nameFa: 'ایستگاه آزمون' }), 'station');
    expectOk(await patch(`/metro/stations/${st.id}`, T.pmo, { underConstruction: true }), 'edit station');
    expectOk(await del(`/metro/stations/${st.id}`, T.pmo), 'delete station');
    line = expectOk(await get(`/metro/lines/${lineId}`, T.pmo), 'line again');
    expect(line.stations.some((s: any) => s.nameFa === 'ایستگاه آزمون')).toBe(false);
  });
});

describe('Metro bookings (ADR-135)', () => {
  it('books units of spaces, refuses more than a space has, suggests the amount, and takes payments', async () => {
    const handle = spaces.find((s) => s.kind === 'HANDLE')!, body = spaces.find((s) => s.kind === 'BODY')!;
    expect((await post('/metro/bookings', T.designer, { clientName: 'x', startDate: '2026-12-01', endDate: '2026-12-30', items: [{ spaceId: body.id }] })).status).toBe(403);
    const a = expectOk(await post('/metro/bookings', T.sales, {
      clientName: 'شرکت نوشابه آزمون', title: 'کمپین زمستانه', startDate: '2026-12-01', endDate: '2026-12-30',
      items: [{ spaceId: body.id, quantity: 1 }, { spaceId: handle.id, quantity: 15 }], state: 'CONFIRMED',
    }), 'booking');
    expect(a.code).toMatch(/^MTR-/);
    expect(a.amount).toBe(metroSuggestedAmount([{ quantity: 1, monthlyPrice: 300_000_000 }, { quantity: 15, monthlyPrice: 500_000 }], '2026-12-01', '2026-12-30'));
    // The body is taken; of the twenty handles, five are left.
    const clash = await post('/metro/bookings', T.sales, { clientName: 'دیگری', startDate: '2026-12-20', endDate: '2027-01-10', items: [{ spaceId: body.id }] });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('SPACE_TAKEN');
    expect((await post('/metro/bookings', T.sales, { clientName: 'دیگری', startDate: '2026-12-20', endDate: '2027-01-10', items: [{ spaceId: handle.id, quantity: 6 }] })).status).toBe(409);
    const b = expectOk(await post('/metro/bookings', T.sales, { clientName: 'دیگری', startDate: '2026-12-20', endDate: '2027-01-10', items: [{ spaceId: handle.id, quantity: 5 }], amount: 1_000_000 }), 'fits');
    expect(b.amount).toBe(1_000_000);
    const free = expectOk(await get('/metro/availability', T.sales, { from: '2026-12-25', to: '2026-12-26', lineId }), 'free') as any[];
    expect(free.find((s) => s.id === handle.id)).toMatchObject({ taken: 20, free: 0 });
    // After the first ends, the body is free again.
    expectOk(await post('/metro/bookings', T.sales, { clientName: 'بعدی', startDate: '2026-12-31', endDate: '2027-01-15', items: [{ spaceId: body.id }] }), 'after');

    expectOk(await post(`/metro/bookings/${a.id}/payments`, T.sales, { amount: 100_000_000, paidAt: '2026-12-02', method: 'کارت به کارت' }), 'payment');
    const shown = expectOk(await get(`/metro/bookings/${a.id}`, T.finance), 'shown');
    expect(shown).toMatchObject({ paid: 100_000_000, balance: a.amount - 100_000_000, client: 'شرکت نوشابه آزمون' });
    expect((await patch(`/metro/spaces/${handle.id}`, (await login('pmo@hiva.local')), { quantity: 10 })).status).toBe(409);
  });

  it('moves through its states; a cancelled one frees its spaces and needs a reason; deleted for good', async () => {
    const body = spaces.find((s) => s.kind === 'KATIBEH')!;
    const x = expectOk(await post('/metro/bookings', T.sales, { clientName: 'لغوشونده', startDate: '2027-02-01', endDate: '2027-02-10', items: [{ spaceId: body.id, quantity: 6 }] }), 'x');
    expect(x.state).toBe('HOLD');
    expect((await post(`/metro/bookings/${x.id}/state`, T.sales, { to: 'ENDED' })).status).toBe(409);
    expect((await post(`/metro/bookings/${x.id}/state`, T.sales, { to: 'CANCELLED' })).status).toBe(400);
    expectOk(await post(`/metro/bookings/${x.id}/state`, T.sales, { to: 'CANCELLED', reason: 'مشتری منصرف شد' }), 'cancel');
    const y = expectOk(await post('/metro/bookings', T.sales, { clientName: 'جایگزین', startDate: '2027-02-01', endDate: '2027-02-10', items: [{ spaceId: body.id, quantity: 6 }] }), 'y');
    // Back to a hold, the cancelled one finds its spaces taken.
    expect((await post(`/metro/bookings/${x.id}/state`, T.sales, { to: 'HOLD' })).status).toBe(409);
    expectOk(await del(`/metro/bookings/${x.id}`, T.sales), 'delete');
    expect(await prisma.metroBooking.findUnique({ where: { id: x.id } })).toBeNull();
    expect(y.id).toBeTruthy();
    // A space a booking holds is not deleted from under it.
    expect((await del(`/metro/spaces/${body.id}`, T.pmo)).status).toBe(409);
  });

  it('runs its daily round: starts, ends, and tells of what ends soon — once', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const inFive = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const handle = spaces.find((s) => s.kind === 'HANDLE')!;
    const z = expectOk(await post('/metro/bookings', T.sales, { clientName: 'امروزی', startDate: today, endDate: inFive, items: [{ spaceId: handle.id, quantity: 1 }], state: 'CONFIRMED' }), 'z');
    const first = await runMetroReminders();
    expect(first.started).toBeGreaterThanOrEqual(1);
    expect((await prisma.metroBooking.findUniqueOrThrow({ where: { id: z.id } })).state).toBe('ACTIVE');
    expect(await prisma.notification.count({ where: { kind: 'METRO_ENDING', entityId: z.id } })).toBeGreaterThan(0);
    const again = await prisma.notification.count({ where: { kind: 'METRO_ENDING', entityId: z.id } });
    await runMetroReminders();
    expect(await prisma.notification.count({ where: { kind: 'METRO_ENDING', entityId: z.id } })).toBe(again);
  });

  it('reports occupancy and money by line and kind, and as a CSV', async () => {
    const r = expectOk(await get('/metro/reports', T.finance, { from: '2026-12-01', to: '2026-12-31', lineId }), 'report');
    const body = r.occupancy[0].kinds.find((k: any) => k.kind === 'BODY');
    expect(body.sold).toBeGreaterThan(0);
    expect(r.totals.billed).toBeGreaterThan(0);
    const res = await (await app()).inject({ method: 'GET', url: `/api/v1/metro/reports.csv?from=2026-12-01&to=2026-12-31`, headers: { authorization: `Bearer ${T.finance}` } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('شرکت نوشابه آزمون');
  });

  it('carries notes and files on every part', async () => {
    const line = expectOk(await get(`/metro/lines/${lineId}`, T.pmo), 'line');
    const train = line.trains[0];
    for (const [recordType, recordId] of [['metroLine', lineId], ['metroTrain', train.id], ['metroWagon', train.wagons[0].id], ['metroSpace', spaces[0]!.id]] as const) {
      expectOk(await post('/notes', T.pmo, { recordType, recordId, body: 'یادداشت آزمون' }), recordType);
      expectOk(await upload(T.pmo, { name: 'photo.pdf', type: 'application/pdf', content: tinyPdf('p') }, { recordType, recordId }), `${recordType} file`);
    }
    // Whoever reads the metro reads them; the designer, whose unit runs it, does.
    const notes = expectOk(await get('/notes', T.designer, { recordType: 'metroLine', recordId: lineId }), 'designer reads') as unknown[];
    expect(notes.length).toBeGreaterThan(0);
    expect(expectOk(await get('/documents', T.designer, { recordType: 'metroTrain', recordId: train.id }), 'files').length).toBe(1);
  });
});
