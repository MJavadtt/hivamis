import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LocaleProvider } from '../src/lib/locale';
import { FormDesigner } from '../src/components/FormDesigner';

const design = {
  code: 'B11_BRIEF_ANALYSIS', nameFa: 'فرم تحلیل Brief', nameEn: 'Brief analysis', category: 'B',
  module: 'ACCOUNT_MANAGEMENT', no: 11, version: 3, isCustom: false, isActive: true,
  customizedAt: null, binding: null, slaCode: null,
  senderDepts: ['A'], receiverDepts: ['A', 'ST'], approverRoles: ['ACCOUNT_MANAGER'], nextProcessFa: null,
  fields: [
    { key: 'briefId', labelFa: 'بریف', labelEn: 'Brief', type: 'entityRef', entity: 'brief', required: true },
    { key: 'interpretedNeed', labelFa: 'تفسیر نیاز مشتری', labelEn: 'Interpreted need', type: 'textarea', required: true },
    { key: 'risks', labelFa: 'ریسک‌های شناسایی‌شده', labelEn: 'Risks', type: 'textarea' },
  ],
  protectedKeys: [
    { key: 'briefId', labelFa: 'بریف', type: 'entityRef' },
    { key: 'interpretedNeed', labelFa: 'تفسیر نیاز مشتری', type: 'textarea' },
  ],
  submissions: 12,
};

function mount() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(
    JSON.stringify(String(url).includes('/design')
      ? design
      : String(url).includes('/forms/definitions')
        ? { definitions: [{ code: 'B11_BRIEF_ANALYSIS', nameFa: 'فرم تحلیل Brief', category: 'B' }] }
        : { items: [], total: 0 }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<LocaleProvider><QueryClientProvider client={qc}><FormDesigner /></QueryClientProvider></LocaleProvider>);
}

describe('FormDesigner', () => {
  it('lists the fields, marks the ones the process needs, and previews with the real renderer', async () => {
    mount();
    const table = await screen.findByTestId('designer-fields');
    expect(table.querySelectorAll('tr')).toHaveLength(3);
    // A field Doc_H requires is shown locked, not hidden.
    expect(table.textContent).toContain('الزام فرآیند');
    const deleteButtons = [...table.querySelectorAll('button')].filter((b) => b.textContent === 'حذف');
    expect((deleteButtons[0] as HTMLButtonElement).disabled).toBe(true);   // briefId is protected
    expect((deleteButtons[2] as HTMLButtonElement).disabled).toBe(false);  // risks is not

    // The preview is the form itself: every label appears in it.
    const preview = screen.getByTestId('designer-preview');
    expect(preview.textContent).toContain('تفسیر نیاز مشتری');
    expect(preview.textContent).toContain('ریسک‌های شناسایی‌شده');
  });

  it('removes an unprotected field into an unsaved draft without touching the server', async () => {
    mount();
    const table = await screen.findByTestId('designer-fields');
    const remove = [...table.querySelectorAll('button')].filter((b) => b.textContent === 'حذف')[2]!;
    fireEvent.click(remove);

    expect(screen.getByTestId('designer-fields').querySelectorAll('tr')).toHaveLength(2);
    expect(screen.getByText('ذخیره نشده')).toBeTruthy();
    expect(screen.getByTestId('designer-preview').textContent).not.toContain('ریسک‌های شناسایی‌شده');
    // Nothing was saved: the change lives in the draft until the administrator commits it.
    expect((globalThis.fetch as any).mock.calls.every((c: any[]) => !String(c[1]?.method ?? 'GET').includes('PUT'))).toBe(true);
  });
});
