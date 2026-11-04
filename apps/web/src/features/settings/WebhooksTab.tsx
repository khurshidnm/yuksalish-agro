import { History, Pause, Pencil, Play, Plus, Send, Trash2, Webhook } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { type Column, DataTable, DataTableView, FormDialog, TextField, TextareaField, useConfirm } from '@/components';
import { Badge, Button, type BadgeVariant, Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { zOptionalText } from '@/lib/forms';
import { useApiMutation, useDetail } from '@/lib/query';
import { ShowOnceDialog } from './shared';

const HOOKS = '/settings/webhooks';

interface Subscription {
  id: string;
  url: string;
  description: string | null;
  eventTypes: string[];
  active: boolean;
  createdAt: string;
}

interface Delivery {
  id: string;
  eventType: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  nextAttemptAt: string;
  lastStatusCode: number | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

const STATUS_VARIANT: Record<Delivery['status'], BadgeVariant> = { pending: 'warning', delivered: 'success', failed: 'danger' };

const PATTERN = /^(\*|[a-z0-9_]+(\.[a-z0-9_]+)*(\.\*)?)$/;

const parseTypes = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);

const schema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  description: zOptionalText(200),
  eventTypes: z
    .string()
    .refine((text) => {
      const types = parseTypes(text);
      return types.length > 0 && types.every((type) => PATTERN.test(type));
    }),
});

function DeliveriesDialog({ hook, onClose }: { hook: Subscription | null; onClose: () => void }) {
  const { t } = useTranslation('settings');
  const path = `${HOOKS}/${hook?.id}/deliveries`;
  const retry = useApiMutation<string>({
    mutationFn: (deliveryId) => api.post(`${HOOKS}/${hook?.id}/deliveries/${deliveryId}/retry`),
    invalidate: [path],
    successMessage: 'settings:webhooks.retryQueued',
  });

  const columns: Column<Delivery>[] = [
    { key: 'eventType', header: t('webhooks.event'), cell: (row) => <code className="font-mono text-sm">{row.eventType}</code>, mobile: 'title' },
    { key: 'status', header: t('webhooks.deliveryStatus'), cell: (row) => <Badge variant={STATUS_VARIANT[row.status]}>{t(`webhooks.statuses.${row.status}`)}</Badge>, mobile: 'subtitle' },
    { key: 'attempts', header: t('webhooks.attempts'), cell: (row) => row.attempts, align: 'right' },
    { key: 'lastError', header: t('webhooks.lastError'), cell: (row) => row.lastError ?? '—' },
    {
      key: 'nextAttemptAt',
      header: t('webhooks.nextAttempt'),
      cell: (row) => (row.status === 'pending' ? formatDateTime(row.nextAttemptAt) : '—'),
    },
    { key: 'createdAt', header: t('webhooks.createdAt'), cell: (row) => formatDateTime(row.createdAt), mobile: 'hidden' },
  ];

  return (
    <Dialog open={hook !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>{t('webhooks.logTitle')}</DialogTitle>
          <DialogDescription className="break-all">{hook?.url}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {hook && (
            <DataTable<Delivery>
              path={path}
              columns={columns}
              urlPrefix="log"
              searchable={false}
              pageSize={10}
              empty={{ icon: History, title: t('webhooks.logEmpty') }}
              rowActions={(row) => [
                { label: t('webhooks.retry'), icon: Send, hidden: row.status === 'delivered', onClick: () => retry.mutate(row.id) },
              ]}
            />
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

export function WebhooksTab() {
  const { t } = useTranslation('settings');
  const confirm = useConfirm();
  const query = useDetail<Subscription[]>(HOOKS);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Subscription | null>(null);
  const [log, setLog] = useState<Subscription | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  const toBody = (values: z.output<typeof schema>) => ({ ...values, eventTypes: parseTypes(values.eventTypes) });

  const save = useApiMutation<z.output<typeof schema>, Subscription & { secret?: string }>({
    mutationFn: (values) => (editing ? api.patch(`${HOOKS}/${editing.id}`, toBody(values)) : api.post(HOOKS, toBody(values))),
    invalidate: [HOOKS],
    silentError: true,
    onSuccess: (result) => {
      if (result.secret) setSecret(result.secret);
      else toast.success(t('common:toast.updated'));
    },
  });
  const setActive = useApiMutation<{ id: string; active: boolean }>({
    mutationFn: ({ id, active }) => api.patch(`${HOOKS}/${id}`, { active }),
    invalidate: [HOOKS],
    successMessage: 'common:toast.updated',
  });
  const test = useApiMutation<string>({
    mutationFn: (id) => api.post(`${HOOKS}/${id}/test`),
    successMessage: 'settings:webhooks.testQueued',
  });
  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${HOOKS}/${id}`),
    invalidate: [HOOKS],
    successMessage: 'common:toast.deleted',
  });

  const columns: Column<Subscription>[] = [
    { key: 'url', header: t('webhooks.url'), cell: (row) => <span className="break-all">{row.url}</span>, mobile: 'title' },
    { key: 'description', header: t('webhooks.descriptionField'), cell: (row) => row.description ?? '—', mobile: 'hidden' },
    {
      key: 'eventTypes',
      header: t('webhooks.events'),
      cell: (row) => (
        <span className="flex flex-wrap gap-1">
          {row.eventTypes.map((type) => (
            <Badge key={type} variant="outline" className="font-mono">
              {type}
            </Badge>
          ))}
        </span>
      ),
    },
    {
      key: 'active',
      header: t('webhooks.state'),
      cell: (row) => (row.active ? <Badge variant="success">{t('webhooks.on')}</Badge> : <Badge>{t('webhooks.paused')}</Badge>),
      mobile: 'subtitle',
    },
  ];

  const addButton = (
    <Button onClick={() => setCreating(true)}>
      <Plus aria-hidden />
      {t('webhooks.add')}
    </Button>
  );

  return (
    <>
      <p className="mb-3 text-sm text-muted-foreground">{t('webhooks.hint')}</p>
      <div className="mb-3 flex justify-end">{addButton}</div>
      <DataTableView<Subscription>
        rows={query.data ?? []}
        columns={columns}
        loading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
        empty={{ icon: Webhook, title: t('webhooks.emptyTitle'), description: t('webhooks.emptyBody'), action: addButton }}
        rowActions={(row) => [
          { label: t('webhooks.log'), icon: History, onClick: () => setLog(row) },
          { label: t('webhooks.test'), icon: Send, onClick: () => test.mutate(row.id) },
          { label: t('common:actions.edit'), icon: Pencil, onClick: () => setEditing(row) },
          {
            label: row.active ? t('webhooks.pause') : t('webhooks.resume'),
            icon: row.active ? Pause : Play,
            onClick: () => setActive.mutate({ id: row.id, active: !row.active }),
          },
          {
            label: t('common:actions.delete'),
            icon: Trash2,
            destructive: true,
            onClick: () =>
              void confirm({ title: t('webhooks.deleteTitle'), description: row.url, destructive: true }).then((ok) => ok && remove.mutate(row.id)),
          },
        ]}
      />

      <FormDialog
        open={creating || editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
          }
        }}
        title={editing ? t('webhooks.edit') : t('webhooks.add')}
        schema={schema}
        defaultValues={{
          url: editing?.url ?? '',
          description: editing?.description ?? '',
          eventTypes: editing?.eventTypes.join('\n') ?? '',
        }}
        onSubmit={(values) => save.mutateAsync(values)}
      >
        {(form) => (
          <>
            <TextField form={form} name="url" label={t('webhooks.url')} hint={t('webhooks.urlHint')} required type="url" inputMode="url" placeholder="https://" autoFocus />
            <TextField form={form} name="description" label={t('webhooks.descriptionField')} />
            <TextareaField form={form} name="eventTypes" label={t('webhooks.events')} hint={t('webhooks.eventsHint')} required rows={4} placeholder={'sale.*\nanimal.lambed\nalert.raised'} />
          </>
        )}
      </FormDialog>

      <ShowOnceDialog
        secret={secret}
        title={t('webhooks.createdTitle')}
        description={t('webhooks.createdBody')}
        label={t('webhooks.secret')}
        onClose={() => setSecret(null)}
      />

      <DeliveriesDialog hook={log} onClose={() => setLog(null)} />
    </>
  );
}
