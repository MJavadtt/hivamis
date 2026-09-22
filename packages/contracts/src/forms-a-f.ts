import { f, OPT, UNIT_ORDER_FIELDS, MEETING_FIELDS, type FormDef } from './form-fields.js';

/**
 * Form catalogue — categories A to F (Doc_H forms 1–52).
 * Source: «دسته‌بندی فرم‌های ارتباطی و انتقال داده شرکت».
 * Each entry supplies the full Doc_H contract: Sender → Receiver → Approver → SLA → Next Process.
 */
export const FORMS_A_F: readonly FormDef[] = [
  /* ── A. فرم‌های CRM و فروش ───────────────────────────────────────────── */
  {
    no: 1, code: 'A01_LEAD', nameFa: 'فرم ثبت Lead', nameEn: 'Lead registration', category: 'A',
    module: 'CRM_SALES', senderDepts: ['S'], receiverDepts: ['S'], approverRoles: ['SALES_MANAGER'],
    slaCode: 'SLA_LEAD_CREATE', binding: 'lead', nextProcessFa: 'مذاکره و نیازسنجی',
    fields: [
      f.text('name', 'نام سرنخ', 'Lead name', true),
      f.text('companyName', 'نام شرکت', 'Company name', true),
      f.text('contactName', 'نام تماس', 'Contact name'),
      f.text('phone', 'تلفن', 'Phone'),
      f.text('email', 'ایمیل', 'Email'),
      f.sel('source', 'منبع', 'Source', [
        { value: 'REFERRAL', labelFa: 'معرفی' }, { value: 'INBOUND', labelFa: 'ورودی' },
        { value: 'OUTBOUND', labelFa: 'تماس سرد' }, { value: 'EVENT', labelFa: 'رویداد' },
        { value: 'CAMPAIGN', labelFa: 'کمپین' }, { value: 'OTHER', labelFa: 'سایر' },
      ], true),
      f.money('estimatedValue', 'ارزش تخمینی', 'Estimated value'),
      f.area('need', 'نیاز اولیه', 'Initial need'),
      f.files(),
    ],
  },
  {
    no: 2, code: 'A02_OPPORTUNITY', nameFa: 'فرم ثبت Opportunity', nameEn: 'Opportunity registration', category: 'A',
    module: 'CRM_SALES', senderDepts: ['S'], receiverDepts: ['S', 'A'], approverRoles: ['SALES_MANAGER'],
    binding: 'opportunity', nextProcessFa: 'تهیه بریف فروش',
    fields: [
      f.text('title', 'عنوان فرصت', 'Opportunity title', true),
      f.ref('companyId', 'مشتری', 'Customer', 'company', true),
      f.money('estimatedValue', 'ارزش تخمینی', 'Estimated value', true),
      f.date('expectedCloseDate', 'تاریخ تخمینی بستن', 'Expected close date'),
      f.multi('servicesNeeded', 'خدمات مورد نیاز', 'Services needed', OPT.units),
      f.area('description', 'شرح فرصت', 'Description'),
      f.files(),
    ],
  },
  {
    no: 3, code: 'A03_CUSTOMER_INFO', nameFa: 'فرم اطلاعات اولیه مشتری', nameEn: 'Initial customer information', category: 'A',
    module: 'CRM_SALES', senderDepts: ['S'], receiverDepts: ['S', 'A'], approverRoles: ['SALES_MANAGER'],
    binding: 'company', nextProcessFa: 'تهیه بریف فروش',
    fields: [
      f.text('legalName', 'نام رسمی شرکت', 'Legal name', true),
      f.text('brandName', 'نام برند', 'Brand name'),
      f.text('industry', 'صنعت', 'Industry', true),
      f.text('nationalId', 'شناسه ملی', 'National ID'),
      f.text('economicCode', 'کد اقتصادی', 'Economic code'),
      f.text('website', 'وب‌سایت', 'Website'),
      f.area('address', 'آدرس', 'Address'),
      f.text('phone', 'تلفن', 'Phone'),
      f.files(),
    ],
  },
  {
    no: 4, code: 'A04_SALES_BRIEF', nameFa: 'فرم Brief فروش', nameEn: 'Sales brief', category: 'A',
    module: 'CRM_SALES', senderDepts: ['S'], receiverDepts: ['A'], approverRoles: ['ACCOUNT_MANAGER'],
    slaCode: 'SLA_BRIEF_PREPARE', binding: 'brief', nextProcessFa: 'کنترل بریف توسط اکانت',
    fields: [
      f.ref('opportunityId', 'فرصت فروش', 'Opportunity', 'opportunity', true),
      f.text('title', 'عنوان بریف', 'Brief title', true),
      f.area('businessObjective', 'هدف کسب‌وکار مشتری', 'Business objective', true),
      f.area('targetAudience', 'مخاطب هدف', 'Target audience', true),
      f.area('scope', 'Scope درخواستی', 'Requested scope', true),
      f.area('expectedDeliverables', 'خروجی‌های مورد انتظار', 'Expected deliverables', true),
      f.money('budgetRange', 'بودجه تقریبی مشتری', 'Client budget range', true),
      f.date('desiredDeadline', 'زمان مورد انتظار مشتری', 'Desired deadline', true),
      f.multi('unitsNeeded', 'واحدهای احتمالی درگیر', 'Likely units', OPT.units, true),
      f.area('competitorContext', 'رقبا و سابقه', 'Competitor context'),
      f.area('constraints', 'محدودیت‌ها', 'Constraints'),
      f.area('successCriteria', 'معیار موفقیت', 'Success criteria'),
      f.files(),
    ],
  },
  {
    no: 5, code: 'A05_SALES_ACTIVITY', nameFa: 'فرم ثبت مذاکرات و پیگیری فروش', nameEn: 'Sales negotiation & follow-up log', category: 'A',
    module: 'CRM_SALES', senderDepts: ['S'], receiverDepts: ['S'], approverRoles: ['SALES_MANAGER'],
    binding: 'activity', nextProcessFa: 'به‌روزرسانی وضعیت فرصت',
    fields: [
      f.ref('opportunityId', 'فرصت فروش', 'Opportunity', 'opportunity'),
      f.sel('kind', 'نوع فعالیت', 'Activity type', [
        { value: 'CALL', labelFa: 'تماس' }, { value: 'MEETING', labelFa: 'جلسه' },
        { value: 'EMAIL', labelFa: 'ایمیل' }, { value: 'VISIT', labelFa: 'بازدید' },
        { value: 'NOTE', labelFa: 'یادداشت' },
      ], true),
      f.dt('occurredAt', 'زمان', 'Occurred at', true),
      f.area('summary', 'خلاصه مذاکره', 'Summary', true),
      f.area('nextStep', 'اقدام بعدی', 'Next step'),
      f.date('nextStepDue', 'مهلت اقدام بعدی', 'Next step due'),
      f.files(),
    ],
  },
  {
    no: 6, code: 'A06_PROPOSAL_REQUEST', nameFa: 'فرم درخواست تهیه Proposal', nameEn: 'Proposal preparation request', category: 'A',
    module: 'CRM_SALES', senderDepts: ['S'], receiverDepts: ['A'], approverRoles: ['ACCOUNT_MANAGER'],
    slaCode: 'SLA_BRIEF_ACK', nextProcessFa: 'Kick-off داخلی اکانت',
    fields: [
      f.ref('briefId', 'بریف', 'Brief', 'brief', true),
      f.date('requiredBy', 'مهلت مورد نیاز', 'Required by', true),
      f.sel('priority', 'اولویت', 'Priority', OPT.priority, true),
      f.area('notes', 'توضیحات', 'Notes'),
      f.files(),
    ],
  },
  {
    no: 7, code: 'A07_SALES_TO_ACCOUNT_HANDOFF', nameFa: 'فرم انتقال رسمی مشتری از Sales به Account', nameEn: 'Sales→Account customer handoff', category: 'A',
    module: 'CRM_SALES', senderDepts: ['S'], receiverDepts: ['A'], approverRoles: ['ACCOUNT_MANAGER'],
    slaCode: 'SLA_HANDOVER', binding: 'handoff', nextProcessFa: 'Kick-off اجرایی',
    fields: [
      f.ref('companyId', 'مشتری', 'Customer', 'company', true),
      f.ref('projectId', 'پروژه', 'Project', 'project'),
      f.ref('contractId', 'قرارداد', 'Contract', 'contract', true),
      f.user('salesOwner', 'مسئول فروش', 'Sales owner', true),
      f.user('accountOwner', 'مسئول اکانت', 'Account owner', true),
      f.area('commitmentsMade', 'تعهدات داده‌شده به مشتری', 'Commitments made to client', true),
      f.area('clientExpectations', 'انتظارات مشتری', 'Client expectations', true),
      f.area('sensitivities', 'حساسیت‌ها و نکات کلیدی', 'Sensitivities'),
      f.area('openItems', 'موارد باز', 'Open items'),
      f.files(),
    ],
  },
  {
    no: 8, code: 'A08_CLIENT_MEETING_RESULT', nameFa: 'فرم ثبت نتیجه جلسه / مذاکره مشتری', nameEn: 'Client meeting outcome', category: 'A',
    module: 'CRM_SALES', senderDepts: ['S'], receiverDepts: ['S', 'A'], approverRoles: ['SALES_MANAGER'],
    slaCode: 'SLA_MEETING_MINUTES', binding: 'meeting', nextProcessFa: 'به‌روزرسانی فرصت / بریف',
    fields: [f.ref('companyId', 'مشتری', 'Customer', 'company', true), ...MEETING_FIELDS],
  },

  /* ── B. فرم‌های Account و تحلیل پروژه ──────────────────────────────────── */
  {
    no: 9, code: 'B09_BRIEF_CONTROL', nameFa: 'فرم دریافت و کنترل Brief', nameEn: 'Brief receipt & completeness control', category: 'B',
    module: 'ACCOUNT_MANAGEMENT', senderDepts: ['A'], receiverDepts: ['S'], approverRoles: ['ACCOUNT_MANAGER'],
    slaCode: 'SLA_BRIEF_REVIEW', binding: 'briefReview', nextProcessFa: 'تأیید بریف یا بازگشت به فروش',
    fields: [
      f.ref('briefId', 'بریف', 'Brief', 'brief', true),
      f.check('hasObjective', 'هدف کسب‌وکار مشخص است', 'Objective defined'),
      f.check('hasAudience', 'مخاطب هدف مشخص است', 'Audience defined'),
      f.check('hasScope', 'Scope مشخص است', 'Scope defined'),
      f.check('hasDeliverables', 'خروجی‌ها مشخص است', 'Deliverables defined'),
      f.check('hasBudget', 'بودجه مشخص است', 'Budget defined'),
      f.check('hasDeadline', 'زمان‌بندی مشخص است', 'Deadline defined'),
      f.sel('verdict', 'نتیجه کنترل', 'Verdict', [
        { value: 'COMPLETE', labelFa: 'کامل — تأیید' },
        { value: 'INCOMPLETE', labelFa: 'ناقص — بازگشت به فروش' },
      ], true),
      f.area('missingItems', 'موارد ناقص', 'Missing items', false),
      f.files(),
    ],
  },
  {
    no: 10, code: 'B10_BRIEF_COMPLETION', nameFa: 'فرم تکمیل اطلاعات Brief', nameEn: 'Brief completion', category: 'B',
    module: 'ACCOUNT_MANAGEMENT', senderDepts: ['S'], receiverDepts: ['A'], approverRoles: ['ACCOUNT_MANAGER'],
    slaCode: 'SLA_BRIEF_ACK', nextProcessFa: 'کنترل مجدد بریف',
    fields: [
      f.ref('briefId', 'بریف', 'Brief', 'brief', true),
      f.area('addedInformation', 'اطلاعات تکمیلی', 'Added information', true),
      f.files(),
    ],
  },
  {
    no: 11, code: 'B11_BRIEF_ANALYSIS', nameFa: 'فرم تحلیل Brief', nameEn: 'Brief analysis', category: 'B',
    module: 'ACCOUNT_MANAGEMENT', senderDepts: ['A'], receiverDepts: ['A', 'ST'], approverRoles: ['ACCOUNT_MANAGER'],
    nextProcessFa: 'برگزاری Kick-off',
    fields: [
      f.ref('briefId', 'بریف', 'Brief', 'brief', true),
      f.area('interpretedNeed', 'تفسیر نیاز مشتری', 'Interpreted need', true),
      f.area('proposedApproach', 'رویکرد پیشنهادی', 'Proposed approach', true),
      f.multi('unitsInvolved', 'واحدهای درگیر', 'Units involved', OPT.units, true),
      f.area('risks', 'ریسک‌های شناسایی‌شده', 'Identified risks'),
      f.area('assumptions', 'مفروضات', 'Assumptions'),
      f.area('openQuestions', 'ابهامات باقی‌مانده', 'Open questions'),
      f.files(),
    ],
  },
  {
    no: 12, code: 'B12_KICKOFF', nameFa: 'فرم Kick-off', nameEn: 'Kick-off form', category: 'B',
    module: 'ACCOUNT_MANAGEMENT', senderDepts: ['A'], receiverDepts: ['ST', 'CR', 'ME', 'DM'], approverRoles: ['ACCOUNT_MANAGER'],
    slaCode: 'SLA_KICKOFF', nextProcessFa: 'تبدیل بریف به پروژه',
    fields: [
      f.ref('briefId', 'بریف', 'Brief', 'brief', true),
      f.dt('scheduledAt', 'زمان جلسه', 'Scheduled at', true),
      f.multi('unitsInvited', 'واحدهای دعوت‌شده', 'Units invited', OPT.units, true),
      f.area('objectives', 'اهداف جلسه', 'Objectives', true),
      f.files(),
    ],
  },
  {
    no: 13, code: 'B13_KICKOFF_MINUTES', nameFa: 'صورتجلسه Kick-off', nameEn: 'Kick-off minutes', category: 'B',
    module: 'ACCOUNT_MANAGEMENT', senderDepts: ['A'], receiverDepts: ['ST', 'CR', 'ME', 'DM', 'OP'], approverRoles: ['ACCOUNT_MANAGER'],
    slaCode: 'SLA_MEETING_MINUTES', binding: 'meeting', nextProcessFa: 'تعریف پروژه',
    fields: [f.ref('briefId', 'بریف', 'Brief', 'brief', true), ...MEETING_FIELDS],
  },
  {
    no: 14, code: 'B14_PROJECT_DEFINITION', nameFa: 'فرم تعریف پروژه', nameEn: 'Project definition', category: 'B',
    module: 'PROJECT_PMO', senderDepts: ['A'], receiverDepts: ['OP'], approverRoles: ['ACCOUNT_MANAGER'],
    slaCode: 'SLA_PROJECT_CREATE', binding: 'project', nextProcessFa: 'تعیین Scope و Deliverable',
    fields: [
      f.ref('briefId', 'بریف', 'Brief', 'brief', true),
      f.text('name', 'نام پروژه', 'Project name', true),
      f.ref('companyId', 'مشتری', 'Customer', 'company', true),
      f.user('accountOwner', 'مالک اکانت', 'Account owner', true),
      f.area('objective', 'هدف پروژه', 'Objective', true),
      f.date('plannedStart', 'شروع برنامه‌ریزی‌شده', 'Planned start', true),
      f.date('plannedEnd', 'پایان برنامه‌ریزی‌شده', 'Planned end', true),
      f.money('plannedBudget', 'بودجه برنامه‌ریزی‌شده', 'Planned budget'),
      f.files(),
    ],
  },
  {
    no: 15, code: 'B15_SCOPE_DELIVERABLES', nameFa: 'فرم تعیین Scope و Deliverable', nameEn: 'Scope & deliverables definition', category: 'B',
    module: 'PROJECT_PMO', senderDepts: ['A'], receiverDepts: ['ST', 'CR', 'ME', 'DM'], approverRoles: ['ACCOUNT_MANAGER'],
    binding: 'scope', nextProcessFa: 'تعیین Timeline',
    fields: [
      f.ref('projectId', 'پروژه', 'Project', 'project', true),
      f.area('inScope', 'داخل Scope', 'In scope', true),
      f.area('outOfScope', 'خارج از Scope', 'Out of scope', true),
      f.table('deliverables', 'خروجی‌ها', 'Deliverables', [
        f.text('name', 'عنوان خروجی', 'Name', true),
        f.sel('unit', 'واحد مسئول', 'Owning unit', OPT.units, true),
        f.text('format', 'فرمت', 'Format'),
        f.date('due', 'مهلت', 'Due', true),
      ]),
      f.files(),
    ],
  },
  {
    no: 16, code: 'B16_INITIAL_TIMELINE', nameFa: 'فرم تعیین Timeline اولیه', nameEn: 'Initial timeline', category: 'B',
    module: 'PROJECT_PMO', senderDepts: ['A'], receiverDepts: ['OP', 'ST', 'CR', 'ME', 'DM'], approverRoles: ['ACCOUNT_MANAGER'],
    nextProcessFa: 'تعیین واحدهای درگیر',
    fields: [
      f.ref('projectId', 'پروژه', 'Project', 'project', true),
      f.table('milestones', 'نقاط عطف', 'Milestones', [
        f.text('name', 'عنوان', 'Name', true),
        f.date('due', 'تاریخ', 'Date', true),
      ]),
      f.files(),
    ],
  },
  {
    no: 17, code: 'B17_UNITS_INVOLVED', nameFa: 'فرم تعیین واحدهای درگیر', nameEn: 'Involved units', category: 'B',
    module: 'PROJECT_PMO', senderDepts: ['A'], receiverDepts: ['OP'], approverRoles: ['ACCOUNT_MANAGER'],
    nextProcessFa: 'تعیین RACI',
    fields: [
      f.ref('projectId', 'پروژه', 'Project', 'project', true),
      f.multi('units', 'واحدها', 'Units', OPT.units, true),
      f.area('rationale', 'دلیل انتخاب', 'Rationale'),
    ],
  },
  {
    no: 18, code: 'B18_RACI', nameFa: 'فرم تعیین مسئولیت‌ها / RACI', nameEn: 'RACI assignment', category: 'B',
    module: 'PROJECT_PMO', senderDepts: ['A'], receiverDepts: ['OP', 'ST', 'CR', 'ME', 'DM'], approverRoles: ['ACCOUNT_MANAGER'],
    binding: 'raci', nextProcessFa: 'صدور Project Order',
    fields: [
      f.ref('projectId', 'پروژه', 'Project', 'project', true),
      f.table('assignments', 'ماتریس RACI', 'RACI matrix', [
        f.text('activity', 'فعالیت', 'Activity', true),
        f.dept('responsible', 'R — مجری', 'Responsible', true),
        f.dept('accountable', 'A — پاسخگو', 'Accountable', true),
        f.dept('consulted', 'C — مشورت‌شونده', 'Consulted'),
        f.dept('informed', 'I — در جریان', 'Informed'),
      ]),
    ],
  },
  {
    no: 19, code: 'B19_PROJECT_ORDER', nameFa: 'فرم Project Order', nameEn: 'Project order', category: 'B',
    module: 'PROJECT_PMO', senderDepts: ['A'], receiverDepts: ['ST', 'CR', 'ME', 'DM'], approverRoles: ['ACCOUNT_MANAGER'],
    slaCode: 'SLA_TASK_DISPATCH', binding: 'workOrder', nextProcessFa: 'پذیرش Task توسط واحد',
    fields: [f.dept('targetUnit', 'واحد مقصد', 'Target unit', true), ...UNIT_ORDER_FIELDS],
  },

  /* ── C. فرم‌های سفارش به واحدهای اجرایی ────────────────────────────────── */
  ...(
    [
      [20, 'C20_ORDER_STRATEGY', 'فرم سفارش Strategy', 'Strategy order', 'ST', 'ACCOUNT_MANAGEMENT'],
      [21, 'C21_ORDER_CREATIVITY', 'فرم سفارش Creativity', 'Creativity order', 'CR', 'CREATIVE_PRODUCTION'],
      [22, 'C22_ORDER_GRAPHIC', 'فرم سفارش Graphic', 'Graphic order', 'CR', 'CREATIVE_PRODUCTION'],
      [23, 'C23_ORDER_PRODUCTION', 'فرم سفارش Production', 'Production order', 'CR', 'CREATIVE_PRODUCTION'],
      [24, 'C24_ORDER_MEDIA', 'فرم سفارش Media', 'Media order', 'ME', 'MEDIA_DIGITAL'],
      [25, 'C25_ORDER_DIGITAL', 'فرم سفارش Digital Marketing', 'Digital marketing order', 'DM', 'MEDIA_DIGITAL'],
      [26, 'C26_ORDER_OTHER', 'فرم سفارش سایر خدمات تخصصی', 'Other specialist services order', 'ST', 'ACCOUNT_MANAGEMENT'],
    ] as const
  ).map(([no, code, nameFa, nameEn, unit, module]): FormDef => ({
    no, code, nameFa, nameEn, category: 'C',
    module: module as FormDef['module'],
    senderDepts: ['A'], receiverDepts: [unit as FormDef['receiverDepts'][number]],
    approverRoles: ['UNIT_MANAGER'], slaCode: 'SLA_TASK_ACCEPTANCE',
    binding: 'workOrder', nextProcessFa: 'پذیرش Task و برنامه‌ریزی داخلی واحد',
    fields: UNIT_ORDER_FIELDS,
  })),

  /* ── D. فرم‌های اجرای داخلی واحدها ─────────────────────────────────────── */
  {
    no: 27, code: 'D27_TASK_ACCEPTANCE', nameFa: 'فرم پذیرش Task', nameEn: 'Task acceptance', category: 'D',
    module: 'TRAFFIC_TASK', senderDepts: ['ST', 'CR', 'ME', 'DM'], receiverDepts: ['A'], approverRoles: ['UNIT_MANAGER'],
    slaCode: 'SLA_TASK_ACCEPTANCE', binding: 'taskAcceptance', nextProcessFa: 'برنامه‌ریزی داخلی واحد',
    fields: [
      f.ref('workOrderId', 'سفارش کار', 'Work order', 'workOrder', true),
      f.sel('decision', 'تصمیم', 'Decision', [
        { value: 'ACCEPT', labelFa: 'پذیرش' },
        { value: 'CLARIFY', labelFa: 'نیاز به رفع ابهام' },
      ], true),
      f.user('assignee', 'مسئول اجرا', 'Assignee', true),
      f.date('committedDate', 'تاریخ تعهدشده', 'Committed date', true),
      f.area('notes', 'توضیحات', 'Notes'),
    ],
  },
  {
    no: 28, code: 'D28_CLARIFICATION', nameFa: 'فرم اعلام ابهام / سؤال', nameEn: 'Clarification request', category: 'D',
    module: 'TRAFFIC_TASK', senderDepts: ['ST', 'CR', 'ME', 'DM'], receiverDepts: ['A'], approverRoles: ['ACCOUNT_MANAGER'],
    slaCode: 'SLA_CLARIFICATION', nextProcessFa: 'رفع ابهام توسط اکانت',
    fields: [
      f.ref('workOrderId', 'سفارش کار', 'Work order', 'workOrder', true),
      f.area('question', 'ابهام / سؤال', 'Question', true),
      f.sel('blocking', 'مسدودکننده اجرا؟', 'Blocking?', OPT.yesNo, true),
      f.files(),
    ],
  },
  {
    no: 29, code: 'D29_RESOURCE_NEED', nameFa: 'فرم اعلام نیاز منابع', nameEn: 'Resource need declaration', category: 'D',
    module: 'TRAFFIC_TASK', senderDepts: ['ST', 'CR', 'ME', 'DM'], receiverDepts: ['OP'], approverRoles: ['UNIT_MANAGER'],
    slaCode: 'SLA_RESOURCE_REQUEST', nextProcessFa: 'تخصیص منابع یا درخواست تأمین خارجی',
    fields: [
      f.ref('projectId', 'پروژه', 'Project', 'project', true),
      f.area('needDescription', 'شرح نیاز', 'Need description', true),
      f.num('personDays', 'نفر-روز مورد نیاز', 'Person-days needed'),
      f.date('neededBy', 'مورد نیاز تا تاریخ', 'Needed by', true),
      f.sel('priority', 'اولویت', 'Priority', OPT.priority),
    ],
  },
  ...(
    [
      [30, 'D30_FREELANCER_REQUEST', 'فرم درخواست Freelancer', 'Freelancer request', 'FREELANCER'],
      [31, 'D31_OUTSOURCE_REQUEST', 'فرم درخواست Outsource', 'Outsource request', 'OUTSOURCE'],
      [32, 'D32_SUPPLIER_REQUEST', 'فرم درخواست تأمین‌کننده / شریک تجاری', 'Supplier / partner request', 'SUPPLIER'],
    ] as const
  ).map(([no, code, nameFa, nameEn, kind]): FormDef => ({
    no, code, nameFa, nameEn, category: 'D', module: 'TRAFFIC_TASK',
    senderDepts: ['ST', 'CR', 'ME', 'DM'], receiverDepts: ['OP', 'FI', 'M'],
    approverRoles: ['UNIT_MANAGER', 'DEPUTY'], slaCode: 'SLA_RESOURCE_REQUEST',
    binding: 'outsourceRequest', nextProcessFa: 'تأیید مدیر واحد و مدیریت',
    routing: [
      {
        id: 'outsource.costly', whenFa: 'هزینهٔ تخمینی بیش از ۵۰۰٬۰۰۰٬۰۰۰ ریال باشد',
        when: { field: 'estimatedCost', op: 'gt', value: 500_000_000 },
        addApprovers: ['CEO'], notifyRoles: ['FINANCE_MANAGER'], source: 'DEFAULT',
      },
    ],
    fields: [
      f.ref('projectId', 'پروژه', 'Project', 'project', true),
      { key: 'kind', labelFa: 'نوع تأمین', labelEn: 'Supply type', type: 'select', required: true, options: OPT.supplierKind },
      f.text('supplierName', 'نام تأمین‌کننده پیشنهادی', 'Proposed supplier', true),
      f.area('scopeOfWork', 'شرح کار', 'Scope of work', true),
      f.money('estimatedCost', 'هزینه تخمینی', 'Estimated cost', true),
      f.date('neededBy', 'مورد نیاز تا', 'Needed by', true),
      f.area('justification', 'دلیل استفاده از منبع خارجی', 'Justification', true),
      f.files(),
    ],
  })),
  {
    no: 33, code: 'D33_SUPPLIER_EVALUATION', nameFa: 'فرم ارزیابی Freelancer / Supplier', nameEn: 'Freelancer / supplier evaluation', category: 'D',
    module: 'TRAFFIC_TASK', senderDepts: ['ST', 'CR', 'ME', 'DM'], receiverDepts: ['OP'], approverRoles: ['UNIT_MANAGER'],
    binding: 'supplierEvaluation', nextProcessFa: 'به‌روزرسانی دیتابیس تأمین‌کنندگان',
    fields: [
      f.ref('supplierId', 'تأمین‌کننده', 'Supplier', 'supplier', true),
      f.ref('projectId', 'پروژه', 'Project', 'project'),
      f.sel('quality', 'کیفیت خروجی', 'Output quality', OPT.rating, true),
      f.sel('timeliness', 'رعایت زمان‌بندی', 'Timeliness', OPT.rating, true),
      f.sel('communication', 'کیفیت ارتباط', 'Communication', OPT.rating, true),
      f.sel('costValue', 'ارزش در برابر هزینه', 'Cost/value', OPT.rating, true),
      f.sel('wouldReuse', 'همکاری مجدد', 'Would reuse', OPT.yesNo, true),
      f.area('comments', 'توضیحات', 'Comments'),
    ],
  },
  {
    no: 34, code: 'D34_UNIT_OUTPUT_DELIVERY', nameFa: 'فرم تحویل خروجی واحد', nameEn: 'Unit output delivery', category: 'D',
    module: 'TRAFFIC_TASK', senderDepts: ['ST', 'CR', 'ME', 'DM'], receiverDepts: ['A'], approverRoles: ['UNIT_MANAGER'],
    binding: 'deliverableSubmission', nextProcessFa: 'QC اکانت',
    fields: [
      f.ref('workOrderId', 'سفارش کار', 'Work order', 'workOrder', true),
      f.ref('deliverableId', 'خروجی', 'Deliverable', 'deliverable'),
      f.text('version', 'نسخه', 'Version', true),
      f.area('summary', 'شرح خروجی', 'Output summary', true),
      f.check('unitQcDone', 'QC داخلی واحد انجام شده است', 'Unit QC completed'),
      f.check('brandCompliant', 'مطابق هویت بصری هیوا', 'Complies with Hiva brand identity'),
      f.files('files', 'فایل‌های خروجی', 'Output files'),
    ],
  },
  {
    no: 35, code: 'D35_COST_DECLARATION', nameFa: 'فرم اعلام قیمت تمام‌شده', nameEn: 'Cost declaration', category: 'D',
    module: 'FINANCE', senderDepts: ['ST', 'CR', 'ME', 'DM'], receiverDepts: ['A', 'FI'], approverRoles: ['UNIT_MANAGER'],
    binding: 'costDeclaration', nextProcessFa: 'فرآیند Pricing',
    fields: [
      f.ref('workOrderId', 'سفارش کار', 'Work order', 'workOrder', true),
      f.table('costItems', 'اقلام هزینه', 'Cost items', [
        f.text('description', 'شرح', 'Description', true),
        f.num('quantity', 'تعداد', 'Qty', true),
        f.money('unitCost', 'هزینه واحد', 'Unit cost', true),
      ]),
      f.money('internalCost', 'هزینه داخلی', 'Internal cost', true),
      f.money('externalCost', 'هزینه خارجی', 'External cost'),
      f.area('assumptions', 'مفروضات', 'Assumptions'),
      f.files(),
    ],
  },
  {
    no: 36, code: 'D36_RISK_DELAY_NOTICE', nameFa: 'فرم اعلام ریسک / تأخیر', nameEn: 'Risk / delay notification', category: 'D',
    module: 'PROJECT_PMO', senderDepts: ['ST', 'CR', 'ME', 'DM'], receiverDepts: ['A', 'OP'], approverRoles: ['ACCOUNT_MANAGER'],
    binding: 'risk', nextProcessFa: 'به‌روزرسانی Timeline و Escalation',
    fields: [
      f.ref('projectId', 'پروژه', 'Project', 'project', true),
      f.ref('taskId', 'وظیفه', 'Task', 'task'),
      f.sel('kind', 'نوع اعلام', 'Type', [
        { value: 'RISK', labelFa: 'ریسک' }, { value: 'DELAY', labelFa: 'تأخیر' },
      ], true),
      f.area('description', 'شرح', 'Description', true),
      f.sel('severity', 'شدت', 'Severity', OPT.severity, true),
      f.date('expectedImpactDate', 'تاریخ اثرگذاری', 'Expected impact date'),
      f.area('mitigation', 'اقدام پیشنهادی', 'Proposed mitigation'),
    ],
  },

  /* ── E. فرم‌های کنترل کیفیت (Doc_H §9 — سه سطح) ────────────────────────── */
  {
    no: 37, code: 'E37_QC_UNIT', nameFa: 'فرم QC اولیه واحد اجرایی', nameEn: 'Unit-level QC (level 1)', category: 'E',
    module: 'QUALITY_CONTROL', senderDepts: ['ST', 'CR', 'ME', 'DM'], receiverDepts: ['A'], approverRoles: ['UNIT_MANAGER'],
    slaCode: 'SLA_UNIT_QC', binding: 'qcReview', nextProcessFa: 'تحویل به اکانت',
    fields: [
      f.ref('deliverableId', 'خروجی', 'Deliverable', 'deliverable', true),
      f.check('matchesBrief', 'مطابق بریف است', 'Matches brief'),
      f.check('technicallySound', 'از نظر فنی صحیح است', 'Technically sound'),
      f.check('brandCompliant', 'مطابق هویت بصری', 'Brand compliant'),
      f.check('completeDeliverable', 'کامل است', 'Complete'),
      f.sel('verdict', 'نتیجه', 'Verdict', OPT.qcVerdict, true),
      f.area('findings', 'یافته‌ها', 'Findings'),
      f.files(),
    ],
  },
  {
    no: 38, code: 'E38_QC_ACCOUNT', nameFa: 'فرم QC اکانت', nameEn: 'Account QC (level 2)', category: 'E',
    module: 'QUALITY_CONTROL', senderDepts: ['A'], receiverDepts: ['ST', 'CR', 'ME', 'DM'], approverRoles: ['ACCOUNT_MANAGER'],
    slaCode: 'SLA_ACCOUNT_QC', binding: 'qcReview', nextProcessFa: 'یکپارچه‌سازی یا صدور اصلاحیه',
    fields: [
      f.ref('deliverableId', 'خروجی', 'Deliverable', 'deliverable', true),
      f.check('matchesBrief', 'تطابق با Brief', 'Matches brief'),
      f.check('matchesScope', 'تطابق با Scope', 'Matches scope'),
      f.check('matchesKickoff', 'تطابق با تصمیمات Kick-off', 'Matches kick-off decisions'),
      f.check('deliverablesComplete', 'کامل بودن Deliverableها', 'Deliverables complete'),
      f.check('costReviewed', 'قیمت تمام‌شده بررسی شد', 'Cost reviewed'),
      f.sel('verdict', 'نتیجه', 'Verdict', OPT.qcVerdict, true),
      f.area('findings', 'یافته‌ها', 'Findings'),
      f.files(),
    ],
  },
  {
    no: 39, code: 'E39_QC_FINAL', nameFa: 'فرم Final QC', nameEn: 'Final QC (level 3)', category: 'E',
    module: 'QUALITY_CONTROL', senderDepts: ['A'], receiverDepts: ['M', 'S'], approverRoles: ['ACCOUNT_MANAGER', 'DEPUTY', 'CEO'],
    slaCode: 'SLA_FINAL_QC', binding: 'qcReview', nextProcessFa: 'تحویل Proposal به فروش',
    fields: [
      f.ref('proposalId', 'پروپوزال', 'Proposal', 'proposal', true),
      f.check('proposalComplete', 'پروپوزال کامل است', 'Proposal complete'),
      f.check('pricingReviewed', 'قیمت بررسی شد', 'Pricing reviewed'),
      f.check('qualityAcceptable', 'کیفیت قابل قبول است', 'Quality acceptable'),
      f.check('clientReady', 'قابل ارائه به مشتری است', 'Client-ready'),
      f.sel('verdict', 'نتیجه', 'Verdict', OPT.qcVerdict, true),
      f.area('findings', 'یافته‌ها', 'Findings'),
      f.files(),
    ],
  },
  {
    no: 40, code: 'E40_PROPOSAL_APPROVAL', nameFa: 'فرم تأیید Proposal', nameEn: 'Proposal approval', category: 'E',
    module: 'QUALITY_CONTROL', senderDepts: ['A'], receiverDepts: ['S'], approverRoles: ['ACCOUNT_MANAGER', 'DEPUTY'],
    nextProcessFa: 'ارائه به مشتری',
    fields: [
      f.ref('proposalId', 'پروپوزال', 'Proposal', 'proposal', true),
      f.check('approved', 'تأیید نهایی', 'Final approval'),
      f.area('conditions', 'شروط تأیید', 'Approval conditions'),
    ],
  },
  {
    no: 41, code: 'E41_OUTPUT_REJECTION', nameFa: 'فرم عدم تأیید خروجی', nameEn: 'Output rejection', category: 'E',
    module: 'QUALITY_CONTROL', senderDepts: ['A'], receiverDepts: ['ST', 'CR', 'ME', 'DM'], approverRoles: ['ACCOUNT_MANAGER'],
    nextProcessFa: 'صدور فرم اصلاحیه',
    fields: [
      f.ref('deliverableId', 'خروجی', 'Deliverable', 'deliverable', true),
      f.sel('reason', 'علت عدم تأیید', 'Rejection reason', OPT.revisionReason, true),
      f.area('details', 'شرح دقیق', 'Details', true),
      f.files(),
    ],
  },
  {
    no: 42, code: 'E42_REVISION', nameFa: 'فرم Revision / اصلاحیه', nameEn: 'Revision form', category: 'E',
    module: 'QUALITY_CONTROL', senderDepts: ['A'], receiverDepts: ['ST', 'CR', 'ME', 'DM'], approverRoles: ['ACCOUNT_MANAGER'],
    slaCode: 'SLA_REVISION', binding: 'revision', nextProcessFa: 'اصلاح توسط واحد و QC مجدد',
    fields: [
      f.ref('deliverableId', 'خروجی', 'Deliverable', 'deliverable', true),
      f.sel('reason', 'علت اصلاح', 'Revision reason', OPT.revisionReason, true),
      f.area('requiredCorrection', 'اصلاح مورد انتظار', 'Required correction', true),
      f.dept('responsibleUnit', 'واحد مسئول', 'Responsible unit', true),
      f.date('dueDate', 'مهلت اصلاح', 'Due date', true),
      f.files(),
    ],
  },
  {
    no: 43, code: 'E43_REVISION_APPROVAL', nameFa: 'فرم تأیید اصلاحات', nameEn: 'Revision approval', category: 'E',
    module: 'QUALITY_CONTROL', senderDepts: ['A'], receiverDepts: ['ST', 'CR', 'ME', 'DM'], approverRoles: ['ACCOUNT_MANAGER'],
    nextProcessFa: 'یکپارچه‌سازی',
    fields: [
      f.ref('revisionId', 'اصلاحیه', 'Revision', 'revision', true),
      f.sel('verdict', 'نتیجه', 'Verdict', OPT.qcVerdict, true),
      f.area('comments', 'توضیحات', 'Comments'),
    ],
  },
  {
    no: 44, code: 'E44_VERSION_CONTROL', nameFa: 'فرم کنترل نسخه فایل / Version Control', nameEn: 'File version control', category: 'E',
    module: 'QUALITY_CONTROL', senderDepts: ['ST', 'CR', 'ME', 'DM', 'A'], receiverDepts: ['A'], approverRoles: ['ACCOUNT_MANAGER'],
    nextProcessFa: 'ثبت در مخزن اسناد پروژه',
    fields: [
      f.ref('projectId', 'پروژه', 'Project', 'project', true),
      f.text('fileName', 'نام فایل', 'File name', true),
      f.text('version', 'نسخه', 'Version', true),
      f.area('changeLog', 'شرح تغییرات', 'Change log', true),
      f.files(),
    ],
  },

  /* ── F. فرم‌های Proposal و Pricing ─────────────────────────────────────── */
  {
    no: 45, code: 'F45_PROPOSAL_STRUCTURE', nameFa: 'فرم ساختار Proposal', nameEn: 'Proposal structure', category: 'F',
    module: 'ACCOUNT_MANAGEMENT', senderDepts: ['A'], receiverDepts: ['A'], approverRoles: ['ACCOUNT_MANAGER'],
    slaCode: 'SLA_INTEGRATION', binding: 'proposal', nextProcessFa: 'قیمت‌گذاری',
    fields: [
      f.ref('briefId', 'بریف', 'Brief', 'brief', true),
      f.text('title', 'عنوان پروپوزال', 'Proposal title', true),
      f.area('executiveSummary', 'خلاصه مدیریتی', 'Executive summary', true),
      f.area('approach', 'رویکرد', 'Approach', true),
      f.area('deliverablesSummary', 'خروجی‌ها', 'Deliverables', true),
      f.area('timeline', 'زمان‌بندی', 'Timeline', true),
      f.files(),
    ],
  },
  {
    no: 46, code: 'F46_COST_SHEET', nameFa: 'فرم قیمت تمام‌شده', nameEn: 'Cost sheet', category: 'F',
    module: 'FINANCE', senderDepts: ['ST', 'CR', 'ME', 'DM'], receiverDepts: ['A', 'FI'], approverRoles: ['UNIT_MANAGER', 'FINANCE_MANAGER'],
    binding: 'costDeclaration', nextProcessFa: 'تعیین قیمت فروش',
    fields: [
      f.ref('proposalId', 'پروپوزال', 'Proposal', 'proposal', true),
      f.table('lines', 'ردیف‌های هزینه', 'Cost lines', [
        f.dept('unit', 'واحد', 'Unit', true),
        f.text('item', 'شرح', 'Item', true),
        f.money('cost', 'هزینه', 'Cost', true),
      ]),
      f.money('totalCost', 'جمع هزینه تمام‌شده', 'Total cost', true),
    ],
  },
  {
    no: 47, code: 'F47_PRICING', nameFa: 'فرم قیمت‌گذاری', nameEn: 'Pricing', category: 'F',
    module: 'FINANCE', senderDepts: ['A', 'FI'], receiverDepts: ['M'], approverRoles: ['DEPUTY', 'CEO'],
    slaCode: 'SLA_PRICING', binding: 'pricing', nextProcessFa: 'QC نهایی',
    routing: [
      {
        id: 'pricing.below-cost', whenFa: 'قیمت فروش کمتر از قیمت تمام‌شده باشد',
        when: { field: 'salePrice', op: 'ltField', value: 'totalCost' },
        addApprovers: ['CEO'], source: 'DOC_H', docRef: 'قوانین §قیمت‌گذاری — قیمت فروش نهایی صرفاً پس از تأیید فرآیند Pricing',
      },
      {
        id: 'pricing.thin-margin', whenFa: 'درصد Margin کمتر از ۲۰ باشد',
        when: { field: 'marginPercent', op: 'lt', value: 20 },
        addApprovers: ['CEO'], source: 'DEFAULT',
      },
    ],
    fields: [
      f.ref('proposalId', 'پروپوزال', 'Proposal', 'proposal', true),
      f.money('totalCost', 'قیمت تمام‌شده', 'Total cost', true),
      f.money('salePrice', 'قیمت فروش', 'Sale price', true),
      f.pct('marginPercent', 'درصد Margin', 'Margin %', true),
      f.area('rationale', 'مبنای قیمت‌گذاری', 'Pricing rationale', true),
    ],
  },
  {
    no: 48, code: 'F48_PRICING_MARGIN', nameFa: 'فرم Pricing & Margin', nameEn: 'Pricing & margin review', category: 'F',
    module: 'FINANCE', senderDepts: ['A', 'FI'], receiverDepts: ['M'], approverRoles: ['DEPUTY', 'CEO'],
    slaCode: 'SLA_PRICING', nextProcessFa: 'تأیید مدیریت',
    routing: [
      {
        id: 'margin.below-target', whenFa: 'Margin محاسبه‌شده کمتر از Margin هدف باشد',
        when: { field: 'actualMargin', op: 'ltField', value: 'targetMargin' },
        notifyRoles: ['FINANCE_MANAGER'], source: 'DEFAULT',
      },
      {
        id: 'margin.far-below-target', whenFa: 'Margin محاسبه‌شده کمتر از ۱۵ باشد',
        when: { field: 'actualMargin', op: 'lt', value: 15 },
        addApprovers: ['CEO'], source: 'DEFAULT',
      },
    ],
    fields: [
      f.ref('proposalId', 'پروپوزال', 'Proposal', 'proposal', true),
      f.pct('targetMargin', 'Margin هدف', 'Target margin', true),
      f.pct('actualMargin', 'Margin محاسبه‌شده', 'Calculated margin', true),
      f.area('deviationJustification', 'دلیل انحراف', 'Deviation justification'),
    ],
  },
  {
    no: 49, code: 'F49_PAYMENT_TERMS', nameFa: 'فرم شرایط پرداخت', nameEn: 'Payment terms', category: 'F',
    module: 'FINANCE', senderDepts: ['A', 'FI'], receiverDepts: ['LG', 'S'], approverRoles: ['FINANCE_MANAGER', 'DEPUTY'],
    nextProcessFa: 'تنظیم قرارداد',
    routing: [
      {
        id: 'terms.long-credit', whenFa: 'مهلت پرداخت بیش از ۶۰ روز باشد',
        when: { field: 'creditDays', op: 'gt', value: 60 },
        addApprovers: ['CEO'], source: 'DEFAULT',
      },
    ],
    fields: [
      f.ref('proposalId', 'پروپوزال', 'Proposal', 'proposal', true),
      f.table('milestones', 'مراحل پرداخت', 'Payment milestones', [
        f.text('label', 'عنوان', 'Label', true),
        f.pct('percent', 'درصد', 'Percent', true),
        f.text('trigger', 'شرط پرداخت', 'Trigger', true),
      ]),
      f.num('creditDays', 'مهلت پرداخت (روز)', 'Credit days'),
    ],
  },
  {
    no: 50, code: 'F50_CONTRACT_SCALE', nameFa: 'فرم اشل قرارداد', nameEn: 'Contract scale', category: 'F',
    module: 'CONTRACT_LEGAL', senderDepts: ['A', 'FI'], receiverDepts: ['LG'], approverRoles: ['DEPUTY', 'CEO'],
    nextProcessFa: 'درخواست انعقاد قرارداد',
    routing: [
      {
        id: 'contract.large-value', whenFa: 'مبلغ قرارداد بیش از ۵٬۰۰۰٬۰۰۰٬۰۰۰ ریال باشد',
        when: { field: 'contractValue', op: 'gt', value: 5_000_000_000 },
        addApprovers: ['LEGAL_MANAGER', 'CEO'], source: 'DEFAULT',
      },
      {
        id: 'contract.large-band', whenFa: 'اشل قرارداد بزرگ یا ویژه باشد',
        when: { field: 'scaleBand', op: 'in', value: ['L', 'XL'] },
        addApprovers: ['LEGAL_MANAGER'], source: 'DEFAULT',
      },
    ],
    fields: [
      f.ref('proposalId', 'پروپوزال', 'Proposal', 'proposal', true),
      f.money('contractValue', 'مبلغ قرارداد', 'Contract value', true),
      f.sel('scaleBand', 'اشل', 'Scale band', [
        { value: 'S', labelFa: 'کوچک' }, { value: 'M', labelFa: 'متوسط' },
        { value: 'L', labelFa: 'بزرگ' }, { value: 'XL', labelFa: 'ویژه' },
      ], true),
      f.area('notes', 'توضیحات', 'Notes'),
    ],
  },
  {
    no: 51, code: 'F51_PROPOSAL_FINAL_APPROVAL', nameFa: 'فرم تأیید نهایی Proposal', nameEn: 'Final proposal approval', category: 'F',
    module: 'QUALITY_CONTROL', senderDepts: ['A'], receiverDepts: ['M'], approverRoles: ['DEPUTY', 'CEO'],
    slaCode: 'SLA_FINAL_QC', nextProcessFa: 'تحویل به فروش',
    fields: [
      f.ref('proposalId', 'پروپوزال', 'Proposal', 'proposal', true),
      f.check('approved', 'تأیید نهایی مدیریت', 'Management final approval'),
      f.area('conditions', 'شروط', 'Conditions'),
    ],
  },
  {
    no: 52, code: 'F52_PROPOSAL_TO_SALES', nameFa: 'فرم تحویل Proposal به Sales', nameEn: 'Proposal handover to Sales', category: 'F',
    module: 'ACCOUNT_MANAGEMENT', senderDepts: ['A'], receiverDepts: ['S'], approverRoles: ['ACCOUNT_MANAGER'],
    slaCode: 'SLA_PROPOSAL_HANDOVER', nextProcessFa: 'ارائه به مشتری',
    fields: [
      f.ref('proposalId', 'پروپوزال', 'Proposal', 'proposal', true),
      f.user('salesOwner', 'مسئول فروش', 'Sales owner', true),
      f.area('talkingPoints', 'نکات ارائه', 'Talking points'),
      f.money('floorPrice', 'کف قیمت مجاز', 'Floor price'),
      f.files(),
    ],
  },
];
