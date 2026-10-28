# Architecture

## The shape of the problem

Doc_H describes an advertising agency whose operating model is a **governed hand-off chain**:
Sales acquires, Account owns delivery, four specialist units execute, three QC levels gate
quality, and Management authorises money and start. The documents spend far more effort on
*rules and control points* than on features.

That shaped every decision below. The system is not a CRM with workflow bolted on; it is a
workflow engine with domain modules attached.

## Context

```
┌──────────────┐        ┌─────────────────────────────┐        ┌──────────────┐
│  Browser     │──HTTP──▶│  nginx (SPA + /api proxy)   │──────▶ │  API         │
│  RTL SPA     │        └─────────────────────────────┘        │  Fastify     │
└──────────────┘                                                └──────┬───────┘
                                                                       │
                            ┌──────────────────────────────────────────┼─────────────┐
                            │                     │                    │             │
                     ┌──────▼──────┐      ┌───────▼───────┐   ┌────────▼──────┐  ┌───▼────────┐
                     │ PostgreSQL  │      │ pg-boss jobs  │   │ Object store  │  │ Anthropic  │
                     │ 17          │      │ (same DB)     │   │ (filesystem)  │  │ (optional) │
                     └─────────────┘      └───────────────┘   └───────────────┘  └────────────┘
```

## Architecture choice: modular monolith

**Evaluated:** modular monolith, microservices, serverless, event-driven, hybrid.

**Chosen: modular monolith with strict internal boundaries.**

The decisive fact is that Hiva's core operations are *transactional across module boundaries*.
A single QC rejection must, atomically: write the review, raise a revision, move the deliverable's
state, stop one SLA clock, start another, and append two audit rows. In a microservice split that
is a distributed saga with compensating transactions and eventual consistency — for an
organisation of roughly 15–200 users. The cost is real and the benefit is zero at this scale.

The monolith is kept honest by boundaries that are enforced rather than aspirational:

- `packages/contracts` is the single source of truth for enums, permissions, state machines,
  the SLA catalogue and all 130 forms. Both the API and the SPA import it, so a state or
  permission cannot drift between layers.
- **Entity `state` is written only by `workflow/engine.ts`** — through `transition()` for a move
  the actor initiates, `transitionWithin()` where that move must be atomic with other writes, and
  `cascadeState()` for a move on a second entity caused by the first. All three write the
  `StateTransition` row and the audit event; only the cascade skips guards, and only because the
  transition that caused it already passed its own. The generic CRUD factory strips `state` from
  every PATCH body, and a database CHECK constraint pins each column to its declared vocabulary,
  so a direct UPDATE cannot introduce an undeclared state either. See ADR-002.
- Domain modules communicate through the database and the workflow engine, not by importing
  each other's route handlers.

If a module ever needs independent scaling, its boundary is already drawn.

## Technology

| Layer | Choice | Why this one |
|---|---|---|
| Language | TypeScript (Node 22) | One language across API, SPA and shared contracts — the workflow and permission definitions are literally the same objects on both sides |
| API | Fastify 5 | Fast, small, first-class async, and `app.inject()` gives in-process HTTP testing with no port binding |
| ORM | Prisma 6 | Generated types keep the domain model and the code in lock-step; migrations are first-class; the DMMF drives the CRUD factory |
| Database | PostgreSQL 17 | Transactional guarantees the governance model depends on, plus JSONB for form payloads, arrays, and full-text search — one datastore instead of three |
| Jobs | pg-boss | Postgres-backed. Adding Redis for a handful of scheduled SLA ticks would be operational cost with no benefit at agency scale |
| Search | PostgreSQL `ILIKE` + indexes | The corpus is thousands of records, not millions. Elasticsearch would be unjustified infrastructure |
| Validation | Zod | Schemas are shared with the SPA and double as the API contract |
| Auth | `jose` (JWT) + Argon2id | Argon2id is the current OWASP recommendation; short access tokens with rotating refresh tokens |
| SPA | React 19 + Vite 6 | Internal tool: no SEO need, so a fast SPA beats SSR complexity |
| Data fetching | TanStack Query | Cache invalidation after a workflow transition is one call |
| Styling | Tailwind CSS 4 | Token-driven design system in CSS, no runtime cost, trivially RTL. The tokens are the Figma kit's variables (Hivamis task 3, [design.md](design.md)) |
| Charts | Recharts | Lazy-loaded on `/reports` only |
| The guide's owl | three.js | Hivamis task 8: the owl is drawn in 3D from primitives, with no model file. The library loads in its own chunk the first time the owl appears; without WebGL, or in tests, a flat SVG owl stands in |
| Language | Persian source, English catalogues (no library) | `tr()` over Persian keys; the English catalogues load only in English, and composed server text is read back against its template (ADR-056) |

**Deliberately not used:** Kubernetes, a message broker, a separate search cluster, a vector
database, microservices. Each was considered and rejected as unjustified at the target scale.
The architecture is designed so any of them can be introduced later at a single seam.

## The four engines

### 1. Workflow engine — `src/workflow/`

Every lifecycle change in the platform goes through `transition()`. It executes in one database
transaction, in this order:

```
load record → find declared transition → check permission → check mandatory reason
  → run Doc_H guards → apply state + effects → log StateTransition → append AuditEvent
  → stop SLA clocks → start SLA clocks
```

- **Definitions** (`packages/contracts/src/workflows.ts`) are declarative: 16 state machines,
  every transition naming its permission, guards, mandatory-reason flag and SLA effects.
- **Guards** (`src/workflow/guards.ts`) are the Doc_H rules RBAC cannot express — "a project may
  not activate without an authorization record", "nothing reaches the client without a passing
  Account QC". A blocked guard returns HTTP 422 naming the Doc_H clause, so the UI explains
  *which rule* fired rather than showing a generic failure. Enforcement stops at the first failing guard; `preflight()` runs every guard and reports every verdict, and the action bar shows that checklist beside each button — so a blocked move says what is missing before the click, not after (roadmap #2). Guards are read-only, which is what makes that safe to call on every page view; each has a positive `GUARD_LABELS` entry for the tick, since a guard's own message only exists on failure.
- **Effects** (`src/workflow/effects.ts`) are side effects applied atomically with the state
  change, so timestamps can never drift from the state they describe.
- **Opening states** (`recordOpeningState`, roadmap #48): a record that arrives from a previous
  system already in mid-life has its state *recorded*, in the engine, from the workflow's first
  state and only once — no guard runs — and the transition row is marked `opening`, which process
  mining, the rule lab and webhooks leave out.
- **The registry** (`src/workflow/registry.ts`, roadmap #47) is where the engine finds both. Doc_H's
  guards and effects register themselves; an extension in `EXTENSIONS_DIR` registers its own and
  attaches guards to existing transitions; an organisation's no-code rules (`custom_rules`) join at
  the transition. A rule is added, never replaced: keys are unique, attached guards stand beside
  Doc_H's, and an extension effect may not write the state or rewrite what the core set.

- **Notices after the commit** (`src/workflow/notices.ts`, roadmap #49): once `transition()`
  has committed, a move that hands someone short-deadline work tells them — an issued (or
  clarified) work order its owner, a submitted deliverable its unit's manager (or their delegate in
  the unit). Never inside the transaction, so a move that rolls back tells nobody.

An undeclared transition returns 409 with the list of legal actions.

### 2. Form engine — `src/forms/`

Doc_H specifies 130 forms and, crucially, demands each be a *Data Object*:
`Form → Sender → Receiver → Trigger → Input → Process → Output → Approver → SLA → Next Process`.

Hand-coding 130 screens would be unmaintainable. Instead every form is a row in
`form_definitions` carrying its field schema as JSON. One renderer draws all of them; one
engine routes, validates, approves and SLA-tracks all of them.

73 of the 130 forms are **structural** — they carry a `binding` and drive a first-class domain
record through a typed handler (a lead form creates a `Lead`, a QC form creates a `QcReview`).
The rest are genuine structured communications and are fully functional as routed, approved,
SLA-tracked records — which is exactly what Doc_H asks of them.

Adding or changing a form is a data change, not a code change.

### 3. SLA engine — `src/sla/`

Doc_H states SLAs in *working* hours («۴ ساعت کاری», «۱ روز کاری»). Wall-clock arithmetic would
be wrong. `lib/business-calendar.ts` implements business-hours addition and elapsed-time
measurement against the organisation's calendar — Saturday–Wednesday, 09:00–18:00 with a break
hour, plus holidays — all configurable per organisation.

Clocks start and stop from workflow transitions and form submissions. A scheduled job moves
clocks to `AT_RISK` at the warning threshold and `BREACHED` past due, notifying the owner.
All 31 policies carry a `docRef` back to their source: 30 are transcribed from Doc_H slide 33 and
the RACI matrix, and one decides a meeting booking within half a working day (audit F-9).

Every notice leaves through `notify()` (`src/mail/notify.ts`): the in-app row, the messenger (#40),
email for the kinds that warrant it, and — for the three loops whose deadlines are hours — **Web
Push to the phone** (`src/push/`, roadmap #49). Push is implemented without a library: the payload
is encrypted to the browser's key (RFC 8291, aes128gcm) and the request signed with the
installation's VAPID key (RFC 8292), so the browser's push service carries it unread. Each notice is
an outbox row per browser (`push_messages`), sent at once and retried by the `push:send` job; the
service's answer decides what follows (410 switches the browser off). Endpoints are held to the
browsers' own push services (`PUSH_SERVICE_HOSTS`), and the connection refuses internal addresses —
a subscription is an address the server will call, supplied by whoever is signed in. The phone's
screen, `/m`, is part of the web app, not a separate one: the same endpoints, the same engine.

### 4. AI subsystem — `src/ai/`

Two properties were non-negotiable: it must never widen a user's reach, and it must be useful
without a model.

- **Permission-bound.** Each capability declares the data permission it needs. A unit specialist
  asking for customer health gets 403 — the same answer a direct request would produce.
- **Deterministic core.** Every capability first computes rule-derived findings from the database:
  a project ACTIVE without authorization, an out-of-scope change missing impact dimensions, an
  incomplete brief. These are correct and citable with no model involved.
- **Model is additive.** When `ANTHROPIC_API_KEY` is configured, a language model adds narrative
  over the same grounded data. When it is not, the findings still work and the UI says so plainly.
- **Fully audited.** Every call writes to `ai_interactions` with actor, capability, model,
  grounding references and latency.
- **Advisory only.** The AI layer holds no write path to business data. What the assistant proposes
  is written only by the ordinary routes, as the person, after they approve it (below).
- **A local conversation.** The chat assistant (`/ai/chat`, ADR-060) runs on a model served by Ollama
  on the organisation's own machine. Its tools are the application's read endpoints, called
  in-process with the asking person's token, so it sees what they see. It writes nothing: it offers
  forms, already filled, and pages for the person to open. Conversations (`ai_conversations`,
  `ai_messages`) belong to their owner. The log keeps the tools used, not the words.
- **Proposals and voice** (ADR-085). Asked to change something, the assistant proposes a plan
  (`ai_plans`): steps resolved with the person's reads, each the exact request it would make.
  - Only steps the person ticks run. They run as that person, through the public routes
    (`app.inject`), so the state machine, Doc_H guards, SLAs and audit apply as on the page.
  - Speech is turned into text by the installation's own Whisper server (`TRANSCRIPTION_URL`, the
    Compose `speech` profile) and is not kept.
- **Offline** (ADR-088). The page keeps an AES-GCM copy of what people read in the field
  (lib/vault.ts, lib/offline.ts) under a per-sign-in key from `/auth/me`. It queues forms, time,
  task notes and hand-ins (lib/outbox.ts, lib/sync.ts) under keys that four routes honour through
  `app.idempotent` (lib/idempotency.ts), and shows conflicts for the person to resolve.
- **Profiles** (ADR-087). A photo is a document a user points at (`users.avatarDocumentId`),
  re-encoded by sharp to a 512px WebP with no metadata, and shown from a signed, day-long address so
  a plain `<img>` can load it. People carry `avatarUrl` wherever the API returns them.
- **Team chat** (ADR-086). `chat_conversations`, `chat_members`, `chat_messages` and their edits.
  A conversation answers to its members only; shared files are documents linked to it and served by
  the chat alone. A trigger announces each message on `hiva_events` (that it arrived, not what it
  says), and the stream passes it to members. Oversight is a permission nobody holds by default,
  given only by `SUPER_ADMIN`; each look is audited with its reason, and a trigger keeps those audit
  rows from being changed or deleted.
- **The guide.** Each page's guide (`GUIDE` in `@hiva/contracts`, ADR-061) is data in both languages.
  The owl reads it as a tour, the guide's search answers from it, and the assistant searches it with
  `search_guide`. Tour steps point at `data-tour` anchors on shared components. A test fails if a
  step names an anchor no page carries, or a route has no section.

## Data model

130 tables. The domain groups:

| Group | Core tables |
|---|---|
| Identity | `organizations`, `departments`, `teams` (within a unit), `users`, `roles`, `permissions`, `sessions` |
| CRM | `companies`, `contacts`, `leads`, `opportunities`, `activities` |
| Commercial | `briefs`, `proposals`, `proposal_versions`, `cost_declarations`, `handoffs` |
| Delivery | `projects`, `execution_authorizations`, `milestones`, `raci_assignments`, `work_orders`, `tasks`, `deliverables` |
| Quality | `qc_reviews`, `revisions` |
| Governance | `change_requests`, `risks`, `issues`, `decisions`, `meetings`, `status_reports` |
| Legal & finance | `contracts`, `amendments`, `invoices`, `payments`, `settlements` |
| Resources | `suppliers`, `supplier_evaluations`, `outsource_requests`, `allocations` |
| Closure | `closure_checklists`, `feedbacks`, `lessons_learned` |
| Engines | `form_definitions`, `form_submissions`, `form_approvals`, `sla_policies`, `sla_clocks` |
| Cross-cutting | `documents`, `comments`, `audit_events`, `state_transitions`, `notifications`, `ai_interactions`, `counters` |
| Sign-in and devices | `user_identities` (Google, Telegram), `login_tickets`, `sessions`, `otp_codes`, `push_subscriptions`, `idempotency_keys` |
| Conversations | `chat_conversations`, `chat_members`, `chat_messages`, `chat_message_edits` (audit F-5); `messenger_links`, `messenger_actions`, `messenger_messages`, `messenger_poll_state` |
| Bookings (audit F-9) | `booking_locations`, `bookable_resources`, `bookings`, `booking_participants`, `booking_resources`, `booking_guests`, `catering_options`, `booking_catering`, `resource_holds`, `person_holds` |

Design rules applied throughout:

- Money is `Decimal(20,2)` — Rial amounts reach billions, and floats are unacceptable for
  contract values.
- Every business record carries a human code (`PRJ-000016`) allocated by an atomic
  `INSERT … ON CONFLICT DO UPDATE … RETURNING`, so concurrent requests never collide.
- Soft delete where history matters; hard delete only where it does not.
- `organizationId` on every tenant-scoped table and in every lookup; one installation may hold
  several organisations (roadmap #50, see Multi-tenancy below).
- Where a clash must be impossible, the database refuses it: two exclusion constraints keep one
  room, piece of equipment or person from being held twice at once (ADR-091).

## Multi-tenancy

Several organisations on one installation (roadmap #50, ADR-064). Each has its own units, users,
rules, forms, SLA policies and records.

- **Scoping.** `organizationId` is on every scoped table, and the data layer applies it to every
  lookup: list, detail, update, delete, workflow transitions, PDF export and AI grounding. Form and
  SLA codes are unique per organisation, so each has the whole catalogue under the same codes. A
  cross-tenant read returns 404 rather than 403, since a 403 would confirm the record exists.
  - `registerCrud` scopes a model by its `organizationId`, or by a `scope` it is given for a model
    reached through a parent. It refuses at boot to register a model with neither (audit SEC-1).
  - Every foreign key a create or update sets must name a record of the caller's organisation,
    checked generically from the schema (`lib/scope.ts`). A record elsewhere answers as one that
    does not exist: `422 UNKNOWN_REFERENCE` (audit SEC-12).
  - A contact carries its company's organisation, and a composite key to `companies(id,
    organizationId)` makes the database refuse any other (ADR-067).
  - `tests/037-tenant-isolation` calls every route as one organisation with another's ids and
    checks that nothing of the other's is read or changed.
- **Resolution.** A signed-in request takes its organisation from its token. An anonymous one
  (sign-in, asking to join, the sign-in page) takes it from the host name in `TENANT_MODE=multi`, or
  is the one organisation in `single`. A person signs in only at their organisation's address or at
  the installation's own.
- **Provisioning.** `cli tenant:create` creates the organisation, brings its reference data up, and
  creates its first administrator, who sets a password from a one-time link. A suspended
  organisation keeps everything but signs nobody in.
- **Shared by design.** Role and permission definitions (each organisation grants its own), the
  record-number sequence, and email uniqueness are shared.

## Upgrades

The reference data is code. On every start the API brings each organisation's reference data up to
it (`src/setup/reference.ts`), in one transaction behind an advisory lock. It never takes back what
an organisation made its own: a form edited in the designer, SLA hours its administrator set. Each
run that changed something is written to `system_upgrades`. `infrastructure/hivamis` installs,
backs up, restores and upgrades a Compose installation.

## Security

| Control | Implementation |
|---|---|
| Password storage | Argon2id, 19 MiB / 2 iterations / 1 lane (OWASP) |
| Session | 15-minute access JWT, held in the page's memory only; opaque refresh token in an `HttpOnly`, `SameSite=Strict` cookie scoped to `/api/v1/auth` (`Secure` in production), spent only by a request carrying `X-Hiva-Refresh: 1` from the app's own origin (audit SEC-4), and stored only as SHA-256 digest; rotated single-use, each rotation carrying its sign-in's `familyId`. Replaying a spent token is treated as theft: every session for that user is revoked and a `REFRESH_TOKEN_REUSE` audit event is written. Every request also checks that what the access token was issued on still stands (audit SEC-3, `auth/standing.ts`): its sign-in has a live row, its holder is active, not deleted and not locked, and its `av` equals the holder's `authVersion`, which a role change, a deactivation, a password change or a delegation's end raises. Otherwise `401 SESSION_REVOKED`, and the client's refresh fails for a session that is over. The check is cached per session for at most five seconds; the process that makes a change forgets its copy at once, so it holds there on the next request and on any other process within the five seconds |
| Brute force | Login and refresh rate limits. Wrong passwords and codes are kept against (what was typed, the client's /24 or /64): three free, then a doubling wait, then that pair blocked for fifteen minutes at ten — never the account, which anyone could otherwise keep locked (audit SEC-10). Fifty failures on one account in an hour raise a security alert. A missing or password-less account still pays for an Argon2 check, so timing does not tell who exists. `TRUST_PROXY` defaults to trusting no proxy, so a forged `X-Forwarded-For` cannot move a client between rate-limit buckets |
| Authorization | 133 permissions across 16 roles (and any an organisation makes, audit F-3), checked per route and again inside the workflow engine. The managing director, deputy, system administrator and account manager hold every permission but `chat.oversight`, fixed — oversight is nobody's until the system administrator gives it (audit F-5); every other role holds what the organisation's administrator granted (`role_grants`, with history), or its default until reviewed (Hivamis task 6). A grant is a new version of the permissions rule set, and an access token is stamped with each of its roles' grant counts: a token whose role was granted anew since is refused with `401 GRANTS_CHANGED`, and the client takes a fresh one at once — a permission taken away stops working on the next request. Doc_H's guards bind every role, full access included |
| Audit | Every consequential mutation writes who / what / when / before / after / why; sensitive fields redacted |
| Injection | Prisma parameterises everything; the two raw queries use bound parameters or a fixed allow-list. Path parameters naming an entity are validated against the declared workflow list before any dynamic delegate lookup |
| State integrity | Each workflow table carries a CHECK constraint pinning `state` to its declared vocabulary, generated from `packages/contracts` by `prisma/generate-state-constraints.mts`. The engine remains the only sanctioned writer; the constraint means a direct UPDATE or a data import cannot introduce an undeclared state either |
| Upload | MIME allow-list verified against the file's magic bytes (the declared Content-Type is client-controlled), size cap, generated storage names, path-traversal check, attachment targets validated against the caller's organisation, `Content-Disposition: attachment` with `nosniff`. SVG is not accepted |
| Transport headers | Helmet on the API; CSP, HSTS-ready headers, `X-Frame-Options: DENY` at nginx |
| Error handling | Internal detail logged, never returned; every response carries a request id. The logs never carry a credential: authorization and cookie headers, webhook signatures, `Set-Cookie`, and any password, code, ticket or token in a body are redacted (`lib/log.ts`, audit SEC-11) |
| Secrets | Environment-only, validated at boot; the process refuses to start on a missing or short `JWT_SECRET`, on a value copied from an example file, and in production on any active demo account (`ALLOW_DEMO_ACCOUNTS=true` overrides, loudly; ADR-068) |

Verified by the security suite in [`apps/api/tests/003-security.test.ts`](../apps/api/tests/003-security.test.ts).

## Observability

- Structured JSON logs (pino) with per-request ids; authorization headers and password fields
  redacted at the logger.
- `/health`, `/health/ready` (checks the database), `/health/live` for orchestrators.
- `state_transitions` is an event log in the process-mining sense (case, activity, timestamp,
  resource), so the process the organisation actually runs is discovered from it and laid
  against the one declared in `WORKFLOWS`: unused declared paths, loops, waiting per state,
  variants, cycle time (`/reports/mining/:entity`, roadmap #1). Cascade-written moves are flagged
  on the row so they can be told from someone acting on the record.
- The rules themselves are versioned by fingerprint at boot (`rule_set_versions`), and every
  transition names the workflow and permission versions that allowed it — ADR-020, roadmap #4.
- `audit_events` and `state_transitions` provide a complete forensic history — and, because
  every mutation carries `before` and `after`, a record can be reconstructed as it stood at any
  instant and diffed between two, field by field, with names on each change (`/history/…`,
  roadmap #3). Financial fields are withheld by the same rule the PDF layer uses; password
  hashes are withheld from everyone.
- `sla_clocks` is an operational signal, not just a report: breaches surface on dashboards and
  in notifications.
- `/reports/data-quality` actively hunts records that would silently break the process —
  an ACTIVE project with no authorization, a task with no source document, a closed project
  with unclear finances.

---

## Testing

- The API suite runs against a real PostgreSQL database, not a mock. `app.inject()` drives it
  in process, so there is no port to bind and no server to start.
- Each test file gets its own schema, cloned from a template migrated and seeded once per run,
  and files run in parallel — see [ADR-017](decisions.md). Two consecutive runs from an empty
  database produce identical results, and any single file passes on its own.
- `HIVA_TEST_ISOLATION=shared` puts every file back on one database, sequentially, and keeps
  what a run creates. Faster for iterating on one file; not what CI runs.
- The frontend suite needs neither a database nor a server: pure logic and small components.
- **What each role sees** (Hivamis task 6) is checked on a running stack by
  `apps/api/scripts/visibility-audit.ts`: it signs in as each demo account, opens every page, first
  record and tab its navigation offers, and lists every call the screen made that the server refused —
  a part shown to someone who may not use it. Run it against a copy of the database with jobs off
  (`AUDIT_API`), since it makes refused requests on purpose; it exits non-zero on any finding or on an
  account it could not check.
