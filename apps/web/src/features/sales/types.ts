import type { PURCHASE_REQUEST_STATUSES, SALE_STATUSES } from '@yap/shared';

export type SaleStatus = (typeof SALE_STATUSES)[number];
export type PurchaseStatus = (typeof PURCHASE_REQUEST_STATUSES)[number];
export type LocalizedName = { uz: string; ru: string; en: string };

/** Money fields are null when the viewer has no finance.view. */
export interface SaleRow {
  id: string;
  number: string;
  date: string;
  status: SaleStatus;
  counterpartyId: string;
  counterpartyName: string;
  totalAmount: number | null;
  currency: string;
  deliveryDate: string | null;
  paymentMethod: string;
  lineCount: number;
  createdBy: string | null;
}

export interface SaleLine {
  id: string;
  itemId: string | null;
  itemName: string | null;
  warehouseId: string | null;
  warehouseName: string | null;
  animalId: string | null;
  animalTag: string | null;
  animalCategory: string | null;
  description: string | null;
  qty: number;
  unit: string;
  price: number | null;
  amount: number | null;
  costAmount: number | null;
  categoryId: string | null;
  categoryName: LocalizedName | null;
  costCenterId: string | null;
  costCenterName: string | null;
  withdrawalUntil: string | null;
}

export interface SaleDetail extends Omit<SaleRow, 'lineCount'> {
  counterpartyTin: string | null;
  accountId: string | null;
  dueDate: string | null;
  notes: string | null;
  rejectedReason: string | null;
  cancelReason: string | null;
  confirmedBy: string | null;
  lines: SaleLine[];
  documents: { id: string; type: string; title: string; number: string | null; fileId: string | null }[];
  postings: { id: string; type: string; amountBase: number | null; status: string; date: string }[];
}

export interface CurrentPrice {
  itemId: string;
  itemName: string;
  unit: string;
  kind: 'sale' | 'market';
  date: string;
  price: number | null;
  source: string | null;
  previousPrice: number | null;
  changePercent: number | null;
}

export interface PriceRow {
  id: string;
  itemId: string;
  itemName: string;
  unit: string;
  date: string;
  price: number | null;
  kind: 'sale' | 'market';
  source: string | null;
}

export interface Margin {
  amount: number | null;
  cost: number | null;
  avgPrice: number | null;
  margin: number | null;
  marginPercent: number | null;
}

export interface SalesAnalysis {
  totals: Margin;
  byProduct: (Margin & { key: string; itemName: string | null; animalCategory: string | null; unit: string; qty: number })[];
  byBuyer: (Margin & { counterpartyId: string; name: string; documents: number })[];
  byMonth: (Margin & { month: string })[];
}

export interface ContractRow {
  id: string;
  counterpartyId: string;
  counterpartyName: string;
  number: string;
  title: string | null;
  startDate: string | null;
  endDate: string | null;
  amount: number | null;
  currency: string;
  terms: string | null;
  fileId: string | null;
  fileUrl: string | null;
  status: 'draft' | 'active' | 'closed' | 'terminated';
  daysLeft: number | null;
  expired: boolean;
  expiringSoon: boolean;
}

export interface Settlement {
  counterparty: { id: string; name: string; tin: string | null; type: string; phone: string | null };
  totals: {
    sold: number | null;
    bought: number | null;
    received: number | null;
    paid: number | null;
    balance: number | null;
    receivable: number | null;
    payable: number | null;
  };
  transactions: {
    id: string;
    date: string;
    type: string;
    status: string;
    paymentMethod: string;
    amountBase: number | null;
    categoryName: LocalizedName | null;
    description: string | null;
    dueDate: string | null;
  }[];
  sales: { id: string; number: string; date: string; status: SaleStatus; totalAmount: number | null; currency: string }[];
  purchases: { id: string; itemName: string; qty: number; unit: string; status: PurchaseStatus; paidAmount: number | null }[];
  contracts: { id: string; number: string; title: string | null; endDate: string | null; amount: number | null; status: string }[];
}

export const GRANT_KINDS = ['subsidy', 'compensation', 'grant', 'preferential_loan'] as const;
export const GRANT_STATUSES = ['draft', 'submitted', 'in_review', 'approved', 'rejected', 'received'] as const;
export const CONTRACT_STATUSES = ['draft', 'active', 'closed', 'terminated'] as const;
export const REPORT_AUTHORITIES = ['veterinary', 'statistics', 'tax', 'other'] as const;
export const REPORT_PERIODS = ['once', 'monthly', 'quarterly', 'yearly'] as const;
export const SALE_PAYMENT_METHODS = ['cash', 'bank', 'card', 'debt'] as const;

export interface GrantRow {
  id: string;
  title: string;
  program: string | null;
  kind: (typeof GRANT_KINDS)[number];
  amount: number | null;
  status: (typeof GRANT_STATUSES)[number];
  submittedOn: string | null;
  decisionOn: string | null;
  notes: string | null;
}

export interface StateReportRow {
  id: string;
  title: string;
  authority: (typeof REPORT_AUTHORITIES)[number];
  period: (typeof REPORT_PERIODS)[number];
  dueDate: string;
  status: 'planned' | 'submitted';
  submittedOn: string | null;
  fileUrl: string | null;
  notes: string | null;
  overdue: boolean;
}

export interface PurchaseRow {
  id: string;
  itemId: string;
  itemName: string;
  itemCategory: string;
  unit: string;
  qty: number;
  expectedPrice: number | null;
  counterpartyId: string | null;
  counterpartyName: string | null;
  status: PurchaseStatus;
  neededBy: string | null;
  rejectedReason: string | null;
  paidAmount: number | null;
  unitCost: number | null;
  warehouseId: string | null;
  warehouseName: string | null;
  receivedQty: number | null;
  receivedOn: string | null;
  quality: string | null;
  diffQty: number | null;
  diffAmount: number | null;
  notes: string | null;
  createdBy: string | null;
  transactionId: string | null;
}

export interface SupplierPrices {
  item: { id: string; name: string; unit: string };
  suppliers: {
    counterpartyId: string;
    name: string;
    purchases: number;
    totalQty: number;
    lastDate: string;
    lastPrice: number | null;
    avgPrice: number | null;
    minPrice: number | null;
    maxPrice: number | null;
  }[];
  history: { batchId: string; date: string; counterpartyId: string; name: string; qty: number; unitCost: number | null }[];
}
