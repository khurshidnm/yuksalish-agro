# Yuksalish Agro Platform (YAP) — engineering guide

Multi-tenant farm-management SaaS. Pilot tenant: Yuksalish Agro (210 ha, 500 Hisori ewes, Qorovulbozor).
The source of truth for requirements is `Yuksalish Agro — Ferma boshqaruv platformasi. Texnik topshiriq.md`.

**Scope right now: web application only.** No Flutter app, no separate Python service. Field staff use the
web app from a phone, so every screen must work at 360 px. AI features live inside the API (`modules/ai`),
behind a swappable provider: Gemini by default, Claude as the alternative.

## Stack

| Layer | Choice |
| --- | --- |
| Monorepo | pnpm workspaces: `apps/api`, `apps/web`, `packages/shared` |
| API | Node 22, Fastify 5, zod 4 + `fastify-type-provider-zod` (OpenAPI at `/api/docs`), Drizzle ORM, `pg` |
| DB | PostgreSQL 17 + PostGIS, RLS for tenant isolation, generic audit triggers |
| Queue | Redis + BullMQ (cron and background jobs) |
| Web | React 19, Vite 8, react-router 8, TanStack Query 5, Tailwind 4, `radix-ui`, lucide-react, Recharts, Leaflet + Geoman, react-hook-form + zod, i18next |
| Tests | vitest (`packages/shared`, `apps/api` against a real Postgres) |

Ports: API 4000, web 5173, Postgres 5434, Redis 6381.

```sh
pnpm db:up            # start Postgres and Redis (docker compose)
pnpm db:reset         # rebuild schema, then seed the pilot tenant
pnpm dev              # API and web together
pnpm typecheck        # all packages
pnpm test             # all packages
```

Demo logins are printed by the seed. Password for every demo user: `Yuksalish2026!`

## Repository layout

```
packages/shared/src/
  formulas/      pure calculations: the ONLY implementation of every spec formula
  permissions.ts roles, modules, default permission matrix
  enums.ts       stable string values for status/type columns
  dates.ts       business-date helpers (Asia/Tashkent)
  i18n/locales/{uz,ru,en}/<namespace>.json   one namespace per module
apps/api/src/
  core/          kernel: context, http guard, errors, query helpers, journal, inventory, ledger, cost centers,
                 settings, storage. Modules call into core; core never imports modules.
  db/schema/     Drizzle schema, one file per domain
  db/post-schema.sql  extensions, PostGIS columns, RLS, audit triggers, grants. Generic over the
                 catalog: a new table with tenant_id gets all of it automatically
  modules/<m>/   index.ts (Fastify plugin) + *.routes.ts + *.service.ts
  jobs/          BullMQ workers and schedules
  seed/          index.ts + one file per domain
apps/web/src/
  app/           shell, router, nav, providers
  components/ui/ UI kit. components/ shared composites (DataTable, PageHeader, ...)
  lib/           api client, auth, i18n, formatters
  features/<m>/  routes.tsx + pages + feature components
  features/landing/  the public website: prerendered at build time, only the contact form is hydrated.
                 Its copy is packages/shared/src/i18n/locales/<lang>/landing.json. Claim only what the
                 product does. It speaks of livestock in general: species cover cattle, sheep, goats,
                 horses and poultry (a test keeps the wording general).
```

The development database was built with `db:setup`, not migrations, so `db:migrate` does not work on it.
For a schema change there, apply the new table by hand; never run `db:reset` on data someone is using.

## Non-negotiable domain rules

1. **Tenant isolation.** All business tables have `tenant_id`, `farm_id`, `created_by`, `created_at`,
   `updated_at`. Every authenticated request runs inside one transaction with `app.tenant_id` set, and
   Postgres RLS enforces isolation. The API connects as `yap_app`, which cannot bypass RLS. Still filter
   by `farmId` in every query, because a tenant can have several farms.
2. **Never bypass the kernel.** Stock quantities change only through `core/inventory`. Money records are
   created only through `core/ledger`. Cost centers come only from `core/costCenters`.
3. **No double counting.** `transactions.costTreatment` decides how an expense reaches a cost center:
   `expense` (direct), `inventory` (bought for stock: reaches a cost center only when issued),
   `capex` (via depreciation), `animal` (capitalised into the animal). Cost reports sum approved
   `expense` transactions plus stock `issue` movements. Purchases for stock must use `inventory`.
   Money and goods stand or fall together: rejecting or voiding the money of a stock purchase takes its
   receipt back, and if the stock was already used, the rejection is refused.
4. **Formulas live in `packages/shared/src/formulas`.** Do not reimplement one. Add it there with a test.
5. **Missing data is `null`, never 0.** A zero denominator yields `null`; the UI shows a "not enough data"
   dash. Do not guess.
6. **Maker-checker.** Transactions at or above the tenant's approval threshold need approval by a different
   user (`core/ledger`). Only `approved` transactions count in balances and reports.
7. **Money is visible only with `finance.view`.** The rule "a shepherd cannot see finance data" (spec 24.1)
   covers every field that reveals money: purchase price, unit cost, ration cost, animal cost. API responses
   strip those fields for users without `finance.view`; hiding them in the UI alone is not enough.
   One exception: the manager of a module sees that module's costs, because the spec gives them the
   whole module. `canSeeMoney('crops.approve')` for crop costs (agronomist), `canSeeMoney('feed.approve')`
   for feed and ration costs (zootechnician). Cash, accounts, debts, sale prices and animal purchase
   prices stay behind `finance.view`. Investors hold `finance.summary`: aggregated figures on the
   dashboard and investor report, without the journal, accounts or counterparties.
8. **Personal data** (phone, passport, salary, employee full name in reports) is hidden without `pii.view`.
9. **AI never writes business data.** It reads through the `yap_ai` role and writes only `ai_insights`,
   `ai_conversations`, `ai_messages` and `ai_proposals`. Postgres enforces this, not just the code. A
   proposal reaches the books only when a person confirms it, through the owning service
   (docs/assistant.md). Nothing on a card rests on the model's word alone: code finds each fact in the
   person's words, and confirm decides again under a lock. Word evidence lives in
   `packages/shared/src/formulas/record-words.ts` and `money-text.ts`, with tests in all four scripts.
10. **Every domain action writes a journal event** via `recordEvent()` (spec 4.1 p.4). Row-level change
    history is captured automatically by audit triggers; do not write audit rows by hand.
11. **Business dates** are `date` columns as `YYYY-MM-DD` strings. "Today" is `todayIso()` from shared,
    never `new Date().toISOString().slice(0, 10)`, which is wrong for 5 hours each night in Tashkent.

## API conventions

- Base path `/api/v1`. Modules mount at `/api/v1/<module>`, e.g. `/api/v1/livestock/animals`.
- Success: `{ "data": T }`. Lists: `{ "data": T[], "meta": { "page", "pageSize", "total" } }`.
- Error: `{ "error": { "code": "SNAKE_UPPER", "message": "...", "details": ... } }` with a matching HTTP
  status. `message` is an English fallback. Add the user-facing text to your module's i18n namespace under
  `errors.<CODE>`; the web app looks it up across namespaces.
- Query params for lists: `page` (1-based), `pageSize` (default 25, max 200), `search`, `sort` (`field` or `-field`).
- JSON is camelCase, DB is snake_case. Drizzle maps this through `casing: 'snake_case'`.
- IDs are UUIDv7. Clients may supply `id` on create (offline outbox), so creates accept an optional `id`.
- `Idempotency-Key` header on POST replays the stored response. `routes()` handles it.

Every route goes through `routes()`, which authenticates, opens the tenant transaction, checks the
permission, module and 2FA policy, replays idempotent requests, and wraps the result in `{ data }`.
A switched-off module grants nothing: use `enabledPermissions(permissions, modules)` for any identity built
outside `routes()`. An `Idempotency-Key` answers only for its own path and person.
Return a plain value, or a `Page` from `paged()`. `apps/api/src/modules/finance/counterparties.*` is the
reference module: copy its shape.

```ts
export function registerCounterparties(app: FastifyInstance) {
  const r = routes(app, 'finance');           // tag in OpenAPI
  r.get('/counterparties', {
    access: 'finance.view',                   // Permission | Permission[] (any of) | 'authenticated' | 'public' | 'platform' | { apiKey: scope }
    query: service.counterpartyListQuery,     // zod; req.query is typed from it
    handler: (req) => service.list(req.query),
  });
}
```

Inside a handler or service: `ctx()` (tenantId, farmId, userId, settings, ...), `tx()` (the transaction,
always use it, never `db`), `today()`, `canSeeMoney()`, `hasPermission(p)`, `assertPermission(p)`.
Route options include `transaction: false` for handlers that wait on something slow (then use
`withTenant(req.identity, fn)` around each DB step) and `config` for per-route rate limits.

## Kernel API (apps/api/src/core)

| File | Exports |
| --- | --- |
| `errors` | `AppError`, `badRequest(code,msg,details?)`, `forbidden(msg?,code?,details?)`, `notFound(what)`, `conflict(code,msg,details?)`, `unauthorized()`, `safeError(error)` for logs: never log a raw database error, its message holds the query's parameters |
| `query` | `listQuery`, `idParam`, `isoDate`, `isoMonth`, `clientId`, `paged(q,table,where,rows)`, `searchAny(term,cols)`, `sortBy(sort,allowed,fallback,tieBreaker?)`, `sumOf(col)` |
| `journal` | `recordEvent({type,entityType,entityId,severity,data,occurredAt,source,photoFileId})` |
| `costCenters` | `ensureCostCenter(type,refId,name)` (call when creating a field, herd or asset, and store the id), `generalCostCenterId()` |
| `inventory` | `receiveStock`, `issueStock` (FIFO or AVG, locks batches, `INSUFFICIENT_STOCK` on shortage, needs `costCenterId` unless reason is `sale`), `transferStock`, `adjustStock`, `reverseMovements(refType,refId)` (when a source record is edited or deleted: reverse, then re-issue), `reverseStockDocument(refId)` (one receipt, by its unique reference, never by document number), `receiptOfBatch(batchId)`, `stockOnHand`, `getItemOrThrow`, `COST_MOVEMENT_TYPES`, `COST_CREDIT_MOVEMENT_TYPES` |
| `ledger` | `postTransaction(input)` (returns the row; large amounts stay `pending`; `documentBase` for one document posted as several rows), `approveTransaction(id)`, `rejectTransaction(id,reason)`, `voidTransactions(match,reason)` (`DEBT_ALREADY_SETTLED` if a settlement would be stranded), `cancelStockPurchase(batchId,reason)`, `assertDebtRemovable(ids)`, `lockDebt(counterpartyId,direction)` (take it before any check-then-write on a debt), `accountTakesCurrency(account,currency)` (the one currency rule), `fxRateIsPlausible(given,stored)`, `resolveFxRate(currency,date,given?)`, `assertCostCenterOpen(id)` |
| `geo` | `computeAreaHa(geojson)`: authoritative area through PostGIS |
| `settings` | `TenantSettings`, read through `ctx().settings` |
| `tenancy` | `provisionTenant`, `addMember` |

Cross-module rules:
- A record that consumes stock passes `refType` and `refId`, so `reverseMovements` can undo it.
- A record that creates money stores the returned transaction id, and sets `sourceType` and `sourceId`.
- Never import another module's internals except its exported `*.service.ts` functions.
- Background work: add a `FarmJob` to `modules/<m>/jobs.ts`. It runs once per farm in a system context.

## Web conventions

- Every string comes from i18n; no literals in JSX. Uzbek is Latin with the ASCII apostrophe (`o'`, `g'`).
  Uzbek Cyrillic is generated from Latin at runtime, so only write `uz`, `ru` and `en`.
- Colours only through Tailwind theme tokens (`bg-card`, `text-muted-foreground`, `border-border`...).
  Light and dark must both work. No hex in components.
- Every screen works at 360 px: tables collapse to cards or scroll inside their own container, tap targets
  are at least 44 px, no horizontal page scroll. Field staff wear gloves.
- Loading is a skeleton, an error is a retry card with the server message, an empty list is `EmptyState`.
- Show actions only when `usePermission()` allows them, and keep the server check as the real enforcement.
- Numbers through `lib/format` (`formatMoney`, `formatQty`, `formatDate`). `null` renders as `—`.
- Data access through TanStack Query with `api` from `lib/api`. Forms use react-hook-form + zod.
- Reference feature: `features/finance/CounterpartiesPage.tsx`. Copy its shape.

## Testing

- API tests run against a fresh, uniquely named database per run, so parallel runs do not collide.
  `createFixture()` from `apps/api/test/helpers.ts` gives a new tenant; `await f.as('shepherd')` gives an API
  client signed in with that role; `f.run(fn)` arranges data inside the tenant with every permission.
  Put module tests in `apps/api/test/<module>.test.ts`. Run one file with
  `pnpm --filter @yap/api exec vitest run test/<module>.test.ts`.
- Cover business rules, not framework behaviour: permission denials, tenant isolation, calculations
  checked against hand-computed control numbers (spec 24.2), and failure paths.
- Report real results. Do not mark something done without running it.
