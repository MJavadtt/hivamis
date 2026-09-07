# Market analysis and competitive positioning

## Method and limits

Research combined a live web survey of the 2026 agency-software market with structural analysis
of the incumbents' published capabilities. This is a **capability and positioning analysis**, not
a verified feature audit: statements about competitors reflect their public positioning and
independent commentary, not hands-on testing of each product. Where a claim is inference rather
than a vendor statement, it is marked as such.

## Identifying the real competitive set

The brief asked for a survey of CRM (Salesforce, Dynamics 365, HubSpot, Zoho, Pipedrive…),
ERP (SAP, Oracle, NetSuite, Odoo, ERPNext…) and project management (Jira, Asana, Monday, ClickUp,
Wrike, Smartsheet, Linear…). Those markets set the *usability baseline* — global search, saved
views, keyboard access, contextual actions, permission-aware navigation — and Hiva OS adopts that
baseline.

But they are not the competitive set. Hiva is a full-service advertising agency whose operating
model is briefs, creative production, media, traffic and three-level QC. The products actually
competing for this budget are **agency management platforms**:

| Product | Positioning |
|---|---|
| Workamajig | Advertising/marketing agencies; traffic, resourcing, projects, finance. Distinctive in handling media commissions |
| Productive.io | Agency management with the strongest capacity forecasting for 15–50 person agencies |
| Scoro | All-in-one for consultancies and agencies; strongest financial management and reporting |
| Deltek WorkBook | Enterprise agency suite: projects, people, finance |
| Kantata | The usual choice above ~100 people |
| Synergist, Ravetree | Mid-market agency management |

Horizontal CRM/ERP/PM tools appear in this market only as assemblies — Jira plus HubSpot plus a
spreadsheet plus Xero — which is precisely the fragmentation Doc_H's «Single Source of Truth»
rule exists to end.

## What the incumbents do well

Taken together, the agency platforms cover: project and task management, resource planning and
capacity forecasting, time tracking, budget versus actual, invoicing and profitability, a CRM
layer, client portals, and — in the enterprise tier — media buying and commissions. Hiva OS
does not out-build them on any of these. It matches the necessary subset and treats the rest as
either out of scope (general ledger) or future work (Gantt, e-signature).

## Where they leave a gap

Across the set, the same structural gap appears: **these tools model work, not governance.**
They will happily let you:

- start a project with no signed contract;
- deliver an output that never passed quality control;
- let an execution unit quote a price to a client;
- act on a scope change before anyone costed it;
- close a project with no client sign-off, no feedback and unclear finances;
- create a task from a corridor conversation with no source document.

Every one of those is a rule Doc_H writes down explicitly — and a rule that, in practice, is
enforced by memory and discipline rather than by the system. Doc_H itself names the failure mode:
«هیچ Task شفاهی معتبر نیست» and «اطلاعات پروژه باید در یک محل رسمی و قابل رهگیری ثبت شود».

An organisation that has written fifteen governing rules, 130 forms and a 52-step RACI matrix has
already decided that governance is the product. No tool in the set sells that.

## Positioning

**Hiva OS is a governance-enforcing agency operating platform.** The differentiation is not a
feature list; it is that the rules are structural rather than advisory.

| Capability | Agency platforms | Hiva OS |
|---|---|---|
| Projects, tasks, resourcing, invoicing | Mature, often deeper | Present at the depth Doc_H requires |
| Client portal, time tracking, media commissions | Present in the leaders | Not built |
| General ledger accounting | Scoro / Deltek strongest | Out of scope by decision |
| Gantt and critical path | Standard | Not built (milestones and timeline are) |
| **Enforced execution authorisation** | Not offered | Three legal bases, checked before ACTIVE |
| **Enforced three-level QC** | Not offered | Per-level permissions; delivery blocked without Account QC |
| **Revision governance with mandatory cause** | Not offered | Reason is non-null; failed QC auto-raises the revision |
| **Commercial-impact gate on scope change** | Not offered | Six dimensions required before the client is asked |
| **Sales/Account separation in the permission model** | Not offered | Disjoint permission sets |
| **Cost/price separation of duties** | Not offered | Declare ≠ set ≠ approve, three different roles |
| **Eight-condition closure gate** | Not offered | Enforced, not a checklist |
| **Every form as a routed, approved, SLA-tracked object** | Partial (custom fields) | 130 forms, schema-driven |
| **Working-hours SLA engine** | Rare | 30 policies on the organisation's own calendar |
| **AI that is permission-bound and useful without a model** | Emerging, model-dependent | Deterministic rule findings first; model additive; fully audited |

## Honest assessment

Hiva OS would lose a feature-by-feature comparison against Workamajig or Scoro on breadth. It has
no client portal, no time tracking, no media-buying module, no general ledger, no Gantt.

It wins on exactly one axis, and it is the axis Doc_H cares about: an agency running Hiva OS
**cannot** skip authorisation, cannot deliver unreviewed work, cannot let a unit quote a price,
cannot implement an uncosted change, and cannot close a project with loose ends. In the
alternatives, all of those depend on people remembering.

## Prioritised gaps, if the platform continues

| Gap | Value | Effort | Note |
|---|---|---|---|
| Time tracking | High — feeds real cost and utilisation | Medium | Would make traffic and margin figures actuals rather than estimates |
| Email/calendar integration | High — Doc_H §7 leaks through inboxes | Medium | Meeting minutes and client threads pulled into the record |
| Gantt + critical path | Medium | Medium | Schema already carries `task_dependencies` |
| Client portal | Medium | High | Would move client approvals inside the audit trail |
| SSO + MFA | Medium | Low–Medium | Enterprise procurement requirement |
| E-signature | Medium | Low | Contract signature is recorded, not executed |
| Media buying and commissions | Low unless media is a large revenue share | High | Workamajig's genuine moat |

## Sources

- [Best Agency Management Software 2026 — Synergist](https://www.synergist.co.uk/guides/best-agency-management-software)
- [Best Productive.io Alternatives for Agencies 2026 — Workamajig](https://www.workamajig.com/blog/productive-alternatives)
- [Scoro Alternatives for Agencies 2026 — Workamajig](https://www.workamajig.com/blog/scoro-alternatives)
- [Deltek WorkBook Alternatives & Competitors 2026 — SoftwareWorld](https://www.softwareworld.co/competitors/deltek-workbook-alternatives/)
- [Best Agency Management Software in 2026 — AgencyPro](https://agencypro.app/best/agency-management-software)
- [Modular Architecture: The Enterprise Blueprint for 2026 — Gart](https://gartsolutions.com/modular-architecture/)
- [Composable CX Will Replace Monolithic CRM Platforms — CX Today](https://www.cxtoday.com/crm/composable-cx-replace-monolithic-crm/)
