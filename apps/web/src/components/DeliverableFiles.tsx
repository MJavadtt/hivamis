import { FileShelf, useFiles } from './RecordFiles';
import { tr } from '../i18n';

/** A deliverable's files: the shelf every record has, under the name its people know it by. */
export const useDeliverableFiles = (deliverableId: string | null | undefined) => useFiles(deliverableId ? { deliverableId } : null);

export function DeliverableFiles({ deliverableId, label = tr('گذاشتن فایل خروجی') }: { deliverableId: string; label?: string }) {
  return <FileShelf target={{ deliverableId }} label={label} />;
}
