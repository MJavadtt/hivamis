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
A hand-rolled engine here is ~180 lines and keeps everything in one transaction.

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
validator, one routing/approval/SLA engine serves all 130. About 25 forms additionally carry a
typed `binding` that drives a first-class domain record.

**Alternatives considered.** Hand-coding each form was rejected as unmaintainable and as a
guarantee that the catalogue would drift from the documents.

**Consequences.** Adding or amending a form is a data change. The trade-off is that a generic
renderer cannot express a highly bespoke layout — acceptable, because these are structured
operational forms. Forms without a binding are honest structured communications, which is what
Doc_H asks of them; they are not presented as more than that.

---

## ADR-005 — Business-hours SLA arithmetic

**Context.** Doc_H states SLAs in *working* hours. A 4-working-hour SLA started at 16:00 on a
Wednesday is due Saturday at 11:00, not Wednesday at 20:00.

**Decision.** A calendar-aware arithmetic module driven by the organisation's own working days,
hours, break and holidays.

**Consequences.** SLA compliance figures are defensible. The calendar is data, so a change in
working hours needs no code change. Verified by five calendar tests including the
Thursday–Friday Iranian weekend.

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
