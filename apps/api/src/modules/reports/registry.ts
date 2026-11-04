import { assetReports } from './defs/assets';
import { cropReports } from './defs/crops';
import { financeReports } from './defs/finance';
import { hrReports } from './defs/hr';
import { feedReports, inventoryReports } from './defs/inventory';
import { livestockReports } from './defs/livestock';
import { salesReports } from './defs/sales';
import type { ReportDefinition } from './types';

export const REPORTS: ReportDefinition[] = [
  ...financeReports,
  ...livestockReports,
  ...feedReports,
  ...inventoryReports,
  ...cropReports,
  ...hrReports,
  ...assetReports,
  ...salesReports,
];

export const REPORTS_BY_KEY = new Map(REPORTS.map((report) => [report.key, report]));
