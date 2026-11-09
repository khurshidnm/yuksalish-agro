import { PRIORITIES, RECURRENCES } from '@yap/shared';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { ComboboxField, DateField, FormDialog, FormField, FormGrid, SelectField, SwitchField, TextField, TextareaField } from '@/components';
import { Select, apiOptions, type ComboboxOption } from '@/components/ui';
import { api } from '@/lib/api';
import { zEnum, zOptionalDate, zOptionalEnum, zOptionalRef, zOptionalText, zText } from '@/lib/forms';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation } from '@/lib/query';
import { DIVISIONS, ENTITY_TYPES, RECORD_TYPES, type MemberOption, type Task } from './types';

const schema = z.object({
  title: zText(200),
  description: zOptionalText(2000),
  assigneeUserId: zOptionalRef(),
  dueDate: zOptionalDate(),
  priority: zEnum(PRIORITIES),
  division: zOptionalEnum(DIVISIONS),
  entityType: zOptionalEnum(ENTITY_TYPES),
  entityId: zOptionalRef(),
  recurrence: zEnum(RECURRENCES),
  requiresPhoto: z.boolean(),
  requiresRecord: zOptionalEnum(RECORD_TYPES),
});

type FormValues = z.input<typeof schema>;

const EMPTY: FormValues = {
  title: '',
  description: '',
  assigneeUserId: null,
  dueDate: '',
  priority: 'normal',
  division: '',
  entityType: '',
  entityId: null,
  recurrence: 'none',
  requiresPhoto: false,
  requiresRecord: '',
};

function toForm(task: Task): FormValues {
  return {
    ...EMPTY,
    title: task.title,
    description: task.description ?? '',
    assigneeUserId: task.assigneeUserId,
    dueDate: task.dueDate ?? '',
    priority: task.priority,
    division: (task.division as FormValues['division']) ?? '',
    entityType: task.entityType ?? '',
    entityId: task.entityId,
    recurrence: task.recurrence,
    requiresPhoto: task.requiresPhoto,
    requiresRecord: task.requiresRecord ?? '',
  };
}

export const memberOptions = apiOptions<MemberOption>('/settings/users/lookup', (m) => ({ value: m.id, label: m.name }));

/** Lookups differ per object type, but all answer with an id plus something readable. */
const ENTITY_OPTIONS: Record<(typeof ENTITY_TYPES)[number], (search: string) => Promise<ComboboxOption[]>> = {
  field: apiOptions<{ id: string; number: string; name?: string | null }>('/farm/fields/lookup', (f) => ({
    value: f.id,
    label: f.name ? `${f.number} · ${f.name}` : f.number,
  })),
  herd: apiOptions<{ id: string; name: string }>('/livestock/herds/lookup', (h) => ({ value: h.id, label: h.name })),
  animal: apiOptions<{ id: string; tag: string }>('/livestock/animals/lookup', (a) => ({ value: a.id, label: a.tag })),
  asset: apiOptions<{ id: string; name: string; inventoryNo?: string | null }>('/assets/lookup', (a) => ({
    value: a.id,
    label: a.name,
    hint: a.inventoryNo ?? undefined,
  })),
};

interface TaskFormDialogProps {
  open: boolean;
  /** The task being edited; null when creating. */
  task: Task | null;
  onOpenChange: (open: boolean) => void;
}

export function TaskFormDialog({ open, task, onOpenChange }: TaskFormDialogProps) {
  const { t } = useTranslation('tasks');

  const save = useApiMutation<z.output<typeof schema>>({
    mutationFn: ({ recurrence, ...values }) => {
      // A link is meaningless without its object.
      const body = { ...values, entityType: values.entityId ? values.entityType : null };
      return task ? api.patch(`/tasks/${task.id}`, body) : api.post('/tasks', { ...body, recurrence });
    },
    invalidate: ['/tasks'],
    silentError: true,
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={task ? t('edit') : t('add')}
      schema={schema}
      defaultValues={task ? toForm(task) : EMPTY}
      onSubmit={(values) => save.mutateAsync(values)}
      successMessage={task ? 'common:toast.updated' : 'common:toast.created'}
      size="lg"
    >
      {(form) => {
        const entityType = form.watch('entityType');
        const recurrence = form.watch('recurrence');
        const requiresRecord = form.watch('requiresRecord');
        const requiresPhoto = form.watch('requiresPhoto');
        return (
          <>
            <TextField form={form} name="title" label={t('fields.title')} required autoFocus />
            <TextareaField form={form} name="description" label={t('fields.description')} />
            <FormGrid>
              <ComboboxField
                form={form}
                name="assigneeUserId"
                label={t('fields.assignee')}
                loadOptions={memberOptions}
                selectedLabel={task?.assigneeName}
                placeholder={t('fields.assigneePlaceholder')}
              />
              <DateField
                form={form}
                name="dueDate"
                label={recurrence === 'none' ? t('fields.dueDate') : t('fields.startDate')}
              />
              <SelectField form={form} name="priority" label={t('fields.priority')} options={enumOptions('priority', PRIORITIES)} />
              <SelectField
                form={form}
                name="division"
                label={t('fields.division')}
                placeholder={t('fields.noDivision')}
                options={DIVISIONS.map((d) => ({ value: d, label: t(`division.${d}`) }))}
              />
              <FormField form={form} name="entityType" label={t('fields.linkedType')}>
                {(field) => (
                  <Select
                    id={field.id}
                    value={field.value ?? ''}
                    onBlur={field.onBlur}
                    onChange={(e) => {
                      field.onChange(e.target.value);
                      // An id from the previous type would point at nothing.
                      form.setValue('entityId', null);
                    }}
                    placeholder={t('fields.noLink')}
                    options={ENTITY_TYPES.map((e) => ({ value: e, label: t(`entity.${e}`) }))}
                  />
                )}
              </FormField>
              {entityType ? (
                <ComboboxField
                  key={entityType}
                  form={form}
                  name="entityId"
                  label={t('fields.linkedObject')}
                  loadOptions={ENTITY_OPTIONS[entityType as (typeof ENTITY_TYPES)[number]]}
                  selectedLabel={task?.entityLabel}
                />
              ) : (
                <div className="hidden md:block" />
              )}
              {!task && (
                <SelectField
                  form={form}
                  name="recurrence"
                  label={t('fields.recurrence')}
                  hint={recurrence === 'none' ? undefined : t('fields.recurrenceHint')}
                  options={enumOptions('recurrence', RECURRENCES)}
                />
              )}
              <SelectField
                form={form}
                name="requiresRecord"
                label={t('fields.requiresRecord')}
                // The hint describes the rule once there is one: under "Not required" it would say the opposite.
                hint={requiresRecord ? t('fields.requiresRecordHint') : undefined}
                placeholder={t('fields.noRecord')}
                options={RECORD_TYPES.map((r) => ({ value: r, label: t(`record.${r}`) }))}
              />
            </FormGrid>
            <SwitchField
              form={form}
              name="requiresPhoto"
              label={t('fields.requiresPhoto')}
              hint={requiresPhoto ? t('fields.requiresPhotoHint') : undefined}
            />
          </>
        );
      }}
    </FormDialog>
  );
}
