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
| 4 | Effective-dated rule sets | — | Verified | e73d4dc |
| 1 | Process mining and conformance | — | Verified | fbc8a47 |
| 5 | Rule lab — replay history under a changed policy | 1, 4 | Verified | cf4a0c0 |
| 14 | Time logging and cost accuracy | — | Verified | e10973e |
| 10 | Critical path and Gantt | 13 | Verified | 0e7c2d1 |
| 11 | Monte Carlo delivery forecast | 13, 14 | Verified | 4b85505 |
| 12 | Capacity-aware assignment | 13 | Verified | bfaa4a1 |
| 8 | SLA breach prediction | 13 | Verified | f00170a |
| 17 | Conditional routing and approval | — | Verified | b2ba689 |
| 18 | Approval chains and quorum | 17 | Verified | b8b9f6d |
| 15 | No-code form designer | 16 | Verified | 671c78a |
| 19 | Offline forms (PWA) | — | Verified | e364cf2 |
| 21 | Semantic search over organisational memory | — | Verified | 8295207 |
| 44 | Lessons-learned surfacing at project start | 21 | Verified | f2d57fe |
| 25 | Brief quality scoring | — | Verified | 8c853cf |
| 24 | Estimation assistant | 14 | Verified | 52cab17 |
| 22 | Automated QC, stage zero | — | Verified | 142ebb5 |
| 26 | Anomaly detection on the audit trail | — | Verified | e4cfea0 |
| 23 | Meeting → minutes → tasks | — | Verified (audio transcription: Adapter) | b62cc74 |
| 27 | Natural-language reporting | 1, 21 | Verified (model fallback: Adapter) | 0a330e6 |
| 28 | Multi-currency with dated rates | — | Verified | a70990c |
| 29 | Revenue recognition and WIP | — | Verified | 5fcbf00 |
| 31 | Media commission | 28 | Verified | 703d6c9 |
| 46 | Public API keys and webhooks | — | Verified | 54105b2 |
| 32 | Moadian e-invoicing | 46 | Verified (live transport: Adapter) | 369fcb1 |
| 33 | Accounting-package export | 46 | Verified | 8b01026 |
| 35 | Client approval with evidentiary weight | — | Verified | e70f92e |
| 34 | Client portal | 35 | Verified | 59b1b56 |
| 36 | Contract e-signature | 46 | Verified (live provider: Adapter) | fda3fd5 |
| 39 | Live updates (SSE) instead of polling | — | Verified | next |
| 40 | Two-way messenger integration | 46 | Pending | |
| 38 | Annotation on deliverables | — | Pending | |
| 42 | Digital asset management with versioning | — | Pending | |
| 43 | Brand-identity compliance check | 42 | Pending | |
| 47 | Extension points on guards and effects | — | Pending | |
| 48 | Migration and onboarding toolkit | 20 | Pending | |
| 49 | Mobile for the three short-SLA loops | 39 | Pending | |
| 50 | Multi-tenancy and on-premise installer | — | Pending | |
