import type { CostingMethod, OverheadBaseValue } from '@yap/shared';

/** Tenant policy. Stored as a partial in tenants.settings and merged over these defaults. */
export interface TenantSettings {
  finance: {
    /** At or above this base-currency amount, a transaction needs approval. */
    approvalThreshold: number;
    /** Maker-checker: the approver must differ from the creator (spec 5.1). */
    makerChecker: boolean;
    /** Base for sharing general costs (spec 25.1). */
    overheadBase: OverheadBaseValue;
  };
  inventory: { costingMethod: CostingMethod };
  feed: {
    /** Winter housing period used by the feed planner. */
    winterDays: number;
    /** Warn when a feed covers fewer days than this. */
    minStockDays: number;
    /** Daily log deviation from the ration that raises an alert, percent. */
    deviationPercent: number;
  };
  livestock: { quarantineDays: number; defaultGestationDays: number };
  security: {
    /** Spec 20.1: 2FA is mandatory for owner, director and accountant. */
    enforce2fa: boolean;
  };
  storage: {
    /** All of this workspace's files together. */
    quotaMb: number;
    /** What one person may upload in 24 hours. */
    dailyUploadMb: number;
  };
  /** Days each kind of passing data is kept (modules/settings/retention.ts). */
  retention: {
    /** Messages to people, once nothing is waiting to go out. */
    notificationDays: number;
    /** Stored answers to repeated requests. A phone can sit offline for weeks. */
    idempotencyDays: number;
    /** The webhook delivery log, once a delivery has finished. */
    webhookDeliveryDays: number;
    /** What the assistant looked up for an answer. The words of the answer stay. */
    aiToolDataDays: number;
    /** Spreadsheet rows an import still holds, which can be personal data. */
    importDays: number;
    /** Raw collar and bolus readings. Each animal's daily summary stays. */
    trackerReadingsDays: number;
  };
}

export const DEFAULT_SETTINGS: TenantSettings = {
  finance: { approvalThreshold: 5_000_000, makerChecker: true, overheadBase: 'head' },
  inventory: { costingMethod: 'fifo' },
  feed: { winterDays: 120, minStockDays: 14, deviationPercent: 15 },
  livestock: { quarantineDays: 21, defaultGestationDays: 150 },
  security: { enforce2fa: true },
  storage: { quotaMb: 20_480, dailyUploadMb: 500 },
  retention: { notificationDays: 365, idempotencyDays: 30, webhookDeliveryDays: 90, aiToolDataDays: 90, importDays: 90, trackerReadingsDays: 30 },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch) || !isPlainObject(base)) return (patch === undefined ? base : (patch as T));
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : value;
  }
  return out as T;
}

export function mergeSettings(stored: unknown): TenantSettings {
  return deepMerge(DEFAULT_SETTINGS, stored);
}
