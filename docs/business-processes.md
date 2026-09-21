# Business processes as implemented

The source is Doc_H `الگوریتم جامع مسیر مشتری تا پایان پروژه` (100 steps, sections A–K),
the process flowchart, and the 52-step RACI/SLA/KPI matrix in `data.pptx`.

## The end-to-end lifecycle

```
Lead ──▶ Opportunity ──▶ Sales Brief
                              │
                    ┌─────────▼─────────┐
                    │ Brief completeness │◀── incomplete ──▶ back to Sales  (cycle 1)
                    └─────────┬─────────┘
                              ▼ complete
                          Kick-off ──▶ Project ──▶ Scope + Deliverables + RACI
                                                        │
                                                        ▼
                                              Project Orders to units
                                                        │
                                    ┌───────────────────▼───────────────────┐
                                    │ Accept → Plan → Execute → Unit QC (L1)│
                                    └───────────────────┬───────────────────┘
                                                        ▼
                                             Account QC (L2) ──failed──▶ Revision (cycle 2)
                                                        │ passed              │
                                                        ▼                     ▼
                                                  Integration ◀───────── rework + re-QC
                                                        ▼
                                        Cost declared → Pricing → Margin approval
                                                        ▼
                                                  Final QC (L3)
                                                        ▼
                                          Proposal ──▶ Sales ──▶ Customer
                                                        │
                        ┌───────────────────────────────┼──────────────────────────┐
                     approved                        revision                   rejected
                        │                               │                          │
                        ▼                        rework (cycle 3)          new proposal (cycle 4)
                    Contract
                        ▼
              Execution Authorization  ◀── Doc_H §13 gate
                        ▼
              Sales → Account handoff
                        ▼
              Planning → ACTIVE ──┬──▶ Change Request ──▶ scope? ──▶ impact ──▶ customer  (cycle 5)
                                  │
                                  ▼
                    Delivery → Client acceptance → Settlement
                                  ▼
                    Closure gate (8 conditions) ──▶ CLOSED
                                  ▼
                    Feedback → Lessons Learned → New need → Cross-sell  (cycle 6)
```

All six recurring cycles Doc_H names are implemented and covered by end-to-end tests.

## State machines

| Entity | States |
|---|---|
| Lead | NEW → CONTACTED → QUALIFIED → CONVERTED / DISQUALIFIED |
| Opportunity | NEW → QUALIFIED → BRIEF_REQUESTED → BRIEF_COMPLETED → PROPOSAL → NEGOTIATION → WON / LOST |
| Brief | DRAFT → SUBMITTED → UNDER_REVIEW → RETURNED_INCOMPLETE ⇄ APPROVED |
| Proposal | DRAFT → AWAITING_UNIT_OUTPUTS → INTEGRATION → PRICING → FINAL_QC → APPROVED → DELIVERED_TO_SALES → PRESENTED_TO_CLIENT → CLIENT_APPROVED / CLIENT_REVISION_REQUESTED / CLIENT_REJECTED |
| Project | DRAFT → PENDING_AUTHORIZATION → AUTHORIZED → PLANNING → ACTIVE ⇄ ON_HOLD → COMPLETED → PENDING_CLOSURE → CLOSED |
| Work order | DRAFT → ISSUED → PENDING_ACCEPTANCE → ACCEPTED → IN_PROGRESS → SUBMITTED → COMPLETED |
| Task | CREATED → ASSIGNED → ACCEPTED → IN_PROGRESS ⇄ BLOCKED → SUBMITTED → IN_QC → REVISION_REQUIRED / APPROVED → CLOSED |
| Deliverable | PLANNED → IN_PROGRESS → SUBMITTED → IN_QC → REVISION_REQUIRED / APPROVED → DELIVERED → ACCEPTED |
| Revision | REQUESTED → ASSIGNED → IN_PROGRESS → SUBMITTED → IN_QC → APPROVED / REJECTED |
| Change request | SUBMITTED → SCOPE_REVIEW → COMMERCIAL_REVIEW → PENDING_CUSTOMER_APPROVAL → APPROVED → IMPLEMENTING → CLOSED |
| Contract | REQUESTED → DRAFTING → LEGAL_REVIEW → INTERNAL_APPROVED → PENDING_SIGNATURE → SIGNED → REGISTERED |
| Invoice | DRAFT → ISSUED → SENT → PARTIALLY_PAID → PAID |
| Outsource request | REQUESTED → UNIT_MANAGER_REVIEW → MANAGEMENT_REVIEW → APPROVED / REJECTED → FULFILLED |

## The governing rules and where they live

| Rule | Doc_H | Enforcement |
|---|---|---|
| 1 | Account owns the customer after contract | `Project.accountOwnerId`; RACI; handoff object |
| 2 | Sales / Account separation | `ROLE_PERMISSIONS` — the split is in the permission grants themselves |
| 3 | Single customer communication owner | Handoff record + Account-only client-facing transitions |
| 4 | Unit responsibilities | Unit permissions: execute, unit QC, declare cost — never set price |
| 5 | Outsourcing process | `OutsourceRequest` workflow: unit manager → management |
| 6 | No valid verbal task | `Task.sourceType` + `sourceRef` non-null, six allowed values |
| 7 | Single source of truth | Every consequential action produces a persisted record + audit event |
| 8 | Change control | `change.impactAssessed` + `change.readyForImplementation` guards |
| 9 | Three-level QC | `qc.unit` / `qc.account` / `qc.final` permissions; `deliverable.accountQcPassed` guard |
| 10 | Revision governance | `Revision.reason` non-null; failed QC auto-raises a revision |
| 11 | Timeline ownership | Account owns project dates; units own task deadlines; delay reporting via `task.block` and risks |
| 12 | Financial governance | `pricing.declare_cost` vs `pricing.set_price` vs `pricing.approve`, all held by different roles |
| 13 | Project start authorization | `project.hasValidAuthorizationBasis` + `project.isAuthorized` guards |
| 14 | Reporting | `StatusReport` carries the nine mandatory sections Doc_H §14 lists |
| 15 | Project closure | `project.closureChecklistComplete` guard over eight conditions |

## SLA catalogue

All 30 policies come from Doc_H slide 33 and the RACI matrix, each storing its `docRef`.
Durations are business hours against the organisation calendar.

The column below is Doc_H's own wording. Two needed interpretation when encoded:
«۲۴ ساعت پس از جلسه» means 24 *calendar* hours — by the next working day — and is stored as one
working day, not 24 working hours, which across the Thursday–Friday weekend would be nearly a
week. «همان روز تأیید» is not a fixed duration at all, since approval at 09:00 and at 16:00 leave
very different amounts of the day; it is carried as a one-day approximation. Both are marked in
`packages/contracts/src/sla.ts`.

| Policy | Doc_H duration |
|---|---|
| Account acknowledges a new brief | 4 working hours |
| Brief completeness review | 1 working day |
| Task acceptance | 4 hours |
| Clarification | 4 hours |
| Account QC | 1 working day |
| Revision response | 4 hours |
| Pricing | 1 working day |
| Final QC | 1 working day |
| Proposal handover to Sales | same day |
| Post-contract handover | 1 working day |
| Execution kick-off | 2 working days |
| Change request response | 1 working day |
| Meeting minutes | 24 hours |
| Project closure report | 3 working days |
| Customer feedback | 7 days |
| Close project | 2 working days |

**Waiting on someone else.** A clock measures the party it was started against. When that party
is waiting — on the client for an answer, on a supplier for a proof, on another unit for an
input — the clock can be paused, always with a kind and a reason, by its owner or by traffic
management. The budget is untouched; the wait is not counted. Every clock then carries two
numbers: how long it has been open, and how much of that was ours. Only the second is a fair
basis for evaluating anyone, and it is the one the SLA report averages.

One pause is declared by the state machines themselves: a work order in `CLARIFICATION_REQUESTED`
pauses the unit's acceptance clock, because the unit is waiting on Account, whose own
clarification clock is running meanwhile. It resumes when the clarification is provided.

**Exceptions (governed waivers).** A guard that blocks a transition can be set aside by the CEO
or deputy for one record, once, with a reason, for at most thirty days. The transition that uses
it records which guard was waived and on whose authority; the register of exceptions is on the
executive dashboard and in the data-quality report. See ADR-019.

**Budget control at the order (Doc_H §12, §C).** Every work order carries a budget and every
cost declaration names its order, so the two are compared the moment a declaration lands. At
90% of budget the account owner and the declarer are warned; above 100% the warning is
critical. The project figure still exists, but it moves too late to act on — the unit figure is
where someone can still rescope. `GET /projects/:id/budget` shows every order and every unit.

**Weekly client report (Doc_H §14).** Every Saturday at 09:00 the system sends each active
project's latest status report of the week to the client company's primary contact, as a PDF
built for a reader outside the organisation — no financial status, no internal decisions, and
every cost or price figure withheld. An active project with no report that week produces a
warning to its account owner instead; a project whose client has no contact email is counted
as unaddressed in the job's log. Account can also preview and send at any time from the project.

## Organisational model

Ten units, codes exactly as Doc_H slide 30 defines them:
`S` Sales · `A` Account · `ST` Strategy · `CR` Creativity/Graphic/Production · `ME` Media ·
`DM` Digital Marketing · `FI` Finance · `LG` Legal/Contracts · `OP` Operations/PMO · `M` Management.

Sixteen roles map onto these units, each carrying the permission set its Doc_H responsibilities
imply and — as importantly — *not* carrying the permissions its counterpart holds.
