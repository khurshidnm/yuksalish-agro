import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { ErrorCard, NumberField, SwitchField, TextField } from '@/components';
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { zOptionalNumber, zOptionalText } from '@/lib/forms';
import i18n from '@/lib/i18n';
import { useApiMutation, useDetail } from '@/lib/query';
import { InlineForm } from './shared';

const POLICY = '/settings/policy';

/** The same shape the server accepts: 3 to 40 Latin letters, digits and hyphens. */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const MAX_TARGET_KG = 2000;

const schema = z.object({
  livestock: z.object({
    saleTargetWeightKg: zOptionalNumber().refine((kg) => kg === null || (kg > 0 && kg <= MAX_TARGET_KG), {
      error: () => i18n.t('common:validation.invalid'),
    }),
  }),
  catalogue: z.object({
    enabled: z.boolean(),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .nullish()
      .transform((slug) => slug || null)
      .refine((slug) => slug === null || SLUG.test(slug), { error: () => i18n.t('settings:salesTab.slugHint') }),
    contact: zOptionalText(200),
  }),
});

type Values = z.input<typeof schema>;

interface Policy {
  livestock: { saleTargetWeightKg: number | null };
  catalogue: { enabled: boolean; slug: string | null; contact: string | null };
}

/** What the farm sells at, and its public page of animals for sale. The page is off until switched on. */
export function SalesSettingsTab() {
  const { t } = useTranslation('settings');
  const canUpdate = useCan()('settings.update');
  const query = useDetail<Policy>(POLICY);
  const save = useApiMutation<z.output<typeof schema>>({
    // Only these two sections: the rest of the policy is left as it is.
    mutationFn: (values) => api.patch(POLICY, values),
    invalidate: [POLICY, '/livestock/sale-readiness'],
    silentError: true,
  });

  const stored = query.data;
  const values = useMemo<Values | null>(
    () =>
      stored
        ? {
            livestock: { saleTargetWeightKg: stored.livestock.saleTargetWeightKg },
            catalogue: { enabled: stored.catalogue.enabled, slug: stored.catalogue.slug ?? '', contact: stored.catalogue.contact ?? '' },
          }
        : null,
    [stored],
  );

  if (query.error) return <ErrorCard error={query.error} onRetry={() => void query.refetch()} />;
  if (!stored || !values) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  const address = stored.catalogue.slug ? `${window.location.origin}/catalogue/${stored.catalogue.slug}` : null;

  return (
    <InlineForm schema={schema} values={values} readOnly={!canUpdate} onSubmit={(next) => save.mutateAsync(next)}>
      {(form) => (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t('salesTab.targetTitle')}</CardTitle>
              <CardDescription>{t('salesTab.targetHint')}</CardDescription>
            </CardHeader>
            <CardContent>
              <NumberField form={form} name="livestock.saleTargetWeightKg" label={t('salesTab.targetWeight')} suffix={t('enums:unit.kg')} maxDigits={1} className="sm:max-w-xs" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('salesTab.catalogueTitle')}</CardTitle>
              <CardDescription>{t('salesTab.catalogueHint')}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <SwitchField form={form} name="catalogue.enabled" label={t('salesTab.enabled')} />
              <TextField form={form} name="catalogue.slug" label={t('salesTab.slug')} hint={t('salesTab.slugHint')} autoComplete="off" maxLength={40} />
              <TextField form={form} name="catalogue.contact" label={t('salesTab.contact')} hint={t('salesTab.contactHint')} maxLength={200} />
              {stored.catalogue.enabled && address ? (
                <Alert tone="info">
                  {t('salesTab.link')}{' '}
                  <a href={address} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center font-medium break-all underline underline-offset-2">
                    {address}
                  </a>
                </Alert>
              ) : (
                <p className="text-sm text-muted-foreground">{t('salesTab.linkOff')}</p>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </InlineForm>
  );
}
