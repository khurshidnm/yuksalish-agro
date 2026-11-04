import { latinToCyrillic } from '@yap/shared/i18n';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { I18nName } from './types';

/** Reference data carries its own translations. Uzbek Cyrillic is derived, as in the dictionaries. */
export function useLocalName(): (name: I18nName | null | undefined) => string {
  const { i18n } = useTranslation();
  const language = i18n.language;
  return useCallback(
    (name) => {
      if (!name) return '—';
      if (language === 'uz-Cyrl') return latinToCyrillic(name.uz);
      return name[language as keyof I18nName] ?? name.uz;
    },
    [language],
  );
}

/** The farm-wide center has a stored English name, so it is shown through its translated type. */
export function useCenterName(): (name: string | null | undefined, type: string | null | undefined) => string {
  const { t } = useTranslation('finance');
  return useCallback((name, type) => (type === 'general' ? t('enums:costCenterType.general') : (name ?? '—')), [t]);
}

/** The budget year runs from October to September: the 2026/27 farming season starts in autumn. */
export function budgetYear(today: string): number {
  const year = Number(today.slice(0, 4));
  return Number(today.slice(5, 7)) >= 10 ? year : year - 1;
}

export function budgetYearRange(year: number): { from: string; to: string } {
  return { from: `${year}-10`, to: `${year + 1}-09` };
}

export const budgetYearLabel = (year: number) => `${year}/${String(year + 1).slice(2)}`;

export const FINANCE_PATHS = {
  transactions: '/finance/transactions',
  accounts: '/finance/accounts',
  debts: '/finance/debts',
  budget: '/finance/budget',
  summary: '/finance/summary',
  costs: '/finance/costs',
  cashflow: '/finance/cashflow',
  loans: '/finance/loans',
  fx: '/finance/fx-rates',
};

/** Everything a posted transaction can change. */
export const MONEY_QUERIES = [
  FINANCE_PATHS.transactions,
  FINANCE_PATHS.accounts,
  FINANCE_PATHS.debts,
  FINANCE_PATHS.budget,
  FINANCE_PATHS.summary,
  FINANCE_PATHS.costs,
  FINANCE_PATHS.cashflow,
  FINANCE_PATHS.loans,
];
