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
| Fever | The median of its last 2 hours is at least 1.0 °C above the herd's and at least 0.8 °C above its own normal: the lower quarter of its last 7 daily medians, so days of an illness do not become its normal. It is urgent at 2.0 °C over the herd. It needs 2 readings in those 2 hours (a bolus sends 4, so one lost message does not hide a fever) and 3 days of history. Water drunk lowers a reading, and the median drops it. | `animal_fever` |

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

## Zones, night movement, last seen

A **zone** (`geofences`) is where a herd may graze (`allowed`) or must not go (`forbidden`). It follows a
field's boundary as that is drawn today, or has an outline of its own, drawn on the **Zones** tab. It binds one
herd, or every herd. The outline is GeoJSON and the test is a pure function (`outOfZone` in
`formulas/tracking.ts`): no PostGIS is involved.

- A sheep is **out of zone** when her last 2 fixes are both more than 30 m outside every allowed zone of her
  herd, or more than 30 m inside a closed one (`ZONE_RULES`). The 30 m is GPS jitter. A closed zone narrower
  than 60 m therefore never fires, and the Zones tab says so. A herd with no zone is
  free, and an animal in no herd is never judged. One alert per herd, `geofence_exit`, says how many sheep and
  which zone; it closes when they are back or the zone is switched off.
- **Night movement** (`night_movement`, urgent): between 22:00 and 05:00 farm time, the herd's median point
  moved more than 400 m within two hours, or faster than 1 km/h between two looks at least 10 minutes apart
  (`NIGHT_RULES`). A flock asleep does not walk: it is being driven or chased. A farm that grazes its flock
  at night switches the watch off on the Zones tab (`settings.tracking.nightWatch`, on by default): nothing
  is raised then, and an alert left open is closed by the next run.
- **Last seen** (`GET /tracking/lost`) lists the sheep whose trackers are all silent or who are apart from the
  flock: last position, time since, distance from the herd's centre, battery, and a link to directions. It
  raises no alert of its own, because `tracking_silent` and `animal_isolated` already say so.

All three sets of thresholds are starting values, like the health rules. Zones are changed with
`livestock.update` and removed with `livestock.delete`; each change is a journal event.

## Grazing map

`GET /tracking/grazing?days=7|30|90` answers where the flock spent its time: a grid of about 50 m cells with each
cell's share of all fixes, and for each field with a boundary the animal-hours, animal-days (a sheep that spent
at least 1 hour there that day) and animal-days per hectare. Every fix counts, day and night, so it shows
presence, not only eating. The period ends yesterday. With no stored position the lists are `null`.

The request never reads raw readings. The nightly job counts each finished day into `grazing_cell_days` and
`grazing_field_days` (one read of that day's fixes, about 67,000 rows for 700 collars), and the request sums
those through their `(farm_id, date)` index: at most one row per used cell, herd and day, about 80,000 rows for
90 days of the pilot farm, and the answer is capped at the 4,000 most used cells (`GRAZING_RULES`).

## Storage

| Table | What | Kept |
| --- | --- | --- |
| `tracker_assignments` | Which animal wore which tracker, from when to when | For ever (audited) |
| `tracker_readings` | Every reading as it arrived, about 100,000 rows a day for 700 sheep | `retention.trackerReadingsDays`, 30 days by default |
| `tracker_state` | Each tracker's last reading, battery and signal | Current only |
| `animal_tracking` | Each animal's last position, temperature, activity and flags | Current only |
| `animal_track_days` | Each animal's day: fixes, distance, activity, median and maximum temperature | For ever |
| `geofences` | Zones: name, kind, a field or an own outline, a herd or every herd, on or off | For ever (audited) |
| `grazing_cell_days` | Fixes per grid cell, herd and day, for the grazing map | 100 days |
| `grazing_field_days` | Fixes, animals and animal-hours per field, herd and day | For ever |

The nightly `tracking.daily` job (00:20) fills `animal_track_days`, redoing yesterday for readings that arrived
late, and looking back a week for any day it missed. It also takes trackers off animals that left the farm, on the
day they left. Readings are telemetry, so they are not written to the journal. Fitting, removing and importing
trackers are domain actions, and each is.

## Simulating a sensored flock

`apps/api/src/modules/tracking/simulator` imagines that every sheep on a demo farm wears a GPS collar and a rumen
bolus, and runs the whole process end to end:

1. **Fitting.** It imports a collar and a bolus for every sheep on the farm, through the same all-or-nothing
   import as the Trackers tab. Their DevEUIs start `53494D` ("SIM" in hex). It also creates its own API key,
   named "Tracking simulator".
2. **History.** The first time, it fills the last 7 days (`SIM_HISTORY_DAYS`, 1 to 7) through the batch
   endpoint, as a vendor bridge sends what it buffered. It then writes the daily summaries and runs the health
   rules once, so the charts and each sheep's normal temperature are there from the start.
3. **Live.** It posts every uplink as it happens, one ChirpStack `up` event each, to
   `/api/v1/tracking/ingest/chirpstack`. Once a day each device also sends a `status` battery report. That is
   about 1.2 requests a second for 700 sheep, the load real trackers would bring.

The world is a pure function of the clock (`simulator/world.ts`). A restart resumes exactly where it stopped, and
after a pause it fills the gap. The day follows a winter day at the farm:

| Farm time | The flock |
| --- | --- |
| 21:00 to 07:30 | In the barn (the herd's facility outline) |
| 07:30 to 08:15 | Walks out in a column, the lame at the back |
| 08:15 to 12:00 | Grazes a slow loop across its pasture (the open pasture move, or the largest pasture) |
| 12:00 to 13:30 | Rests at a trough on the pasture's edge nearest the barn |
| 13:30 to 16:30 | Grazes again |
| 16:30 to 17:15 | Walks home |

Things happen at made-up but plausible rates, all driven by the seed:

- Most days one sheep wanders 650 to 1,300 m off for two to three hours. That raises *apart from the flock*.
- About every third day one falls ill for three to five days. It runs a fever of 1.4 to 2.3 °C, moves a third
  as much, and lies down where grazing began. That raises *fever*, then *not moving*.
- About 1% are lame.
- Now and then a collar slips off on the pasture and is fitted again next morning.
- A few collars arrived half flat, and one runs out within the week. That raises *low battery*, then *silent*.
- About 0.4% of GPS fixes fail, and 2% of messages are lost to radio collisions.
- Cold water drops the rumen temperature for an hour after each drink.

The radio follows distance. There is a gateway on the barn roof and a mast at each trough. Collars reach a few km.
A bolus speaks from inside the sheep, so it is heard only within about 300 m of a gateway: at night in the barn,
and at the midday rest. That is why a gateway belongs where the flock sleeps and drinks.

**On the server.** It is an optional service, `tracking-sim` (compose profile `simulation`). A deploy never starts
it, and moves a running one to the new code:

```sh
infra/simulate.sh start    # fit, fill history, then live, day and night
infra/simulate.sh logs     # what the flock is doing: phase, who strayed, who is ill
infra/simulate.sh status
infra/simulate.sh stop     # trackers and readings stay
infra/simulate.sh remove   # take every simulated tracker, reading, flag and alert away
```

**Locally**, with the database settings in `.env`:

```sh
pnpm --filter @yap/api tracking:simulate start --url http://localhost:4000
```

It invents data. Run it on a demo farm only, and `remove` it before real trackers arrive. Its alerts go out
like any other: a fever is urgent, and reaches Telegram if the bot is set up.

## Hardware notes

- Collars report every 10 to 15 minutes. A battery GPS cannot report every second for months, and a sheep does not
  need it.
- A gateway covers a few km on flat ground. For pastures beyond the farm, take a portable solar gateway with 4G
  with the flock. Only the gateway needs mobile signal, not each sheep.
- Buy devices for the LoRaWAN band legal in Uzbekistan. We could not confirm it (sources disagree between EU868
  and EU433), and 915 MHz is not legal, so ask the seller and the regulator.
