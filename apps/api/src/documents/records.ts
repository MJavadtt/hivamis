import { FILE_RECORD_TYPES, type FileRecordType, type Permission } from '@hiva/contracts';
import { prisma } from '../db.js';
import { organizationWhere } from '../lib/scope.js';
import { mayReadSiteFile } from '../sites/access.js';
import { visibleAmong, type BookingViewer } from '../bookings/access.js';
import { isSystemAdmin } from '../auth/grants.js';

/**
 * A file attached to any record (the owner, 2026-11-06, ADR-121): a lead, a task, an invoice, a risk…
 * A record's file is read as the record is: with the permission that reads it — an invoice's by
 * Finance, not by everyone who may read files — and, for a booking, by those who may see that booking.
 */

const RECORDS: Record<FileRecordType, { model: string; read: Permission }> = {
  lead: { model: 'lead', read: 'crm.lead.read' },
  opportunity: { model: 'opportunity', read: 'crm.opportunity.read' },
  activity: { model: 'activity', read: 'crm.activity.read' },
  brief: { model: 'brief', read: 'brief.read' },
  workOrder: { model: 'workOrder', read: 'workorder.read' },
  task: { model: 'task', read: 'task.read' },
  changeRequest: { model: 'changeRequest', read: 'change.read' },
  revision: { model: 'revision', read: 'revision.read' },
  risk: { model: 'risk', read: 'governance.read' },
  issue: { model: 'issue', read: 'governance.read' },
  decision: { model: 'decision', read: 'governance.read' },
  statusReport: { model: 'statusReport', read: 'report.read' },
  meeting: { model: 'meeting', read: 'meeting.read' },
  invoice: { model: 'invoice', read: 'finance.read' },
  supplier: { model: 'supplier', read: 'supplier.read' },
  outsourceRequest: { model: 'outsourceRequest', read: 'supplier.read' },
  mediaOrder: { model: 'mediaOrder', read: 'pricing.read' },
  booking: { model: 'booking', read: 'meeting.book' },
};

export const isFileRecord = (type: string | null): type is FileRecordType => (FILE_RECORD_TYPES as readonly (string | null)[]).includes(type);

type Reader = BookingViewer & Parameters<typeof isSystemAdmin>[0];
interface FileLinks { venueId: string | null; siteProjectId: string | null; siteRecordType: string | null; recordType: string | null; recordId: string | null }

/** Whether this person may read this record: its permission, and a booking's own visibility. */
export async function mayReadRecord(actor: Reader, type: FileRecordType, id: string): Promise<boolean> {
  if (!actor.permissions.includes(RECORDS[type].read)) return false;
  return type === 'booking' ? (await visibleAmong({ ...actor, systemAdmin: isSystemAdmin(actor) }, [id])).has(id) : true;
}

/** The one gate every route that reads a file passes through. */
export async function mayReadFile(actor: Reader, doc: FileLinks): Promise<boolean> {
  if (!mayReadSiteFile(actor.permissions, doc)) return false;
  if (!doc.recordType) return true;
  return isFileRecord(doc.recordType) && !!doc.recordId && mayReadRecord(actor, doc.recordType, doc.recordId);
}

/** The record exists in this organisation — one answer for none and another's. */
export async function recordInOrganization(type: FileRecordType, id: string, organizationId: string): Promise<boolean> {
  const { model } = RECORDS[type];
  return (await (prisma as any)[model].count({ where: { id, ...organizationWhere(model, organizationId) } })) > 0;
}
