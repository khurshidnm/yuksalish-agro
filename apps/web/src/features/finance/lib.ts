import { latinToCyrillic } from '@yap/shared/i18n';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { I18nName, Transaction } from './types';

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

type JournalEntry = Pick<Transaction, 'status' | 'sourceType' | 'type'>;

/** The assistant only prepares entries, so what it wrote stays with finance. */
const ownedByFinance = (row: JournalEntry) => !row.sourceType || row.sourceType === 'ai_proposal';

/** Entries of other modules whose money can be cancelled here. The rest are changed where they were made. */
const CANCELLED_IN_FINANCE = ['stock_batch', 'stock_doc', 'animal_exit', 'maintenance', 'rental_act', 'purchase_request'];

/** Only an entry still waiting can change: an approved one is voided, and a rejected one stays as history. */
export const canDeleteEntry = (row: JournalEntry) => row.status === 'pending' && ownedByFinance(row);

/** A settlement is limited by the debt it pays, so changing it means entering it again. */
export const canEditEntry = (row: JournalEntry) => canDeleteEntry(row) && row.type !== 'debt_payment' && row.type !== 'debt_receipt';

export const canVoidEntry = (row: JournalEntry) =>
  row.status === 'approved' && (ownedByFinance(row) || CANCELLED_IN_FINANCE.includes(row.sourceType ?? ''));

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
  unpaidReceipts: '/finance/debts/unpaid-receipts',
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
