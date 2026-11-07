# Device events and webhooks

Written for: integrators connecting cameras, sensors, RFID readers and scales to YAP, and anyone
consuming YAP webhooks.

Devices send events to one API (spec 16.4). Video is processed at the farm, and only events and
short clips go to the cloud. The platform stores events in the journal, shows them on the Cameras
page, and raises an alert for urgent ones. It detects nothing by itself: a fire is known only once a
device reports it, see [Smoke detectors and relays](#smoke-detectors-and-relays).

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
| `eventId` | no | Your own id for this event, up to 128 characters, the same on every retry. See [Retrying](#retrying) |
| `type` | yes | Lower case letters, digits, `_`, `.`, `-`. Types without a dot get the prefix `camera.` or `sensor.` |
| `occurredAt` | no | ISO 8601 with offset. Defaults to the time of receipt. More than one day ahead is refused, so a wrong clock cannot pollute reports |
| `severity` | no | `info` (default), `attention` or `urgent`. Events of type `fire` and `smoke` are always `urgent`, whatever is sent here |
| `data` | no | Any JSON object, stored as sent |
| `snapshotUrl` | no | `http` or `https` address of a JPEG, PNG or WebP frame, at a public address the server can reach |

Replies are `{ "data": { "accepted": true } }`, or an error of the form
`{ "error": { "code": "...", "message": "..." } }`. **Only a 2xx reply means the event is stored.**

| Status | Code | Cause | What to do |
| --- | --- | --- | --- |
| 400 | `VALIDATION_ERROR` | A field is malformed | Drop it and log it |
| 400 | `INVALID_EVENT_TIME` | `occurredAt` is too far in the future | Drop it and fix the device clock |
| 401 | `API_KEY_REQUIRED`, `INVALID_API_KEY` | Key missing, wrong or revoked | Keep it, and fix the key |
| 403 | `INSUFFICIENT_SCOPE` | The key lacks `events:write` | Keep it, and fix the key |
| 403 | `DEVICE_KEY_MISMATCH` | The device is bound to a different key | Keep it, and fix the key |
| 403 | `TENANT_SUSPENDED` | The workspace is suspended | Keep it |
| 404 | `NOT_FOUND` | No such device on this key's farm | Drop it and fix the bridge's table |
| 413 | | The body is too large: 64 KB for one event, 1 MB for a batch | Send fewer at a time |
| 429 | `RATE_LIMITED` | Too many requests | Keep it, and retry after `Retry-After` |
| 5xx | any | The server is restarting, or a part of it is down | Keep it, and retry with backoff |
| none | | No answer: a timeout, or no network | Keep it, and retry with backoff |

An event marks its device `online`. An `urgent` event also raises an alert, and it repeats until
someone acknowledges it, day and night, in the app or with the button on the Telegram message. So
keep `urgent` for what cannot wait for morning. There is one alert per device and event type while it
stays open, so a burst of frames does not page anyone twice.

### Retrying

The API refuses honestly during an outage, so nothing it acknowledged is lost. An event it refused,
though, exists only on your side: **a fire frame the server never stored raises no alert and sends no
message.** So a device or bridge must keep each event on disk until it gets a 2xx, and send it again.
An update of the server alone means about two seconds of 502, and a real outage can last hours.

Sending again is safe. The reply can be lost after the event was stored, so the server treats a repeat
as the same event: it stores it once, raises no second alert, and answers `"duplicate": true`. A repeat
is the same `eventId` from the same device. Without an `eventId` it is the same `type` and `occurredAt`,
so always send one of these. An event with neither cannot be told from a new one.

An urgent event that arrives more than five minutes after its `occurredAt` still raises the alert, and
the message says when it really happened.

### Buffered events

After an outage, send up to 100 events at once:

```http
POST /api/v1/devices/events/batch
{ "events": [ { ... }, { ... } ] }
```

The reply counts the repeats and lists the failures, and everything else is stored. A malformed event
is reported here too, so it cannot hold the rest back:

```json
{ "data": { "accepted": 98, "duplicates": 3, "rejected": [ { "index": 4, "code": "DEVICE_NOT_FOUND" } ] } }
```

`accepted` includes the repeats. Everything in the batch is settled by a 2xx: nothing is gained by
sending a rejected event again.

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
| `person` | Person on the farm | `urgent` outside working hours, otherwise `info` |
| `vehicle` | Unknown vehicle | `attention` |
| `gate_open` | Gate opened | `info` |
| `smoke`, `fire` | Smoke or fire in the barn or store | Always `urgent`: the server does not read `severity` for these |
| `temperature`, `humidity`, `ammonia`, `water_level` | Sensor readings, values in `data` | `info` |

## Frigate

[Frigate](https://frigate.video) publishes detections to MQTT on `frigate/events`, not through
webhooks, so a small bridge is needed on the edge device. Map each message like this:

| Frigate field | YAP field |
| --- | --- |
| `after.camera` | `deviceId`, through a table you keep in the bridge |
| `after.label` | `type`: `person` → `person`, `car` or `truck` → `vehicle` |
| `after.start_time` (Unix seconds) | `occurredAt`, converted to ISO 8601, and `severity`: a person is `urgent` only outside working hours (spec 16.3) |
| `after.top_score`, `after.entered_zones` | `data` |
| `after.id` | `snapshotUrl`: `<frigate-url>/api/events/<id>/snapshot.jpg` when `after.has_snapshot` is true |

Handle only `"type": "new"`, or one object produces several events.

The bridge has two parts. The first keeps every event on disk until the server has accepted it, and
works for any device. Save it as `outbox.mjs`. It needs Node 18 or later and nothing else:

```js
// outbox.mjs
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const BATCH_URL = `${process.env.YAP_URL}/api/v1/devices/events/batch`;
const KEY = process.env.YAP_API_KEY;
const DIR = process.env.YAP_OUTBOX ?? './outbox';
const MAX_BATCH = 100;
const FIRST_WAIT_MS = 1_000;
const LONGEST_WAIT_MS = 60_000;

await mkdir(DIR, { recursive: true });

const waiting = async () => (await readdir(DIR)).filter((name) => name.endsWith('.json')).sort();

/**
 * On disk first, under its final name in one step: a power cut leaves the whole event or none of it.
 * Its id and time are set now, so that a retry is the same event and a late one still says when it happened.
 */
export async function enqueue(event) {
  const name = `${Date.now()}-${randomUUID()}.json`;
  const stamped = { eventId: randomUUID(), occurredAt: new Date().toISOString(), ...event };
  await writeFile(join(DIR, `${name}.part`), JSON.stringify(stamped));
  await rename(join(DIR, `${name}.part`), join(DIR, name));
  void flush();
}

async function send(names) {
  const events = await Promise.all(names.map(async (name) => JSON.parse(await readFile(join(DIR, name), 'utf8'))));
  return fetch(BATCH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY },
    body: JSON.stringify({ events }),
    signal: AbortSignal.timeout(30_000),
  });
}

const forget = (names) => Promise.all(names.map((name) => unlink(join(DIR, name))));

/** 408, 429 and the key problems can pass. Any other 4xx means this body will never be accepted. */
const hopeless = (status) => status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status);

let flushing = false;

/** Oldest first until nothing is left. Whatever goes wrong, the events stay on disk for the next try. */
export async function flush() {
  if (flushing) return;
  flushing = true;
  let batch = MAX_BATCH;
  let wait = FIRST_WAIT_MS;
  try {
    for (;;) {
      const names = (await waiting()).slice(0, batch);
      if (names.length === 0) return;
      let retryAfterMs = 0;
      try {
        const response = await send(names);
        if (response.ok) {
          const { data } = await response.json();
          for (const { index, code } of data.rejected) console.error(`YAP refused ${names[index]}: ${code}`);
          await forget(names);
          batch = MAX_BATCH;
          wait = FIRST_WAIT_MS;
          continue;
        }
        if (hopeless(response.status)) {
          if (names.length === 1) {
            console.error(`YAP will never take ${names[0]}: ${response.status}`);
            await forget(names);
          }
          batch = Math.ceil(names.length / 2);
          continue;
        }
        console.warn(`YAP answered ${response.status}, trying again`);
        retryAfterMs = Number(response.headers.get('retry-after')) * 1000 || 0;
      } catch (error) {
        console.warn(`YAP did not answer, trying again: ${error.message}`);
      }
      await sleep(Math.max(retryAfterMs, wait * (0.5 + Math.random())));
      wait = Math.min(wait * 2, LONGEST_WAIT_MS);
    }
  } finally {
    flushing = false;
  }
}
```

Keep the `outbox` folder on a disk that survives a restart, and start `flush()` when the bridge starts,
so that what a power cut left behind goes out first. Events are small, but with nothing being accepted
the folder grows until the server is back, so check it now and then.

The second part reads Frigate and hands each detection to the outbox. It needs the `mqtt` npm package.
Frigate's own id is the `eventId`, so a message repeated by MQTT is one event too:

```js
import mqtt from 'mqtt';
import { enqueue, flush } from './outbox.mjs';

const FRIGATE = 'https://frigate.farm.example';
const DEVICES = { barn_1: '0190a7e2-...', gate: '0190a7e3-...' };
const TYPES = { person: 'person', car: 'vehicle', truck: 'vehicle' };

// By the farm's clock, whatever the clock of this computer says. Set them to the farm's working day.
const WORK_STARTS_AT = 7;
const WORK_ENDS_AT = 19;
const farmHour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: 'numeric', hourCycle: 'h23' });

/** Staff walking past a camera in the day is no alarm. An urgent event repeats until someone acknowledges it. */
function severityOf(eventType, startTime) {
  if (eventType !== 'person') return 'attention';
  const hour = Number(farmHour.format(startTime * 1000));
  return hour >= WORK_STARTS_AT && hour < WORK_ENDS_AT ? 'info' : 'urgent';
}

const client = mqtt.connect('mqtt://localhost:1883');
client.on('connect', () => client.subscribe('frigate/events'));

client.on('message', async (_topic, message) => {
  const { type, after } = JSON.parse(message.toString());
  const eventType = TYPES[after.label];
  const deviceId = DEVICES[after.camera];
  if (type !== 'new' || !eventType || !deviceId) return;

  await enqueue({
    eventId: after.id,
    deviceId,
    type: eventType,
    severity: severityOf(eventType, after.start_time),
    occurredAt: new Date(after.start_time * 1000).toISOString(),
    data: { score: after.top_score, zones: after.entered_zones },
    ...(after.has_snapshot ? { snapshotUrl: `${FRIGATE}/api/events/${after.id}/snapshot.jpg` } : {}),
  });
});

await flush();
setInterval(flush, 30_000);
```

Run it with `YAP_URL=https://your-yap-host YAP_API_KEY=yap_... node bridge.mjs`, and let systemd or Docker
restart it if it stops.

The server fetches the frame when someone opens the event, and shows it from its own address, so the
gateway needs no entry in the page's security policy. It connects only to public addresses and does
not follow redirects, so a frame must come straight from an address like that, within 8 seconds and
under 10 MB, with a valid certificate on `https`. A gateway that only answers on the farm network
still shows as a link, which works from a phone on that network, but no picture appears anywhere else.

## Smoke detectors and relays

**The platform has no fire detection of its own.** It looks at nothing and smells nothing: it only passes
on what a device tells it. A farm with no detector connected has no fire cover from the platform, however
calm the dashboard looks. The bridge above does not change that, because it reports people and vehicles.
A fire alert exists only if a detector on the farm sends one.

To connect one:

1. **Choose a detector that can report.** A battery alarm that only beeps cannot. You need a relay output
   (a dry contact), or a wireless detector that reports over Zigbee or MQTT. Dust and damp set off household
   detectors in a barn, so ask the supplier for a type made for farm buildings.
2. **Keep the siren.** Leave a siren wired to the detector itself, so people nearby hear it with no computer,
   internet or server involved. The path below needs all three.
3. **Put a small computer on the farm next to it,** the edge device if there is one, on a power supply that
   outlasts a cut. A fire that takes the power or the router with it sends nothing.
4. **Register each detector** under **Cameras** with `"type": "sensor"`, and give it a short
   `offlineAfterMinutes`.
5. **Run the bridge below,** then test it as described under it.

The bridge reads each detector from MQTT and hands the moment it goes off to the `outbox.mjs` above, so an
event survives an outage. Zigbee detectors reach MQTT through Zigbee2MQTT, and many relay modules publish
to MQTT themselves. A relay wired straight into the computer needs a few lines that read its pin and call
`enqueue` the same way. Every detector says "alarm" in its own words, so change the two examples:

```js
import mqtt from 'mqtt';
import { enqueue, flush } from './outbox.mjs';

const DETECTORS = {
  'zigbee2mqtt/barn-smoke': { deviceId: '0190a7e4-...', isAlarm: (text) => JSON.parse(text).smoke === true },
  'relays/store-smoke/input': { deviceId: '0190a7e5-...', isAlarm: (text) => text === '1' },
};
const ringing = new Set();

const client = mqtt.connect('mqtt://localhost:1883');
client.on('connect', () => client.subscribe(Object.keys(DETECTORS)));

// A detector repeats its state, so the event is the moment it goes off, not every message after that.
client.on('message', async (topic, message) => {
  const { deviceId, isAlarm } = DETECTORS[topic];
  if (!isAlarm(message.toString())) return void ringing.delete(topic);
  if (ringing.has(topic)) return;
  ringing.add(topic);
  await enqueue({ deviceId, type: 'smoke' });
});

const heartbeat = (deviceId) =>
  fetch(`${process.env.YAP_URL}/api/v1/devices/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.YAP_API_KEY },
    body: JSON.stringify({ deviceId }),
    signal: AbortSignal.timeout(10_000),
  }).catch((error) => console.warn(`Heartbeat not sent: ${error.message}`));

await flush();
setInterval(flush, 30_000);
setInterval(() => Object.values(DETECTORS).forEach(({ deviceId }) => heartbeat(deviceId)), 60_000);
```

Send `smoke` or `fire`, and leave `severity` out: the server makes these two urgent whatever the sender
says. Then the alert goes to the director and the owner, it repeats until someone acknowledges it, and if
nobody responsible can be reached, the next role hears.

The heartbeat tells you the bridge and its network are alive, and an `offline` alert tells you when they
are not. It says nothing about the detector itself: a dead sensor on a working bridge looks like a quiet barn.

**Test it with real smoke.** Put smoke in front of the detector, as its maker describes, and follow it all
the way to a phone: the message arrives, and **Acknowledge** on it stops the repeats. Do this when it is
fitted and again every few months, and until then treat the farm as having no fire cover. The test button on
the **Notifications** page proves only the half from the server to the phone. It never touches a detector.

## Live view

Browsers cannot play RTSP. To show a camera live, run a stream gateway such as
[MediaMTX](https://github.com/bluenviron/mediamtx) or go2rtc at the farm, and put its browser
address in the device's **live view address** (`liveUrl`). HLS (`.m3u8`) and MP4 addresses play in a
video element, where the browser supports them; any other address opens as an embedded page. The
address must use `https`: the app runs on `https`, and a browser refuses to embed `http` in it. An
`http` address shows as a link instead.

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

Addresses must be public: private, loopback and link-local addresses are refused when saving, before
each send, and again by the connection itself, so a name that changes its answer in between gets
nowhere.
