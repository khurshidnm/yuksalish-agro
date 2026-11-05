import { describe, expect, it } from 'vitest';
import { latinToCyrillic } from '../i18n/translit';
import { currencyOf, currencySaid, findMention, isMoneyCurrency, parseMoneyMentions } from './money-text';

const amounts = (text: string) => parseMoneyMentions(text).map((m) => m.amount);

describe('parseMoneyMentions', () => {
  it.each([
    ["Yoqilg'iga 3 mln to'ladim", 3_000_000],
    ['2,5 mln berdim', 2_500_000],
    ['2.5 mln', 2_500_000],
    ['1.2 mlrd kredit', 1_200_000_000],
    ['500 ming tushlik', 500_000],
    ['1.200 mln', 1_200_000],
    ['3 000 000', 3_000_000],
    ['3.000.000 so\'m', 3_000_000],
    ['3,000,000 sum', 3_000_000],
    ['3000000', 3_000_000],
    ['750 ming so\'m', 750_000],
    ['2 млн сум', 2_000_000],
    ['500 тыс', 500_000],
    ['пол миллиона', 500_000],
    ['1,5 миллиона рублей', 1_500_000],
    ['3 млн 500 минг сўм', 3_500_000],
    ['3 mln 500 ming', 3_500_000],
    ['3 mln va 200 ming', 3_200_000],
    ['2 миллиона 300 тысяч', 2_300_000],
    ['yarim mln', 500_000],
    ['uch yarim million', 3_500_000],
    ['ikki million', 2_000_000],
    ['besh yuz ming', 500_000],
    ['yigirma besh ming', 25_000],
    ['bir yarim mln', 1_500_000],
    ['два миллиона', 2_000_000],
    ['пятьсот тысяч', 500_000],
    ['двадцать пять тысяч', 25_000],
    ['икки миллион', 2_000_000],
    ['Paid 900 thousand', 900_000],
    ['2 million', 2_000_000],
    ['1.5 billion', 1_500_000_000],
    ['1,5 milion', 1_500_000],
    ['2 milyon', 2_000_000],
    ['5 лимонов', 5_000_000],
    ['2 ляма', 2_000_000],
    ['300 тыщ', 300_000],
    ['беш юз минг', 500_000],
  ])('%s → %d', (text, expected) => {
    expect(amounts(text)).toEqual([expected]);
  });

  it('reads the currency', () => {
    expect(parseMoneyMentions('$200')[0]).toMatchObject({ amount: 200, currency: 'USD', bare: false });
    expect(parseMoneyMentions('200 dollar')[0]).toMatchObject({ amount: 200, currency: 'USD' });
    expect(parseMoneyMentions('200 долларов')[0]).toMatchObject({ amount: 200, currency: 'USD' });
    expect(parseMoneyMentions('50 evro')[0]).toMatchObject({ amount: 50, currency: 'EUR' });
    expect(parseMoneyMentions('1000 rubl')[0]).toMatchObject({ amount: 1000, currency: 'RUB' });
    expect(parseMoneyMentions("3 mln so'm")[0]).toMatchObject({ currency: 'UZS' });
    expect(parseMoneyMentions('3 mln')[0].currency).toBeNull();
  });

  it('accepts every apostrophe people type', () => {
    for (const mark of ["'", 'ʻ', '‘', '’', '`']) expect(parseMoneyMentions(`5 ming so${mark}m`)[0].currency).toBe('UZS');
  });

  it('flags a plain number, which may not mean what it seems', () => {
    expect(parseMoneyMentions("yoqilg'iga 500 berdim")[0]).toMatchObject({ amount: 500, bare: true });
  });

  it.each([
    ['50 qop kepak oldim'],
    ['2 tonna somon'],
    ['500 kg arpa'],
    ['120 litr dizel'],
    ['10 ta qo\'y'],
    ['12 gektar'],
    ['5 kun'],
    ['MTZ-82 ga'],
    ['3-dala'],
    ['№3 dala'],
    ['5-noyabr'],
    ['12.11.2026 kuni'],
    ['2026-11-04'],
    ['ikki kun oldin'],
    ['uch qop'],
    ['пять мешков'],
  ])('%s is not money', (text) => {
    expect(amounts(text)).toEqual([]);
  });

  it('separates money from the quantities around it', () => {
    expect(amounts('50 qop kepak oldim 5 mln')).toEqual([5_000_000]);
    expect(amounts("120 litr dizel 1 mln 800 ming so'm")).toEqual([1_800_000]);
    expect(amounts('MTZ-82 ta\'miriga 2 mln')).toEqual([2_000_000]);
    expect(amounts('3-dala suv uchun 400 ming')).toEqual([400_000]);
  });

  it('finds each amount in a message with several', () => {
    expect(amounts("3 mln yoqilg'i, 500 ming tushlik")).toEqual([3_000_000, 500_000]);
  });

  it('finds nothing in a message with no amount', () => {
    expect(amounts("Yoqilg'iga pul to'ladim")).toEqual([]);
    expect(amounts('')).toEqual([]);
  });
});

describe('findMention', () => {
  const mentions = parseMoneyMentions("3 mln yoqilg'i, 500 ming tushlik");
  it('matches only amounts that were stated', () => {
    expect(findMention(mentions, 3_000_000)?.raw).toBe('3 mln');
    expect(findMention(mentions, 500_000)?.raw).toBe('500 ming');
    expect(findMention(mentions, 3_500_000)).toBeNull();
    expect(findMention(mentions, 300_000)).toBeNull();
  });
});

// ─── Hardening: every row below was worked out by hand ─────────────────────

const toRussianKeyboard = (text: string) =>
  text.replace(/[қҚўЎғҒҳҲ]/g, (letter) => ({ қ: 'к', Қ: 'К', ў: 'у', Ў: 'У', ғ: 'г', Ғ: 'Г', ҳ: 'х', Ҳ: 'Х' })[letter]!);

/** One Uzbek phrase as it really arrives: any apostrophe or none, capitals, Cyrillic, a Russian keyboard. */
const uzbekSpellings = (text: string) => [
  text,
  text.replace(/'/g, 'ʻ'),
  text.replace(/'/g, '’'),
  text.replace(/'/g, ''),
  text.toUpperCase(),
  latinToCyrillic(text),
  toRussianKeyboard(latinToCyrillic(text)),
];

const read = (text: string) => parseMoneyMentions(text).map((m) => ({ amount: m.amount, currency: m.currency }));
const only = (text: string) => {
  const mentions = parseMoneyMentions(text);
  expect(mentions, text).toHaveLength(1);
  return mentions[0];
};

describe('Uzbek amounts, in every spelling', () => {
  it.each<[string, number, string?]>([
    ['3 mln', 3_000_000], ['3mln', 3_000_000], ['3,5 mln', 3_500_000], ['3.5 mln', 3_500_000], ['2 yarim mln', 2_500_000], ['500 ming', 500_000],
    ['500ming', 500_000], ['1,2 mlrd', 1_200_000_000], ['uch million', 3_000_000], ["to'rt million", 4_000_000], ['yetti million', 7_000_000],
    ['uch yarim million', 3_500_000], ['ikki yarim million', 2_500_000], ['bir yarim mln', 1_500_000], ['yarim million', 500_000], ['yarim mln', 500_000],
    ['bir million ikki yuz ming', 1_200_000], ['million ikki yuz ming', 1_200_000], ['ikki million uch yuz', 2_300_000], ['ikki million yarim', 2_500_000],
    ['3 mln yarim', 3_500_000], ['yetti million ikki yuz ming', 7_200_000], ['bir ming', 1_000], ['uch yuz ming', 300_000], ['besh yuz ming', 500_000],
    ['olti yuz ming', 600_000], ['sakkiz yuz ming', 800_000], ["to'qqiz yuz ellik ming", 950_000], ['yuz ming', 100_000], ['bir yuz ming', 100_000],
    ['yigirma besh ming', 25_000], ['ellik ming', 50_000], ["o'n besh ming", 15_000], ["o'ttiz ming", 30_000], ['qirq besh ming', 45_000],
    ['oltmish ming', 60_000], ['yetmish ming', 70_000], ['sakson ming', 80_000], ["to'qson ming", 90_000], ["o'n ikki million", 12_000_000],
    ['ikki yuz ellik ming', 250_000], ['ikki yarim ming', 2_500], ['5 yuz ming', 500_000],
    ['ming dollar', 1_000, 'USD'], ['ming ikki yuz dollar', 1_200, 'USD'], ['bir ming ikki yuz dollar', 1_200, 'USD'], ['yuz dollar', 100, 'USD'],
    ['besh yuz dollar', 500, 'USD'], ["bir million ikki yuz ming besh yuz so'm", 1_200_500, 'UZS'], ["besh ming besh yuz so'm", 5_500, 'UZS'],
    ["750 ming so'm", 750_000, 'UZS'], ["750 ming so'mga", 750_000, 'UZS'], ["3 000 000 so'm", 3_000_000, 'UZS'], ["1 mln 200 ming 500 so'm", 1_200_500, 'UZS'],
    ["1 ming 500 so'm", 1_500, 'UZS'], ["3 mln so'mlik", 3_000_000, 'UZS'], ['200 dollar', 200, 'USD'], ['200 dollarga', 200, 'USD'], ['200 dollarni', 200, 'USD'],
    ['200 dollarlik', 200, 'USD'], ['100 evro', 100, 'EUR'], ['100 evrodan', 100, 'EUR'], ['1000 rubl', 1_000, 'RUB'], ['2 ming dollar', 2_000, 'USD'],
    ['500 mingga', 500_000], ['500 mingdan', 500_000], ['500 minglik', 500_000], ['5 millionga', 5_000_000], ['3 mln dan', 3_000_000], ['2 mln lik', 2_000_000],
    ['1500000lik', 1_500_000], ['500000ga', 500_000], ['500 000 ga', 500_000], ['3 000 000-ga', 3_000_000], ['3 000 000-dan', 3_000_000],
    ['3 mln 500 ming', 3_500_000], ['3 mln va 200 ming', 3_200_000], ['1 mln 200 ming', 1_200_000], ['1 mln 200 ming 500', 1_200_500], ['10 mln 500 ming', 10_500_000],
  ])('%s', (text, amount, currency) => {
    for (const form of uzbekSpellings(text)) expect(read(form), form).toEqual([{ amount, currency: currency ?? null }]);
  });
});

describe('Russian amounts', () => {
  it.each<[string, number, string?]>([
    ['полтора миллиона', 1_500_000], ['полтора млн', 1_500_000], ['полтора лимона', 1_500_000], ['полтора ляма', 1_500_000], ['полторы тысячи', 1_500],
    ['полутора миллионов', 1_500_000], ['полмиллиона', 500_000], ['пол миллиона', 500_000], ['пол-миллиона', 500_000], ['полляма', 500_000], ['пол ляма', 500_000],
    ['поллимона', 500_000], ['полмиллиарда', 500_000_000], ['половина миллиона', 500_000], ['два с половиной миллиона', 2_500_000], ['три с половиной миллиона', 3_500_000],
    ['два с половиной лимона', 2_500_000], ['миллион', 1_000_000], ['миллион двести', 1_200_000], ['миллион двести тысяч', 1_200_000], ['миллион двести пятьдесят', 1_250_000],
    ['два миллиона', 2_000_000], ['два миллиона триста', 2_300_000], ['двух миллионов', 2_000_000], ['пяти тысяч', 5_000], ['пятнадцать тысяч', 15_000], ['двенадцать миллионов', 12_000_000],
    ['двести пятнадцать тысяч', 215_000], ['двести тысяч', 200_000], ['пятьсот тысяч', 500_000], ['двадцать пять тысяч', 25_000], ['сто тысяч', 100_000], ['девяносто тысяч', 90_000],
    ['тысячу долларов', 1_000, 'USD'], ['тысяча двести долларов', 1_200, 'USD'], ['две тысячи пятьсот долларов', 2_500, 'USD'], ['сто долларов', 100, 'USD'], ['сто рублей', 100, 'RUB'],
    ['3 млн', 3_000_000], ['3млн', 3_000_000], ['3 млн.', 3_000_000], ['3 миллиона', 3_000_000], ['5 лимонов', 5_000_000], ['5 лимон', 5_000_000], ['2 ляма', 2_000_000], ['5 лямов', 5_000_000],
    ['300 тыс', 300_000], ['300 тыс.', 300_000], ['300 тыщ', 300_000], ['5 косарей', 5_000], ['1,5 млрд', 1_500_000_000], ['1 млн 200 тыс', 1_200_000], ['3 млн. 500 тыс.', 3_500_000],
    ['1 млн. 200 тыс. сум', 1_200_000, 'UZS'], ['500 тыс. руб.', 500_000, 'RUB'], ['2 млн. руб.', 2_000_000, 'RUB'], ['100 тыс. долл.', 100_000, 'USD'], ['1,5 млн. долларов', 1_500_000, 'USD'],
    ['500 долл', 500, 'USD'], ['500 руб', 500, 'RUB'], ['500 рублей', 500, 'RUB'], ['2 рубля', 2, 'RUB'], ['100 бакс', 100, 'USD'], ['100 баксов', 100, 'USD'], ['100 у.е.', 100, 'USD'], ['100 у.е', 100, 'USD'],
    ['200 евро', 200, 'EUR'], ['3 млн сум', 3_000_000, 'UZS'], ['3 млн сумов', 3_000_000, 'UZS'],
  ])('%s', (text, amount, currency) => {
    expect(read(text)).toEqual([{ amount, currency: currency ?? null }]);
  });
});

describe('English amounts', () => {
  it.each<[string, number, string?]>([
    ['one million', 1_000_000], ['two million', 2_000_000], ['two hundred thousand', 200_000], ['half a million', 500_000], ['half million', 500_000], ['a million', 1_000_000],
    ['two and a half million', 2_500_000], ['twenty five thousand', 25_000], ['twenty-five thousand', 25_000], ['three hundred and fifty thousand', 350_000], ['fifteen thousand', 15_000],
    ['a thousand dollars', 1_000, 'USD'], ['a hundred dollars', 100, 'USD'], ['two hundred dollars', 200, 'USD'], ['900 thousand', 900_000], ['2 million', 2_000_000], ['1.5 billion', 1_500_000_000],
    ['500k', 500_000], ['500 k', 500_000], ['1.5k', 1_500], ['1m', 1_000_000], ['$5k', 5_000, 'USD'], ['$2m', 2_000_000, 'USD'], ['50 euros', 50, 'EUR'], ['100 bucks', 100, 'USD'],
    ['50 000 roubles', 50_000, 'RUB'], ['USD 200', 200, 'USD'], ['EUR 100', 100, 'EUR'], ['usd200', 200, 'USD'], ['UZS 500 000', 500_000, 'UZS'],
  ])('%s', (text, amount, currency) => {
    expect(read(text)).toEqual([{ amount, currency: currency ?? null }]);
  });
});

describe('digits and separators', () => {
  it.each<[string, number, string?]>([
    ['1.500.000', 1_500_000], ['1,500,000', 1_500_000], ['1 500 000', 1_500_000], ['1 500 000', 1_500_000], ['1 500 000', 1_500_000], ['1  500  000', 1_500_000],
    ['150000000', 150_000_000], ['900000000', 900_000_000], ['1500000000', 1_500_000_000], ['1.200.000,50', 1_200_000.5], ['1,200,000.50', 1_200_000.5], ['1 200 000,50', 1_200_000.5], ['12.500,75', 12_500.75], ['4 999 999,99', 4_999_999.99], ['.5 mln', 500_000],
    ['1.200 ming', 1_200_000], ['12.500 ming', 12_500_000], ['1.200 mln', 1_200_000], ['1,250 mln', 1_250_000], ['0,5 mln', 500_000], ['1.200 USD', 1_200, 'USD'], ['1,200', 1_200], ['12,500', 12_500],
    ['$1,200', 1_200, 'USD'], ['$1,200.50', 1_200.5, 'USD'], ['1200$', 1_200, 'USD'], ['€200', 200, 'EUR'], ['₽100', 100, 'RUB'], ['$ 200', 200, 'USD'], ['2 mln $', 2_000_000, 'USD'], ['$2 mln', 2_000_000, 'USD'],
    ['2 млн$', 2_000_000, 'USD'], ['5 ming$', 5_000, 'USD'], ['5ming$', 5_000, 'USD'], ['1,5 mln$', 1_500_000, 'USD'], ['5 ming€', 5_000, 'EUR'], ['$100.40', 100.4, 'USD'],
    ['Elektr-3 mln', 3_000_000], ['gaz-500 ming', 500_000], ['Tushlik-250000', 250_000], ['250000-tushlik', 250_000], ['Elektr - 3 mln', 3_000_000],
    ['300к', 300_000], ['5к', 5_000], ['300т', 300_000], ['300 т.р', 300_000, 'RUB'], ['300т.р.', 300_000, 'RUB'], ['300 т.р.', 300_000, 'RUB'], ['300 т.с', 300_000, 'UZS'],
  ])('%s', (text, amount, currency) => {
    expect(read(text)).toEqual([{ amount, currency: currency ?? null }]);
  });

  it('never gives a number that is not a number', () => {
    for (const text of ['1.2.3.4', '1,2,3', '..5', ',,', '1..2', '.', '$', '1.200.000,50.5', '12,500,75']) {
      for (const mention of parseMoneyMentions(text)) expect(Number.isFinite(mention.amount), text).toBe(true);
    }
  });
});

describe('words that only look like a unit stay money', () => {
  it.each<[string, number]>([
    ['500000 kunjara', 500_000], ['2 000 000 kunjaraga', 2_000_000], ['1 500 000 boshqa xarajat', 1_500_000], ["800000 motor ta'miriga", 800_000], ['800000 motorga', 800_000],
    ['200 000 штраф', 200_000], ['300 000 грузчикам', 300_000], ["250000 bog'bonga", 250_000], ["500 000 boshlig'iga", 500_000], ["200000 ta'mirga", 200_000], ['3 000 000 taxi', 3_000_000],
    ['1 500 000 ga oldim', 1_500_000], ['3 mln kunjara', 3_000_000], ['3 mln metallga', 3_000_000], ["3 mln to'yga", 3_000_000], ["3 mln to'y uchun", 3_000_000], ['3 mln kun uchun', 3_000_000],
  ])('%s', (text, amount) => {
    expect(read(text)).toEqual([{ amount, currency: null }]);
  });
});

describe('a currency is a whole word', () => {
  it.each([
    ['500 тысяч рубашки'], ['500 минг рубероид'], ['3 млн евроремонт'], ['3 mln Evropa'], ['3 mln Eurotrans'], ['500 somsa'], ['200 somon'], ['300 sumkaga'], ['500 ming somonga'], ['3 млн сумка'], ['3 млн сумма'],
    ['3 mln dolzarb'], ['5 mln rublevka'], ['200 ming evropalik'], ['2 mln евровагонка'],
  ])('%s has no currency', (text) => {
    expect(parseMoneyMentions(text)[0].currency).toBeNull();
    expect(parseMoneyMentions(text)[0].unknownCurrency).toBeUndefined();
  });

  it.each<[string, string]>([
    ['$500 somon uchun', 'USD'], ['$300 sumkaga', 'USD'], ['€200 somonga', 'EUR'], ["$5 ming so'm", 'USD'],
  ])('a symbol on the number wins over what follows: %s', (text, currency) => {
    expect(parseMoneyMentions(text)[0].currency).toBe(currency);
  });

  it.each<[string, string, number]>([
    ['50 000 tenge', 'tenge', 50_000], ['150000 yuan', 'yuan', 150_000], ['20000 манат', 'манат', 20_000], ['30000 lira', 'lira', 30_000], ['25000 shmollar', 'shmollar', 25_000], ["15 000 ko'k", "ko'k", 15_000],
    ['5 ming teng', '', 5_000], ['£20000', '£', 20_000], ['₸50000', '₸', 50_000], ['50 000 ₸', '₸', 50_000], ['¥300 000', '¥', 300_000], ['100 фунтов', 'фунтов', 100], ['200 pounds', 'pounds', 200], ['5000 юаней', 'юаней', 5_000], ['300 aed', 'aed', 300],
  ])('%s is not so\'m', (text, word, amount) => {
    const mention = parseMoneyMentions(text)[0];
    expect(mention).toMatchObject({ amount, currency: null });
    expect(mention.unknownCurrency).toBe(word === '' ? undefined : word);
    if (word !== '') expect(mention.bare).toBe(false);
  });

  it.each([['200 AQSh dollari'], ['2 ming AQSh dollari'], ['200 US dollars'], ['200 американских долларов'], ['200 АҚШ доллари']])('%s is dollars', (text) => {
    expect(parseMoneyMentions(text)[0].currency).toBe('USD');
  });

  it('an account named after a currency is not the currency of the amount', () => {
    expect(parseMoneyMentions('3 mln Dollar seyfdan elektrga')[0]).toMatchObject({ amount: 3_000_000, currency: null });
    expect(parseMoneyMentions('Elektrga 200 dollar Dollar seyfdan')[0]).toMatchObject({ amount: 200, currency: 'USD' });
    expect(parseMoneyMentions('Gazga 200 dollar kassadan')[0]).toMatchObject({ amount: 200, currency: 'USD' });
    expect(parseMoneyMentions("Gazga 700 ming so'm dollar kassadan")[0]).toMatchObject({ amount: 700_000, currency: 'UZS' });
  });

  it('knows which codes the books keep', () => {
    expect(['UZS', 'USD', 'EUR', 'RUB'].every(isMoneyCurrency)).toBe(true);
    expect([null, undefined, 'usd', 'KZT', ''].some(isMoneyCurrency)).toBe(false);
  });

  it('reads any written currency word', () => {
    expect(['USD', "so'm", 'сум', 'сўм', 'som', 'доллар', 'рубль', 'евро', 'tenge'].map(currencyOf)).toEqual(['USD', 'UZS', 'UZS', 'UZS', 'UZS', 'USD', 'RUB', 'EUR', null]);
  });
});

describe('numbers that are never money', () => {
  it.each([
    // Quantities, also with a scale word
    ['2 tonna'], ['ikki tonna'], ['50 qop'], ['10 ga'], ['100 l'], ['2 ming litr'], ['ikki ming litr'], ["3 ming bosh qo'y"], ['5 ming tonna'], ['1,5 ming kg'], ['2 тысячи литров'], ['две тысячи литров'],
    ['500 тысяч голов'], ['3 mingta'], ['5 ming dona'], ['10 га'], ['2 т'], ['100 л'], ['5 та'], ['2т'], ['20 флаконов'], ['500 доз'], ['пять мешков'], ['uch qop'], ['ming litr'], ['two tonnes'], ['yarim kilo'],
    ['5 kunga'], ['3 kunlik'], ['2 soat'], ['2 oy'], ['2026 yil'], ['2026 yilda'], ['2026 год'], ['5 hafta'], ['10 kishi'], ['5 nafar'], ['2 marta'], ['3 раза'], ['12 gektar'], ['100 м'], ['5 km'],
    // Percent
    ['12%'], ['12 %'], ['12 foiz'], ['15 foizga'], ['12 процентов'], ['5 percent'],
    // Phones and accounts
    ['90 123 45 67'], ['+998 90 123 45 67'], ['+998901234567'], ['998901234567'], ['(90) 123 45 67'], ['90-123-45-67'], ['901234567'], ['telefoni 90 123 45 67'], ['8600 1234 5678 9012'], ['hisob 20208000900123456001'],
    // Dates and years
    ['5 noyabr'], ['2 noyabr kuni'], ['5-noyabr'], ['5-noyabrda'], ['5 noyabrda'], ['2 ноября'], ['5 мая'], ['12 мая 2026'], ['noyabr 5'], ['Nov 2'], ['2 Nov'], ['12/05'], ['12.05.2026'], ['12.05.26'], ['12.05.2026y'],
    ['12 05 2026'], ['2026.05.12'], ['2026-11-04'], ['20261104'], ['02.11'], ['2026-11-04T18:59:00Z'], ['14:30'],
    // Documents and ids
    ['faktura 45678'], ['schet 123456'], ['invoice 123456'], ['счёт 123456'], ['#45678'], ['# 45678'], ['№45678'], ['№ 45678'], ['INN 301234567'], ['STIR 301234567'], ['ИНН 301234567'], ['tel 123456'], ['тел. 123456'],
    ['faktura №45678'], ['faktura: 45678'], ['schet-faktura 45678'], ['nomer 45678'], ['номер 45678'],
    // Names and ordinals
    ['MTZ-82'], ['MTZ 82'], ['МТЗ 82'], ['mtz 82'], ['MTZ82'], ['T-28'], ['Kamaz 5511'], ['Dala 3'], ['Dala 12'], ['Pivot 5'], ['3 sonli dala'], ['3 dala'], ['3-dala'], ['12-dala'], ['1-dalaga'], ['3chi'], ['3-chi'], ['5inchi'],
    ['5-го'], ['3-й'], ['1st'], ['2nd'], ['3rd'], ['4th'], ['Dizel Euro-5'],
    // Words
    ['ming rahmat'], ['ming marta aytdim'], ['bir kishi'], ['uch kun'], ['ikki oy'], ['bir narsa'], ['он заплатил'],
  ])('%s', (text) => {
    expect(read(text)).toEqual([]);
  });

  it('a number next to a document word is still money when it says so', () => {
    expect(read('schet 3 mln')).toEqual([{ amount: 3_000_000, currency: null }]);
    expect(read("faktura 45678 bo'yicha 3 mln")).toEqual([{ amount: 3_000_000, currency: null }]);
    expect(read('Elektr cheki, 3 mln naqd')).toEqual([{ amount: 3_000_000, currency: null }]);
    expect(read('Elektr cheki 500000 naqd')).toEqual([{ amount: 500_000, currency: null }]);
  });

  it('a date-shaped number is money when a scale or a currency says so', () => {
    expect(read('12.05 mln')).toEqual([{ amount: 12_050_000, currency: null }]);
    expect(read('$12.05')).toEqual([{ amount: 12.05, currency: 'USD' }]);
    expect(read('12.05 dollar')).toEqual([{ amount: 12.05, currency: 'USD' }]);
  });

  it('a noun is not a scale because it starts like one', () => {
    expect(read('3 лимонада')).toEqual([{ amount: 3, currency: null }]);
    expect(parseMoneyMentions('3 лимонада')[0].bare).toBe(true);
  });

  it('the Russian "he" is not the Uzbek ten', () => {
    expect(read('он миллион заплатил')).toEqual([{ amount: 1_000_000, currency: null }]);
    expect(read("on ming so'm")).toEqual([{ amount: 10_000, currency: 'UZS' }]);
  });
});

describe('a price per unit is not a total', () => {
  it.each<[string, number, string]>([
    ['tonnasi 2 mln', 2_000_000, 't'], ['tonnasiga 2 mln', 2_000_000, 't'], ['litri 15 ming', 15_000, 'l'], ['litriga 15 ming', 15_000, 'l'], ['kilosi 3 ming', 3_000, 'kg'], ['kilosiga 3 ming', 3_000, 'kg'],
    ['kilosi 3000', 3_000, 'kg'], ['boshiga 2 mln', 2_000_000, 'head'], ['donasi 5 ming', 5_000, 'pcs'], ['flakoni 45 ming', 45_000, 'vial'], ['dozasi 8 ming', 8_000, 'dose'], ['qopi 40 ming', 40_000, 'bag'],
    ['har litri 15 ming', 15_000, 'l'], ['har bir qop 40 ming', 40_000, 'bag'], ['har bir litr uchun 15 ming', 15_000, 'l'], ['1 kg uchun 3 ming', 3_000, 'kg'], ['bir kilo uchun 3 ming', 3_000, 'kg'], ['litr 15 ming', 15_000, 'l'],
    ['har biri 5 ming', 5_000, 'unit'], ['bittasi 5 ming', 5_000, 'unit'], ["qo'yiga 2 mln", 2_000_000, 'unit'], ['15 mingdan', 15_000, 'unit'], ['15 ming dan', 15_000, 'unit'], ['2 mln dan', 2_000_000, 'unit'], ["14 750 so'mdan", 14_750, 'unit'], ['300 dollardan', 300, 'unit'],
    ['3 000 000-dan', 3_000_000, 'unit'], ['2 mln boshiga', 2_000_000, 'head'], ['15 ming litriga', 15_000, 'l'], ['3 ming kilosiga', 3_000, 'kg'], ['gektariga 500 ming', 500_000, 'unit'], ['soatiga 100 ming', 100_000, 'unit'],
    ['по 15 тысяч', 15_000, 'unit'], ['по 15000', 15_000, 'unit'], ['по $5', 5, 'unit'], ['за литр 15 тысяч', 15_000, 'l'], ['за тонну 2 млн', 2_000_000, 't'], ['за кг 3 тысячи', 3_000, 'kg'], ['за килограмм 3 тысячи', 3_000, 'kg'],
    ['за 1 кг 3 тысячи', 3_000, 'kg'], ['за голову 2 млн', 2_000_000, 'head'], ['за штуку 5 тысяч', 5_000, 'pcs'], ['за мешок 40 тысяч', 40_000, 'bag'], ['15 тысяч за литр', 15_000, 'l'], ['2 млн за тонну', 2_000_000, 't'],
    ['2 млн за голову', 2_000_000, 'head'], ['литр 15 тысяч', 15_000, 'l'], ['тонна 2 млн', 2_000_000, 't'], ['на голову 2 млн', 2_000_000, 'head'], ['2 млн в месяц', 2_000_000, 'unit'],
    ['15 thousand per litre', 15_000, 'l'], ['15 thousand a litre', 15_000, 'l'], ['2 million per tonne', 2_000_000, 't'], ['$5 each', 5, 'unit'], ['each 5 thousand', 5_000, 'unit'], ['per kg 3 thousand', 3_000, 'kg'],
    ['at 15 thousand', 15_000, 'unit'], ['3000/kg', 3_000, 'kg'], ['15 ming/l', 15_000, 'l'], ["3000 so'm/kg", 3_000, 'kg'], ['1.2 dollar', 1.2, ''],
  ])('%s', (text, amount, perUnit) => {
    expect(only(text)).toMatchObject({ amount, perUnit: perUnit === '' ? null : perUnit });
  });

  it.each<[string, number]>([
    ['2 tonna arpa 4 mln naqd', 4_000_000], ['100 kg arpa 1,5 mln naqd', 1_500_000], ['Kepak 1 tonna 3 mln qarzga', 3_000_000], ['50 qop kepak 2 mln', 2_000_000], ['Купил ячмень 2 тонны за 6 млн наличными', 6_000_000],
    ['200 литров дизеля 3 млн', 3_000_000], ['6 млн за 2 тонны', 6_000_000], ['uch yuz litr dizel 4 mln', 4_000_000], ['uch yuz litr 4 mln', 4_000_000], ['2 ming litr 30 mln', 30_000_000], ['ikki yarim tonna 5 mln', 5_000_000],
    ['Traktor narxi 500 mln', 500_000_000], ["Jami 3 mln to'ladim", 3_000_000],
  ])('a stated quantity does not turn the total into a price: %s', (text, amount) => {
    expect(only(text)).toMatchObject({ amount, perUnit: null });
  });

  it('keeps the price and the total of one purchase apart', () => {
    const mentions = parseMoneyMentions('200 l dizel, litri 20 ming, jami 3 mln, naqd, Neft Bazadan');
    expect(mentions.map((m) => [m.amount, m.perUnit])).toEqual([[20_000, 'l'], [3_000_000, null]]);
  });

  it('a price word needs a stated quantity to be a price per unit', () => {
    expect(only('dizel narxi 15 ming, 200 litr').perUnit).toBe('unit');
    expect(only('цена 15 тысяч, 300 литров').perUnit).toBe('unit');
    expect(only('Traktor narxi 500 mln').perUnit).toBeNull();
  });
});

describe('figures the person took back', () => {
  it.each<[string, number[], number[]]>([
    ['3 mln emas, 4 mln', [3_000_000], [4_000_000]], ['3 mln emas 4 mln', [3_000_000], [4_000_000]], ["3 mln so'm emas, 4 mln", [3_000_000], [4_000_000]], ["yo'q, 4 emas 5", [4], [5]],
    ['не 3, а 4', [3], [4]], ['не 3 млн, а 4 млн', [3_000_000], [4_000_000]], ['не 3 млн а 4 млн', [3_000_000], [4_000_000]], ['4 млн, а не 3 млн', [3_000_000], [4_000_000]],
    ['not 3 but 4', [3], [4]], ['not 3 million but 4 million', [3_000_000], [4_000_000]], ['4 million, not 3 million', [3_000_000], [4_000_000]],
    ["3 mln, yo'q 2 mln", [3_000_000], [2_000_000]], ["3 mln yo'q 2 mln", [3_000_000], [2_000_000]], ['3 млн, нет 2 млн', [3_000_000], [2_000_000]], ['3 млн, вернее 2 млн', [3_000_000], [2_000_000]],
    ["3 mln, aniqrog'i 2 mln", [3_000_000], [2_000_000]], ['3 mln, adashdim, 2 mln', [3_000_000], [2_000_000]], ['3 million, sorry, 2 million', [3_000_000], [2_000_000]], ['3 mln aslida 4 mln', [3_000_000], [4_000_000]],
  ])('%s', (text, taken, kept) => {
    const mentions = parseMoneyMentions(text);
    expect(mentions.filter((m) => m.negated).map((m) => m.amount)).toEqual(taken);
    expect(mentions.filter((m) => !m.negated).map((m) => m.amount)).toEqual(kept);
  });

  it('a negative word somewhere else takes nothing back', () => {
    expect(only("3 mln ko'p emas").negated).toBe(false);
    expect(only("3 mln ko'p emasmi").negated).toBe(false);
    expect(only('3 mln bankdan emas').negated).toBe(false);
  });
});

describe('figures that are not one stated amount', () => {
  it.each<[string, number[]]>([
    ['3-4 mln', [3_000_000, 4_000_000]], ['3–4 mln', [3_000_000, 4_000_000]], ['3 - 4 mln', [3_000_000, 4_000_000]], ['2,5-3 mln', [2_500_000, 3_000_000]], ['2-3 ming', [2_000, 3_000]], ['3 yoki 4 mln', [3_000_000, 4_000_000]],
    ['3 или 4 млн', [3_000_000, 4_000_000]], ['3 либо 4 млн', [3_000_000, 4_000_000]], ['3 or 4 million', [3_000_000, 4_000_000]], ['3 mln yoki 3,5 mln', [3_000_000, 3_500_000]], ['3 млн или 3,5 млн', [3_000_000, 3_500_000]],
    ["uch-to'rt million", [3_000_000, 4_000_000]], ["uch to'rt million", [3_000_000, 4_000_000]], ['два-три миллиона', [2_000_000, 3_000_000]], ['два три миллиона', [2_000_000, 3_000_000]], ['от 3 до 4 млн', [3_000_000, 4_000_000]],
    ['3 dan 4 mln gacha', [3_000_000, 4_000_000]], ['between 3 and 4 million', [3_000_000, 4_000_000]], ['между 3 и 4 млн', [3_000_000, 4_000_000]],
  ])('a range or a choice: %s', (text, amounts) => {
    const mentions = parseMoneyMentions(text);
    expect(mentions.map((m) => m.amount)).toEqual(amounts);
    expect(mentions.every((m) => m.uncertain)).toBe(true);
    expect(mentions.some((m) => m.perUnit)).toBe(false);
  });

  it.each([
    ['taxminan 3 mln'], ['qariyb 3 mln'], ['salkam 3 mln'], ['deyarli 3 mln'], ['3 mln atrofida'], ['3 mln chamasi'], ['3 mln ga yaqin'], ['500 mingcha'], ["3 mln dan ko'p"], ['3 mln dan kam'], ['3 mln dan ortiq'], ['3 mln gacha'],
    ['3 mln+'], ['bir necha million'], ['около 3 млн'], ['примерно 3 млн'], ['приблизительно 3 млн'], ['почти 3 млн'], ['где-то 3 млн'], ['до 3 млн'], ['больше 3 млн'], ['3 млн с лишним'], ['~3 mln'], ['≈3 mln'],
    ['3 mln shekilli'], ['3 mln chog\'i'], ['balki 3 mln'], ['3 млн наверное'], ['возможно 3 млн'], ['maybe 3 million'], ['probably 3 million'], ['about 3 million'], ['around 3 million'], ['roughly 3 million'], ['almost 3 million'], ['nearly 3 million'], ['more than 3 million'], ['less than 3 million'], ['over 3 million'], ['3 million or so'],
  ])('approximate: %s', (text) => {
    expect(parseMoneyMentions(text)[0].uncertain).toBe(true);
  });

  it.each([['Elektrga minus 500 ming naqd'], ['Elektrga -500 ming naqd'], ['Elektrga − 500 ming naqd'], ['минус 500 тысяч'], ['-500 ming']])('a minus sign the person wrote: %s', (text) => {
    expect(only(text)).toMatchObject({ amount: 500_000, uncertain: true });
  });

  it.each([['Elektr - 3 mln'], ['Elektr-3 mln'], ['- 3 mln elektr']])('a dash in a list is not a minus: %s', (text) => {
    expect(only(text).uncertain).toBe(false);
  });

  it.each([['3 mln 500'], ['Gazga 3 mln 500 bankdan']])('digits after the millions may be the rest of the amount or another one: %s', (text) => {
    expect(parseMoneyMentions(text).map((m) => m.uncertain)).toEqual([true, true]);
  });

  it('a spoken remainder that does not fit is not dropped silently', () => {
    expect(parseMoneyMentions('два миллиона пятьдесят').map((m) => [m.amount, m.uncertain])).toEqual([[2_000_000, true]]);
  });
});

describe('an exchange rate is never an amount', () => {
  it.each<[string, number]>([
    ['kurs 12 700', 12_700], ['kurs 12700', 12_700], ['курс 12700', 12_700], ['rate 12,700.55', 12_700.55], ['kurs 12,7 ming', 12_700], ['kursi 12 650,55', 12_650.55], ['курс 12.650,55', 12_650.55],
    ['dollar kursi 12 700', 12_700], ['курс доллара 12 700', 12_700], ['по курсу 12 700', 12_700], ["kurs bo'yicha 12 700", 12_700], ['kurs: 12700', 12_700], ['kurs = 12700', 12_700], ['12 700 kursda', 12_700],
    ['12700 kurs bilan', 12_700], ['курс 12,7 тысяч', 12_700], ['the rate was 12 700', 12_700], ['курс двенадцать тысяч семьсот', 12_700], ["kurs o'n ikki ming yetti yuz", 12_700],
  ])('%s', (text, rate) => {
    expect(only(text)).toMatchObject({ amount: rate, rate: true });
  });

  it('leaves the amount beside it alone', () => {
    const mentions = parseMoneyMentions('Elektrga 200 dollar naqd, kurs 12 700');
    expect(mentions.map((m) => [m.amount, m.currency, m.rate])).toEqual([[200, 'USD', false], [12_700, null, true]]);
    expect(parseMoneyMentions('200 dollar kurs bilan 12700').map((m) => [m.amount, m.rate])).toEqual([[200, false], [12_700, true]]);
    expect(parseMoneyMentions('200 kurs 12700').map((m) => [m.amount, m.rate])).toEqual([[200, false], [12_700, true]]);
    expect(only("200 dollar kurs bo'yicha naqd")).toMatchObject({ amount: 200, currency: 'USD', rate: false });
    expect(only("12 700 so'm kursda")).toMatchObject({ amount: 12_700, rate: true });
  });
});

describe('several amounts', () => {
  it('two records joined by "va" are two mentions, and one sum stays one', () => {
    expect(amounts('Gazga 3 mln va 200 ming tushlikka, naqd')).toEqual([3_000_000, 200_000]);
    expect(amounts('На газ 3 млн и 200 тысяч на обед')).toEqual([3_000_000, 200_000]);
    expect(amounts('3 million and 200 thousand for lunch')).toEqual([3_000_000, 200_000]);
    expect(amounts("3 mln va 200 ming tushlik uchun")).toEqual([3_000_000, 200_000]);
    expect(amounts("Elektrga 3 mln va 200 ming to'ladim")).toEqual([3_200_000]);
  });

  it('a new line is a new amount', () => {
    expect(amounts("Yoqilg'iga 3 mln\n500 ming tushlikka")).toEqual([3_000_000, 500_000]);
    expect(amounts('3 mln\n500')).toEqual([3_000_000, 500]);
    expect(amounts('gaz 300 ming\nsvet 700 ming\ntelefon 50 ming')).toEqual([300_000, 700_000, 50_000]);
  });

  it('separate scales in a row stay separate', () => {
    expect(amounts('400 ming 250 ming')).toEqual([400_000, 250_000]);
    expect(amounts('3 mln 2 mln')).toEqual([3_000_000, 2_000_000]);
    expect(amounts("Elektrga 3 mln, gazga 500 ming, ikkalasi naqd")).toEqual([3_000_000, 500_000]);
  });

  it('a quantity after the amount is not part of it', () => {
    expect(amounts('5 ming 3 ta')).toEqual([5_000]);
    expect(amounts('500 mingdan 4 ta')).toEqual([500_000]);
    expect(amounts('5 ming 2 noyabr')).toEqual([5_000]);
    expect(amounts('5 ming 12%')).toEqual([5_000]);
  });
});

describe('voice notes and typed slang', () => {
  it.each<[string, number[]]>([
    ['ertalab bozorga bordim kepak oldim yuz qop ikki million uch yuz ming berdim naqd', [2_300_000]],
    ["kecha kechqurun traktorga dizel quydik uch yuz litr to'rt yarim million bankdan", [4_500_000]],
    ['вчера вечером заехал на заправку взял двести литров солярки заплатил три миллиона наличкой', [3_000_000]],
    ['so today i went to the feed store and bought two tons of bran for six million in cash', [6_000_000]],
    ['Вчера свет учун полтора лимона нал бердим', [1_500_000]],
    ['svetga 1.5mln naqt berdim', [1_500_000]],
    ['gazga 400min', []],
    ['5лям налом', [5_000_000]],
    ['за свет 2 ляма нал', [2_000_000]],
    ['tushlikka 320 000 kasadan', [320_000]],
    ['3mln kartadan', [3_000_000]],
    ['$500 kartadan', [500]],
    ['2 yarim million xisobdan toladim', [2_500_000]],
    ['bir million besh yuz ming naqt', [1_500_000]],
  ])('%s', (text, expected) => {
    expect(amounts(text)).toEqual(expected);
  });
});

describe('every mention points at the text it came from', () => {
  it.each([
    ["Yoqilg'iga 3 mln naqd, 500 ming tushlik"], ['Elektrga 200 dollar naqd, kurs 12 650,55'], ['  3 000 000  so\'m'], ['3 mln\n500 ming'], ['telefoni 90 123 45 67, 5 ming'], ['12.05.2026 kuni 1,5 млн. долларов'],
    ['\u{1F600} 3 mln \u{1F600} 500 ming'], ['Qoʻzilar 3 mln'], ['Bugun 400 ming tushlik naqd, kecha ham 400 ming tushlik naqd'],
  ])('%s', (text) => {
    const mentions = parseMoneyMentions(text);
    expect(mentions.length).toBeGreaterThan(0);
    for (const mention of mentions) expect(text.slice(mention.start, mention.end)).toBe(mention.raw);
  });

  it('gives the offsets of the amount, past dates and phones', () => {
    const text = '12.05.2026 tel 90 123 45 67 uchun 5 ming';
    expect(parseMoneyMentions(text)).toMatchObject([{ raw: '5 ming', start: 34, end: 40 }]);
  });

  it('survives anything thrown at it', () => {
    const parts = ['3', 'mln', 'ming', ',', '.', '-', '$', '%', 'yoki', 'emas', 'не', '\n', "o'", 'kurs', '№', '+998', '12.05', 'tonna', 'dan', 'yarim', '1 000', '/', 'ta', 'a', 'и', '́'];
    let seed = 7;
    const next = (limit: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % limit;
    };
    for (let round = 0; round < 2_000; round += 1) {
      const text = Array.from({ length: next(12) }, () => parts[next(parts.length)]).join(next(2) ? ' ' : '');
      for (const mention of parseMoneyMentions(text)) {
        expect(Number.isFinite(mention.amount), text).toBe(true);
        expect(text.slice(mention.start, mention.end), text).toBe(mention.raw);
      }
    }
  });
});

describe('findMention, hardened', () => {
  const newestFirst = (...texts: string[]) => [...texts].reverse().flatMap((text) => parseMoneyMentions(text));

  it('is exact to the tiyin', () => {
    expect(findMention(parseMoneyMentions('$100.40'), 100)).toBeNull();
    expect(findMention(parseMoneyMentions('$100.40'), 100.4)?.raw).toBe('100.40');
    expect(findMention(parseMoneyMentions('$12.75'), 13)).toBeNull();
    expect(findMention(parseMoneyMentions('4 999 999,99'), 5_000_000)).toBeNull();
    expect(findMention(parseMoneyMentions('3 mln'), 3_000_000.4)).toBeNull();
    expect(findMention(parseMoneyMentions('3 mln'), 3_000_000.001)?.raw).toBe('3 mln');
  });

  it('never matches a figure taken back, uncertain, or a rate', () => {
    expect(findMention(parseMoneyMentions('3 mln emas, 4 mln'), 3_000_000)).toBeNull();
    expect(findMention(parseMoneyMentions('3 mln emas, 4 mln'), 4_000_000)?.raw).toBe('4 mln');
    expect(findMention(parseMoneyMentions('3-4 mln'), 4_000_000)).toBeNull();
    expect(findMention(parseMoneyMentions('3 yoki 4 mln'), 3_000_000)).toBeNull();
    expect(findMention(parseMoneyMentions('kurs 12 700'), 12_700)).toBeNull();
    expect(findMention(parseMoneyMentions('Elektrga minus 500 ming'), 500_000)).toBeNull();
  });

  it('a price per unit answers only a question about the price, and a total only about the total', () => {
    const mentions = parseMoneyMentions('200 l dizel, litri 20 ming, jami 3 mln');
    expect(findMention(mentions, 20_000)).toBeNull();
    expect(findMention(mentions, 20_000, { perUnit: true })?.perUnit).toBe('l');
    expect(findMention(mentions, 3_000_000)?.raw).toBe('3 mln');
    expect(findMention(mentions, 3_000_000, { perUnit: true })).toBeNull();
  });

  it('takes the newest statement when mentions come newest first', () => {
    expect(findMention(newestFirst('Elektrga 500 berdim naqd', "500 so'm"), 500)).toMatchObject({ bare: false, currency: 'UZS' });
    expect(findMention(newestFirst('200', '200 dollar'), 200)).toMatchObject({ currency: 'USD' });
    expect(findMention(newestFirst("Tushlikka 5000 naqd to'ladim", "5000 so'm"), 5_000)).toMatchObject({ currency: 'UZS' });
    expect(findMention(newestFirst('Elektrga 300 dollar naqd', 'Tushlikka 300 naqd'), 300)).toMatchObject({ bare: true, currency: null });
  });

  it('with two currencies on one number, the one asked for wins', () => {
    const text = "Bank komissiyasi 100 ming so'm, traktor uchun 100 ming dollar, ikkalasi bankdan";
    expect(findMention(parseMoneyMentions(text), 100_000, { currency: 'USD' })?.currency).toBe('USD');
    expect(findMention(parseMoneyMentions(text), 100_000, { currency: 'uzs' })?.currency).toBe('UZS');
    expect(findMention(newestFirst("Elektrga 500 ming so'm naqd", "yo'q, 500 ming dollar"), 500_000, { currency: 'USD' })?.currency).toBe('USD');
  });

  it('prefers a mention that names no currency over one that names another', () => {
    expect(findMention(parseMoneyMentions('100 ming dollar, 100 ming'), 100_000, { currency: 'UZS' })?.currency).toBeNull();
  });
});

// ─── Second hardening: each block is a defect an independent review proved, with its whole class ─────────

const uzbek = (text: string, check: (form: string) => void) => {
  for (const form of uzbekSpellings(text)) check(form);
};
const usable = (text: string) => parseMoneyMentions(text).filter((m) => !m.negated && !m.uncertain && !m.rate && !m.perUnit).map((m) => m.amount);
const accepts = (text: string, amount: number, currency?: string) => {
  const found = findMention(parseMoneyMentions(text), amount, { currency });
  expect(found?.amount, text).toBe(amount);
  if (currency) expect(found?.currency, text).toBe(currency);
};
const refuses = (text: string, amount: number) => expect(findMention(parseMoneyMentions(text), amount), text).toBeNull();

describe('a sign or a code belongs to its own number', () => {
  it.each<[string, number, string]>([
    ["200$ 300 ming so'm", 300_000, 'UZS'], ["200$ 3 mln so'm", 3_000_000, 'UZS'], ["100€ 200 ming so'm", 200_000, 'UZS'], ["500₽ 3 mln so'm", 3_000_000, 'UZS'], ["200 usd 300 ming so'm", 300_000, 'UZS'],
    ["5k$ 300 ming so'm", 300_000, 'UZS'], ['5 ming uzs 200 dollar', 200, 'USD'], ['200$ 300 минг сўм', 300_000, 'UZS'], ['200 usd 300 тысяч сум', 300_000, 'UZS'], ["300 ming so'm 200$", 200, 'USD'],
  ])('%s', (text, amount, currency) => accepts(text, amount, currency));

  it.each([['200$ 300 ming naqd'], ['200$ 5 mln'], ['Zapchast 200$ 300 ming ustaga'], ['200$, 300 ming'], ['200$. 300 ming'], ['200$\n300 ming'], ['200 dollar 300 ming'], ['200 долларов 300 тысяч'], ['200 у.е. 300 тысяч'], ['200 бакс 300 тысяч'], ['5к$ 300 тысяч']])(
    'the number after it names no currency: %s',
    (text) => {
      expect(parseMoneyMentions(text).map((m) => m.currency)[1]).toBeNull();
    },
  );

  it.each<[string, [number, string | null][]]>([
    ['300 ming $200', [[300_000, null], [200, 'USD']]], ['300 ming €200 naqd', [[300_000, null], [200, 'EUR']]], ['$200 $300', [[200, 'USD'], [300, 'USD']]],
    ['$200 300 ming', [[200, 'USD'], [300_000, null]]], ['USD 200 300 ming', [[200, 'USD'], [300_000, null]]], ['€100 200 тысяч наличными', [[100, 'EUR'], [200_000, null]]], ['EUR 5 300 ming', [[5, 'EUR'], [300_000, null]]],
  ])('a sign written on the next number stays with it, and digits do not join across it: %s', (text, expected) => {
    expect(parseMoneyMentions(text).map((m) => [m.amount, m.currency])).toEqual(expected);
  });

  it('digits spaced by thousands still join when no sign splits them', () => {
    expect(read('UZS 3 200 ming')).toEqual([{ amount: 3_200_000, currency: 'UZS' }]);
    expect(read('$1 200')).toEqual([{ amount: 1_200, currency: 'USD' }]);
    expect(read('1 500 ming')).toEqual([{ amount: 1_500_000, currency: null }]);
  });
});

describe('the number of a machine or a field is not part of the amount', () => {
  it.each<[string, number, number]>([
    ["MTZ-82 300 ming ta'mirga naqd", 300_000, 82_300_000], ['MTZ 80 200 ming', 200_000, 80_200_000], ['TTZ-80 150 ming', 150_000, 80_150_000], ['МТЗ-82 300 тысяч за ремонт', 300_000, 82_300_000], ['Dala-3 200 ming', 200_000, 3_200_000],
    ['mtz 82 300 ming', 300_000, 82_300_000], ['mtz82 300 ming', 300_000, 82_300_000], ['МТЗ 82 300 тысяч', 300_000, 82_300_000], ['T-28 200 ming', 200_000, 28_200_000], ['K-700 300 ming', 300_000, 700_300_000],
    ['GAZ-53 300 ming', 300_000, 53_300_000], ['ЗИЛ-130 300 тысяч', 300_000, 130_300_000], ['ЗИЛ 130 300 тысяч', 300_000, 130_300_000], ['Pivot 2 300 ming', 300_000, 2_300_000], ['MTZ-82 300 000', 300_000, 82_300_000],
  ])('%s', (text, amount, wrong) => {
    refuses(text, wrong);
    accepts(text, amount);
  });

  it('a word that names nothing leaves the digits whole', () => {
    expect(amounts('Elektr-3 200 ming')).toEqual([3_200_000]);
    expect(amounts('Dalaga 3 200 ming')).toEqual([3_200_000]);
    expect(amounts('GAZ - 3 200 ming')).toEqual([3_200_000]);
  });
});

describe('a price per unit in the words people use', () => {
  it.each<[string, number, string]>([
    ['bir tonnasi 2 mln', 2_000_000, 't'], ['1 tonnasi 2 mln', 2_000_000, 't'], ['bir litri 15 ming', 15_000, 'l'], ['1 litri 15 ming', 15_000, 'l'], ['bir kilosi 3 ming', 3_000, 'kg'], ['1 kilosi 3000', 3_000, 'kg'],
    ['bir qopi 40 ming', 40_000, 'bag'], ['bir donasi 40 ming', 40_000, 'pcs'], ['bir boshi 2 mln', 2_000_000, 'head'], ['bir boshiga 2 mln', 2_000_000, 'head'], ['bir tonnasi ikki million', 2_000_000, 't'],
    ['2 mln tonnasi', 2_000_000, 't'], ['2 mln boshi', 2_000_000, 'head'], ['2 mln donasi', 2_000_000, 'pcs'], ['2 mln dona', 2_000_000, 'pcs'], ['15 ming litri', 15_000, 'l'], ['har tonna 2 mln', 2_000_000, 't'],
    ['2 mln har biri', 2_000_000, 'unit'], ['2 mln bittasi', 2_000_000, 'unit'], ["har bir qo'y 2 mln", 2_000_000, 'unit'], ["15 ming so'm litr", 15_000, 'l'], ["50 ming so'm qop", 50_000, 'bag'], ["15 ming so'm litri", 15_000, 'l'],
  ])('%s', (text, amount, unit) => {
    // A Russian keyboard writes "qop" as "коп", which cannot be told from "ko'p" (many).
    uzbek(text, (form) => {
      if (!/коп/.test(form)) expect(only(form), form).toMatchObject({ amount, perUnit: unit });
    });
  });

  it.each<[string, number, string]>([
    ['2 млн тонна', 2_000_000, 't'], ['2 млн голова', 2_000_000, 'head'], ['2 млн штука', 2_000_000, 'pcs'], ['10 овец 2 млн каждая', 2_000_000, 'unit'], ['каждая 2 млн', 2_000_000, 'unit'], ['каждая овца 2 млн', 2_000_000, 'unit'],
    ['литр стоит 15 тысяч', 15_000, 'l'], ['литр обошелся в 15 тысяч', 15_000, 'l'], ['тонна обошлась в 2 млн', 2_000_000, 't'], ['цена за тонну 2 млн', 2_000_000, 't'], ['200 тысяч на гектар', 200_000, 'unit'], ['200 тысяч за гектар', 200_000, 'unit'],
    ['на гектар 200 тысяч', 200_000, 'unit'], ['200 тысяч с гектара', 200_000, 'unit'], ['200 thousand per hectare', 200_000, 'unit'], ['a ton costs 2 million', 2_000_000, 't'], ['each sheep 2 million', 2_000_000, 'unit'], ['every sheep 2 million', 2_000_000, 'unit'],
    ['each one 2 million', 2_000_000, 'unit'],
  ])('%s', (text, amount, unit) => {
    expect(parseMoneyMentions(text).at(-1)).toMatchObject({ amount, perUnit: unit });
  });

  it.each<[string, number, string]>([
    ['500 kg 1 kg 3 ming', 3_000, 'kg'], ['500 kg 1 kg = 3 ming', 3_000, 'kg'], ['500 kg 1 kg - 3 ming', 3_000, 'kg'], ['500 кг 1 кг 3 тысячи', 3_000, 'kg'], ['300 литров 1 литр 15 тысяч', 15_000, 'l'], ['300 литров дизеля один литр 15 тысяч', 15_000, 'l'],
    ['4 тонны ячменя одна тонна 2 млн', 2_000_000, 't'], ['300 литров литр стоит 15 тысяч', 15_000, 'l'], ['300 litr litri turadi 15 ming', 15_000, 'l'], ['10 qop kepak oldim bir qop kepak 40 ming', 40_000, 'bag'], ['4 тонны ячменя одна тонна ячменя 2 млн', 2_000_000, 't'],
  ])('one unit beside the quantity is a price: %s', (text, amount, unit) => {
    expect(only(text)).toMatchObject({ amount, perUnit: unit });
  });

  it.each<[string, number]>([
    ['Kepak 1 tonna 3 mln qarzga', 3_000_000], ['bir tonna 3 mln', 3_000_000], ['1 литр 15 тысяч', 15_000], ['одна тонна 2 млн', 2_000_000], ['5 кг 3 тысячи', 3_000], ['300 litr 15 ming', 15_000], ['4 tonna arpa 8 mln', 8_000_000],
  ])('one quantity with one amount stays a total: %s', (text, amount) => {
    expect(only(text)).toMatchObject({ amount, perUnit: null });
  });

  it.each<[string, number]>([
    ['oy boshi 500 ming', 500_000], ['hafta boshi 300 ming', 300_000], ['500 ming bosh agronomga', 500_000], ['300 ming bosh hisobchiga', 300_000], ["3 mln to'y uchun", 3_000_000], ['3 млн г. Бухара', 3_000_000],
  ])('a word that only looks like a unit: %s', (text, amount) => {
    expect(only(text)).toMatchObject({ amount, perUnit: null });
  });
});

describe('real money after a word that looks like an id or a count', () => {
  it.each<[string, number]>([
    ["schetdan 1500000 o'tkazdim", 1_500_000], ["hisob raqamidan 1500000 o'tkazdim", 1_500_000], ['со счета 1500000 за свет', 1_500_000], ['со счёта 3000000 перевёл', 3_000_000], ['на счёт 1500000', 1_500_000], ['в счёт 3000000', 3_000_000],
    ["Telefonga 30000 to'ladim", 30_000], ['Nomerga 50000 tashladim', 50_000], ['500 ming oylik', 500_000], ["Internetga 500 ming oylik to'lov naqd", 500_000], ["Sug'urtaga 600 ming yillik to'lov naqd", 600_000], ['500 ming dalaga ketdi', 500_000],
    ['300 ming dalada ishlatdik', 300_000], ['200 ming dala ishchilariga', 200_000], ['500 000 dalaga', 500_000], ['600 000 yillik', 600_000], ["200 ming bog'ga sarfladik", 200_000], ['2 yuz 50 ming', 250_000], ['чек на 45678', 45_678], ['hisob 3000000', 3_000_000],
    ['Kamaz 300000', 300_000], ['Kamazga 300000', 300_000],
  ])('%s', (text, amount) => {
    accepts(text, amount);
  });

  it.each([['10 ming km'], ['2 ming gektar'], ['5 ming kishi'], ['3 тысячи метров'], ['20000 km'], ['15000 kishi'], ['2 ming marta']])('what really comes in thousands is still a count: %s', (text) => {
    expect(read(text)).toEqual([]);
  });
});

describe('numbers that are not money, in more forms', () => {
  it.each([
    ["Elektrga naqd to'ladim, chek 45678"], ["Elektrga naqd to'ladim, kvitansiya 123456"], ['квитанция 123456'], ['чек 45678'], ['акт 45678'], ['akt 45678'], ['заказ 123456'], ['buyurtma 123456'], ['order 123456'], ['id 123456'], ['код 123456'], ['kod 123456'], ['sms kod 654321'],
    ['tranzaksiya 123456'], ['транзакция 123456'], ['договор 123456'], ['по договору 123456'], ['по чеку 45678'], ['dogovor 123456'], ['tel 90 1234567'], ['90 1234567'], ['(90)1234567'], ['90 123 4567'], ['+7 916 123 45 67'], ['8 916 123 45 67'], ['+7 (916) 123-45-67'], ['8(916)1234567'],
    ["Kamaz 65115 ta'miri"], ['AA 1234567'], ['пробег 123456'], ['probeg 123456'], ['счёт 1500000'],
  ])('%s', (text) => {
    expect(read(text)).toEqual([]);
  });

  it('a large round figure is not a phone', () => {
    expect(amounts('80000000000')).toEqual([80_000_000_000]);
  });

  it('metres are not millions', () => {
    expect(amounts('100м трубы 3 млн')).toEqual([3_000_000]);
    expect(amounts('5м')).toEqual([]);
  });
});

describe('half after the scale word', () => {
  it.each<[string, number, number]>([
    ['миллион с половиной наличными', 1_500_000, 1_000_000], ['два миллиона с половиной наличными', 2_500_000, 2_000_000], ['2 млн с половиной наличными', 2_500_000, 2_000_000], ['три тысячи с половиной', 3_500, 3_000], ['a million and a half cash', 1_500_000, 1_000_000],
    ['two million and a half cash', 2_500_000, 2_000_000], ['million and half', 1_500_000, 1_000_000], ['ikki million va yarim', 2_500_000, 2_000_000],
  ])('%s', (text, amount, wrong) => {
    refuses(text, wrong);
    accepts(text, amount);
  });

  it('a half of something else stays apart', () => {
    expect(amounts('3 mln va yarim million')).toEqual([3_000_000, 500_000]);
    expect(amounts('3 mln yarim tonna')).toEqual([3_000_000]);
  });
});

describe('a spoken number stops at the unit of the quantity after it', () => {
  it.each<[string, number]>([
    ['ikki million uch yuz litr dizel oldim naqd', 2_000_000], ['bir million besh yuz kilo arpa naqd', 1_000_000],
  ])('%s', (text, amount) => {
    uzbek(text, (form) => expect(amounts(form), form).toEqual([amount]));
  });

  it.each<[string, number]>([
    ['два миллиона триста литров дизеля наличными', 2_000_000], ['миллион двести килограмм ячменя наличными', 1_000_000], ['two million three hundred liters of diesel cash', 2_000_000], ['три миллиона сто мешков', 3_000_000],
  ])('%s', (text, amount) => {
    expect(amounts(text)).toEqual([amount]);
  });

  it('the word "ming" dropped in speech still counts when no unit follows', () => {
    expect(amounts('ikki million uch yuz')).toEqual([2_300_000]);
    expect(amounts('миллион двести наличными')).toEqual([1_200_000]);
  });
});

describe('currency words as people really type them', () => {
  it.each<[string, string]>([
    ['100 ming dollor', 'USD'], ['100 ming doller', 'USD'], ['100 ming доллор', 'USD'], ['100 ming далар', 'USD'], ['100 ming долор', 'USD'], ['100 ming dollr', 'USD'], ['100 dolar', 'USD'], ['200 dollorga', 'USD'], ['5 тыс р', 'RUB'], ['5 тыс. р.', 'RUB'], ['5 тысяч р', 'RUB'],
    ['20000 р', 'RUB'], ['20000р', 'RUB'], ['20000 рублёв', 'RUB'], ['20000 рублев', 'RUB'], ['20000 rublei', 'RUB'], ['200 rubley', 'RUB'], ['200 yevro', 'EUR'],
  ])('%s', (text, currency) => {
    expect(parseMoneyMentions(text)[0].currency).toBe(currency);
  });

  it.each<[string, number, string]>([['300 т.руб', 300_000, 'RUB'], ['300 т. руб.', 300_000, 'RUB'], ['300 т.сум', 300_000, 'UZS']])('%s', (text, amount, currency) => {
    expect(read(text)).toEqual([{ amount, currency }]);
  });

  it.each([['50000 тг'], ['50000 tg'], ['50000 тнг'], ['50000 RMB'], ['50000 rial'], ['50000 riyal'], ['50000 риал'], ['50000 тугрик'], ['50000 сомов'], ['5000 динар'], ['5000 CHF'], ['5000 рупий']])('%s is not so\'m', (text) => {
    expect(only(text)).toMatchObject({ currency: null, bare: false });
    expect(only(text).unknownCurrency).toBeDefined();
  });

  it.each([['3 mln dollar seyfdan elektrga'], ['3 mln Dollar seyfdan elektrga'], ['3 MLN DOLLAR SEYFDAN'], ['3 млн доллар сейфдан'], ['3 mln evro kassadan'], ['5 ming dollar kartadan']])('with a scale, a currency word before an account names the account: %s', (text) => {
    expect(only(text).currency).toBeNull();
  });

  it('the person can still say so\'m, or a plain sum in dollars', () => {
    expect(only("3 mln so'm kassadan").currency).toBe('UZS');
    expect(only('Gazga 200 dollar kassadan').currency).toBe('USD');
    expect(only('Elektrga 3 mln dollar naqd').currency).toBe('USD');
  });
});

describe('scale words as people really type them', () => {
  it.each<[string, number]>([
    ['3 miliyon', 3_000_000], ['3 милион', 3_000_000], ['3 milion', 3_000_000], ['300 тысч', 300_000], ['300 тыш', 300_000], ['300 тышь', 300_000], ['300 тыщ', 300_000], ['300 тыс.', 300_000],
  ])('%s', (text, amount) => {
    expect(amounts(text)).toEqual([amount]);
  });
});

describe('separators, mixed', () => {
  it.each<[string, number, string?]>([
    ["5 000.000 so'm", 5_000_000, 'UZS'], ['3 000.000', 3_000_000], ['5 000,000', 5_000_000], ['3.000 000', 3_000_000], ['1,500 000', 1_500_000], ["1'500'000 so'm", 1_500_000, 'UZS'], ['1’500’000', 1_500_000], ['1 500.000 so\'m', 1_500_000, 'UZS'],
  ])('%s', (text, amount, currency) => {
    expect(read(text)).toEqual([{ amount, currency: currency ?? null }]);
  });

  it('never reads them a thousand times too small', () => {
    refuses("Elektrga 5 000.000 so'm naqd", 5_000);
    refuses('3.000 000', 3_000);
  });

  it('two decimals stay decimals', () => {
    expect(amounts('1 500 000,50')).toEqual([1_500_000.5]);
    expect(amounts('2 500,75')).toEqual([2_500.75]);
  });
});

describe('words that only fold like numbers', () => {
  it.each<[string, number[]]>([
    ['эти три миллиона отдал', [3_000_000]], ['эти триста тысяч наличными', [300_000]], ['Торт тысячу', []], ['торт минг', [4_000]], ['он беш минг', [15_000]], ['Он беш минг нақд', [15_000]], ['ун беш минг', [15_000]], ['ўн беш минг', [15_000]], ['un besh ming', [15_000]],
    ['он заплатил 3 млн', [3_000_000]], ['on five million', [5_000_000]], ["on ming so'm", [10_000]], ['on million', [10_000_000]], ['Un 5 mln', [5_000_000]], ['етти миллион', [7_000_000]],
  ])('%s', (text, expected) => {
    expect(amounts(text)).toEqual(expected);
    for (const mention of parseMoneyMentions(text)) expect(mention.uncertain, text).toBe(false);
  });
});

describe('a range or an approximate figure is not exact', () => {
  it.each<[string, number[]]>([
    ['3 to 4 thousand dollars', [3_000, 4_000]], ['Electricity 3 to 4 million cash', [3_000_000, 4_000_000]], ['3 mln to 4 mln', [3_000_000, 4_000_000]], ['3 млн до 4 млн', [3_000_000, 4_000_000]], ['3 mln ~ 4 mln', [3_000_000, 4_000_000]],
    ['3..4 млн', [3_000_000, 4_000_000]], ['3...4 mln', [3_000_000, 4_000_000]], ['3…4 mln', [3_000_000, 4_000_000]], ['three to four million', [3_000_000, 4_000_000]], ['две-три тысячи', [2_000, 3_000]], ['bir-ikki million', [1_000_000, 2_000_000]],
  ])('%s', (text, expected) => {
    const mentions = parseMoneyMentions(text);
    expect(mentions.map((m) => m.amount)).toEqual(expected);
    expect(mentions.every((m) => m.uncertain)).toBe(true);
  });

  it('a "to" that leads to something else is no range', () => {
    expect(parseMoneyMentions('Paid 3 million to 4 workers').filter((m) => m.amount === 3_000_000)[0].uncertain).toBe(false);
    expect(parseMoneyMentions('3 млн до 4').map((m) => m.uncertain)).toEqual([true, true]);
  });

  it.each([
    ['taqriban 3 mln naqd'], ['tahminan 3 mln naqd'], ['qariyb 3 mln'], ['3 mln atrof naqd'], ['3 mln lar atrofida naqd'], ['3 millionlar chamasi'], ['kamida 3 mln naqd'], ["ko'pi bilan 3 mln naqd"], ['maksimum 3 mln naqd'], ['minimum 3 mln naqd'], ['balkim 3 mln naqd'], ['3 mln ekan shekilli'], ['menimcha 3 mln'], ['3 mln dan oshiqroq'],
  ])('%s', (text) => {
    uzbek(text, (form) => expect(parseMoneyMentions(form)[0].uncertain, form).toBe(true));
  });

  it.each([
    ['где то 3 млн наличными'], ['где-то 3 млн наличными'], ['3 млн где то наличными'], ['в районе 3 млн наличными'], ['в пределах 3 млн наличными'], ['3 млн с копейками наличными'], ['3 млн с чем то наличными'], ['3 млн с чем-то наличными'], ['3 млн с небольшим наличными'],
    ['минимум 3 млн наличными'], ['максимум 3 млн наличными'], ['наверно 3 млн наличными'], ['может 3 млн'], ['3 млн похоже'], ['думаю 3 млн'], ['не больше 3 млн'], ['чуть меньше 3 млн'], ['at least 3 million cash'], ['at most 3 million cash'], ['up to 3 million cash'],
    ['3 million give or take cash'], ['3 million or thereabouts cash'], ['3 million or more'], ['some 3 million'], ['like 3 million cash'], ['a bit over 3 million cash'], ['just under 3 million cash'], ['I think 3 million'],
  ])('%s', (text) => {
    expect(parseMoneyMentions(text)[0].uncertain).toBe(true);
  });

  it('a hedge in another clause does not touch the figure', () => {
    expect(only('Gaz qimmat shekilli, elektrga 3 mln naqd').uncertain).toBe(false);
    expect(only('Elektrga 3 mln, shekilli gaz ham qimmat').uncertain).toBe(false);
  });
});

describe('a correction, in more words', () => {
  it.each<[string, number]>([
    ['Elektrga 3 mln kechirasiz 4 mln naqd', 3_000_000], ["Elektrga 3 mln, ya'ni 4 mln naqd", 3_000_000], ['Elektrga 3 mln desam 4 mln ekan', 3_000_000], ['Elektrga 3 mln hozir aytaman 4 mln', 3_000_000], ["Elektrga 3 mln, noto'g'ri, 4 mln", 3_000_000],
    ["3 mln o'rniga 4 mln", 3_000_000], ["Elektrga 3 mln e yo'q 4 mln naqd", 3_000_000], ["elektrga uch million to'ladim yo'q to'rt million", 3_000_000],
  ])('%s', (text, taken) => {
    uzbek(text, (form) => {
      const mentions = parseMoneyMentions(form);
      expect(mentions.filter((m) => m.negated).map((m) => m.amount), form).toEqual([taken]);
      expect(mentions.filter((m) => !m.negated).map((m) => m.amount), form).toEqual([4_000_000]);
    });
  });

  it.each([
    ['За свет 3 млн ой 4 млн наличными'], ['За свет 3 млн извините 4 млн наличными'], ['За свет 3 млн, то есть 4 млн наличными'], ['За свет 3 млн, в смысле 4 млн наличными'], ['За свет 3 млн, а нет, 4 млн наличными'], ['За свет 3 млн, хотя нет, 4 млн наличными'],
    ['За свет 3 млн вернее сказать 4 млн наличными'], ['За свет 3 млн нет стоп 4 млн наличными'], ['вместо 3 млн 4 млн'], ['ne 3 mln a 4 mln'], ['Electricity 3 million I mean 4 million cash'], ['Electricity 3 million wait 4 million cash'], ['Electricity 3 million make that 4 million cash'],
    ['Electricity 3 million scratch that 4 million cash'], ['Electricity 3 million no wait 4 million cash'], ['Electricity 3 million sorry I meant 4 million cash'], ['instead of 3 million 4 million'], ['3 million oops 4 million'],
  ])('%s', (text) => {
    const mentions = parseMoneyMentions(text);
    expect(mentions.filter((m) => m.negated).map((m) => m.amount)).toEqual([3_000_000]);
    expect(mentions.filter((m) => !m.negated).map((m) => m.amount)).toEqual([4_000_000]);
  });

  it.each<[string, number]>([
    ['За свет не три миллиона а четыре наличными', 4_000_000], ['3 mln emas 4', 4_000_000], ['не 3 млн а 4', 4_000_000], ['3 млн нет четыре', 4_000_000], ['not three million but four', 4_000_000], ['не 2 тысячи а 3 наличными', 3_000],
  ])('the new figure keeps the scale of the one it replaces: %s', (text, amount) => {
    expect(usable(text)).toEqual([amount]);
  });

  it('the Russian "но" is no English "no"', () => {
    expect(usable('за свет 3 млн но за газ 4 млн')).toEqual([3_000_000, 4_000_000]);
  });

  it('the Uzbek word for month is not "ой"', () => {
    expect(usable('3 млн ой учун 4 млн')).toEqual([3_000_000, 4_000_000]);
    expect(usable('3 mln, oy uchun 4 mln')).toEqual([3_000_000, 4_000_000]);
  });
});

describe('a figure taken back in a newer message', () => {
  const newestFirst = (...texts: string[]) => [...texts].reverse().flatMap((text) => parseMoneyMentions(text));

  it('cancels the older statement of it', () => {
    expect(findMention(newestFirst('Elektrga 3 mln', '3 mln emas, 4 mln, naqd'), 3_000_000)).toBeNull();
    expect(findMention(newestFirst('За свет 3 млн', 'нет, не 3 млн, а 4 млн'), 3_000_000)).toBeNull();
    expect(findMention(newestFirst('Elektrga 3 mln', 'taxminan 3 mln edi'), 3_000_000)).toBeNull();
    expect(findMention(newestFirst('Elektrga 3 mln', '3 yoki 4 mln'), 3_000_000)).toBeNull();
  });

  it('leaves the figure that replaced it', () => {
    expect(findMention(newestFirst('Elektrga 3 mln', '3 mln emas, 4 mln, naqd'), 4_000_000)?.raw).toBe('4 mln');
  });

  it('the same figure said again after it stands', () => {
    expect(findMention(newestFirst('3 mln emas, 4 mln', "yo'q, baribir 3 mln"), 3_000_000)?.raw).toBe('3 mln');
  });

  it('a figure taken back in another currency leaves this one', () => {
    expect(findMention(newestFirst('Elektrga 3 mln', "3 mln dollar emas, so'm"), 3_000_000, { currency: 'UZS' })?.raw).toBe('3 mln');
  });

  it('a rate of the same number is no retraction', () => {
    expect(findMention(newestFirst("Tushlikka 12 700 so'm", 'kurs 12 700'), 12_700)?.currency).toBe('UZS');
  });
});

describe('an exchange rate in the words people use', () => {
  const rate = (text: string) => parseMoneyMentions(text).filter((m) => m.rate).map((m) => [m.amount, m.rateOf ?? null]);

  it.each<[string, number, string | null]>([
    ['kurs 1 dollar 12700', 12_700, 'USD'], ['курс 1 доллар 12700', 12_700, 'USD'], ['kurs 1$ 12700', 12_700, 'USD'], ['курс 1 $ = 12 700', 12_700, 'USD'], ['1$=12700', 12_700, 'USD'], ['$1 = 12 700', 12_700, 'USD'], ['1$ - 12700', 12_700, 'USD'], ["1 dollar = 12700 so'm", 12_700, 'USD'],
    ['1 USD = 12 700 UZS', 12_700, 'USD'], ['1 dollar uchun 12700', 12_700, 'USD'], ['курс 1 доллар 12700 сўм', 12_700, 'USD'], ['kurs 1 evro 14000', 14_000, 'EUR'], ['курс 1 евро 14 000 сум', 14_000, 'EUR'], ['1 рубль 130', 130, 'RUB'], ["1 rubl = 130 so'm", 130, 'RUB'],
    ['Evro kursi 14 000', 14_000, 'EUR'], ['евро курси 14 000', 14_000, 'EUR'], ['Rubl kursi 130', 130, 'RUB'], ['курс евро 14000', 14_000, 'EUR'], ['курс доллара на сегодня 12700', 12_700, 'USD'], ['dollar kursi 12 700', 12_700, 'USD'], ['доллар курси 12 700', 12_700, 'USD'], ['usd rate 12700', 12_700, 'USD'],
    ['dollariga 12 700', 12_700, 'USD'], ['долларга 12700', 12_700, 'USD'], ['за доллар 12700', 12_700, 'USD'], ['12700 за доллар', 12_700, 'USD'], ['per dollar 12700', 12_700, 'USD'], ['at 12700 per dollar', 12_700, 'USD'], ['курс 12700', 12_700, null], ['обменный курс 12700', 12_700, null], ['exchange rate 12700', 12_700, null], ['at a rate of 12700', 12_700, null],
    ['курс на сегодня 12700', 12_700, null], ['курс ЦБ 12 700', 12_700, null], ['курс цб 12700', 12_700, null], ['курс банка 12700', 12_700, null], ['kurs bankda 12700', 12_700, null], ['kurs kecha 12700', 12_700, null], ['kurs hozir 12700', 12_700, null], ['kurs edi 12700', 12_700, null], ['курс на 1 ноября 12700', 12_700, null], ['kurs 2-noyabr 12700', 12_700, null],
  ])('%s', (text, amount, of) => {
    expect(rate(text)).toEqual([[amount, of]]);
  });

  it('the 1 in front of a rate is no amount', () => {
    expect(amounts('kurs 1 dollar 12700')).toEqual([12_700]);
    expect(amounts("1 dollar = 12700 so'm")).toEqual([12_700]);
  });

  it.each<[string, number, string]>([
    ['200 dollar 12700 dan', 12_700, 'USD'], ['200 dollar 12700 dan', 12_700, 'USD'], ["200 dollar 12 700 so'mdan", 12_700, 'USD'], ['200 долларов по 12700', 12_700, 'USD'], ['200 dollarni 12700 dan oldik', 12_700, 'USD'], ['Elektrga 100 evro 14000', 14_000, 'EUR'], ['Elektrga 200 dollar 12700 naqd', 12_700, 'USD'],
  ])('a number beside a foreign amount: %s', (text, amount, of) => {
    expect(rate(text)).toEqual([[amount, of]]);
    expect(parseMoneyMentions(text)[1].perUnit).toBeNull();
  });

  it.each<[string, number, string]>([
    ['Dollar 12700 dan oldik', 12_700, 'USD'], ['dollarni 12700 dan oldik', 12_700, 'USD'], ['доллар по 12700', 12_700, 'USD'], ['евро по 14000', 14_000, 'EUR'],
  ])('a price of the currency itself is its rate: %s', (text, amount, of) => {
    expect(rate(text)).toEqual([[amount, of]]);
  });

  it('a figure beside a foreign amount that is money stays money', () => {
    expect(rate('200 dollar 300 ming')).toEqual([]);
    expect(rate("200 dollar 12700 so'm")).toEqual([]);
    expect(rate('200 dollar, 12700 naqd')).toEqual([]);
    expect(rate('200 dollar 300')).toEqual([]);
    expect(rate('Internetga 1 dollar, 20000 gazga')).toEqual([]);
  });

  it.each<[string, number]>([
    ["kurs bo'yicha 200 dollar", 200], ['по курсу 200 долларов', 200], ['bugungi kurs bilan 200 dollar', 200], ['Haydovchilar kursi 3 mln naqd', 3_000_000], ['Haydovchilar kursi 300 ming naqd', 300_000], ['Kurslarga 500 ming', 500_000],
  ])('an amount is not a rate: %s', (text, amount) => {
    expect(rate(text)).toEqual([]);
    accepts(text, amount);
  });

  it('a rate word reaches only into its own clause', () => {
    expect(rate('kurs baland, 20 ming')).toEqual([]);
    expect(rate('kurs baland elektrga 20 ming')).toEqual([]);
    expect(rate('kurs 12 700, elektrga 20 ming')).toEqual([[12_700, null]]);
  });

  it('the figure in a correction of a rate is the rate', () => {
    expect(parseMoneyMentions('kurs 12700 emas 12800').map((m) => [m.amount, m.rate, m.negated])).toEqual([[12_700, true, true], [12_800, true, false]]);
    expect(parseMoneyMentions("kurs 12700 yo'q 12800").map((m) => [m.amount, m.rate, m.negated])).toEqual([[12_700, true, true], [12_800, true, false]]);
    expect(parseMoneyMentions('курс 12700, нет 12800').map((m) => [m.amount, m.rate, m.negated])).toEqual([[12_700, true, true], [12_800, true, false]]);
  });

  it('a correction to a foreign amount is no rate', () => {
    expect(rate('kurs 12700 emas 200 dollar')).toEqual([[12_700, null]]);
  });

  it('two currencies keep their own rates', () => {
    expect(rate('курс евро 14000 а за доллар 12700')).toEqual([[14_000, 'EUR'], [12_700, 'USD']]);
  });
});

describe('long text', () => {
  it('stays linear, so a pasted page cannot stall the assistant', () => {
    const text = '4 tonna arpa 12 ming olma '.repeat(4_000);
    const started = Date.now();
    expect(parseMoneyMentions(text).length).toBe(4_000);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe('a unit said before the figure', () => {
  it.each([
    ["5000 kg arpa, tonnasi 2 mln so'mdan", 2_000_000, 't'],
    ['5000 kg arpa, tonnasi 2 mlndan', 2_000_000, 't'],
    ['5000 кг ячменя, тонна по 2 млн', 2_000_000, 't'],
    ['5000 kg of barley, a tonne at 2 million', 2_000_000, 't'],
    ['300 литров, литр по 15 тысяч', 15_000, 'l'],
    ["500 litr dizel, litri 15 ming so'mdan", 15_000, 'l'],
    ['1 kg 3 mingdan, 500 kg', 3_000, 'kg'],
  ])('%s says what the price is for', (text, amount, unit) => {
    expect(parseMoneyMentions(text).at(-1)).toMatchObject({ amount, perUnit: unit });
  });

  it.each([
    ['2 tonna, 3 mingdan', 3_000],
    ['2 tonna arpa 3 mingdan', 3_000],
    ['5 тонн по 2 млн', 2_000_000],
    ['200 литров по 15 тысяч', 15_000],
  ])('%s leaves it open: the count names the quantity, not the price', (text, amount) => {
    expect(parseMoneyMentions(text).at(-1)).toMatchObject({ amount, perUnit: 'unit' });
  });
});

describe('currencySaid', () => {
  it.each([
    ['dollar edi', 'USD'],
    ["so'm", 'UZS'],
    ['это в рублях', 'RUB'],
    ['евро', 'EUR'],
  ])('%s names %s', (text, currency) => {
    expect(currencySaid(text)).toBe(currency);
  });

  it.each([["so'm emas, dollar"], ['naqd'], ['']])('%s settles nothing', (text) => {
    expect(currencySaid(text)).toBeNull();
  });
});
