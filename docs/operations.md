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
| `ACCESS_TOKEN_TTL` | no | 15m | |
| `REFRESH_TOKEN_TTL` | no | 7d | |
| `STORAGE_DIR` | no | ./storage | Uploaded documents |
| `MAX_UPLOAD_MB` | no | 25 | |
| `RATE_LIMIT_MAX` | no | 300 | Requests/minute per user or IP |
| `LOGIN_RATE_LIMIT_MAX` | no | 10 | Login attempts/minute per IP |
| `JOBS_ENABLED` | no | true | SLA ticking and digests |
| `ANTHROPIC_API_KEY` | no | — | Without it, AI falls back to the rule engine |
| `AI_ENABLED` | no | false | Both this and the key are required |
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

## Monitoring

| Signal | Where | Alert when |
|---|---|---|
| Liveness | `GET /health/live` | Two consecutive failures |
| Readiness | `GET /health/ready` | Database unreachable |
| SLA breaches | `GET /reports/sla` | `overall.breached` trending up |
| Data quality | `GET /reports/data-quality` | Any CRITICAL finding — especially an ACTIVE project with no authorization |
| Failed logins | `audit_events` where `action='LOGIN_FAILED'` | Spike from one IP |
| Permission denials | `audit_events` where `action='PERMISSION_DENIED'` | Sustained rise suggests a misassigned role |
| Job health | API logs, `pgboss` schema | `sla:tick` not logging for >15 min |

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
| Email / calendar | Notifications are in-app only. No SMTP, no calendar sync |
| Gantt and dependency scheduling | `task_dependencies` exists in the schema; critical-path computation and a Gantt view are not built. Milestones and a timeline are |
| Document versioning | Documents carry a `version` column and full audit, but there is no diff or rollback UI |
| E-signature | Contract signature is *recorded*, not executed. No e-signature integration |
| Full accounting | Project-level financial control per Doc_H — cost, revenue, margin, invoices, payments, settlement. Not a general ledger, and deliberately so |
| Search | PostgreSQL `ILIKE` with indexes. Fine for thousands of records; semantic search would need a vector store |
| Offline / mobile app | Responsive web only |
| Load testing | Not performed. Query patterns are indexed and paginated, but no benchmark under concurrent load has been run |

## Security operations

- Rotate `JWT_SECRET` by deploying a new value; all sessions invalidate, which is the intent.
- Deactivating a user (`POST /users/:id/deactivate`) revokes their sessions immediately.
- A password change revokes every session for that user.
- The audit trail is append-only in practice — nothing in the application updates or deletes
  `audit_events`. Consider a database-level revoke on UPDATE/DELETE for that table in production.
- Uploads are served as `application/octet-stream` with `nosniff` and forced download, so an
  uploaded SVG or HTML file cannot execute in a viewer's session.
