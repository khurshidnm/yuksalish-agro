import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { todayIso } from '@yap/shared';
import { LANGUAGES } from '@yap/shared/i18n';
import { schema } from '../src/db/client';
import { tx } from '../src/core/context';
import { renderRecap } from '../src/modules/ai/records/recap';
import { raiseAlert } from '../src/modules/alerts/alerts.service';
import { evaluateRules } from '../src/modules/alerts/rules';
import { renderDigest } from '../src/modules/notifications/digest';
import { sendDailySummary } from '../src/modules/notifications/jobs';
import { PASSWORD_NOTICE, inviteNotice } from '../src/modules/notifications/notifications.service';
import { dispatchPending, notifyRole, notifyUser } from '../src/modules/notifications/notify.service';
import { investorMessage } from '../src/modules/reports/investor';
import { createFixture, type Client, type Fixture } from './helpers';

const { alerts, notifications, transactions, users } = schema;

const titleIn = async (reader: Client, lang?: string) => (await reader.get('/notifications', { lang })).data[0].title as string;
const bodyIn = async (reader: Client, lang?: string) => (await reader.get('/notifications', { lang })).data[0].body as string | null;

const sickAnimals = () =>
  raiseAlert({ ruleKey: 'sick_animals', dedupKey: 's', severity: 'attention', title: 'Kasal hayvonlar: 3 bosh', data: { count: 3 } });

describe('notifications in the reader\'s language', () => {
  it('reads a rule alert in whichever language is on screen, whatever the account says', async () => {
    const f = await createFixture();
    const vet = await f.as('veterinarian');
    await f.run(sickAnimals);

    expect(await titleIn(vet, 'uz')).toBe('Kasal hayvonlar: 3 bosh');
    expect(await titleIn(vet, 'uz-Cyrl')).toBe('Касал ҳайвонлар: 3 бош');
    expect(await titleIn(vet, 'ru')).toBe('Больных животных: 3');
    expect(await titleIn(vet, 'en')).toBe('Sick animals: 3');
  });

  it('without a language, each row keeps the one its recipient had when it was written', async () => {
    const f = await createFixture();
    const vet = await f.as('veterinarian');
    await f.run(() => tx().update(users).set({ locale: 'ru' }).where(eq(users.id, vet.userId)));
    await f.run(sickAnimals);

    expect(await titleIn(vet)).toBe('Больных животных: 3');
  });

  it('covers what is not an alert: a task, an account notice, a notice that names something', async () => {
    const f = await createFixture();
    const shepherd = await f.as('shepherd');
    const director = await f.as('director');

    await director.post('/tasks', { title: "Qo'ylarni sanang", assigneeUserId: shepherd.userId });
    expect(await titleIn(shepherd, 'en')).toBe('A new task was assigned to you');
    // The director's own words are not for translating.
    expect(await bodyIn(shepherd, 'en')).toBe("Qo'ylarni sanang");

    await f.run(() => notifyUser(shepherd.userId, PASSWORD_NOTICE));
    expect(await titleIn(shepherd, 'ru')).toBe('Пароль изменён');

    await f.run(() => notifyUser(shepherd.userId, inviteNotice('Yuksalish Agro')));
    expect(await bodyIn(shepherd, 'en')).toContain('Yuksalish Agro');
    expect(await bodyIn(shepherd, 'ru')).toContain('Yuksalish Agro');
  });

  it('gives the daily summary line by line in the reader\'s language', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    await f.run(() => sendDailySummary());

    const uzbek = await bodyIn(owner, 'uz');
    const russian = await bodyIn(owner, 'ru');
    const cyrillic = await bodyIn(owner, 'uz-Cyrl');
    expect(russian).not.toBe(uzbek);
    expect(russian).toMatch(/[а-я]/);
    expect(cyrillic).toMatch(/[қўғҳ]/);
    expect(cyrillic).not.toMatch(/[a-z]{3}/);
  });

  it('says a month the way the Alerts page does', async () => {
    const f = await createFixture();
    const director = await f.as('director');
    await f.run(() =>
      raiseAlert({
        ruleKey: 'budget_overrun',
        dedupKey: 'b',
        severity: 'attention',
        title: 'Ozuqa: byudjetdan oshdi',
        data: { category: { uz: 'Ozuqa', ru: 'Корма', en: 'Feed' }, month: '2026-11', percent: 120 },
      }),
    );

    expect(await titleIn(director, 'ru')).toBe('Корма: бюджет превышен');
    expect(await bodyIn(director, 'ru')).toBe('Исполнение за Ноябрь 2026: 120%.');
    expect(await bodyIn(director, 'en')).toBe('120% of the budget used for November 2026.');
    expect(await bodyIn(director, 'uz')).toBe('Noyabr 2026 oyi uchun ijro 120%.');
    expect(await bodyIn(director, 'uz-Cyrl')).toContain('Ноябрь 2026');
  });

  it('shows a row written before languages were kept, in the words it has', async () => {
    const f = await createFixture();
    const vet = await f.as('veterinarian');
    await f.run(() =>
      tx().insert(notifications).values({ tenantId: f.tenantId, farmId: f.farmId, userId: vet.userId, title: 'Eski xabar', body: 'Eski matn' }),
    );

    for (const lang of ['uz', 'uz-Cyrl', 'ru', 'en', undefined]) {
      expect(await titleIn(vet, lang)).toBe('Eski xabar');
      expect(await bodyIn(vet, lang)).toBe('Eski matn');
    }
    expect((await vet.get('/notifications/unread-count')).data.count).toBe(1);
  });

  it('leaves plain text as written, in every language', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    await f.run(() => notifyRole('owner', { title: 'Oylik hisobot', body: 'Sotuv: 5 bosh' }));

    expect(await titleIn(owner, 'ru')).toBe('Oylik hisobot');
    expect(await bodyIn(owner, 'en')).toBe('Sotuv: 5 bosh');
  });

  it('does not hand over the other languages: only title and body leave the API', async () => {
    const f = await createFixture();
    const vet = await f.as('veterinarian');
    await f.run(sickAnimals);

    const [row] = (await vet.get('/notifications', { lang: 'ru' })).data;
    expect(row).not.toHaveProperty('texts');
  });

  it('a sender that words its text by hand works in every language, since each is now written for all of them', () => {
    const investor = { finance: { income: 1_000_000, expense: 400_000, cash: 600_000 }, livestock: { head: 500 } };
    const recap = { date: todayIso(), recorded: 2, moneyOut: 500_000, moneyIn: 0, currency: 'UZS', lines: [{ label: 'Yem', amount: 500_000, currency: 'UZS' }], awaitingSecond: 1, waiting: 0 };

    for (const { code } of LANGUAGES) {
      expect(investorMessage(investor as never, code)).toContain('500');
      expect(renderRecap(recap as never, code).body).toContain('500');
    }
    expect(investorMessage(investor as never, 'ru')).not.toBe(investorMessage(investor as never, 'en'));
  });

  it('refuses a language that does not exist', async () => {
    const f = await createFixture();
    const vet = await f.as('veterinarian');
    expect((await vet.get('/notifications', { lang: 'fr' })).status).toBe(400);
  });

  it('keeps a money notification from someone who lost the right to it, in every language', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    await f.run(() => notifyRole('owner', { title: (locale) => `Kassa ${locale}: 5 000 000` }, { permission: 'finance.view' }));
    expect(await titleIn(owner, 'ru')).toBe('Kassa ru: 5 000 000');

    await f.run(() => tx().update(notifications).set({ permission: 'payroll.approve_nobody' }).where(eq(notifications.userId, owner.userId)));
    for (const lang of ['uz', 'ru', 'en']) expect((await owner.get('/notifications', { lang })).data).toHaveLength(0);
  });
});

describe('the language of the account', () => {
  it('belongs to the person who sets it, and only to them', async () => {
    const f = await createFixture();
    const vet = await f.as('veterinarian');
    const shepherd = await f.as('shepherd');

    const saved = await vet.put('/notifications/language', { language: 'ru' });
    expect(saved.status).toBe(200);
    expect(saved.data).toEqual({ language: 'ru' });

    const people = await f.run(() => tx().select({ id: users.id, locale: users.locale }).from(users));
    expect(people.find((p) => p.id === vet.userId)?.locale).toBe('ru');
    expect(people.find((p) => p.id === shepherd.userId)?.locale).toBe('uz');
  });

  it('accepts Uzbek Cyrillic, and nothing outside the interface languages', async () => {
    const f = await createFixture();
    const vet = await f.as('veterinarian');

    expect((await vet.put('/notifications/language', { language: 'uz-Cyrl' })).status).toBe(200);
    expect((await vet.put('/notifications/language', { language: 'fr' })).status).toBe(400);
    expect((await vet.put('/notifications/language', {})).status).toBe(400);
  });

  it('needs a signed-in person', async () => {
    const f = await createFixture();
    const anonymous = await f.app.inject({ method: 'PUT', url: '/api/v1/notifications/language', payload: { language: 'ru' } });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('Telegram speaks the recipient\'s language', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  /** A linked person and every text the bot sends them. */
  async function linked(f: Fixture, role: 'veterinarian' | 'director') {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
    const client = await f.as(role);
    await f.run(() => tx().update(users).set({ telegramChatId: `chat-${client.userId}` }).where(eq(users.id, client.userId)));
    const sent: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        sent.push(JSON.parse(init.body as string).text as string);
        return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
      }),
    );
    return { client, sent };
  }

  it('after the person picks a language in the app, the bot follows', async () => {
    const f = await createFixture();
    const { client, sent } = await linked(f, 'veterinarian');
    await client.put('/notifications/language', { language: 'ru' });

    await f.run(sickAnimals);
    await f.run(() => dispatchPending());

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Больных животных: 3');
  });

  it('a message still waiting goes out in the language chosen since it was written', async () => {
    const f = await createFixture();
    const { client, sent } = await linked(f, 'veterinarian');
    await f.run(sickAnimals);
    expect((await f.run(() => tx().select().from(notifications).where(eq(notifications.userId, client.userId))))[0].title).toBe('Kasal hayvonlar: 3 bosh');

    await client.put('/notifications/language', { language: 'en' });
    await f.run(() => dispatchPending());

    expect(sent[0]).toContain('Sick animals: 3');
  });

  it('writes Uzbek Cyrillic through the same conversion the app uses', async () => {
    const f = await createFixture();
    const { client, sent } = await linked(f, 'veterinarian');
    await client.put('/notifications/language', { language: 'uz-Cyrl' });

    await f.run(sickAnimals);
    await f.run(() => dispatchPending());

    expect(sent[0]).toContain('Касал ҳайвонлар: 3 бош');
  });

  it('sends a row from before languages were kept, as written', async () => {
    const f = await createFixture();
    const { client, sent } = await linked(f, 'veterinarian');
    await client.put('/notifications/language', { language: 'ru' });
    await f.run(() =>
      tx().insert(notifications).values({
        tenantId: f.tenantId,
        farmId: f.farmId,
        userId: client.userId,
        title: 'Eski xabar',
        severity: 'attention',
        deliveries: { telegram: 'pending' },
      }),
    );

    await f.run(() => dispatchPending());

    expect(sent[0]).toContain('Eski xabar');
  });
});

describe('alert links', () => {
  it('sends payments waiting for approval to the approvals tab', async () => {
    const f = await createFixture();
    await f.run(async () => {
      await tx().insert(transactions).values({
        tenantId: f.tenantId,
        farmId: f.farmId,
        date: todayIso(),
        type: 'expense',
        amount: 500,
        amountBase: 500,
        paymentMethod: 'cash',
        status: 'pending',
      });
      await evaluateRules();
    });

    const [alert] = await f.run(() => tx().select().from(alerts).where(eq(alerts.ruleKey, 'approvals_pending')));
    expect(alert.link).toBe('/finance/transactions?tab=approval');
  });
});

describe('dates in server text', () => {
  it('match what the web app shows beside them: slashes in English, dots otherwise', () => {
    const facts = { date: '2026-11-06', herd: null, scarceFeed: null, openAlerts: 0, urgentAlerts: 0, cash: null, tasksOpen: null };
    expect(renderDigest(facts, 'en').title).toBe('Daily summary, 06/11/2026');
    for (const locale of ['ru', 'uz', 'uz-Cyrl']) expect(renderDigest(facts, locale).title).toContain('06.11.2026');
  });
});
