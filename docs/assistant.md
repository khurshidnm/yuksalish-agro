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
| An animal was weighed: "1234-qo'y 46 kilo chiqdi" | farm record `weight` | `livestock/weights.service createWeight` | no money |
| An animal died: "0567 raqamli qo'y o'ldi, ichi ketgan" | farm record `death` | `livestock/exits.service createExit` | no money |
| A treatment, vaccination or deworming was given: "0567 ga 5 ml ivermektin qildim" | farm record `treatment` | `livestock/health.service createRecord` | the drug leaves the warehouse as a stock issue |
| A herd was fed: "bugun 1-otarga 300 kilo beda berdim" | farm record `herd_log` | `livestock/daily-logs.service createDailyLog` | the feed leaves the warehouse as a stock issue |

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
| `barn_construction`, `machinery_purchase`, `camera_system`, `land_purchase` | General | `capex` |
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

## Farm records

Field staff dictate what was done, by text or voice, on the web and in Telegram. It works as money
records do: the model only drafts, a pending row in `ai_proposals` becomes a card, the person confirms,
and the owning service writes it under that person's name. The kinds offered are `FARM_RECORD_KINDS` in
`routing.ts`: `weight`, `death`, `treatment`, `herd_log`. Lambing and field operations are not built.
The code is `modules/ai/records/farm-*.ts`; the cards are attachments of type `farm_proposal`, served by
`/ai/farm-proposals` (`/:id`, `/:id/confirm` with `{ stamp }`, `/:id/reject`, `/:id/undo`).

A farm card holds no money for anyone (rule 7): no unit cost, no ration cost, no value of the animal.

**Rights.** `FARM_RULES` gives each kind the rights its own page asks. A draft tool is offered, and a
draft, a confirm and an undo are allowed, only with them, and only while the owning module is switched on.

| Kind | Draft and confirm | Undo | Undo calls |
| --- | --- | --- | --- |
| `weight` | `livestock.update` | `livestock.update` | `deleteWeight` |
| `death` | `livestock.create` | `livestock.delete` | `undoExit`: the animal returns to the flock |
| `treatment` | `health.update` | `health.delete` | `deleteRecord`: the drug returns to the warehouse |
| `herd_log` | `livestock.create` | `livestock.delete` | `deleteDailyLog`: the feed returns to the warehouse |

Someone who may confirm but not undo gets no Undo button, and the card says to change it on its own
page. So a shepherd feeds a herd by voice and corrects it on the daily log page; a zootechnician records
a treatment and cannot take it back from the chat.

**Readiness: every fact is in the person's words** (`formulas/record-words.ts`, tested in Uzbek Latin,
Uzbek Cyrillic, Russian and English). Whatever the model passes, a card is made only when code finds:

- the tag, said as a tag: "1234-qo'y", "0567 raqamli", "номер 567", "#567". "46 kilo" is never tag 46,
  and "46 qo'y" may be a head count, so it asks. A tag no animal has, or several animals answer to, asks.
  An animal that has left the farm asks
- the quantity with its unit, beside the thing it measures. A bare number is not a quantity. After a
  number said as a tag ("YA-0567 46 kilo", "0567 5 ml") the quantity is read. After a bare number
  ("567 5 ml") it is not, because two numbers side by side may be a range: it asks
- the herd, the drug or the feed by name. The only herd, when none was named, is taken and shown on the
  card as chosen by rule. A drug the warehouse does not keep stays as they named it, with a warning that
  nothing leaves the warehouse. A feed must be a stock item
- the day, through the same date evidence as money: a day the model sets against the words asks
- for a death, a word that says it died. The cause is quoted from their words or left empty

Quantities never cross kinds of unit. Millilitres of a drug kept in vials or doses ask how many vials
left; kilograms of straw kept in bales ask how many bales. An amount that does not fit the warehouse's
three decimals asks. A quantity said once backs one card: the second animal or herd needs its own.

A herd's feeding takes several feeds in one sentence. Each amount is tied to the one stock item beside
it, amount first or feed first, read one way through the whole message ("300 kilo beda va 50 kilo arpa",
"beda 300 kilo, arpa 50 kilo"). One amount for two feeds, or a message that reads two ways, asks. An
amount said alone answers for one waiting feed only. The card names the ration feeds it does not hold,
because the daily log writes them as not given. A herd has one record a day.

Two animals in one sentence are two drafts and two cards. A second draft about the same thing in the
same conversation (the same animal and kind, the same herd and day) corrects the first card and does not
make another. A correction that raises a question leaves the card visible and not confirmable.

**Confirm** (`confirmFarmProposal`) takes the row lock and the per-farm lock `ai-confirm:<farmId>`, then:

1. refuses `PROPOSAL_NEEDS_ANSWER`, `PROPOSAL_EXPIRED` and `PROPOSAL_CHANGED` as for money
2. checks the kind's right for the person confirming (`FARM_RULES`), since the weight, health and daily
   log services leave that check to their routes
3. looks at the books again: `FARM_RECORD_EXISTS` when the same record is already there (the animal
   weighed that day, its death, that treatment with that drug that day, that herd's day);
   `PROPOSAL_STALE` when the animal left the farm or changed its tag, the herd was archived, the item
   was switched off or changed its unit, or the named warehouse was closed
4. calls the owning service, whose validation, journal event, stock issue and withdrawal date run as on
   its own page. A shortage is the warehouse's refusal (`INSUFFICIENT_STOCK`): nothing is written and the
   card stays pending

The model has no confirm tool, and `yap_ai` cannot write any of these tables.

## Tools given to the model

Read-only tools stay as they are. New ones, offered only to people holding the matching permissions:

| Tool | Needs |
| --- | --- |
| `farm_status`: herd, feed days, cash when allowed, alerts, overdue work | any AI user, money only with `finance.view` |
| `find_records(kind, query)`: categories, cost centers, items, herds, fields, machines | any AI user, no money. Accounts and counterparties need `finance.view` |
| `draft_expense`, `draft_stock_purchase`, `draft_income`, `draft_debt_payment`, `draft_transfer` | `finance.create` and `finance.view`; stock purchase also `inventory.create` |
| `update_draft(proposalId, changes)`, `cancel_draft(proposalId)` | the proposal's owner, on a card of this conversation. `cancel_draft` also needs the person's own last message to ask for it |
| `draft_weight`, `draft_death`, `draft_treatment`, `draft_herd_log` | the kind's create right in `FARM_RULES` and its module switched on. No `finance` right is needed. Passing `proposalId` corrects that card |
| `cancel_farm_draft(proposalId)` | the card's owner, on a farm card of this conversation, when their own last message asks for it |

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
