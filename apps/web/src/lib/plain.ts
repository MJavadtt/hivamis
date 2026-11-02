import { RECORD_PAGES } from '@hiva/contracts';
import type { Tone } from '../components/ui';
import { loc, tr } from '../i18n';

/**
 * Plain words for where work stands (the owner's brief, 2026-11-02: "the system manages the
 * complexity; the person sees what to do"). Every workflow keeps its own states — the engine,
 * the API and the record's history are unchanged. Here those dozens of states are read as the few
 * things a person needs to know: is it new, moving, waiting on someone, back with me to correct,
 * stopped, approved, finished, or off.
 */

export type Stage = 'new' | 'progress' | 'waiting' | 'returned' | 'stopped' | 'approved' | 'done' | 'cancelled';

const GENERIC: Record<string, Stage> = {
  // Returned: someone looked at it and sent it back with something to fix or answer.
  REVISION_REQUIRED: 'returned', RETURNED_INCOMPLETE: 'returned', CHANGES_REQUESTED: 'returned', REVISION_REQUESTED: 'returned',
  CLIENT_REVISION_REQUESTED: 'returned', CLARIFICATION_REQUESTED: 'returned',
  // New: it has arrived and nobody has picked it up yet.
  CREATED: 'new', ASSIGNED: 'new', ISSUED: 'new', PENDING_ACCEPTANCE: 'new', REQUESTED: 'new', NEW: 'new', PLANNED: 'new', DRAFT: 'new',
  // Moving: someone is working on it.
  ACCEPTED: 'progress', IN_PROGRESS: 'progress', DRAFTING: 'progress', IMPLEMENTING: 'progress', PLANNING: 'progress', ACTIVE: 'progress',
  CONTACTED: 'progress', QUALIFIED: 'progress', BRIEF_REQUESTED: 'progress', BRIEF_COMPLETED: 'progress', PROPOSAL: 'progress',
  NEGOTIATION: 'progress', AWAITING_UNIT_OUTPUTS: 'progress', INTEGRATION: 'progress', PRICING: 'progress', SETTLING: 'progress',
  BOOKED: 'progress', AIRED: 'progress',
  // Waiting: handed in, and someone else is to look at it or decide.
  SUBMITTED: 'waiting', IN_QC: 'waiting', UNDER_REVIEW: 'waiting', PENDING_APPROVAL: 'waiting', LEGAL_REVIEW: 'waiting', SCOPE_REVIEW: 'waiting',
  COMMERCIAL_REVIEW: 'waiting', PENDING_CUSTOMER_APPROVAL: 'waiting', PENDING_AUTHORIZATION: 'waiting', PENDING_SIGNATURE: 'waiting',
  UNIT_MANAGER_REVIEW: 'waiting', MANAGEMENT_REVIEW: 'waiting', FINAL_QC: 'waiting', PENDING_CLOSURE: 'waiting', CLOSURE_PENDING: 'waiting',
  DELIVERED_TO_SALES: 'waiting', PRESENTED_TO_CLIENT: 'waiting',
  // Stopped.
  BLOCKED: 'stopped', ON_HOLD: 'stopped',
  // Approved: someone said yes; it goes on from here.
  APPROVED: 'approved', INTERNAL_APPROVED: 'approved', AUTHORIZED: 'approved', CLIENT_APPROVED: 'approved', CONFIRMED: 'approved',
  // Finished.
  CLOSED: 'done', COMPLETED: 'done', DELIVERED: 'done', SIGNED: 'done', REGISTERED: 'done', WON: 'done', PAID: 'done', CONVERTED: 'done',
  FULFILLED: 'done', RECONCILED: 'done',
  // Off: cancelled, turned down, lost or lapsed.
  CANCELLED: 'cancelled', REJECTED: 'cancelled', CLIENT_REJECTED: 'cancelled', LOST: 'cancelled', DISQUALIFIED: 'cancelled',
  TERMINATED: 'cancelled', EXPIRED: 'cancelled',
};

/** Where the same word means something else for one kind of record. */
const BY_ENTITY: Record<string, Record<string, Stage>> = {
  deliverable: { ACCEPTED: 'done' },
  invoice: { ISSUED: 'progress', SENT: 'progress', PARTIALLY_PAID: 'progress' },
  project: { COMPLETED: 'approved' },
  booking: { COMPLETED: 'done' },
  contract: { REQUESTED: 'new' },
};

/** Where a record stands, in words anyone reads — its own state underneath, unchanged. */
export function stageOf(state: string, entity?: string): Stage {
  return (entity ? BY_ENTITY[entity]?.[state] : undefined) ?? GENERIC[state] ?? 'progress';
}

export const STAGE: Record<Stage, { label: string; tone: Tone }> = {
  new: { label: tr('تازه'), tone: 'info' },
  progress: { label: tr('در حال انجام'), tone: 'progress' },
  waiting: { label: tr('منتظر بررسی'), tone: 'neutral' },
  returned: { label: tr('برگشت برای اصلاح'), tone: 'warning' },
  stopped: { label: tr('متوقف'), tone: 'danger' },
  approved: { label: tr('تأیید شد'), tone: 'success' },
  done: { label: tr('انجام شد'), tone: 'success' },
  cancelled: { label: tr('لغو یا رد شد'), tone: 'neutral' },
};

/* ── the work queue ───────────────────────────────────────────────────────── */

/** One item of `/me/work`, as the API sends it. */
export interface WorkItem {
  kind: string; entityType: string; entityId: string; code: string; title: string; state: string;
  projectCode: string | null; projectName: string | null; dueAt: string | null;
  sla: {
    policyCode: string; labelFa: string; state: string; dueAt: string; budgetHours: number; controlledHours: number;
    risk?: { probability: number; risk: 'WATCH' | 'LIKELY' | 'CRITICAL'; becauseFa: string | null } | null;
  } | null;
  href: string;
  availableTransitions: Transition[];
}
export interface Transition { action: string; labelFa: string; labelEn: string; requiresReason: boolean; to: string }

/** Work that asks the person for a decision on someone else's: they read, and approve or send back. */
const DECISIONS = new Set(['formApproval', 'qcUnit', 'qcAccount', 'qcFinal']);
export const isDecision = (i: WorkItem) => DECISIONS.has(i.kind);

/** How a person sorts their own work: what came back, what is late, what is theirs to decide, the rest. */
export type WorkGroup = 'returned' | 'urgent' | 'decide' | 'todo' | 'waiting';

export function isUrgent(i: WorkItem, now = Date.now()): boolean {
  if (i.sla && (i.sla.state === 'BREACHED' || i.sla.state === 'AT_RISK')) return true;
  if (i.sla?.risk && i.sla.risk.risk !== 'WATCH') return true;
  return !!i.dueAt && new Date(i.dueAt).getTime() - now < 24 * 3_600_000;
}

export function groupOf(i: WorkItem, now = Date.now()): WorkGroup {
  if (i.kind === 'revision' || i.kind === 'clarification' || stageOf(i.state, i.entityType) === 'returned') return 'returned';
  // Handed in and with someone else: nothing for this person to do but wait — unless the next step is theirs too.
  if (!isDecision(i) && stageOf(i.state, i.entityType) === 'waiting' && !forwardMove(i.availableTransitions)) return 'waiting';
  if (isUrgent(i, now)) return 'urgent';
  return isDecision(i) ? 'decide' : 'todo';
}

/** What the person is to do now, said as they would say it. */
export function whatToDo(i: WorkItem): string {
  switch (i.kind) {
    case 'formApproval': return tr('فرمی منتظر تصمیم شماست. آن را بخوانید و تأیید یا برای اصلاح برگردانید.');
    case 'qcUnit': return tr('همکارتان خروجی را تحویل داده است. بررسی کنید و تأیید یا برای اصلاح برگردانید.');
    case 'qcAccount': return tr('خروجی برای کنترل کیفیت اکانت آمده است. بررسی کنید و تأیید یا برگشت دهید.');
    case 'qcFinal': return tr('پروپوزال برای بررسی نهایی آمده است. بررسی کنید و تصمیم بگیرید.');
    case 'clarification': return tr('واحد اجرا دربارهٔ این سفارش سؤال دارد. پاسخ دهید تا کار ادامه پیدا کند.');
    case 'revision': return i.state === 'IN_PROGRESS'
      ? tr('اصلاح را تمام کنید و دوباره تحویل دهید.')
      : tr('ایرادی گرفته شده که با شماست. آن را برطرف کنید و تحویل دهید.');
    case 'workOrder':
      if (['ISSUED', 'PENDING_ACCEPTANCE'].includes(i.state)) return tr('سفارش کار تازه‌ای برای شماست. آن را بپذیرید، یا اگر ابهامی دارد بپرسید.');
      if (i.state === 'ACCEPTED') return tr('سفارش را پذیرفته‌اید. کار را شروع کنید.');
      return tr('وقتی کار آماده شد، آن را برای بررسی بفرستید.');
    default:
      switch (i.state) {
        case 'CREATED': case 'ASSIGNED': return tr('این کار به شما سپرده شده است. اول آن را بپذیرید.');
        case 'ACCEPTED': return tr('کار را پذیرفته‌اید. هر وقت آماده بودید شروعش کنید.');
        case 'IN_PROGRESS': return tr('وقتی کار آماده شد، خروجی را تحویل دهید.');
        case 'BLOCKED': return tr('کار متوقف است. وقتی مانع برطرف شد، دوباره شروعش کنید.');
        case 'REVISION_REQUIRED': return tr('برگشت خورده است. ایرادها را برطرف کنید و دوباره تحویل دهید.');
        case 'SUBMITTED': case 'IN_QC': {
          const next = forwardMove(i.availableTransitions);
          return next ? tr('تحویل داده شده و گام بعد با شماست: «{0}».', loc(next, 'label')) : tr('تحویل داده‌اید. منتظر بررسی است؛ کاری با شما نیست.');
        }
        default: return tr('آن را باز کنید و گام بعد را بردارید.');
      }
  }
}

/** Moves a person makes to stop, turn down or send back — never the obvious next step. */
const AWAY = /reject|cancel|lose|disqualify|terminate|return|withdraw|hold|block|clarif|request_changes|revision|reopen|reschedule|escalate|expire/;

/** The one move that takes the work forward, when the person may make it. */
export function forwardMove(transitions: Transition[]): Transition | null {
  return transitions.find((t) => !AWAY.test(t.action)) ?? null;
}

/** The page a record of this type opens on. */
export function pageOf(entityType: string | null | undefined, id: string | null | undefined): string | null {
  if (!entityType || !id) return null;
  const known = RECORD_PAGES[entityType];
  if (known) return `${known}/${id}`;
  switch (entityType) {
    case 'workOrder': return `/work-orders/${id}`;
    case 'booking': return `/bookings/${id}`;
    case 'changeRequest': return `/changes/${id}`;
    case 'supplier': return `/suppliers/${id}`;
    case 'siteProject': return `/sites/projects/${id}`;
    case 'venue': return `/sites/venues/${id}`;
    case 'chatConversation': return `/chat/${id}`;
    case 'formSubmission': return `/forms?tab=inbox&submission=${id}`;
    case 'deliverable': case 'revision': return '/qc';
    case 'invoice': return '/finance';
    case 'lead': return '/leads';
    case 'securityAlert': return '/admin';
    default: return null;
  }
}

/** Where a queue item opens: a form opens on itself, not on the forms page. */
export const hrefOf = (i: WorkItem) => (i.kind === 'formApproval' ? pageOf('formSubmission', i.entityId)! : i.href);
