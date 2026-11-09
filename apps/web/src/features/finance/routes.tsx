import type { RouteObject } from 'react-router';
import { page } from '@/app/guards';

export const routes: RouteObject[] = [
  { path: 'finance/transactions', element: page(() => import('./TransactionsPage'), 'finance.view') },
  { path: 'finance/accounts', element: page(() => import('./AccountsPage'), 'finance.view') },
  { path: 'finance/cash-holders', element: page(() => import('./CashHoldersPage'), 'finance.view') },
  { path: 'finance/counterparties', element: page(() => import('./CounterpartiesPage'), 'finance.view') },
  { path: 'finance/debts', element: page(() => import('./DebtsPage'), 'finance.view') },
  { path: 'finance/budget', element: page(() => import('./BudgetPage'), 'finance.view') },
  { path: 'finance/costs', element: page(() => import('./CostsPage'), 'finance.view') },
  { path: 'finance/cashflow', element: page(() => import('./CashflowPage'), 'finance.view') },
  { path: 'finance/loans', element: page(() => import('./LoansPage'), 'finance.view') },
];
