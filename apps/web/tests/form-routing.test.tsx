import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { evaluateRouting, buildStages, currentStage } from '@hiva/contracts';
import { FormRouting } from '../src/components/FormRouting';

const routing = {
  formCode: 'F50_CONTRACT_SCALE', nameFa: 'فرم اشل قرارداد', version: 2,
  baseRoles: ['DEPUTY', 'CEO'],
  fields: [
    { key: 'contractValue', labelFa: 'مبلغ قرارداد', type: 'currency', options: null },
    { key: 'scaleBand', labelFa: 'اشل', type: 'select', options: [{ value: 'L', labelFa: 'بزرگ' }] },
  ],
  rules: [{
    id: 'contract.large-value', whenFa: 'مبلغ قرارداد بیش از ۵٬۰۰۰٬۰۰۰٬۰۰۰ ریال باشد',
    describedFa: '«مبلغ قرارداد» بزرگ‌تر از 5000000000 باشد',
    when: { field: 'contractValue', op: 'gt', value: 5_000_000_000 },
    addApprovers: ['LEGAL_MANAGER', 'CEO'], source: 'DEFAULT',
  }],
};

describe('conditional routing', () => {
  it('evaluates a rule the same way in the browser as the server does', () => {
    const rules = routing.rules as any;
    const small = evaluateRouting(['DEPUTY', 'CEO'], rules, { contractValue: 100_000_000 });
    expect(small.roles.sort()).toEqual(['CEO', 'DEPUTY']);
    expect(small.matched).toEqual([]);
    expect(small.unmatched).toHaveLength(1);

    const big = evaluateRouting(['DEPUTY', 'CEO'], rules, { contractValue: 9_000_000_000 });
    expect(big.roles).toContain('LEGAL_MANAGER');
    expect(big.matched[0]!.whenFa).toContain('مبلغ قرارداد');
    // Numbers typed into a form arrive as strings; the evaluator must not care.
    expect(evaluateRouting(['DEPUTY'], rules, { contractValue: '9000000000' }).roles).toContain('LEGAL_MANAGER');
  });

  it('shows the rules of a form with their source and what they add', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(
      JSON.stringify(String(url).includes('/routing') ? routing : { definitions: [{ code: 'F50_CONTRACT_SCALE', nameFa: 'فرم اشل قرارداد', category: 'F' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><FormRouting /></QueryClientProvider>);

    expect(await screen.findByText(/مبلغ قرارداد بیش از/)).toBeTruthy();
    expect(screen.getByText('مدیر حقوقی، مدیرعامل')).toBeTruthy();
    expect(screen.getByText('پیش‌فرض سامانه')).toBeTruthy();
    // The fixed approvers from Doc_H are stated separately from what the rules add.
    const fixed = screen.getAllByText(/تأییدکنندهٔ ثابت/).find((el) => el.textContent?.includes('قائم‌مقام'));
    expect(fixed?.textContent).toContain('قائم‌مقام، مدیرعامل');
    expect(fixed?.textContent).toContain('نسخهٔ ۲');
  });
});

describe('approval chains', () => {
  const chain = [
    { id: 'unit', labelFa: 'تأیید مدیر واحد', roles: ['UNIT_MANAGER'] },
    { id: 'management', labelFa: 'تأیید مدیریت', roles: ['DEPUTY'] },
    { id: 'ceo', labelFa: 'تأیید مدیرعامل برای هزینهٔ بالا', roles: ['CEO'], when: { field: 'estimatedCost', op: 'gt', value: 500_000_000 } },
  ] as any;

  it('drops a conditional stage the values do not call for, and keeps the order', () => {
    const cheap = buildStages(chain, ['UNIT_MANAGER', 'DEPUTY'], { estimatedCost: 100_000_000 });
    expect(cheap.map((s) => s.id)).toEqual(['unit', 'management']);
    expect(currentStage(cheap)!.labelFa).toBe('تأیید مدیر واحد');

    const costly = buildStages(chain, ['UNIT_MANAGER', 'DEPUTY', 'CEO'], { estimatedCost: 900_000_000 });
    expect(costly.map((s) => s.id)).toEqual(['unit', 'management', 'ceo']);
    expect(costly.every((s) => s.declared)).toBe(true);
  });

  it('appends a routed-in role no stage covers, and a form without a chain keeps one stage', () => {
    const withLegal = buildStages(chain, ['UNIT_MANAGER', 'DEPUTY', 'LEGAL_MANAGER'], { estimatedCost: 1 });
    expect(withLegal.at(-1)!.roles).toEqual(['LEGAL_MANAGER']);
    expect(withLegal.at(-1)!.declared).toBe(false);

    const plain = buildStages([], ['ACCOUNT_MANAGER'], {});
    expect(plain).toHaveLength(1);
    expect(plain[0]!.quorum).toBe(1);
    expect(plain[0]!.declared).toBe(false);
    expect(buildStages([], [], {})).toEqual([]);
  });
});
