# Architecture Decision Records

Each record states the decision, what was actually considered, and what it costs.

---

## ADR-001 — Modular monolith, not microservices

**Context.** The master brief explicitly required evaluating monolith, microservices,
event-driven, serverless and hybrid rather than assuming one.

**Decision.** A modular monolith with enforced internal boundaries.

**Alternatives considered.**

| Option | Verdict |
|---|---|
| Microservices | Rejected. Hiva's core operations are transactional across module boundaries — a QC rejection atomically touches reviews, revisions, deliverable state, two SLA clocks and audit. Splitting them turns one transaction into a distributed saga for an organisation of ~15–200 users. |
| Serverless | Rejected. Background SLA ticking, long-lived database connections and stateful workflow transactions fit poorly; cold starts hurt an internal tool used continuously through the working day. |
| Event-driven | Partially adopted. Transition effects and notifications behave like domain events, but synchronously and inside the transaction, which is what the consistency requirement demands. |
| Modular monolith | **Chosen.** |

**Consequences.** One deployable unit; simple local development; strong consistency for free.
Discipline must come from code review rather than network boundaries — mitigated by the
single-write-path rule for `state` and by `packages/contracts` as a shared source of truth.

---

## ADR-002 — A declarative workflow engine as the single write path for state

**Context.** Doc_H's value is in its control points. If any code path can set
`project.state = 'ACTIVE'`, every rule becomes advisory.

**Decision.** All 13 entity lifecycles are declared as data in `packages/contracts/src/workflows.ts`.
`workflow/engine.ts` is the only code that writes `state`, and the CRUD factory strips `state`
from every PATCH body.

Precisely, there are two sanctioned entry points and no others:

- **`transition()` / `transitionWithin()`** for a move the actor initiates. Both run the same
  body — permission, mandatory reason, Doc_H guards, effects, `StateTransition`, audit, SLA.
  The second exists because Prisma has no nested interactive transactions and some moves must be
  atomic with other writes: converting a lead also creates a Company and an Opportunity, and a
  failed QC review raises a revision alongside the deliverable's move. Those callers join the
  engine's transaction rather than opening their own around it.
- **`cascadeState()`** for a move on a *second* entity caused by the first — approving a brief
  moves its opportunity to `BRIEF_COMPLETED`. Guards and permissions are deliberately skipped:
  the causing transition was already authorised and already passed its guards, and re-checking
  would demand the actor hold permissions on an entity they are not acting on. Traceability is
  not skipped — the `StateTransition` row and the audit event are written, which is exactly what
  the inline `tx.<model>.update({ state })` calls this replaced were omitting.

Three code paths previously wrote `state` directly. Converting a lead skipped the declared
`QUALIFIED → CONVERTED` precondition entirely, so a brand-new lead could be converted. A failed
QC forced a deliverable to `REVISION_REQUIRED` from any state and left no row in its history. And
the brief cascades moved their opportunity silently, leaving gaps in that opportunity's own
timeline. All three now go through the entry points above.

Since ADR-016, the vocabulary is also a database constraint, so a direct `UPDATE` or a data
import cannot introduce an undeclared state either.

**Alternatives considered.** Temporal and Camunda were considered and rejected: both are excellent
for long-running distributed orchestration, but they would add an external service and a second
programming model to enforce rules that are fundamentally *database constraints with permissions*.
A hand-rolled engine here is a few hundred lines and keeps everything in one transaction.

**Consequences.** Illegal transitions are impossible rather than discouraged. A test asserts that
a direct `PATCH { state: 'CLOSED' }` is silently ignored. The cost is that every new lifecycle
must be declared before it can be used — which is the intent.

---

## ADR-003 — Doc_H rules as named guards, not scattered conditionals

**Context.** Rules like "an out-of-scope change may not reach the customer before all six impact
dimensions are assessed" cannot be expressed by RBAC.

**Decision.** A guard registry. Each guard is a named predicate that returns a Persian message
*and the Doc_H clause it enforces*. Transitions declare which guards apply.

**Consequences.** The API returns HTTP 422 with `details.rule = "Doc_H §8 — کنترل تغییرات"`, so
the UI tells the operator exactly which rule blocked them. Guards are unit-testable in isolation
and the mapping from document to code is legible to a non-programmer.

---

## ADR-004 — A form engine, not 130 hand-built screens

**Context.** Doc_H catalogues 130 forms and demands each behave as a Data Object with a sender,
receiver, approver, SLA and next process.

**Decision.** Forms are rows in `form_definitions` carrying a JSON field schema. One renderer, one
validator, one routing/approval/SLA engine serves all 130. 73 forms additionally carry a
typed `binding` that drives a first-class domain record.

**Alternatives considered.** Hand-coding each form was rejected as unmaintainable and as a
guarantee that the catalogue would drift from the documents.

**Consequences.** Adding or amending a form is a data change. The trade-off is that a generic
renderer cannot express a highly bespoke layout — acceptable, because these are structured
operational forms. Forms without a binding are honest structured communications, which is what
Doc_H asks of them; they are not presented as more than that.

**Versioned since roadmap #16.** "Adding a form is a data change" was true; *changing* one was
a data change that rewrote history, because every submission and every archived PDF rendered
under the schema as it stood today. Each schema change is now a `form_definition_versions` row,
a submission pins `definitionVersion` when it is filled in, and every reader — the submission
endpoint, the PDF, attachment discovery — asks for that version. The definition's `schema` column
remains the current version for new submissions. Schemas are compared structurally, not as
strings: JSONB reorders keys, and a string comparison minted a version on every seed.

---

## ADR-005 — Business-hours SLA arithmetic

**Context.** Doc_H states SLAs in *working* hours. A 4-working-hour SLA started at 16:00 on a
Wednesday is due Saturday at 12:00, not Wednesday at 20:00.

**Decision.** A calendar-aware arithmetic module driven by the organisation's own working days,
hours, break and holidays.

**Break model.** `Organization` stores `breakHours` as a duration, not a window, so the break has
no wall-clock position. It is modelled at the END of the working span: with 09:00–18:00 and one
break hour, productive time is 09:00–17:00. Any fixed position yields the same total per day;
placing it at the end keeps `addBusinessHours` and `businessHoursBetween` exact inverses and needs
no schema change. A budget that exactly consumes the rest of a day rolls to the next working
morning rather than landing on the closing instant, so a due date is always a moment the office is
open.

**Consequences.** SLA compliance figures are defensible. The calendar is data, so a change in
working hours needs no code change.

**Corrected after review.** Neither `addBusinessHours` nor `businessHoursBetween` subtracted the
break: both measured the full nine-hour span, so a "1 working day" (8h) SLA started at 09:00 came
due at 17:00 the *same* day, and the error compounded across multi-day policies. The
Wednesday-16:00 example above previously read "Saturday 11:00", which was that bug written into
the ADR. Separately, the AT_RISK threshold compared wall-clock durations, so a clock opened before
the Thursday–Friday weekend was flagged as nearly-due during the weekend having consumed no
working time; it now compares working hours consumed against the policy's budget. Two catalogue
entries were also wrong: `SLA_MEETING_MINUTES` read «۲۴ ساعت» as 24 *working* hours (three working
days, nearly a calendar week) instead of one working day, and `SLA_PROPOSAL_HANDOVER` carries
«همان روز» as a one-day approximation because "by close of business today" is not a fixed duration
the engine can express. Covered by the calendar tests in `004-engines.test.ts`, including the
weekend, a declared holiday, and a round-trip across a range of durations.

**Scopes (roadmap #13).** The calendar is resolved for a scope — organisation → department →
person — with a narrower scope's set fields winning and null fields inheriting. A person's
leaves are added to their holidays, so they have no working hours on those days. Every SLA
computation now uses the clock owner's calendar: the due date at start, the pause credit, and
the tick's consumption — a deadline is measured in the hours of whoever has to meet it. A unit
that works Thursdays gets Thursday deadlines; someone on leave has a clock that does not run.
The cache is keyed by scope, not by organisation.

**Pauses (roadmap #9).** A clock can be paused while its owner waits on someone else. The
implementation keeps the rest of the engine oblivious: on resume, `dueAt` is pushed out by
exactly the working hours paused, so `now > dueAt` still means breached, and the warning ratio
subtracts `pausedHours` from the hours elapsed. The alternative — leaving `dueAt` fixed and
teaching every reader to recompute — would have put the pause arithmetic in four places instead
of one. `pausedSeconds` (wall-clock, for people) and `pausedHours` (working hours, for the
arithmetic) are both kept because they answer different questions. Each pause is a row with a
kind, a reason and names, so "why was this late" has an answer rather than a number.

---

## ADR-006 — PostgreSQL as the only datastore

**Decision.** One database for relational data, JSONB form payloads, full-text search and the
job queue (via pg-boss).

**Alternatives considered.** Redis + BullMQ for jobs and Elasticsearch for search were both
rejected: the job volume is a handful of scheduled ticks and the search corpus is thousands of
rows. Each would add an operational component, a failure mode and a backup target for no
measurable gain.

**Consequences.** One thing to back up, monitor and restore. If search volume grows past what
`ILIKE` with indexes handles, the search route is a single seam to replace.

---

## ADR-007 — AI as an audited advisory layer with a deterministic core

**Context.** The brief demanded AI that respects permissions and never acts beyond its identity.

**Decision.** Capabilities declare the data permission they require and are checked before any
data is read. Every capability computes rule-derived findings from the database first; the
language model is additive narrative over that same grounded data. Every call is written to
`ai_interactions`. The AI layer has no write path to business data.

**Consequences.** The feature is useful with no API key configured — a genuine advantage, since
the deterministic findings (rule violations, incomplete briefs, unassessed changes) are the
highest-value output and are never hallucinated. Cost and vendor dependency are optional rather
than structural.

---

## ADR-008 — Single-organisation now, multi-tenant-ready by construction

**Decision.** `organizationId` on every scoped table and applied by the data layer to every
lookup — list, detail, update, delete, workflow transition, PDF export and AI grounding — but no
tenant provisioning, per-tenant branding or resolution middleware.

**Rationale.** Doc_H describes one organisation. Building SaaS multi-tenancy now would be
speculative complexity. Carrying the column costs nothing and avoids the migration that would
otherwise be required.

**What was actually true until recently.** Only *list* queries were scoped. Detail, update and
delete looked records up by id alone, as did the workflow engine, the admin user routes and the
AI and PDF layers — so with a second organisation present, a known id would have crossed the
boundary. The SLA calendar cache was a single process-wide slot, so a second organisation would
have inherited the first one's working week and holidays for up to a minute, silently
miscomputing every due date. Both are fixed; a cross-tenant suite in `003-security.test.ts` seeds
a second organisation and asserts its records are unreachable.

Cross-tenant reads return **404, never 403** — a 403 confirms the id exists, which is itself what
tenancy withholds.

**Still not in place**, and required before this could be sold as SaaS: tenant resolution from
the request (there is no subdomain or header mapping — `organizationId` comes from the actor's
own token), provisioning, per-tenant branding, and per-tenant form and workflow overrides.
`FormDefinition.code` and `SlaPolicy.code` are also globally unique rather than unique per
organisation, which a second tenant with its own form catalogue would collide on.

---

## ADR-009 — Persian-first, RTL-first, Jalali dates

**Decision.** The interface is Persian and right-to-left by default; all dates render in the Solar
Hijri calendar; numbers render in Persian digits; Latin identifiers (codes, emails) are isolated
LTR inside RTL text.

**Rationale.** The organisation works in Persian and in the Jalali calendar. An
English-first UI with a translation layer would be a worse fit and a constant source of
mixed-direction bugs. Field labels carry both `labelFa` and `labelEn`, so an English locale is
additive rather than a rewrite.

---

**Entry, added after review.** Display honoured this from the start (`fa-IR-u-ca-persian` in both
`apps/web/src/lib/format.ts` and the PDF layer), but the form engine rendered a native
`<input type="date">`, which is Gregorian in practice — so a user read «مهلت: ۱۴۰۵/۰۶/۳۱» and had
to type `2026-09-22`. These are the fields filled every day, and they feed the SLA engine.

`JalaliDateInput` replaces both entry points. Typing works on its own — Persian, Arabic-Indic or
Latin digits, with `/`, `-` or `.` between them — and the calendar is an accelerator rather than
the only way in, so the control stays usable from the keyboard.

The wire format is deliberately unchanged: a `date` field still posts `YYYY-MM-DD`, exactly what
the native input produced for the same real-world day, so no Zod schema moved. A `datetime` now
posts a UTC instant, which is a correction rather than a change of contract — the old
`datetime-local` value carried no offset and was re-read in whatever timezone the server happened
to run in.

**Dependency.** `date-fns-jalali` (MIT), about 40 kB gzipped in the built bundle. Hand-rolling
against `Intl.DateTimeFormat` handles formatting but not the reverse direction, and Jalali month
lengths — اسفند is 29 or 30 days depending on the leap year — are exactly where hand-rolled
conversions break. Thirteen tests cover both directions, including a round-trip over every day of
a Jalali year, leap and common اسفند, and an early-morning time that crosses back into the
previous UTC day from Tehran.

**Language switch, added after review.** Every enum, role, department, module, form and field in
`packages/contracts` already carried both sides — 327 label pairs — but nothing in the UI could
reach the English one. `LocaleProvider` switches which side is read and flips `dir` and `lang` on
`<html>`; the choice persists to `User.locale`, which was already a column, through a new
`PATCH /auth/me/locale`.

Scope is deliberately partial and should not be mistaken for an English product. Switching today
gives English form names and field labels — the form engine is the surface with full bilingual
coverage, and it is the one people spend the day in. What stays Persian:

- **706 strings written directly into page components**, across 18 files. The largest are
  `Operations.tsx` (132), `Projects.tsx` (89), `Crm.tsx` (72), `Sales.tsx` (65) and `Forms.tsx`
  (62). Extracting them is the follow-up this pass deliberately did not start.
- **`STATE_LABELS`**, which carries `fa` only. Adding `en` to all 118 entries is translation
  work, not plumbing, and belongs with the extraction above.

The direction flip is applied before React mounts, so the layout does not visibly reverse on load.
## ADR-010 — Access token in memory, refresh token in storage

**Decision.** The access token lives only in a module-scoped variable; the refresh token is the
only value in `localStorage`, and it rotates single-use on every refresh.

**Rationale.** An XSS cannot read a token that is not in storage. The refresh token in storage is
the residual risk, bounded by rotation and server-side revocation. The alternative —
`httpOnly` cookies — is stronger against XSS but requires CSRF defences and complicates the
split-origin development setup; rotation plus a short access-token lifetime is the better
trade-off here.

---

## ADR-014 — تولید PDF با موتور مرورگر به‌جای کتابخانه‌ی PDF

**وضعیت:** پذیرفته‌شده

**زمینه**
سازمان سندمحور است: ۱۳۰ فرم، قرارداد، پروپوزال، فاکتور و گزارش پایان پروژه باید به شکل نسخه‌ی
رسمی قابل چاپ و بایگانی درآیند. تمام محتوا فارسی است.

**مسئله**
فارسی به شکل‌دهی وابسته به موقعیت حرف و چیدمان دوجهته نیاز دارد. کتابخانه‌های رایج تولید PDF در
جاوااسکریپت (pdfkit، pdfmake، jsPDF) این را انجام نمی‌دهند و خروجی آن‌ها حروف جدا و وارونه است —
یعنی سندی که برای این سازمان بی‌ارزش است.

**گزینه‌های بررسی‌شده**
1. **pdfmake / pdf-lib با قلم فارسی جاسازی‌شده** — نیازمند پیاده‌سازی دستی shaping و bidi. پرریسک و
   در عمل ناقص. رد شد.
2. **@react-pdf/renderer** — پشتیبانی bidi ناقص. رد شد.
3. **چاپ سمت کلاینت با `window.print()`** — رندر فارسی درست است، اما نقطه‌ی اعمال دسترسی به
   مرورگر منتقل می‌شود، قابل حسابرسی نیست و امکان تولید خودکار/بایگانی ندارد. رد شد.
4. **رندر سمت سرور با موتور مرورگر (Chromium via Playwright)** — انتخاب شد.

**تصمیم**
اسناد در Chromium صفحه‌بندی و چاپ می‌شوند. قلم Vazirmatn داخل سند جاسازی می‌شود تا خروجی مستقل از
قلم‌های نصب‌شده روی میزبان یکسان باشد.

**پیامدها**
- وابستگی به یک باینری Chromium (~۳۵۰ مگابایت) در محیط اجرا. مسیر آن قابل پیکربندی است و در
  نبودش سامانه با `503` تنزل شرافتمندانه می‌کند، نه خطای عمومی.
- رندر با شبکه‌ی غیرفعال و جاوااسکریپت خاموش انجام می‌شود؛ این هم‌زمان سطح حمله‌ی SSRF را می‌بندد.
- کیفیت خروجی برابر با چاپ مرورگر است: RTL، تقویم جلالی، ارقام فارسی و جدول‌های چندصفحه‌ای درست.

**مرتبط:** `docs/pdf-export.md`

---

## ADR-016 — The state vocabulary is a database constraint, not only an engine rule

**Decision.** Every table with a `state` column carries a CHECK constraint listing exactly the
states its workflow declares. The constraints are generated from the same contracts the engine
reads, by `prisma/generate-state-constraints.mts`, so the two cannot drift.

**Rationale.** ADR-003 makes `workflow/engine.ts` the only sanctioned writer of `state`, but
"sanctioned" is a property of the application: a direct `UPDATE` in a console, a data import, a
restored dump or a future code path that has not read this document can all still write nonsense.
A CHECK constraint makes the vocabulary a property of the schema, which those paths cannot route
around. It does not replace the engine — the engine enforces *which transition* is legal, and
under whose permission; the constraint only enforces *which states exist*.

**Consequences.** Adding a state means a migration, not just a contracts edit — which is the
intended friction. The constraints are regenerated rather than hand-edited; the generator is the
source of truth and the migration is its output.

---

## ADR-017 — One database schema per test file

**Decision.** Each API test file runs against its own PostgreSQL schema, cloned from a template
that is migrated and seeded once per run. Files run in parallel. `HIVA_TEST_ISOLATION=shared`
restores the previous behaviour — one schema, sequential, nothing dropped.

**Rationale.** The suite used to drive one shared schema through every file and never reset it,
so a test could pass because of a row an earlier file, or an earlier *run*, had left behind. That
was not theoretical: one security test selected project `PRJ-000016`, a code that existed only
because repeated runs had pushed the counter that far, and the PDF export file depended on
records that only the lifecycle file ever creates. Both had been green for months. Neither
survived contact with a clean database.

A schema rather than a database because `CREATE SCHEMA` needs no CREATEDB privilege, takes no
lock a parallel worker might contend on, and keeps every artefact inside the database named by
`DATABASE_URL`, so CI provisions nothing extra.

Cloning rather than migrating-and-seeding each file because the seed is the expensive half:
0.23s against 1.25s measured. The clone replays migration SQL and copies the seeded rows in
foreign-key order, which is also why it does *not* use `prisma migrate diff --from-empty` —
that round-trips through Prisma's schema model, which has no concept of a CHECK constraint, and
would silently drop all 15 of the ADR-016 constraints.

Every schema is built in the global setup, before the first worker starts — not lazily in each
file's own setup, which was the first version. Lazy provisioning meant one worker replaying 313
DDL statements while others were mid-test; the catalogue locks that takes were enough to push
their queries past Prisma's 5-second connect timeout, and the suite failed about one run in four
with an HTTP 500 that looked like an application bug. With all DDL finished before any test
runs, thirteen consecutive runs passed. The clones are built a few at a time, which is safe only
there: nothing is waiting on the database yet.

**Consequences.** The suite is repeatable: two consecutive runs from an empty database produce
identical results, and any single file passes on its own. Wall-clock fell from 23.3s sequential
to 16.2s parallel on the same tests. Tests may no longer read data another file created — which
is the point, and cost two fixes to get to. `tests/007-isolation.test.ts` asserts the mechanism
is actually in effect, because a silent failure here looks exactly like success.

---

## ADR-018 — Delegation is a record, not a shared password

**Decision.** Authority can be lent for a bounded time through a `Delegation` row: who, to whom,
which permissions and roles, from when to when, why. The delegate's token carries the lent grants
with an attribution map (`delegated`, `delegatedRoles`), and everything done on a lent grant is
recorded with `onBehalfOfId` — on the state transition, on its audit row, on a form decision — and
every gated request that passed only because of a delegation writes a `DELEGATION_USED` row
naming the lender and the URL.

**Rationale.** The model names one approver per step. When that person is away the chain stops,
and in practice organisations route around it by sharing a password, which turns every audit row
in the system into a guess about who was at the keyboard. The alternative had to be easier than
the workaround: a person lends exactly what they hold, for a few days, with a reason, from a page
— and gets it back with a click.

**Constraints that make it safe.** Only what the delegator holds *right now* is granted, re-checked
every time a token is issued, so a delegation cannot outlive a demotion. Nothing is lent that the
delegate already has, so the attribution map names only what came from someone else. Ninety days
is the ceiling — a longer absence is a role change. Revocation ends the delegate's sessions, so
the lent grant lives at most until their current access token expires, the same window a role
change has (ADR-010).

**Consequences.** A delegation shows in the audit trail from three angles — granted, used,
revoked — and the record history says "A, as B's delegate". Any request gated by
`requirePermissions` is covered automatically; the workflow engine and the form engine attribute
their own rows because they check permissions themselves.

---

## ADR-019 — An exception must be possible, and expensive, visible and temporary

**Decision.** The CEO or deputy (`governance.waive`) can grant a `Waiver`: one guard, one record,
optionally one transition, a reason of at least ten characters, an expiry of at most thirty days.
Enforcement treats a failing guard covered by a live waiver as holding, spends the waiver in the
same transaction, and writes what was waived into the transition's audit row. Preflight shows a
waived check as satisfied and says by whom. The register is visible on the executive dashboard and
in the data-quality report, beside the rules set aside by accident.

**Rationale.** A blocked guard was a dead end, and a dead end moves the work outside the system —
losing both the rule and the trace. In practice the CEO does sometimes need to say "start without
the contract this once; on my authority". If the system cannot express that, the organisation
expresses it in a chat message and the project starts anyway, with no record and no rule. The
design goal is not to make exceptions easy; it is to make the *recorded* exception easier than
the unrecorded one.

**What keeps it an exception.** Single use — the first transition it lets through spends it.
Bounded — thirty days at most; a permanent exception is a rule change, and belongs in the
contracts. Narrow — one guard on one record, never a class of records. Named — the reason is
mandatory and stays in the register with the grantor's name. Counted — `waiversOpen` and
`waiversUsed30d` on the dashboard, so drift toward routine exceptions is visible as a number.

**Alternatives rejected.** A "force" flag on the transition endpoint: no reason, no expiry, no
register, and it would have to be guarded by the same permission anyway. Editing the record to
satisfy the guard: that is the workaround this replaces, with a lie in the data instead of a
truth in the register.

---

## ADR-020 — Rules are versioned by fingerprint, and every transition names its version

**Decision.** At boot the API fingerprints each rule set the code declares — the state machines
(`WORKFLOWS`), the role grants (`ROLE_PERMISSIONS`), the SLA catalogue (`SLA_POLICIES`) — and,
when a fingerprint is new, stores the full snapshot as the next version, effective from then.
Every state transition records the workflow and permission versions in force when it happened,
on the row and in its audit event. `/rules/at`, `/rules/diff` and `/rules/for-transition` answer
the auditor's three questions: what was in force then, what changed, and what allowed this.

**Rationale.** The rules are data (ADR-003, ADR-004), which is the platform's advantage — and
until now its blind spot: a change to a guard or a grant rewrote history, because nothing said
which rules a past decision had been judged by. Any organisation under review eventually hears
"was this decision right under the rules of that time". The answer had to be on the row.

**Why fingerprints rather than a version number in the code.** A number someone has to remember
to bump is a number that will not be bumped. A fingerprint is bumped by the change itself, and
the same content always maps to the same version — a rollback of the code registers nothing and
resumes stamping the old version. Key order is canonicalised first, so a cosmetic reordering is
not a new version.

**Consequences.** A rule change is visible in the Admin tab within one boot, with a diff in words.
The Rule Lab (roadmap #5) can replay history under a chosen version because the snapshots are
complete. The `note` on a version is optional today; the seed and the boot leave it empty, and a
future rule editor should fill it.

---

## ADR-021 — Policy changes are regression-tested against history before they are made

**Decision.** `/rules/lab` takes proposed edits to the rules — a transition's guards or required
permission, a role's grants — applies them to a copy of the running rule sets, and replays the
transition log under the copy. It reports the past moves the candidate would have refused and,
for a guard the candidate drops, the past blocked attempts it would have let through. Nothing is
written. The blocked attempts come from `TRANSITION_BLOCKED` audit rows, which the engine now
writes whenever a guard refuses a move, naming the guard.

**Rationale.** A rule change in an organisation is usually argued from anecdote — "Account QC
slows everything down" — and decided without evidence, then discovered to have consequences.
Because the rules are data (ADR-003) and the log is complete, the evidence is available: how many
of last quarter's approvals would have failed, how many attempts died on the rule being loosened.
That is the difference between changing a policy and guessing.

**What the lab states rather than hides.** Permissions are replayed against actors' *current*
roles, because roles at the time are not recorded. A guard the candidate adds is evaluated
against the record *as it stands today*. Cascaded transitions are not replayed. These three
assumptions are returned with every result, and the UI prints them under the numbers.

**Consequences.** `TRANSITION_BLOCKED` is also a friction log in its own right: where people push
against the rules, by guard, over time. The rule editor of the future (roadmap #47) should run the
lab before publishing — the shape is ready for that.

## ADR-022 — Capacity is advice, not a rule

**Decision.** `GET /tasks/suggest-assignee` ranks a unit's people by free capacity on their own
calendar (ADR-005 addendum, roadmap #13) and by how their finished tasks actually went, and
returns the ranking with its reasons and its warnings in Persian. Over-capacity is a warning
carried beside the name. It is not a guard, and nothing in the assignment path refuses a
transition on capacity grounds. The traffic board reads the same function, so the board and the
suggestion cannot disagree.

Capacity itself is the smaller of what a person's calendar holds in the window and what their
contract (`weeklyCapacityHours`) says, and commitment is what is *left* of their open tasks —
estimate minus hours already logged (roadmap #14) — or their allocations, whichever is larger,
which is the convention the traffic board has always used.

**Rationale.** Doc_H nowhere forbids overloading a person; a deadline sometimes costs a weekend,
and that is a manager's call to make with the number in front of them. A system that refuses the
assignment does not prevent the overload — it moves the work to a chat message, where nothing is
measured. Advice at the moment of decision changes behaviour; a 422 changes where the decision
is recorded.

**Consequence.** One thing *did* become a rule: `task.assign` now requires `payload.assigneeId`
(400 `ASSIGNEE_REQUIRED`). Dispatch starts the four-hour acceptance clock, and a clock with no
owner measures nobody — which was possible before and is not a judgement call.

## ADR-023 — A breach is predicted from comparable clocks, and the prediction shows its working

**Decision.** `predictClocks` answers, for every open SLA clock: of the finished clocks of the
same policy and the same unit that were *still open at the point this one has reached*, what
share went on to exceed the budget. That conditional share is the probability. It is raised —
never lowered — when the owner is over capacity, by at most half again at 200 % utilisation
(roadmap #12). Below eight comparable clocks the model falls back to the policy across all
units, and below eight of those it returns the consumption ratio and says `source: NONE`.

Every prediction returns `becauseFa[]`: the number of comparable clocks, the share that
breached, the median they took, and whether the fixed threshold is still silent. The owner is
told once per clock (`riskNotifiedAt`) when the probability passes 0.7.

**Rationale.** `warnAt` fires at a fixed fraction of the budget, which tells a person they *were*
late — three-quarters of the deadline is already spent by then. The clocks are a complete record
of how long each policy really takes in each unit, so the same question can be answered at the
start. A conditional share over real observations is defensible in a way a fitted curve is not:
a unit manager can check it by counting.

**Why the load adjustment only goes up.** A person with free capacity still has to do the work;
claiming a discount for it would be inventing evidence the clocks do not contain.

**Consequences.** `riskProbability` is kept beside `riskNotifiedAt`, so the predictions can be
scored against what happened — the honest way to find out whether the model earns its place.

## ADR-024 — Conditional approvers are data on the form, evaluated by one pure function

**Decision.** A form definition carries `routing`: rules of the shape *condition on the submitted
values → roles that must also approve*. `evaluateRouting` in `@hiva/contracts` is pure and total,
so the browser runs it on every keystroke while the form is filled, the server runs it at submit,
and `POST /forms/definitions/:code/routing/preview` runs it for any other client — all three
reach the same answer by construction. Doc_H's `approverRoles` are a floor the rules can only add
to. The result is stored on the submission (`requiredRoles`, plus the rules that fired), and the
decision endpoint authorises against *that*, not against whatever the definition says today.

Routing is versioned with the schema: a rule change mints a new definition version (ADR-004,
roadmap #16), because it changes who was entitled to approve.

**Rationale.** The field-condition pattern already existed for `visibleWhen`; lifting it to the
routing level covers "a discount above X needs the CEO", "a contract above Y goes through Legal"
and most of the customisation requests that would otherwise arrive as code. Storing the outcome
rather than recomputing it means a submission's approvers cannot be changed retroactively by an
administrator editing a threshold.

**Every rule carries a sentence.** `whenFa` is written by the person who made the rule and is
shown three times: while the form is filled, in the approver's notification, and beside the
decision afterwards. An approval request that cannot explain why it landed on someone's desk is
the thing this feature exists to replace.

**Thresholds are defaults, not Doc_H.** Doc_H fixes who approves each form but names no figures,
so the shipped rules are marked `DEFAULT` and the admin screen exists to change them. A rule
that does restate a clause is marked `DOC_H` and carries its `docRef`.

## ADR-025 — An approval is a chain of stages, and the executive bypass stops at a declared one

**Decision.** A form definition may declare `approvalChain`: ordered stages, each naming roles, a
quorum (default one) and optionally a condition on the submitted values. `buildStages` resolves
it against a submission — dropping stages whose condition does not hold, and appending one final
stage for any role that routing (ADR-024) added but no stage covers. The submission stores the
resolved stages, the index it has reached and `currentRoles`, the roles that may decide *now*.

An approval clears a stage only when that stage has the distinct approvals its quorum asks for;
the same person cannot count twice. A rejection or a return ends the chain wherever it stands.
The form's SLA clock runs until the form is decided, not until the first signature, and only the
waiting stage is notified.

A form with no declared chain resolves to a single stage over its required roles, quorum one —
bit for bit the behaviour every form had before chains existed.

**Rationale.** Doc_H has multi-step approvals in several places; the catalogue could only express
them as one `approverRoles` list, where whoever clicked first ended the form, or as two separate
forms, which is how the organisation had been working around it. Stages say the thing directly.

**The bypass stops at a declared stage.** SUPER_ADMIN, CEO and DEPUTY can approve any ordinary
form. A declared stage exists precisely because *that* person's sign-off is the point of it, so
the bypass does not apply there — otherwise a deputy could clear the unit manager's stage and
then their own, and the chain would be decoration. The bypass still applies to the implicit
single stage and to the routed-in stage, where it never meant anything more than convenience.

## ADR-026 — The designer writes the same FieldDef the catalogue declares, and the seed yields to it

**Decision.** `PUT /forms/definitions/:code/design` replaces a definition's field list with the
same `FieldDef` shape the Doc_H catalogue declares in TypeScript, validated by the same rules and
rendered by the same component. Editing marks the definition `customizedAt`, and
`publishDefinition` then refreshes only its metadata: the catalogue stops pushing its schema over
the organisation's. A form the organisation invents is `isCustom`, numbered from 1000, and the
seed never touches it at all.

**What cannot be edited.** The required fields of the shipped definition are protected: they may
not be removed, retyped or made optional. That set is derived from the catalogue rather than
listed by hand, so it covers Doc_H §C's nine order elements and the keys every typed binding
reads without a second source of truth to keep in step.

**Rationale.** ADR-004 already said adding a form is a data change, not a code change — but a
programmer still had to write TypeScript, so every new customer was a development project. This
is the half that was missing. Keeping one `FieldDef`, one validator and one renderer is what
makes it safe: a designed form is not a second-class form, and the preview cannot drift from the
real thing because it *is* the real thing.

**Why the seed yields rather than merges.** A merge would need a rule for every conflict —
renamed field, changed type, removed option — and would silently produce a schema nobody wrote.
Yielding is predictable and says so in the seed output; an organisation that wants the catalogue's
version back can clear the customisation deliberately.

## ADR-027 — The offline queue is the app's, not the service worker's, and it never lies about what happened

**Decision.** A form submitted with no connection is written to an outbox (IndexedDB, falling
back to localStorage and then memory) with a key the device generates, and sent by the app when
the network returns. The service worker caches only three things — the app shell, hashed build
assets, and GETs of form definitions — and never intercepts a submission. `clientKey` on
`form_submissions` is unique per organisation, so a retry over a link that dropped after the
server wrote the row returns the original submission rather than filing a second one.

Sync keeps three outcomes apart: **accepted** (marked sent, carrying the code the server gave
it), **refused** (a 4xx — the item stays in the queue with the server's Persian message, for a
person to fix or discard) and **unreached** (5xx or network — the item waits, attempts counted).

**Rationale.** Background Sync in a worker can retry, but it cannot explain. The roadmap named
the hard part exactly: a form filled offline may be refused by a guard on arrival, and the
person has to be told, in their own screen, with their own data still in front of them. Queueing
in the app is what makes that possible; it also means the queue is visible — a device carrying
three unsent forms says so in the header rather than looking like everything went through.

**Why a storage fallback rather than IndexedDB alone.** A phone in private mode, or a browser
with site data restricted, would otherwise silently lose a form somebody typed standing in a
warehouse. localStorage is smaller and less private, but a queued form that survives is the
point of the feature.

**No new dependencies.** The service worker is forty lines of cache rules written by hand rather
than a generated bundle: a form the production unit fills on set is not the place to discover
what a plugin's default strategy decided.

## ADR-028 — Semantic memory on stock PostgreSQL, with the embedder named on every answer

**Decision.** `memory_documents` holds one row per remembered record — brief, proposal, meeting
minutes, lesson learned, client feedback, status report — with the text worth keeping and its
embedding as a `double precision[]`. Retrieval is hybrid: the cosine of the query's vector
(computed in the API over a trigram-filtered shortlist) blended 65/35 with `pg_trgm` word
similarity. Both halves come back with every hit, and the search states which embedder produced
the vectors.

Embeddings come from `EMBEDDING_URL` — any OpenAI-shaped `/embeddings` endpoint, which includes
a local Ollama, LM Studio or vLLM — when one is configured, and from a deterministic local hash
embedder (feature hashing over words and bigrams, TF-weighted, L2-normalised) otherwise. A
service that fails falls back rather than failing the search.

**Why not pgvector.** The roadmap asked for it, and ADR-006's reasoning does allow it: it is a
PostgreSQL extension, not a new datastore. But requiring an extension means a deployment that
cannot install one has no feature at all, and an agency-sized corpus does not need approximate
search — a few thousand rows, filtered by trigram first, is milliseconds of dot products. Where
pgvector *is* installed, adding a `vector` column and an HNSW index is a drop-in optimisation
that changes none of the arithmetic above; `docs/operations.md` carries the migration.

**Why the embedder is named.** A hash embedder is not a language model: it cannot know that
«کمپین» and «campaign» are the same idea. Presenting its output as "semantic search" without
qualification would be a claim the system cannot support, so both scores are shown and the basis
is stated in words on every response and on the page.

**Permissions.** Memory is indexed once and read per caller: each kind declares the permission
its records carry, and a kind the caller cannot read is never searched. Memory can widen what
somebody *finds*, never what they may see.

