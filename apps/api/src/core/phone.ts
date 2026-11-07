/** Accepts 901234567, 998901234567, +998 90 123-45-67. */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  return digits.length === 9 ? `+998${digits}` : `+${digits}`;
}

/** The subscriber number, the part that survives the many ways people type a prefix by hand. */
export const subscriberNumber = (raw: string): string => raw.replace(/\D/g, '').slice(-9);
