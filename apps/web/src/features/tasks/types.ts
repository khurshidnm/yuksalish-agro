import type { PRIORITIES, RECURRENCES, TASK_STATUSES } from '@yap/shared';
import type { TFunction } from 'i18next';

export const ENTITY_TYPES = ['field', 'herd', 'animal', 'asset'] as const;
export const RECORD_TYPES = ['health_record', 'field_operation', 'daily_log', 'weight_record'] as const;
export const DIVISIONS = ['crops', 'livestock', 'machinery', 'admin'] as const;

export interface Task {
  id: string;
  title: string;
  description: string | null;
  assigneeUserId: string | null;
  assigneeName: string | null;
  dueDate: string | null;
  priority: (typeof PRIORITIES)[number];
  status: (typeof TASK_STATUSES)[number];
  division: string | null;
  entityType: (typeof ENTITY_TYPES)[number] | null;
  entityId: string | null;
  entityLabel: string | null;
  entityLink: string | null;
  recurrence: (typeof RECURRENCES)[number];
  templateId: string | null;
  requiresPhoto: boolean;
  requiresRecord: (typeof RECORD_TYPES)[number] | null;
  completedAt: string | null;
  completionNote: string | null;
  completionRecordId: string | null;
  createdAt: string;
}

export interface MemberOption {
  id: string;
  name: string;
  roleKey: string;
}

export const CALENDAR_KINDS = [
  'lambing',
  'vaccination',
  'field_operation',
  'loan',
  'contract',
  'document',
  'maintenance',
  'state_report',
  'staff_contract',
  'staff_medical',
  'task',
  'manual',
] as const;
export type CalendarKind = (typeof CALENDAR_KINDS)[number];

export interface CalendarItem {
  id: string;
  kind: CalendarKind;
  date: string;
  endDate: string | null;
  title: string | null;
  params: Record<string, unknown>;
  link: string | null;
  division: string | null;
  responsibleUserId: string | null;
  responsibleName: string | null;
  status: string | null;
  priority: string | null;
  editableId: string | null;
}

export const isClosed = (task: Pick<Task, 'status'>) => task.status === 'done' || task.status === 'cancelled';

/** A field's label is only its number, which means nothing alone: "Dala 1", not "1". */
export function entityText(task: Pick<Task, 'entityType' | 'entityLabel'>, t: TFunction): string {
  return task.entityType === 'field' ? `${t('entity.field')} ${task.entityLabel}` : (task.entityLabel ?? '');
}
