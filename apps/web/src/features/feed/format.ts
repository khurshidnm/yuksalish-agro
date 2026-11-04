import { formatQty } from '@/lib/format';

/** Large amounts read better in tonnes: 72 000 kg → "72 t". */
export function formatKg(kg: number | null | undefined): string {
  if (kg === null || kg === undefined) return formatQty(null);
  return Math.abs(kg) >= 1000 ? formatQty(kg / 1000, 't', 2) : formatQty(kg, 'kg', 1);
}
