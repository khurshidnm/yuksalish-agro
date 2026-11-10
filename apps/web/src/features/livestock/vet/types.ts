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
  /** From this farm's own lambings; null until the first one. */
  expectedLambs: number | null;
  /** The outlook's estimate from its stated lambs-per-ewe assumption; null with no ewes due. */
  assumedLambs?: number | null;
  assumedLambsPerEwe?: number;
  /** Ewes with a pregnancy scan, and the foetuses counted in them: those are counted, not estimated. */
  scannedEwes?: number;
  scannedFetuses?: number;
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
  /** The plan a scheduled dose answered. */
  planName: string | null;
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
  itemCategory: string | null;
  /** The type of the last record made under this plan, if any. */
  lastType: string | null;
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

export interface ScanEwe {
  breedingId: string;
  eweId: string;
  tag: string;
  herdId: string | null;
  herdName: string | null;
  expectedDate: string;
  /** Null until she is scanned. */
  fetusCount: number | null;
  scanDate: string | null;
}

export interface ScanEwes {
  summary: { total: number; notScanned: number; single: number; twin: number; triplet: number; fetuses: number };
  ewes: ScanEwe[];
}

export interface BulkScanResult {
  date: string;
  recorded: number;
  closed: number;
  skipped: { tag: string | null; eweId: string | null; reason: string }[];
}

export type Mothering = 'with_dam' | 'fostered' | 'bottle';

export interface LambCare {
  lambId: string;
  tag: string;
  birthDate: string | null;
  damId: string | null;
  damTag: string | null;
  /** False until someone has entered anything for this lamb. */
  recorded: boolean;
  colostrumAt: string | null;
  navelTreated: boolean;
  mothering: Mothering | null;
  fosterEweId: string | null;
  fosterEweTag: string | null;
  notes: string | null;
}

export interface AttentionLamb {
  lambId: string;
  tag: string;
  sex: string;
  birthDate: string;
  ageDays: number;
  /** At least this old: the hour of birth itself is not recorded. */
  hoursOld: number;
  damId: string | null;
  damTag: string | null;
  herdName: string | null;
  facilityName: string | null;
  colostrumAt: string | null;
  navelTreated: boolean;
  mothering: Mothering | null;
  fosterEweTag: string | null;
  reasons: ('no_colostrum' | 'bottle')[];
}

export interface WatchEwe {
  breedingId: string;
  eweId: string;
  tag: string;
  expectedDate: string;
  expectedEarliest: string;
  expectedLatest: string;
  fetusCount: number | null;
  herdId: string | null;
  herdName: string | null;
  facilityId: string | null;
  facilityName: string | null;
  barnName: string | null;
  daysLeft: number;
  overdue: boolean;
  firstLambing: boolean;
  complications: { date: string; text: string }[];
  stillborn: number;
  inPen: boolean;
}

export interface Pen {
  id: string;
  name: string;
  parentId: string | null;
  parentName: string | null;
  free: boolean;
  stay: {
    id: string;
    eweId: string;
    eweTag: string;
    sinceDate: string;
    plannedReleaseDate: string | null;
    releaseDue: boolean;
    lambs: { id: string; tag: string }[];
  } | null;
}

export interface PenSection {
  id: string;
  name: string;
  parentId: string | null;
  parentName: string | null;
  capacity: number | null;
  lambingPen: boolean;
}

export interface LambingDesk {
  today: string;
  limits: { watchDays: number; colostrumHours: number; penDays: number };
  counts: {
    dueThisWeek: number;
    overdue: number;
    lambedToday: number;
    lambsToday: number;
    lambsNeedingAttention: number;
    pensTotal: number;
    pensFree: number;
  };
  watch: WatchEwe[];
  attention: AttentionLamb[];
  pens: Pen[];
}

// ─── Appraisal: body condition, fat tail, grading, ewe score, culling ───────

export interface ScorePart {
  key: string;
  /** The fact behind the part: lambs per lambing, a share 0..1, an index, days, years or a condition score. */
  value: number;
  /** 0..100. */
  points: number;
  /** Share of the score this part carries, after the missing parts gave theirs up. */
  weight: number;
}

export interface EweScore {
  score: number | null;
  parts: ScorePart[];
  missing: string[];
  lambings: number;
}

export interface ScoredEwe extends EweScore {
  eweId: string;
  tag: string;
  status: string;
  herdId: string | null;
  herdName: string | null;
  birthDate: string | null;
  ageYears: number | null;
  lambsBorn: number;
  lambsAlive: number;
  survivalPercent: number | null;
  avgWeight100Kg: number | null;
  bodyCondition: number | null;
  bodyConditionDate: string | null;
  gradingClass: string | null;
  gradedOn: string | null;
  cullMarked: boolean;
}

export interface ConditionAnimal {
  animalId: string;
  tag: string;
  category: string;
  speciesKey: string | null;
  herdId: string | null;
  herdName: string | null;
  score: number | null;
  scoredOn: string | null;
}

export interface HerdCondition {
  summary: {
    head: number;
    scored: number;
    average: number | null;
    thin: number;
    thinPercent: number | null;
    recentDays: number;
    thinAtOrBelow: number;
  };
  animals: ConditionAnimal[];
}

export interface BulkConditionResult {
  date: string;
  recorded: number;
  skipped: { tag: string | null; animalId: string | null; reason: string }[];
}

export interface CullMark {
  id: string;
  animalId: string;
  reason: string;
  note: string | null;
  markedOn: string;
}

export interface Appraisal {
  animalId: string;
  bodyCondition: { id: string; date: string; score: number; notes: string | null } | null;
  gradingClass: string | null;
  gradedOn: string | null;
  conditionScores: { id: string; date: string; score: number; notes: string | null }[];
  fatTail: { id: string; date: string; widthCm: number | null; lengthCm: number | null; circumferenceCm: number | null; notes: string | null }[];
  gradings: { id: string; date: string; classKey: string; gradedBy: string | null; notes: string | null }[];
  gradingClasses: string[];
  cullMark: CullMark | null;
}

export interface CullSuggestion {
  animalId: string;
  tag: string;
  herdId: string | null;
  herdName: string | null;
  ageYears: number | null;
  lambings: number;
  score: number | null;
  bodyCondition: number | null;
  reasons: string[];
}

export interface MarkedAnimal {
  id: string;
  animalId: string;
  tag: string;
  category: string;
  herdId: string | null;
  herdName: string | null;
  reason: string;
  note: string | null;
  markedOn: string;
  ageYears: number | null;
  score: number | null;
  suggestedReasons: string[];
}

export interface CullingList {
  suggested: CullSuggestion[];
  marked: MarkedAnimal[];
  flock: { ewes: number; scored: number; lowScoreCutoff: number | null };
  thresholds: {
    oldAgeYears: number;
    emptySeasons: number;
    lambingsWithoutRearing: number;
    lowScoreShare: number;
    lowScoreMinFlock: number;
    thinScorings: number;
    complicatedLambings: number;
    thinAtOrBelow: number;
  };
}
