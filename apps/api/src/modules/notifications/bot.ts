/**
 * Telegram bot: account linking, quick status commands (spec 17.3) and the conversational assistant.
 * Replies are built with the sender's own role, so the bot never reveals more than the web app.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../../config';
import { ctx, withTenant, type Identity } from '../../core/context';
import { safeError } from '../../core/errors';
import { latest, renderAlert } from '../alerts/alerts.service';
import {
  COMMANDS,
  handleAssistantMessage,
  handleCallback,
  loadPerson,
  noAssistantText,
  noticeFarmWaits,
  refusalText,
  refuseOvertakingPress,
  sendFarms,
  sendPending,
  sendRefusal,
  startNewConversation,
  type BotLog,
  type Person,
} from './assistant-bot';
import { digestFacts, digestScope, renderDigest } from './digest';
import { tr } from './i18n';
import { handleLinkPress, startLink } from './link';
import {
  confirmUpdates,
  escapeHtml,
  formatMessage,
  getUpdates,
  sendHtml,
  setCommands,
  telegramConfigured,
  TelegramError,
  type TelegramMessage,
  type TelegramUpdate,
  type TelegramUser,
} from './telegram';

const ALERT_LIST_SIZE = 10;

/** Past this, a chat is flooding, and further updates are dropped rather than queued without end. */
const MAX_QUEUED_PER_CHAT = 50;

/** A model call can hang for many minutes, and what waits behind it cannot wait that long. */
const TURN_HOLD_MS = 60_000;

/** getUpdates hands over 100 at most, so an update stuck further back than this must not hide newer ones. */
const MAX_HELD_UPDATES = 90;

/** A backlog after an outage is not stuck, just waiting its turn, so Telegram keeps it this long. */
const BACKLOG_HELD_MS = 5 * 60_000;

/** Well past what Telegram can hand back at once, so a repeat is always recognised. */
const MAX_REMEMBERED_UPDATES = 1_000;

/** Telegram answers at once while it still holds something, so a poll with nothing new has to wait. */
const HELD_POLL_MS = 1_000;
const POLL_FAILURE_WAIT_MS = 5_000;
/** Inside the time a deploy allows a process to stop. */
const SHUTDOWN_WAIT_MS = 20_000;
/** Telegram delivers an album as one update per page, within about a second. */
const ALBUM_QUIET_MS = 1_000;

/** The web's proposal routes need ai.view, so these do too. */
const ASSISTANT_COMMANDS = new Set(['/kutilmoqda', '/pending', '/yangi', '/new']);

/** /yangi must keep its place among the person's messages. Other commands answer whatever the model is doing. */
const ORDERED_COMMANDS = new Set(['/yangi', '/new']);

/** Stopping something needs no model, and an Undo has a clock on it. */
const QUICK_PRESS = /^(p:[xu]:|l:)/;

/** These book money, so they must never run ahead of what an earlier turn does to the card. */
const BOOKING_PRESS = /^p:[cd]:/;

/** A farm changes in its place among the messages, or what was written before it would land on the new farm. */
const FARM_PRESS = /^f:/;

const statusReply = (person: Person): Promise<string> =>
  withTenant(person.identity, async () => {
    const { title, body } = renderDigest(await digestFacts(digestScope(ctx().permissions)), person.locale);
    return `<b>${escapeHtml(title)}</b>\n${escapeHtml(body)}`;
  });

const openAlerts = (identity: Identity, locale: string): Promise<string[]> =>
  withTenant(identity, async () =>
    (await latest(ALERT_LIST_SIZE)).map((alert) => {
      const { title, body } = renderAlert(alert, locale);
      return formatMessage({ severity: alert.severity as 'info', title, body });
    }),
  );

/** An alert reaches them from every farm, so the list covers every farm, each under its name. */
async function alertsReply(person: Person): Promise<string> {
  const none = tr(person.locale, 'alerts', 'bot.noAlerts');
  const farms = person.farms.filter((farm) => farm.identity);
  const lists = await Promise.all(farms.map((farm) => openAlerts(farm.identity!, person.locale)));
  if (lists.every((list) => list.length === 0)) return none;
  if (lists.length === 1) return lists[0].join('\n\n');
  return lists.map((list, i) => [`<b>${escapeHtml(farms[i].name)}</b>`, ...(list.length > 0 ? list : [none])].join('\n')).join('\n\n');
}

/**
 * Answer one command as HTML. Exported for tests; the poller below feeds it. An empty reply means
 * the answer has already gone out, as with /kutilmoqda, whose cards are separate messages.
 */
export async function handleMessage(chatId: string, text: string, from?: TelegramUser): Promise<string> {
  const [command, argument] = text.trim().split(/\s+/, 2);
  const name = command.split('@')[0].toLowerCase();

  if (name === '/start' && argument) return startLink(chatId, argument, from);

  const person = await loadPerson(chatId);
  if (person.status === 'choose_farm' || person.status === 'enroll_2fa') {
    await sendRefusal(chatId, person);
    return '';
  }
  if (person.status !== 'ok') return refusalText(person);
  if (ASSISTANT_COMMANDS.has(name) && !person.canAsk) return noAssistantText(person);

  switch (name) {
    case '/holat':
    case '/status':
      return statusReply(person);
    case '/ogohlantirishlar':
    case '/alerts':
      return alertsReply(person);
    case '/kutilmoqda':
    case '/pending':
      await sendPending(person);
      return '';
    case '/ferma':
    case '/farm':
      await sendFarms(person);
      return '';
    case '/yangi':
    case '/new':
      startNewConversation(person);
      // Options left on screen belong to what was just dropped.
      await sendHtml(chatId, escapeHtml(tr(person.locale, 'alerts', 'bot.newConversation')), { remove_keyboard: true });
      return '';
    default:
      return tr(person.locale, 'alerts', person.canAsk ? 'bot.help' : 'bot.helpBasic', COMMANDS);
  }
}

const NEW_WITH_WORDS = /^\/(?:yangi|new)(?:@\w+)?\s+([\s\S]+)$/i;

/** Forwarded text is someone else's, so a slash in it commands nothing. */
const isCommand = (message: TelegramMessage) => message.forward_origin === undefined && message.text?.trimStart().startsWith('/');

async function handleCommand(message: TelegramMessage, log: BotLog): Promise<void> {
  const chatId = String(message.chat.id);
  const reply = await handleMessage(chatId, message.text!, message.from);
  if (reply) await sendHtml(chatId, reply);
  const words = NEW_WITH_WORDS.exec(message.text!.trim())?.[1];
  if (!words) return;
  const person = await loadPerson(chatId);
  if (person.status === 'ok' && person.canAsk) await handleAssistantMessage(person, { ...message, text: words }, log);
}

async function handleIncoming(update: TelegramUpdate, log: BotLog): Promise<void> {
  const message = update.message;
  if (!message) return;
  const chatId = String(message.chat.id);
  try {
    if (message.chat.type !== 'private') {
      // People in a group talk among themselves, and the team chat for enquiries is theirs. Only a command is meant for the bot.
      if (isCommand(message) && chatId !== config.LEADS_TELEGRAM_CHAT_ID) await sendHtml(chatId, tr(null, 'alerts', 'bot.groupOnly'));
      return;
    }
    if (isCommand(message)) return await handleCommand(message, log);
    const person = await loadPerson(chatId);
    if (person.status === 'ok') await handleAssistantMessage(person, message, log);
    else await sendRefusal(chatId, person);
  } catch (error) {
    log.error({ err: safeError(error), updateId: update.update_id }, 'telegram reply failed');
    const locale = await loadPerson(chatId).then((person) => person.locale, () => undefined);
    await sendHtml(chatId, tr(locale, 'alerts', 'bot.apology')).catch(() => {});
  }
}

/** An edit changes nothing we heard, and the person must not think it did. */
async function handleEdit(message: TelegramMessage): Promise<void> {
  const chatId = String(message.chat.id);
  if (message.chat.type !== 'private') return;
  const person = await loadPerson(chatId);
  if (person.status === 'ok' && person.canAsk) await sendHtml(chatId, escapeHtml(tr(person.locale, 'alerts', 'bot.editIgnored')));
}

/** Answer one update, whatever it is. Exported for tests; the poller feeds it through a queue. */
export async function handleUpdate(update: TelegramUpdate, log: BotLog): Promise<void> {
  if (update.callback_query?.data?.startsWith('l:')) await handleLinkPress(update.callback_query, log);
  else if (update.callback_query) await handleCallback(update.callback_query, log);
  else if (update.edited_message) await handleEdit(update.edited_message);
  else await handleIncoming(update, log);
}

function chatOf(update: TelegramUpdate): string | null {
  const message = update.message ?? update.edited_message;
  const id = message?.chat.id ?? update.callback_query?.message?.chat.id ?? update.callback_query?.from.id;
  return id === undefined ? null : String(id);
}

/**
 * Each chat has two lanes. Messages, Confirm, Change and a farm choice keep strict order behind the
 * model, because a Confirm must see the correction written just before it, and a message belongs to
 * the farm it was written on. Everything else needs no model, and a hanging one must not hold back
 * alerts, Cancel or Undo.
 */
function laneOf(update: TelegramUpdate, chatId: string): string {
  const press = update.callback_query?.data;
  if (press !== undefined) return QUICK_PRESS.test(press) ? `${chatId}:quick` : chatId;
  if (update.edited_message) return `${chatId}:quick`;
  const message = update.message;
  if (!message || !isCommand(message)) return chatId;
  const command = message.text!.trim().split(/[\s@]/, 1)[0].toLowerCase();
  return ORDERED_COMMANDS.has(command) ? chatId : `${chatId}:quick`;
}

function untilExpired(work: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref();
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

/**
 * Work for one lane runs strictly in order, and lanes run side by side. A model call can take a
 * minute, and the poller must keep reading meanwhile. A task past `holdMs` carries on, and its
 * answer still arrives, but the lane moves on. What must not run beside that task gives `overtaking`,
 * which runs in its place. Returns false for a task it had to drop.
 */
export function createChatQueue(log: BotLog, holdMs = TURN_HOLD_MS) {
  const chats = new Map<string, { tail: Promise<void>; waiting: number; running: number }>();
  const enqueue = (chatId: string, task: () => Promise<void>, overtaking = task): boolean => {
    const chat = chats.get(chatId) ?? { tail: Promise.resolve(), waiting: 0, running: 0 };
    if (chat.waiting >= MAX_QUEUED_PER_CHAT) {
      log.error({ chatId }, 'telegram chat queue is full, dropping an update');
      return false;
    }
    chat.waiting++;
    chats.set(chatId, chat);
    const forgetWhenDone = () => {
      if (chat.waiting === 0 && chat.running === 0) chats.delete(chatId);
    };
    const run = () => {
      const work = chat.running > 0 ? overtaking : task;
      chat.running++;
      return work()
        .catch((error) => log.error({ err: safeError(error), chatId }, 'telegram update failed'))
        .finally(() => {
          chat.running--;
          forgetWhenDone();
        });
    };
    chat.tail = chat.tail
      .then(() => untilExpired(run(), holdMs))
      .finally(() => {
        chat.waiting--;
        forgetWhenDone();
      });
    return true;
  };
  return Object.assign(enqueue, { busy: (chatId: string) => chats.has(chatId) });
}

interface Album {
  pages: TelegramUpdate[];
  touchedAt: number;
}

function asOneUpdate(pages: TelegramUpdate[]): TelegramUpdate {
  const [first] = pages;
  return { ...first, message: { ...first.message!, album: pages.map((page) => page.message!) } };
}

/**
 * Telegram keeps an update until a poll asks for what comes after it, so the offset waits at the
 * oldest update still being worked on, and a restart picks up whatever never finished. The same
 * updates coming back meanwhile are told apart by id. Only by id: after a quiet week Telegram picks
 * the next id at random, so a lower one can be new.
 */
export function createUpdateLedger() {
  /** When each update in hand came in. */
  const working = new Map<number, number>();
  const remembered = new Set<number>();
  let next = 0;
  return {
    /** True once for each update. */
    admit(id: number): boolean {
      if (remembered.has(id)) return false;
      remembered.add(id);
      if (remembered.size > MAX_REMEMBERED_UPDATES) remembered.delete(remembered.values().next().value!);
      next = id + 1;
      working.set(id, Date.now());
      return true;
    },
    finish: (id: number) => void working.delete(id),
    idle: () => working.size === 0,
    /** Only what is both far behind and long in hand is let go, so a backlog nobody has handled stays with Telegram. */
    offset: () => {
      const lostPatienceAt = Date.now() - BACKLOG_HELD_MS;
      const held = [...working].filter(([id, since]) => id >= next - MAX_HELD_UPDATES || since > lostPatienceAt);
      return Math.min(next, ...held.map(([id]) => id));
    },
  };
}

async function registerCommands(log: BotLog): Promise<void> {
  const list = (locale: string) =>
    Object.entries(COMMANDS).map(([key, command]) => ({
      command: command.slice(1),
      description: tr(locale, 'alerts', `bot.commands.${key}`),
    }));
  try {
    await setCommands(list('uz'));
    await setCommands(list('ru'), 'ru');
    await setCommands(list('en'), 'en');
  } catch (error) {
    log.error({ err: safeError(error) }, 'telegram commands not registered');
  }
}

const pause = (ms: number, signal?: AbortSignal) => sleep(ms, undefined, { signal }).catch(() => {});

/**
 * Long-poll getUpdates. Does nothing when no token is set. Returns a stop function, which waits for
 * the work in hand. Whatever it cannot wait for stays with Telegram for the next start.
 * Wire into src/index.ts next to startJobs.
 */
export function startTelegramBot(log: BotLog, holdMs = TURN_HOLD_MS): () => Promise<void> {
  if (!telegramConfigured()) {
    log.info('Telegram bot not configured: TELEGRAM_BOT_TOKEN is empty');
    return async () => {};
  }

  const controller = new AbortController();
  const enqueue = createChatQueue(log, holdMs);
  const ledger = createUpdateLedger();
  const albums = new Map<string, Album>();

  const run = (updates: TelegramUpdate[], work: () => Promise<void>, overtaking = work): boolean => {
    const finish = () => updates.forEach((update) => ledger.finish(update.update_id));
    const chatId = chatOf(updates[0]);
    const queued =
      chatId !== null &&
      enqueue(
        laneOf(updates[0], chatId),
        () => work().finally(finish),
        () => overtaking().finally(finish),
      );
    if (!queued) finish();
    return queued;
  };

  /** One album is one question: the first page waits for the rest, then all of them go as one. */
  const takeAlbum = (update: TelegramUpdate, key: string) => {
    const album = albums.get(key);
    if (album) {
      album.pages.push(update);
      album.touchedAt = Date.now();
      return;
    }
    const opened: Album = { pages: [update], touchedAt: Date.now() };
    albums.set(key, opened);
    const queued = run(opened.pages, async () => {
      while (Date.now() - opened.touchedAt < ALBUM_QUIET_MS) await pause(ALBUM_QUIET_MS / 10);
      albums.delete(key);
      await handleUpdate(asOneUpdate(opened.pages), log);
    });
    if (!queued) albums.delete(key);
  };

  const take = (update: TelegramUpdate) => {
    // Audio files can share an album too, but each one is its own note.
    const album = update.message?.audio ? undefined : update.message?.media_group_id;
    if (album) return takeAlbum(update, `${chatOf(update)}:${album}`);
    const press = update.callback_query;
    if (press && FARM_PRESS.test(press.data ?? '') && enqueue.busy(chatOf(update)!)) void noticeFarmWaits(press, log);
    const booking = press && BOOKING_PRESS.test(press.data ?? '');
    run([update], () => handleUpdate(update, log), booking ? () => refuseOvertakingPress(press, log) : undefined);
  };

  const loop = async () => {
    await registerCommands(log);
    while (!controller.signal.aborted) {
      try {
        const updates = await getUpdates(ledger.offset(), controller.signal);
        const fresh = updates.filter((update) => ledger.admit(update.update_id));
        fresh.forEach(take);
        if (updates.length > 0 && fresh.length === 0) await pause(HELD_POLL_MS, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) return;
        log.error({ err: safeError(error) }, 'telegram polling failed');
        await pause((error instanceof TelegramError && error.retryAfterMs) || POLL_FAILURE_WAIT_MS, controller.signal);
      }
    }
  };
  const polling = loop();
  log.info('Telegram bot polling started');
  return async () => {
    controller.abort();
    await polling;
    const deadline = Date.now() + SHUTDOWN_WAIT_MS;
    while (!ledger.idle() && Date.now() < deadline) await pause(100);
    await confirmUpdates(ledger.offset()).catch((error) => log.error({ err: safeError(error) }, 'telegram offset not confirmed'));
  };
}
