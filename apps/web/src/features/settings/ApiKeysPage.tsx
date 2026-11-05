import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { type Column, DataTableView, FormDialog, PageHeader, SelectField, TextField, UrlTabs, useConfirm } from '@/components';
import { Badge, Button } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/format';
import { zText } from '@/lib/forms';
import { useApiMutation, useDetail } from '@/lib/query';
import { ShowOnceDialog } from './shared';
import { WebhooksTab } from './WebhooksTab';

const KEYS = '/settings/api-keys';

interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

const schema = z.object({ name: zText(120), scope: z.enum(['events:write', '*']), expiry: z.enum(['never', '90', '365']) });

function KeysTab() {
  const { t } = useTranslation('settings');
  const confirm = useConfirm();
  const query = useDetail<ApiKey[]>(KEYS);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);

  const create = useApiMutation<z.output<typeof schema>, ApiKey & { key: string }>({
    mutationFn: ({ name, scope, expiry }) => api.post(KEYS, { name, scopes: [scope], expiresInDays: expiry === 'never' ? null : Number(expiry) }),
    invalidate: [KEYS],
    silentError: true,
    onSuccess: (result) => setSecret(result.key),
  });
  const revoke = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${KEYS}/${id}`),
    invalidate: [KEYS],
    successMessage: 'common:toast.updated',
  });

  const columns: Column<ApiKey>[] = [
    { key: 'name', header: t('apiKeys.name'), cell: (row) => row.name, mobile: 'title' },
    { key: 'keyPrefix', header: t('apiKeys.key'), cell: (row) => <code className="font-mono text-sm">{row.keyPrefix}…</code>, mobile: 'subtitle' },
    { key: 'scopes', header: t('apiKeys.scope'), cell: (row) => row.scopes.map((scope) => t(`apiKeys.scopes.${scope === '*' ? 'all' : 'events'}`)).join(', ') },
    { key: 'lastUsedAt', header: t('apiKeys.lastUsed'), cell: (row) => (row.lastUsedAt ? formatDateTime(row.lastUsedAt) : t('apiKeys.neverUsed')) },
    { key: 'expiresAt', header: t('apiKeys.expires'), cell: (row) => (row.expiresAt ? formatDate(row.expiresAt) : t('apiKeys.expiryNever')), mobile: 'hidden' },
    {
      key: 'status',
      header: t('apiKeys.status'),
      cell: (row) => {
        if (row.revokedAt) return <Badge variant="danger">{t('apiKeys.revoked')}</Badge>;
        if (row.expiresAt && new Date(row.expiresAt) <= new Date()) return <Badge variant="danger">{t('apiKeys.expired')}</Badge>;
        return <Badge variant="success">{t('apiKeys.active')}</Badge>;
      },
    },
  ];

  const addButton = (
    <Button onClick={() => setCreating(true)}>
      <Plus aria-hidden />
      {t('apiKeys.add')}
    </Button>
  );

  return (
    <>
      <p className="mb-3 text-sm text-muted-foreground">{t('apiKeys.hint')}</p>
      <div className="mb-3 flex justify-end">{addButton}</div>
      <DataTableView<ApiKey>
        rows={query.data ?? []}
        columns={columns}
        loading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
        empty={{ icon: KeyRound, title: t('apiKeys.emptyTitle'), description: t('apiKeys.emptyBody'), action: addButton }}
        rowActions={(row) => [
          {
            label: t('apiKeys.revoke'),
            icon: Trash2,
            destructive: true,
            hidden: row.revokedAt !== null,
            onClick: () =>
              void confirm({
                title: t('apiKeys.revokeTitle'),
                description: t('apiKeys.revokeBody', { name: row.name }),
                confirmLabel: t('apiKeys.revoke'),
                destructive: true,
              }).then((ok) => ok && revoke.mutate(row.id)),
          },
        ]}
      />

      <FormDialog
        open={creating}
        onOpenChange={setCreating}
        title={t('apiKeys.add')}
        schema={schema}
        defaultValues={{ name: '', scope: 'events:write', expiry: 'never' }}
        onSubmit={(values) => create.mutateAsync(values)}
      >
        {(form) => (
          <>
            <TextField form={form} name="name" label={t('apiKeys.name')} hint={t('apiKeys.nameHint')} required autoFocus />
            <SelectField
              form={form}
              name="scope"
              label={t('apiKeys.scope')}
              options={[
                { value: 'events:write', label: t('apiKeys.scopes.events') },
                { value: '*', label: t('apiKeys.scopes.all') },
              ]}
            />
            <SelectField
              form={form}
              name="expiry"
              label={t('apiKeys.expiry')}
              options={[
                { value: 'never', label: t('apiKeys.expiryNever') },
                { value: '90', label: t('apiKeys.expiry90') },
                { value: '365', label: t('apiKeys.expiry365') },
              ]}
            />
          </>
        )}
      </FormDialog>

      <ShowOnceDialog
        secret={secret}
        title={t('apiKeys.createdTitle')}
        description={t('apiKeys.createdBody')}
        label={t('apiKeys.key')}
        onClose={() => setSecret(null)}
      />
    </>
  );
}

export default function ApiKeysPage() {
  const { t } = useTranslation('settings');
  return (
    <>
      <PageHeader title={t('apiKeys.title')} description={t('apiKeys.description')} />
      <UrlTabs
        tabs={[
          { value: 'keys', label: t('apiKeys.tabKeys'), content: <KeysTab /> },
          { value: 'webhooks', label: t('apiKeys.tabWebhooks'), content: <WebhooksTab /> },
        ]}
      />
    </>
  );
}
