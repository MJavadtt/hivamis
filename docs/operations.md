# Operations

## Deployment

### Docker (recommended)

```bash
cp .env.docker.example .env
# Required:
#   POSTGRES_PASSWORD=$(openssl rand -base64 32)
#   JWT_SECRET=$(openssl rand -base64 48)
docker compose up -d --build
docker compose exec api npx prisma migrate deploy   # runs automatically on start
```

Serves on `http://localhost:8080`. Only the web container publishes a port; the API and database
are reachable only on the internal network.

**Before going live:** terminate TLS at a reverse proxy in front of `web`, set `CORS_ORIGIN` to
the real origin, and add HSTS at that proxy.

### Manual

```bash
pnpm install
pnpm build
cd apps/api && pnpm exec prisma migrate deploy
node --env-file=.env dist/server.js     # API
# serve apps/web/dist from any static host, proxying /api to the API
```

## Seeding

`pnpm db:seed` is idempotent: it upserts reference data (departments, roles, permissions, 30 SLA
policies, all 130 form definitions) and skips demo data if customers already exist.

**In production, run the seed but do not keep the demo accounts.** They share a published
development password. Create real accounts through `POST /users` (which forces a password change
on first sign-in), then deactivate the demo users.

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | yes | — | PostgreSQL connection string |
| `JWT_SECRET` | yes | — | ≥32 chars. The process refuses to start otherwise |
| `PORT` / `HOST` | no | 4000 / 0.0.0.0 | |
| `NODE_ENV` | no | development | |
| `LOG_LEVEL` | no | info | `fatal`…`trace`, or `silent` |
| `CORS_ORIGIN` | no | localhost:5173 | Comma-separated list |
| `PUBLIC_APP_URL` | no | first `CORS_ORIGIN` | The web app's public address — the base of approval links sent to clients (roadmap #35) |
| `ACCESS_TOKEN_TTL` | no | 15m | |
| `REFRESH_TOKEN_TTL` | no | 7d | |
| `STORAGE_DIR` | no | ./storage | Uploaded documents |
| `MAX_UPLOAD_MB` | no | 25 | |
| `SEED_DEMO_DATA` | no | unset | `true` loads the fifteen demo accounts and demo records. Ignored entirely when `NODE_ENV=production`. Note Prisma auto-loads `apps/api/.env`, so a value there applies to seed runs. |
| `MAIL_ENABLED` | no | `false` | Outbound email. Off by default; notifications stay in-app and nothing throws. Requires `SMTP_HOST` and `SMTP_FROM` to actually engage — the flag alone is not enough. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | no | — / 587 / false | Relay to send through. |
| `SMTP_USER` / `SMTP_PASS` | no | — | Omit both for an unauthenticated relay. |
| `SMTP_FROM` | no | — | Envelope sender. Required for `MAIL_ENABLED` to take effect. |
| `PDF_MAX_CONCURRENCY` | no | 2 | Simultaneous Chromium renders. Each costs roughly 150MB of RSS while it runs, and the work is CPU-bound, so raising this buys queueing rather than throughput. |
| `PDF_QUEUE_FACTOR` | no | 4 | Queue depth as a multiple of `PDF_MAX_CONCURRENCY`. Requests beyond it are refused with 503 `PDF_ENGINE_BUSY` rather than joining a queue that cannot drain in time. |
| `PDF_BROWSER_PATH` | no | — | Chromium binary for PDF export. Unset locally (the renderer probes the Playwright cache and system paths); the Docker image pins it to `/usr/bin/chromium`. Without a resolvable browser, `/api/v1/pdf/*` returns 503 and the rest of the platform is unaffected. |
| `RATE_LIMIT_MAX` | no | 300 | Requests/minute per user or IP |
| `LOGIN_RATE_LIMIT_MAX` | no | 10 | Login attempts/minute per IP |
| `TRUST_PROXY` | no | `false` | Which proxies may set `X-Forwarded-For`. `false` trusts nothing; a number is a hop count (`1` behind one reverse proxy — what the compose stack sets); a comma-separated list trusts those addresses. Leaving it at `false` behind a proxy means every client shares one rate-limit bucket; setting it too high lets a client forge its own IP and escape the login limit entirely. |
| `JOBS_ENABLED` | no | true | SLA ticking and digests |
| `TRANSCRIPTION_URL` | no | — | Speech-to-text endpoint for meeting audio (roadmap #23), OpenAI-compatible: `POST` multipart `file`, `model`, `language=fa`, returning `{ text }` — a self-hosted Whisper server works. Unset, the audio button is hidden and minutes are drafted from typed notes |
| `TRANSCRIPTION_MODEL` / `TRANSCRIPTION_API_KEY` | no | whisper-1 / — | Sent as the `model` field and as a Bearer token. Audio leaves the building when the URL is not your own; point it at an internal service if that matters |
| `FX_MAX_RATE_AGE_DAYS` | no | 7 | How old an exchange rate may be and still convert a new figure (roadmap #28). A figure dated after the last rate by more than this is refused with `FX_RATE_STALE` until that day's rate is recorded — the rial moves daily, and last month's rate is a figure nobody agreed to. `0` demands a rate for the exact day |
| `WEBHOOK_ALLOW_PRIVATE` | no | false | Let webhooks call internal addresses (and plain http) — roadmap #46. Off, a webhook URL that is or resolves to loopback, a private range or link-local (cloud metadata) is refused, on save and at connection time. Turn on only for an on-premise installation whose receivers share its network: it re-opens server-side request forgery to anyone holding `admin.keys` |
| `MOADIAN_MODE` | no | off | سامانهٔ مؤدیان (roadmap #32): `off` prepares and queues e-invoices without sending; `sandbox` sends to an in-process stand-in that accepts what passes validation — for training, **not** the tax authority; `live` uses the direct API |
| `MOADIAN_URL` | no | `https://tp.tax.gov.ir/requestsmanager/api/v2/` | The authority's API base. Point it at the authority's test environment for the first live submissions |
| `MOADIAN_PRIVATE_KEY_PATH` / `MOADIAN_CERTIFICATE_PATH` | for `live` | — | The taxpayer's private key (PEM) registered in the authority's portal, and its certificate (PEM, sent as `x5c`). Keep them out of the repository and readable only by the API process |
| `ANTHROPIC_API_KEY` | no | — | Without it, AI falls back to the rule engine |
| `AI_ENABLED` | no | false | Both this and the key are required. Also enables the model fallback of «پرسش از داده‌ها» (roadmap #27): a question the rules cannot map is sent — the question text and the metric list only, never data — to the model, which may only fill the same plan |
| `AI_MODEL` | no | claude-sonnet-4-5 | |

## Backup and recovery

```bash
DATABASE_URL=… STORAGE_DIR=./storage ./infrastructure/database/backup.sh
```

Dumps the database in custom format and archives uploaded documents, pruning beyond
`RETENTION_DAYS` (default 30). Schedule it daily:

```cron
0 2 * * * cd /opt/hiva-os && DATABASE_URL=… ./infrastructure/database/backup.sh >> /var/log/hiva-backup.log 2>&1
```

Restore:

```bash
DATABASE_URL=… ./infrastructure/database/restore.sh backups/hiva-db-20260907-020000.dump \
                                                    backups/hiva-storage-20260907-020000.tar.gz
```

The script demands you type `RESTORE` — it overwrites the target database.

**Test your restore.** A backup you have never restored is a hypothesis, not a backup. Restore
into a scratch database quarterly and check `/health/ready` plus a project 360 view.

## Production readiness checklist

Every item is checkable; none is advisory.

**1. No demo accounts.** The seed's demo phase requires `SEED_DEMO_DATA=true` *and* a
non-production `NODE_ENV`, so a production seed cannot create them. Verify anyway — a database
restored from a development dump carries them:

```bash
curl -s localhost:4000/health/ready    # demoAccounts must be 0
```

A non-zero count is also logged at `fatal` on startup, naming each account. Deactivate with
`POST /api/v1/users/:id/deactivate` (this revokes their sessions).

**2. `JWT_SECRET` rotated.** It must not be `CHANGE_ME` or any value from an example file.
Rotating it invalidates every existing session, which is the intent on first deploy:

```bash
openssl rand -base64 48
```

**3. `CORS_ORIGIN` is the real origin.** The default `http://localhost:5173` will refuse the
browser in production. Set it to the deployed origin, comma-separated if several.

**4. TLS terminated upstream.** The `web` container serves plain HTTP on `:8080` by design.
Put a TLS proxy in front of it and add HSTS there — not in `nginx.conf`, which has no
certificate. See "Reverse proxy and headers" below.

**5. Backups scheduled *and* a restore rehearsed.** A backup that has never been restored is
an assumption, not a backup:

```bash
DATABASE_URL=… STORAGE_DIR=./storage ./infrastructure/database/backup.sh
# then, against a scratch database, prove it comes back:
./infrastructure/database/restore.sh <dump>
```

**6. `PDF_BROWSER_PATH` resolves.** Confirm the engine is reachable inside the image:

```bash
docker compose exec api sh -c '$PDF_BROWSER_PATH --version'
```


## Monitoring

| Signal | Where | Alert when |
|---|---|---|
| Liveness | `GET /health/live` | Two consecutive failures |
| Readiness | `GET /health/ready` | Database unreachable |
| SLA breaches | `GET /reports/sla` | `overall.breached` trending up |
| Data quality | `GET /reports/data-quality` | Any CRITICAL finding — especially an ACTIVE project with no authorization |
| Security alerts | **مدیریت → هشدارهای امنیتی**, or `GET /security/alerts` | Any OPEN HIGH or CRITICAL alert. The `security:scan` job (every 15 min) now watches what the two rows below used to ask an operator to watch by hand |
| Failed logins | `audit_events` where `action='LOGIN_FAILED'` — raised automatically as `LOGIN_FAILURES` | Spike from one IP, or one IP trying several accounts |
| Permission denials | `audit_events` where `action='PERMISSION_DENIED'` — raised automatically as `DENIAL_SURGE` | Sustained rise suggests a misassigned role; many *different* permissions suggest probing |
| Job health | API logs, `pgboss` schema | `sla:tick` not logging for >15 min |
| Client reports | `audit_events` where `action='CLIENT_REPORT_SENT'`; API log `client status reports` every Saturday 09:00 | A week with `sent: 0` while projects are active; `unaddressed > 0` means a client company has no contact with an email |

Logs are structured JSON (pino). Every request carries a `reqId` that also appears in every error
response, so a user-reported failure maps to exactly one log line.

## Troubleshooting

**API will not start — "Invalid environment configuration".**
The message names the offending variables. `JWT_SECRET` shorter than 32 characters is the usual
cause. This is intentional: a mis-set secret must never silently fall back to a default.

**A transition returns 422.**
A Doc_H rule blocked it. `error.details.rule` names the clause and `error.message` says what is
missing — e.g. an out-of-scope change with unassessed impact dimensions. This is the system
working as designed.

**A transition returns 409 `ILLEGAL_TRANSITION`.**
The action is not declared from the current state. `error.details.allowed` lists what is legal.

**A user cannot see a screen they expect.**
Navigation is permission-driven. Check `GET /auth/me` → `permissions`, then `GET /roles`. Note
that several absences are deliberate: Sales holds no `pricing.set_price`, Account holds no
`crm.company.write`.

**SLA clocks look wrong.**
They measure *working* hours against the organisation calendar. Check
`GET /organization` for `workingDays`, `workStartHour`, `workEndHour` and holidays. The default
is Saturday–Wednesday, 09:00–18:00.

**Business code collision on insert.**
Codes come from the `counters` table. If rows were imported without going through the API,
re-run `pnpm db:seed` — its `syncCounters()` step advances every counter past the highest
existing code.

**Background jobs are not running.**
Check `JOBS_ENABLED` and look for `background jobs started` in the logs. pg-boss creates its own
`pgboss` schema on first start and needs create-schema privileges.

## Known limitations

Stated plainly rather than buried.

| Area | Status |
|---|---|
| Multi-tenancy | Schema is tenant-ready (`organizationId` everywhere) but tenant provisioning, per-tenant branding and isolation testing are not built. Single-organisation deployment by design (ADR-008) |
| SSO / MFA | Password authentication with lockout is implemented; OIDC and MFA are not |
| Calendar | No calendar integration — meetings are recorded in the platform but not written to anyone's calendar. Email notifications ARE supported; see `MAIL_ENABLED` above. |
| Gantt and dependency scheduling | Built (roadmap #10): `/projects/:id/schedule` computes earliest/latest dates and float per task on the assignee's calendar; the project's «زمان‌بندی» tab draws it. Finish-to-start only; the `kind` column is there for the other dependency types when they are needed. |
| Document versioning | Documents carry a `version` column and full audit, but there is no diff or rollback UI |
| E-signature | Contract signature is *recorded*, not executed. No e-signature integration |
| Full accounting | Project-level financial control per Doc_H — cost, revenue, margin, invoices, payments, settlement. Not a general ledger, and deliberately so |
| Search | PostgreSQL `ILIKE` with indexes. Fine for thousands of records; semantic search would need a vector store |
| Offline / mobile app | Responsive web only |
| Load testing | Done — see [performance.md](performance.md) for the dataset, harness and measured figures at 1/10/50 concurrent |

## Security operations

- Rotate `JWT_SECRET` by deploying a new value; all sessions invalidate, which is the intent.
- Deactivating a user (`POST /users/:id/deactivate`) revokes their sessions immediately.
- A password change revokes every session for that user.
- The audit trail is append-only in practice — nothing in the application updates or deletes
  `audit_events`. Consider a database-level revoke on UPDATE/DELETE for that table in production.
- Uploads are served as `application/octet-stream` with `nosniff` and forced download, so an
  uploaded SVG or HTML file cannot execute in a viewer's session.


### Mail delivery

Failures are queued, not raised: a relay outage leaves the in-app notification in place, so nobody notices the email never arrived. Watch for failed jobs:

```sql
SELECT COUNT(*) FROM pgboss.job WHERE name = 'mail:send' AND state = 'failed';
```

## Faster memory search with pgvector (optional)

`memory_documents.vector` is a `double precision[]`, and retrieval filters with `pg_trgm` before
computing cosines in the API (ADR-028). That is fast enough for an agency-sized corpus — a few
thousand documents — and needs nothing beyond a stock PostgreSQL.

If the corpus grows into the tens of thousands, and the deployment can install the extension:

```sql
CREATE EXTENSION IF NOT EXISTS vector SCHEMA public;
ALTER TABLE memory_documents ADD COLUMN embedding public.vector(256);
UPDATE memory_documents SET embedding = vector::text::public.vector;
CREATE INDEX memory_documents_embedding_hnsw
  ON memory_documents USING hnsw (embedding public.vector_cosine_ops);
```

The dimension must match the embedder in use (`local-hash-v1` is 256; a service model is
whatever it returns — `GET /memory/status` reports the models in the index). With the column in
place, the shortlist query can order by `embedding <=> $1` and the blend stays as it is. Nothing
else changes, and a deployment without the extension keeps working exactly as before.

## Security alerts

`security:scan` runs every fifteen minutes and compares each person's last 24 hours of exports,
downloads, refused permissions and failed logins with **their own** previous 30 days. Thresholds
are floors in `src/security/anomalies.ts` (`THRESHOLDS`); a person's usual day can only raise
them. Six kinds are raised: `OFF_HOURS_EXPORT`, `DOWNLOAD_SURGE`, `OUT_OF_SCOPE_ACCESS` (skipped
for org-wide roles — executives, PMO, finance, legal), `DENIAL_SURGE`, `LOGIN_FAILURES` and
`TOKEN_REUSE` (always CRITICAL).

A new HIGH or CRITICAL alert notifies every holder of `admin.audit` except the person it is about.
Alerts never lock an account or end a session on their own — `TOKEN_REUSE` is the only exception,
and that revocation is done by the auth layer when the reuse happens, not by the scanner. Review in
the admin screen: **بررسی کردم** needs no note; **مشکلی نبود** needs a reason; nobody reviews an
alert about themselves. Every review is written to the audit trail as `SECURITY_ALERT_REVIEWED`.

## API keys and webhooks

Roadmap #46. `webhooks:dispatch` runs every minute: it reads each active subscription forward
through `state_transitions` from its cursor and sends what is due, so an event reaches a receiver
within about a minute. Deliveries, their attempts and last errors are under **مدیریت ←
یکپارچه‌سازی**.

- A key's per-minute budget is counted in the API process; with several API instances behind a load
  balancer each has its own count. The global per-IP limit still applies to every request.
- Revoking a key or deactivating its creator takes effect on the next request. Rotating a key is
  creating the new one, switching the receiving system, then revoking the old.
- A leaked webhook secret: replace it by creating a new subscription (a new secret) and stopping
  the old one; the receiver should accept both only during the switch.
- Key activity is audited as the creator's, with the key named (`apiKeyId`). The audit-trail
  detectors (#26) read it as the creator's too: a key that exports at night raises the alert on its
  creator, and the audit rows the alert cites carry the key's id.

## سامانهٔ مؤدیان

Roadmap #32. `moadian:run` runs every ten minutes: it sends queued submissions and asks after sent
ones. A transport failure leaves a submission queued and is retried; the fifth attempt marks it
`FAILED`. A refusal from the authority is kept with its reasons (`errors`).

Going live — the transport follows the public SDKs of the authority's API and has not been
exercised against the authority from this repository:

1. Register the organisation's key in the authority's portal and obtain the fiscal memory id.
2. Enter the memory id and identifiers under **مالی ← سامانهٔ مؤدیان** (finance manager).
3. Set `MOADIAN_MODE=live`, `MOADIAN_URL` to the authority's **test** environment, and the key and
   certificate paths. Report one invoice and check it in the authority's portal.
4. Only then point `MOADIAN_URL` at production.

Every submission keeps the payload exactly as prepared, so what the authority received can be shown
even when it disagrees with the invoice as it stands today.

## Client approval links

Roadmap #35. Clients open `/approve/<secret>` on the web app, which calls
`/api/v1/public/approvals/*` — the only API paths that answer without a session. Both must be
reachable from outside when the rest of the application is not: publish those two prefixes at the
reverse proxy, set `PUBLIC_APP_URL` to the address clients will use, and keep the rest internal if
that is the deployment's shape. The API limits them to 30 requests a minute per address (codes 5).

With `MAIL_ENABLED` on, the link goes to the contact's email and the decision takes a one-time
code sent to the same address; with mail off, the requester is shown the link once and decisions
are verified by the link alone — the certificate says which.

A sealed approval cannot be updated (trigger `client_approvals_sealed`) and the event log cannot
be rewritten (`client_approval_events_append_only`). Someone who disables a trigger can still change
a row, which is why `GET /client-approvals/:id/verify` recomputes everything and the client's
receipt email carries the decision's hash. Approved files stay in `STORAGE_DIR` even when their
document is deleted in the application — back the directory up with the database; a restore
without it leaves approvals that verify as `FILE_MISSING`.

## Export to the accounting package

Roadmap #33. No job and no configuration outside the application: the finance manager sets the
account codes and the file layout under **مالی ← خروجی حسابداری**, and posts batches from there.

Setting up an organisation's package:

1. Export a voucher template from the package's own import screen and copy its column order and
   headings into the layout; choose the date format it expects.
2. Post a first batch up to an early date, import it into a **test company** in the package, and
   compare the trial balance with the batch's totals before importing into the live company.
3. If a batch was imported wrongly, delete it in the package and import the same file again —
   `GET /accounting/exports/:id/file` returns it byte for byte. A batch is never re-posted from
   Hiva: its records are marked, and posting them again would count them twice.

What the export leaves to the accountant: matching an advance with the invoice that follows it;
period-end revenue adjustments for work in progress (the figures are in the revenue report, #29);
supplier bills as payables — a payment out is posted to project cost when it is paid.

The file is kept in `accounting_exports.content`; the table's check constraint refuses a batch
whose debits and credits differ.

