import { useState } from 'react';
import { ApiError, downloadPdf } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, useToast } from './ui';

/** Permission each document kind needs — mirrors DOCUMENT_POLICIES on the server. */
const KIND_PERMISSION: Record<string, string> = {
  'form-submission': 'form.read',
  brief: 'brief.read',
  proposal: 'proposal.read',
  contract: 'contract.read',
  invoice: 'finance.read',
  project: 'project.read',
  company: 'crm.company.read',
  'work-order': 'workorder.read',
  deliverable: 'deliverable.read',
  'qc-review': 'qc.read',
  revision: 'revision.read',
  'change-request': 'change.read',
  'status-report': 'report.read',
  meeting: 'meeting.read',
  'closure-report': 'project.read',
  'executive-report': 'report.executive',
};

export interface PdfButtonProps {
  kind: keyof typeof KIND_PERMISSION | string;
  id: string;
  label?: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * Export a record as a PDF. Hidden when the signed-in user lacks the read permission for that
 * kind, and the server re-checks regardless — the button is a convenience, not the control.
 */
export function PdfButton({ kind, id, label = 'خروجی PDF', variant = 'secondary', size = 'sm', className }: PdfButtonProps) {
  const { can } = useAuth();
  const showToast = useToast();
  const [busy, setBusy] = useState(false);

  const permission = KIND_PERMISSION[kind];
  if (permission && !can(permission)) return null;

  const run = async () => {
    setBusy(true);
    try {
      await downloadPdf(kind, id);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.body.message
          : 'تولید فایل PDF ناموفق بود. لطفاً دوباره تلاش کنید.';
      showToast(message, 'danger');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button variant={variant} size={size} loading={busy} onClick={run} className={className} title="دریافت نسخه PDF">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
           strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
        <path d="M7 10l5 5 5-5" />
        <path d="M12 15V3" />
      </svg>
      {label}
    </Button>
  );
}
