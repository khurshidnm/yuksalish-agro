import { uuid } from 'drizzle-orm/pg-core';
import { ts } from './_helpers';
import { farms, tenants, users } from './platform';

/** Columns required on every business table (spec section 22). */
export const tenantColumns = () => ({
  tenantId: uuid().notNull().references(() => tenants.id),
  farmId: uuid().notNull().references(() => farms.id),
  createdBy: uuid().references(() => users.id),
  createdAt: ts().notNull().defaultNow(),
  updatedAt: ts().notNull().defaultNow().$onUpdate(() => new Date()),
});

/** Reference data shared across a tenant's farms. */
export const tenantOnlyColumns = () => ({
  tenantId: uuid().notNull().references(() => tenants.id),
  createdAt: ts().notNull().defaultNow(),
  updatedAt: ts().notNull().defaultNow().$onUpdate(() => new Date()),
});
