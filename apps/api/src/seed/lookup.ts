import { and, eq, sql } from 'drizzle-orm';
import { schema } from '../db/client';
import { ctx, tx } from '../core/context';

async function one<T>(rows: Promise<T[]>, what: string): Promise<T> {
  const [row] = await rows;
  if (!row) throw new Error(`Seed lookup failed: ${what}. Check the seed order in seed/names.ts.`);
  return row;
}

const farm = () => ctx().farmId;

export const findItem = (name: string) =>
  one(tx().select().from(schema.items).where(and(eq(schema.items.farmId, farm()), eq(schema.items.name, name))), `item ${name}`);
export const findWarehouse = (name: string) =>
  one(tx().select().from(schema.warehouses).where(and(eq(schema.warehouses.farmId, farm()), eq(schema.warehouses.name, name))), `warehouse ${name}`);
export const findField = (number: string) =>
  one(tx().select().from(schema.fields).where(and(eq(schema.fields.farmId, farm()), eq(schema.fields.number, number))), `field ${number}`);
export const findFacility = (name: string) =>
  one(tx().select().from(schema.facilities).where(and(eq(schema.facilities.farmId, farm()), eq(schema.facilities.name, name))), `facility ${name}`);
export const findHerd = (name: string) =>
  one(tx().select().from(schema.herds).where(and(eq(schema.herds.farmId, farm()), eq(schema.herds.name, name))), `herd ${name}`);
export const findRation = (name: string) =>
  one(tx().select().from(schema.rations).where(and(eq(schema.rations.farmId, farm()), eq(schema.rations.name, name))), `ration ${name}`);
export const findAccount = (name: string) =>
  one(tx().select().from(schema.accounts).where(and(eq(schema.accounts.farmId, farm()), eq(schema.accounts.name, name))), `account ${name}`);
export const findCounterparty = (name: string) =>
  one(tx().select().from(schema.counterparties).where(and(eq(schema.counterparties.farmId, farm()), eq(schema.counterparties.name, name))), `counterparty ${name}`);
export const findAsset = (name: string) =>
  one(tx().select().from(schema.assets).where(and(eq(schema.assets.farmId, farm()), eq(schema.assets.name, name))), `asset ${name}`);
export const findSeason = (name: string) =>
  one(tx().select().from(schema.seasons).where(and(eq(schema.seasons.farmId, farm()), eq(schema.seasons.name, name))), `season ${name}`);
export const findCategory = (key: string) =>
  one(tx().select().from(schema.financeCategories).where(and(eq(schema.financeCategories.tenantId, ctx().tenantId), eq(schema.financeCategories.key, key))), `category ${key}`);
export const findCrop = (key: string) =>
  one(tx().select().from(schema.crops).where(and(eq(schema.crops.tenantId, ctx().tenantId), eq(schema.crops.key, key))), `crop ${key}`);
export const findEmployee = (position: string) =>
  one(tx().select().from(schema.employees).where(and(eq(schema.employees.farmId, farm()), eq(schema.employees.position, position))), `employee ${position}`);

/** Skip the audit trigger for this transaction: seeds would otherwise write a row per insert. */
export const skipAudit = () => tx().execute(sql`select set_config('app.skip_audit', 'on', true)`);
