import { interpolate, lookup } from '../../notifications/i18n';
import type { FarmAnimal, FarmProposalView } from './farm-types';
import { dayText, number, oneLine } from './render';

const unitText = (unit: string, language: string) => lookup(language, 'enums', `unit.${unit}`) ?? unit;

/** The animal named plainly: tag, what it is, how old on the record's day. */
function animalText(animal: FarmAnimal, language: string): string {
  const label = (key: string) => lookup(language, 'ai', `farmRecords.${key}`) ?? key;
  const what =
    (animal.category &&
      (lookup(language, 'enums', `animalCategoryBySpecies.${animal.species}.${animal.category}`) ??
        lookup(language, 'enums', `animalCategory.${animal.category}`))) ||
    (animal.sex && lookup(language, 'enums', `sex.${animal.sex}`));
  const age = animal.ageMonths === null ? label('ageUnknown') : interpolate(label('ageMonths'), { months: animal.ageMonths }, language);
  return [animal.tag, what, age].filter(Boolean).join(', ');
}

/**
 * A farm card as plain text for Telegram, with the labels the web card uses. It holds no money, so
 * it reads the same for everyone. Escaping for HTML is the caller's job.
 */
export function renderFarmProposalText(view: FarmProposalView, language: string, farmName?: string): string {
  const label = (key: string) => lookup(language, 'ai', `farmRecords.${key}`) ?? key;
  const f = view.fields;
  const lines = [label(`kind.${view.kind}`)];
  const add = (key: string, value: string | null | undefined) => {
    const text = value && oneLine(value);
    if (text) lines.push(`${label(`fields.${key}`)}: ${text}`);
  };
  add('animal', f.animal && animalText(f.animal, language));
  const herd = f.herd ? (f.herd.defaulted ? `${f.herd.name} (${label('herdDefaulted')})` : f.herd.name) : f.animal ? (f.animal.herd?.name ?? label('noHerd')) : null;
  add('herd', herd);
  if (farmName) lines.push(`${lookup(language, 'ai', 'recordText.farm') ?? 'Farm'}: ${oneLine(farmName)}`);
  add('weight', f.weightKg === null ? null : `${number(f.weightKg, 2)} ${unitText('kg', language)}`);
  add('care', f.healthType && lookup(language, 'enums', `healthRecordType.${f.healthType}`));
  add('drug', f.drug?.name);
  add('dose', f.dose === null ? null : `${number(f.dose, 3)} ${f.doseUnit ? unitText(f.doseUnit, language) : ''}`);
  add('headCount', f.headCount === null ? null : number(f.headCount, 0));
  for (const line of f.stockOut) {
    add('stockOut', `${line.name}, ${number(line.qty, 3)} ${unitText(line.unit, language)} (${line.warehouse?.name ?? label('warehouseByRule')})`);
  }
  add('date', dayText(f.date));
  add('cause', f.cause);
  for (const warning of view.warnings) {
    const text = lookup(language, 'ai', `recordText.warnings.${warning.code}`) ?? lookup(language, 'alerts', 'bot.checkThis');
    if (text) lines.push(`⚠️ ${interpolate(text, warning.params, language)}`);
  }
  if (view.kind === 'death' && view.status === 'pending') lines.push(label('deathNote'));
  if (view.kind === 'herd_log' && view.status === 'pending') lines.push(label('herdLogNote'));
  return lines.join('\n');
}
