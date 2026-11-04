import ExcelJS from 'exceljs';
import { and, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RoleKey } from '@yap/shared';
import { addDays, expectedLambingDate, todayIso } from '@yap/shared';
import { tx } from '../src/core/context';
import { signAccessToken } from '../src/core/tokens';
import { schema } from '../src/db/client';
import { createFixture, type Fixture } from './helpers';

const { accounts, breedingRecords, animals, budgets, cropPlans, employees, fields, herds, items, seasons, stockBatches, transactions } = schema;

const BOUNDARY = 'yapimport';

async function tokenFor(f: Fixture, role: RoleKey): Promise<string> {
  const client = await f.as(role);
  return signAccessToken({ userId: client.userId, membershipId: client.membershipId, tenantId: f.tenantId, farmId: f.farmId });
}

async function upload(
  f: Fixture,
  role: RoleKey,
  template: string,
  body: Buffer,
  name = 'data.xlsx',
  lang = 'uz',
) {
  const head = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const res = await f.app.inject({
    method: 'POST',
    url: `/api/v1/import/${template}?lang=${lang}`,
    headers: {
      authorization: `Bearer ${await tokenFor(f, role)}`,
      'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
    },
    payload: Buffer.concat([Buffer.from(head), body, Buffer.from(`\r\n--${BOUNDARY}--\r\n`)]),
  });
  const json = res.json();
  return { status: res.statusCode, body: json, data: json.data, error: json.error };
}

async function download(f: Fixture, role: RoleKey, path: string) {
  const res = await f.app.inject({
    method: 'GET',
    url: `/api/v1/import${path}`,
    headers: { authorization: `Bearer ${await tokenFor(f, role)}` },
  });
  return { status: res.statusCode, body: res.rawPayload, headers: res.headers };
}

const template = async (f: Fixture, role: RoleKey, key: string, lang = 'uz') =>
  (await download(f, role, `/templates/${key}?lang=${lang}`)).body;

async function load(body: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(body as unknown as ArrayBuffer);
  return workbook;
}

const asBuffer = async (workbook: ExcelJS.Workbook) => Buffer.from(await workbook.xlsx.writeBuffer());

/** Add rows to a downloaded template, the way a person does, below the example. */
async function fill(file: Buffer, rows: unknown[][]): Promise<Buffer> {
  const workbook = await load(file);
  const sheet = workbook.worksheets[0];
  rows.forEach((row, index) => {
    row.forEach((value, column) => {
      if (value !== null && value !== undefined) sheet.getCell(3 + index, column + 1).value = value as ExcelJS.CellValue;
    });
  });
  return asBuffer(workbook);
}

/** A workbook made by hand, the way a farm's own spreadsheet looks. */
async function sheetOf(rows: unknown[][], name = 'Sheet1'): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(name);
  for (const row of rows) sheet.addRow(row);
  return asBuffer(workbook);
}

const confirm = (f: Fixture, role: RoleKey, id: string) => f.as(role).then((c) => c.post(`/import/jobs/${id}/confirm`));

async function rowsOf(f: Fixture, role: RoleKey, id: string, status?: string) {
  const client = await f.as(role);
  return (await client.get(`/import/jobs/${id}/rows`, { status, pageSize: 200 })).body.data as any[];
}

async function addAccounts(f: Fixture) {
  await f.run(() =>
    tx()
      .insert(accounts)
      .values([
        { tenantId: f.tenantId, farmId: f.farmId, name: 'Kassa', type: 'cash' },
        { tenantId: f.tenantId, farmId: f.farmId, name: 'Bank', type: 'bank' },
      ]),
  );
}

const today = todayIso();
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);

describe('templates', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await createFixture();
  });

  const HEADERS: [string, string[]][] = [
    ['fields', ['Dala raqami *', 'Maydoni (ga)', 'Ekin', 'Nav', 'Ekish sanasi', "Urug' me'yori (kg/ga)", "Sug'orish manbai", 'Koordinatalar (ixtiyoriy)']],
    ['animals', ['Birka raqami *', 'Zoti', 'Jinsi *', "Tug'ilgan sana yoki yoshi", 'Vazni (kg)', "Bo'g'ozlik sanasi", 'Sotib olish sanasi', 'Sotib olish narxi', 'Sotuvchi', 'Poda']],
    ['feed', ['Ozuqa turi *', 'Miqdori *', "O'lchov birligi *", 'Kirim sanasi *', 'Narxi (1 birlik uchun) *']],
    ['employees', ['Ism *', 'Lavozim *', 'Ish haqi turi *', 'Ish haqi miqdori *', 'Ishga qabul sanasi *', 'Telefon', 'Shartnoma tugash sanasi']],
    ['machinery', ['Nomi *', 'Turi *', 'Inventar raqami', 'Xarid sanasi', 'Xarid narxi', 'Holati']],
    ['counterparties', ['Nomi *', 'STIR', 'Toifa *', 'Telefon', 'Bank rekvizitlari']],
    ['expenses', ['Sana *', 'Modda *', 'Summa *', "To'lov usuli *", 'Xarajat markazi *', 'Izoh', 'Kontragent']],
    ['budget', ['Oy *', 'Modda *', 'Reja summa *']],
  ];

  it.each(HEADERS)('%s has the columns of spec 25.2', async (key, headers) => {
    const workbook = await load(await template(f, 'owner', key));
    const row = workbook.worksheets[0].getRow(1).values as unknown[];
    expect(row.slice(1)).toEqual(headers);
    expect(workbook.getWorksheet("Ko'rsatma")).toBeTruthy();
  });

  it('writes headers in the language asked for, Cyrillic included', async () => {
    const header = async (lang: string) =>
      (await load(await template(f, 'owner', 'animals', lang))).worksheets[0].getCell('A1').value;
    expect(await header('uz')).toBe('Birka raqami *');
    expect(await header('ru')).toBe('Номер бирки *');
    expect(await header('en')).toBe('Tag number *');
    expect(await header('uz-Cyrl')).toBe('Бирка рақами *');
  });

  it('fills in an example row and marks it', async () => {
    const sheet = (await load(await template(f, 'owner', 'animals'))).worksheets[0];
    expect(sheet.getCell('A2').value).toBe('YA-0001');
    expect(sheet.getCell('B2').value).toBe('Hisori');
    expect(String(sheet.getCell('K2').value)).toContain('misol');
  });

  it("offers the tenant's own reference data as dropdowns", async () => {
    const workbook = await load(await template(f, 'owner', 'fields'));
    const lists = workbook.getWorksheet('Lists')!;
    expect(lists.state).toBe('hidden');
    const values = (lists.getColumn(1).values as unknown[]).filter(Boolean);
    expect(values).toContain("Bug'doy");
    expect(values).toContain('Beda');
    const crop = workbook.worksheets[0].getCell('C5').dataValidation;
    expect(crop.type).toBe('list');
    expect(crop.formulae[0]).toContain('Lists!');
  });

  it('offers categories in the language asked for', async () => {
    const workbook = await load(await template(f, 'owner', 'budget', 'ru'));
    expect((workbook.getWorksheet('Lists')!.getColumn(1).values as unknown[]).filter(Boolean)).toContain('Корма');
  });

  it('a person without finance.view gets no price columns (rule 7)', async () => {
    const sheet = (await load(await template(f, 'zootechnician', 'animals'))).worksheets[0];
    const headers = (sheet.getRow(1).values as unknown[]).slice(1);
    expect(headers).not.toContain('Sotib olish narxi');
    expect(headers).not.toContain('Sotuvchi');
    expect(headers).toContain('Birka raqami *');
  });

  it('lists what the caller may use', async () => {
    const owner = await f.as('owner');
    const accountant = await f.as('accountant');
    const allowed = async (client: typeof owner) =>
      (await client.get('/import/templates')).data.templates.filter((t: any) => t.allowed).map((t: any) => t.key);
    expect(await allowed(owner)).toEqual(['fields', 'animals', 'feed', 'employees', 'machinery', 'counterparties', 'expenses', 'budget']);
    expect(await allowed(accountant)).toEqual(['counterparties', 'expenses', 'budget']);
  });

  it('an untouched template has nothing to import', async () => {
    const res = await upload(f, 'owner', 'animals', await template(f, 'owner', 'animals'));
    expect(res.status).toBe(400);
    expect(res.error.code).toBe('NO_DATA_ROWS');
  });
});

describe('round trip through the generated template', () => {
  it('fields: creates the field, its cost center, the season and the crop plan', async () => {
    const f = await createFixture();
    const file = await fill(await template(f, 'owner', 'fields'), [
      ['1', 20, "Bug'doy", 'Krasnodarskaya-99', new Date('2026-10-25T00:00:00Z'), 220, 'Kanal'],
      ['2', 15, 'Arpa'],
      ['Y-1', 100],
    ]);
    const preview = await upload(f, 'owner', 'fields', file);
    expect(preview.status).toBe(200);
    expect(preview.data.summary).toEqual({ new: 3, update: 0, skip: 0, error: 0 });
    expect(preview.data.warnings[0].message).toContain('Yangi mavsum yaratiladi');

    // A preview writes nothing.
    expect(await f.run(() => tx().select().from(fields))).toEqual([]);

    const done = await confirm(f, 'owner', preview.data.id);
    expect(done.status).toBe(200);
    expect(done.data.status).toBe('confirmed');
    expect(done.data.importedRows).toBe(3);

    const { rows, plans, season } = await f.run(async () => ({
      rows: await tx().select().from(fields),
      plans: await tx().select().from(cropPlans),
      season: await tx().select().from(seasons),
    }));
    const first = rows.find((r) => r.number === '1')!;
    expect(first.areaHa).toBe(20);
    expect(first.irrigationSource).toBe('Kanal');
    expect(first.costCenterId).toBeTruthy();
    expect(rows.reduce((sum, r) => sum + r.areaHa, 0)).toBe(135);

    expect(plans).toHaveLength(2);
    const wheat = plans.find((p) => p.fieldId === first.id)!;
    expect(wheat.variety).toBe('Krasnodarskaya-99');
    expect(wheat.seedRateKgHa).toBe(220);
    expect(wheat.status).toBe(today >= '2026-10-25' ? 'sown' : 'planned');
    expect(season.map((s) => s.name)).toContain('Kuzgi 2026/27');
  });

  it('fields: an outline is measured by PostGIS, and disagreement is reported', async () => {
    const f = await createFixture();
    const file = await fill(await template(f, 'owner', 'fields'), [
      ['7', 500, null, null, null, null, null, '39.50, 64.80; 39.50, 64.81; 39.51, 64.81; 39.51, 64.80'],
    ]);
    const preview = await upload(f, 'owner', 'fields', file);
    expect(preview.data.warnings[0].message).toContain('Chegaradan hisoblangan maydon');
    await confirm(f, 'owner', preview.data.id);
    const [field] = await f.run(() => tx().select().from(fields));
    // 0.01° of latitude is about 1110 m and of longitude here about 859 m.
    expect(field.areaHa).toBeGreaterThan(90);
    expect(field.areaHa).toBeLessThan(100);
    expect(field.boundary).toBeTruthy();
  });

  it('animals: a pregnancy date gives the expected lambing date (spec 24.1)', async () => {
    const f = await createFixture();
    await f.run(() => tx().insert(herds).values({ tenantId: f.tenantId, farmId: f.farmId, name: "Bo'g'oz sovliqlar" }));
    const file = await fill(await template(f, 'owner', 'animals'), [
      ['YA-0100', 'Hisori', "Urg'ochi", new Date('2023-03-15T00:00:00Z'), 62.5, new Date('2026-10-05T00:00:00Z'), new Date('2026-10-20T00:00:00Z'), 4_200_000, 'Sherobod Chorva MChJ'],
    ]);
    const preview = await upload(f, 'owner', 'animals', file);
    expect(preview.data.summary.new).toBe(1);
    expect(preview.data.warnings[0].message).toContain('kontragent');

    const done = await confirm(f, 'owner', preview.data.id);
    expect(done.data.summary.pregnancies).toBe(1);

    const { animal, record, partner } = await f.run(async () => ({
      animal: (await tx().select().from(animals))[0],
      record: (await tx().select().from(breedingRecords))[0],
      partner: (await tx().select().from(schema.counterparties))[0],
    }));
    expect(animal.tag).toBe('YA-0100');
    expect(animal.status).toBe('pregnant');
    expect(animal.category).toBe('ewe');
    expect(animal.origin).toBe('purchased');
    expect(animal.purchasePrice).toBe(4_200_000);
    expect(animal.currentWeightKg).toBe(62.5);
    expect(animal.herdId).toBeTruthy();
    expect(animal.sellerId).toBe(partner.id);
    expect(partner.name).toBe('Sherobod Chorva MChJ');
    // Oct 5 + 150 days: 26 to Oct 31, Nov 30, Dec 31, Jan 31, Feb 28, then Mar 4.
    expect(record.expectedDate).toBe('2027-03-04');
    expect(record.source).toBe('purchase');
  });

  it('feed: tons become kg, price follows, and the opening batch costs what it should', async () => {
    const f = await createFixture();
    const file = await fill(await template(f, 'owner', 'feed'), [
      ['Beda (pichan)', 120, 't', new Date('2026-10-15T00:00:00Z'), 1_800_000],
      ['Tuz', 500, 'kg', '2026-10-15', 2000],
    ]);
    const preview = await upload(f, 'owner', 'feed', file);
    expect(preview.data.summary.new).toBe(2);
    await confirm(f, 'owner', preview.data.id);

    const { item, batch, warehouse } = await f.run(async () => {
      const [row] = await tx().select().from(items).where(eq(items.name, 'Beda (pichan)'));
      const [stock] = await tx().select().from(stockBatches).where(eq(stockBatches.itemId, row.id));
      return { item: row, batch: stock, warehouse: await tx().select().from(schema.warehouses) };
    });
    expect(item.unit).toBe('kg');
    expect(item.category).toBe('feed');
    expect(batch.qtyReceived).toBe(120_000);
    expect(batch.unitCost).toBe(1800);
    expect(batch.source).toBe('opening');
    expect(warehouse).toHaveLength(1);
    expect(warehouse[0].type).toBe('feed');
  });

  it('employees', async () => {
    const f = await createFixture();
    const file = await fill(await template(f, 'owner', 'employees'), [
      ['Karimov Sherzod', "Cho'pon", 'Oylik', 4_500_000, new Date('2026-09-01T00:00:00Z'), '90 123 45 67'],
      ['Mavsumiy Ishchi', 'Ishchi', 'Mavsumiy', 150_000, new Date('2026-09-01T00:00:00Z'), null, new Date('2026-12-01T00:00:00Z')],
    ]);
    const preview = await upload(f, 'owner', 'employees', file);
    expect(preview.data.summary.new).toBe(2);
    await confirm(f, 'owner', preview.data.id);
    const rows = await f.run(() => tx().select().from(employees));
    const first = rows.find((r) => r.fullName === 'Karimov Sherzod')!;
    expect(first.phone).toBe('+998901234567');
    expect(first.payType).toBe('monthly');
    expect(first.baseRate).toBe(4_500_000);
    expect(rows.find((r) => r.payType === 'seasonal')!.contractEndDate).toBe('2026-12-01');
  });

  it('machinery gets a cost center', async () => {
    const f = await createFixture();
    const file = await fill(await template(f, 'owner', 'machinery'), [
      ['MTZ-82 №1', 'Traktor', 'INV-7', new Date('2024-03-15T00:00:00Z'), 350_000_000, "Ta'mirda"],
      ['Generator', 'Generator'],
    ]);
    const preview = await upload(f, 'owner', 'machinery', file);
    expect(preview.data.summary.new).toBe(2);
    await confirm(f, 'owner', preview.data.id);
    const rows = await f.run(() => tx().select().from(schema.assets));
    const tractor = rows.find((r) => r.inventoryNo === 'INV-7')!;
    expect(tractor.status).toBe('repair');
    expect(tractor.purchasePrice).toBe(350_000_000);
    expect(tractor.costCenterId).toBeTruthy();
    expect(rows.find((r) => r.name === 'Generator')!.status).toBe('working');
  });

  it('counterparties: splits the one bank cell', async () => {
    const f = await createFixture();
    const file = await fill(await template(f, 'owner', 'counterparties'), [
      ['Buxoro Yem Savdo', '305 123 456', 'Yetkazib beruvchi', '+998 71 234 56 78', 'Agrobank, h/r 20208000900123456001, MFO 00394'],
    ]);
    const preview = await upload(f, 'owner', 'counterparties', file);
    await confirm(f, 'owner', preview.data.id);
    const [row] = await f.run(() => tx().select().from(schema.counterparties));
    expect(row.tin).toBe('305123456');
    expect(row.type).toBe('supplier');
    expect(row.phone).toBe('+998712345678');
    expect(row.bankDetails).toEqual({ bankName: 'Agrobank', account: '20208000900123456001', mfo: '00394' });
  });

  it('expenses: go through the ledger, large amounts wait, no cost is counted twice (rules 3, 6)', async () => {
    const f = await createFixture();
    await addAccounts(f);
    const file = await fill(await template(f, 'owner', 'expenses'), [
      [new Date('2026-10-05T00:00:00Z'), 'Elektr', 1_500_000, 'Naqd', 'Umumiy ferma', 'Oktabr uchun'],
      [new Date('2026-10-06T00:00:00Z'), 'Ozuqa', 900_000, 'Bank', 'Umumiy ferma', 'Kepak'],
      [new Date('2026-10-07T00:00:00Z'), 'Hayvon xaridi', 9_000_000, 'Bank', 'Umumiy ferma', 'Qo\'chqor'],
      [new Date('2026-10-08T00:00:00Z'), "Ta'mirlash", 300_000, 'Qarzga', 'Umumiy ferma', 'Nasos', 'Usta Ali'],
    ]);
    const preview = await upload(f, 'owner', 'expenses', file);
    expect(preview.data.summary).toEqual({ new: 4, update: 0, skip: 0, error: 0 });
    const done = await confirm(f, 'owner', preview.data.id);
    expect(done.data.summary.pendingApproval).toBe(1);

    const rows = await f.run(() => tx().select().from(transactions));
    const by = (description: string) => rows.find((r) => r.description === description)!;
    expect(by('Oktabr uchun').costTreatment).toBe('expense');
    expect(by('Oktabr uchun').status).toBe('approved');
    expect(by('Kepak').costTreatment).toBe('inventory');
    expect(by("Qo'chqor").costTreatment).toBe('animal');
    expect(by("Qo'chqor").status).toBe('pending');
    expect(by('Nasos').paymentMethod).toBe('debt');
    expect(by('Nasos').counterpartyId).toBeTruthy();
  });

  it('budget: reaches the budget grid', async () => {
    const f = await createFixture();
    const file = await fill(await template(f, 'owner', 'budget'), [
      ['2026-11', 'Ozuqa', 12_000_000],
      ['Dekabr 2026', 'Ozuqa', 13_000_000],
      ['01.2027', "Qo'ylar sotuvi", 50_000_000],
    ]);
    const preview = await upload(f, 'owner', 'budget', file);
    expect(preview.data.summary.new).toBe(3);
    await confirm(f, 'owner', preview.data.id);
    const rows = await f.run(() => tx().select().from(budgets));
    expect(rows.map((r) => [r.month, r.amount]).sort()).toEqual([
      ['2026-11', 12_000_000],
      ['2026-12', 13_000_000],
      ['2027-01', 50_000_000],
    ]);
  });

  it('writes journal events and audit rows as manual entry does', async () => {
    const f = await createFixture();
    const file = await fill(await template(f, 'owner', 'counterparties'), [['Audit Test', null, 'Xaridor']]);
    const owner = await f.as('owner');
    const preview = await upload(f, 'owner', 'counterparties', file);
    await confirm(f, 'owner', preview.data.id);
    const { events, audit } = await f.run(async () => ({
      events: (await tx().select().from(schema.events)).map((e) => e.type),
      audit: await tx().select().from(schema.auditLogs).where(eq(schema.auditLogs.entity, 'counterparties')),
    }));
    expect(events).toContain('counterparty.created');
    expect(events).toContain('import.confirmed');
    expect(audit[0].userId).toBe(owner.userId);
  });
});

describe('messy input', () => {
  const ANIMAL_HEADER = ['Birka raqami', 'Zoti', 'Jinsi', "Tug'ilgan sana yoki yoshi", 'Vazni (kg)', "Bo'g'ozlik sanasi", 'Sotib olish sanasi'];

  it('reads Excel serial dates, text dates, comma decimals, spaces and trailing blanks', async () => {
    const f = await createFixture();
    const file = await sheetOf([
      ANIMAL_HEADER,
      ['  A-1  ', ' hisori ', 'urgochi', 46000, '62,5', '05.10.2026', 46315],
      ['A-2', 'HISORI', 'Самка', '15.03.2023', '1 000', '2026-10-05', '20/10/2026'],
      [],
      [null, null, null],
      ['   ', '  '],
    ]);
    const preview = await upload(f, 'owner', 'animals', file);
    expect(preview.data.totalRows).toBe(2);
    expect(preview.data.errors).toEqual([]);
    await confirm(f, 'owner', preview.data.id);
    const rows = await f.run(() => tx().select().from(animals).orderBy(animals.tag));
    expect(rows.map((r) => r.tag)).toEqual(['A-1', 'A-2']);
    expect(rows[0].purchaseDate).toBe('2026-10-20');
    expect(rows[0].birthDate).toBe('2025-12-09');
    expect(rows[0].currentWeightKg).toBe(62.5);
    expect(rows[1].birthDate).toBe('2023-03-15');
    expect(rows[1].currentWeightKg).toBe(1000);
  });

  it('reads an age instead of a birth date, and marks the date as estimated', async () => {
    const f = await createFixture();
    const file = await sheetOf([
      ANIMAL_HEADER,
      ['B-1', 'Hisori', "Urg'ochi", '3 yosh', null, null, '2026-10-20'],
      ['B-2', 'Hisori', 'Erkak', 3, null, null, '2026-10-20'],
      ['B-3', 'Hisori', "Urg'ochi", '6 oy', null, null, '2026-10-20'],
      ['B-4', 'Hisori', 'Erkak', '18 мес', null, null, '2026-10-20'],
    ]);
    const preview = await upload(f, 'owner', 'animals', file);
    expect(preview.data.errors).toEqual([]);
    await confirm(f, 'owner', preview.data.id);
    const rows = await f.run(() => tx().select().from(animals).orderBy(animals.tag));
    expect(rows.map((r) => r.category)).toEqual(['ewe', 'ram', 'lamb_female', 'ram']);
    expect(rows.every((r) => r.birthDateEstimated)).toBe(true);
    expect(rows[0].birthDate).toBe(addDays(today, -Math.round(36 * 30.44)));
  });

  it('matches crop names in Latin, Cyrillic, Russian, and without apostrophes', async () => {
    const f = await createFixture();
    const file = await sheetOf([
      ['Dala raqami', 'Maydoni (ga)', 'Ekin'],
      ['1', 10, "bug'doy"],
      ['2', 10, 'Bugdoy'],
      ['3', 10, 'Буғдой'],
      ['4', 10, 'бугдой'],
      ['5', 10, 'Пшеница'],
      ['6', 10, 'WHEAT'],
      ['№7', 10, 'Bug‘doy'],
    ]);
    const preview = await upload(f, 'owner', 'fields', file);
    expect(preview.data.errors).toEqual([]);
    await confirm(f, 'owner', preview.data.id);
    const rows = await f.run(() => tx().select().from(fields));
    expect(rows.map((r) => r.number).sort()).toEqual(['1', '2', '3', '4', '5', '6', '7']);
  });

  it('finds the table under a title, with Russian headers, in any column order', async () => {
    const f = await createFixture();
    const file = await sheetOf([
      ['Ферма Юксалиш, список полей'],
      [],
      ['Культура', 'Площадь (га)', 'Номер поля'],
      ['Ячмень', '15,5', '3'],
    ]);
    const preview = await upload(f, 'owner', 'fields', file);
    expect(preview.data.errors).toEqual([]);
    expect(preview.data.summary.new).toBe(1);
    await confirm(f, 'owner', preview.data.id);
    const [field] = await f.run(() => tx().select().from(fields));
    expect(field.areaHa).toBe(15.5);
    expect(field.number).toBe('3');
  });

  it('finds the data when it is not on the first sheet', async () => {
    const f = await createFixture();
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Izohlar').addRow(['Bu varaqda faqat izohlar bor']);
    const data = workbook.addWorksheet('Kontragentlar');
    data.addRow(['Nomi', 'Toifa']);
    data.addRow(['Ali', 'Xaridor']);
    const preview = await upload(f, 'owner', 'counterparties', await asBuffer(workbook));
    expect(preview.status).toBe(200);
    expect(preview.data.summary.new).toBe(1);
  });

  it('reads formula cells by their stored result', async () => {
    const f = await createFixture();
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Data');
    sheet.addRow(['Dala raqami', 'Maydoni (ga)']);
    sheet.addRow(['1', { formula: '10+10', result: 20 }]);
    const preview = await upload(f, 'owner', 'fields', await asBuffer(workbook));
    expect(preview.data.errors).toEqual([]);
    await confirm(f, 'owner', preview.data.id);
    expect((await f.run(() => tx().select().from(fields)))[0].areaHa).toBe(20);
  });

  it('names the row, the column and the reason for every problem', async () => {
    const f = await createFixture();
    const file = await sheetOf([
      ANIMAL_HEADER,
      ['C-1', 'Merinos', "Urg'ochi", '15.03.2023', null, null, '2026-10-20'],
      ['C-2', 'Hisori', 'Noaniq', '15.03.2023', null, null, '2026-10-20'],
      ['C-3', 'Hisori', "Urg'ochi", '31.02.2023', null, null, '2026-10-20'],
      ['C-4', 'Hisori', "Urg'ochi", '15.03.2023', 'og\'ir', null, '2026-10-20'],
      ['C-5', 'Hisori', 'Erkak', '15.03.2023', null, '2026-10-01', '2026-10-20'],
      ['C-6', 'Hisori', "Urg'ochi", '15.03.2023', null, '2099-01-01', '2026-10-20'],
      ['C-7', 'Hisori', "Urg'ochi", 'qari', null, null, '2026-10-20'],
      [null, 'Hisori', "Urg'ochi", '15.03.2023', null, null, '2026-10-20'],
      ['C-9', 'Hisori', "Urg'ochi", '3 yosh'],
    ]);
    const preview = await upload(f, 'owner', 'animals', file);
    expect(preview.status).toBe(200);
    expect(preview.data.summary.error).toBe(9);

    const rows = await rowsOf(f, 'owner', preview.data.id, 'error');
    const reason = (row: number) => rows.find((r) => r.row === row).errors[0];
    expect(reason(2)).toMatchObject({ row: 2, column: 'breed' });
    expect(reason(2).message).toContain('"Merinos" topilmadi');
    expect(reason(2).message).toContain('Hisori');
    expect(reason(3).column).toBe('sex');
    expect(reason(4).message).toContain("yosh bo'lishi kerak");
    expect(reason(5).message).toBe('Vazni (kg): son emas');
    expect(reason(6).message).toContain('Erkak hayvon uchun');
    expect(reason(7).message).toContain('kelajakdagi');
    expect(reason(8).column).toBe('birth');
    expect(reason(9)).toMatchObject({ column: 'tag', message: "Birka raqami to'ldirilmagan" });
    expect(reason(10).message).toContain('Sotib olish sanasi yoki aniq');
    expect(preview.data.errors.length).toBeGreaterThan(0);
  });

  it('flags a tag repeated in the file, and imports the first occurrence', async () => {
    const f = await createFixture();
    const file = await sheetOf([
      ANIMAL_HEADER,
      ['D-1', 'Hisori', "Urg'ochi", null, null, null, '2026-10-20'],
      ['d-1', 'Hisori', "Urg'ochi", null, null, null, '2026-10-20'],
    ]);
    const preview = await upload(f, 'owner', 'animals', file);
    expect(preview.data.summary).toMatchObject({ new: 1, error: 1 });
    const [row] = await rowsOf(f, 'owner', preview.data.id, 'error');
    expect(row.row).toBe(3);
    expect(row.errors[0].message).toContain('2-qatorda');
  });

  it('skips a tag already in the system, whatever the case', async () => {
    const f = await createFixture();
    const file = await sheetOf([ANIMAL_HEADER, ['E-1', 'Hisori', "Urg'ochi", null, null, null, '2026-10-20']]);
    await confirm(f, 'owner', (await upload(f, 'owner', 'animals', file)).data.id);
    const again = await upload(f, 'owner', 'animals', await sheetOf([ANIMAL_HEADER, ['e-1', 'Hisori', "Urg'ochi", null, null, null, '2026-10-20']]));
    expect(again.data.summary).toMatchObject({ new: 0, skip: 1, error: 0 });
    const [row] = await rowsOf(f, 'owner', again.data.id, 'skip');
    expect(row.note).toContain('allaqachon bor');
  });

  it('accepts CSV for Google Sheets users: comma, semicolon, BOM, quotes', async () => {
    const f = await createFixture();
    const comma = Buffer.from('﻿Nomi,Toifa,STIR\n"Ali, Vali MChJ",Xaridor,305123456\nBobur,Yetkazib beruvchi,\n');
    const preview = await upload(f, 'owner', 'counterparties', comma, 'data.csv');
    expect(preview.data.summary.new).toBe(2);
    await confirm(f, 'owner', preview.data.id);

    const semicolon = Buffer.from('Nomi;Toifa\nSamad;Xaridor\n');
    const second = await upload(f, 'owner', 'counterparties', semicolon, 'data.csv');
    expect(second.data.summary.new).toBe(1);
    await confirm(f, 'owner', second.data.id);

    const rows = await f.run(() => tx().select().from(schema.counterparties));
    expect(rows.map((r) => r.name).sort()).toEqual(['Ali, Vali MChJ', 'Bobur', 'Samad']);
  });

  it('reads a CSV saved by Russian Excel in Windows-1251', async () => {
    const f = await createFixture();
    const text = 'Название;Тип\nЮксалиш;Покупатель\n';
    const cp1251 = Buffer.from(
      [...text].map((ch) => {
        const code = ch.charCodeAt(0);
        return code >= 0x410 && code <= 0x44f ? code - 0x410 + 0xc0 : code;
      }),
    );
    const preview = await upload(f, 'owner', 'counterparties', cp1251, 'data.csv');
    expect(preview.data.summary.new).toBe(1);
    const [row] = await rowsOf(f, 'owner', preview.data.id);
    expect(row.values.name).toBe('Юксалиш');
  });

  it.each([
    ['a picture', PNG, 'NOT_A_SPREADSHEET'],
    ['an old .xls', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]), 'OLD_EXCEL_FORMAT'],
    ['a zip that is not a workbook', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]), 'NOT_A_SPREADSHEET'],
    ['an empty file', Buffer.alloc(0), 'EMPTY_FILE'],
  ])('refuses %s with a clear reason', async (_name, body, code) => {
    const f = await createFixture();
    const res = await upload(f, 'owner', 'animals', body);
    expect(res.status).toBe(400);
    expect(res.error.code).toBe(code);
  });

  it('says which template a file looks like when the wrong one is chosen', async () => {
    const f = await createFixture();
    const file = await template(f, 'owner', 'counterparties');
    const filled = await fill(file, [['Ali', null, 'Xaridor']]);
    const res = await upload(f, 'owner', 'animals', filled);
    expect(res.status).toBe(400);
    expect(res.error.code).toBe('LOOKS_LIKE_OTHER_TEMPLATE');
    expect(res.error.details.detected).toBe('Kontragentlar');
    expect(res.error.details.expected).toBe('Hayvonlar');
  });

  it('refuses a sheet that is nothing like a template', async () => {
    const f = await createFixture();
    const res = await upload(f, 'owner', 'animals', await sheetOf([['Xarid', 'Narx'], ['olma', 5]]));
    expect(res.error.code).toBe('WRONG_TEMPLATE');
  });

  it('names a missing required column', async () => {
    const f = await createFixture();
    const res = await upload(f, 'owner', 'animals', await sheetOf([['Birka raqami', 'Zoti'], ['X-1', 'Hisori']]));
    expect(res.error.code).toBe('MISSING_COLUMNS');
    expect(res.error.details.columns).toBe('Jinsi');
  });

  it('refuses a file with too many rows', async () => {
    const f = await createFixture();
    const rows = Array.from({ length: 2001 }, (_, i) => [`Z-${i}`, 'Xaridor']);
    const res = await upload(f, 'owner', 'counterparties', await sheetOf([['Nomi', 'Toifa'], ...rows]));
    expect(res.status).toBe(400);
    expect(res.error.code).toBe('TOO_MANY_ROWS');
  });

  it('gives errors in the language of the upload', async () => {
    const f = await createFixture();
    const file = await sheetOf([['Birka raqami', 'Jinsi', 'Sotib olish sanasi'], ['X', 'нечто', '2026-10-20']]);
    const preview = await upload(f, 'owner', 'animals', file, 'data.xlsx', 'ru');
    expect(preview.data.errors[0].message).toContain('не найдено');
  });
});

describe('importing the same file again', () => {
  const cases: { key: string; rows: unknown[][]; arrange?: (f: Fixture) => Promise<void>; count: (f: Fixture) => Promise<number> }[] = [
    {
      key: 'fields',
      rows: [['1', 20, "Bug'doy", null, new Date('2026-10-25T00:00:00Z')], ['2', 15]],
      count: (f) => f.run(async () => (await tx().select().from(fields)).length + (await tx().select().from(cropPlans)).length),
    },
    {
      key: 'animals',
      rows: [['F-1', 'Hisori', "Urg'ochi", null, 60, new Date('2026-10-05T00:00:00Z'), new Date('2026-10-20T00:00:00Z'), 4_000_000]],
      count: (f) => f.run(async () => (await tx().select().from(animals)).length + (await tx().select().from(breedingRecords)).length),
    },
    {
      key: 'feed',
      rows: [['Somon', 80, 't', new Date('2026-10-15T00:00:00Z'), 500_000]],
      count: (f) => f.run(async () => (await tx().select().from(stockBatches)).length),
    },
    {
      key: 'employees',
      rows: [
        ['Telefonli Xodim', "Cho'pon", 'Oylik', 4_000_000, new Date('2026-09-01T00:00:00Z'), '901234567'],
        ['Telefonsiz Xodim', "Cho'pon", 'Oylik', 4_000_000, new Date('2026-09-01T00:00:00Z')],
      ],
      count: (f) => f.run(async () => (await tx().select().from(employees)).length),
    },
    {
      key: 'machinery',
      rows: [['MTZ', 'Traktor', 'INV-1'], ['Plug', 'Plug']],
      count: (f) => f.run(async () => (await tx().select().from(schema.assets)).length),
    },
    {
      key: 'counterparties',
      rows: [['Ali', '305123456', 'Xaridor'], ['Vali', null, 'Xaridor']],
      count: (f) => f.run(async () => (await tx().select().from(schema.counterparties)).length),
    },
    {
      key: 'expenses',
      rows: [[new Date('2026-10-05T00:00:00Z'), 'Elektr', 1_500_000, 'Naqd', 'Umumiy ferma', 'Oktabr']],
      arrange: addAccounts,
      count: (f) => f.run(async () => (await tx().select().from(transactions)).length),
    },
    {
      key: 'budget',
      rows: [['2026-11', 'Ozuqa', 12_000_000]],
      count: (f) => f.run(async () => (await tx().select().from(budgets)).length),
    },
  ];

  it.each(cases)('$key does not double anything', async ({ key, rows, arrange, count }) => {
    const f = await createFixture();
    await arrange?.(f);
    const file = await fill(await template(f, 'owner', key), rows);

    const first = await upload(f, 'owner', key, file);
    expect(first.data.summary.error).toBe(0);
    expect((await confirm(f, 'owner', first.data.id)).status).toBe(200);
    const before = await count(f);
    expect(before).toBeGreaterThan(0);

    const second = await upload(f, 'owner', key, file);
    expect(second.data.summary).toMatchObject({ new: 0, update: 0, error: 0, skip: rows.length });

    const blocked = await confirm(f, 'owner', second.data.id);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('NOTHING_TO_IMPORT');
    expect(await count(f)).toBe(before);
  });

  it('a job cannot be confirmed twice', async () => {
    const f = await createFixture();
    const file = await fill(await template(f, 'owner', 'counterparties'), [['Ali', null, 'Xaridor']]);
    const job = await upload(f, 'owner', 'counterparties', file);
    expect((await confirm(f, 'owner', job.data.id)).status).toBe(200);
    const again = await confirm(f, 'owner', job.data.id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('JOB_NOT_OPEN');
  });

  it('a changed quantity for the same feed and date is refused, not added', async () => {
    const f = await createFixture();
    const key = 'feed';
    const date = new Date('2026-10-15T00:00:00Z');
    const first = await upload(f, 'owner', key, await fill(await template(f, 'owner', key), [['Somon', 80, 't', date, 500_000]]));
    await confirm(f, 'owner', first.data.id);

    const changed = await upload(f, 'owner', key, await fill(await template(f, 'owner', key), [['Somon', 90, 't', date, 500_000]]));
    expect(changed.data.summary).toMatchObject({ new: 0, error: 1 });
    expect(changed.data.errors[0].message).toContain('boshqa qoldiq');
  });

  it('a changed budget amount replaces the plan and reports the update', async () => {
    const f = await createFixture();
    const first = await upload(f, 'owner', 'budget', await fill(await template(f, 'owner', 'budget'), [['2026-11', 'Ozuqa', 12_000_000]]));
    await confirm(f, 'owner', first.data.id);
    const second = await upload(f, 'owner', 'budget', await fill(await template(f, 'owner', 'budget'), [['2026-11', 'Ozuqa', 15_000_000]]));
    expect(second.data.summary).toMatchObject({ new: 0, update: 1 });
    await confirm(f, 'owner', second.data.id);
    const rows = await f.run(() => tx().select().from(budgets));
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(15_000_000);
  });

  it('a row added elsewhere between preview and confirm is skipped, not doubled', async () => {
    const f = await createFixture();
    const file = await fill(await template(f, 'owner', 'counterparties'), [['Ali', '305123456', 'Xaridor'], ['Vali', null, 'Xaridor']]);
    const job = await upload(f, 'owner', 'counterparties', file);
    const owner = await f.as('owner');
    await owner.post('/finance/counterparties', { name: 'Ali Boshqa', tin: '305123456', type: 'buyer' });
    const done = await confirm(f, 'owner', job.data.id);
    expect(done.data.summary).toMatchObject({ new: 1, skip: 1 });
    expect((await f.run(() => tx().select().from(schema.counterparties))).length).toBe(2);
  });

  it('a new upload replaces the previous unconfirmed attempt', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const file = await fill(await template(f, 'owner', 'counterparties'), [['Ali', null, 'Xaridor']]);
    const first = await upload(f, 'owner', 'counterparties', file);
    const second = await upload(f, 'owner', 'counterparties', file);
    const history = (await owner.get('/import/jobs')).body.data;
    expect(history.find((j: any) => j.id === first.data.id).status).toBe('discarded');
    expect(history.find((j: any) => j.id === second.data.id).status).toBe('preview');
  });
});

describe('a failure halfway through confirm', () => {
  const OWNER_URL = process.env.DATABASE_OWNER_URL!;

  async function owner(sqlText: string) {
    const client = new pg.Client({ connectionString: OWNER_URL });
    await client.connect();
    await client.query(sqlText);
    await client.end();
  }

  beforeAll(() =>
    owner(`
      CREATE OR REPLACE FUNCTION fail_on_tag() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.tag = 'BOOM' THEN RAISE EXCEPTION 'simulated failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_on_tag BEFORE INSERT ON animals FOR EACH ROW EXECUTE FUNCTION fail_on_tag();
    `),
  );
  afterAll(() => owner('DROP TRIGGER fail_on_tag ON animals; DROP FUNCTION fail_on_tag();'));

  it('leaves nothing behind, reports the row, and keeps the preview open', async () => {
    const f = await createFixture();
    const date = new Date('2026-10-20T00:00:00Z');
    const pregnant = new Date('2026-10-05T00:00:00Z');
    const file = await fill(await template(f, 'owner', 'animals'), [
      ['G-1', 'Hisori', "Urg'ochi", null, 60, pregnant, date, 4_000_000, 'Yangi Sotuvchi', 'Yangi poda'],
      ['G-2', 'Hisori', "Urg'ochi", null, 60, pregnant, date, 4_000_000, 'Yangi Sotuvchi', 'Yangi poda'],
      ['BOOM', 'Hisori', "Urg'ochi", null, 60, pregnant, date, 4_000_000, 'Yangi Sotuvchi', 'Yangi poda'],
      ['G-4', 'Hisori', "Urg'ochi", null, 60, pregnant, date, 4_000_000, 'Yangi Sotuvchi', 'Yangi poda'],
    ]);
    const job = await upload(f, 'owner', 'animals', file);
    expect(job.data.summary.new).toBe(4);

    const failed = await confirm(f, 'owner', job.data.id);
    expect(failed.status).toBe(409);
    expect(failed.body.error.code).toBe('IMPORT_ROW_FAILED');
    expect(failed.body.error.details.row).toBe(5);

    const left = await f.run(async () => ({
      animals: await tx().select().from(animals),
      records: await tx().select().from(breedingRecords),
      herds: await tx().select().from(herds),
      partners: await tx().select().from(schema.counterparties),
      weights: await tx().select().from(schema.weightRecords),
      events: await tx().select().from(schema.events).where(eq(schema.events.type, 'animal.registered')),
      idents: await tx().select().from(schema.animalIdentifiers),
    }));
    expect(left).toEqual({ animals: [], records: [], herds: [], partners: [], weights: [], events: [], idents: [] });

    const owner_ = await f.as('owner');
    expect((await owner_.get(`/import/jobs/${job.data.id}`)).data.status).toBe('preview');
  });
});

describe('permissions', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await createFixture();
  });

  it('follows the create permission of the owning module', async () => {
    const file = await sheetOf([['Nomi', 'Toifa'], ['Ali', 'Xaridor']]);
    expect((await upload(f, 'shepherd', 'counterparties', file)).status).toBe(403);
    expect((await upload(f, 'investor', 'counterparties', file)).status).toBe(403);
    expect((await upload(f, 'auditor', 'counterparties', file)).status).toBe(403);
    expect((await upload(f, 'accountant', 'counterparties', file)).status).toBe(200);

    const animalsFile = await sheetOf([['Birka raqami', 'Jinsi', 'Sotib olish sanasi'], ['X-1', 'Erkak', '2026-10-20']]);
    expect((await upload(f, 'accountant', 'animals', animalsFile)).status).toBe(403);
    expect((await upload(f, 'zootechnician', 'animals', animalsFile)).status).toBe(200);
    // Shepherds hold livestock.create for daily logs, which must not let them register animals.
    expect((await upload(f, 'shepherd', 'animals', animalsFile)).status).toBe(403);
  });

  it('refuses the template download too', async () => {
    expect((await download(f, 'shepherd', '/templates/expenses')).status).toBe(403);
    expect((await download(f, 'shepherd', '/templates/animals')).status).toBe(403);
    expect((await download(f, 'investor', '/templates/animals')).status).toBe(403);
  });

  it('feed needs finance.view, because its price values all later consumption', async () => {
    const file = await sheetOf([['Ozuqa turi', 'Miqdori', "O'lchov birligi", 'Kirim sanasi', 'Narxi'], ['Somon', 1, 't', '2026-10-15', 5]]);
    expect((await upload(f, 'storekeeper', 'feed', file)).status).toBe(403);
    expect((await upload(f, 'owner', 'feed', file)).status).toBe(200);
  });

  it('a role without finance.view cannot smuggle in a price (rule 7)', async () => {
    const file = await sheetOf([
      ['Birka raqami', 'Jinsi', 'Sotib olish sanasi', 'Sotib olish narxi', 'Sotuvchi'],
      ['P-1', "Urg'ochi", '2026-10-20', 4_000_000, 'Ali'],
      ['P-2', "Urg'ochi", '2026-10-20'],
    ]);
    const preview = await upload(f, 'zootechnician', 'animals', file);
    expect(preview.data.summary).toMatchObject({ new: 1, error: 1 });
    const [row] = await rowsOf(f, 'zootechnician', preview.data.id, 'error');
    expect(row.row).toBe(2);
    expect(row.errors.map((e: any) => e.column)).toEqual(expect.arrayContaining(['purchasePrice']));
    await confirm(f, 'zootechnician', preview.data.id);
    const rows = await f.run(() => tx().select().from(animals).where(eq(animals.tag, 'P-2')));
    expect(rows[0].purchasePrice).toBeNull();
  });

  it("another person's preview hides money from a role that cannot see it", async () => {
    const file = await sheetOf([
      ['Birka raqami', 'Jinsi', 'Sotib olish sanasi', 'Sotib olish narxi', 'Sotuvchi'],
      ['Q-1', "Urg'ochi", '2026-10-20', 4_444_444, 'Maxfiy Sotuvchi'],
    ]);
    const preview = await upload(f, 'owner', 'animals', file);
    const zootechnician = await f.as('zootechnician');

    const job = await zootechnician.get(`/import/jobs/${preview.data.id}`);
    const rows = await zootechnician.get(`/import/jobs/${preview.data.id}/rows`);
    expect(JSON.stringify(job.body)).not.toContain('kontragent');
    expect(JSON.stringify(rows.body)).not.toContain('4444444');
    expect(JSON.stringify(rows.body)).not.toContain('Maxfiy');
    expect(rows.data[0].values.tag).toBe('Q-1');

    const owner = await f.as('owner');
    const own = await owner.get(`/import/jobs/${preview.data.id}/rows`);
    expect(own.data[0].values.purchasePrice).toBe(4_444_444);
  });

  it('a confirmer who lacks finance.view cannot push through the prices of a preview', async () => {
    const file = await sheetOf([
      ['Birka raqami', 'Jinsi', 'Sotib olish sanasi', 'Sotib olish narxi'],
      ['R-1', "Urg'ochi", '2026-10-20', 4_000_000],
    ]);
    const preview = await upload(f, 'owner', 'animals', file);
    const res = await confirm(f, 'zootechnician', preview.data.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOTHING_TO_IMPORT');
    expect(await f.run(() => tx().select().from(animals).where(eq(animals.tag, 'R-1')))).toEqual([]);
  });

  it('history shows only templates the caller can use', async () => {
    const file = await sheetOf([['Nomi', 'Toifa'], ['Yopiq', 'Xaridor']]);
    await upload(f, 'accountant', 'counterparties', file);
    const zootechnician = await f.as('zootechnician');
    const history = (await zootechnician.get('/import/jobs')).body.data;
    expect(history.every((j: any) => j.template === 'animals')).toBe(true);
  });

  it('refuses a job of a template the caller cannot use', async () => {
    const preview = await upload(f, 'accountant', 'counterparties', await sheetOf([['Nomi', 'Toifa'], ['Boshqa', 'Xaridor']]));
    const zootechnician = await f.as('zootechnician');
    expect((await zootechnician.get(`/import/jobs/${preview.data.id}`)).status).toBe(403);
    expect((await zootechnician.post(`/import/jobs/${preview.data.id}/confirm`)).status).toBe(403);
  });

  it('keeps tenants apart', async () => {
    const other = await createFixture();
    const preview = await upload(f, 'owner', 'counterparties', await sheetOf([['Nomi', 'Toifa'], ['Ajnabiy', 'Xaridor']]));
    const stranger = await other.as('owner');
    expect((await stranger.get(`/import/jobs/${preview.data.id}`)).status).toBe(404);
    expect((await stranger.post(`/import/jobs/${preview.data.id}/confirm`)).status).toBe(404);
    expect((await stranger.get('/import/jobs')).body.data).toEqual([]);
  });

  it('honours module switches', async () => {
    const small = await createFixture({ modules: ['livestock'] });
    const file = await sheetOf([['Nomi', 'Toifa'], ['Ali', 'Xaridor']]);
    const res = await upload(small, 'owner', 'counterparties', file);
    expect(res.status).toBe(403);
    expect(res.error.code).toBe('MODULE_DISABLED');
    const animalsFile = await sheetOf([['Birka raqami', 'Jinsi', 'Sotib olish sanasi'], ['X-1', 'Erkak', '2026-10-20']]);
    expect((await upload(small, 'owner', 'animals', animalsFile)).status).toBe(200);
    const listed = (await (await small.as('owner')).get('/import/templates')).data.templates.map((t: any) => t.key);
    expect(listed).toEqual(['animals']);
  });

  it('applies the 2FA gate', async () => {
    const strict = await createFixture({ settings: { security: { enforce2fa: true } } });
    const res = await upload(strict, 'accountant', 'counterparties', await sheetOf([['Nomi', 'Toifa'], ['Ali', 'Xaridor']]));
    expect(res.error.code).toBe('TWO_FACTOR_ENROLLMENT_REQUIRED');
  });
});

describe('job handling', () => {
  it('discards a preview and clears its rows', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const job = await upload(f, 'owner', 'counterparties', await sheetOf([['Nomi', 'Toifa'], ['Ali', 'Xaridor']]));
    const discarded = await owner.post(`/import/jobs/${job.data.id}/discard`);
    expect(discarded.data.status).toBe('discarded');
    expect((await rowsOf(f, 'owner', job.data.id)).length).toBe(0);
    expect((await confirm(f, 'owner', job.data.id)).status).toBe(409);
  });

  it('keeps only failed rows after confirm, so personal data does not linger', async () => {
    const f = await createFixture();
    const file = await sheetOf([
      ['Ism', 'Lavozim', 'Ish haqi turi', 'Ish haqi miqdori', 'Ishga qabul sanasi', 'Telefon'],
      ['Ali Valiyev', "Cho'pon", 'Oylik', 4_000_000, '2026-09-01', '901234567'],
      ['Xato Qator', "Cho'pon", 'Noaniq', 4_000_000, '2026-09-01', '901234568'],
    ]);
    const job = await upload(f, 'owner', 'employees', file);
    await confirm(f, 'owner', job.data.id);
    const rows = await rowsOf(f, 'owner', job.data.id);
    expect(rows.map((r) => r.row)).toEqual([3]);
  });

  it('hands back the failed rows with reasons, and the fixed file imports', async () => {
    const f = await createFixture();
    const file = await sheetOf([
      ['Nomi', 'Toifa'],
      ['Yaxshi', 'Xaridor'],
      ['Yomon', 'Noaniq toifa'],
    ]);
    const job = await upload(f, 'owner', 'counterparties', file);
    await confirm(f, 'owner', job.data.id);

    const errors = await download(f, 'owner', `/jobs/${job.data.id}/errors.xlsx`);
    expect(errors.status).toBe(200);
    const workbook = await load(errors.body);
    const sheet = workbook.worksheets[0];
    expect(sheet.rowCount).toBe(2);
    expect(sheet.getCell('A2').value).toBe('Yomon');
    const reasonColumn = (sheet.getRow(1).values as unknown[]).indexOf('Xato sababi');
    expect(String(sheet.getCell(2, reasonColumn).value)).toContain('"Noaniq toifa" topilmadi');

    sheet.getCell('C2').value = 'Xaridor';
    const fixed = await upload(f, 'owner', 'counterparties', await asBuffer(workbook));
    expect(fixed.data.summary).toMatchObject({ new: 1, error: 0 });
    await confirm(f, 'owner', fixed.data.id);
    const names = (await f.run(() => tx().select().from(schema.counterparties))).map((r) => r.name).sort();
    expect(names).toEqual(['Yaxshi', 'Yomon']);
  });

  it('groups one mistake repeated across rows', async () => {
    const f = await createFixture();
    const rows = Array.from({ length: 30 }, (_, i) => [`T-${i}`, 'Noma\'lum']);
    const job = await upload(f, 'owner', 'counterparties', await sheetOf([['Nomi', 'Toifa'], ...rows]));
    expect(job.data.errors).toHaveLength(1);
    expect(job.data.errors[0].count).toBe(30);
    expect(job.data.errors[0].rows).toHaveLength(12);
  });
});

describe('export', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await createFixture();
    await addAccounts(f);
    const animalsFile = await sheetOf([
      ['Birka raqami', 'Jinsi', 'Sotib olish sanasi', 'Sotib olish narxi'],
      ['X-1', "Urg'ochi", '2026-10-20', 4_200_000],
    ]);
    await confirm(f, 'owner', (await upload(f, 'owner', 'animals', animalsFile)).data.id);
    const people = await sheetOf([
      ['Ism', 'Lavozim', 'Ish haqi turi', 'Ish haqi miqdori', 'Ishga qabul sanasi', 'Telefon'],
      ['Ali Valiyev', "Cho'pon", 'Oylik', 4_000_000, '2026-09-01', '901234567'],
    ]);
    await confirm(f, 'owner', (await upload(f, 'owner', 'employees', people)).data.id);
    const money = await sheetOf([
      ['Sana', 'Modda', 'Summa', "To'lov usuli", 'Xarajat markazi', 'Izoh'],
      ['2026-10-05', 'Elektr', 1_500_000, 'Naqd', 'Umumiy ferma', '=HYPERLINK("http://evil","click")'],
    ]);
    await confirm(f, 'owner', (await upload(f, 'owner', 'expenses', money)).data.id);
    const partners = await sheetOf([['Nomi', 'Toifa', 'Telefon'], ['@SUM(A1:A2)', 'Xaridor', '+998712345678']]);
    await confirm(f, 'owner', (await upload(f, 'owner', 'counterparties', partners)).data.id);
  });

  it('downloads Excel with real dates and numbers', async () => {
    const res = await download(f, 'owner', '/export/animals?format=xlsx&lang=uz');
    expect(res.status).toBe(200);
    expect(String(res.headers['content-disposition'])).toContain('hayvonlar.xlsx');
    const sheet = (await load(res.body)).worksheets[0];
    const headers = (sheet.getRow(1).values as unknown[]).slice(1);
    expect(headers).toContain('Sotib olish narxi');
    const price = sheet.getRow(2).getCell(headers.indexOf('Sotib olish narxi') + 1).value;
    expect(price).toBe(4_200_000);
    expect(sheet.getRow(2).getCell(headers.indexOf('Sotib olish sanasi') + 1).value).toBeInstanceOf(Date);
  });

  it('downloads CSV that Excel opens correctly: BOM and semicolons', async () => {
    const res = await download(f, 'owner', '/export/animals?format=csv&lang=ru');
    expect(res.body.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    const text = res.body.toString('utf8');
    expect(text).toContain('Номер бирки;');
    expect(text).toContain('X-1;');
  });

  it('disarms cells that would run as formulas in Excel', async () => {
    const res = await download(f, 'owner', '/export/transactions?format=csv');
    const text = res.body.toString('utf8');
    expect(text).toContain(`"'=HYPERLINK(""http://evil"",""click"")"`);
    const partners = (await download(f, 'owner', '/export/counterparties?format=csv')).body.toString('utf8');
    expect(partners).toContain("'@SUM(A1:A2)");
    expect(partners).toContain(';+998712345678;');
  });

  it('leaves money out of the file for a role without finance.view (rule 7)', async () => {
    const res = await download(f, 'shepherd', '/export/animals?format=csv');
    expect(res.status).toBe(200);
    const text = res.body.toString('utf8');
    expect(text).not.toContain('narxi');
    expect(text).not.toContain('4200000');
    expect(text).toContain('X-1');
  });

  it('checks the view permission of each list', async () => {
    expect((await download(f, 'shepherd', '/export/transactions')).status).toBe(403);
    expect((await download(f, 'shepherd', '/export/employees')).status).toBe(403);
    expect((await download(f, 'shepherd', '/export/counterparties')).status).toBe(403);
    expect((await download(f, 'investor', '/export/animals')).status).toBe(403);
    expect((await download(f, 'auditor', '/export/transactions')).status).toBe(200);
  });

  it('leaves personal data out for a role without pii.view (rule 8)', async () => {
    const custom = await createFixture();
    await confirm(
      custom,
      'owner',
      (
        await upload(
          custom,
          'owner',
          'employees',
          await sheetOf([
            ['Ism', 'Lavozim', 'Ish haqi turi', 'Ish haqi miqdori', 'Ishga qabul sanasi', 'Telefon'],
            ['Maxfiy Odam', "Cho'pon", 'Oylik', 4_000_000, '2026-09-01', '901234567'],
          ]),
        )
      ).data.id,
    );
    const { withPlatform } = await import('../src/core/context');
    await withPlatform((trx) =>
      trx
        .update(schema.roles)
        .set({ permissions: ['hr.view', 'dashboard.view'] })
        .where(and(eq(schema.roles.tenantId, custom.tenantId), eq(schema.roles.key, 'storekeeper'))),
    );
    const res = await download(custom, 'storekeeper', '/export/employees?format=csv');
    expect(res.status).toBe(200);
    const text = res.body.toString('utf8');
    expect(text).not.toContain('Maxfiy');
    expect(text).not.toContain('901234567');
    expect(text).not.toContain('4000000');
    expect(text).toContain("Cho'pon");
  });

  it('writes a journal event, so downloads of data can be traced', async () => {
    await download(f, 'owner', '/export/counterparties');
    const events = await f.run(() => tx().select().from(schema.events).where(sql`type = 'data.exported'`));
    expect(events.length).toBeGreaterThan(0);
  });
});

describe('the pilot: 500 ewes', () => {
  it('imports 500 animals with pregnancies inside the request limit', async () => {
    const f = await createFixture();
    await f.run(() => tx().insert(herds).values({ tenantId: f.tenantId, farmId: f.farmId, name: "Bo'g'oz sovliqlar" }));

    const matingDate = (i: number) => addDays('2026-09-10', i % 45);
    const rows = Array.from({ length: 500 }, (_, i) => [
      `YA-${String(i + 1).padStart(4, '0')}`,
      'Hisori',
      "Urg'ochi",
      `${2 + (i % 4)} yosh`,
      55 + (i % 16),
      new Date(`${matingDate(i)}T00:00:00Z`),
      new Date('2026-10-20T00:00:00Z'),
      4_200_000,
      'Sherobod Chorva MChJ',
    ]);
    const file = await fill(await template(f, 'owner', 'animals'), rows);

    const t0 = performance.now();
    const preview = await upload(f, 'owner', 'animals', file);
    const t1 = performance.now();
    expect(preview.data.summary).toEqual({ new: 500, update: 0, skip: 0, error: 0 });

    const done = await confirm(f, 'owner', preview.data.id);
    const t2 = performance.now();
    expect(done.status).toBe(200);
    expect(done.data.importedRows).toBe(500);
    expect(done.data.summary.pregnancies).toBe(500);

    process.stderr.write(
      `TIMING 500 animals: file ${(file.length / 1024).toFixed(0)} KB, preview ${Math.round(t1 - t0)} ms, confirm ${Math.round(t2 - t1)} ms\n`,
    );
    expect(t1 - t0).toBeLessThan(10_000);
    expect(t2 - t1).toBeLessThan(30_000);

    const { registered, records, head } = await f.run(async () => ({
      registered: await tx().select().from(animals),
      records: await tx()
        .select({ tag: animals.tag, mating: breedingRecords.matingDate, expected: breedingRecords.expectedDate, status: breedingRecords.status })
        .from(breedingRecords)
        .innerJoin(animals, eq(animals.id, breedingRecords.eweId)),
      head: await tx().select().from(herds),
    }));
    expect(registered).toHaveLength(500);
    expect(new Set(registered.map((a) => a.herdId))).toEqual(new Set([head[0].id]));
    expect(registered.every((a) => a.status === 'pregnant')).toBe(true);
    expect(records).toHaveLength(500);

    for (const record of records) {
      const index = Number(record.tag.slice(3)) - 1;
      expect(record.mating).toBe(matingDate(index));
      expect(record.expected).toBe(expectedLambingDate(matingDate(index)));
      expect(record.status).toBe('pregnant');
    }
    // Hand-checked ends of the range: Sep 10 and Oct 24 plus 150 days.
    expect(records.find((r) => r.tag === 'YA-0001')!.expected).toBe('2027-02-07');
    expect(records.find((r) => r.tag === 'YA-0045')!.expected).toBe('2027-03-23');

    // Re-importing the pilot file does not double 500 sheep.
    const again = await upload(f, 'owner', 'animals', file);
    expect(again.data.summary).toMatchObject({ new: 0, skip: 500 });
  }, 120_000);
});

describe('fieldNumberOf', () => {
  it('reads the common ways of writing a field number, and leaves names alone', async () => {
    const { fieldNumberOf } = await import('../src/modules/import/templates');
    expect(fieldNumberOf('1')).toBe('1');
    expect(fieldNumberOf('№1')).toBe('1');
    expect(fieldNumberOf('Dala 1')).toBe('1');
    expect(fieldNumberOf('dala №12')).toBe('12');
    expect(fieldNumberOf('Поле 3')).toBe('3');
    expect(fieldNumberOf('Dala-4')).toBe('4');
    expect(fieldNumberOf('Y-1')).toBe('Y-1');
    expect(fieldNumberOf('Dalacha')).toBe('Dalacha');
  });
});
