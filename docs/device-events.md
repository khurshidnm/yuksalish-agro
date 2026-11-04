# Device events and webhooks

Written for: integrators connecting cameras, sensors, RFID readers and scales to YAP, and anyone
consuming YAP webhooks.

Devices send events to one API (spec 16.4). Video is processed at the farm, and only events and
short clips go to the cloud. The platform stores events in the journal, shows them on the Cameras
page, and raises an alert for urgent ones.

## Setup

1. Register the device under **Cameras** (or `POST /api/v1/devices`). Note its `id`.
2. Create a key under **Settings → API keys** with the scope `events:write`. The key is shown once.
3. Optional: bind the device to that key with `apiKeyId`. The device then accepts no other key.

Each key belongs to one farm. A key can only report for devices on that farm; any other `deviceId`
gets a 404.

## Sending an event

```http
POST /api/v1/devices/events
X-Api-Key: yap_...
Content-Type: application/json

{
  "deviceId": "0190a7e2-7b1c-7c3d-8e4f-1234567890ab",
  "type": "trough_empty",
  "occurredAt": "2026-11-04T06:15:00+05:00",
  "severity": "attention",
  "data": { "section": 2, "confidence": 0.93 },
  "snapshotUrl": "https://nvr.example.uz/snapshots/1.jpg"
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `deviceId` | yes | The registered device |
| `type` | yes | Lower case letters, digits, `_`, `.`, `-`. Types without a dot get the prefix `camera.` or `sensor.` |
| `occurredAt` | no | ISO 8601 with offset. Defaults to the time of receipt. More than one day ahead is refused, so a wrong clock cannot pollute reports |
| `severity` | no | `info` (default), `attention` or `urgent` |
| `data` | no | Any JSON object, stored as sent |
| `snapshotUrl` | no | `http` or `https` address of a frame the viewer's browser can reach |

Replies are `{ "data": { "accepted": true } }`, or an error of the form
`{ "error": { "code": "...", "message": "..." } }`.

| Status | Code | Cause |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | A field is malformed |
| 400 | `INVALID_EVENT_TIME` | `occurredAt` is too far in the future |
| 401 | `API_KEY_REQUIRED`, `INVALID_API_KEY` | Key missing, wrong or revoked |
| 403 | `INSUFFICIENT_SCOPE` | The key lacks `events:write` |
| 403 | `DEVICE_KEY_MISMATCH` | The device is bound to a different key |
| 403 | `TENANT_SUSPENDED` | The workspace is suspended |
| 404 | `NOT_FOUND` | No such device on this key's farm |

An event marks its device `online`. An `urgent` event also raises an alert. There is one alert per
device and event type while it stays open, so a burst of frames does not page anyone twice.

### Buffered events

After an outage, send up to 100 events at once:

```http
POST /api/v1/devices/events/batch
{ "events": [ { ... }, { ... } ] }
```

The reply lists the failures, and the good events are kept:

```json
{ "data": { "accepted": 98, "rejected": [ { "index": 4, "code": "DEVICE_NOT_FOUND" } ] } }
```

### Heartbeat

Send this at least every few minutes when nothing else is happening:

```http
POST /api/v1/devices/heartbeat
{ "deviceId": "0190a7e2-7b1c-7c3d-8e4f-1234567890ab" }
```

A device silent for longer than its limit (default 10 minutes, `offlineAfterMinutes` per device) is
marked `offline` and raises an alert. The next signal clears both.

## Standard event types

Use these names so that titles appear properly in the interface (spec 16.3).

| Type | Meaning | Suggested severity |
| --- | --- | --- |
| `animal_count` | Count in a barn section differs from the registry | `attention` |
| `inactivity` | An animal lying still for a long time | `attention` |
| `isolation` | An animal apart from the flock | `attention` |
| `lambing_activity` | Signs of lambing at night | `urgent` |
| `trough_empty` | Feed trough is empty | `attention` |
| `person` | Person outside working hours | `urgent` |
| `vehicle` | Unknown vehicle | `attention` |
| `gate_open` | Gate opened | `info` |
| `smoke`, `fire` | Smoke or fire in the barn or store | `urgent` |
| `temperature`, `humidity`, `ammonia`, `water_level` | Sensor readings, values in `data` | `info` |

## Frigate

[Frigate](https://frigate.video) publishes detections to MQTT on `frigate/events`, not through
webhooks, so a small bridge is needed on the edge device. Map each message like this:

| Frigate field | YAP field |
| --- | --- |
| `after.camera` | `deviceId`, through a table you keep in the bridge |
| `after.label` | `type`: `person` → `person`, `car` or `truck` → `vehicle` |
| `after.start_time` (Unix seconds) | `occurredAt`, converted to ISO 8601 |
| `after.top_score`, `after.entered_zones` | `data` |
| `after.id` | `snapshotUrl`: `<frigate-url>/api/events/<id>/snapshot.jpg` when `after.has_snapshot` is true |

Handle only `"type": "new"`, or one object produces several events. This example needs the `mqtt`
npm package and Node 18 or later:

```js
import mqtt from 'mqtt';

const YAP = 'https://your-yap-host/api/v1/devices/events';
const KEY = process.env.YAP_API_KEY;
const FRIGATE = 'https://frigate.farm.example';
const DEVICES = { barn_1: '0190a7e2-...', gate: '0190a7e3-...' };
const TYPES = { person: 'person', car: 'vehicle', truck: 'vehicle' };
const SEVERITY = { person: 'urgent', vehicle: 'attention' };

const client = mqtt.connect('mqtt://localhost:1883');
client.on('connect', () => client.subscribe('frigate/events'));

client.on('message', async (_topic, message) => {
  const { type, after } = JSON.parse(message.toString());
  const eventType = TYPES[after.label];
  const deviceId = DEVICES[after.camera];
  if (type !== 'new' || !eventType || !deviceId) return;

  await fetch(YAP, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY },
    body: JSON.stringify({
      deviceId,
      type: eventType,
      severity: SEVERITY[eventType],
      occurredAt: new Date(after.start_time * 1000).toISOString(),
      data: { score: after.top_score, zones: after.entered_zones },
      ...(after.has_snapshot ? { snapshotUrl: `${FRIGATE}/api/events/${after.id}/snapshot.jpg` } : {}),
    }),
  });
});
```

The snapshot address must be reachable from the browser of whoever views the Cameras page. If
Frigate stays on the farm network, leave `snapshotUrl` out.

## Live view

Browsers cannot play RTSP. To show a camera live, run a stream gateway such as
[MediaMTX](https://github.com/bluenviron/mediamtx) or go2rtc at the farm, and put its browser
address in the device's **live view address** (`liveUrl`). HLS (`.m3u8`) and MP4 addresses play in a
video element, where the browser supports them; any other address opens as an embedded page.

Until `liveUrl` is set, the Cameras page says that no gateway is configured.

A user name and password inside `streamUrl` are encrypted and removed from the stored address, so
they never appear in the interface, the audit log or backups in plain text.

## Webhooks (outgoing)

Under **Settings → API keys → Webhooks**, subscribe an `https` address to event types. Patterns are
an exact type (`sale.created`), a prefix (`sale.*`), or everything (`*`). The signing secret is shown
once. A new subscription receives events from that moment on, not the farm's history.

Each delivery is a POST of one event:

```http
POST https://your-host/yap-hook
Content-Type: application/json
User-Agent: YAP-Webhooks/1.0
X-YAP-Event: animal.lambed
X-YAP-Delivery: 0190a7e2-...
X-YAP-Signature: t=1793800000,v1=5f8a...

{ "id": "...", "type": "animal.lambed", "occurredAt": "...", "farmId": "...", "severity": "info",
  "entityType": "animal", "entityId": "...", "data": { } }
```

Verify `v1` before trusting a message, and reject old timestamps to stop replays:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(header, rawBody, secret, maxAgeSeconds = 300) {
  const { t, v1 } = Object.fromEntries(header.split(',').map((part) => part.split('=')));
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const fresh = Math.abs(Date.now() / 1000 - Number(t)) < maxAgeSeconds;
  return fresh && timingSafeEqual(Buffer.from(v1, 'hex'), Buffer.from(expected, 'hex'));
}
```

Answer with any 2xx status within 5 seconds. Redirects are not followed and count as failures.
Failed deliveries are retried after 1, 5, 30, 120 and 360 minutes, then marked `failed`. The delivery
log shows every attempt's status and error, and any delivery can be sent again by hand. Events
normally reach subscribers within about a minute and a half, and the same event may arrive twice
after a retry, so use `X-YAP-Delivery` to ignore duplicates.

Addresses must be public: private, loopback and link-local addresses are refused both when saving
and before each send.
