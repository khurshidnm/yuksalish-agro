export interface Pregnancy {
  id: string;
  eweId: string;
  ramId: string | null;
  source: 'mating' | 'purchase';
  matingDate: string;
  expectedDate: string;
  expectedEarliest: string;
  expectedLatest: string;
  status: 'pregnant' | 'lambed' | 'aborted' | 'failed';
  notes: string | null;
  eweTag: string;
  eweStatus: string;
  herdId: string | null;
  herdName: string | null;
  ramTag: string | null;
  daysToExpected: number;
}

export interface InbreedingCheck {
  related: boolean;
  common: { id: string; tag: string | null; distanceEwe: number; distanceRam: number }[];
}

export interface BulkResult {
  created: number;
  skipped: { animalId: string; tag: string; reason: string }[];
  inbreeding: { animalId: string; tag: string }[];
}

export interface LambingCalendar {
  from: string;
  to: string;
  days: { date: string; expected: number }[];
  weeks: { week: string; expected: number }[];
  totalEwes: number;
  overdue: number;
  expectedLambs: number | null;
}

export interface LambDetail {
  sex: string;
  birthWeightKg: number | null;
  alive: boolean;
  animalId: string | null;
  tag: string | null;
}

export interface Lambing {
  id: string;
  eweId: string;
  eweTag: string;
  herdName: string | null;
  date: string;
  lambsBorn: number;
  lambsAlive: number;
  lambs: LambDetail[];
  complications: string | null;
  notes: string | null;
}

export interface ReproductionKpis {
  ewesPregnant: number;
  ewesMated: number;
  ewesWithOutcome: number;
  lambings: number;
  lambsBorn: number;
  lambsBornAlive: number;
  lambingPercent: number | null;
  survivalPercent: number | null;
  lambsPerEwe: number | null;
  avgWeight100Kg: number | null;
}

export interface EwePerformance {
  id: string;
  tag: string;
  status: string;
  lambings: number;
  lambsBorn: number;
  lambsAlive: number;
  survivalPercent: number | null;
  avgWeight100Kg: number | null;
}

export interface RamRow {
  rank: number | null;
  ramId: string;
  tag: string;
  status: string;
  progeny: number;
  weighed: number;
  avgWeight100Kg: number | null;
  avgGainGrams: number | null;
  index: number | null;
  lowConfidence: boolean;
}

export interface PedigreeBase {
  id: string;
  tag: string;
  sex: string;
  category: string;
  status: string;
  birthDate: string | null;
}

export interface AncestorNode extends PedigreeBase {
  dam: AncestorNode | null;
  sire: AncestorNode | null;
}

export interface DescendantNode extends PedigreeBase {
  children: DescendantNode[];
}

export interface Pedigree {
  animal: AncestorNode;
  descendants: DescendantNode[];
  truncated: boolean;
}

export interface HealthRecord {
  id: string;
  type: string;
  animalId: string | null;
  herdId: string | null;
  animalTag: string | null;
  herdName: string | null;
  date: string;
  diagnosis: string | null;
  itemId: string | null;
  itemName: string | null;
  itemUnit: string | null;
  warehouseId: string | null;
  dose: number | null;
  doseUnit: string | null;
  qtyUsed: number | null;
  courseDays: number | null;
  vetEmployeeId: string | null;
  vetName: string | null;
  result: string | null;
  withdrawalDays: number | null;
  withdrawalUntil: string | null;
  headCount: number | null;
  /** Null without finance.view. */
  totalCost: number | null;
  nextDueDate: string | null;
  vaccinationPlanId: string | null;
  reportStatus: 'open' | 'resolved' | null;
  endedOn: string | null;
  notes: string | null;
}

export interface SickReport {
  id: string;
  animalId: string;
  date: string;
  notes: string | null;
  result: string | null;
  reportStatus: 'open' | 'resolved';
  endedOn: string | null;
  tag: string;
  animalStatus: string;
  herdName: string | null;
  reportedBy: string | null;
  photoUrls: string[];
}

export interface QuarantineRow {
  id: string;
  animalId: string;
  startDate: string;
  until: string | null;
  endedOn: string | null;
  reason: string | null;
  result: string | null;
  tag: string;
  herdName: string | null;
  daysLeft: number | null;
}

export interface WithdrawalRow {
  animalId: string;
  tag: string;
  herdName: string | null;
  drug: string | null;
  recordId: string;
  withdrawalUntil: string;
  daysLeft: number;
}

export interface VaccinationPlan {
  id: string;
  name: string;
  itemId: string | null;
  itemName: string | null;
  itemUnit: string | null;
  speciesId: string | null;
  category: string | null;
  ageDays: number | null;
  intervalDays: number | null;
  mandatory: boolean;
  notes: string | null;
}

export type DueState = 'overdue' | 'today' | 'upcoming';

export interface DueRow {
  planId: string;
  planName: string;
  mandatory: boolean;
  itemId: string | null;
  herdId: string | null;
  herdName: string | null;
  dueDate: string;
  state: DueState;
  daysOverdue: number;
  head: number;
}

export interface VaccinationDue {
  rows: DueRow[];
  /** Doses by state: an animal on two plans counts twice. */
  totals: Record<DueState, number>;
  animals: number;
  plans: number;
}

export interface VetDocument {
  id: string;
  title: string;
  number: string | null;
  issueDate: string | null;
  expiryDate: string | null;
  entityType: string | null;
  entityId: string | null;
  notes: string | null;
  fileUrl: string | null;
}

export interface VetToday {
  date: string;
  vaccinations: Record<DueState, number> & { animals: number; plans: number; rows: DueRow[] };
  sick: { open: number; animals: number; reports: SickReport[] };
  quarantine: { active: number; endingSoon: QuarantineRow[] };
  courses: { id: string; date: string; courseDays: number; diagnosis: string | null; tag: string | null; herdName: string | null; itemName: string | null; day: number }[];
  withdrawal: { animals: number };
}

/** The fields of GET /livestock/animals that the sick list needs. */
export interface SickAnimal {
  id: string;
  tag: string;
  status: string;
  herdName: string | null;
}
