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
| `GET /workflow/definitions` | All 13 state machines |
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
| Work orders | `/work-orders` (+ `POST /:id/cost`) | `workorder.read` |
| Tasks | `/tasks` | `task.read` |
| Deliverables | `/deliverables` | `deliverable.read` |
| QC reviews | `/qc-reviews` (+ `/qc/queue`) | `qc.read` |
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
| `POST /work-orders/:id/cost` | `pricing.declare_cost` | §12 — units declare cost only |
| `POST /proposals/:id/costs` | `pricing.declare_cost` | §12 |
| `POST /proposals/:id/pricing` | `pricing.set_price` | §12 — sets price; clears any prior approval |
| `POST /proposals/:id/pricing/approve` | `pricing.approve` | §12 — must be a different person |
| `POST /projects/:id/authorize` | `project.authorize` | §13 — records the authorisation basis |
| `POST /projects/:id/settle` | `finance.settle` | §15 — ticks the financial closure condition |
| `POST /change-requests/:id/scope-review` | `change.scope_review` | §8 |
| `POST /change-requests/:id/impact` | `change.commercial_review` | §8 — six mandatory dimensions |

## Forms

| Endpoint | Purpose |
|---|---|
| `GET /forms/definitions` | All 130 definitions, grouped, with a per-user `canSubmit` flag |
| `GET /forms/definitions/:code` | One definition with its field schema and SLA policy |
| `GET /forms/definitions/:code/versions` | Every version the definition has had, newest first, each with its schema, note and how many submissions pin it |
| `GET /forms/submissions` | Submissions; `?awaitingMe=true` is the approval inbox — a single submission includes `definitionVersion` and `schema`, the fields as they stood when it was filled in |
| `POST /forms/submissions` | Submit or save a draft |
| `POST /forms/submissions/:id/decision` | Approve, reject or return (a reason is required to reject or return) |

Submitting enforces the sender department Doc_H assigns to the form, validates against the
stored field schema, runs the typed binding when present, and starts the declared SLA clock.
A submitter cannot approve their own form.

## Reporting

| Endpoint | Permission | Contents |
|---|---|---|
| `GET /reports/my-dashboard` | authenticated | My tasks, projects, approvals, revisions, SLAs |
| `GET /me/work` | authenticated | One work queue: tasks, owned work orders, QC for my level, forms awaiting my roles, my revisions, clarification requests if I issue orders. Each item has `availableTransitions`, its nearest open `sla` with `controlledHours`, and `href`; ordered breached → soonest SLA → due date |
| `GET /reports/executive` | `report.executive` | Pipeline, portfolio health, finance, delivery, governance |
| `GET /reports/sales` | `report.read` | Funnel, conversion, brief quality, per-owner performance |
| `GET /reports/units` | `report.read` | On-time delivery, first pass yield, revision rate, declared cost |
| `GET /reports/sla` | `report.read` | Compliance overall and per policy |
| `GET /reports/data-quality` | `report.read` | Records that would silently break the process |
| `GET /traffic` | `traffic.read` | Capacity vs committed hours, over-allocation |

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
| `GET /sla-policies`, `PATCH /sla-policies/:code` | `admin.settings` for writes |
| `GET /organization`, `PATCH /organization` | `admin.settings` for writes |
| `GET /audit-events` | `admin.audit` |
| `GET /history/:entityType/:entityId` | The record's timeline from the audit trail: each event with actor, action, reason and field-level `changes[]` (`{ field, before, after }`, or `withheld` for a figure the caller may not see); events *about* the record (exports, SLA pauses) carry `details` instead. Gate: the record's read permission, or `admin.audit` |
| `GET /history/:entityType/:entityId/at?ts=` | The record as it stood at `ts`, reconstructed by folding the trail; `known: false` before its first event |
| `GET /history/:entityType/:entityId/diff?from=&to=` | Field-level differences between two instants, with the count of events and the actors in between |
| `GET /sla-clocks` | authenticated — each clock carries `elapsedHours`, `pausedHours`, `controlledHours`, `budgetHours` and its `pauses`; `entityType`+`entityId` scope it to one record, `state=ALL` includes closed clocks |
| `POST /sla-clocks/:id/pause` `{ kind, reason }`, `POST /sla-clocks/:id/resume` | the clock's owner, or `traffic.manage`. `kind` is one of `WAITING_ON_CLIENT`, `WAITING_ON_SUPPLIER`, `INTERNAL_DEPENDENCY`; `reason` is mandatory |
| `GET /notifications`, `POST /notifications/read-all` | authenticated |
| `GET /search?q=` | authenticated — results are filtered to what you may read |

## Health

`GET /health` · `GET /health/ready` (checks the database) · `GET /health/live`
