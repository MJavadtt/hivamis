import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BRAND_COLOR_ROLES, BRAND_COLOR_ROLE_LABELS, BRAND_ROLES, BRAND_ROLE_LABELS, type BrandRole } from '@hiva/contracts';
import { apiGet, apiPut, apiUpload, downloadFile } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Badge, Button, Card, Input, Modal, Select, Textarea, useToast } from './ui';
import { FilePreview, NewVersionButton, VersionsButton, metadataFa } from './Assets';
import { formatDate, toPersianDigits } from '../lib/format';

/* Roadmap #42 — a client's brand in one place: palette, typefaces, and the files that carry it. */

type ColorRole = (typeof BRAND_COLOR_ROLES)[number];
interface Kit { colors: { name: string; hex: string; role: ColorRole }[]; fonts: { family: string; usage?: string }[]; notes: string | null; updatedAt: string | null }
interface BrandFile { id: string; lineageId: string | null; fileName: string; mimeType: string; sizeBytes: number; brandRole: BrandRole; version: number; metadata: any; createdAt: string; uploadedBy: { fullName: string } | null }
interface Data { company: { id: string; legalName: string }; kit: Kit; files: BrandFile[] }

/** Dark text on light swatches, light text on dark ones. */
export function inkOn(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? '#111827' : '#FFFFFF';
}

export function BrandLibraryCard({ companyId }: { companyId: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [role, setRole] = useState<BrandRole>('LOGO');
  const [editing, setEditing] = useState(false);
  const key = [`/companies/${companyId}/brand`];
  const { data } = useQuery<Data>({ queryKey: key, queryFn: () => apiGet(key[0]!), enabled: can('document.read') });
  if (!data) return null;
  const keeper = can('brand.manage');
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const add = async (file: File) => {
    const form = new FormData();
    form.append('companyId', companyId);
    form.append('brandRole', role);
    form.append('file', file);
    try { await apiUpload('/documents', form); toast(`«${file.name}» به کتابخانهٔ برند افزوده شد.`); await refresh(); }
    catch (e: any) { toast(e?.message ?? 'بارگذاری ناموفق بود.', 'danger'); }
  };
  const { kit, files } = data;
  const empty = !kit.colors.length && !kit.fonts.length && !kit.notes && !files.length;
  return (
    <Card title="کتابخانهٔ برند" subtitle="رنگ‌ها، فونت‌ها و فایل‌های هویت بصری این مشتری — مرجع هر طراحی برای او."
      action={keeper ? <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>ویرایش رنگ و فونت</Button> : undefined}>
      <div className="space-y-4 px-4 py-3" data-testid="brand-library">
        {empty && <p className="text-xs text-ink-500">هنوز چیزی از برند این مشتری ثبت نشده است.</p>}
        {kit.colors.length > 0 && (
          <section>
            <h4 className="mb-1.5 text-xs font-medium text-ink-600">رنگ‌ها</h4>
            <ul className="flex flex-wrap gap-2" data-testid="brand-colors">
              {kit.colors.map((c) => (
                <li key={`${c.hex}-${c.name}`}>
                  <button type="button" title="رونوشت کد رنگ" onClick={() => { void navigator.clipboard?.writeText(c.hex); toast(`${c.hex} رونوشت شد.`); }}
                    className="flex h-20 w-28 flex-col justify-end rounded-lg p-2 text-start shadow-sm ring-1 ring-ink-200" style={{ background: c.hex, color: inkOn(c.hex) }}>
                    <span className="text-xs font-medium">{c.name}</span>
                    <span className="ltr text-[11px] opacity-90">{c.hex}</span>
                    <span className="text-[10px] opacity-80">{BRAND_COLOR_ROLE_LABELS[c.role]}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {kit.fonts.length > 0 && (
          <section>
            <h4 className="mb-1.5 text-xs font-medium text-ink-600">فونت‌ها</h4>
            <ul className="space-y-1 text-sm" data-testid="brand-fonts">
              {kit.fonts.map((f) => {
                const file = files.find((x) => x.brandRole === 'FONT' && x.metadata?.fontFamily?.toLowerCase() === f.family.toLowerCase());
                return (
                  <li key={f.family} className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{f.family}</span>
                    {f.usage && <span className="text-xs text-ink-500">— {f.usage}</span>}
                    {!file && <Badge tone="warning">فایل فونت در کتابخانه نیست</Badge>}
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        {kit.notes && <p className="whitespace-pre-line rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-700">{kit.notes}</p>}
        {files.length > 0 && (
          <section>
            <h4 className="mb-1.5 text-xs font-medium text-ink-600">فایل‌های برند</h4>
            <ul className="divide-y divide-ink-100 text-sm" data-testid="brand-files">
              {files.map((f) => (
                <li key={f.lineageId ?? f.id} className="flex flex-wrap items-center gap-3 py-2">
                  <FilePreview documentId={f.id} mimeType={f.mimeType} />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-1.5"><Badge tone="neutral">{BRAND_ROLE_LABELS[f.brandRole]}</Badge><span className="truncate">{f.fileName}</span></p>
                    <p className="text-[11px] text-ink-500">{[metadataFa(f.metadata), `${f.uploadedBy?.fullName ?? ''} · ${formatDate(f.createdAt)}`].filter(Boolean).join(' · ')}</p>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => void downloadFile(`/documents/${f.id}/download`, f.fileName)}>دریافت</Button>
                  <VersionsButton documentId={f.id} version={f.version} onChanged={refresh} />
                  {keeper && <NewVersionButton documentId={f.id} onDone={refresh} />}
                </li>
              ))}
            </ul>
          </section>
        )}
        {keeper && (
          <div className="flex flex-wrap items-center gap-2 border-t border-ink-100 pt-3">
            <Select value={role} onChange={(e) => setRole(e.target.value as BrandRole)} aria-label="نقش فایل در برند" className="w-auto">
              {BRAND_ROLES.map((r) => <option key={r} value={r}>{BRAND_ROLE_LABELS[r]}</option>)}
            </Select>
            <input ref={input} type="file" className="hidden" data-testid="brand-file-input" onChange={(e) => { const f = e.target.files?.[0]; if (f) void add(f); e.target.value = ''; }} />
            <Button size="sm" variant="secondary" onClick={() => input.current?.click()}>افزودن فایل برند</Button>
            <span className="text-[11px] text-ink-400">لوگو، فایل فونت (TTF/OTF/WOFF)، راهنمای هویت بصری یا تصویر.</span>
          </div>
        )}
      </div>
      {editing && <KitEditor companyId={companyId} kit={kit} onClose={() => setEditing(false)} onSaved={refresh} />}
    </Card>
  );
}

const HEX = /^#[0-9a-fA-F]{6}$/;

function KitEditor({ companyId, kit, onClose, onSaved }: { companyId: string; kit: Kit; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const toast = useToast();
  const [colors, setColors] = useState(kit.colors.length ? kit.colors : [{ name: '', hex: '#000000', role: 'PRIMARY' as ColorRole }]);
  const [fonts, setFonts] = useState(kit.fonts);
  const [notes, setNotes] = useState(kit.notes ?? '');
  const [busy, setBusy] = useState(false);
  const setColor = (i: number, patch: Partial<Kit['colors'][number]>) => setColors(colors.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const setFont = (i: number, patch: Partial<Kit['fonts'][number]>) => setFonts(fonts.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const keptColors = colors.filter((c) => c.name.trim());
  const bad = keptColors.find((c) => !HEX.test(c.hex));
  const save = async () => {
    setBusy(true);
    try {
      await apiPut(`/companies/${companyId}/brand`, {
        colors: keptColors.map((c) => ({ ...c, name: c.name.trim() })),
        fonts: fonts.filter((f) => f.family.trim()).map((f) => ({ family: f.family.trim(), ...(f.usage?.trim() ? { usage: f.usage.trim() } : {}) })),
        notes: notes.trim() || null,
      });
      toast('کتابخانهٔ برند ذخیره شد.');
      await onSaved();
      onClose();
    } catch (e: any) { toast(e?.message ?? 'ذخیره ناموفق بود.', 'danger'); } finally { setBusy(false); }
  };
  return (
    <Modal open wide title="رنگ‌ها و فونت‌های برند" onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>انصراف</Button><Button variant="primary" loading={busy} disabled={!!bad} onClick={() => void save()}>ذخیره</Button></>}>
      <div className="space-y-4" data-testid="kit-editor">
        <section className="space-y-2">
          <h4 className="text-xs font-medium text-ink-600">رنگ‌ها</h4>
          {colors.map((c, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <input type="color" value={HEX.test(c.hex) ? c.hex : '#000000'} onChange={(e) => setColor(i, { hex: e.target.value.toUpperCase() })} aria-label={`رنگ ${toPersianDigits(i + 1)}`} className="h-9 w-10 cursor-pointer rounded border border-ink-200" />
              <Input value={c.hex} onChange={(e) => setColor(i, { hex: e.target.value.trim() })} aria-label={`کد رنگ ${toPersianDigits(i + 1)}`} className="ltr w-28" />
              <Input value={c.name} onChange={(e) => setColor(i, { name: e.target.value })} aria-label={`نام رنگ ${toPersianDigits(i + 1)}`} placeholder="نام رنگ" className="w-40" />
              <Select value={c.role} onChange={(e) => setColor(i, { role: e.target.value as ColorRole })} aria-label={`کاربرد رنگ ${toPersianDigits(i + 1)}`} className="w-auto">
                {BRAND_COLOR_ROLES.map((r) => <option key={r} value={r}>{BRAND_COLOR_ROLE_LABELS[r]}</option>)}
              </Select>
              <Button size="sm" variant="ghost" onClick={() => setColors(colors.filter((_, j) => j !== i))}>حذف</Button>
            </div>
          ))}
          {bad && <p className="text-xs text-rose-700">کد رنگ «{bad.hex}» باید به شکل #RRGGBB باشد.</p>}
          <Button size="sm" variant="secondary" onClick={() => setColors([...colors, { name: '', hex: '#000000', role: 'SECONDARY' }])}>افزودن رنگ</Button>
        </section>
        <section className="space-y-2">
          <h4 className="text-xs font-medium text-ink-600">فونت‌ها</h4>
          {fonts.map((f, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Input value={f.family} onChange={(e) => setFont(i, { family: e.target.value })} aria-label={`نام فونت ${toPersianDigits(i + 1)}`} placeholder="نام خانوادهٔ فونت" className="w-48" />
              <Input value={f.usage ?? ''} onChange={(e) => setFont(i, { usage: e.target.value })} aria-label={`کاربرد فونت ${toPersianDigits(i + 1)}`} placeholder="کاربرد، مثلاً تیتر" className="w-56" />
              <Button size="sm" variant="ghost" onClick={() => setFonts(fonts.filter((_, j) => j !== i))}>حذف</Button>
            </div>
          ))}
          <Button size="sm" variant="secondary" onClick={() => setFonts([...fonts, { family: '' }])}>افزودن فونت</Button>
        </section>
        <section>
          <h4 className="mb-1 text-xs font-medium text-ink-600">نکته‌های برند</h4>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} aria-label="نکته‌های برند" placeholder="مثلاً حریم لوگو، ترکیب‌های ممنوع، لحن…" />
        </section>
      </div>
    </Modal>
  );
}
