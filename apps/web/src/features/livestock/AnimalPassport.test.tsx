import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '@/components';
import { ApiError } from '@/lib/api';
import i18n from '@/lib/i18n';
import { pathKey } from '@/lib/query';
import { AnimalBreedingTab, BreedingCard } from './AnimalBreedingTab';
import AnimalCardPage from './AnimalCardPage';
import { AnimalHealthTab, HealthCard } from './AnimalHealthTab';

// sonner adds its styles to the page as it loads, and there is no page here.
vi.mock('sonner', () => ({ toast: {} }));

const auth = vi.hoisted(() => ({ permissions: new Set<string>() }));

vi.mock('@/lib/auth', async (original) => ({
  ...(await original<typeof import('@/lib/auth')>()),
  usePermission: (permission: string) => auth.permissions.has(permission),
  useCan: () => (permission: string) => auth.permissions.has(permission),
}));

const ID = 'ewe-1';
const BREEDING = `/livestock/animals/${ID}/breeding`;
const HEALTH = `/livestock/animals/${ID}/health`;

const lamb = { sex: 'female', birthWeightKg: 3.5, alive: true, animalId: 'lamb-1', tag: 'YA-0501' };
const stillborn = { sex: 'male', birthWeightKg: null, alive: false, animalId: null, tag: null };

const breeding = {
  summary: { lambings: 2, lambsBorn: 3, lambsAlive: 2, survivalPercent: null, avgWeight100Kg: null, lastLambingDate: '2026-03-12' },
  matings: [
    { id: 'm3', source: 'mating', matingDate: '2026-09-14', expectedDate: '2027-02-11', status: 'pregnant', ramId: 'ram-1', ramTag: 'YA-0420', notes: null, canSetRam: true, lambing: null },
    { id: 'm2', source: 'mating', matingDate: '2025-10-13', expectedDate: '2026-03-12', status: 'lambed', ramId: null, ramTag: null, notes: null, canSetRam: false, lambing: { id: 'l2', date: '2026-03-12', lambsBorn: 2, lambsAlive: 1 } },
    { id: 'm1', source: 'purchase', matingDate: '2024-10-13', expectedDate: '2025-03-12', status: 'lambed', ramId: null, ramTag: null, notes: null, canSetRam: false, lambing: { id: 'l1', date: '2025-03-10', lambsBorn: 1, lambsAlive: 1 } },
  ],
  lambings: [
    { id: 'l2', breedingId: 'm2', date: '2026-03-12', lambsBorn: 2, lambsAlive: 1, complications: "Og'ir tug'ruq", ramId: null, ramTag: null, lambs: [lamb, stillborn] },
    { id: 'l1', breedingId: 'm1', date: '2025-03-10', lambsBorn: 1, lambsAlive: 1, complications: null, ramId: null, ramTag: null, lambs: [{ ...lamb, animalId: null, tag: null }] },
  ],
};

const record = {
  id: 'r1',
  type: 'treatment',
  date: '2026-10-01',
  scope: 'animal',
  herdName: null,
  diagnosis: null,
  itemName: null,
  itemUnit: null,
  dose: null,
  doseUnit: null,
  courseDays: null,
  vetName: null,
  result: null,
  withdrawalUntil: null,
  nextDueDate: null,
  reportStatus: null,
  endedOn: null,
  notes: null,
  totalCost: null,
};

const health = {
  nextDue: [
    { date: '2099-06-01', type: 'deworming', itemName: 'Albendazol' },
    { date: '2099-01-15', type: 'quarantine', itemName: null },
    { date: '2099-03-01', type: 'vaccination', itemName: 'Enterovak' },
  ],
  records: [
    { ...record, id: 'r5', type: 'quarantine', date: '2026-11-01', nextDueDate: '2099-01-15', diagnosis: 'Yangi kelgan' },
    { ...record, id: 'r4', type: 'examination', date: '2026-10-20', reportStatus: 'open', notes: 'Yem yemayapti' },
    { ...record, id: 'r3', type: 'vaccination', date: '2026-09-02', scope: 'herd', herdName: 'Sovliqlar-1', itemName: 'Enterovak', itemUnit: 'dose', dose: 2, nextDueDate: '2099-03-01' },
    { ...record, id: 'r2', type: 'vaccination', date: '2026-02-02', itemName: 'Eski vaksina' },
    { ...record, id: 'r1', totalCost: 18000, vetName: 'Karimov Aziz', withdrawalUntil: '2026-10-15', result: "Sog'aydi", courseDays: 3 },
  ],
};

const baseAnimal = {
  id: ID,
  tag: 'YA-0123',
  speciesId: 's',
  breedId: null,
  sex: 'female',
  category: 'ewe',
  birthDate: null,
  birthDateEstimated: false,
  origin: 'purchased',
  damId: null,
  sireId: null,
  purchaseDate: null,
  purchasePrice: null,
  sellerId: null,
  herdId: null,
  facilityId: null,
  status: 'active',
  currentWeightKg: null,
  lastWeighedOn: null,
  birthWeightKg: null,
  photoFileId: null,
  exitDate: null,
  notes: null,
  speciesName: { uz: "Qo'y", ru: 'Овца', en: 'Sheep' },
  speciesKey: 'sheep',
  breedName: null,
  herdName: null,
  facilityName: null,
  damTag: null,
  sireTag: null,
  sellerName: null,
  photoUrl: null,
  identifiers: [],
  weights: [],
  adgG: null,
  transfers: [],
  exit: null,
  pregnancy: null,
  withdrawalUntil: null,
  cost: null,
};

const newClient = () => new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, retryOnMount: false } } });

function html(node: ReactNode, seed: Record<string, unknown>, url = '/', client = newClient()) {
  for (const [path, data] of Object.entries(seed)) client.setQueryData(pathKey(path), data);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/** What a person reads. */
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

const hrefs = (markup: string) => [...markup.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);

const pageNode = (
  <ConfirmProvider>
    <Routes>
      <Route path="/livestock/animals/:id" element={<AnimalCardPage />} />
    </Routes>
  </ConfirmProvider>
);

const page = (animal: Record<string, unknown>, url = `/livestock/animals/${ID}`) =>
  html(pageNode, { [`/livestock/animals/${ID}`]: animal, [BREEDING]: breeding, [HEALTH]: health }, url);

const tabLabels = (markup: string) => [...markup.matchAll(/role="tab"[^>]*>([^<]+)</g)].map((match) => text(match[1]));

function failing(path: string, node: ReactNode) {
  const client = newClient();
  client.getQueryCache().build(client, { queryKey: pathKey(path) }).setState({ status: 'error', error: new ApiError(409, 'SOME_CODE', 'The server said no') });
  return text(html(node, {}, '/', client));
}

beforeEach(async () => {
  auth.permissions.clear();
  await i18n.changeLanguage('uz');
});

afterAll(() => {
  void i18n.changeLanguage('uz');
});

describe('passport tabs', () => {
  it('puts breeding and veterinary right after the overview', () => {
    auth.permissions.add('health.view');
    expect(tabLabels(page(baseAnimal))).toEqual(['Umumiy', 'Naslchilik', 'Veterinariya', 'Treker (GPS, harorat)', 'Baholash', 'Vazn', 'Identifikatorlar', "Ko'chirishlar"]);
  });

  it('keeps breeding from a male and from poultry, and veterinary from anyone without health.view', () => {
    expect(tabLabels(page({ ...baseAnimal, sex: 'male', category: 'ram' }))).not.toContain('Naslchilik');
    expect(tabLabels(page({ ...baseAnimal, speciesKey: 'poultry' }))).not.toContain('Naslchilik');
    expect(tabLabels(page(baseAnimal))).not.toContain('Veterinariya');
  });

  it('shows both answers on the overview without opening a tab', () => {
    auth.permissions.add('health.view');
    const screen = text(page(baseAnimal));
    expect(screen).toContain("2 marta, 3 qo'zi");
    expect(screen).toContain('Oxirgi emlash');
  });

  it('asks a person without health.view for nothing they would be refused', () => {
    expect(text(page(baseAnimal))).not.toContain('Oxirgi emlash');
  });

  it('opens the tab named in the address, so a reload stays on it', () => {
    auth.permissions.add('health.view');
    expect(text(page(baseAnimal, `/livestock/animals/${ID}?tab=breeding`))).toContain('Qochirishlar');
    expect(text(page(baseAnimal, `/livestock/animals/${ID}?tab=health`))).toContain('Keyingi muddatlar');
  });

  it("asks for a tab's data only when that tab is open", () => {
    auth.permissions.add('health.view');
    const asked = (tab: string) => {
      const client = newClient();
      html(pageNode, { [`/livestock/animals/${ID}`]: baseAnimal }, `/livestock/animals/${ID}?tab=${tab}`, client);
      return [BREEDING, HEALTH].filter((path) => client.getQueryCache().find({ queryKey: pathKey(path) }));
    };
    expect(asked('weights')).toEqual([]);
    expect(asked('breeding')).toEqual([BREEDING]);
    expect(asked('health')).toEqual([HEALTH]);
    expect(asked('overview')).toEqual([BREEDING, HEALTH]);
  });

  it('falls back to the overview for a tab this animal does not have', () => {
    expect(text(page({ ...baseAnimal, sex: 'male', category: 'ram' }, `/livestock/animals/${ID}?tab=breeding`))).not.toContain('Qochirishlar');
  });
});

describe('breeding card on the overview', () => {
  it('links the last ram to its passport and counts births the way the owner asked', () => {
    const markup = html(<BreedingCard animalId={ID} speciesKey="sheep" />, { [BREEDING]: breeding });
    expect(hrefs(markup)).toContain('/livestock/animals/ram-1');
    expect(text(markup)).toContain("Qo'chqor");
    expect(text(markup)).toContain('14.09.2026');
    expect(text(markup)).toContain("2 marta, 3 qo'zi");
    expect(text(markup)).toContain("Faqat shu fermadagi tug'ishlar");
  });

  it('says a ewe bought pregnant has an unknown ram, and why', () => {
    const data = { ...breeding, matings: breeding.matings.slice(2) };
    const screen = text(html(<BreedingCard animalId={ID} speciesKey="sheep" />, { [BREEDING]: data }));
    expect(screen).toContain("Noma'lum");
    expect(screen).toContain("Fermaga bo'g'oz holda kelgan");
  });

  it('does not claim a birth count of zero as a fact about her whole life', () => {
    const data = { ...breeding, summary: { ...breeding.summary, lambings: 0, lambsBorn: 0, lambsAlive: 0 } };
    const screen = text(html(<BreedingCard animalId={ID} speciesKey="sheep" />, { [BREEDING]: data }));
    expect(screen).toContain("Bu fermada hali tug'magan");
    expect(screen).not.toContain('0 marta');
  });

  it.each([
    ['goat', 'Taka', '2 marta, 3 uloq'],
    ['cattle', 'Buqa', '2 marta, 3 buzoq'],
    ['horse', "Ayg'ir", '2 marta, 3 toy'],
  ])('speaks of %s in its own words', (speciesKey, male, births) => {
    const screen = text(html(<BreedingCard animalId={ID} speciesKey={speciesKey} />, { [BREEDING]: breeding }));
    expect(screen).toContain(male);
    expect(screen).toContain(births);
    expect(screen).not.toContain("Qo'chqor");
    expect(screen).not.toContain("qo'zi");
  });

  it('falls back to a neutral word for a species it has no word for', () => {
    expect(text(html(<BreedingCard animalId={ID} speciesKey={null} />, { [BREEDING]: breeding }))).toContain('2 marta, 3 bola');
    expect(text(html(<BreedingCard animalId={ID} speciesKey="camel" />, { [BREEDING]: breeding }))).toContain('2 marta, 3 bola');
  });

  it('declines the count in Russian and English', async () => {
    await i18n.changeLanguage('ru');
    expect(text(html(<BreedingCard animalId={ID} speciesKey="sheep" />, { [BREEDING]: breeding }))).toContain('2 раза, 3 ягнёнка');
    const five = { ...breeding, summary: { ...breeding.summary, lambings: 1, lambsBorn: 5 } };
    expect(text(html(<BreedingCard animalId={ID} speciesKey="cattle" />, { [BREEDING]: five }))).toContain('1 раз, 5 телят');
    await i18n.changeLanguage('en');
    expect(text(html(<BreedingCard animalId={ID} speciesKey="goat" />, { [BREEDING]: breeding }))).toContain('2 times, 3 kids');
    const one = { ...breeding, summary: { ...breeding.summary, lambings: 1, lambsBorn: 1 } };
    expect(text(html(<BreedingCard animalId={ID} speciesKey="cattle" />, { [BREEDING]: one }))).toContain('1 time, 1 calf');
  });

  it('keeps its placeholders in Uzbek Cyrillic', async () => {
    auth.permissions.add('health.update');
    await i18n.changeLanguage('uz-Cyrl');
    const card = text(html(<BreedingCard animalId={ID} speciesKey="sheep" />, { [BREEDING]: breeding }));
    expect(card).toContain('2 марта, 3 қўзи');
    expect(card).not.toContain('{{');
    const tab = text(html(<AnimalBreedingTab animalId={ID} speciesKey="sheep" tag="YA-0123" />, { [BREEDING]: breeding }));
    expect(tab).toContain('Қўчқорни белгилаш');
    expect(tab).not.toContain('{{');
  });
});

describe('breeding tab', () => {
  const tab = (seed: Record<string, unknown> = { [BREEDING]: breeding }, speciesKey = 'sheep') => html(<AnimalBreedingTab animalId={ID} speciesKey={speciesKey} tag="YA-0123" />, seed);

  it('shows a dash for what is not known, and real counts as numbers', () => {
    const screen = text(tab());
    expect(screen).toContain("Tug'ishlar 2");
    expect(screen).toContain("Tug'ilgan qo'zilar 3");
    expect(screen).toContain("Tirik tug'ilgan qo'zilar 2");
    expect(screen).toContain('Saqlanib qolish —');
    expect(screen).toContain('100 kunlik vazn —');
  });

  it('states that the counts cover this farm only', () => {
    expect(text(tab())).toContain("Bu sonlar faqat shu fermadagi tug'ishlarni ko'rsatadi");
  });

  it('gives each mating its ram, status, expected date and result', () => {
    const screen = text(tab());
    expect(screen).toContain('14.09.2026');
    expect(screen).toContain('11.02.2027');
    expect(screen).toContain('Kutilmoqda');
    expect(screen).toContain("12.03.2026: 2 qo'zi, 1 tirik");
    expect(screen).toContain("Tug'gan");
  });

  it('marks a ram nobody recorded as unknown, and adds the purchase note only for a purchase', () => {
    const notes = (markup: string) => text(markup).split("Fermaga bo'g'oz holda kelgan").length - 1;
    // The purchase mating and its birth; never the plain mating with no ram.
    expect(notes(tab())).toBe(2);
    expect(text(tab())).toContain("Noma'lum");
  });

  it('never prints a closed mating with no birth as blank', () => {
    const data = { ...breeding, matings: [{ ...breeding.matings[2], status: 'aborted', lambing: null }] };
    const screen = text(tab({ [BREEDING]: data }));
    expect(screen).toContain('Bola tashlagan');
    expect(screen).toContain("Tug'ish bo'lmagan");
  });

  it('offers to set the ram only where the server allows it and the person may change it', () => {
    expect(text(tab())).not.toContain("Qo'chqorni belgilash");
    auth.permissions.add('health.update');
    expect(text(tab()).split("Qo'chqorni belgilash").length - 1).toBe(1);
    auth.permissions.clear();
    auth.permissions.add('livestock.update');
    expect(text(tab())).toContain("Qo'chqorni belgilash");
  });

  it('links a living young animal to its passport and never a stillborn one', () => {
    const markup = tab();
    const screen = text(markup);
    expect(hrefs(markup)).toContain('/livestock/animals/lamb-1');
    expect(screen).toContain('YA-0501');
    expect(screen).toContain("O'lik tug'ilgan");
    expect(screen).toContain('Birkasiz');
    expect(hrefs(markup).filter((href) => href.includes('null'))).toEqual([]);
  });

  it('prints births with their numbers and complications, or a dash', () => {
    const screen = text(tab());
    expect(screen).toContain('1 / 2');
    expect(screen).toContain("Og'ir tug'ruq");
    expect(screen).toContain('Asoratlar —');
  });

  it('uses the species word in every heading it builds', () => {
    const screen = text(tab({ [BREEDING]: breeding }, 'cattle'));
    expect(screen).toContain("Tug'ilgan buzoqlar");
    expect(screen).toContain('Buqa');
    expect(screen).not.toContain("qo'zi");
    expect(screen).not.toContain("Qo'zi");
    expect(screen).not.toContain("Qo'chqor");
  });

  it('has an empty state, a skeleton and a retry card', () => {
    const empty = { ...breeding, matings: [], lambings: [] };
    expect(text(tab({ [BREEDING]: empty }))).toContain("Naslchilik yozuvlari yo'q");
    expect(tab({})).toContain('animate-pulse');
  });

  it('shows the server message with a retry when the request fails', () => {
    for (const node of [<AnimalBreedingTab key="tab" animalId={ID} speciesKey="sheep" tag="YA-0123" />, <BreedingCard key="card" animalId={ID} speciesKey="sheep" />]) {
      const screen = failing(BREEDING, node);
      expect(screen).toContain('The server said no');
      expect(screen).toContain('Qayta urinish');
    }
  });
});

describe('veterinary card on the overview', () => {
  const screen = (data: unknown = health) => text(html(<HealthCard animalId={ID} />, { [HEALTH]: data }));

  it('names the last vaccination, even one given to the whole herd', () => {
    expect(screen()).toContain('02.09.2026');
    expect(screen()).toContain('Enterovak');
    expect(screen()).not.toContain('Eski vaksina');
  });

  it('gives the soonest next date, and leaves a quarantine end to the quarantine line', () => {
    expect(screen()).toContain('01.03.2099');
    expect(screen()).not.toContain('01.06.2099');
  });

  it('raises an open sick report and an open quarantine', () => {
    expect(screen()).toContain('Ochiq kasallik xabari');
    expect(screen()).toContain('Yem yemayapti');
    expect(screen()).toContain('Karantin davom etmoqda');
    expect(screen()).toContain('15.01.2099 gacha');
  });

  it('stays quiet about a closed report and a finished quarantine', () => {
    const closed = {
      nextDue: [],
      records: [
        { ...record, id: 'a', type: 'quarantine', endedOn: '2026-10-01' },
        { ...record, id: 'b', type: 'examination', reportStatus: 'resolved' },
      ],
    };
    expect(screen(closed)).not.toContain('Ochiq kasallik xabari');
    expect(screen(closed)).not.toContain('Karantin davom etmoqda');
    expect(screen(closed)).toContain('Oxirgi emlash —');
    expect(screen(closed)).toContain('Keyingi muddat —');
  });

  it('flags a date that has passed', () => {
    expect(screen({ nextDue: [{ date: '2026-01-01', type: 'vaccination', itemName: null }], records: [] })).toContain("Muddati o'tgan");
    expect(screen()).not.toContain("Muddati o'tgan");
  });
});

describe('veterinary tab', () => {
  const tab = (onFarm = true, data: unknown = health) => html(<AnimalHealthTab animalId={ID} tag="YA-0123" onFarm={onFarm} />, { [HEALTH]: data });

  it('marks a herd record as one and names the herd', () => {
    expect(text(tab())).toContain('Butun poda uchun yozuv : Sovliqlar-1');
  });

  it('prints what was given, with its dose and unit', () => {
    const screen = text(tab());
    expect(screen).toContain('Preparat Enterovak');
    expect(screen).toContain('Doza 2 doza');
  });

  it('shows a dash for what is missing, and the vet only when the server sent the name', () => {
    const screen = text(tab(true, { nextDue: [], records: [record] }));
    expect(screen).toContain('Preparat —');
    expect(screen).toContain('Doza —');
    expect(screen).toContain('Veterinar —');
    expect(screen).toContain('Natija —');
    // No withdrawal period: the sale date is left out rather than shown as an empty "can be sold".
    expect(screen).not.toContain('Sotish mumkin');
    expect(screen).toContain('Keyingi muddat —');
    expect(text(tab())).toContain('Veterinar Karimov Aziz');
  });

  it('shows cost only when the server sent it', () => {
    expect(text(tab(true, { nextDue: [], records: [record] }))).not.toContain('Xarajat');
    expect(text(tab())).toContain('Xarajat');
    expect(text(tab())).toContain("18 000 so'm");
  });

  it("reads a quarantine's dates as a quarantine's", () => {
    const screen = text(tab());
    expect(screen).toContain('Tugash muddati 15.01.2099');
    expect(screen).toContain('Sabab Yangi kelgan');
  });

  it('offers a new record only to the vet, and only while the animal is on the farm', () => {
    expect(text(tab())).not.toContain("Yozuv qo'shish");
    auth.permissions.add('health.update');
    expect(text(tab())).toContain("Yozuv qo'shish");
    expect(text(tab(false))).not.toContain("Yozuv qo'shish");
  });

  it('has an empty state, a skeleton and a retry card', () => {
    expect(text(tab(true, { nextDue: [], records: [] }))).toContain("Veterinariya yozuvlari yo'q");
    expect(html(<AnimalHealthTab animalId={ID} tag="YA-0123" onFarm />, {})).toContain('animate-pulse');
    for (const node of [<AnimalHealthTab key="tab" animalId={ID} tag="YA-0123" onFarm />, <HealthCard key="card" animalId={ID} />]) {
      const screen = failing(HEALTH, node);
      expect(screen).toContain('The server said no');
      expect(screen).toContain('Qayta urinish');
    }
  });

  it('has every word in Russian and English', async () => {
    for (const language of ['ru', 'en']) {
      await i18n.changeLanguage(language);
      const screen = text(tab());
      expect(screen).not.toMatch(/card\.|vet:|journal\.|enums:|\{\{/);
      expect(text(html(<AnimalBreedingTab animalId={ID} speciesKey="horse" tag="YA-0123" />, { [BREEDING]: breeding }))).not.toMatch(/card\.|vet:|lambing\.|enums:|\{\{/);
    }
  });
});
