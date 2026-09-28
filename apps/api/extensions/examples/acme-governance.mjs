/**
 * An example extension (roadmap #47) — how an organisation adds its own code rules without
 * forking Hiva OS. Not loaded unless EXTENSIONS_DIR points at this directory.
 *
 * A guard: a project may not be activated with a planned budget above its contract value — the
 * cost plan may not exceed what the client pays. An effect: when a deliverable is sent to the
 * client, its current files are shared in the client portal.
 */
export default {
  name: 'acme',
  version: '1.0.0',
  descriptionFa: 'نمونه: بودجه در سقف قرارداد، و اشتراک خودکار فایل‌های تحویل‌شده در پورتال',

  register(api) {
    api.registerGuard({
      key: 'acme.budgetWithinContract',
      labelFa: 'بودجهٔ برنامه‌ریزی‌شده در سقف ارزش قرارداد',
      descriptionFa: 'پروژه با بودجه‌ای بیشتر از ارزش قرارداد فعال نمی‌شود.',
      async run({ record }) {
        const budget = record.plannedBudget == null ? null : Number(record.plannedBudget);
        const value = record.contractValue == null ? null : Number(record.contractValue);
        if (budget == null || value == null || budget <= value) return { ok: true };
        return {
          ok: false,
          rule: 'acme — سیاست بودجه',
          messageFa: `بودجهٔ برنامه‌ریزی‌شده (${budget.toLocaleString('fa-IR')}) از ارزش قرارداد (${value.toLocaleString('fa-IR')}) بیشتر است.`,
          details: { plannedBudget: budget, contractValue: value },
        };
      },
    });
    api.attachGuard('project', 'activate', 'acme.budgetWithinContract');

    api.registerEffect({
      key: 'acme.shareDeliveredFiles',
      entity: 'deliverable',
      action: 'deliver',
      labelFa: 'اشتراک فایل‌های تحویل‌شده در پورتال مشتری',
      async run({ tx, id }) {
        await tx.document.updateMany({ where: { deliverableId: id, deletedAt: null, supersededAt: null }, data: { clientVisible: true } });
      },
    });
  },
};
