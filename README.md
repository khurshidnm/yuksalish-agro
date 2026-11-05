# Yuksalish Agro Platform (YAP)

Multi-tenant farm management: land, crops, livestock, feed and stock, finance, staff, machinery, sales,
reports, alerts and an AI assistant. The pilot tenant is the Yuksalish Agro farm in Qorovulbozor
(210 ha, 500 Hisori ewes). Requirements are in
`Yuksalish Agro — Ferma boshqaruv platformasi. Texnik topshiriq.md`.

This repository is the web application: a React front end, a Node API and PostgreSQL. Field staff use the
same web app from a phone, including offline. There is no mobile app yet.

## Prerequisites

- Node 22 or newer
- pnpm through Corepack (`corepack enable`). The version is pinned in `package.json`.
- Docker, for PostgreSQL with PostGIS and Redis

## Quick start

```sh
corepack enable
pnpm install
cp .env.example .env
pnpm db:up       # Postgres on 5434, Redis on 6381
pnpm db:reset    # drops and rebuilds the schema, then seeds the pilot farm
pnpm dev         # API on 4000, web on 5173
```

`pnpm install` may report that the build script of `msgpackr-extract` was ignored. That is harmless: it is an
optional add-on with prebuilt binaries.

Open http://localhost:5173 and sign in with a demo login. API docs are at http://localhost:4000/api/docs.

`pnpm db:reset` deletes everything in the development database. It refuses to run in production.

## Demo logins

The password for every demo user is `Yuksalish2026!`.

| Role | Phone | Name |
| --- | --- | --- |
| Owner | +998900000001 | Anvar Egamov |
| Director | +998900000002 | Bahodir Rahimov |
| Accountant | +998900000003 | Nodira Karimova |
| Agronomist | +998900000004 | Sardor Toshev |
| Zootechnician | +998900000005 | Jasur Ergashev |
| Veterinarian | +998900000006 | Dilshod Olimov |
| Storekeeper | +998900000007 | Rustam Sobirov |
| Mechanic | +998900000008 | Akmal Qodirov |
| Shepherd | +998900000009 | Sherzod Boboyev |
| Investor | +998900000010 | Investor Demo |
| Auditor | +998900000011 | Auditor Demo |
| Platform admin | +998900000000 | Platform Admin |

Sign-in is limited to 10 attempts a minute per address. The demo data has 2FA enforcement switched off so
that these logins work without an authenticator app. New tenants have it on, as the specification requires
for owners, directors and accountants.

## Project layout

```
apps/api/             Fastify API
  src/core/           kernel: request context, routes(), stock posting, money posting, cost centers
  src/db/schema/      Drizzle schema, one file per domain
  src/db/post-schema.sql   row-level security, audit triggers, grants, tenant foreign keys
  src/modules/        one folder per module
  src/seed/           pilot tenant data
  drizzle/            committed migrations for production
  test/               API tests, run against a real Postgres
apps/web/             React front end
  src/components/     UI kit and shared composites
  src/features/       one folder per module
  public/             service worker and manifest for offline use
packages/shared/      formulas, permissions, enums, dates, translations
infra/                Postgres image, nginx config, backup and restore scripts
docs/                 architecture, data model, API, deployment, user guides
```

Read `CLAUDE.md` before changing code. It holds the rules the code depends on, such as who may see money and
why stock and money only change through the kernel.

## Common commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | API and web together |
| `pnpm typecheck` | Type check all packages |
| `pnpm test` | All tests |
| `pnpm --filter @yap/api exec vitest run test/finance.test.ts` | One API test file |
| `pnpm db:up` / `pnpm db:down` | Start or stop Postgres and Redis |
| `pnpm db:reset` | Rebuild and reseed the development database |
| `pnpm db:generate` | Create a migration after a schema change |
| `pnpm db:migrate` | Apply committed migrations, as production does. A database built with `db:setup` has no history: see [Deployment](docs/deployment.md#a-database-built-with-pnpm-dbsetup) |
| `pnpm --filter @yap/api exec tsx src/db/erd.ts` | Regenerate `docs/erd.md` |

API tests create a uniquely named database for each run and drop it afterwards, so they need Postgres up but
never touch your development data.

After changing `apps/api/src/db/schema`, run `pnpm db:generate` and commit the new file in `apps/api/drizzle`.

To try cameras without hardware, see [infra/camera-sim](infra/camera-sim/README.md).

## Environment variables

Development values are in `.env.example`. Production values are in `infra/env.production.example`.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | API connection. Must be the `yap_app` role, which row-level security applies to. |
| `DATABASE_OWNER_URL` | Owner role, for schema changes and seeding only. Must be a superuser or have BYPASSRLS. |
| `AI_DATABASE_URL` | Read-only `yap_ai` role. Set it in production: the default uses the development password. |
| `REDIS_URL` | Background job queue. |
| `API_PORT` | API port. |
| `WEB_ORIGIN` | Browser origin allowed by CORS. |
| `JWT_SECRET` | Signs tokens and derives the key for stored 2FA secrets. Required in production. |
| `ACCESS_TOKEN_TTL_MIN`, `REFRESH_TOKEN_TTL_DAYS` | Session lifetimes. |
| `BCRYPT_ROUNDS` | Password hashing cost. |
| `STORAGE_DRIVER`, `STORAGE_DIR` | `local` keeps uploads on disk; `s3` uses the settings below. |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | Any S3-compatible store. |
| `TELEGRAM_BOT_TOKEN` | Optional. Without it, messages go to the API log. |
| `LEADS_TELEGRAM_CHAT_ID` | Optional. Telegram chat told about each new enquiry from the website. Needs the bot token. |
| `GEMINI_API_KEY` | Optional, enables the AI assistant. Must come from a billing-enabled Google project: on the free tier Google may use prompts to improve its products. Prove it works with `pnpm --filter @yap/api ai:check`. |
| `GEMINI_PAID_TIER` | Set to `true` once the key is on a paid project. Production refuses Gemini without it. |
| `ANTHROPIC_API_KEY` | Optional alternative to Gemini. With neither key, the assistant says it is not configured; statistical insights still run. |
| `AI_PROVIDER` | `gemini` or `claude`. Only needed when both keys are set; Gemini is the default. |
| `AI_MODEL`, `AI_THINKING_BUDGET`, `AI_EFFORT`, `AI_CHAT_PER_MINUTE`, `AI_CHAT_PER_DAY` | Optional AI tuning. `AI_THINKING_BUDGET` is Gemini only, `AI_EFFORT` Claude only. |
| `JOBS_ENABLED` | Set to `false` to run the API without background jobs. |
| `PLATFORM_ADMIN_PHONE`, `PLATFORM_ADMIN_PASSWORD` | Read by the migrate step: create the first platform admin. |
| `SEED_PASSWORD` | Password for the demo users. Set it for any seed on a server others can reach: see [Deployment](docs/deployment.md#demo-data-on-a-server). |

## Not built yet

- Mobile app. Offline work is done through the web app instead.
- Live camera video. Cameras can be registered and can send events, but there is no stream gateway.
- Camera AI, IoT sensors beyond the events API, and GPS trackers.
- Speaking to the assistant in the web app. Voice notes work in Telegram.
- Real connections to Keeping, Didox, banks and state systems. Keeping is a CSV export whose account
  mapping is an assumption and has not been checked against Keeping.
- Push, SMS and email notifications. Those channels are stubs reported as not configured.
- Camera barcode scanning. Tags and barcodes are typed.
- OAuth 2.0. Users have JWT sessions and machines have API keys.
- AI herd growth forecast and market price monitoring.
- Forced password change for one-time passwords, payslip PDFs, and Excel for the full tenant export, which
  is JSON and CSV. The main lists do export to Excel.

## Not yet tested for real

- Telegram: a real bot delivered a daily summary and an urgent alert on 2026-11-04 (see
  [the acceptance record](docs/acceptance.md)). Scheduled delivery has not yet run unattended, and the
  assistant in the bot, with its cards, voice notes and receipts, has only run against a mocked API.
- The AI assistant's automated tests use a scripted model. `ai:check` and `ai:eval` use the real one, and no
  score from them is recorded here.
- Offline mode has run in headless Chromium, not on a real phone, and not on Safari or iOS.

## Documentation

- [Architecture](docs/architecture.md)
- [Data model](docs/erd.md)
- [API](docs/api.md), with the interactive reference at `/api/docs`
- [Conversational assistant](docs/assistant.md)
- [Deployment](docs/deployment.md)
- [Acceptance record](docs/acceptance.md)
- [Cross-module contracts](docs/contracts.md)
- [Device events](docs/device-events.md)
- User guides: [o'zbekcha](docs/user-guide.uz.md), [русский](docs/user-guide.ru.md)
