import { latinToCyrillic } from '@yap/shared/i18n';
import { FileText, Upload, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { type FieldPath, type FieldValues } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { FormDialog, FormField, type FieldBaseProps, TextareaField } from '@/components';
import { apiOptions, Badge, Button } from '@/components/ui';
import { api } from '@/lib/api';
import { zText } from '@/lib/forms';
import i18n from '@/lib/i18n';
import { errorMessage } from '@/lib/query';
import type { LocalizedName, PurchaseStatus, SaleStatus } from './types';

type BadgeVariant = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'outline';

const SALE_STATUS_VARIANT: Record<SaleStatus, BadgeVariant> = {
  draft: 'neutral',
  pending: 'warning',
  confirmed: 'success',
  cancelled: 'outline',
};

const PURCHASE_STATUS_VARIANT: Record<PurchaseStatus, BadgeVariant> = {
  requested: 'warning',
  approved: 'info',
  rejected: 'outline',
  paid: 'info',
  received: 'success',
};

export function SaleStatusBadge({ status }: { status: SaleStatus }) {
  const { t } = useTranslation();
  return <Badge variant={SALE_STATUS_VARIANT[status]}>{t(`enums:saleStatus.${status}`)}</Badge>;
}

export function PurchaseStatusBadge({ status }: { status: PurchaseStatus }) {
  const { t } = useTranslation();
  return <Badge variant={PURCHASE_STATUS_VARIANT[status]}>{t(`enums:purchaseRequestStatus.${status}`)}</Badge>;
}

/** Reference data carries its name in three languages; Uzbek Cyrillic comes from the Latin one. */
export function localName(name: LocalizedName | null | undefined): string {
  if (!name) return '—';
  if (i18n.language === 'uz-Cyrl') return latinToCyrillic(name.uz);
  return name[i18n.language as keyof LocalizedName] ?? name.uz;
}

interface Named {
  id: string;
  name: string;
}

export const counterpartyOptions = apiOptions<Named & { type: string }>(
  '/finance/counterparties/lookup',
  (c) => ({ value: c.id, label: c.name }),
);

export const accountOptions = apiOptions<Named & { type: string; currency: string }>(
  '/finance/accounts/lookup',
  (a) => ({ value: a.id, label: a.name, hint: a.currency }),
);

export const warehouseOptions = apiOptions<Named & { type: string }>(
  '/inventory/warehouses/lookup',
  (w) => ({ value: w.id, label: w.name }),
);

export interface ItemLookup extends Named {
  category: string;
  unit: string;
  qtyOnHand: number | null;
  defaultWarehouseId?: string | null;
}

export const itemOptions = apiOptions<ItemLookup>('/inventory/items/lookup', (i) => ({
  value: i.id,
  label: i.name,
  hint: i.qtyOnHand === null ? i.unit : `${i.qtyOnHand} ${i.unit}`,
}));

export interface AnimalLookup {
  id: string;
  tag: string;
  category: string;
  sex: string;
  herdId: string | null;
}

export const animalOptions = apiOptions<AnimalLookup>('/livestock/animals/lookup', (a) => ({
  value: a.id,
  label: a.tag,
  hint: i18n.t(`enums:animalCategory.${a.category}`),
}));

interface ReasonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  submitLabel: string;
  onSubmit: (reason: string) => Promise<unknown>;
}

const reasonSchema = z.object({ reason: zText(500) });

/** Asks why, for actions that keep the reason on record: reject, cancel. */
export function ReasonDialog({ open, onOpenChange, title, description, submitLabel, onSubmit }: ReasonDialogProps) {
  const { t } = useTranslation('sales');
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      schema={reasonSchema}
      defaultValues={{ reason: '' }}
      onSubmit={(values) => onSubmit(values.reason)}
      submitLabel={submitLabel}
      size="sm"
    >
      {(form) => <TextareaField form={form} name="reason" label={t('reason')} required rows={3} />}
    </FormDialog>
  );
}

interface FileFieldProps<F extends FieldValues, N extends FieldPath<F>> extends FieldBaseProps<F, N> {
  /** Link to the file already attached, when editing. */
  currentUrl?: string | null;
}

/** Uploads straight away and stores the file id in the form. */
export function FileField<F extends FieldValues, N extends FieldPath<F>>({ currentUrl, ...props }: FileFieldProps<F, N>) {
  const { t } = useTranslation('sales');
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [picked, setPicked] = useState<{ name: string; url: string } | null>(null);

  return (
    <FormField {...props}>
      {(field) => {
        const url = picked?.url ?? (field.value ? currentUrl : null);
        const upload = async (file: File | undefined) => {
          if (!file) return;
          setUploading(true);
          try {
            const stored = await api.upload(file);
            setPicked({ name: stored.name, url: stored.url });
            field.onChange(stored.id);
          } catch (error) {
            toast.error(errorMessage(error));
          } finally {
            setUploading(false);
            if (input.current) input.current.value = '';
          }
        };
        return (
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={input}
              id={field.id}
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              className="sr-only"
              aria-label={t('file.choose')}
              onChange={(e) => void upload(e.target.files?.[0])}
            />
            <Button variant="outline" onClick={() => input.current?.click()} loading={uploading}>
              <Upload aria-hidden />
              {field.value ? t('file.replace') : t('file.choose')}
            </Button>
            {url && (
              <a href={url} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-1.5 text-sm text-primary underline">
                <FileText className="size-4" aria-hidden />
                {picked?.name ?? t('file.open')}
              </a>
            )}
            {field.value && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('file.remove')}
                onClick={() => {
                  setPicked(null);
                  field.onChange(null);
                }}
              >
                <X aria-hidden />
              </Button>
            )}
          </div>
        );
      }}
    </FormField>
  );
}
