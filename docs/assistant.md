# Conversational assistant

The same assistant works in the web app and in Telegram. A person can ask how the farm is doing, or
tell it about money ("yoqilg'iga 3 mln naqd to'ladim"), and it prepares the record in the right place.

## Principles

1. **The AI prepares, a person confirms, the kernel writes.** Spec 4.1 and 15 forbid AI from writing
   financial records. The model only creates a pending proposal in `ai_proposals`. Nothing reaches the
   books until a person presses Confirm, and then it goes through the same service as manual entry,
   under that person's identity, with the same permissions, validation and maker-checker.
2. **Code decides "ready", not the model.** The model extracts. Deterministic checks then decide whether
   the proposal is complete. A model's confidence is never trusted on its own.
3. **Nothing on a card rests on the model's word.** Amounts, quantities, dates, how it was paid, who paid
   whom, and the names of people, fields, machines and accounts must each be found by code in what the
   person said, or the answer is a question. The category is the one thing the model chooses, and the
   card shows it. A field is checked once: a later correction to one field does not put the others back
   on trial, and anything typed into the card's form is the person's own statement.
4. **When in doubt, ask.** One question at a time, with options where possible. A missing or ambiguous
   required field is a question, never a guess.
5. **Stored text is data.** Names and notes in tool results can never become instructions, and only a
   button press or a confirm call can move a proposal forward.
6. **Confirm decides again.** What was true when a draft was made may not be true when it is confirmed.
   Confirm books exactly the card the person read, re-checks everything the card points at, and looks
   for duplicates in the books as they stand at that moment, all under a lock.

## Flow

```
message, voice note or receipt photo
  → model reads it, looks things up with read-only tools, calls draft_*
  → code resolves ids and runs the checks in "Readiness" below
      needs_info → the model asks the returned question
      ready      → a pending proposal is saved and shown as a card
  → person presses Confirm, Change or Cancel
  → Confirm: code decides again under a lock (see Confirm), the owning service writes it, the
    journal records it, a short Undo window opens
```

## What goes where

Routing is a code table (`modules/ai/records/routing.ts`), not a model decision. The model picks the
category; the table says what that category needs.

| What the person describes | Kind | Written through | Treatment |
| --- | --- | --- | --- |
| Goods with a quantity: feed, seed, fertilizer, fuel, drugs, parts | `stock_purchase` | `inventory/stock.service createReceipt` | `inventory`, so cost reaches a cost center on issue |
| Direct cost: service, repair, electricity, fee | `expense` | `finance/transactions.service create` | `expense` |
| Tractor, barn, camera system | `expense` | same | `capex` |
| Buying animals | `expense` | same, then a reminder to register them | `animal` |
| Money received | `income` | same | none |
| Paying off an existing debt to a supplier, or a buyer paying what they owed | `debt_payment` | the finance debts settlement service | none |
| Moving money between cash and bank | `transfer` | `finance/transactions.service create` | none |

Refused with an explanation, because another module owns them and recording them here would double count:
salaries and advances (HR payroll), loan instalments (finance loans), depreciation (monthly job), selling
goods or animals that leave stock (sales).

Category rules:

| Categories | Required target | When unstated |
| --- | --- | --- |
| `feed`, `seed`, `fertilizer`, `crop_protection`, `fuel`, `spare_parts`, `veterinary` as goods | `stock_purchase`: item, quantity, warehouse. A supplier is needed only when something is owed | Ask for the quantity. If it is really a service, it becomes an `expense` |
| `water`, `mechanization_service` | A field, or general | Ask which field |
| `shearing`, `tags_devices`, `veterinary` as a service | A herd | The farm's only herd when there is exactly one, otherwise ask |
| `repair`, `equipment_rent` | A machine or field | Ask which |
| `electricity`, `gas`, `utility_water`, `security_guard`, `communication`, `transport`, `paperwork`, `licenses`, `bank_fees`, `insurance`, `meals`, `clothing`, `construction_repair` | General cost center | General, shown on the card, and the person may change it |
| `barn_construction`, `machinery_purchase`, `camera_system` | General | `capex` |
| `animal_purchase` | A herd | Ask which |

## Which words count

A draft may lean on the current message, and on earlier messages only while the assistant is still
asking about them. Once a turn ends with no open question, the money in it is spoken for, so "Gazga ham
to'ladim" can never borrow the 3 mln said for electricity. Each message's document amounts come from a
separate tool-free reading step, so the drafting model never vouches for its own number. The person's
own words outrank a document: when they disagree, that is a question.

An open question does not make everything said before it fair game:

- It lapses after 12 hours of silence, on both channels, and the next message starts afresh.
- A draft about another category, item or counterparty than the one being asked about is a new record. It
  has only its own message to lean on, so gas never inherits the repair's day and payment, and the old
  question is dropped. This compares drafts of one kind, and not while the question is about that very name.
- Money said once backs one card. A second record needs the sum said again, or said to be each:
  "по 500 тысяч: за интернет и нотариусу".
- Each message keeps the day it was said. "Bugun" means that day when the answer comes after midnight, and
  with no day in the words the record takes the day it was first said.
- Forwarded words back nothing on a card, but a plan or a wage in them stops the record all the same.

## Readiness

`validateDraft` returns `{ fields, questions, warnings }`. Blocking, so the result is a question:

- nothing happened yet: a question, a plan, something still to pay, something someone else said. Once
  asked, only words that say it was paid get past this
- a kind the words contradict: income with only we-paid words, an expense with only money-came-in words,
  or an expense paying off a debt the books hold
- amount missing, not found in the person's words or document, taken back ("3 mln emas"), a range, a
  price per unit offered as a total, or money already on another card
- a bare figure that may have lost its "ming": below 10 000 as an amount, below 100 as a price per unit, or
  a price that comes to less than 10 000 in all
- the words and the document give different amounts
- a total and a unit price that do not agree
- category missing, or several fit equally
- a target missing or ambiguous, per the table above, or named by the model and not by the person
- a name that matches nothing or several records
- goods the person's words do not single out: "bug'doy" with both a feed and a seed on the shelf
- a place they named that code cannot confirm: it never quietly stays on General
- how it was paid is unstated: never assume cash, bank or debt
- the account is unstated and the farm has more than one of that type
- an account kept in another currency than the record
- on debt, or a settlement, with no counterparty, or one matching several records
- a settlement with no direction in the person's words, no open debt, or more than is open
- a transfer whose words send the money the other way than the draft does
- paying ahead for goods not yet received, on a settlement: entered in Finance
- a stock purchase with no quantity in the person's words, a unit that does not convert exactly, or a
  price that could be per tonne or per kilo
- goods with no expense category of their own, and none chosen
- goods that may have gone to the warehouse, unless the words say they were used directly or paid for
  as a service
- pay to a named job, which may be a wage: asked before it can be a Qorovul expense
- a foreign currency with no rate, a stated rate far from the stored one or, with none stored, one that
  cannot be a rate, a currency the farm does not keep, or foreign money on a settlement
- a date in the future, one that does not exist, a phrase that cannot be pinned down ("o'tgan hafta"),
  a date the words do not back, or one more than 400 days old

Refused with an explanation before anything else, because another module owns them: salaries and
advances, loans and leasing, depreciation, and selling animals or goods, whichever category was chosen.

Warnings, shown on the card without blocking:

- much larger than usual for this category, or a unit price far from the item's usual price
- more than the account's balance
- dated more than 30 days ago
- at or above the approval threshold, so it will wait for a second person
- the target was the default, not stated
- a stored exchange rate older than 7 days
- a learned word chose this: the card says so

Four warnings need an explicit yes, not just Confirm (`needsAcknowledgement`):

- `POSSIBLE_DUPLICATE`: the same thing was recorded in the last 3 days, or waits on an older open card.
  Each kind has its own match: category, target and amount; item and quantity; counterparty, direction
  and amount; both accounts and amount. This is checked live, every time a card is shown and again at
  confirm. Two different records at one price stay two cards; nothing is ever merged silently.
- `OTHER_AMOUNT`: the exchange held money no card accounts for, such as change or a discount. It is worked
  out on the turn the card appears, from the message holding the card's own amount onward, because a
  correction leaves the figure it replaced behind. Money on the exchange's other cards, in drafts still
  being asked about, and the rate are accounted for.
- `AMOUNT_FROM_DOCUMENT`: the amount was read from a document and no words back it.
- `CURRENCY_CONVERTED`: dollars were said, but the account holds so'm: what leaves it is the so'm value.

`OTHER_AMOUNT` and `AMOUNT_FROM_DOCUMENT` are about the amount, so they stay through every change that
leaves it alone, in chat or in the form.

## Confirm

`confirmProposal(id, { stamp, acknowledged })` takes the proposal's row lock and a per-farm lock, then:

1. refuses `PROPOSAL_NEEDS_ANSWER` if a correction is still waiting for an answer
2. refuses `PROPOSAL_CHANGED` if `stamp` is not the card's current stamp, with the fresh card in
   `details.proposal`. The stamp covers the fields and the codes of the warnings that need a yes, so a
   yes covers only what the person saw: a duplicate that appears later has to be read first
3. re-runs validation from the settled input, and refuses `PROPOSAL_STALE` if a question comes back or
   the record's substance changed, for example the account was closed. A rename is not a change
4. refuses `NOT_ACKNOWLEDGED` if a warning above needs a yes, with the fresh card in `details.proposal`
5. writes through the owning service. Money records carry `sourceType: 'ai_proposal'`. A stock purchase's
   money stays `stock_batch`, because the receipt owns it, and the proposal keeps the receipt in its result

A correction that needs an answer keeps the old card visible but not confirmable. The card's form starts
from the settled input and never from that correction, so nothing code refused can be adopted, and the
correction goes on waiting until the form has set what it changed. Only `update_draft` with an explicit
id, on a card of the same conversation, or that form changes a card. A card's result status follows
the books, so a second person's approval or refusal shows on it.

## Tools given to the model

Read-only tools stay as they are. New ones, offered only to people holding the matching permissions:

| Tool | Needs |
| --- | --- |
| `farm_status`: herd, feed days, cash when allowed, alerts, overdue work | any AI user, money only with `finance.view` |
| `find_records(kind, query)`: categories, cost centers, items, herds, fields, machines | any AI user, no money. Accounts and counterparties need `finance.view` |
| `draft_expense`, `draft_stock_purchase`, `draft_income`, `draft_debt_payment`, `draft_transfer` | `finance.create` and `finance.view`; stock purchase also `inventory.create` |
| `update_draft(proposalId, changes)`, `cancel_draft(proposalId)` | the proposal's owner, on a card of this conversation. `cancel_draft` also needs the person's own last message to ask for it |

There is deliberately no confirm tool, and no way for the model to clear a duplicate warning.

Beside a card, the closing sentence is written by code, because the card already says everything and a
free sentence could only contradict it. A question keeps the model's wording unless it claims something
was saved or names money nobody said, and then a fixed question is used.

## Learning

Common farm words are known from the start, in all three languages: "salyarka" and "отруби" find Dizel and
Kepak, "plough" finds the Plug, and "yoqilg'i" finds the only fuel (`records/vocabulary.ts`). When a person
answers a question about a word that matched nothing ("Akmal aka" means a certain supplier), the card says what will be remembered, and the phrase is saved to `ai_aliases`
on confirm. A word that matched several records is never learned: it stays a question, because the
answer may differ next time. A name always beats a learned word, and a learned word stops working when it
starts to match a real record. Undo forgets what that record taught. A new answer replaces an old one.
Aliases apply per farm, and someone with `ai.create` can delete them under Phrases on the AI page.

## Telegram

The bot talks to the same core, so nothing here decides anything about money. What is its own:

- **Linking:** a code never moves a chat that belongs to someone else without a yes that names both
  accounts. Whatever ends a person's web sessions, such as a password change or leaving a workspace, burns
  unused codes and keeps the link, because it may be how a fire on another farm reaches them. Each update
  checks the memberships again. The link ends only when they unlink it or the account is blocked, and the
  chat is told.
- **Several farms:** `/ferma` chooses the farm with buttons. Someone on several farms is asked rather than
  sent to the oldest one, and every card names the farm.
- **Two lanes per chat:** messages, Confirm, Yes, Change and `/yangi` keep their order. Other commands,
  Cancel, Undo and link presses never wait for the model, so a stuck model call cannot hold them back.
  After 60 seconds a turn keeps running and the lane moves on, but a Confirm or Yes is refused until that
  turn has answered, because it must see what the turn does to the card.
- **Delivery:** an update is acknowledged only after it is handled, and a durable key stops a message being
  answered twice after a crash. The one exception is an update more than 90 behind that has been in hand
  for over 5 minutes, which is let go so that it cannot hide newer ones. Urgent alerts go first, run on
  their own worker, and one person's `retry_after` never holds back the next person.
- **Forwarded messages:** someone else's words, so their figures count like a document's.

## Ideas included beyond the request

- **Voice notes:** speak in Uzbek or Russian in Telegram. The transcript is shown before anything else.
- **Receipt photos:** send a photo or PDF, and it becomes a proposal with the amount read from the document.
- **Several records in one message:** "500 ming tushlik, 200 ming aloqa, ikkalasi naqd" gives two cards.
- **Undo:** for 15 minutes after confirming, below the approval threshold.
- **Evening recap:** at 20:00, today's confirmed records, what still waits, and the totals, to those who recorded something and may still see money. Totals count approved records only.
- **Accuracy score:** `pnpm --filter @yap/api ai:eval` runs real messages through the real model and reports how often it filed correctly or asked when it should. Rerun it after any prompt or model change. `--cases=$PWD/eval/holdout4.ts` scores another set. The holdout files were each written blind from this document and the farm's data, but each stopped being blind once its failures were read, so they serve as regression sets now. An honest score always needs a new set: the last one, on the final code, was 94.4% over 360 conversations, with no record created without a Confirm.

## Contract between the parts

```ts
// apps/api/src/modules/ai/assistant.ts
chat(identity, {
  conversationId?: string;
  message: string;
  language?: string;
  channel?: 'web' | 'telegram';   // default 'web'
  blocks?: LlmBlock[];            // photo, PDF or audio sent with the message
}, onEvent?) → { conversationId, message }
// message.attachments may include { type: 'proposal', proposal: ProposalView } and { type: 'question', question }

// apps/api/src/modules/ai/records/service.ts. All run inside withTenant as the person.
listPending(): Promise<ProposalView[]>
getProposal(id): Promise<ProposalView>
confirmProposal(id, input: { stamp: string; acknowledged?: boolean }): Promise<ProposalView>
rejectProposal(id): Promise<ProposalView>
updateProposal(id, changes): Promise<ProposalView | { questions: Question[] }>
undoProposal(id): Promise<ProposalView>

// apps/api/src/modules/ai/records/render.ts
renderProposalText(view: ProposalView, language, farmName?): string   // plain text for Telegram, HTML-escaped by the caller

interface ProposalView {
  id: string;
  kind: 'expense' | 'stock_purchase' | 'income' | 'debt_payment' | 'transfer';
  status: 'pending' | 'confirmed' | 'rejected' | 'expired' | 'undone';
  channel: 'web' | 'telegram';
  createdAt: string;
  expiresAt: string;
  undoUntil: string | null;
  sourceText: string;
  stamp: string;                  // send it back with Confirm
  masked: boolean;                // this person may no longer see money: amounts are null and it cannot be acted on
  fields: {
    amount: number | null; currency: string; fxRate: number | null; amountBase: number | null; date: string;
    category: { id: string; name: string } | null;
    target: { costCenterId: string; type: string; name: string; defaulted: boolean } | null;
    account: { id: string; name: string } | null;
    toAccount: { id: string; name: string } | null;
    paymentMethod: 'cash' | 'bank' | 'card' | 'debt' | null;
    counterparty: { id: string; name: string } | null;
    item: { id: string; name: string; unit: string } | null;
    warehouse: { id: string; name: string } | null;
    qty: number | null; unitPrice: number | null;
    costTreatment: string | null;
    direction: 'payable' | 'receivable' | null;
    description: string | null;
  };
  warnings: { code: string; params: Record<string, unknown> }[];
  learning: { phrase: string; name: string }[];   // what confirming will teach it
  needsAcknowledgement: boolean;  // a warning needs an explicit yes: send acknowledged: true
  needsAnswer: boolean;           // a correction waits for an answer: show no Confirm
  willNeedApproval: boolean;
  result: { type: string; id: string; status: string } | null;   // status follows the books
}

interface Question {
  field: string;
  code: string;            // stable, for tests
  options: { id: string; label: string }[];
  hint: string;            // for the model only
}
```

HTTP, under `/api/v1/ai`: `GET /proposals`, `GET /proposals/:id`, `PATCH /proposals/:id`,
`POST /proposals/:id/confirm`, `POST /proposals/:id/reject`, `POST /proposals/:id/undo`, `GET /aliases`,
`DELETE /aliases/:id`. Confirm's body is `{ stamp, acknowledged? }`. PATCH, confirm and undo need
`finance.create`. Only the person who owns a proposal can act on it. Expiry is 24 hours.
