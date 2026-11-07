/**
 * What this farm's records are called, for the model to use when it prepares a draft. Knowing the
 * names up front is what lets it file "tushlik" without asking. Names only: no money.
 */
import {
  accountCandidates, categoryCandidates, costCenterCandidates, counterpartyCandidates, itemCandidates,
  warehouseCandidates,
} from './resolve';

const MAX_PER_LIST = 40;

/**
 * Stored text as one line of plain data, escaped as fenceToolData escapes it, so whatever anyone
 * typed as a name cannot close a tag around it, start a line or a list entry of its own, or hide
 * behind invisible direction marks.
 */
export const plainName = (text: string) =>
  text
    .replace(/[\s\p{Cc}]+/gu, ' ')
    .replace(/\p{C}/gu, '')
    .trim()
    .replace(/;/g, ',')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');

const entries = (names: string[]) => names.map(plainName).join('; ');

/** A list that was cut says so, or the model would take a name left out for one that does not exist. */
function list(names: string[]): string {
  const more = names.length - MAX_PER_LIST;
  if (more > 0) return `${entries(names.slice(0, MAX_PER_LIST))}; and ${more} more, ask find_records`;
  return entries(names) || '(none)';
}

export async function recordCatalog(): Promise<string> {
  const expense = await categoryCandidates('expense');
  const income = await categoryCandidates('income');
  const items = await itemCandidates();
  return [
    '<farm_records>',
    `Expense categories (key = name): ${entries(expense.map((c) => `${c.key} = ${c.name}`))}`,
    `Income categories (key = name): ${entries(income.map((c) => `${c.key} = ${c.name}`))}`,
    `Accounts: ${list((await accountCandidates()).map((a) => `${a.name} (${a.extra?.type})`))}`,
    `Fields: ${list((await costCenterCandidates(['field'])).map((c) => c.name))}`,
    `Herds: ${list((await costCenterCandidates(['herd'])).map((c) => c.name))}`,
    `Machines: ${list((await costCenterCandidates(['asset'])).map((c) => c.name))}`,
    `Stock items (unit): ${list(items.map((i) => `${i.name} (${i.extra?.unit})`))}`,
    `Warehouses: ${list((await warehouseCandidates()).map((w) => w.name))}`,
    `Counterparties: ${list((await counterpartyCandidates()).map((c) => c.name))}`,
    '</farm_records>',
  ].join('\n');
}
