export interface I18nName {
  uz: string;
  ru: string;
  en: string;
}

export interface Transaction {
  id: string;
  date: string;
  type: 'expense' | 'income' | 'transfer' | 'debt_payment' | 'debt_receipt';
  status: 'draft' | 'pending' | 'approved' | 'rejected';
  amount: number;
  currency: string;
  fxRate: number;
  amountBase: number;
  paymentMethod: string;
  costTreatment: string;
  description: string | null;
  dueDate: string | null;
  fileId: string | null;
  sourceType: string | null;
  sourceId: string | null;
  rejectedReason: string | null;
  categoryId: string | null;
  categoryName: I18nName | null;
  categoryGroup: string | null;
  accountId: string | null;
  accountName: string | null;
  toAccountId: string | null;
  toAccountName: string | null;
  counterpartyId: string | null;
  counterpartyName: string | null;
  costCenterId: string | null;
  costCenterName: string | null;
  costCenterType: string | null;
  createdBy: string | null;
  createdByName: string | null;
  approvedByName: string | null;
  createdAt: string;
  /** Sent back with an edit or a decision, so the server knows which version the person read. */
  updatedAt: string;
}

/** A purchase from a supplier with no payment or debt recorded. Its value is in the base currency. */
export interface UnpaidReceipt {
  id: string;
  docNo: string;
  date: string;
  counterpartyId: string;
  supplier: string;
  invoiceNo: string | null;
  value: number;
  goods: string;
  lines: { itemName: string; itemCategory: string; unit: string; qty: number; value: number }[];
  /** A paid purchase request is still waiting for these goods, so they may be paid for already. */
  paidRequest: boolean;
}

export interface Totals {
  income: number;
  expense: number;
  net: number;
}

export interface AccountOption {
  id: string;
  name: string;
  type: string;
  currency: string;
}

export interface AccountBalance extends AccountOption {
  bankName: string | null;
  accountNumber: string | null;
  openingBalance: number;
  openingDate: string | null;
  balance: number;
  balanceBase: number;
}

export interface CategoryOption {
  id: string;
  kind: 'expense' | 'income';
  group: string;
  key: string;
  name: I18nName;
}

export interface CostCenterOption {
  id: string;
  name: string;
  type: string;
  refId: string | null;
}

export interface OpenDocument {
  id: string;
  date: string;
  dueDate: string | null;
  description: string | null;
  amount: number;
  outstanding: number;
  daysOverdue: number;
}

export interface Aging {
  notDue: number;
  d1_30: number;
  d31_60: number;
  d61_90: number;
  d90Plus: number;
}

export interface CounterpartyDebt {
  isPayroll: boolean;
  counterpartyId: string;
  counterpartyName: string;
  direction: 'payable' | 'receivable';
  total: number;
  paid: number;
  outstanding: number;
  pendingSettlement: number;
  overdue: number;
  nextDueDate: string | null;
  aging: Aging;
  documents: OpenDocument[];
}

export interface DebtSummary {
  receivable: number;
  payable: number;
  overdue: number;
  overduePayable: number;
  overdueReceivable: number;
  loansOutstanding: number;
}

export interface BudgetCell {
  planned: number;
  actual: number;
}

export interface BudgetRow {
  categoryId: string;
  key: string;
  kind: 'expense' | 'income';
  group: string;
  name: I18nName;
  cells: Record<string, BudgetCell>;
  planned: number;
  actual: number;
  deviation: number;
  percent: number | null;
}

export interface BudgetTotal {
  planned: number;
  actual: number;
  deviation: number;
  percent: number | null;
  byMonth: Record<string, BudgetCell>;
}

export interface BudgetGrid {
  months: string[];
  rows: BudgetRow[];
  totals: { expense: BudgetTotal; income: BudgetTotal };
}

export interface CostCenterCost {
  costCenterId: string;
  type: string;
  refId: string | null;
  name: string | null;
  direct: number;
  materials: number;
  machinery: number;
  overhead: number;
  total: number;
  income: number;
  profit: number;
  profitabilityPercent: number | null;
}

export interface HerdCost {
  herdId?: string;
  name?: string;
  head: number;
  purchaseCost: number;
  accumulated: number;
  costPerHead: number | null;
  breakdown: { feed: number; vet: number; labor: number; overhead: number; other: number };
  weightGainKg: number;
  costPerKg: number | null;
}

export interface FieldCost {
  cropPlanId: string;
  fieldId: string;
  number: string;
  areaHa: number;
  crop: I18nName;
  planned: number | null;
  actual: number;
  deviation: number | null;
  harvestT: number;
  yieldTHa: number | null;
  costPerTon: number | null;
  income: number;
  internalRevenue: number;
  profit: number;
  profitabilityPercent: number | null;
}

export interface CategoryAmount {
  categoryId: string;
  key: string;
  group: string;
  kind: 'expense' | 'income';
  name: I18nName;
  amount: number;
}

export interface CategoryReport {
  rows: CategoryAmount[];
  income: number;
  expense: number;
  net: number;
}

export interface ForecastParts {
  budgetIncome: number;
  recurringIncome: number;
  receivables: number;
  plannedSales: number;
  plannedHarvest: number;
  plannedLambs: number;
  budgetExpense: number;
  recurringExpense: number;
  payables: number;
  loans: number;
}

export interface ForecastMonth {
  month: string;
  inflow: number;
  outflow: number;
  net: number;
  closing: number;
  negative: boolean;
  parts: ForecastParts;
}

export interface Forecast {
  method: 'statistical';
  asOf: string;
  opening: number;
  historyMonths: number;
  lowConfidence: boolean;
  assumptions: { lambsPerEwe: number; survival: number; monthsToSale: number };
  firstNegativeMonth: string | null;
  /** The last budgeted month. After it, only loans and debts are known. */
  plannedThrough: string | null;
  rows: ForecastMonth[];
}

export interface ActualMonth {
  month: string;
  inflow: number;
  outflow: number;
  net: number;
}

export interface Loan {
  id: string;
  name: string;
  counterpartyId: string | null;
  counterpartyName: string | null;
  principal: number;
  annualRate: number;
  termMonths: number;
  startDate: string;
  method: 'annuity' | 'equal_principal';
  preferential: boolean;
  terms: string | null;
  status: 'active' | 'closed';
  outstanding: number;
  paidPrincipal: number;
  paidInterest: number;
  nextDueDate: string | null;
  nextPayment: number | null;
  overdue: boolean;
}

export interface Instalment {
  id: string;
  period: number;
  dueDate: string;
  principal: number;
  interest: number;
  payment: number;
  balance: number;
  paidDate: string | null;
}

export interface LoanDetail extends Loan {
  instalments: Instalment[];
}

export interface UpcomingInstalment {
  id: string;
  loanId: string;
  loanName: string;
  period: number;
  dueDate: string;
  payment: number;
}

export interface FxRate {
  date: string;
  currency: string;
  rate: number;
}
