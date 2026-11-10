export interface StockRow {
  itemId: string;
  name: string;
  category: string;
  unit: string;
  minQty: number | null;
  warehouseId: string | null;
  warehouseName: string | null;
  qty: number;
  value: number | null;
  avgCost: number | null;
  nearestExpiry: string | null;
  belowMinimum: boolean;
}

export interface LowRow {
  itemId: string;
  name: string;
  unit: string;
  stockQty: number;
  minQty: number | null;
  days: number | null;
  minDays: number | null;
  reason: 'qty' | 'days';
}

export interface ExpiringRow {
  batchId: string;
  itemId: string;
  itemName: string;
  category: string;
  unit: string;
  warehouseName: string;
  batchNo: string | null;
  qtyRemaining: number;
  expiryDate: string;
  unitCost: number | null;
  expired: boolean;
}

export interface BatchRow {
  id: string;
  batchNo: string | null;
  invoiceNo: string | null;
  warehouseId: string;
  warehouseName: string;
  receivedDate: string;
  qtyReceived: number;
  qtyRemaining: number;
  unitCost: number | null;
  expiryDate: string | null;
  source: string;
  counterpartyName: string | null;
}

export interface ItemRow {
  id: string;
  name: string;
  category: string;
  unit: string;
  sku: string | null;
  barcode: string | null;
  dryMatterPct: number | null;
  /** Feed nutrients per kg of dry matter. Null: not known. */
  meMjPerKgDm?: number | null;
  crudeProteinPctDm?: number | null;
  calciumGPerKgDm?: number | null;
  phosphorusGPerKgDm?: number | null;
  isRoughage?: boolean | null;
  minQty: number | null;
  minDays: number | null;
  defaultWarehouseId: string | null;
  defaultWarehouseName: string | null;
  withdrawalDays: number | null;
  /** Fertiliser content, percent of the product as sold. Null: not said. */
  nPct?: number | null;
  p2o5Pct?: number | null;
  k2oPct?: number | null;
  transferPrice: number | null;
  kgPerUnit: number | null;
  cropId: string | null;
  notes: string | null;
  qtyOnHand: number;
}

export interface ItemOption {
  id: string;
  name: string;
  category: string;
  unit: string;
  defaultWarehouseId: string | null;
  qtyOnHand: number;
}

export interface WarehouseRow {
  id: string;
  name: string;
  type: string;
  facilityId: string | null;
  notes: string | null;
  positions: number;
  value: number | null;
}

export interface WarehouseOption {
  id: string;
  name: string;
  type: string;
}

export interface MovementRow {
  id: string;
  type: string;
  date: string;
  itemId: string;
  itemName: string;
  unit: string;
  warehouseId: string;
  warehouseName: string;
  qty: number;
  unitCost: number | null;
  totalCost: number | null;
  costCenterId: string | null;
  costCenterName: string | null;
  costCenterType?: string | null;
  reason: string | null;
  docNo: string | null;
  refType: string | null;
  notes: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface CountRow {
  id: string;
  date: string;
  docNo: string | null;
  status: 'draft' | 'approved';
  notes: string | null;
  warehouseId: string;
  warehouseName: string;
  approvedAt: string | null;
  lines: number;
}

export interface CountLine {
  id: string;
  itemId: string;
  itemName: string;
  unit: string;
  systemQty: number;
  actualQty: number;
  diffQty: number;
  diffCost: number | null;
}

export interface CountDetail {
  id: string;
  date: string;
  docNo: string | null;
  status: 'draft' | 'approved';
  notes: string | null;
  warehouseId: string;
  warehouseName: string | null;
  approvedByName: string | null;
  lines: CountLine[];
}

/** Result of POST /inventory/receipts, /issues and /transfers. */
export interface DocumentResult {
  docNo: string;
  transactions?: { id: string; status: string }[];
}
