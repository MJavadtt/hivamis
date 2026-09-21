# User guide

Hiva OS follows the agency's own process. If you know your role in Doc_H, the system will feel
familiar — and it will stop you when a step is skipped.

## Signing in

Use your organisational email. What you see is decided by your role: navigation, buttons and
report tabs all appear only where you hold the permission. If a screen seems missing, it is
because the process assigns that step to someone else.

---

## Your queue — «کارهای من»

Everything that sits with you, in one list: tasks assigned to you, work orders you own, QC
waiting for your level, forms awaiting your approval, revisions assigned to you, and — if you
issue work orders — clarification requests from the units. Ordered by urgency: a breached SLA
first, then whatever runs out soonest, then by due date. Each row carries its own actions, so
you accept, submit or send to QC from the list. Filter by kind with the chips above it.

## Sales

**Your loop: acquire → qualify → brief → present → close.**

1. **Leads** — record a new lead, then move it Contact → Qualify. Converting creates the
   opportunity and, if needed, the customer record.
2. **Briefs** — write the sales brief and submit it to Account. The brief shows a completeness
   score; anything below 100% will be returned to you, so fill in objective, audience, scope,
   deliverables, budget and deadline before submitting.
3. **Proposals** — once Account delivers a proposal, present it and record the outcome:
   approved, revision requested, or rejected. A revision request must carry the client's exact
   wording — Account needs it to scope the rework.

**What you cannot do, by design:** set a sale price, authorise a project, or perform Account QC.
Doc_H §2 separates these loops, and the permission model enforces it.

---

## Account

**Your loop: receive brief → coordinate → integrate → price → deliver → run the project.**

1. **Brief control** — open the brief and review it. If it is incomplete, use *بازگشت بریف ناقص*
   with a reason; it goes back to Sales and the return is counted. Approve only a complete brief —
   the system will refuse otherwise.
2. **Project and orders** — create the project, define scope and deliverables, set RACI, and issue
   a work order to each unit. Every order must carry all nine mandatory elements; an incomplete
   order cannot be issued.
3. **Account QC** — as units deliver, record QC. A failed review **automatically raises a
   revision** carrying your findings as the required correction. Nothing reaches the client
   without a passing Account QC.
4. **Integration and pricing** — once every unit output is in and every cost is declared,
   integrate, then set the sale price with a written rationale. Someone with approval authority
   must confirm it — you cannot approve your own pricing.
5. **Execution** — after the contract is authorised, run the project from Project 360: tasks,
   traffic, risks, issues, change requests, status reports, and the closure checklist.

---

## Execution units (Strategy, Creative, Media, Digital)

**Your loop: accept → plan → execute → unit QC → declare cost → deliver.**

1. **Work orders** — accept within four working hours, or raise a clarification. The acceptance
   clock is visible and starts the moment the order is issued.
2. **Tasks** — accept, start, submit. If you will miss a deadline, report it *before* the deadline
   using the blocker action — Doc_H §11 requires the warning in advance.
3. **Unit QC** — record your own QC before handing anything to Account. You cannot submit a work
   order without it.
4. **Cost** — declare the actual cost. You cannot submit without it, and you cannot set the sale
   price: that belongs to the pricing process (Doc_H §12).
5. **Revisions** — when Account rejects an output, the revision arrives with the reason and the
   expected correction. Work it, resubmit, and it returns to QC.

---

## Finance

- **Invoices and payments** — issue proformas and invoices; totals are computed server-side.
  Recording a receipt rolls the invoice to partially paid or paid automatically.
- **Settlement** — settling a project computes invoiced, received and balance, and ticks the
  financial condition on the closure checklist.
- **Project financials** — Project 360 → Financial shows budget vs actual cost vs revenue, margin,
  and cost broken down by unit, all from declared costs.

---

## Legal

Drive the contract through drafting → legal review → approval → signature → registration.
Registering a contract sets the project's revenue baseline. Amendments update the contract value
and the project end date together.

---

## PMO / Operations

- **Traffic** — capacity versus committed hours per person, with over-allocation flagged. The
  window uses the organisation's real working calendar.
- **Reports → Units** — on-time delivery, first pass yield and revision rate per unit.
- **Reports → Data quality** — records that will silently break the process: an ACTIVE project
  with no authorisation, a task with no source document, overdue revisions. Treat CRITICAL
  findings as incidents.
- **Lessons learned** — record them at closure; they satisfy one of the eight closure conditions.

---

## Management

**Reports → Executive control tower** answers the questions Doc_H asks of management: what is
late, what is at risk, which projects are unhealthy, where margin is thin, what is awaiting
approval, and where money is stuck.

Your two gates:
- **Project authorisation** — no project enters execution without a contract, an approved
  official order, or an approved invoiced-execution order.
- **Pricing approval** — the sale price needs your confirmation, and it cannot be the same person
  who set it.

---

## Forms

**فرم‌ها** holds all 130 Doc_H forms. Each shows its route (from which unit to which), its
approver, its SLA, and the process it triggers. You can only submit forms your unit owns — the
rest are visible so you can see the shape of the process.

*در انتظار تأیید من* is your approval inbox. You cannot approve a form you submitted yourself.

---

## The AI assistant

Choose an analysis and its subject. You always get **rule-based findings** computed directly from
system data — rule violations, incomplete briefs, unassessed change impacts. These are
deterministic and cite the records they came from.

If a language model is configured, you also get a narrative over the same grounded data. If not,
the page says so plainly. The assistant never sees data you cannot see yourself, never changes
anything, and every request is logged.

---

## When the system blocks you

A refusal names the rule. For example:

> پروژه بدون مجوز معتبر وارد اجرا نمی‌شود.
> **قانون حاکم:** Doc_H §13 — شروع اجرای پروژه

That is the platform doing its job. The path forward is to satisfy the rule — record the
authorisation, complete the brief, assess the change impact — not to work around it.
