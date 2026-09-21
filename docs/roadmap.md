# Roadmap — the fifty

Fifty capabilities, each built on an asset the repository already has. Worked in the order
below, which is dependency order rather than the order they were proposed in: calendars before
scheduling, form versioning before the form designer, API keys before any integration.

Status vocabulary, and it is used strictly:

| Status | Meaning |
|---|---|
| Pending | Not started |
| Implemented | Code exists and type-checks |
| Tested | Automated tests pass |
| Verified | Exercised end-to-end against a running system |
| Adapter | The in-repo half is Tested; the live external connector needs credentials this repo cannot have |

| # | Capability | Depends on | Status | Commit |
|---|---|---|---|---|
| 9 | SLA pause / resume with reason | — | Verified | 435bf15 |
| 2 | Guard preflight — "why can't I?" before the click | — | Verified | 196526c |
| 3 | Time-travel audit and state reconstruction | — | Verified | f5e545a |
| 16 | Form versioning and submission pinning | — | Verified | 832ae49 |
| 41 | Unified work inbox (My Work) | — | Verified | 9ceda83 |
| 37 | Scheduled, branded client status report | — | Verified | a677ebd |
| 45 | Supplier and freelancer 360 | — | Verified | e83381d |
| 30 | Budget vs actual at work-order level | — | Verified | 8cb8ddf |
| 20 | Bulk import / export per form | 16 | Verified | daac98d |
| 13 | Calendars per unit and per person | — | Verified | c93cbf0 |
| 6 | Time-boxed delegation | — | Verified | 2b4ac78 |
| 7 | Governed waiver | — | Verified | f0d1ef1 |
| 4 | Effective-dated rule sets | — | Verified | next |
| 1 | Process mining and conformance | — | Pending | |
| 5 | Rule lab — replay history under a changed policy | 1, 4 | Pending | |
| 14 | Time logging and cost accuracy | — | Pending | |
| 10 | Critical path and Gantt | 13 | Pending | |
| 11 | Monte Carlo delivery forecast | 13, 14 | Pending | |
| 12 | Capacity-aware assignment | 13 | Pending | |
| 8 | SLA breach prediction | 13 | Pending | |
| 17 | Conditional routing and approval | — | Pending | |
| 18 | Parallel approval chains and quorum | 17 | Pending | |
| 15 | No-code form designer | 16 | Pending | |
| 19 | Offline forms (PWA) | — | Pending | |
| 21 | Semantic search over organisational memory (pgvector) | — | Pending | |
| 44 | Lessons-learned surfacing at project start | 21 | Pending | |
| 25 | Brief quality scoring | — | Pending | |
| 24 | Estimation assistant | 14 | Pending | |
| 22 | Automated QC, stage zero | — | Pending | |
| 26 | Anomaly detection on the audit trail | — | Pending | |
| 23 | Meeting → minutes → tasks | — | Pending | |
| 27 | Natural-language reporting | 1, 21 | Pending | |
| 28 | Multi-currency with dated rates | — | Pending | |
| 29 | Revenue recognition and WIP | — | Pending | |
| 31 | Media commission | 28 | Pending | |
| 46 | Public API keys and webhooks | — | Pending | |
| 32 | Moadian e-invoicing | 46 | Pending | |
| 33 | Accounting-package export | 46 | Pending | |
| 35 | Client approval with evidentiary weight | — | Pending | |
| 34 | Client portal | 35 | Pending | |
| 36 | Contract e-signature | 46 | Pending | |
| 39 | Live updates (SSE) instead of polling | — | Pending | |
| 40 | Two-way messenger integration | 46 | Pending | |
| 38 | Annotation on deliverables | — | Pending | |
| 42 | Digital asset management with versioning | — | Pending | |
| 43 | Brand-identity compliance check | 42 | Pending | |
| 47 | Extension points on guards and effects | — | Pending | |
| 48 | Migration and onboarding toolkit | 20 | Pending | |
| 49 | Mobile for the three short-SLA loops | 39 | Pending | |
| 50 | Multi-tenancy and on-premise installer | — | Pending | |
