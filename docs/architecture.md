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
- **Entity `state` is written in exactly one place** — `workflow/engine.ts`. The generic CRUD
  factory strips `state` from every PATCH body. This is what makes the Doc_H rules structural.
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
| Styling | Tailwind CSS 4 | Token-driven design system in CSS, no runtime cost, trivially RTL |
| Charts | Recharts | Lazy-loaded on `/reports` only |

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

- **Definitions** (`packages/contracts/src/workflows.ts`) are declarative: 13 state machines,
  every transition naming its permission, guards, mandatory-reason flag and SLA effects.
- **Guards** (`src/workflow/guards.ts`) are the Doc_H rules RBAC cannot express — "a project may
  not activate without an authorization record", "nothing reaches the client without a passing
  Account QC". A blocked guard returns HTTP 422 naming the Doc_H clause, so the UI explains
  *which rule* fired rather than showing a generic failure.
- **Effects** (`src/workflow/effects.ts`) are side effects applied atomically with the state
  change, so timestamps can never drift from the state they describe.

An undeclared transition returns 409 with the list of legal actions.

### 2. Form engine — `src/forms/`

Doc_H specifies 130 forms and, crucially, demands each be a *Data Object*:
`Form → Sender → Receiver → Trigger → Input → Process → Output → Approver → SLA → Next Process`.

Hand-coding 130 screens would be unmaintainable. Instead every form is a row in
`form_definitions` carrying its field schema as JSON. One renderer draws all of them; one
engine routes, validates, approves and SLA-tracks all of them.

Roughly 25 forms are **structural** — they carry a `binding` and drive a first-class domain
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
All 30 policies are transcribed from Doc_H slide 33 and the RACI matrix, each carrying its
`docRef` back to the source.

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
- **Advisory only.** The AI layer holds no write path to business data.

## Data model

59 tables. The domain groups:

| Group | Core tables |
|---|---|
| Identity | `organizations`, `departments`, `users`, `roles`, `permissions`, `sessions` |
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

Design rules applied throughout:

- Money is `Decimal(20,2)` — Rial amounts reach billions, and floats are unacceptable for
  contract values.
- Every business record carries a human code (`PRJ-000016`) allocated by an atomic
  `INSERT … ON CONFLICT DO UPDATE … RETURNING`, so concurrent requests never collide.
- Soft delete where history matters; hard delete only where it does not.
- `organizationId` on every tenant-scoped table — single-organisation today, multi-tenant-ready
  without a migration.

## Multi-tenancy

Deliberately **not** implemented as full SaaS multi-tenancy. Doc_H describes one organisation.
Building tenant provisioning, per-tenant configuration and isolation testing would be complexity
with no current buyer.

What *is* in place: `organizationId` on every scoped table, automatically applied to reads and
writes by the CRUD factory, plus organisation-level calendar, working hours and holidays.
Turning this into multi-tenant SaaS means adding tenant resolution and provisioning — not
reshaping the schema.

## Security

| Control | Implementation |
|---|---|
| Password storage | Argon2id, 19 MiB / 2 iterations / 1 lane (OWASP) |
| Session | 15-minute access JWT; opaque refresh token stored only as SHA-256 digest; rotated single-use. Refresh re-checks that the account is still active, so a deactivated user cannot keep minting access tokens. Replaying a spent token is treated as theft: every session for that user is revoked and a `REFRESH_TOKEN_REUSE` audit event is written. Changing a user's roles revokes their sessions, because permissions are carried in the access token |
| Brute force | Login and refresh rate limits plus account lock after 5 failures. `TRUST_PROXY` defaults to trusting no proxy, so a forged `X-Forwarded-For` cannot move a client between rate-limit buckets |
| Authorization | 103 permissions across 16 roles, checked per route and again inside the workflow engine |
| Audit | Every consequential mutation writes who / what / when / before / after / why; sensitive fields redacted |
| Injection | Prisma parameterises everything; the two raw queries use bound parameters or a fixed allow-list. Path parameters naming an entity are validated against the declared workflow list before any dynamic delegate lookup |
| State integrity | Each workflow table carries a CHECK constraint pinning `state` to its declared vocabulary, generated from `packages/contracts` by `prisma/generate-state-constraints.mts`. The engine remains the only sanctioned writer; the constraint means a direct UPDATE or a data import cannot introduce an undeclared state either |
| Upload | MIME allow-list verified against the file's magic bytes (the declared Content-Type is client-controlled), size cap, generated storage names, path-traversal check, attachment targets validated against the caller's organisation, `Content-Disposition: attachment` with `nosniff`. SVG is not accepted |
| Transport headers | Helmet on the API; CSP, HSTS-ready headers, `X-Frame-Options: DENY` at nginx |
| Error handling | Internal detail logged, never returned; every response carries a request id |
| Secrets | Environment-only, validated at boot; the process refuses to start on a missing or short `JWT_SECRET` |

Verified by the security suite in [`apps/api/tests/003-security.test.ts`](../apps/api/tests/003-security.test.ts).

## Observability

- Structured JSON logs (pino) with per-request ids; authorization headers and password fields
  redacted at the logger.
- `/health`, `/health/ready` (checks the database), `/health/live` for orchestrators.
- `audit_events` and `state_transitions` provide a complete forensic history.
- `sla_clocks` is an operational signal, not just a report: breaches surface on dashboards and
  in notifications.
- `/reports/data-quality` actively hunts records that would silently break the process —
  an ACTIVE project with no authorization, a task with no source document, a closed project
  with unclear finances.
