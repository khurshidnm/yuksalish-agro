/**
 * Crop rotation rules: what a field carried before against what is planned next. The one
 * implementation behind the plan form's warnings and the AI suggestion's rotation penalty.
 *
 * Every rule is a sentence from a named textbook, not a model. The rules warn and never block:
 * a farm with four crops and a herd to feed breaks them knowingly.
 *
 * Sources:
 *  [B] Баздырев Г.И., Лошаков В.Г., Пупонин А.И. и др. «Земледелие», Москва, Колос, 2000, chapter
 *      «Севооборот», as quoted by universityagro.ru:
 *      - return to the same field: «Для большинства культур этот период составляет 2-3 года»;
 *      - repeat sowing is tolerated by «картофеля, кукурузы, риса»;
 *      - «к наихудшим предшественникам относятся зерновые культуры», and
 *        «следует избегать повторных посевов зерновых более 2 лет»;
 *      - «Зернобобовые хорошие предшественники почти для всех культур», but
 *        «Нецелесообразно использовать повторные посевы зернобобовых»;
 *      - perennial grasses stand «в полевых севооборотах 2-3 года, в кормовых и специализированных —
 *        4-5 лет и более», and their after-effect «сохраняется на вторую и третью культуры».
 *  [M] Махмудов А., докторский автореферат, УзНИИХ, Ташкент, 1994: cotton after cotton without
 *      lucerne fell from 25.6 to 18.3 ц/га; lucerne was ploughed «после трехгодичного стояния».
 *  [T] Тураев У.У., Бобомирзаев П.Х., «Innovatsion texnologiyalar», 2024, № 3(55), с. 133-137 (Bukhara):
 *      wheat after mung bean gave 10.8 ц/га more than wheat straight after wheat.
 *
 * Not found, and so not judged: a predecessor table for these crops under irrigation in Central
 * Asia, and a largest safe share of cereals in the rotation.
 */
import type { CROP_FAMILIES } from '../enums';

export type CropFamily = (typeof CROP_FAMILIES)[number];

/**
 * The family of the crops every new farm starts with, used where the farm has not set one.
 * Lucerne is a legume to a botanist; in a rotation it plays the part of a perennial grass.
 */
export const TYPICAL_CROP_FAMILY: Readonly<Record<string, CropFamily>> = {
  wheat: 'cereal',
  barley: 'cereal',
  rice: 'cereal',
  alfalfa: 'perennial_grass',
  corn: 'row_crop',
  cotton: 'row_crop',
};

export function cropFamilyOf(key: string, stored: string | null | undefined): CropFamily | null {
  return (stored as CropFamily | null | undefined) ?? TYPICAL_CROP_FAMILY[key] ?? null;
}

/** Crops that [B] names as tolerating repeat sowing. */
const REPEAT_TOLERANT_KEYS = new Set(['corn', 'corn_grain', 'corn_silage', 'maize', 'rice', 'potato']);

export const ROTATION_SOURCES = {
  B: 'Баздырев Г.И. и др., «Земледелие», 2000',
  T: 'Тураев У.У., Бобомирзаев П.Х., 2024 (Buxoro)',
} as const;

export type RotationRule =
  /** The same crop straight after itself. */
  | 'same_crop'
  /** A third cereal in a row. */
  | 'cereal_run'
  /** A cereal after another cereal. */
  | 'cereal_after_cereal'
  /** A grain legume after another grain legume. */
  | 'legume_after_legume'
  /** Good: after a grain legume. */
  | 'after_legume'
  /** Good: after a perennial grass such as lucerne. */
  | 'after_perennial_grass';

export interface RotationNote {
  rule: RotationRule;
  level: 'warning' | 'good';
  /** Who says so, shown beside the reason. */
  source: string;
}

export interface RotationCrop {
  key: string;
  family: CropFamily | null;
}

const warn = (rule: RotationRule): RotationNote => ({ rule, level: 'warning', source: ROTATION_SOURCES.B });

/**
 * Notes for sowing `crop` on a field whose earlier crops are `history`, newest first. A crop with
 * no family still gets the same-crop rule; the family rules need the family.
 *
 * A perennial grass after itself is the stand growing on, not a repeat: lucerne kept for several
 * years never warns.
 */
export function rotationNotes(crop: RotationCrop, history: readonly RotationCrop[]): RotationNote[] {
  const previous = history[0];
  if (!previous) return [];
  if (crop.family === 'perennial_grass' && previous.key === crop.key) return [];

  const notes: RotationNote[] = [];
  const tolerant = REPEAT_TOLERANT_KEYS.has(crop.key);
  const same = previous.key === crop.key;

  if (same && !tolerant) notes.push(warn('same_crop'));

  if (crop.family === 'cereal' && !tolerant) {
    const cerealsBefore = history.findIndex((h) => h.family !== 'cereal');
    const run = cerealsBefore === -1 ? history.length : cerealsBefore;
    if (run >= 2) notes.push(warn('cereal_run'));
    else if (run === 1 && !same) notes.push(warn('cereal_after_cereal'));
  }

  if (crop.family === 'legume' && previous.family === 'legume' && !same) notes.push(warn('legume_after_legume'));

  if (previous.family === 'legume' && crop.family !== 'legume') {
    notes.push({ rule: 'after_legume', level: 'good', source: `${ROTATION_SOURCES.B}; ${ROTATION_SOURCES.T}` });
  }
  if (previous.family === 'perennial_grass' && crop.family !== 'perennial_grass') {
    notes.push({ rule: 'after_perennial_grass', level: 'good', source: ROTATION_SOURCES.B });
  }
  return notes;
}

/** True when any rule warns: the AI suggestion's rotation penalty. */
export function rotationPenalised(crop: RotationCrop, history: readonly RotationCrop[]): boolean {
  return rotationNotes(crop, history).some((note) => note.level === 'warning');
}
