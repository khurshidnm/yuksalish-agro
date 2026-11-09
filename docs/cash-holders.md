# Cash held by people: handovers, spending, returns

The owner hands the farm manager cash for the week, from his own pocket or from the farm's cash box or bank.
The manager confirms it arrived, spends it on the farm's daily costs, and gives back what is left. AgroPanel
shows the owner what each person received, what they spent it on, and the cash they should still hold.

Code: `apps/api/src/modules/finance/advances.service.ts` and `advances.routes.ts`, tables in
`apps/api/src/db/schema/cash.ts`, web page `apps/web/src/features/finance/CashHoldersPage.tsx` at
`/finance/cash-holders`. Tests: `apps/api/test/advances.test.ts`.

## The model

A person's cash is an ordinary `cash` account, named after them. `cash_holders` says whose it is (one row per
account, `active` until closed). Because it is a normal account, balances, the journal, approval, reports and the
export need nothing new: an expense paid from the manager's cash is an expense like any other, on its category
and cost center, and counts in every report the same way.

| What happens | Entry in the ledger | Counts as |
| --- | --- | --- |
| Owner gives own money | `contribution` into the holder's account | cash in, financing; never income |
| Cash from a farm account | `transfer` from that account to the holder's | nothing: money between own accounts |
| The holder pays for something | `expense` (or `debt_payment`) from the holder's account | an expense, as entered |
| Cash back to the owner | `withdrawal` from the holder's account | cash out, financing; never expense |
| Cash back into a farm account | `transfer` from the holder's account | nothing |

`contribution` and `withdrawal` are the owner's own money in and out. They move one real account and carry no
category, cost center or counterparty (`INVALID_CAPITAL_ENTRY`). Profit never sees them; cash flow counts them in
inflow and outflow and shows them again as `financingIn` and `financingOut`, so net flow still equals the change
in cash. The 1C export books them against owner's capital, account 8300 (to be confirmed by the farm's
accountant). Only a person holding `finance.capital` enters them, the owner by default; roles are editable, so this
is a permission rather than a role check.

## A handover

```
sent ──Received──▶ accepted ──reverse──▶ reversed
  │
  ├──Not received (with a reason)──▶ disputed
  └──the sender takes it back──────▶ cancelled
```

1. **Sent.** `POST /finance/cash-handovers` records the handover and moves no money. Own money needs
   `finance.capital`; a farm account needs `finance.create`, and the handover is in that account's currency. The
   holder's account in that currency is opened on first use. The holder gets a message with **Received** and
   **Not received** (in the app now, in Telegram from phase 1b).
2. **Received.** Only the holder's own login can accept, and it needs `finance.create`, because accepting posts
   money in the holder's name. The money is entered by the holder and approved by the sender when the sender holds
   `finance.approve` (`postTransaction({ approvedBy })`), so maker and checker are two people and it counts at once,
   whatever the amount. A sender who may not approve leaves it `pending` above the threshold, for someone who may.
3. **Not received** records the reason and tells the sender. Nothing moves.
4. **Reverse** (`finance.approve`, never the holder) takes accepted cash off the books: its money is refused while
   pending, voided once approved. Refused with `HOLDER_CASH_SPENT` once part of it is spent, as a stock purchase is
   once its goods are used: the holder would show spending from money they never had. Keep it and take back what
   is left instead.

The handover owns its money: finance cannot void it (`TRANSACTION_HAS_SOURCE`). When an approver refuses its
pending money on the approvals page, the ledger marks the handover `reversed` with that reason
(`releaseSource`), under the same "not once spent" rule.

## Rules that keep the cash honest

- **Who may hold cash.** An employee still working here, linked to a login that holds `finance.view` and
  `finance.create` (`HOLDER_NEEDS_LOGIN`, `HOLDER_NEEDS_FINANCE`). A driver without finance rights waits for the
  narrower `finance.own_cash` of phase 5.
- **The holder never judges their own cash.** `assertCanDecide` refuses approving or rejecting an entry on an
  account the caller holds (`HOLDER_CANNOT_APPROVE`), on top of maker ≠ checker. The pilot's manager is a
  `director`, who holds `finance.approve` for everything else.
- **Cash reaches a person only through a handover.** A manual transfer or contribution into someone else's cash
  is refused (`USE_CASH_HANDOVER`). Taking money from the cash box into one's own cash is one's own word and is
  allowed.
- **Never more back than is held.** A return above the cash in hand is refused (`HOLDER_CASH_SHORT`).
- **Cash in hand** is the approved balance plus what waits for approval but already moved:
  `balance + pending in − pending out`. A large purchase waiting for the owner already left the manager's pocket.
- **Leaving.** Someone holding cash, or with a handover waiting for their answer, cannot be terminated or moved to
  another login (`EMPLOYEE_HOLDS_CASH`). Their cash account closes only from Cash holders, once nothing is left
  (`HOLDER_HAS_CASH`, `HANDOVER_OPEN`); the accounts page refuses to close it (`HOLDER_ACCOUNT`).
- **Names.** Another person's cash is left out of `/finance/accounts/lookup` for callers without `finance.view`, and
  unnamed (`name: null`, `holder` set) without `pii.view`, there and in the accounts list, the cash position the
  dashboard, reports and the assistant read, and the holder lists. The web names it "A staff member's cash".

## Buttons on messages

A notification may carry `action: { kind, id }` (`notifications.action`). The module that owns the record
registers a handler (`notifications/actions.service.ts`): `buttons(id)` says which buttons the reader may press
now, and `run(id, button)` decides again, as the person who pressed, through the owning service. A stale button
can never act: `POST /notifications/actions` answers `ACTION_NOT_AVAILABLE`. The inbox lists the live buttons with
each message; a button with `needsReason` asks for a few words first. Messages about handovers are the
`cash_handover` event type, sent to Telegram by default and shown only to holders of `finance.view`, since they
name amounts.

## Reading it back

- `GET /finance/cash-holders`: each open holder with cash in hand, the approved balance, this week's received and
  spent, entries waiting for approval and handovers waiting for an answer.
- `GET /finance/cash-holders/:id?from&to`: one person over a period (Monday to today unless named): opening,
  received, spent, given back, closing, spending by category and by cost center (a machine is a cost center), and
  every entry.
- `GET /finance/capital`: the owner's own money put in so far (contributions less withdrawals) and the cash in
  people's hands now. The dashboard's cash card shows both.

## Still to come

Telegram buttons, approvals from Telegram, `/kassa` and the owner's evening summary (phase 1b); the weekly cash
count with shortage and surplus (phase 1c, which also stops `cash_shortage` and `cash_surplus` being filed by
hand); the assistant drafting handovers and paying from the holder's own cash (phase 1d).
