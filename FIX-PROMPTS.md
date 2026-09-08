# Hiva OS — Remediation Prompts for Claude Code

> **راهنما:** هر بخش زیر یک پرامپت مستقل و کامل است. آن را عیناً در Claude Code (در ریشهٔ مخزن `CRM_H`) پیست کنید. پرامپت‌ها به ترتیب اولویت چیده شده‌اند و هرکدام خودکفاست — Claude Code هر بار از صفر شروع می‌کند، پس چیزی را از پرامپت حذف نکنید.
>
> **پیشنهاد:** قبل از شروع، یک برنچ بسازید: `git checkout -b fix/review-2026-09`. پس از هر پرامپت، `pnpm typecheck && pnpm test` بگیرید و کامیت کنید.

---

## Global preamble (optional — paste once at the start of a session)

```
You are working on Hiva OS, a governance-enforcing enterprise operating platform for an
advertising agency. It is a pnpm monorepo:

  apps/api          Fastify 5 + Prisma 6 + PostgreSQL 17 (ESM, Node 22, strict TypeScript)
  apps/web          React 19 + Vite 6 + Tailwind 4, Persian RTL SPA
  packages/contracts Shared source of truth: enums, permissions, 13 state machines, 30 SLA
                     policies, 130 form definitions. Imported by BOTH api and web.
  Doc_H/            The organisation's own process documents (INPUT — never modify these)
  docs/             architecture.md, decisions.md (ADRs), traceability.md, operations.md,
                    api.md, pdf-export.md, business-processes.md, user-guide.md

Non-negotiable project invariants — respect them in every change:
  1. Entity `state` is written ONLY by apps/api/src/workflow/engine.ts (`transition()`).
     The generic CRUD factory strips `state` from PATCH bodies. Never add a new write path.
  2. Doc_H governance rules are enforced as named guards in apps/api/src/workflow/guards.ts.
     A blocked guard returns HTTP 422 with `details.rule` naming the Doc_H clause, and a
     Persian user-facing message.
  3. All user-facing strings are Persian. Error messages use the AppError helpers in
     apps/api/src/lib/errors.ts (which carry `messageFa`).
  4. Enums, permissions, state machines and SLA policies live in packages/contracts and are
     imported — never duplicated — by api and web.
  5. Every consequential mutation writes an AuditEvent via apps/api/src/lib/audit.ts, inside
     the same transaction as the mutation.
  6. Comments explain WHY, in the existing terse style. Do not add banner comments or
     restate what the code does.

House rules for your changes:
  - TypeScript strict; `pnpm -r typecheck` must pass with zero errors.
  - Do not introduce new runtime dependencies without saying so explicitly and justifying it.
  - Do not reformat or "tidy" code you were not asked to change; keep diffs minimal.
  - When you change behaviour that a doc describes, update that doc in the same change.
  - Add or extend tests in apps/api/tests/ for every behavioural change.
```

---

# PRIORITY 1 — Must fix before any real deployment

---

## Prompt 1 — Chromium is missing from the API Docker image, so all PDF export returns 503

```
TASK: Make PDF export actually work in the Docker deployment, and align the documentation
with the Dockerfile that actually ships.

CONTEXT / EVIDENCE:
- apps/api/src/pdf/renderer.ts launches Chromium via playwright-core. `resolveExecutable()`
  checks, in order: $PDF_BROWSER_PATH, the Playwright browser cache, then a small list of
  system paths (/usr/bin/chromium, /usr/bin/chromium-browser, /usr/bin/google-chrome,
  the macOS Chrome path).
- infrastructure/docker/Dockerfile.api builds on `node:22-alpine` for both build and runtime
  stages and installs only `tini` and `curl`. No Chromium is present anywhere in the image,
  and `PDF_BROWSER_PATH` is not set in docker-compose.yml.
- Result: in the deployment that README.md and docs/operations.md recommend, every
  /api/v1/pdf/* route fails with 503 PDF_ENGINE_UNAVAILABLE. This is a headline feature
  (ADR-014, docs/pdf-export.md) that is dead on arrival in Docker.
- docs/pdf-export.md, section "در Docker", gives a Debian recipe:
      RUN apt-get update && apt-get install -y chromium fonts-liberation
      ENV PDF_BROWSER_PATH=/usr/bin/chromium
  That recipe cannot run on the Alpine image the repo actually builds.

WHAT TO DO:
1. Fix infrastructure/docker/Dockerfile.api so the runtime stage has a working Chromium.
   Pick ONE of these and state which you chose and why in your summary:
     (a) Stay on Alpine and add the chromium package plus its required libs:
         apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont
         then ENV PDF_BROWSER_PATH=/usr/bin/chromium
     (b) Switch the runtime stage to node:22-bookworm-slim and apt-get install chromium.
   Note: no Persian font needs to be installed — Vazirmatn is embedded as base64 by
   apps/api/src/pdf/renderer.ts. Do NOT add font packages beyond what Chromium needs to start.
2. Set PDF_BROWSER_PATH explicitly in the image (ENV) so resolution never depends on a
   filesystem probe.
3. Add PDF_BROWSER_PATH to:
     - apps/api/src/env.ts  (optional string, no default — the resolver already handles absent)
     - apps/api/.env.example
     - .env.docker.example
     - docker-compose.yml (api service environment, pass-through with a sensible default)
     - the environment-variable table in docs/operations.md
4. Rewrite the "در Docker" section of docs/pdf-export.md so it matches the Dockerfile you
   actually produced. Do not leave a recipe for a base image the repo does not use.
5. Verify the image builds: `docker build -f infrastructure/docker/Dockerfile.api -t hiva-api:test .`
   Report the final image size delta.

ACCEPTANCE CRITERIA:
- `docker build -f infrastructure/docker/Dockerfile.api .` succeeds.
- `docker run --rm --entrypoint sh hiva-api:test -c '$PDF_BROWSER_PATH --version'` prints a
  Chromium version.
- docs/pdf-export.md's Docker section is copy-pasteable against the real Dockerfile.
- No change to apps/api/src/pdf/* logic is required; if you think it is, explain why first.
```

---

## Prompt 2 — Close the three violations of the "single write path for state" invariant

```
TASK: Three code paths write an entity's `state` column outside workflow/engine.ts, which
breaks the invariant that README.md and docs/decisions.md (ADR-002) present as the core
value of this system. Close all three.

CONTEXT / EVIDENCE — the three violations:

(A) apps/api/src/routes/crm.ts, POST /leads/:id/convert (around line 123):
      await tx.lead.update({ where: { id }, data: { state: 'CONVERTED', companyId } });
    The route checks the `crm.lead.convert` permission but NOT the state precondition.
    packages/contracts/src/workflows.ts declares:
      { from: ['QUALIFIED'], to: 'CONVERTED', action: 'convert', permission: 'crm.lead.convert' }
    So a lead in state NEW or CONTACTED can be converted directly, skipping the declared
    lifecycle. This is a real behavioural bug, not just an architectural smell.

(B) apps/api/src/routes/quality.ts, POST /qc-reviews (around line 102):
      await tx.deliverable.update({ where: { id }, data: { state: 'REVISION_REQUIRED' } });
    Runs on a FAILED verdict, from ANY current deliverable state, with no guard and — most
    importantly — WITHOUT creating a StateTransition row. The change is invisible in the
    deliverable's own state history, which undermines Doc_H §7 (single source of truth).

(C) apps/api/src/workflow/effects.ts, lines ~30 and ~38 ('brief.return_incomplete' and
    'brief.approve'):
      await tx.opportunity.update({ where: { id }, data: { state: 'BRIEF_REQUESTED' } });
      await tx.opportunity.update({ where: { id }, data: { state: 'BRIEF_COMPLETED' } });
    A cascade from the brief lifecycle onto the opportunity lifecycle. Arguably intended,
    but it produces no StateTransition row for the opportunity, so the opportunity's history
    has silent gaps.

WHAT TO DO:

For (A):
  Route the conversion through the workflow engine. The cleanest shape: keep the route (it
  also creates the Company and Opportunity), but before mutating the lead, validate the
  declared transition — reuse `findTransition('lead', lead.state, 'convert')` from
  @hiva/contracts and reject with the same 409 ILLEGAL_TRANSITION shape the engine produces
  (including `details.allowed` from `availableTransitions`). Better still, if you can do it
  without breaking the atomic creation of company+opportunity, call `transition()` itself.
  Explain your choice.
  The existing "ALREADY_CONVERTED" 400 must keep working (or be subsumed by the 409).

For (B):
  Do not set the state inline. Either:
    - call the declared deliverable transition that moves it to REVISION_REQUIRED through
      the engine (check packages/contracts/src/workflows.ts DELIVERABLE_WORKFLOW for the
      action name and its `from` states), or
    - if the QC route legitimately needs to force the state from several origins, add the
      missing transition to the workflow definition rather than bypassing it.
  Either way a StateTransition row MUST be written, with actorId and a reason referencing
  the QC review code.

For (C):
  Introduce a small helper in apps/api/src/workflow/engine.ts — e.g.
  `cascadeState(tx, entity, id, toState, { action, actorId, organizationId, reason })` —
  that writes the state AND the StateTransition row AND an AuditEvent, and use it from
  effects.ts. Do NOT run guards or permission checks for a cascade (that is the point of a
  cascade), but DO make it traceable and DO make it the only sanctioned way to cascade.

FINALLY:
  Update docs/decisions.md ADR-002 to state precisely what the invariant is after your
  change: engine-only for user-initiated transitions, plus an explicit, audited cascade
  mechanism. Do not leave the ADR claiming something the code does not do.

ACCEPTANCE CRITERIA / TESTS (add to apps/api/tests/):
- Converting a lead in state NEW returns 409 ILLEGAL_TRANSITION with `details.allowed`.
- Converting a lead in state QUALIFIED still succeeds and still creates the opportunity.
- A FAILED QC on a deliverable produces exactly one new StateTransition row for that
  deliverable, with the correct fromState/toState and a non-null actorId.
- Approving a brief produces a StateTransition row for the OPPORTUNITY as well as the brief.
- `pnpm -r typecheck` clean; existing 133 tests still pass.
```

---

## Prompt 3 — `trustProxy: true` lets a client spoof its IP and bypass the login rate limit

```
TASK: Restrict Fastify's proxy trust so X-Forwarded-For cannot be forged by clients.

CONTEXT / EVIDENCE:
- apps/api/src/app.ts sets `trustProxy: true` unconditionally on the Fastify instance.
  With that setting, Fastify derives `req.ip` from the client-supplied X-Forwarded-For
  header with no restriction on who may set it.
- apps/api/src/routes/auth.ts rate-limits POST /auth/login by IP
  (`config: { rateLimit: { max: env.LOGIN_RATE_LIMIT_MAX, timeWindow: '1 minute' } }`), and
  the global limiter in app.ts also falls back to `req.ip`.
- Consequence: an attacker rotating a forged X-Forwarded-For value defeats both the 10/min
  login limit and the 300/min global limit. The per-account lockout after 5 failures still
  applies, but the first line of defence is gone.
- In the shipped topology the only legitimate proxy is the `web` nginx container
  (infrastructure/docker/nginx.conf sets X-Real-IP and X-Forwarded-For).

WHAT TO DO:
1. Replace `trustProxy: true` with a value that reflects the real topology. Prefer a new,
   validated environment variable, e.g. TRUST_PROXY, added to apps/api/src/env.ts:
     - accepted values: `false` (default), a hop count (e.g. `1`), or a comma-separated list
       of CIDRs/IPs.
     - Parse it into the shape Fastify's `trustProxy` option accepts.
   Default MUST be safe (`false`) so a misconfigured deployment fails closed, not open.
2. Set TRUST_PROXY for the api service in docker-compose.yml to match the compose network
   (a hop count of 1 is correct there — nginx is the only proxy). Document why.
3. Add TRUST_PROXY to apps/api/.env.example, .env.docker.example and the environment table
   in docs/operations.md.
4. While you are in apps/api/src/app.ts, fix a related defect: the global rate limiter's
   keyGenerator is
       keyGenerator: (req) => (req as any).user?.sub ?? req.ip
   but @fastify/rate-limit runs in the `onRequest` phase while authentication runs in
   `preHandler`, so `req.user` is ALWAYS undefined there and the per-user branch is dead
   code. Either move authentication earlier for authenticated routes, or delete the dead
   branch and key purely on IP — and say in a comment which you did and why. Do not leave
   code that pretends to do something it cannot.

ACCEPTANCE CRITERIA:
- With TRUST_PROXY unset, a request carrying `X-Forwarded-For: 1.2.3.4` does NOT change the
  rate-limit bucket. Add a test in apps/api/tests/003-security.test.ts that proves this:
  send LOGIN_RATE_LIMIT_MAX+1 failed logins with a rotating forged X-Forwarded-For and
  assert a 429 is eventually returned.
- `pnpm -r typecheck` clean.
```

---

## Prompt 4 — Unauthorised information disclosure on the workflow routes

```
TASK: Add authorization to the workflow read routes and validate the `entity` path parameter.

CONTEXT / EVIDENCE — apps/api/src/routes/workflow.ts:
1. `GET /workflow/:entity/:id/history` has `preHandler: [app.authenticate]` only — NO
   permission check. Any authenticated user (including a UNIT_MEMBER designer) can read the
   full state history of ANY record, including the free-text `reason` field. Reasons carry
   things like why a proposal was rejected, why an opportunity was lost, and why a brief was
   returned. This directly defeats the Sales/Account separation that Doc_H §2 and
   packages/contracts/src/permissions.ts are built to enforce.
2. `GET /workflow/:entity/:id/available` has the same gap, and additionally does:
       await (prisma as any)[entity]?.findUnique?.({ where: { id }, select: { state: true } })
   with `entity` taken straight from the URL. Unvalidated dynamic property access on the
   Prisma client.
3. `POST /workflow/:entity/:id/transitions` has no route-level permission. Per-transition
   permission IS enforced inside `transition()` via `def.permission`, which is correct —
   but any transition declared WITHOUT a `permission` field is open to every authenticated
   user. Audit packages/contracts/src/workflows.ts for such transitions.

WHAT TO DO:
1. Build a single authoritative mapping from workflow entity key -> required read
   permission. Put it in packages/contracts (next to WORKFLOWS) so api and web share it,
   e.g. `WORKFLOW_READ_PERMISSION: Record<string, Permission>`. Cover all 13 entities:
   lead, opportunity, brief, proposal, project, workOrder, task, deliverable, revision,
   changeRequest, contract, invoice, outsourceRequest.
2. Apply that permission to `/history` and `/available`. Return 403 with the standard
   Persian forbidden message; the denial must be audited (app.requirePermissions already
   audits — use it rather than hand-rolling the check).
3. Validate `:entity` against `Object.keys(WORKFLOWS)` before any Prisma access, in ALL
   three routes. An unknown entity must return the existing 400 UNKNOWN_ENTITY AppError,
   never reach `(prisma as any)[entity]`.
4. Replace `(prisma as any)[entity]` in `/available` with the same explicit delegate map
   that `apps/api/src/workflow/engine.ts` already has in its `delegate()` function. Export
   and reuse it rather than duplicating the map.
5. Scan packages/contracts/src/workflows.ts for any TransitionDef without a `permission`.
   List them in your summary. For each, either add the correct permission or explain in a
   code comment why it is deliberately unrestricted.

ACCEPTANCE CRITERIA / TESTS (apps/api/tests/003-security.test.ts):
- A designer (UNIT_MEMBER, `designer@hiva.local`) gets 403 on
  `GET /workflow/opportunity/:id/history` and on `/available`.
- An account manager still gets 200 on the same routes.
- `GET /workflow/user/:id/history` returns 400 UNKNOWN_ENTITY, not 500.
- `pnpm -r typecheck` clean.
```

---

## Prompt 5 — Session management: refresh does not re-check the user, no reuse detection, role change does not revoke

```
TASK: Close four session-lifecycle gaps in apps/api/src/routes/auth.ts and
apps/api/src/routes/admin.ts.

CONTEXT / EVIDENCE:

(1) POST /auth/refresh calls `claimsFor(session.userId)` which loads the user and builds
    fresh claims, but it NEVER checks `user.isActive` or `user.deletedAt`. A deactivated or
    soft-deleted user whose sessions were not explicitly revoked keeps minting valid access
    tokens for up to REFRESH_TOKEN_TTL (default 7 days). POST /auth/login does check these
    (`if (!user || !user.isActive || user.deletedAt) return fail(...)`), so the two paths
    disagree.

(2) Refresh-token rotation has no reuse detection. Presenting an already-revoked refresh
    token returns 401 and nothing else happens. If a token is stolen, attacker and victim
    can both keep rotating in parallel indefinitely. The standard mitigation (OAuth 2.1
    BCP) is: on presentation of a revoked-but-known token, revoke the entire session family
    for that user and force re-authentication.

(3) PATCH /users/:id in apps/api/src/routes/admin.ts can replace a user's roles
    (`tx.userRole.deleteMany` + `createMany`) but does NOT revoke their sessions. Because
    permissions are baked into the 15-minute access JWT, a demoted user keeps the old
    permission set for up to 15 minutes. For privilege REMOVAL that window is too long.
    Note the correct precedent already in the codebase: POST /auth/change-password and
    POST /users/:id/deactivate both revoke sessions.

(4) POST /auth/refresh has no dedicated rate limit, unlike /auth/login.

WHAT TO DO:
1. In /auth/refresh, after loading the session, load the user and reject with 401 (Persian
   message: session invalid, sign in again) if `!user.isActive || user.deletedAt`. Also
   revoke the presented session in that case.
2. Add reuse detection. The Session model already has `revokedAt`. On refresh:
     - If the hash matches a session that is ALREADY revoked, treat it as a compromise
       signal: revoke every non-revoked session for that userId, write an AuditEvent with
       action 'REFRESH_TOKEN_REUSE' (entityType 'user'), and return 401.
     - Keep the existing behaviour for expired-but-not-revoked sessions.
   Consider whether you need a `familyId`/`replacedById` column to distinguish "a token from
   this device's chain" from "an unrelated old token" — if you add a column, add a Prisma
   migration and explain the trade-off. A simpler userId-wide revocation is acceptable for
   this scale; if you choose it, say so.
3. In PATCH /users/:id, when `input.roleCodes` is provided AND the resulting role set
   differs from the current one, revoke all that user's active sessions inside the same
   transaction, and record the reason in the AuditEvent.
4. Add a rate limit to POST /auth/refresh (reuse LOGIN_RATE_LIMIT_MAX or add a new env var;
   pick one and justify).

ACCEPTANCE CRITERIA / TESTS (apps/api/tests/003-security.test.ts):
- Deactivating a user and then presenting a refresh token issued before deactivation
  returns 401.
- Presenting a refresh token twice: the second presentation returns 401 AND every other
  session for that user is revoked AND an AuditEvent with action 'REFRESH_TOKEN_REUSE'
  exists.
- Changing a user's roles revokes their sessions.
- `pnpm -r typecheck` clean; do not break the existing "rotates the refresh token and
  invalidates the presented one" test.
```

---

## Prompt 6 — Self-host the Vazirmatn font; stop depending on Google Fonts

```
TASK: Serve the Persian UI font from the application itself instead of fonts.googleapis.com,
and tighten the CSP accordingly.

CONTEXT / EVIDENCE:
- apps/web/index.html loads Vazirmatn from https://fonts.googleapis.com with preconnect to
  fonts.gstatic.com.
- infrastructure/docker/nginx.conf widens the CSP specifically for this:
    style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
    font-src 'self' https://fonts.gstatic.com;
- apps/web/src/index.css sets `--font-sans: 'Vazirmatn', system-ui, ...`.
- This deployment targets an Iranian organisation. Google Fonts is frequently unreachable
  there and is unavailable in any air-gapped/on-prem install. When it fails, the ENTIRE UI
  silently falls back to a system font and Persian typography degrades badly.
- The project already solves this correctly on the server side: apps/api/src/pdf/assets/
  contains Vazirmatn-Regular.woff2 and Vazirmatn-Bold.woff2 (plus OFL.txt) and
  apps/api/src/pdf/renderer.ts embeds them as base64 so PDFs render identically on a host
  with no Persian fonts. The web app should be equally self-contained.

WHAT TO DO:
1. Copy Vazirmatn-Regular.woff2 and Vazirmatn-Bold.woff2 from apps/api/src/pdf/assets/ into
   apps/web/public/fonts/ (or apps/web/src/assets/fonts/ if you prefer Vite to hash them —
   pick one and justify; `public/` is simpler and gives a stable path). Copy OFL.txt
   alongside them — the font is OFL-licensed and the licence must ship with the files.
2. Add @font-face declarations to apps/web/src/index.css for weight 400 and 700, with
   `font-display: swap` and `unicode-range` left unset (Persian needs the full face).
   Keep the existing `--font-sans` fallback chain.
3. Remove the three <link> tags for Google Fonts from apps/web/index.html. Add a
   `<link rel="preload" as="font" type="font/woff2" crossorigin>` for the regular face so
   first paint does not flash.
4. Tighten infrastructure/docker/nginx.conf CSP: drop
   `https://fonts.googleapis.com` from style-src and `https://fonts.gstatic.com` from
   font-src. Update the comment above the CSP line, which currently says Google Fonts is the
   only permitted external origin — after this change there is no permitted external origin.
5. Check the repo for any other reference to fonts.googleapis.com or fonts.gstatic.com and
   remove it.

CONSTRAINTS:
- Do NOT add a font npm package. Reuse the .woff2 files already in the repo.
- Only the two weights the app actually uses (400, 700). The current Google Fonts URL
  requests 300;400;500;600;700 — verify against apps/web/src which weights are really used
  (grep for font-medium / font-semibold / font-bold in Tailwind classes) and ship only
  those. Report what you found.

ACCEPTANCE CRITERIA:
- `pnpm --filter @hiva/web build` succeeds and the built dist/ contains the woff2 files.
- No network request to any *.google.com / *.gstatic.com origin remains in the built app.
- The CSP in nginx.conf has no external origins.
```

---

## Prompt 7 — Make demo-account teardown a hard deployment gate

```
TASK: Make it structurally difficult to run this system in production with the seeded demo
accounts still active.

CONTEXT / EVIDENCE:
- apps/api/prisma/seed.ts creates fifteen demo users across every role, all sharing the
  password `Hiva@Dev2026!`, which is PUBLISHED in README.md.
- docs/operations.md says "In production, run the seed but do not keep the demo accounts"
  — prose only. Nothing in the code enforces it.
- The seed is idempotent and skips demo data if customers already exist, so a production
  operator who seeds once has fifteen live accounts with a public password.

WHAT TO DO:
1. In apps/api/prisma/seed.ts, split the seed into two clearly separated phases:
     - reference data (organisation, departments, roles, permissions, 30 SLA policies,
       130 form definitions) — always safe to run;
     - demo data (demo users, demo customers, demo projects) — development only.
   Gate the demo phase behind an explicit opt-in: run it only when
   `NODE_ENV !== 'production'` AND an env flag such as `SEED_DEMO_DATA=true` is set.
   In production, print a clear Persian+English notice that demo data was skipped.
2. Add a startup guard in apps/api/src/server.ts (or app.ts): when `NODE_ENV === 'production'`,
   query for users whose passwordHash verifies against the published demo password, or more
   cheaply, for users with the `@hiva.local` email domain that are still `isActive`. If any
   exist, log a `fatal`-level warning naming them. Decide — and justify — whether this
   should refuse to start or only warn loudly. (Recommendation: warn loudly at first boot,
   and expose the count on GET /health/ready as a non-blocking field, so monitoring can
   alert on it. Refusing to start is defensible too; say which you chose.)
3. Add a "Production readiness checklist" section to docs/operations.md with hard,
   checkable items: demo accounts deactivated, JWT_SECRET rotated from any example value,
   CORS_ORIGIN set to the real origin, TLS terminated upstream, backup script scheduled AND
   a restore rehearsed. Reference the specific commands.
4. Add SEED_DEMO_DATA to .env.example, .env.docker.example and the env table in
   docs/operations.md.

ACCEPTANCE CRITERIA:
- `NODE_ENV=production pnpm db:seed` loads reference data and creates zero demo users.
- The existing test suite, which depends on the demo users, still passes (it runs with
  NODE_ENV=test — make sure your gate allows that path; see apps/api/tests/global-setup.ts).
- `pnpm -r typecheck` clean.
```

---

# PRIORITY 2 — Within the next few weeks

---

## Prompt 8 — Jalali date input (the biggest UX defect in the product)

```
TASK: Let users ENTER dates in the Jalali (Solar Hijri) calendar, matching how every date is
already DISPLAYED.

CONTEXT / EVIDENCE:
- docs/decisions.md ADR-009 commits the product to "Persian-first, RTL-first, Jalali dates".
- Display honours that: apps/web/src/lib/format.ts uses
  `new Intl.DateTimeFormat('fa-IR-u-ca-persian', ...)` for formatDate / formatDateLong /
  formatDateTime, and the server mirrors it in apps/api/src/pdf/fmt.ts.
- Input does NOT: apps/web/src/pages/Forms.tsx (around line 290) renders
      <Input type={field.type === 'date' ? 'date' : 'datetime-local'} ... />
  i.e. the browser's native picker, which is Gregorian in practice. The same happens for
  table columns (around line 411).
- So a user reads "مهلت: ۱۴۰۵/۰۶/۳۱" and must type 2026-09-22. These fields are the ones
  filled in every day (deadlines, committed dates, milestones) and they feed the SLA engine.
- apps/web/src/lib/format.ts already has a stub for the return trip:
      export const toIso = (value: string): string | undefined =>
        value ? new Date(value).toISOString() : undefined;

WHAT TO DO:
1. Build a `JalaliDateInput` component in apps/web/src/components/ (next to ui.tsx, or
   inside it if it fits the file's conventions) that:
     - displays and accepts Jalali dates with Persian digits;
     - emits an ISO-8601 UTC string on change, so no API contract changes;
     - supports both `date` and `datetime` modes;
     - is keyboard-accessible and RTL-correct;
     - degrades gracefully: typing a Jalali date by hand must work, not only picking.
   For the calendar arithmetic, prefer `Intl.DateTimeFormat`/`Temporal`-free conversion
   using the existing `fa-IR-u-ca-persian` locale where possible. If you conclude a small
   dependency is genuinely warranted, propose ONE (e.g. `date-fns-jalali`), state its size
   and licence, and WAIT for approval before adding it — do not add it unilaterally.
2. Replace the native inputs in apps/web/src/pages/Forms.tsx (both the field renderer and
   the table-column renderer) with the new component.
3. Grep apps/web/src/pages/ for every other date entry point (filters, modals, project
   planning, milestones) and convert them too. List what you changed.
4. Add unit tests for the conversion in both directions, including edge cases: the Jalali
   leap year, the 31st of a 31-day Jalali month, and a date that crosses midnight when
   converted to UTC from Asia/Tehran.

CONSTRAINTS:
- The wire format stays ISO-8601 UTC. Do not change any Zod schema in packages/contracts.
- Do not touch apps/api. This is a presentation-layer fix.
- Persian digits on display; accept both Persian and Latin digits on input.

ACCEPTANCE CRITERIA:
- Every date field in the SPA shows and accepts Jalali.
- `pnpm --filter @hiva/web typecheck` clean.
- The value posted to the API for a given picked day is identical to what the old Gregorian
  input produced for the same real-world day.
```

---

## Prompt 9 — The SLA engine ignores the break hour and warns on wall-clock time

```
TASK: Fix two arithmetic defects in the SLA engine that make deadlines and warnings wrong.

CONTEXT / EVIDENCE:

DEFECT 1 — the break hour is defined but never subtracted.
  apps/api/src/lib/business-calendar.ts:
    - `hoursPerDay(cal)` returns `cal.endHour - cal.startHour - cal.breakHours` = 9 - 1 = 8.
    - packages/contracts/src/sla.ts declares `const D = 8; // one business day = 8 working hours`
      and BUSINESS_CALENDAR.hoursPerDay likewise subtracts breakHours.
    - BUT `addBusinessHours()` computes `availableToday` as
        (endOfDay - cursor) / 3_600_000
      i.e. the full 09:00–18:00 span (9 hours), never subtracting breakHours.
    - `businessHoursBetween()` has the same omission.
  Consequence: a "1 working day" (8h) SLA started at 09:00 is due at 17:00 the SAME day
  instead of 09:00 the next working day. Error compounds on multi-day policies
  (SLA_CONTRACT_DRAFT = 3*D, SLA_FEEDBACK = 7*D).

DEFECT 2 — the AT_RISK threshold is computed on wall-clock time.
  apps/api/src/sla/engine.ts, tickSlaClocks():
      const totalMs   = clock.dueAt.getTime() - clock.startedAt.getTime();
      const elapsedMs = now.getTime() - clock.startedAt.getTime();
      const ratio     = totalMs > 0 ? elapsedMs / totalMs : 1;
  Both are calendar durations. A clock started Wednesday 17:00 with a 4-working-hour policy
  is due Saturday 11:00; by Thursday noon `ratio` already exceeds warnAt (0.75) and the
  owner is told "the deadline is nearly up" — during the Thursday/Friday Iranian weekend,
  when zero working hours have been consumed. False SLA alarms train users to ignore all
  SLA alarms, which is worse than having none.

WHAT TO DO:
1. Decide and document the break-hour semantics. The simplest defensible model, consistent
   with the declared `D = 8`: treat a working day as `endHour - startHour - breakHours`
   productive hours, distributed by subtracting the break from each full day consumed.
   Implement it in BOTH `addBusinessHours()` and `businessHoursBetween()` so they are exact
   inverses. Add a comment stating the model.
   If you believe modelling an explicit break WINDOW (e.g. 13:00–14:00) is better, propose
   it with the schema change it needs (Organization currently stores only `breakHours` as a
   count) and WAIT for approval before implementing.
2. Replace the wall-clock ratio in tickSlaClocks() with business-hours arithmetic: compute
   consumed working hours with `businessHoursBetween(clock.startedAt, now, cal)` and compare
   against `Number(clock.policy.hours)`. Load the calendar via the existing
   `loadCalendar(organizationId)`.
   Note: tickSlaClocks currently queries clocks across all organisations with no calendar
   lookup at all — fix that too (see Prompt 15 on the calendar cache; you may need to load a
   calendar per organizationId).
3. Also fix the N+1 in tickSlaClocks: it issues one `prisma.slaClock.update` per clock in a
   loop. Batch the state changes with `updateMany` grouped by target state, keeping the
   per-clock notification.
4. Extend the calendar tests. docs/decisions.md ADR-005 claims "Verified by five calendar
   tests including the Thursday–Friday Iranian weekend" — extend apps/api/tests/
   004-engines.test.ts with:
     - 8 working hours from Saturday 09:00 lands on Sunday 09:00 (not Saturday 17:00);
     - 4 working hours from Wednesday 17:00 lands on Saturday 11:00;
     - a clock spanning the weekend does NOT become AT_RISK during the weekend;
     - addBusinessHours and businessHoursBetween round-trip for a range of durations;
     - a declared holiday is skipped.

ACCEPTANCE CRITERIA:
- All 30 SLA policies in packages/contracts/src/sla.ts produce due dates consistent with
  their `docRef` prose (e.g. "حداکثر ۱ روز کاری" = next working day at the same time).
- `pnpm -r typecheck` clean; existing tests updated, not deleted, where the old expectation
  encoded the bug. Call out any test whose expectation you had to change.
```

---

## Prompt 10 — `/reports/executive` loads whole tables into memory and is quadratic

```
TASK: Move the executive dashboard's aggregation from Node into PostgreSQL.

CONTEXT / EVIDENCE — apps/api/src/routes/reports.ts, GET /reports/executive:
- It issues 13 parallel queries, of which EIGHT are unbounded `findMany` with no `take`:
  projects (with company include), opportunities, invoices, costDeclarations (with workOrder
  include), tasks, changeRequests, risks, revisions, feedbacks. Every row of every one of
  those tables is loaded into Node's heap on each request.
- It then aggregates in JavaScript, and `projectHealth` runs
      projects.filter(...).map(p => { const pTasks = tasks.filter(t => t.projectId === p.id); ... })
  which is O(projects × tasks). At 200 projects and 20,000 tasks that is 4,000,000
  comparisons per dashboard load, on top of the memory cost.
- docs/operations.md "Known limitations" already admits no load testing has been done. This
  endpoint is where it will fail first, and it is the CEO's landing page.

WHAT TO DO:
1. Rewrite the aggregation using database-side computation. Prefer, in order:
     a. `prisma.<model>.groupBy` / `aggregate` / `count` with `where` filters, for the
        scalar KPIs (pipeline value, win rate, invoiced/received totals, counts by state);
     b. a small number of `prisma.$queryRaw` statements with BOUND PARAMETERS for the
        per-project health roll-up (cost per project, late-task count per project). Bound
        parameters only — the repo's stated injection posture (docs/architecture.md) is that
        raw queries use bound parameters or a fixed allow-list. Honour that.
2. Keep the response JSON shape byte-identical. apps/web/src/pages/Reports.tsx consumes it;
   do not force a frontend change. If you find a field that is genuinely impossible to
   compute in SQL, say so before changing the contract.
3. Preserve the existing permission behaviour: the `finance` block is returned only when the
   caller holds `finance.read` (currently an in-handler check). Do not compute the finance
   aggregates at all when the caller lacks the permission — that is both faster and safer.
4. Add the indexes the new queries need. Check apps/api/prisma/schema.prisma first — there
   are already 75 @@index entries — and only add what is missing. Generate a proper Prisma
   migration; do not use `db push`.
5. Repeat the same review for the other report endpoints in the file (`/reports/sales`,
   `/reports/units`, `/reports/sla`, `/reports/data-quality`, `/reports/my-dashboard`).
   Report which ones have the same unbounded-findMany pattern and fix the worst offenders.

ACCEPTANCE CRITERIA:
- No unbounded `findMany` remains in GET /reports/executive.
- The response for the seeded demo dataset is deep-equal to the response from the current
  implementation. Prove it: write a temporary comparison script, run it, paste the result,
  then delete the script.
- Add a test asserting the endpoint returns 403 for a role without `report.executive` and
  that the `finance` key is null for a role without `finance.read`.
- `pnpm -r typecheck` clean.
```

---

## Prompt 11 — Email notifications for short SLAs

```
TASK: Add outbound email so short-fuse SLA warnings and approval requests reach people who
do not have the SPA open.

CONTEXT / EVIDENCE:
- Notifications are in-app only. apps/api/src/sla/engine.ts `notifyOwner()` and
  apps/api/src/forms/engine.ts `notifyApprovers()` both write rows to the `notifications`
  table and nothing else.
- The SPA polls: apps/web/src/components/Shell.tsx `Notifications` uses
  `refetchInterval: 60_000`.
- Several Doc_H SLAs are 4 working hours (SLA_TASK_ACCEPTANCE, SLA_CLARIFICATION,
  SLA_REVISION, SLA_UNIT_QC, SLA_SCOPE_REVIEW). A four-hour deadline whose only warning
  appears inside an app the user may not have open is an operational gap, not a "limitation".
- docs/operations.md lists "Email / calendar — Notifications are in-app only. No SMTP" under
  Known limitations.

WHAT TO DO:
1. Add an SMTP transport behind a feature flag, following the exact pattern the AI subsystem
   already uses (apps/api/src/env.ts `aiEnabled`, and the graceful-degradation contract in
   docs/decisions.md ADR-007):
     - env: MAIL_ENABLED, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_SECURE
     - `mailEnabled` computed exactly like `aiEnabled` (flag AND required settings present)
     - when disabled, everything else keeps working unchanged and nothing throws.
   This needs one dependency (nodemailer). State that clearly in your summary.
2. Create apps/api/src/mail/ with:
     - `transport.ts` — lazy singleton, same shape as the Anthropic client in
       apps/api/src/ai/service.ts;
     - `templates.ts` — Persian, RTL HTML email bodies + plain-text alternative. Reuse
       apps/api/src/pdf/fmt.ts (stateFa, date, num) for consistent Persian formatting.
       Do NOT inline the Vazirmatn font in email — email clients will not render it; use a
       system font stack.
3. Introduce a single `notify()` service that writes the Notification row AND, when mail is
   enabled and the recipient has an email, queues an email. Route both existing call sites
   (`notifyOwner`, `notifyApprovers`) through it. Email sending must NEVER block or fail the
   business transaction — dispatch it after the transaction commits, and swallow+log errors,
   exactly as `notifyOwner` already does with `.catch(() => undefined)`.
4. Send email only for notifications that warrant it. Start with:
   SLA_BREACH, SLA_WARNING, FORM_APPROVAL_REQUIRED, and OVERDUE_DIGEST. Not for
   FORM_APPROVED/REJECTED. Make the set a constant, not scattered conditionals.
5. Use the existing pg-boss runner (apps/api/src/jobs/runner.ts) for delivery so a slow SMTP
   server cannot stall a request: add a `mail:send` queue and enqueue jobs.
6. Update docs/operations.md: remove email from Known limitations, add the new env vars to
   the table, add SMTP failure to the Monitoring table.

ACCEPTANCE CRITERIA:
- With MAIL_ENABLED unset, behaviour is bit-identical to today and no test changes.
- With it set, an SLA breach produces both a Notification row and a queued mail job.
- Add a test that asserts the disabled path is a no-op and that the enabled path enqueues
  (mock the transport; do not send real mail in tests).
- `pnpm -r typecheck` clean.
```

---

## Prompt 12 — PDF engine: dead code, no shutdown, no concurrency limit, unescaped header/footer

```
TASK: Four defects in the PDF subsystem. Fix all four.

CONTEXT / EVIDENCE — apps/api/src/pdf/renderer.ts:

(1) DEAD CODE / BROKEN HEALTH CONTRACT.
    `pdfEngineHealthy()` and `shutdownPdfEngine()` are exported but grep shows they are
    called from NOWHERE in apps/api/src.
    - Consequence A: GET /health/ready in apps/api/src/app.ts only runs
      `prisma.$queryRaw\`SELECT 1\`` — it does not check the PDF engine. But
      docs/pdf-export.md's "بررسی سلامت" section tells operators to verify the PDF engine
      with `curl localhost:4000/health/ready`. The doc describes a check that does not exist.
    - Consequence B: apps/api/src/server.ts's SIGTERM/SIGINT handler closes Fastify, pg-boss
      and Prisma but never closes the browser. The Chromium process is leaked on every
      restart.

(2) NO CONCURRENCY LIMIT.
    `renderPdf()` creates a new BrowserContext per request with no cap. The only protection
    is the global 300 req/min rate limit, which is far too loose. Twenty concurrent
    executive-report exports can exhaust container memory. Note that the executive report is
    also landscape and multi-page, so it is the most expensive kind.

(3) UNESCAPED INTERPOLATION IN HEADER/FOOTER.
    `headerTemplate(right)` and `footerTemplate(note)` interpolate directly into HTML:
        <span>${right}</span>       // right = doc.code
        <span>${note}</span>        // note contains the exporter's fullName (routes/pdf.ts)
    Everywhere else the PDF layer correctly escapes via `esc()` from apps/api/src/pdf/fmt.ts.
    JavaScript is disabled in the render context so this is not code execution, but a
    fullName containing `<` breaks the header of an official document.

(4) --no-sandbox.
    `chromium.launch({ args: ['--no-sandbox', ...] })`. Risk is low given `offline: true`,
    `javaScriptEnabled: false` and the data:-only route filter, but it should be a
    documented, deliberate choice rather than a default.

WHAT TO DO:
1. Wire up the health check: add a `pdf` field to GET /health/ready reporting the engine's
   availability. Make it NON-BLOCKING — a missing browser must not make the service report
   not-ready, because the rest of the platform works fine without it (that is the whole
   point of the 503 degradation in ADR-014). Cache the result briefly (the engine launch is
   expensive) — mirror the TTL-cache pattern already used by `loadCalendar` in
   apps/api/src/sla/engine.ts.
2. Call `shutdownPdfEngine()` from the `shutdown` handler in apps/api/src/server.ts, before
   `app.close()`.
3. Add a concurrency limiter around `renderPdf()` — a small semaphore (no dependency needed;
   ~20 lines) with a configurable ceiling, e.g. env `PDF_MAX_CONCURRENCY` default 2, and a
   bounded queue. When the queue is full, return 503 with a Persian "try again shortly"
   message rather than queuing unboundedly. Add the env var to .env.example,
   .env.docker.example, docker-compose.yml and the docs/operations.md table.
4. Escape `right` and `note` with `esc()` in headerTemplate/footerTemplate.
5. Document the --no-sandbox decision in a code comment referencing the offline +
   JS-disabled + data:-only mitigations, and add a note to docs/pdf-export.md's security
   section. If you can make the Docker image run Chromium WITH the sandbox (it needs
   appropriate kernel capabilities), propose that instead and explain the trade-off.

ACCEPTANCE CRITERIA:
- `grep -rn "pdfEngineHealthy\|shutdownPdfEngine" apps/api/src` shows call sites outside
  renderer.ts.
- A user whose fullName contains `<script>` produces a well-formed PDF header.
- Concurrent export requests beyond the ceiling are queued or rejected, never unbounded.
- docs/pdf-export.md's health-check section matches what /health/ready actually returns.
- `pnpm -r typecheck` clean.
```

---

## Prompt 13 — nginx: security headers are silently dropped on static assets

```
TASK: Fix the nginx add_header inheritance bug in infrastructure/docker/nginx.conf.

CONTEXT / EVIDENCE:
- The server block sets Content-Security-Policy, X-Content-Type-Options, X-Frame-Options,
  Referrer-Policy and Permissions-Policy, all with `always`.
- The block
      location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
      }
  contains its own `add_header`. Per nginx's documented inheritance rule, `add_header`
  directives are inherited from the previous level ONLY IF the current level defines no
  `add_header` directives of its own. Because this location defines one, ALL five
  server-level security headers are dropped for every request under /assets/ — i.e. for
  every JavaScript and CSS file the SPA loads.
- Same trap would apply to any other location block that later gains an add_header.

WHAT TO DO:
1. Restructure so the security headers apply everywhere. Preferred approach: move the five
   security headers into a separate file (e.g. infrastructure/docker/security-headers.conf)
   and `include` it in BOTH the server block and every location block that defines its own
   add_header. Add a comment at the include site explaining the inheritance rule, so the
   next person does not reintroduce the bug.
2. Audit every location block in the file for the same problem.
3. While you are here, review the CSP itself:
   - `style-src 'unsafe-inline'` is currently required by Tailwind's runtime? Verify whether
     the built output actually needs it (Tailwind 4 with the Vite plugin emits a static
     stylesheet). If it does not, remove 'unsafe-inline' and report that you did.
   - After Prompt 6 (self-hosted fonts), remove the Google origins.
   - Consider adding `object-src 'none'` and `upgrade-insecure-requests`.
4. Add a short "Reverse proxy and headers" subsection to docs/operations.md documenting what
   is set and why, and noting that HSTS must be added at the TLS-terminating proxy in front
   of `web` (docs/operations.md already says this in prose — cross-reference it).

ACCEPTANCE CRITERIA:
- `docker build -f infrastructure/docker/Dockerfile.web .` succeeds and
  `nginx -t` passes inside the image.
- `curl -I http://localhost:8080/assets/<any-hashed-file>.js` returns all five security
  headers AND the Cache-Control header. Show the actual output in your summary.
```

---

## Prompt 14 — Broken search navigation and untranslated state labels in the UI

```
TASK: Two small but highly visible frontend defects.

DEFECT 1 — search results for tasks and leads navigate nowhere.
  apps/web/src/components/Shell.tsx defines:
      const SEARCH_ROUTES: Record<string, string> = {
        company: '/companies', opportunity: '/opportunities', project: '/projects',
        task: '/tasks', brief: '/briefs', proposal: '/proposals', contract: '/contracts',
      };
  and navigates to `${SEARCH_ROUTES[group.type]}/${item.id}`.
  But apps/web/src/App.tsx declares NO `/tasks/:id` route (only `/tasks`), and no `/leads/:id`
  route at all. apps/api/src/routes/search.ts returns a `task` group whenever the caller has
  `task.read`. So clicking a task search result hits the `path="*"` catch-all and silently
  redirects the user to the dashboard.

DEFECT 2 — the success toast shows the raw English state code.
  apps/web/src/hooks/queries.ts:
      onSuccess: async (result) => {
        toast(`وضعیت به «${result?.toState ? stateLabel(result.toState) : 'وضعیت جدید'}» تغییر کرد.`);
      }
      function stateLabel(state: string): string {
        // Kept local to avoid a circular import with the UI module's STATE_META.
        return state;
      }
  So a Persian-speaking user sees: «وضعیت به «PENDING_AUTHORIZATION» تغییر کرد.» while the
  StateBadge on the very same screen correctly renders «در انتظار مجوز». The mapping already
  exists as STATE_META in apps/web/src/components/ui.tsx — the only reason it is not used is
  the circular import the comment describes.

WHAT TO DO:
1. Extract STATE_META (and the `Tone` type it depends on) out of
   apps/web/src/components/ui.tsx into a new dependency-free module, e.g.
   apps/web/src/lib/states.ts. Re-export from ui.tsx so existing imports keep working, and
   import it in hooks/queries.ts. Delete the `stateLabel` stub and use the real lookup, with
   the raw state as fallback.
   Consider whether STATE_META belongs in packages/contracts instead (it is a labelling
   concern shared with apps/api/src/pdf/fmt.ts STATE_FA, which is a near-duplicate of the
   same table). If you move it there, deduplicate both copies. Recommend one and do it.
2. Either add the missing detail routes, or stop offering the links:
   - Preferred: add `/tasks/:id` and `/leads/:id` detail pages consistent with the existing
     detail pages in apps/web/src/pages/Operations.tsx and Crm.tsx. Keep them minimal:
     header + state badge + available transitions + related records + PdfButton where a PDF
     kind exists.
   - If you judge that out of scope, then remove `task` from SEARCH_ROUTES and have
     apps/api/src/routes/search.ts stop returning groups the UI cannot open — but say
     explicitly that you chose the lesser fix.
3. Grep the whole SPA for other navigation targets that have no matching route in App.tsx
   and report them.

ACCEPTANCE CRITERIA:
- Clicking any global-search result lands on a real page.
- The transition toast reads «وضعیت به «در انتظار مجوز» تغییر کرد.»
- No circular import; `pnpm --filter @hiva/web typecheck` clean.
```

---

## Prompt 15 — Scope every lookup by organizationId, or stop claiming multi-tenant readiness

```
TASK: docs/architecture.md and ADR-008 claim the schema is "multi-tenant-ready" and that
`organizationId` is "automatically applied to reads and writes by the CRUD factory". That is
only true for list queries. Make it true everywhere, or amend the claim.

CONTEXT / EVIDENCE:

(1) apps/api/src/lib/crud.ts — the factory applies organizationId ONLY in the list handler:
        if (fieldsOf(opts.model).has('organizationId')) where.organizationId = actor.organizationId;
    The detail, update and delete handlers all use
        model().findUnique({ where: { id } })
    with no tenant predicate. Same for the subsequent `update` / `delete`.

(2) apps/api/src/workflow/engine.ts `transition()` loads the record with
        model.findUnique({ where: { id } })
    and updates it, with no organizationId predicate — even though `actor.organizationId` is
    right there and is used for the StateTransition and AuditEvent rows.

(3) apps/api/src/routes/admin.ts — PATCH /users/:id and POST /users/:id/deactivate look the
    user up by id only.

(4) apps/api/src/sla/engine.ts — the calendar cache is a single module-level variable:
        let cachedCalendar: { at: number; cal: Calendar } | null = null;
    keyed by nothing. In a multi-tenant deployment, organisation B would get organisation A's
    working week and holidays for up to 60 seconds. This is a correctness bug waiting to
    happen, and it is cheap to fix now.

(5) apps/api/src/routes/quality.ts, apps/api/src/ai/service.ts and several route files look
    records up by id without a tenant predicate.

Note: apps/api/src/routes/documents.ts DOES do this correctly
    (`if (!doc || doc.deletedAt || doc.organizationId !== actor.organizationId) throw notFound()`)
— use it as the reference pattern.

WHAT TO DO:
1. In lib/crud.ts, replace `findUnique({ where: { id } })` with a tenant-scoped lookup for
   the detail, update and delete handlers — `findFirst({ where: { id, organizationId } })`
   for models that carry the column (the factory already knows this via `fieldsOf`). Make
   the update/delete operate on the verified record. A record belonging to another
   organisation must return 404, never 403 (do not disclose existence).
2. Do the same in workflow/engine.ts `transition()`.
3. Do the same in routes/admin.ts for the user routes.
4. Convert the calendar cache to a `Map<organizationId, {at, cal}>` and keep the 60s TTL.
   `resetCalendarCache()` must clear the whole map (tests use it).
5. Sweep the rest of apps/api/src for `findUnique({ where: { id` on tenant-scoped models and
   fix them. Produce a list of every file you changed.
6. Update docs/architecture.md's Multi-tenancy section and ADR-008 to describe exactly what
   is and is not in place after your change.

CONSTRAINTS:
- Do not change any API response shape.
- Prisma note: `findUnique` cannot take a non-unique filter; `findFirst` is the correct
  replacement. Do not add compound unique constraints to the schema just to keep findUnique.

ACCEPTANCE CRITERIA:
- Add a test that seeds a second Organization with one project, then asserts that a user of
  organisation A gets 404 on GET/PATCH of organisation B's project id and 404 on a workflow
  transition against it.
- `pnpm -r typecheck` clean; all existing tests pass.
```

---

## Prompt 16 — Tighten remaining authorization and upload gaps

```
TASK: Four smaller security hardening items. Do them in one change.

(1) GET /users is readable by every authenticated user.
    apps/api/src/routes/admin.ts registers it with `preHandler: [app.authenticate]` only —
    no permission. It returns the full staff directory including roles, department and
    `lastLoginAt` for every user. The write routes correctly require `admin.users`.
    The read is presumably needed to populate assignee pickers.
    FIX: keep an unprivileged, minimal directory (id, fullName, department code, and only
    the fields the pickers actually consume — check apps/web/src for every consumer of
    /users before deciding), and require `admin.users` for the full record including
    lastLoginAt, isActive and the role list. Report which fields the SPA actually needs.

(2) Upload MIME type is taken from the client.
    apps/api/src/routes/documents.ts checks `file.mimetype` against ALLOWED_MIME. That value
    comes from the multipart Content-Type header and is trivially forged.
    FIX: verify the declared type against the file's magic bytes before persisting. Read the
    first bytes from the stream (you are already piping it and already computing a SHA-256
    while streaming, so extend that pattern rather than buffering the whole file). Reject
    with the existing 400 UNSUPPORTED_TYPE on mismatch and delete the partial file, exactly
    as the existing truncation path does. If you need a dependency (e.g. file-type), say so
    and justify it; a hand-rolled signature table for the ~15 allowed types is also fine and
    dependency-free — recommend one.
    Also: drop `image/svg+xml` from ALLOWED_MIME unless there is a stated need. The forced
    `Content-Disposition: attachment` + `nosniff` + octet-stream override already neutralise
    it, but there is no reason to accept an active-content format at all.

(3) Uploaded document ownership is not verified.
    The POST /documents handler takes projectId, companyId, contractId, deliverableId and
    submissionId straight from multipart fields and writes them to the row without checking
    those records exist or belong to the caller's organisation.
    FIX: validate each supplied id with a tenant-scoped existence check before create; return
    400 FK_VIOLATION-style Persian error otherwise.

(4) The `state` column has no database-level constraint.
    apps/api/prisma/schema.prisma declares state as `String @default("DRAFT")` on every
    workflow entity. The "structurally impossible to bypass" claim in README.md therefore
    holds only at the application layer; a direct UPDATE or a data import can write any
    value.
    FIX: add CHECK constraints (via a Prisma migration with raw SQL) restricting each
    entity's `state` to the states declared in packages/contracts/src/workflows.ts. GENERATE
    the migration from WORKFLOWS rather than hand-typing the lists, so it cannot drift — a
    small script under apps/api/prisma/ that emits the SQL is acceptable and preferable.
    Add a test asserting that every state in WORKFLOWS is accepted and that an invented
    state is rejected by the database.
    Note the precedent: docs/operations.md already recommends a database-level REVOKE on
    audit_events. This is the same idea applied to state.

ACCEPTANCE CRITERIA:
- Tests in apps/api/tests/003-security.test.ts for (1), (2) and (3).
- A migration + test for (4).
- `pnpm -r typecheck` clean.
```

---

## Prompt 17 — Reconcile the documentation with the code

```
TASK: Seven documented claims do not match the code. Fix each by correcting the doc, and —
where cheap — by making the number impossible to drift again.

THE DISCREPANCIES (all verified against the current working tree):

| Claim | Location | Reality |
|---|---|---|
| "109 tests" | README.md (twice: repo layout section and Commands table) | 133 tests: 001=21, 002=36, 003=24, 004=31, 005=21 |
| "21 dedicated tests" for governance | README.md | 21 — correct, leave it |
| "Verified by 21 security tests" | docs/architecture.md, Security section | 24 |
| "schema is tenant-ready … applied automatically to reads and writes by the CRUD factory" | docs/architecture.md Multi-tenancy; ADR-008 | Only list reads are scoped (see Prompt 15) |
| "Entity `state` is written in exactly one place" | docs/architecture.md; ADR-002; README table | Three exceptions (see Prompt 2) |
| "/health/ready … بررسی سلامت [of the PDF engine]" | docs/pdf-export.md | /health/ready only checks the database |
| Docker recipe `apt-get install chromium` | docs/pdf-export.md | The image is Alpine (see Prompt 1) |
| `pnpm test:e2e` listed as a command | package.json (root) delegates to `@hiva/api test:e2e` | No such script in apps/api/package.json; the root `tests/` directory is empty |

WHAT TO DO:
1. Correct every doc statement above to match the code AS IT IS AFTER the other prompts in
   this batch have been applied. If a prompt has not been applied yet, describe the current
   truth, not the intended future.
2. Remove `test:e2e` from the root package.json scripts, OR implement it. Do not leave a
   documented command that fails. If you remove it, also remove the empty `tests/` directory
   at the repo root and the mention in README.md.
3. Make the counts self-maintaining. Add a test in apps/api/tests/004-engines.test.ts that
   asserts the constants the docs quote — permissions (103), roles (16), forms (130), SLA
   policies (30), workflows (13), Prisma models (59). Several of these already exist for
   forms and SLA; extend the pattern. Then, in the docs, cite the test as the source of
   truth rather than repeating a bare number where practical.
4. For the test COUNT specifically, prefer removing the hard number from README.md entirely
   ("the full suite" rather than "109 tests"). A number that must be manually maintained
   will drift again.
5. Also clean up the small repo hygiene issues while you are here:
   - `.DS_Store` files are committed despite being in .gitignore
     (Doc_H/.DS_Store, apps/.DS_Store, apps/api/.DS_Store, apps/web/.DS_Store,
     packages/.DS_Store, packages/contracts/.DS_Store). Remove them from the index with
     `git rm --cached`.
   - apps/web/tsconfig.tsbuildinfo is on disk; confirm it is ignored.
   - Two files under Doc_H/ are untracked. Ask whether they should be committed — do not
     decide unilaterally, they are the organisation's source documents.

ACCEPTANCE CRITERIA:
- Every number quoted in README.md and docs/*.md is either correct or replaced by a
  qualitative statement.
- `pnpm test:e2e` either works or no longer exists.
- `git status --short` is clean apart from the intentional Doc_H question.
```

---

# PRIORITY 3 — Medium term

---

## Prompt 18 — Build a frontend test suite from zero

```
TASK: apps/web has approximately 5,000 lines of React and ZERO tests. Establish a test
suite, starting with the highest-risk logic.

CONTEXT:
- apps/api has a strong integration suite (133 tests via vitest + app.inject against a real
  PostgreSQL). apps/web has nothing — no vitest config, no test files, no testing deps.
- The riskiest frontend logic, in order:
    1. apps/web/src/lib/format.ts — Persian digit conversion, Jalali formatting, currency
       abbreviation ("۴٫۳ میلیارد ریال"), relative dates, toIso. Pure functions; highest
       value per line of test.
    2. apps/web/src/lib/api.ts — the 401 → refresh → retry flow, including the
       `refreshing ??=` single-flight collapse and the queueMicrotask reset. Subtle and
       untested.
    3. apps/web/src/lib/auth.tsx — session restore on first paint, `can` / `canAny` /
       `hasRole`.
    4. apps/web/src/components/ui.tsx — StateBadge falls back to the raw state for unknown
       values; assert every state in packages/contracts WORKFLOWS has an entry in STATE_META
       (this would have caught missing labels).

WHAT TO DO:
1. Add vitest + @testing-library/react + jsdom to apps/web as devDependencies, with a
   vitest.config.ts mirroring the conventions in apps/api/vitest.config.ts.
2. Add a `test` script to apps/web/package.json and wire it into the root `pnpm test` so CI
   runs both. Update .github/workflows/ci.yml.
3. Write the tests for items 1–4 above. For lib/api.ts use a mocked fetch; assert that two
   concurrent 401s trigger exactly ONE refresh call.
4. The STATE_META completeness test is the highest-value one — write it as a table-driven
   test importing WORKFLOWS from @hiva/contracts and asserting every declared state (and
   every state in the SLA/QC/form vocabularies) has a Persian label. Report any gaps it
   finds.

CONSTRAINTS:
- Do not attempt full page-level rendering tests in this pass; that needs a router and query
  client harness and will balloon. Pure logic and small components only.
- Do not change production code except where a test reveals a real bug — and if it does,
  report the bug separately rather than silently fixing it.

ACCEPTANCE CRITERIA:
- `pnpm --filter @hiva/web test` passes.
- CI runs frontend tests.
```

---

## Prompt 19 — Isolate the API test database per test file

```
TASK: Improve test isolation so the suite is repeatable and can run in parallel.

CONTEXT / EVIDENCE:
- apps/api/vitest.config.ts sets `fileParallelism: false` and `sequence.concurrent: false`
  with the comment "The business-scenario suite drives one shared database through a full
  lifecycle, so files must not run concurrently."
- apps/api/tests/global-setup.ts runs `prisma migrate deploy` + the seed ONCE and is
  deliberately non-destructive ("no migrate reset"). The seed is idempotent and skips demo
  data if customers already exist.
- Consequences: every run accumulates rows in the same database; a test can pass because of
  data a previous run created; the suite gets slower over time; and a developer cannot run a
  single file in isolation with confidence.
- The mitigation currently relied upon is that business codes come from an atomic counter so
  collisions do not occur. That prevents crashes, not cross-contamination.

WHAT TO DO:
1. Give each test FILE its own PostgreSQL schema (not database — schema creation is far
   cheaper and Prisma supports it via the `?schema=` parameter in DATABASE_URL).
   Approach: in a per-file setup, derive a schema name from the test file name, create it,
   run `prisma migrate deploy` against it once (or template it from a pre-migrated schema —
   benchmark both and pick the faster), seed it, and drop it in teardown.
2. Re-enable `fileParallelism` and measure. Report before/after wall-clock time for the full
   suite.
3. Keep global-setup.ts's behaviour available behind a flag for developers who want the
   current fast shared-database loop, but make isolated the default in CI.
4. apps/api/tests/helpers.ts caches a single Fastify instance in a module-level `cached`
   variable. Verify that still works per-worker under parallelism; adjust if not.

CONSTRAINTS:
- Do not rewrite the tests themselves. The lifecycle suite (002) is intentionally sequential
  WITHIN its file — preserve that.
- .github/workflows/ci.yml must keep working; update it if the DATABASE_URL handling changes.

ACCEPTANCE CRITERIA:
- Running the suite twice in a row from a clean database produces identical results.
- Running a single file (`pnpm --filter @hiva/api test tests/001-governance.test.ts`) passes
  from an empty database.
- Report the new total runtime.
```

---

## Prompt 20 — Load-test the two endpoints most likely to fall over

```
TASK: docs/operations.md states under Known limitations: "Load testing — Not performed."
Perform it for the two highest-risk surfaces and record the results.

TARGETS (chosen from the code, not guessed):
  1. GET /api/v1/reports/executive — see Prompt 10. Even after that fix, this is the
     heaviest read in the system and it is the CEO's landing page.
  2. GET /api/v1/forms/definitions — returns all 130 form definitions INCLUDING each one's
     full JSON field schema, plus a category roll-up computed in JS with a `.filter()` per
     category. Called on every visit to /forms.
  3. GET /api/v1/pdf/executive-report/all — the most expensive write-side operation
     (Chromium, landscape, multi-page). Test it against the concurrency limiter from
     Prompt 12.

WHAT TO DO:
1. Add a load-test harness under a new top-level `bench/` directory (autocannon or k6 — pick
   one, justify, and keep it a devDependency of the root workspace, not of apps/api).
2. Seed a realistic dataset first: write a script that generates, say, 200 companies,
   400 projects, 20,000 tasks, 5,000 deliverables, 2,000 form submissions with the same
   distribution the demo seed uses. Make the volumes configurable. This script is a
   deliverable in its own right — put it next to apps/api/prisma/seed.ts and document it.
3. Measure p50/p95/p99 latency and RSS growth at 1, 10 and 50 concurrent users for each
   target. Run against a production-mode build, not `tsx watch`.
4. Write the results into a new docs/performance.md: the dataset shape, the numbers, the
   bottleneck you found, and what you would fix next. Replace the "Not performed" row in
   docs/operations.md Known limitations with a pointer to it.
5. If any target exceeds 1s at p95 with 10 concurrent users, stop and report before
   optimising — the fix should be a separate, reviewed change.

ACCEPTANCE CRITERIA:
- `bench/` is runnable with one documented command.
- docs/performance.md exists with real measured numbers, not estimates.
- The data-generation script is idempotent and clearly marked as non-production.
```

---

## Prompt 21 — UX polish: dark mode, language switch, in-app help, error boundary

```
TASK: Four accessibility/usability gaps. Treat them as independent sub-tasks; do them in the
order given and report after each.

(1) ERROR BOUNDARY (do this one first — it is the smallest and the most valuable).
    apps/web/src/App.tsx has no React error boundary. Any render-time exception blanks the
    entire page with no recovery path. Add one wrapping the <Routes> inside <Shell>, showing
    a Persian message, the error id if available, and a "reload" action. Reuse the visual
    language of `ErrorBlock` in apps/web/src/components/ui.tsx.

(2) DARK MODE.
    apps/web/src/index.css hardcodes `color-scheme: light` and defines the ink/brand scales
    as flat tokens under @theme. For a tool that stays open all day this is a common request.
    Implement with Tailwind 4's dark variant driven by a `data-theme` attribute on <html>,
    with three states: light, dark, system (default). Persist the choice in localStorage —
    note that apps/web/src/lib/api.ts already uses localStorage for the refresh token, so
    the pattern exists. Redefine ONLY the tokens under the dark selector; do not fork the
    component styles. Add the toggle to the TopBar in apps/web/src/components/Shell.tsx.

(3) LANGUAGE SWITCH.
    Every field, form and role definition in packages/contracts already carries both
    `labelFa` and `labelEn` (see form-fields.ts, permissions.ts, enums.ts ROLE_LABELS and
    DEPARTMENT_LABELS, and every FormDef). docs/decisions.md ADR-009 explicitly says
    "an English locale is additive rather than a rewrite". The infrastructure exists but is
    unreachable from the UI, and User.locale is already a column in the Prisma schema.
    Add a locale context that switches label selection and flips `dir` on <html>, persisted
    to User.locale via the API. Scope this pass to labels that ALREADY have an English
    string — do NOT start translating hardcoded Persian strings in page components; instead,
    produce a list of the hardcoded strings you found so a follow-up can extract them.

(4) IN-APP HELP.
    docs/user-guide.md is a good per-role walkthrough that no user will ever find. Surface it:
    add a help entry in the sidebar that opens the relevant section for the signed-in user's
    role, and add contextual help links on the Forms and QC pages. Source the content from
    docs/user-guide.md — do not fork the text; either import it at build time or generate the
    in-app content from it, so the two cannot drift.

CONSTRAINTS:
- No new UI framework. Tailwind 4 + the existing components in ui.tsx only.
- Every new interactive element must be keyboard-reachable with a visible focus ring — match
  the `focus-visible:outline` pattern already used by Button.
- `pnpm --filter @hiva/web typecheck` clean after each sub-task.
```

---

## Prompt 22 — Accessibility pass on the overlay components

```
TASK: The dropdown overlays in the shell are mouse-only. Make them keyboard- and
screen-reader-accessible.

CONTEXT / EVIDENCE — apps/web/src/components/Shell.tsx:
- `GlobalSearch`: results render in a floating div. There is a Ctrl/⌘+K focus shortcut and
  Escape closes it, which is good. But there is no `role="combobox"` / `aria-expanded` /
  `aria-controls` / `aria-activedescendant`, no arrow-key navigation through results, and
  Enter does not select the first result. The click-outside handler is a bare
  document mousedown listener.
- `Notifications`: the trigger button has a good `aria-label` with the unread count, but the
  panel has no `role`, no focus management, no Escape handler (unlike search), and focus is
  not returned to the trigger on close.
- The mobile sidebar in `Shell` toggles with `translate-x` but is not removed from the
  accessibility tree when closed, and there is no focus trap while it is open.
- apps/web/src/components/ui.tsx has a `Modal` component — check it for the same issues
  (focus trap, Escape, aria-modal, restoring focus).

WHAT TO DO:
1. Implement a small shared `useDismissable({ onClose })` hook handling Escape, click-outside
   and focus restoration, and use it in GlobalSearch, Notifications and Modal so the
   behaviour is identical everywhere.
2. Give GlobalSearch full combobox semantics with arrow-key navigation and Enter-to-select.
3. Give the Notifications panel a role, Escape handling and focus return.
4. Hide the closed mobile sidebar from assistive tech (`inert` or `aria-hidden` plus
   `visibility`), and trap focus while it is open.
5. Verify RTL correctness of every focus/arrow interaction — this is an RTL-first app and
   arrow-key semantics must feel right in RTL.

ACCEPTANCE CRITERIA:
- Every overlay is fully operable with keyboard only.
- Report the result of an axe-core scan (add it as a devDependency for the test run if you
  set up the frontend test suite from Prompt 18; otherwise report a manual checklist).
- `pnpm --filter @hiva/web typecheck` clean.
```

---

## Prompt 23 — Repository and build hygiene

```
TASK: A short cleanup pass. Low risk, do it in one change.

ITEMS:

(1) Non-reproducible builds.
    `pnpm install --frozen-lockfile=false` is used in THREE places:
      - .github/workflows/ci.yml
      - infrastructure/docker/Dockerfile.api
      - infrastructure/docker/Dockerfile.web
    This lets dependency versions drift silently between CI and production images.
    FIX: commit an up-to-date pnpm-lock.yaml and switch all three to `--frozen-lockfile`.
    If the lockfile is currently out of sync (it may be — the repo resolved
    @prisma/engines-version 7.x against prisma 6.19 during a fresh install), regenerate it
    deliberately, verify the resulting versions, and say what changed.

(2) Vulnerability audit does not gate CI.
    .github/workflows/ci.yml runs `pnpm audit --audit-level high` with
    `continue-on-error: true`, so a high-severity advisory never fails the build.
    FIX: decide a policy and implement it — either remove continue-on-error, or keep it but
    add a scheduled job that opens an issue. State which you chose. Do not leave a check
    that cannot fail.

(3) Silent fallback in ttlToMs.
    apps/api/src/auth/tokens.ts:
        export function ttlToMs(ttl: string): number {
          const m = /^(\d+)([smhd])$/.exec(ttl);
          if (!m) return 7 * 24 * 3_600_000;   // silently 7 days
    A typo in ACCESS_TOKEN_TTL or REFRESH_TOKEN_TTL silently becomes a 7-day lifetime.
    FIX: validate the TTL format in apps/api/src/env.ts with a Zod regex so the process
    refuses to start on a malformed value — consistent with the existing fail-fast posture
    for JWT_SECRET. Then make ttlToMs throw instead of guessing.

(4) Empty root tests/ directory and stale build artifacts — see Prompt 17 item 5.

ACCEPTANCE CRITERIA:
- CI passes with frozen lockfiles.
- A malformed ACCESS_TOKEN_TTL causes a startup failure naming the variable.
- `pnpm -r typecheck` clean.
```

---

## Appendix — Suggested order and batching

| Batch | Prompts | Rationale |
|---|---|---|
| A | 1, 6, 7 | Deployment blockers; independent; no code-logic risk |
| B | 3, 4, 5, 16 | Security cluster; touches auth + routes; test together |
| C | 2, 15 | State/tenancy invariants; both touch crud.ts + engine.ts — do them together to avoid conflicts |
| D | 9, 10, 12 | Engine correctness and performance |
| E | 13, 14, 23 | Small, low-risk, high-visibility |
| F | 8, 11 | New user-facing capability; each is a multi-day change |
| G | 17 | Documentation reconciliation — do this LAST, after the code is settled |
| H | 18, 19, 20, 21, 22 | Quality investment; can run in parallel with F |

**Note on Prompt 17:** run it last. Reconciling docs before the code changes means doing it twice.
