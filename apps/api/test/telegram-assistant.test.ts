/**
 * The assistant over Telegram, end to end: the real chat(), proposals service and database, with
 * only Telegram and the model replaced.
 */
import { randomInt } from 'node:crypto';
import { DEFAULT_ROLE_PERMISSIONS, todayIso } from '@yap/shared';
import { eq } from 'drizzle-orm';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config';
import { tx, withPlatform } from '../src/core/context';
import { AppError, safeError } from '../src/core/errors';
import { ensureCostCenter, generalCostCenterId } from '../src/core/costCenters';
import { addMember } from '../src/core/tenancy';
import { schema } from '../src/db/client';
import { setProvider, type LlmBlock, type LlmProvider, type LlmRequest, type LlmResponse } from '../src/modules/ai/provider';
import { ClaudeProvider } from '../src/modules/ai/provider/claude';
import { renderProposalText } from '../src/modules/ai/records/render';
import type { ProposalView } from '../src/modules/ai/records/types';
import { raiseAlert } from '../src/modules/alerts/alerts.service';
import { modelTextToHtml } from '../src/modules/notifications/assistant-bot';
import { createChatQueue, createUpdateLedger, handleUpdate, startTelegramBot } from '../src/modules/notifications/bot';
import { tr } from '../src/modules/notifications/i18n';
import { sendDailySummary } from '../src/modules/notifications/jobs';
import { dispatchPending, notifyUser } from '../src/modules/notifications/notify.service';
import { setUserStatus } from '../src/modules/platform/users.service';
import { sendHtml, splitHtml, stripHtml, type TelegramFile, type TelegramUpdate } from '../src/modules/notifications/telegram';
import { createFixture, type Client, type Fixture, type FixtureOptions } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setProvider(undefined);
});

// ─── Telegram and the model, faked ──────────────────────────────────────────

interface Call {
  method: string;
  body: any;
  /** For sendMessage: the id Telegram gave the message. */
  messageId?: number;
}

const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
const refused = (status: number, description: string) =>
  new Response(JSON.stringify({ ok: false, description }), { status });

/** Telegram as the bot sees it: records every call and answers it. Nothing leaves the process. */
function fakeTelegram(files: Record<string, Buffer> = {}) {
  const calls: Call[] = [];
  const downloads: string[] = [];
  /** What each message shows now, because Telegram refuses an edit that changes nothing. */
  const shown = new Map<number, string>();
  let nextMessageId = 1000;
  const state = {
    /** Return a Response to replace the normal answer to a call. */
    intercept: (_call: Call): Response | undefined => undefined,
    /** What Telegram holds. With nothing held getUpdates waits, like a real long poll. */
    updates: [] as TelegramUpdate[],
  };

  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const file = /\/file\/bottest-token\/(.+)$/.exec(url);
      if (file) {
        downloads.push(file[1]);
        return new Response(new Uint8Array(files[file[1]]));
      }
      const method = url.split('/').pop()!;
      const call: Call = { method, body: init?.body ? JSON.parse(init.body as string) : {} };
      calls.push(call);
      const replaced = state.intercept(call);
      if (replaced) return replaced;
      switch (method) {
        case 'getUpdates': {
          // As Telegram does: what lies before the offset is forgotten, the rest comes back every time.
          state.updates = state.updates.filter((update) => update.update_id >= call.body.offset);
          if (state.updates.length > 0) return ok(state.updates);
          if (call.body.timeout === 0) return ok([]);
          return new Promise((_, reject) =>
            init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
          );
        }
        case 'getFile':
          return ok({ file_id: call.body.file_id, file_path: call.body.file_id });
        case 'sendMessage':
          call.messageId = nextMessageId++;
          shown.set(call.messageId, JSON.stringify([call.body.text, call.body.reply_markup]));
          return ok({ message_id: call.messageId });
        case 'editMessageText':
        case 'editMessageReplyMarkup': {
          const current = JSON.parse(shown.get(call.body.message_id) ?? '[]');
          const next = JSON.stringify([call.body.text ?? current[0], call.body.reply_markup]);
          if (next === shown.get(call.body.message_id)) return refused(400, 'Bad Request: message is not modified');
          shown.set(call.body.message_id, next);
          return ok(true);
        }
        default:
          return ok(true);
      }
    }),
  );

  const of = (method: string, chatId?: string) =>
    calls.filter((c) => c.method === method && (chatId === undefined || c.body.chat_id === chatId));
  return {
    calls,
    downloads,
    state,
    of,
    sentTo: (chatId: string) => of('sendMessage', chatId).map((c) => c.body.text as string),
    notices: () => of('answerCallbackQuery').map((c) => c.body.text as string | undefined),
    edits: () => of('editMessageText'),
  };
}

type FakeTelegram = ReturnType<typeof fakeTelegram>;

type Reply = string | LlmBlock[] | Error | ((request: LlmRequest) => Promise<string | LlmBlock[]>);

/** A provider that plays back replies and keeps what it was asked. */
function scripted(...replies: Reply[]) {
  const requests: LlmRequest[] = [];
  const provider: LlmProvider = {
    name: 'scripted',
    model: 'scripted-1',
    configured: true,
    async complete(request): Promise<LlmResponse> {
      requests.push(structuredClone(request));
      let reply = replies.shift();
      if (reply === undefined) throw new Error('no scripted reply left');
      if (reply instanceof Error) throw reply;
      if (typeof reply === 'function') reply = await reply(request);
      const content: LlmBlock[] = typeof reply === 'string' ? [{ type: 'text', text: reply }] : reply;
      return {
        stopReason: content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end',
        content,
        raw: undefined,
        model: 'scripted-1',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
      };
    },
  };
  setProvider(provider);
  return { requests, provider };
}

const toolCall = (name: string, input: unknown): LlmBlock[] => [{ type: 'tool_use', id: `call-${name}`, name, input }];

function gated() {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  return { gate, release };
}
const offered = (request: LlmRequest) => (request.tools ?? []).map((tool) => tool.name);
const lastUserBlocks = (request: LlmRequest) => request.messages.filter((m) => m.role === 'user').at(-1)!.content;
const lastUserText = (request: LlmRequest) => (lastUserBlocks(request)[0] as { text: string }).text;

const log = () => ({ info: vi.fn(), error: vi.fn() });
const send = (update: TelegramUpdate, logger = log()) => handleUpdate(update, logger);

let nextUpdateId = 1;

function messageUpdate(chatId: string, fields: Partial<NonNullable<TelegramUpdate['message']>>, type = 'private'): TelegramUpdate {
  const id = nextUpdateId++;
  return { update_id: id, message: { message_id: id, chat: { id: Number(chatId), type }, ...fields } };
}

const textUpdate = (chatId: string, text: string, type?: string) => messageUpdate(chatId, { text }, type);

function pressUpdate(fromId: string, data: string, messageId: number, chatId = fromId, type = 'private'): TelegramUpdate {
  const id = nextUpdateId++;
  return {
    update_id: id,
    callback_query: {
      id: `press-${id}`,
      from: { id: Number(fromId) },
      data,
      message: { message_id: messageId, chat: { id: Number(chatId), type } },
    },
  };
}

// ─── A farm with a linked person ────────────────────────────────────────────

interface Linked {
  client: Client;
  chatId: string;
}

async function link(f: Fixture, role: Parameters<Fixture['as']>[0]): Promise<Linked> {
  const client = await f.as(role);
  const chatId = String(randomInt(100_000_000, 900_000_000));
  await f.run(() => tx().update(schema.users).set({ telegramChatId: chatId }).where(eq(schema.users.id, client.userId)));
  return { client, chatId };
}

/** Roles other than the managers do not get the assistant by default. */
const grantAi = (f: Fixture, role: keyof typeof DEFAULT_ROLE_PERMISSIONS) =>
  f.run(() =>
    tx()
      .update(schema.roles)
      .set({ permissions: [...DEFAULT_ROLE_PERMISSIONS[role], 'ai.view'] })
      .where(eq(schema.roles.id, f.roleIds[role])),
  );

const setRolePermissions = (f: Fixture, role: keyof typeof DEFAULT_ROLE_PERMISSIONS, permissions: string[]) =>
  f.run(() => tx().update(schema.roles).set({ permissions }).where(eq(schema.roles.id, f.roleIds[role])));

interface World {
  f: Fixture;
  owner: Linked;
  telegram: FakeTelegram;
}

async function world(options: FixtureOptions = {}, files: Record<string, Buffer> = {}): Promise<World> {
  const f = await createFixture(options);
  const owner = await link(f, 'owner');
  const base = { tenantId: f.tenantId, farmId: f.farmId };
  await f.run(() =>
    tx()
      .insert(schema.accounts)
      .values([
        { ...base, name: 'Kassa', type: 'cash', openingBalance: 100_000_000 },
        { ...base, name: 'Agrobank', type: 'bank', openingBalance: 500_000_000 },
      ]),
  );
  return { f, owner, telegram: fakeTelegram(files) };
}

const ELECTRICITY = "Elektrga 3 mln naqd to'ladim";
const electricity = { amount: 3_000_000, category: 'electricity', paymentMethod: 'cash' };

const buttonsOf = (call: Call): { text: string; callback_data: string }[] => (call.body.reply_markup?.inline_keyboard ?? []).flat();
const labelsOf = (call: Call) => buttonsOf(call).map((button) => button.text);
const messageIdOf = (call: Call) => (call.messageId ?? call.body.message_id) as number;

function lastCard(w: World, chatId = w.owner.chatId): Call {
  const card = w.telegram.of('sendMessage', chatId).filter((call) => buttonsOf(call).length > 0).at(-1);
  if (!card) throw new Error('no card was sent');
  return card;
}

/** A pending card, made the real way: the model calls a draft tool inside chat(). */
async function draftCard(w: World, input: unknown = electricity, text = ELECTRICITY, person = w.owner): Promise<Call> {
  scripted(toolCall('draft_expense', input), 'Tasdiqlashingizni kutmoqda.');
  await send(textUpdate(person.chatId, text));
  return lastCard(w, person.chatId);
}

const CONFIRM = 'Tasdiqlash';
const CHANGE = "O'zgartirish";
const CANCEL = 'Bekor qilish';
const UNDO = 'Qaytarish';
const YES_RECORD = 'Ha, yozilsin';

function press(card: Call, label: string, chatId: string = card.body.chat_id, logger = log()) {
  const button = buttonsOf(card).find((b) => b.text === label);
  if (!button) throw new Error(`no "${label}" button on ${JSON.stringify(labelsOf(card))}`);
  return send(pressUpdate(chatId, button.callback_data, messageIdOf(card)), logger);
}

const transactions = (w: World) => w.f.run(() => tx().select().from(schema.transactions));
const proposals = (w: World) => w.f.run(() => tx().select().from(schema.aiProposals));
const conversations = (f: Fixture) => f.run(() => tx().select().from(schema.aiConversations));

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('who is writing', () => {
  it('runs as the sender, with their own tools, and reads their role afresh each time', async () => {
    const f = await createFixture();
    const owner = await link(f, 'owner');
    const shepherd = await link(f, 'shepherd');
    await grantAi(f, 'shepherd');
    const telegram = fakeTelegram();
    const { requests } = scripted('Egasiga javob', "Cho'ponga javob", 'Yana javob');

    await send(textUpdate(owner.chatId, 'Pul qancha?'));
    await send(textUpdate(shepherd.chatId, 'Pul qancha?'));

    expect(offered(requests[0])).toContain('cash_position');
    expect(offered(requests[1])).not.toContain('cash_position');
    expect(telegram.sentTo(owner.chatId).at(-1)).toContain('Egasiga javob');
    expect(telegram.sentTo(shepherd.chatId).at(-1)).toContain("Cho'ponga javob");

    const stored = await conversations(f);
    expect(stored.map((row) => row.userId).sort()).toEqual([owner.client.userId, shepherd.client.userId].sort());
    expect(stored.map((row) => row.channel)).toEqual(['telegram', 'telegram']);

    // Promoted between two messages: no restart, no new login.
    await setRolePermissions(f, 'shepherd', DEFAULT_ROLE_PERMISSIONS.owner);
    await send(textUpdate(shepherd.chatId, 'Endi-chi?'));
    expect(offered(requests[2])).toContain('cash_position');
  });

  it('a role without ai.view gets a plain refusal, and the model is not called', async () => {
    const f = await createFixture();
    const shepherd = await link(f, 'shepherd');
    const telegram = fakeTelegram();
    const { requests } = scripted();

    await send(textUpdate(shepherd.chatId, 'Salom'));
    await send(textUpdate(shepherd.chatId, '/kutilmoqda'));
    await send(textUpdate(shepherd.chatId, '/yangi'));

    expect(requests).toHaveLength(0);
    for (const reply of telegram.sentTo(shepherd.chatId)) expect(reply).toBe(tr('uz', 'alerts', 'bot.noAssistant', { status: '/holat', alerts: '/ogohlantirishlar' }));
  });

  it('a workspace with the AI module switched off is refused the same way', async () => {
    const f = await createFixture({ modules: ['dashboard', 'finance'] });
    const owner = await link(f, 'owner');
    const telegram = fakeTelegram();
    const { requests } = scripted();

    await send(textUpdate(owner.chatId, 'Salom'));

    expect(requests).toHaveLength(0);
    expect(telegram.sentTo(owner.chatId)[0]).toContain('/holat');
  });
});

describe('who is refused', () => {
  it('an unlinked chat gets the linking instructions and nothing else', async () => {
    const telegram = fakeTelegram();
    const { requests } = scripted();

    await send(textUpdate('55501', 'Pul qancha?'));
    await send(messageUpdate('55501', { voice: { file_id: 'v', duration: 1 } }));
    await send(textUpdate('55501', '/kutilmoqda'));

    expect(requests).toHaveLength(0);
    expect(telegram.of('getFile')).toHaveLength(0);
    expect(telegram.of('sendChatAction')).toHaveLength(0);
    expect(telegram.sentTo('55501')).toEqual(Array(3).fill(tr('uz', 'alerts', 'bot.notLinked')));
  });

  it.each(['user', 'membership'] as const)('a %s blocked mid-conversation is refused on the next message', async (what) => {
    const f = await createFixture();
    const owner = await link(f, 'owner');
    const telegram = fakeTelegram();
    const { requests } = scripted('Javob');

    await send(textUpdate(owner.chatId, 'Salom'));
    expect(requests).toHaveLength(1);

    await f.run(async () => {
      if (what === 'user') await tx().update(schema.users).set({ status: 'blocked' }).where(eq(schema.users.id, owner.client.userId));
      else await tx().update(schema.memberships).set({ status: 'blocked' }).where(eq(schema.memberships.id, owner.client.membershipId));
    });

    await send(textUpdate(owner.chatId, 'Yana'));
    await send(textUpdate(owner.chatId, '/holat'));

    expect(requests).toHaveLength(1);
    expect(telegram.sentTo(owner.chatId).slice(-2)).toEqual(Array(2).fill(tr('uz', 'alerts', 'bot.blocked')));
  });

  it('a suspended workspace is refused', async () => {
    const f = await createFixture();
    const owner = await link(f, 'owner');
    const telegram = fakeTelegram();
    const { requests } = scripted();
    await withPlatform((trx) => trx.update(schema.tenants).set({ status: 'suspended' }).where(eq(schema.tenants.id, f.tenantId)));

    await send(textUpdate(owner.chatId, 'Salom'));

    expect(requests).toHaveLength(0);
    expect(telegram.sentTo(owner.chatId)).toEqual([tr('uz', 'alerts', 'bot.blocked')]);
  });

  it('a group chat is refused, even with a linked person in it', async () => {
    const f = await createFixture();
    const owner = await link(f, 'owner');
    const telegram = fakeTelegram();
    const { requests } = scripted();

    await send(textUpdate('-100123', '/holat', 'supergroup'));
    await send(textUpdate('-100123', 'Pul qancha?', 'group'));
    await send(textUpdate(owner.chatId, 'Pul qancha?', 'group')); // the chat id of a person, but not a private chat

    expect(requests).toHaveLength(0);
    expect(telegram.sentTo('-100123')).toEqual([tr('uz', 'alerts', 'bot.groupOnly')]);
    expect(telegram.sentTo(owner.chatId)).toEqual([]);
  });

  it('the team chat that hears about enquiries is left alone, even when someone types a command there', async () => {
    const telegram = fakeTelegram();
    config.LEADS_TELEGRAM_CHAT_ID = '-1001234567';
    try {
      await send(textUpdate('-1001234567', "Men qo'ng'iroq qilaman", 'supergroup'));
      await send(textUpdate('-1001234567', '/holat', 'supergroup'));
    } finally {
      config.LEADS_TELEGRAM_CHAT_ID = undefined;
    }

    expect(telegram.sentTo('-1001234567')).toEqual([]);
  });

  it('2FA policy: an unenrolled owner is pointed to the web app, and enrolling opens the bot', async () => {
    const f = await createFixture({ settings: { security: { enforce2fa: true } } });
    const owner = await link(f, 'owner');
    const telegram = fakeTelegram();
    const { requests } = scripted('Javob');

    await send(textUpdate(owner.chatId, 'Salom'));
    await send(textUpdate(owner.chatId, '/holat'));
    expect(requests).toHaveLength(0);
    expect(telegram.sentTo(owner.chatId)).toEqual(Array(2).fill(tr('uz', 'alerts', 'bot.enroll2fa')));
    expect(tr('uz', 'alerts', 'bot.enroll2fa')).toContain('veb-ilova');

    await f.run(() => tx().update(schema.users).set({ totpEnabled: true }).where(eq(schema.users.id, owner.client.userId)));
    await send(textUpdate(owner.chatId, 'Salom'));
    expect(requests).toHaveLength(1);
  });

  it('2FA policy leaves alone the roles it does not cover', async () => {
    const f = await createFixture({ settings: { security: { enforce2fa: true } } });
    const shepherd = await link(f, 'shepherd');
    await grantAi(f, 'shepherd');
    fakeTelegram();
    const { requests } = scripted('Javob');

    await send(textUpdate(shepherd.chatId, 'Salom'));

    expect(requests).toHaveLength(1);
  });
});

describe('conversations', () => {
  const age = (f: Fixture, conversationId: string, hours: number) => {
    const at = new Date(Date.now() - hours * 3_600_000);
    return f.run(async () => {
      await tx().update(schema.aiMessages).set({ createdAt: at }).where(eq(schema.aiMessages.conversationId, conversationId));
      await tx().update(schema.aiConversations).set({ createdAt: at }).where(eq(schema.aiConversations.id, conversationId));
    });
  };

  it('carries on the same conversation, so a follow-up has its history', async () => {
    const w = await world();
    const { requests } = scripted('Birinchi javob', 'Ikkinchi javob');

    await send(textUpdate(w.owner.chatId, 'Birinchi savol'));
    await send(textUpdate(w.owner.chatId, 'Ikkinchi savol'));

    expect(await conversations(w.f)).toHaveLength(1);
    expect(requests[1].messages.map((m) => (m.content[0] as { text: string }).text)).toEqual([
      'Birinchi savol',
      'Birinchi javob',
      'Ikkinchi savol',
    ]);
  });

  it('reuses one quiet for 11 hours, and starts afresh after 13', async () => {
    const w = await world();
    scripted('1', '2', '3');

    await send(textUpdate(w.owner.chatId, 'Bir'));
    const [first] = await conversations(w.f);
    await age(w.f, first.id, 11);
    await send(textUpdate(w.owner.chatId, 'Ikki'));
    expect(await conversations(w.f)).toHaveLength(1);

    await age(w.f, first.id, 13);
    await send(textUpdate(w.owner.chatId, 'Uch'));
    expect(await conversations(w.f)).toHaveLength(2);
  });

  it('counts from the last message, so a long working day is not cut in two', async () => {
    const w = await world();
    scripted('1', '2');

    await send(textUpdate(w.owner.chatId, 'Bir'));
    const [first] = await conversations(w.f);
    await w.f.run(() =>
      tx().update(schema.aiConversations).set({ createdAt: new Date(Date.now() - 20 * 3_600_000) }).where(eq(schema.aiConversations.id, first.id)),
    );
    await send(textUpdate(w.owner.chatId, 'Ikki'));

    expect(await conversations(w.f)).toHaveLength(1);
  });

  it('never picks up a conversation from the web, or someone else\'s', async () => {
    const w = await world();
    const director = await link(w.f, 'director');
    scripted('Webdan javob', 'Direktorga', 'Egasiga');

    expect((await w.owner.client.post('/ai/chat', { message: 'Web savol' })).status).toBe(200);
    await send(textUpdate(director.chatId, 'Salom'));
    await send(textUpdate(w.owner.chatId, 'Salom'));

    const stored = await conversations(w.f);
    expect(stored).toHaveLength(3);
    expect(stored.filter((row) => row.channel === 'telegram')).toHaveLength(2);
  });

  it('/yangi starts a new one, and the conversation after it continues normally', async () => {
    const w = await world();
    const { requests } = scripted('1', '2', '3');

    await send(textUpdate(w.owner.chatId, 'Eski mavzu'));
    await send(textUpdate(w.owner.chatId, '/yangi'));
    expect(w.telegram.sentTo(w.owner.chatId).at(-1)).toBe(tr('uz', 'alerts', 'bot.newConversation'));
    await send(textUpdate(w.owner.chatId, 'Yangi mavzu'));
    await send(textUpdate(w.owner.chatId, 'Davomi'));

    expect(await conversations(w.f)).toHaveLength(2);
    expect(requests[1].messages).toHaveLength(1); // nothing of the old topic reaches the model
    expect(requests[2].messages).toHaveLength(3);
  });
});

describe('/yangi and a turn from before it', () => {
  it('the turn finishing afterwards does not cancel it: the next message starts afresh', async () => {
    const w = await world();
    const { gate, release } = gated();
    scripted(
      async () => {
        await gate;
        return 'Eski javob';
      },
      'Yangi javob',
    );
    const stale = send(textUpdate(w.owner.chatId, 'Uzoq savol'));
    await vi.waitFor(() => expect(w.telegram.of('sendChatAction').length).toBeGreaterThan(0));

    await send(textUpdate(w.owner.chatId, '/yangi'));
    release();
    await stale;
    await send(textUpdate(w.owner.chatId, 'Boshqa mavzu'));

    expect(await conversations(w.f)).toHaveLength(2);
  });

  it('a first turn that fails still leaves the next message to start afresh', async () => {
    const w = await world();
    scripted('Birinchi', new Error('model down'), 'Javob');
    await send(textUpdate(w.owner.chatId, 'Salom'));
    await send(textUpdate(w.owner.chatId, '/yangi'));

    await send(textUpdate(w.owner.chatId, 'Boshqa'));
    await send(textUpdate(w.owner.chatId, 'Yana boshqa'));

    expect(await conversations(w.f)).toHaveLength(3);
  });
});

describe('proposal cards', () => {
  it('a draft becomes a card with Confirm, Change and Cancel, and nothing is written yet', async () => {
    const w = await world();

    const card = await draftCard(w);

    expect(card.body.text).toContain('3 000 000');
    expect(labelsOf(card)).toEqual([CONFIRM, CHANGE, CANCEL]);
    expect(await transactions(w)).toHaveLength(0);
    const [proposal] = await proposals(w);
    expect(proposal).toMatchObject({ status: 'pending', channel: 'telegram', userId: w.owner.client.userId });
    for (const button of buttonsOf(card)) expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
  });

  it('escapes what the person typed on the card', async () => {
    const w = await world();

    const card = await draftCard(w, { ...electricity, description: '<b>svet</b> & gaz' });

    expect(card.body.text).toContain('&lt;b&gt;svet&lt;/b&gt; &amp; gaz');
    expect(card.body.parse_mode).toBe('HTML');
  });

  it('Confirm records it as the presser, edits the card in place, and offers Undo', async () => {
    const w = await world();
    const card = await draftCard(w);
    const before = w.telegram.of('sendMessage').length;

    await press(card, CONFIRM);

    const [entry, ...others] = await transactions(w);
    expect(others).toEqual([]);
    expect(entry).toMatchObject({ amount: 3_000_000, status: 'approved', createdBy: w.owner.client.userId, costTreatment: 'expense' });

    const [edit, ...moreEdits] = w.telegram.edits();
    expect(moreEdits).toEqual([]);
    expect(edit.body.message_id).toBe(card.messageId);
    expect(edit.body.text).toContain('3 000 000');
    expect(edit.body.text).toContain(tr('uz', 'alerts', 'bot.recorded'));
    expect(labelsOf(edit)).toEqual([UNDO]);
    expect(w.telegram.of('sendMessage')).toHaveLength(before); // in place, not a new message
    expect(w.telegram.notices()).toEqual([undefined]);

    const events = await w.f.run(() => tx().select().from(schema.events).where(eq(schema.events.type, 'ai_proposal.confirmed')));
    expect(events).toHaveLength(1);
  });

  it('Undo takes the money back and the card says so, with no button left', async () => {
    const w = await world();
    const card = await draftCard(w);
    await press(card, CONFIRM);

    await press(w.telegram.edits().at(-1)!, UNDO);

    const [entry] = await transactions(w);
    expect(entry.status).toBe('rejected');
    const edit = w.telegram.edits().at(-1)!;
    expect(edit.body.text).toContain(tr('uz', 'alerts', 'bot.undone'));
    expect(edit.body.reply_markup).toBeUndefined();
  });

  it('the Undo button is taken off when the window closes, leaving the text alone', async () => {
    const w = await world();
    const card = await draftCard(w);
    const timers = vi.spyOn(globalThis, 'setTimeout');

    await press(card, CONFIRM);

    const scheduled = timers.mock.calls.find(([, ms]) => (ms ?? 0) > 14 * 60_000 && (ms ?? 0) <= 15 * 60_000);
    expect(scheduled).toBeDefined();
    (scheduled![0] as () => void)();
    await vi.waitFor(() => expect(w.telegram.of('editMessageReplyMarkup')).toHaveLength(1));
    expect(w.telegram.of('editMessageReplyMarkup')[0].body).toEqual({ chat_id: w.owner.chatId, message_id: card.messageId });
    expect(w.telegram.edits()).toHaveLength(1);
  });

  it('a press after the window closes is refused, and the button goes', async () => {
    const w = await world();
    const card = await draftCard(w);
    await press(card, CONFIRM);
    const confirmed = w.telegram.edits().at(-1)!;
    await w.f.run(() => tx().update(schema.aiProposals).set({ undoUntil: new Date(Date.now() - 1000) }));

    await press(confirmed, UNDO);

    expect((await transactions(w))[0].status).toBe('approved');
    expect(w.telegram.notices().at(-1)).toBe(tr('uz', 'ai', 'errors.UNDO_EXPIRED'));
    expect(w.telegram.edits().at(-1)!.body.reply_markup).toBeUndefined();
  });

  it('Cancel drops the draft, and nothing reaches the books', async () => {
    const w = await world();
    const card = await draftCard(w);

    await press(card, CANCEL);

    expect((await proposals(w))[0].status).toBe('rejected');
    expect(await transactions(w)).toHaveLength(0);
    const edit = w.telegram.edits().at(-1)!;
    expect(edit.body.text).toContain(tr('uz', 'alerts', 'bot.cancelled'));
    expect(edit.body.reply_markup).toBeUndefined();
  });

  it('a large amount waits for a second person and offers no Undo', async () => {
    const w = await world();
    const card = await draftCard(w, { ...electricity, amount: 9_000_000 }, "Elektrga 9 mln naqd to'ladim");
    expect(card.body.text).toContain('9 000 000');

    await press(card, CONFIRM);

    expect((await transactions(w))[0].status).toBe('pending');
    const edit = w.telegram.edits().at(-1)!;
    expect(edit.body.text).toContain(tr('uz', 'alerts', 'bot.waitingApproval'));
    expect(edit.body.reply_markup).toBeUndefined();
  });

  it('a double tap, one after the other, records once and both presses are answered', async () => {
    const w = await world();
    const card = await draftCard(w);

    await press(card, CONFIRM);
    await press(card, CONFIRM);

    expect(await transactions(w)).toHaveLength(1);
    expect(w.telegram.of('answerCallbackQuery')).toHaveLength(2);
    expect(w.telegram.notices()[1]).toBe(tr('uz', 'ai', 'errors.PROPOSAL_NOT_PENDING'));
    expect(w.telegram.edits()).toHaveLength(2);
    expect((await w.owner.client.get('/ai/proposals')).data).toEqual([]);
  });

  it('a double tap racing itself still records once: the row lock decides', async () => {
    const w = await world();
    const card = await draftCard(w);

    await Promise.all([press(card, CONFIRM), press(card, CONFIRM)]);

    expect(await transactions(w)).toHaveLength(1);
    expect(w.telegram.of('answerCallbackQuery')).toHaveLength(2);
  });

  it('someone else\'s press is refused, whatever the farm, and changes nothing', async () => {
    const w = await world();
    const director = await link(w.f, 'director');
    const card = await draftCard(w);

    await press(card, CONFIRM, director.chatId);
    await press(card, CANCEL, director.chatId);
    await press(card, CHANGE, director.chatId);

    const stranger = await world();
    await press(card, CONFIRM, stranger.owner.chatId);

    expect(await transactions(w)).toHaveLength(0);
    expect((await proposals(w))[0].status).toBe('pending');
    expect(stranger.telegram.of('editMessageText')).toHaveLength(0);
    expect(stranger.telegram.of('sendMessage')).toHaveLength(0);
    expect(stranger.telegram.notices()).toEqual([tr('uz', 'common', 'errors.NOT_FOUND')]);
  });

  it('someone else\'s press on the same farm is told whose it is', async () => {
    const w = await world();
    const director = await link(w.f, 'director');
    const card = await draftCard(w);

    await press(card, CONFIRM, director.chatId);

    expect(w.telegram.notices()).toEqual([tr('uz', 'ai', 'errors.NOT_YOUR_PROPOSAL')]);
    expect(w.telegram.edits()).toHaveLength(0);
  });

  it('a possible duplicate needs a second, different tap', async () => {
    const w = await world();
    await press(await draftCard(w), CONFIRM);
    expect(await transactions(w)).toHaveLength(1);

    const card = await draftCard(w);
    const pending = (await w.owner.client.get('/ai/proposals')).data as { needsAcknowledgement: boolean }[];
    expect(pending.map((p) => p.needsAcknowledgement)).toEqual([true]);

    await press(card, CONFIRM);
    expect(await transactions(w)).toHaveLength(1);
    const asked = w.telegram.edits().at(-1)!;
    expect(asked.body.message_id).toBe(card.messageId);
    expect(asked.body.text).toContain(tr('uz', 'alerts', 'bot.acknowledgeAsk'));
    expect(asked.body.text).toContain(tr('uz', 'ai', 'recordText.warnings.POSSIBLE_DUPLICATE'));
    // A second tap lands where Confirm was, so that place holds neither the yes nor Cancel.
    expect(labelsOf(asked)).toEqual([CHANGE, YES_RECORD, CANCEL]);

    // The second tap of a double tap still lands on Confirm, and proves nothing.
    await press(card, CONFIRM);
    expect(await transactions(w)).toHaveLength(1);

    await press(asked, YES_RECORD);
    expect(await transactions(w)).toHaveLength(2);
    expect(w.telegram.edits().at(-1)!.body.text).toContain(tr('uz', 'alerts', 'bot.recorded'));
  });

  it('a card charged to General by default has no bare warning under the line that already says it', async () => {
    const w = await world();

    const card = await draftCard(w);

    expect(card.body.text).toContain(tr('uz', 'ai', 'recordText.defaulted'));
    expect(card.body.text).not.toContain(tr('uz', 'alerts', 'bot.checkThis'));
  });

  it('an expired card says so and loses its buttons', async () => {
    const w = await world();
    const card = await draftCard(w);
    await w.f.run(() => tx().update(schema.aiProposals).set({ expiresAt: new Date(Date.now() - 1000) }));

    await press(card, CONFIRM);

    expect(await transactions(w)).toHaveLength(0);
    expect(w.telegram.notices()).toEqual([tr('uz', 'ai', 'errors.PROPOSAL_EXPIRED')]);
    const edit = w.telegram.edits().at(-1)!;
    expect(edit.body.text).toContain(tr('uz', 'alerts', 'bot.expired'));
    expect(edit.body.reply_markup).toBeUndefined();
  });

  it('Change asks what to change, and the reply goes through chat() to a new card', async () => {
    const w = await world();
    const card = await draftCard(w);
    const { requests } = scripted(
      async (request) => {
        const id = /Open card ([0-9a-f-]{36})/.exec(request.context!)![1];
        return toolCall('update_draft', { proposalId: id, changes: { amount: 4_000_000 } });
      },
      'Yangilandi.',
    );

    await press(card, CHANGE);

    expect(w.telegram.sentTo(w.owner.chatId).at(-1)).toBe(tr('uz', 'alerts', 'bot.changePrompt'));
    expect(w.telegram.edits()).toHaveLength(0);
    expect(w.telegram.notices()).toEqual([undefined]);
    expect(requests).toHaveLength(0);

    await send(textUpdate(w.owner.chatId, 'Aslida 4 mln edi'));

    expect(lastUserText(requests[0])).toBe('Aslida 4 mln edi');
    const updated = lastCard(w);
    expect(updated.messageId).not.toBe(card.messageId);
    expect(updated.body.text).toContain('4 000 000');
    expect(await proposals(w)).toHaveLength(1);

    await press(updated, CONFIRM);
    expect((await transactions(w))[0].amount).toBe(4_000_000);
  });

  it('Confirm on a card that has since changed records nothing and shows the change', async () => {
    const w = await world();
    const stale = await draftCard(w);
    scripted(
      async (request) => {
        const id = /Open card ([0-9a-f-]{36})/.exec(request.context!)![1];
        return toolCall('update_draft', { proposalId: id, changes: { amount: 4_000_000 } });
      },
      'Yangilandi.',
    );
    await send(textUpdate(w.owner.chatId, 'Aslida 4 mln edi'));

    await press(stale, CONFIRM);

    expect(await transactions(w)).toHaveLength(0);
    expect(w.telegram.notices()).toEqual([tr('uz', 'alerts', 'bot.cardChanged')]);
    const refreshed = w.telegram.edits().at(-1)!;
    expect(refreshed.body.message_id).toBe(stale.messageId);
    expect(refreshed.body.text).toContain('4 000 000');

    await press(refreshed, CONFIRM);
    expect((await transactions(w))[0].amount).toBe(4_000_000);
  });

  it('/kutilmoqda lists drafts from any channel, and a web draft offers no Change', async () => {
    const w = await world();
    await draftCard(w);
    scripted(toolCall('draft_expense', { ...electricity, amount: 2_000_000 }), 'Tasdiqlang.');
    expect((await w.owner.client.post('/ai/chat', { message: "Elektrga 2 mln naqd to'ladim" })).status).toBe(200);
    const before = w.telegram.of('sendMessage').length;

    await send(textUpdate(w.owner.chatId, '/kutilmoqda'));

    const [count, telegramCard, webCard] = w.telegram.of('sendMessage').slice(before);
    expect(count.body.text).toBe(tr('uz', 'alerts', 'bot.pendingCount', { count: 2 }));
    expect(labelsOf(telegramCard)).toEqual([CONFIRM, CHANGE, CANCEL]);
    expect(labelsOf(webCard)).toEqual([CONFIRM, CANCEL]);
    expect(webCard.body.text).toContain('2 000 000');

    await press(webCard, CONFIRM);
    expect((await transactions(w))[0].amount).toBe(2_000_000);
  });

  it('/kutilmoqda with nothing waiting says so', async () => {
    const w = await world();

    await send(textUpdate(w.owner.chatId, '/kutilmoqda'));

    expect(w.telegram.sentTo(w.owner.chatId)).toEqual([tr('uz', 'alerts', 'bot.noPending')]);
  });

  it('two records in one message give two cards', async () => {
    const w = await world();
    scripted(
      [
        ...toolCall('draft_expense', { ...electricity, amount: 3_000_000 }),
        { type: 'tool_use', id: 'second', name: 'draft_expense', input: { amount: 500_000, category: 'meals', paymentMethod: 'cash' } },
      ],
      'Ikkalasini tasdiqlang.',
    );

    await send(textUpdate(w.owner.chatId, "Elektrga 3 mln, tushlikka 500 ming naqd to'ladim"));

    const cards = w.telegram.of('sendMessage', w.owner.chatId).filter((call) => buttonsOf(call).length > 0);
    expect(cards).toHaveLength(2);
    expect(new Set(cards.map((card) => card.messageId)).size).toBe(2);
  });
});

describe('a turn that corrects itself', () => {
  it('gives one card, with the last version', async () => {
    const w = await world();
    const correct = (id: string) => toolCall('update_draft', { proposalId: id, changes: { description: 'Noyabr uchun' } });
    scripted(
      toolCall('draft_expense', electricity),
      async (request) => {
        const result = request.messages.at(-1)!.content[0] as { content: string };
        return correct(/"proposalId":"([0-9a-f-]{36})"/.exec(result.content)![1]);
      },
      'Tasdiqlang.',
    );

    await send(textUpdate(w.owner.chatId, "Elektrga 3 mln naqd to'ladim, noyabr uchun"));

    const cards = w.telegram.of('sendMessage', w.owner.chatId).filter((call) => buttonsOf(call).length > 0);
    expect(cards).toHaveLength(1);
    expect(cards[0].body.text).toContain('Noyabr uchun');
  });
});

describe('a press is checked like a message', () => {
  it('a person blocked since the card was sent cannot confirm it', async () => {
    const w = await world();
    const card = await draftCard(w);
    await w.f.run(() => tx().update(schema.users).set({ status: 'blocked' }).where(eq(schema.users.id, w.owner.client.userId)));

    await press(card, CONFIRM);

    expect(await transactions(w)).toHaveLength(0);
    expect(w.telegram.notices()).toEqual([tr('uz', 'alerts', 'bot.blocked')]);
  });

  it('a role that lost ai.view cannot, even with finance.create', async () => {
    const w = await world();
    const card = await draftCard(w);
    await setRolePermissions(w.f, 'owner', DEFAULT_ROLE_PERMISSIONS.owner.filter((p) => p !== 'ai.view'));

    await press(card, CONFIRM);
    await press(card, CANCEL);

    expect(await transactions(w)).toHaveLength(0);
    expect((await proposals(w))[0].status).toBe('pending');
    expect(w.telegram.edits()).toHaveLength(0);
  });

  it('a role that lost finance.create is refused by the service, as on the web', async () => {
    const w = await world();
    const card = await draftCard(w);
    await setRolePermissions(w.f, 'owner', DEFAULT_ROLE_PERMISSIONS.owner.filter((p) => p !== 'finance.create'));

    await press(card, CONFIRM);

    expect(await transactions(w)).toHaveLength(0);
    expect(w.telegram.notices()).toEqual([tr('uz', 'common', 'errors.FORBIDDEN')]);
    expect(w.telegram.edits()).toHaveLength(0);
  });

  it('2FA policy turned on since the card was sent stops the press', async () => {
    const w = await world();
    const card = await draftCard(w);
    await withPlatform((trx) =>
      trx.update(schema.tenants).set({ settings: { security: { enforce2fa: true } } }).where(eq(schema.tenants.id, w.f.tenantId)),
    );

    await press(card, CONFIRM);

    expect(await transactions(w)).toHaveLength(0);
    expect(w.telegram.notices()).toEqual([tr('uz', 'alerts', 'bot.enroll2fa')]);
  });

  it('an unlinked presser is told how to link, and nothing happens', async () => {
    const w = await world();
    const card = await draftCard(w);

    await press(card, CONFIRM, '999000111');

    expect(await transactions(w)).toHaveLength(0);
    expect(w.telegram.notices()).toEqual([tr('uz', 'alerts', 'bot.notLinked')]);
  });

  it('a press from a group is refused, and so is one from another person\'s chat', async () => {
    const w = await world();
    const card = await draftCard(w);
    const data = buttonsOf(card)[0].callback_data;

    await send(pressUpdate(w.owner.chatId, data, card.messageId!, '-100555', 'supergroup'));
    await send(pressUpdate(w.owner.chatId, data, card.messageId!, '12345'));

    expect(await transactions(w)).toHaveLength(0);
    expect(w.telegram.notices()).toEqual(Array(2).fill(tr('uz', 'alerts', 'bot.groupOnly')));
  });

  it.each([
    ['unknown data', 'something-else'],
    ['no data', undefined],
  ])('%s gets an answer rather than a spinning button', async (_name, data) => {
    const w = await world();

    await send(pressUpdate(w.owner.chatId, data as string, 1));

    expect(w.telegram.notices()).toEqual([tr('uz', 'alerts', 'bot.stale')]);
  });

  it('data shaped like a card but not a real id is a stale button, not a database error', async () => {
    const w = await world();
    const logger = log();

    await send(pressUpdate(w.owner.chatId, `p:c:${'-'.repeat(36)}:deadbeefdead`, 1), logger);

    expect(w.telegram.notices()).toEqual([tr('uz', 'alerts', 'bot.stale')]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('a press on a message Telegram no longer sends is answered too', async () => {
    const w = await world();
    const update = pressUpdate(w.owner.chatId, 'p:c:01234567-89ab-7def-8123-456789abcdef:deadbeef', 1);
    delete update.callback_query!.message;

    await send(update);

    expect(w.telegram.notices()).toEqual([tr('uz', 'alerts', 'bot.stale')]);
  });

  describe('when the card cannot be edited', () => {
    const noEdits = (w: World, also: string[] = []) => {
      w.telegram.state.intercept = (call) =>
        ['editMessageText', ...also].includes(call.method) ? refused(400, "Bad Request: message can't be edited") : undefined;
    };

    it('a Confirm that went through is reported as recorded, on a new card with Undo, and the cause is logged', async () => {
      const w = await world();
      const card = await draftCard(w);
      noEdits(w);
      const logger = log();

      await press(card, CONFIRM, w.owner.chatId, logger);

      expect(await transactions(w)).toHaveLength(1);
      expect(w.telegram.notices()).toEqual([tr('uz', 'alerts', 'bot.recorded')]);
      const fresh = lastCard(w);
      expect(fresh.messageId).not.toBe(card.messageId);
      expect(fresh.body.text).toContain(tr('uz', 'alerts', 'bot.recorded'));
      expect(labelsOf(fresh)).toEqual([UNDO]);
      expect(JSON.stringify(logger.error.mock.calls)).toContain("can't be edited");
    });

    it('says so even when no message can be sent either', async () => {
      const w = await world();
      const card = await draftCard(w);
      noEdits(w, ['sendMessage']);

      await press(card, CONFIRM);

      expect(await transactions(w)).toHaveLength(1);
      expect(w.telegram.notices()).toEqual([tr('uz', 'alerts', 'bot.recorded')]);
    });

    it('an Undo and a Cancel that went through say what happened', async () => {
      const w = await world();
      const confirmed = await draftCard(w);
      await press(confirmed, CONFIRM);
      const undo = w.telegram.edits().at(-1)!;
      const cancelled = await draftCard(w, { ...electricity, amount: 2_000_000 }, "Elektrga 2 mln naqd to'ladim");
      noEdits(w);

      await press(undo, UNDO);
      await press(cancelled, CANCEL);

      expect(w.telegram.notices().slice(-2)).toEqual([tr('uz', 'alerts', 'bot.undone'), tr('uz', 'alerts', 'bot.cancelled')]);
      expect((await proposals(w)).map((p) => p.status).sort()).toEqual(['rejected', 'undone']);
    });

    it('an out-of-date press still says so, and the new card can be acted on', async () => {
      const w = await world();
      const stale = await draftCard(w);
      scripted(
        async (request) => toolCall('update_draft', { proposalId: /Open card ([0-9a-f-]{36})/.exec(request.context!)![1], changes: { amount: 4_000_000 } }),
        'Yangilandi.',
      );
      await send(textUpdate(w.owner.chatId, 'Aslida 4 mln edi'));
      noEdits(w);

      await press(stale, CONFIRM);

      expect(await transactions(w)).toHaveLength(0);
      expect(w.telegram.notices()).toEqual([tr('uz', 'alerts', 'bot.cardChanged')]);
      const fresh = lastCard(w);
      expect(fresh.body.text).toContain('4 000 000');
      expect(labelsOf(fresh)).toContain(CONFIRM);
    });
  });
});

describe('the Undo button', () => {
  it('goes when the window closes, also on a copy of the card brought up to date by a press', async () => {
    const w = await world();
    await draftCard(w);
    await send(textUpdate(w.owner.chatId, '/kutilmoqda'));
    const copy = lastCard(w);
    const first = w.telegram.of('sendMessage', w.owner.chatId).filter((call) => buttonsOf(call).length > 0)[0];
    await press(first, CONFIRM);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await press(copy, CONFIRM); // already handled, so this refreshes the copy and offers Undo
      expect(w.telegram.notices().at(-1)).toBe(tr('uz', 'ai', 'errors.PROPOSAL_NOT_PENDING'));
      expect(labelsOf(w.telegram.edits().at(-1)!)).toEqual([UNDO]);

      await vi.advanceTimersByTimeAsync(16 * 60_000);
    } finally {
      vi.useRealTimers();
    }

    await vi.waitFor(() => expect(w.telegram.of('editMessageReplyMarkup').map((call) => call.body.message_id)).toContain(copy.messageId));
  });
});

describe('a refusal with figures in it', () => {
  it('reads as a sentence, with the figure in place of the template', async () => {
    const w = await world();
    scripted(new AppError(409, 'AMOUNT_EXCEEDS_DEBT', 'Only 1500000 is outstanding', { outstanding: 1_500_000 }));

    await send(textUpdate(w.owner.chatId, 'Salom'));

    const [text] = w.telegram.sentTo(w.owner.chatId);
    expect(text).toContain('1 500 000');
    expect(text).not.toContain('{{');
  });
});

describe('a Confirm the service refuses', () => {
  const closeAccounts = (w: World) => w.f.run(() => tx().update(schema.accounts).set({ active: false }));

  it('a card waiting for an answer offers no Confirm, and an old Confirm is refused', async () => {
    const w = await world();
    const card = await draftCard(w);
    await w.f.run(async () => {
      const [row] = await tx().select().from(schema.aiProposals);
      await tx().update(schema.aiProposals).set({ fields: { ...row.fields, _pending: { amount: 4_000_000 } } });
    });

    await press(card, CONFIRM);

    expect(await transactions(w)).toHaveLength(0);
    const edit = w.telegram.edits().at(-1)!;
    expect(edit.body.text).toContain(tr('uz', 'alerts', 'bot.needsAnswer'));
    expect(labelsOf(edit)).toEqual([CHANGE, CANCEL]);

    await send(textUpdate(w.owner.chatId, '/kutilmoqda'));
    expect(labelsOf(lastCard(w))).toEqual([CHANGE, CANCEL]);
  });

  it('something on the card closed: nothing is recorded, and it offers Change or Cancel', async () => {
    const w = await world();
    const card = await draftCard(w);
    await closeAccounts(w);

    await press(card, CONFIRM);

    expect(await transactions(w)).toHaveLength(0);
    const edit = w.telegram.edits().at(-1)!;
    expect(edit.body.text).toContain(tr('uz', 'alerts', 'bot.cardStale'));
    expect(labelsOf(edit)).toEqual([CHANGE, CANCEL]);
  });

  it('every button fits in Telegram\'s 64 bytes', async () => {
    const w = await world();
    await press(await draftCard(w), CONFIRM);
    const stale = await draftCard(w);
    await press(stale, CONFIRM); // the same record again, so it asks for the explicit yes

    const buttons = [...w.telegram.of('sendMessage'), ...w.telegram.edits()].flatMap(buttonsOf);
    expect(new Set(buttons.map((button) => button.text)).size).toBeGreaterThanOrEqual(5);
    for (const button of buttons) expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
  });
});

/** The owner also works on a second workspace. */
async function withSecondFarm(w: World, role: 'owner' | 'accountant' = 'owner') {
  const second = await createFixture();
  await second.run(() =>
    tx().insert(schema.accounts).values({ tenantId: second.tenantId, farmId: second.farmId, name: 'Kassa', type: 'cash', openingBalance: 100_000_000 }),
  );
  const [user] = await withPlatform((trx) => trx.select().from(schema.users).where(eq(schema.users.id, w.owner.client.userId)));
  const { membershipId } = await addMember({
    tenantId: second.tenantId,
    farmId: second.farmId,
    roleId: second.roleIds[role],
    phone: user.phone,
    fullName: user.fullName,
    password: 'Password123!',
  });
  return { ...w, second, membershipId };
}

describe('someone on several farms', () => {
  const onTwoFarms = async (role: 'owner' | 'accountant' = 'owner') => withSecondFarm(await world(), role);

  const farmButtons = (call: Call) => buttonsOf(call).filter((button) => button.callback_data.startsWith('f:'));
  const chooseSecond = async (w: Awaited<ReturnType<typeof onTwoFarms>>) => {
    await send(pressUpdate(w.owner.chatId, `f:${w.membershipId}`, 1));
  };

  it('is asked which farm before anything is read, and the message goes nowhere', async () => {
    const w = await onTwoFarms();
    const { requests } = scripted();

    await send(textUpdate(w.owner.chatId, ELECTRICITY));

    expect(requests).toHaveLength(0);
    const [asked, ...rest] = w.telegram.of('sendMessage', w.owner.chatId);
    expect(rest).toEqual([]);
    expect(asked.body.text).toBe(tr('uz', 'alerts', 'bot.chooseFarm'));
    expect(farmButtons(asked)).toHaveLength(2);
    expect(await proposals(w)).toEqual([]);
  });

  it('commands wait for the choice too', async () => {
    const w = await onTwoFarms();

    await send(textUpdate(w.owner.chatId, '/holat'));

    expect(farmButtons(lastCard(w))).toHaveLength(2);
    expect(w.telegram.sentTo(w.owner.chatId)).toEqual([tr('uz', 'alerts', 'bot.chooseFarm')]);
  });

  it('after choosing, a record lands on that farm and its card names the farm', async () => {
    const w = await onTwoFarms();
    await chooseSecond(w);

    const card = await draftCard(w);
    await press(card, CONFIRM);

    const [farm] = await w.second.run(() => tx().select({ name: schema.farms.name }).from(schema.farms));
    expect(card.body.text).toContain(`${tr('uz', 'ai', 'recordText.farm')}: `);
    expect(card.body.text).toContain(farm.name);
    expect(await transactions(w)).toHaveLength(0);
    expect(await w.second.run(() => tx().select().from(schema.transactions))).toHaveLength(1);
  });

  it('/ferma shows where this chat works and switches it; a card of the other farm says so', async () => {
    const w = await onTwoFarms();
    await send(pressUpdate(w.owner.chatId, `f:${w.owner.client.membershipId}`, 1));
    const card = await draftCard(w);

    await send(textUpdate(w.owner.chatId, '/ferma'));
    const list = w.telegram.of('sendMessage', w.owner.chatId).at(-1)!;
    expect(farmButtons(list).filter((button) => button.text.startsWith('✓'))).toHaveLength(1);
    await send(pressUpdate(w.owner.chatId, farmButtons(list).find((button) => !button.text.startsWith('✓'))!.callback_data, list.messageId!));

    await press(card, CONFIRM);

    expect(w.telegram.notices().at(-1)).toBe(tr('uz', 'alerts', 'bot.otherFarm', { farm: '/ferma' }));
    expect(await transactions(w)).toHaveLength(0);
  });

  it('a farm that is not theirs cannot be chosen by a crafted press', async () => {
    const w = await onTwoFarms();
    const stranger = await w.second.as('director');

    await send(pressUpdate(w.owner.chatId, `f:${stranger.membershipId}`, 1));

    expect(w.telegram.notices()).toEqual([tr('uz', 'alerts', 'bot.stale')]);
    const [row] = await withPlatform((trx) => trx.select().from(schema.users).where(eq(schema.users.id, w.owner.client.userId)));
    expect(row.telegramMembershipId).toBeNull();
  });

  it('a chosen farm that ended is never swapped for another without asking', async () => {
    const w = await onTwoFarms();
    await chooseSecond(w);
    await withPlatform((trx) => trx.update(schema.memberships).set({ status: 'blocked' }).where(eq(schema.memberships.id, w.membershipId)));
    const { requests } = scripted();

    await send(textUpdate(w.owner.chatId, ELECTRICITY));

    expect(requests).toHaveLength(0);
    expect(w.telegram.sentTo(w.owner.chatId).at(-1)).toBe(tr('uz', 'alerts', 'bot.chooseFarm'));
  });

  it('a workspace without the assistant does not stop them reaching the one that has it', async () => {
    const f = await createFixture({ modules: ['livestock'] });
    const person = await link(f, 'owner');
    const second = await createFixture();
    const [user] = await withPlatform((trx) => trx.select().from(schema.users).where(eq(schema.users.id, person.client.userId)));
    const { membershipId } = await addMember({
      tenantId: second.tenantId,
      farmId: second.farmId,
      roleId: second.roleIds.owner,
      phone: user.phone,
      fullName: user.fullName,
      password: 'Password123!',
    });
    const telegram = fakeTelegram();
    await send(pressUpdate(person.chatId, `f:${membershipId}`, 1));
    scripted('Salom');

    await send(textUpdate(person.chatId, 'Salom'));

    expect(telegram.sentTo(person.chatId).at(-1)).toBe('Salom');
  });

  describe('a message and a farm press behind a stuck turn', () => {
    const onFirstFarm = async () => {
      const w = await onTwoFarms();
      await send(pressUpdate(w.owner.chatId, `f:${w.owner.client.membershipId}`, 1));
      return w;
    };
    const onSecond = (w: Awaited<ReturnType<typeof onTwoFarms>>) => w.second.run(() => tx().select().from(schema.aiProposals));

    it('what was written before the press stays on the old farm, and the press is answered at once', async () => {
      const w = await onFirstFarm();
      const { gate, release } = gated();
      scripted(
        async () => {
          await gate;
          return 'Eski javob';
        },
        toolCall('draft_expense', electricity),
        'Tasdiqlang.',
      );
      w.telegram.state.updates.push(textUpdate(w.owner.chatId, 'Uzoq savol'));
      const stop = startTelegramBot(log());
      await vi.waitFor(() => expect(w.telegram.of('sendChatAction').length).toBeGreaterThan(0));

      w.telegram.state.updates.push(textUpdate(w.owner.chatId, ELECTRICITY), pressUpdate(w.owner.chatId, `f:${w.membershipId}`, 2));
      await vi.waitFor(() => expect(w.telegram.notices()).toContain(tr('uz', 'alerts', 'bot.farmAfterTurn')), { timeout: 5_000 });
      release();
      await stop();

      expect(await proposals(w)).toHaveLength(1);
      expect(await onSecond(w)).toEqual([]);
      const [user] = await withPlatform((trx) => trx.select().from(schema.users).where(eq(schema.users.id, w.owner.client.userId)));
      expect(user.telegramMembershipId).toBe(w.membershipId);
      expect(w.telegram.notices()).toHaveLength(2); // a press takes one answer
    });

    it('what was written after the press lands on the new farm', async () => {
      const w = await onFirstFarm();
      const { gate, release } = gated();
      scripted(
        async () => {
          await gate;
          return 'Eski javob';
        },
        toolCall('draft_expense', electricity),
        'Tasdiqlang.',
      );
      w.telegram.state.updates.push(textUpdate(w.owner.chatId, 'Uzoq savol'));
      const stop = startTelegramBot(log());
      await vi.waitFor(() => expect(w.telegram.of('sendChatAction').length).toBeGreaterThan(0));

      w.telegram.state.updates.push(pressUpdate(w.owner.chatId, `f:${w.membershipId}`, 2), textUpdate(w.owner.chatId, ELECTRICITY));
      await vi.waitFor(() => expect(w.telegram.notices()).toContain(tr('uz', 'alerts', 'bot.farmAfterTurn')), { timeout: 5_000 });
      release();
      await stop();

      expect(await proposals(w)).toEqual([]);
      expect(await onSecond(w)).toHaveLength(1);
    });
  });

  it('a swipe-reply to a card of the other farm is told so, and is not taken as words for this farm', async () => {
    const w = await onTwoFarms();
    await send(pressUpdate(w.owner.chatId, `f:${w.owner.client.membershipId}`, 1));
    const card = await draftCard(w);
    await chooseSecond(w);
    const { requests } = scripted('Qaysi xarajat?');

    await send(messageUpdate(w.owner.chatId, { text: "2 mln bo'lsin", reply_to_message: { reply_markup: card.body.reply_markup } }));

    expect(requests).toHaveLength(0);
    expect(w.telegram.sentTo(w.owner.chatId).at(-1)).toBe(tr('uz', 'alerts', 'bot.otherFarm', { farm: '/ferma' }));
  });

  describe('when one of the farms demands two-step sign-in', () => {
    const demand2fa = (w: Awaited<ReturnType<typeof onTwoFarms>>) =>
      withPlatform((trx) => trx.update(schema.tenants).set({ settings: { security: { enforce2fa: true } } }).where(eq(schema.tenants.id, w.f.tenantId)));

    it('the chat stopped there can still move to the other farm, with /ferma or any message', async () => {
      const w = await onTwoFarms();
      await send(pressUpdate(w.owner.chatId, `f:${w.owner.client.membershipId}`, 1));
      await demand2fa(w);
      const offers = () => farmButtons(w.telegram.of('sendMessage', w.owner.chatId).at(-1)!).map((button) => button.callback_data);

      await send(textUpdate(w.owner.chatId, '/ferma'));
      expect(offers()).toEqual([`f:${w.membershipId}`]);
      await send(textUpdate(w.owner.chatId, 'Salom'));
      expect(offers()).toEqual([`f:${w.membershipId}`]);

      await chooseSecond(w);
      await send(textUpdate(w.owner.chatId, '/ogohlantirishlar'));
      expect(w.telegram.sentTo(w.owner.chatId).at(-1)).toBe(tr('uz', 'alerts', 'bot.noAlerts'));
    });

    it('its alerts stay out of the list, as the web would keep them behind the sign-in', async () => {
      const w = await onTwoFarms();
      await chooseSecond(w);
      await w.f.run(() => raiseAlert({ ruleKey: 'device_event', dedupKey: 'fire', severity: 'urgent', title: "Yong'in", notify: ['owner'] }));
      await demand2fa(w);

      await send(textUpdate(w.owner.chatId, '/ogohlantirishlar'));

      expect(w.telegram.sentTo(w.owner.chatId).at(-1)).toBe(tr('uz', 'alerts', 'bot.noAlerts'));
    });
  });

  describe('an alert', () => {
    const fire = (w: Awaited<ReturnType<typeof onTwoFarms>>) =>
      w.f.run(() => raiseAlert({ ruleKey: 'device_event', dedupKey: 'fire', severity: 'urgent', title: "Yong'in belgisi", notify: ['owner'] }));
    const names = async (w: Awaited<ReturnType<typeof onTwoFarms>>) => {
      const [first] = await w.f.run(() => tx().select({ name: schema.farms.name }).from(schema.farms));
      const [workspace] = await withPlatform((trx) => trx.select({ name: schema.tenants.name }).from(schema.tenants).where(eq(schema.tenants.id, w.f.tenantId)));
      return { farm: first.name, workspace: workspace.name };
    };

    it('says which farm is burning, and the list covers every farm', async () => {
      const w = await onTwoFarms();
      await chooseSecond(w);
      const { farm, workspace } = await names(w);

      await fire(w);
      await w.f.run(() => dispatchPending());
      expect(w.telegram.sentTo(w.owner.chatId).at(-1)).toContain(`${workspace}: ${farm}`);

      await send(textUpdate(w.owner.chatId, '/ogohlantirishlar'));
      const list = w.telegram.sentTo(w.owner.chatId).at(-1)!;
      expect(list).toContain(`<b>${workspace}: ${farm}</b>`);
      expect(list).toContain("Yong'in belgisi");
      expect(list).toContain(tr('uz', 'alerts', 'bot.noAlerts')); // the other farm, under its own name
    });

    it('all clear on every farm is said once', async () => {
      const w = await onTwoFarms();
      await chooseSecond(w);

      await send(textUpdate(w.owner.chatId, '/ogohlantirishlar'));

      expect(w.telegram.sentTo(w.owner.chatId).at(-1)).toBe(tr('uz', 'alerts', 'bot.noAlerts'));
    });

    it('on one farm, it names none', async () => {
      const w = await world();

      await w.f.run(() => raiseAlert({ ruleKey: 'device_event', dedupKey: 'fire', severity: 'urgent', title: "Yong'in belgisi", notify: ['owner'] }));
      await w.f.run(() => dispatchPending());

      expect(w.telegram.sentTo(w.owner.chatId).at(-1)).not.toContain('📍');
    });
  });

  it('someone on one farm is not asked, and their card names no farm', async () => {
    const w = await world();

    const card = await draftCard(w);

    expect(card.body.text).not.toContain(`${tr('uz', 'ai', 'recordText.farm')}:`);
  });

  it('two workspaces with a farm of the same name can be told apart', async () => {
    const w = await onTwoFarms();
    await withPlatform((trx) => trx.update(schema.farms).set({ name: 'Bosh ferma' }));

    await send(textUpdate(w.owner.chatId, '/holat'));

    const labels = farmButtons(lastCard(w)).map((button) => button.text);
    expect(new Set(labels).size).toBe(2);
    for (const label of labels) expect(label).toContain('Bosh ferma');
  });
});

describe('during a turn', () => {
  it('someone blocked mid-turn gets the answer already under way, and a press on its card is refused', async () => {
    const w = await world();
    scripted(async () => {
      await w.f.run(() => tx().update(schema.users).set({ status: 'blocked' }).where(eq(schema.users.id, w.owner.client.userId)));
      return toolCall('draft_expense', electricity);
    }, 'Tasdiqlang.');

    await send(textUpdate(w.owner.chatId, ELECTRICITY));
    await press(lastCard(w), CONFIRM);

    expect(await transactions(w)).toHaveLength(0);
    expect(w.telegram.notices()).toEqual([tr('uz', 'alerts', 'bot.blocked')]);
  });

  it('a correction just after Confirm is told the record stands and Undo is the way', async () => {
    const w = await world();
    await press(await draftCard(w), CONFIRM);
    const { requests } = scripted('Avval Qaytarish tugmasini bosing.');

    await send(textUpdate(w.owner.chatId, 'Aslida 4 mln edi'));

    expect(requests[0].context).toContain('Already confirmed');
    expect(await transactions(w)).toHaveLength(1);
  });
});

describe('without finance', () => {
  it('a workspace with the finance module off gets no money tools, no cash, and no press', async () => {
    const w = await world();
    const card = await draftCard(w);
    await withPlatform((trx) =>
      trx.update(schema.tenants).set({ modules: ['ai', 'livestock', 'feed', 'alerts'] }).where(eq(schema.tenants.id, w.f.tenantId)),
    );
    const { requests } = scripted('Bu ochiq emas.');

    await send(textUpdate(w.owner.chatId, ELECTRICITY));
    await send(textUpdate(w.owner.chatId, '/holat'));
    await press(card, CONFIRM);

    expect(offered(requests[0]).filter((name) => name.startsWith('draft_') || name === 'cash_position')).toEqual([]);
    expect(w.telegram.sentTo(w.owner.chatId).at(-1)).not.toContain(tr('uz', 'alerts', 'digest.cash', { amount: '' }).trim().split(' ')[0]);
    expect(await transactions(w)).toHaveLength(0);
    expect(w.telegram.notices()).toEqual([tr('uz', 'alerts', 'bot.moneyHidden')]);
  });

  it.each(['c', 'd', 'x', 'u', 'e'])('a crafted %s press by someone who cannot read money does nothing', async (action) => {
    const w = await world();
    const card = await draftCard(w);
    const data = buttonsOf(card)[0].callback_data.replace(/^p:c:/, `p:${action}:`);
    await setRolePermissions(w.f, 'owner', DEFAULT_ROLE_PERMISSIONS.owner.filter((p) => p !== 'finance.view'));

    await send(pressUpdate(w.owner.chatId, data, card.messageId!));

    expect(await transactions(w)).toHaveLength(0);
    expect((await proposals(w))[0].status).toBe('pending');
    expect(w.telegram.edits().at(-1)!.body.text).toBe(tr('uz', 'alerts', 'bot.moneyHidden'));
  });
});

describe('Change and Cancel belong to the card they were pressed on', () => {
  async function twoCards(w: World) {
    const first = await draftCard(w);
    const second = await draftCard(w, { amount: 2_000_000, category: 'meals', paymentMethod: 'cash' }, "Tushlikka 2 mln naqd to'ladim");
    return [first, second];
  }

  const correctTo = (amount: number) => async (request: LlmRequest) => {
    const pointer = lastUserBlocks(request).find((block) => block.type === 'text' && block.text.includes('means card')) as { text: string } | undefined;
    return toolCall('update_draft', { proposalId: /card ([0-9a-f-]{36})/.exec(pointer!.text)![1], changes: { amount } });
  };

  it('the model is told which card Change was pressed on, and only for that one message', async () => {
    const w = await world();
    const [first, second] = await twoCards(w);
    const { requests } = scripted(correctTo(4_000_000), 'Yangilandi.', 'Javob');

    await press(first, CHANGE);
    await send(textUpdate(w.owner.chatId, 'Aslida 4 mln edi'));
    await send(textUpdate(w.owner.chatId, 'Rahmat'));

    const amounts = (await proposals(w)).map((p) => (p.fields as { amount: number }).amount).sort();
    expect(amounts).toEqual([2_000_000, 4_000_000]);
    expect(buttonsOf(first)[0].callback_data).toContain((await proposals(w)).find((p) => (p.fields as { amount: number }).amount === 4_000_000)!.id);
    expect(second.body.text).toContain('2 000 000');
    expect(JSON.stringify(lastUserBlocks(requests.at(-1)!))).not.toContain('means card');
  });

  it('a swipe-reply to a card means that card', async () => {
    const w = await world();
    const [first] = await twoCards(w);
    scripted(correctTo(4_000_000), 'Yangilandi.');

    await send(
      messageUpdate(w.owner.chatId, { text: 'Aslida 4 mln edi', reply_to_message: { reply_markup: first.body.reply_markup } }),
    );

    expect((await proposals(w)).map((p) => (p.fields as { amount: number }).amount).sort()).toEqual([2_000_000, 4_000_000]);
  });

  it('a card from an earlier conversation can still be changed, in that conversation', async () => {
    const w = await world();
    const card = await draftCard(w);
    await send(textUpdate(w.owner.chatId, '/yangi'));
    scripted('Salom');
    await send(textUpdate(w.owner.chatId, 'Salom'));
    const { requests } = scripted(
      async (request) => {
        expect(request.context).toContain('Open card');
        return correctTo(4_000_000)(request);
      },
      'Yangilandi.',
    );

    await press(card, CHANGE);
    await send(textUpdate(w.owner.chatId, 'Aslida 4 mln edi'));

    expect(requests).toHaveLength(2);
    expect(((await proposals(w))[0].fields as { amount: number }).amount).toBe(4_000_000);
  });

  async function corrected(w: World) {
    const stale = await draftCard(w);
    scripted(
      async (request) => toolCall('update_draft', { proposalId: /Open card ([0-9a-f-]{36})/.exec(request.context!)![1], changes: { amount: 4_000_000 } }),
      'Yangilandi.',
    );
    await send(textUpdate(w.owner.chatId, 'Aslida 4 mln edi'));
    return stale;
  }

  it('Cancel on an old copy of a card shows the new one and cancels nothing', async () => {
    const w = await world();
    const stale = await corrected(w);

    await press(stale, CANCEL);

    expect((await proposals(w))[0].status).toBe('pending');
    expect(w.telegram.notices()).toEqual([tr('uz', 'alerts', 'bot.cardChanged')]);
    expect(w.telegram.edits().at(-1)!.body.text).toContain('4 000 000');
  });

  it('Change on an old copy shows the new one and does not start a change', async () => {
    const w = await world();
    const stale = await corrected(w);
    const before = w.telegram.sentTo(w.owner.chatId).length;

    await press(stale, CHANGE);

    expect(w.telegram.sentTo(w.owner.chatId).slice(before)).toEqual([]);
    expect(w.telegram.edits().at(-1)!.body.text).toContain('4 000 000');
  });

  it('the Change prompt and /yangi clear the options of an earlier question', async () => {
    const w = await world();
    const card = await draftCard(w);

    await press(card, CHANGE);
    expect(w.telegram.of('sendMessage', w.owner.chatId).at(-1)!.body.reply_markup).toEqual({ remove_keyboard: true });

    await send(textUpdate(w.owner.chatId, '/yangi'));
    const last = w.telegram.of('sendMessage', w.owner.chatId).at(-1)!;
    expect(last.body.text).toBe(tr('uz', 'alerts', 'bot.newConversation'));
    expect(last.body.reply_markup).toEqual({ remove_keyboard: true });
  });

  it('/yangi also forgets a pending Change, so the next message is not taken for it', async () => {
    const w = await world();
    const card = await draftCard(w);
    await press(card, CHANGE);
    await send(textUpdate(w.owner.chatId, '/yangi'));
    const { requests } = scripted('Salom');

    await send(textUpdate(w.owner.chatId, 'Aslida salom'));

    expect(JSON.stringify(lastUserBlocks(requests[0]))).not.toContain('means card');
    expect(requests[0].messages).toHaveLength(1);
  });

  it('a press names no draft in its text, so it cannot be mistaken for words', async () => {
    const w = await world();
    const [, second] = await twoCards(w);
    scripted(correctTo(5_000_000), 'Yangilandi.');

    await press(second, CHANGE);
    await send(textUpdate(w.owner.chatId, 'Aslida 5 mln edi'));

    const saved = await w.f.run(() => tx().select().from(schema.aiMessages));
    expect(JSON.stringify(saved)).not.toContain('means card');
  });
});

describe('linking', () => {
  const linkCode = async (client: Client) => (await client.post('/notifications/telegram/link')).data.code as string;
  const chatOfUser = async (client: Client) => {
    const [row] = await withPlatform((trx) => trx.select().from(schema.users).where(eq(schema.users.id, client.userId)));
    return row.telegramChatId;
  };
  const nameOf = async (client: Client) => {
    const [row] = await withPlatform((trx) => trx.select().from(schema.users).where(eq(schema.users.id, client.userId)));
    return row.fullName;
  };
  const events = (f: Fixture, type: string) => f.run(() => tx().select().from(schema.events).where(eq(schema.events.type, type)));

  async function occupied() {
    const w = await world();
    const director = await w.f.as('director');
    const code = await linkCode(director);
    await send(textUpdate(w.owner.chatId, `/start ${code}`));
    const asked = w.telegram.of('sendMessage', w.owner.chatId).at(-1)!;
    return { w, director, code, asked };
  }

  it('someone else\'s code does not move a chat, and the question names both accounts', async () => {
    const { w, director, asked } = await occupied();

    expect(await chatOfUser(w.owner.client)).toBe(w.owner.chatId);
    expect(await chatOfUser(director)).toBeNull();
    expect(asked.body.text).toContain(await nameOf(w.owner.client));
    expect(asked.body.text).toContain(await nameOf(director));
    expect(buttonsOf(asked).map((button) => button.text).join(' ')).toContain(await nameOf(director));
    for (const button of buttonsOf(asked)) expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
  });

  it('answering no changes nothing, and the code stays good for its own chat', async () => {
    const { w, director, code, asked } = await occupied();

    await send(pressUpdate(w.owner.chatId, buttonsOf(asked)[0].callback_data, asked.messageId!));

    expect(await chatOfUser(w.owner.client)).toBe(w.owner.chatId);
    expect(w.telegram.edits().at(-1)!.body.text).toBe(tr('uz', 'alerts', 'bot.moveKept'));

    await send(textUpdate('77001', `/start ${code}`));
    expect(await chatOfUser(director)).toBe('77001');
  });

  it('answering yes moves the chat, says so, and leaves a trace for both', async () => {
    const { w, director, asked } = await occupied();

    await send(pressUpdate(w.owner.chatId, buttonsOf(asked)[1].callback_data, asked.messageId!));

    expect(await chatOfUser(director)).toBe(w.owner.chatId);
    expect(await chatOfUser(w.owner.client)).toBeNull();
    const told = w.telegram.edits().at(-1)!.body.text as string;
    expect(told).toContain(await nameOf(director));
    expect(told).toContain(await nameOf(w.owner.client));
    expect((await events(w.f, 'telegram.linked')).map((e) => e.entityId)).toEqual([director.userId]);
    expect((await events(w.f, 'telegram.unlinked')).map((e) => e.entityId)).toEqual([w.owner.client.userId]);
  });

  it('a double tap on yes moves the chat once and says nothing false', async () => {
    const { w, asked } = await occupied();
    const yes = buttonsOf(asked)[1].callback_data;

    await send(pressUpdate(w.owner.chatId, yes, asked.messageId!));
    const told = w.telegram.edits().at(-1)!.body.text;
    await send(pressUpdate(w.owner.chatId, yes, asked.messageId!));

    expect(w.telegram.edits().at(-1)!.body.text).toBe(told);
    expect(await events(w.f, 'telegram.linked')).toHaveLength(1);
  });

  it('the press only works from the chat that was asked', async () => {
    const { w, director, asked } = await occupied();

    await send(pressUpdate('55001', buttonsOf(asked)[1].callback_data, asked.messageId!, w.owner.chatId));

    expect(await chatOfUser(director)).toBeNull();
    expect(w.telegram.notices()).toEqual([tr('uz', 'alerts', 'bot.stale')]);
  });

  it('an account moving to a new chat tells the old one, and the owner sees it in the web app', async () => {
    const w = await world();
    const code = await linkCode(w.owner.client);

    await send({ ...textUpdate('77002', `/start ${code}`) });

    expect(await chatOfUser(w.owner.client)).toBe('77002');
    expect(w.telegram.sentTo(w.owner.chatId)).toEqual([tr('uz', 'alerts', 'bot.movedAway')]);
    const inbox = await w.owner.client.get('/notifications');
    expect(inbox.data.map((n: { title: string }) => n.title)).toContain(tr('uz', 'alerts', 'bot.linkNotice.title'));
  });

  it('a redelivered /start tells the person they are linked, not that the code is bad', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const telegram = fakeTelegram();
    const code = await linkCode(owner);

    await send(textUpdate('77003', `/start ${code}`));
    await send(textUpdate('77003', `/start ${code}`));

    expect(telegram.sentTo('77003')).toHaveLength(2);
    expect(telegram.sentTo('77003')[1]).toBe(telegram.sentTo('77003')[0]);
  });

  it('a used code does not work from another chat', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const telegram = fakeTelegram();
    const code = await linkCode(owner);
    await send(textUpdate('77004', `/start ${code}`));

    await send(textUpdate('77005', `/start ${code}`));

    expect(telegram.sentTo('77005')).toEqual([tr('uz', 'alerts', 'bot.linkFailed')]);
    expect(await chatOfUser(owner)).toBe('77004');
  });

  it('a bad code is refused in the language of the person in the chat', async () => {
    const w = await world();
    await w.f.run(() => tx().update(schema.users).set({ locale: 'ru' }).where(eq(schema.users.id, w.owner.client.userId)));

    await send(textUpdate(w.owner.chatId, '/start 000000000000'));

    expect(w.telegram.sentTo(w.owner.chatId)).toEqual([tr('ru', 'alerts', 'bot.linkFailed')]);
  });

  it('a new code burns the one before it, and unlinking burns them all', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const telegram = fakeTelegram();
    const old = await linkCode(owner);
    const current = await linkCode(owner);

    await send(textUpdate('77006', `/start ${old}`));
    expect(await chatOfUser(owner)).toBeNull();

    await owner.delete('/notifications/telegram');
    await send(textUpdate('77006', `/start ${current}`));
    expect(await chatOfUser(owner)).toBeNull();
    expect(telegram.sentTo('77006')).toEqual(Array(2).fill(tr('uz', 'alerts', 'bot.linkFailed')));
  });

  it('unlinking from the web tells the chat, and is in the journal', async () => {
    const w = await world();

    await w.owner.client.delete('/notifications/telegram');

    await vi.waitFor(() => expect(w.telegram.sentTo(w.owner.chatId)).toEqual([tr('uz', 'alerts', 'bot.unlinked')]));
    expect(await events(w.f, 'telegram.unlinked')).toHaveLength(1);
    const inbox = await w.owner.client.get('/notifications');
    expect(inbox.data.map((n: { title: string }) => n.title)).toEqual([tr('uz', 'alerts', 'bot.unlinkNotice.title')]);
  });

  it('asking for a code is in the journal', async () => {
    const w = await world();

    await linkCode(w.owner.client);

    expect(await events(w.f, 'telegram.link_requested')).toHaveLength(1);
  });

  it('a password change keeps the chat, burns its codes, and tells the chat whatever it chose to hear', async () => {
    const w = await world();
    const code = await linkCode(w.owner.client);
    const card = await draftCard(w);
    await w.owner.client.put('/notifications/preferences', { eventType: 'alert_attention', channels: [] });

    const changed = await w.owner.client.post('/auth/change-password', { currentPassword: 'Password123!', newPassword: 'NewPassword456!' });
    expect(changed.status).toBe(200);
    await w.f.run(() => dispatchPending());

    expect(await chatOfUser(w.owner.client)).toBe(w.owner.chatId);
    expect(w.telegram.sentTo(w.owner.chatId).at(-1)).toContain(tr('uz', 'alerts', 'bot.passwordNotice.body'));
    await press(card, CONFIRM);
    expect(await transactions(w)).toHaveLength(1);
    await send(textUpdate('77003', `/start ${code}`));
    expect(await chatOfUser(w.owner.client)).toBe(w.owner.chatId);
  });

  it('a fire after a password change still reaches the chat', async () => {
    const w = await world();
    await w.owner.client.post('/auth/change-password', { currentPassword: 'Password123!', newPassword: 'NewPassword456!' });

    await w.f.run(() => raiseAlert({ ruleKey: 'device_event', dedupKey: 'fire', severity: 'urgent', title: "Yong'in", notify: ['owner'] }));
    await w.f.run(() => dispatchPending());

    expect(w.telegram.sentTo(w.owner.chatId).join()).toContain("Yong'in");
  });

  it('an admin resetting a password tells the chat and leaves it linked', async () => {
    const w = await world();
    const director = await link(w.f, 'director');

    expect((await w.owner.client.post(`/settings/users/${director.client.membershipId}/reset-password`)).status).toBe(200);
    await w.f.run(() => dispatchPending());

    expect(await chatOfUser(director.client)).toBe(director.chatId);
    expect(w.telegram.sentTo(director.chatId).at(-1)).toContain(tr('uz', 'alerts', 'bot.passwordNotice.body'));
  });

  it('blocking someone on their only farm stops the chat without unlinking it', async () => {
    const w = await world();
    const accountant = await link(w.f, 'accountant');

    expect((await w.owner.client.post(`/settings/users/${accountant.client.membershipId}/block`)).status).toBe(200);
    await w.f.run(() => raiseAlert({ ruleKey: 'device_event', dedupKey: 'fire', severity: 'urgent', title: "Yong'in", notify: ['accountant'] }));
    await send(textUpdate(accountant.chatId, 'Holat qanday?'));

    expect(await chatOfUser(accountant.client)).toBe(accountant.chatId);
    expect(w.telegram.sentTo(accountant.chatId)).toEqual([tr('uz', 'alerts', 'bot.blocked')]);
  });

  describe('someone on two workspaces, let go by one of them', () => {
    async function letGo(how: (w: Awaited<ReturnType<typeof withSecondFarm>>, membershipId: string) => Promise<{ status: number }>) {
      const w = await withSecondFarm(await world());
      expect((await how(w, w.membershipId)).status).toBe(200);
      const fire = (f: Fixture) => f.run(() => raiseAlert({ ruleKey: 'device_event', dedupKey: 'fire', severity: 'urgent', title: "Yong'in", notify: ['owner'] }));
      await fire(w.f);
      await w.f.run(() => dispatchPending());
      expect(await chatOfUser(w.owner.client)).toBe(w.owner.chatId);
      expect(w.telegram.sentTo(w.owner.chatId).join()).toContain("Yong'in");
    }

    it('blocked there: a fire on the other still reaches them', async () => {
      await letGo(async (w, membershipId) => (await w.second.as('owner')).post(`/settings/users/${membershipId}/block`));
    });

    it('terminated there: a fire on the other still reaches them', async () => {
      await letGo(async (w) => {
        const boss = await w.second.as('owner');
        const hired = await boss.post('/hr/employees', {
          fullName: 'Ikki ferma', position: "Cho'pon", hireDate: '2026-01-01', payType: 'monthly', baseRate: 3_000_000, userId: w.owner.client.userId,
        });
        return boss.post(`/hr/employees/${hired.data.id}/terminate`, { date: todayIso('Asia/Tashkent') });
      });
    });
  });

  it('blocking the account itself ends the link: the chat hears why, every farm keeps a trace, and the notice waits for them', async () => {
    const w = await withSecondFarm(await world());

    await setUserStatus(w.owner.client.userId, 'blocked', undefined);

    await vi.waitFor(() => expect(w.telegram.sentTo(w.owner.chatId)).toEqual([tr('uz', 'alerts', 'bot.unlinkedBlocked')]));
    expect(await chatOfUser(w.owner.client)).toBeNull();
    expect(await events(w.f, 'telegram.unlinked')).toHaveLength(1);
    expect(await events(w.second, 'telegram.unlinked')).toHaveLength(1);

    await setUserStatus(w.owner.client.userId, 'active', undefined);
    const inbox = await w.owner.client.get('/notifications');
    expect(inbox.data.map((n: { title: string }) => n.title)).toEqual([tr('uz', 'alerts', 'bot.unlinkNotice.title')]);
  });

  it('whoever a chat was moved away from finds a notice in the web app', async () => {
    const { w, code, asked } = await occupied();

    await send(pressUpdate(w.owner.chatId, `l:y:${code}`, asked.messageId!));

    const inbox = await w.owner.client.get('/notifications');
    expect(inbox.data.map((n: { title: string }) => n.title)).toContain(tr('uz', 'alerts', 'bot.unlinkNotice.title'));
  });

  it('an account moving off a chat that cannot be reached still leaves its trace and its web notice', async () => {
    const w = await world();
    const code = await linkCode(w.owner.client);
    w.telegram.state.intercept = (call) =>
      call.method === 'sendMessage' && String(call.body.chat_id) === w.owner.chatId ? refused(403, 'Forbidden: bot was blocked by the user') : undefined;
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await send(textUpdate('77012', `/start ${code}`));

    expect(await chatOfUser(w.owner.client)).toBe('77012');
    expect(await events(w.f, 'telegram.linked')).toHaveLength(1);
    const inbox = await w.owner.client.get('/notifications');
    expect(inbox.data.map((n: { title: string }) => n.title)).toEqual([tr('uz', 'alerts', 'bot.linkNotice.title')]);
  });
});

describe('late and forwarded messages', () => {
  const yesterdayNoon = () => Math.floor((Date.now() - 86_400_000) / 1000);

  it('a message Telegram held overnight is dated the day it was written', async () => {
    const w = await world();
    const { requests } = scripted(toolCall('draft_expense', electricity), 'Tasdiqlang.');

    await send(messageUpdate(w.owner.chatId, { text: `Bugun ${ELECTRICITY}`, date: yesterdayNoon() }));

    const written = todayIso('Asia/Tashkent', new Date(yesterdayNoon() * 1000));
    expect(((await proposals(w))[0].fields as { date: string }).date).toBe(written);
    expect(requests[0].context).toContain(`Today is ${written}`);
  });

  it('a message from today counts as today', async () => {
    const w = await world();
    const { requests } = scripted(toolCall('draft_expense', electricity), 'Tasdiqlang.');

    await send(messageUpdate(w.owner.chatId, { text: ELECTRICITY, date: Math.floor(Date.now() / 1000) }));

    expect(((await proposals(w))[0].fields as { date: string }).date).toBe(todayIso('Asia/Tashkent'));
    expect(requests[0].context).toContain(`Today is ${todayIso('Asia/Tashkent')}`);
  });

  it('a forwarded message is someone else\'s words: the model is told, and Confirm needs an explicit yes', async () => {
    const w = await world();
    const { requests } = scripted(
      toolCall('draft_expense', electricity),
      'Qanday to\'landi?',
      toolCall('draft_expense', electricity),
      'Tasdiqlang.',
    );

    await send(messageUpdate(w.owner.chatId, { text: ELECTRICITY, forward_origin: { type: 'user' } }));

    expect(lastUserText(requests[0])).toContain("someone else's words");
    expect(await proposals(w)).toEqual([]); // the amount may come from there, but how it was paid must be theirs

    await send(textUpdate(w.owner.chatId, 'Elektr uchun, naqd'));
    await press(lastCard(w), CONFIRM);
    expect(await transactions(w)).toHaveLength(0);
    const asked = w.telegram.edits().at(-1)!;
    expect(asked.body.text).toContain(tr('uz', 'alerts', 'bot.acknowledgeAsk'));
    await press(asked, YES_RECORD);
    expect(await transactions(w)).toHaveLength(1);
  });

  describe('a question between the words and the card', () => {
    const expense = { amount: 3_000_000, category: 'electricity' };
    const fiveDaysAgo = () => Math.floor((Date.now() - 5 * 86_400_000) / 1000);
    const dayOf = (seconds: number) => todayIso('Asia/Tashkent', new Date(seconds * 1000));
    const forwarded = (date: number) => ({ type: 'user', date });

    it('a late message keeps the day it was written', async () => {
      const w = await world();
      scripted(toolCall('draft_expense', expense), "Qanday to'landi?", toolCall('draft_expense', { ...expense, paymentMethod: 'cash' }), 'Tasdiqlang.');
      const sent = yesterdayNoon();

      await send(messageUpdate(w.owner.chatId, { text: "Elektrga 3 mln to'ladim", date: sent }));
      await send(textUpdate(w.owner.chatId, 'naqd'));

      expect(((await proposals(w))[0].fields as { date: string }).date).toBe(dayOf(sent));
    });

    it('a forward keeps the day it was written, not the day it was passed on', async () => {
      const w = await world();
      scripted(toolCall('draft_expense', expense), "Qanday to'landi?", toolCall('draft_expense', { ...expense, paymentMethod: 'cash' }), 'Tasdiqlang.');
      const written = fiveDaysAgo();

      await send(messageUpdate(w.owner.chatId, { text: "Bugun elektrga 3 mln to'ladim", forward_origin: forwarded(written) }));
      await send(textUpdate(w.owner.chatId, 'naqd'));

      expect(((await proposals(w))[0].fields as { date: string }).date).toBe(dayOf(written));
    });

    it('a new record said meanwhile has a day of its own', async () => {
      const w = await world();
      scripted(toolCall('draft_expense', expense), "Qanday to'landi?", toolCall('draft_expense', { amount: 500_000, category: 'meals', paymentMethod: 'cash' }), 'Tasdiqlang.');

      await send(messageUpdate(w.owner.chatId, { text: "Elektrga 3 mln to'ladim", forward_origin: forwarded(fiveDaysAgo()) }));
      await send(textUpdate(w.owner.chatId, "Tushlikka 500 ming naqd to'ladim"));

      expect(((await proposals(w))[0].fields as { date: string }).date).toBe(todayIso('Asia/Tashkent'));
    });

    it('once the record is made, the next one is not dated by the forward', async () => {
      const w = await world();
      scripted(
        toolCall('draft_expense', expense), "Qanday to'landi?", toolCall('draft_expense', { ...expense, paymentMethod: 'cash' }), 'Tasdiqlang.',
        toolCall('draft_expense', { amount: 500_000, category: 'meals', paymentMethod: 'cash' }), 'Tasdiqlang.',
      );
      await send(messageUpdate(w.owner.chatId, { text: "Elektrga 3 mln to'ladim", forward_origin: forwarded(fiveDaysAgo()) }));
      await send(textUpdate(w.owner.chatId, 'naqd'));

      await send(textUpdate(w.owner.chatId, "Tushlikka 500 ming naqd to'ladim"));

      const [second] = (await proposals(w)).filter((p) => (p.fields as { amount: number }).amount === 500_000);
      expect((second.fields as { date: string }).date).toBe(todayIso('Asia/Tashkent'));
    });
  });

  it('a forwarded voice note counts as forwarded too', async () => {
    const w = await world({}, { 'voice.oga': Buffer.from('OggS') });
    const { requests } = scripted(JSON.stringify({ speechHeard: true, transcript: ELECTRICITY }), 'Tushunarli.');

    await send(messageUpdate(w.owner.chatId, { voice: { file_id: 'voice.oga', duration: 4, mime_type: 'audio/ogg' }, forward_origin: { type: 'user' } }));

    expect(lastUserText(requests[1])).toContain("someone else's words");
  });

  it('a forwarded command commands nothing', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const director = await link(f, 'director');
    const telegram = fakeTelegram();
    const { data } = await owner.post('/notifications/telegram/link');
    const { requests } = scripted('Bu havola.');

    await send(messageUpdate(director.chatId, { text: `/start ${data.code}`, forward_origin: { type: 'user' } }));

    expect(requests).toHaveLength(1);
    expect(telegram.sentTo(director.chatId)).toEqual(['Bu havola.']);
  });
});

describe('the card, read as plain text', () => {
  const view = (fields: Partial<ProposalView['fields']>, extra: Partial<ProposalView> = {}): ProposalView => ({
    id: 'id', kind: 'expense', status: 'pending', channel: 'telegram', createdAt: '', expiresAt: '', undoUntil: null, sourceText: '',
    stamp: '', masked: false, warnings: [], learning: [], needsAcknowledgement: false, needsAnswer: false, willNeedApproval: false, result: null,
    fields: {
      amount: 3_000_000, currency: 'UZS', fxRate: null, amountBase: 3_000_000, date: '2026-11-03', category: null, target: null, account: null,
      toAccount: null, paymentMethod: 'cash', counterparty: null, item: null, warehouse: null, qty: null, unitPrice: null, costTreatment: null,
      direction: null, description: null, ...fields,
    },
    ...extra,
  });

  it('a debt card says who paid whom, and the two directions read differently', () => {
    const debt = (direction: 'payable' | 'receivable') =>
      renderProposalText(view({ direction, counterparty: { id: 'c', name: 'Neft Baza' } }, { kind: 'debt_payment' }), 'uz');

    expect(debt('payable')).toContain(tr('uz', 'ai', 'recordText.direction.payable'));
    expect(debt('receivable')).toContain(tr('uz', 'ai', 'recordText.direction.receivable'));
    expect(debt('payable')).not.toBe(debt('receivable'));
    expect(debt('payable')).toContain('Neft Baza');
  });

  it('a foreign amount shows the rate and what it comes to', () => {
    const text = renderProposalText(view({ amount: 100, currency: 'USD', fxRate: 12_700, amountBase: 1_270_000 }), 'uz');

    expect(text).toContain('100 $');
    expect(text).toContain("12 700 so'm");
    expect(text).toContain("1 270 000 so'm");
  });

  it('speaks the reader\'s language: category, general cost, currency, unit', () => {
    const fields = {
      category: { id: 'c', name: 'Elektr', translations: { uz: 'Elektr', ru: 'Электричество', en: 'Electricity' } },
      target: { costCenterId: 't', type: 'general', name: 'Umumiy xarajat', defaulted: false },
      item: { id: 'i', name: 'Dizel', unit: 'l' },
      qty: 20,
    };

    const russian = renderProposalText(view(fields), 'ru');
    expect(russian).toContain('Электричество');
    expect(russian).toContain('3 000 000 сум');
    expect(russian).toContain(tr('ru', 'enums', 'costCenterType.general'));
    expect(russian).not.toContain("so'm");
    expect(renderProposalText(view(fields), 'en')).toContain('Electricity');
    expect(renderProposalText(view(fields), 'uz-Cyrl')).toContain('Электр');
  });

  it('a line break in a note cannot pass for a line of the card', () => {
    const text = renderProposalText(view({ description: "Svet\nHisob: Kassa\n\u2028Sana: 01.01.2020" }), 'uz');

    expect(text.split('\n').filter((line) => line.startsWith('Hisob'))).toEqual([]);
    expect(text).toContain("Svet Hisob: Kassa Sana: 01.01.2020");
  });

  it('a warning no dictionary knows yet still shows, so a yes is never asked about nothing', () => {
    const text = renderProposalText(view({}, { warnings: [{ code: 'BRAND_NEW', params: {} }] }), 'en');

    expect(text).toContain(tr('en', 'alerts', 'bot.checkThis'));
  });

  it('every warning the core can raise has its text', () => {
    const codes = ['POSSIBLE_DUPLICATE', 'OTHER_AMOUNT', 'AMOUNT_FROM_DOCUMENT', 'PHRASE_USED', 'STALE_RATE', 'UNUSUAL_PRICE'];
    for (const language of ['uz', 'ru', 'en']) {
      for (const code of codes) {
        expect(renderProposalText(view({}, { warnings: [{ code, params: {} }] }), language)).toContain(tr(language, 'ai', `recordText.warnings.${code}`));
      }
    }
  });

  it('a large record a second person refused no longer reads as recorded on an old copy', async () => {
    const w = await world({ settings: { finance: { approvalThreshold: 1_000_000 } } });
    const director = await w.f.as('director');
    await draftCard(w);
    await send(textUpdate(w.owner.chatId, '/kutilmoqda'));
    const copy = lastCard(w);
    await press(copy, CONFIRM);
    const edit = w.telegram.edits().at(-1)!;
    expect(edit.body.text).toContain(tr('uz', 'alerts', 'bot.waitingApproval'));
    const [entry] = await transactions(w);
    expect((await director.post(`/finance/transactions/${entry.id}/reject`, { reason: 'Xato' })).status).toBe(200);

    await press(lastCard(w), CONFIRM); // the first copy, still with its buttons

    expect(w.telegram.edits().at(-1)!.body.text).toContain(tr('uz', 'alerts', 'bot.notInBooks'));
    expect(w.telegram.edits().at(-1)!.body.text).not.toContain(tr('uz', 'alerts', 'bot.recorded'));
  });
});

describe('a turn that fails after a card was made', () => {
  it('Telegram refusing the answer text does not cost the card', async () => {
    const w = await world();
    scripted(toolCall('draft_expense', electricity), 'Tasdiqlang.');
    const logger = log();
    let refusedOnce = false;
    w.telegram.state.intercept = (call) => {
      if (call.method !== 'sendMessage' || refusedOnce) return undefined;
      refusedOnce = true;
      return refused(400, 'Bad Request: something odd');
    };

    await send(textUpdate(w.owner.chatId, ELECTRICITY), logger);

    expect(labelsOf(lastCard(w))).toEqual([CONFIRM, CHANGE, CANCEL]);
    expect(w.telegram.sentTo(w.owner.chatId)).not.toContain(tr('uz', 'alerts', 'bot.apology'));
  });

  it('the turn failing at its very end still shows the card, and no apology to say it again', async () => {
    const w = await world();
    const { provider } = scripted(toolCall('draft_expense', electricity), 'Tasdiqlang.');
    const complete = provider.complete.bind(provider);
    let round = 0;
    // A NUL in the stored answer makes Postgres refuse the last step of chat().
    provider.complete = async (request) => ({ ...(await complete(request)), model: ++round > 1 ? 'broken\u0000model' : 'scripted-1' });
    const logger = log();

    await send(textUpdate(w.owner.chatId, ELECTRICITY), logger);

    expect(labelsOf(lastCard(w))).toEqual([CONFIRM, CHANGE, CANCEL]);
    expect(w.telegram.sentTo(w.owner.chatId)).not.toContain(tr('uz', 'alerts', 'bot.apology'));
    expect(logger.error).toHaveBeenCalled();
  });

  it('a stuck turn that fails is reported, even if a later message made a card meanwhile', async () => {
    const w = await world();
    const { gate, release } = gated();
    scripted(
      async () => {
        await gate;
        throw new Error('model timed out');
      },
      toolCall('draft_expense', { amount: 500_000, category: 'meals', paymentMethod: 'cash' }),
      'Tasdiqlang.',
    );
    const first = send(textUpdate(w.owner.chatId, "Elektrga 3 mln naqd to'ladim"));
    await vi.waitFor(() => expect(w.telegram.of('sendChatAction').length).toBeGreaterThan(0));
    await send(textUpdate(w.owner.chatId, "Tushlikka 500 ming naqd to'ladim"));
    const cards = () => w.telegram.of('sendMessage', w.owner.chatId).filter((call) => buttonsOf(call).length > 0);
    expect(cards()).toHaveLength(1);

    release();
    await first;

    expect(w.telegram.sentTo(w.owner.chatId)).toContain(tr('uz', 'alerts', 'bot.apology'));
    expect(cards()).toHaveLength(1); // the other message's card is not sent twice
  });

  it('a failed turn that made no card still apologises, and an older draft is not sent again', async () => {
    const w = await world();
    await draftCard(w);
    const before = w.telegram.sentTo(w.owner.chatId).length;
    scripted(new Error('model down'));

    await send(textUpdate(w.owner.chatId, 'Salom'));

    expect(w.telegram.sentTo(w.owner.chatId).slice(before)).toEqual([tr('uz', 'alerts', 'bot.apology')]);
  });
});

describe('questions', () => {
  const twoBanks = (w: World) =>
    w.f.run(() =>
      tx().insert(schema.accounts).values({ tenantId: w.f.tenantId, farmId: w.f.farmId, name: 'Hamkorbank', type: 'bank' }),
    );
  const paidByBank = { amount: 3_000_000, category: 'electricity', paymentMethod: 'bank' };

  it('options are buttons that send their label as the next message, and the hint is never shown', async () => {
    const w = await world();
    await twoBanks(w);
    const { requests } = scripted(
      toolCall('draft_expense', paidByBank),
      'Qaysi bankdan?',
      toolCall('draft_expense', { ...paidByBank, account: 'Hamkorbank' }),
      'Tasdiqlang.',
    );

    await send(textUpdate(w.owner.chatId, "Elektrga 3 mln bankdan to'ladim"));

    const [asked, ...rest] = w.telegram.of('sendMessage', w.owner.chatId);
    expect(rest).toEqual([]);
    expect(asked.body.text).toBe('Qaysi bankdan?');
    const { keyboard, one_time_keyboard: oneTime } = asked.body.reply_markup;
    expect(keyboard.flat().map((b: { text: string }) => b.text).sort()).toEqual(['Agrobank', 'Hamkorbank']);
    expect(oneTime).toBe(true);

    const toolResult = requests[1].messages.at(-1)!.content[0] as { content: string };
    const hint = /"ask":"([^"]+)"/.exec(toolResult.content)![1];
    expect(hint.length).toBeGreaterThan(5);
    expect(JSON.stringify(w.telegram.calls)).not.toContain(hint);

    // A press on a reply keyboard arrives as the person typing the label.
    await send(textUpdate(w.owner.chatId, 'Hamkorbank'));

    expect(lastUserText(requests[2])).toBe('Hamkorbank');
    const [answer, card] = w.telegram.of('sendMessage', w.owner.chatId).slice(1);
    expect(answer.body.text).toBe(tr('uz', 'ai', 'assistant.cardReady'));
    expect(answer.body.reply_markup).toEqual({ remove_keyboard: true }); // the options must not linger
    expect(card.body.text).toContain('Hamkorbank');
    expect(labelsOf(card)).toEqual([CONFIRM, CHANGE, CANCEL]);
  });

  const labels = (call: Call) => call.body.reply_markup.keyboard.flat().map((button: { text: string }) => button.text);

  it('a stored name that looks like a command stays data when its button is pressed', async () => {
    const w = await world();
    await w.f.run(() =>
      tx().insert(schema.accounts).values([
        { tenantId: w.f.tenantId, farmId: w.f.farmId, name: '/start abc', type: 'bank' },
      ]),
    );
    const { requests } = scripted(toolCall('draft_expense', paidByBank), 'Qaysi bankdan?', 'Javob');

    await send(textUpdate(w.owner.chatId, "Elektrga 3 mln bankdan to'ladim"));
    const offered = labels(w.telegram.of('sendMessage', w.owner.chatId)[0]) as string[];
    const label = offered.find((text) => text.includes('/start abc'))!;
    expect(label.startsWith('/')).toBe(false);

    await send(textUpdate(w.owner.chatId, label));

    expect(lastUserText(requests.at(-1)!)).toBe(label);
  });

  it('payment options are in the person\'s language, and a press carries on from there', async () => {
    const w = await world();
    const { requests } = scripted(
      toolCall('draft_expense', { amount: 3_000_000, category: 'electricity' }),
      'Qanday to\'landi?',
      toolCall('draft_expense', electricity),
      'Tasdiqlang.',
    );

    await send(textUpdate(w.owner.chatId, "Elektrga 3 mln to'ladim"));

    const [asked] = w.telegram.of('sendMessage', w.owner.chatId);
    expect(labels(asked)).toEqual(['Naqd', 'Bank', 'Qarzga']);

    await send(textUpdate(w.owner.chatId, 'Naqd'));

    expect(lastUserText(requests[2])).toBe('Naqd');
    expect(lastCard(w).body.text).toContain('3 000 000');
  });

  it('category options use the translated name, in Russian too', async () => {
    const w = await world();
    await w.f.run(async () => {
      await tx().update(schema.users).set({ locale: 'ru' }).where(eq(schema.users.id, w.owner.client.userId));
      const category = (key: string, ru: string) => ({ tenantId: w.f.tenantId, kind: 'expense', group: 'other', key, name: { uz: 'Aralash', ru, en: key } });
      await tx().insert(schema.financeCategories).values([category('mix_feed', 'Смесь кормов'), category('mix_other', 'Прочая смесь')]);
    });
    scripted(toolCall('draft_expense', { amount: 3_000_000, paymentMethod: 'cash', category: 'Aralash' }), 'Какая именно?');

    await send(textUpdate(w.owner.chatId, 'За смесь 3 млн наличными'));

    expect(labels(w.telegram.of('sendMessage', w.owner.chatId)[0]).sort()).toEqual(['Прочая смесь', 'Смесь кормов']);
  });

  it('a list too long for buttons is asked in words', async () => {
    const w = await world();
    scripted(toolCall('draft_expense', { amount: 3_000_000, paymentMethod: 'cash' }), 'Nima uchun edi?');

    await send(textUpdate(w.owner.chatId, "3 mln naqd to'ladim"));

    expect(w.telegram.of('sendMessage', w.owner.chatId)[0].body.reply_markup).toEqual({ remove_keyboard: true });
  });

  it('the general cost center is named in the person\'s language', async () => {
    const w = await world();
    await w.f.run(async () => {
      await generalCostCenterId();
      const [field] = await tx().insert(schema.fields).values({ tenantId: w.f.tenantId, farmId: w.f.farmId, number: '7', areaHa: 5 }).returning();
      await ensureCostCenter('field', field.id, 'Dala 7');
    });
    scripted(toolCall('draft_expense', { amount: 3_000_000, category: 'mechanization_service', paymentMethod: 'cash' }), 'Qaysi dala?');

    await send(textUpdate(w.owner.chatId, "Mexanizatsiya xizmatiga 3 mln naqd to'ladim"));

    const options = labels(w.telegram.of('sendMessage', w.owner.chatId)[0]);
    expect(options).toContain('Dala 7');
    expect(options).toContain(tr('uz', 'enums', 'costCenterType.general'));
    expect(options).not.toContain('General');
  });

  const keyboard = (w: World) => {
    const sent = w.telegram.of('sendMessage', w.owner.chatId).at(-1)!;
    return (sent.body.reply_markup?.keyboard ?? []).flat().map((button: { text: string }) => button.text);
  };

  it('the wage question reaches the person, with its buttons in their language', async () => {
    const w = await world();
    const logger = log();
    scripted(toolCall('draft_expense', { amount: 2_500_000, category: 'security_guard', paymentMethod: 'cash' }), 'Bu ish haqimi yoki xizmatmi?');

    await send(textUpdate(w.owner.chatId, 'Qorovulga 2.5 mln naqd berdim'), logger);

    expect(w.telegram.sentTo(w.owner.chatId).at(-1)).toContain('ish haqimi');
    expect(keyboard(w)).toEqual([tr('uz', 'ai', 'records.options.wage'), tr('uz', 'ai', 'records.options.service')]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('the tonne-or-kilo question words its buttons as the web does', async () => {
    const w = await world();
    await w.f.run(async () => {
      const base = { tenantId: w.f.tenantId, farmId: w.f.farmId };
      const [store] = await tx().insert(schema.warehouses).values({ ...base, name: 'Ombor', type: 'feed' }).returning();
      await tx().insert(schema.items).values({ ...base, name: 'Kepak', category: 'feed', unit: 'kg', defaultWarehouseId: store.id });
    });
    scripted(toolCall('draft_stock_purchase', { item: 'Kepak', qty: 2, unit: 'tonna', unitPrice: 3000, paymentMethod: 'cash' }), 'Tonnasigami, kilosigami?');

    await send(textUpdate(w.owner.chatId, "Kepak oldim, 2 tonna, 3 mingdan, naqd to'ladim"));

    expect(keyboard(w)).toEqual([tr('uz', 'ai', 'records.options.per_ton'), tr('uz', 'ai', 'records.options.per_kg')]);
  });

  it('a question without options clears the options of an earlier one', async () => {
    const w = await world();
    scripted(toolCall('draft_expense', { category: 'electricity', paymentMethod: 'cash' }), 'Qancha edi?');

    await send(textUpdate(w.owner.chatId, "Elektrga naqd to'ladim"));

    const [asked] = w.telegram.of('sendMessage', w.owner.chatId);
    expect(asked.body.text).toBe('Qancha edi?');
    expect(asked.body.reply_markup).toEqual({ remove_keyboard: true });
  });
});

describe('rule 7: a role without finance.view', () => {
  it('is offered no money tools, and a tool it asks for anyway is denied', async () => {
    const f = await createFixture();
    const shepherd = await link(f, 'shepherd');
    await grantAi(f, 'shepherd');
    const telegram = fakeTelegram();
    const { requests } = scripted(toolCall('cash_position', {}), "Bu sizga ochiq emas.");

    await send(textUpdate(shepherd.chatId, 'Kassada qancha pul bor?'));

    expect(offered(requests[0])).not.toContain('cash_position');
    expect(offered(requests[0]).filter((name) => name.startsWith('draft_'))).toEqual([]);
    const result = requests[1].messages.at(-1)!.content[0] as { content: string; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content).toContain('does not have access');
    expect(telegram.sentTo(shepherd.chatId).at(-1)).toBe('Bu sizga ochiq emas.');
  });

  it('farm_status carries no cash for them, and does for the owner', async () => {
    const f = await createFixture();
    const owner = await link(f, 'owner');
    const shepherd = await link(f, 'shepherd');
    await grantAi(f, 'shepherd');
    fakeTelegram();
    const { requests } = scripted(toolCall('farm_status', {}), 'Yaxshi.', toolCall('farm_status', {}), 'Yaxshi.');

    await send(textUpdate(shepherd.chatId, 'Ahvol qanday?'));
    await send(textUpdate(owner.chatId, 'Ahvol qanday?'));

    const toolOutput = (request: LlmRequest) => (request.messages.at(-1)!.content[0] as { content: string }).content;
    expect(toolOutput(requests[1])).not.toContain('"cash"');
    expect(toolOutput(requests[3])).toContain('"cash"');
  });

  it('/holat hides cash from them', async () => {
    const w = await world();
    const shepherd = await link(w.f, 'shepherd');

    await send(textUpdate(w.owner.chatId, '/holat'));
    await send(textUpdate(shepherd.chatId, '/holat'));

    const moneyLine = tr('uz', 'alerts', 'digest.cash', { amount: '' }).trim().split(' ')[0];
    expect(w.telegram.sentTo(w.owner.chatId)[0]).toContain(moneyLine);
    expect(w.telegram.sentTo(shepherd.chatId)[0]).not.toContain(moneyLine);
  });

  it('a draft from before they lost finance.view shows no money and no buttons', async () => {
    const w = await world();
    const card = await draftCard(w);
    expect(card.body.text).toContain('3 000 000');
    await setRolePermissions(w.f, 'owner', DEFAULT_ROLE_PERMISSIONS.owner.filter((p) => p !== 'finance.view'));

    await send(textUpdate(w.owner.chatId, '/kutilmoqda'));

    const shown = w.telegram.of('sendMessage', w.owner.chatId).at(-1)!;
    expect(shown.body.text).toBe(tr('uz', 'alerts', 'bot.moneyHidden'));
    expect(shown.body.reply_markup).toBeUndefined();
  });

  it('pressing an old card keeps the amount off the edited card', async () => {
    const w = await world();
    const card = await draftCard(w);
    await setRolePermissions(w.f, 'owner', DEFAULT_ROLE_PERMISSIONS.owner.filter((p) => p !== 'finance.view'));

    await press(card, CONFIRM);

    const edit = w.telegram.edits().at(-1)!;
    expect(edit.body.text).not.toContain('3 000 000');
    expect(edit.body.reply_markup).toBeUndefined();
  });
});

describe('commands', () => {
  it('registers its commands in each language, for private chats, and polls for button presses', async () => {
    const telegram = fakeTelegram();

    const stop = startTelegramBot(log());
    await vi.waitFor(() => expect(telegram.of('getUpdates').length).toBeGreaterThan(0));
    await stop();

    const registered = telegram.of('setMyCommands');
    expect(registered.map((c) => c.body.language_code)).toEqual([undefined, 'ru', 'en']);
    expect(registered[0].body.commands.map((c: { command: string }) => c.command)).toEqual(['holat', 'ogohlantirishlar', 'kutilmoqda', 'yangi', 'ferma', 'yordam']);
    for (const call of registered) {
      for (const { description } of call.body.commands) expect(description).toMatch(/^\S.{0,255}$/);
      expect(call.body.scope).toEqual({ type: 'all_private_chats' });
    }
    expect(telegram.of('getUpdates')[0].body.allowed_updates).toEqual(['message', 'edited_message', 'callback_query']);
  });

  it('a failure to register commands does not stop the bot', async () => {
    const telegram = fakeTelegram();
    telegram.state.intercept = (call) => (call.method === 'setMyCommands' ? refused(400, 'Bad Request: nope') : undefined);
    const logger = log();

    const stop = startTelegramBot(logger);
    await vi.waitFor(() => expect(telegram.of('getUpdates').length).toBeGreaterThan(0));
    await stop();

    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('help lists only what works for a role without the assistant', async () => {
    const f = await createFixture();
    const shepherd = await link(f, 'shepherd');
    const telegram = fakeTelegram();

    await send(textUpdate(shepherd.chatId, '/yordam'));

    const [help] = telegram.sentTo(shepherd.chatId);
    expect(help).toContain('/holat');
    expect(help).not.toContain('/kutilmoqda');
    expect(help).not.toContain('/yangi');
  });

  it('/yangi with words starts afresh and takes the words as the first message', async () => {
    const w = await world();
    await draftCard(w);
    const { requests } = scripted('Yangi javob');

    await send(textUpdate(w.owner.chatId, '/yangi Fermada nechta qo\'y bor?'));

    expect(lastUserText(requests[0])).toBe("Fermada nechta qo'y bor?");
    expect(requests[0].messages).toHaveLength(1);
    expect(w.telegram.sentTo(w.owner.chatId).slice(-2)).toEqual([tr('uz', 'alerts', 'bot.newConversation'), 'Yangi javob']);
  });

  it('a group\'s service messages get no answer', async () => {
    const telegram = fakeTelegram();

    await send(messageUpdate('-100777', {}, 'supergroup'));
    await send(textUpdate('-100777', 'Salom', 'supergroup'));

    expect(telegram.sentTo('-100777')).toEqual([]);
  });

  it('an edited message is not read, and the person is told', async () => {
    const w = await world();
    const { requests } = scripted();
    const update = textUpdate(w.owner.chatId, "2 mln edi");

    await send({ update_id: update.update_id, edited_message: update.message });

    expect(requests).toHaveLength(0);
    expect(w.telegram.sentTo(w.owner.chatId)).toEqual([tr('uz', 'alerts', 'bot.editIgnored')]);
  });

  it('a provider out of quota is in the log, though the person gets a plain reply', async () => {
    const w = await world();
    const logger = log();
    scripted(new AppError(429, 'AI_PROVIDER_BUSY', 'Quota'));

    await send(textUpdate(w.owner.chatId, 'Salom'), logger);

    expect(logger.error).toHaveBeenCalled();
  });

  it('/kutilmoqda says how many it left out', async () => {
    const w = await world();
    await draftCard(w);
    await w.f.run(async () => {
      const [{ id, ...copy }] = await tx().select().from(schema.aiProposals);
      await tx().insert(schema.aiProposals).values(Array(11).fill(copy));
    });
    const before = w.telegram.of('sendMessage').length;

    await send(textUpdate(w.owner.chatId, '/kutilmoqda'));

    const shown = w.telegram.of('sendMessage').slice(before);
    expect(shown.filter((call) => buttonsOf(call).length > 0)).toHaveLength(10);
    expect(shown.at(-1)!.body.text).toBe(tr('uz', 'alerts', 'bot.pendingMore', { count: 2 }));
  });

  it('/yordam lists everything, in the person\'s language', async () => {
    const f = await createFixture();
    const owner = await link(f, 'owner');
    await f.run(() => tx().update(schema.users).set({ locale: 'ru' }).where(eq(schema.users.id, owner.client.userId)));
    const telegram = fakeTelegram();

    await send(textUpdate(owner.chatId, '/yordam'));

    const [help] = telegram.sentTo(owner.chatId);
    expect(help).toContain('голосовые');
    for (const command of ['/holat', '/ogohlantirishlar', '/kutilmoqda', '/yangi', '/yordam']) expect(help).toContain(command);
  });

  it('linking ends with the commands spelled out, none of them blank', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const telegram = fakeTelegram();
    const { data } = await owner.post('/notifications/telegram/link');

    await send(textUpdate('424242', `/start ${data.code}`));

    const [reply] = telegram.sentTo('424242');
    for (const command of ['/holat', '/ogohlantirishlar', '/yordam']) expect(reply).toContain(command);
  });
});

describe('updates are confirmed only once they are handled', () => {
  const offsets = (telegram: FakeTelegram) => telegram.of('getUpdates').map((call) => call.body.offset as number);

  it('the offset waits behind a running turn, and however often the update comes back it runs once', async () => {
    const f = await createFixture();
    const owner = await link(f, 'owner');
    const telegram = fakeTelegram();
    const { gate, release } = gated();
    const { requests } = scripted(async () => {
      await gate;
      return 'Javob';
    });
    const update = textUpdate(owner.chatId, 'Sekin');
    telegram.state.updates.push(update);

    const stop = startTelegramBot(log());
    await vi.waitFor(() => expect(telegram.of('getUpdates').length).toBeGreaterThan(2), { timeout: 5_000 });

    expect(Math.max(...offsets(telegram))).toBeLessThanOrEqual(update.update_id);
    release();
    await vi.waitFor(() => expect(Math.max(...offsets(telegram))).toBe(update.update_id + 1), { timeout: 5_000 });
    await stop();
    expect(requests).toHaveLength(1);
    expect(telegram.sentTo(owner.chatId)).toEqual(['Javob']);
  });

  it('while a turn runs it polls at a walk, not in a spin', async () => {
    const f = await createFixture();
    const owner = await link(f, 'owner');
    const telegram = fakeTelegram();
    const { gate, release } = gated();
    scripted(async () => {
      await gate;
      return 'Javob';
    });
    telegram.state.updates.push(textUpdate(owner.chatId, 'Sekin'));

    const stop = startTelegramBot(log());
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    expect(telegram.of('getUpdates').length).toBeLessThan(6);
    release();
    await stop();
  });

  it('a new message is still read while an old one is held', async () => {
    const f = await createFixture();
    const slow = await link(f, 'owner');
    const fast = await link(f, 'director');
    const telegram = fakeTelegram();
    const { gate, release } = gated();
    scripted(
      async (request) => {
        if (lastUserText(request) === 'Tez') return 'Tez javob';
        await gate;
        return 'Sekin javob';
      },
      async (request) => (lastUserText(request) === 'Tez' ? 'Tez javob' : 'Sekin javob'),
    );
    telegram.state.updates.push(textUpdate(slow.chatId, 'Sekin'));

    const stop = startTelegramBot(log());
    await vi.waitFor(() => expect(telegram.of('getUpdates').length).toBeGreaterThan(1));
    telegram.state.updates.push(textUpdate(fast.chatId, 'Tez'));

    await vi.waitFor(() => expect(telegram.sentTo(fast.chatId)).toEqual(['Tez javob']), { timeout: 5_000 });
    release();
    await stop();
  });

  it('stopping waits for the turn in hand, then tells Telegram what is done', async () => {
    const f = await createFixture();
    const owner = await link(f, 'owner');
    const telegram = fakeTelegram();
    const { gate, release } = gated();
    scripted(async () => {
      await gate;
      return 'Javob';
    });
    const update = textUpdate(owner.chatId, 'Sekin');
    telegram.state.updates.push(update);
    const stop = startTelegramBot(log());
    await vi.waitFor(() => expect(telegram.of('sendChatAction').length).toBeGreaterThan(0));

    const stopped = stop();
    release();
    await stopped;

    expect(telegram.sentTo(owner.chatId)).toEqual(['Javob']);
    expect(offsets(telegram).at(-1)).toBe(update.update_id + 1);
    expect(telegram.state.updates).toEqual([]);
  });

  it('what a crash cut off comes back and is handled; what was answered is not answered twice', async () => {
    const f = await createFixture();
    const owner = await link(f, 'owner');
    const telegram = fakeTelegram();
    const { requests } = scripted('Javob');
    const update = textUpdate(owner.chatId, 'Salom');

    await send(update);
    await send(update); // the restart got it back, because the poll confirming it never went out

    expect(requests).toHaveLength(1);
    expect(telegram.sentTo(owner.chatId)).toEqual(['Javob']);
  });

  it('a redelivered press after a crash changes nothing', async () => {
    const w = await world();
    const card = await draftCard(w);
    const pressed = pressUpdate(w.owner.chatId, buttonsOf(card)[0].callback_data, card.messageId!);

    await send(pressed);
    await send(pressed);

    expect(await transactions(w)).toHaveLength(1);
  });

  it('an update stuck far behind does not hide newer ones for long', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const ledger = createUpdateLedger();
      ledger.admit(1000);
      for (let id = 1001; id <= 1200; id++) {
        ledger.admit(id);
        ledger.finish(id);
      }
      expect(ledger.offset()).toBe(1000);

      vi.setSystemTime(Date.now() + 6 * 60_000);

      expect(ledger.offset()).toBeGreaterThan(1000);
      expect(ledger.admit(1100)).toBe(false);
      expect(ledger.idle()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a backlog after an outage stays with Telegram until it is handled', () => {
    const ledger = createUpdateLedger();
    for (let id = 1; id <= 150; id++) ledger.admit(id);

    expect(ledger.offset()).toBe(1);
    for (let id = 1; id <= 40; id++) ledger.finish(id);
    expect(ledger.offset()).toBe(41);
  });

  it('after a quiet week Telegram\'s next id can be lower, and it is still new', () => {
    const ledger = createUpdateLedger();
    ledger.admit(9_000);
    ledger.finish(9_000);

    expect(ledger.admit(4_000)).toBe(true);
    ledger.finish(4_000);
    expect(ledger.offset()).toBe(4_001);
  });

  it('a flood that was dropped does not hold the offset back', () => {
    const ledger = createUpdateLedger();
    ledger.admit(5);
    ledger.admit(6);
    ledger.finish(5);
    ledger.finish(6);

    expect(ledger.offset()).toBe(7);
    expect(ledger.idle()).toBe(true);
  });

  it('a 429 on getUpdates waits as long as Telegram says, not a fixed time', async () => {
    const telegram = fakeTelegram();
    let limited = false;
    telegram.state.intercept = (call) => {
      if (call.method !== 'getUpdates' || limited) return undefined;
      limited = true;
      return new Response(JSON.stringify({ ok: false, description: 'Too Many Requests', parameters: { retry_after: 0.05 } }), { status: 429 });
    };
    const started = Date.now();

    const stop = startTelegramBot(log());
    await vi.waitFor(() => expect(telegram.of('getUpdates').length).toBeGreaterThan(1), { timeout: 2_000 });
    await stop();

    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('what the outbox still lets out', () => {
  const withoutFinance = DEFAULT_ROLE_PERMISSIONS.accountant.filter((p) => p !== 'finance.view');

  it('text with money stops, and leaves the inbox, once its reader loses finance.view', async () => {
    const f = await createFixture();
    const accountant = await link(f, 'accountant');
    const telegram = fakeTelegram();
    await f.run(() =>
      raiseAlert({ ruleKey: 'budget_exceeded', dedupKey: 'b-1', severity: 'urgent', title: "Byudjet: 120 000 000 so'm sarflandi", notify: ['accountant'], permission: 'finance.view' }),
    );
    expect((await accountant.client.get('/notifications')).data).toHaveLength(1);
    await setRolePermissions(f, 'accountant', withoutFinance);

    const result = await f.run(() => dispatchPending());

    expect(result).toMatchObject({ sent: 0, skipped: 1 });
    expect(telegram.sentTo(accountant.chatId)).toEqual([]);
    expect((await accountant.client.get('/notifications')).data).toEqual([]);
    expect((await accountant.client.get('/notifications/unread-count')).data.count).toBe(0);
  });

  it('it still goes to whoever keeps the right, and to anyone when it needs none', async () => {
    const f = await createFixture();
    const accountant = await link(f, 'accountant');
    const telegram = fakeTelegram();
    await f.run(() => raiseAlert({ ruleKey: 'budget_exceeded', dedupKey: 'b-1', severity: 'urgent', title: 'Pul', notify: ['accountant'], permission: 'finance.view' }));
    await f.run(() => raiseAlert({ ruleKey: 'sick', dedupKey: 's-1', severity: 'urgent', title: 'Kasal', notify: ['accountant'] }));

    await f.run(() => dispatchPending());

    expect(telegram.sentTo(accountant.chatId)).toHaveLength(2);
  });

  it('the evening recap and a summary with cash stop the same way', async () => {
    const f = await createFixture();
    const owner = await link(f, 'owner');
    const telegram = fakeTelegram();
    await f.run(() => notifyUser(owner.client.userId, { eventType: 'assistant_recap', severity: 'info', title: 'Bugun: 3 mln' }));
    await f.run(() => sendDailySummary());
    await setRolePermissions(f, 'owner', DEFAULT_ROLE_PERMISSIONS.owner.filter((p) => p !== 'finance.view'));

    await f.run(() => dispatchPending());

    expect(telegram.sentTo(owner.chatId)).toEqual([]);
  });

  it('a summary with no cash in it goes out whatever became of finance.view', async () => {
    const f = await createFixture();
    const owner = await link(f, 'owner');
    const telegram = fakeTelegram();
    await setRolePermissions(f, 'owner', DEFAULT_ROLE_PERMISSIONS.owner.filter((p) => p !== 'finance.view'));
    await f.run(() => sendDailySummary());

    await f.run(() => dispatchPending());

    expect(telegram.sentTo(owner.chatId)).toHaveLength(1);
  });

  it('an alert someone has since resolved is not announced', async () => {
    const w = await world();
    const { id } = await w.f.run(() => raiseAlert({ ruleKey: 'device_event', dedupKey: 'fire', severity: 'urgent', title: "Yong'in", notify: ['owner'] }));
    expect((await w.owner.client.post(`/alerts/${id}/resolve`)).status).toBe(200);

    const result = await w.f.run(() => dispatchPending());

    expect(result).toMatchObject({ sent: 0, skipped: 1 });
    expect(w.telegram.sentTo(w.owner.chatId)).toEqual([]);
  });

  it('one that was only acknowledged still goes out, because the others have not heard', async () => {
    const w = await world();
    const { id } = await w.f.run(() => raiseAlert({ ruleKey: 'device_event', dedupKey: 'fire', severity: 'urgent', title: "Yong'in", notify: ['owner'] }));
    await w.owner.client.post(`/alerts/${id}/acknowledge`);

    await w.f.run(() => dispatchPending());

    expect(w.telegram.sentTo(w.owner.chatId)).toHaveLength(1);
  });

  it('a message that waited out an outage says when it really happened, in the reader\'s language', async () => {
    const w = await world();
    await w.f.run(() => tx().update(schema.users).set({ locale: 'ru' }).where(eq(schema.users.id, w.owner.client.userId)));
    await w.f.run(() => raiseAlert({ ruleKey: 'device_event', dedupKey: 'fire', severity: 'urgent', title: "Yong'in", notify: ['owner'] }));
    const hourAgo = new Date(Date.now() - 3_600_000);
    await w.f.run(() => tx().update(schema.notifications).set({ createdAt: hourAgo }));

    await w.f.run(() => dispatchPending());

    const time = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(hourAgo);
    expect(w.telegram.sentTo(w.owner.chatId).at(-1)).toContain(tr('ru', 'alerts', 'bot.sentLate', { time }));
  });

  it('one that went out on time says nothing of the kind', async () => {
    const w = await world();
    await w.f.run(() => raiseAlert({ ruleKey: 'device_event', dedupKey: 'fire', severity: 'urgent', title: "Yong'in", notify: ['owner'] }));

    await w.f.run(() => dispatchPending());

    expect(w.telegram.sentTo(w.owner.chatId).at(-1)).toBe("🔴 <b>Yong'in</b>");
  });
});

describe('a stuck model call', () => {
  function stuck(w: World) {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    scripted(async () => {
      await gate;
      return 'Nihoyat';
    });
    return release;
  }

  it('does not hold back alerts, status, Cancel or Undo', async () => {
    const w = await world();
    const toCancel = await draftCard(w);
    const toUndo = await draftCard(w, { ...electricity, amount: 2_000_000 }, "Elektrga 2 mln naqd to'ladim");
    await press(toUndo, CONFIRM);
    const undo = w.telegram.edits().at(-1)!;
    const release = stuck(w);
    const before = w.telegram.sentTo(w.owner.chatId).length;

    w.telegram.state.updates.push(textUpdate(w.owner.chatId, 'Uzoq savol'));
    const stop = startTelegramBot(log());
    await vi.waitFor(() => expect(w.telegram.of('sendChatAction').length).toBeGreaterThan(0));
    w.telegram.state.updates.push(
      textUpdate(w.owner.chatId, '/ogohlantirishlar'),
      textUpdate(w.owner.chatId, '/holat'),
      pressUpdate(w.owner.chatId, buttonsOf(toCancel).find((b) => b.text === CANCEL)!.callback_data, toCancel.messageId!),
      pressUpdate(w.owner.chatId, buttonsOf(undo)[0].callback_data, messageIdOf(undo)),
    );

    await vi.waitFor(() => expect(w.telegram.notices()).toHaveLength(3), { timeout: 5_000 });
    await vi.waitFor(() => expect(w.telegram.sentTo(w.owner.chatId).length).toBeGreaterThanOrEqual(before + 2));
    expect((await proposals(w)).map((p) => p.status).sort()).toEqual(['rejected', 'undone']);
    expect(w.telegram.sentTo(w.owner.chatId)).not.toContain('Nihoyat');

    release();
    await stop();
    expect(w.telegram.sentTo(w.owner.chatId)).toContain('Nihoyat');
  });

  it('Confirm keeps its place behind the turn, so it sees a correction made just before it', async () => {
    const w = await world();
    const card = await draftCard(w);
    const release = stuck(w);

    w.telegram.state.updates.push(textUpdate(w.owner.chatId, 'Uzoq savol'), pressUpdate(w.owner.chatId, buttonsOf(card)[0].callback_data, card.messageId!));
    const stop = startTelegramBot(log());
    await vi.waitFor(() => expect(w.telegram.of('sendChatAction').length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(await transactions(w)).toHaveLength(0);
    release();
    await vi.waitFor(() => expect(w.telegram.notices()).toHaveLength(1));
    await stop();
    expect(await transactions(w)).toHaveLength(1);
  });

  it('past the hold, a Confirm with the turn still out is told to wait, and the correction lands on the card', async () => {
    const w = await world();
    const card = await draftCard(w);
    const [draft] = await proposals(w);
    const { gate, release } = gated();
    scripted(
      async () => {
        await gate;
        return toolCall('update_draft', { proposalId: draft.id, changes: { amount: 2_000_000 } });
      },
      'Tuzatdim.',
    );
    w.telegram.state.updates.push(textUpdate(w.owner.chatId, "Yo'q, 2 mln naqd"));
    const stop = startTelegramBot(log(), 20);
    await vi.waitFor(() => expect(w.telegram.of('sendChatAction').length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 60));

    w.telegram.state.updates.push(pressUpdate(w.owner.chatId, buttonsOf(card)[0].callback_data, card.messageId!));
    await vi.waitFor(() => expect(w.telegram.notices()).toEqual([tr('uz', 'alerts', 'bot.waitForAnswer')]), { timeout: 5_000 });
    expect(await transactions(w)).toEqual([]);

    release();
    await stop();
    expect(await transactions(w)).toEqual([]);
    expect(((await proposals(w))[0].fields as { amount: number }).amount).toBe(2_000_000);
  });

  it('work that must not overtake gets its stand-in while anything earlier runs, and only then', async () => {
    const queue = createChatQueue(log(), 20);
    const order: string[] = [];
    const { gate, release } = gated();
    const booking = () => queue('1', async () => void order.push('booked'), async () => void order.push('told to wait'));

    queue('1', async () => {
      await gate;
      order.push('stuck');
    });
    booking();
    await vi.waitFor(() => expect(order).toEqual(['told to wait']));

    // The lane has drained by now, and the turn is still out.
    booking();
    await vi.waitFor(() => expect(order).toEqual(['told to wait', 'told to wait']));
    expect(queue.busy('1')).toBe(true);

    release();
    await vi.waitFor(() => expect(queue.busy('1')).toBe(false));
    booking();
    await vi.waitFor(() => expect(order.at(-1)).toBe('booked'));
  });

  it('holds a lane only so long: what waits moves on, and the stuck work still finishes', async () => {
    const logger = log();
    const queue = createChatQueue(logger, 20);
    const order: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));

    queue('1', async () => {
      await gate;
      order.push('stuck');
    });
    queue('1', async () => {
      order.push('next');
    });

    await vi.waitFor(() => expect(order).toEqual(['next']));
    release();
    await vi.waitFor(() => expect(order).toEqual(['next', 'stuck']));
  });
});

describe('an album', () => {
  const page = (chatId: string, fileId: string, caption?: string) =>
    messageUpdate(chatId, { media_group_id: 'album-1', caption, photo: [{ file_id: fileId, file_size: 4 }] });

  it('is one question: all its pages in one request, under its one caption', async () => {
    const w = await world({}, { one: Buffer.from('P1'), two: Buffer.from('P2'), three: Buffer.from('P3') });
    const { requests } = scripted('[]', 'Uch sahifa.');
    const pages = [page(w.owner.chatId, 'one', 'Bu faktura'), page(w.owner.chatId, 'two'), page(w.owner.chatId, 'three')];
    w.telegram.state.updates.push(...pages);

    const stop = startTelegramBot(log());
    await vi.waitFor(() => expect(w.telegram.sentTo(w.owner.chatId)).toEqual(['Uch sahifa.']), { timeout: 5_000 });
    await vi.waitFor(() => expect(w.telegram.of('getUpdates').at(-1)!.body.offset).toBe(pages[2].update_id + 1), { timeout: 5_000 });
    await stop();

    expect(requests).toHaveLength(2);
    const blocks = lastUserBlocks(requests[1]);
    expect(blocks.filter((block) => block.type === 'image')).toHaveLength(3);
    expect(blocks.some((block) => block.type === 'text' && block.text === 'Bu faktura')).toBe(true);
  });

  it('a page arriving a moment later still joins it', async () => {
    const w = await world({}, { one: Buffer.from('P1'), two: Buffer.from('P2') });
    const { requests } = scripted('[]', 'Ikki sahifa.');

    w.telegram.state.updates.push(page(w.owner.chatId, 'one', 'Bu faktura'));
    const stop = startTelegramBot(log());
    await new Promise((resolve) => setTimeout(resolve, 300));
    w.telegram.state.updates.push(page(w.owner.chatId, 'two'));

    await vi.waitFor(() => expect(w.telegram.sentTo(w.owner.chatId)).toEqual(['Ikki sahifa.']), { timeout: 5_000 });
    await stop();
    expect(lastUserBlocks(requests[1]).filter((block) => block.type === 'image')).toHaveLength(2);
  });
});

describe('order and concurrency', () => {
  function poll(telegram: FakeTelegram, updates: TelegramUpdate[], logger = log()) {
    telegram.state.updates.push(...updates);
    return startTelegramBot(logger);
  }

  it('a slow model call in one chat does not hold up another chat, or the poller', async () => {
    const f = await createFixture();
    const slow = await link(f, 'owner');
    const fast = await link(f, 'director');
    const telegram = fakeTelegram();
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    // Both chats reach the model at once, so the answer follows the question, not the order of arrival.
    const answer = async (request: LlmRequest) => {
      if (lastUserText(request) === 'Tez') return 'Tez javob';
      await gate;
      return 'Sekin javob';
    };
    scripted(answer, answer);

    const stop = poll(telegram, [textUpdate(slow.chatId, 'Sekin'), textUpdate(fast.chatId, 'Tez')]);

    await vi.waitFor(() => expect(telegram.sentTo(fast.chatId)).toEqual(['Tez javob']));
    expect(telegram.sentTo(slow.chatId)).toEqual([]);
    expect(telegram.of('getUpdates').length).toBeGreaterThan(1);
    release();
    await vi.waitFor(() => expect(telegram.sentTo(slow.chatId)).toEqual(['Sekin javob']));
    await stop();
  });

  it('messages in one chat are handled strictly one at a time, in order', async () => {
    const f = await createFixture();
    const owner = await link(f, 'owner');
    const telegram = fakeTelegram();
    let running = 0;
    let most = 0;
    const answer = (text: string) => async () => {
      most = Math.max(most, ++running);
      await new Promise((resolve) => setTimeout(resolve, 30));
      running--;
      return text;
    };
    const { requests } = scripted(answer('Birinchi'), answer('Ikkinchi'), answer('Uchinchi'));

    const stop = poll(telegram, [textUpdate(owner.chatId, 'bir'), textUpdate(owner.chatId, 'ikki'), textUpdate(owner.chatId, 'uch')]);

    await vi.waitFor(() => expect(telegram.sentTo(owner.chatId)).toHaveLength(3));
    await stop();
    expect(most).toBe(1);
    expect(telegram.sentTo(owner.chatId)).toEqual(['Birinchi', 'Ikkinchi', 'Uchinchi']);
    expect(requests.map(lastUserText)).toEqual(['bir', 'ikki', 'uch']);
  });

  it('a button pressed while a message is being answered waits its turn', async () => {
    const w = await world();
    const card = await draftCard(w);
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    scripted(async () => {
      await gate;
      return 'Javob';
    });

    const stop = poll(w.telegram, [
      textUpdate(w.owner.chatId, 'Sekin savol'),
      pressUpdate(w.owner.chatId, buttonsOf(card)[0].callback_data, card.messageId!),
    ]);

    await vi.waitFor(() => expect(w.telegram.of('getUpdates').length).toBeGreaterThan(1));
    expect(await transactions(w)).toHaveLength(0);
    release();
    await vi.waitFor(() => expect(w.telegram.of('answerCallbackQuery')).toHaveLength(1));
    await stop();
    expect(await transactions(w)).toHaveLength(1);
  });

  it('a double tap through the poller records once', async () => {
    const w = await world();
    const card = await draftCard(w);
    const data = buttonsOf(card)[0].callback_data;

    const stop = poll(w.telegram, [pressUpdate(w.owner.chatId, data, card.messageId!), pressUpdate(w.owner.chatId, data, card.messageId!)]);

    await vi.waitFor(() => expect(w.telegram.of('answerCallbackQuery')).toHaveLength(2));
    await stop();
    expect(await transactions(w)).toHaveLength(1);
  });

  it('one failed update does not stop the ones after it', async () => {
    const logger = log();
    const queue = createChatQueue(logger);
    const order: string[] = [];
    queue('1', async () => {
      order.push('first');
      throw new Error('boom');
    });
    queue('1', async () => {
      order.push('second');
    });

    await vi.waitFor(() => expect(order).toEqual(['first', 'second']));
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('a flood from one chat is dropped past the limit instead of queueing without end', async () => {
    const logger = log();
    const queue = createChatQueue(logger);
    let finish = () => {};
    const blocked = new Promise<void>((resolve) => (finish = resolve));
    let ran = 0;
    for (let i = 0; i < 60; i++) {
      queue('1', async () => {
        ran++;
        await blocked;
      });
    }
    finish();

    await vi.waitFor(() => expect(ran).toBe(50));
    expect(logger.error).toHaveBeenCalledTimes(10);
  });

  it('shows typing before it answers', async () => {
    const f = await createFixture();
    const owner = await link(f, 'owner');
    const telegram = fakeTelegram();
    scripted('Javob');

    await send(textUpdate(owner.chatId, 'Salom'));

    expect(telegram.of('sendChatAction', owner.chatId)[0].body.action).toBe('typing');
    const methods = telegram.calls.map((c) => c.method);
    expect(methods.indexOf('sendChatAction')).toBeLessThan(methods.indexOf('sendMessage'));
  });

  it('keeps showing typing through a long call, and stops afterwards', async () => {
    const f = await createFixture();
    const owner = await link(f, 'owner');
    const telegram = fakeTelegram();
    const started = vi.spyOn(globalThis, 'setInterval');
    const stopped = vi.spyOn(globalThis, 'clearInterval');
    const typing = () => started.mock.results[started.mock.calls.findIndex(([, ms]) => ms === 4000)]?.value;
    scripted(async () => {
      expect(telegram.of('sendChatAction')).toHaveLength(1);
      expect(stopped).not.toHaveBeenCalledWith(typing());
      (started.mock.calls.find(([, ms]) => ms === 4000)![0] as () => void)();
      return 'Javob';
    });

    await send(textUpdate(owner.chatId, 'Salom'));

    expect(telegram.of('sendChatAction')).toHaveLength(2);
    expect(stopped).toHaveBeenCalledWith(typing());
  });

  it('a refused typing call does not stop the answer', async () => {
    const f = await createFixture();
    const owner = await link(f, 'owner');
    const telegram = fakeTelegram();
    telegram.state.intercept = (call) => (call.method === 'sendChatAction' ? refused(429, 'Too Many Requests') : undefined);
    scripted('Javob');

    await send(textUpdate(owner.chatId, 'Salom'));

    expect(telegram.sentTo(owner.chatId)).toEqual(['Javob']);
  });
});

describe('voice notes', () => {
  const voice = (chatId: string, file: Partial<TelegramFile> = {}) =>
    messageUpdate(chatId, { voice: { file_id: 'voice.oga', duration: 4, mime_type: 'audio/ogg', ...file } });
  const heard = (transcript: string) => JSON.stringify({ speechHeard: true, transcript });

  it('shows the transcript first, then answers it as the person\'s own message', async () => {
    const w = await world({}, { 'voice.oga': Buffer.from('OggS-voice') });
    const { requests } = scripted(heard("Fermada nechta qo'y bor?"), '500 bosh.');

    await send(voice(w.owner.chatId));

    const audio = lastUserBlocks(requests[0]).find((block) => block.type === 'audio') as Extract<LlmBlock, { type: 'audio' }>;
    expect(audio.mediaType).toBe('audio/ogg');
    expect(Buffer.from(audio.dataBase64, 'base64').toString()).toBe('OggS-voice');
    expect(requests[0].tools ?? []).toEqual([]);

    expect(lastUserBlocks(requests[1])).toEqual([{ type: 'text', text: "Fermada nechta qo'y bor?" }]);
    const [transcript, answer] = w.telegram.sentTo(w.owner.chatId);
    expect(transcript).toContain("Fermada nechta qo'y bor?");
    expect(transcript).toContain(tr('uz', 'alerts', 'bot.heard'));
    expect(answer).toBe('500 bosh.');

    const stored = await w.f.run(() => tx().select({ content: schema.aiMessages.content }).from(schema.aiMessages));
    expect(stored.map((row) => (row.content as { text: string }).text)).toContain("Fermada nechta qo'y bor?");
  });

  it('a spoken amount counts as their words, so it can become a card', async () => {
    const w = await world({}, { 'voice.oga': Buffer.from('OggS') });
    scripted(heard("Elektrga 3 mln naqd to'ladim"), toolCall('draft_expense', electricity), 'Tasdiqlang.');

    await send(voice(w.owner.chatId));

    expect(lastCard(w).body.text).toContain('3 000 000');
    await press(lastCard(w), CONFIRM);
    expect((await transactions(w))[0].amount).toBe(3_000_000);
  });

  it('escapes the transcript', async () => {
    const w = await world({}, { 'voice.oga': Buffer.from('OggS') });
    scripted(heard('<b>salom</b> & xayr'), 'Javob');

    await send(voice(w.owner.chatId));

    expect(w.telegram.sentTo(w.owner.chatId)[0]).toContain('&lt;b&gt;salom&lt;/b&gt; &amp; xayr');
  });

  it('nothing heard: says so, drops whatever the model made up, and asks the assistant nothing', async () => {
    const w = await world({}, { 'voice.oga': Buffer.from('OggS') });
    const { requests } = scripted(JSON.stringify({ speechHeard: false, transcript: 'hayoliy matn' }));

    await send(voice(w.owner.chatId));

    expect(requests).toHaveLength(1);
    expect(w.telegram.sentTo(w.owner.chatId)).toEqual([tr('uz', 'alerts', 'bot.nothingHeard')]);
    expect(await conversations(w.f)).toHaveLength(0);
  });

  it('a note over the size or length cap is refused before anything is downloaded', async () => {
    const w = await world();
    const { requests } = scripted();

    await send(voice(w.owner.chatId, { file_size: 6 * 1024 * 1024 }));
    await send(voice(w.owner.chatId, { duration: 181 }));

    expect(w.telegram.of('getFile')).toHaveLength(0);
    expect(requests).toHaveLength(0);
    expect(w.telegram.sentTo(w.owner.chatId)).toEqual([
      tr('uz', 'alerts', 'bot.fileTooLarge', { limit: 5 }),
      tr('uz', 'alerts', 'bot.voiceTooLong', { limit: 3 }),
    ]);
  });

  it('a download larger than Telegram declared is cut off at the cap', async () => {
    const w = await world({}, { 'voice.oga': Buffer.alloc(6 * 1024 * 1024) });
    const { requests } = scripted();

    await send(voice(w.owner.chatId));

    expect(requests).toHaveLength(0);
    expect(w.telegram.sentTo(w.owner.chatId)).toEqual([tr('uz', 'alerts', 'bot.fileTooLarge', { limit: 5 })]);
  });

  it('an audio file works like a voice note, and an unknown format is refused', async () => {
    const w = await world({}, { 'a.mp3': Buffer.from('ID3') });
    const { requests } = scripted(heard('Salom'), 'Javob');

    await send(messageUpdate(w.owner.chatId, { audio: { file_id: 'a.mp3', mime_type: 'audio/mpeg', duration: 3 } }));
    await send(messageUpdate(w.owner.chatId, { audio: { file_id: 'a.xyz', mime_type: 'audio/x-unknown', duration: 3 } }));

    expect((lastUserBlocks(requests[0])[0] as { mediaType: string }).mediaType).toBe('audio/mpeg');
    expect(w.telegram.sentTo(w.owner.chatId).at(-1)).toBe(tr('uz', 'alerts', 'bot.unsupported'));
  });

  it('three minutes of ordinary speech is accepted, past what the chat box allows for typing', async () => {
    const w = await world({}, { 'voice.oga': Buffer.from('OggS') });
    const { requests } = scripted(heard('oddiy gap '.repeat(380)), 'Javob');

    await send(voice(w.owner.chatId, { duration: 175 }));

    expect(requests).toHaveLength(2);
    expect(w.telegram.sentTo(w.owner.chatId).at(-1)).toBe('Javob');
  });

  it('a transcript too long even for that is shown, not sent on, and refused in a speaker\'s terms', async () => {
    const w = await world({}, { 'voice.oga': Buffer.from('OggS') });
    const { requests } = scripted(heard('juda uzun '.repeat(500)));

    await send(voice(w.owner.chatId));

    expect(requests).toHaveLength(1);
    expect(w.telegram.sentTo(w.owner.chatId).at(-1)).toBe(tr('uz', 'alerts', 'bot.voiceTooLong', { limit: 3 }));
  });

  it('typed text keeps the chat box limit', async () => {
    const w = await world();
    const { requests } = scripted();

    await send(textUpdate(w.owner.chatId, 'x'.repeat(2001)));

    expect(requests).toHaveLength(0);
    expect(w.telegram.sentTo(w.owner.chatId)).toEqual([tr('uz', 'alerts', 'bot.tooLong', { limit: 2000 })]);
  });

  it('a caption on a voice note is the person\'s words too', async () => {
    const w = await world({}, { 'voice.oga': Buffer.from('OggS') });
    const { requests } = scripted(heard('Elektrga to\'ladim'), 'Javob');

    await send(messageUpdate(w.owner.chatId, { caption: '3 mln, naqd', voice: { file_id: 'voice.oga', duration: 4, mime_type: 'audio/ogg' } }));

    expect(lastUserText(requests[1])).toContain("Elektrga to'ladim");
    expect(lastUserText(requests[1])).toContain('3 mln, naqd');
  });

  it('a caption survives a note with no speech in it', async () => {
    const w = await world({}, { 'voice.oga': Buffer.from('OggS') });
    const { requests } = scripted(JSON.stringify({ speechHeard: false, transcript: '' }), 'Javob');

    await send(messageUpdate(w.owner.chatId, { caption: '3 mln, naqd', voice: { file_id: 'voice.oga', duration: 4, mime_type: 'audio/ogg' } }));

    expect(lastUserText(requests[1])).toBe('3 mln, naqd');
    expect(w.telegram.sentTo(w.owner.chatId).at(-1)).toBe('Javob');
  });

  it('audio sent as a file is heard like a voice note', async () => {
    const w = await world({}, { 'a.ogg': Buffer.from('OggS') });
    const { requests } = scripted(heard('Salom'), 'Javob');

    await send(messageUpdate(w.owner.chatId, { document: { file_id: 'a.ogg', mime_type: 'audio/ogg', file_size: 4 } }));

    expect((lastUserBlocks(requests[0])[0] as { mediaType: string }).mediaType).toBe('audio/ogg');
    expect(w.telegram.sentTo(w.owner.chatId).at(-1)).toBe('Javob');
  });

  it('silent notes, which never become questions, still stop at the day\'s limit', async () => {
    const w = await world({}, { 'voice.oga': Buffer.from('OggS') });
    const silence = JSON.stringify({ speechHeard: false, transcript: '' });
    const { requests } = scripted(...Array<string>(201).fill(silence));
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 7_000)); // slower than the limit for a minute

    for (let i = 0; i < 201; i++) await send(voice(w.owner.chatId));

    expect(requests).toHaveLength(200);
    expect(w.telegram.sentTo(w.owner.chatId).at(-1)).toBe(tr('uz', 'alerts', 'bot.rateLimited', { minutes: 60 }));
  });

  it('on Claude a voice note gets a clear reply, not an apology', async () => {
    const w = await world({}, { 'voice.oga': Buffer.from('OggS') });
    setProvider(new ClaudeProvider({ client: { beta: { messages: { create: async () => ({}) } } } }));

    await send(voice(w.owner.chatId));

    expect(w.telegram.sentTo(w.owner.chatId)).toEqual([tr('uz', 'alerts', 'errors.AI_AUDIO_NOT_SUPPORTED')]);
  });

  it('a transcription that fails asks them to repeat, and nothing goes to the assistant', async () => {
    const w = await world({}, { 'voice.oga': Buffer.from('OggS') });
    const { requests } = scripted('this is not the agreed JSON');

    await send(voice(w.owner.chatId));

    expect(requests).toHaveLength(1);
    expect(w.telegram.sentTo(w.owner.chatId)).toEqual([tr('uz', 'alerts', 'errors.AI_TRANSCRIPTION_FAILED')]);
  });
});

describe('photos and documents', () => {
  /** chat() reads a document's amounts in a step of its own before the model answers. */
  const READ_RECEIPT = '[{"amount":150000,"currency":"UZS"}]';
  const NO_AMOUNTS = '[]';

  it('a photo reaches the assistant as an image with its caption, in its largest size', async () => {
    const w = await world({}, { big: Buffer.from('JPEG-big') });
    const { requests } = scripted(NO_AMOUNTS, 'Chekda 150 000 yozilgan.');

    await send(
      messageUpdate(w.owner.chatId, {
        caption: 'Bu chek',
        photo: [
          { file_id: 'small', file_size: 10 },
          { file_id: 'big', file_size: 100 },
        ],
      }),
    );

    expect(w.telegram.downloads).toEqual(['big']);
    const blocks = lastUserBlocks(requests[1]);
    const image = blocks.find((block) => block.type === 'image') as Extract<LlmBlock, { type: 'image' }>;
    expect(image.mediaType).toBe('image/jpeg');
    expect(Buffer.from(image.dataBase64, 'base64').toString()).toBe('JPEG-big');
    expect(blocks.some((block) => block.type === 'text' && block.text === 'Bu chek')).toBe(true);
    expect(w.telegram.sentTo(w.owner.chatId).at(-1)).toContain('150 000');
  });

  it('skips a size over the cap, and reads the next one down', async () => {
    const w = await world({}, { medium: Buffer.from('JPEG') });
    scripted(NO_AMOUNTS, 'Javob');

    await send(
      messageUpdate(w.owner.chatId, {
        photo: [
          { file_id: 'medium', file_size: 100 },
          { file_id: 'huge', file_size: 11 * 1024 * 1024 },
        ],
      }),
    );

    expect(w.telegram.downloads).toEqual(['medium']);
  });

  it('an amount read from a photo can become a card, marked as coming from the document', async () => {
    const w = await world({}, { receipt: Buffer.from('JPEG') });
    scripted(READ_RECEIPT, toolCall('draft_expense', { amount: 150_000, category: 'electricity', paymentMethod: 'cash' }), 'Tasdiqlang.');

    await send(messageUpdate(w.owner.chatId, { caption: 'Elektr uchun, naqd', photo: [{ file_id: 'receipt', file_size: 4 }] }));

    const [proposal] = await proposals(w);
    expect(proposal.warnings.map((warning) => warning.code)).toContain('AMOUNT_FROM_DOCUMENT');
    expect(lastCard(w).body.text).toContain('150 000');
  });

  it('a PDF reaches it as a document, and no caption gets a default request', async () => {
    const w = await world({}, { 'bill.pdf': Buffer.from('%PDF-') });
    const { requests } = scripted(NO_AMOUNTS, 'Hisob-faktura.');

    await send(messageUpdate(w.owner.chatId, { document: { file_id: 'bill.pdf', mime_type: 'application/pdf', file_size: 5 } }));

    const blocks = lastUserBlocks(requests[1]);
    expect(blocks.some((block) => block.type === 'document')).toBe(true);
    expect(blocks.some((block) => block.type === 'text' && block.text === tr('uz', 'alerts', 'bot.documentPrompt'))).toBe(true);
  });

  it('an image sent as a file is read too', async () => {
    const w = await world({}, { 'a.png': Buffer.from('PNG') });
    const { requests } = scripted(NO_AMOUNTS, 'Javob');

    await send(messageUpdate(w.owner.chatId, { document: { file_id: 'a.png', mime_type: 'image/png', file_size: 3 } }));

    expect(lastUserBlocks(requests[1]).some((block) => block.type === 'image' && block.mediaType === 'image/png')).toBe(true);
  });

  it('refuses a file type it cannot read, and a file over the cap, before downloading', async () => {
    const w = await world();
    const { requests } = scripted();

    await send(messageUpdate(w.owner.chatId, { document: { file_id: 'a.zip', mime_type: 'application/zip', file_size: 5 } }));
    await send(messageUpdate(w.owner.chatId, { document: { file_id: 'b.pdf', mime_type: 'application/pdf', file_size: 11 * 1024 * 1024 } }));
    await send(messageUpdate(w.owner.chatId, { photo: [{ file_id: 'huge', file_size: 11 * 1024 * 1024 }] }));

    expect(w.telegram.of('getFile')).toHaveLength(0);
    expect(requests).toHaveLength(0);
    expect(w.telegram.sentTo(w.owner.chatId)).toEqual([
      tr('uz', 'alerts', 'bot.unsupported'),
      tr('uz', 'alerts', 'bot.fileTooLarge', { limit: 10 }),
      tr('uz', 'alerts', 'bot.fileTooLarge', { limit: 10 }),
    ]);
  });

  it('a picture type the model cannot read is refused with what to do instead', async () => {
    const w = await world();
    const { requests } = scripted();

    await send(messageUpdate(w.owner.chatId, { document: { file_id: 'a.heic', mime_type: 'image/heic', file_size: 5 } }));

    expect(requests).toHaveLength(0);
    expect(w.telegram.sentTo(w.owner.chatId)).toEqual([tr('uz', 'alerts', 'bot.sendAsPhoto')]);
  });

  it('a role the web refuses a document is refused here too', async () => {
    const w = await world();
    await setRolePermissions(w.f, 'owner', DEFAULT_ROLE_PERMISSIONS.owner.filter((p) => p !== 'ai.create'));
    const { requests } = scripted();

    await send(messageUpdate(w.owner.chatId, { photo: [{ file_id: 'a', file_size: 4 }] }));

    expect(requests).toHaveLength(0);
    expect(w.telegram.of('getFile')).toHaveLength(0);
    expect(w.telegram.sentTo(w.owner.chatId)).toEqual([tr('uz', 'common', 'errors.FORBIDDEN')]);
  });

  it('a sticker or the like gets a short note on what works', async () => {
    const w = await world();
    const { requests } = scripted();

    await send(messageUpdate(w.owner.chatId, {}));

    expect(requests).toHaveLength(0);
    expect(w.telegram.sentTo(w.owner.chatId)).toEqual([tr('uz', 'alerts', 'bot.unsupported')]);
  });
});

describe('what goes out', () => {
  it('splits a long answer so that no part passes 4096 characters and nothing is lost', async () => {
    const w = await world();
    const long = Array.from({ length: 300 }, (_, i) => `**Qator ${i}** <teg> & matn uchun yetarlicha uzun jumla`).join('\n');
    scripted(long);

    await send(textUpdate(w.owner.chatId, 'Hisobot'));

    const parts = w.telegram.of('sendMessage', w.owner.chatId);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(stripHtml(part.body.text).length).toBeLessThanOrEqual(4096);
      expect((part.body.text.match(/<b>/g) ?? []).length).toBe((part.body.text.match(/<\/b>/g) ?? []).length);
      expect(part.body.text).not.toContain('<teg>');
      expect(part.body.parse_mode).toBe('HTML');
    }
    const joined = parts.map((part) => stripHtml(part.body.text)).join('\n');
    for (const i of [0, 150, 299]) expect(joined).toContain(`Qator ${i} <teg> & matn`);
    // Only the last part can hold the markup that closes a question.
    expect(parts.slice(0, -1).every((part) => part.body.reply_markup === undefined)).toBe(true);
    expect(parts.at(-1)!.body.reply_markup).toEqual({ remove_keyboard: true });
  });

  it('splitting keeps tags whole, entities whole, and emoji whole', () => {
    const bold = splitHtml(`<b>${'a '.repeat(3000)}</b>`);
    expect(bold).toHaveLength(2);
    for (const part of bold) expect(part).toMatch(/^<b>[\s\S]*<\/b>$/);

    for (const part of splitHtml('&amp;'.repeat(5000))) expect(part).toMatch(/^(&amp;)+$/);

    const emoji = splitHtml('😀'.repeat(3000));
    expect(emoji.join('')).toBe('😀'.repeat(3000));
    for (const part of emoji) expect(part.length).toBeLessThanOrEqual(4096);
  });

  it('a long /ogohlantirishlar reply is split like any other', async () => {
    const w = await world();
    await w.f.run(() =>
      tx()
        .insert(schema.alerts)
        .values(
          Array.from({ length: 10 }, (_, i) => ({
            tenantId: w.f.tenantId,
            farmId: w.f.farmId,
            ruleKey: `long_${i}`,
            dedupKey: `long_${i}`,
            severity: 'urgent',
            title: `Sarlavha ${i}`,
            body: `<muhim> ${'matn '.repeat(200)}`,
          })) as never,
        ),
    );

    await send(textUpdate(w.owner.chatId, '/ogohlantirishlar'));

    const parts = w.telegram.of('sendMessage', w.owner.chatId);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(stripHtml(part.body.text).length).toBeLessThanOrEqual(4096);
  });

  it('a message Telegram cannot parse is resent as plain text, buttons included', async () => {
    const telegram = fakeTelegram();
    telegram.state.intercept = (call) =>
      call.method === 'sendMessage' && call.body.parse_mode === 'HTML'
        ? refused(400, "Bad Request: can't parse entities: unexpected end tag at byte offset 3")
        : undefined;

    await sendHtml('77', '<b>Yog&apos; &lt;1 l&gt;</b>', { inline_keyboard: [[{ text: 'Ok', callback_data: 'x' }]] });

    const [rejected, plain] = telegram.of('sendMessage', '77');
    expect(rejected.body.parse_mode).toBe('HTML');
    expect(plain.body.parse_mode).toBeUndefined();
    expect(plain.body.text).toBe('Yog&apos; <1 l>');
    expect(plain.body.reply_markup.inline_keyboard[0][0].text).toBe('Ok');
  });

  it('the fallback reaches the person when the model\'s answer is the one refused', async () => {
    const w = await world();
    w.telegram.state.intercept = (call) =>
      call.method === 'sendMessage' && call.body.parse_mode === 'HTML' ? refused(400, "Bad Request: can't parse entities") : undefined;
    scripted('**Qalin** <javob> & tamom');

    await send(textUpdate(w.owner.chatId, 'Salom'));

    expect(w.telegram.sentTo(w.owner.chatId).at(-1)).toBe('Qalin <javob> & tamom');
  });

  it('other refusals are not papered over with a plain resend', async () => {
    const telegram = fakeTelegram();
    telegram.state.intercept = () => refused(403, 'Forbidden: bot was blocked by the user');

    await expect(sendHtml('77', 'salom')).rejects.toThrow('bot was blocked');
    expect(telegram.of('sendMessage')).toHaveLength(1);
  });

  it('turns a Markdown table from the model into a readable list', () => {
    const html = modelTextToHtml(
      [
        'Hisobot:',
        '',
        '| Mahsulot | Miqdor | Narx |',
        '| --- | ---: | --- |',
        '| Dizel | 20 l | 300 000 |',
        '| Arpa <1> | 1 t |  |',
        '',
        'Tamom.',
      ].join('\n'),
    );
    expect(html).toBe(
      ['Hisobot:', '', '• Dizel: Miqdor 20 l, Narx 300 000', '• Arpa &lt;1&gt;: Miqdor 1 t', '', 'Tamom.'].join('\n'),
    );
  });

  it('reads a table written without outer pipes', () => {
    expect(modelTextToHtml('Nomi | Soni\n--- | ---\nQo\'y | 500')).toBe("• Qo'y: Soni 500");
  });

  it('keeps a pipe that is no table as it is, and escapes everything', () => {
    expect(modelTextToHtml('a | b')).toBe('a | b');
    expect(modelTextToHtml('a | b\n---')).toBe('a | b\n---');
    expect(modelTextToHtml('<script>x</script> & **qalin**')).toBe('&lt;script&gt;x&lt;/script&gt; &amp; <b>qalin</b>');
    expect(modelTextToHtml('## Sarlavha\n- band\n* `kod`')).toBe('<b>Sarlavha</b>\n• band\n• <code>kod</code>');
  });

  it('a table from present_result arrives as a list, with data escaped and columns named', async () => {
    const w = await world();
    await w.f.run(() =>
      tx().insert(schema.accounts).values({ tenantId: w.f.tenantId, farmId: w.f.farmId, name: 'Kassa <2>', type: 'cash' }),
    );
    scripted(
      toolCall('cash_position', {}),
      toolCall('present_result', { resultId: 'r1', kind: 'table', title: 'Hisoblar & kassa', rowsKey: 'accounts', columns: ['name', 'balance'] }),
      'Mana.',
    );

    await send(textUpdate(w.owner.chatId, 'Hisoblar'));

    const [text] = w.telegram.sentTo(w.owner.chatId);
    expect(text).toContain('Mana.');
    expect(text).toContain('<b>Hisoblar &amp; kassa</b>');
    expect(text).toContain('Kassa &lt;2&gt;');
    expect(text).toContain(`${tr('uz', 'ai', 'fields.balance')} 500 000 000`);
    expect(text).not.toContain('|');
  });

  it('a chart from present_result arrives as a list too', async () => {
    const w = await world();
    scripted(
      toolCall('cash_position', {}),
      toolCall('present_result', { resultId: 'r1', kind: 'bar', title: 'Qoldiq', rowsKey: 'accounts', xKey: 'name', yKeys: ['balance'] }),
      'Mana.',
    );

    await send(textUpdate(w.owner.chatId, 'Grafik'));

    const [text] = w.telegram.sentTo(w.owner.chatId);
    expect(text).toContain('<b>Qoldiq</b>');
    expect(text).toContain('• Kassa:');
    expect(text).toContain('100 000 000');
  });

  it('a failure gets a short apology in the person\'s language, and the log has the cause but no text or token', async () => {
    const f = await createFixture();
    const owner = await link(f, 'owner');
    await f.run(() => tx().update(schema.users).set({ locale: 'ru' }).where(eq(schema.users.id, owner.client.userId)));
    const telegram = fakeTelegram();
    scripted(new Error('provider exploded with test-token inside'));
    const logger = log();

    await send(textUpdate(owner.chatId, 'Секретный вопрос'), logger);

    expect(telegram.sentTo(owner.chatId)).toEqual([tr('ru', 'alerts', 'bot.apology')]);
    expect(logger.error).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(logger.error.mock.calls);
    expect(logged).toContain('provider exploded');
    expect(logged).not.toContain('test-token');
    expect(logged).not.toContain('Секретный вопрос');
  });

  it('with no model configured it says so plainly', async () => {
    const w = await world();
    setProvider({ name: 'none', model: null, configured: false, complete: async () => { throw new Error('unreachable'); } });

    await send(textUpdate(w.owner.chatId, 'Salom'));

    expect(w.telegram.sentTo(w.owner.chatId)).toEqual([tr('uz', 'ai', 'errors.AI_NOT_CONFIGURED')]);
  });

  it('a failed command apologises in the person\'s language', async () => {
    const f = await createFixture();
    const owner = await link(f, 'owner');
    await f.run(() => tx().update(schema.users).set({ locale: 'en' }).where(eq(schema.users.id, owner.client.userId)));
    const telegram = fakeTelegram();
    let failed = false;
    telegram.state.intercept = (call) => {
      if (call.method !== 'sendMessage' || failed) return undefined;
      failed = true;
      return refused(400, 'Bad Request: something else');
    };
    const logger = log();

    await send(textUpdate(owner.chatId, '/yordam'), logger);

    expect(telegram.sentTo(owner.chatId).at(-1)).toBe(tr('en', 'alerts', 'bot.apology'));
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('Drizzle query parameters, which can hold the message, stay out of the log', () => {
    const wrapped = new DrizzleQueryError('insert into ai_messages values ($1)', ['Секретный вопрос'], new Error('deadlock detected'));

    const logged = JSON.stringify(safeError(wrapped));

    expect(logged).toContain('deadlock detected');
    expect(logged).not.toContain('Секретный вопрос');
  });

  it('logs nothing on the normal path', async () => {
    const w = await world();
    scripted('Javob');
    const logger = log();

    await send(textUpdate(w.owner.chatId, 'Secret'), logger);

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('a message longer than the web chat box allows is refused kindly', async () => {
    const w = await world();
    const { requests } = scripted();

    await send(textUpdate(w.owner.chatId, 'x'.repeat(2001)));

    expect(requests).toHaveLength(0);
    expect(w.telegram.sentTo(w.owner.chatId)).toEqual([tr('uz', 'alerts', 'bot.tooLong', { limit: 2000 })]);
  });
});

describe('rate limit', () => {
  const note = (chatId: string) => messageUpdate(chatId, { voice: { file_id: 'voice.oga', duration: 1 } });

  it('the eleventh message in a minute is refused before the model is called', async () => {
    const w = await world();
    const { requests } = scripted(...Array.from({ length: 10 }, (_, i) => `Javob ${i}`));

    for (let i = 0; i < 11; i++) await send(textUpdate(w.owner.chatId, `Savol ${i}`));

    expect(requests).toHaveLength(10);
    expect(w.telegram.sentTo(w.owner.chatId).at(-1)).toBe(tr('uz', 'alerts', 'bot.rateLimited', { minutes: 1 }));
  });

  it('a person over the limit is not treated as a failure in the log', async () => {
    const w = await world();
    scripted(...Array.from({ length: 10 }, (_, i) => `Javob ${i}`));
    const logger = log();

    for (let i = 0; i < 11; i++) await send(textUpdate(w.owner.chatId, `Savol ${i}`), logger);

    expect(logger.error).not.toHaveBeenCalled();
  });

  it('counts voice notes that never become a stored question', async () => {
    const w = await world({}, { 'voice.oga': Buffer.from('OggS') });
    const silence = JSON.stringify({ speechHeard: false, transcript: '' });
    const { requests } = scripted(...Array.from({ length: 10 }, () => silence));

    for (let i = 0; i < 11; i++) await send(note(w.owner.chatId));

    expect(requests).toHaveLength(10);
    expect(w.telegram.of('getFile')).toHaveLength(10);
    expect(w.telegram.sentTo(w.owner.chatId).at(-1)).toBe(tr('uz', 'alerts', 'bot.rateLimited', { minutes: 1 }));
  });

  it('shares the stored count with the web app, so a file costs nothing once the limit is reached', async () => {
    const w = await world({}, { 'voice.oga': Buffer.from('OggS') });
    const { requests } = scripted(...Array.from({ length: 10 }, (_, i) => `Javob ${i}`));
    for (let i = 0; i < 10; i++) expect((await w.owner.client.post('/ai/chat', { message: `Savol ${i}` })).status).toBe(200);

    await send(note(w.owner.chatId));
    await send(messageUpdate(w.owner.chatId, { photo: [{ file_id: 'p', file_size: 1 }] }));

    expect(requests).toHaveLength(10);
    expect(w.telegram.of('getFile')).toHaveLength(0);
    expect(w.telegram.sentTo(w.owner.chatId)).toEqual(Array(2).fill(tr('uz', 'alerts', 'bot.rateLimited', { minutes: 1 })));
  });
});
