# User guide

Hiva OS follows the agency's own process. If you know your role in Doc_H, the system will feel
familiar — and it will stop you when a step is skipped.

## Signing in

Use your organisational email. What you see is decided by your role: navigation, buttons and
report tabs all appear only where you hold the permission. If a screen seems missing, it is
because the process assigns that step to someone else.

---

## Your queue — «کارهای من»

Everything that sits with you, in one list: tasks assigned to you, work orders you own, QC
waiting for your level, forms awaiting your approval, revisions assigned to you, and — if you
issue work orders — clarification requests from the units. Ordered by urgency: a breached SLA
first, then whatever runs out soonest, then by due date. Each row carries its own actions, so
you accept, submit or send to QC from the list. Filter by kind with the chips above it.

## Sales

**Your loop: acquire → qualify → brief → present → close.**

1. **Leads** — record a new lead, then move it Contact → Qualify. Converting creates the
   opportunity and, if needed, the customer record.
2. **Briefs** — write the sales brief and submit it to Account. The brief shows a completeness
   score; anything below 100% will be returned to you, so fill in objective, audience, scope,
   deliverables, budget and deadline before submitting.
3. **Proposals** — once Account delivers a proposal, present it and record the outcome:
   approved, revision requested, or rejected. A revision request must carry the client's exact
   wording — Account needs it to scope the rework.

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

---

**The weekly client report.** Write the status report as usual; every Saturday morning the
system sends the week's report to the client's primary contact as a PDF built for them — the
financial status and internal decisions are left out, and the strip above the preview says so.
*ارسال برای مشتری* on the project page previews that copy and sends it now. If you did not file a
report that week, you get a warning on Saturday instead of the client getting nothing.

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

## Finance

- **Invoices and payments** — issue proformas and invoices; totals are computed server-side.
  Recording a receipt rolls the invoice to partially paid or paid automatically.
- **Settlement** — settling a project computes invoiced, received and balance, and ticks the
  financial condition on the closure checklist.
- **Project financials** — Project 360 → Financial shows budget vs actual cost vs revenue, margin,
  and cost broken down by unit, all from declared costs.

---

## Legal

Drive the contract through drafting → legal review → approval → signature → registration.
Registering a contract sets the project's revenue baseline. Amendments update the contract value
and the project end date together.

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

## Forms

**فرم‌ها** holds all 130 Doc_H forms. Each shows its route (from which unit to which), its
approver, its SLA, and the process it triggers. You can only submit forms your unit owns — the
rest are visible so you can see the shape of the process.

*در انتظار تأیید من* is your approval inbox. You cannot approve a form you submitted yourself.

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

## The AI assistant

Choose an analysis and its subject. You always get **rule-based findings** computed directly from
system data — rule violations, incomplete briefs, unassessed change impacts. These are
deterministic and cite the records they came from.

If a language model is configured, you also get a narrative over the same grounded data. If not,
the page says so plainly. The assistant never sees data you cannot see yourself, never changes
anything, and every request is logged.

---

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
