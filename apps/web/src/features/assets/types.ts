export interface Asset {
  id: string;
  name: string;
  type: string;
  inventoryNo: string | null;
  purchaseDate: string | null;
  purchasePrice: number | null;
  status: string;
  usefulLifeMonths: number | null;
  salvageValue: number | null;
  depreciationMethod: string;
  totalUnits: number | null;
  motoHours: number;
  fuelNormLPerHour: number | null;
  fuelNormLPerHa: number | null;
  costCenterId: string | null;
  rented: boolean;
  rentalCounterpartyId: string | null;
  rentalContractId: string | null;
  rentalPrice: number | null;
  rentalUnit: 'ha' | 'hour' | 'day' | null;
  notes: string | null;
}

export interface AssetCard extends Asset {
  accumulatedDepreciation: number | null;
  bookValue: number | null;
  usage: { shifts: number; hours: number; hectares: number; fuelL: number };
  lastMaintenance: Maintenance | null;
  maintenanceDue: { nextDueDate: string | null; nextDueMotoHours: number | null; overdue: boolean } | null;
}

export interface UsageLog {
  id: string;
  assetId: string;
  date: string;
  operatorEmployeeId: string | null;
  operatorName: string | null;
  fieldId: string | null;
  fieldNumber: string | null;
  operationId: string | null;
  workType: string | null;
  motoHours: number | null;
  volumeHa: number | null;
  fuelL: number | null;
  fuelItemId: string | null;
  fuelCost: number | null;
  fuelNormL: number | null;
  fuelDeviationPercent: number | null;
  billedTransactionId: string | null;
  notes: string | null;
}

export interface Maintenance {
  id: string;
  date: string;
  type: string;
  description: string | null;
  cost: number | null;
  nextDueDate: string | null;
  nextDueMotoHours: number | null;
  downtimeHours: number | null;
  transactionId: string | null;
}

export interface MaintenanceDue {
  assetId: string;
  name: string;
  motoHours: number;
  nextDueDate: string | null;
  nextDueMotoHours: number | null;
  overdue: boolean;
}

export interface AssetCosts {
  fuel: number;
  labor: number;
  repairs: number;
  depreciation: number;
  total: number;
  hours: number;
  hectares: number;
  fuelL: number;
  costPerHour: number | null;
  costPerHectare: number | null;
  fuelPerHectare: number | null;
}

export interface DepreciationEntry {
  id: string;
  month: string;
  amount: number;
  transactionId: string | null;
}
