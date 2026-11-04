# Deployment

This describes one server running the Docker Compose stack in `docker-compose.prod.yml`.

## Where it must run

Personal data must be stored on servers in Uzbekistan, under the law on personal data (spec 20.1). Choose
the server, the object store and the backup location accordingly. The AI assistant sends the data a question
needs to the Anthropic API, which is outside the country: review this before setting `ANTHROPIC_API_KEY`.

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
| `ANTHROPIC_API_KEY` | AI assistant and document reading | Statistical insights run without it. |
| `STORAGE_DRIVER=s3` with `S3_*` | Files in an S3-compatible store | With `local`, files live in the `files` volume. |

Telegram and the AI assistant have only been tested against mocks. Check each one on staging with real
credentials before relying on it.

## First deploy

```sh
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f docker-compose.prod.yml --env-file .env.production ps
docker compose -f docker-compose.prod.yml --env-file .env.production logs migrate
```

Then sign in as the platform admin and create the tenant with its first owner under Platform.

## TLS

TLS must terminate in front of the `web` container. The refresh cookie is marked `Secure` in production, so
over plain HTTP a session cannot be renewed and people are signed out when the access token expires. Service
workers also need HTTPS.

Put any TLS proxy on the host and forward to `127.0.0.1:${WEB_PORT}`, sending these headers:

```nginx
proxy_set_header Host $host;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Forwarded-Proto https;
client_max_body_size 16m;
```

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

## Known limits

- One API instance. Background jobs and the Telegram poller run inside it, and the sign-in rate limit is kept
  in memory.
- The API image runs TypeScript through `tsx`, because `@yap/shared` ships as source.
