import { interpolate, localizeValue, lookup } from '../../notifications/i18n';
import type { ProposalView } from './types';

const number = (value: number, digits = 2) =>
  new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(value).replace(/\u00a0/g, ' ');

export const money = (amount: number, currency: string, language?: string) =>
  `${number(amount)} ${lookup(language, 'enums', `currency.${currency}`) ?? currency}`;

const dayText = (date: string) => date.split('-').reverse().join('.');

/** A name or a note is one value, and a line break in it must not pass for a line of the card. */
const oneLine = (text: string) => text.replace(/[\s\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();

/** A proposal as plain text for Telegram. Escaping for HTML is the caller's job. */
export function renderProposalText(view: ProposalView, language: string, farmName?: string): string {
  const label = (key: string) => lookup(language, 'ai', `recordText.${key}`) ?? key;
  const f = view.fields;
  const cash = (amount: number, currency: string) => money(amount, currency, language);
  const kind = view.kind === 'debt_payment' && f.direction ? `direction.${f.direction}` : `kind.${view.kind}`;
  const lines = [oneLine(`${label(kind)}: ${f.amount === null ? '—' : cash(f.amount, f.currency)}`)];
  const add = (key: string, value: string | null | undefined) => {
    const text = value && oneLine(value);
    if (text) lines.push(`${label(key)}: ${text}`);
  };
  const target = f.target && {
    ...f.target,
    name: f.target.type === 'general' ? (lookup(language, 'enums', 'costCenterType.general') ?? f.target.name) : f.target.name,
  };
  const unit = f.item && (lookup(language, 'enums', `unit.${f.item.unit}`) ?? f.item.unit);
  add('farm', farmName);
  if (f.amountBase !== null && f.fxRate !== null && f.currency !== 'UZS') {
    add('rate', `${cash(f.fxRate, 'UZS')} → ${cash(f.amountBase, 'UZS')}`);
  }
  add('category', f.category && String(localizeValue(f.category.translations ?? f.category.name, language)));
  add('item', f.item && `${f.item.name}, ${number(f.qty ?? 0, 3)} ${unit}`);
  add('warehouse', f.warehouse?.name);
  add('target', target && (target.defaulted ? `${target.name} (${label(target.type === 'general' ? 'defaulted' : 'onlyOne')})` : target.name));
  add('account', f.account?.name ?? (f.paymentMethod === 'debt' ? label('onDebt') : null));
  add('toAccount', f.toAccount?.name);
  add('counterparty', f.counterparty?.name);
  add('date', dayText(f.date));
  add('description', f.description);
  for (const { phrase, name } of view.learning) add('learning', `${phrase} = ${name}`);
  for (const warning of view.warnings) {
    const text = lookup(language, 'ai', `recordText.warnings.${warning.code}`) ?? lookup(language, 'alerts', 'bot.checkThis');
    if (text) lines.push(`⚠️ ${interpolate(text, warning.params, language)}`);
  }
  if (view.willNeedApproval) lines.push(`⏳ ${label('needsApproval')}`);
  return lines.join('\n');
}
