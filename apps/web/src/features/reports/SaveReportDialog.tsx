import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { FormDialog, FormField, FormGrid, SelectField, SwitchField, TextField } from '@/components';
import { Checkbox, Label, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { usePermission, useSession } from '@/lib/auth';
import { zText } from '@/lib/forms';
import { useApiMutation, useDetail } from '@/lib/query';
import type { SavedConfig, SavedReport } from './types';

const PATH = '/reports/saved';
const SCHEDULES = ['none', 'daily', 'weekly', 'monthly'] as const;

const schema = z.object({
  name: zText(120),
  schedule: z.enum(SCHEDULES),
  telegram: z.boolean(),
  recipients: z.array(z.string()),
});
type Values = z.infer<typeof schema>;

interface Member {
  id: string;
  fullName: string;
  roleKey: string;
}

function RecipientList({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const { t } = useTranslation('reports');
  const members = useDetail<Member[]>('/settings/users/lookup');
  if (members.isLoading) return <Skeleton className="h-24 w-full" />;
  // Without the list, the report still goes to its owner, so this is a hint and not a blocker.
  if (members.isError) return <p className="text-sm text-muted-foreground">{t('builder.selfOnly')}</p>;
  return (
    <ul className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
      {(members.data ?? []).map((member) => (
        <li key={member.id}>
          <Label className="flex min-h-11 cursor-pointer items-center gap-3 font-normal">
            <Checkbox
              checked={value.includes(member.id)}
              onCheckedChange={(checked) =>
                onChange(checked ? [...value, member.id] : value.filter((id) => id !== member.id))
              }
            />
            <span className="min-w-0 flex-1 truncate">{member.fullName}</span>
            <span className="text-sm text-muted-foreground">{t(`enums:role.${member.roleKey}`)}</span>
          </Label>
        </li>
      ))}
    </ul>
  );
}

export interface SaveReportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Save a new report from this viewer state. */
  draft?: { reportKey: string; config: SavedConfig; name: string };
  /** Or change an existing one. */
  saved?: SavedReport | null;
}

export function SaveReportDialog({ open, onOpenChange, draft, saved }: SaveReportDialogProps) {
  const { t } = useTranslation('reports');
  const session = useSession();
  const canChooseRecipients = usePermission('reports.update');

  const submit = useApiMutation({
    mutationFn: (values: Values) => {
      const body = {
        name: values.name,
        schedule: values.schedule === 'none' ? null : values.schedule,
        channels: values.telegram ? ['telegram'] : [],
        recipients: values.recipients.length ? values.recipients : [session.user.id],
      };
      return saved
        ? api.patch(`${PATH}/${saved.id}`, body)
        : api.post(PATH, { ...body, reportKey: draft!.reportKey, config: draft!.config });
    },
    invalidate: [PATH],
    silentError: true,
  });

  const defaults: Values = {
    name: saved?.name ?? draft?.name ?? '',
    schedule: saved?.schedule ?? 'none',
    telegram: saved ? saved.channels.includes('telegram') : true,
    recipients: saved?.recipients ?? [session.user.id],
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t(saved ? 'saved.edit' : 'builder.saveAs')}
      schema={schema}
      defaultValues={defaults}
      onSubmit={(values) => submit.mutateAsync(values)}
      successMessage={t(saved ? 'saved.updated' : 'builder.saved')}
    >
      {(form) => (
        <FormGrid>
          <TextField form={form} name="name" label={t('builder.name')} required className="sm:col-span-2" />
          <SelectField
            form={form}
            name="schedule"
            label={t('builder.schedule')}
            options={SCHEDULES.map((value) => ({ value, label: t(`schedule.${value}`) }))}
          />
          <SwitchField form={form} name="telegram" label={t('builder.telegram')} />
          {canChooseRecipients ? (
            <FormField form={form} name="recipients" label={t('builder.recipients')} hint={t('builder.recipientsHint')} className="sm:col-span-2">
              {(field) => <RecipientList value={field.value as string[]} onChange={field.onChange} />}
            </FormField>
          ) : (
            <p className="text-sm text-muted-foreground sm:col-span-2">{t('builder.selfOnly')}</p>
          )}
        </FormGrid>
      )}
    </FormDialog>
  );
}
