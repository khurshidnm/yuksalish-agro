import { ANIMAL_ON_FARM_STATUSES, type AnimalStatus } from '@yap/shared';
import { ageInMonths } from '@yap/shared/formulas/livestock';
import { latinToCyrillic } from '@yap/shared/i18n';
import {
  Baby,
  Banknote,
  Beef,
  CircleCheck,
  CircleHelp,
  type LucideIcon,
  ShieldAlert,
  Skull,
  Thermometer,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge, type BadgeVariant } from '@/components/ui';

export interface I18nName {
  uz: string;
  ru: string;
  en: string;
}

export interface Animal {
  id: string;
  tag: string;
  speciesId: string;
  breedId: string | null;
  sex: 'female' | 'male';
  category: string;
  birthDate: string | null;
  birthDateEstimated: boolean;
  origin: 'born' | 'purchased';
  damId: string | null;
  sireId: string | null;
  purchaseDate: string | null;
  purchasePrice: number | null;
  sellerId: string | null;
  herdId: string | null;
  facilityId: string | null;
  status: AnimalStatus;
  currentWeightKg: number | null;
  lastWeighedOn: string | null;
  birthWeightKg: number | null;
  photoFileId: string | null;
  exitDate: string | null;
  notes: string | null;
  herdName?: string | null;
  breedName?: I18nName | null;
}

export interface HerdRow {
  id: string;
  name: string;
  state: string;
  status: string;
  facilityId: string | null;
  rationId: string | null;
  costCenterId: string | null;
  notes: string | null;
  headCount: number;
  facilityName?: string | null;
  rationName?: string | null;
}

export interface Species {
  id: string;
  key: string;
  name: I18nName;
  gestationDays: number;
  breeds: { id: string; key: string; name: I18nName }[];
}

export interface HerdSummary {
  total: number;
  byCategory: Record<string, number>;
  byStatus: Record<string, number>;
  pregnant: number;
  sick: number;
  quarantine: number;
}

export interface LookupRow {
  id: string;
  name: string;
}

export interface HerdLookup extends LookupRow {
  state: string;
  headCount: number;
}

export interface AnimalLookup extends LookupRow {
  tag: string;
  category: string;
  sex: string;
  herdId: string | null;
}

const STATUS_STYLE: Record<AnimalStatus, { variant: BadgeVariant; icon: LucideIcon }> = {
  active: { variant: 'success', icon: CircleCheck },
  pregnant: { variant: 'info', icon: Baby },
  sick: { variant: 'danger', icon: Thermometer },
  quarantine: { variant: 'warning', icon: ShieldAlert },
  sold: { variant: 'neutral', icon: Banknote },
  slaughtered: { variant: 'neutral', icon: Beef },
  dead: { variant: 'outline', icon: Skull },
  lost: { variant: 'outline', icon: CircleHelp },
};

/** Icon and word together: the colour alone must not carry the meaning, outdoors or on a cheap screen. */
export function StatusBadge({ status }: { status: AnimalStatus }) {
  const { t } = useTranslation();
  const { variant, icon: Icon } = STATUS_STYLE[status];
  return (
    <Badge variant={variant}>
      <Icon aria-hidden />
      {t(`enums:animalStatus.${status}`)}
    </Badge>
  );
}

export function isOnFarm(status: string): boolean {
  return (ANIMAL_ON_FARM_STATUSES as readonly string[]).includes(status);
}

/** Reference data carries its own translations; Cyrillic Uzbek comes from the Latin spelling. */
export function useLocalName() {
  const { i18n } = useTranslation();
  return (name: I18nName | null | undefined): string => {
    if (!name) return '—';
    if (i18n.language === 'uz-Cyrl') return latinToCyrillic(name.uz);
    return name[i18n.language as keyof I18nName] ?? name.uz;
  };
}

/** "3 yosh 2 oy": what a farmer says, rather than a birth date. */
export function useAgeText() {
  const { t } = useTranslation('livestock');
  return (birthDate: string | null | undefined, onDate: string): string => {
    const months = ageInMonths(birthDate, onDate);
    if (months === null) return '—';
    const years = Math.floor(months / 12);
    const rest = months % 12;
    if (years === 0) return t('age.months', { months });
    return rest === 0 ? t('age.years', { years }) : t('age.yearsMonths', { years, months: rest });
  };
}

/** The server accepts this id, so a retry after a dropped connection cannot create a second record. */
export function newClientId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // crypto.randomUUID exists only on HTTPS and localhost.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Phone photos run to several MB; on a rural connection the upload must stay small (spec 18.2). */
export async function compressImage(file: File, maxSide = 1600, quality = 0.8): Promise<File> {
  if (!file.type.startsWith('image/')) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' });
  } catch {
    return file;
  }
}
