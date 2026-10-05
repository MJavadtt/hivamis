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

**Update (roadmap #50, ADR-064).** All of the above is now in place: resolution by host, provisioning,
codes unique per organisation, and the organisation's name on its sign-in page. Per-tenant form and
workflow overrides were already there through the form designer (#15) and the organisation's own
rules (#47).

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

## ADR-029 — A lesson is surfaced without being asked for, and answered rather than acknowledged

**Decision.** A project's overview retrieves past lessons against its own text (ADR-028),
excluding its own project, and raises the score for three plain signals: the same client
(+0.18), a shared execution unit (+0.10) and the same account owner (+0.05). Every hit returns
`whyFa[]` — which signals applied, and whether the textual match was semantic or lexical.

A lesson can be answered in exactly two ways: `APPLIED`, or `NOT_RELEVANT` with a written
reason. An answered lesson leaves the list and joins a count; the answer is written to the
project's history as `LESSON_REVIEWED`.

**Rationale.** Doc_H §15 makes lessons mandatory and the closing checklist asks for them, so the
organisation has been *writing* them for years. Reading them is the part that never happens,
because finding the relevant one means remembering it exists. Asking the question on the team's
behalf, at kick-off, is the whole feature.

**Why there is no "seen" button.** "Acknowledged" measures attention, not learning, and would
make the count meaningless within a quarter. Forcing a choice between *used it* and *set it
aside, for this reason* produces something a manager can actually read — and the reasons
accumulate into evidence about which lessons keep being written and never used.

**Why boosts rather than filters.** A same-client filter would hide the lesson from another
client that is exactly the trap this project is walking into. The signals move a lesson up the
list; they never decide what is on it.

## ADR-030 — Brief quality is scored by rules that quote what they object to, and checked against returns

**Decision.** `scoreBrief` scores six text fields and two structured ones. Each text field earns
40 % for being present, up to 30 % for substance (words against a per-field minimum) and up to
30 % for specificity (a measurable target and a timeframe in the objective, demographics and
geography in the audience, an itemised scope, counted deliverables, a measurable KPI in the
success criteria), and loses 10 % for every vague phrase it contains. Every deduction is a Persian
sentence naming the field, and a vague phrase is quoted. Digits are read in Persian as well as
Latin form. The score and band are stored on the brief.

Beside the score, the organisation's own history is reported: the mean score of briefs that
became won deals, and — the number that matters — the share of briefs in each band that were
returned to Sales. Below five samples a figure is withheld and the page says why.

**Rationale.** Doc_H names the incomplete brief as recurring cycle 1, and the returned briefs are
mostly not empty but vague; completeness gave «افزایش فروش» the same 100 as three precise
paragraphs. A rule-based score is used rather than a language model's judgement so that it is
reproducible, explainable and arguable: a salesperson can see exactly what to change, and a
manager can dispute a rule instead of a number. The AI assistant's `BRIEF_ANALYSIS` may *draft*
improvements; it does not score them.

**Why the return rate is shown.** A score that does not track returned briefs is decoration.
Publishing the per-band return rate next to every score is how the rules get tested — and how
the organisation finds out if a rule is wrong.

**Advisory, not a guard.** The completeness guard still decides whether a brief can be approved
(ADR-003). Blocking on a heuristic score would move the vague brief into an email rather than
improve it.

## ADR-031 — An estimate is judged against what comparable work actually cost, at the moment it is declared

**Decision.** `estimateFor` ranks a unit's finished work orders (SUBMITTED or COMPLETED) against
the one being costed — text similarity of title, scope, expected output and format, plus a boost
for the same output format and for a budget within half-to-double — and keeps up to twelve above
a similarity floor, falling back to the unit's whole history (and saying so) when fewer than
three qualify. For each comparable it reports the declared cost, the *actual* cost (hours logged
on its tasks at each person's hourly rate, plus declared external spend) and the working days
from acceptance to submission. A proposed figure is judged against the p25–p75 range of actual
cost, or of declared cost when no comparable has fully-priced hours.

An actual cost with any unpriced hours is reported as unknown rather than as the priced part:
too small a number would make every estimate look generous.

The check runs in the cost dialog as the figure is typed, and again when the declaration is
saved; a figure below p25 with at least three comparables notifies the unit's managers.

**Rationale.** A declaration becomes the price. Without the comparison, an optimistic number
passes through Pricing untested and the loss appears at closure, when nothing can be done. The
comparison is only useful before the price is locked, so that is where it lives.

**Why a unit sees only its own history.** Cost is the unit's to declare (Doc_H §12), and another
unit's costs are not theirs to read; roles that set or approve prices see every unit.

**Advisory.** Doc_H makes the unit responsible for its declaration. The assistant makes a
figure visible; it does not overrule it.

## ADR-032 — QC stage zero blocks only on certainties, reads inside archives, and never writes from a guard

**Decision.** At the unit's handover (`deliverable.submit`), the guard `deliverable.passesStageZero`
runs mechanical checks against the work order. FAIL findings — which alone block — are
objective: a format named in the order's *format field* is absent both as a file and inside every
readable ZIP; a file is zero bytes; a PNG/JPEG's pixels disagree with dimensions the order spelled
out. WARN findings never block: fewer items than the order counted, draft-like file names, words
resembling the project's out-of-scope list, empty entries inside an archive. Anything uncertain is
downgraded — a missing format when an archive could not be read is a WARN, not a FAIL. Every
result lists what was checked and what was not.

**Formats come from the format field only.** The expected-output text says what is being made
(«۳ پوستر»), not how it is delivered; posters routinely arrive as PDF. Reading it as a format
requirement failed a correct handover in testing. Counts and dimensions may come from either.

**Persian needs whole-word matching.** A substring match fails correct handovers: «ورد» (Word)
sits inside «مورد», «تصویر» inside «تصویربرداری». Matching is on whole words, Unicode-aware.

**Archives are read, not trusted blindly.** Source formats (PSD, AI, Figma, After Effects) are
outside the upload allow-list, so an "open file" can only arrive inside a ZIP. A check that could
not look inside one would demand something nobody can upload. The ZIP's central directory is read
with no library and no decompression; ZIP64 and damaged archives answer "could not read".

**Guards are pure.** Preflight (#2) runs guards on a read, and the rule lab (#5) replays them
against history, so a guard that wrote would change real records on every "why can't I?" and
every policy experiment. The result is stored by the `deliverable.submit` effect when the
handover happens, and by the explicit check endpoint; a refused handover survives in its
TRANSITION_BLOCKED audit event, reasons included. Waivable through the governed waiver (#7).

**Rationale.** A good share of what the Account desk sends back needs no judgement. Catching it
before a person spends time is the point; blocking on anything less than certain would teach
people to route around the check.

## ADR-033 — Audit anomalies compare a person with themselves, and only ever inform

**Decision.** `security:scan` reads the last 24 hours of `audit_events` every fifteen minutes and
raises six kinds of alert: exports and downloads out of hours, a download surge, exports from
projects the person has no tie to, a surge of refused permissions, failed logins from one address,
and a reused revoked session. Each count is compared with **the same person's** median day over
the previous 30 days: the absolute thresholds are floors, and a person whose ordinary day is heavy
raises their own bar. Alerts are stored once per kind, subject and window (`fingerprint`), so a
rescan updates the evidence instead of repeating the alert, and a review survives rescans.

**Rationale.** The trail was always complete and inspectable, and docs/operations.md told an
operator to watch it by hand, which in practice means reading it after the damage. A global
threshold alone would be wrong in both directions — a finance lead's month-end is not a designer's
midnight — so the person's own history is the reference.

**Why nothing acts automatically.** An alert is a suspicion about a colleague. A false positive
that locked an account would punish someone for the system's mistake, and the right response to a
true positive usually starts with a conversation. So alerts notify holders of `admin.audit` —
never the person concerned — and a dismissal requires a written reason, because "this was fine" is
the decision most worth being able to check later. Nobody reviews an alert about themselves.
(Session revocation on token reuse is done by the auth layer at the moment of reuse, not here.)

**Why out-of-scope access skips some roles.** Executives, PMO, finance and legal work across the
whole organisation; "outside their projects" does not describe them and would only generate noise
that teaches reviewers to dismiss.

**Limits, stated.** The detectors see what the trail records — exports, downloads, denials, logins.
Record *reads* are not audited, so browsing is invisible to them; and "downloads before a
resignation" can only be approximated by a surge against the person's own baseline.

## ADR-034 — Minutes are drafted by rule and confirmed by a person; audio is an adapter

**Decision.** A meeting's notes become a *draft* (`meetings/extract.ts`): lines are split into
decisions and actions by their markers and verbs, an owner is resolved against the organisation's
active users (full name, then a first or family name only when it is unique), and a due date is
read from the Persian phrases people actually use — Jalali dates, «۱۲ مهر», weekday names,
«ظرف N روز», «پایان هفته» — counted from the meeting's date, not today's. The draft writes
nothing. Only the confirmed minutes create tasks, in one transaction with the minutes themselves,
each sourced `MEETING_MINUTES` to the meeting code so Rule 6 ("no verbal task") holds for them.

**Rationale.** The damage in a meeting is the action nobody wrote down, and the second damage is
the one written down against the wrong person. So ambiguity is surfaced, never resolved by
guessing: two «آرش»s become a choice, a commitment with no owner and no date is listed as such,
and every action shows the line it came from. A rule-based extractor is predictable and
testable; an LLM could raise recall later behind the same draft shape, and the confirmation step
would stay.

**Audio.** Transcription is an adapter to any OpenAI-compatible speech endpoint
(`TRANSCRIPTION_URL`), tested against a local stub. It is off by default: meeting audio is some
of the most sensitive material an agency has, and where it goes is the operator's decision. The
audio is not stored; the transcript is kept as the minutes' source.

**Limits, stated.** The extractor reads Persian notes written a line per item; free-flowing prose
yields fewer actions and more "unresolved" lines. A deadline phrase it does not know is left in
the title for the person to see.

## ADR-035 — Questions are answered from a catalogue of defined metrics, not translated into queries

**Decision.** «پرسش از داده‌ها» maps a Persian question to a *plan* over a fixed catalogue of
sixteen metrics (`src/ask/catalog.ts`): each has a written definition, the date that places a
record in a window, the dimensions it can be split by, the filters it accepts and the permissions
its fields need. The plan is built by deterministic rules (`src/ask/parse.ts`, Jalali windows in
`src/ask/periods.ts`); a language model is consulted only when the rules find no metric, and only
to fill the same plan from the metric list — it never sees data, and every name it returns is
resolved again under the asker's reach. The answer states its understanding, its definition, its
records, and — the rule the whole design turns on — the words of the question it did not apply.

**Rationale.** The roadmap's own warning: a question answerer over raw tables produces answers
that look valid and are wrong. The two ways that happens are a definition invented on the spot
("margin" as whatever the query happened to compute) and a condition silently dropped ("for TV
campaigns" answered as if it were not there). The catalogue removes the first — where a dashboard
already shows the number, the definition is the dashboard's, and a test compares them; that test
found the units report counting undated tasks as late, now fixed. Reporting unused words removes
the second.

**Permissions at field level.** A metric declares every permission its fields need, not the
report it lives in: margin needs `finance.read` *and* `pricing.read`. Individual performance —
splitting or filtering by a colleague — needs `report.executive`; anyone may ask about
themselves. Cost history is per unit unless the asker sets or approves prices (as in #24). A
refused number is never computed, and the refusal is audited as `PERMISSION_DENIED`, so asking
for finance in a sentence is seen by the #26 detectors exactly like trying the finance page.

**What depends on #1 and #21.** Cycle time and the date an opportunity was won or lost come from
the state-transition log that process mining (#1) reads. Persian normalisation for matching
questions, names and synonyms is the memory index's (#21).

**Limits, stated.** Sixteen metrics, not every question: what cannot be mapped says so, and is
logged (`ai_interactions`, `NL_REPORT`, unsucceeded) as the list of what to add next. "Projects of
the media unit" means projects in which the unit received a work order, and a margin is the whole
project's, not the unit's share — the answer says so. The model fallback is an adapter: its
validation is tested with a stub planner; a live model call is not exercised here.

## ADR-036 — A foreign figure is converted once, at its own day's rate, and keeps it

**Decision.** The organisation's currency stays the base of every amount column, so every report
sums like with like and none of them changed. A figure written in another currency is converted
when it is recorded, at the latest rate on or before its own date (issue date, payment date, the
day a contract or cost is recorded), and stores its currency, the figure as written, the rate and
the rate's date beside the converted one. Rates are a dated history (`exchange_rates`), recorded by
holders of the new `finance.rates` permission; correcting a day's rate needs a reason and never
moves a figure already booked. A figure with no rate for its day, or only one older than
`FX_MAX_RATE_AGE_DAYS`, is refused with the currency and the day named.

**Rationale.** The roadmap's point for this market: with the rial moving daily, a six-month
contract's margin means nothing without the rate at the moment each figure was recorded. Storing
only the foreign figure and converting at "today's rate" on read would make every past report
change every day; storing only the converted figure would lose the contract's actual terms. Both,
frozen together, are what an accountant would book.

**Settlement in the invoice's currency.** A dollar invoice is settled when its dollars are, whatever
the rials came to. Its base `paidAmount` is the settled dollars at the invoice's own rate, so
"outstanding" and project settlement read zero for a paid invoice instead of flagging the exchange
difference as a dispute; the difference is reported as a realised exchange gain or loss. Open
dollar receivables, dollar contracts and dollar costs are revalued at the latest rate in
`/reports/fx`, beside what they were booked at — the answer to "is this project still profitable in
rials?". A receipt against a foreign invoice must state its currency: guessed wrong, it is off by
a factor of a million.

**Limits, stated.** Rates are entered or imported; no live rate feed is wired (the market has
several competing "rates of the day" and choosing one is the finance team's decision, not the
software's). Internal cost is always in base. Budgets and opportunity values remain base-only.

## ADR-037 — Revenue is recognised from the work, measured three ways, and closed months stay closed

**Decision.** A project earns its contract value in proportion to the work done, by the method it
chooses: milestone shares, effort (hours logged ÷ hours logged + estimate still to go), or cost
(labour at hourly cost plus payments out ÷ the larger of declared and incurred cost). A single
function computes a project's position at any instant from records already kept, so any month can
be read as it stood at its end. Recognised minus billed is work in progress (unbilled or deferred).
A finished month can be closed, in order and once: each project's figure is frozen in
`revenue_entries`, and anything recorded later with a date inside it lands in the next open month
as a catch-up.

**Rationale.** The roadmap's point: without recognition, the month a contract is signed or an
invoice goes out looks profitable and the months the work is done look like losses, so a monthly
profit report means nothing. The milestones, estimates, timesheets (#14) and cost declarations
needed to measure progress were already in the system. "Done ÷ (done + still to do)" rather than
"done ÷ planned" keeps an overrun from recognising more than the contract before the work ends —
the overrun lowers progress, which is the truthful reading.

**Why closed months do not move.** A reported month that changes after the fact is worse than a
late correction: people have acted on it. Freezing it and carrying the difference forward is how
every set of books treats a closed period, and the frozen row keeps the numbers it was computed
from, so the month can still be explained.

**Limits, stated.** Hours are costed at today's hourly cost (the person's, or their unit's), not
the cost when they were worked; hours with no cost are reported as unpriced, not guessed. A
contract's value at a past date subtracts later amendments by their effective date. An expected
loss (declared cost above the contract) is flagged, not provisioned. There is no reopening of a
closed month in the application.

## ADR-038 — Media is an agency's pass-through: the vendor's net is never revenue

**Decision.** Media bought for a client is a first-class record with its own state machine
(`mediaOrder`: booked, aired with proof, reconciled against the vendor's invoice). Each order
computes, from the vendor's quote and the deal, what the client pays, what the vendor is owed and
the difference — under `COMMISSION` the client pays the gross and the vendor deducts the agency
commission; under `MARKUP` the vendor is paid net and the client pays net plus the markup. The
client is billed on an intermediary invoice whose lines separate the pass-through from the
commission. In revenue recognition (#29) the agency earns the commission when the order runs; the
pass-through lines of invoices and payments to media vendors are left out of billed revenue and
project cost alike.

**Rationale.** The roadmap's point, and the market analysis's: media buying has its own financial
structure — pass-through cost, percentage commission, intermediary billing — and it is the one area
where the leading agency platform is genuinely ahead. Treated as ordinary revenue and cost, a
10-billion media buy on a 1-billion service contract makes the agency look eleven times its size
at a tenth of its margin. The agency acts as an agent for the media: only what it keeps is revenue.

**Why the controls.** Booking is confined to the media unit, Account and management by a guard,
because roles do not know units and every unit role holds `media.buy`. Delivery needs its proof,
because the commission is earned when the media runs and "it ran" is a claim. A vendor invoice
that differs from the booking by more than half a per cent cannot be reconciled without a written
reason: an unexplained difference is money nobody agreed to pay. The media report lists the four
places money gets lost — ran and unbilled, flight over without proof, awaiting the vendor, billed
differently.

**Limits, stated.** One currency per intermediary invoice. A vendor's invoice is compared in the
order's currency; the exchange difference between booking and paying a foreign vendor is not yet
in the exchange report (#28). A media order is booked at today's rate. Contract values are taken to
be the service fee; media is billed through media orders, not inside the contract value.

## ADR-039 — Keys act as their creator, narrowed; webhooks are thin events from the transition log

**Decision.** An API key is not a new kind of user. It acts with its creator's authority, narrowed
to the permissions it was given, recomputed on every request from the creator's own roles — so a
key can never exceed its creator, never carries a delegation, never holds the permissions that
would let it make more keys, users, roles or exceptions, and dies with its creator's account. Only
a SHA-256 of the key is stored. Every audit row written through a key names it, through a
request-scoped context rather than a change to every caller. Webhooks read `state_transitions`
forward from a per-subscription cursor — the transition log is already a transactional outbox —
and deliver thin, HMAC-signed events: which record, which move, when and why, never the record
itself, and only for entities the creator may read, re-checked at each event.

**Rationale.** The roadmap's point: the API was already clean, versioned and permission-checked;
what it lacked was a non-human identity, and without one every integration (#32, #33, #40) becomes
a special case. A separate service-account user would have to be excluded from every list of
people — assignee pickers, capacity, the people the question box resolves — and would hold
authority nobody answers for. Acting as its creator keeps accountability with a person and needs
no new kind of principal. Thin events cannot leak what a subscriber may not read: anything more is
fetched with a key, under that key's permissions.

**Why the address checks.** A webhook URL is an admin's input that the server will call. Refusing
loopback, private and link-local addresses — on save, and again inside DNS resolution at connection
time, so a name that later resolves inward is still refused — and following no redirects closes
the path to cloud metadata and internal services. On-premise installations can lift it knowingly.

**Limits, stated.** Delivery is at most about a minute behind (a minute-scheduled job). A key's rate
budget is per API process. Webhooks cover state transitions only — not creations or field edits.
The audit detectors attribute key activity to the creator (with the key named).

## ADR-040 — E-invoices are prepared and validated here; the live transport is an adapter

**Decision.** Reporting an invoice to سامانهٔ مؤدیان is a submission record: its subject (original,
correction, cancellation), a 22-character tax number, the tax number it replaces, and the payload —
header, lines, totals in whole rials, in the authority's field names — fixed when prepared. Every
reason the authority would refuse it that can be known in advance (the taxpayer profile, the
buyer's national ID and postal code, the kind and state of the invoice, line arithmetic against the
total, the date) is checked first and named in Persian. After acceptance only a correction or a
cancellation may follow, and the invoice's own cancellation is refused by a guard until the
authority has accepted its cancellation. Sending is a mode: off (queued), sandbox (an in-process
stand-in), live (the direct API).

**Rationale.** For an Iranian company this is a legal duty, not a feature, and the roadmap asks
for it directly. The part that decides whether an invoice is accepted — the numbers, the
identifiers, the arithmetic, the sequence of original, correction and cancellation — is ours to get
right and is tested here. The transport — a nonce, a token signed with the taxpayer's key, the
invoice signed (JWS, RS256, `sigT` critical, certificate attached) and encrypted for the authority's
key (JWE, RSA-OAEP-256 + A256GCM), then an inquiry by reference — needs keys only a registered
taxpayer has.

**Sources, and what is verified.** The tax number's layout and check digit follow the public SDKs
of the authority's API — `InvoiceHeader::setTaxID` in Jooyeshgar/moadian: memory id, days since
1970 in hex (5), serial in hex (10), and a Verhoeff digit over the memory id with letters as ASCII
codes, the day padded to 6 digits and the serial to 12. The Verhoeff implementation is checked
against the textbook vector; the envelopes are checked by round trip with generated keys; the
transport is checked against a stand-in authority. None of it has been exercised against the
authority itself: the roadmap marks the live half **Adapter**, and operations.md says to go live
through the authority's test environment first.

**Limits, stated.** Invoice type 1 (identified buyer) and the sales pattern only; the export pattern
with currency fields is not implemented — an invoice in another currency is reported in rials at
its booked rate (#28). Every line uses the profile's default service and unit codes unless it
carries its own. Settlement is reported as credit. Doc_H form A03 is unchanged; the buyer's postal
code is kept on the client record.


## ADR-041 — The ledger stays in the accounting package; Hiva writes its vouchers, in its own columns

**Decision.** Each invoice, cancellation after posting, receipt and payment becomes a balanced
double-entry voucher in whole rials, posted to the account codes of the organisation's own chart
and written as a CSV in the column order, headings and date format the organisation sets. A batch
takes everything not yet posted up to a date, is numbered, keeps its file byte for byte, and marks
every record it carried; a record is never posted twice, and an invoice cancelled after it was
posted is reversed in a later batch, dated the day it was cancelled. Nothing is posted while an
account it uses has no code; a client without a detail code is a warning, not a stop.

**Rationale.** General-ledger accounting is out of scope by decision (market-analysis.md): Iranian
agencies already keep their books in a local package, and the gap the roadmap names is re-typing.
The part that decides whether the books agree — which accounts, which side, pass-through apart from
revenue (#31), a foreign receivable cleared at its booked rate with the difference as exchange gain
or loss (#28), no double posting, reversals — is ours and is tested here. The part that differs by
package is the file's shape, so the shape is configuration, not code.

**Not verified, and not built.** No package's import format has been checked from this repository:
the layout is general enough for a voucher import (voucher number, date, account, detail, debit and
credit or a signed amount), and operations.md says to import the first batch into a test company.
No live connection to any package's API is built; an API key with `finance.read` (#46) lets an
integration pull batch files instead. The export does not post supplier bills as payables (a
payment out is expensed when paid), period-end work-in-progress adjustments (#29), or the matching
of an advance with the invoice that follows it — those remain the accountant's.

## ADR-042 — A client's approval is sealed evidence: the addressee, the moment, the address, the hash of what they saw

**Decision.** A client approves a delivered deliverable or a presented proposal on a page reached
by a link sent to one named contact. What they will be shown — the subject, its client-facing
content, each file's SHA-256 read from storage — is frozen and hashed when the request is made;
files are re-hashed each time they are served, and one that no longer matches is not served. Before
approving, the client must download every file; when the organisation's email is on, they must
also enter a one-time code sent to the addressee at that moment. The decision is sealed with the
typed name, time, IP, browser, the page's event log and the previous decision's hash in the
organisation — a hash chain — and a trigger refuses later changes to the sealed row. The client
is emailed a receipt carrying the hashes. The decision is then applied through the workflow
engine as the staff member who asked, with their current permissions.

**Rationale.** Disputes about approvals («این آن چیزی نیست که تأیید کردم») are claims about a
file and a moment. The document store already kept a SHA-256 per upload; what was missing was the
link between a decision and exactly those bytes, an identity for someone who has no account, and
a record the organisation cannot quietly edit. The code to the addressee's mailbox means a
forwarded link cannot be used to decide; the receipt in the client's hands, and the chain, mean a
rewritten record disagrees with something outside the organisation's control. Applying the
decision as the requester keeps the Doc_H rules in charge: a client's approval cannot move a
record further than the person who asked for it could.

**What this is not.** It is an electronic record with integrity evidence — not a secure electronic
signature backed by a certification authority's certificate, and not legal advice about how a
court will weigh it. With mail off, identity rests on the link alone, and the record says so; a
decision made from an address the organisation's staff also use is flagged, because a link handed
over by hand could have been used by the person who handed it over. Contract signature is
roadmap #36.

## ADR-043 — The client portal is a second identity, not a narrowed staff account

**Decision.** A client contact gets a portal account of their own: invited by Account, the
contact's email as the sign-in name, a password they set themselves from the invitation, and a
token signed with a key derived for the portal alone under its own issuer. The account carries no
roles and no permissions; every portal read is scoped to its company and filtered field by field
into what a client may see. Account decides who is in (`portal.manage`, kept off API keys because
it creates identities), which files are shown (off by default, one box per file), and answers the
conversation. The approvals of #35 are decided in the portal by their addressee, recorded as a
portal decision.

**Rationale.** Doc_H §7 makes the system the single source of truth, and today everything with the
client goes through email and messengers. The server-side rules the portal needs already existed —
delivery only after Account QC, the client's approve and revision transitions, the client version
of the weekly report — so what was missing was an identity for someone outside and a view built
for them. A staff account with a "client" role would have put the client one misconfigured
permission away from internal data; a separate identity with its own token cannot reach a staff
route at all, and a view assembled field by field cannot leak a field nobody chose to include.

**Limits.** No single sign-on or second factor for clients; sign-in is email and password with a
lockout. A client sees every authorised project of their company, not a chosen subset; the
conversation is per project, not per deliverable; files are shared one by one. Annotation on
deliverables is roadmap #38; e-signature of contracts is #36.

## ADR-044 — E-signature through a provider adapter; the contract is signed by the envelope completing

**Decision.** A contract awaiting signature is sent, as one of its own PDFs with its SHA-256 fixed,
to a provider: the client's contact signs first, the organisation's signatory second. Hiva follows
the envelope — a signed callback only prompts it to read the status back — and when every signer
has signed it keeps the signed PDF and signs the contract through the workflow engine as the
sender. While an envelope is out, the guard `contract.signatureNotInFlight` refuses a signature
recorded by hand, so there is one path to «signed» at a time. The provider is an adapter: an
in-process sandbox, and an HTTP provider behind a REST contract of ours.

**Rationale.** operations.md said plainly that signature was recorded, not executed: the moment of
signing happened outside, and SLA_CONTRACT_DRAFT stopped at internal approval with nothing
measured after. Keeping the sending, the order, the declines and the signed file inside the record
closes that. The part that makes a signature legally binding — a certificate from a licensed
certification authority, used on the signer's side — belongs to the provider; our REST contract
lets any provider be connected by a thin bridge without Hiva knowing its API.

**Not verified, and not built.** No real provider has been connected from this repository; the
roadmap marks the live half **Adapter**. Hiva stores the signed PDF and its hash and shows the
certificate details the provider reports, but does not validate the signature embedded in the PDF
(PAdES) itself. The sandbox's signatures are labelled as such on the page, in the certificate and on
the signed file's last page. Two signers, in a fixed order, per envelope.

## ADR-045 — Live updates are announced by the database and carry only that something moved

**Decision.** Triggers on `state_transitions` and `notifications` call `pg_notify` from the
transaction that writes the row; each API process listens on one connection and relays events to
the signed-in browsers over server-sent events. A transition event says which record moved and
between which states — not its content — and reaches only people in the organisation who may read
that kind of record; a notification event reaches its recipient. The page answers an event by
re-reading the queries on screen, at most every two seconds, through the ordinary endpoints; polling
remains as a slower fallback.

**Rationale.** The roadmap names the cost: a minute's delay on the QC queue, the traffic board and
the approval inbox. Every state change already goes through one table in the same transaction, so a
trigger is a publishing point no code path can miss — including jobs and other instances — and
PostgreSQL delivers a NOTIFY only on commit, so nothing rolled back is announced. Sending only "this
moved" keeps the permission model where it is: what the page then shows is fetched through endpoints
that already check it. SSE over fetch rather than WebSocket: one direction is all that is needed, it
passes through the existing proxy, and the token stays in a header.

**Limits.** No replay: events missed while disconnected are not resent; on reconnecting the page
re-reads what it shows instead. Record-level visibility finer than the entity type is not applied to
the event itself — it only says that a record of a type the reader may read moved. Only transitions
and notifications are announced; other edits still appear on the next read.

## ADR-046 — Approving from the messenger is approving in the app

**Decision.** A person links their messenger chat with a one-time code they requested in the app
and sent to the organisation's bot themselves. Notifications that need them are sent there too; a
form approval carries «تأیید / رد / باز کردن در سیستم». A button is an unguessable, single-use token
that expires and works only from the chat linked to the person it was sent to. Pressing it calls
`decideForm` — unchanged — as that person, with their roles, permissions and delegations as of that
moment and behind the same `form.approve` gate as the app's endpoint; a rejection asks for its
reason as the app does. Linking is refused to API keys. The provider is an adapter: an in-app
sandbox, and bots on the Telegram-compatible Bot API (Bale, Telegram).

**Rationale.** The roadmap's condition is the whole point: a decision taken in the messenger must be
indistinguishable, in its checks and its record, from one taken in the app, or the messenger becomes
the way around the rules. Calling the same function with the same actor keeps every rule in one
place — approver roles, stages and quorum (#18), delegation (#6), separation of duties — and the
audit row differs only in saying where it came from. Removing the "open the system" step from the
approver's loop is what the SLA figures need.

**Limits.** Only form approvals are decided from the messenger; other notifications carry a link.
The live bots are written to the Telegram Bot API and exercised against a stand-in, not the services
themselves. Eitaa, Slack and Teams are not connected. Whoever holds the linked chat holds the
approver's approvals for 72 hours — the same exposure as their email — and unlinking ends it.

## ADR-047 — Feedback is placed on the file, and a failed QC turns it into the revision's lines

**Decision.** Reviewers annotate a deliverable's own files — a pin on an image, a moment in a video,
a region of a PDF page — in positions stored as fractions of the file, numbered per file, with the
file's hash as annotated. A QC review that fails carries the annotations the reviewer ticks: the
revision's required correction becomes the written findings plus one numbered line per annotation
saying which file and where, and each annotation stays linked to that revision, to be marked
resolved. PDF pages are drawn in the browser with pdf.js, the one dependency this adds, loaded only
when a PDF is opened.

**Rationale.** The roadmap names the gap: agencies point at the exact spot all day, through screenshots
in messengers, and the revision (Doc_H §10) receives a paragraph that has to be decoded. The data
model already had QC reviews and revisions; putting the place into the record, and into the text of
the correction that the unit works from, closes the loop without changing the revision rules — a
revision still has its mandatory reason and correction; the correction is just precise now.

**Limits.** Images, videos and PDFs only; a ZIP or a PSD is not opened. A new upload is a new file:
its annotations start again (the old file's stay with it). No drawing tools beyond a pin and a
rectangle, and no threaded replies on an annotation.


## ADR-048 — A new version takes the file's place, and the old one is kept

**Decision.** A file's new version is uploaded against the file it replaces. It takes that file's
links, tags and brand role, joins its lineage with the next version number, and the replaced file is
kept, marked superseded — only the current version can be replaced, checked inside the upload's
transaction so two racing uploads cannot both win. Everything that lists or uses files takes the
current version: the record's files, e-signature, client approvals, QC stage zero, PDF attachments;
the annotator shows older versions with their notes, read-only. What each file says about itself —
pixel size, colour space, duration, pages and paper, a font's family — is read from its headers at
upload, with no new dependency. A client's brand library is a palette, typefaces and notes on the
client, plus the client's files that carry a brand role, kept under a new `brand.manage` permission
(unit and account managers). Previews are drawn in the browser from the file itself: images and
video as they are, a PDF's first page with the pdf.js already loaded for annotation, a font set in
itself through `FontFace`.

**Rationale.** The roadmap's gap is the «فایل نهایی واقعاً نهایی» problem: a reworked file uploaded
as a new file sits beside the old one, and whoever picks one — the client's approval link, the
contract sent for signature, the PDF bundle — may pick the wrong one. Making the new version *take
the place* of the old one, rather than sit beside it, answers that in every place at once, and
keeping the old one keeps the evidence: an approval or a signature records the SHA-256 of the file it
covered (ADR-042, ADR-044), and that file still exists. ADR-047's limit — «a new upload is a new
file; its annotations start again» — still holds, but the old version's notes are now one click away
from the new one, which is how a revision is checked. Colour space is read because agencies lose
days to RGB artwork sent to print; the brand library is on the client because the client, not the
project, owns its identity.

Showing a file is recorded as a view, not a download. Thumbnails, the annotator and the compare
read `GET /documents/:id/preview`, audited as `FILE_VIEW` once per person, file and hour; the
anomaly scan (ADR-033's detectors) counts each distinct file viewed. Verification found why: with
every thumbnail audited as `FILE_DOWNLOAD`, browsing one version history raised a `DOWNLOAD_SURGE`.
Leaving views out of the scan would have made previews a quiet way around it; counting distinct
files keeps the signal and drops the noise.

**Limits.** The client sees a new version only when it is shared (visibility is not inherited). No
branching: a version replaces the current one, not an older one. Colour profiles (ICC) and EXIF are
not read; a WebP, GIF or font file gives only what its header holds; WOFF/WOFF2 fonts are accepted
but their family name is not read (the data is compressed). Old versions are kept on disk for good —
there is no retention policy. Nothing checks designs against the brand library yet; that is #43.

## ADR-049 — The brand check reads colours from the file itself, and only advises

**Decision.** Each PNG, JPEG and PDF is read at upload for what it is made of: an image's main
colours with their share of the area, a PDF's colours as its content sets them and the fonts its
text selects. The reading is kept with the file's metadata — a version's bytes never change — and
compared, when asked, with the client's brand library as it is then: in CIEDE2000 for RGB, ink by
ink for CMYK against CMYK values the brand library now accepts. Results are warnings in QC stage
zero and a panel in the annotator; never a failure, never a blocked handover. No dependency was
added: a PNG is inflated with zlib and un-filtered; a JPEG is read only for each block's DC
coefficient — its average colour — which skips the inverse DCT and is exactly the resolution a
palette needs; a PDF's content streams are tokenised through pdf-lib, which was already here.

**Rationale.** «مغایرت با هویت بصری» is already one of the revision reasons, which says the error
recurs. Most of it is mechanical — the wrong navy, a font that isn't the brand's — and a machine
can name it before a person spends a review on it. It cannot judge the rest: a photograph has
colours no palette lists and a chart needs more than four, so the check names the colours and their
shares and leaves the verdict to the reviewer, in keeping with stage zero's rule (ADR-032) that
only certainties block. Tolerances differ by source: an image is measured through compression and
8×8 averaging, while a PDF's colours are exact numbers, so "almost the brand's navy" in a PDF is
itself a finding. CMYK is not converted to RGB, because without the file's colour profile the
conversion is a guess; it is compared with the brand's own CMYK, and left unjudged where the brand
gives none.

**Limits.** Fonts are read only from PDFs, not from text in images; images placed in a PDF are not
read; video, GIF, WebP and archive contents are not checked; logo use, clear space and composition
remain the reviewer's. Spot inks match only by name. Arithmetic-coded JPEGs and images over 60
megapixels are reported as unread. The reading costs up to about half a second of CPU per large
image, in the upload request.

## ADR-050 — Rules are added through one registry, from three sources, and never taken away

**Decision.** The engine no longer reads fixed `GUARDS` and `EFFECTS` maps; it asks a registry what
applies to a transition. Doc_H's guards and effects register themselves at start-up; an extension —
a module an operator puts in `EXTENSIONS_DIR` — registers its own through the same calls and may
attach guards to existing transitions; an organisation's no-code rules, written in the app and
stored as versioned rows in `custom_rules`, join at the transition: a GUARD is a condition in #17's
routing language that the move must satisfy, a NOTIFY tells roles when it happens. Preflight (#2),
waivers (#7), the audit trail and rule versions (#4) see all three. Installed extensions ride in
the workflows rule-set snapshot, so installing one is a new rules version that every later
transition names; with none installed the snapshot is exactly Doc_H's, so nothing changes.

**Rationale.** The product sells an organisation's rules, and every organisation's rules differ.
If the only way to add one is to change this repository, every customer is a fork — a project, not
a product. Two kinds of customer need two doors: an integrator writes code (an extension, loaded
from a directory, with the full context a core guard has), and a manager writes a sentence (a
condition over the record's fields, tried on a record and replayed against history before it is
published). Both are held to one property that keeps Doc_H meaningful: a rule can add a
requirement, never remove one. Keys are unique, so no extension replaces a core guard; attached
guards stand beside the declared ones; an extension effect may not write the state or rewrite a
field the core effect set; an organisation's rule can only block or notify. A rule version is never
edited — a change is the next version, the database refuses an in-place edit — so a transition can
always name the rule it met. Extensions fail closed at boot: running with some of an
organisation's rules silently missing is worse than not running.

**Limits.** Extension code runs with the API's rights; the directory is the operator's to guard,
and nothing in the app can install code. A guard is trusted to be read-only — it is given the
transaction to read and could write. No-code rules see the record's own scalar fields, dates as
days from now, and the acting user — not related records, counts or sums; the editor builds one
level of all/any (deeper nesting is API-only). A replay judges past moves against records as they
are today, as the rule lab does. Notices are in-app only (no email or messenger push).

## ADR-051 — An organisation is brought in from its own files, previewed, idempotent, and never around the rules

**Decision.** Onboarding imports people, units, clients, contacts, running projects and holidays
from the files an organisation has — `.xlsx` read without a library, or CSV in UTF-8 or
Windows-1256 — through one pattern: a preview that checks every row and writes nothing, then a
commit that writes the valid rows one by one. Rows already present are skipped by a natural key
(email, national id or legal name, the old system's project reference, the date), so a file can be
run again. The organisation's unit names are mapped to Doc_H's ten by a map a person confirms. No
password travels in a file: imported people get a one-time link to set their own, emailed or shown
once. Running projects come in at their current state through `recordOpeningState` — in the
engine, from the first state only, once, marked `opening` — and a project past authorization must
bring its authorization basis and document, recorded as an execution authorization.

**Rationale.** Setting up is where enterprise software sales are lost: the demo seed shows what the
system does, but a customer's first week is their own org chart, their clients, their running work.
The files they have are Excel, often saved as Windows-1256 CSV by Persian Excel (so «ي»/«ك» are read
as «ی»/«ک», or no name would ever match). A preview before any write, and a skip for what is there,
make a migration something that can be tried, corrected and run again, instead of a one-shot
operation. The two rules that make the system worth having are not relaxed for it: state is still
written only in the engine — an opening state is recorded there, visibly, never as a move — and
rule 13's authorization is still required, only now as a document reference from the old world.
`SUPER_ADMIN` is never granted by a file.

**Limits.** One sheet per workbook; formulas are read by their cached value; no import of work
orders, tasks, invoices or history — a running project comes in as a project, and its detail is
added in the system. Opening states cover projects only. The unit map is by name; two different units
with the same name cannot be told apart. The activation link, when mail is off, has to be passed on
by hand.


## ADR-052 — The phone does three things, and Web Push is built on the RFCs, not a vendor

**Decision.** The mobile experience is one screen of the web app, `/m`, installable to the home
screen, that does only the three things whose deadlines are hours: accepting a work order
(`SLA_TASK_ACCEPTANCE`), deciding a form, and recording a unit's level-1 QC with photos from the
camera. It acts through the same endpoints and the same engine as the full interface. The phone is
reached by Web Push, implemented in the API without a library: RFC 8291 payload encryption and RFC 8292
VAPID signing, with Node's own crypto, checked against the RFC's worked example. Only those loops'
notices, and warnings on their own clocks, are pushed. Two moves that hand over short-deadline work
now notify after the commit — an issued work order its owner, a submitted deliverable its unit's
manager (or their delegate in the unit). A photo taken at a QC review is the review's evidence, filed
on the review and not on the deliverable, not versioned, and removable only by its reviewer the same
day.

**Rationale.** A four-working-hour deadline is kept by someone who hears about the work while away
from a desk; the whole interface on a phone would be slower at the three things that matter and would
buzz for everything else, which is how people learn to switch notices off. A native app would be a
second codebase and a store process for three screens. A push library would be a dependency for what
is under a hundred lines of well-specified cryptography, and a hosted notification vendor would put every
notice's content through a third party — Web Push's encryption means the browser vendor's push service
carries it unread. A subscription is an address the server will POST to, supplied by whoever is signed
in, so it is held to the browsers' push services and the connection refuses internal addresses. The
level-1 QC notice goes to the manager, not to every member holding `qc.unit`, because every member
holds it to see the queue. QC evidence is kept apart from the deliverable's files because Account would
otherwise read a photo of the set as part of the work.

**Limits.** Delivery depends on the browser vendor's push service being reachable from both the server
and the phone; where it is not (common for FCM on some Iranian networks), `PUSH_DELIVERY=off` and the
messenger remain. iPhone receives notices only from the app added to the home screen (iOS 16.4+). The
three actions need a connection: unlike the form outbox (#19), a decision on the phone is not queued
offline, because it must meet the record's current state. The payload carries titles such as a work
order's name — encrypted, but its length and timing are visible to the push service. What this
installation can observe ends at the push service's `201`; that a phone showed the notice is checked
by a person with the test button.

## ADR-053 — The product is called هیوامیس; the code keeps its identifiers

**Decision.** From 2026-10-03 the product is **هیوامیس** (Hivamis): the browser title, the installed
app's name, the sign-in page, the shell, the mail and PDF taglines, the assistant's introduction, the
messenger bot and the phone screen say so. The agency in the demo data is still «هیوا» — an
organisation that uses the product, not the product. Package names (`@hiva/*`), storage keys
(`hiva.refresh`, `hiva.locale`), the database names and the outbound user agents are unchanged.

**Rationale.** The name is what people read; the identifiers are what installations depend on. A
renamed storage key signs everyone out; a renamed database or package breaks every deployment script
and integration that names it, for nothing a person would see.

## ADR-054 — A lead is its mobile number, and its source has two steps

**Decision.** (Hivamis task 2.) A lead's **تلفن همراه** is required and stored in one written form,
`09xxxxxxxxx`, whatever digits, spaces or prefix it was typed with (`normalizeIranMobile`, shared by
the web, the API and the form engine's new `mobile` field type). A number already on a lead, or on a
client's contact, stops the save and says who has it, unless the person ticks that the lead is new;
stored numbers are compared by their last ten digits, so ones typed before the single form are still
found. The source is a kind — sales team, marketers, company staff, direct contact, partner companies —
and exactly one detail: a member of the sales unit, a colleague outside it, a marketer or partner on
the organisation's list, or a channel. The database holds the kinds, the channels, and that only the
kind's own detail is set. Marketers are a list the system admin keeps; a partner company joins the list
the first time a seller names it. Existing leads were migrated: a cold call became the seller's,
events and campaigns direct channels, a referral a partner (unnamed), the rest direct contact.

**Rationale.** In an Iranian agency the mobile number is how a client is known, and two sellers
chasing one client is the usual way a lead is lost; the duplicate check is where that is caught.
A source is what a commission, a campaign's return or a partner's worth is later read from — "referral"
with no name answers none of those. Marketers may be owed money, so who counts as one is the admin's
decision; a partner company is only a name, and making a seller wait for an admin to write it down
would push the lead back into a spreadsheet.

**Limits.** Only Iranian mobile numbers are accepted as a lead's number; a lead reachable only on a
landline or abroad keeps it in «نیاز اولیه». Leads migrated from «REFERRAL» have no partner named,
and those from «INBOUND»/«OTHER» no channel — they show their kind alone. The duplicate check covers
leads and contacts, not suppliers or users.

## ADR-055 — Four roles hold everything; the administrator grants the rest, at once and on the record

**Decision.** (Hivamis task 6.) The managing director, deputy, system administrator and account
manager hold every permission, in code, not something an administrator can take back. Every other
role holds what the organisation's administrator granted: a grant is a row in `role_grants`, the
previous one kept and marked superseded, a new version of the permissions rule set (roadmap #4) and
an audit event; until a role is reviewed it keeps its Doc_H default and says so. Permissions are no
longer read from the code constant at sign-in but from the organisation's map, cached a few seconds.
An access token is stamped with each of its roles' grant counts; a request with a token whose role
was granted anew since is refused `401 GRANTS_CHANGED`, the client refreshes and the app re-reads the
user, so a permission taken away stops working — and its screen disappears — on the next click, not
fifteen minutes later. Every page part is shown only to who may use it: the administration page is
open to anyone holding one of its permissions, each of its tabs only to its own. A development
script (`apps/api/scripts/visibility-audit.ts`) signs in as each demo role, opens every page, record
and tab its navigation offers, and lists every call the screen made that the server refused.

**Rationale.** The organisation's people, not the product's authors, decide who does what; the
product's defaults are a starting point the administrator approves. Taking a permission away is
usually urgent — someone moved, someone left a role — so it must not wait for a token to expire;
per-role counts invalidate exactly the tokens a grant affects, with no clock comparisons to get wrong.
Full access is not exemption: Doc_H's guards are rules of the process, and the waiver remains the
governed, recorded way past one. Hiding is checked rather than assumed, because a tab that renders
and then fails is exactly what "they should not even see it" forbids.

**Limits.** Delegated permissions are re-checked against the delegator's role at the delegate's next
token, not instantly. Open live-update streams keep the permissions they opened with until the token
behind them ends. Roles themselves are the sixteen Doc_H roles; an organisation cannot yet define a
new one. Form approver routing names roles (`approverRoles`), not permissions, so a full-access role
decides only the forms routed to it.

---

## ADR-056 — English is a catalogue over Persian sources, read back where it was composed

**Decision.** (Hivamis task 7.) Persian stays the source language everywhere. Every visible string
in the web app goes through `tr('…{0}…', value)` — 2,430 of them, put there by a type-aware codemod
(`apps/web/scripts/i18n-wrap.mts`) that keeps each JSX sentence whole with placeholders. Two
catalogues hold the English: the app's own words (`apps/web/src/i18n/en.json`) and what the API and
the contracts put in front of people — states, transitions, guard messages, permissions, form fields,
notifications (`packages/contracts/i18n/en.json`, 2,467 entries, extracted by
`packages/contracts/scripts/i18n-keys.mts`; where a source already pairs `labelFa` with `labelEn`,
that pair is the translation). A translator in `@hiva/contracts` reads text that arrives already
composed («انتقال «ارسال» از وضعیت «پیش‌نویس» مجاز نیست.») back against the template it came from,
recovers the values, translates each in turn, gives a bare number Latin digits, and joins phrases
built from known parts («تماس مستقیم — رویداد») part by part. A person's or client's name — which no
catalogue holds — stays as written.

The web reads data-borne Persian through `loc(record, 'label')` (a record's English side, else its
Persian read back), `pair({ fa, en })` and `trx(text)`; a second codemod
(`apps/web/scripts/i18n-dynamic.mts`) applied them where such a value is shown, never where it is
data. Numbers are Latin, money says "Rials", dates are Gregorian ("3 Oct 2026") and the date fields
are the browser's own picker, emitting the same `YYYY-MM-DD` / UTC instant as the Solar Hijri entry.
The API answers errors in the request's `Accept-Language` (the web sends it on every call), message
and the words inside its details; logs, the audit trail and stored records keep the Persian they
were written in.

The language is fixed for the life of a page: switching saves the choice, tells the server
(`PATCH /auth/me/locale`) and reloads. The catalogues are fetched only for English, before any app
module runs (`main.tsx` → `boot.tsx`), so a label a module builds when it loads is already in English
and a Persian reader downloads none of it. A device with no choice of its own adopts the signed-in
person's saved language.

**Rationale.** The product is written, reviewed and used in Persian; an English layer must not move
that. Keeping Persian as the key means a string cannot be added without its source, and the
completeness tests (`apps/web/tests/english.test.tsx`, `apps/api/tests/029-english.test.ts`) fail
the build for any string — web or server — without English. Reading composed text back avoids
threading a locale through every guard, validator and notice in the API, which would have touched
hundreds of call sites and the stored audit text with them.

**Limits.** Documents keep the language they were issued in: PDFs, emails, the approval certificate
and accounting vouchers are Persian. The question parser of "ask the reports" understands Persian
questions only. The user guide is written in English and shown as it is in both languages. A short
Persian word with two meanings in two places has one English; where that read wrong («ورود» as both
"Sign in" and "Import") the Persian source was made specific. Text an organisation types itself —
a department's name, a rule's label — is English only where they gave an English side.

---

## ADR-057 — A unit is a coloured tag, in a colour the system administrator chooses

**Decision.** (Hivamis task 9.) Each unit has a tag colour: `departments.tagColor`, `#rrggbb` lower
case (a database CHECK refuses anything else), null meaning the unit's default from
`DEFAULT_UNIT_COLORS` in `@hiva/contracts` — ten distinct hues, so a fresh installation already tells
its units apart. The system administrator (`admin.settings`) sets it from Administration → Unit
colours (`PATCH /departments/:code/color`), one click per swatch or any colour by hand, and the change
is audited. Wherever the web showed a unit as a bare code it now shows `<UnitTag>`: the unit's name on
its colour, with black or white text chosen by contrast (`textOn`), the code in the tooltip.

**Rationale.** The person who asked wanted units recognisable at a glance across the system, and the
organisation, not the product, to decide what each unit looks like. Choosing the text colour instead
of restricting the palette means no colour the administrator likes is refused: for any background one
of black or white reaches at least 4.58:1, above WCAG AA for small text. The tag reads the units list
the calendar and form pages already share (`GET /departments`, kept five minutes), so it costs no new
request.

**Limits.** A colour change reaches other people's open pages when their units list is next fetched
— within five minutes, or on reload — not instantly. Charts keep their own series colours; PDFs and
emails do not show unit colours.

---

## ADR-058 — More ways in, one way to be given access; a page for every person

**Decision.** (Hivamis task 4, first part.) Besides email and password, a person signs in with a
six-digit code texted to a mobile they proved is theirs, or with Google (OpenID Connect,
authorization code with PKCE and a nonce, the ID token verified against Google's keys). Codes are kept
only as an HMAC bound to their purpose and number, last five minutes, allow five tries and one send a
minute; the sign-in start answers the same whether or not the number has an account. Google answers
the browser with a redirect carrying a single-use, minute-long ticket in the fragment, traded by the
page for a session — no token in a URL. Every way in ends in one `issueSession`, which records the
method in the audit trail. SMS goes through an adapter: a sandbox (messages readable by an
administrator), Kavenegar's verify/lookup, or a generic HTTP endpoint. Someone without an account can
ask to join with a proved mobile or a Google account; a request grants nothing until the administrator
of users approves it and chooses the unit and roles (never system administration), and the
administrator can close joining altogether. Every person has a page (`/people/:id`) and a directory;
one's own page (`/me`) manages the ways in — at least one always remains — and the signed-in devices.

Sessions now record why they ended. Only a token whose session was rotated away and is presented
again is treated as theft (every session revoked, `REFRESH_TOKEN_REUSE`); one ended by signing out, a
password or role change, a delegation's end or deactivation is simply refused.

**Rationale.** People asked to sign in the way they already sign in elsewhere, and to join without an
administrator typing their details — but who may do what stays the administrator's (ADR-055). Proving
a mobile before it can sign anyone in, and refusing to say whether a number has an account, keep the
new doors from being a way to find or take accounts. The session reasons fix a real fault found while
building the device list: before them, an administrator changing someone's roles — or the person
signing out a device — made that device's next refresh look like token theft, signed the person out
everywhere and raised a critical alert. Those were the false TOKEN_REUSE alerts seen during task 6.

**Limits.** Google sign-in is tested against a stand-in provider with its own keys; it needs the
organisation's own OAuth client to run for real, and Google must be reachable from the server. The
Kavenegar and HTTP SMS adapters are written to the providers' documented APIs but not exercised
against them here. Joining goes to the one organisation an installation has; with several (roadmap
#50) it will come from the address. Profile photos are not part of this: a person is their initials
on their unit's colour.

---

## ADR-059 — A record's page offers its forms, filled in; the catalogue is the fallback

**Decision.** (Hivamis task 4, second part.) Every record page shows the forms related to it as one
row of buttons under its title. A form is related when one of its fields points at that kind of
record — read from the form definitions themselves, so a form the organisation designs (roadmap #15)
joins in without code. The row holds only forms the reader's unit may send, by the same
`maySubmitForm` rule the form engine enforces; it puts first the Doc_H categories the record's stage
calls for (`RECORD_KINDS` in `@hiva/contracts`: a project being authorised → contract and finance; in
delivery → orders, unit work, QC, reporting; closing → closure), then the forms the reader's unit has
sent most in six months. A click opens the form with every field that points at the record — or at
the records it belongs to: its project, client, proposal, contract — already filled. A «+» in the top
bar lists the forms the person sends most, or, before they have sent any, the ones that start
something.

**Rationale.** The person asked for processes that are a click and already prepared, with the related
forms on each page, and for speed. The catalogue of 130 forms asks someone to know which form
comes next and to find, then retype, the record it is about; the record's page already knows both.
Deriving relatedness from the field definitions, and order from the stage and from use, keeps the
suggestion honest — a form never appears that the person cannot send, and none is hidden that they can.

**Limits.** Fields other than record references are not prefilled (a status report's period, say).
The stage map is a default an organisation cannot yet edit. List pages keep their own «new» buttons;
the related-forms row is on record pages only.

## ADR-060 — The assistant is a local model that reads as the person and only offers

**Decision.** (Hivamis task 5.) A chat assistant in the top bar answers with a model served by
Ollama on the organisation's own machine. The default is `qwen3:14b`, with thinking turned off for
speed.

The model is given tools: search records, read one, list records of a kind by state (and projects
by health), see the person's work, ask the report engine (#27), search the organisation's memory
(#26), list the forms that fit a record, offer a form, and offer a page. Each read tool calls this application's own endpoint in-process. It uses
the asking person's token and language, so the permissions, unit scoping and field hiding that
apply to them apply unchanged. Nothing can be written. A form is offered with its fields filled,
and only if the person's unit may send it. The person checks it and sends it. Pages are limited to
an allow-list of in-app paths.

The answer streams as server-sent events. The page it was asked from is part of the question. When
that page is a record, the record and the forms that fit it are read before the model starts, and
put in its instructions, which saves it a round.

What tools return is shaped before the model sees it: amounts are given with their currency and
thousands separators, dates in the reader's calendar, and only the reader's language of each
label. In a trial the model, given a raw `4400000000`, reported a budget of 440 million tomans as
4,400 million.

A form the answer names, by code or by a name from the forms it was shown, becomes a button
through `offer_form` if the model did not offer it. That happens only when it names four or fewer;
more is a list. Links written in the text are shown as plain words.
Answers are written one at a time, and the rest queue and see their place. Conversations belong to
their owner. The governance log records the tools and records used, never the words.

**Rationale.** The person asked for an assistant that is free, unlimited and local, "like Ollama".
A hosted model meets none of the three. Going through the application's own endpoints, rather than
giving the model a database or a parallel set of queries, means the assistant cannot see more than
the person. It also cannot drift from the rules as they change, and a new permission or a field
hidden in #43 applies to it without further work.

Offering instead of doing keeps every write behind the forms, the workflow engine and their rules.
A small local model will sometimes be wrong, and here being wrong costs a click, not a record.

**Limits.**

- A 14B model on a laptop is slower than a hosted one: seconds for a short answer, longer when it
  looks several things up.
- It is weaker at arithmetic over many rows, so numbers should come from the report tool rather than
  from the model.
- It does not always follow its instructions. In trials it said a form was ready without offering
  it, and recited every fitting form when asked to recommend one or two. That is why buttons come
  from what the answer names, not only from what the model offers.
- One answer at a time is the default on a laptop.
- Conversations are not searchable, and are not shared.
- `ai.chat` is in every role's defaults. A role whose permissions an administrator set explicitly
  before this version does not have it until it is ticked.

## ADR-061 — The guide is data, the owl reads it on the live page, and videos are the organisation's

**Decision.** (Hivamis task 8.) The guide is one section per page (`GUIDE` in `@hiva/contracts`).
Each section has a summary and steps, in Persian and English side by side, and each step may point
at an element through a `data-tour` anchor on the shared components (page header, list toolbar,
workflow actions, related forms, tabs).

Hiva the owl sits in the corner of every page. Clicking it opens that page's section. **نمایش
گام‌به‌گام** plays the section like a video: the owl flies beside each element, the rest of the page
dims, a caption speaks, and the steps advance on a timer with pause, back, next and Escape.

Questions are answered at once from the guide by a local search in either language. Answers are
limited to sections the person may open, and an answer on another page navigates there and plays
from that step. Anything the guide cannot answer goes to the assistant (ADR-060), which now also has
a `search_guide` tool and knows which page's guide it was opened from.

Recorded videos are uploaded by the system administrator, one per section and language. They play
through a three-hour signed link, served in byte ranges.

The owl is drawn in three dimensions with three.js, built from primitives. It breathes, blinks,
follows the pointer or the tour's target, talks, thinks, waves and hops. It is drawn flat (SVG)
without WebGL, and holds still under reduced motion.

**Rationale.** The person asked for an owl that guides in smooth 3D and answers questions, with text
and video guides per section.

- **Tours instead of shipped videos.** Videos we recorded would go stale with the next change to a
  screen, would exist in one language, and would not know what the person may see. A tour drawn on
  the live page has none of these problems. Recorded videos remain the organisation's choice: its
  own process, its own voice.
- **Guide as data.** It can be checked: a test fails if a step points at an anchor no component
  carries, if a page has no section, or if English text contains Persian. One source then serves the
  panel, the search and the assistant.
- **Primitives instead of a model file.** Nothing to license or download, a small chunk, and a
  character in the house colours.

**Limits.**

- The guide's text is the product's. An organisation cannot yet edit it, only add videos.
- Steps on detail pages, and in tabs that are not open, show their caption without a highlight, and
  say so.
- The search matches words, not meaning; the assistant covers the rest.
- The written user guide (docs/user-guide.md) is still English, opened from the panel.
- The owl's three.js chunk is the largest single addition to the web bundle, though it loads only
  when the owl appears.

## ADR-062 — The interface takes its values from the chosen Figma kit, as tokens

**Decision.** (Hivamis task 3.) The organisation chose a Figma community kit ("Main Dashboard",
Constructor X) and supplied it as a `.fig` file. The file was decoded directly, without the Figma
connector: its kiwi-encoded document, its components, and its variables in Light and Dark mode. The
interface was then brought to it in two layers.

- **Tokens** (`apps/web/src/index.css`, listed in docs/design.md):
  - the kit's neutral grey ramp becomes `ink-*`, and its blue primary `brand-*`;
  - its Background and Base-0 become the new `canvas` (the page) and `surface` (cards);
  - its shadow becomes `shadow-sm`, and its square cards make `rounded-xl` 0;
  - dark mode takes the kit's Dark values, still by redefining tokens only.
- **Shared components:**
  - the 32px controls;
  - the dark button as the main action, black on light and white on dark;
  - square bordered cards, metric tiles with an outlined icon, and bold grey labels;
  - tabs with an outlined selected tab;
  - the sidebar's grouped navigation with the person's card, folding to a rail on desktop;
  - a 64px top bar that, on a phone, shows the logo and opens search over itself;
  - a centred content column, and the head line over a hairline;
  - the kit's half gauge, on the dashboard's deadlines.

Every page is built from these components, so the redesign reaches every page without editing each
one.

**Rationale.** Taking the file's own variables, rather than matching colours by eye from a picture,
makes the result the kit's, in both modes. Keeping the change in tokens and shared components keeps
dark mode, RTL and every page consistent, and means a later change of palette is a change of
values. The kit's other primaries (Pink, Indigo, Emerald) and grey themes are one edit away.

**Departures from the kit:**

- **Secondary text** (`ink-500`) is one step darker than the kit's base-500, to keep 4.5:1 contrast
  for small text on white.
- **Type.** Labels are one step larger than the kit's 10–12px, because Persian script at 10px bold
  does not read. Vazirmatn replaces Inter, which has no Persian glyphs.
- **Status badges** keep the platform's single status scale. In the dark they are tinted, through a
  `dark:` variant tied to the app's own theme switch.
- **Text alignment.** Tables and cards that were hard-coded to `text-right` now use `text-start`, so
  English reads left to right.

**Limits.**

- Of the kit's charts, only the half gauge is used. The column chart and the progress rings have
  no data on the dashboard that calls for them yet.
- Alert boxes written with fixed light colours outside the shared badges (some `bg-rose-50` and
  `bg-amber-50` notices) stay light in dark mode.
- The kit's footer is not reproduced; the app has no footer content.

## ADR-063 — A refresh token is spent once, by one tab at a time; an unanswered refresh is not a refusal

**Decision.** (Hivamis task 10.) The sweep found three faults around refreshing a session, and
fixed them together.

- **The server rotates atomically.** It revokes the presented session only if it is still live
  (`updateMany … where revokedAt is null`), inside the transaction that creates the new one. When
  two requests present the same token at once, one rotation wins. The other is handled as the
  replay it is: every session of the account is revoked, and the reuse is audited. Before, both
  rotated, and the account gained two sessions from one token. The test's two simultaneous
  refreshes answer `200, 401` now, and answered `200, 200` against the old code.
- **The browser refreshes one tab at a time.** Concurrent 401s in a tab already shared one
  request. Tabs now take turns through a Web Lock (`hiva.refresh`), and each reads the stored token
  inside the lock. A tab never presents a token another tab has just rotated, so the stricter server
  never reads two tabs as theft. Restoring the session on page load uses the same path; it used to
  call the endpoint directly, which is how React's development double mount produced pairs of
  sessions.
- **An unanswered refresh keeps the session.** A network error, a 5xx or a 429 is reported as
  *unreachable*: the stored token is kept, the page says the server cannot be reached and tries
  again with backoff, and «تلاش دوباره» tries at once. Only a refusal from the server (400, 401,
  403) ends the session. Before, any failure deleted the token, so a server restart or a deploy
  signed out everyone who loaded a page during it.

**Rationale.** Reuse detection is only worth having if it is not triggered by the system itself.
Weakening it with a grace window would also forgive an attacker who replays quickly, so the fix
makes legitimate clients unable to spend a token twice, and makes the server unable to honour it
twice.

**Limits.** A browser without Web Locks (none of the supported ones) falls back to one refresh per
tab. Two devices can never share a refresh token, so they never race.

## ADR-064 — Several organisations on one installation, and an upgrade that brings each up to the code

**Decision.** (Roadmap #50.) The four gaps ADR-008 listed are closed, and an installation can be
installed, upgraded, backed up and restored without hand work.

- **Codes per organisation.** `form_definitions` and `sla_policies` are unique on
  `(organizationId, code)`. Every lookup by code takes the organisation from the actor or the
  input. The sweep found `GET /forms/definitions/:code` unscoped, which was harmless with one
  organisation and a cross-tenant read with two.
- **Resolution.** `TENANT_MODE=multi` finds an anonymous request's organisation by host
  (`organizations.hosts`):
  - asking to join, the sign-in page's name and phone sign-in use the organisation of the address;
  - a Google «ask to join» carries the organisation it began in, in its sign-in state;
  - a person signs in at their own organisation's address or at the installation's own, and
    elsewhere is told what a wrong password is told;
  - a suspended organisation (`isActive`) signs nobody in, and its sessions end with reason
    `SUSPENDED`.
- **Provisioning.** `cli tenant:create` checks everything before writing anything. It creates the
  organisation, runs the reference sync for it, and creates a system administrator in the management
  unit with no password and a one-time activation link at the organisation's host. In `single` mode
  it refuses a second organisation.
- **The upgrade path.** The seed's reference phase became `src/setup/reference.ts`, and the API
  runs it on start (`REFERENCE_SYNC=on`).
  - It runs as one transaction behind `pg_advisory_xact_lock`, so replicas take turns and a failure
    changes nothing.
  - It adds what is missing and refreshes what the catalogue speaks for. It keeps what an
    organisation made its own: designer-edited forms (`customizedAt`), and SLA hours an
    administrator set, which now stamp `customizedAt`. Before, a re-run seed reset them.
  - Runs that changed something, or met a new version, are recorded in `system_upgrades`.
  - Against this installation's own database, the first start after the change gave the lead form
    the fields task 2 had added in the code several commits
earlier.
- **The operator's script.** `infrastructure/hivamis`:
  - `install` generates the secrets into a 600-mode `.env`, starts the stack and provisions;
  - `backup` and `restore` run `pg_dump`/`pg_restore` and `tar` inside the containers;
  - `upgrade` backs up, rebuilds stamped with `git describe`, restarts and reports;
  - `status` and `tenant` pass through to the CLI;
  - `HIVAMIS_DRY_RUN=1` prints every command, which is how the tests exercise it.

**Rationale.** The single-organisation assumption lived in a handful of places: two unique indexes,
a dozen lookups by code, two `findFirst` organisation lookups. Closing them cost less than ADR-008
feared, because the scoping was already everywhere else.

The upgrade gap was a real defect, not a feature. Every installation that upgraded silently ran on
the previous version's forms and SLA policies. Making the code's reference data reach the
database on every start, while respecting what each organisation changed, is what makes an on-premise
installation maintainable by someone other than its developer.

**Limits.**

- Roles, permission definitions, the record-number sequence and email uniqueness are shared across
  the installation.
- Google sign-in returns to `PUBLIC_APP_URL` and completes there.
- Organisations are created and suspended from the command line; there is no platform operator's
  web screen.
- The installer and upgrade were exercised in dry run here (no images were built on this machine);
  the CLI, provisioning and the reference sync ran against the real databases.

