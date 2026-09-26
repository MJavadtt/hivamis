# API reference

Base URL: `/api/v1`. All responses are JSON. All dates are ISO-8601 UTC.

## Authentication

```http
POST /api/v1/auth/login
{ "email": "account.manager@hiva.local", "password": "…" }

200 { "accessToken": "...", "refreshToken": "...", "user": { … } }
```

Send the access token as `Authorization: Bearer <token>`. It expires in 15 minutes;
`POST /auth/refresh` exchanges the refresh token for a new pair and **invalidates the one you
sent** — refresh tokens are single-use.

| Endpoint | Purpose |
|---|---|
| `POST /auth/login` | Sign in. Rate-limited; the account locks for 15 minutes after 5 failures |
| `POST /auth/refresh` | Rotate tokens |
| `POST /auth/logout` | Revoke the current session, or all sessions when no token is sent |
| `GET /auth/me` | Current user with roles and resolved permissions |
| `POST /auth/change-password` | Change password; revokes every session |

## Conventions

**Pagination** — list endpoints accept `page`, `pageSize` (max 200), `sort`, `order`, `q`:

```json
{ "items": [...], "total": 42, "page": 1, "pageSize": 25, "pageCount": 2 }
```

**Errors** — every failure returns the same envelope:

```json
{ "error": { "code": "GOVERNANCE_RULE_VIOLATION",
             "message": "پروژه بدون مجوز معتبر وارد اجرا نمی‌شود.",
             "details": { "rule": "Doc_H §13 — شروع اجرای پروژه" },
             "requestId": "…" } }
```

| Status | Code | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR`, `FORM_VALIDATION_ERROR` | Input rejected; `details.issues` lists field paths |
| 400 | `REASON_REQUIRED` | The transition requires a reason |
| 401 | `UNAUTHORIZED` | Missing, invalid or expired token |
| 403 | `FORBIDDEN` | Permission denied; the denial is audited |
| 404 | `NOT_FOUND` | Record absent or outside your organisation |
| 409 | `ILLEGAL_TRANSITION` | Not declared from the current state; `details.allowed` lists legal actions |
| 409 | `DUPLICATE` | Unique constraint |
| 422 | `GOVERNANCE_RULE_VIOLATION` | A Doc_H rule blocked it; `details.rule` names the clause |
| 429 | `RATE_LIMITED` | Too many requests |

## Workflow — the universal state-change path

Every lifecycle move in the platform goes through one endpoint.

```http
POST /api/v1/workflow/:entity/:id/transitions
{ "action": "authorize", "reason": "optional", "payload": {} }
```

`:entity` ∈ `lead · opportunity · brief · proposal · project · workOrder · task · deliverable ·
revision · changeRequest · contract · invoice · outsourceRequest`

| Endpoint | Purpose |
|---|---|
| `GET /workflow/definitions` | All 14 state machines |
| `GET /workflow/:entity/definition` | One state machine |
| `GET /workflow/:entity/:id/available` | Transitions this caller may perform now |
| `GET /workflow/:entity/:id/preflight` | Every transition out of the current state with every guard's verdict — `checks[]` of `{ guard, labelFa, ok, messageFa?, rule? }`, plus `permitted` and `ready`. Read-only; needs the entity's read permission |
| `GET /workflow/:entity/:id/preflight/:action` | The same for one transition; `409` with `details.allowed` if it does not exist from this state |
| `GET /workflow/:entity/:id/history` | Full transition log with actor and reason |

List and detail responses also embed `availableTransitions`, so the UI never offers an
action the engine would reject on authority.

## Domain endpoints

Standard collections support `GET /`, `GET /:id`, `POST /`, `PATCH /:id`.
`state` is never writable through `PATCH` — it belongs to the workflow engine.

| Resource | Path | Read permission |
|---|---|---|
| Companies | `/companies` (+ `/:id/360`) | `crm.company.read` |
| Contacts | `/contacts` | `crm.contact.read` |
| Leads | `/leads` (+ `POST /:id/convert`) | `crm.lead.read` |
| Opportunities | `/opportunities` | `crm.opportunity.read` |
| Activities | `/activities` | `crm.activity.read` |
| Briefs | `/briefs` (+ `POST /:id/recalculate`) | `brief.read` |
| Proposals | `/proposals` | `proposal.read` |
| Projects | `/projects` (+ `/:id/360`, `/finance`, `/closure`) | `project.read` |
| Project budget | `GET /projects/:id/budget` — budget against declared cost per work order (`status`: NO_BUDGET / UNDER / NEAR / OVER, variance, declaration count), rolled up per unit and for the project | `project.read` + `pricing.read` |
| Time on tasks | `GET /tasks/:id/time`; `POST /tasks/:id/time { hours, workedOn?, note?, userId? }` (the assignee, or `task.write`; 0 < hours ≤ 24); `DELETE /tasks/:id/time/:entryId`. `actualHours` is maintained as the sum. `POST /workflow/task/:id/transitions { action: 'submit', payload: { hours } }` logs one entry with the submission | `task.read` to read |
| Schedule | `GET /projects/:id/schedule` — critical path: per task earliest/latest start and finish, `floatHours`, `critical`, `missesDueDate`, `estimateAssumed` (no estimate → 8h); `projectedEnd`, `slipHours` against the plan; `cycles`. Durations are working hours on the assignee's calendar | `project.read` |
| Forecast | `GET /projects/:id/forecast?runs=&seed=` — Monte Carlo over the open tasks' dependency chain: each task's estimate is multiplied by a ratio drawn from the actual/estimate ratios of finished tasks in its department (≥8 samples), else the organisation's, else a default distribution. `percentiles.p50/p85/p95` (dates and working hours from now), `probabilityOnTime` against `plannedEnd`, a 10-bucket `histogram`, `samples` (where each department's ratios came from), `deterministicHours` (what one number would have said). `runs` 100–10000 (default 2000); a `seed` reproduces a forecast | `project.read` |
| Dependencies | `POST /tasks/:id/dependencies { prerequisiteId }` (finish-to-start; same project; a loop is refused with `CYCLE`), `DELETE /tasks/:id/dependencies/:prerequisiteId` | `task.write` |
| Cost accuracy | `GET /reports/cost-accuracy?from=&to=` — declared internal cost against Σ hours × hourly cost per unit and per work order, with `unpricedHours` for people without a rate, `ratio` (actual / declared) and the mean estimate error of tasks | `report.read` + `pricing.read` |
| Hourly cost | `PATCH /departments/:code/rate { hourlyCost }` (`admin.settings`), `PATCH /users/:id/rate { hourlyCost }` (`admin.users`); a person's own rate beats the unit's default; null clears |
| Work orders | `/work-orders` (+ `POST /:id/cost`) | `workorder.read` |
| Tasks | `/tasks` | `task.read` |
| Deliverables | `/deliverables` | `deliverable.read` |
| QC reviews | `/qc-reviews` (+ `/qc/queue`) | `qc.read` |
| QC stage zero | `POST /deliverables/:id/stage-zero` — the mechanical checks, on demand (roadmap #22): every format the work order's *format field* names is present (directly or inside a ZIP, whose central directory is read), no file is empty, PNG/JPEG pixels match dimensions the order spelled out, and — as warnings only — as many items as the order counted, no draft-like file names, nothing resembling the project's out-of-scope list. Returns `verdict` (PASS/WARN/FAIL), `findings`, `checkedFa`, `notCheckedFa`, `files`, `archived`, and stores it on the deliverable. The same checks run as the guard `deliverable.passesStageZero` on `submit`, where only FAIL findings block | `deliverable.read` |
| Revisions | `/revisions` | `revision.read` |
| Change requests | `/change-requests` (+ `/:id/scope-review`, `/:id/impact`) | `change.read` |
| Contracts | `/contracts` (+ `POST /:id/amendments`) | `contract.read` |
| Invoices | `/invoices` | `finance.read` |
| Payments | `/payments` | `finance.read` |
| Suppliers | `/suppliers` | `supplier.read` |
| Supplier 360 | `GET /suppliers/:id/360` — evaluations averaged per dimension with reuse rate; requests by state, on-time fulfilment (measured from the FULFILLED transition against `neededBy`), open load, average cost; a merged timeline. `GET /suppliers/suggest?departmentCode=&kind=&limit=` — candidates ranked by evidence (evaluation 50, on-time 25, reuse 15, availability 10 − 2 per open request); no history scores availability alone | `supplier.read` |
| Outsource requests | `/outsource-requests` | `supplier.read` |
| Allocations | `/allocations` | `resource.read` |
| Risks / Issues / Decisions | `/risks`, `/issues`, `/decisions` | `governance.read` |
| Meetings | `/meetings` | `meeting.read` |
| Status reports | `/status-reports` | `report.read` |
| Client status report | `GET /status-reports/:id/client-preview` — the client's copy (no financial status, no internal decisions, financial figures redacted) with `omitted[]` and the primary contact it would go to; `POST /status-reports/:id/send-to-client { to? }` — renders the PDF, sends it, audits `CLIENT_REPORT_SENT` | `report.read` to preview, `project.execute` to send |
| Feedback / Lessons | `/feedbacks`, `/lessons-learned` | `report.read` |
| Documents | `/documents` (+ `/:id/download`) | `document.read` |

### Gated commercial endpoints

| Endpoint | Permission | Doc_H rule |
|---|---|---|
| `POST /work-orders/:id/cost` | `pricing.declare_cost` | §12 — units declare cost only — the response carries `budget: { status, budget, declared, notified }`; NEAR (≥90%) and OVER notify the account owner and the declarer at once. It also carries `estimate` (roadmap #24); a figure below three-quarters of comparable orders, with at least three of them, notifies the unit's managers (`ESTIMATE_BELOW_HISTORY`). The declaration stands either way |
| `GET /work-orders/:id/estimate?proposedCost=` | `workorder.read` and `pricing.declare_cost` or `pricing.read` | What similar finished orders in the same unit were declared at, what their logged hours at each person's rate say they actually cost, and how many working days they took — comparables ranked by text similarity, same output format and same volume band, each with `whyFa[]`; `summary` ranges (p25/median/p75), `overrunRatio` (actual ÷ declared), a `verdict` on the proposed figure, and a `schedule` check against the deadline. A unit sees its own history only; `pricing.set_price` or `pricing.approve` sees every unit |
| `POST /proposals/:id/costs` | `pricing.declare_cost` | §12 |
| `POST /proposals/:id/pricing` | `pricing.set_price` | §12 — sets price; clears any prior approval |
| `POST /proposals/:id/pricing/approve` | `pricing.approve` | §12 — must be a different person |
| `POST /projects/:id/authorize` | `project.authorize` | §13 — records the authorisation basis |
| `POST /projects/:id/settle` | `finance.settle` | §15 — ticks the financial closure condition |
| `POST /change-requests/:id/scope-review` | `change.scope_review` | §8 |
| `POST /change-requests/:id/impact` | `change.commercial_review` | §8 — six mandatory dimensions |

## Briefs

| Endpoint | Purpose |
|---|---|
| `GET /briefs/:id/quality` | `brief.read` — how *specific* the brief is, not only whether it is filled (roadmap #25): an overall score and band, per-field scores with Persian findings that quote the vague phrase they object to, `fixFirst` (the field losing the most points), a benchmark from this organisation's history (briefs that became won deals, and the return rate per band — with `enoughHistory: false` when there are too few) and the closest won brief as an example. Refreshes the stored `qualityScore`/`qualityBand` |
| `GET /reports/brief-quality` | `report.read` — the benchmark alone: does a low score here actually predict a returned brief? |

## Forms

| Endpoint | Purpose |
|---|---|
| `GET /forms/definitions` | All 130 definitions, grouped, with a per-user `canSubmit` flag |
| `GET /forms/definitions/:code` | One definition with its field schema and SLA policy |
| `GET /forms/definitions/:code/design` | `form.read` — the designer's view (roadmap #15): the fields as they stand, `protectedKeys` (the required fields of the shipped definition, which cannot be removed or retyped), the binding, the submission count and whether this organisation has edited the form |
| `POST /forms/definitions/:code/design/validate` `{ fields[] }` | `admin.settings` — every problem with a proposed field list at once, in Persian; nothing is written |
| `PUT /forms/definitions/:code/design` `{ fields[], note? }` | `admin.settings` — replace the fields. Refused with `INVALID_FORM_DESIGN` and a `problems[]` list if it would break the process; mints a version and marks the definition as this organisation's, after which the seed stops overwriting it |
| `POST /forms/definitions` `{ code, nameFa, …, fields[] }` | `admin.settings` — a form outside the Doc_H catalogue (`isCustom`, numbered from 1000). Validated, versioned and submitted exactly like any other |
| `PATCH /forms/definitions/:code` | `admin.settings` — names, sender/receiver units, approver roles, SLA, next process, `isActive` |
| `GET /forms/definitions/:code/chain` | `form.read` — the approval stages of a form (roadmap #18): each stage's roles, quorum and condition, plus the chain a submission with no conditional values would walk and a Persian summary |
| `PUT /forms/definitions/:code/chain` `{ stages[], note? }` | `admin.settings` — replace the chain (≤ 6 stages, quorum ≤ 10, unique ids — `DUPLICATE_STAGE_ID`). Mints a new definition version like a routing change |
| `GET /forms/definitions/:code/routing` | `form.read` — the conditional approval rules on a definition (roadmap #17), each with its Persian sentence and a rendered description of its condition, plus the fields available to build one |
| `PUT /forms/definitions/:code/routing` `{ rules[], note? }` | `admin.settings` — replace the rules. Rule ids must be unique (`DUPLICATE_RULE_ID`) and conditions are validated; saving mints a new definition version, so filed submissions keep the rules they were judged under |
| `POST /forms/definitions/:code/routing/preview` `{ data }` | `form.read` — who these values would need: `roles`, `notifyRoles`, `matched[]` (id + the sentence) and `unmatched[]` (thresholds not yet crossed). The same pure evaluator the engine submits with, and the one the browser runs while the form is filled |
| `GET /forms/definitions/:code/versions` | Every version the definition has had, newest first, each with its schema, note and how many submissions pin it |
| `GET /forms/definitions/:code/template` / `template.csv` | The importable columns of a form from its schema (key, label, type, required, options, a Persian hint); the CSV has a key row and a label row |
| `POST /forms/definitions/:code/import` `{ csv \| rows, mode }` | `mode: preview` checks every row and writes nothing — references are resolved by code, email or name, and each row's issues are listed; `draft` (default for a migration) and `submit` write the valid rows through the form engine, skipping the invalid ones. `form.submit`; ≤ 2000 rows; audited as `BULK_IMPORT` |
| `GET /forms/definitions/:code/export.csv` | Every submission of the form, bookkeeping columns then the union of field keys across versions. `form.read`; audited |
| `GET /forms/submissions` | Submissions; `?awaitingMe=true` is the approval inbox — a single submission includes `definitionVersion` and `schema`, the fields as they stood when it was filled in |
| `POST /forms/submissions` | Submit or save a draft. An optional `clientKey` (roadmap #19) makes it idempotent: the first write wins, a replay returns that same submission with `duplicateOf` and HTTP 200 instead of filing a second one |
| `POST /forms/submissions/:id/decision` | Approve, reject or return (a reason is required to reject or return). Stage-aware (roadmap #18): an approval clears the current stage only when it has the distinct approvals its quorum asks for, then the form waits on the next stage (`stageCleared`, `nextStageFa`, `stages[]` come back with the response); a rejection or return ends the chain wherever it stands. The executive bypass does not apply to a declared stage, and nobody may fill a quorum twice (`ALREADY_APPROVED`) |

Submitting enforces the sender department Doc_H assigns to the form, validates against the
stored field schema, runs the typed binding when present, and starts the declared SLA clock.
A submitter cannot approve their own form.

## Reporting

| Endpoint | Permission | Contents |
|---|---|---|
| `GET /reports/my-dashboard` | authenticated | My tasks, projects, approvals, revisions, SLAs |
| `GET /me/work` | authenticated | One work queue: tasks, owned work orders, QC for my level, forms awaiting my roles, my revisions, clarification requests if I issue orders. Each item has `availableTransitions`, its nearest open `sla` with `controlledHours` (and `sla.risk` when that deadline is predicted to breach — probability, band and the first reason), and `href`; ordered breached → soonest SLA → due date |
| `GET /reports/executive` | `report.executive` | Pipeline, portfolio health, finance, delivery, governance |
| `GET /reports/sales` | `report.read` | Funnel, conversion, brief quality, per-owner performance |
| `GET /reports/units` | `report.read` | On-time delivery, first pass yield, revision rate, declared cost |
| `GET /reports/sla` | `report.read` | Compliance overall and per policy |
| `GET /reports/mining/:entity?from=&to=` | `report.executive` | Process mining from `state_transitions`: nodes (visits, mean dwell in working hours, open cases), edges (count, cases, mean wait, `declared`, `cascade`), `unusedDeclared` (transitions in WORKFLOWS the log never shows), `loops` (revisits), `variants` (paths with share and mean cycle time), `happyPath` (shortest declared route to a successful terminal), `cycleTime`, `bottlenecks` |
| `GET /reports/data-quality` | `report.read` | Records that would silently break the process |
| `GET /traffic` | `traffic.read` | Per-person capacity vs committed hours over a window, on each person's own calendar and leave; `leaveHours` per row, `onLeave` in the summary. Same arithmetic as the assignment suggestion |
| `GET /tasks/suggest-assignee` | `task.assign` | Who has room for the work. `taskId` reads the unit, estimate and due date off a task; or pass `unit`, `hours`, `by` directly (`limit` ≤ 50). Each candidate carries free capacity, `utilisationAfter`, `earliestFinish` on their own calendar, `missesDueDate`, delivery history, a score and its `reasonsFa`/`warningsFa`. Advisory — nothing here refuses an assignment |

## Currencies and exchange rates

Roadmap #28. Every base amount column (`total`, `paidAmount`, `amount`, `externalCost`,
`contractValue`, `valueDelta`) stays in the organisation's currency, so every report sums like with
like. A figure written in another currency (`currency` on `POST /invoices`, `POST /payments`,
`POST /contracts`, `externalCurrency` on cost declarations; an amendment takes its contract's) is
converted **once**, at the rate in force on the record's own date — issue date, payment date,
today for contracts, amendments and cost declarations — and keeps `currency`, the `original…`
figure, `fxRate` and `fxRateDate` beside the base one. No rate on or before that date is
`422 FX_RATE_MISSING`; only one older than `FX_MAX_RATE_AGE_DAYS` is `422 FX_RATE_STALE`; both name
the currency and the day. A zero needs no rate.

A receipt against an invoice in another currency must state its `currency` (`FX_CURRENCY_REQUIRED`
— read as the wrong one, a figure is off by the rate); it may be the invoice's currency or base
(`FX_CURRENCY_MISMATCH` otherwise). Settlement is counted in the invoice's currency
(`settledOriginal`, `originalPaidAmount`); `paidAmount` is the settled share at the invoice's own
rate, so an invoice paid in full is fully settled in base too, and the difference from the rate it
was actually paid at is an exchange gain or loss, not a dispute.

| Endpoint | Gate | Purpose |
|---|---|---|
| `GET /fx/rates` | `finance.read` | Base currency, and per currency the latest rate with its age and `stale` flag, plus up to 30 rates of history |
| `GET /fx/rate?currency=&on=` | authenticated | The rate a figure dated `on` would convert at: `rate`, `effectiveDate`, `ageDays`, `usable` |
| `POST /fx/rates` `{ currency, rate, effectiveDate, note? }` | `finance.rates` | Record a day's rate. Replacing one needs `note` (`REASON_REQUIRED`) and returns `replaced.recordsKeepingPrevious` — figures converted at the old rate keep it. Audited with before/after |
| `POST /fx/rates/import` `{ csv }` | `finance.rates` | «date,currency,rate» per line, Jalali or ISO. Never overwrites: a different rate for a recorded day comes back in `conflicts[]`; bad lines in `errors[]` with their line numbers. Audited as `BULK_IMPORT` |
| `GET /reports/fx?from=&to=` | `finance.read` | `totals.realised` (receipts at their day's rate against the invoice's booked rate) and `totals.unrealised` (open foreign receivables at the latest rate against booked), `byCurrency[]`, and the rows: `receivables`, `realised`, `contracts` and `costs`, each booked vs today |

## سامانهٔ مؤدیان (e-invoicing)

Roadmap #32. An invoice (`kind: INVOICE`, issued) is reported to the tax authority as a
submission: `ORIGINAL`, and after acceptance only `CORRECTION` or `CANCELLATION`, each with its own
22-character tax number (fiscal memory id + issue day and serial in hex + Verhoeff digit) and, for
the latter two, the accepted tax number it replaces (`irtaxid`). The payload is fixed when the
submission is prepared, in the authority's field names and whole rials. `MOADIAN_MODE` decides where
it goes: `off` (queued only), `sandbox` (an in-process stand-in — not the authority), `live` (the
direct API). An invoice the authority accepted cannot be cancelled here until its cancellation is
accepted there (guard `invoice.taxCancellationFiled`).

| Endpoint | Gate | Purpose |
|---|---|---|
| `GET /tax/profile` · `PUT /tax/profile` | `finance.read` · `finance.settle` | The taxpayer profile (memory id, seller number, default service and unit codes), the sending mode, and what is missing. `TAX_PROFILE_INVALID` with `problems[]` |
| `PUT /companies/:id/tax-identifiers` `{ nationalId?, economicCode?, postalCode? }` | `finance.invoice` | Complete a buyer's identifiers without full client-editing rights. Audited |
| `GET /invoices/:id/tax` | `finance.read` | What may be reported next (`subjects`, `referenceTaxId`), every problem that would get it refused (`problems[]`: profile, buyer id and postal code, kind, state, line arithmetic against the total, a future date), a preview of the payload, and the submissions so far |
| `POST /invoices/:id/tax` `{ subject }` | `finance.invoice` | Prepare (validate, number, fix the payload) and — when sending is on — send and inquire at once. `TAX_INVOICE_INVALID`, `TAX_SUBJECT_NOT_ALLOWED`, `TAX_IN_FLIGHT`, `TAX_ALREADY_CANCELLED`. Audited as `TAX_SUBMISSION_PREPARED` |
| `POST /tax/submissions/:id/inquire` | `finance.invoice` | Send if still queued, then ask the authority |
| `GET /reports/tax` | `finance.read` | Issued invoices not yet accepted — not reported, queued, awaiting an answer, refused (with the authority's reasons) — oldest first, with counts |

`GET /invoices` rows carry their latest submission (`taxSubmissions[0]`).

## Export to the accounting package

Roadmap #33. The general ledger stays in the organisation's accounting package; Hiva writes the
vouchers for it. Everything not yet posted up to a date becomes a balanced double-entry voucher in
whole rials, posted to the account codes of the organisation's own chart:

| Record | Voucher |
|---|---|
| Invoice (`kind: INVOICE`, issued, not cancelled before posting) | Dr receivable (client's detail code) / Cr revenue, Cr media clearing for pass-through lines (#31), Cr VAT |
| Invoice cancelled after it was posted | The same voucher reversed, dated the day it was cancelled |
| Receipt against an invoice | Dr bank (cash for `CASH`) / Cr receivable — for a foreign invoice at its booked rate (#28), the difference to FX gain or loss |
| Receipt against a proforma, or with no invoice | Dr bank or cash / Cr client advance |
| Payment out | Dr project cost — media clearing for a media-vendor payment (#31) / Cr bank or cash |

Drafts and proformas are never posted. A batch marks every record it carried (`accountingExportId`,
and `accountingReversalExportId` for a reversal), so nothing is posted twice; two batches at the
same moment cannot both take a record (`409 ACCOUNTING_EXPORT_RACE`). Voucher numbers continue from
batch to batch.

| Endpoint | Gate | Purpose |
|---|---|---|
| `GET /accounting/settings` · `PUT /accounting/settings` `{ accounts, clientCodes, layout }` | `finance.read` · `finance.settle` | The account code for each of `receivable, revenue, vat, mediaClearing, bank, cash, clientAdvance, projectCost, fxGain, fxLoss`; client detail codes (`companyId → code`); the file layout — `columns[]` of `{ field, header }` in order (`voucherNo, date, voucherDescription, row, accountCode, detailCode, lineDescription, debit, credit, amount, reference`; `amount` is signed) and `dateFormat` `JALALI` or `GREGORIAN`. `ACCOUNTING_SETTINGS_INVALID` with `problems[]`: a repeated column, no account code column, no amount (debit and credit, or signed), no voucher number, a client from another organisation. `GET` also returns the default layout and the clients money has moved with. Audited |
| `GET /accounting/preview?to=` | `finance.read` | What a batch up to `to` would carry: `counts`, `lines`, `debitTotal`, `creditTotal`, the first 50 vouchers (`more` for the rest), `problems[]` that block it (`ACCOUNT_CODE_MISSING` naming the accounts, an unusable layout) and `warnings[]` that do not (`CLIENT_CODE_MISSING` naming the clients). Marks nothing |
| `POST /accounting/exports` `{ to }` | `finance.settle` | Post the batch: numbered per organisation, its CSV kept, every record marked. `ACCOUNTING_EXPORT_BLOCKED` with `problems[]`, `ACCOUNTING_NOTHING_TO_EXPORT`. Audited |
| `GET /accounting/exports` | `finance.read` | Batches, newest first, with who posted them |
| `GET /accounting/exports/:id/file` | `finance.read` | The CSV exactly as the batch wrote it — UTF-8 with a BOM, Latin digits, the organisation's columns; text a spreadsheet would run as a formula is prefixed with `'`. Audited as `EXPORT` on every download |

An API key with `finance.read` (#46) can read the preview and download batch files, so an
integration can pull them on a schedule.

## Client approval as evidence

Roadmap #35. Staff ask a named contact of the client to approve a **delivered** deliverable or a
**presented** proposal. What the client will be shown is frozen when the request is made — the
subject, its client-facing content (a proposal's summary, approach, deliverables, timeline, price
and payment terms; never cost or margin) and each file with its SHA-256, read from storage — and
hashed (`manifestHash`). A link with a 256-bit secret goes to the contact's address; only the
secret's SHA-256 is stored. With mail off the link is returned to the requester once
(`channel: MANUAL`) and never again.

The decision is sealed: who (the addressee, the name typed as signature, and — when mail is on —
a six-digit code sent to the same address at decision time), when, the IP and browser, whether
that address is one the organisation's staff used in the last 30 days, and the log of everything
done on the page before deciding. `evidenceHash` is the SHA-256 of that record in canonical JSON,
including the previous decision's hash in the organisation (`sequence`, `prevEvidenceHash`). A
database trigger refuses any change to a sealed row, and the event log is append-only. The
decision is then applied through the workflow engine as the requester — `client_accept` /
`client_reject` on a deliverable, `client_approve` / `client_request_revision` on a proposal —
with the client's address; if the engine refuses, the evidence stands and `transitionError` says why.

| Endpoint | Gate | Purpose |
|---|---|---|
| `GET /client-approvals/options?subjectType=&subjectId=` | `deliverable.deliver` · `proposal.record_feedback` | Whether the subject may be sent now, the client's contacts, and the subject's files |
| `POST /client-approvals` `{ subjectType, subjectId, contactId, documentIds?, message?, expiresInDays }` | as above | Create and send. `CLIENT_APPROVAL_WRONG_STATE`, `CLIENT_APPROVAL_CONTACT` (not this client's), `CLIENT_APPROVAL_CONTACT_EMAIL`, `CLIENT_APPROVAL_NO_FILES` (a deliverable needs one), `CLIENT_APPROVAL_FILES`, `CLIENT_APPROVAL_FILE_ALTERED` (the file no longer matches its upload checksum), `409 CLIENT_APPROVAL_PENDING`. Returns `link` only when `channel` is `MANUAL`. Audited |
| `GET /client-approvals?subjectType=&subjectId=` · `GET /client-approvals/:id` | `deliverable.read` · `proposal.read` | Requests with their manifest, decision, evidence and event log — never the token or code hashes |
| `POST /client-approvals/:id/cancel` `{ reason }` | as for creating | Withdraw a pending request |
| `GET /client-approvals/:id/verify` | as for reading | Recompute every hash — each file from storage, the manifest, the evidence, the record's columns against it, the log, the chain link — and name what does not match (`FILE_ALTERED`, `FILE_MISSING`, `MANIFEST_ALTERED`, `EVIDENCE_ALTERED`, `RECORD_ALTERED`, `LOG_ALTERED`, `CHAIN_BROKEN`) |
| `GET /client-approvals/:id/certificate` | as for reading | «گواهی تأیید مشتری» as PDF, with a fresh verification. Audited as `EXPORT` |

The client's side, with no session (30 requests a minute per address; codes 5 a minute):

| Endpoint | Purpose |
|---|---|
| `GET /public/approvals/:token` | The request as the client sees it; a pending request past `expiresAt` becomes `EXPIRED`, and one whose subject has left the state it was sent in becomes `CANCELLED` |
| `GET /public/approvals/:token/files/:documentId` | A frozen file, re-hashed before it is served; one that no longer matches is refused (`409 CLIENT_APPROVAL_FILE_CHANGED`) and logged. Downloadable until `expiresAt` |
| `POST /public/approvals/:token/code` | Send a code to the contact's address (10 minutes, 5 attempts, 5 codes per request). `422 CLIENT_APPROVAL_NO_CODE` when mail is off |
| `POST /public/approvals/:token/decision` `{ decision: APPROVE \| REQUEST_CHANGES, signerName, comment?, code?, confirm: true }` | Seal and apply. Approval needs every file downloaded first (`CLIENT_APPROVAL_UNSEEN`); a change request needs a comment; with mail on, a valid code (`CLIENT_APPROVAL_CODE_REQUIRED`, `CLIENT_APPROVAL_CODE_INVALID`). `409 CLIENT_APPROVAL_CLOSED` once decided, cancelled or expired. The client is emailed a receipt with both hashes |

`POST /documents` accepts `proposalId`, so a presented deck can be frozen with the proposal.

## Client portal

Roadmap #34. A client contact signs in with their own account and sees their company's projects.
A portal account is not a staff user: it has no roles or permissions, and its token is signed with
a key derived for the portal alone under its own issuer — a portal token is refused everywhere in
the app, and a staff token everywhere in the portal. The token lasts 12 hours and dies with the
account's `tokenVersion` (disabling it, or a new invitation, ends every session at once). Every
portal read is scoped to the account's company; nothing takes a company or organisation from the
request.

**What the client sees:** projects from `AUTHORIZED` onward (never a draft or a cancelled one) —
name, objective, state, planned dates, milestones (not their revenue share), deliverables with the
states before delivery folded into «در حال تهیه», approval requests (#35), weekly reports in their
client version (#37), the files Account shared, their issued invoices, and a conversation with
Account per project. Never cost, price build-up, margin, budgets, unit codes or staff workload.

Account (`portal.manage`, held by the account roles; not grantable to an API key):

| Endpoint | Purpose |
|---|---|
| `GET /portal-users?companyId=` | The company's portal accounts — never a password or invitation hash |
| `POST /portal-users` `{ contactId }` | Invite a contact (the contact's email is the sign-in name). Returns `link` once when mail is off; mails it when on. `PORTAL_CONTACT_EMAIL`, `409 PORTAL_EMAIL_TAKEN`. Audited |
| `POST /portal-users/:id/reinvite` | A new invitation — also the password reset: the old password stops working |
| `POST /portal-users/:id/disable` | Close the account and end its sessions |
| `GET /projects/:id/client-files` | The project's and its deliverables' files, with `clientVisible` (`project.read` + `document.read`) |
| `PATCH /documents/:id/client-visibility` `{ clientVisible }` | Share a project file with the client, or stop. A file not attached to a project or deliverable is refused (`PORTAL_NOT_PROJECT_FILE`). Audited |
| `GET /projects/:id/portal-messages` · `POST` `{ body }` | The conversation (`project.read`); replying needs `portal.manage`, and mails the company's active portal accounts when mail is on |

The client (portal token; 120 requests a minute per address, sign-in at the login limit):

| Endpoint | Purpose |
|---|---|
| `POST /portal/auth/accept` `{ token, password }` | Set a password from an invitation (staff password rules) and sign in. `410 PORTAL_INVITE_INVALID` once used or expired (7 days) |
| `POST /portal/auth/login` `{ email, password }` | One answer for every failure; five failures lock the account for 15 minutes |
| `GET /portal/home` | The account, its projects with milestone progress, approvals waiting (`forMe` for the addressee), invoices |
| `GET /portal/projects/:id` | One project as above; another company's, or a draft, is `404` |
| `POST /portal/projects/:id/messages` `{ body }` | Write to Account; the account owner is notified (`PORTAL_MESSAGE`) |
| `GET /portal/documents/:id` | A shared file. Audited as `FILE_DOWNLOAD` with the portal account |
| `GET /portal/status-reports/:id` | The weekly report as PDF, built for the client (#37). Audited as `EXPORT` |
| `GET /portal/approvals/:id` · `…/files/:documentId` · `POST …/decision` | An approval request (#35) of the company. Only its addressee downloads its files and decides; the decision is sealed with `verification: PORTAL` and the portal account's id |

## Contract e-signature

Roadmap #36. A contract awaiting signature (`PENDING_SIGNATURE`) is sent as one of its own PDFs
— its SHA-256 frozen in `originalSha256` — to two signers in order: a client contact, then an
organisation signatory (an active user holding `contract.sign`). When the provider reports every
signer signed, its signed PDF is stored on the contract (tag `e-signed`, with its own SHA-256) and
the contract is signed through the workflow engine as the sender, with `signedDate` the completion
time. While an envelope is out, recording the signature by hand is refused by the guard
`contract.signatureNotInFlight`. `ESIGN_MODE` decides the provider: `sandbox` (an in-process
stand-in whose signatures carry no legal weight and say so), `http` (a provider behind the
contract in operations.md), `off`.

| Endpoint | Gate | Purpose |
|---|---|---|
| `GET /contracts/:id/signature-options` | `contract.read` | Mode, whether the contract may be sent now, the envelope in flight, its PDFs, the client's contacts with an email, the signatories |
| `POST /contracts/:id/signatures` `{ documentId, clientContactId, agencyUserId, expiresInDays }` | `contract.sign` | Send. `ESIGN_OFF`, `ESIGN_WRONG_STATE`, `409 ESIGN_IN_FLIGHT`, `ESIGN_DOCUMENT`, `ESIGN_NOT_PDF`, `ESIGN_DOCUMENT_ALTERED`, `ESIGN_CLIENT_SIGNER`, `ESIGN_AGENCY_SIGNER`, `502 ESIGN_PROVIDER_FAILED` (nothing is kept). Returns the signing `links` once when mail is off; mails them when on. Audited `ESIGN_SENT` |
| `GET /contracts/:id/signatures` | `contract.read` | Envelopes with signers (status, time, IP, the certificate the provider reported), the event log, the original and signed files |
| `POST /esign/envelopes/:id/sync` | `contract.sign` | Read the envelope back from the provider now |
| `POST /esign/envelopes/:id/void` `{ reason }` | `contract.sign` | Withdraw an envelope still out. Audited `ESIGN_VOIDED` |
| `POST /esign/callback` | HMAC | The provider's "look again": `X-Hiva-Signature: sha256=<HMAC(body, ESIGN_WEBHOOK_SECRET)>` over the exact bytes; the status is then read back from the provider, never taken from the callback |

The sandbox's signing page (`ESIGN_MODE=sandbox` only; 30 requests a minute per address):
`GET /esign/sandbox/:token`, `GET …/document` (re-hashed before it is served), `POST …/sign`
`{ signerName, confirm: true }` and `POST …/decline` `{ reason }`. Signers sign in order
(`ESIGN_ORDER`); the completed PDF ends with a page stating that no legal signature was made.

## API keys and webhooks

Roadmap #46 — identities for systems, and events sent to them. Both are managed only from a
person's session (`admin.keys`); a key is refused on `/auth/*`, `/delegations` and these
management paths.

**Keys.** Send `Authorization: Bearer hiva_<prefix>_<secret>` in place of an access token. A key
acts as its creator, narrowed to the permissions it was given and recomputed on every request from
the creator's own roles — never a delegation, never `admin.users`, `admin.roles`, `admin.keys`,
`governance.waive` or `portal.manage` (#34 — it creates identities), and nothing once the creator is inactive. Each key has its own per-minute
budget (`429 API_KEY_RATE_LIMITED`); revoked or expired keys get `401`. Every audit row written
through a key carries its `apiKeyId`.

| Endpoint | Purpose |
|---|---|
| `GET /admin/api-keys` | Keys with status (`ACTIVE`, `REVOKED`, `EXPIRED`, `OWNER_INACTIVE`), last use and address — never the secret |
| `GET /admin/api-keys/grantable` | What the caller may put on a key |
| `POST /admin/api-keys` `{ name, permissions[], rateLimitPerMinute, expiresAt? }` | Returns the key **once**; only its SHA-256 is kept. `KEY_PERMISSION_NOT_GRANTABLE` lists what the caller cannot give |
| `POST /admin/api-keys/:id/revoke` `{ reason }` | Stops the key at once. Audited |

**Webhooks.** A subscription names `events` — `entity.action` (`invoice.issue`), `entity.*` or
`*` — from `GET /admin/webhooks/events`, and only for entities its creator may read, re-checked on
every event. Deliveries are thin and signed:

```http
POST <url>
X-Hiva-Event: lead.contact
X-Hiva-Delivery: <delivery id>
X-Hiva-Timestamp: 1790000000
X-Hiva-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>" with the webhook secret>

{"id":"…","event":"lead.contact","eventId":"<transition id>","occurredAt":"…",
 "data":{"entity":"lead","entityId":"…","code":"LEAD-000031","action":"contact","actionFa":"برقراری ارتباط",
         "from":"NEW","to":"CONTACTED","reason":null,"cascade":false}}
```

A receiver verifies the signature over the raw body, refuses stale timestamps, and treats
`eventId` as the idempotency key; for the record itself it calls the API with a key. Non-2xx
responses are retried after 1, 5, 30, 120 and 720 minutes, then the delivery is `DEAD`; twenty
consecutive failures disable the subscription and notify its creator. URLs must be `https` and
must not resolve to an internal address — checked on save and again at connection time.

| Endpoint | Purpose |
|---|---|
| `GET /admin/webhooks/events` | Subscribable events, with the read permission each needs and whether the caller holds it |
| `GET /admin/webhooks` · `POST /admin/webhooks` `{ name, url, events[] }` | List (secret masked, delivery counts) · create (secret returned **once**). `WEBHOOK_URL_REFUSED`, `WEBHOOK_EVENTS_INVALID` |
| `PATCH /admin/webhooks/:id` `{ active?, events?, url? }` | Re-enabling resets the failure count and starts from now, not from a backlog |
| `POST /admin/webhooks/:id/test` | A `ping`, sent now; returns the receiver's status |
| `GET /admin/webhooks/:id/deliveries` · `POST /admin/webhooks/deliveries/:id/redeliver` | The last 50 deliveries; send one again now |

## Media buying

Roadmap #31. A media order (`MO-…`, state machine `mediaOrder`: `DRAFT → BOOKED → AIRED →
RECONCILED`, or `CANCELLED`) is media bought for a client. `amount` is the vendor's quote: gross
under `COMMISSION` (the client is billed it; the vendor deducts the agency commission), net under
`MARKUP` (the client is billed it plus the markup). The server keeps `clientAmount`, `netAmount`
(the vendor's — a pass-through, never the agency's revenue) and `agencyRevenue`, in base, with the
originals and rate for another currency (#28). Booking needs the media unit, Account or management
(guard `mediaOrder.bookedByMediaOrAccount`); delivery needs its proof as the reason; reconciling
needs the vendor's invoice to match the booked net within half a per cent, or a written
`discrepancyNote` (guard `mediaOrder.vendorInvoiceMatches`).

| Endpoint | Gate | Purpose |
|---|---|---|
| `GET /media-orders?projectId=&state=&supplierId=` / `GET /media-orders/:id` | `pricing.read` | Orders with their split and `availableTransitions` |
| `POST /media-orders` | `media.buy` (media unit, Account, management, or a pricer) | A draft order; the split is computed, never accepted |
| `PATCH /media-orders/:id` | `media.buy` | A draft only (`MEDIA_ORDER_NOT_DRAFT` after booking); re-priced at today's rate |
| `POST /media-orders/:id/vendor-invoice` `{ number, amount, invoiceDate, discrepancyNote? }` | `finance.payment` | The vendor's invoice in the order's currency; returns `expected`, `difference`, `matches` |
| `POST /projects/:id/media-billing` `{ orderIds[], number, issueDate, dueDate?, taxPercent }` | `finance.invoice` | The intermediary invoice: per order, the vendor's net on a line marked `passThrough: true` and the agency's commission on its own line. Booked or later, unbilled, one currency (`MEDIA_BILLING_INVALID` with `problems[]`) |
| `GET /reports/media?from=&to=` | `pricing.read` | Billings, pass-through, agency revenue and the effective rate — overall, by channel, vendor and project — and the exceptions: ran and unbilled, flight over without proof, awaiting the vendor's invoice, vendor invoice differs |

`POST /payments` takes `mediaOrderId` for a payment to a media vendor: it is a pass-through, so
revenue recognition (#29) leaves it out of project cost — as it leaves `passThrough` invoice lines
out of what was billed, and recognises the agency's revenue on an order when it runs.

## Revenue recognition and work in progress

Roadmap #29. A project earns its contract value as the work is done, measured by its
`revenueMethod`: `MILESTONE` (the revenue shares of completed milestones), `EFFORT` (hours logged ÷
hours logged + estimate still to go on open tasks) or `COST` (labour at hourly cost plus payments
out ÷ the larger of declared cost and cost incurred). Recognised − invoiced (`kind: INVOICE`) is
work in progress: positive, earned and not billed; negative, billed ahead (deferred). A closed
project has earned all of it.

| Endpoint | Gate | Purpose |
|---|---|---|
| `GET /projects/:id/revenue` | `finance.read` | The method, today's `position` (`progress`, `recognised`, `invoiced`, `wip`, `basis`, `reasonFa` when it cannot be measured, `notesFa`), `expectedLoss` when declared cost exceeds the contract, the milestones with their shares, and the last twelve months |
| `PATCH /projects/:id/revenue` `{ method?, shares?[], note? }` | `finance.budget` | Choose the method; set milestone shares (a total over 100 % is `REVENUE_SHARES_OVER_100`). Audited. Closed months do not change; the effect lands in the next open month |
| `PATCH /projects/:id/milestones/:mid` `{ completedAt?, name?, dueDate? }` | `project.plan` | Mark a milestone done (not in the future — `COMPLETED_IN_FUTURE`) or undone. Audited |
| `GET /reports/revenue?months=` | `finance.read` | Per Jalali month: `recognised`, `invoiced`, `labourCost`, `externalCost`, `margin` (earned − cost) and `billingMargin` (billed − cost), closed months as they were closed; `wip.unbilled` / `wip.deferred`; each project's position; `nextToClose` |
| `GET /revenue/periods` | `finance.read` | Closed months, newest first |
| `POST /revenue/periods/close` `{ period: "1405-06" }` | `finance.settle` | Freeze a finished month: one `revenue_entries` row per measured project with its progress, contract value, recognised to date and the month's amount. In order only (`PERIOD_OUT_OF_ORDER` with `expected`), never twice (`PERIOD_ALREADY_CLOSED`), never the current month (`PERIOD_NOT_ENDED`), never reopened. Audited as `REVENUE_PERIOD_CLOSED` |

`POST /projects/:id/milestones` now checks the project belongs to the caller's organisation.

## Asking the reports

Natural-language reporting (roadmap #27). A question is mapped to a metric from a fixed catalogue
(`apps/api/src/ask/catalog.ts`) — never to SQL — and answered under the asker's permissions.

| Endpoint | Gate | Purpose |
|---|---|---|
| `GET /reports/ask/catalog` | `report.read` | Every metric with its Persian definition, unit, dimensions and filters; `allowed` and, when not, `lockedFa` naming the missing permission; the period presets; whether a model fallback is configured |
| `POST /reports/ask` `{ question }` or `{ plan }` | `report.read`, 30/min | `status` is `ANSWERED`, `NEEDS_CLARIFICATION` (`clarify.options` — two people, clients or projects fit, or two metrics; the partial `plan` comes back so a choice re-runs it), `NOT_UNDERSTOOD` (`suggestions[]`; no number is invented) or `REFUSED` (`refusal.permissions`; nothing was computed, and the refusal is audited as `PERMISSION_DENIED` on `report.ask`). An answer carries `plan`, `understoodFa[]`, `metric.definitionFa`, `value`/`valueFa`/`countFa`, `rows[]` when split, `previous` when compared, `basis` (the records it is made of, with links), `caveatsFa[]` and `ignoredFa[]` — the words of the question that were not applied. A `plan` is how the page corrects an understanding; its ids are checked against what the asker can see |

Metrics a dashboard also shows use that dashboard's definition, and `tests/008-ask.test.ts` holds
them together: on-time rate, first-pass yield, revisions, overdue tasks and declared cost per unit
(units report), on-time rate, CSAT, invoiced and outstanding (control tower), win rate and
pipeline (sales), SLA compliance (SLA report). The units report's on-time rate now divides by the
finished tasks that *had* a due date, as the control tower always did — an undated task was
being counted as late there.

## Security alerts

| Endpoint | Gate | Purpose |
|---|---|---|
| `GET /security/alerts?status=OPEN\|ACKNOWLEDGED\|DISMISSED\|ALL` | `admin.audit` | Anomalies raised from the audit trail (roadmap #26), newest first, each with `kindFa`, severity, the person or address, the window, `evidence` (counts, the person's own usual day, event ids) and any review; plus counts by status and severity |
| `POST /security/alerts/:id/review` `{ status, note? }` | `admin.audit` | `ACKNOWLEDGED`, `DISMISSED` (a note of at least five characters is required — `REASON_REQUIRED`) or back to `OPEN`. An alert about the reviewer is refused (`SELF_REVIEW`). Audited as `SECURITY_ALERT_REVIEWED` |
| `POST /security/scan` | `admin.audit` | Run the detectors now instead of at the next quarter-hour; returns `{ detected, created, updated, notified }` |

## Meeting minutes

| Endpoint | Gate | Purpose |
|---|---|---|
| `GET /meetings/capabilities` | authenticated | `{ transcription }` — whether a speech-to-text service is configured |
| `POST /meetings/:id/draft-minutes` `{ notes }` | `meeting.write` | A draft of the minutes from notes or a transcript (roadmap #23): `decisions[]`, `actions[]` (each with `title`, a resolved `assigneeId` or the `ownerRaw` it could not resolve with its `candidates[]`, `departmentCode`, `dueDate` with the `dueRaw` phrase it came from, `confidence` and `sourceLine`) and `unresolvedFa[]` — commitments with no owner and no date. Relative dates («تا شنبه», «ظرف ۳ روز») are counted from `heldAt`. Nothing is written |
| `POST /meetings/:id/transcribe` (multipart `file`) | `meeting.write` | Audio → text through the configured service (`TRANSCRIPTION_URL`). 501 `TRANSCRIPTION_NOT_CONFIGURED` without one; 502 when it fails. The audio is not stored. Audited as `MEETING_TRANSCRIBED` |
| `POST /meetings/:id/minutes` `{ decisions, source?, actions[] }` | `meeting.write` | Record the confirmed minutes. Every action with `createTask` becomes a task on the meeting's project in one transaction — `sourceType: MEETING_MINUTES`, `sourceRef` the meeting code, `ASSIGNED` with its acceptance clock when it has an owner, `CREATED` otherwise; each owner other than the recorder is told in the app (`MEETING_ACTION_ASSIGNED`). Refused whole with `MEETING_HAS_NO_PROJECT` or `INVALID_ACTIONS` (`problems[]`: an inactive owner, a task with no unit) |

## Organisational memory

| Endpoint | Gate | Purpose |
|---|---|---|
| `GET /memory/search?q=&kinds=&projectId=&limit=` | authenticated | Hybrid retrieval over briefs, proposals, meeting minutes, lessons learned, client feedback and status reports (roadmap #21). Each hit carries `score` and both halves of it (`semantic`, `lexical`), a snippet, and the embedder that produced its vector. Kinds the caller may not read are never searched |
| `GET /memory/similar/:entityType/:id` | authenticated | The same retrieval seeded by a record's own text — "what have we done before that looks like this". Excludes the record's own project |
| `GET /projects/:id/lessons?limit=&includeReviewed=` | `project.read` | Lessons from past projects that bear on this one (roadmap #44): retrieval over the project's own text, raised for the same client, the same execution units and the same account owner, each hit carrying `whyFa[]`. Reviewed lessons drop out of the list and are counted instead |
| `POST /projects/:id/lessons/:lessonId/review` `{ decision, note? }` | `project.plan` | `APPLIED` or `NOT_RELEVANT`; a reason is required to set one aside (`REASON_REQUIRED`). Recorded on the project's history as `LESSON_REVIEWED` |
| `GET /memory/status` | `report.read` | What the index holds per kind, which models produced it, when it last ran, and whether an embedding service is configured |
| `POST /memory/reindex` `{ force?, kinds? }` | `admin.settings` | Rebuild; only changed sources are re-embedded unless `force` |

Embeddings come from `EMBEDDING_URL` (any OpenAI-shaped `/embeddings` endpoint, including a
local Ollama or vLLM) when configured, and from a deterministic local hash embedder otherwise —
every response says which. Vectors are stored as float arrays in PostgreSQL, so no extension is
required; the lexical half is `pg_trgm`, which ships with PostgreSQL.

## AI

| Endpoint | Purpose |
|---|---|
| `GET /ai/status` | Whether a model is configured; the capabilities this user may use |
| `POST /ai/ask` | Run a capability. Returns deterministic `findings`, `grounding`, and `narrative` when a model is configured |
| `GET /ai/interactions` | Governance log (`admin.audit`) |

Capabilities: `BRIEF_ANALYSIS`, `PROJECT_SUMMARY`, `RISK_DETECTION`, `STATUS_REPORT_DRAFT`,
`CHANGE_IMPACT_ANALYSIS`, `QC_COMPARISON`, `CUSTOMER_HEALTH`, `NEXT_BEST_ACTION`, `FREE_QUERY`.
Each requires both `ai.use` and the underlying data permission.

## Administration

| Endpoint | Permission |
|---|---|
| `GET /users`, `POST /users`, `PATCH /users/:id`, `POST /users/:id/deactivate` | `admin.users` for writes |
| `GET /departments`, `/roles`, `/permissions` | authenticated |
| `PATCH /departments/:code/calendar` `{ workingDays?, workStartHour?, workEndHour?, breakHours? }` | `admin.settings` — a unit's calendar overrides; `null` inherits the organisation |
| `PATCH /users/:id/calendar` `{ workingDays?, workStartHour?, workEndHour? }` | `admin.users` — a person's overrides; inherits the unit, then the organisation |
| `GET /users/:id/leaves`, `POST /users/:id/leaves` `{ from, to, kind, note }`, `DELETE /users/:id/leaves/:leaveId` | `admin.users` (a person may read their own) — days with no working hours |
| `GET /calendar/effective?userId=&departmentCode=` | authenticated — the calendar actually in force for a scope, after inheritance, leaves included as holidays |
| `POST /delegations` `{ toUserId, permissions[], roles[], startsAt?, endsAt, reason, fromUserId? }` | authenticated — lend your own authority (a subset of what you hold; ≤ 90 days; reason mandatory); `fromUserId` other than yourself needs `admin.users`. Takes effect on the delegate's next token |
| `GET /delegations?scope=all&active=true` | mine, given and received, with names and status (ACTIVE / SCHEDULED / EXPIRED / REVOKED); `scope=all` needs `admin.users` |
| `POST /delegations/:id/revoke` | the delegator, the delegate or `admin.users`; ends the delegate's sessions so it cannot linger past the access-token lifetime |
| `POST /waivers` `{ entityType, entityId, guard, action?, reason, expiresAt? }` | `governance.waive` (CEO, deputy) — set one guard aside on one record, once; the guard must stand on a transition of that entity; reason ≥ 10 chars; expiry ≤ 30 days (default 7); one live waiver per guard per record. Audited `WAIVER_GRANTED` |
| `GET /waivers?entityType=&entityId=&status=` | `governance.read` — the register, with names and status (OPEN / USED / EXPIRED / REVOKED) |
| `POST /waivers/:id/revoke` | `governance.waive` — an unused waiver only; a spent one is history |
| `GET /rules/versions`, `GET /rules/versions/:id` | `admin.audit` — every version of the workflows, permissions and SLA rule sets, with fingerprint, effective-from and note; a version with its full snapshot and how many transitions ran under it |
| `GET /rules/at?ts=` | `admin.audit` — which version of each kind was in force at an instant |
| `GET /rules/diff?kind=&from=&to=` | `admin.audit` — what changed between two versions, as Persian lines (transitions added/removed, a guard or permission changed, a role gaining or losing a permission, an SLA duration moved); defaults to the last two |
| `GET /rules/for-transition/:id` | `admin.audit` — the rule versions a given transition was allowed under |
| `POST /rules/lab` `{ edits[], since?, limit? }` | `admin.audit` — replay history under proposed edits (`transition`: guards / permission / requiresReason; `role`: add / remove permissions). Returns `wouldBlock` (past transitions the candidate would refuse: ILLEGAL, PERMISSION, GUARD_ADDED) and `wouldAllow` (past `TRANSITION_BLOCKED` attempts a removed guard would let through), per-entity counts, and the assumptions it makes. Writes nothing |
| `GET /rules/lab/vocabulary` | `admin.audit` — every guard id with its label, for the editor |
| `GET /sla-policies`, `PATCH /sla-policies/:code` | `admin.settings` for writes |
| `GET /organization`, `PATCH /organization` | `admin.settings` for writes |
| `GET /audit-events` | `admin.audit` |
| `GET /history/:entityType/:entityId` | The record's timeline from the audit trail: each event with actor, action, reason and field-level `changes[]` (`{ field, before, after }`, or `withheld` for a figure the caller may not see); events *about* the record (exports, SLA pauses) carry `details` instead. Gate: the record's read permission, or `admin.audit` |
| `GET /history/:entityType/:entityId/at?ts=` | The record as it stood at `ts`, reconstructed by folding the trail; `known: false` before its first event |
| `GET /history/:entityType/:entityId/diff?from=&to=` | Field-level differences between two instants, with the count of events and the actors in between |
| `GET /sla-clocks` | authenticated — each clock carries `elapsedHours`, `pausedHours`, `controlledHours`, `budgetHours` and its `pauses`; `entityType`+`entityId` scope it to one record, `state=ALL` includes closed clocks |
| `GET /sla-clocks/predictions?mine=&minProbability=&limit=` | authenticated — open clocks ranked by the probability they will breach (roadmap #8). Each row carries `probability`, `risk`, `ratio` against the fixed `warnAt`, `beatsWarnAt` (predicted to fail while the threshold is still silent), `expectedFinish`/`expectedOverrunHours`, the `basis` (source `POLICY_AND_UNIT` / `POLICY` / `NONE`, samples, survivors, breach rate, median, p85), `loadFactor` and `becauseFa[]` |
| `POST /workflow/task/:id/transitions` `{ action: "assign", payload: { assigneeId } }` | `task.assign` — dispatch names a person: `ASSIGNEE_REQUIRED` (400) without one, `ASSIGNEE_INVALID` (400) for someone inactive or outside the organisation. The acceptance clock is opened in that person's name |
| `POST /sla-clocks/:id/pause` `{ kind, reason }`, `POST /sla-clocks/:id/resume` | the clock's owner, or `traffic.manage`. `kind` is one of `WAITING_ON_CLIENT`, `WAITING_ON_SUPPLIER`, `INTERNAL_DEPENDENCY`; `reason` is mandatory |
| `GET /notifications`, `POST /notifications/read-all` | authenticated |
| `GET /search?q=` | authenticated — results are filtered to what you may read |

## Health

`GET /health` · `GET /health/ready` (checks the database) · `GET /health/live`
