import { z } from 'zod';

/**
 * Zod field helpers for forms. Optional values come out as `null`, not '' or undefined, so a
 * cleared field really clears the column on PATCH. Validation messages are set globally in lib/i18n.
 */
export const zText = (max = 200) => z.string().trim().min(1).max(max);

export const zOptionalText = (max = 2000) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => v || null);

export const zNumber = () => z.number();
export const zPositive = () => z.number().positive();
export const zNonNegative = () => z.number().nonnegative();
export const zOptionalNumber = () =>
  z
    .number()
    .nullish()
    .transform((v) => v ?? null);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const zDate = () => z.string().regex(ISO_DATE);
export const zOptionalDate = () =>
  z
    .string()
    .regex(ISO_DATE)
    .or(z.literal(''))
    .nullish()
    .transform((v) => v || null);

/** Required reference to another record, from a Select or Combobox. */
export const zRef = () => z.string().min(1);
export const zOptionalRef = () =>
  z
    .string()
    .nullish()
    .transform((v) => v || null);

export const zEnum = <T extends readonly [string, ...string[]]>(values: T) => z.enum(values);
export const zOptionalEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .enum(values)
    .or(z.literal(''))
    .nullish()
    .transform((v) => (v ? (v as T[number]) : null));
