# API reference

Base URL: `/api/v1`. All responses are JSON. All dates are ISO-8601 UTC.

## Authentication

```http
POST /api/v1/auth/login
{ "email": "account.manager@hiva.local", "password": "…" }

200 { "accessToken": "...", "user": { … } }
Set-Cookie: hiva_refresh=…; Max-Age=604800; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Strict
```

Send the access token as `Authorization: Bearer <token>`. It expires in 15 minutes, and stops at
once when its sign-in ends or its holder's roles, password or status change (`401 SESSION_REVOKED`).

The refresh token is never in a response body (audit SEC-4). Every way in sets it as the
`hiva_refresh` cookie: `HttpOnly`, `SameSite=Strict`, sent only to `/api/v1/auth`, and `Secure` in
production. `POST /auth/refresh` reads it from the cookie and nothing else, rotates it, sets the new
one and answers `{ accessToken }`. Refresh tokens are single-use.

A request that spends the cookie (`/auth/refresh`, `/auth/refresh/legacy`, `/auth/logout`) must carry
`X-Hiva-Refresh: 1`. When it sends an `Origin`, that must be the app's: an origin in `CORS_ORIGIN` or
`PUBLIC_APP_URL`, or the host the request came to. Otherwise `403 CROSS_SITE`.

| Endpoint | Purpose |
|---|---|
| `POST /auth/login` | Sign in. Rate-limited. Wrong passwords slow down the network they come from, for that address — three free, then a doubling wait, then fifteen minutes blocked at ten (`429 TOO_MANY_TRIES` with `retryAfterSeconds`). The account is never locked (audit SEC-10) |
| `POST /auth/refresh` | Rotate the cookie's refresh token; answers `{ accessToken }` |
| `POST /auth/refresh/legacy` `{ refreshToken }` | Once per browser: trades a refresh token an older build kept in `localStorage` for the cookie. Old tokens expire with `REFRESH_TOKEN_TTL`, after which this route has nothing left to trade |
| `POST /auth/logout` | Revoke this device's session (from its cookie) and clear the cookie; every session when there is no cookie |
| `GET /auth/me` | Current user with roles and resolved permissions |
| `POST /auth/change-password` | Change password; revokes every session |
| `GET /auth/methods` | Public — which ways in this installation offers (`password`, `phone`, `google`) and whether asking to join is open |
| `POST /auth/phone/start` `{ phone }` | Public — texts a six-digit code if the number is an active person's verified mobile; answers `202` the same either way. One code a minute and five an hour per number |
| `POST /auth/phone/verify` `{ phone, code }` | Public — signs in; five wrong tries spend the code, and wrong codes slow their network down for that number as wrong passwords do |
| `GET /auth/google/start?mode=login\|signup` | Public — `{ url }` to send the browser to (state, nonce and PKCE kept server-side, ten minutes, one use). Sets `hiva_oauth`, a ten-minute `HttpOnly` `SameSite=Lax` cookie: the callback is honoured only in this browser (audit SEC-5), otherwise `#error=GOOGLE_BROWSER` |
| `GET /auth/google/callback` | Google's redirect. Answers with a redirect to `/auth/google#ticket=…` (or `#error=CODE`), `/signup#done=sent`, or `/me#linked=google` — never with a token in a URL |
| `POST /auth/ticket` `{ ticket }` | Public — trades the minute-long, single-use ticket for a session |
| `POST /auth/google/offer` `{ token }` | Public — a Google account whose verified address is a person's work address comes back as `/auth/google#link=…`, not linked (audit SEC-5). This shows whose account it is and which proofs it takes (`password`, a masked `phone`) |
| `POST /auth/google/offer/code` `{ token }` | Public — texts a sign-in code to the account's verified mobile |
| `POST /auth/google/offer/confirm` `{ token, password }` or `{ token, code }` | Public — the proof. Links the Google account (audited, with the proof used) and signs in. A wrong proof counts as a wrong password; five spend the offer (`410 OFFER_GONE`) |
| `GET /auth/signup/options`, `POST /auth/signup/phone/start`, `POST /auth/signup` `{ fullName, email, phone, code, departmentCode?, note? }` | Public — asking to join; records a request, grants nothing |
| `GET /signup-requests`, `POST /signup-requests/:id/approve` `{ departmentCode, roles, jobTitle? }`, `POST /signup-requests/:id/reject` `{ note }` | `admin.users` — the administrator creates the account with the unit and roles they choose; never `SUPER_ADMIN` |
| `GET` / `PATCH /settings/signup` `{ enabled }` | `admin.settings` — open or close asking to join |
| `GET /people?q=`, `GET /people/:id` | Authenticated — the directory and a person's page; mobile, last sign-in are only for the person and `admin.users`; tasks and projects only with `task.read` / `project.read` |
| `GET /me/profile` | One's ways in and live sessions (`current` marks this device) |
| `POST /me/phone/start`, `POST /me/phone/verify`, `DELETE /me/phone` | Prove a mobile with a code; remove it as a way in (refused if it is the last) |
| `POST /me/google/link`, `DELETE /me/identities/:id` | Link or unlink a Google account (unlinking the last way in is refused) |
| `POST /me/password` `{ newPassword }` | A first password, for someone who joined without one |
| `DELETE /me/sessions/:id`, `POST /me/sessions/revoke-others` | Sign a device out, or every other device |

A session ends with a reason (`ROTATED`, `SIGNED_OUT`, `PASSWORD_CHANGED`, `ROLES_CHANGED`,
`DELEGATION_REVOKED`, `DEACTIVATED`, `REUSE`). Presenting a refresh token whose session was **rotated**
is treated as theft — every session of the user ends and `REFRESH_TOKEN_REUSE` is audited; a token
whose session ended any other way is simply refused.

### Documents: retention, legal hold, quota (audit LOG-5)

| Endpoint | Purpose |
|---|---|
| `POST /documents/:id/legal-hold` `{ hold, reason }` | `contract.legal_review` — keep the file whatever happens to the document (a reason is required to place a hold); audited as `LEGAL_HOLD` / `LEGAL_HOLD_RELEASED` |

An upload past the organisation's storage quota answers `413 STORAGE_QUOTA` with `{ usedMb, quotaMb }`.

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

**Language** — messages are written in Persian. A request whose `Accept-Language` puts English first
(`en`, `en-GB,en;q=0.9`, …) gets the error's `message`, and the words inside its `details`
(`message`, `labelFa`, `messageFa`, `rule`, …), in English; data inside `details` is left as it is.
Persian, or no header, gets Persian. Response bodies other than errors are not translated: labels
arrive as `labelFa` / `labelEn` pairs where the source has both, and the web reads the rest against
the catalogue in `@hiva/contracts/i18n/en.json` (ADR-056).

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
| `GET /workflow/definitions` | All 16 state machines |
| `GET /workflow/:entity/definition` | One state machine |
| `GET /workflow/:entity/:id/available` | Transitions this caller may perform now |
| `GET /workflow/:entity/:id/preflight` | Every transition out of the current state with every guard's verdict — `checks[]` of `{ guard, labelFa, ok, messageFa?, rule? }`, plus `permitted` and `ready`. Read-only; needs the entity's read permission |
| `GET /workflow/:entity/:id/preflight/:action` | The same for one transition; `409` with `details.allowed` if it does not exist from this state |
| `GET /workflow/:entity/:id/history` | Full transition log with actor and reason |

List and detail responses also embed `availableTransitions`, so the UI never offers an
action the engine would reject on authority.

## Roles and grants

Hivamis task 6. `SUPER_ADMIN`, `CEO`, `DEPUTY` and `ACCOUNT_MANAGER` hold every permission, fixed.
Every other role holds what the organisation's administrator granted, or its default until then.

| Endpoint | Purpose |
|---|---|
| `GET /roles` | Each role here: `fullAccess`, `permissions` (in force), `defaults`, `differsFromDefault`, `userCount` (in this organisation), and `review: { at, note, grantedBy } \| null` (null = default, not yet reviewed). Any signed-in user |
| `PUT /roles/:code/permissions` `{ permissions, note? }` | Grant exactly these. `admin.roles`. `400 FULL_ACCESS_ROLE` for the four full-access roles, `400 UNKNOWN_PERMISSION` for a code that does not exist. Returns `{ added, removed, permissions }`. A new grant row (the previous one kept, superseded), a new version of the permissions rule set, and an audit event |
| `GET /roles/:code/grants` | Who granted what and when, newest first. `admin.roles` |
| `POST /roles` `{ nameFa, nameEn?, description?, color?, copyFrom? }` | A role of the organisation's own (audit F-3), its code `C_` and eight letters or digits; `copyFrom` starts it with that role's permissions here. `admin.roles`. A grant row, a new permissions rule-set version and an audit event |
| `PATCH /roles/:code` `{ nameFa?, nameEn?, description?, color? }` | The organisation's own roles only; `409 SYSTEM_ROLE` for the code's. `admin.roles` |
| `DELETE /roles/:code` | The organisation's own role, when nothing names it: `409 ROLE_IN_USE` with `details: { holders, delegations, forms, pendingSubmissions, rules }`; `409 SYSTEM_ROLE` for the code's. Its grants are superseded, kept. `admin.roles` |
| `GET /roles/:code/holders` | Who holds it here. `admin.roles`. Another organisation's role is `404` everywhere |
| `GET /positions` | The organisation's positions (audit F-3): `{ id, nameFa, nameEn, departmentCode, defaultRoleCodes, archived, holders }`; `?all=1` with `admin.users` includes archived. Any signed-in user |
| `POST /positions`, `PATCH /positions/:id` `{ nameFa, nameEn?, departmentCode?, defaultRoleCodes?, archived? }` | `admin.users`. `409 POSITION_EXISTS` for a title already there. A rename renames every holder's `jobTitle` |
| `POST /users`, `PATCH /users/:id` `{ …, positionId?, roleCodes? }` | `positionId` sets the position and its title; `roleCodes` may name the organisation's own roles, and `400 UNKNOWN_ROLE` names any it does not have |
| `GET /permissions` | Every permission with the roles that hold it here |

An access token carries `gv`, the grant count of each of its roles at issue. When a role has been
granted anew since, every request with that token is refused with `401 GRANTS_CHANGED`; refresh
and continue — the new token carries the role's permissions as they now are. `GET /rules/versions/:id`
and `/rules/diff` show an organisation only its own grants (under `~organisations` in the
permissions snapshot).

## Domain endpoints

Standard collections support `GET /`, `GET /:id`, `POST /`, `PATCH /:id`.
`state` is never writable through `PATCH` — it belongs to the workflow engine.

| Resource | Path | Read permission |
|---|---|---|
| Companies | `/companies` (+ `/:id/360`) | `crm.company.read` |
| Contacts | `/contacts` | `crm.contact.read` |
| Leads | `/leads` (+ `POST /:id/convert`). `phone` («تلفن همراه») is required and stored as `09xxxxxxxxx` whatever way it was typed. `source` is `SALES_TEAM` \| `MARKETER` \| `STAFF` \| `DIRECT` \| `PARTNER` with its second step: `sourceUserId` (a member of the sales unit, or a colleague outside it), `sourceReferrerId` (a marketer or partner on the list), `sourceChannel` (`PHONE` \| `EXHIBITION` \| `EVENT` \| `CAMPAIGN`), or `sourcePartnerName` (a partner named for the first time, added to the list). Only the kind's own detail is kept; a wrong person is `400 LEAD_SOURCE`. A number already on a lead or a client's contact is `409 DUPLICATE_LEAD` with `details: { leads, contacts }`, unless `confirmDuplicate: true`. List filter `?source=`; `q` also searches the mobile | `crm.lead.read` |
| Lead duplicates | `GET /leads/duplicates?phone=&exclude=` — `{ phone (normalised or null), leads, contacts }` for a number, compared by its last ten digits | `crm.lead.read` |
| Lead source options | `GET /leads/source-options` — kinds, channels, `salesTeam`, `staff`, active `marketers` and `partners`, `canManageMarketers`, `canAddPartners` | `crm.lead.read` |
| Lead sources list | `GET /lead-referrers?kind=&all=` (with each one's `leads` count); `POST { kind, name, phone?, note? }` — a `MARKETER` needs `admin.settings`, a `PARTNER` `crm.lead.write`; `PATCH /:id { name?, phone?, note?, isActive? }` (`admin.settings`). Names are compared with Arabic letters read as Persian; a repeat is `409 REFERRER_EXISTS` | `crm.lead.read` |
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
| Documents | `/documents` (+ `/:id/download`, `/:id/versions`) — the current version of each file unless `?versions=all`; see [Files, versions and the brand library](#files-versions-and-the-brand-library) | `document.read` |

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
| `GET /forms/definitions/:code` | One definition with its field schema, SLA policy and the caller's `canSubmit` |
| `GET /forms/suggest?entity=&id=&limit=` | `form.read` (and the record kind's read permission) — the forms that point at this record and the caller's unit may send, the ones its stage calls for first (`RECORD_KINDS` in `@hiva/contracts`), then by the unit's use in the last six months; each with `prefill` (the record and the records it belongs to, by field key), `fitsStage` and `lastForRecord`. Without `entity`: the caller's most-sent forms |
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

## Notices on the phone (Web Push)

Roadmap #49. Each person's own browsers only; every endpoint needs sign-in and nothing else.

| Endpoint | Purpose |
|---|---|
| `GET /push/key` | `{ publicKey, delivery }` — the VAPID public key a browser subscribes with (base64url, 65 bytes), and whether this installation sends (`PUSH_DELIVERY`) |
| `GET /push/subscriptions` | My browsers: push-service host, user agent, last delivery, and why one is off (`GONE`, `REJECTED`, `FAILING`, `NOT_ALLOWED`) |
| `POST /push/subscriptions` `{ endpoint, keys: { p256dh, auth }, userAgent? }` | `PushSubscription.toJSON()` as the browser gives it. `201` new, `200` known. The endpoint must be https on a push service in `PUSH_SERVICE_HOSTS` (`400 PUSH_ENDPOINT`); `p256dh` a P-256 point and `auth` 16 bytes (`400 PUSH_KEYS`). A browser already registered to someone else moves to the caller, audited with `tookOverFrom`. 20 a minute |
| `DELETE /push/subscriptions` `{ endpoint }` | This browser stops — used on sign-out. Only the caller's own is removed |
| `DELETE /push/subscriptions/:id` | One of my browsers, from the list |
| `POST /push/test` | A test notice to each of my browsers, sent before answering: `{ delivery, results: [{ subscriptionId, host, status: SENT \| QUEUED \| FAILED \| GONE \| OFF, error }] }`. 5 a minute |

What is pushed: `WORK_ORDER_ISSUED` and `WORK_ORDER_CLARIFIED` (to the order's owner),
`QC_UNIT_REQUIRED` (to the deliverable's unit manager, or their delegate in the unit holding
`qc.unit`), `FORM_APPROVAL_REQUIRED`, and `SLA_WARNING` / `SLA_BREACH` / `SLA_PREDICTED_BREACH` only on
a form submission's clock or a work order's `SLA_TASK_ACCEPTANCE`. The payload, encrypted to the
browser (RFC 8291), is `{ id, kind, title, body, url, tag, urgent }`; `url` is `/m?open=<entity>:<id>`.

QC evidence: `POST /documents` takes **`qcReviewId`** — an image, from the review's reviewer, within
24 hours of the review, filed on nothing else (`QC_EVIDENCE_ALONE`, `QC_EVIDENCE_IMAGE`,
`409 QC_EVIDENCE_LATE`, `403` for anyone else). It is not versioned and only its uploader takes it back,
the same day (`409 QC_EVIDENCE_FIXED`). `GET /qc-reviews` lists each review's `documents`, and `GET /qc/queue` gives each deliverable
awaiting QC its last unit-level review (`qcReviews[0]`: verdict, reviewer, photos). The unit-QC
queue in `GET /me/work` leaves out a deliverable reviewed at unit level since it was submitted.

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

## Live updates

Roadmap #39. `GET /events` (authenticated) is a server-sent event stream. Database triggers announce
every state transition and every notification on commit (`pg_notify('hiva_events', …)`), whatever
wrote them — a request, a job, another instance — and a rolled-back change is never announced. Each
API process holds one listening connection and fans events out to its streams.

| Event | Data | Sent to |
|---|---|---|
| `ready` | `{ live }` — the listener is up | this stream |
| `transition` | `{ entity, id, from, to, action, at, mine }` — that a record moved, never what it holds | the organisation's readers of that entity type (`WORKFLOW_READ_PERMISSION`) |
| `notification` | `{ kind, severity }` | the notification's recipient |
| `reset` | `{}` — the listener reconnected; events may have been missed | every stream |
| `expired` | `{}` — the access token that opened the stream has expired; reconnect | this stream |

A comment line every 25 s keeps proxies from closing the stream. At most five streams per person
(`429 LIVE_TOO_MANY`). Send the access token as `Authorization: Bearer` — the web app reads the
stream with `fetch`, so the token never appears in a URL.

## Annotation on deliverables

Roadmap #38. Feedback placed on a deliverable's file: a pin on an image (`PIN`, `x`, `y`), a moment in
a video (`TIMECODE`, `timeSec`, optionally a point), a region of a PDF page (`HIGHLIGHT`, `page`, `x`,
`y`, `w`, `h`). Positions are fractions of the shown size (0–1), so they hold at any zoom; the
database refuses a place outside the file. Each annotation is numbered on its file and keeps the
SHA-256 of the file as annotated.

| Endpoint | Gate | Purpose |
|---|---|---|
| `GET /deliverables/:id/annotations` | `deliverable.read` | The deliverable's files — with which can be annotated (`image`, `video`, `pdf`), older versions too, marked `current: false` with their `version` and `lineageId` — and every annotation with its author, review and revision |
| `POST /deliverables/:id/annotations` | `qc.read` | Add one. `ANNOTATION_FILE` (not this deliverable's), `ANNOTATION_UNSUPPORTED` (not an image, video or PDF), `ANNOTATION_KIND` (a pin on a PDF, say), `ANNOTATION_SUPERSEDED` (an older version — marks go on the current one). Audited |
| `PATCH /annotations/:id` `{ status: OPEN \| RESOLVED }` | `deliverable.write` | Mark it fixed, or open it again |
| `DELETE /annotations/:id` | the author | Only while no QC review has carried it (`409 ANNOTATION_CARRIED`) |

`POST /qc-reviews` takes `annotationIds`: open annotations on the reviewed deliverable, not carried
by another review (`QC_ANNOTATIONS`). A failed review may give them instead of, or with, written
findings; the revision's `requiredCorrection` is then the findings followed by one numbered line per
annotation — `[file — صفحهٔ ۲]`, `[file — ۰۰:۱۲]`, `[file — نشانهٔ ۳]` — and each annotation is linked
to the review and the revision.

## Files, versions and the brand library

A file may be any size (ADR-124). 507 `DISK_FULL`: the server's disk cannot keep it. 413 `STORAGE_QUOTA`:
the organisation's quota cannot.

Roadmap #42. `POST /documents` (multipart) takes two more fields:

- **`replacesId`** — the upload becomes the next version of that file. It takes the replaced file's
  links (project, client, contract, deliverable, form, proposal), tags and brand role; it joins the
  file's lineage (`lineageId`, `version` = previous + 1); the replaced file is kept, marked
  `supersededAt` / `supersededById`. Only the current version can be replaced
  (`409 DOCUMENT_SUPERSEDED`), so two uploads racing on it cannot both win. Visibility to the client
  is not inherited: a new version is shared when someone shares it.
- **`brandRole`** — `LOGO`, `FONT`, `GUIDELINE`, `IMAGE` or `OTHER`: a file of the client's brand
  library. It needs a `companyId` (`BRAND_NEEDS_CLIENT`) and `brand.manage` (403), and so does a new
  version of one; an unknown role is `BAD_BRAND_ROLE`.

Fonts (`.ttf`, `.otf`, `.woff`, `.woff2`) are accepted and checked by signature like everything else;
the vague types browsers give them are settled by the extension. Every upload carries `metadata`,
read from the file's own headers: an image's `width`, `height`, `colorSpace` (`RGB`, `RGBA`,
`GRAYSCALE`, `GRAYSCALE_ALPHA`, `INDEXED`, `CMYK`, `YCCK`) and `bitDepth`; an MP4's `durationSec`,
`width` and `height`; a PDF's `pageCount` and first `pageSizeMm`; a TrueType/OpenType font's
`fontFamily`. What cannot be read is `null` — never a guess.

Every list shows the current version only — `GET /documents` (unless `?versions=all`), the client's
page, a project's and a record's files, a contract's signable PDFs, approval files, QC stage zero,
PDF attachments. E-signature refuses an older version (`422 ESIGN_DOCUMENT_SUPERSEDED`). The client
portal shows, of each file, the newest version shared with the client. `DELETE /documents/:id` on
the current version makes the version it replaced current again.

| Endpoint | Gate | Purpose |
|---|---|---|
| `GET /documents/:id/preview` | `document.read` | The bytes of an image, MP4, PDF or font for showing in the app (`422 PREVIEW_UNSUPPORTED` otherwise). Audited as `FILE_VIEW` once per person, file and hour — not as a download; cacheable privately for five minutes |
| `GET /documents/:id/versions` | `document.read` | Every version of the file, oldest first — name, type, size, SHA-256, `version`, `metadata`, uploader, `current`, `clientVisible` and its annotation count. The same history from any of its versions |
| `GET /companies/:id/brand` | `document.read` | The client's palette, typefaces and notes, and its current brand files with their roles, versions and metadata |
| `PUT /companies/:id/brand` `{ colors: [{ name, hex, role }], fonts: [{ family, usage? }], notes }` | `brand.manage` | Replace them. `hex` is `#RRGGBB`, stored upper-case; `role` is `PRIMARY`, `SECONDARY`, `ACCENT` or `NEUTRAL`. Audited |

## Brand compliance check

Roadmap #43. Each PNG, JPEG and PDF is read at upload for what it is made of, kept as
`metadata.brand` (`v`, `kind`, `colours [{ hex, share }]`, `inks [{ cmyk, share }]`, and for a PDF
`spots` and `fonts`; `skipped: TOO_LARGE | UNREADABLE` when it could not be read). An image's main
colours carry their share of the area; a PDF's colours are those its content sets (`rg`, `k`, `scn`
in ICC, grey and Separation spaces, inside form XObjects too), with their share of the settings,
and its fonts are those its text selects (`Tf`), without the subset prefix. The metadata job reads
older files and re-reads any whose scan is from an older version.

The comparison is made when asked, against the brand library as it is then:

| Endpoint | Gate | Purpose |
|---|---|---|
| `GET /documents/:id/brand-check` | `document.read` | `{ company, supported, kit, check, noteFa }`. `check.colours[]` names each colour `BRAND`, `NEAR`, `NEUTRAL`, `OFF` or `UNCHECKED`, with the nearest brand colour and the distance; `check.fonts[]` and `check.spots[]` likewise; `offShare`; `verdict` `OK`, `WARN` or `NOT_CHECKED`; `notesFa` — what was not judged, and why. The file's client is its own, its project's, its deliverable's project's or its contract's |

RGB is compared in CIEDE2000 — within 8 of a brand colour is the brand's in an image (read through
compression), within 1 in a PDF (exact numbers); up to 15 and 10 is `NEAR`. White, grey and black
(chroma under 8) are `NEUTRAL`. CMYK is compared ink by ink against the brand colours' `cmyk`
(within 6 and 2 points), and left `UNCHECKED` where the brand gave none. An image warns when a
tenth of its area is outside the palette (colours under 3% of it are detail, not design), a PDF at
a twentieth of its colour settings or any typeface outside the brand's.

`PUT /companies/:id/brand` accepts `cmyk: [c, m, y, k]` (0–100, stored whole) on each colour.

QC stage zero (`POST /deliverables/:id/stage-zero`, and the `deliverable.submit` handover) runs the
same check on the deliverable's current files: `check: 'brand'` findings are `WARN` (off-palette
colours, typefaces outside the brand) or `INFO` (a PDF colour nearly the brand's) — never `FAIL`.
What was not judged goes to `notCheckedFa`.

## Rules on the workflows: the registry, extensions, and the organisation's own

Roadmap #47. Guards and effects come from a registry with three sources: Doc_H's (`core`), those an
installed extension adds (`extension`, from `EXTENSIONS_DIR`), and the organisation's own
(`custom`, written in the app). Every transition runs Doc_H's guards, the guards extensions attached
to it, then the organisation's; effects run core first. A rule can add a requirement, never remove
one. The organisation's guards appear in preflight as `custom:<code>`, can be waived (#7) under that
key, and a passing move's audit row records them: `after.customRules = { guards: ['RUL-000001@2'],
notified: [...] }`. A refused move is `422 GOVERNANCE_RULE_VIOLATION` with
`details.rule = 'قانون سازمان RUL-000001 (نسخهٔ 2)'`. An extension effect that writes `state`,
identity or a field the core effect set is refused, `500 EFFECT_REFUSED`, and the move is undone.

| Endpoint | Gate | Purpose |
|---|---|---|
| `GET /rules/registry` | signed in | Installed extensions and what each adds; every guard with its `source`; guards attached to transitions; extension effects |
| `GET /rules/custom` (`?all=1` for retired versions too) | signed in | The organisation's rules, current versions, each with `whenFa` — its condition in Persian |
| `GET /rules/custom/:code` | signed in | Every version of one rule, newest first |
| `GET /rules/custom/vocabulary` | signed in | Workflows, their transitions, and each entity's fields a condition may name (from the schema; each date also as `<field>.daysFromNow`; `actor.id` for four-eyes rules) |
| `POST /rules/custom` `{ kind, entity, action, labelFa, messageFa?, when?, notifyRoles? }` | `rules.manage` | Publish a rule as `RUL-000001` v1. `kind` `GUARD` needs `when` (the condition the move must satisfy); `NOTIFY` needs `notifyRoles` and may have `when`. `422 RULE_INVALID` for a transition or field that does not exist. Audited |
| `PUT /rules/custom/:code` | `rules.manage` | A change: the next version, and the current one retired (`supersededById`). A version is never edited — the database refuses it. `409 RULE_CHANGED` if another edit won. Audited |
| `POST /rules/custom/:code/retire` `{ reason }` | `rules.manage` | Stop applying it; its versions stay. Audited with the reason |
| `POST /rules/custom/test` `{ rule, recordId }` | `rules.manage` | A draft against one record (id or code), now: `holds`, `verdictFa`, and the values the condition read. Nothing written |
| `POST /rules/custom/replay` `{ rule, limit? }` | `rules.manage` | A draft against this organisation's past transitions of that move: how many it would have held back (or notified), judged on the records as they are today |

Conditions are #17's routing language, which gains `eqField` and `neField` — sameness with another
field. A `NOTIFY` rule writes `CUSTOM_RULE` notifications to the active holders of its roles, except
the person who made the move, inside the move's transaction.

## Onboarding

Roadmap #48. An organisation's own spreadsheets, brought in: people and their units, clients and
contacts, projects already running, holidays. Every import is the same two calls with the same file —
an `.xlsx` (first sheet) or a CSV (UTF-8 or Windows-1256, comma or semicolon); headers in Persian or
English; digits in any script; dates Jalali or Gregorian.

| Endpoint | Gate | Purpose |
|---|---|---|
| `GET /onboarding` | `admin.settings` | Six steps read from the data — units, users, calendar, SLA, clients, projects — each `done`, with a Persian detail; the three that are a judgement carry `confirmed { at, by }` |
| `GET /onboarding/columns/:kind` · `GET /onboarding/templates/:kind` | `admin.settings` | The columns of `users`, `companies`, `contacts`, `projects` or `holidays`, with how to fill each; a CSV of Persian headers |
| `POST /onboarding/import/:kind/preview` (multipart `file`) | `admin.users` for `users`, else `admin.settings` | Every row checked, nothing written: `rows[] { line, label, status: CREATE \| SKIP \| INVALID, issues[], notes[] }`, `summary`, and the header's `missing` and `unknown` columns. `SKIP` is a row already here — a file run twice creates nothing twice |
| `POST /onboarding/import/:kind/commit` (same file) | same | The valid rows written, each in its own transaction: `created[]`, `failed[]`, and for people `activations[]`. Audited as `BULK_IMPORT` |
| `GET /onboarding/units` · `PUT /onboarding/units { map }` | `admin.settings` | The organisation's unit names, each mapped to one of the ten Doc_H unit codes. Audited |
| `POST /onboarding/units/scan` (multipart users file) | `admin.settings` | The unit names the file uses: `{ name, people, resolved, suggestion }` |
| `POST /onboarding/confirm/:step` (`units`, `calendar`, `sla`) | `admin.settings` | A person says the step is right. Audited |
| `GET /onboarding/activations` | `admin.users` | People imported who have not set a password |
| `POST /users/:id/activation` | `admin.users` | A fresh one-time link; the old one stops working. `url` only when it was not emailed |
| `GET /auth/activation/:token` · `POST /auth/activation/:token { password }` | public, rate-limited | Who the link is for; then the first password (the staff password rules). `404 ACTIVATION_INVALID`, `410 ACTIVATION_USED`, `410 ACTIVATION_EXPIRED` |

What each import holds to:

- **users** — `email`, `fullName`, `unit` (a Doc_H code, the organisation's own name through the unit
  map, or Doc_H's Persian name), `roles` (codes or Persian names, `|`-separated; `SUPER_ADMIN` is
  never granted by file). No password is in the file or set by it: each person gets a one-time link
  — emailed when mail is on, otherwise returned once — good for seven days.
- **companies** — found again by national id or legal name (Arabic «ي»/«ك» read as Persian). An empty
  account owner makes the importer the owner, and the row says so.
- **contacts** — the client by national id or legal name.
- **projects** — `legacyRef` (the old system's reference) makes a re-run skip it. The state it comes
  over in — draft, pending authorization, authorized, planning, active, on hold — is recorded by the
  engine as an *opening state*: not a move, no guard, marked `opening` on the transition so process
  mining, the rule lab and webhooks leave it out. From authorized on, Doc_H rule 13 needs
  `authorizationBasis` and `authorizationRef`, recorded as the project's execution authorization.
- **holidays** — a date and a title, once per day.

`PATCH /organization` and `PATCH /sla-policies/:code` now validate what they are given (weekdays
0–6, hours in order, SLA hours 0.5–2000, warning 0.1–0.99), and a change of the working week is
audited.

## Messenger

Roadmap #40. A person links their messenger chat, and the notifications that matter
(`FORM_APPROVAL_REQUIRED`, `SLA_BREACH`, `SLA_WARNING`, `SLA_PREDICTED_BREACH`,
`CLIENT_APPROVAL_DECIDED`, `PORTAL_MESSAGE`, `ESIGN_COMPLETED`, `ESIGN_DECLINED`) are sent there
too. A form approval arrives with «تأیید / رد / باز کردن در سیستم»; pressing one decides the form
through `decideForm` — the same approver roles, stages, quorum and separation of duties, the same
audit row (its `userAgent` is `messenger:<provider>`) — as that person with their permissions and
delegations of now, after the same `form.approve` gate as the app. «رد» asks for the reason, and the
next message from that chat is taken as it (or «انصراف»). A button is a single-use token that
expires in 72 h and works only from the chat linked to the person it was sent to; the message is
then edited to say what happened. `MESSENGER_MODE`: `sandbox` (an in-app chat per person), `bale`,
`telegram` (a bot on the Telegram-compatible Bot API), `off`.

| Endpoint | Gate | Purpose |
|---|---|---|
| `GET /messenger/me` | signed in (not an API key) | Mode, whether this person is linked |
| `POST /messenger/link` | same | A one-time code `HV-XXXXXX` (15 minutes) to send the bot — `/start HV-…`, `/link HV-…` or the code alone; a Telegram deep link when the bot's name is set. A chat already linked to someone else is refused |
| `DELETE /messenger/link` | same | Unlink; open buttons stop working. Audited |
| `GET /messenger/sandbox/chat` · `POST …/send` `{ text }` · `POST …/press` `{ action }` | same, sandbox only | Your own stand-in chat: what the bot said, what you say back, the buttons you press |
| `POST /messenger/webhook/:secret` | the path secret, and the Bot API's `X-Telegram-Bot-Api-Secret-Token` when sent | The bot's updates: `message` (codes, reasons) and `callback_query` (buttons). Anything else is `404`; a processing failure is logged and still answered `200`, as the Bot API retries otherwise |
| `GET /admin/messenger` · `POST /admin/messenger/webhook` | `admin.settings` | Mode, linked people, messages in the last 24 h; register the webhook with the bot |

Outgoing messages are kept (`messenger_messages`): sent at once, retried every minute up to five
times.

## API keys and webhooks

Roadmap #46 — identities for systems, and events sent to them. Both are managed only from a
person's session (`admin.keys`); a key is refused on `/auth/*`, `/delegations`, `/messenger/*`
(#40 — a linked chat decides with the person's whole authority) and these management paths.

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

### The chat assistant

Hivamis task 5. A local model (Ollama) answers questions in a conversation. Every route needs
`ai.chat`, which each role has unless the administrator takes it away; none accepts an API key.

| Endpoint | Purpose |
|---|---|
| `GET /ai/chat/status` | `{ mode, ready, model, reachable, modelPresent, busy, waiting }`. `ready` means the model server answers and has the model. Takes at most two seconds |
| `POST /ai/chat` `{ conversationId?, message, context? }` | One question. `context` is the page it was asked from: `{ path, entity, id, title }`. Answers `text/event-stream`; see below. 30 a minute. 503 `CHAT_OFF` when `CHAT_MODE=off` |
| `GET /ai/conversations` | Your own, newest first (50) |
| `GET /ai/conversations/:id` | One of yours, with its questions and answers (tool steps are not returned). Someone else's is 404 |
| `DELETE /ai/conversations/:id` | Delete one of yours, 204 |

The stream's events, in order:

- `meta` `{ conversationId, model }`
- `queue` `{ position }`, only while waiting for a free slot
- `tool` `{ name, args }`, each time the model looks something up
- `delta` `{ text }`, the answer as it is written
- `action` `{ type: 'form', label, code, prefill }`, `{ type: 'link', label, path }`, or
  `{ type: 'plan', label, planId, steps }` (below)
- `done` `{ messageId, actions }`, or `error` `{ code, message }`

When `context` names a record (`entity`, `id`), that record and the forms that fit it are read
first, as the person, and given to the model. A form the answer names becomes an `action` even if
the model did not offer it (four at most).

The model's lookups are this application's own read endpoints, called as the person asking. A
lookup they may not make comes back refused, and the model is told so. Nothing is written: a form
is only offered, with its fields filled. `prefill` keeps only the form's own fields, and only forms
the person's unit may send are offered. Links are limited to pages in the application.

#### Voice, and changes the person approves

Audit F-4. Same permission, `ai.chat`.

| Endpoint | Purpose |
|---|---|
| `GET /ai/voice/status` | `{ configured }`: whether `TRANSCRIPTION_URL` is set. The microphone is shown only when it is |
| `POST /ai/voice/transcribe` | One multipart part, `audio/*` (WebM, Ogg, MP4/M4A, MPEG, WAV, AAC), at most 10 MB. Answers `{ text }`, in Persian unless spoken otherwise. The audio is not kept. 20 a minute. 400 `UNSUPPORTED_TYPE`, 413 `VOICE_TOO_LONG`, 501 `TRANSCRIPTION_NOT_CONFIGURED` |
| `GET /ai/plans/:id` | `{ id, status, outcome, createdAt, decidedAt, expired }`. Status is `PROPOSED`, `EXECUTED`, `PARTIAL`, `FAILED` or `DECLINED`. Someone else's plan is 404 |
| `POST /ai/plans/:id/execute` `{ steps: number[] }` | Runs those steps in order, as the caller, through the routes their `request` names; the rest are declined. Answers `{ status, outcome: [{ index, status: DONE\|FAILED\|DECLINED, code?, message? }] }`. 409 `PLAN_DECIDED` once decided; 409 `PLAN_EXPIRED` after 30 minutes |
| `POST /ai/plans/:id/decline` | Declines every step. Same answer |

A plan arrives in the chat stream as an `action`:

```json
{ "type": "plan", "label": "تغییرات پیشنهادی", "planId": "…",
  "steps": [{ "kind": "log_time", "summary": "ثبت ۳ ساعت کار روی «پیش‌نویس لوگو» (TSK-000123) برای ۱۴۰۵/۰۷/۲۱",
              "request": { "method": "POST", "path": "/tasks/…/time", "body": { "hours": 3, "workedOn": "2026-10-13" } } }] }
```

- **Step kinds:** `task_submit`, `task_move` (any task move but assigning), `log_time`,
  `create_task`, `schedule_meeting`, `submit_form`.
- **`issue`** says, in the reader's language, why a step cannot be approved as it stands; such a
  step is reported `FAILED` with `NOT_APPROVABLE` if ticked anyway.
- **Audit actions:** `AI_PLAN_PROPOSED`, `AI_PLAN_EXECUTED`, `AI_PLAN_DECLINED`, on `aiPlan`.

## Team chat

Audit F-5. Every route needs `chat.use`, which every role has unless the administrator takes it
away; none accepts an API key (`chat.*` are never on a key). A conversation answers only to its
members: anyone else, in this organisation or another, gets 404.

| Endpoint | Purpose |
|---|---|
| `GET /chat/conversations?archived=true` | Yours, most recently active first: `id, kind, title, topic, peer, memberCount, unread, muted, notify, role, lastMessage, archived` |
| `GET /chat/unread` | `{ total, conversations }`: unread messages in conversations you have not muted (the sidebar's count) |
| `GET /chat/channels` | The organisation's channels, with `memberCount` and whether you `joined` |
| `POST /chat/conversations` | `{ kind: 'DIRECT', memberIds: [other] }` opens the pair's one conversation (`existing: true` when it was there); `{ kind: 'GROUP', title, topic?, memberIds }`; `{ kind: 'CHANNEL', title, topic?, memberIds? }` needs `chat.channel.create`. 201 `{ id, existing }`. 400 `UNKNOWN_USER` for anyone not an active colleague |
| `GET /chat/conversations/:id` | The conversation, your own settings (`me`) and its members |
| `PATCH /chat/conversations/:id` | `{ title?, topic?, archived? }`: owner or administrator; not a direct conversation |
| `POST /chat/conversations/:id/join` · `/leave` | Join a channel; leave a group or channel (the last owner leaving hands it to the longest-standing member). A direct conversation cannot be left: 400 `DIRECT_FIXED` |
| `POST /chat/conversations/:id/members` `{ userIds }` · `DELETE …/members/:userId` · `PATCH …/members/:userId` `{ role }` | Owner or administrator adds and removes; the owner sets roles |
| `PATCH /chat/conversations/:id/me` | `{ muted?, notify?: ALL \| MENTIONS \| NONE }` |
| `POST /chat/conversations/:id/read` | Marks it read now, with its notices |
| `GET /chat/conversations/:id/messages?before=&limit=` | Up to 50, oldest first: `{ items, hasMore, records }`. A removed message has `deleted: true` and no text. `records` maps each code the messages name (`PRJ-…`, `TSK-…`, `BRF-…`, `PRP-…`, `CNT-…`, `OPP-…`) to `{ type, id, title }`, only where the reader may open it |
| `POST /chat/conversations/:id/messages` | `{ body, replyToId?, attachmentIds?, mentionIds? }`. Files must be ones you uploaded to this conversation and not yet sent; only members can be named. 409 `CHAT_ARCHIVED` |
| `PATCH /chat/messages/:id` | `{ body }`: the author only; what it said before is kept |
| `DELETE /chat/messages/:id` | The author, or the owner or an administrator of a group or channel (audited as `DELETE` on `chatMessage`). The message is hidden and kept |
| `GET /chat/files/:id` | A shared file, to members, as a download (`FILE_DOWNLOAD` audited). Before it is sent, only its uploader may fetch it |

**Sharing a file.** `POST /documents` with a multipart field `chatConversationId` **before** the
file part. It needs `document.write` and membership, and links the file to nothing else
(400 `CHAT_FILE_ALONE`). The documents routes do not list or serve such a file; the chat does.

**Live.** The `/events` stream carries `chat` `{ conversationId, messageId, op, mine }` to the
conversation's members, and `{ conversationId, membership: true }` when your own membership
changes. It never carries what a message says.

**Notices.** `CHAT_MESSAGE` (once per conversation until it is read) and `CHAT_MENTION`, as each
member chose. The title names the writer and the conversation; there is no body.

### Oversight

`chat.oversight` is held by no role by default, the full-access roles included. Only a
`SUPER_ADMIN` in their own right may add it to a role or give a role that holds it
(403 `OVERSIGHT_GRANTOR_ONLY`). It cannot be delegated (400 `NOT_DELEGABLE`) or put on a key.

| Endpoint | Purpose |
|---|---|
| `GET /chat/oversight/conversations?q=` | The organisation's conversations: members, kind, message count, last activity — not their text. Audited as `CHAT_OVERSIGHT_LIST` |
| `POST /chat/oversight/conversations/:id/view` | `{ reason (10–500), before? }`: up to 200 messages, read-only, removed ones and earlier wordings (`edits`) included. Audited as `CHAT_OVERSIGHT_VIEW` with the reason, in the same transaction as the read |
| `POST /chat/oversight/files/:id` | `{ reason }`: one shared file, audited as `CHAT_OVERSIGHT_VIEW` on the document |

Audit rows whose action starts `CHAT_OVERSIGHT_` cannot be updated, deleted or truncated away: a
database trigger refuses it.

## Offline replays

Audit F-7. Four writes honour an `Idempotency-Key` header (8–100 characters of `A–Z a–z 0–9 _ . : -`):
`POST /forms/submissions`, `POST /tasks/:id/time`, `POST /tasks/:id/comments` and
`POST /workflow/:entity/:id/transitions`.

- **The first request** with a key runs, and a successful answer is kept for seven days.
- **The same key and the same request again** (method, path and body) gets that answer, with
  `Idempotent-Replayed: true`, and the work is not done again.
- **The same key on a different request:** 422 `IDEMPOTENCY_KEY_REUSED`.
- **While the first is still running:** 409 `IDEMPOTENCY_IN_PROGRESS`. After a minute of silence
  the first is taken to have died, and the next takes its place.
- **A refusal (4xx) or a failure (5xx)** is not kept: the key is let go, so a corrected request
  may use it again.
- **Keys are per person:** another person's key is another key.

| Endpoint | Purpose |
|---|---|
| `GET /tasks/:id/comments` | `task.read`: the task's notes, oldest first (300), with `author.avatarUrl` |
| `POST /tasks/:id/comments` | `task.read`: `{ body (1–2000) }`. 201. Audited as `CREATE` on `comment`; the assignee is told (`TASK_COMMENT`) |

`GET /auth/me` carries `offlineKey`: a 32-byte key (base64url) the page encrypts its offline copy
with. It is the same for every refresh of one sign-in on a device and different for another sign-in.
It is derived from the session and never stored.

## The profile

Audit F-6. Any signed-in person, for themselves.

| Endpoint | Purpose |
|---|---|
| `GET /me/about` · `PATCH /me/about` | `{ bio? (≤ 500), pronouncedName? (≤ 120), skills? (≤ 20 × 40), links? (≤ 5, https only) }`. A blank text clears it. Audited as `UPDATE` on the user |
| `POST /me/avatar` | One multipart part: JPEG, PNG, WebP or GIF, at most 10 MB. Decoded (at most 40 megapixels), turned upright, cut to 512 × 512 and re-encoded as WebP with no metadata. Kept as a document; the previous photo is deleted. `{ avatarUrl }`. 400 `UNSUPPORTED_TYPE`, `UNSUPPORTED_IMAGE`; 413 `FILE_TOO_LARGE`. 10 a minute |
| `DELETE /me/avatar` | Removes your photo |
| `DELETE /users/:id/avatar` | `admin.users`: takes someone's photo down, audited as theirs |
| `GET /avatars/:id?exp=&sig=` | No session: the address is signed (HMAC), good until the end of the next day (UTC), so one address serves all day and the browser keeps it. Only a current photo is served, as `image/webp`; anything else is 404, a bad or old signature 403 |

People carry `avatarUrl` (or `null`) wherever they appear: `/auth/me`, `/people`, `/people/:id`
(with `bio`, `pronouncedName`, `skills`, `links`), the chat (members, message authors, a direct
conversation's peer), notes on files, and the assignee suggestions. A photo is not listed by
`GET /documents`.

## The guide's videos

Hivamis task 8. One recorded video per guide section and language, added by the organisation.

| Endpoint | Purpose |
|---|---|
| `GET /guide/videos` | Any signed-in user. The videos that exist: `id`, `sectionId`, `locale`, `title`, `mimeType`, `sizeBytes`, `createdAt`, uploader |
| `POST /guide/videos?sectionId=&locale=fa\|en&title=` | `admin.settings`. The file is the one multipart part, MP4 or WebM, checked by its bytes, of any size. It replaces that section's video in that language, and the old file is deleted. 201 |
| `DELETE /guide/videos/:id` | `admin.settings`. Removes the video and its file. 204 |
| `GET /guide/videos/:id/link` | Any signed-in user. `{ url, expiresAt }`: a link that plays this video for three hours |
| `GET /guide/videos/:id/stream?exp=&sig=` | No token: the signature is the permission. Serves byte ranges (206) as `video/mp4` or `video/webm` with `nosniff`. 403 `LINK_INVALID` when the signature does not match this video or has expired |

`sectionId` is an id from `GUIDE` in `@hiva/contracts`. The assistant's `search_guide` tool searches
the same guide (see the chat assistant above).

## Venues, deployment projects and rentals

ADR-103. Lists are paginated (`page`, `pageSize`, `q`, `sort`, `order`); every write is audited.

| Route | Permission | |
|---|---|---|
| `GET/POST /site-options`, `PATCH /site-options/:id` | any of the module's / `site.configure` | The organisation's lists, retired not deleted |
| `GET/PUT /site-settings` | any of the module's / `site.configure` | Reminders, proration, overpayment, activation, required fields, SMS templates |
| `GET /venues`, `GET /venues/facets`, `GET /venues/:id` | `venue.read` | Filters: province, city, typeCode, gradeCode, audience, status, incomplete, withoutActiveProject |
| `POST /venues/duplicates` | `venue.read` | Likely duplicates of a draft |
| `POST /venues`, `PATCH /venues/:id` | `venue.write` | 409 `POSSIBLE_DUPLICATE` unless `confirmNotDuplicate`; `version` for concurrent edits |
| `POST /venues/:id/archive`, `/restore`, `/duplicates/decision` | `venue.manage` | Merge or keep apart |
| `POST /venues/:id/contacts`, `PATCH /venue-contacts/:id`, `POST /venue-contacts/:id/archive`, `POST /venues/:id/channels`, `DELETE /venue-channels/:id` | `venue.write` | |
| `POST /venue-messages`, `GET /venue-messages` | `venue.sms` | SMS to venues and its log |
| `GET /site-projects`, `GET /site-projects/:id` | `site.read` | With `availableTransitions`; balances with `rental.read` |
| `POST /site-projects`, `PATCH /site-projects/:id` | `site.write` | Terms locked once the contract is sent (409 `TERMS_LOCKED`) |
| `POST /site-projects/:id/negotiations`, `PATCH /site-negotiations/:id` | `site.write` | |
| `POST /site-projects/:id/contracts`, `POST /site-contracts/:id/submit` | `site.write` | A version, or an amendment |
| `POST /site-contracts/:id/decision` | `site.contract.approve` | Not by its writer; moves the project in the same transaction |
| `POST /site-projects/:id/approvals`, counters, assignments | `site.write` | The client's approval; counters; staff on site |
| `POST /workflow/siteProject/:id/transitions` | per transition | The lifecycle |
| `GET /rentals/dashboard`, `GET /site-obligations`, `GET /site-obligations/calendar`, `GET /site-projects/:id/ledger`, `GET /site-projects/:id/closure` | `rental.read` | |
| `POST /site-projects/:id/obligations`, `PATCH /site-obligations/:id`, `POST /site-obligations/:id/close`, `POST /site-projects/:id/schedule` | `rental.manage` | Waiving needs `rental.approve` |
| `POST /site-projects/:id/payments` | `rental.manage` | `clientKey` makes it idempotent (200 + `Idempotent-Replay: true` on a repeat) |
| `POST /site-payments/:id/reverse`, `POST /site-projects/:id/deductions` | `rental.manage` | |
| `POST /site-deposit-entries/:id/decision` | `rental.approve` | Not by its recorder |
| `GET /site-reminders`, `POST /site-reminders/run` | `rental.read` or `site.configure` / `site.configure` | |
| `GET /site-reports/venues`, `/projects`, `/rentals` | `venue.read` / `site.read` / `rental.read` | |
| `GET /site-data/templates/:kind`, `GET /site-data/columns/:kind`, `POST /site-data/import/:kind` | per kind | `dryRun` (default true), `mode`, `skipInvalid` |
| `GET /site-data/imports`, `GET /site-data/export/:kind` | per kind | Exports stream xlsx |

## Administration

| Endpoint | Permission |
|---|---|
| `GET /users`, `POST /users`, `PATCH /users/:id`, `POST /users/:id/deactivate` | `admin.users` for writes |
| `GET /departments`, `/roles`, `/permissions` | authenticated |
| `PATCH /departments/:code/calendar` `{ workingDays?, workStartHour?, workEndHour?, breakHours? }` | `admin.settings` — a unit's calendar overrides; `null` inherits the organisation |
| `PATCH /departments/:code/color` `{ color: "#rrggbb" \| null }` | `admin.settings` — the unit's tag colour, stored lower case; `null` returns it to its default. `GET /departments` returns `tagColor` (the choice, or null) and `color` (what to show). Audited |
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
