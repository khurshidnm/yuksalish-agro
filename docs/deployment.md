# Deployment

This describes one server running the Docker Compose stack in `docker-compose.prod.yml`.

## Where it must run

Personal data must be stored on servers in Uzbekistan, under the law on personal data (spec 20.1). Choose
the server, the object store and the backup location accordingly. The AI assistant sends the data a question
needs to the chosen AI provider (Google or Anthropic), which is outside the country: review this before
setting `GEMINI_API_KEY` or `ANTHROPIC_API_KEY`.

## Server

Pilot sizing from spec 21.1:

| Component | Size |
| --- | --- |
| Application | 8 vCPU, 16 GB RAM |
| Database | 4 vCPU, 16 GB RAM, 500 GB SSD |
| Object storage | 1 TB |

The Compose stack puts both on one host, so size that host for both or move Postgres out. Install Docker
Engine with the Compose plugin, and clone the repository, for example to `/opt/yap`.

## The stack

| Service | Role |
| --- | --- |
| `db` | PostgreSQL 17 with PostGIS. Creates `yap_app` and `yap_ai` on first start. |
| `redis` | Background job queue, password protected. |
| `migrate` | One-shot: applies migrations and security rules, then exits. |
| `api` | Runs as the non-root `node` user. Starts only after `migrate` succeeds. |
| `web` | nginx, non-root. Serves the app and proxies `/api`. |

Only `web` is published, on `127.0.0.1:${WEB_PORT}`. Nothing else is reachable from outside Docker.

## Configuration

```sh
cp infra/env.production.example .env.production
chmod 600 .env.production
openssl rand -hex 32    # once for each secret
```

Fill in `POSTGRES_PASSWORD`, `YAP_APP_PASSWORD`, `YAP_AI_PASSWORD`, `REDIS_PASSWORD`, `JWT_SECRET` and
`WEB_ORIGIN`. Compose refuses to start without them. Use hex secrets: the database and Redis passwords go
inside connection URLs, where other characters would need escaping.

`YAP_APP_PASSWORD` and `YAP_AI_PASSWORD` are applied only when the database volume is first created. The
passwords in `infra/postgres/init/01-roles.sql` are for development and are not used by this stack.

On the first deploy, also set `PLATFORM_ADMIN_PHONE` and `PLATFORM_ADMIN_PASSWORD` (12 characters or more).
The demo seed refuses to run in production, so this is how the first account is created. An existing user is
never changed, so you can remove both values after the first start.

### Optional integrations

| Setting | Effect | Note |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Daily summary, urgent alerts, bot commands | Run one API instance only: two `getUpdates` pollers conflict. |
| `LEADS_TELEGRAM_CHAT_ID` | Tells a Telegram chat about each new enquiry from the website | Needs the bot token. Enquiries reach `/platform/leads` either way. |
| `GEMINI_API_KEY` | AI assistant and document reading | Must be from a billing-enabled Google project. On the free tier Google may use prompts and answers to improve its products and reviewers may read them, which spec 15.2 forbids. Statistical insights run without it. |
| `GEMINI_PAID_TIER` | Confirms the key above is on a paid project | Must be `true`, or production refuses to use Gemini. Google offers no way to detect the tier from a key. |
| `ANTHROPIC_API_KEY` | Alternative to Gemini | Set `AI_PROVIDER` if both keys are present. |
| `AI_PROVIDER` | `gemini` or `claude` | Only needed when both keys are set. Gemini is the default. |
| `AI_MODEL`, `AI_THINKING_BUDGET`, `AI_EFFORT`, `AI_CHAT_PER_MINUTE`, `AI_CHAT_PER_DAY` | Optional AI tuning | Empty keeps the defaults, including 10 questions a minute and 200 a day per person. `AI_THINKING_BUDGET` is Gemini only, `AI_EFFORT` Claude only. |
| `STORAGE_DRIVER=s3` with `S3_*` | Files in an S3-compatible store | With `local`, files live in the `files` volume. |

A real bot has delivered a daily summary and an urgent alert ([acceptance record](acceptance.md), criterion 8).
Scheduled delivery has not yet run unattended. The assistant has only been tested with a scripted model and,
in Telegram, a mocked API, and no score from `ai:eval` is recorded. Check both on staging with real
credentials before relying on them.

## First deploy

```sh
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f docker-compose.prod.yml --env-file .env.production ps
docker compose -f docker-compose.prod.yml --env-file .env.production logs migrate
```

Then sign in as the platform admin and create the tenant with its first owner under Platform.

A new farm has no accounts. Add its cash and bank accounts under Finance before anyone records money, by hand
or through the assistant: a record has nowhere to go until one exists.

## TLS

TLS must terminate in front of the `web` container. The refresh cookie is marked `Secure` in production, so
over plain HTTP a session cannot be renewed and people are signed out when the access token expires. Service
workers also need HTTPS.

Put any TLS proxy on the host and forward to `127.0.0.1:${WEB_PORT}`:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
    proxy_buffering off;
    proxy_read_timeout 600s;
    client_max_body_size 16m;
}
```

The last settings are for the assistant, and any other proxy needs the same two things. Its answer streams, so
responses must not be buffered: the web container's nginx removes `X-Accel-Buffering`, so an outer proxy never
sees that request. And one model call can take 3 attempts of 120 s with nothing sent meanwhile, so the read
timeout must be longer than that. A proxy that cuts it first hands a turn that is still working back to the
person to send again, which can draft a second card. `infra/nginx.conf` allows the same 600 s under
`/api/v1/ai/`, and 120 s for the rest of the API.

`infra/nginx.conf` trusts `X-Forwarded-For` only from loopback and Docker's private range. Set `WEB_ORIGIN` to
the public HTTPS address.

## Updates and migrations

```sh
git pull
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

`migrate` runs before the API on every deploy. It applies new files from `apps/api/drizzle`, then re-applies
`post-schema.sql`, which is safe to repeat and covers any new table with row-level security, audit and grants.

Take a backup before a deploy that includes a new migration. Do not edit a migration that has shipped.

`migrate` connects as the owner role, `yap`, which is a superuser in this stack. If Postgres moves elsewhere, the
owner must be a superuser or have BYPASSRLS. Tables force row-level security even on their owner, so a migration
that changes data finds no rows under any other role, changes nothing and still reports success.

`web` is not restarted when only the API changes. nginx asks Docker's DNS for the API's address every few
seconds, so `/api` comes back by itself within about 10 seconds of the new API starting. After changing
`infra/nginx.conf`, test it before it replaces the running container:

```sh
docker compose -f docker-compose.prod.yml --env-file .env.production build web
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm --no-deps web nginx -t
```

### Upgrading a running farm to migrations 0003 and 0004

| Migration | What it does |
| --- | --- |
| `0003_close_cost_centers` | Data only. Closes the cost centers of archived herds and written-off machines, so they can no longer be chosen. Each change is in the audit log. |
| `0004_assistant_hardening` | Adds `idempotency_keys.user_id` and `users.telegram_membership_id`, and drops `ai_proposals.needs_duplicate_confirmation`. |

0003 needs the owner role. Under `yap_app`, or an owner without BYPASSRLS, it reports `UPDATE 0` and looks like a
success. The `migrate` service already connects correctly; this matters if you run it by hand.

Choose a quiet hour, and ask field staff to open the app with a connection until nothing waits on `/today/sync`.
Then:

```sh
cd /opt/yap
BACKUP_PASSPHRASE_FILE=/etc/yap/backup.key infra/backup.sh db
git pull
docker compose -f docker-compose.prod.yml --env-file .env.production build
docker compose -f docker-compose.prod.yml --env-file .env.production stop -t 30 api
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
docker compose -f docker-compose.prod.yml --env-file .env.production logs migrate
```

The API stops first because 0004 drops a column the old code reads. The `-t 30` gives the old container the
time its Telegram shutdown needs: it was created before `stop_grace_period` was set.

`migrate` should end with `Row-level security, audit triggers and grants applied.` Then check the result:

```sh
docker compose -f docker-compose.prod.yml --env-file .env.production exec -T db psql -U yap -d yap <<'SQL'
select count(*) as migrations from drizzle.__drizzle_migrations;
select count(*) as still_open from cost_centers cc
  left join herds h on cc.type = 'herd' and h.id = cc.ref_id
  left join assets a on cc.type = 'asset' and a.id = cc.ref_id
  where cc.active and (h.status = 'archived' or a.status = 'written_off');
SQL
```

`migrations` is the number of `.sql` files in `apps/api/drizzle`, and `still_open` is 0. If `still_open` is not
0, 0003 ran under a role that row-level security applies to. It is safe to repeat as `yap`:

```sh
docker compose -f docker-compose.prod.yml --env-file .env.production exec -T db psql -U yap -d yap -v ON_ERROR_STOP=1 -1 -f - < apps/api/drizzle/0003_close_cost_centers.sql
```

What people may notice afterwards:

- **Telegram:** someone on one farm carries on as before. Someone on several farms is asked once, with buttons,
  which farm to work on before the assistant answers. Alerts do not change.
- **Phones:** a post saved before the upgrade whose answer never reached the phone is refused with
  `IDEMPOTENCY_KEY_REUSED` instead of being answered again, because old keys have no owner. It is not counted
  twice, but `/today/sync` shows it as failed although the record is saved. Find the record, then delete the
  item from the queue.
- **Open cards** stay open. Their duplicate check now runs live, when shown and at confirm.

There is no step back from 0004 by redeploying: the old code needs the dropped column. To go back, restore the
backup taken above and deploy the older commit.

### A database built with `pnpm db:setup`

`pnpm db:setup` and `pnpm db:reset` create the schema directly and record no migration history. To check, run
`select count(*) from drizzle.__drizzle_migrations` as the owner: on such a database the table does not exist.
`migrate` and `pnpm db:migrate` then try to create every table again and stop at
`relation "api_keys" already exists`. Nothing changes, but in the production stack `api` does not start.

Back up first and stop the API, then apply each migration the database does not have yet by hand, in order, as
the owner. These lines are for the development stack; for production, add the flags used above.

```sh
docker compose exec -T db psql -U yap -d yap -v ON_ERROR_STOP=1 -1 -f - < apps/api/drizzle/0003_close_cost_centers.sql
docker compose exec -T db psql -U yap -d yap -v ON_ERROR_STOP=1 -1 -f - < apps/api/drizzle/0004_assistant_hardening.sql
docker compose exec -T db psql -U yap -d yap -v ON_ERROR_STOP=1 < apps/api/src/db/post-schema.sql
```

If 0004 stops at `column "user_id" of relation "idempotency_keys" already exists`, nothing was changed: that
database was built from a newer schema. Compare it with the file before going on.

Then record the history, so that later deploys can use `migrate`. The number is the `when` of the last entry
applied, from `apps/api/drizzle/meta/_journal.json`:

```sh
docker compose exec -T db psql -U yap -d yap -v ON_ERROR_STOP=1 <<'SQL'
CREATE SCHEMA IF NOT EXISTS drizzle;
CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);
INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('baseline', 1793866598422);
SQL
```

## Backups

Spec 20.3: database every 6 hours, files daily, kept 90 days. Spec 20.1 requires backups to be encrypted, so
`infra/backup.sh` refuses to run without a passphrase file.

```sh
openssl rand -hex 32 > /etc/yap/backup.key
chmod 600 /etc/yap/backup.key
```

Keep a copy of that key away from the server. Without it, every backup is unreadable.

Crontab of a user allowed to run Docker:

```cron
0 */6 * * *  cd /opt/yap && BACKUP_PASSPHRASE_FILE=/etc/yap/backup.key infra/backup.sh db
30 2 * * *   cd /opt/yap && BACKUP_PASSPHRASE_FILE=/etc/yap/backup.key infra/backup.sh files
```

Backups go to `/var/backups/yap`, or `BACKUP_DIR`. Older ones are deleted after `RETENTION_DAYS` (90).

Copy them to another machine, in Uzbekistan. A backup on the same disk does not survive losing that disk, and
the targets below depend on it. If `STORAGE_DRIVER=s3`, use the object store's own versioning or replication:
`backup.sh files` covers only the local volume.

## Restore

Targets from spec 20.3: restore within 4 hours (RTO), and lose at most 6 hours of data (RPO), which follows
from the 6-hour schedule.

Check a backup without touching live data. This restores into a separate database:

```sh
BACKUP_PASSPHRASE_FILE=/etc/yap/backup.key RESTORE_DB=yap_drill infra/restore.sh db /var/backups/yap/yap-db-XXXX.dump.enc
```

Restore over the live database. This stops `api` and `web`, restores, and starts them again:

```sh
BACKUP_PASSPHRASE_FILE=/etc/yap/backup.key RESTORE_CONFIRM=yes infra/restore.sh db /var/backups/yap/yap-db-XXXX.dump.enc
BACKUP_PASSPHRASE_FILE=/etc/yap/backup.key infra/restore.sh files /var/backups/yap/yap-files-XXXX.tar.gz.enc
```

On a new server, start `db` first so that it creates the roles, with the same passwords as before, then
restore, then bring up the rest:

```sh
docker compose -f docker-compose.prod.yml --env-file .env.production up -d db redis
```

Run a restore drill regularly, and time it against the 4-hour target.

## Monitoring

`GET /api/health` checks the database, and `GET /healthz` on the web container checks nginx. Container health
is visible in `docker compose ps`. The spec's Prometheus and Grafana monitoring (20.3) is not part of this
stack yet, so point an external uptime check at `/api/health` meanwhile.

## Logs

`docker compose logs api` and `logs web`. Request lines hold the path without its query string, which can carry
a searched name or phone, or the token of a file link. Errors hold the database driver's error, not the query or
what the person typed (`LOG_SERIALIZERS` in `apps/api/src/app.ts`). nginx's error log is the one exception: when
the proxy itself fails a request, for example during a deploy, that line shows the full address.

## Known limits

- One API instance. Background jobs and the Telegram poller run inside it, and the sign-in rate limit is kept
  in memory.
- The API image runs TypeScript through `tsx`, because `@yap/shared` ships as source.

## Public website and leads

`/`, `/ru`, `/en` and `/uz-cyrl` are prerendered at build time into `dist/landing/`, so search engines read
real HTML. nginx serves those files; every other address is the app. A browser with a session is sent
from the public page to `/app`, and the installed app starts there too.

Before the first public release:

1. Set `VITE_SITE_URL`, `VITE_CONTACT_PHONE` and `VITE_CONTACT_TELEGRAM`, then rebuild the web image. They
   are baked into the pages, so a change needs a rebuild, not a restart.
2. Check the result: `/sitemap.xml` exists, and `/` contains a `rel="canonical"` link.
3. Submit `/sitemap.xml` to Google Search Console and Yandex Webmaster.
4. Set `LEADS_TELEGRAM_CHAT_ID` to hear about new enquiries straight away. They appear in the admin panel
   at `/platform/leads` either way.

Enquiries hold personal data, so keep them on the server in Uzbekistan with the rest of the database, and
add a privacy notice with your legal details before collecting them at scale.
