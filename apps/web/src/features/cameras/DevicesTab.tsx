import { DEVICE_STATUSES, DEVICE_TYPES } from '@yap/shared';
import { Camera, KeySquare, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { type Column, ComboboxField, DataTable, FormDialog, FormGrid, NumberField, SelectField, TextField, TextareaField, useConfirm, useUrlParam } from '@/components';
import { Badge, Button, Select, apiOptions } from '@/components/ui';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { zEnum, zOptionalEnum, zOptionalNumber, zOptionalRef, zOptionalText, zText } from '@/lib/forms';
import { enumOptions } from '@/lib/i18n';
import { useApiMutation, useDetail } from '@/lib/query';
import { CAMERA_ZONES, DEVICES, type Device, STATUS_VARIANT } from './types';

interface ApiKey {
  id: string;
  name: string;
  revokedAt: string | null;
}

const schema = z.object({
  type: zEnum(DEVICE_TYPES),
  name: zText(120),
  zone: zOptionalEnum(CAMERA_ZONES),
  facilityId: zOptionalRef(),
  streamUrl: zOptionalText(500),
  onvifUrl: zOptionalText(500),
  liveUrl: zOptionalText(500).refine((value) => !value || /^https?:\/\//i.test(value)),
  offlineAfterMinutes: zOptionalNumber(),
  apiKeyId: zOptionalRef(),
  notes: zOptionalText(1000),
});

type FormValues = z.input<typeof schema>;

const EMPTY: FormValues = {
  type: 'camera',
  name: '',
  zone: '',
  facilityId: '',
  streamUrl: '',
  onvifUrl: '',
  liveUrl: '',
  offlineAfterMinutes: null,
  apiKeyId: '',
  notes: '',
};

const toForm = (row: Device): FormValues => ({
  type: row.type as FormValues['type'],
  name: row.name,
  zone: row.zone ?? '',
  facilityId: row.facilityId ?? '',
  streamUrl: row.streamUrl ?? '',
  onvifUrl: row.onvifUrl ?? '',
  liveUrl: row.liveUrl ?? '',
  offlineAfterMinutes: row.offlineAfterMinutes,
  apiKeyId: row.apiKeyId ?? '',
  notes: row.notes ?? '',
});

export function DevicesTab() {
  const { t } = useTranslation('cameras');
  const can = useCan();
  const confirm = useConfirm();
  const canCreate = can('cameras.create');
  const [type, setType] = useUrlParam('type');
  const [status, setStatus] = useUrlParam('status');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Device | null>(null);

  const keys = useDetail<ApiKey[]>(can('settings.view') ? '/settings/api-keys' : null);
  const keyOptions = (keys.data ?? []).filter((key) => !key.revokedAt).map((key) => ({ value: key.id, label: key.name }));

  const save = useApiMutation<z.output<typeof schema>>({
    mutationFn: (values) => (editing ? api.patch(`${DEVICES}/${editing.id}`, values) : api.post(DEVICES, values)),
    invalidate: [DEVICES, '/devices/plan'],
    silentError: true,
  });
  const remove = useApiMutation<string>({
    mutationFn: (id) => api.delete(`${DEVICES}/${id}`),
    invalidate: [DEVICES, '/devices/plan'],
    successMessage: 'common:toast.deleted',
  });

  const columns: Column<Device>[] = [
    { key: 'name', header: t('devices.name'), cell: (row) => row.name, sortable: true, mobile: 'title' },
    { key: 'type', header: t('devices.type'), cell: (row) => t(`enums:deviceType.${row.type}`), mobile: 'subtitle' },
    { key: 'zone', header: t('devices.zone'), cell: (row) => (row.zone ? t(`zones.${row.zone}`) : '—') },
    { key: 'status', header: t('devices.status'), sortable: true, cell: (row) => <Badge variant={STATUS_VARIANT[row.status]}>{t(`enums:deviceStatus.${row.status}`)}</Badge> },
    { key: 'lastSeenAt', header: t('devices.lastSeen'), sortable: true, cell: (row) => formatDateTime(row.lastSeenAt), mobile: 'hidden' },
  ];

  const addButton = canCreate && (
    <Button onClick={() => setCreating(true)}>
      <Plus aria-hidden />
      {t('devices.add')}
    </Button>
  );

  return (
    <>
      <div className="mb-3 flex justify-end empty:hidden">{addButton}</div>
      <DataTable<Device>
        path={DEVICES}
        params={{ type: type || undefined, status: status || undefined }}
        columns={columns}
        defaultSort="name"
        urlPrefix="d"
        searchPlaceholder={t('devices.searchPlaceholder')}
        filters={
          <>
            <Select aria-label={t('devices.type')} value={type} onChange={(e) => setType(e.target.value)} options={enumOptions('deviceType', DEVICE_TYPES)} placeholder={t('devices.allTypes')} className="md:w-48" />
            <Select aria-label={t('devices.status')} value={status} onChange={(e) => setStatus(e.target.value)} options={enumOptions('deviceStatus', DEVICE_STATUSES)} placeholder={t('devices.allStatuses')} className="md:w-44" />
          </>
        }
        empty={{ icon: Camera, title: t('devices.emptyTitle'), description: t('devices.emptyBody'), action: addButton }}
        rowActions={(row) => [
          { label: t('common:actions.edit'), icon: Pencil, hidden: !can('cameras.update'), onClick: () => setEditing(row) },
          {
            label: t('common:actions.delete'),
            icon: Trash2,
            destructive: true,
            hidden: !can('cameras.delete'),
            onClick: () =>
              void confirm({
                title: t('devices.deleteTitle'),
                description: t('devices.deleteBody', { name: row.name }),
                destructive: true,
              }).then((ok) => ok && remove.mutate(row.id)),
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
        title={editing ? t('devices.edit') : t('devices.add')}
        schema={schema}
        size="lg"
        defaultValues={editing ? toForm(editing) : EMPTY}
        successMessage={editing ? 'common:toast.updated' : 'common:toast.created'}
        onSubmit={(values) => save.mutateAsync(values)}
      >
        {(form) => {
          const isCamera = form.watch('type') === 'camera';
          return (
            <>
              <FormGrid>
                <SelectField form={form} name="type" label={t('devices.type')} required options={enumOptions('deviceType', DEVICE_TYPES)} />
                <TextField form={form} name="name" label={t('devices.name')} required autoFocus />
              </FormGrid>
              <FormGrid>
                <SelectField form={form} name="zone" label={t('devices.zone')} options={CAMERA_ZONES.map((zone) => ({ value: zone, label: t(`zones.${zone}`) }))} />
                <ComboboxField
                  form={form}
                  name="facilityId"
                  label={t('devices.facility')}
                  clearable
                  loadOptions={apiOptions<{ id: string; name: string }>('/farm/facilities/lookup', (row) => ({ value: row.id, label: row.name }))}
                />
              </FormGrid>
              {isCamera && (
                <>
                  <TextField form={form} name="streamUrl" label={t('devices.streamUrl')} hint={t('devices.streamUrlHint')} autoComplete="off" placeholder="rtsp://192.168.1.20:554/stream1" />
                  {editing?.hasStreamCredentials && (
                    <p className="-mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <KeySquare className="size-3.5" aria-hidden />
                      {t('devices.credentialsStored')}
                    </p>
                  )}
                  <TextField form={form} name="onvifUrl" label={t('devices.onvifUrl')} hint={t('devices.onvifUrlHint')} autoComplete="off" />
                  <TextField form={form} name="liveUrl" label={t('devices.liveUrl')} hint={t('devices.liveUrlHint')} autoComplete="off" inputMode="url" placeholder="https://" />
                </>
              )}
              <FormGrid>
                <NumberField form={form} name="offlineAfterMinutes" label={t('devices.offlineAfter')} hint={t('devices.offlineAfterHint')} suffix={t('devices.minutes')} maxDigits={0} />
                {can('settings.view') && <SelectField form={form} name="apiKeyId" label={t('devices.apiKey')} hint={t('devices.apiKeyHint')} placeholder={t('devices.anyKey')} options={keyOptions} />}
              </FormGrid>
              <TextareaField form={form} name="notes" label={t('devices.notes')} rows={2} />
            </>
          );
        }}
      </FormDialog>
    </>
  );
}
