# Animal tracking: collars and boluses

Every sheep can wear a LoRaWAN GPS collar (position and a motion counter) and a rumen bolus (body
temperature). Their readings reach AgroPanel through a LoRaWAN network server. Shepherds then see the flock
on a map, each animal's passport shows its track, temperature and activity, and the vet, zootechnician and
shepherd are told when a sheep strays, stops moving or runs a fever.

Code: `apps/api/src/modules/tracking`, rules in `packages/shared/src/formulas/tracking.ts`, web in
`apps/web/src/features/tracking`. The flock map is at `/livestock/tracking`.

## How readings arrive

```
collar / bolus ──radio──▶ gateway (farm, or portable with 4G) ──▶ network server ──HTTP──▶ AgroPanel
```

One network server serves all gateways, so a sheep that walks from one gateway's range to another's keeps
reporting. ChirpStack (open source, self-hosted) and The Things Stack both work. The network server's codec
(the device profile's payload decoder) turns the radio payload into an object, and AgroPanel reads that.

1. **Register the trackers first.** On the flock map, open **Trackers**, then **Import trackers**, and paste the
   seller's list, one `DevEUI, ear tag` per line. Uplinks from a DevEUI that is not registered are answered 200 and
   listed as `unknown`, but they are not stored.
2. **Create an API key** with the `events:write` scope under **Settings**, then **API keys**. The key belongs to
   one farm.
3. **Point the network server at AgroPanel:**

| Network server | Setting | Value |
| --- | --- | --- |
| ChirpStack v4 | Application, then Integrations, then HTTP | URL `https://<host>/api/v1/tracking/ingest/chirpstack`, payload encoding **JSON**, header `X-Api-Key: <key>` |
| The Things Stack | Application, then Webhooks, then Custom | Base URL `https://<host>/api/v1/tracking/ingest/tts`, uplink message and location solved enabled, additional header `X-Api-Key: <key>` |
| Anything else | Your bridge | `POST /api/v1/tracking/readings` with `{ "readings": [{ "externalId", "recordedAt", "lat", "lng", "activity", "temperatureC", "batteryPct" }] }`, up to 500 at a time |

ChirpStack calls the URL with `?event=up|status|location|join|...`. AgroPanel stores `up`, the battery from
`status` and the position from `location`, and answers 204 to the rest. ChirpStack's default payload encoding is
Protobuf. It must be switched to JSON.

## What is read from the decoded object

Vendors name their fields differently, so the known names are tried in order, at the top level and inside a
`gps`, `gnss`, `location`, `position`, `data` or `payload` object:

| Reading | Names tried |
| --- | --- |
| Position | `latitude`/`lat`/`gpsLatitude`, `longitude`/`lng`/`lon`/`long` |
| Activity | `activity`, `activityCount`, `activityLevel`, `steps`, `stepCount`, `motion`, `motionCount`, `act` |
| Temperature (bolus only) | `bodyTemperature`, `rumenTemperature`, `rumenTemp`, `temperature`, `temp`, `temperatureC` |
| Battery, % | `batteryPct`, `batteryPercent`, `batteryLevel`, `battery_level`, `battery`, `bat` |

A device can point at any other field with `config.fieldMap` on its `devices` row, for example
`{ "temperatureC": "sensors.rumen.t", "batteryPct": "power.pct" }`.

What cannot be right is stored as null, never 0:

- A position of 0,0, or any position when the codec says `fix`, `gnssFix`, `gpsFix` or `valid` is false.
- A collar's or ear tag's "temperature", which is the air, unless `fieldMap` names it.
- A temperature outside 30 to 45 °C.
- A battery under 5 with a fraction, which is volts, not percent.

An uplink with nothing usable is counted as `empty` in the reply. Many of those mean the codec is missing.

## Health rules

Every rule compares a sheep with **its own herd at the same moment**. A flock grazes, rests and heats up
together, so the herd cancels out the weather, the time of day and the scale of a vendor's activity counter. A
herd needs at least 5 sheep with fresh data, or the rule says nothing.

| Flag | Raised when | Alert |
| --- | --- | --- |
| Apart from the flock | Its last two fixes are both farther from the herd's median point than the larger of 300 m and 4 × the herd's median distance. If more than 10% of the herd is that far, it is a split flock instead: one alert for the herd. | `animal_isolated`, `tracking_herd_split` |
| Not moving | By day (07:00 to 20:00), over the last 3 hours: its fixes stayed within 25 m while the median sheep ranged 100 m or more, or its activity was below 25% of the herd's median. When a sheep has both signs, both must agree. | `animal_inactive` |
| Fever | The median of its last hour is at least 1.0 °C above the herd's and at least 0.8 °C above its own 7-day normal. It is urgent at 2.0 °C over the herd. It needs 2 readings in the hour and 3 days of history. Water drunk lowers a reading, and the median drops it. | `animal_fever` |

These thresholds are **starting values**. Tune them against the pilot flock's own data in
`TRACKING_RULES` before trusting them. A flag clears only when fresh data says all is well; silence keeps it.
A tracker never diagnoses: the alert asks someone to go and look.

The job `tracking.health` runs every 10 minutes for each farm. Animal alerts go to the shepherd, vet and
zootechnician, and link to the passport's **Location & health** tab.

Two alerts cover the whole farm, so one gateway outage is one alert and not 700:

- `tracking_silent` counts fitted trackers with no reading for 2 hours. When none reports at all, the text points
  at the gateway, its power and internet, and the network server. The first run after the API was away does not
  judge silence, because the trackers spoke while nobody was listening.
- `tracking_battery` counts trackers below 20%.

The per-device offline check of the devices module leaves trackers alone.

## Storage

| Table | What | Kept |
| --- | --- | --- |
| `tracker_assignments` | Which animal wore which tracker, from when to when | For ever (audited) |
| `tracker_readings` | Every reading as it arrived, about 100,000 rows a day for 700 sheep | `retention.trackerReadingsDays`, 30 days by default |
| `tracker_state` | Each tracker's last reading, battery and signal | Current only |
| `animal_tracking` | Each animal's last position, temperature, activity and flags | Current only |
| `animal_track_days` | Each animal's day: fixes, distance, activity, median and maximum temperature | For ever |

The nightly `tracking.daily` job (00:20) fills `animal_track_days`, redoing yesterday for readings that arrived
late, and looking back a week for any day it missed. It also takes trackers off animals that left the farm, on the
day they left. Readings are telemetry, so they are not written to the journal. Fitting, removing and importing
trackers are domain actions, and each is.

## Trying it without hardware

`apps/api/src/modules/tracking/simulate.ts` plays the network server. It invents readings for a flock grazing
around a point:

```sh
pnpm --filter @yap/api tracking:simulate -- --key <events:write key> --list trackers.csv --backfill 24
```

Use the same list as the import. The first collar wanders off, the second stands still by day, the third runs
low on battery, and the first bolus runs a fever after an hour. It is for development and demos only.

## Hardware notes

- Collars report every 10 to 15 minutes. A battery GPS cannot report every second for months, and a sheep does not
  need it.
- A gateway covers a few km on flat ground. For pastures beyond the farm, take a portable solar gateway with 4G
  with the flock. Only the gateway needs mobile signal, not each sheep.
- Buy devices for the LoRaWAN band legal in Uzbekistan. We could not confirm it (sources disagree between EU868
  and EU433), and 915 MHz is not legal, so ask the seller and the regulator.
