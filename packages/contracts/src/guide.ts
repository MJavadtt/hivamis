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
    id: 'dashboard', route: '^/$', path: '/', manual: 'Your workspace — «میز کار من»',
    title: t('میز کار من', 'My workspace'),
    summary: t('آنچه امروز با شماست، به زبان ساده: چه برای اصلاح برگشته، چه فوری است، کار بعدی چیست؛ و جلسه‌ها، اعلان‌ها و پروژه‌هایتان.',
      'What is yours today, in plain words: what came back to correct, what is urgent, what is next — and your meetings, notifications and projects.'),
    keywords: 'خانه صفحه اول میز کار امروز home start today workspace',
    steps: [
      step('[data-tour="today"]', t('امروز', 'Today'), t('یک جمله می‌گوید امروز چه با شماست، چه برگشته و چه فوری است. دکمهٔ کنارش فهرست کامل را باز می‌کند.',
        'One sentence says how much is yours, how much came back and how much is urgent. The button beside it opens all your work.')),
      step('[data-tour="my-tasks"]', t('آنچه با شماست', 'What is yours'), t('هر کارت می‌گوید کار چیست، چه باید بکنید و تا کی — و دکمه‌اش همان کار را انجام می‌دهد. برگشتی‌ها می‌گویند چه کسی، کی و چرا برگرداند.',
        'Each card says what the work is, what to do and by when — and its button does it. A returned one says who sent it back, when and why.')),
      step('[data-tour="meetings"]', t('جلسه‌های پیش رو', 'Upcoming meetings'), t('جلسه‌های دو هفتهٔ آینده‌تان؛ روی هر کدام بزنید تا باز شود.', 'Your meetings in the next two weeks; click one to open it.')),
      step('[data-tour="my-projects"]', t('پروژه‌های من', 'My projects'), t('پروژه‌هایی که در آن‌ها کار می‌کنید، با وضعیتشان به زبان ساده و اینکه روی روال هستند یا نه.',
        'The projects you work on, where each stands in plain words, and whether it is on track.')),
      step('[data-tour="search"]', t('رفتن به هر پرونده', 'Go to any record'), t('نام یا کد پروژه، مشتری، وظیفه یا قرارداد را بنویسید. Ctrl+K هم جستجو را باز می‌کند.',
        'Type the name or code of a project, client, task or contract. Ctrl+K opens the search too.')),
    ],
  },
  {
    id: 'overview', route: '^/overview', path: '/overview', manual: 'Your figures — «نمای آماری من»',
    title: t('نمای آماری من', 'My figures'),
    summary: t('شمار کارهای شما به عدد: وظایف باز و تاخیردار، فرم‌های منتظر تأیید، مهلت‌ها و پروژه‌ها و فرصت‌های فروش.',
      'Your work in figures: open and overdue tasks, forms awaiting approval, deadlines, projects and sales opportunities.'),
    keywords: 'داشبورد آمار کاشی عدد dashboard tiles figures overview',
    steps: [
      step('[data-tour="tiles"]', t('چهار کاشی', 'Four tiles'), t('وظایف باز، وظایف تاخیردار، فرم‌های در انتظار تأیید شما و روندهای نقض‌شده یا در خطر. روی هر کاشی بزنید تا فهرستش باز شود.',
        'Open tasks, overdue tasks, forms waiting for your approval, and deadlines broken or about to be. Click a tile to open its list.')),
      step('[data-tour="my-slas"]', t('روندهای من', 'My deadlines'), t('ساعت‌های مهلتی که به نام شماست و اینکه از هر کدام چقدر مانده.', 'The deadline clocks you own, and how much of each is left.')),
      step('[data-tour="my-projects"]', t('پروژه‌ها و فرصت‌ها', 'Projects and opportunities'), t('«در حال اجرا» پروژه‌هایی است که در آن‌ها کار می‌کنید؛ «فروش» فرصت‌هایی که هنوز برده یا باخته نشده‌اند.',
        '“In progress” lists the projects you work on; “Sales” the opportunities not yet won or lost.')),
    ],
  },
  {
    id: 'my-work', route: '^/my-work', path: '/my-work', manual: 'Your queue — «کارهای من»',
    title: t('کارهای من', 'My work'),
    summary: t('هر چه با شماست، هر کدام با گام بعدی‌اش: وظایف، سفارش‌های کار، بررسی خروجی‌ها، فرم‌های منتظر تصمیم شما، اصلاحیه‌ها و سؤال‌ها.',
      'Everything that is yours, each with its next step: tasks, work orders, reviews of outputs, forms awaiting your decision, corrections and questions.'),
    keywords: 'صف کارتابل inbox queue todo',
    steps: [
      step('[data-tour="work-summary"]', t('در یک جمله', 'In one sentence'), t('چند کار با شماست، چندتا برگشته، چندتا فوری است و چندتا منتظر تصمیم شما.', 'How much is yours, how much came back, how much is urgent and how much awaits your decision.')),
      step('[data-tour="work-groups"]', t('گروه‌ها', 'Groups'), t('برگشت برای اصلاح، فوری، منتظر تصمیم شما، کارهای من، و آنچه تحویل داده‌اید و منتظر دیگران است. روی یکی بزنید تا فقط همان بماند.',
        'Returned for correction, urgent, awaiting your decision, your work, and what you handed in that waits on others. Click one to see only it.')),
      step('[data-tour="work-list"]', t('کار، همین‌جا', 'Act from the card'), t('هر کارت می‌گوید چه باید بکنید و دکمهٔ اصلی همان کار را انجام می‌دهد؛ «جزئیات» پرونده را با همهٔ کارهای دیگرش باز می‌کند.',
        'Each card says what to do, and its main button does it; Details opens the record with everything else that can be done.')),
      step('[data-tour="notifications"]', t('اعلان‌ها', 'Notifications'), t('روی هر اعلان بزنید تا پرونده‌اش باز شود. نقطهٔ سبز روی زنگ یعنی صفحه زنده است.',
        'Click a notification to open its record. A green dot on the bell means the page is live.')),
    ],
  },
  {
    id: 'operations', route: '^/operations', path: '/operations', permission: 'workorder.read', manual: 'PMO / Operations',
    title: t('میز عملیات', 'The operations desk'),
    summary: t('آنچه واحدها تحویل داده‌اند، پرسیده‌اند یا هنوز نپذیرفته‌اند، بار کاری هر واحد، و پروپوزال‌هایی که از کار آن‌ها کنار هم گذاشته می‌شوند — در همهٔ پروژه‌ها.',
      'What the units have handed in, asked, or not yet taken, each unit\'s load, and the proposals being put together from their work — across every project.'),
    keywords: 'عملیات واحد سفارش خروجی بررسی سؤال ابهام operations unit order output review question',
    steps: [
      step('[data-tour="ops-summary"]', t('در یک جمله', 'In one sentence'), t('چند خروجی منتظر بررسی، چند سؤال، چند سفارش پذیرفته‌نشده و چند پروپوزال در دست است.',
        'How many outputs await review, how many questions, how many orders not yet taken, and how many proposals in hand.')),
      step('[data-tour="ops-handed-in"]', t('خروجی‌های رسیده', 'What was handed in'), t('بپذیرید، یا با توضیح روشن برای اصلاح برگردانید؛ توضیح شما کنار کار می‌ماند و واحد آن را می‌بیند.',
        'Accept it, or send it back for correction with a clear reason; your reason stays with the work and the unit sees it.')),
      step('[data-tour="ops-questions"]', t('سؤال‌های واحدها', 'Units\' questions'), t('چه کسی چه پرسیده است؛ پاسخ را بدهید تا سفارش جلو برود.',
        'Who asked what; answer it so the order can go on.')),
      step('[data-tour="ops-units"]', t('کار در دست هر واحد', 'Each unit\'s load'), t('برای هر واحد: چند سفارش نپذیرفته، چندتا در دست کار و چندتا تحویل‌شده است.',
        'For each unit: how many orders it has not taken, has in hand, and has handed in.')),
      step('[data-tour="ops-proposals"]', t('پروپوزال‌ها', 'Proposals'), t('هر پروپوزال با گام بعدش؛ روی آن بزنید تا مسیر اکانت آن باز شود.',
        'Each proposal with its next step; click it to open its account journey.')),
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
      step('[data-tour="task-glance"]', t('در یک نگاه', 'At a glance'), t('چه خواسته شده، چه کسی خواسته، برای کدام پروژه و مشتری، چه باید تحویل داد و در چه قالبی، تا کی و با چه کسی؛ فایل‌های خروجی را همین‌جا بگذارید و گام بعد را با دکمه‌اش بردارید.',
        'What is asked, who asked, for which project and client, what to hand in and in what format, by when and by whom; add the output files right here and take the next step with its button.')),
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
    id: 'bookings', route: '^/bookings(/(?!admin$)[^/]+)?$', path: '/bookings', permission: 'meeting.book', manual: 'Booking a meeting',
    title: t('رزرو جلسه', 'Booking a meeting'),
    summary: t('اتاق، تجهیزات، پارکینگ و همکاران را برای جلسه رزرو کنید — بی‌تداخل، با تأیید، و با صورتجلسه در هیوامیس.',
      'Book a room, equipment, parking and colleagues for a meeting — without clashes, approved, and minuted in Hivamis.'),
    keywords: 'رزرو اتاق جلسه پارکینگ پروژکتور مهمان book room meeting parking projector guest reservation',
    steps: [
      step(ANY.header, t('رزرو تازه', 'A new booking'), t('زمان و همکاران را بدهید: فقط اتاق‌های آزادِ بزرگ‌به‌اندازه نشان داده می‌شوند و هر تداخلی با نام گفته می‌شود، با زمان‌های آزاد بعدی.',
        'Give the time and the colleagues: only rooms free and large enough are shown, and any clash is named, with the next free times.')),
      step(undefined, t('تأیید، سپس قطعی', 'Approved, then confirmed'), t('تأییدکننده — مدیر واحد شما — تصمیم می‌گیرد؛ سپس «قطعی کردن» اتاق و افراد را نگه می‌دارد و جلسه‌ای در هیوامیس می‌سازد.',
        'The approver — your unit\'s manager — decides; then “Confirm” holds the room and the people and makes a Hivamis meeting.')),
    ],
  },
  {
    id: 'booking-admin', route: '^/bookings/admin$', path: '/bookings/admin', anyOf: ['resource.manage', 'meeting.view_all'], manual: 'Booking a meeting',
    title: t('مدیریت رزرو', 'Booking administration'),
    summary: t('اتاق‌ها، تجهیزات، پارکینگ و پذیرایی را نگه دارید و ببینید هر اتاق چقدر به کار رفته است.',
      'Keep the rooms, equipment, parking and catering, and see how much each room is used.'),
    keywords: 'اتاق پارکینگ پذیرایی گزارش ظرفیت room parking catering report utilisation',
    steps: [
      step(undefined, t('اتاق‌ها و منابع', 'Rooms and resources'), t('هر اتاق با صندلی، طبقه، مکان و امکاناتش؛ آنچه دیگر به کار نمی‌رود غیرفعال می‌شود، نه پاک.',
        'Each room with its seats, floor, place and features; what is no longer used is deactivated, not deleted.')),
      step(undefined, t('گزارش استفاده', 'Usage report'), t('ساعت‌های رزروشدهٔ هر اتاق در برابر ساعت‌های کاری، و ساعت‌هایی که جلسه‌ها آغاز می‌شوند.',
        "Each room's booked hours against its working hours, and the hours meetings start in.")),
    ],
  },
  {
    id: 'reception', route: '^/reception$', path: '/reception', permission: 'reception.checkin', manual: 'Booking a meeting',
    title: t('پذیرش', 'Reception'),
    summary: t('مهمانان جلسه‌های امروز: ورود و خروجشان را ثبت کنید؛ برگزارکننده بی‌درنگ باخبر می‌شود.',
      "Today's meeting guests: check them in and out; the organiser is told at once."),
    keywords: 'پذیرش مهمان ورود خروج reception guest check in visitor',
    steps: [
      step(undefined, t('ثبت ورود', 'Check in'), t('«ثبت ورود» زیر نام مهمان؛ برگزارکنندهٔ جلسه در برنامه، روی گوشی و در پیام‌رسان باخبر می‌شود.',
        '“Check in” under the guest\'s name; the organiser hears of it in the app, on the phone and in the messenger.')),
    ],
  },
  // ADR-103: venues, deployment projects and rentals.
  {
    id: 'sites', route: '^/sites$', path: '/sites', anyOf: ['venue.read', 'site.read', 'rental.read'], manual: 'Venues and rentals — «مکان‌ها و اجاره‌داری»',
    title: t('مکان‌ها و اجاره‌داری', 'Venues and rentals'),
    summary: t('آنچه امروز کار دارد: معوق‌ها، سررسیدهای این هفته، قراردادهای منتظر تأیید و نصب‌های با تأخیر.',
      'What needs attention today: overdue items, this week\'s dues, contracts awaiting approval and delayed installations.'),
    keywords: 'مکان اجاره ودیعه شارژ پروژه استقرار کانتر venue rent deposit service charge deployment counter',
    steps: [
      step(ANY.header, t('هر عدد پیوند است', 'Every figure is a link'), t('روی هر کاشی بزنید تا فهرست همان اقلام باز شود.', 'Tap any tile to open the list of those items.')),
    ],
  },
  {
    id: 'site-venues', route: '^/sites/venues(/[^/]+)?$', path: '/sites/venues', permission: 'venue.read', manual: 'Venues and rentals — «مکان‌ها و اجاره‌داری»',
    title: t('بانک مکان‌ها', 'Venue database'),
    summary: t('مجتمع‌ها، ایستگاه‌ها و شهربازی‌ها با گرید، مخاطبان، عکس‌ها و افراد هر مکان؛ تکراری‌ها پیش از ثبت گفته می‌شوند.',
      'Malls, stations and amusement parks with their grade, audiences, photos and people; duplicates are named before saving.'),
    keywords: 'مکان مجتمع مترو شهربازی گرید مخاطب عکس تکراری venue mall metro grade audience photo duplicate',
    steps: [
      step(ANY.header, t('مکان تازه', 'A new venue'), t('نام، شهر و نوع را بنویسید؛ اگر شبیه مکانی ثبت‌شده باشد، پیش از ثبت نشانش می‌دهیم.', 'Write the name, city and type; if it looks like a recorded venue, it is shown before you save.')),
      step(undefined, t('کامل بودن', 'Completeness'), t('نوار «کامل بودن» می‌گوید هر مکان چه کم دارد — آدرس، تلفن، گرید، مخاطب یا عکس.', 'The completeness bar says what each venue lacks — address, phone, grade, a contact or a photo.')),
    ],
  },
  {
    id: 'site-projects', route: '^/sites/projects(/[^/]+)?$', path: '/sites/projects', permission: 'site.read', manual: 'Venues and rentals — «مکان‌ها و اجاره‌داری»',
    title: t('پروژه‌های استقرار', 'Deployment projects'),
    summary: t('یک استقرار در یک مکان، از بررسی و مذاکره تا قرارداد، نصب، بهره‌برداری، تسویه و عودت ودیعه.',
      'One placement in one venue, from evaluation and negotiation to contract, installation, operation, settlement and the deposit back.'),
    keywords: 'پروژه استقرار مذاکره قرارداد نصب پروموتر کانتر deployment negotiation contract installation promoter',
    steps: [
      step(ANY.workflow, t('گام بعدی', 'The next step'), t('دکمه‌های بالای پروژه گام بعدی‌اند؛ عدد قرمز کنار هر کدام یعنی چند پیش‌نیاز هنوز برقرار نیست.', 'The buttons above the project are its next steps; a red number beside one counts the prerequisites still missing.')),
      step(ANY.tabs, t('همه‌چیز در یک صفحه', 'Everything on one page'), t('مذاکره‌ها، قرارداد و تأییدها، نصب و نیروها، اجاره و پرداخت‌ها، و بستن پروژه — هر کدام یک زبانه.', 'Negotiations, contract and approvals, installation and staff, rent and payments, and closing — a tab each.')),
    ],
  },
  {
    id: 'site-rentals', route: '^/sites/rentals$', path: '/sites/rentals', permission: 'rental.read', manual: 'Venues and rentals — «مکان‌ها و اجاره‌داری»',
    title: t('اجاره‌داری', 'Rentals'),
    summary: t('اجاره، شارژ، ودیعه و جریمهٔ همهٔ مکان‌ها: نمای کلی، جدول اجاره‌داری و تقویم سررسیدها.',
      'Rent, service charges, deposits and penalties for every venue: an overview, the rental schedule and the due-date calendar.'),
    keywords: 'اجاره شارژ ودیعه سررسید معوق تقویم rent charge deposit due overdue calendar',
    steps: [
      step(ANY.tabs, t('سه نما', 'Three views'), t('نمای کلی برای امروز، جدول برای فیلتر و اکسل، تقویم برای ماه.', 'The overview for today, the schedule to filter and export, the calendar for the month.')),
    ],
  },
  {
    id: 'site-reminders', route: '^/sites/reminders$', path: '/sites/reminders', anyOf: ['rental.read', 'site.configure', 'venue.sms'], manual: 'Venues and rentals — «مکان‌ها و اجاره‌داری»',
    title: t('یادآوری‌ها و پیامک‌ها', 'Reminders and SMS'),
    summary: t('یادآوری‌هایی که فرستاده شد، به چه کسی و از چه راهی، و پیامک‌هایی که به مکان‌ها رفت با پاسخ سامانهٔ پیامک.',
      'The reminders sent, to whom and by which channel, and the texts sent to venues with the SMS provider\'s answer.'),
    keywords: 'یادآوری پیامک سررسید reminder sms notification',
    steps: [step(ANY.header, t('هر یادآوری یک بار', 'Each reminder once'), t('اجرای روزانه هر یادآوری را یک بار می‌فرستد؛ اجرای دوباره چیزی را تکرار نمی‌کند.', 'The daily run sends each reminder once; running it again repeats nothing.'))],
  },
  {
    id: 'site-reports', route: '^/sites/reports$', path: '/sites/reports', anyOf: ['venue.read', 'site.read', 'rental.read'], manual: 'Venues and rentals — «مکان‌ها و اجاره‌داری»',
    title: t('گزارش‌های مکان‌ها و اجاره‌داری', 'Venues and rentals reports'),
    summary: t('مکان‌ها به تفکیک استان، نوع و گرید؛ پروژه‌ها به تفکیک وضعیت؛ اجاره، پرداخت، ودیعه و جریان نقدی — هر ارز جدا.',
      'Venues by province, type and grade; projects by status; rent, payments, deposits and cash flow — each currency apart.'),
    keywords: 'گزارش مکان پروژه اجاره ودیعه report venue project rent deposit cash flow',
    steps: [step(ANY.tabs, t('سه گزارش', 'Three reports'), t('مکان‌ها، پروژه‌ها، و اجاره و مالی؛ هر ردیف به رکوردهایش می‌برد.', 'Venues, projects, and rentals and finance; each row leads to its records.'))],
  },
  {
    id: 'site-excel', route: '^/sites/excel$', path: '/sites/excel', anyOf: ['venue.read', 'site.read', 'rental.read'], manual: 'Venues and rentals — «مکان‌ها و اجاره‌داری»',
    title: t('ورود و خروج اکسل', 'Excel import and export'),
    summary: t('الگو را دریافت و پر کنید، بررسی کنید، سپس ثبت کنید؛ هر ردیف خطادار با دلیلش گفته می‌شود.',
      'Download and fill the template, check it, then save; every row with an error says why.'),
    keywords: 'اکسل ورود خروج الگو excel import export template',
    steps: [step(ANY.header, t('اول بررسی', 'Check first'), t('«بررسی» چیزی ثبت نمی‌کند؛ فقط می‌گوید هر ردیف چه می‌شود.', '“Check” saves nothing; it only says what each row would do.'))],
  },
  {
    id: 'site-settings', route: '^/sites/settings$', path: '/sites/settings', permission: 'site.configure', manual: 'Venues and rentals — «مکان‌ها و اجاره‌داری»',
    title: t('تنظیمات مکان‌ها و اجاره‌داری', 'Venues and rentals settings'),
    summary: t('فهرست‌های سازمان (نوع، گرید، مخاطب، مدل همکاری…) و قواعد اجاره‌داری: یادآوری‌ها، ماه ناقص، اضافه‌پرداخت، قالب‌های پیامک.',
      'The organisation\'s lists (type, grade, audience, cooperation model…) and the rentals\' rules: reminders, part-months, overpayment, SMS templates.'),
    keywords: 'تنظیمات فهرست یادآوری قالب پیامک settings list reminder template',
    steps: [step(ANY.tabs, t('فهرست‌ها و قواعد', 'Lists and rules'), t('گزینه‌ها کنار گذاشته می‌شوند، نه پاک؛ رکوردهای قدیمی معنایشان را نگه می‌دارند.', 'Options are retired, not deleted; old records keep their meaning.'))],
  },
  {
    id: 'install', route: '^/install$', path: '/install', manual: 'Installing the app',
    title: t('نصب هیوامیس', 'Installing Hivamis'),
    summary: t('هیوامیس را روی گوشی، تبلت یا رایانه مانند یک برنامه نصب کنید — از همان مرورگری که دارید.',
      'Install Hivamis on a phone, tablet or computer like an app — from the browser you already have.'),
    keywords: 'نصب برنامه گوشی آیفون اندروید ویندوز مک install app phone iphone android windows mac',
    steps: [
      step(ANY.header, t('یک کلیک یا چند گام', 'One click, or a few steps'), t('جایی که مرورگر اجازه دهد، دکمهٔ «نصب روی این دستگاه» همین‌جاست؛ در Safari و بقیه، گام‌های همان دستگاه را دنبال کنید.',
        'Where the browser allows it, “Install on this device” is right here; in Safari and the others, follow the steps for that device.')),
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
    id: 'sales-new', route: '^/sales/new', path: '/sales/new', permission: 'crm.lead.write', manual: 'Sales',
    title: t('ثبت مشتری تازه', 'A new customer'),
    summary: t('سه بخش کوتاه: مشتری کیست، با چه کسانی در تماسیم، و از کجا آمده است. با ثبت، پروندهٔ مشتری، مخاطب‌هایش و سرنخش با هم ساخته می‌شوند.',
      'Three short parts: who the customer is, whom you are in touch with, and where it came from. Saving makes the client, its contacts and its lead together.'),
    keywords: 'مشتری جدید مشتری تازه مخاطب new customer client contact',
    steps: [
      step('[data-tour="customer"]', t('مشتری', 'The customer'), t('نام شرکت یا برند و نوع کسب‌وکارش. اگر مشتری‌ای به همین نام ثبت شده باشد، پیوندش را می‌بینید تا دوباره ساخته نشود.',
        'The company or brand name and its line of business. If a customer by that name is already on file, its link is shown so it is not made twice.')),
      step('[data-tour="contacts"]', t('مخاطب‌ها', 'Contacts'), t('هر چند نفر که لازم است. نفر اول مخاطب اصلی است و شمارهٔ همراهش لازم است؛ اگر این شماره پیش‌تر ثبت شده باشد، پیش از ثبت گفته می‌شود.',
        'As many people as needed. The first is the main contact and needs a mobile number; if that number is already known, you are told before saving.')),
      step('[data-tour="source"]', t('از کجا آمده؟', 'Where it came from'), t('نوع منبع و بعد چه کسی یا چه راهی. بدون آن، دکمهٔ ثبت روشن نمی‌شود.',
        'The kind of source, then who or which channel. Without it the save button stays off.')),
    ],
  },
  {
    id: 'sales-journey', route: '^/sales/journey/', permission: 'crm.company.read', manual: 'Sales',
    title: t('مسیر فروش', 'The sales journey'),
    summary: t('یک مشتری از ثبت تا بریفی که برای بررسی فرستاده می‌شود، در چهار گام روی یک صفحه.',
      'One customer from registration to a brief sent for review, in four steps on one page.'),
    keywords: 'مسیر فروش پیگیری جلسه تماس بریف ارسال sales journey follow up meeting brief',
    steps: [
      step('[data-tour="journey"]', t('گام‌ها', 'The steps'), t('گام‌های انجام‌شده تیک دارند و گامی که اکنون نوبت آن است پررنگ است.',
        'Steps that are done are ticked, and the one to do now is in bold.')),
      step('[data-tour="follow-ups"]', t('پیگیری‌ها و جلسه‌ها', 'Follow-ups and meetings'), t('هر تماس، جلسه یا بازدید را با اینکه با چه کسی، کجا، چه گفته شد و پیگیری بعدی کی است ثبت کنید. همه زیر هم، تازه‌ترین بالا.',
        'Record each call, meeting or visit — with whom, where, what was said, and when to follow up. They are listed newest first.')),
      step('[data-tour="brief"]', t('فرصت فروش و بریف', 'The sale and its brief'), t('وقتی مشتری جدی شد، آن را واجد شرایط و بعد فرصت فروش کنید؛ سپس بریف را بنویسید: هدف، مخاطب، کار، خروجی‌ها، بودجه، مهلت و واحدها.',
        'When the customer is serious, qualify it and make it a sale; then write the brief: aim, audience, work, deliverables, budget, deadline and units.')),
      step('[data-tour="send"]', t('ارسال برای بررسی', 'Send for review'), t('بریف کامل به اکانت فرستاده می‌شود. اگر ناقص باشد، با توضیح برمی‌گردد و همین‌جا می‌بینید چه کسی و چرا.',
        'The finished brief goes to Account. If something is missing it comes back with a note, and you see here who sent it back and why.')),
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
    id: 'account-desk', route: '^/account/?$', path: '/account', permission: 'brief.read', manual: 'Account',
    title: t('میز اکانت', 'The account desk'),
    summary: t('هر بریفی که به اکانت رسیده و اینکه اکنون منتظر چیست: بررسی، کار در دست اکانت، نزد فروش و مشتری، یا برگشته به فروش.',
      'Every brief that has reached Account and what it waits for now: review, in Account\'s hands, with Sales and the client, or sent back to Sales.'),
    keywords: 'اکانت میز بریف پروپوزال account desk brief proposal',
    steps: [
      step('[data-tour="account-summary"]', t('در یک جمله', 'In one sentence'), t('چند بریف برای بررسی، چندتا در دست اکانت و چندتا نزد فروش و مشتری است.',
        'How many briefs await review, how many are in Account\'s hands, and how many are with Sales and the client.')),
      step('[data-tour="account-groups"]', t('گروه‌ها', 'Groups'), t('هر بریف یک جمله دارد که می‌گوید اکنون منتظر چیست. روی آن بزنید تا مسیرش باز شود.',
        'Each brief has a sentence saying what it waits for now. Click it to open its journey.')),
    ],
  },
  {
    id: 'account-journey', route: '^/account/journey/', permission: 'brief.read', manual: 'Account',
    title: t('مسیر اکانت', 'The account journey'),
    summary: t('یک بریف از بررسی تا تحویل پروپوزال به فروش، در شش گام روی یک صفحه.',
      'One brief from review to handing the proposal to Sales, in six steps on one page.'),
    keywords: 'مسیر اکانت سفارش واحد پروژه پروپوزال قیمت account journey work order unit project proposal pricing',
    steps: [
      step('[data-tour="journey"]', t('گام‌ها', 'The steps'), t('گام‌های انجام‌شده تیک دارند و گامی که اکنون نوبت آن است پررنگ است.',
        'Steps that are done are ticked, and the one to do now is in bold.')),
      step('[data-tour="brief-review"]', t('بررسی بریف', 'Reviewing the brief'), t('آنچه فروش گفته و آنچه کم است. تأیید کنید، یا با توضیح دقیق به فروش برگردانید.',
        'What Sales said and what is missing. Approve it, or send it back to Sales with a clear reason.')),
      step('[data-tour="project-setup"]', t('پروژه و پروپوزال', 'Project and proposal'), t('هر دو با یک دکمه از روی بریف باز می‌شوند؛ نام، بودجه و تاریخ‌ها از بریف پر شده‌اند.',
        'Both open with one button from the brief; the name, budget and dates come filled from it.')),
      step('[data-tour="unit-orders"]', t('سفارش به واحدها', 'Ordering each unit'), t('برای هر واحد یک سفارش با شرح کار، هدف، خروجی، قالب، مهلت و مسئول. «صدور سفارش» آن را به واحد می‌رساند.',
        'One order per unit, with the work, its purpose, the output, its format, the deadline and who is responsible. Issuing it sends it to the unit.')),
      step('[data-tour="unit-outputs"]', t('خروجی و هزینهٔ واحدها', 'What units hand in'), t('خروجی تحویل‌شده را ببینید و بپذیرید یا با توضیح برگردانید؛ هزینهٔ اعلام‌شدهٔ هر واحد کنارش است.',
        'Look at what was handed in and accept it or send it back with a reason; each unit\'s declared cost is beside it.')),
      step('[data-tour="proposal-finish"]', t('یکپارچه‌سازی، قیمت و QC نهایی', 'Integrate, price, final QC'), t('قیمت تمام‌شده، قیمت فروش، تأیید قیمت و QC نهایی در یک نگاه، و دکمهٔ گام بعد.',
        'The cost, the sale price, its approval and the final QC at a glance, with the button for the next step.')),
      step('[data-tour="deliver"]', t('تحویل به فروش', 'Hand to Sales'), t('پروپوزال تأییدشده به فروش می‌رود؛ پاسخ مشتری همین‌جا دیده می‌شود.',
        'The approved proposal goes to Sales; the client\'s answer shows here.')),
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
      step('[data-tour="project-glance"]', t('پروژه در یک نگاه', 'The project at a glance'), t('وضعیت و سلامت، آنچه انجام شده، آنچه در جریان است و با چه کسی، گام‌های بعد با مهلتشان، آنچه گیر کرده یا دیر است، و مسئول هر واحد.',
        'Its status and health, what is done, what is in progress and with whom, the next steps with their deadlines, what is stuck or late, and who is responsible in each unit.')),
      step('[data-tour="start-authorization"]', t('مجوز شروع کار', 'The go-ahead'), t('یکی از سه مبنا را برگزینید — قرارداد امضاشده، سفارش رسمی مشتری، یا دستور اجرا با فاکتور — و سندش را بنویسید؛ بی‌قرارداد هم می‌شود شروع کرد.',
        'Choose one of three bases — a signed contract, the client\'s official order, or an execution order with an invoice — and name its document; work can start without a contract.')),
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
      step(undefined, t('دو تصمیم', 'Two decisions'), t('«تأیید و ارسال» یا «برگرداندن برای اصلاح». برگرداندن توضیح روشن می‌خواهد — دلیل‌های رایج یک کلیک فاصله دارند — و خودش اصلاحیه می‌سازد، با توضیح شما به‌عنوان اصلاح مورد انتظار. یادداشت‌های روی فایل را تیک بزنید تا دقیق برسد.',
        'Approve and forward, or send back for correction. Sending back needs a clear reason — the common ones are a click away — and raises the revision itself, carrying your reason as the expected correction. Tick the notes on the file so it arrives precise.')),
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
    id: 'commercial-desk', route: '^/commercial/?$', path: '/commercial', manual: 'Finance',
    title: t('میز قرارداد و مالی', 'The contracts and finance desk'),
    summary: t('قراردادهای فروش، پیش‌فاکتورها و فاکتورها، پروژه‌های منتظر مجوز شروع و درخواست‌های خرید — هر کدام با یک جمله دربارهٔ آنچه منتظرش است.',
      'Sales contracts, proformas and invoices, projects waiting for their go-ahead, and purchase requests — each with one sentence on what it waits for.'),
    keywords: 'قرارداد فاکتور پیش‌فاکتور پرداخت مجوز شروع خرید تأمین contract invoice proforma payment go-ahead purchase',
    steps: [
      step('[data-tour="commercial-summary"]', t('در یک جمله', 'In one sentence'), t('چند قرارداد در جریان است، چند سند مالی باز و چندتا سررسیدگذشته، چند پروژه منتظر مجوز و چند درخواست خرید.',
        'How many contracts are under way, how many financial documents are open and how many are overdue, how many projects wait for a go-ahead and how many purchases wait.')),
      step('[data-tour="commercial-contracts"]', t('قراردادهای فروش', 'Sales contracts'), t('هر قرارداد روی مسیرش؛ در بررسی حقوقی، تأیید و بازگرداندن با توضیح کنار هم‌اند.',
        'Each contract on its road; in legal review, approving and sending back with a reason sit side by side.')),
      step('[data-tour="commercial-invoices"]', t('پیش‌فاکتورها و فاکتورها', 'Proformas and invoices'), t('از پیش‌نویس تا پرداخت؛ سررسیدگذشته‌ها قرمزند.', 'From draft to paid; overdue ones are in red.')),
      step('[data-tour="commercial-go-ahead"]', t('مجوز شروع', 'Go-ahead'), t('پروژه با قرارداد، سفارش رسمی مشتری، یا دستور اجرا با فاکتور شروع می‌شود؛ مبنا را در صفحهٔ پروژه ثبت کنید.',
        'A project starts on a contract, the client\'s official order, or an execution order with an invoice; record the basis on the project\'s page.')),
      step('[data-tour="commercial-purchases"]', t('خرید و تأمین بیرونی', 'Purchases'), t('درخواست‌هایی که منتظر تصمیم یا تأمین‌اند، با دکمهٔ تصمیم.', 'Requests waiting for a decision or to be fulfilled, with the decision\'s buttons.')),
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
