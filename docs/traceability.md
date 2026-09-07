# Requirements traceability

Every Doc_H requirement mapped to its implementation and the test that proves it.
Test IDs refer to files under [`apps/api/tests/`](../apps/api/tests).

## Governing rules — `قوانین و دستورالعمل حاکم بر فرآیند اجرای پروژه‌ها`

| # | Requirement | Domain / API | Enforcement | Test |
|---|---|---|---|---|
| 1 | Account owns customer relationship after contract | `Project.accountOwnerId`, `Handoff`, `RaciAssignment` | RACI required before ACTIVE | 002 §7 |
| 2 | Sales / Account separation | `ROLE_PERMISSIONS` | Disjoint permission grants | 001 §Rule 2 (4 tests) |
| 3 | Single customer communication owner | `Handoff` + Account-only client transitions | Permission on `deliverable.deliver` | 002 §12 |
| 4 | Unit responsibilities | `WorkOrder`, `Task`, `QcReview`, `CostDeclaration` | `UNIT_CORE` grants | 002 §3–4 |
| 5 | Outsourcing / freelancer process | `OutsourceRequest`, `Supplier`, `SupplierEvaluation` | Two-stage approval workflow | seeded + engine tests |
| 6 | No valid verbal task | `Task.sourceType`, `Task.sourceRef` | Non-null + enum of six documents | 001 §Rule 6 (2 tests) |
| 7 | Single source of truth | `AuditEvent`, `StateTransition` | Written in the same transaction | 003 §Audit (2 tests) |
| 8 | Change control | `ChangeRequest` six impact fields | `change.impactAssessed`, `change.readyForImplementation` | 001 §Rule 8 (3), 002 §8/9/10 |
| 9 | Three-level QC | `QcReview.level`, `qc.unit/account/final` | Per-level permission + `deliverable.accountQcPassed` | 001 §Rule 9 (3), 002 §4 |
| 10 | No revision without reason | `Revision.reason` (non-null) | Schema + auto-raise on failed QC | 001 §Rule 10 (2), 002 §4 |
| 11 | Timeline ownership | `Project.plannedStart/End`, `Task.dueDate`, `Risk` | `task.block` requires a reason | 002 §11 |
| 12 | Financial governance | `CostDeclaration`, `Proposal.salePrice` | `declare_cost` ≠ `set_price` ≠ `approve`, self-approval blocked | 001 §Rule 2, 002 §5/6 |
| 13 | Project start authorization | `ExecutionAuthorization` | `hasValidAuthorizationBasis`, `isAuthorized` | 001 §Rule 13 (3), 002 §7 |
| 14 | Reporting content | `StatusReport` — nine mandatory sections | Schema | 002 §11 |
| 15 | Project closure | `ClosureChecklist` — eight conditions | `closureChecklistComplete` | 001 §Rule 15, 002 §12 |

## Customer lifecycle — `الگوریتم جامع مسیر مشتری` (steps 1–100)

| Doc_H section | Steps | Implementation | Test |
|---|---|---|---|
| A — Acquisition and conversion | 1–9 | `Lead` → `Opportunity` → `Brief`; `POST /leads/:id/convert` | 002 §1 |
| A — Control point: incomplete brief | — | `brief.isComplete` guard, `returnCount` | 002 §2 |
| B — Analysis and proposal design | 10–20 | `Brief` review, Kick-off meeting, `Project`, scope, RACI, `WorkOrder` | 002 §3 |
| C — Production | 21–32 | `WorkOrder` accept/clarify/execute, `Deliverable`, `CostDeclaration` | 002 §3–5 |
| D — Integration and Account QC | 33–40 | `QcReview` level ACCOUNT, `Revision`, `proposal.integrate` | 002 §4–5 |
| E — Pricing and Final QC | 41–51 | `POST /proposals/:id/pricing`, `/pricing/approve`, `QcReview` FINAL | 002 §5/6 |
| F — Handover to Sales and negotiation | 52–55 | `deliver_to_sales`, `present`, client decision transitions | 002 §5/6 |
| G — Contract and authorization | 56–64 | `Contract` workflow, `ExecutionAuthorization` | 002 §7 |
| H — Formal execution | 65–80 | Handoff, execution kick-off, schedule, tasks, traffic, reporting | 002 §7/11 |
| I — Change management | — | `ChangeRequest` full chain + `Amendment` | 002 §8/9/10 |
| J — Project closure | 81–92 | Final delivery, `Settlement`, `ClosureChecklist`, `Feedback`, `LessonLearned` | 002 §12 |
| K — Retention and repeat sale | 93–100 | Customer health from feedback, new `Opportunity`, Customer 360 | 002 §13 |

### Recurring cycles

| Cycle | Doc_H | Test |
|---|---|---|
| 1 — Incomplete information | Brief returned to Sales and completed | 002 §2 |
| 2 — Output revision | Unit output → Account QC → fail → revision → re-QC | 002 §4 |
| 3 — Proposal revision | Client feedback → Account → unit → QC → Sales | 002 §5/6 |
| 4 — New proposal | Rejection restarts from analysis | Workflow definition (`client_reject`) |
| 5 — Scope change | Request → scope → price/time → customer approval | 002 §9/10 |
| 6 — Repeat sale | Closure → new need → new opportunity | 002 §13 |

## Forms — `دسته‌بندی فرم‌های ارتباطی و انتقال داده شرکت`

All 130 forms are defined in
[`packages/contracts/src/forms-a-f.ts`](../packages/contracts/src/forms-a-f.ts) and
[`forms-g-n.ts`](../packages/contracts/src/forms-g-n.ts), and seeded into `form_definitions`.

| Category | Forms | Range | Module |
|---|---|---|---|
| A — CRM and sales | 8 | 1–8 | CRM_SALES |
| B — Account and project analysis | 11 | 9–19 | ACCOUNT_MANAGEMENT / PROJECT_PMO |
| C — Orders to execution units | 7 | 20–26 | CREATIVE_PRODUCTION / MEDIA_DIGITAL |
| D — Internal unit execution | 10 | 27–36 | TRAFFIC_TASK |
| E — Quality control | 8 | 37–44 | QUALITY_CONTROL |
| F — Proposal and pricing | 8 | 45–52 | FINANCE / QUALITY_CONTROL |
| G — Sales ↔ Account | 7 | 53–59 | CRM_SALES / ACCOUNT_MANAGEMENT |
| H — Contract and legal | 10 | 60–69 | CONTRACT_LEGAL |
| I — Finance | 12 | 70–81 | FINANCE |
| J — Project management and traffic | 14 | 82–95 | PROJECT_PMO / TRAFFIC_TASK |
| K — Reporting | 8 | 96–103 | REPORTING_CUSTOMER_SUCCESS |
| L — Customer communication | 9 | 104–112 | REPORTING_CUSTOMER_SUCCESS |
| M — Project closure | 11 | 113–123 | PROJECT_PMO / FINANCE |
| N — Customer development | 7 | 124–130 | CRM_SALES |

Each carries its Doc_H contract — `senderDepts`, `receiverDepts`, `approverRoles`, `slaCode`,
`nextProcessFa` — verified by the catalogue-completeness tests in `004-engines.test.ts`.

## ERP modules

The ten modules Doc_H mandates, each backed by real domain tables, APIs and screens:

| # | Module | Primary tables | UI |
|---|---|---|---|
| 1 | CRM & Sales | leads, opportunities, companies, contacts, activities | Leads, Opportunities, Customers, Customer 360 |
| 2 | Account Management | briefs, proposals, handoffs | Briefs, Proposals |
| 3 | Project Management / PMO | projects, milestones, raci, risks, issues, decisions | Projects, Project 360 |
| 4 | Traffic & Task Management | tasks, allocations, work_orders | Tasks, Work orders, Traffic board |
| 5 | Creative & Production | work_orders + deliverables (ST/CR) | Work orders, Project 360 → Execution |
| 6 | Media & Digital | work_orders + deliverables (ME/DM) | Work orders, Project 360 → Execution |
| 7 | Quality Control | qc_reviews, revisions | QC console |
| 8 | Finance | invoices, payments, settlements, cost_declarations | Finance, Project 360 → Financial |
| 9 | Contract & Legal | contracts, amendments | Contracts |
| 10 | Reporting & Customer Success | status_reports, feedbacks, lessons_learned | Reports (5 surfaces) |

## KPIs — `data.pptx` slide 34

| Doc_H group | KPI | Where it is computed |
|---|---|---|
| Sales | Lead→Opportunity conversion, Win rate, Sales cycle, Average deal size | `GET /reports/sales` |
| Account | Brief completeness, Client retention, Customer satisfaction | `/reports/sales`, `/companies/:id/360` |
| Operations / PMO | On-time delivery, Resource utilisation, Project delay rate | `/reports/units`, `/traffic` |
| Execution units | On-time task delivery, First pass yield, Revision rate, Cost accuracy | `/reports/units` |
| Finance | Budget variance, Gross margin, Project profitability, Outstanding receivables | `/projects/:id/finance`, `/reports/executive` |
| Customer | CSAT, NPS, Revision/change rate, Retention | `/companies/:id/360`, `/reports/executive` |

## Coverage summary

| Category | Total | Implemented | Notes |
|---|---|---|---|
| Governing rules | 15 | 15 | All enforced server-side |
| Lifecycle steps | 100 | 100 | Sections A–K |
| Recurring cycles | 6 | 6 | |
| Forms | 130 | 130 | ~25 with typed domain bindings; the rest routed, approved and SLA-tracked |
| ERP modules | 10 | 10 | |
| SLA policies | 30 | 30 | Business-hours arithmetic |
| Organisational units | 10 | 10 | |
