# User guide

Hivamis (هیوامیس) follows the agency's own process. If you know your role in Doc_H, the system will feel
familiar — and it will stop you when a step is skipped.

## Signing in

Use your organisational email. What you see is decided by your role: navigation, buttons and
report tabs all appear only where you hold the permission. If a screen seems missing, it is
because the process assigns that step to someone else — or because the system administrator has
not granted it to your role.

**Who may do what («مدیریت سیستم ← نقش‌ها و دسترسی‌ها»).** The managing director, the deputy, the
system administrator and the account manager hold the whole system. Every other role holds exactly
what the system administrator ticks for it, grouped by area — sales, projects, finance and so on.
A role nobody has reviewed yet shows **پیش‌فرض — بازبینی نشده** and keeps Doc_H's default until the
administrator approves or changes it; **تأیید** records the approval under their name, with an
optional note, and **سابقه** shows who granted what and when. A change takes effect at once for
everyone holding the role: what was taken away disappears from their screens on their next click.
Full access is not exemption: the process rules (a project without authorization, a delivery without
QC) still stop everyone, and the managing director's governed exception remains the way past one.

**Other ways in.** Where the installation offers them, the sign-in page also takes a **mobile
number** — a six-digit code is texted to it — and **Google** («ورود با حساب گوگل»). The mobile must
first be verified on your own page; a Google account whose address is your work email is linked the
first time you use it. Someone who has no account yet can **ask to join** («درخواست عضویت») with a
mobile or a Google account; the system administrator approves the request under Admin → Users,
choosing the unit and roles, and nothing is granted before that.

**Your page («صفحهٔ من»)** — click your name at the bottom of the menu. It lists your ways in: a
password (set a first one if you joined with a mobile or Google, or change it), a verified mobile, a
linked Google account — at least one always stays — and the devices you are signed in on, each of
which you can sign out. **Colleagues («همکاران»)** lists everyone; each person has a page with their
unit, roles, email and, where you may see them, their open tasks and projects. Mobile numbers and last
sign-ins are shown only to the person themselves and to the administrators of users.

**Language.** The **EN** / **فا** button at the top switches the whole interface between Persian and
English; the page reloads in the other language and remembers the choice, here and on your next
device. In English, numbers use Latin digits, amounts read "Rials", dates are Gregorian and date
fields use the browser's calendar; the stored dates are the same either way. Names of people,
clients and projects stay as they were written, and documents — PDFs, emails, certificates — keep the
language they were issued in.

---

## The dashboard — «داشبورد»

The first page after signing in. Four tiles count what is yours, and each opens the list behind it:
**وظایف باز من**, **وظایف تاخیردار** (past their due date), **در انتظار تأیید** (forms waiting for your
decision) and **نقض روند** (your deadlines broken or about to be). Beside your tasks are
**اصلاحیه‌ها** — revisions assigned to you or your unit — and **روندهای من**, the deadline clocks you
own. **پروژه‌های من** has two halves: **در حال اجرا (فعال)**, the projects you run or work on, and
**فروش (فرصت فروش)**, the opportunities you own that are not yet won or lost (for those who see the
sales pipeline).

## Your queue — «کارهای من»

Everything that sits with you, in one list: tasks assigned to you, work orders you own, QC
waiting for your level, forms awaiting your approval, revisions assigned to you, and — if you
issue work orders — clarification requests from the units. Ordered by urgency: a breached SLA
first, then whatever runs out soonest, then by due date. Each row carries its own actions, so
you accept, submit or send to QC from the list. Filter by kind with the chips above it.

**Live.** The small dot on the bell is green while the page is live: a record moved by someone
else — an order accepted, a deliverable through QC, an invoice issued — appears on the screen you
have open within a couple of seconds, and a new notification at once. Amber means connecting; grey
means the live connection is not available, and the page refreshes itself every minute as before.

**In your messenger.** **پیام‌رسان** at the foot of the sidebar links your messenger chat: press
**اتصال پیام‌رسان**, and send the code it shows to the organisation's bot. From then on the
notifications that need you — an approval waiting, an SLA about to be missed or missed, a client's
message, a contract signed — reach you there too. An approval request comes with «تأیید» and «رد»:
approving from the chat is exactly approving in the app — the same rules decide whether you may,
and the record says you did it, from the messenger. «رد» asks for the reason first. **جدا کردن**
disconnects the chat. On an installation without a bot, the same window shows a practice chat.

## Sales

**Your loop: acquire → qualify → brief → present → close.**

1. **Leads** — record a new lead, then move it Contact → Qualify. Converting creates the
   opportunity and, if needed, the customer record. A lead needs its **تلفن همراه**; type it any
   way (۰۹۱۲…, +98…, with spaces) and it is kept as 09xxxxxxxxx. If the number is already a lead or
   a client's contact, the form says who has it before you save — tick that it is a new lead to
   register it anyway. Its **منبع ورودی** takes two clicks: the kind — **تیم فروش**, **بازاریابان**,
   **پرسنل شرکت**, **تماس مستقیم**, **شرکت‌های همکار** — then who or what: the seller, the marketer,
   the colleague outside sales, the channel (تلفن، نمایشگاه، رویداد، کمپین) or the partner company.
   A partner not on the list yet is added as you type its name; marketers are added by the system
   administrator under **مدیریت سیستم ← منابع سرنخ**.
2. **Briefs** — write the sales brief and submit it to Account. The brief shows a completeness
   score; anything below 100% will be returned to you, so fill in objective, audience, scope,
   deliverables, budget and deadline before submitting.
3. **Proposals** — once Account delivers a proposal, present it and record the outcome:
   approved, revision requested, or rejected. A revision request must carry the client's exact
   wording — Account needs it to scope the rework.
   Better still, let the client answer themselves: the proposal page's **تأیید مشتری** card sends
   the client a link to the proposal as presented — its text and price, and the deck you attach —
   and their approval or change request is recorded, and applied, as theirs (see below).

**What you cannot do, by design:** set a sale price, authorise a project, or perform Account QC.
Doc_H §2 separates these loops, and the permission model enforces it.

---

## Account

**Your loop: receive brief → coordinate → integrate → price → deliver → run the project.**

1. **Brief control** — open the brief and review it. If it is incomplete, use *بازگشت بریف ناقص*
   with a reason; it goes back to Sales and the return is counted. Approve only a complete brief —
   the system will refuse otherwise.
2. **Project and orders** — create the project, define scope and deliverables, set RACI, and issue
   a work order to each unit. Every order must carry all nine mandatory elements; an incomplete
   order cannot be issued.
3. **Account QC** — as units deliver, record QC. A failed review **automatically raises a
   revision** carrying your findings as the required correction. Nothing reaches the client
   without a passing Account QC.
4. **Integration and pricing** — once every unit output is in and every cost is declared,
   integrate, then set the sale price with a written rationale. Someone with approval authority
   must confirm it — you cannot approve your own pricing.
5. **Execution** — after the contract is authorised, run the project from Project 360: tasks,
   traffic, risks, issues, change requests, status reports, and the closure checklist.
6. **Client approval that holds up later** — on Project 360, a delivered deliverable has a
   **تأیید مشتری** button. Choose the client contact and the files (upload them there if they are
   not attached yet) and send. The client gets a link to a page with the files, downloads each one,
   types their name, and — when the organisation's email is set up — enters a code sent to their
   own address; then approves or says what to change. The deliverable moves to accepted, or back
   to revision with their words as the reason. What is kept: who decided, when, from which
   address, and the fingerprint (SHA-256) of exactly the files they received. **بررسی دوباره**
   recomputes every fingerprint and says whether anything has changed since; **گواهی PDF** prints
   it all for a dispute — «این آن چیزی نیست که تأیید کردم» becomes a question with an answer. A
   file changed after sending is not served as the approved one. If email is not set up, the link
   is shown to you once to pass on, and the record says the client was verified by the link alone.
7. **The client portal** — on the client's page, **پورتال مشتری** invites a contact (they need an
   email; it becomes their sign-in). They set their own password from the invitation and then see
   their projects: progress against milestones, deliverables («در حال تهیه» until delivered, then
   waiting for their opinion, then approved), the approvals waiting for them — which they decide
   right there, the record saying it was their own account — the weekly reports, their invoices,
   and the files you choose to share. On Project 360 the **مشتری** tab lists every file of the
   project with a **نمایش در پورتال** box (nothing is shown until you tick it) and the conversation
   with the client; when they write, the account owner is notified. **دعوت دوباره** is also how a
   forgotten password is reset; **غیرفعال** closes their access at once. The client never sees
   cost, margin, budgets or who on your side is doing what.
8. **The client's brand library** — on the client's page, **کتابخانهٔ برند** holds their colours
   (click one to copy its code), typefaces, notes such as logo clear space, and their brand files
   by role: logos, font files, the identity guide. A font file is shown set in itself, and a
   typeface listed without a file is flagged. For print work, give each colour its CMYK too —
   without it, the brand check cannot judge a CMYK file's colours. Unit and account managers
   (**brand.manage**) edit it;
   everyone who reads files sees it. A new version of a file you shared in the portal reaches the
   client only when you share it; until then they keep the one they had.

---

**The weekly client report.** Write the status report as usual; every Saturday morning the
system sends the week's report to the client's primary contact as a PDF built for them — the
financial status and internal decisions are left out, and the strip above the preview says so.
*ارسال برای مشتری* on the project page previews that copy and sends it now. If you did not file a
report that week, you get a warning on Saturday instead of the client getting nothing.


**Brief quality, not just brief completeness.** A brief could always be «کامل» with one word in
every field. The brief page now scores how *specific* it is: a goal with no number, an audience
of «همه», a scope that is one sentence, deliverables with no count, success with no measure —
each is named, and vague words («جذاب»، «مناسب»، «در صورت امکان») are quoted back so it is clear
what to replace. The card says which field to fix first. Beside it is this organisation's own
evidence: how often briefs at each level were sent back to Sales, and the closest brief that
became a won deal, showing what the field you need to fix looked like when it worked. When there
are too few won deals to compare against, the card says so instead of averaging two.
## Execution units (Strategy, Creative, Media, Digital)

**Your loop: accept → plan → execute → unit QC → declare cost → deliver.**

1. **Work orders** — accept within four working hours, or raise a clarification. The acceptance
   clock is visible and starts the moment the order is issued.
2. **Tasks** — accept, start, submit. If you will miss a deadline, report it *before* the deadline
   using the blocker action — Doc_H §11 requires the warning in advance.
3. **Unit QC** — record your own QC before handing anything to Account. You cannot submit a work
   order without it.
4. **Cost** — declare the actual cost. You cannot submit without it, and you cannot set the sale
   price: that belongs to the pricing process (Doc_H §12).
5. **Revisions** — when Account rejects an output, the revision arrives with the reason and the
   expected correction. Work it, resubmit, and it returns to QC.
6. **Marks on the file itself** — **یادداشت روی فایل** (on the project's deliverables, in the QC
   dialog, and beside each revision) opens the deliverable's images, videos and PDFs. Click an
   image to pin a note; pause a video and note the moment; drag across a PDF page to mark a region.
   A reviewer who fails a QC ticks the notes it carries: the revision's «اصلاح مورد انتظار» then
   lists each one — which file, which page or second or pin — instead of a paragraph to decode.
   When a note is fixed, mark it **رفع شد**.
7. **New versions, not new files** — when you rework a file, use **نسخهٔ جدید** beside it (on the
   project's files, in the annotator, in a version history) instead of uploading it again. The new
   version takes its place everywhere — the deliverable, the contract, the approvals — and the old
   one is kept. **نسخه‌ها** lists every version with who uploaded it, its size in pixels or pages,
   its colour space (a CMYK file is print artwork), and puts any two side by side — images can be
   laid over each other with a slider — marking what changed. In the annotator an older version
   keeps its notes, shown read-only, so you can check each one against the new version; new notes
   go on the current version only.
8. **The brand check** — before a person looks, the machine compares each image's main colours and
   each PDF's colours and fonts with the client's brand library. Stage zero warns when a tenth of
   an image is in colours the brand doesn't have, when a PDF uses a typeface outside the brand, and
   notes a PDF colour that is *nearly* the brand's (usually picked by eye). In the annotator,
   **بررسی برند** shows the file's colours as swatches, each named against the brand. It advises:
   a photo or a chart has colours no palette lists, and you judge.

---

**Suppliers and freelancers («تأمین‌کنندگان»).** Every external partner has a page: overall
rating and the four D33 dimensions, on-time fulfilment, whether evaluators would work with them
again, what is currently on their plate, and a timeline of requests and evaluations. The panel at
the top of the list ranks who to send the next request to, by that evidence — a supplier with no
history ranks by free capacity alone, so a proven one always comes first.

**Log your hours.** On a task, «ثبت زمان» takes a number, a day and an optional note; or type the
hours once when you submit the task. The card shows the estimate beside the actual. Your unit's
declared cost is compared with these hours on the «دقت برآورد» report — that is the Doc_H
cost-accuracy KPI, and after a few months it is how quotes get sharper.


**Declaring a cost, with the history beside it.** When you enter the cost of a work order, the
dialog compares it with the finished orders of your own unit that look most like this one — same
kind of output, similar size, similar description — and shows what they were declared at, what
the hours logged on them actually cost, and how many working days they took. If your figure is
below three-quarters of them, it says so in plain words, and your unit manager is told while the
price can still change. If your unit has been declaring low as a habit, the dialog says by how
much. Nothing is blocked: the declaration is yours. And when there are too few finished orders to
compare against, the dialog says that instead of inventing a range.

**Before a deliverable reaches Account, the machine checks the obvious.** When you hand a
deliverable over, it is checked against its work order: every format the order's format field
asks for is attached (source files count if they are inside a ZIP — the system reads the list of
files in it), no file is empty, and images are the pixel size the order spelled out. Any of those
missing stops the handover, with the reason in words; fix it and hand over again. Other things
only warn and never stop you: fewer files than the order counted, a file name that looks like a
draft, something that sounds like the project's out-of-scope list. **بررسی دوباره** runs the check
before you hand over. Every result also lists what the machine did *not* look at — the content,
the brief, the brand — because that is still the reviewer's job.
**Media buying (the project's «رسانه» tab — media unit and Account).** Record each buy as a media
order: the vendor, the channel and placement, the flight, and the deal — a commission deducted from
the gross, or a markup on the net. The order shows what the client pays, what passes through to the
vendor, and the agency's share, before you save. Book it with the vendor; when it has run, confirm
delivery with its proof (the airing certificate, the installation photo). Finance bills the client
on a media invoice that lists the vendor's net and the agency's commission on separate lines,
records the vendor's invoice against the order — a difference has to be explained before the order
can be reconciled — and marks a payment to the vendor against its order. The vendor's net is never
the agency's revenue: projects earn the commission when the media runs. **گزارش‌ها ← رسانه** shows
billings, pass-through and the agency's share by channel and vendor, and four lists to clear: ran
and not billed, flight over without proof, awaiting the vendor's invoice, and invoices that differ.

## Finance

- **Invoices and payments** — issue proformas and invoices; totals are computed server-side.
  Recording a receipt rolls the invoice to partially paid or paid automatically.
- **Settlement** — settling a project computes invoiced, received and balance, and ticks the
  financial condition on the closure checklist.
- **Project financials** — Project 360 → Financial shows budget vs actual cost vs revenue, margin,
  and cost broken down by unit, all from declared costs.
- **Other currencies** — **مالی ← نرخ ارز** holds each currency's rate to the rial, by date: record
  the day's rate, or paste a history (one «date,currency,rate» per line, Jalali or Gregorian). An
  invoice, receipt, contract or external cost written in dollars, dirhams or euros is converted at
  the rate in force on its own day, and keeps that rate for good — correcting a rate later does
  not move anything already recorded, and the correction asks for a reason. If there is no rate for
  that day, or the last one is more than a week old, the system refuses and says which rate it
  needs rather than using an old one. A receipt against a dollar invoice can be entered in dollars,
  or in rials at that day's rate; the invoice is settled when its dollars are. **اثر نرخ ارز**
  shows what the rate has done: the gain or loss on receipts already collected, what open dollar
  invoices would be worth at today's rate, and each dollar contract as booked and as it stands.
- **E-invoicing (سامانهٔ مؤدیان)** — the **سامانهٔ مؤدیان** tab holds the organisation's fiscal
  memory id and identifiers, and lists every issued invoice the tax authority has not yet accepted.
  Open one to see what would stop it being accepted — a client without a postal code or national
  ID (fill them in right there), lines that do not add up to the total — and report it. Once
  accepted, an invoice can only be corrected or cancelled with a new report that names the accepted
  one; and an accepted invoice is cancelled at the authority first, then here — the system will not
  let the books say a sale never happened while the tax authority still holds it. Each invoice row
  in the financial documents list shows where it stands.
- **Export to the accounting package (خروجی حسابداری)** — the ledger stays in your accounting
  software; this tab writes its vouchers so nothing is typed in twice. Under **سرفصل‌ها و قالب فایل**
  the finance manager enters the code of each account in your own chart (receivables, revenue, VAT,
  bank, cash, …), a detail code for each client, and the file's columns — in the order and with the
  headings your software's import screen expects, dates in Jalali or Gregorian. Pick a date and the
  tab shows every invoice, receipt and payment not yet exported up to it, voucher by voucher; it
  will not export while an account used has no code, and it tells you which clients have no detail
  code. **ثبت خروجی و دریافت فایل** numbers the batch and downloads the file; what it carried is
  never exported again, and the file of any past batch can be downloaded again, unchanged. An
  invoice cancelled after it was exported comes back in the next batch as its reversal. Money
  received against a proforma is exported as an advance from the client; a payment to a media
  vendor goes to the media clearing account, not to project cost.
- **Revenue as it is earned** — a project's **مالی** tab shows **شناسایی درآمد**: how much of the
  work is done, how much of the contract that has earned, how much has been billed, and the gap —
  «کار انجام‌شدهٔ صورت‌حساب‌نشده» when the work is ahead of the invoices, «پیش‌صورت‌حساب» when the
  invoices are ahead of the work. Choose how progress is measured: by milestones (give each a
  share of the contract and mark it «انجام شد» on the overview when it is), by hours logged against
  the tasks' estimates, or by cost incurred against cost declared. **گزارش‌ها ← درآمد و کار در
  جریان** sets each month's earned margin beside its billing margin — the month an invoice went out
  no longer looks like the month the work was done. At month end, **بستن** freezes the month; a
  late timesheet or a milestone dated back into it then shows in the next open month instead of
  changing a month already reported.

---

## Legal

Drive the contract through drafting → legal review → approval → signature → registration.
Registering a contract sets the project's revenue baseline. Amendments update the contract value
and the project end date together.

**Electronic signature.** When a contract is «در انتظار امضا», the **امضای الکترونیکی** card on
the contract sends one of its PDFs to be signed — first by the client contact you choose, then by
the organisation's signatory. Each gets a signing link; you see who has signed, when, from which
address and with which certificate. When both have signed, the signed PDF is attached to the
contract and the contract becomes «امضاشده» by itself. While it is out, the signature cannot also
be recorded by hand — **ابطال** it first (for example, if the wrong file went). If the client
declines, their reason is shown and the contract stays where it was. On an installation not yet
connected to a signature provider, the card says «محیط آزمایشی»: everything works the same, but
nothing signed there is a legal signature, and the signed file says so on its last page.

---

## PMO / Operations

- **Traffic** — capacity versus committed hours per person, with over-allocation flagged. Each
  person is measured on their own working calendar and leave, and capacity is the smaller of
  what their calendar holds and what their contract says. Only what is *left* of a task counts:
  hours already logged are spent. The numbers are the ones the assignment suggestion uses, so
  the board and the suggestion cannot disagree.
- **Assigning a task** — «تخصیص» asks who, beside each candidate's free capacity: what they are
  at now, what this task would take them to, when they would actually finish it on their own
  calendar after the work they already hold, and their delivery history. Choosing someone
  already full is allowed — the warning is there to be read, not to block — but a task can no
  longer be dispatched to nobody, because the four-hour acceptance clock it starts has to belong
  to someone.
- **Reports → SLA** — compliance per policy, and above it the deadlines *predicted* to be
  missed: for each open clock, the share of comparable past deadlines — same policy, same unit,
  still open at the same point — that went on to breach, raised when the owner is over capacity.
  A row marked «پیش از آستانهٔ ثابت» is one the fixed warning threshold cannot see yet. Each row
  shows its evidence: how many comparable deadlines, how many went over, and the median they
  took. With no history the row says so instead of inventing a number.
- **Reports → Units** — on-time delivery, first pass yield and revision rate per unit.
- **Reports → Data quality** — records that will silently break the process: an ACTIVE project
  with no authorisation, a task with no source document, overdue revisions. Treat CRITICAL
  findings as incidents.
- **Lessons learned** — record them at closure; they satisfy one of the eight closure conditions.
- **Meetings → minutes → tasks** — a project's «حاکمیت» tab lists its meetings; one without
  minutes is flagged, and after two days it appears in Data quality. «ثبت صورتجلسه» takes the
  notes as they were written — one decision or action per line, the owner's name and the deadline
  as they were said («تا شنبه»، «ظرف ۳ روز»، «۱۲ مهر») — and drafts the minutes: decisions, and
  actions with an owner, a date and a unit. Nothing is saved until you confirm. Where a first name
  fits two people, the draft asks which one rather than guessing; lines that promise something
  with no owner and no date are listed separately, because those are the ones that stay verbal.
  Each confirmed action becomes a task on the project, sourced to the minutes, and its acceptance
  clock starts for the owner, who is told in the app. Where a transcription service is configured, meeting audio can be
  uploaded instead of notes — read the transcript before drafting.

---

**Being told before, not after.** «کارهای من» shows «احتمال نقض ٪…» beside a deadline heading
for a breach, and the owner is emailed once when it passes 70 %. The fixed threshold still
fires at three-quarters of the budget; the prediction is what arrives earlier.

**Schedule and critical path («زمان‌بندی» on a project).** Link tasks — «ب» after «الف» — and
the chart shows every task's earliest and latest dates, its float (the lighter stretch it can
slide into), and in red the critical chain: a task there that slips an hour moves the project's
end. A task without an estimate is drawn as one working day and marked as assumed; give it an
estimate and the chart tightens. The projected end is compared with the plan as a slip in
working hours.

**Delivery forecast (below the chart).** One projected end is a promise nobody can keep. The
forecast runs the same task chain a few thousand times, each time stretching every estimate by
a ratio drawn from how the same unit's finished tasks actually went against their estimates
(the time logged on them — #14), and reports three dates: the 50 % date, the 85 % date (the safe
commitment) and the 95 % date, with the probability of meeting the plan. The bars show where the
runs landed. With too little logged history the forecast says so and uses a mild default
distribution; log time on tasks and it sharpens.

## Management

**Reports → Executive control tower** answers the questions Doc_H asks of management: what is
late, what is at risk, which projects are unhealthy, where margin is thin, what is awaiting
approval, and where money is stuck.

Your two gates:
- **Project authorisation** — no project enters execution without a contract, an approved
  official order, or an approved invoiced-execution order.
- **Pricing approval** — the sale price needs your confirmation, and it cannot be the same person
  who set it.

---

**Process discovery («کشف فرآیند» under Reports).** Pick an entity and see the process as it is
actually run: every move that has happened, how often, and how long cases waited before it —
laid against the process as declared. Three things to look at: the declared paths nobody walks,
the loops (returns, rework, rejections) and where the waiting concentrates. This is the report
that says "the process you wrote and the process you run part ways here".

**Trying a rule before changing it («آزمایشگاه قانون» under Admin).** Untick a guard on a
transition, change its required permission, or add or remove a permission on a role — and run it
against the history. You get the past moves that would now be blocked and the past blocked
attempts that would now go through, each with a date and a reason, plus the assumptions the
simulation makes. Nothing changes; the numbers are the argument for or against changing it.

**Working calendars («تقویم کاری» under Admin).** Each unit can keep its own working days and
hours — a production unit that works Thursdays, a shift unit with different hours — and each
person their own, plus leaves. Blank means "same as the level above". Deadlines are computed in
the hours of whoever holds them: a clock owned by someone on leave does not run.

**Unit colours («رنگ واحدها» under Admin).** Every unit appears as a coloured tag — in work-order,
task, deliverable and revision tables, the traffic board, the unit reports and the user list. Each
unit starts in a colour of its own; the system administrator changes it with one click on a swatch,
or picks any colour by hand, and **پیش‌فرض** returns it to the default. The tag's text turns black or
white by itself, so every colour stays legible. The change is recorded in the audit trail, and
everyone sees it the next time their page loads its units (at most five minutes).


**Asking the numbers («پرسش از داده‌ها» under Reports).** Type the question as you would ask it —
«حاشیه سود پروژه‌های واحد رسانه در سه ماه گذشته چقدر بوده؟», «کدام واحد بیشترین اصلاحیه را
داشته؟», «ساعات ثبت‌شدهٔ من در این ماه». The answer is one of the defined metrics, with the same
definition and the same number as the report tabs, and shows how it understood you: the metric,
the unit or client or person, the exact dates of the window. If that is not what you meant,
correct it with the selectors under the answer instead of rephrasing. Read two things every time:
the yellow line, if there is one, names the part of your question that was **not** applied; and
«بر پایهٔ … رکورد» lists the records the number is made of. When a name fits two people or two
clients it asks which; when a question matches no metric it says so and offers the ones that
exist, rather than guessing. It cannot show you more than your role can: a margin needs finance
access, a colleague's personal numbers need management access (your own you can always ask), and
cost history is your own unit's unless you price.

**Connecting other systems (مدیریت ← یکپارچه‌سازی).** An **API key** lets another system — the
accounting package, a reporting tool, a messenger bot — use Hiva as you, limited to the
permissions you tick, with its own requests-per-minute budget. The key is shown once; copy it into
the other system then, because only a fingerprint of it is kept. A key can never do more than you
can, never manage users, roles, keys or exceptions, and stops working the moment you revoke it or
your account is deactivated. A **webhook** tells another system, within about a minute, when
something moves — an invoice issued, a project activated — for the kinds of records you may see.
It sends which record and which move, never the record's contents, signed so the receiver can
prove the message is Hiva's. «آزمایش» sends a test; «تحویل‌ها» shows what was delivered, what is
waiting and what failed, and can send any of it again. A receiver that keeps failing is switched
off and you are told.

**Security alerts (مدیریت → هشدارهای امنیتی).** Every quarter-hour the system reads the audit
trail and raises what does not look like its usual self: exports at night from someone who never
works at night, a burst of downloads far beyond a person's own usual day, exports from projects a
person has no part in, a run of refused permissions, many failed logins from one address, a
stolen session. Each alert shows its evidence — today's count beside the person's usual day — so
you judge a case, not a score. Nothing is locked automatically. **بررسی کردم** records that you
looked; **مشکلی نبود** needs a written reason. You never review an alert about yourself, and the
person an alert concerns is not notified of it.
## Forms

**فرم‌ها** holds all 130 Doc_H forms. Each shows its route (from which unit to which), its
approver, its SLA, and the process it triggers. You can only submit forms your unit owns — the
rest are visible so you can see the shape of the process.

*در انتظار تأیید من* is your approval inbox. You cannot approve a form you submitted yourself.

**Forms where you are working.** You rarely need the catalogue. Every record's page — a project, an
opportunity, a client, a brief, a proposal, a contract, a work order, a task, a change request —
shows **فرم‌های مرتبط** under its title: the forms about that kind of record that your unit sends,
the ones its current stage calls for first (highlighted). A click opens the form with the record — and
its project, client, contract — already filled in; a ✓ marks a form already sent for this record.
The **+** at the top of every page lists the forms you send most, one click from anywhere.

---

**Who has to approve this depends on what you typed.** The approver line at the top of a form
updates as you fill it in: price a job below cost and the CEO joins; put a contract over the
organisation's threshold and Legal does. Each addition names the rule that caused it, in the
sentence a manager wrote — and the thresholds you have *not* crossed are listed under it, so a
limit is visible before you hit it. The approver reviewing the form later sees the same
sentences. Administrators edit the rules in **مدیریت → مسیریابی فرم‌ها**; the thresholds shipped
with the system are defaults, not Doc_H law, and changing them mints a new version of the form
definition so anything already filed keeps the rules it was judged under.

**Some forms are approved in stages.** Doc_H's resource request says «تأیید مدیر واحد و
مدیریت» — two signatures, in order — and forms like it now show their chain before you submit:
«۱. تأیید مدیر واحد ← ۲. تأیید مدیریت». Only the stage that is actually waiting is notified, so
the second approver hears about the form when it is their turn and not before. A stage can ask
for more than one signature («۲ تأیید از ۳»): two *different* people must approve, and nobody
can make up the numbers alone. A rejection or a return ends the chain wherever it stands, and
the reviewer sees the whole ladder — who has signed, who is next, and where it is now.

---

**Building a form (مدیریت → طراح فرم).** Fields are added, reordered, reworded and removed on
the left while the real form draws itself on the right — the preview is the same component the
person filling it will use, not a picture of it. Saving mints a new version, so the two hundred
forms already filed keep the fields they were filled with. Fields the process depends on — Doc_H's
nine order elements, the keys a form's record-creating handler reads — are marked «الزام فرآیند»
and cannot be removed or retyped; everything else is yours. **فرم تازه** adds a form of your own,
outside the Doc_H catalogue and numbered from ۱۰۰۰, which no future update will overwrite. Once
you edit a Doc_H form, the catalogue stops speaking for it too: your fields stay.

**Filling forms with no signal.** The app installs (Add to Home Screen on a phone) and opens
without a connection: the shell and the form catalogue are cached, so a unit form or a QC form
can be filled on set or at the client's office. A form submitted offline is held in **صف ارسال
فرم‌ها** at the top of the forms page and sent by itself when the network returns — the header
says «آفلاین» meanwhile, and shows how many forms the device is still carrying.

What the queue will not do is pretend. When a queued form finally reaches the server, the rules
run as they always do: a project closed while the phone was in a pocket refuses the form, and
the refusal appears in the queue in the server's own words, beside your data, to fix and retry
or discard knowingly. Nothing is deleted on your behalf. And a form sent twice — a dropped
connection after the server already had it — files once: the device stamps each form with its
own key, and a repeat returns the submission already filed.

**Spreadsheets in and out.** Every form offers a CSV template (its columns with Persian labels
and a hint per column), an export of everything filed on it, and an import. Choose a file and
the system checks every row first — references can be codes like `PRJ-000002`, emails or
company names — and lists each row's problems before anything is written. Valid rows go in as
drafts by default (a migration of last year's records should not open two hundred approvals),
or through approval if you say so.

## Organisational memory

**حافظهٔ سازمان** searches what the organisation has already learned: briefs, proposals, meeting
minutes, lessons learned, client feedback and status reports. Ask it the way you would ask a
colleague — «برای مشتری صنایع غذایی چه استراتژی‌هایی داده‌ایم؟» — and it ranks records by what
they are about, not only by the words you happened to choose.

Every result shows two numbers: how close it is in *meaning* and how close in *wording*. That
matters, because the quality of the first depends on how the system is configured. With an
embedding service configured (a hosted one, or a local model on your own network) the meaning
half is real; without one, the system embeds locally with a word-based method and says so on
every search — the page tells you which you are looking at rather than letting you assume.

You only ever see records you could already open: a kind you have no permission to read is
never searched.

**At the top of every project: what we already learned.** Doc_H has required lessons learned at
closure for years; the problem was never writing them, it was that nobody reads last year's.
The project's own overview now shows the past lessons that bear on it — matched on the project's
description, and raised when they come from the same client, the same execution units or the
same account owner. Each one says why it is there.

Two answers are possible, and «دیدم» is not one of them: **در این پروژه به‌کار می‌گیریم**, or
**مرتبط نیست** with a reason. A lesson you have answered leaves the list and is counted instead,
and the decision is written to the project's history. That record is the difference between an
organisation that learns and one that archives.

## The AI assistant

Choose an analysis and its subject. You always get **rule-based findings** computed directly from
system data — rule violations, incomplete briefs, unassessed change impacts. These are
deterministic and cite the records they came from.

If a language model is configured, you also get a narrative over the same grounded data. If not,
the page says so plainly. The assistant never sees data you cannot see yourself, never changes
anything, and every request is logged.

---

## Getting the organisation started

**راه‌اندازی سازمان** (for the system administrator) takes the organisation from empty to working,
from the spreadsheets it already has — Excel or CSV, headers in Persian. Six steps, each showing what
is already there:

1. **واحدها** — your own unit names («استودیو طراحی»، «بازاریابی دیجیتال»…) are read from the users
   file, and each is given one of Doc_H's ten units, with a suggestion to accept or correct.
2. **کاربران** — each file is checked first, row by row, before anything is written: what will be
   created, what is already there, what is wrong and why. Then the valid rows are created. Nobody's
   password is ever in a file: each new person receives a one-time link to set their own.
3. **تقویم کاری** — the working week and hours, and the holidays (a file of dates, Jalali is fine).
4. **مهلت‌های SLA** — Doc_H's hours, which you may adjust to your contracts.
5. **مشتریان** and their contacts.
6. **پروژه‌های در جریان** — projects that are already running come in at the state they are in. A
   project past authorization needs its basis and document (a contract number, an order letter): Doc_H
   rule 13 holds for migrated work too.

Running a file twice creates nothing twice.

## The organisation's rules

**قوانین سازمان** (in the sidebar, for everyone) lists every rule the workflows follow: the
organisation's own, and — under **Doc_H و افزونه‌ها** — the product's and any installed extension's.
Each rule is read back as a sentence: «انتقال فقط وقتی مجاز است که …».

The CEO and the PMO manager (**rules.manage**) write the organisation's own, with no code:

1. **قانون تازه** — choose the workflow and the move («تأیید قرارداد»، «واجد شرایط کردن سرنخ»…),
   name the rule as people should see it, and build the condition from the record's fields: an
   amount at least so much, a date no more than so many days away, a field filled in, the person
   making the move being (or not being) the record's owner. For a notice, choose instead who
   should be told.
2. **آزمون روی این رکورد** tries it on one record by its code; **سنجش روی سابقه** says how many of
   the moves already made it would have held back — before anyone is stopped by it.
3. **انتشار** — it applies from that moment. The blocked person sees it in «چرا نمی‌توانم؟» by its
   name; the CEO's governed exception (استثنا) covers it like any other rule.

A change is **نسخهٔ تازه**: the old version is kept, and every move records the version it met.
**کنار گذاشتن** stops a rule, with a reason; its history stays. A rule can only add a requirement or
a notice — it never switches off one of Doc_H's.

## On the phone

**هیوا همراه** (open `/m` on the phone, and **Add to Home Screen** to keep it there) does three
things, the three whose deadlines are hours, and nothing else:

1. **پذیرش سفارش** — a work order issued to you: read the brief, then **پذیرش سفارش**, or
   **اعلام ابهام** with what is unclear (the acceptance clock waits for Account's answer).
2. **تأیید فرم** — a form waiting for your decision, shown as it was filled: **تأیید**, or **رد** /
   **بازگشت** with a reason.
3. **QC واحد** — your unit's deliverable, handed over and waiting for level-1 QC: the checklist, the
   verdict, what was found (required for a rejection, and the revision is raised from it) and up to
   four photos from the camera. The photos are the review's evidence, not files of the deliverable;
   once recorded they are not replaced, and only you can take one back, the same day.

Each item shows the working hours left on its clock. The bell at the top turns on **notices on
this phone**: the work order issued to you, the form waiting for you, the deliverable waiting for
your unit's check — and the warning when one of their clocks is running out. Tapping a notice opens
that item. **ارسال اعلان آزمایشی** checks that notices reach the phone. On an iPhone, notices work
only in the app added to the home screen. Signing out stops the notices on that phone. Everything
else stays in the full interface (**نسخهٔ کامل هیوا**).

## When the system blocks you

A refusal names the rule. For example:

> پروژه بدون مجوز معتبر وارد اجرا نمی‌شود.
> **قانون حاکم:** Doc_H §13 — شروع اجرای پروژه

That is the platform doing its job. The path forward is to satisfy the rule — record the
authorisation, complete the brief, assess the change impact — not to work around it.

**The rule really must be set aside this once.** Only the CEO or deputy can do this, and only
from the checklist next to the blocked button: *صدور استثنا* on the failing line, with a reason.
The exception covers that one guard on that one record, is spent by the first move it lets
through, expires within days, and appears in the register on the data-quality report with the
grantor's name. It is meant to be rare; the dashboard counts them.

**The approver is away.** Do not share a password — the audit trail would say the wrong person
did everything. Open *تفویض اختیار* (bottom of the sidebar) and lend exactly the permissions or
approver role needed, until a date, with a reason. The delegate sees the lent items on their next
sign-in, everything they do with them is recorded as done on your behalf, and you can end it
early from the same page.
