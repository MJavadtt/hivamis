import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ProjectGlance, glance, type GlanceData } from '../src/components/ProjectGlance';

/**
 * The owner's brief (2026-11-02): a project's overview answers what its status is, what is done, what
 * is in progress, what is next, who is responsible, and whether anything is blocked.
 */
const NOW = Date.parse('2026-11-02T09:00:00.000Z');
const day = (n: number) => new Date(NOW + n * 86_400_000).toISOString();
const DATA: GlanceData = {
  project: { state: 'ACTIVE', healthStatus: 'AMBER', accountOwner: { fullName: 'رضا شریفی' } },
  tasks: [
    { id: 't-done', title: 'استراتژی محتوا', state: 'CLOSED', dueDate: day(-10) },
    { id: 't-run', title: 'طراحی بنر', state: 'IN_PROGRESS', dueDate: day(5), assignee: { fullName: 'بهراد مهرنیا' } },
    { id: 't-block', title: 'عکاسی', state: 'BLOCKED', dueDate: day(2), blockReason: 'استودیو در دسترس نیست' },
    { id: 't-late', title: 'متن تیزر', state: 'ASSIGNED', dueDate: day(-3), assignee: { fullName: 'نگار حیدری' } },
    { id: 't-off', title: 'لغوشده', state: 'CANCELLED', dueDate: null },
  ],
  deliverables: [
    { id: 'd-1', name: 'بنر نهایی', state: 'ACCEPTED', dueDate: day(-1), departmentCode: 'CR' },
    { id: 'd-2', name: 'تیزر ۳۰ ثانیه', state: 'IN_PROGRESS', dueDate: day(8), departmentCode: 'CR' },
  ],
  workOrders: [
    { id: 'w-1', title: 'خلاقیت', state: 'IN_PROGRESS', targetDepartmentCode: 'CR', owner: { fullName: 'سپیده آذر' } },
    { id: 'w-2', title: 'رسانه', state: 'CLARIFICATION_REQUESTED', targetDepartmentCode: 'ME', owner: { fullName: 'حمید صابری' } },
  ],
  issues: [{ id: 'i-1', title: 'تأخیر در تأیید مشتری', state: 'OPEN', severity: 'HIGH' }],
  slaClocks: [{ id: 's-1', state: 'BREACHED', policy: { labelFa: 'پذیرش سفارش', labelEn: 'Order acceptance' } }],
};

describe('A project at a glance', () => {
  it('answers what is done, being done, next, stuck, and whose', () => {
    const g = glance(DATA, NOW);
    expect(g.done).toEqual({ tasks: 1, of: 4, deliverables: 1, ofDeliverables: 2 });
    expect(g.doing.map((t) => t.id)).toEqual(['t-run']);
    expect(g.next.map((n) => n.title)).toEqual(['عکاسی', 'طراحی بنر', 'تیزر ۳۰ ثانیه']);
    expect(g.stuck.map((s) => s.text)).toEqual([
      '«عکاسی» متوقف است: استودیو در دسترس نیست',
      '«متن تیزر» ۳ روز از مهلتش گذشته است — نگار حیدری',
      'واحد رسانه دربارهٔ «رسانه» سؤال دارد',
      'مسئلهٔ باز: تأخیر در تأیید مشتری',
      'مهلت «پذیرش سفارش» گذشته است',
    ]);
    expect(g.owners).toEqual([['CR', 'سپیده آذر'], ['ME', 'حمید صابری']]);
  });

  it('puts it on the page in plain words', () => {
    render(<MemoryRouter><ProjectGlance data={DATA} /></MemoryRouter>);
    const card = screen.getByTestId('project-glance');
    expect(card.textContent).toContain('نیازمند توجه');
    expect(card.textContent).toContain('مسئول پروژه: رضا شریفی');
    expect(within(screen.getByTestId('glance-doing')).getByRole('link', { name: 'طراحی بنر' }).getAttribute('href')).toBe('/tasks/t-run');
    expect(screen.getByTestId('glance-owners').textContent).toContain('خلاقیت / گرافیک / تولید: سپیده آذر');
  });
});
