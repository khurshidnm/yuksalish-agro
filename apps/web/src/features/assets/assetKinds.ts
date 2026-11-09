/** Types that never work a field: a hectare figure or a field on their shift means nothing. */
const NO_FIELD_WORK = new Set(['excavator', 'pump', 'generator', 'scale', 'camera', 'vehicle']);
/** Types with no engine of their own: a plough or seeder runs on the tractor's hours and fuel. */
const NO_ENGINE = new Set(['seeder', 'plough', 'scale', 'camera']);
/** Machines that stand in one place and simply run: their log is hours and fuel, with no operator or field. */
const STATIONARY = new Set(['pump', 'generator']);

export interface AssetKind {
  /** Hectares, fuel per hectare, cost per hectare and a field on the shift apply. */
  worksFields: boolean;
  /** Motor-hours and fuel apply. */
  hasEngine: boolean;
  /** The work log has anything to hold. */
  logsWork: boolean;
  /** The log is a run-hours entry rather than a shift report. */
  stationary: boolean;
}

/**
 * What an asset of this type is measured by. An unknown type, or one filed as "other", keeps every
 * measure: the app does not guess what a machine does.
 */
export function assetKind(type: string): AssetKind {
  const worksFields = !NO_FIELD_WORK.has(type);
  const hasEngine = !NO_ENGINE.has(type);
  return { worksFields, hasEngine, logsWork: worksFields || hasEngine, stationary: STATIONARY.has(type) };
}
