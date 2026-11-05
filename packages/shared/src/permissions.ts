/**
 * Role-based access control (spec section 5).
 *
 * A permission is "<module>.<action>". The matrix below is the default set for a new tenant;
 * tenants can customise role permissions in Settings, stored in the `roles` table.
 */
export const MODULES = [
  'dashboard',
  'farm', // farm passport, land, facilities, documents
  'crops',
  'livestock',
  'health', // veterinary
  'inventory',
  'feed', // rations and feed planning
  'finance',
  'payroll',
  'hr',
  'assets',
  'sales',
  'reports',
  'ai',
  'cameras',
  'tasks',
  'users',
  'settings',
  'audit',
] as const;
export type Module = (typeof MODULES)[number];

export const ACTIONS = ['view', 'create', 'update', 'approve', 'delete'] as const;
export type Action = (typeof ACTIONS)[number];

/** Investors must not see personal data (spec section 5). Hidden unless a role holds this. */
export const PII_VIEW = 'pii.view';

/**
 * Aggregated finance figures without the journal, accounts pages or counterparties. Investors hold
 * this: the spec promises them a dashboard and reports (2.2, 5) but not access to the books.
 */
export const FINANCE_SUMMARY_VIEW = 'finance.summary';

export type Permission = `${Module}.${Action}` | typeof PII_VIEW | typeof FINANCE_SUMMARY_VIEW;

export const ROLE_KEYS = [
  'owner',
  'director',
  'accountant',
  'agronomist',
  'zootechnician',
  'veterinarian',
  'storekeeper',
  'mechanic',
  'shepherd',
  'investor',
  'auditor',
] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

/** Spec 20.1: two-factor authentication is mandatory for these roles. */
export const ROLES_REQUIRING_2FA: readonly RoleKey[] = ['owner', 'director', 'accountant'];

function grant(modules: readonly Module[], actions: readonly Action[] = ACTIONS): Permission[] {
  return modules.flatMap((m) => actions.map((a) => `${m}.${a}` as Permission));
}

const VIEW: readonly Action[] = ['view'];
const WRITE: readonly Action[] = ['view', 'create', 'update'];
const OPERATIONAL: readonly Module[] = [
  'dashboard',
  'farm',
  'crops',
  'livestock',
  'health',
  'inventory',
  'feed',
  'finance',
  'payroll',
  'hr',
  'assets',
  'sales',
  'reports',
  'ai',
  'cameras',
  'tasks',
];

export const DEFAULT_ROLE_PERMISSIONS: Record<RoleKey, Permission[]> = {
  owner: [...grant(MODULES), PII_VIEW],
  director: [...grant(OPERATIONAL), ...grant(['users', 'settings', 'audit'], VIEW), PII_VIEW],
  accountant: [
    ...grant(['finance', 'payroll']),
    ...grant(['sales'], WRITE),
    ...grant(['ai'], ['view', 'create']),
    ...grant(['dashboard', 'reports', 'hr', 'assets', 'farm', 'crops', 'livestock', 'inventory', 'feed'], VIEW),
    ...grant(['tasks'], WRITE),
    PII_VIEW,
  ],
  agronomist: [
    ...grant(['crops']),
    ...grant(['inventory'], ['view', 'create']),
    ...grant(['farm'], WRITE),
    ...grant(['dashboard', 'reports', 'assets', 'feed'], VIEW),
    ...grant(['tasks'], WRITE),
  ],
  zootechnician: [
    ...grant(['livestock', 'feed']),
    ...grant(['health'], WRITE),
    ...grant(['inventory'], ['view', 'create']),
    ...grant(['dashboard', 'reports', 'farm'], VIEW),
    ...grant(['tasks'], WRITE),
  ],
  veterinarian: [
    ...grant(['health']),
    ...grant(['inventory'], ['view', 'create']),
    ...grant(['livestock'], ['view', 'update']),
    ...grant(['dashboard', 'feed'], VIEW),
    ...grant(['tasks'], WRITE),
  ],
  storekeeper: [
    ...grant(['inventory'], WRITE),
    ...grant(['dashboard', 'feed', 'crops', 'farm'], VIEW),
    ...grant(['tasks'], WRITE),
  ],
  mechanic: [
    ...grant(['assets', 'crops', 'farm'], VIEW),
    ...grant(['crops'], ['create']),
    ...grant(['tasks'], ['view', 'update']),
  ],
  shepherd: [
    ...grant(['livestock', 'feed'], VIEW),
    ...grant(['livestock'], ['create']),
    ...grant(['health'], ['view', 'create']),
    ...grant(['tasks'], ['view', 'update']),
  ],
  investor: [...grant(['dashboard', 'reports'], VIEW), FINANCE_SUMMARY_VIEW],
  auditor: [
    ...grant(['finance', 'payroll', 'audit', 'reports', 'dashboard', 'inventory', 'livestock', 'crops', 'assets', 'sales', 'farm'], VIEW),
    PII_VIEW,
  ],
};

export function can(permissions: Iterable<string>, required: Permission): boolean {
  for (const p of permissions) if (p === required) return true;
  return false;
}
