<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/hiva-logo-white.svg">
    <img src="docs/brand/hiva-logo.svg" alt="Hiva — Branding | Creativity" height="120">
  </picture>
</p>

# هیوامیس (Hivamis) — سیستم‌عامل سازمانی

An enterprise operating platform for the Hiva advertising agency, built directly from the
process documentation in [`Doc_H/`](Doc_H). It unifies CRM, Sales, Account Management, PMO,
Traffic, Creative/Production operations, Quality Control, Proposal & Pricing, Contracts,
Finance and Customer Success into one governed system.

The product thesis is narrow and deliberate: agency tools already do projects, resourcing and
invoicing. **None of them enforce the operating rules an agency actually runs on.** Hivamis makes
those rules structurally impossible to bypass.

---

## What makes this different

Doc_H's `قوانین و دستورالعمل حاکم بر فرآیند اجرای پروژه‌ها` is not documentation here — it is
executable. Fifteen governing rules are enforced by the server on every write:

| Doc_H rule | How it is enforced |
|---|---|
| §2 — Sales / Account separation | Permission model: no sales role holds `pricing.set_price`, `project.authorize`, or `qc.account`; no account role holds `crm.lead.convert` |
| §6 — No valid verbal task | `Task.sourceType` + `sourceRef` are non-null; a task cannot exist without tracing to one of six authorised source documents |
| §8 — Change control | An out-of-scope change cannot reach the customer until all six impact dimensions are recorded, nor be implemented before customer approval |
| §9 — Three-level QC | Each QC level requires a different permission; nothing reaches the client without a passing Account QC |
| §10 — Revision governance | `Revision.reason` is non-null; a failed QC automatically raises a revision carrying its reason |
| §12 — Financial separation | Execution units may declare cost but the sale price needs `pricing.set_price`, and approval needs a *different* person holding `pricing.approve` |
| §13 — Project start authorization | A project cannot go ACTIVE without a live `ExecutionAuthorization` on one of three legal bases |
| §15 — Project closure | Eight closure conditions are checked as a gate, not a checklist |

These are covered by a dedicated suite in [`apps/api/tests/001-governance.test.ts`](apps/api/tests/001-governance.test.ts) — each rule has a test that asserts the system refuses to break it.

---

## Quick start

**Prerequisites:** Node 22+, pnpm 10+, PostgreSQL 17+ running locally.

```bash
pnpm install
createdb hiva_os
cp apps/api/.env.example apps/api/.env
# set DATABASE_URL, and generate a secret: openssl rand -base64 48
pnpm db:migrate
pnpm db:seed
pnpm dev
```

- Web UI — <http://localhost:5173>
- API — <http://localhost:4000>
- Health — <http://localhost:4000/health/ready>

Both must run. The web server proxies `/api` to port 4000; with the API stopped, every request —
signing in included — fails (the proxy answers a bare 500), and the app says «سرور در دسترس نیست».
Start the API again (`pnpm dev`, or `pnpm --filter @hiva/api dev`).

### Development sign-in

The seed creates fifteen demo accounts across every role. They share the password
`Hiva@Dev2026!` and exist **only for local development** — never deploy this seed to production.
A production API refuses to start while any of them is active (see the readiness checklist in
[docs/operations.md](docs/operations.md)).

| Account | Role | Use it to see |
|---|---|---|
| `admin@hiva.local` | System Administrator | Everything, plus the audit trail |
| `ceo@hiva.local` | CEO | Executive control tower |
| `deputy@hiva.local` | Deputy CEO | Project authorization, pricing approval |
| `sales@hiva.local` | Sales Representative | Leads, opportunities, briefs — and the permissions Sales does *not* have |
| `account.manager@hiva.local` | Account Manager | Brief control, proposals, Project 360, QC |
| `creative@hiva.local` | Unit Manager (Creative) | Work orders, unit QC, cost declaration |
| `designer@hiva.local` | Unit Specialist | Task execution and revisions |
| `finance@hiva.local` | Finance Manager | Invoices, payments, settlement |
| `legal@hiva.local` | Legal Manager | Contract lifecycle |
| `pmo@hiva.local` | PMO Manager | Traffic, capacity, lessons learned |

---

## Running with Docker

```bash
infrastructure/hivamis install --org-name "…" --org-slug acme --admin-email you@acme.ir --admin-name "…"
```

The installer generates the secrets, starts the stack and creates the organisation and its first
administrator, who sets a password from a one-time link. The stack serves the SPA on
`http://localhost:8080` with the API proxied at `/api`. On start the API migrates the database and
brings the reference data up to the code. Only the web container publishes a port. `hivamis backup`,
`restore`, `upgrade`, `status` and `tenant` cover the rest; see docs/operations.md.

- **The assistant's model.** `hivamis model auto` chooses it again for the machine (GPU or not, its
  memory) and switches to it. `sudo hivamis prereqs` makes an NVIDIA card reachable to Docker.
- **A clean start.** `hivamis reset --admin EMAIL` empties the organisation but for that system
  administrator, keeping the settings and the history. It takes a backup first and asks for the
  administrator's new password.
- **https.** Run it behind https (`--domain` and a certificate in front): over plain http the
  password travels in the clear.

---

## Repository layout

```
apps/
  api/                 Fastify + Prisma API, workflow engine, form engine, SLA engine, AI layer
    prisma/            Schema, migrations, seed
    src/workflow/      State machines, Doc_H guards, transition effects
    src/forms/         130-form engine, validator, typed bindings
    src/sla/           Business-calendar SLA engine
    src/ai/            Permission-aware, audited AI subsystem
    tests/             Governance, lifecycle, security, engines, PDF export, mail, isolation
  web/                 React 19 + Vite SPA — RTL Persian, Jalali dates
    tests/             Conversion, API client, auth, overlays, theme, locale, help
packages/
  contracts/           Shared source of truth: enums, permissions, workflows, SLA catalogue, 130 forms
infrastructure/
  docker/              Dockerfiles + nginx config
  database/            Backup and restore scripts
docs/                  Architecture, ADRs, API, traceability, operations, user guide
Doc_H/                 The organisation's own process documentation (input, unmodified)
```

---

## Commands

| Command | Purpose |
|---|---|
| `pnpm dev` | Run API and web together |
| `pnpm prepare:code` | Build `@hiva/contracts` and generate the Prisma client — what `dev`, `test` and `typecheck` run first, so a fresh clone works without remembering it |
| `pnpm build` | Type-check and build every package |
| `pnpm test` | Run both test suites — API and frontend |
| `HIVA_TEST_ISOLATION=shared pnpm test` | Run the API suite on one shared database instead of a schema per file — faster inner loop, keeps the rows a run creates |
| `pnpm typecheck` | Type-check without emitting |
| `pnpm bench` | Load-test the heaviest endpoints — see [docs/performance.md](docs/performance.md) |
| `pnpm db:migrate` | Create and apply a migration |
| `pnpm db:seed` | Load reference data + demo dataset (idempotent) |

---

## Documentation

| Document | Contents |
|---|---|
| [Architecture](docs/architecture.md) | System design, data model, engines, security model |
| [Decisions](docs/decisions.md) | Architecture Decision Records with alternatives and trade-offs |
| [Business processes](docs/business-processes.md) | The Doc_H lifecycle as implemented, with state machines |
| [Requirements traceability](docs/traceability.md) | Every Doc_H requirement → code → test |
| [API reference](docs/api.md) | Endpoints, auth, errors, conventions |
| [Operations](docs/operations.md) | Deployment, backup, monitoring, troubleshooting |
| [PDF export](docs/pdf-export.md) | Document PDFs and who may export them (خروجی PDF اسناد و ترتیب دسترسی) |
| [User guide](docs/user-guide.md) · [راهنمای کاربر](docs/user-guide.fa.md) | Per-role walkthrough of daily work, in English and Persian |
| [Audit of October 2026](docs/audit-2026-10.md) | Every audit item: status, commit and the test that proves it |
| [گزارش نهایی ایرادها](docs/bug-report.fa.md) | Every bug found and fixed since task 10, by category, in Persian |
| [Telegram integration](docs/telegram-integration.md) | The meeting platform brought into Hivamis, and why that way |
| [Market analysis](docs/market-analysis.md) | Competitive benchmark and the gap this fills |

---

## Status

Implemented and verified: the full Doc_H lifecycle from Lead through Closure and back into
Cross-sell, all 130 forms, the workflow/SLA/form engines, three-level QC, change control,
contract and finance flows, Customer 360, Project 360, the traffic board, six report surfaces,
the audited AI layer, and RBAC with an immutable audit trail.

The fifty capabilities of [the roadmap](docs/roadmap.md) are built. After them, the October 2026
audit's defects were fixed and nine capabilities added ([audit record](docs/audit-2026-10.md)):

- an AI assistant that runs inside the installation;
- writing and pictures for every role;
- roles and positions the administrator manages;
- speaking to the assistant, with confirm-before-act;
- team chat with disclosed oversight;
- profile photos;
- working offline;
- installing on every platform;
- meeting bookings, with the Telegram Mini App, the bot and reception.

See [Known limitations](docs/operations.md#known-limitations) for what is deliberately out of scope.
