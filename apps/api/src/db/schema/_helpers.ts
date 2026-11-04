import { date, numeric, timestamp, uuid } from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';

export const newId = () => uuidv7();
export const pk = () => uuid().primaryKey().$defaultFn(newId);
/** Money: amounts reach billions of so'm, 2 decimals. */
export const money = () => numeric({ precision: 18, scale: 2, mode: 'number' });
/** Quantities: kg, t, litres, doses. */
export const qty = () => numeric({ precision: 16, scale: 3, mode: 'number' });
export const dec = (precision: number, scale: number) => numeric({ precision, scale, mode: 'number' });
/** Business date as YYYY-MM-DD string. */
export const day = () => date({ mode: 'string' });
export const ts = () => timestamp({ withTimezone: true, mode: 'date' });

export type I18nName = { uz: string; ru: string; en: string };
