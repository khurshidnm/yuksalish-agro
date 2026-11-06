import { monthOf, todayIso } from '@yap/shared';
import { Calculator } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { MoneyText, useConfirm } from '@/components';
import { Alert, Button } from '@/components/ui';
import { api } from '@/lib/api';
import { formatMonth } from '@/lib/format';
import { useApiMutation } from '@/lib/query';
import type { DepreciationRun } from './types';

export function DepreciationRunButton({ onResult }: { onResult: (run: DepreciationRun) => void }) {
  const { t } = useTranslation('assets');
  const confirm = useConfirm();
  const run = useApiMutation<void, DepreciationRun>({
    mutationFn: () => api.postOnce<DepreciationRun>('/assets/depreciation/run', {}),
    invalidate: ['/assets', '/finance', '/reports'],
    onSuccess: onResult,
  });

  return (
    <Button
      size="lg"
      variant="outline"
      loading={run.isPending}
      onClick={async () => {
        const ok = await confirm({ title: t('depreciation.confirmTitle'), description: t('depreciation.confirmBody'), confirmLabel: t('depreciation.run') });
        if (ok) run.mutate();
      }}
    >
      <Calculator aria-hidden />
      {t('depreciation.run')}
    </Button>
  );
}

export function DepreciationResultAlert({ run }: { run: DepreciationRun }) {
  const { t } = useTranslation('assets');

  if (run.posted === 0) {
    return (
      <Alert className="mb-4" title={t('depreciation.nothingTitle')}>
        {t('depreciation.nothingBody', { month: formatMonth(monthOf(todayIso())) })}
      </Alert>
    );
  }
  return (
    <Alert tone="success" className="mb-4" title={t('depreciation.postedTitle')}>
      <ul>
        {run.months.map((line) => (
          <li key={line.month} className="flex flex-wrap justify-between gap-x-3">
            <span>
              {formatMonth(line.month)}, {t('depreciation.machines', { count: line.posted })}
            </span>
            <MoneyText value={line.total} />
          </li>
        ))}
      </ul>
      <p className="mt-1 font-medium">
        {t('depreciation.total')}: <MoneyText value={run.total} />
      </p>
    </Alert>
  );
}
