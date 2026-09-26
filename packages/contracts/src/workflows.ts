import type { Permission } from './permissions.js';

/**
 * Declarative state machines. The API rejects any transition that is not declared here,
 * so an entity can never reach an illegal state via a stray UPDATE.
 *
 * `guards` name server-side predicates registered in apps/api/src/workflow/guards.ts. They encode
 * the Doc_H rules that RBAC alone cannot express — e.g. a project may not go ACTIVE without an
 * authorisation record, a proposal may not be APPROVED without a passing Final QC.
 */
export interface TransitionDef {
  readonly from: readonly string[];
  readonly to: string;
  /** Machine action name; the API exposes it as POST /:entity/:id/transitions/:action */
  readonly action: string;
  readonly labelFa: string;
  readonly labelEn: string;
  readonly permission?: Permission;
  readonly guards?: readonly string[];
  /** SLA policy code started when the entity ARRIVES in `to`. */
  readonly startsSla?: string;
  /** SLA policy codes stopped (met) when the entity LEAVES via this transition. */
  readonly stopsSla?: readonly string[];
  /**
   * SLA policy codes paused when the entity ARRIVES in `to`, because the party the clock
   * measures is now waiting on someone else. The clock keeps its budget; the wait is not
   * counted against it. Pair with `resumesSla` on the transition that ends the wait.
   */
  readonly pausesSla?: readonly string[];
  /** SLA policy codes resumed when the entity LEAVES via this transition. */
  readonly resumesSla?: readonly string[];
  /** Free-text reason is mandatory for this transition. */
  readonly requiresReason?: boolean;
}

export interface WorkflowDef {
  readonly entity: string;
  readonly labelFa: string;
  readonly initial: string;
  readonly states: readonly string[];
  readonly terminal: readonly string[];
  readonly transitions: readonly TransitionDef[];
}

export const LEAD_WORKFLOW: WorkflowDef = {
  entity: 'lead',
  labelFa: 'سرنخ',
  initial: 'NEW',
  states: ['NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'DISQUALIFIED'],
  terminal: ['CONVERTED', 'DISQUALIFIED'],
  transitions: [
    { from: ['NEW'], to: 'CONTACTED', action: 'contact', labelFa: 'برقراری ارتباط', labelEn: 'Contact', permission: 'crm.lead.write', stopsSla: ['SLA_LEAD_CREATE'] },
    { from: ['CONTACTED'], to: 'QUALIFIED', action: 'qualify', labelFa: 'واجد شرایط', labelEn: 'Qualify', permission: 'crm.lead.write' },
    { from: ['QUALIFIED'], to: 'CONVERTED', action: 'convert', labelFa: 'تبدیل به فرصت', labelEn: 'Convert', permission: 'crm.lead.convert' },
    { from: ['NEW', 'CONTACTED', 'QUALIFIED'], to: 'DISQUALIFIED', action: 'disqualify', labelFa: 'رد سرنخ', labelEn: 'Disqualify', permission: 'crm.lead.write', requiresReason: true },
  ],
};

export const OPPORTUNITY_WORKFLOW: WorkflowDef = {
  entity: 'opportunity',
  labelFa: 'فرصت فروش',
  initial: 'NEW',
  states: ['NEW', 'QUALIFIED', 'BRIEF_REQUESTED', 'BRIEF_COMPLETED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST'],
  terminal: ['WON', 'LOST'],
  transitions: [
    { from: ['NEW'], to: 'QUALIFIED', action: 'qualify', labelFa: 'نیازسنجی انجام شد', labelEn: 'Qualify', permission: 'crm.opportunity.write' },
    { from: ['QUALIFIED'], to: 'BRIEF_REQUESTED', action: 'request_brief', labelFa: 'درخواست بریف', labelEn: 'Request brief', permission: 'brief.write', startsSla: 'SLA_BRIEF_PREPARE' },
    { from: ['BRIEF_REQUESTED'], to: 'BRIEF_COMPLETED', action: 'brief_approved', labelFa: 'بریف تأیید شد', labelEn: 'Brief approved', permission: 'brief.approve', stopsSla: ['SLA_BRIEF_PREPARE'] },
    { from: ['BRIEF_COMPLETED'], to: 'PROPOSAL', action: 'start_proposal', labelFa: 'شروع تهیه پروپوزال', labelEn: 'Start proposal', permission: 'proposal.write' },
    { from: ['PROPOSAL'], to: 'NEGOTIATION', action: 'negotiate', labelFa: 'مذاکره تجاری', labelEn: 'Negotiate', permission: 'proposal.present' },
    { from: ['NEGOTIATION', 'PROPOSAL'], to: 'WON', action: 'win', labelFa: 'برنده شد', labelEn: 'Won', permission: 'crm.opportunity.write', guards: ['opportunity.hasApprovedProposal'] },
    { from: ['NEW', 'QUALIFIED', 'BRIEF_REQUESTED', 'BRIEF_COMPLETED', 'PROPOSAL', 'NEGOTIATION'], to: 'LOST', action: 'lose', labelFa: 'از دست رفت', labelEn: 'Lost', permission: 'crm.opportunity.write', requiresReason: true },
  ],
};

/** Doc_H recurring cycle 1 — an incomplete brief must go back to Sales, it cannot proceed. */
export const BRIEF_WORKFLOW: WorkflowDef = {
  entity: 'brief',
  labelFa: 'بریف',
  initial: 'DRAFT',
  states: ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'RETURNED_INCOMPLETE', 'APPROVED'],
  terminal: ['APPROVED'],
  transitions: [
    { from: ['DRAFT', 'RETURNED_INCOMPLETE'], to: 'SUBMITTED', action: 'submit', labelFa: 'ارسال به اکانت', labelEn: 'Submit to Account', permission: 'brief.submit', startsSla: 'SLA_BRIEF_ACK' },
    { from: ['SUBMITTED'], to: 'UNDER_REVIEW', action: 'start_review', labelFa: 'شروع کنترل بریف', labelEn: 'Start review', permission: 'brief.review', stopsSla: ['SLA_BRIEF_ACK'], startsSla: 'SLA_BRIEF_REVIEW' },
    { from: ['UNDER_REVIEW'], to: 'RETURNED_INCOMPLETE', action: 'return_incomplete', labelFa: 'بازگشت بریف ناقص', labelEn: 'Return as incomplete', permission: 'brief.return', requiresReason: true, stopsSla: ['SLA_BRIEF_REVIEW'] },
    { from: ['UNDER_REVIEW'], to: 'APPROVED', action: 'approve', labelFa: 'تأیید بریف', labelEn: 'Approve brief', permission: 'brief.approve', guards: ['brief.isComplete'], stopsSla: ['SLA_BRIEF_REVIEW'] },
  ],
};

export const PROPOSAL_WORKFLOW: WorkflowDef = {
  entity: 'proposal',
  labelFa: 'پروپوزال',
  initial: 'DRAFT',
  states: [
    'DRAFT', 'AWAITING_UNIT_OUTPUTS', 'INTEGRATION', 'PRICING', 'FINAL_QC', 'APPROVED',
    'DELIVERED_TO_SALES', 'PRESENTED_TO_CLIENT', 'CLIENT_REVISION_REQUESTED', 'CLIENT_APPROVED', 'CLIENT_REJECTED',
  ],
  terminal: ['CLIENT_APPROVED', 'CLIENT_REJECTED'],
  transitions: [
    { from: ['DRAFT'], to: 'AWAITING_UNIT_OUTPUTS', action: 'dispatch_orders', labelFa: 'ارسال سفارش به واحدها', labelEn: 'Dispatch unit orders', permission: 'workorder.issue' },
    { from: ['AWAITING_UNIT_OUTPUTS'], to: 'INTEGRATION', action: 'integrate', labelFa: 'یکپارچه‌سازی خروجی‌ها', labelEn: 'Integrate outputs', permission: 'proposal.integrate', guards: ['proposal.allUnitOutputsAccepted'], startsSla: 'SLA_INTEGRATION' },
    { from: ['INTEGRATION'], to: 'PRICING', action: 'send_to_pricing', labelFa: 'ارسال به قیمت‌گذاری', labelEn: 'Send to pricing', permission: 'pricing.set_price', guards: ['proposal.allCostsDeclared'], stopsSla: ['SLA_INTEGRATION'], startsSla: 'SLA_PRICING' },
    { from: ['PRICING'], to: 'FINAL_QC', action: 'send_to_final_qc', labelFa: 'ارسال به QC نهایی', labelEn: 'Send to Final QC', permission: 'pricing.set_price', guards: ['proposal.pricingComplete'], stopsSla: ['SLA_PRICING'], startsSla: 'SLA_FINAL_QC' },
    { from: ['FINAL_QC'], to: 'INTEGRATION', action: 'final_qc_reject', labelFa: 'رد در QC نهایی', labelEn: 'Final QC rejected', permission: 'qc.final', requiresReason: true, stopsSla: ['SLA_FINAL_QC'] },
    { from: ['FINAL_QC'], to: 'APPROVED', action: 'approve', labelFa: 'تأیید نهایی پروپوزال', labelEn: 'Approve proposal', permission: 'qc.final', guards: ['proposal.finalQcPassed', 'proposal.pricingApproved'], stopsSla: ['SLA_FINAL_QC'] },
    { from: ['APPROVED'], to: 'DELIVERED_TO_SALES', action: 'deliver_to_sales', labelFa: 'تحویل به فروش', labelEn: 'Deliver to Sales', permission: 'proposal.deliver_to_sales', startsSla: 'SLA_PROPOSAL_HANDOVER' },
    { from: ['DELIVERED_TO_SALES'], to: 'PRESENTED_TO_CLIENT', action: 'present', labelFa: 'ارائه به مشتری', labelEn: 'Present to client', permission: 'proposal.present', stopsSla: ['SLA_PROPOSAL_HANDOVER'] },
    { from: ['PRESENTED_TO_CLIENT'], to: 'CLIENT_APPROVED', action: 'client_approve', labelFa: 'تأیید مشتری', labelEn: 'Client approved', permission: 'proposal.record_feedback' },
    { from: ['PRESENTED_TO_CLIENT'], to: 'CLIENT_REVISION_REQUESTED', action: 'client_request_revision', labelFa: 'درخواست اصلاح مشتری', labelEn: 'Client requested revision', permission: 'proposal.record_feedback', requiresReason: true, startsSla: 'SLA_PROPOSAL_REVISION' },
    { from: ['PRESENTED_TO_CLIENT'], to: 'CLIENT_REJECTED', action: 'client_reject', labelFa: 'رد کامل مشتری', labelEn: 'Client rejected', permission: 'proposal.record_feedback', requiresReason: true },
    // Doc_H cycle 3 — revision loop returns through Account, units, QC, then back to Sales.
    { from: ['CLIENT_REVISION_REQUESTED'], to: 'INTEGRATION', action: 'rework', labelFa: 'شروع اصلاح پروپوزال', labelEn: 'Start rework', permission: 'proposal.write', stopsSla: ['SLA_PROPOSAL_REVISION'] },
  ],
};

/** Doc_H §13 & §15 — authorisation gate on entry, eight-condition gate on exit. */
export const PROJECT_WORKFLOW: WorkflowDef = {
  entity: 'project',
  labelFa: 'پروژه',
  initial: 'DRAFT',
  states: ['DRAFT', 'PENDING_AUTHORIZATION', 'AUTHORIZED', 'PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'PENDING_CLOSURE', 'CLOSED', 'CANCELLED'],
  terminal: ['CLOSED', 'CANCELLED'],
  transitions: [
    { from: ['DRAFT'], to: 'PENDING_AUTHORIZATION', action: 'request_authorization', labelFa: 'درخواست مجوز شروع', labelEn: 'Request authorization', permission: 'project.write', startsSla: 'SLA_PROJECT_AUTHORIZATION' },
    { from: ['PENDING_AUTHORIZATION'], to: 'AUTHORIZED', action: 'authorize', labelFa: 'صدور مجوز شروع پروژه', labelEn: 'Authorize project', permission: 'project.authorize', guards: ['project.hasValidAuthorizationBasis'], stopsSla: ['SLA_PROJECT_AUTHORIZATION'] },
    { from: ['AUTHORIZED'], to: 'PLANNING', action: 'start_planning', labelFa: 'شروع برنامه‌ریزی', labelEn: 'Start planning', permission: 'project.plan', startsSla: 'SLA_EXECUTION_KICKOFF' },
    { from: ['PLANNING'], to: 'ACTIVE', action: 'activate', labelFa: 'شروع اجرای پروژه', labelEn: 'Activate project', permission: 'project.execute', guards: ['project.isAuthorized', 'project.hasSchedule', 'project.hasRaci'], stopsSla: ['SLA_EXECUTION_KICKOFF'] },
    { from: ['ACTIVE'], to: 'ON_HOLD', action: 'hold', labelFa: 'توقف موقت', labelEn: 'Put on hold', permission: 'project.execute', requiresReason: true },
    { from: ['ON_HOLD'], to: 'ACTIVE', action: 'resume', labelFa: 'ازسرگیری', labelEn: 'Resume', permission: 'project.execute' },
    { from: ['ACTIVE'], to: 'COMPLETED', action: 'complete', labelFa: 'تکمیل اجرای پروژه', labelEn: 'Complete execution', permission: 'project.execute', guards: ['project.allDeliverablesAccepted'] },
    { from: ['COMPLETED'], to: 'PENDING_CLOSURE', action: 'start_closure', labelFa: 'شروع فرآیند بستن پروژه', labelEn: 'Start closure', permission: 'project.close', startsSla: 'SLA_PROJECT_CLOSURE' },
    { from: ['PENDING_CLOSURE'], to: 'CLOSED', action: 'close', labelFa: 'بستن پروژه', labelEn: 'Close project', permission: 'project.close', guards: ['project.closureChecklistComplete'], stopsSla: ['SLA_PROJECT_CLOSURE'] },
    { from: ['DRAFT', 'PENDING_AUTHORIZATION', 'AUTHORIZED', 'PLANNING', 'ACTIVE', 'ON_HOLD'], to: 'CANCELLED', action: 'cancel', labelFa: 'لغو پروژه', labelEn: 'Cancel project', permission: 'project.close', requiresReason: true },
  ],
};

export const WORK_ORDER_WORKFLOW: WorkflowDef = {
  entity: 'workOrder',
  labelFa: 'سفارش کار',
  initial: 'DRAFT',
  states: ['DRAFT', 'ISSUED', 'PENDING_ACCEPTANCE', 'ACCEPTED', 'CLARIFICATION_REQUESTED', 'IN_PROGRESS', 'SUBMITTED', 'COMPLETED', 'CANCELLED'],
  terminal: ['COMPLETED', 'CANCELLED'],
  transitions: [
    { from: ['DRAFT'], to: 'ISSUED', action: 'issue', labelFa: 'صدور سفارش', labelEn: 'Issue order', permission: 'workorder.issue', guards: ['workOrder.hasCompleteSpec'], startsSla: 'SLA_TASK_ACCEPTANCE' },
    { from: ['ISSUED'], to: 'PENDING_ACCEPTANCE', action: 'deliver', labelFa: 'دریافت توسط واحد', labelEn: 'Received by unit', permission: 'workorder.accept' },
    { from: ['ISSUED', 'PENDING_ACCEPTANCE'], to: 'CLARIFICATION_REQUESTED', action: 'request_clarification', labelFa: 'اعلام ابهام', labelEn: 'Request clarification', permission: 'workorder.clarify', requiresReason: true, startsSla: 'SLA_CLARIFICATION', pausesSla: ['SLA_TASK_ACCEPTANCE'] },
    { from: ['CLARIFICATION_REQUESTED'], to: 'PENDING_ACCEPTANCE', action: 'clarify', labelFa: 'رفع ابهام', labelEn: 'Clarification provided', permission: 'workorder.issue', stopsSla: ['SLA_CLARIFICATION'], resumesSla: ['SLA_TASK_ACCEPTANCE'] },
    { from: ['ISSUED', 'PENDING_ACCEPTANCE'], to: 'ACCEPTED', action: 'accept', labelFa: 'پذیرش سفارش', labelEn: 'Accept order', permission: 'workorder.accept', stopsSla: ['SLA_TASK_ACCEPTANCE'] },
    { from: ['ACCEPTED'], to: 'IN_PROGRESS', action: 'start', labelFa: 'شروع اجرا', labelEn: 'Start execution', permission: 'task.execute' },
    { from: ['IN_PROGRESS'], to: 'SUBMITTED', action: 'submit', labelFa: 'تحویل خروجی به اکانت', labelEn: 'Submit to Account', permission: 'workorder.submit', guards: ['workOrder.costDeclared', 'workOrder.unitQcPassed'] },
    { from: ['SUBMITTED'], to: 'IN_PROGRESS', action: 'reopen', labelFa: 'بازگشت برای اصلاح', labelEn: 'Reopen for revision', permission: 'revision.create', requiresReason: true },
    { from: ['SUBMITTED'], to: 'COMPLETED', action: 'complete', labelFa: 'تأیید و بستن سفارش', labelEn: 'Accept and close', permission: 'qc.account' },
    { from: ['DRAFT', 'ISSUED', 'PENDING_ACCEPTANCE', 'ACCEPTED', 'IN_PROGRESS'], to: 'CANCELLED', action: 'cancel', labelFa: 'لغو سفارش', labelEn: 'Cancel order', permission: 'workorder.issue', requiresReason: true },
  ],
};

export const TASK_WORKFLOW: WorkflowDef = {
  entity: 'task',
  labelFa: 'وظیفه',
  initial: 'CREATED',
  states: ['CREATED', 'ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'BLOCKED', 'SUBMITTED', 'IN_QC', 'REVISION_REQUIRED', 'APPROVED', 'CLOSED', 'CANCELLED'],
  terminal: ['CLOSED', 'CANCELLED'],
  transitions: [
    { from: ['CREATED'], to: 'ASSIGNED', action: 'assign', labelFa: 'تخصیص', labelEn: 'Assign', permission: 'task.assign', startsSla: 'SLA_TASK_ACCEPTANCE' },
    { from: ['ASSIGNED'], to: 'ACCEPTED', action: 'accept', labelFa: 'پذیرش وظیفه', labelEn: 'Accept task', permission: 'task.execute', stopsSla: ['SLA_TASK_ACCEPTANCE'] },
    { from: ['ACCEPTED', 'BLOCKED', 'REVISION_REQUIRED'], to: 'IN_PROGRESS', action: 'start', labelFa: 'شروع کار', labelEn: 'Start work', permission: 'task.execute' },
    { from: ['IN_PROGRESS', 'ACCEPTED'], to: 'BLOCKED', action: 'block', labelFa: 'اعلام مانع/تأخیر', labelEn: 'Report blocker', permission: 'task.execute', requiresReason: true },
    { from: ['IN_PROGRESS'], to: 'SUBMITTED', action: 'submit', labelFa: 'تحویل خروجی', labelEn: 'Submit output', permission: 'task.execute' },
    { from: ['SUBMITTED'], to: 'IN_QC', action: 'send_to_qc', labelFa: 'ارسال به کنترل کیفیت', labelEn: 'Send to QC', permission: 'qc.unit', startsSla: 'SLA_ACCOUNT_QC' },
    { from: ['IN_QC'], to: 'REVISION_REQUIRED', action: 'qc_reject', labelFa: 'عدم تأیید در QC', labelEn: 'QC rejected', permission: 'qc.account', requiresReason: true, stopsSla: ['SLA_ACCOUNT_QC'], startsSla: 'SLA_REVISION' },
    { from: ['IN_QC'], to: 'APPROVED', action: 'qc_approve', labelFa: 'تأیید در QC', labelEn: 'QC approved', permission: 'qc.account', stopsSla: ['SLA_ACCOUNT_QC', 'SLA_REVISION'] },
    { from: ['APPROVED'], to: 'CLOSED', action: 'close', labelFa: 'بستن وظیفه', labelEn: 'Close task', permission: 'task.write' },
    { from: ['CREATED', 'ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'BLOCKED'], to: 'CANCELLED', action: 'cancel', labelFa: 'لغو وظیفه', labelEn: 'Cancel task', permission: 'task.write', requiresReason: true },
  ],
};

export const DELIVERABLE_WORKFLOW: WorkflowDef = {
  entity: 'deliverable',
  labelFa: 'خروجی',
  initial: 'PLANNED',
  states: ['PLANNED', 'IN_PROGRESS', 'SUBMITTED', 'IN_QC', 'REVISION_REQUIRED', 'APPROVED', 'DELIVERED', 'ACCEPTED'],
  terminal: ['ACCEPTED'],
  transitions: [
    { from: ['PLANNED'], to: 'IN_PROGRESS', action: 'start', labelFa: 'شروع تولید', labelEn: 'Start production', permission: 'deliverable.write' },
    // QC stage zero (roadmap #22): the mechanical checks before a person's time is spent.
    { from: ['IN_PROGRESS', 'REVISION_REQUIRED'], to: 'SUBMITTED', action: 'submit', labelFa: 'تحویل به اکانت', labelEn: 'Submit to Account', permission: 'deliverable.write', guards: ['deliverable.passesStageZero'] },
    { from: ['SUBMITTED'], to: 'IN_QC', action: 'send_to_qc', labelFa: 'ارسال به QC اکانت', labelEn: 'Send to Account QC', permission: 'qc.account', startsSla: 'SLA_ACCOUNT_QC' },
    { from: ['IN_QC'], to: 'REVISION_REQUIRED', action: 'qc_reject', labelFa: 'عدم تأیید — صدور اصلاحیه', labelEn: 'QC rejected — raise revision', permission: 'qc.account', requiresReason: true, stopsSla: ['SLA_ACCOUNT_QC'] },
    { from: ['IN_QC'], to: 'APPROVED', action: 'qc_approve', labelFa: 'تأیید QC', labelEn: 'QC approved', permission: 'qc.account', stopsSla: ['SLA_ACCOUNT_QC'] },
    // Doc_H D/J — nothing reaches the customer without a passing Account QC.
    { from: ['APPROVED'], to: 'DELIVERED', action: 'deliver', labelFa: 'تحویل به مشتری', labelEn: 'Deliver to client', permission: 'deliverable.deliver', guards: ['deliverable.accountQcPassed'] },
    { from: ['DELIVERED'], to: 'ACCEPTED', action: 'client_accept', labelFa: 'تأیید مشتری', labelEn: 'Client accepted', permission: 'deliverable.deliver' },
    { from: ['DELIVERED'], to: 'REVISION_REQUIRED', action: 'client_reject', labelFa: 'عدم تأیید مشتری', labelEn: 'Client rejected', permission: 'deliverable.deliver', requiresReason: true },
  ],
};

/** Doc_H §10 — every revision carries a recorded reason and a responsible unit. */
export const REVISION_WORKFLOW: WorkflowDef = {
  entity: 'revision',
  labelFa: 'اصلاحیه',
  initial: 'REQUESTED',
  states: ['REQUESTED', 'ASSIGNED', 'IN_PROGRESS', 'SUBMITTED', 'IN_QC', 'APPROVED', 'REJECTED'],
  terminal: ['APPROVED', 'REJECTED'],
  transitions: [
    { from: ['REQUESTED'], to: 'ASSIGNED', action: 'assign', labelFa: 'ارجاع به واحد مسئول', labelEn: 'Assign to unit', permission: 'revision.create', guards: ['revision.hasReason'], startsSla: 'SLA_REVISION' },
    { from: ['ASSIGNED'], to: 'IN_PROGRESS', action: 'start', labelFa: 'شروع اصلاح', labelEn: 'Start revision', permission: 'revision.execute' },
    { from: ['IN_PROGRESS'], to: 'SUBMITTED', action: 'submit', labelFa: 'تحویل نسخه اصلاحی', labelEn: 'Submit revised version', permission: 'revision.execute' },
    { from: ['SUBMITTED'], to: 'IN_QC', action: 'send_to_qc', labelFa: 'ارسال به QC', labelEn: 'Send to QC', permission: 'qc.account' },
    { from: ['IN_QC'], to: 'APPROVED', action: 'approve', labelFa: 'تأیید اصلاح', labelEn: 'Approve revision', permission: 'qc.account', stopsSla: ['SLA_REVISION'] },
    { from: ['IN_QC'], to: 'ASSIGNED', action: 'reject', labelFa: 'رد اصلاح — تکرار چرخه', labelEn: 'Reject — repeat cycle', permission: 'qc.account', requiresReason: true },
    { from: ['REQUESTED', 'ASSIGNED', 'IN_PROGRESS'], to: 'REJECTED', action: 'withdraw', labelFa: 'ابطال اصلاحیه', labelEn: 'Withdraw revision', permission: 'revision.create', requiresReason: true },
  ],
};

/** Doc_H §8 / stage I — out-of-scope work cannot be executed before impact + customer approval. */
export const CHANGE_REQUEST_WORKFLOW: WorkflowDef = {
  entity: 'changeRequest',
  labelFa: 'درخواست تغییر',
  initial: 'SUBMITTED',
  states: ['SUBMITTED', 'SCOPE_REVIEW', 'COMMERCIAL_REVIEW', 'PENDING_CUSTOMER_APPROVAL', 'APPROVED', 'REJECTED', 'IMPLEMENTING', 'CLOSED'],
  terminal: ['CLOSED', 'REJECTED'],
  transitions: [
    { from: ['SUBMITTED'], to: 'SCOPE_REVIEW', action: 'start_scope_review', labelFa: 'شروع بررسی Scope', labelEn: 'Start scope review', permission: 'change.scope_review', startsSla: 'SLA_SCOPE_REVIEW' },
    // In-scope changes skip the commercial gate and are executed under the existing contract.
    { from: ['SCOPE_REVIEW'], to: 'APPROVED', action: 'approve_in_scope', labelFa: 'داخل Scope — تأیید اجرا', labelEn: 'In scope — approve', permission: 'change.scope_review', guards: ['change.isInScope'], stopsSla: ['SLA_SCOPE_REVIEW'] },
    { from: ['SCOPE_REVIEW'], to: 'COMMERCIAL_REVIEW', action: 'start_commercial_review', labelFa: 'خارج از Scope — بررسی تجاری', labelEn: 'Out of scope — commercial review', permission: 'change.commercial_review', guards: ['change.isOutOfScope'], stopsSla: ['SLA_SCOPE_REVIEW'], startsSla: 'SLA_CHANGE_REQUEST' },
    { from: ['COMMERCIAL_REVIEW'], to: 'PENDING_CUSTOMER_APPROVAL', action: 'send_to_customer', labelFa: 'ارسال برای تأیید مشتری', labelEn: 'Send for customer approval', permission: 'change.commercial_review', guards: ['change.impactAssessed'], stopsSla: ['SLA_CHANGE_REQUEST'] },
    { from: ['PENDING_CUSTOMER_APPROVAL'], to: 'APPROVED', action: 'customer_approve', labelFa: 'تأیید مشتری', labelEn: 'Customer approved', permission: 'change.approve' },
    { from: ['SCOPE_REVIEW', 'COMMERCIAL_REVIEW', 'PENDING_CUSTOMER_APPROVAL'], to: 'REJECTED', action: 'reject', labelFa: 'رد درخواست تغییر', labelEn: 'Reject change', permission: 'change.approve', requiresReason: true },
    { from: ['APPROVED'], to: 'IMPLEMENTING', action: 'implement', labelFa: 'شروع اجرای تغییر', labelEn: 'Start implementation', permission: 'project.execute', guards: ['change.readyForImplementation'] },
    { from: ['IMPLEMENTING'], to: 'CLOSED', action: 'close', labelFa: 'بستن درخواست تغییر', labelEn: 'Close change request', permission: 'project.execute' },
  ],
};

export const CONTRACT_WORKFLOW: WorkflowDef = {
  entity: 'contract',
  labelFa: 'قرارداد',
  initial: 'REQUESTED',
  states: ['REQUESTED', 'DRAFTING', 'LEGAL_REVIEW', 'REVISION_REQUESTED', 'INTERNAL_APPROVED', 'PENDING_SIGNATURE', 'SIGNED', 'REGISTERED', 'EXPIRED', 'TERMINATED'],
  terminal: ['EXPIRED', 'TERMINATED'],
  transitions: [
    { from: ['REQUESTED'], to: 'DRAFTING', action: 'start_drafting', labelFa: 'شروع تهیه قرارداد', labelEn: 'Start drafting', permission: 'contract.draft', startsSla: 'SLA_CONTRACT_DRAFT' },
    { from: ['DRAFTING', 'REVISION_REQUESTED'], to: 'LEGAL_REVIEW', action: 'send_to_legal', labelFa: 'ارسال به بررسی حقوقی', labelEn: 'Send to legal review', permission: 'contract.draft' },
    { from: ['LEGAL_REVIEW'], to: 'REVISION_REQUESTED', action: 'request_revision', labelFa: 'درخواست اصلاح قرارداد', labelEn: 'Request revision', permission: 'contract.legal_review', requiresReason: true },
    { from: ['LEGAL_REVIEW'], to: 'INTERNAL_APPROVED', action: 'approve', labelFa: 'تأیید داخلی قرارداد', labelEn: 'Internal approval', permission: 'contract.approve', stopsSla: ['SLA_CONTRACT_DRAFT'] },
    { from: ['INTERNAL_APPROVED'], to: 'PENDING_SIGNATURE', action: 'send_for_signature', labelFa: 'ارسال برای امضا', labelEn: 'Send for signature', permission: 'contract.approve' },
    { from: ['PENDING_SIGNATURE'], to: 'SIGNED', action: 'sign', labelFa: 'ثبت امضای قرارداد', labelEn: 'Record signature', permission: 'contract.sign', guards: ['contract.signatureNotInFlight'] },
    { from: ['SIGNED'], to: 'REGISTERED', action: 'register', labelFa: 'ثبت قرارداد', labelEn: 'Register contract', permission: 'contract.sign' },
    { from: ['REGISTERED'], to: 'EXPIRED', action: 'expire', labelFa: 'اتمام اعتبار', labelEn: 'Expire', permission: 'contract.amend' },
    { from: ['REGISTERED', 'SIGNED'], to: 'TERMINATED', action: 'terminate', labelFa: 'فسخ قرارداد', labelEn: 'Terminate', permission: 'contract.approve', requiresReason: true },
  ],
};

export const INVOICE_WORKFLOW: WorkflowDef = {
  entity: 'invoice',
  labelFa: 'سند مالی',
  initial: 'DRAFT',
  states: ['DRAFT', 'ISSUED', 'SENT', 'PARTIALLY_PAID', 'PAID', 'CANCELLED'],
  terminal: ['PAID', 'CANCELLED'],
  transitions: [
    { from: ['DRAFT'], to: 'ISSUED', action: 'issue', labelFa: 'صدور', labelEn: 'Issue', permission: 'finance.invoice' },
    { from: ['ISSUED'], to: 'SENT', action: 'send', labelFa: 'ارسال به مشتری', labelEn: 'Send to client', permission: 'finance.invoice' },
    { from: ['SENT', 'PARTIALLY_PAID'], to: 'PARTIALLY_PAID', action: 'partial_payment', labelFa: 'دریافت جزئی', labelEn: 'Partial payment', permission: 'finance.payment' },
    { from: ['SENT', 'PARTIALLY_PAID'], to: 'PAID', action: 'settle', labelFa: 'تسویه کامل', labelEn: 'Fully settled', permission: 'finance.payment' },
    { from: ['DRAFT', 'ISSUED', 'SENT'], to: 'CANCELLED', action: 'cancel', labelFa: 'ابطال', labelEn: 'Cancel', permission: 'finance.invoice', requiresReason: true, guards: ['invoice.taxCancellationFiled'] },
  ],
};

/** Doc_H §5 — external resource supply passes unit manager then management. */
export const OUTSOURCE_WORKFLOW: WorkflowDef = {
  entity: 'outsourceRequest',
  labelFa: 'درخواست تأمین منابع',
  initial: 'REQUESTED',
  states: ['REQUESTED', 'UNIT_MANAGER_REVIEW', 'MANAGEMENT_REVIEW', 'APPROVED', 'REJECTED', 'FULFILLED'],
  terminal: ['FULFILLED', 'REJECTED'],
  transitions: [
    { from: ['REQUESTED'], to: 'UNIT_MANAGER_REVIEW', action: 'submit', labelFa: 'ارسال به مدیر واحد', labelEn: 'Submit to unit manager', permission: 'supplier.request', startsSla: 'SLA_RESOURCE_REQUEST' },
    { from: ['UNIT_MANAGER_REVIEW'], to: 'MANAGEMENT_REVIEW', action: 'escalate', labelFa: 'ارجاع به مدیریت', labelEn: 'Escalate to management', permission: 'supplier.write' },
    { from: ['UNIT_MANAGER_REVIEW', 'MANAGEMENT_REVIEW'], to: 'APPROVED', action: 'approve', labelFa: 'تأیید تأمین', labelEn: 'Approve', permission: 'supplier.approve', stopsSla: ['SLA_RESOURCE_REQUEST'] },
    { from: ['UNIT_MANAGER_REVIEW', 'MANAGEMENT_REVIEW'], to: 'REJECTED', action: 'reject', labelFa: 'رد درخواست', labelEn: 'Reject', permission: 'supplier.approve', requiresReason: true, stopsSla: ['SLA_RESOURCE_REQUEST'] },
    { from: ['APPROVED'], to: 'FULFILLED', action: 'fulfil', labelFa: 'تأمین شد', labelEn: 'Fulfilled', permission: 'supplier.write' },
  ],
};

/**
 * Roadmap #31 — media bought on a client's behalf: booked with the vendor, delivered (aired,
 * printed, run) with proof, and reconciled against the vendor's invoice before it is closed.
 */
export const MEDIA_ORDER_WORKFLOW: WorkflowDef = {
  entity: 'mediaOrder',
  labelFa: 'سفارش خرید رسانه',
  initial: 'DRAFT',
  states: ['DRAFT', 'BOOKED', 'AIRED', 'RECONCILED', 'CANCELLED'],
  terminal: ['RECONCILED', 'CANCELLED'],
  transitions: [
    { from: ['DRAFT'], to: 'BOOKED', action: 'book', labelFa: 'رزرو نزد رسانه', labelEn: 'Book with vendor', permission: 'media.buy', guards: ['mediaOrder.bookedByMediaOrAccount'] },
    { from: ['BOOKED'], to: 'AIRED', action: 'confirm_delivery', labelFa: 'تأیید پخش و اجرا', labelEn: 'Confirm delivery', permission: 'media.buy', requiresReason: true },
    { from: ['AIRED'], to: 'RECONCILED', action: 'reconcile', labelFa: 'تطبیق با صورت‌حساب رسانه', labelEn: 'Reconcile vendor invoice', permission: 'finance.payment', guards: ['mediaOrder.vendorInvoiceMatches'] },
    { from: ['DRAFT', 'BOOKED'], to: 'CANCELLED', action: 'cancel', labelFa: 'لغو سفارش', labelEn: 'Cancel', permission: 'media.buy', requiresReason: true },
  ],
};

export const WORKFLOWS: Record<string, WorkflowDef> = {
  lead: LEAD_WORKFLOW,
  opportunity: OPPORTUNITY_WORKFLOW,
  brief: BRIEF_WORKFLOW,
  proposal: PROPOSAL_WORKFLOW,
  project: PROJECT_WORKFLOW,
  workOrder: WORK_ORDER_WORKFLOW,
  task: TASK_WORKFLOW,
  deliverable: DELIVERABLE_WORKFLOW,
  revision: REVISION_WORKFLOW,
  changeRequest: CHANGE_REQUEST_WORKFLOW,
  contract: CONTRACT_WORKFLOW,
  invoice: INVOICE_WORKFLOW,
  outsourceRequest: OUTSOURCE_WORKFLOW,
  mediaOrder: MEDIA_ORDER_WORKFLOW,
};

export function findTransition(entity: string, from: string, action: string): TransitionDef | undefined {
  return WORKFLOWS[entity]?.transitions.find((t) => t.action === action && t.from.includes(from));
}

export function availableTransitions(entity: string, from: string): TransitionDef[] {
  return (WORKFLOWS[entity]?.transitions ?? []).filter((t) => t.from.includes(from));
}

/**
 * Reading an entity's lifecycle is reading the entity. State history carries the free-text
 * `reason` on every transition — why a proposal was rejected, why an opportunity was lost, why
 * a brief was returned — so it is gated by the same permission as the record itself. Without
 * this, the Sales/Account separation in Doc_H §2 leaks through the history endpoint.
 */
export const WORKFLOW_READ_PERMISSION: Record<string, Permission> = {
  lead: 'crm.lead.read',
  opportunity: 'crm.opportunity.read',
  brief: 'brief.read',
  proposal: 'proposal.read',
  project: 'project.read',
  workOrder: 'workorder.read',
  task: 'task.read',
  deliverable: 'deliverable.read',
  revision: 'revision.read',
  changeRequest: 'change.read',
  contract: 'contract.read',
  invoice: 'finance.read',
  outsourceRequest: 'supplier.read',
  // What was paid for media and at what commission is pricing data.
  mediaOrder: 'pricing.read',
};

/** True when `entity` names a declared state machine. Guards dynamic lookups. */
export function isWorkflowEntity(entity: string): boolean {
  return Object.prototype.hasOwnProperty.call(WORKFLOWS, entity);
}
