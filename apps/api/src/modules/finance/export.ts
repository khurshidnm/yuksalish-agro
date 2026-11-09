/**
 * Journal export (spec 10.3.12). The official books live in Keeping. Its import format has not been
 * confirmed for this project yet, so this is a generic double-entry CSV: one row per transaction,
 * a debit and a credit account from the Uzbek chart of accounts (BHMS 21).
 *
 *   date, document, debit, credit, amount, currency, fx_rate, amount_base,
 *   counterparty, tin, cost_center, category, description
 *
 * Money accounts follow the account the money really moved through, whatever method it was entered with.
 *
 *   paid expense       Dt expense account           Ct 5010 cash / 5110 bank / 5210 card
 *   expense on credit  Dt expense account           Ct 6010 payable
 *   bought for stock   Dt 1000 materials            Ct as above
 *   bought animals     Dt 1200 livestock            Ct as above
 *   capital spending   Dt 0800 capital investment   Ct as above
 *   depreciation       Dt expense account           Ct 0200 accumulated depreciation
 *   income, paid       Dt 5010 / 5110 / 5210        Ct 9010 revenue (9390 other income)
 *   income on credit   Dt 4010 receivable           Ct 9010 / 9390
 *   debt payment       Dt 6010 payable              Ct 5010 / 5110 / 5210
 *   debt receipt       Dt 5010 / 5110 / 5210        Ct 4010 receivable
 *   transfer           Dt destination account       Ct source account
 *   loan received      Dt 5110                      Ct 7810 long-term loan
 *   loan principal     Dt 7810                      Ct 5110
 *
 * The account mapping is a sensible default. Confirm it with the accountant and Keeping before
 * relying on it for official books.
 */
import ExcelJS from 'exceljs';

export interface ExportRow {
  id: string;
  date: string;
  type: string;
  amount: number;
  currency: string;
  fxRate: number;
  amountBase: number;
  paymentMethod: string;
  costTreatment: string;
  description: string | null;
  sourceType: string | null;
  categoryGroup: string | null;
  categoryName: { uz: string } | null;
  accountName: string | null;
  accountType: string | null;
  toAccountName: string | null;
  toAccountType: string | null;
  counterpartyName: string | null;
  counterpartyTin: string | null;
  costCenterName: string | null;
}

const MONEY_ACCOUNT: Record<string, string> = { cash: '5010', bank: '5110', card: '5210' };
const PAYABLE = '6010';
const RECEIVABLE = '4010';
const LOAN = '7810';
/** The owner's own money put in and taken out. To be confirmed by the farm's accountant. */
const OWNER_CAPITAL = '8300';

const EXPENSE_ACCOUNT: Record<string, string> = {
  livestock: '2010',
  crops: '2010',
  labor: '2010',
  machinery: '2010',
  infrastructure: '2510',
  admin: '9420',
  financial: '9610',
  investment: '0800',
};

function expenseDebit(row: ExportRow): string {
  if (row.costTreatment === 'inventory') return '1000';
  if (row.costTreatment === 'animal') return '1200';
  if (row.costTreatment === 'capex') return '0800';
  return EXPENSE_ACCOUNT[row.categoryGroup ?? ''] ?? '9430';
}

function moneyAccount(accountType: string | null): string {
  return MONEY_ACCOUNT[accountType ?? ''] ?? '5110';
}

export function doubleEntry(row: ExportRow): { debit: string; credit: string } {
  const money = moneyAccount(row.accountType);
  switch (row.type) {
    case 'expense':
      return {
        debit: expenseDebit(row),
        credit: row.paymentMethod === 'debt' ? PAYABLE : row.paymentMethod === 'non_cash' ? '0200' : money,
      };
    case 'income':
      return {
        debit: row.paymentMethod === 'debt' ? RECEIVABLE : money,
        credit: row.categoryGroup === 'subsidy' || row.categoryGroup === 'other_income' ? '9390' : '9010',
      };
    case 'debt_payment':
      return { debit: row.sourceType === 'loan_instalment' ? LOAN : PAYABLE, credit: money };
    case 'debt_receipt':
      return { debit: money, credit: row.sourceType === 'loan' ? LOAN : RECEIVABLE };
    case 'contribution':
      return { debit: money, credit: OWNER_CAPITAL };
    case 'withdrawal':
      return { debit: OWNER_CAPITAL, credit: money };
    default:
      return { debit: moneyAccount(row.toAccountType), credit: money };
  }
}

const HEADER = [
  'date',
  'document',
  'debit',
  'credit',
  'amount',
  'currency',
  'fx_rate',
  'amount_base',
  'counterparty',
  'tin',
  'cost_center',
  'category',
  'description',
];

function values(row: ExportRow): (string | number)[] {
  const { debit, credit } = doubleEntry(row);
  return [
    row.date,
    row.id,
    debit,
    credit,
    row.amount,
    row.currency,
    row.fxRate,
    row.amountBase,
    row.counterpartyName ?? '',
    row.counterpartyTin ?? '',
    row.costCenterName ?? '',
    row.categoryName?.uz ?? '',
    row.description ?? '',
  ];
}

/** Quote per RFC 4180, and neutralise spreadsheet formula injection in free text. */
export function csvCell(value: string | number): string {
  if (typeof value === 'number') return String(value);
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** With a BOM, so Excel reads Uzbek and Russian text correctly. */
export function toCsv(rows: ExportRow[]): string {
  const lines = [HEADER, ...rows.map(values)].map((line) => line.map(csvCell).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

export async function toXlsx(rows: ExportRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Operatsiyalar');
  sheet.addRow(HEADER);
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  for (const row of rows) sheet.addRow(values(row));
  HEADER.forEach((_, index) => {
    sheet.getColumn(index + 1).width = HEADER[index] === 'description' ? 48 : 16;
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

interface BudgetExportRow {
  kind: string;
  name: { uz: string };
  cells: Record<string, { planned: number; actual: number }>;
  planned: number;
  actual: number;
  deviation: number;
  percent: number | null;
}

/** Plan and fact side by side for each month, then totals per category and per kind. */
export async function budgetToXlsx(grid: { months: string[]; rows: BudgetExportRow[] }): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Byudjet');
  sheet.addRow([
    'Modda',
    ...grid.months.flatMap((month) => [`${month} reja`, `${month} fakt`]),
    'Jami reja',
    'Jami fakt',
    'Farq',
    'Ijro, %',
  ]);
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }];

  const addSection = (kind: string, title: string) => {
    const rows = grid.rows.filter((row) => row.kind === kind);
    for (const row of rows) {
      sheet.addRow([
        row.name.uz,
        ...grid.months.flatMap((month) => [row.cells[month].planned, row.cells[month].actual]),
        row.planned,
        row.actual,
        row.deviation,
        row.percent === null ? '' : Math.round(row.percent * 10) / 10,
      ]);
    }
    const sum = (pick: (row: BudgetExportRow) => number) => rows.reduce((total, row) => total + pick(row), 0);
    const planned = sum((row) => row.planned);
    const actual = sum((row) => row.actual);
    const total = sheet.addRow([
      title,
      ...grid.months.flatMap((month) => [sum((row) => row.cells[month].planned), sum((row) => row.cells[month].actual)]),
      planned,
      actual,
      actual - planned,
      planned ? Math.round((actual / planned) * 1000) / 10 : '',
    ]);
    total.font = { bold: true };
  };
  addSection('expense', 'Jami xarajat');
  addSection('income', 'Jami daromad');

  sheet.getColumn(1).width = 30;
  for (let index = 2; index <= grid.months.length * 2 + 5; index++) {
    sheet.getColumn(index).width = 15;
    sheet.getColumn(index).numFmt = '#,##0';
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
