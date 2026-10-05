# Operations

## Deployment

### Docker, with the installer (recommended)

Roadmap #50. On a machine with Docker, Docker Compose v2 and `openssl`, from a checkout of the
repository:

```bash
infrastructure/hivamis install --org-name "آژانس نمونه" --org-slug nemooneh \
  --admin-email boss@nemooneh.ir --admin-name "پرستو نمونه" --domain hiva.nemooneh.ir
```

The installer:

1. writes `.env` from `.env.docker.example`, with a database password and token key generated on
   the spot, readable only by its owner;
2. sets `PUBLIC_APP_URL` and `CORS_ORIGIN` to `https://<domain>`, or `http://localhost:<port>`
   without `--domain`;
3. builds and starts the stack and waits until the API is ready. The API migrates the database
   and brings the reference data up first;
4. creates the organisation and its first system administrator. The administrator has no
   password: the installer prints a one-time link (valid seven days) where they set their own, and
   emails it when mail is configured.

It refuses to run where `.env` already exists, so an installation's secrets are never overwritten.
`--port` changes the published port (8080); `--multi` sets up an installation for several
organisations.

Serves on `http://localhost:8080`. Only the web container publishes a port; the API and database
are reachable only on the internal network.

### Docker, by hand

```bash
cp .env.docker.example .env
# Required:
#   POSTGRES_PASSWORD=$(openssl rand -base64 32)
#   JWT_SECRET=$(openssl rand -base64 48)
docker compose up -d --build
docker compose exec -T api node dist/cli.js tenant:create --name "…" --slug … --admin-email … --admin-name "…"
```

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

## Reference data and seeding

The reference data comprises units, roles and permissions, the 30 SLA policies and the 130 form
definitions. **It comes from the code, and is brought up to it on every start of the API**
(roadmap #50, `REFERENCE_SYNC=on`):

- every organisation in service gets what is missing;
- what the catalogue still speaks for is refreshed;
- nothing an organisation made its own is taken back: a form edited in the designer, SLA hours its
  administrator set, its units' colours.

The sync runs as one transaction behind an advisory lock, so replicas starting together take
turns. Each run that changed something is recorded in `system_upgrades`. To run it by hand:
`node dist/cli.js reference:sync [--slug s]`.

`pnpm db:seed` is for development. It creates the demo organisation, brings its reference data up
through the same sync, and loads the demo dataset when `SEED_DEMO_DATA=true` outside production.
**A production installation does not need the seed**: its first organisation and administrator
come from `tenant:create`, as the installer does.

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
| `EXTENSIONS_DIR` | no | unset | Modules that add guards and effects to the workflow engine (roadmap #47). Loaded at boot; a broken one stops the boot. See [Extensions](#extensions) |
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
| `ESIGN_MODE` | no | `sandbox` outside production, `off` in production | Contract e-signature (roadmap #36): `off` — signatures are recorded by hand; `sandbox` — an in-process stand-in, **not** a legal signature; `http` — a provider behind the contract below |
| `ESIGN_URL` · `ESIGN_API_KEY` | for `http` | — | The provider bridge's base URL and bearer key |
| `ESIGN_WEBHOOK_SECRET` | for `http` | — | HMAC key for the provider's callbacks; without it every callback is refused |
| `MESSENGER_MODE` | no | `sandbox` outside production, `off` in production | Messenger (roadmap #40): `sandbox` — an in-app chat; `bale` / `telegram` — a bot on the Bot API; `off` |
| `SMS_MODE` | no | `sandbox` outside production, `off` in production | One-time codes by SMS (Hivamis task 4): `sandbox` keeps messages for an administrator to read (Admin → Users); `kavenegar` uses Kavenegar's verify/lookup; `http` POSTs `{ to, text }` to `SMS_URL`; `off` hides signing in and joining by mobile |
| `SMS_API_KEY`, `SMS_TEMPLATE`, `SMS_URL` | with `kavenegar` / `http` | — | The provider's key; Kavenegar's verify template (one token, the code); the `http` endpoint |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | for Google sign-in | — | An OAuth client of type "Web application"; register `PUBLIC_APP_URL` (or the first `CORS_ORIGIN`) + `/api/v1/auth/google/callback` as its redirect URI. Unset: no Google button |
| `GOOGLE_ALLOWED_DOMAINS` | no | — | Comma list of email domains allowed to ask to join with Google; signing in with an already-linked account is unaffected |
| `MESSENGER_BOT_TOKEN` | for `bale`/`telegram` | — | The bot's token. It appears in every Bot API URL; errors never repeat the URL |
| `MESSENGER_API_URL` | no | the provider's | Bot API base, e.g. a proxy in front of it |
| `MESSENGER_BOT_USERNAME` | no | — | Shown to people linking, and used for Telegram deep links |
| `MESSENGER_WEBHOOK_SECRET` | for `bale`/`telegram` | — | Path segment of the webhook and the Bot API secret token; without it no update is accepted |
| `MOADIAN_URL` | no | `https://tp.tax.gov.ir/requestsmanager/api/v2/` | The authority's API base. Point it at the authority's test environment for the first live submissions |
| `MOADIAN_PRIVATE_KEY_PATH` / `MOADIAN_CERTIFICATE_PATH` | for `live` | — | The taxpayer's private key (PEM) registered in the authority's portal, and its certificate (PEM, sent as `x5c`). Keep them out of the repository and readable only by the API process |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | no | made on first use | Web Push (roadmap #49): the key pair that names this server to the browsers' push services, base64url (65-byte public point, 32-byte private scalar). Unset, one pair is generated and kept in `server_keys`. Set it once in production — changing it silences every phone until its owner opens `/m` again. A mismatched pair is refused on first use |
| `VAPID_SUBJECT` | no | the app's https address, else `mailto:admin@<host>` | A `mailto:` or `https:` contact for the push services (Apple requires one) |
| `PUSH_DELIVERY` | no | `on` | `off` records pushes and sends none — for an installation with no route to the push services, and for tests. `/m` then says notices are off |
| `PUSH_SERVICE_HOSTS` | no | FCM, Mozilla, Apple, WNS | The push services a browser subscription may point at (each host and its subdomains). Anything else is refused on subscribe and at send; the connection also refuses internal addresses |
| `ANTHROPIC_API_KEY` | no | — | Without it, AI falls back to the rule engine |
| `AI_ENABLED` | no | false | Both this and the key are required. Also enables the model fallback of «پرسش از داده‌ها» (roadmap #27): a question the rules cannot map is sent — the question text and the metric list only, never data — to the model, which may only fill the same plan |
| `AI_MODEL` | no | claude-sonnet-4-5 | |
| `CHAT_MODE` | no | `ollama` | The chat assistant (Hivamis task 5): `ollama`, a model served by Ollama, or `off`. See [The chat assistant](#the-chat-assistant-local-model) |
| `OLLAMA_URL` | no | `http://127.0.0.1:11434` | Where Ollama listens. Keep it on the server or the internal network; what people ask is sent there |
| `OLLAMA_MODEL` | no | `qwen3:14b` | A model that supports tool calling and writes Persian |
| `CHAT_CONCURRENCY` | no | 1 | How many answers are written at once. Further questions wait their turn and are told their place |
| `GUIDE_VIDEO_MAX_MB` | no | 200 | Largest guide video (Hivamis task 8). Videos are kept in `STORAGE_DIR`, so back them up with it |
| `REFERENCE_SYNC` | no | `on` | Roadmap #50: on start, bring every organisation's reference data — roles, units, SLA policies, the form catalogue — up to the code. `off` leaves it to `cli reference:sync` |
| `TENANT_MODE` | no | `single` | Roadmap #50: `single`, one organisation; `multi`, several, each found by its host names. See [Several organisations](#several-organisations) |
| `APP_VERSION` | no | the API package's version | Shown by `/health` and `status`, written into each reference sync. `hivamis upgrade` sets it from `git describe` |

## Backup and recovery

With the Compose stack, `infrastructure/hivamis` runs both inside the containers, so the host needs
no PostgreSQL tools:

```bash
infrastructure/hivamis backup                    # → backups/hiva-db-….dump, backups/hiva-storage-….tar.gz
infrastructure/hivamis restore --db backups/hiva-db-20261005-020000.dump \
                               --storage backups/hiva-storage-20261005-020000.tar.gz --yes
```

`backup` prunes files older than `RETENTION_DAYS` (default 30) from `HIVAMIS_BACKUP_DIR` (default
`./backups`). `restore` stops the application, leaving the database up, replaces the database (and
the files, if given), starts the application again and waits until it is ready. It refuses without
`--yes`. Schedule the backup daily:

```cron
0 2 * * * cd /opt/hivamis && infrastructure/hivamis backup >> /var/log/hivamis-backup.log 2>&1
```

Without Docker, the scripts below do the same against `DATABASE_URL` and `STORAGE_DIR`:

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

## Upgrading

```bash
infrastructure/hivamis upgrade --pull
```

The upgrade:

1. takes a backup first (`--no-backup` skips it);
2. updates the checkout (`--pull` runs `git pull --ff-only`; without it, the files already in place
   are used);
3. rebuilds the images, stamped with `git describe` as `APP_VERSION`;
4. restarts the stack. On start the API applies new migrations, then brings every organisation's
   reference data up to the code: a form the new version changed reaches the organisations whose
   form it still is, and an SLA policy it added is created. The operator does nothing else;
5. waits until the API is ready, and prints `status`: the version, the migrations applied, the last
   reference sync, and the organisations.

Before #50 the upgrade stopped at the migrations. The reference data stayed as the previous seed
left it, so a form changed in the catalogue kept its old fields until someone re-ran the seed by
hand. Going back is a restore of the backup the upgrade took.

## Several organisations

Roadmap #50. One installation can serve several organisations, each with its own units, users,
rules, forms, records and address.

- **The mode.**
  - `TENANT_MODE=single` (the default) serves one organisation, and provisioning refuses a second
    one, so it cannot be created by mistake.
  - `TENANT_MODE=multi` serves several. A request without a signed-in user (signing in, asking to
    join, the sign-in page) finds its organisation by host name. A signed-in request carries its
    organisation in its token, as always.
- **The commands**, through the API's CLI (`infrastructure/hivamis tenant …` inside the stack):

  ```bash
  infrastructure/hivamis tenant create --name "…" --slug acme --admin-email a@acme.ir --admin-name "…" --host hiva.acme.ir
  infrastructure/hivamis tenant list
  infrastructure/hivamis tenant update --slug acme --add-host acme.example.com
  infrastructure/hivamis tenant update --slug acme --suspend      # its sessions end now; --resume undoes it
  ```

- **Addresses.**
  - Point each organisation's host names at the installation, and list them with `--host` or
    `--add-host`. A host belongs to one organisation.
  - At an organisation's address, only its people sign in. Anyone else is told what a wrong
    password is told.
  - The installation's own address, which names no organisation, accepts everyone's sign-in.
  - Google sign-in returns to `PUBLIC_APP_URL`, so it completes at the installation's address.
- **A suspended organisation** keeps everything: nobody can sign in, its sessions stop refreshing,
  and its users see «سازمان شما موقتاً از دسترس خارج است».
- **What stays shared.**
  - Roles and permissions are the installation's definitions; each organisation grants them its
    own way (task 6).
  - Record numbers (PRJ-…) run on one sequence for the whole installation, so they never collide.
  - A person's email is unique across the installation.

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
| E-signature | Built as an adapter (roadmap #36): the flow, the sandbox and the REST contract are in the repository; a legally binding signature needs a provider bridge and its certificates — see «Contract e-signature» above |
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
downloads, files viewed in the app, refused permissions and failed logins with **their own**
previous 30 days. A view (`FILE_VIEW`, #42) counts once per person and file, so a page of
thumbnails is not a surge while many different files still are. Thresholds
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

## Live updates

Roadmap #39. Each API process keeps one extra PostgreSQL connection (`application_name = hiva-live`)
listening on `hiva_events`, opened with the first browser stream and closed with the last; triggers
on `state_transitions` and `notifications` publish to it on commit. Several API instances each listen,
so every instance's browsers hear every change. If the connection drops, it reconnects with backoff
and tells the browsers to re-read what they show.

Behind a proxy the stream must not be buffered: the API sends `X-Accel-Buffering: no`, which nginx
honours, and a heartbeat every 25 s keeps it under `proxy_read_timeout` (120 s in
`infrastructure/docker/nginx.conf`). A browser that cannot hold the stream falls back to polling
notifications and «کارهای من» every minute; while it is live, every five minutes. `pg` (already
installed as pg-boss's driver) is now a direct dependency of the API for this listener.

## Onboarding a new organisation

Roadmap #48, **راه‌اندازی سازمان** (under `admin.settings`). The order that works:

1. **Units** — give it the users file; it reads the unit names and suggests one of Doc_H's ten for
   each. Correct, save, confirm. A name left unmapped holds its people back at import.
2. **Users** — preview, then create. With mail on, each person gets a link by email; without it, the
   links are shown once — pass them on, they are not shown again (a fresh one can be issued from the
   same page). Grant `SUPER_ADMIN` by hand in user management; a file cannot.
3. **Calendar** — the working week and hours (every SLA clock runs on them), and the year's
   holidays from a file. Confirm.
4. **SLA** — Doc_H's hours; change any the organisation's contracts set differently. Confirm.
5. **Clients**, then **contacts**.
6. **Projects** already running, at the state they are in, with their authorization.

Every import can be run again with the same (or a corrected) file: what is already there is skipped.
Keep each organisation's source files; the audit trail records every `BULK_IMPORT` with its counts.

## Extensions

Roadmap #47. An organisation adds its own code rules without forking: `.js`/`.mjs` modules in
`EXTENSIONS_DIR`, loaded at boot in file-name order. `apps/api/extensions/examples` holds a working
example and the full contract (`README.md` there). What an operator needs to know:

- **Boot fails closed.** An extension that throws, names a transition that does not exist, or
  registers a key outside its own name stops the API from starting, with the reason in the log.
  Fix or remove it; a workflow must not look governed and not be.
- **It changes the rules.** Installing, upgrading or removing one gives the workflows rule set a new
  version (`/rules/versions`), with the extension's additions in the diff; transitions after it
  name that version.
- **It runs with the API's rights** — database included. Install only reviewed code, keep the
  directory writable only by the deploy user, and never make it reachable from the web app.
- **Effects run inside the transition's transaction.** A slow effect holds the move's locks; calls to
  outside systems belong in webhooks (#46).

The organisation's no-code rules (the «قوانین سازمان» page) need none of this: they are data,
written in the app under `rules.manage`, versioned in `custom_rules`.

## Files and versions

Roadmap #42. A new version never deletes the old one: every version stays in `STORAGE_DIR`, so
storage grows with each revision of a heavy file — plan disk for it, and back up the directory as
before. Deleting the current version (with `document.delete`) makes the previous one current again;
the file itself stays on disk, like every soft-deleted file.

What a file says about itself — pixel size and colour space, a video's length, a PDF's pages and
paper, a font's family — is read at upload from its headers, with no new dependency. The
`documents:metadata` job (hourly, at minute 37) reads files uploaded before this was in place, 50 at
a time; a file with nothing readable is marked `{}` and not read again.

Everything the app shows in place — thumbnails, the annotator, a compared version — is read
through `GET /documents/:id/preview`, audited as `FILE_VIEW` once per person, file and hour, not
as a download; the anomaly scan counts each distinct file viewed. The browser may keep a preview
for five minutes (`Cache-Control: private`), which is safe because a version's bytes never change.

The brand check (#43) reads each PNG, JPEG and PDF at upload, in the request: a PNG is inflated
and un-filtered, a JPEG is read for its DC coefficients only, a PDF for its content streams. On a
24-megapixel image that is 0.1–0.5 s of CPU; images over 60 megapixels are not read (reported as too
large). The same hourly `documents:metadata` job reads files uploaded before, 50 at a time; raising
`BRAND_SCAN_VERSION` in `src/brand/scan.ts` makes it read every file again.

Brand typefaces are previewed in the browser from the file's bytes (`FontFace` with an
`ArrayBuffer`), so the page's CSP needs nothing beyond what #38 added; thumbnails of PDF first
pages reuse the pdf.js already loaded for annotation.

## Annotation on deliverables

Roadmap #38. The web app shows PDF pages with pdf.js (`pdfjs-dist`), loaded only when a PDF is
opened for annotation — its worker is served from the app itself. The annotator reads files as
same-origin object URLs, so the page's CSP (`infrastructure/docker/security-headers.conf`) allows
`blob:` for `img-src` and `media-src`; a proxy that sets its own CSP must allow the same.

## Messenger

Roadmap #40. To connect a bot:

1. Create the bot in the messenger (Bale or Telegram) and take its token and username.
2. Set `MESSENGER_MODE`, `MESSENGER_BOT_TOKEN`, `MESSENGER_BOT_USERNAME` and a long random
   `MESSENGER_WEBHOOK_SECRET`; `PUBLIC_APP_URL` must be reachable from the messenger's servers.
3. In **مدیریت ← یکپارچه‌سازی ← پیام‌رسان**, **ثبت وب‌هوک ربات** registers
   `PUBLIC_APP_URL/api/v1/messenger/webhook/<secret>` with the bot.
4. Each person links from the sidebar's **پیام‌رسان**: a one-time code they send to the bot.

`messenger:send` runs every minute and retries what did not go out (five attempts). The live
transport follows the Telegram Bot API, which Bale's bot API mirrors; it has been exercised against a
stand-in, not against either service — link one person and approve one form end to end before
announcing it. Eitaa, Slack and Teams are not connected.

## Signing in with a mobile or Google, and asking to join

Hivamis task 4. Besides email and password, people can sign in with a six-digit code texted to a
mobile they verified (on their own page, «صفحهٔ من»), or with a Google account linked to them. Both
only prove who someone is; their roles still decide what they may do.

- **SMS.** Out of the box (outside production) codes go to the sandbox: Admin → Users shows them, so
  a developer can sign in without a provider. For real use set `SMS_MODE=kavenegar` with
  `SMS_API_KEY` and a verify template (`SMS_TEMPLATE`) whose single token is the code, or `http` with
  `SMS_URL` behind a small adapter for another provider. Outside the sandbox the code is never stored —
  only an HMAC of it in `otp_codes`, and the text with the code masked in `sms_outbox`.
- **Google.** Create an OAuth client (Google Cloud Console → APIs & Services → Credentials → Web
  application), add the redirect URI above, and set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. A
  verified Google address equal to someone's work email signs that person in and links the account;
  anyone else can only ask to join.
- **Asking to join** (`/signup`) is open while at least one of the two is available; the administrator
  can close it (Admin → Users → «پذیرش درخواست عضویت»). A request grants nothing: the administrator
  of users approves it and chooses the unit and roles (never system administration), or rejects it
  with a reason. The account has no password until its owner sets one on their own page.

## Notices on the phone

Roadmap #49. `/m` is the phone's screen for the three short-deadline loops; its bell turns on Web
Push for that browser. Nothing needs registering with Google, Apple or Mozilla: the browser names its
own push service, and the service trusts the VAPID key the subscription was made with.

1. For production, generate a key pair once and set it:
   `pnpm --filter @hiva/api exec tsx -e "import('./src/push/crypto.js').then(m=>console.log(m.generateVapidKeys()))"`
   → `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and a `VAPID_SUBJECT` (`mailto:` or `https:`).
2. The web app must be served over https (a service worker and the Push API need a secure origin;
   `localhost` counts as one for development).
3. The API needs outbound https to the push services: `fcm.googleapis.com` (Chrome, Edge, Android),
   `updates.push.services.mozilla.com` (Firefox), `web.push.apple.com` (Safari, iPhone from the home
   screen). Where those are unreachable — an installation with no internet, or a network that blocks
   them — set `PUSH_DELIVERY=off`; the messenger (#40) and email remain the ways to reach a phone.
   A phone's own browser also needs to reach its push service to receive anything.

`push:send` runs every minute and retries what the service was too busy for (four attempts); a
notice older than eight hours is dropped rather than sent late. A browser the service reports gone
(`404`/`410`) is switched off; one whose service refuses the key (`401`/`403`, usually after the key
changed) is switched off until its owner opens `/m`, which subscribes it again. What each service
answered is in `push_messages`. This has been verified against the RFC 8291 test vector and a push
service of the test suite's own; delivery through a real phone's service is the step to check with
**ارسال اعلان آزمایشی** on a phone before announcing it.

## Contract e-signature

Roadmap #36. `esign:run` runs every ten minutes: it reads every envelope still out back from its
provider and lets lapsed ones expire. The provider's callback (`POST /api/v1/esign/callback`) makes
that happen at once; it must reach the API from the provider's network.

A signature with legal weight is made with a certificate from a licensed certification authority,
on the provider's side. Hiva speaks one REST contract; connecting a provider means a small bridge
that translates it:

| Call | Request | Response |
|---|---|---|
| `POST {ESIGN_URL}/envelopes` | `{ externalId, title, document: { fileName, contentBase64, sha256 }, signers: [{ externalId, name, email, order }], callbackUrl, expiresAt }` | `{ id, signers: [{ externalId, url }] }` |
| `GET {ESIGN_URL}/envelopes/{id}` | — | `{ status: SENT\|COMPLETED\|DECLINED\|EXPIRED, signers: [{ externalId, status, signedAt?, declineReason?, ip?, certificate?: { subject, serial, issuer, notAfter } }] }` |
| `GET {ESIGN_URL}/envelopes/{id}/document` | — | the signed PDF |
| `POST {ESIGN_URL}/envelopes/{id}/void` | `{ reason }` | — |
| callback to `callbackUrl` | `{ id }` with `X-Hiva-Signature: sha256=<HMAC-SHA256(body, ESIGN_WEBHOOK_SECRET)>` | — |

Every call carries `Authorization: Bearer ESIGN_API_KEY`. Going live: build the bridge against the
provider's test environment, set `ESIGN_MODE=http` with its URL, key and secret, sign one contract
end to end, and check the signed PDF's signature in a PDF reader before production. Hiva keeps the
signed PDF and its hash and shows the certificate the provider reports; it does not itself validate
the signature embedded in the PDF.

The sandbox's page is `/esign-sandbox/<secret>` on the web app. Leaving `ESIGN_MODE` unset in
production means `off`.

## Client portal

Roadmap #34. Clients use `/portal/*` on the web app, which calls `/api/v1/portal/*`; like the
approval links, these must be reachable from outside if the rest of the application is not. Invitations
link to `PUBLIC_APP_URL/portal/invite/<secret>` (7 days). With mail off, the invitation link is shown
once to the person who created it.

A portal session is a 12-hour token held in the browser tab (`sessionStorage`), signed with a key
derived from `JWT_SECRET` for the portal alone — rotating `JWT_SECRET` signs every client out, as it
does staff. Five failed sign-ins lock a portal account for 15 minutes. **غیرفعال** on the client's
page, or a new invitation, ends every session of that account at once.

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

## The chat assistant (local model)

Hivamis task 5. The assistant in the top bar runs on a model served by
[Ollama](https://ollama.com) on the organisation's own machine. It has no per-question cost and no
quota, and nothing said to it leaves the network. Setting it up:

1. Install Ollama on the server, or on a machine the API can reach (`brew install ollama` on a Mac;
   the install script or package on Linux). Start it with `ollama serve`. On Linux the package runs
   it as a service.
2. Download the model:

   ```bash
   ollama pull qwen3:14b
   ```

   It is about 9 GB, needs about 10 GB of memory while answering, and fits a 16 GB machine. On a
   smaller machine use `qwen3:8b` and set `OLLAMA_MODEL`. A different family needs to support tool
   calling.
3. If Ollama is not on the API's own machine, set `OLLAMA_URL`. Do not expose Ollama to the
   internet: it has no authentication.

   With the Compose stack, the API container reaches Ollama on the host at
   `host.docker.internal:11434`, which is the default there. On Linux, Ollama only listens on
   127.0.0.1 out of the box. Make it listen on the Docker bridge as well, for example
   `OLLAMA_HOST=172.17.0.1:11434` in its service environment, rather than on `0.0.0.0`.

`GET /api/v1/ai/chat/status` reports `ready: true` when both are in place. Until then, the
conversation tells people the assistant is unavailable, and tells the system administrator how to
start it. The model stays loaded for 30 minutes after the last question. The first question after
that takes a few seconds longer while the model loads.

**Who has it.** The permission `ai.chat` («گفت‌وگو با دستیار») is in every role by default. A role
whose permissions an administrator already chose under Admin → Roles before this version keeps
those exact permissions, so tick `ai.chat` there to give that role the assistant. To turn the
assistant off for everyone, set `CHAT_MODE=off`.

**Capacity.** One answer is written at a time by default. Measured on a 16 GB Apple M1 Pro also
running the application, its database and a browser:

- The first question after the model was idle took about 40 seconds, most of it loading.
- After that, answers took 13 to 36 seconds.
- The model ran fully on the GPU. The time went to writing the answer, at a few words a second,
  because memory was short.

`qwen3:8b` answers roughly twice as fast with somewhat weaker Persian. On a server with a GPU and
spare memory, raise `CHAT_CONCURRENCY` along with Ollama's own `OLLAMA_NUM_PARALLEL`.

**What is kept.** Conversations are in `ai_conversations` and `ai_messages`, and are visible only to
their owner. Deleting a user deletes theirs. The AI governance log (`ai_interactions`, capability
`CHAT`) records the tools used, the records they touched, tokens and timing. It never records the
question or the answer.

## The guide owl and its videos

Hivamis task 8. The owl and its guide need no setup: the guide text ships with the application in
both languages, and the tours are drawn on the live page.

**Videos are the organisation's own.** None ship with the product. For each section, the system
administrator can add one screen recording per language. Open the page, click the owl, and use
**ویدیوی این بخش (مدیر سیستم)** at the foot of its panel. To record:

1. Record the screen with the operating system's own recorder (on a Mac, Shift-Command-5).
2. Convert it to MP4 (H.264) so every browser plays it and seeking starts at once:

   ```bash
   ffmpeg -i recording.mov -c:v libx264 -crf 26 -preset slow -pix_fmt yuv420p -movflags +faststart -an guide.mp4
   ```

   Leave out `-an` to keep the narration. Three minutes at 1080p is usually 20 to 40 MB.

A file over `GUIDE_VIDEO_MAX_MB` is refused. The Compose stack's nginx allows 210 MB on this one
path and streams uploads straight to the API. Raise both together, along with any other proxy in
front.

**Playing.** A browser's video player cannot send the sign-in token, so the app asks for a link that
plays that one video for three hours. The link is signed with `JWT_SECRET`, so changing the secret
ends every link that has been handed out. The video is served in byte ranges, which lets the player
seek without downloading the whole file.

**The 3D owl** loads three.js in its own chunk, about 125 KB compressed, the first time it appears. It
stops drawing while it is off screen or the tab is hidden. It holds still for people who asked their
system for reduced motion, and is drawn flat where WebGL is unavailable. People who prefer it gone
use **پنهان کردن هیوا** in its panel; the ? in the top bar still opens the guide.

