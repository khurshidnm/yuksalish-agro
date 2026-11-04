# API

The full reference is generated from the code: Swagger UI at `/api/docs`, and OpenAPI 3.1 JSON at
`/api/docs/json`. It lists 473 operations. This page covers what applies to all of them.

The examples below were run against a seeded server. `$B` is `http://localhost:4000/api/v1`.

## Responses

```json
{ "data": { "id": "..." } }
```

Lists add paging. Lists accept `page`, `pageSize` (at most 200), `search` and `sort` (`name` or `-name`).

```sh
curl "$B/finance/counterparties?pageSize=2&sort=name" -H "authorization: Bearer $TOKEN"
```

```json
{
  "data": [
    { "id": "01a1a409-b2d0-735d-a3ea-bc1b454e76f4", "name": "Agrobank Qorovulbozor filiali", "type": "bank" },
    { "id": "01a1a409-b5ec-731a-b7d6-5b10b092845d", "name": "Agroservis Buxoro MChJ", "type": "service" }
  ],
  "meta": { "page": 1, "pageSize": 2, "total": 11 }
}
```

The rows above are shortened. JSON is camelCase, dates are `YYYY-MM-DD`, and ids are UUIDv7.

## Errors

`code` is stable, so program against it. `message` is an English fallback.

```json
{ "error": { "code": "FORBIDDEN", "message": "You do not have permission to do this", "details": { "required": ["finance.view"] } } }
```

| Status | Typical codes |
| --- | --- |
| 400 | `VALIDATION_ERROR`, `INVALID_REFERENCE`, `NOTHING_TO_UPDATE` |
| 401 | `UNAUTHORIZED`, `INVALID_TOKEN`, `INVALID_CREDENTIALS`, `ACCOUNT_BLOCKED` |
| 403 | `FORBIDDEN`, `MODULE_DISABLED`, `TWO_FACTOR_ENROLLMENT_REQUIRED` |
| 404 | `NOT_FOUND` |
| 409 | `ALREADY_EXISTS`, `IN_USE`, `INSUFFICIENT_STOCK`, `RETRY` |
| 429 | `RATE_LIMITED` |

Validation names each field:

```sh
curl -X POST "$B/finance/counterparties" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"name":"","type":"nonsense"}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Please check the highlighted fields",
    "details": {
      "fieldErrors": {
        "name": "Too small: expected string to have >=1 characters",
        "type": "Invalid option: expected one of \"buyer\"|\"supplier\"|\"service\"|\"bank\"|\"government\"|\"other\""
      }
    }
  }
}
```

Validation runs before authentication, so a malformed request gets a 400 even without a valid token or key.

## Sign-in

```sh
curl -X POST "$B/auth/login" -H 'content-type: application/json' \
  -d '{"phone":"+998900000001","password":"Yuksalish2026!"}'
```

The response holds `accessToken` (15 minutes) and `session` (`user`, `tenant`, `farm`, `role`, `permissions`,
`memberships`, `mustEnroll2fa`, `settings`). It also sets the `yap_rt` refresh cookie, which is `HttpOnly`,
scoped to `/api/v1/auth`, and rotated on each use. If the user has 2FA on, the response is instead
`{ "twoFactorRequired": true, "challengeToken": "..." }`, followed by `POST /auth/2fa/verify`.

Send the token on every request: `authorization: Bearer $TOKEN`. Without one, the API answers 401.

`POST /auth/refresh` gets a new access token from the cookie. Replaying an old refresh token after a 10-second
grace period signs out every device in that session.

## Idempotency and client ids

A POST with `Idempotency-Key` is applied once. A repeat returns the stored response with the
`idempotent-replay: true` header. Creates also accept a client-generated `id`. The offline outbox relies on both.

```sh
curl -i -X POST "$B/finance/counterparties" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -H 'idempotency-key: 0190a7e2-demo-key' \
  -d '{"id":"0190a7e2-7b1c-7c3d-8e4f-0000000000a1","name":"Oflayn yozuv","type":"buyer"}'
```

Sent twice, both answers are `201 Created` with the same record, and the second carries `idempotent-replay: true`.

## Files

Upload as multipart with the field name `file`. JPEG, PNG, WebP, PDF, CSV and XLSX are accepted, up to 15 MB.

```sh
curl -X POST "$B/files" -H "authorization: Bearer $TOKEN" -F 'file=@photo.png;type=image/png'
```

```json
{ "data": { "id": "...", "name": "photo.png", "mimeType": "image/png", "url": "/api/v1/files/.../content?token=..." } }
```

`url` is a signed link valid for an hour, for `<img>` tags and downloads. `GET /files/:id` returns a fresh one.

## API keys for machines

Create one under Settings or with the API. The key is shown once and stored hashed.

```sh
curl -X POST "$B/settings/api-keys" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"name":"Molxona kamerasi","scopes":["events:write"]}'
```

The response includes `key` (`yap_...`) and `keyPrefix`. Send it as `X-Api-Key`:

```sh
curl -X POST "$B/devices/events" -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"deviceId":"'$DEVICE'","type":"camera.motion","occurredAt":"2026-11-04T01:12:00+05:00","severity":"info","data":{"zone":"gate"}}'
```

```json
{ "data": { "accepted": true } }
```

The event format, batch ingest and heartbeat are in [device-events.md](device-events.md).

## Webhooks

Subscribe a URL to event types. Patterns such as `sale.*` are allowed, and the secret is shown once. The URL must
resolve to a public address.

```sh
curl -X POST "$B/settings/webhooks" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"url":"https://example.com/yap-hook","description":"Sotuv tizimi","eventTypes":["sale.*","animal.lambed"]}'
```

```json
{
  "data": {
    "id": "01a1a418-1ef4-779c-8f93-126f12af41b7",
    "url": "https://example.com/yap-hook",
    "description": "Sotuv tizimi",
    "eventTypes": ["sale.*", "animal.lambed"],
    "active": true,
    "createdAt": "2026-11-04T01:06:46.609Z",
    "secret": "whsec_..."
  }
}
```

Each delivery is a POST with these headers:

| Header | Value |
| --- | --- |
| `x-yap-event` | Event type |
| `x-yap-delivery` | Delivery id, for spotting repeats |
| `x-yap-signature` | `t=<unix seconds>,v1=<hex>` |

To verify, compute HMAC-SHA256 of `<t>.<raw body>` with the secret and compare it to `v1`. Any non-2xx answer is
retried after 1, 5, 30, 120 and 360 minutes, then the delivery is marked failed. The job sends once a minute and
skips events from the last 30 seconds. Delivery history is available from the webhook routes under `/settings`.

## Rate limits

Sign-in, 2FA and password routes allow 10 requests a minute per address. The AI chat has per-user limits, set with
`AI_CHAT_PER_MINUTE` and `AI_CHAT_PER_DAY` (defaults 10 and 200).
