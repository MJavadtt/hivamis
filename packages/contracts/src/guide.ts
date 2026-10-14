import type { Permission } from './permissions.js';

/**
 * The guide (Hivamis task 8): what each part of the application is for and how to do the usual
 * things there, in both languages, one section per page. The owl reads a section out as a tour —
 * each step points at the element it talks about (`target`, a CSS selector over the `data-tour`
 * anchors the shared components carry) — and answers "how do I…" from these words, on the page and
 * through the assistant. The full written guide (docs/user-guide.md) stays the long form; `manual`
 * names the heading there to read on.
 *
 * Each entry carries its own English, so the catalogue extractor skips this file.
 */

export interface GuideText { fa: string; en: string }
export interface GuideStep { title: GuideText; body: GuideText; target?: string }
export interface GuideSection {
  id: string;
  /** The pages it covers: a regular expression over the path. */
  route: string;
  /** A page to open for it, when the route is a list rather than one record. */
  path?: string;
  title: GuideText;
  summary: GuideText;
  steps: GuideStep[];
  /** Shown to those who can open the page; omitted for pages everyone has. */
  permission?: Permission;
  anyOf?: Permission[];
  /** The heading of docs/user-guide.md that says more. */
  manual?: string;
  /** Other words people use for it, for the search. */
  keywords?: string;
}

const t = (fa: string, en: string): GuideText => ({ fa, en });
const step = (target: string | undefined, title: GuideText, body: GuideText): GuideStep => ({ title, body, ...(target ? { target } : {}) });

const NAV = (path: string) => `[data-tour="sidebar"] a[href="${path}"]`;
const ANY = {
  header: '[data-tour="page-header"]',
  actions: '[data-tour="page-actions"]',
  search: '[data-tour="list-search"]',
  filter: '[data-tour="list-filter"]',
  listActions: '[data-tour="list-actions"]',
  table: '[data-tour="list-table"]',
  tabs: 'main [data-tour="tabs"]',
  workflow: '[data-tour="workflow"]',
  forms: '[data-tour="related-forms"]',
  history: '[data-tour="history"]',
};

/** A list page's usual three steps, worded for the kind of record. */
function listSteps(record: GuideText, open: GuideText): GuideStep[] {
  return [
    step(ANY.search, t('جستجو', 'Search'), t(`نام یا کد ${record.fa} را بنویسید و Enter بزنید.`, `Type the ${record.en}'s name or code and press Enter.`)),
    step(ANY.filter, t('فیلترها', 'Filters'), t('فهرست را با وضعیت و فیلترهای دیگر کوتاه کنید؛ «همه» فیلتر را برمی‌دارد.', 'Narrow the list by state and the other filters; “All” removes a filter.')),
    step(ANY.table, t('باز کردن', 'Open one'), open),
  ];
}

const RELATED = step(ANY.forms, t('فرم‌های مرتبط', 'Related forms'), t(
  'فرم‌هایی که واحد شما برای این پرونده می‌فرستد، با یک کلیک و از پیش پرشده. آن‌هایی که مرحلهٔ فعلی می‌خواهد، پررنگ‌ترند؛ ✓ یعنی برای همین پرونده فرستاده شده.',
  'The forms your unit sends for this record, one click away and already filled in. Those its current stage calls for stand out; ✓ means one was already sent for this record.',
));
const WORKFLOW = step(ANY.workflow, t('گام بعدی', 'The next step'), t(
  'کارهایی که در این مرحله مجاز است. اگر قانونی جلوی کاری را گرفته، دلیلش همان‌جا گفته می‌شود — پیش از کلیک، نه بعد از آن.',
  'The moves allowed at this stage. If a rule holds one back, the reason is shown right there — before you click, not after.',
));
const HISTORY = step(ANY.history, t('تاریخچه', 'History'), t('هر تغییر وضعیت، از چه به چه، به دست چه کسی و کِی.', 'Every change of state: from what to what, by whom and when.'));

export const GUIDE: GuideSection[] = [
  {
    id: 'dashboard', route: '^/$', path: '/', manual: 'The dashboard — «داشبورد»',
    title: t('داشبورد', 'Dashboard'),
    summary: t('نگاهی یک‌جا به آنچه با شماست: وظایف، تأییدها، مهلت‌ها و پروژه‌ها. هر کاشی فهرست پشت خودش را باز می‌کند.',
      'Everything that is yours at a glance: tasks, approvals, deadlines and projects. Each tile opens the list behind it.'),
    keywords: 'خانه صفحه اول کاشی home start tiles overview',
    steps: [
      step('[data-tour="tiles"]', t('چهار کاشی', 'Four tiles'), t('وظایف باز، وظایف تاخیردار، فرم‌های در انتظار تأیید شما و روندهای نقض‌شده یا در خطر. روی هر کاشی بزنید تا فهرستش باز شود.',
        'Open tasks, overdue tasks, forms waiting for your approval, and deadlines broken or about to be. Click a tile to open its list.')),
      step('[data-tour="my-tasks"]', t('وظایف من', 'My tasks'), t('وظایف شما، نزدیک‌ترین مهلت بالاتر. اصلاحیه‌هایی که به شما یا واحدتان رسیده کنارش است.',
        'Your tasks, nearest deadline first, with the revisions assigned to you or your unit beside them.')),
      step('[data-tour="my-slas"]', t('روندهای من', 'My deadlines'), t('ساعت‌های مهلتی که به نام شماست و اینکه از هر کدام چقدر مانده.', 'The deadline clocks you own, and how much of each is left.')),
      step('[data-tour="my-projects"]', t('پروژه‌های من', 'My projects'), t('«در حال اجرا» پروژه‌هایی است که در آن‌ها کار می‌کنید؛ «فروش» فرصت‌هایی که هنوز برده یا باخته نشده‌اند.',
        '“In progress” lists the projects you work on; “Sales” the opportunities not yet won or lost.')),
      step('[data-tour="search"]', t('رفتن به هر پرونده', 'Go to any record'), t('نام یا کد پروژه، مشتری، وظیفه یا قرارداد را بنویسید. Ctrl+K هم جستجو را باز می‌کند.',
        'Type the name or code of a project, client, task or contract. Ctrl+K opens the search too.')),
    ],
  },
  {
    id: 'my-work', route: '^/my-work', path: '/my-work', manual: 'Your queue — «کارهای من»',
    title: t('کارهای من', 'My work'),
    summary: t('هر چه با شماست در یک صف: وظایف، سفارش‌های کار، QC، فرم‌های در انتظار تأیید، اصلاحیه‌ها و رفع ابهام‌ها — به ترتیب نزدیکی مهلت.',
      'Everything with you in one queue: tasks, work orders, QC, forms awaiting approval, revisions and clarifications, nearest deadline first.'),
    keywords: 'صف کارتابل inbox queue todo',
    steps: [
      step('[data-tour="tiles"]', t('وضعیت صف', 'Your queue at a glance'), t('چند کار در صف دارید، مهلت چندتا گذشته و چندتا در خطر است.', 'How much is in your queue, how many deadlines have passed and how many are at risk.')),
      step('[data-tour="work-kinds"]', t('یک نوع کار', 'One kind of work'), t('با این دکمه‌ها فقط یک نوع را ببینید؛ دوباره بزنید تا همه برگردد.', 'Show one kind of work only; click again to see everything.')),
      step('[data-tour="work-list"]', t('کار، همین‌جا', 'Act from the list'), t('هر ردیف دکمه‌های خودش را دارد: پذیرش، ارسال، فرستادن به QC، تأیید. «احتمال نقض ٪…» یعنی این مهلت دارد از دست می‌رود.',
        'Each row carries its own actions: accept, submit, send to QC, approve. “…% chance of breach” means that deadline is heading for a breach.')),
      step('[data-tour="notifications"]', t('اعلان‌ها', 'Notifications'), t('نقطهٔ سبز روی زنگ یعنی صفحه زنده است: آنچه دیگران جابه‌جا کنند، چند ثانیه بعد همین‌جا دیده می‌شود.',
        'A green dot on the bell means the page is live: what others move appears here within seconds.')),
    ],
  },
  {
    id: 'tasks', route: '^/tasks/?$', path: '/tasks', permission: 'task.read', manual: 'Execution units (Strategy, Creative, Media, Digital)',
    title: t('وظایف', 'Tasks'),
    summary: t('همهٔ وظایفی که می‌توانید ببینید، با وضعیت، مسئول و مهلت. هر وظیفه به یک سند مرجع وصل است.',
      'Every task you may see, with its state, owner and due date. Each one is tied to the document it came from.'),
    keywords: 'تسک کار task todo',
    steps: listSteps(t('وظیفه', 'task'), t('روی هر ردیف بزنید تا صفحهٔ وظیفه باز شود: پذیرش، شروع، ارسال و ثبت زمان.', 'Click a row to open the task: accept, start, submit and log time.')),
  },
  {
    id: 'task', route: '^/tasks/[^/]+', permission: 'task.read', manual: 'Execution units (Strategy, Creative, Media, Digital)',
    title: t('صفحهٔ وظیفه', 'A task'),
    summary: t('پذیرش، شروع و ارسال وظیفه؛ ثبت ساعت کار؛ و اگر به مهلت نمی‌رسید، اعلام مانع پیش از رسیدن مهلت.',
      'Accept, start and submit the task, log your hours, and if you will miss the deadline, report the blocker before it comes.'),
    keywords: 'ثبت زمان ساعت مانع تاخیر log time hours blocker',
    steps: [
      step(ANY.header, t('وظیفه', 'The task'), t('عنوان، وضعیت و مرحلهٔ وظیفه. منبعش — بریف، سفارش، صورتجلسه یا اصلاحیه — در صفحه آمده است.', 'Its title, state and stage. Where it came from — a brief, an order, minutes or a revision — is on the page.')),
      WORKFLOW,
      step(undefined, t('ثبت زمان', 'Logging time'), t('با «ثبت زمان» ساعت، روز و یادداشت را وارد کنید، یا هنگام ارسال یک‌جا بنویسید. برآورد و واقعی کنار هم دیده می‌شوند.',
        'Use “Record time” to enter hours, a day and a note, or type them once when you submit. The estimate and the actual sit side by side.')),
      RELATED,
      HISTORY,
    ],
  },
  {
    id: 'forms', route: '^/forms', path: '/forms', permission: 'form.read', manual: 'Forms',
    title: t('فرم‌ها', 'Forms'),
    summary: t('فرم‌های Doc_H، صندوق تأیید شما و فرم‌هایی که فرستاده‌اید. فقط فرم‌های واحد خودتان را می‌فرستید؛ بقیه دیده می‌شوند تا شکل فرآیند پیدا باشد.',
      'The Doc_H forms, your approval inbox and the forms you sent. You send only your own unit\'s forms; the rest are visible so the process is clear.'),
    keywords: 'فرم تأیید درخواست کاتالوگ form approve approval inbox catalogue',
    steps: [
      step(ANY.tabs, t('سه بخش', 'Three parts'), t('«کاتالوگ فرم‌ها» همهٔ فرم‌ها، «در انتظار تأیید من» صندوق تأیید شما، و «فرم‌های من» آنچه فرستاده‌اید.',
        '“Forms catalogue” has every form, “Awaiting my approval” is your approval inbox, and “My forms” what you have sent.')),
      step(undefined, t('مسیر و تأییدکننده', 'Route and approver'), t('هر فرم می‌گوید از کدام واحد به کدام می‌رود، چه کسی تأیید می‌کند و چه فرآیندی را راه می‌اندازد. فرمی را که خودتان فرستاده‌اید نمی‌توانید تأیید کنید.',
        'Each form shows which unit sends it to which, who approves it and what it sets off. You cannot approve a form you sent yourself.')),
      step('[data-tour="quick-forms"]', t('فرم تازه از هر جا', 'A form from anywhere'), t('دکمهٔ + بالای هر صفحه، فرم‌هایی را که بیشتر می‌فرستید یک کلیک نزدیک می‌کند.',
        'The + at the top of every page keeps the forms you send most one click away.')),
      step(undefined, t('بدون اینترنت', 'Without a connection'), t('فرمی که آفلاین بفرستید در «صف ارسال فرم‌ها» می‌ماند و با برگشتن اینترنت خودش فرستاده می‌شود.',
        'A form sent offline waits in the “Form send queue” and goes by itself when the connection returns.')),
    ],
  },
  {
    id: 'people', route: '^/people', path: '/people', manual: 'Signing in',
    title: t('همکاران', 'Colleagues'),
    summary: t('همهٔ همکاران سازمان. صفحهٔ هر نفر واحد، نقش‌ها و ایمیلش را نشان می‌دهد و اگر اجازه داشته باشید، وظایف و پروژه‌های بازش را.',
      'Everyone in the organisation. Each person\'s page shows their unit, roles and email, and, where you may see them, their open tasks and projects.'),
    keywords: 'کاربر شخص پرسنل کارمند people person user staff',
    steps: [
      step(ANY.header, t('فهرست همکاران', 'The directory'), t('نام، واحد یا نقش را جستجو کنید و روی هر نفر بزنید تا صفحه‌اش باز شود.', 'Search by name, unit or role, and click someone to open their page.')),
      step(undefined, t('آنچه دیده می‌شود', 'What is shown'), t('شمارهٔ همراه و آخرین ورود هر کس فقط برای خود او و مدیر کاربران پیداست.', 'A person\'s mobile number and last sign-in are shown only to them and to the administrators of users.')),
    ],
  },
  {
    id: 'chat', route: '^/chat(/(?!oversight)[^/]+)?$', path: '/chat', permission: 'chat.use', manual: 'Team chat',
    title: t('گفت‌وگو', 'Chat'),
    summary: t('گفت‌وگوی دونفره، گروه خصوصی و کانالی که هر همکاری می‌تواند به آن بپیوندد. کد پرونده‌ها در پیام به خود پرونده پیوند می‌شود.',
      'Direct conversations, private groups, and channels any colleague may join. A record\'s code in a message links to the record.'),
    keywords: 'گفتگو پیام چت گروه کانال chat message group channel',
    steps: [
      step(undefined, t('گفت‌وگوی تازه', 'A new conversation'), t('«گفت‌وگوی تازه»: با یک همکار، یا گروهی که خودتان اعضایش را برمی‌گزینید. مدیران کانال هم می‌سازند؛ «کانال‌ها» فهرستشان است.',
        '“New conversation”: with one colleague, or a group whose members you choose. Managers also make channels; “Channels” lists them.')),
      step(undefined, t('نوشتن', 'Writing'), t('Enter می‌فرستد و Shift+Enter سطر تازه می‌زند. با @ از همکار نام ببرید تا باخبر شود؛ فایل را با + بفرستید. پیام را می‌شود ویرایش کرد یا برداشت.',
        'Enter sends, Shift+Enter starts a new line. Name a colleague with @ so they hear of it; share a file with +. A message can be edited or removed.')),
      step(undefined, t('باخبر شدن', 'Being told'), t('از تنظیمات هر گفت‌وگو بگویید کی باخبر شوید، یا آن را بی‌صدا کنید. اعلان فقط می‌گوید چه کسی نوشته، نه چه نوشته.',
        'In each conversation\'s settings, say when you want to hear of it, or mute it. A notice says who wrote, not what.')),
      step(undefined, t('بازبینی', 'Review'), t('گفت‌وگوها روی سامانهٔ سازمان انجام می‌شود. مدیران مجاز ممکن است آن‌ها را بازبینی کنند؛ هر بازبینی با نام بازبین، زمان و دلیلش در سابقهٔ حسابرسی ثبت می‌شود و پاک‌شدنی نیست.',
        "Conversations take place on the organisation's system. Authorised administrators may review them; every review is recorded in the audit trail with the reviewer, the time and the reason, and cannot be deleted.")),
    ],
  },
  {
    id: 'chat-oversight', route: '^/chat/oversight$', path: '/chat/oversight', permission: 'chat.oversight', manual: 'Team chat',
    title: t('بازبینی گفت‌وگوها', 'Reviewing conversations'),
    summary: t('برای کسی که مدیر سیستم دسترسی بازبینی را به او داده است: فقط خواندنی، و هر نگاه با دلیلش ثبت می‌شود.',
      'For someone the system administrator gave review: read-only, and every look is recorded with its reason.'),
    keywords: 'بازبینی نظارت حسابرسی oversight review audit',
    steps: [
      step(ANY.header, t('دلیل، پیش از خواندن', 'A reason before reading'), t('هر گفت‌وگو فقط با نوشتن دلیل باز می‌شود. نام شما، زمان و دلیل در سابقهٔ حسابرسی می‌ماند و پاک‌شدنی نیست؛ جستجو هم ثبت می‌شود.',
        'A conversation opens only once you write a reason. Your name, the time and the reason stay in the audit trail and cannot be deleted; searching is recorded too.')),
    ],
  },
  {
    id: 'me', route: '^/me$', path: '/me', manual: 'Signing in',
    title: t('صفحهٔ من', 'My page'),
    summary: t('روش‌های ورود شما — رمز، شمارهٔ همراه، حساب گوگل — و دستگاه‌هایی که با آن‌ها وارد شده‌اید.',
      'Your ways in — password, mobile number, Google account — and the devices you are signed in on.'),
    keywords: 'پروفایل رمز عبور گوگل موبایل دستگاه خروج profile password google mobile phone device sign out',
    steps: [
      step('[data-tour="ways-in"]', t('روش‌های ورود', 'Ways in'), t('شمارهٔ همراه را با کد تأیید کنید یا حساب گوگل را وصل کنید تا با آن هم وارد شوید. دست‌کم یک روش همیشه می‌ماند.',
        'Verify a mobile number with a code, or link a Google account, to sign in with it too. At least one way always remains.')),
      step('[data-tour="devices"]', t('دستگاه‌ها', 'Devices'), t('هر دستگاهی را که نمی‌شناسید از این‌جا خارج کنید؛ «خروج از بقیه» همه را جز همین یکی بیرون می‌کند.',
        'Sign out any device you do not recognise; signing out the others leaves only this one.')),
      step('[data-tour="locale"]', t('زبان', 'Language'), t('دکمهٔ EN / فا کل برنامه را به انگلیسی یا فارسی می‌برد و انتخاب شما را به خاطر می‌سپارد.', 'The EN / فا button switches the whole application between English and Persian, and remembers your choice.')),
    ],
  },
  {
    id: 'delegations', route: '^/delegations', path: '/delegations', manual: 'When the system blocks you',
    title: t('تفویض اختیار', 'Delegation'),
    summary: t('وقتی نیستید، به‌جای دادن رمز، دسترسی یا نقش تأییدکنندگی را تا تاریخی معین به همکاری بسپارید.',
      'When you are away, lend a colleague exactly the permissions or approver role needed, until a date, instead of sharing a password.'),
    keywords: 'جانشین مرخصی نماینده delegate leave away substitute',
    steps: [
      step(ANY.header, t('تفویض تازه', 'A new delegation'), t('همکار، دسترسی‌ها یا نقش، تاریخ پایان و دلیل را بنویسید. او از ورود بعدی آن‌ها را می‌بیند.',
        'Choose the colleague, the permissions or role, an end date and a reason. They see it from their next sign-in.')),
      step(undefined, t('به نمایندگی از شما', 'On your behalf'), t('هر کاری با این دسترسی‌ها بکند، به نام او و «به نمایندگی از شما» ثبت می‌شود، و می‌توانید زودتر پایانش دهید.',
        'Everything done with them is recorded as theirs, on your behalf, and you can end it early.')),
    ],
  },
  {
    id: 'leads', route: '^/leads', path: '/leads', permission: 'crm.lead.read', manual: 'Sales',
    title: t('سرنخ‌ها', 'Leads'),
    summary: t('هر مشتری احتمالی از این‌جا شروع می‌شود: ثبت، تماس، واجد شرایط کردن و تبدیل به فرصت فروش.',
      'Every possible client starts here: record, contact, qualify and convert to an opportunity.'),
    keywords: 'سرنخ لید مشتری احتمالی منبع ورودی بازاریاب lead prospect source marketer',
    steps: [
      step(ANY.listActions, t('سرنخ جدید', 'A new lead'), t('شمارهٔ همراه لازم است و هر طور بنویسید نگه داشته می‌شود. اگر تکراری باشد، فرم پیش از ثبت می‌گوید مال چه کسی است.',
        'A mobile number is required, typed any way you like. If it is already known, the form says whose it is before you save.')),
      step(undefined, t('منبع ورودی', 'Where it came from'), t('دو کلیک: نوع منبع — تیم فروش، بازاریابان، پرسنل شرکت، تماس مستقیم، شرکت‌های همکار — و بعد چه کسی یا چه کانالی.',
        'Two clicks: the kind of source — sales team, marketers, staff, direct contact, partner companies — then who or which channel.')),
      ...listSteps(t('سرنخ', 'lead'), t('روی سرنخ بزنید تا آن را تماس‌گرفته، واجد شرایط یا تبدیل کنید. تبدیل، فرصت فروش و در صورت نیاز پروندهٔ مشتری را می‌سازد.',
        'Click a lead to mark it contacted, qualify it or convert it. Converting creates the opportunity and, if needed, the client.')),
    ],
  },
  {
    id: 'opportunities', route: '^/opportunities/?$', path: '/opportunities', permission: 'crm.opportunity.read', manual: 'Sales',
    title: t('فرصت‌های فروش', 'Opportunities'),
    summary: t('قیف فروش: از واجد شرایط شدن تا بریف، پروپوزال، مذاکره و برد یا باخت.', 'The sales pipeline: from qualified to brief, proposal, negotiation, and won or lost.'),
    keywords: 'فرصت فروش قیف پایپلاین opportunity deal pipeline',
    steps: listSteps(t('فرصت', 'opportunity'), t('روی هر فرصت بزنید تا مرحله‌اش را جلو ببرید و بریف و پروپوزالش را ببینید.', 'Click an opportunity to move it on and see its brief and proposal.')),
  },
  {
    id: 'opportunity', route: '^/opportunities/[^/]+', permission: 'crm.opportunity.read', manual: 'Sales',
    title: t('صفحهٔ فرصت', 'An opportunity'),
    summary: t('یک فرصت فروش و گام بعدی‌اش: درخواست بریف، پروپوزال، مذاکره، برد یا باخت.', 'One opportunity and its next step: brief, proposal, negotiation, won or lost.'),
    steps: [step(ANY.header, t('فرصت', 'The opportunity'), t('مشتری، ارزش برآوردی، مالک و مرحلهٔ فعلی.', 'The client, estimated value, owner and current stage.')), WORKFLOW, RELATED, HISTORY],
  },
  {
    id: 'companies', route: '^/companies', path: '/companies', permission: 'crm.company.read', manual: 'Account',
    title: t('مشتریان', 'Clients'),
    summary: t('پروندهٔ هر مشتری: مخاطبان، پروژه‌ها، قراردادها و فاکتورها، کتابخانهٔ برند و پورتال مشتری.',
      'Each client\'s file: contacts, projects, contracts and invoices, the brand library and the client portal.'),
    keywords: 'مشتری شرکت کارفرما مخاطب برند پورتال client company customer contact brand portal',
    steps: [
      ...listSteps(t('مشتری', 'client'), t('روی مشتری بزنید تا پرونده‌اش باز شود.', 'Click a client to open their file.')),
      step(ANY.tabs, t('بخش‌های پرونده', 'Parts of the file'), t('در صفحهٔ مشتری: «نمای کلی»، «پروژه‌ها»، «تجاری»، «مالی» و «ارتباطات».', 'On a client\'s page: overview, projects, commercial, finance and engagement.')),
      step(undefined, t('پورتال و برند', 'Portal and brand'), t('«پورتال مشتری» مخاطب را دعوت می‌کند تا پروژه‌ها و تأییدهایش را ببیند؛ «کتابخانهٔ برند» رنگ‌ها، فونت‌ها و فایل‌های برند را نگه می‌دارد.',
        '“Client portal” invites a contact to see their projects and approvals; “Brand library” keeps the brand\'s colours, typefaces and files.')),
    ],
  },
  {
    id: 'briefs', route: '^/briefs', path: '/briefs', permission: 'brief.read', manual: 'Sales',
    title: t('بریف‌ها', 'Briefs'),
    summary: t('بریف فروش، نقطهٔ کنترل پیش از کار: کامل و دقیق برود، وگرنه برمی‌گردد.', 'The sales brief, the checkpoint before any work: it goes complete and specific, or it comes back.'),
    keywords: 'بریف کامل بودن کیفیت brief completeness quality',
    steps: [
      ...listSteps(t('بریف', 'brief'), t('روی بریف بزنید تا امتیاز کامل بودن و دقیق بودنش را ببینید.', 'Click a brief to see how complete and how specific it is.')),
      step(undefined, t('کیفیت بریف', 'Brief quality'), t('صفحهٔ بریف می‌گوید کدام بخش مبهم است — هدف بی‌عدد، مخاطبِ «همه»، کلمه‌هایی مثل «جذاب» — و اول کدام را درست کنید.',
        'The brief\'s page names what is vague — a goal with no number, an audience of “everyone”, words like “attractive” — and which to fix first.')),
      WORKFLOW,
    ],
  },
  {
    id: 'proposals', route: '^/proposals', path: '/proposals', permission: 'proposal.read', manual: 'Sales',
    title: t('پروپوزال‌ها', 'Proposals'),
    summary: t('از یکپارچه‌سازی خروجی واحدها و قیمت‌گذاری تا ارائه به مشتری و نتیجه.', 'From integrating the units\' work and pricing to presenting it to the client and the outcome.'),
    keywords: 'پروپوزال قیمت ارائه تأیید مشتری proposal price pricing present client approval',
    steps: [
      ...listSteps(t('پروپوزال', 'proposal'), t('روی پروپوزال بزنید تا نسخه‌ها، قیمت و نتیجهٔ ارائه را ببینید.', 'Click a proposal to see its versions, price and the outcome of presenting it.')),
      step(undefined, t('قیمت با دو امضا', 'Price, twice signed'), t('قیمت فروش با دلیل نوشته می‌شود و کسی جز خود قیمت‌گذار باید تأییدش کند.', 'The sale price is set with a written rationale and must be approved by someone other than whoever set it.')),
      step(undefined, t('تأیید مشتری', 'Client approval'), t('کارت «تأیید مشتری» لینکی برای مشتری می‌فرستد تا خودش تأیید کند یا اصلاح بخواهد؛ پاسخش به نام خودش ثبت می‌شود.',
        'The client-approval card sends the client a link to approve or ask for changes themselves; the answer is recorded as theirs.')),
    ],
  },
  {
    id: 'projects', route: '^/projects/?$', path: '/projects', permission: 'project.read', manual: 'Account',
    title: t('پروژه‌ها', 'Projects'),
    summary: t('پرتفوی پروژه‌ها با وضعیت و سلامت. هیچ پروژه‌ای بدون مجوز وارد اجرا نمی‌شود.', 'The project portfolio, with state and health. No project enters execution without authorisation.'),
    keywords: 'پروژه پرتفوی سلامت project portfolio health',
    steps: listSteps(t('پروژه', 'project'), t('روی پروژه بزنید تا «پروژه ۳۶۰» باز شود: همه چیز یک پروژه در یک صفحه.', 'Click a project to open Project 360: everything about a project on one page.')),
  },
  {
    id: 'project', route: '^/projects/[^/]+', permission: 'project.read', manual: 'Account',
    title: t('پروژه ۳۶۰', 'Project 360'),
    summary: t('همه چیز یک پروژه در یک صفحه: اجرا، زمان‌بندی، کیفیت، حاکمیت، مالی، رسانه، مشتری و بستن پروژه.',
      'Everything about a project on one page: work, schedule, quality, governance, finance, media, the client and closure.'),
    keywords: 'پروژه ۳۶۰ زمان بندی مسیر بحرانی ریسک بستن project 360 schedule critical path risk closure',
    steps: [
      step(ANY.header, t('پروژه', 'The project'), t('کد، مشتری، وضعیت و سلامت پروژه. دکمه‌های بالای صفحه خروجی PDF و گزارش مشتری‌اند.', 'The code, client, state and health. The buttons at the top export a PDF and the client report.')),
      RELATED,
      step(ANY.tabs, t('بخش‌ها', 'Its parts'), t('«اجرا» وظایف و سفارش‌ها، «زمان‌بندی» مسیر بحرانی و پیش‌بینی تحویل، «کیفیت» QC، «حاکمیت» ریسک‌ها و جلسه‌ها، «مالی» بودجه و حاشیه، «بستن پروژه» چک‌لیست پایانی.',
        '“Delivery” has tasks and orders, “Schedule” the critical path and delivery forecast, “Quality” QC, “Governance” risks and meetings, “Finance” budget and margin, “Close project” the closing checklist.')),
      step(undefined, t('درس‌های گذشته', 'What we already learned'), t('بالای نمای کلی، درس‌های پروژه‌های قبلی که به این یکی مربوط است. برای هر کدام بگویید «به‌کار می‌گیریم» یا «مرتبط نیست».',
        'At the top of the overview, lessons from past projects that bear on this one. Answer each: we will apply it, or it is not relevant.')),
      WORKFLOW,
    ],
  },
  {
    id: 'work-orders', route: '^/work-orders', path: '/work-orders', permission: 'workorder.read', manual: 'Execution units (Strategy, Creative, Media, Digital)',
    title: t('سفارش‌های کار', 'Work orders'),
    summary: t('سفارش اکانت به هر واحد اجرایی، با نُه عنصر الزامی. واحد چهار ساعت کاری فرصت دارد بپذیرد یا رفع ابهام بخواهد.',
      'Account\'s order to each execution unit, with its nine required elements. The unit has four working hours to accept or ask for clarification.'),
    keywords: 'سفارش کار واحد پذیرش ابهام هزینه work order unit accept clarification cost',
    steps: [
      ...listSteps(t('سفارش', 'order'), t('روی سفارش بزنید تا آن را بپذیرید، رفع ابهام بخواهید یا تحویل دهید.', 'Click an order to accept it, ask for clarification or deliver it.')),
      step(undefined, t('هزینه با سابقه', 'Cost, with its history'), t('هنگام اعلام هزینه، سفارش‌های مشابه واحدتان و هزینهٔ واقعی‌شان کنارش می‌آید. تا QC واحد و هزینه ثبت نشود، تحویل ممکن نیست.',
        'When you declare the cost, your unit\'s similar orders and what they really cost appear beside it. Without unit QC and a declared cost, the order cannot be delivered.')),
      WORKFLOW,
    ],
  },
  {
    id: 'qc', route: '^/qc', path: '/qc', permission: 'qc.read', manual: 'Account',
    title: t('کنترل کیفیت', 'Quality control'),
    summary: t('سه سطح QC — واحد، اکانت، نهایی — و اصلاحیه‌ها. هیچ چیز بدون QC قبول‌شدهٔ اکانت به مشتری نمی‌رسد.',
      'The three QC levels — unit, account, final — and revisions. Nothing reaches the client without a passing account QC.'),
    keywords: 'کیفیت QC اصلاحیه رد تأیید یادداشت روی فایل quality revision reject annotate',
    steps: [
      step(ANY.tabs, t('سطح‌ها', 'The levels'), t('«QC واحد»، «QC اکانت»، «QC نهایی» و «اصلاحیه‌ها». هر سطح فقط چیزی را نشان می‌دهد که منتظر همان سطح است.',
        'Unit, account and final QC, and revisions. Each level shows only what waits for that level.')),
      step(undefined, t('رد با دلیل', 'Rejecting, with the reason'), t('QC ردشده خودش اصلاحیه می‌سازد، با یافته‌های شما به‌عنوان اصلاح مورد انتظار. یادداشت‌های روی فایل را تیک بزنید تا دقیق برسد.',
        'A failed QC raises the revision itself, carrying your findings as the expected correction. Tick the notes on the file so it arrives precise.')),
      step(undefined, t('یادداشت روی فایل', 'Notes on the file'), t('روی تصویر سنجاق بزنید، ویدیو را نگه دارید و لحظه را یادداشت کنید، یا ناحیه‌ای از PDF را علامت بزنید.',
        'Pin a note on an image, pause a video and note the moment, or mark a region of a PDF page.')),
    ],
  },
  {
    id: 'changes', route: '^/changes', path: '/changes', permission: 'change.read', manual: 'Account',
    title: t('درخواست‌های تغییر', 'Change requests'),
    summary: t('تغییر خارج از محدوده، بدون ارزیابی اثر و تأیید مشتری اجرا نمی‌شود.', 'A change outside the scope is not carried out without an impact assessment and the client\'s approval.'),
    keywords: 'تغییر اسکوپ محدوده ارزیابی اثر change scope impact',
    steps: [
      ...listSteps(t('درخواست تغییر', 'change request'), t('روی درخواست بزنید تا اثرش بر زمان، هزینه و محدوده را ثبت کنید.', 'Click a request to record its impact on time, cost and scope.')),
      WORKFLOW,
    ],
  },
  {
    id: 'traffic', route: '^/traffic', path: '/traffic', permission: 'traffic.read', manual: 'PMO / Operations',
    title: t('ترافیک و ظرفیت', 'Traffic and capacity'),
    summary: t('ظرفیت هر نفر در برابر کار تعهدشده، روی تقویم و مرخصی خودش. بیش‌تخصیص علامت می‌خورد.',
      'Each person\'s capacity against committed work, on their own calendar and leave. Over-allocation is flagged.'),
    keywords: 'ظرفیت تخصیص بار کاری ترافیک capacity allocation workload',
    steps: [
      step(ANY.header, t('صفحهٔ ظرفیت', 'The board'), t('فقط باقی‌ماندهٔ هر وظیفه حساب می‌شود؛ ساعتی که ثبت شده، خرج شده است.', 'Only what is left of each task counts; hours already logged are spent.')),
      step(undefined, t('تخصیص با دید باز', 'Assigning with eyes open'), t('«تخصیص» کنار هر نامزد ظرفیت آزاد، تاریخ واقعی پایان کار روی تقویم خودش و سابقهٔ تحویلش را نشان می‌دهد.',
        '“Assign” shows each candidate\'s free capacity, when they would really finish on their own calendar, and their delivery record.')),
    ],
  },
  {
    id: 'suppliers', route: '^/suppliers', path: '/suppliers', permission: 'supplier.read', manual: 'Execution units (Strategy, Creative, Media, Digital)',
    title: t('تأمین‌کنندگان', 'Suppliers'),
    summary: t('همهٔ همکاران بیرونی و فریلنسرها: امتیاز، تحویل به‌موقع و کارِ در دستشان.', 'Every external partner and freelancer: their rating, on-time delivery and what is on their plate.'),
    keywords: 'تأمین کننده فریلنسر برون سپاری supplier freelancer vendor outsource',
    steps: [
      step(ANY.header, t('پیشنهاد بعدی', 'Who next'), t('بالای فهرست، بر پایهٔ سابقه رتبه می‌دهد که درخواست بعدی را به چه کسی بسپارید.', 'At the top of the list, a ranking by evidence of whom to send the next request to.')),
      step(undefined, t('صفحهٔ هر تأمین‌کننده', 'Each supplier\'s page'), t('امتیاز کلی و چهار بعد ارزیابی، تحویل به‌موقع و خط زمانی درخواست‌ها و ارزیابی‌ها.', 'The overall rating and its four dimensions, on-time delivery, and a timeline of requests and evaluations.')),
    ],
  },
  {
    id: 'contracts', route: '^/contracts', path: '/contracts', permission: 'contract.read', manual: 'Legal',
    title: t('قراردادها', 'Contracts'),
    summary: t('از پیش‌نویس تا بررسی حقوقی، تأیید، امضا و ثبت. ثبت قرارداد، مبنای درآمد پروژه را می‌گذارد.',
      'From drafting through legal review, approval and signature to registration. Registering a contract sets the project\'s revenue baseline.'),
    keywords: 'قرارداد امضا الکترونیکی الحاقیه contract signature e-sign amendment',
    steps: [
      ...listSteps(t('قرارداد', 'contract'), t('روی قرارداد بزنید تا آن را جلو ببرید یا الحاقیه ثبت کنید.', 'Click a contract to move it on or record an amendment.')),
      step(undefined, t('امضای الکترونیکی', 'Electronic signature'), t('وقتی قرارداد «در انتظار امضا» است، کارت «امضای الکترونیکی» آن را اول برای مشتری و بعد برای امضاکنندهٔ سازمان می‌فرستد.',
        'When a contract is “Awaiting signature”, the “E-signature” card sends it to the client first, then to the organisation\'s signatory.')),
      WORKFLOW,
    ],
  },
  {
    id: 'finance', route: '^/finance', path: '/finance', permission: 'finance.read', manual: 'Finance',
    title: t('مالی', 'Finance'),
    summary: t('فاکتورها و دریافت‌ها، سامانهٔ مؤدیان، خروجی حسابداری و نرخ ارز.', 'Invoices and receipts, the tax authority\'s e-invoicing, the accounting export and exchange rates.'),
    keywords: 'فاکتور صورتحساب دریافت پرداخت مؤدیان ارز حسابداری invoice payment receipt tax currency accounting export',
    steps: [
      step(ANY.tabs, t('بخش‌ها', 'Its parts'), t('«اسناد و تراکنش‌ها»، «سامانهٔ مؤدیان»، «خروجی حسابداری»، «نرخ ارز» و «اثر نرخ ارز».', 'Documents and transactions, e-invoicing, the accounting export, exchange rates and the effect of rates.')),
      step(undefined, t('فاکتور و دریافت', 'Invoices and receipts'), t('جمع‌ها را سرور حساب می‌کند. ثبت دریافت، فاکتور را خودش به «نیمه‌پرداخت» یا «پرداخت‌شده» می‌برد.',
        'The server computes the totals. Recording a receipt moves the invoice to partly paid or paid by itself.')),
      step(undefined, t('ارز', 'Other currencies'), t('هر رقم ارزی با نرخ همان روز خودش تبدیل می‌شود و همان را نگه می‌دارد. اگر نرخ آن روز نباشد، سامانه می‌گوید کدام نرخ را لازم دارد.',
        'Each foreign-currency figure is converted at its own day\'s rate and keeps it. If that day has no rate, the system says which rate it needs.')),
    ],
  },
  {
    id: 'reports', route: '^/reports', path: '/reports', permission: 'report.read', manual: 'Management',
    title: t('گزارش‌ها', 'Reports'),
    summary: t('برج کنترل مدیریتی، پرسش از داده‌ها، قیف فروش، عملکرد واحدها، SLA، کیفیت داده، کشف فرآیند و بیشتر.',
      'The executive control tower, asking the data, the sales funnel, unit performance, SLA, data quality, process discovery and more.'),
    keywords: 'گزارش داشبورد مدیریتی شاخص سود حاشیه report kpi margin control tower',
    steps: [
      step(ANY.tabs, t('گزارش‌ها', 'The reports'), t('هر زبانه یک گزارش است؛ آن‌هایی را می‌بینید که نقشتان اجازه می‌دهد.', 'Each tab is one report; you see the ones your role allows.')),
      step(undefined, t('پرسش از داده‌ها', 'Asking the numbers'), t('در «پرسش از داده‌ها» سؤال را همان‌طور که می‌پرسید بنویسید؛ پاسخ می‌گوید چه فهمید و بر پایهٔ کدام رکوردهاست.',
        'In “Ask the data”, type the question as you would ask it; the answer says how it understood you and which records it rests on.')),
      step(undefined, t('خط زرد', 'The yellow line'), t('اگر بخشی از سؤال اعمال نشده باشد، خط زرد زیر پاسخ نامش را می‌برد.', 'If part of your question was not applied, the yellow line under the answer names it.')),
    ],
  },
  {
    id: 'memory', route: '^/memory', path: '/memory', manual: 'Organisational memory',
    title: t('حافظهٔ سازمان', 'Organisational memory'),
    summary: t('جستجو در آنچه سازمان آموخته: بریف‌ها، پروپوزال‌ها، صورتجلسه‌ها، درس‌ها و بازخورد مشتری — بر پایهٔ معنا.',
      'Search what the organisation has learned: briefs, proposals, minutes, lessons and client feedback — by meaning.'),
    keywords: 'حافظه دانش درس آموخته جستجو memory knowledge lessons search',
    steps: [
      step('[data-tour="memory-ask"]', t('بپرسید', 'Ask'), t('مثل پرسیدن از همکار بنویسید: «برای مشتری صنایع غذایی چه استراتژی‌هایی داده‌ایم؟»', 'Ask as you would ask a colleague: what strategies have we given food-industry clients?')),
      step(undefined, t('دو عدد', 'Two numbers'), t('هر نتیجه می‌گوید چقدر از نظر معنا و چقدر از نظر واژه نزدیک است. فقط چیزی را می‌بینید که اجازهٔ باز کردنش را دارید.',
        'Each result says how close it is in meaning and in wording. You only see what you may open.')),
    ],
  },
  {
    id: 'ai', route: '^/ai', path: '/ai', permission: 'ai.use', manual: 'The AI assistant',
    title: t('دستیار هوشمند', 'AI assistant'),
    summary: t('تحلیل‌های قاعده‌محور روی داده‌های سامانه، و گفت‌وگو با دستیار محلی از دکمهٔ بالای صفحه.',
      'Rule-based analyses over the system\'s data, and a conversation with the local assistant from the button at the top.'),
    keywords: 'هوش مصنوعی دستیار تحلیل گفتگو صدا میکروفون پیشنهاد ai assistant analysis chat voice microphone proposal',
    steps: [
      step(ANY.header, t('یک تحلیل', 'An analysis'), t('تحلیل و موضوعش را انتخاب کنید. یافته‌های قاعده‌محور همیشه هست و به رکوردهایش ارجاع می‌دهد.', 'Choose an analysis and its subject. Rule-based findings are always there, citing their records.')),
      step('[data-tour="assistant"]', t('گفت‌وگو', 'A conversation'), t('این دکمه دستیار محلی را باز می‌کند: رایگان و بی‌سقف. هر چه شما می‌بینید می‌بیند، نه بیشتر، و فرم پرشده پیشنهاد می‌دهد.',
        'This button opens the local assistant: free and unlimited. It sees what you see, no more, and offers forms already filled in.')),
      step(undefined, t('گفتن و تأیید', 'Speak, then approve'), t('با دکمهٔ میکروفون بگویید چه کرده‌اید یا چه می‌خواهید؛ متن را می‌خوانید و می‌فرستید. اگر دستیار کاری پیشنهاد کند — تحویل وظیفه، ثبت ساعت، جلسه — تا خودتان تیک نزنید و «انجام موارد انتخاب‌شده» را نزنید، چیزی نوشته نمی‌شود.',
        'Press the microphone and say what you did or want; you read the text, then send it. When the assistant proposes something — submitting a task, logging time, a meeting — nothing is written until you tick it and press “Do the selected”.')),
    ],
  },
  {
    id: 'rules', route: '^/rules', path: '/rules', manual: "The organisation's rules",
    title: t('قوانین سازمان', 'The organisation\'s rules'),
    summary: t('هر قانونی که گردش کارها از آن پیروی می‌کند، به زبان ساده: قوانین خود سازمان و قوانین Doc_H.',
      'Every rule the workflows follow, read as a sentence: the organisation\'s own and Doc_H\'s.'),
    keywords: 'قانون شرط استثنا rule condition exception',
    steps: [
      step(ANY.tabs, t('دو دسته', 'Two kinds'), t('«قوانین سازمان» را مدیرعامل و مدیر PMO می‌نویسند؛ «Doc_H و افزونه‌ها» قوانین محصول است.', 'The organisation\'s own rules, written by the CEO and PMO manager, and Doc_H\'s and extensions\'.')),
      step('[data-tour="new-rule"]', t('قانون تازه', 'A new rule'), t('گردش کار و انتقال را انتخاب کنید و شرط را از فیلدهای رکورد بسازید. پیش از انتشار، روی یک رکورد و روی سابقه بسنجید.',
        'Choose the workflow and the move, and build the condition from the record\'s fields. Before publishing, try it on one record and against the history.')),
    ],
  },
  {
    id: 'onboarding', route: '^/onboarding', path: '/onboarding', permission: 'admin.settings', manual: 'Getting the organisation started',
    title: t('راه‌اندازی سازمان', 'Getting started'),
    summary: t('سازمان را از فایل‌های اکسل موجود راه بیندازید: واحدها، کاربران، تقویم کاری، مهلت‌ها، مشتریان و پروژه‌های در جریان.',
      'Bring the organisation in from the spreadsheets it already has: units, users, calendar, deadlines, clients and running projects.'),
    keywords: 'راه اندازی ورود اطلاعات اکسل کاربران onboarding import excel users setup',
    steps: [
      step(ANY.header, t('شش گام', 'Six steps'), t('هر گام نشان می‌دهد چه چیزی از قبل هست. هر فایل پیش از نوشتن، ردیف به ردیف بررسی می‌شود.', 'Each step shows what is already there. Every file is checked row by row before anything is written.')),
      step(undefined, t('بی‌رمز', 'No passwords in files'), t('رمز کسی در فایل نیست: هر کاربر تازه لینکی یک‌بارمصرف برای گذاشتن رمز خودش می‌گیرد. اجرای دوبارهٔ یک فایل، چیزی را دوبار نمی‌سازد.',
        'Nobody\'s password is in a file: each new person gets a one-time link to set their own. Running a file twice creates nothing twice.')),
    ],
  },
  {
    id: 'admin', route: '^/admin', path: '/admin',
    anyOf: ['admin.users', 'admin.roles', 'admin.settings', 'admin.audit', 'admin.keys'], manual: 'Signing in',
    title: t('مدیریت سیستم', 'Administration'),
    summary: t('کاربران، نقش‌ها و دسترسی‌ها، مهلت‌ها، تقویم کاری، رنگ واحدها، طراح فرم، حسابرسی، هشدارهای امنیتی و یکپارچه‌سازی.',
      'Users, roles and permissions, deadlines, working calendars, unit colours, the form designer, audit, security alerts and integrations.'),
    keywords: 'مدیریت کاربر نقش دسترسی مجوز تنظیمات admin user role permission settings',
    steps: [
      step(ANY.tabs, t('زبانه‌ها', 'The tabs'), t('هر زبانه یک بخش مدیریت است؛ آن‌هایی را می‌بینید که اجازه‌اش را دارید.', 'Each tab is one area of administration; you see those you are allowed.')),
      step(undefined, t('نقش‌ها و دسترسی‌ها', 'Roles and permissions'), t('برای هر نقش، دسترسی‌ها را تیک بزنید؛ تغییر همان لحظه برای همه اعمال می‌شود و سابقه‌اش می‌ماند.',
        'Tick each role\'s permissions; a change applies to everyone at once and its history is kept.')),
      step(undefined, t('درخواست‌های عضویت', 'Requests to join'), t('در «کاربران»، درخواست‌های عضویت را با انتخاب واحد و نقش بپذیرید یا با دلیل رد کنید.', 'Under Users, approve requests to join by choosing the unit and roles, or reject them with a reason.')),
    ],
  },
];

const PATTERNS = GUIDE.map((s) => [new RegExp(s.route), s] as const);

/** The guide section of a page. */
export function guideFor(pathname: string): GuideSection | undefined {
  return PATTERNS.find(([re]) => re.test(pathname))?.[1];
}

/** Letters written two ways, zero-width joiners, and diacritics, folded so a search finds either. */
export function normaliseGuideText(s: string): string {
  return s.toLowerCase()
    .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/[ۀة]/g, 'ه').replace(/[أإآ]/g, 'ا')
    .replace(/[ً-ْٰ]/g, '').replace(/‌/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ');
}

/** Short words that say nothing about what is wanted. */
const STOP_WORDS = new Set(['را', 'به', 'از', 'در', 'که', 'با', 'و', 'یا', 'این', 'آن', 'چه', 'چطور', 'چگونه', 'کجا', 'کنم', 'می', 'است', 'من', 'یک', 'برای',
  'how', 'do', 'i', 'the', 'a', 'an', 'to', 'of', 'in', 'is', 'what', 'where', 'can', 'my', 'for', 'on', 'it']);
const terms = (s: string) => normaliseGuideText(s).split(/\s+/).filter((w) => w.length > 1 && !STOP_WORDS.has(w));

export interface GuideMatch { section: GuideSection; step?: GuideStep; score: number }

/**
 * "How do I…" answered from the guide: sections and steps ranked by how many of the question's words
 * they hold — a word in a title counts more than one in the text, a prefix (فرم → فرم‌ها) less.
 */
export function searchGuide(query: string, locale: 'fa' | 'en' = 'fa', limit = 5): GuideMatch[] {
  const q = terms(query);
  if (!q.length) return [];
  const score = (text: string, weight: number) => {
    const words = terms(text);
    let s = 0;
    for (const w of q) {
      if (words.includes(w)) s += weight;
      else if (w.length >= 3 && words.some((x) => x.startsWith(w) || (w.startsWith(x) && x.length >= 3))) s += weight / 2;
    }
    return s;
  };
  const both = (g: GuideText) => `${g[locale]} ${g[locale === 'fa' ? 'en' : 'fa']}`;
  const out: GuideMatch[] = [];
  for (const section of GUIDE) {
    const base = score(both(section.title), 3) + score(section.keywords ?? '', 2) + score(both(section.summary), 1);
    out.push({ section, score: base });
    for (const st of section.steps) {
      const s = score(both(st.title), 3) + score(both(st.body), 1);
      if (s > 0) out.push({ section, step: st, score: s + base / 2 });
    }
  }
  return out.filter((m) => m.score >= 1).sort((a, b) => b.score - a.score).slice(0, limit);
}
