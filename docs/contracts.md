# Cross-module contracts

Modules are built in parallel against this list. These names and shapes are fixed. If you must change one,
say so in your final report.

## Lookups for dropdowns

`access: 'authenticated'`, so any role's form can use them. They return `[{ id, name, ... }]` capped at 50
rows, accept `?search=`, and never include money.

| Endpoint | Extra fields | Owner |
| --- | --- | --- |
| `GET /finance/counterparties/lookup` | `type` | finance (exists) |
| `GET /finance/cost-centers/lookup?type=` | `type`, `refId` | finance |
| `GET /finance/categories?kind=` | `group`, `key`, `kind`; `name` is `{uz,ru,en}` | finance |
| `GET /finance/accounts/lookup` | `type`, `currency` | finance |
| `GET /farm/fields/lookup?landUse=` | `number`, `areaHa` | land |
| `GET /farm/facilities/lookup?type=` | `type` | land |
| `GET /crops/seasons` | `kind`, `startDate`, `endDate`, `isCurrent` | crops |
| `GET /crops/crops` | `key`, `isFeed`; `name` is `{uz,ru,en}` | crops |
| `GET /assets/lookup?type=` | `type`, `inventoryNo` | crops |
| `GET /livestock/herds/lookup` | `state`, `headCount` | livestock |
| `GET /livestock/animals/lookup?search=&sex=&category=` | `tag`, `category`, `sex`, `herdId` | livestock |
| `GET /livestock/species` | `key`, `gestationDays`, `breeds[]`; `name` is `{uz,ru,en}` | livestock |
| `GET /inventory/items/lookup?category=` | `category`, `unit`, `qtyOnHand` | inventory |
| `GET /inventory/warehouses/lookup?type=` | `type` | inventory |
| `GET /hr/employees/lookup` | `position`, `userId` | hr |
| `GET /users/lookup` (mounted at `/settings/users/lookup`) | `fullName`, `roleKey` | settings |

## Services other modules call

Import only these from another module.

```ts
// modules/livestock/breeding.service.ts (vet agent)
createPregnancy(i: { id?: string; eweId: string; matingDate: string; ramId?: string | null;
  source?: 'mating' | 'purchase'; notes?: string | null }): Promise<BreedingRecord>
  // computes expected dates from the species' gestation days, sets the ewe to 'pregnant'.

// modules/livestock/animals.service.ts (livestock agent)
createAnimal(i: AnimalInput): Promise<Animal>   // also the path used by lambing and Excel import
markExited(animalId: string, status: 'sold'|'slaughtered'|'dead'|'lost', date: string): Promise<void>
herdHeadCount(herdId: string): Promise<number>  // animals on the farm in this herd today

// modules/livestock/herds.service.ts (livestock agent)
createHerd(i): Promise<Herd>                    // creates the cost center

// modules/farm/fields.service.ts (land agent)
createField(i): Promise<Field>                  // computes area, creates the cost center

// modules/inventory/items.service.ts (inventory agent)
createItem(i): Promise<Item>

// modules/alerts/alerts.service.ts (tasks agent)
raiseAlert(i: { ruleKey: string; dedupKey: string; severity: 'info'|'attention'|'urgent'; title: string;
  body?: string; link?: string; entityType?: string; entityId?: string;
  source?: 'rule'|'ai'|'device'; data?: Record<string, unknown> }): Promise<void>
  // idempotent per dedupKey while the alert is open; notifies the responsible roles.

// modules/notifications/notify.service.ts (tasks agent)
notifyRole(role: RoleKey | RoleKey[], n: { severity; title; body?; link? }): Promise<void>
notifyUser(userId: string, n): Promise<void>
```

## Summary functions for dashboards and reports

Each module exports these from `modules/<m>/summary.ts`. They run inside the request context, respect
`farmId`, and return plain JSON. Numbers that cannot be computed are `null`.

```ts
// finance (the cost engine lives here; nobody else computes cost)
cashPosition(): { accounts: {id,name,type,balance}[]; total: number }
monthToDate(month?: string): { income: number; expense: number; month: string }
debtSummary(): { receivable: number; payable: number; overdue: number }
budgetExecution(from: string, to: string): { planned: number; actual: number; percent: number|null;
  rows: { categoryId, name, planned, actual, deviation, percent }[] }
cashflowForecast(months: number): { month: string; inflow: number; outflow: number; closing: number }[]
costCenterCosts(from?: string, to?: string): { costCenterId, type, refId, name, direct, materials,
  overhead, total, income, profit, profitabilityPercent }[]
herdCost(herdId?: string): { head: number; purchaseCost: number; accumulated: number;
  costPerHead: number|null; breakdown: {feed,vet,labor,overhead} }
fieldCosts(seasonId?: string): { fieldId, number, areaHa, crop, planned, actual, deviation, harvestT,
  yieldTHa, costPerTon }[]

// livestock
herdSummary(): { total: number; byCategory: Record<string,number>; byStatus: Record<string,number>;
  pregnant: number; sick: number; quarantine: number }
lambingCalendar(days: number): { date: string; expected: number }[]
mortality(days: number): { dead: number; percent: number|null }
weightTrend(months: number): { month: string; avgKg: number|null }[]
herdMovement(from: string, to: string): { opening, born, purchased, sold, slaughtered, dead, lost, closing }
reproductionKpis(): { lambingPercent: number|null; survivalPercent: number|null; ... }

// inventory
feedBalance(): { itemId, name, unit, stockQty, plannedDaily, actualDaily, daysByPlan: number|null,
  daysByActual: number|null, belowMinimum: boolean }[]
lowStock(): { itemId, name, unit, stockQty, minQty }[]
feedConsumption(days: number): { date: string; qty: number }[]

// crops
fieldStatus(): { sown: number; irrigated: number; harvested: number; total: number }
overdueOperations(): { id, type, date, fieldNumber }[]
harvestPlanFact(seasonId?: string): { plannedT: number; actualT: number }

// assets
assetStatus(): { total: number; byStatus: Record<string,number> }
fuelUsage(days: number): { liters: number }

// hr
attendanceToday(): { present: number; total: number }

// tasks
taskSummary(): { open: number; overdue: number; doneToday: number }

// alerts
openAlerts(limit: number): Alert[]
```
