/**
 * Reads a number typed into a form field, the way people write it: 1500000, 1 500 000, 1.500.000,
 * 1,500,000, 1.500.000,50. The chat reads digits by the same rules (money-text.ts), and the test
 * pins the two together, so a form and the assistant cannot disagree on one figure.
 *
 * Only one shape is open: a lone separator before exactly three digits. In money, where a third
 * decimal means nothing, and in a whole count, 25.000 is twenty-five thousand. In a quantity it can
 * be either, so the decimal stands and `otherReading` lets the field say so where the person can see
 * it. Text that fits no rule is refused, never read as the nearest thing.
 */
export interface TypedNumber {
  /** Null when there is nothing to read yet, or the text cannot be read. */
  value: number | null;
  /** The text is not a number: nothing may be saved from it. */
  unreadable: boolean;
  /** The same digits with the separator grouping thousands. Null when there is no doubt. */
  otherReading: number | null;
}

export interface TypedNumberRules {
  /** A third decimal means nothing here, so 25.000 groups thousands. */
  money?: boolean;
  /** Decimals the field keeps. At 0 it counts whole things, and 1.500 groups thousands there too. */
  decimals?: number;
  negative?: boolean;
}

const NOTHING: TypedNumber = { value: null, unreadable: false, otherReading: null };
const UNREADABLE: TypedNumber = { value: null, unreadable: true, otherReading: null };

const PLAIN = /^(\d*)[.,]?(\d*)$/;
const FIRST_GROUP = /^[1-9]\d{0,2}$/;
/** 1.500.000 or 1,500,000: one kind of separator, and three digits after each. */
const GROUPS = /^[1-9]\d{0,2}([.,])\d{3}(?:\1\d{3})*$/;
/** 1.500.000,50: the last separator is another kind, so it is the decimal point. */
const GROUPS_AND_FRACTION = /^([1-9]\d{0,2}([.,])\d{3}(?:\2\d{3})*)([.,])(\d*)$/;

const digitsOf = (text: string) => text.replace(/[.,]/g, '');

export function readTypedNumber(text: string, rules: TypedNumberRules = {}): TypedNumber {
  const { money = false, decimals = 3, negative = false } = rules;
  const compact = text.replace(/\s/g, '');
  const signed = compact.startsWith('-');
  if (signed && !negative) return UNREADABLE;
  const body = signed ? compact.slice(1) : compact;
  if (body === '' || body === '.' || body === ',') return NOTHING;
  const number = (whole: string, fraction = '') => Number(`${signed ? '-' : ''}${whole || '0'}.${fraction || '0'}`);
  const read = (value: number, otherReading: number | null = null): TypedNumber => ({ value, unreadable: false, otherReading });

  const plain = PLAIN.exec(body);
  if (plain) {
    const [, whole, fraction] = plain;
    const decimal = number(whole, fraction);
    if (fraction.length !== 3) return read(decimal);
    const groupsFirst = money || decimals === 0;
    if (FIRST_GROUP.test(whole)) {
      const grouped = number(whole + fraction);
      return groupsFirst ? read(grouped) : read(decimal, grouped);
    }
    // 1500.000 is no proper group, and in a field with no third decimal no decimal either.
    return groupsFirst && decimals < 3 && whole.length > 3 ? UNREADABLE : read(decimal);
  }

  if (GROUPS.test(body)) return read(number(digitsOf(body)));
  const mixed = GROUPS_AND_FRACTION.exec(body);
  return mixed && mixed[3] !== mixed[2] ? read(number(digitsOf(mixed[1]), mixed[4])) : UNREADABLE;
}
