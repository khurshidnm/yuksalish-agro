# What is kept, and for how long

Nothing in the books is ever removed. One job, `settings.retention`, runs every night at 03:45 Tashkent time and
removes only what has served its purpose (`apps/api/src/modules/settings/retention.ts`). It runs once per farm, and a
night that is missed is made up later.

Each run that removes something writes a `retention.applied` event to the journal, with the count for each kind and the
times in force, and the same counts go to the API's log. A run that finds nothing writes nothing.

## Removed after a stated time

| What | Goes after | Set in | Why it can go |
| --- | --- | --- | --- |
| Notifications | 365 days, read or not, once no delivery is waiting | Policies | The alert behind a message stays. A year of in-app history is enough. |
| Stored answers to repeated requests (`idempotency_keys`) | 30 days | Policies | They exist so that a phone repeating a save gets the first answer. A record's own id still refuses a duplicate after that. The floor is 30 days, because a phone can sit offline for weeks. |
| Webhook delivery log | 90 days, once delivered or failed | Policies | It is a log for fixing an integration. A delivery still retrying stays. |
| What the assistant looked up (`ai_messages`) | 90 days | Policies | See below. |
| Imports never finished | 90 days, the whole row | Policies | An upload nobody confirmed holds spreadsheet rows, often phones and names, and has no other use. |
| Rows held by a finished import | 90 days | Policies | The rows that failed stay for fixing, for a while. The record of the import stays: who, when, how many. |
| Collar and bolus readings (`tracker_readings`) | 30 days | Policies | About 100,000 rows a day for 700 animals. The nightly `tracking.daily` job first keeps each animal's day in `animal_track_days` (distance, activity, temperature), which stays. See [tracking](tracking.md). |
| Dead sessions (`refresh_tokens`) | 30 days after expiry | Fixed | They can never be accepted again. The month is for looking into a break-in. They hold an address and a browser name. |
| Telegram link codes | 7 days after expiry | Fixed | They last 15 minutes. |

Times are changed under **Sozlamalar**, **Siyosatlar**, or through `PATCH /api/v1/settings/policy`, and each farm's
owner decides for that workspace. The last two rows belong to no workspace, so they are fixed in the code.

For the assistant, these go from an answer older than the limit: its `sources`, its token `usage`, the input of each
tool call, and any table or chart. The figures in those are copies of what the books still hold. The words of the
answer stay, as do the person's own messages, the tool names and the cards. Those last two must stay: they are how an
answer that held money stays hidden from someone who has since lost `finance.view`.

## Kept for ever

Accounting and tax rules require the books to be kept for years, and the journal and audit log are their evidence.
Nothing below has a removal path, and the database refuses the API any change to the journal or the audit log.

- **The books:** transactions, accounts, debts and loans, budgets, sales and contracts, payroll, stock movements and
  batches, assets and depreciation.
- **The journal** (`events`) and the **audit log** (`audit_logs`).
- **Farm records:** animals and every record about them, fields and their operations, harvests, weather, tasks,
  which tracker each animal wore, and each animal's daily tracking summary.
- **Stored files:** receipts, scans, photos, monthly investor PDFs. No job removes a file, because many records can
  point at one.
- **Alerts**, including resolved ones: a fire alert is a record of what happened and who answered.
- **AI findings and cards** (`ai_insights`, `ai_proposals`): spec 15.2 asks for a log of what was advised and decided.
  A card is what ties a record in the books to the words that made it.
- **People and setup:** users, roles, memberships, API keys, webhooks, devices, reference data.
- **Website enquiries** (`leads`). See [decisions for the owner](#decisions-for-the-owner).

## How much that is at this farm's volume

These are calculated from an assumed day of 300 records, 2,300 sensor events and 15 MB of photos and scans, using sizes
measured on a real database with indexes included. They are not measurements of a working farm.

| Kept for ever | Per day | Per year |
| --- | --- | --- |
| Journal: 2,600 events at 670 B | 1.7 MB | 0.6 GB |
| Audit log: about 500 rows at 1.6 KB | 0.8 MB | 0.3 GB |
| Books and farm records: 300 records at about 1 KB | 0.3 MB | 0.1 GB |
| **Database** | **2.8 MB** | **about 1 GB** |
| **Stored files** | **15 MB** | **about 5.5 GB** |

So about 6.5 GB a year, of which the database is a small part. A 500 GB disk holds decades of it, before counting
backups, which are the larger load on disk: see [Backups](deployment.md#backups).

Machines add nothing to the audit log. A device's heartbeat adds no row at all, and each event it reports adds one row
to the journal. "Last used" on an API key moves at most once an hour, and neither that, nor an open alert being seen
again, nor a webhook moving through the journal, counts as a change (`audit_row()` in `post-schema.sql`). Before this,
30 devices would have written 20 GB of audit rows a year.

What the nightly job removes stays small for good: about 15 MB of notifications, 12 MB of stored answers and 20 MB of
sessions. The webhook log depends on subscriptions: none with no webhooks, about 230 MB if one takes every event.

The assistant is off, so its tables have not been measured.

## Decisions for the owner

These need a person, so nothing removes them yet:

1. **How long the books must stay.** Ask your accountant for the legal minimum. Keeping them for ever cannot fall short
   of it, so nothing has to change unless you want it to.
2. **Personal data in the audit log and journal.** They keep copies of records as they were, so a former employee's
   phone stays in the audit log. That is what makes it evidence, and it stays out of sight without `pii.view`. If
   someone asks to be erased, take legal advice before anyone touches it.
3. **Website enquiries.** They hold a stranger's phone number and are kept until you delete them. Decide how long a lost
   enquiry may stay, and say so in the privacy notice. It is a small addition to the job.
4. **Expired invitations** hold the phone and name the inviter typed. There are few of them.
