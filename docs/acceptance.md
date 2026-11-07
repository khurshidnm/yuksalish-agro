# Acceptance record

Results of checking the web application against spec section 24. Measured on 2026-11-04 on a development
machine (Apple Silicon, 10 cores, 24 GB) with the API and database on the same host, so timings exclude
real network latency. Data is the seeded demo tenant, not real farm data. Spec section 24 says acceptance
happens on Yuksalish Agro's real data, so this is a pre-acceptance check, not sign-off.

## Section 24.1: MVP criteria

| # | Criterion | Result | Evidence |
| --- | --- | --- | --- |
| 1 | 500 ewes tagged, each with pregnancy and expected lambing date | Pass | Over HTTP: 500 unique tags, 500 pregnancy records, every date is mating + 150 (window 145 to 152), expected lambing 2027-02-07 to 2027-03-24 |
| 2 | 70 ha drawn on the map, crop and season per field, area computed | Pass, placeholder contours | 70.000 ha arable and 210.000 ha total from PostGIS on drawn geometry. Drawing and editing tested in real Chrome by mouse and touch. The contours are invented: the real boundaries must be drawn |
| 3 | Daily feed entered offline, synced correctly after reconnecting | Pass in Chromium, web instead of mobile app | 125 of 125 checks with the connection physically cut: queued, stock unchanged, survives reload, posts exactly once, replay changes nothing. Not tried on a real phone, on Safari or on iOS |
| 4 | Feed stock and days remaining from actual consumption | Pass | 111,467 kg / 617.429 kg per day = 180.5 days, matching the API |
| 5 | Every expense on a cost center; cost per ewe; field cost report | Pass | 40 of 40 expenses have a cost center. Cost per ewe 4,436,321.98 so'm equals (purchase + accumulated) / head by hand. All 5 arable fields reported across seasons |
| 6 | Budget entered, plan and fact on the dashboard | Pass | Year plan 3,381,800,000, fact 3,306,722,272, 97.8 % |
| 7 | Role limits: a shepherd cannot see finance | Pass | 403 on finance routes. Sweep of all 150 parameterless GET routes as shepherd, mechanic, storekeeper and veterinarian found no money or personal field |
| 8 | Telegram daily summary and urgent alert | Pass | Sent through the real delivery job to a real bot on 2026-11-04 and received on the owner's phone: one daily summary, one urgent alert. Scheduled delivery at 07:00 has not yet run unattended |
| 9 | Autumn sowing data loaded through Excel import | Pass | Real template downloaded, filled with comma decimals, dd.mm.yyyy dates, stray spaces and a Cyrillic crop name, imported through preview and confirm. Re-importing the same file added nothing |
| 10 | 10 people at once, under 2 seconds | Pass | See volume test below |

## Section 24.2: test types

| Test | Result |
| --- | --- |
| Unit and integration | 1,849 passing: 1,466 API against a real Postgres, 256 shared, 127 web. No type errors. Formula coverage in `packages/shared/src/formulas`: 99.3 % statements, 100 % lines, against the required 80 % |
| Functional | Real Chrome at 360 px against the real API: 495 pages across 9 roles, no crashes, 5xx responses, raw translation keys or horizontal scroll. Module flows driven through the UI by each module's checks |
| User acceptance (UAT) | Not done. It needs Yuksalish Agro's staff working on real data for 2 weeks |
| Offline and sync | 125 of 125, as in criterion 3 |
| Volume | 1,000 animals, 100 fields, 100,378 journal events in production mode. 81 pages and reports: 0 errors, slowest 81 ms. 10 users for 30 seconds: 925 requests, median 8 ms, p95 84 ms, max 121 ms, 0 errors |
| Security | Tenant isolation by RLS and composite foreign keys, permissions, maker-checker, audit, token rotation, upload limits, all with tests. No external penetration test or dependency audit has been done |
| Data accuracy | Hand-computed control numbers in the module test suites, and the figures above |

## Open before go-live

- UAT with farm staff on real data, then sign-off.
- Draw the real field boundaries and answer the open questions in spec 6.2.
- Offline on real low-cost Android phones and on iOS.
- Confirm the Keeping export format, which is a documented generic double-entry CSV for now.
- An external security review.
