import { describe, expect, it } from 'vitest';
import { latinToCyrillic } from '../i18n/translit';
import { unitOf } from './units';
import {
  advanceWords, asksSomething, cancelWords, claimsCard, claimsDone, dateEvidence, directUseWords, directionWords, joinsThings, moneyCameIn, monthlyWord,
  notHappened, ownedWords, parseQuantities, parseStatedRates,
  paymentWords,
  saysDone, saysGeneral, settlesDebt, warehouseWords, waterIsOpen,
  statedTotals, saleWords, serviceWords, wageWords,
} from './record-words';

const toRussianKeyboard = (text: string) =>
  text.replace(/[қҚўЎғҒҳҲ]/g, (letter) => ({ қ: 'к', Қ: 'К', ў: 'у', Ў: 'У', ғ: 'г', Ғ: 'Г', ҳ: 'х', Ҳ: 'Х' })[letter]!);

/** One Uzbek phrase as it really arrives: any apostrophe or none, h as x, capitals, Cyrillic, a Russian keyboard. */
const spellings = (text: string) => [
  text,
  text.replace(/'/g, 'ʻ'),
  text.replace(/'/g, '’'),
  text.replace(/'/g, '`'),
  text.replace(/'/g, ''),
  text.replace(/(?<![scSC])h/g, 'x'),
  text.toUpperCase(),
  latinToCyrillic(text),
  toRussianKeyboard(latinToCyrillic(text)),
];

/** The check holds for every spelling of an Uzbek phrase. */
const everySpelling = (text: string, check: (form: string) => void) => {
  for (const form of spellings(text)) check(form);
};

// Wednesday. Control dates below were read off a calendar for November 2026.
const TODAY = '2026-11-04';

describe('parseQuantities', () => {
  const read = (text: string) => parseQuantities(text).map((q) => [q.qty, q.unit]);

  it.each<[string, number, string]>([
    ['2 tonna', 2, 'tonna'], ['ikki tonna', 2, 'tonna'], ['bir yarim tonna', 1.5, 'tonna'], ['yarim tonna', 0.5, 'tonna'], ['ikki yarim tonna', 2.5, 'tonna'], ['2,5 tonna', 2.5, 'tonna'], ['2.5 tonna', 2.5, 'tonna'],
    ['uch yuz litr', 300, 'litr'], ['olti yuz litr', 600, 'litr'], ['2 ming litr', 2_000, 'litr'], ['ikki ming litr', 2_000, 'litr'], ['ikki ming besh yuz litr', 2_500, 'litr'], ['ming litr', 1_000, 'litr'],
    ['500 litr', 500, 'litr'], ['500 litrdan', 500, 'litrdan'], ['50 qop', 50, 'qop'], ['besh yuz qop', 500, 'qop'], ['20 flakon', 20, 'flakon'], ['20 doza', 20, 'doza'], ['10 bosh', 10, 'bosh'], ['10 kg', 10, 'kg'],
    ['yuz kilo', 100, 'kilo'], ['3 sentner', 3, 'sentner'], ['5 dona', 5, 'dona'], ["10 ta qo'y", 10, 'ta'], ['10 ta', 10, 'ta'], ['5 ta flakon', 5, 'flakon'], ['10 ta qop', 10, 'qop'], ['uchta qop', 3, 'qop'],
    ["ikkita qo'y", 2, 'ta'], ["to'rtta qop", 4, 'qop'], ['3 mingta', 3_000, 'ta'], ['5 bog\'', 5, "bog'"], ['12 quti', 12, 'quti'],
  ])('%s', (text, qty, unit) => {
    expect(read(text)).toEqual([[qty, unit]]);
    for (const form of spellings(text).filter((f) => !/коп$/i.test(f))) expect(parseQuantities(form).map((q) => q.qty), form).toEqual([qty]);
  });

  it('a Russian keyboard cannot tell a bag from "many", so "коп" is no quantity', () => {
    expect(read('50 қоп')).toEqual([[50, 'қоп']]);
    expect(read('50 коп')).toEqual([]);
    expect(read("3 mln ko'p")).toEqual([]);
  });

  it.each<[string, number, string]>([
    ['2 тонны', 2, 'тонны'], ['5 тонн', 5, 'тонн'], ['две тонны', 2, 'тонны'], ['полторы тонны', 1.5, 'тонны'], ['пол тонны', 0.5, 'тонны'], ['полтонны', 0.5, 'тонны'], ['2,5 т', 2.5, 'т'], ['2т', 2, 'т'], ['2 т', 2, 'т'],
    ['300л', 300, 'л'], ['300 л.', 300, 'л'], ['300 литров', 300, 'литров'], ['двести литров', 200, 'литров'], ['сто литров', 100, 'литров'], ['500 доз', 500, 'доз'], ['20 флаконов', 20, 'флаконов'], ['50 мешков', 50, 'мешков'],
    ['пять мешков', 5, 'мешков'], ['10 голов', 10, 'голов'], ['5 штук', 5, 'штук'], ['100 кг', 100, 'кг'], ['2 тысячи литров', 2_000, 'литров'], ['две тысячи литров', 2_000, 'литров'], ['300 литр', 300, 'литр'],
    ['two tonnes', 2, 'tonnes'], ['two tons', 2, 'tons'], ['half a ton', 0.5, 'ton'], ['200 litres', 200, 'litres'], ['200 liters', 200, 'liters'], ['three hundred liters', 300, 'liters'], ['50 bags', 50, 'bags'], ['10 kg', 10, 'kg'], ['20 vials', 20, 'vials'], ['500 doses', 500, 'doses'],
  ])('%s', (text, qty, unit) => {
    expect(read(text)).toEqual([[qty, unit]]);
  });

  it('keeps the quantity as written in raw', () => {
    expect(parseQuantities('Neft Bazadan 2 ming litr dizel oldim')).toEqual([{ qty: 2_000, unit: 'litr', raw: '2 ming litr' }]);
    expect(parseQuantities('5 ta flakon')).toEqual([{ qty: 5, unit: 'flakon', raw: '5 ta flakon' }]);
  });

  it('finds the quantity among money, dates and names', () => {
    expect(read('100 kg arpa 1,5 mln naqd')).toEqual([[100, 'kg']]);
    expect(read('2 tonna arpa 4 mln naqd Neft Bazadan')).toEqual([[2, 'tonna']]);
    expect(read('12.05.2026 kuni 2 tonna arpa')).toEqual([[2, 'tonna']]);
    expect(read('Kepak 1 tonna 3 mln qarzga')).toEqual([[1, 'tonna']]);
    expect(read('3-dalaga 200 litr dizel')).toEqual([[200, 'litr']]);
    expect(read("yo'q, 2500 kg")).toEqual([[2_500, 'kg']]);
    expect(read('2 tonna arpa va 500 kg kepak')).toEqual([[2, 'tonna'], [500, 'kg']]);
    expect(read('ertalab bozorga bordim kepak oldim yuz qop ikki million berdim')).toEqual([[100, 'qop']]);
    expect(read('взял двести литров солярки заплатил три миллиона наличкой')).toEqual([[200, 'литров']]);
  });

  it('keeps both readings of "300т", which money reads as thousands', () => {
    expect(read('300т')).toEqual([[300, 'т']]);
    expect(read('300 т.р')).toEqual([]);
  });

  it.each([['3 mln'], ['500 ming'], ['5 kun'], ['12 gektar'], ['12%'], ['90 123 45 67'], ['3 dala'], ['2 soat'], ['5 noyabr'], ['MTZ-82'], ['500'], [''], ['boshqa'], ["ta'mir"]])('%s is no stock quantity', (text) => {
    expect(parseQuantities(text)).toEqual([]);
  });
});

describe('parseStatedRates', () => {
  it.each<[string, number[]]>([
    ['kurs 12 700', [12_700]], ['курс 12700', [12_700]], ['rate 12,700.55', [12_700.55]], ['kurs 12,7 ming', [12_700]], ['kurs 12 650,55', [12_650.55]], ['курс 12.650,55', [12_650.55]],
    ['Elektrga 200 dollar naqd, kurs 12 650,55', [12_650.55]], ['200 dollar, kurs 12700', [12_700]], ['dollar kursi 12 700', [12_700]], ['12 700 kursda', [12_700]], ['kurs 12 700, keyin kurs 12 800', [12_700, 12_800]],
  ])('%s', (text, rates) => {
    expect(parseStatedRates(text)).toEqual(rates);
  });

  it.each([['Elektrga 200 dollar naqd'], ['Elektrga 100 dollar naqd'], ['Elektrga $150 naqd'], ['Dollar kursi qancha?'], ['kurs 12 700 emas'], ['kurs 12 700 yoki 12 800'], ['kurs taxminan 12 700'], ['']])('%s states no rate to use', (text) => {
    expect(parseStatedRates(text)).toEqual([]);
  });
});

describe('paymentWords', () => {
  it.each<[string, string]>([
    ['naqd', 'cash'], ['naqdga', 'cash'], ['naqd pul', 'cash'], ['naqdiy', 'cash'], ['naqt', 'cash'], ['kassa', 'cash'], ['kassadan', 'cash'], ['kassaga', 'cash'], ['kasadan', 'cash'],
    ['bank', 'bank'], ['bankdan', 'bank'], ['bankka', 'bank'], ['bank orqali', 'bank'], ['Agrobankdan', 'bank'], ['Hamkorbankdan', 'bank'], ['Xalq bankidan', 'bank'], ['hisobdan', 'bank'], ['hisob raqamidan', 'bank'],
    ['hisob raqamiga', 'bank'], ["o'tkazma", 'bank'], ["o'tkazma orqali", 'bank'], ['naqdsiz', 'bank'], ['karta', 'card'], ['kartadan', 'card'], ['karta bilan', 'card'], ['kartochkadan', 'card'], ['plastik', 'card'], ['plastikdan', 'card'],
    ['humo', 'card'], ['humodan', 'card'], ['qarzga', 'debt'], ['nasiya', 'debt'], ['nasiyaga', 'debt'],
  ])('%s', (text, word) => {
    everySpelling(text, (form) => expect(paymentWords(form), form).toEqual([word]));
  });

  it.each<[string, string]>([
    ['налик', 'cash'], ['нал', 'cash'], ['налом', 'cash'], ['наличка', 'cash'], ['наличкой', 'cash'], ['наличными', 'cash'], ['наличные', 'cash'], ['кэш', 'cash'], ['кеш', 'cash'], ['из кассы', 'cash'], ['cash', 'cash'], ['in cash', 'cash'],
    ['со счёта', 'bank'], ['со счета', 'bank'], ['с расчётного счёта', 'bank'], ['перечисление', 'bank'], ['перечислением', 'bank'], ['перечислили', 'bank'], ['perechislenie', 'bank'], ['perechisleniya', 'bank'], ['perevod', 'bank'],
    ['переводом', 'bank'], ['безнал', 'bank'], ['безналом', 'bank'], ['beznal', 'bank'], ['через банк', 'bank'], ['bank transfer', 'bank'], ['from the account', 'bank'], ['картой', 'card'], ['с карты', 'card'], ['на карту', 'card'], ['пластиком', 'card'],
    ['хумо', 'card'], ['uzcard', 'card'], ['uzcarddan', 'card'], ['Uzcarddan', 'card'], ['узкард', 'card'], ['узкарддан', 'card'], ['by card', 'card'], ['в долг', 'debt'], ['в рассрочку', 'debt'], ['on credit', 'debt'],
  ])('%s', (text, word) => {
    expect(paymentWords(text)).toEqual([word]);
  });

  it('names every way the words mention', () => {
    expect(paymentWords('Kassadan Agrobankka 4 mln')).toEqual(['cash', 'bank']);
    expect(paymentWords('4 mln naqd, 2 mln bankdan')).toEqual(['cash', 'bank']);
    expect(paymentWords('Uzcarddan kassaga 2 mln')).toEqual(['cash', 'card']);
  });

  it('a payment ruled out is not named', () => {
    expect(paymentWords('Elektrga 3 mln naqd emas bankdan')).toEqual(['bank']);
    expect(paymentWords('не наличными, а картой')).toEqual(['card']);
    expect(paymentWords('not cash, by card')).toEqual(['card']);
    expect(paymentWords('bankdan emas')).toEqual([]);
  });

  it.each([
    ['Notariusga 210 ming berdim'], ['Elektrga pul berdim'], ['Internetga 200 ming'], ["Elektrga to'ladim"], ['Buxoro Yem Savdo bilan 3 mln hisob-kitob qildik'], ['qarzimizdan 3 mln'], ['qarzni to\'ladim'],
    ['Оплатил счёт за свет'], ['3 млн'], ['Bank komissiyasi 45 ming'], ['банковская комиссия'], ['hisobga olish'], ['nalog'], ['kartoshka uchun'], ['kassir'], ['naqsh'],
  ])('%s does not say how it was paid', (text) => {
    expect(paymentWords(text)).toEqual([]);
  });

  it('a way of paying the person is not sure of is not stated', () => {
    expect(paymentWords("bankdan shekilli, tekshirib ko'raman")).toEqual([]);
    expect(paymentWords('naqd shekilli')).toEqual([]);
    expect(paymentWords('наверное наличными')).toEqual([]);
    expect(paymentWords('maybe cash')).toEqual([]);
  });

  it('the bank in a fee or a card is not how it was paid', () => {
    expect(paymentWords('Bank komissiyasi 12% naqd')).toEqual(['cash']);
    expect(paymentWords('Bank komissiyasi 45 ming, hisobdan yechildi bankdan')).toEqual(['bank']);
    expect(paymentWords('bank kartasidan')).toEqual(['card']);
  });
});

describe('dateEvidence', () => {
  const on = (text: string, today = TODAY) => dateEvidence(text, today);
  const pinned = (text: string, ...dates: string[]) => expect(on(text), text).toEqual({ dates, vague: false, future: false });

  it.each<[string, string]>([
    ['bugun', TODAY], ['Bugun gazga 400 ming', TODAY], ['bugungi', TODAY], ['kecha', '2026-11-03'], ['kechagi', '2026-11-03'], ['kecha kechqurun', '2026-11-03'], ["o'tgan kuni", '2026-11-02'], ['avvalgi kuni', '2026-11-02'],
    ['bir kun oldin', '2026-11-03'], ['ikki kun oldin', '2026-11-02'], ['2 kun oldin', '2026-11-02'], ['uch kun oldin', '2026-11-01'], ['3 kun oldin', '2026-11-01'], ['besh kun avval', '2026-10-30'], ["o'n kun oldin", '2026-10-25'],
    ['dushanba', '2026-11-02'], ['dushanba kuni', '2026-11-02'], ['dushanbada', '2026-11-02'], ["o'tgan dushanba", '2026-11-02'], ['seshanba', '2026-11-03'], ['chorshanba', '2026-10-28'], ['payshanba', '2026-10-29'], ['juma', '2026-10-30'],
    ['jumada', '2026-10-30'], ['shanba', '2026-10-31'], ['shanba kuni', '2026-10-31'], ['yakshanba', '2026-11-01'], ['2-noyabr', '2026-11-02'], ['2 noyabr', '2026-11-02'], ['2-noyabr kuni', '2026-11-02'], ['2-noyabrda', '2026-11-02'],
    ['3-oktabr', '2026-10-03'], ['3 oktabr', '2026-10-03'], ['15-avgust', '2026-08-15'], ['1-yanvar', '2026-01-01'], ['1-may', '2026-05-01'], ['5-iyun', '2026-06-05'], ['5-iyul', '2026-07-05'], ['10-fevral', '2026-02-10'],
    ['10-mart', '2026-03-10'], ['10-aprel', '2026-04-10'], ['10-sentabr', '2026-09-10'], ['noyabrning 2-si', '2026-11-02'], ['noyabr 2', '2026-11-02'], ['2026 yil 2-noyabr', '2026-11-02'], ['2025 yil 2-noyabr', '2025-11-02'], ['2-kuni', '2026-11-02'], ['5-kuni', '2026-10-05'],
  ])('%s', (text, date) => {
    everySpelling(text, (form) => pinned(form, date));
  });

  it.each<[string, string]>([
    ['сегодня', TODAY], ['today', TODAY], ['вчера', '2026-11-03'], ['Вчера за газ 400 тысяч наличными', '2026-11-03'], ['yesterday', '2026-11-03'], ['позавчера', '2026-11-02'], ['the day before yesterday', '2026-11-02'],
    ['3 дня назад', '2026-11-01'], ['три дня назад', '2026-11-01'], ['два дня назад', '2026-11-02'], ['5 дней назад', '2026-10-30'], ['3 days ago', '2026-11-01'], ['three days ago', '2026-11-01'], ['a day ago', '2026-11-03'],
    ['в понедельник', '2026-11-02'], ['во вторник', '2026-11-03'], ['в среду', '2026-10-28'], ['в четверг', '2026-10-29'], ['в пятницу', '2026-10-30'], ['в субботу', '2026-10-31'], ['в воскресенье', '2026-11-01'], ['on Monday', '2026-11-02'], ['last friday', '2026-10-30'],
    ['2 ноября', '2026-11-02'], ['2 ноября 2026', '2026-11-02'], ['2 ноября 2025', '2025-11-02'], ['3 октября', '2026-10-03'], ['5 мая', '2026-05-05'], ['2 марта', '2026-03-02'], ['1 января', '2026-01-01'], ['Nov 2', '2026-11-02'], ['Nov. 2', '2026-11-02'], ['2 Nov', '2026-11-02'], ['November 2', '2026-11-02'],
    ['November 2nd', '2026-11-02'], ['2nd of November', '2026-11-02'], ['the 2nd', '2026-11-02'], ['2 числа', '2026-11-02'], ['2-го числа', '2026-11-02'], ['2-го', '2026-11-02'], ['5 числа', '2026-10-05'], ['02.11', '2026-11-02'], ['2.11', '2026-11-02'], ['02/11', '2026-11-02'],
    ['02.11.2026', '2026-11-02'], ['2.11.2026', '2026-11-02'], ['02.11.26', '2026-11-02'], ['02/11/2026', '2026-11-02'], ['02-11-2026', '2026-11-02'], ['2026-11-02', '2026-11-02'], ['2026.11.02', '2026-11-02'], ['02 11 2026', '2026-11-02'], ['20261102', '2026-11-02'], ['03.05.2026 kuni', '2026-05-03'],
  ])('%s', (text, date) => {
    pinned(text, date);
  });

  it('counts back across a month and a year', () => {
    expect(on('uch kun oldin', '2026-03-02').dates).toEqual(['2026-02-27']);
    expect(on('kecha', '2027-01-01').dates).toEqual(['2026-12-31']);
    expect(on('dushanba', '2027-01-01').dates).toEqual(['2026-12-28']);
    expect(on('5-kuni', '2027-01-03').dates).toEqual(['2026-12-05']);
  });

  it('a weekday is never today, whatever the day', () => {
    expect(on('chorshanba', '2026-11-04').dates).toEqual(['2026-10-28']);
    expect(on('payshanba', '2026-11-05').dates).toEqual(['2026-10-29']);
  });

  it('with no year, a late date around New Year is last year, and a date ahead stays ahead', () => {
    expect(on('28-dekabr', '2027-01-02')).toEqual({ dates: ['2026-12-28'], vague: false, future: false });
    expect(on('25-dekabr', '2026-11-04')).toEqual({ dates: ['2026-12-25'], vague: false, future: true });
    expect(on('5-noyabr', '2026-11-04')).toEqual({ dates: ['2026-11-05'], vague: false, future: true });
    expect(on('4-noyabr', '2026-11-04')).toEqual({ dates: ['2026-11-04'], vague: false, future: false });
  });

  it.each([
    ["o'tgan hafta"], ["O'tgan hafta gazga 470 ming naqd to'ladim"], ["o'tgan haftada"], ["o'tgan oy"], ["o'tgan oyda"], ["O'tgan oy gazga 400 ming"], ["o'tgan yili"], ['bu hafta'], ['shu hafta'], ['bu oyda'], ['hafta boshida'], ['oy oxirida'],
    ['bir necha kun oldin'], ['yaqinda'], ['ancha oldin'], ['oldinroq'], ["o'sha kuni"], ['bir hafta oldin'], ['ikki hafta oldin'], ['bir oy oldin'], ['oktabrda'], ['oktabr oyida'], ['noyabrda'],
    ['3-4 kun oldin'], ['3 yoki 4 kun oldin'], ['2-3 noyabr'], ['2 yoki 3 noyabr'], ['taxminan 3 kun oldin'], ['shu kunlarda'], ["o'tgan kunlari"], ["so'nggi kunlarda"], ['ertasi kuni'], ['hafta ichida'], ['ikki hafta avval'],
  ])('%s cannot be pinned', (text) => {
    everySpelling(text, (form) => expect(on(form), form).toEqual({ dates: [], vague: true, future: false }));
  });

  it.each([
    ['на прошлой неделе'], ['на этой неделе'], ['в прошлом месяце'], ['в этом месяце'], ['в прошлом году'], ['недавно'], ['давно'], ['на днях'], ['несколько дней назад'], ['неделю назад'], ['две недели назад'], ['месяц назад'],
    ['в начале месяца'], ['в конце недели'], ['в октябре'], ['2-3 ноября'], ['2 или 3 ноября'], ['3-4 дня назад'], ['примерно 3 дня назад'], ['в эти дни'], ['в течение недели'], ['last week'], ['last month'], ['last year'], ['this week'], ['recently'], ['the other day'], ['a few days ago'], ['a week ago'], ['two weeks ago'], ['in October'],
    ['второго ноября'], ['second of November'],
  ])('%s cannot be pinned', (text) => {
    expect(on(text)).toEqual({ dates: [], vague: true, future: false });
  });

  it.each([['31-noyabr'], ['31 noyabr'], ['31 ноября'], ['Nov 31'], ['31.11'], ['31.11.2026'], ['30.02.2026'], ['2026-02-30'], ['2026-04-31'], ['30-fevral'], ['29-fevral'], ['2026-13-01']])('%s does not exist', (text) => {
    expect(on(text)).toEqual({ dates: [], vague: true, future: false });
  });

  it('a day of the month is the latest one that exists', () => {
    expect(on('31-kuni', TODAY).dates).toEqual(['2026-10-31']);
    expect(on('31-kuni', '2026-03-02')).toEqual({ dates: [], vague: true, future: false });
  });

  it('accepts the 29th of February in a leap year', () => {
    expect(on('29-fevral', '2028-03-01').dates).toEqual(['2028-02-29']);
    expect(on('29.02.2028', '2028-03-01').dates).toEqual(['2028-02-29']);
  });

  it.each([['ertaga'], ['Ertaga svetga 1 mln naqd to\'layman'], ['indinga'], ['keyingi hafta'], ['kelasi hafta'], ['keyingi oy'], ['kelasi oy'], ['keyingi dushanba'], ['3 kundan keyin']])('%s has not happened', (text) => {
    everySpelling(text, (form) => expect(on(form), form).toEqual({ dates: [], vague: false, future: true }));
  });

  it.each([['завтра'], ['послезавтра'], ['на следующей неделе'], ['в следующем месяце'], ['через неделю'], ['через месяц'], ['через 3 дня'], ['tomorrow'], ['next week'], ['next month'], ['next monday'], ['in 3 days'], ['in a week']])('%s has not happened', (text) => {
    expect(on(text)).toEqual({ dates: [], vague: false, future: true });
  });

  it('a stated date ahead of today says so', () => {
    expect(on('02.11.2027')).toEqual({ dates: ['2027-11-02'], vague: false, future: true });
    expect(on('2026-11-05')).toEqual({ dates: ['2026-11-05'], vague: false, future: true });
  });

  it.each([
    ['Elektrga 3 mln naqd'], ["Qorovulga bu oy uchun 2,6 mln naqd berdim"], ['сторожу за октябрь'], ['за прошлый месяц'], ["o'tgan oy uchun"], ['oktabr uchun'], ['oktabr oyi uchun'], ['for October'], ['2.5 mln'], ['1.5 tonna'], ['3.5 naqd'], ['12.05 mln'], ['$12.05'],
    ['12.05 dollar'], ['2 tonna 3.10 mln'], ['2 marta'], ['I may pay later'], ['mayda pul'], ['5 ming'], ['500'], ['3-dala'], ['ertalab'], ['12 gektar'], ['90 123 45 67'], ["5 kun ishladi"], ['3 tonna'], ['kechasi'], [''],
  ])('%s says nothing about the day', (text) => {
    expect(on(text)).toEqual({ dates: [], vague: false, future: false });
  });

  it('gives every day named, so several can be asked about', () => {
    expect(on('kecha gazga 400 ming, bugun ham gazga 400 ming').dates.sort()).toEqual(['2026-11-03', TODAY]);
    expect(on('Bugun 400 ming tushlik, kecha ham').dates.sort()).toEqual(['2026-11-03', TODAY]);
  });

  it('a day ruled out is not named', () => {
    expect(on('kecha emas, bugun').dates).toEqual([TODAY]);
    expect(on('не вчера, а сегодня').dates).toEqual([TODAY]);
  });

  it('an amount near a month is not its year', () => {
    expect(on("5 noyabr 2000 so'm").dates).toEqual(['2026-11-05']);
    expect(on('2-noyabr 3 mln').dates).toEqual(['2026-11-02']);
    expect(on('noyabr 3 mln').dates).toEqual([]);
  });

  it('a day the person is not sure of is vague, never dropped into today', () => {
    expect(on('kecha shekilli').vague).toBe(true);
    expect(on('вчера наверное').vague).toBe(true);
    expect(on('maybe yesterday').vague).toBe(true);
    expect(on('2-noyabr shekilli').vague).toBe(true);
    expect(on('balki naqd').vague).toBe(false);
  });

  it('reads a voice note with no punctuation', () => {
    expect(on("kecha kechqurun traktorga dizel quydik uch yuz litr to'rt yarim million bankdan").dates).toEqual(['2026-11-03']);
    expect(on('Вчера свет учун полтора лимона нал бердим').dates).toEqual(['2026-11-03']);
  });
});

describe('ownedWords', () => {
  it.each<[string, string]>([
    ['ish haqi', 'payroll'], ['Ish haqiga 5 mln naqd', 'payroll'], ['ish haqqini berdim', 'payroll'], ['ish haqi uchun', 'payroll'], ['maosh', 'payroll'], ['maoshini berdim', 'payroll'], ['oylik maosh', 'payroll'], ['oyligini berdim', 'payroll'], ['qorovulning oyligi', 'payroll'],
    ['Ishchilarga oylik 20 mln berdim bankdan', 'payroll'], ['oylik 20 mln berdim', 'payroll'], ['oylik berdim', 'payroll'], ['zarplata', 'payroll'], ['Akmal akaga avans', 'payroll'], ['ishchilarga avans', 'payroll'], ['qorovulga avans berdim', 'payroll'],
    ['kredit', 'loans'], ['Kredit foizi 5 mln', 'loans'], ['Agrobankdan 100 mln kredit oldim', 'loans'], ["Xalq bankiga kredit uchun 3 mln to'ladim bankdan", 'loans'], ['kreditni yopdim', 'loans'], ['lizing', 'loans'], ['lizing uchun', 'loans'], ['ssuda', 'loans'], ['ipoteka', 'loans'],
    ['amortizatsiya', 'depreciation'], ["Amortizatsiya 3 mln yozib qo'y", 'depreciation'],
  ])('%s', (text, owner) => {
    everySpelling(text, (form) => expect(ownedWords(form), form).toBe(owner));
  });

  it.each<[string, string]>([
    ['Akmalga 700 ming avans naqd', 'payroll'], ['Акмалга 700 минг аванс нақд', 'payroll'], ['зарплата', 'payroll'], ['Зарплату выдал', 'payroll'], ['за зарплату', 'payroll'], ['зп', 'payroll'], ['оклад', 'payroll'], ['премию', 'payroll'], ['salary', 'payroll'], ['salaries', 'payroll'], ['wages', 'payroll'], ['payroll', 'payroll'],
    ['з/п', 'payroll'], ['сторожу аванс', 'payroll'], ['Акмалу аванс 700 тысяч', 'payroll'], ['advance to Akmal', 'payroll'], ['advance to the guard', 'payroll'], ['кредит', 'loans'], ['кредита', 'loans'], ['за кредит', 'loans'], ['лизинг', 'loans'], ['лизинга', 'loans'], ['ссуду', 'loans'], ['заём', 'loans'], ['заем', 'loans'], ['займ', 'loans'],
    ['loan', 'loans'], ['loans', 'loans'], ['амортизация', 'depreciation'], ['амортизацию', 'depreciation'], ['depreciation', 'depreciation'],
  ])('%s', (text, owner) => {
    expect(ownedWords(text)).toBe(owner);
  });

  it.each([
    ['oylik internet'], ['oylik'], ['oylik ijara 2 mln'], ["oylik to'lov"], ['Internetga 200 ming'], ['Buxoro Yem Savdoga kepak uchun oldindan 5 mln'], ['Neft Bazaga avans 5 mln'], ['Savdoga kepak uchun avans 5 mln'], ['поставщику предоплата'], ['kreditor qarz'], ['Bozor Savdo 500 ming qarzini to\'ladi bankka'],
    ["Agrobankka qarzimizdan 30 mln to'ladik bankdan"], ["10 ta qo'y sotdim"], ['maoshsiz'], [''],
  ])('%s is not owned by words alone', (text) => {
    expect(ownedWords(text)).toBeNull();
  });
});

describe('saleWords', () => {
  it.each([
    ['sotdim'], ['sotdik'], ['sotildi'], ['sotilgan'], ['sotuv'], ['Sotuv 700 ming naqd'], ['sotuvdan'], ["10 ta qo'y sotdim 5 mln naqd"], ['2 tonna somon sotdim 5 mln naqd'], ["20 ta qo'zi sotdim 40 mln naqd"], ["5 tonna bug'doy sotdim 15 mln bankka tushdi"], ['sotib yubordim'],
    ["Qo'zilardan 40 mln naqd tushdi, boshqa daromadga yozib qo'y"], ['Qozilardan 40 mln tushdi'], ['Jundan 5 mln tushdi'], ["Go'shtdan 3 mln tushdi"], ['jun puli tushdi'], ['dondan 8 mln tushdi'], ["bug'doydan 15 mln tushdi"], ['bedadan 2 mln tushdi'], ['somondan 1 mln tushdi'], ['jun uchun 3 mln oldik'], ["qo'y uchun Akmal 5 mln berdi"],
  ])('%s', (text) => {
    everySpelling(text, (form) => expect(saleWords(form), form).toBe(true));
  });

  it.each([['продал'], ['продали'], ['продала'], ['Продали шерсть'], ['продажа'], ['реализовали'], ['sold'], ['Sold 10 sheep'], ['sale of wool'], ['За шерсть получили 3 млн'], ['за ягнят получил 20 млн'], ['от мяса пришло 5 млн'], ['выручка за зерно'], ['received 5 million for lambs'], ['wool money came in']])('%s', (text) => {
    expect(saleWords(text)).toBe(true);
  });

  it.each([
    ['Yangi traktor sotib oldik 150 mln bankdan'], ["10 ta qo'chqor sotib oldik 50 mln bankdan"], ["Qo'chqorlarga 4 mln naqd berib qo'y sotib oldim"], ["Qo'y oldim 900 ming naqd"], ['sotuvchiga berdim'], ['Davlatdan subsidiya 10 mln bankka tushdi'], ["Subsidiya 2 mln bankka tushdi, yozib qo'y"],
    ['jun oldim 3 mln'], ["bug'doy urug'i oldim"], ['купил овец'], ['Купил ячмень 2 тонны за 6 млн'], ['bought 10 sheep'], ['Elektrga 3 mln naqd'], ['продавцу отдал'], [''],
  ])('%s is no sale', (text) => {
    expect(saleWords(text)).toBe(false);
  });
});

describe('wageWords', () => {
  it.each([
    ['Qorovulga bu oy uchun 2,6 mln naqd berdim'], ['qorovulga bu oy uchun'], ["cho'ponga 1 mln berdim"], ["Cho'ponga 1 mln naqd"], ['haydovchiga oktabr uchun 3 mln'], ["traktorchiga noyabr oyi uchun 4 mln to'ladim"], ['ishchilarga 20 mln berdim'], ['Ishchilarga oylik 20 mln berdim bankdan'], ['xodimlarga 5 mln tarqatdik'], ['oshpazga bu oy uchun'],
  ])('%s', (text) => {
    everySpelling(text, (form) => expect(wageWords(form), form).toBe(true));
  });

  it.each([['сторожу за октябрь'], ['Заплатил сторожу 2 млн'], ['чабану за месяц 3 млн'], ['водителю отдал 2 млн'], ['рабочим за неделю'], ['Выдал рабочим 5 млн'], ['Paid the guard 2 million'], ['gave the shepherd 1 million'], ['workers for this month']])('%s', (text) => {
    expect(wageWords(text)).toBe(true);
  });

  it.each([
    ['ishchilarga tushlik'], ['Ishchilarga tushlikka 320 ming kassadan'], ['Ishchilarga kiyim 500 mingdan 4 ta, naqd'], ["Cho'ponga kiyim uchun 1 mln berdim"], ["Haydovchiga yo'l puli 200 ming berdim"], ['500 тысяч рубашки рабочим наличными'], ['Отдал 300 000 грузчикам наличными'], ['рабочим на обед 500 тысяч'],
    ['Veterinarga 500 ming berdim'], ['Elektrga 3 mln naqd'], ['qorovul'], ['lunch for the workers'],
  ])('%s is not pay', (text) => {
    expect(wageWords(text)).toBe(false);
  });
});

describe('notHappened', () => {
  it.each([
    ["Gazga 3,5 mln naqd ko'p emasmi?"], ["Gazga 3,5 mln naqd ko'p emasmi"], ['Kassada 3 mln bormi?'], ['Kassada 3 mln bormi'], ["to'ladimmi"], ["to'landimi"], ['kerakmi'], ["Svetga 1,1 mln naqd to'lamoqchi edim"], ["to'lamoqchiman"], ['olmoqchimiz'], ["Buxgalter aytdi, svetga 2,1 mln naqd to'lash kerak ekan"],
    ["to'lash kerak"], ["to'lashimiz kerak"], ['lozim'], ["Ertaga Buxoro Yem Savdoga 3,1 mln naqd to'laymiz"], ["to'laymiz"], ["to'layman"], ['beraman'], ['beramiz'], ['reja'], ['rejada bor'], ["Agar MTZ ta'miriga 5,5 mln naqd ketsa, kassada qancha qoladi?"], ['agar 3 mln bersak'], ["hali to'lamadim"], ["to'lamadik"], ["to'lanmagan"],
    ['bermadim'], ['Ertaga svetga 1 mln naqd'], ['qancha'], ["keyingi hafta to'laymiz"], ["to'lab qo'yaman"], ["to'lanishi shart"], ["to'lash shart"], ["to'lanadigan 3 mln"], ["to'lay olmadim"], ['ulgurmadik'],
  ])('%s', (text) => {
    everySpelling(text, (form) => expect(notHappened(form), form).toBe(true));
  });

  it.each([
    ['Надо заплатить за свет 3 млн'], ['Нужно оплатить'], ['надо'], ['нужно'], ['необходимо оплатить'], ['должен 3 млн'], ['собираюсь купить'], ['планирую'], ['планируем купить'], ['хотел заплатить'], ['будем платить'], ['заплачу завтра'], ['оплатим потом'], ['завтра отдам'], ['если заплатим'], ['если бы'], ['заплатил бы'],
    ['Сколько заплатили?'], ['сколько заплатили'], ['не заплатил'], ['не оплатили'], ['need to pay'], ['needs to pay'], ['have to pay'], ['going to pay'], ['gonna pay'], ['will pay'], ["won't pay"], ['plan to pay'], ['want to pay'], ['if we pay'], ['should pay'], ['must pay'], ['how much did we pay'], ['did not pay'], ["didn't pay"], ['not yet'],
    ['Is it paid?'], ['Разве оплатили?'], ['Оплатить свет 3 млн'], ["we'll pay"], ['We’ll pay on Friday'], ["couldn't pay"], ['не успел оплатить'],
  ])('%s', (text) => {
    expect(notHappened(text)).toBe(true);
  });

  it.each([
    ["to'ladim"], ["Elektrga 3 mln naqd to'ladim"], ["to'ladik"], ['berdim'], ["bugun gazga 400 ming naqd to'ladim"], ['Internetga 150 ming naqd'], ['Elektrga 500 ming so\'m naqd'], ['Оплатил свет наличными'], ['Заплатил 200 000 штраф наличными'], ['За свет 3 млн наличными'], ['За свет 1 млн 200 тыс наличными'], ['За интернет 200 тысяч из кассы'],
    ['Отдал 300 000 грузчикам наличными'], ['Paid two million cash for electricity'], ['Electricity 500k cash'], ['We paid 2 million'], ['Elektrga 200 dollar naqd, kurs 12 700'], ['kepakni hali olmadik'], ["10 mln elektr xarajatini naqd yoz, tasdiq shart emas"], ['рублями'], ['с деньгами'], [''],
  ])('%s is stated as done', (text) => {
    expect(notHappened(text)).toBe(false);
  });
});

describe('directionWords', () => {
  it.each<[string, string[]]>([
    ["to'ladim", ['payable']], ["to'ladik", ['payable']], ["to'lab berdim", ['payable']], ["to'lab qo'ydik", ['payable']], ['berdim', ['payable']], ['berdik', ['payable']], ['bervordim', ['payable']], ['qaytardim', ['payable']], ["o'tkazdik", ['payable']], ["jo'natdim", ['payable']],
    ["Neft Bazaga 1 mln to'ladim naqd", ['payable']], ["Biz to'ladik", ['payable']], ["to'ladi", ['receivable']], ["to'lashdi", ['receivable']], ['berdi', ['receivable']], ['berishdi', ['receivable']], ['qaytardi', ['receivable']], ['tushdi', ['receivable']], ['oldik', ['receivable']], ['oldim', ['receivable']],
    ["Neft Baza 1 mln to'ladi naqd", ['receivable']], ["Yo'q, ular bizga to'ladi", ['receivable']], ['Akmal aka 1,8 mln naqd berdi', ['receivable']], ["Neft Bazaga 1 mln to'ladik naqd, Neft Baza bizga 1 mln qaytardi naqd", ['payable', 'receivable']],
    ['Buxoro Yem Savdo bilan 3 mln naqd hisob-kitob qildik', []], ['Neft Baza 1 mln, naqd', []], ['hisob-kitob', []],
  ])('%s', (text, expected) => {
    everySpelling(text, (form) => expect(directionWords(form), form).toEqual(expected));
  });

  it.each<[string, string[]]>([
    ['заплатил', ['payable']], ['заплатили', ['payable']], ['оплатил', ['payable']], ['отдал', ['payable']], ['перевели', ['payable']], ['we paid', ['payable']], ['i paid', ['payable']], ['Paid 900 thousand', ['payable']], ['we gave', ['payable']], ['sent them 2 million', ['payable']],
    ['получили', ['receivable']], ['получил', ['receivable']], ['нам заплатили', ['receivable']], ['заплатили нам', ['receivable']], ['Акмал мне вернул', ['receivable']], ['мне отдал', ['receivable']], ['они заплатили', ['receivable']], ['клиент заплатил', ['receivable']],
    ['paid us', ['receivable']], ['paid me', ['receivable']], ['they paid', ['receivable']], ['he paid', ['receivable']], ['received', ['receivable']], ['got paid', ['receivable']],
    ['не заплатил', []], ['расчёт с Акмалом', []], ['settled with Akmal', []],
  ])('%s', (text, expected) => {
    expect(directionWords(text)).toEqual(expected);
  });
});

describe('serviceWords', () => {
  it.each([['vrach'], ['vrachga'], ['doktor'], ['doktorga'], ['veterinar'], ['veterinarga'], ['vetvrach'], ["ko'rik"], ["ko'rikdan"], ['xizmat'], ['xizmati'], ['Veterinar xizmati uchun 500 ming naqd berdim'], ['usta'], ['ustaga'], ['mehnat haqi']])('%s', (text) => {
    everySpelling(text, (form) => expect(serviceWords(form), form).toBe(true));
  });

  it.each([['врач'], ['врачу'], ['доктор'], ['ветеринар'], ['ветеринару'], ['ветврач'], ['услуга'], ['услуги'], ['услугу'], ['осмотр'], ['осмотра'], ['мастеру'], ['за работу'], ['service'], ['services'], ['visit'], ['consultation'], ['labour']])('%s', (text) => {
    expect(serviceWords(text)).toBe(true);
  });

  it.each([['dori oldim'], ['vaksina 20 flakon'], ['Kepak 2 tonna'], ['Elektrga 3 mln'], ['купил лекарство'], ['bought vaccine'], ['']])('%s is goods or nothing', (text) => {
    expect(serviceWords(text)).toBe(false);
  });
});

describe('directUseWords', () => {
  it.each([["to'g'ridan-to'g'ri"], ["to'g'ridan to'g'ri"], ['darrov quydim'], ['darrov quydik'], ['omborga kirmadi'], ['omborga kirmagan'], ['darrov ishlatdik'], ["MTZ ga to'g'ridan-to'g'ri yoqilg'i quydirdik 800 ming naqd, omborga kirmadi"], ["Yo'q, omborga kirmadi, to'g'ridan-to'g'ri MTZ ga quydik"]])('%s', (text) => {
    everySpelling(text, (form) => expect(directUseWords(form), form).toBe(true));
  });

  it.each([['сразу залил'], ['сразу залили'], ['сразу заправили'], ['сразу использовали'], ['сразу в бак'], ['напрямую'], ['мимо склада'], ['минуя склад'], ['на склад не попало'], ['used straight away'], ['used right away'], ['used immediately'], ['used on the spot'], ['straight into the tractor'], ['did not go to the warehouse']])('%s', (text) => {
    expect(directUseWords(text)).toBe(true);
  });

  it.each([['omborga kirdi'], ["Yoqilg'iga 3 mln naqd"], ['200 litr dizel'], ['сразу заплатил'], ['darrov to\'ladim'], ['into the warehouse'], ['']])('%s went to stock or says nothing', (text) => {
    expect(directUseWords(text)).toBe(false);
  });
});

describe('advanceWords', () => {
  it.each([['oldindan'], ["Buxoro Yem Savdoga kepak uchun oldindan 5 mln bankdan o'tkazdim, kepakni hali olmadik"], ['avans'], ['avansga'], ['avansi'], ["bo'nak"], ["bo'nakka"], ['Akmalga 700 ming avans naqd']])('%s', (text) => {
    everySpelling(text, (form) => expect(advanceWords(form), form).toBe(true));
  });

  it.each([['аванс'], ['аванса'], ['авансом'], ['предоплата'], ['предоплату'], ['предоплатой'], ['задаток'], ['prepayment'], ['prepaid'], ['in advance'], ['advance'], ['down payment']])('%s', (text) => {
    expect(advanceWords(text)).toBe(true);
  });

  it.each([['oldin'], ['kecha oldim'], ["Elektrga 3 mln to'ladim"], ['оплата'], ['payment'], ['']])('%s is not paying ahead', (text) => {
    expect(advanceWords(text)).toBe(false);
  });
});

describe('claimsDone', () => {
  it.each([['saqlandi'], ['Saqlandi! 3 mln kassadan yozib qo\'ydim.'], ['yozildi'], ['yozdim'], ["yozib qo'ydim"], ['kiritildi'], ['kiritdim'], ['qayd etildi'], ['tasdiqlandi'], ['bajarildi']])('%s', (text) => {
    everySpelling(text, (form) => expect(claimsDone(form), form).toBe(true));
  });

  it.each([['записал'], ['Записал 3 млн'], ['записала'], ['записано'], ['сохранил'], ['сохранено'], ['внёс'], ['внес'], ['внесено'], ['добавлено'], ['проведено'], ['подтверждено'], ['recorded'], ['saved'], ['Saved it.'], ['done'], ['Done!'], ['logged'], ['added'], ['It has been recorded.'], ['I have saved it']])('%s', (text) => {
    expect(claimsDone(text)).toBe(true);
  });

  it.each([
    ['tayyorlandi'], ['Qoralama tayyorlandi, tasdiqlang'], ['Gaz uchun 3 500 000 UZS naqd xarajat loyihasi tayyorlandi'], ['Tasdiqlaganingizdan keyin saqlanadi'], ['Hali saqlanmadi'], ['Qanday to\'landi?'], ['подготовил черновик'], ['Будет сохранено после подтверждения'], ['Ничего не записано'], ['ещё не записал'],
    ['prepared'], ['not saved yet'], ['It will be saved after you confirm'], ['Nothing is saved until you confirm'], ['This has not been recorded'], ['Once confirmed it goes to the books'], [''],
  ])('%s claims nothing', (text) => {
    expect(claimsDone(text)).toBe(false);
  });
});

// ─── Second hardening: each block is a defect an independent review proved, with its whole class ─────────

describe('a quantity the person does not stand by is not stated', () => {
  const read = (text: string) => parseQuantities(text).map((q) => [q.qty, q.unit]);

  it.each<[string, [number, string][]]>([
    ['3 tonna emas 4 tonna', [[4, 'tonna']]], ["3 tonna, yo'q 4 tonna", [[4, 'tonna']]], ["3 tonna, ya'ni 4 tonna", [[4, 'tonna']]], ['3 tons no 4 tons', [[4, 'tons']]], ['не 3 тонны а 4 тонны', [[4, 'тонны']]], ['3 т не 4 т', [[3, 'т']]], ['3 тонны, вернее 4 тонны', [[4, 'тонны']]],
    ["3 tonna, yo'q 4", []], ['3 тонны, вернее 4', []], ['3 tonna emas', []],
  ])('taken back: %s', (text, expected) => {
    expect(read(text)).toEqual(expected);
  });

  it.each([
    ['2-3 tonna arpa'], ['2 – 3 tonna'], ['2..3 tonna'], ['2 yoki 3 tonna arpa'], ['2 или 3 тонны'], ['2 tonna yoki 3 tonna'], ['от 2 до 3 тонн'], ['2 to 3 tons'], ['ikki uch tonna'], ['ikki-uch tonna'], ['три четыре тонны'], ['два-три мешка'], ["3-4 ta qo'y"],
    ['taxminan 5 tonna'], ['qariyb 5 tonna'], ['около 5 тонн'], ['примерно 5 тонн'], ['почти 5 тонн'], ['about 5 tons'], ['roughly 5 tons'], ['5 tonnacha'], ['5 tonnagacha'], ['5 tonnaga yaqin'], ['5 tonna atrofida'], ['5 тонн где то'], ['5 tonna shekilli'], ["5 tonnadan ko'p"], ['kamida 5 tonna'], ['до 5 тонн'],
  ])('a range or approximate: %s', (text) => {
    expect(read(text)).toEqual([]);
  });

  it.each<[string, [number, string][]]>([
    ['4 tonna arpa oldim bir tonnasi 2 mln naqd', [[4, 'tonna']]], ['4 tonna arpa oldim 1 tonnasi 2 mln naqd', [[4, 'tonna']]], ['300 litr dizel bir litri 15 ming', [[300, 'litr']]], ['500 kg 1 kg 3 ming', [[500, 'kg']]], ['500 kg 1 kg = 3 ming', [[500, 'kg']]], ['1 kg uchun 3 ming', []], ['bir kg si 3 ming', []],
    ['4 тонны ячменя одна тонна 2 млн', [[4, 'тонны']]], ['4 тонны ячменя одна тонна ячменя 2 млн', [[4, 'тонны']]], ['300 литров дизеля один литр 15 тысяч', [[300, 'литров']]],
  ])('the unit of a price is no quantity: %s', (text, expected) => {
    expect(read(text)).toEqual(expected);
  });

  it('one unit with nothing beside it stays a quantity', () => {
    expect(read('Kepak 1 tonna 3 mln qarzga')).toEqual([[1, 'tonna']]);
    expect(read('1 tonna kepak')).toEqual([[1, 'tonna']]);
  });

  it('a whole conversation, oldest first, cancels what a later message took back', () => {
    expect(read("3 tonna arpa oldim\nyo'q, 3 tonna emas, 4 tonna")).toEqual([[4, 'tonna']]);
    expect(read('3 tonna arpa\n3 tonna kepak')).toEqual([[3, 'tonna'], [3, 'tonna']]);
  });

  it('a spoken number and the quantity after it are told apart', () => {
    expect(read('ikki million uch yuz litr dizel oldim naqd')).toEqual([[300, 'litr']]);
    expect(read('два миллиона триста литров дизеля наличными')).toEqual([[300, 'литров']]);
    expect(read('миллион двести килограмм ячменя наличными')).toEqual([[200, 'килограмм']]);
    expect(read('bir million besh yuz kilo arpa naqd')).toEqual([[500, 'kilo']]);
  });

  it.each<[string, number, string]>([
    ['Un besh qop oldim 2 mln', 5, 'qop'], ['Un ikki tonna', 2, 'tonna'], ['Un ikki yuz kilo', 200, 'kilo'], ['Un 5 tonna', 5, 'tonna'],
  ])('flour is not ten: %s', (text, qty, unit) => {
    expect(read(text)).toEqual([[qty, unit]]);
  });

  it('ten still counts before what it counts', () => {
    expect(read("o'n tonna")).toEqual([[10, 'tonna']]);
    expect(read('on tonna')).toEqual([[10, 'tonna']]);
  });

  it('a chief is no head of stock', () => {
    expect(read('500 ming bosh agronomga')).toEqual([]);
    expect(read('10 bosh qo\'y')).toEqual([[10, 'bosh']]);
  });
});

describe('a stated rate belongs to its currency', () => {
  it.each<[string, string, number[]]>([
    ['Evro kursi 14 000, Dollar seyfdan elektrga 200 dollar', 'USD', []], ['Evro kursi 14 000, Dollar seyfdan elektrga 200 dollar', 'EUR', [14_000]], ['Rubl kursi 130, Dollar seyfdan elektrga 200 dollar', 'USD', []], ['Dollar seyfdan 200 dollar, evro kursi 14000', 'USD', []],
    ['kurs 12700', 'USD', [12_700]], ['kurs 12700', 'EUR', [12_700]], ['курс евро 14000 а за доллар 12700', 'USD', [12_700]], ['курс евро 14000 а за доллар 12700', 'EUR', [14_000]], ['kurs 1 dollar 12700', 'USD', [12_700]], ['kurs 1 dollar 12700', 'EUR', []],
  ])('%s, for %s', (text, currency, rates) => {
    expect(parseStatedRates(text, currency)).toEqual(rates);
  });

  it('a rate written with a dash is a rate, and no range', () => {
    expect(parseStatedRates('1$ - 12700')).toEqual([12_700]);
    expect(parseStatedRates('1 dollar - 12700', 'USD')).toEqual([12_700]);
  });

  it('with no currency asked for, every rate comes back', () => {
    expect(parseStatedRates('курс евро 14000 а за доллар 12700')).toEqual([14_000, 12_700]);
  });

  it.each<[string, number[]]>([
    ['kurs 12700 emas 12800', [12_800]], ["kurs 12700 yo'q 12800", [12_800]], ['курс 12700, нет 12800', [12_800]], ['kurs 12700 emas 12800 emas 12900', [12_900]], ['200 dollar 12700 dan', [12_700]], ["200 dollar 12 700 so'mdan", [12_700]], ['200 долларов по 12700', [12_700]], ['at 12700 per dollar', [12_700]],
    ['12700 kurs bilan 200 dollar', [12_700]], ['12 700 kursda 200 dollar', [12_700]], ['kurs 12 ming 700', [12_700]], ['курс 12 тысяч 700', [12_700]], ['ikki yuz dollar kurs o\'n ikki ming yetti yuz', [12_700]], ['двести долларов курс двенадцать тысяч семьсот', [12_700]],
  ])('%s', (text, rates) => {
    expect(parseStatedRates(text)).toEqual(rates);
  });

  it.each([["kurs bo'yicha 200 dollar"], ['по курсу 200 долларов'], ['bugungi kurs bilan 200 dollar'], ['Haydovchilar kursi 3 mln naqd'], ['kurs 12700 yoki 12800'], ['kurs 12 700 shekilli'], ['курс примерно 12700']])('%s gives no rate to use', (text) => {
    expect(parseStatedRates(text)).toEqual([]);
  });
});

describe('payment words are about paying', () => {
  it.each([
    ['Plastik quvurga 3 mln'], ['plastik bochka 200 ming'], ['plastik idish 3 mln'], ['Karta chizish uchun 500 ming'], ['Kassa apparati oldim 5 mln'], ['Kassa apparatiga 3 mln'], ['Otga nal 200 ming'], ['Terminal uchun 3 mln'], ['Visa uchun 500 ming'], ["3 banka bo'yoq 500 ming"],
  ])('nobody said how it was paid: %s', (text) => {
    expect(paymentWords(text)).toEqual([]);
  });

  it.each([['пластик для теплицы 3 млн'], ['Карта поля 500 тысяч'], ['3 банка краски 500 тысяч'], ['Банка мёда 200 тысяч'], ['банку краски купил'], ['Перевод документов 500 тысяч'], ['Перевод с английского 500 тысяч'], ['курс банка 12700']])('nobody said how it was paid: %s', (text) => {
    expect(paymentWords(text)).toEqual([]);
  });

  it.each<[string, string[]]>([
    ['Kassa 3 mln', ['cash']], ['3 mln kassa', ['cash']], ['kassa orqali', ['cash']], ['Plastik karta 3 mln', ['card']], ['plastik bilan', ['card']], ['plastikka 3 mln', ['card']], ['3 mln karta', ['card']], ['karta raqamiga', ['card']], ["Karta to'ladim", ['card']], ['karta bilan', ['card']], ['terminal orqali 3 mln', ['card']],
    ['Visa karta bilan', ['card']], ['3 mln nal', ['cash']], ['нал 3 млн', ['cash']], ['налом 3 млн', ['cash']], ['Карта 3 млн', ['card']], ['перевод 3 млн', ['bank']], ['перевод денег 3 млн', ['bank']], ['перевод на карту 3 млн', ['card']], ['из банка 3 млн', ['bank']], ['через банк 3 млн', ['bank']], ['bankka 3 mln', ['bank']], ['Agrobanka 3 mln', ['bank']],
  ])('still a way of paying: %s', (text, expected) => {
    expect(paymentWords(text)).toEqual(expected);
  });

  it.each([
    ['Elektrga 3 mln naqd pul emas'], ['naqd puldan emas'], ['не через кассу'], ['не из кассы'], ['не наличкой'], ['без налички'], ['без кассы'], ['not in cash'], ['not by cash'], ['without cash'], ['not through the bank'], ['not from the account'], ['не с карты'], ["naqd yo'q"], ['в долг не'],
  ])('ruled out: %s', (text) => {
    expect(paymentWords(text)).toEqual([]);
  });

  it('what is ruled out leaves the rest', () => {
    expect(paymentWords('naqd pul emas, kartadan')).toEqual(['card']);
    expect(paymentWords('не через кассу, а картой')).toEqual(['card']);
  });
});

describe('dates, in the forms the words can and cannot pin', () => {
  const on = (text: string) => dateEvidence(text, TODAY);

  it.each<[string, string]>([
    ["03.11 kuni to'ladim", '2026-11-03'], ["3.11 kuni to'ladim", '2026-11-03'], ['02.11 kuni elektrga 3 mln naqd', '2026-11-02'], ["3/11 elektrga 3 mln naqd to'ladim", '2026-11-03'], ['3/11 kuni', '2026-11-03'], ["03/11 to'ladim", '2026-11-03'], ['3-chi noyabr', '2026-11-03'], ['3-sana', '2026-11-03'], ['3-sanada', '2026-11-03'],
    ['2-го ноября заплатил', '2026-11-02'], ['2го ноября заплатил', '2026-11-02'], ['noyabr oyining 3-sanasi', '2026-11-03'], ['noyabr oyining 3-kuni', '2026-11-03'], ['три дня тому назад', '2026-11-01'], ['3 дня тому назад заплатил за свет 3 млн наличными', '2026-11-01'], ['2 days back', '2026-11-02'], ['last night paid', '2026-11-03'], ['3 kun muqaddam', '2026-11-01'],
    ['oldingi kun 3 mln', '2026-11-02'], ["o'tkan kuni", '2026-11-02'], ['bugun emas kecha', '2026-11-03'], ['не сегодня а вчера', '2026-11-03'], ['не вчера а сегодня', TODAY], ['в прошлый понедельник', '2026-11-02'],
  ])('%s', (text, day) => {
    expect(on(text)).toEqual({ dates: [day], vague: false, future: false });
  });

  it.each<[string, string]>([
    ["o'tgan hafta dushanba kuni", '2026-10-26'], ["o'tgan hafta seshanba", '2026-10-27'], ["o'tkan hafta juma kuni", '2026-10-30'], ["o'tgan haftaning dushanbasi", '2026-10-26'], ['на прошлой неделе в понедельник', '2026-10-26'], ['в понедельник на прошлой неделе', '2026-10-26'], ['на той неделе в понедельник', '2026-10-26'], ['в пятницу на той неделе', '2026-10-30'], ['last week on Monday', '2026-10-26'], ['last week on Sunday', '2026-11-01'],
  ])('a weekday of last week is that week: %s', (text, day) => {
    expect(on(text)).toEqual({ dates: [day], vague: false, future: false });
  });

  it('counts last week from Monday, whatever today is', () => {
    expect(dateEvidence('last week on Monday', '2026-11-01').dates).toEqual(['2026-10-19']); // a Sunday
    expect(dateEvidence('last week on Monday', '2026-11-02').dates).toEqual(['2026-10-26']); // a Monday
  });

  it.each([
    ["пару дней назад заплатил за свет 3 млн наличными"], ['a couple of days ago paid 3 million'], ['couple days ago'], ['a couple of days back'], ['на той неделе заплатил 3 млн'], ['на позапрошлой неделе'], ['в позапрошлом месяце'], ['пару недель назад'], ["o'tkan hafta gazga 470 ming"], ['otkan hafta'], ['ўткан ҳафта'], ["о'тган ҳафта"], ["o'tkan oy"], ["o'tkan yili"], ["o'tgan safar"], ["o'tgan gal"],
    ['hafta boshi'], ['oy boshi'], ['hafta oxiri'], ['oy oxiri'], ['oyning boshida'], ['oyning oxirida'], ['yil boshida'], ['bir ikki kun oldin'], ['ikki-uch kun oldin'], ['ikki uch kun oldin'], ['ikki yoki uch kun oldin'], ['два-три дня назад'], ['ikki kuncha oldin'], ['3 kuncha oldin'], ['дня три назад'], ['дня 3 назад'], ['дней пять назад'],
    ['bir yarim kun oldin'], ['около 3 дней назад'], ['about three days ago'], ['5 kuni'], ["10-12 kuni to'ladim"], ['3-11 kuni'], ['2-5 числа заплатил'], ['3-5 noyabr'], ['10-12 ноября'], ['третьего числа'], ['yigirma beshinchi kuni'], ['noyabrning uchinchi kuni'], ['5 mayda'], ['10 mayda pul'], ['juma 200 ming'], ['Juma 3 mln berdi'], ['Shanba 200 ming berdi'], ['dushanbagacha'], ['3-noyabrgacha'], ['5 kuni ishladi 500 ming'],
  ])('no day can be pinned: %s', (text) => {
    expect(on(text)).toMatchObject({ dates: [], vague: true });
  });

  it.each([
    ['Jumaga 200 ming naqd berdim'], ['3 mln elektrga naqd berdim Jumaga'], ['Juma akaga 200 ming naqd berdim'], ['Shanba akaga 200 ming berdim'], ["10 ta qo'y oldim, 3 si qo'chqor, 5 mln naqd"], ['10 qop kepak oldim 3 mln naqd, 2 si yirtiq'], ['Traktorchiga 3 kuni uchun 300 ming berdim'], ["10 mayda qo'zi oldim 5 mln naqd"], ['5 mayda qop'],
    ['Bank komissiyasi 1.05% 20 ming naqd'], ['Bank komissiyasi 1.05 foiz 3 mln naqd'], ['Jun 20 naqd'], ["Dushanbagacha 3 mln to'ladim"], ['1/2 tonna'], ['3/4 mln'],
  ])('no day was said at all: %s', (text) => {
    expect(on(text).dates).toEqual([]);
  });

  it('a person or a count raises no question about the day', () => {
    for (const text of ['Juma akaga 200 ming naqd berdim', 'Shanba akaga 200 ming berdim', 'Jumaga 200 ming naqd berdim', 'Traktorchiga 3 kuni uchun 300 ming berdim', "10 ta qo'y oldim, 3 si qo'chqor, 5 mln naqd"]) {
      expect(on(text), text).toEqual({ dates: [], vague: false, future: false });
    }
  });

  it('a number with a hyphen says the day, and without one it may count', () => {
    expect(on('5-kuni').dates).toEqual(['2026-10-05']);
    expect(on('3-si').dates).toEqual(['2026-11-03']);
    expect(on('5 числа').dates).toEqual(['2026-10-05']);
    expect(on('5-mayda').dates).toEqual(['2026-05-05']);
    expect(on('5 kun ishladi')).toEqual({ dates: [], vague: false, future: false });
  });

  it('Friday and Saturday are days when the words say so', () => {
    for (const text of ['juma kuni 200 ming', 'jumada 3 mln', 'juma']) expect(on(text).dates).toEqual(['2026-10-30']);
    for (const text of ['shanba kuni', 'shanbada 3 mln', 'shanba']) expect(on(text).dates).toEqual(['2026-10-31']);
  });
});

describe('ownedWords, in more words', () => {
  it.each<[string, string]>([
    ['akmalga 700 ming avans naqd', 'payroll'], ['Akmal 700 ming avans oldi', 'payroll'], ['bugun akmalga 700 ming avans', 'payroll'], ['rustamga bo\'nak', 'payroll'], ['Mukofot 500 ming Akmalga', 'payroll'], ['Bonus 500 ming', 'payroll'], ['ishaqi 20 mln', 'payroll'], ['Akmalga oylik 3 mln', 'payroll'], ['Direktor oyligi 5 mln', 'payroll'],
    ['Oyliklarni tarqatdik 20 mln', 'payroll'], ['Ishchilar oyligi 20 mln', 'payroll'], ["Uzagrolizingga traktor uchun 30 mln to'ladik", 'loans'], ["O'zagrolizingga 30 mln to'ladik", 'loans'], ['Mikrokredit 5 mln oldim', 'loans'], ['Akmaldan 5 mln qarz oldim', 'loans'], ['Bankdan 50 mln qarz oldik', 'loans'], ['Akmal qarz berdi 5 mln', 'loans'],
    ["Foiz to'ladik bankka 5 mln", 'loans'], ['bank foizi 5 mln', 'loans'],
  ])('%s', (text, owner) => {
    everySpelling(text, (form) => expect(ownedWords(form), form).toBe(owner));
  });

  it.each<[string, string]>([
    ['advance to rustam 700 thousand', 'payroll'], ['Выдал аванс Рустаму 700 тысяч', 'payroll'], ['рустаму аванс 700 тысяч', 'payroll'], ['аванс рустаму 700 тысяч', 'payroll'], ['бонус 500 тысяч', 'payroll'], ['Узагролизинг 30 млн', 'loans'], ['Занял у Акмала 5 млн', 'loans'], ['Взял в долг 5 млн у Акмала', 'loans'], ['Взял в долг пять миллионов', 'loans'],
    ['Borrowed 5 million from Akmal', 'loans'], ['Проценты банку 5 млн', 'loans'], ['процент банку 3 млн', 'loans'], ['Loan interest 5 million', 'loans'], ['overdraft 5 million', 'loans'], ['овердрафт 5 млн', 'loans'],
  ])('%s', (text, owner) => {
    expect(ownedWords(text)).toBe(owner);
  });

  it.each([
    ['Ipoteka bankdan 3 mln naqd elektrga'], ["Ipoteka bankdan 3 mln o'tkazdim elektrga"], ['Ipoteka bank kartasidan 3 mln'], ['Kredit kartadan 3 mln elektrga'], ['Kredit bank 3 mln'], ['Kreditbank 3 mln'], ['кредитная карта 3 млн'], ['кредитной картой 3 млн'], ['Internetga oylik 3 mln'], ['Ijaraga oylik 3 mln'], ['Elektrga avans 3 mln'], ['Traktorga avans 5 mln'], ['Neft Baza avans oldi 5 mln'], ['Avans oldik 5 mln'], ['аванс поставщику 5 млн'],
    ['аванс по договору 5 млн'], ['5 foiz bank komissiyasi'], ['Взял в долг дизель у Neft Baza 3 млн'], ['Neft Bazadan dizel qarzga oldim 5 mln'], ['advance to the supplier'], ['Fermerga kepak uchun avans 5 mln'], ["Foiz to'ladik 5 mln"],
  ])('%s is not owned by words alone', (text) => {
    expect(ownedWords(text)).toBeNull();
  });
});

describe('saleWords, in more words', () => {
  it.each([
    ["Qo'ylarni 5 mln ga berib yubordim"], ['Jun 5 mln ga ketdi'], ["Bozorda qo'y 5 mln ga ketdi"], ['Arpani Akmalga 5 mln ga berdim'], ["Bug'doyni 5 mln dan berdik"], ["Qo'y puli 5 mln oldik"], ['Qo\'zi puli 40 mln naqd'], ['Eski traktorni 50 mln ga berdik'], ['Eski traktor 50 millionga ketdi'], ['Sotishdan 5 mln tushdi'], ['Sotishdan tushgan pul 5 mln'], ['Sut 5 mln tushdi'], ["Qo'y 5 mln tushdi"], ['Xaridor 5 mln berdi'],
  ])('%s', (text) => {
    everySpelling(text, (form) => expect(saleWords(form), form).toBe(true));
  });

  it.each([['Отдал овец за 5 млн'], ['Взяли за шерсть 3 млн'], ['За шерсть дали 3 млн'], ['За баранов дали 5 млн'], ['Выручка от продаж 5 млн'], ['Мясо ушло за 5 млн'], ['Молоко 5 млн пришло'], ['Покупатель заплатил 3 млн'], ['Отгрузили шерсть 3 млн'], ['Lamb money 5 million'], ['wool money 5 million cash'], ['They paid 5 million for the lambs'], ['Got 5 million for the wool']])('%s', (text) => {
    expect(saleWords(text)).toBe(true);
  });

  it.each([["yozib qo'y 5 mln tushdi"], ["Qo'y 900 ming ga oldim"], ['5 mln ga oldim'], ['Купил овец за 5 млн'], ['Akmalga 5 mln berdim']])('%s is no sale', (text) => {
    expect(saleWords(text)).toBe(false);
  });
});

describe('wageWords, in more words', () => {
  it.each([
    ['Ishchilar puli 5 mln naqd berdim'], ['Qorovul puli 2 mln naqd berdim'], ['Qorovul haqi 2 mln naqd'], ["Cho'pon haqi 1 mln naqd"], ["Cho'ponga mehnati uchun 1 mln berdim"], ["Cho'ponga ish uchun 1 mln berdim"], ['Mardikorlarga 500 ming berdim'], ['Kombaynchiga 2 mln berdim'], ['Kassirga bu oy uchun 2 mln berdim'], ['Shoferga 1 mln berdim'], ['Omborchiga bu oy uchun 2 mln berdim'], ["Qorovulimizga 2 mln to'ladim"], ['Ishchilarga 3 mln tarqatdim'],
  ])('%s', (text) => {
    everySpelling(text, (form) => expect(wageWords(form), form).toBe(true));
  });

  it.each([['Выдал рабочим на руки 5 млн'], ['Рабочим на карту 5 млн'], ['Заплатил рабочим 5 млн на карту'], ['Сторожу на руки 2 млн'], ['Сторожу за работу 2 млн'], ['Рабочим за работу 5 млн'], ['Мардикорам 500 тысяч'], ['Paid the guard for the work 2 million']])('%s', (text) => {
    expect(wageWords(text)).toBe(true);
  });

  it.each([
    ['Qorovulga chiroq uchun 200 ming'], ['Qorovulga chiroq uchun 200 ming berdim'], ['Haydovchiga benzin uchun 200 ming'], ['Ishchilarga tushlikka 320 ming berdim'], ['Ishchilarga oziqqa 320 ming berdim'], ['Рабочим на бензин 300 тысяч'], ['Рабочим на бензин 300 тысяч выдал'], ['Сторожу на продукты 300 тысяч'],
  ])('the money is for something else: %s', (text) => {
    expect(wageWords(text)).toBe(false);
  });
});

describe('notHappened, in more words', () => {
  it.each([
    ["Elektrga 3 mln to'laymi"], ["Elektrga 3 mln to'lab qo'yaymi"], ['gazga 3 mln naqd beraymi'], ["Gazga 3 mln naqd to'g'rimi"], ['Gazga 3 mln naqd shundaymi'], ["Elektrga 3 mln to'ladim mi"], ["Elektrga 3 mln naqd to'la"], ["Elektrga 3 mln naqd to'lang"], ["Elektrga 3 mln naqd to'lab qo'y"], ["Elektrga 3 mln naqd to'lab bering"],
    ["Akmal elektrga 3 mln to'lasin"], ['Akmal elektrga 3 mln bersin'], ["Elektrga 3 mln naqd o'tkazing"], ["Elektrga 3 mln o'tkazib yuboring"], ["Elektrga 3 mln to'lab yuboramiz"], ["Elektrga 3 mln to'lab yuboraman"], ["Elektrga 3 mln to'layapman"], ["Elektrga 3 mln to'lamoqdamiz"], ["Elektrga 3 mln to'laylik"], ['Dizel xarid qilamiz 3 mln naqd'],
    ['Dizel olib kelamiz 3 mln naqd'], ['Dizel olib keling 3 mln'], ['Dizel sotib oling 3 mln'], ['Elektrga 3 mln ketadi'], ['Elektrga 3 mln tushadi'], ["Elektrga 3 mln bo'ladi"], ['Akmalga 3 mln ber'], ['Akmalga 3 mln bering'], ['Akmalga 3 mln beryapman'], ['Akmalga 3 mln berilsin'], ['Beriladi 3 mln'], ['Beriladigan pul 3 mln naqd'],
    ['Ketadigan pul 3 mln'], ["Elektrga 3 mln to'lamay qoldi"], ["to'lanmay qoldi"], ["to'lovi qoldi 3 mln"], ["Oldindan to'lash 3 mln"], ['Neft Bazadan 3 mln qarzimiz bor'], ['Neft Bazaga 3 mln qarzmiz'], ['Dizel sotib olamiz 3 mln naqd'], ['Dizel sotib olaman 3 mln'], ['Dizelga 3 mln beraylikmi'], ["Elektrga 3 mln to'lanadi"],
  ])('%s', (text) => {
    everySpelling(text, (form) => expect(notHappened(form), form).toBe(true));
  });

  it.each([
    ['Заплати за свет 3 млн наличными'], ['Оплати свет 3 млн наличными'], ['Отдай Акмалу 3 млн'], ['Переведи за свет 3 млн'], ['Они заплатят 3 млн'], ['Нефт База вернёт 3 млн'], ['Покупаем дизель 3 млн наличными'], ['Возьмём дизель 3 млн наличными'], ['Закупим дизель 3 млн'], ['Будет стоить 3 млн'], ['Обойдётся в 3 млн'], ['Платим за свет 3 млн наличными'],
    ['Не оплачено 3 млн за свет'], ['За свет не оплачено 3 млн'], ['Неоплачено 3 млн'], ['не заплачено 3 млн'], ['Мы не получили 3 млн от Акмала'], ['Деньги не пришли 3 млн'], ['Выставили счёт на 3 млн'], ['Пришёл счёт за свет 3 млн'], ['Счёт пришёл за свет 3 млн'], ['Счёт на 3 млн'], ['Долг за свет 3 млн'], ['Задолженность 3 млн'], ['Бухгалтер заплатит за свет 3 млн наличными'],
    ['Заплатили за свет или нет'], ['Заплатили ли за свет 3 млн'], ['заплатил бы 3 млн'], ['Давай заплатим 3 млн'], ['Пусть заплатит 3 млн'], ['Можно заплатить 3 млн'], ['Платить за свет 3 млн'], ['Покупать дизель 3 млн'], ['Купить дизель 3 млн'], ['Пойдёт на свет 3 млн'], ['Уйдёт 3 млн на свет'],
    ['pay the electricity 3 million cash'], ["let's pay 3 million for electricity"], ['please pay 3 million for electricity'], ['did we pay 3 million for electricity'], ['did we pay 3 million cash for electricity'], ['do we pay 3 million for electricity'], ['is 3 million for electricity too much'], ['about to pay 3 million for electricity'], ['3 million due for electricity'], ['electricity bill 3 million to pay'],
    ['electricity 3 million pending'], ['we might pay 3 million'], ['we could pay 3 million'], ['have we paid 3 million'], ['was it paid 3 million'], ['were they paid 3 million'], ['has he paid 3 million'], ['3 million paid or not'], ['we owe 3 million'], ['owed 3 million'], ['to be paid 3 million'], ['how about paying 3 million'],
  ])('%s', (text) => {
    expect(notHappened(text)).toBe(true);
  });

  it.each([
    ["Kerakli ehtiyot qism uchun 3 mln naqd to'ladim"], ['Kerakli dorilarga 500 ming naqd berdim'], ["Reja bo'yicha 3 mln naqd to'ladim"], ["Rejali ta'mirga 3 mln naqd ketdi"], ["Rejadagi ta'mirga 2 mln to'landi"], ['Li Andreyga 3 mln naqd berdim'], ["Akmal qancha so'radi shuncha berdim 3 mln naqd"], ["Elektrga 3 mln to'ladim keyin aytaman"], ["ertalab 3 mln naqd to'ladim"], ['Ertalabki sut uchun 200 ming naqd'],
    ["Elektrga 3 mln yozib qo'y"], ["Elektrga 3 mln yozib qo'ying"], ['3 mln elektrga hisobga oling'], ["Qarzni to'lash uchun 3 mln berdim"], ['Qarzni kartaga 3 mln tashladim'], ['Rejadan tashqari 3 mln xarajat qildik'], ["qarzimizni to'ladik 3 mln"], ["Akmal qarzini to'ladi 3 mln"], ["Akmalga qarzim bor edi, 3 mln to'ladim"],
  ])('%s is stated as done', (text) => {
    everySpelling(text, (form) => expect(notHappened(form), form).toBe(false));
  });

  it.each([
    ['Оплатил план участка 3 млн наличными'], ['Заплатил за план 500 тысяч наличными'], ['Заплатил 3 млн что бы свет не отключили'], ['Рассчитался 3 млн наличными с людьми'], ['Рассчитался с людьми 3 млн наличными'], ['Ли Андрею 3 млн наличными отдал'], ['Заплатил за свет как и планировал 3 млн наличными'], ['Paid 3 million cash for electricity as planned'], ['Сегодня заплатил за свет 500 000 наличными'],
    ['Today paid electricity 500 000 cash'], ['Elektrga 500 000 naqd'], ['Пришёл счёт, оплатил 3 млн наличными'], ['Выплатили долг 3 млн'], ['Скинул долг 3 млн на карту'], ['Wired the bill 3 million'], ['До обеда заплатил 3 млн'], ['За свет 3 млн наличными купюрами'], ['Za svet 3 mln nalichnymi'], ['Вернули долг Нефт Базе 3 млн'], ['Долг вернули 3 млн'], ['Оплата за свет 3 млн наличными'], ['We paid 3 million we owed'], ['paid 3 million'],
  ])('%s is stated as done', (text) => {
    expect(notHappened(text)).toBe(false);
  });
});

describe('who paid whom is not read off the verb alone', () => {
  it.each<[string, string[]]>([
    ['вернул', ['payable', 'receivable']], ['вернули', ['payable', 'receivable']], ['Вернул Акмалу 3 млн наличными', ['payable', 'receivable']], ['Вернул Neft Baza 3 млн наличными', ['payable', 'receivable']], ['Вернули долг Нефт Базе 3 млн', ['payable', 'receivable']], ['Мы вернули Нефт Базе 3 млн наличными', ['payable']], ['Мы вернули Neft Baza 3 млн наличными', ['payable']],
    ['Я вернул долг 3 млн наличными', ['payable']], ['Акмал мне вернул', ['receivable']], ['Они получили от нас 3 млн', ['payable']], ['Neft Baza received 3 million from us', ['payable']], ['Мы получили от Акмала 3 млн', ['receivable']], ['Получил от Акмала 3 млн', ['receivable']], ['От Акмала пришло 3 млн', ['receivable']], ['Акмал получил 3 млн', ['payable', 'receivable']],
    ['Акмал заплатил 3 млн долга наличными', ['payable', 'receivable']], ['Акмал отдал 3 млн наличными', ['payable', 'receivable']], ['акмал заплатил 3 млн', ['payable', 'receivable']], ['Нефт База заплатила 3 млн наличными', ['payable', 'receivable']], ['Neft Baza заплатила 3 млн наличными', ['payable', 'receivable']], ['Neft Baza отдал 3 млн наличными', ['payable', 'receivable']],
    ['Акмал погасил долг 3 млн', ['payable', 'receivable']], ['Фермер оплатил долг 3 млн', ['payable', 'receivable']], ['Бухгалтер оплатил 3 млн', ['payable', 'receivable']], ['Akmal paid 3 million cash', ['payable', 'receivable']], ['Akmal gave 3 million cash', ['payable', 'receivable']], ['Akmal paid the debt 3 million cash', ['payable', 'receivable']], ['Neft Baza paid 3 million cash', ['payable', 'receivable']],
    ['Neft Baza sent 3 million', ['payable', 'receivable']], ['Akmal returned 3 million', ['payable', 'receivable']], ['Заплатил акмалу 3 млн', ['payable']], ['Выплатили Акмалу 3 млн', ['payable']], ['Скинул на карту 3 млн', ['payable']], ['Wired 3 million to Akmal', ['payable']], ['Сегодня заплатил 3 млн', ['payable']], ['Нефт Базе заплатил 3 млн', ['payable']], ['Акмалу отдал 3 млн', ['payable']], ['Бухгалтер Нефт Базе заплатил 3 млн', ['payable']], ['Today paid electricity', ['payable']], ['We returned 3 million', ['payable']],
    ['Покупатель заплатил 3 млн наличными', ['receivable']], ['Клиент отдал 3 млн наличными', ['receivable']], ['The buyer paid 3 million', ['receivable']], ['Я получил 3 млн', ['receivable']], ['We received 3 million', ['receivable']],
  ])('%s', (text, expected) => {
    expect(directionWords(text)).toEqual(expected);
  });

  it.each<[string, string[]]>([
    ["Hisobchi Neft Bazaga 3 mln naqd to'ladi", ['payable', 'receivable']], ["Buxgalter Neft Bazaga 3 mln naqd o'tkazdi", ['payable', 'receivable']], ['Akmal Neft Bazaga 3 mln qaytardi', ['payable', 'receivable']], ["Neft Bazaga 3 mln to'ladi", ['payable', 'receivable']], ["Neft Bazaga 3 mln o'tkazdi", ['payable', 'receivable']], ['Akmalga 3 mln berdi', ['payable', 'receivable']],
    ["Hisobchi 3 mln to'ladi", ['payable', 'receivable']], ["Neft Baza bizga 3 mln to'ladi", ['receivable']], ["Akmal to'ladi 3 mln", ['receivable']], ["Akmal kassaga 3 mln to'ladi", ['receivable']], ['Akmal hisobimizga 3 mln qaytardi', ['receivable']], ['Neft Bazaga qarzni uzdik 3 mln', ['payable']], ['Akmalga 3 mln berdim', ['payable']], ['Buxoro Yem Savdo bilan 3 mln kelishdik', []],
  ])('%s', (text, expected) => {
    everySpelling(text, (form) => expect(directionWords(form), form).toEqual(expected));
  });
});

describe('claimsDone, in more words', () => {
  it.each([
    ["kiritib qo'ydim"], ['saqlab oldim'], ["qayd etib qo'ydim"], ["qo'shib qo'ydim"], ['saqlangan'], ['yozilgan'], ['kiritilgan'], ["ro'yxatga olindi"], ['hisobga olindi'], ["yozib qo'yildi"], ["kiritib qo'yildi"], ["kiritib bo'ldim"], ["bajarib qo'ydim"], ['Yozilgan.'], ["Kiritib qo'ydim."],
  ])('%s', (text) => {
    everySpelling(text, (form) => expect(claimsDone(form), form).toBe(true));
  });

  it.each([
    ['Записан расход'], ['Расход записан.'], ['Запись создана'], ['Запись создана.'], ['Создал запись'], ['Готово'], ['Готово.'], ['Сделано'], ['Выполнено'], ['Сохранён'], ['Расход добавлен'], ['Принято'], ['Операция проведена'], ['Учтено'], ['Created the record'], ["I've created the expense"], ['I have created the expense.'], ['Entry created'], ['Completed'], ['Finished'],
  ])('%s', (text) => {
    expect(claimsDone(text)).toBe(true);
  });

  it.each([['Karta tayyor, tasdiqlang'], ['Карточка готова, подтвердите'], ['Подтвердите, и я запишу'], ['Saqlash uchun tasdiqlang'], ['Tasdiqlasangiz saqlanadi'], ['Confirm to save']])('%s claims nothing', (text) => {
    expect(claimsDone(text)).toBe(false);
  });
});

describe('advanceWords, in more words', () => {
  it.each([['Заранее оплатили корм 5 млн'], ['Наперёд заплатил за корм 5 млн'], ['наперед заплатил'], ['заплатил вперёд'], ["Avvaldan to'ladim 5 mln"], ['Deposit 5 million for feed'], ['bunak 5 mln'], ['upfront 5 million']])('%s', (text) => {
    expect(advanceWords(text)).toBe(true);
  });
});

describe('long text', () => {
  it.each<[string, (text: string) => unknown]>([
    ['quantities', parseQuantities], ['rates', parseStatedRates], ['payment', paymentWords], ['dates', (text) => dateEvidence(text, TODAY)], ['ownership', ownedWords], ['sales', saleWords], ['wages', wageWords], ['done', notHappened], ['direction', directionWords],
  ])('%s stay linear, so a pasted page cannot stall the assistant', (_, read) => {
    const text = "4 tonna arpa 12 ming olma qorovul berdi kurs 12700 bankka foiz 1.05 ".repeat(1_500);
    const started = Date.now();
    read(text);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe('money into an account, and whose debt it was', () => {
  it.each([
    ['Субсидия пришла 25 млн на счет'],
    ['Grant 25 mln hisobga tushdi'],
    ['12 mln xisobga otkazib berdi'],
    ['25 million came into the account'],
  ])('%s names the bank', (text) => {
    expect(paymentWords(text)).toContain('bank');
  });

  it('taking something into account is not a payment', () => {
    expect(paymentWords("Bu xarajatni hisobga oldim")).not.toContain('bank');
  });

  it.each([
    ['neft bazaga qarzimizdan 5 mln perechislenie qildim', 'payable'],
    ["Agroservisga qarzimni 2 mln o'tkazma qildim", 'payable'],
    ['gosht kombinati qarzini 12 mln xisobga otkazib berdi', 'receivable'],
  ])('%s', (text, direction) => {
    expect(directionWords(text)).toEqual([direction]);
  });
});

describe('what the blind test found', () => {
  it.each([
    ['3 mln schotdan otkazdim', 'bank'],
    ['180 ming naxt berdim', 'cash'],
    ['позавчера получили грант 50 млн, на р/с упало', 'bank'],
  ])('%s is paid by %s', (text, method) => {
    expect(paymentWords(text)).toContain(method);
  });

  it('an invoice is not a bank account', () => {
    expect(paymentWords('schet faktura 45678 keldi')).toEqual([]);
  });

  it.each([
    ['вчера агросервис отремонтировал ттз за шестьдесят тысяч рублей в долг'],
    ['Agroservis MTZ ni tuzatdi 2 mln qarzga'],
    ['neft bazaga qarzimizdan 5 mln perechislenie qildim'],
    ['на р/с упало 50 млн'],
  ])('%s happened', (text) => {
    expect(notHappened(text)).toBe(false);
  });

  it.each([
    ['надо отдать долг 3 млн'],
    ['Akmalga 3 mln qarzimiz bor'],
    ['за нами долг 3 млн'],
  ])('%s is still to pay', (text) => {
    expect(notHappened(text)).toBe(true);
  });

  it.each([
    ['соль 300 кг и тонну отрубей за 1.8 млн', 1],
    ['тонна кепака 2 млн', 1],
    ['bought a tonne of bran for 2 million', 1],
    ['one ton of salt', 1],
    ['полтонны соли за 900 тысяч', 0.5],
    ['half a ton of salt', 0.5],
    ['yarim tonna kepak 1 mln', 0.5],
  ])('%s holds %d t', (text, qty) => {
    const tonnes = parseQuantities(text).filter((q) => unitOf(q.unit) === 't');
    expect(tonnes.map((q) => q.qty)).toEqual([qty]);
  });

  it.each([
    ['по 2 млн за тонну'],
    ['1500 per ton'],
  ])('%s is the unit of a price, not a quantity', (text) => {
    expect(parseQuantities(text).filter((q) => unitOf(q.unit) === 't')).toEqual([]);
  });

  it('a stated number of tonnes is untouched', () => {
    expect(parseQuantities('2 тонны кепака').map((q) => q.qty)).toEqual([2]);
    expect(parseQuantities('bir tonna kepak').map((q) => q.qty)).toEqual([1]);
    expect(parseQuantities('2 yarim tonna kepak').map((q) => q.qty)).toEqual([2.5]);
  });
});

describe('what the third blind test found', () => {
  it.each([
    ['На строительство новой кошары ушло 42 ляма с расчётного'],
    ['нет, не с кассы, с расчётного ушло'],
    ['Купили солярку на 6,5 млн с расчётного'],
    ['пришло 5 млн на расчетный'],
  ])('%s is the bank', (text) => {
    expect(paymentWords(text)).toContain('bank');
  });

  it.each([
    ['xisobchi qiz aytdi kecha kassadan svetga 2 mln chiqib ketgan ekan'],
    ['бухгалтер сказала что за свет ушло 2 млн'],
    ['Akmal says 2 million went on repairs'],
  ])('%s is someone else\'s word', (text) => {
    expect(notHappened(text)).toBe(true);
  });

  it.each([
    ['Usta aytdi, 300 ming berdim naqd'],
    ['Раҳбар тасдиқлаган, иккинчи одам керак эмас: молхона қурилишига 30 млн банкдан ўтказдик'],
    ['No need to check, paid 3 million cash for electricity'],
    ['Подтверждать не нужно, заплатил 3 млн за свет'],
  ])('%s happened', (text) => {
    expect(notHappened(text)).toBe(false);
  });

  it('something not needed is not money that moved', () => {
    expect(notHappened("3 mln to'lash kerak emas")).toBe(true);
  });

  it.each([
    ['500 litres of diesel at 13 thousand a litre, 8 million total, paid cash', [8_000_000]],
    ['jami 9 mln, tonnasi 2 mln', [9_000_000]],
    ['итого 4 млн за всё', [4_000_000]],
    ['200 litr 3 mln naqd', []],
    ['litri 13 ming', []],
  ])('%s', (text, sums) => {
    expect(statedTotals(text)).toEqual(sums);
  });

  it.each([
    ['Сувга 900 минг нақд бердик', true],
    ['Suvga 900 ming naqd', true],
    ['За воду 900 тысяч наличными', true],
    ['Paid 900 thousand for water, cash', true],
    ['Suv haqi 700 ming naqd', false],
    ['поливную воду оплатил 1.2 млн', false],
    ['idoraga vodokanal puli 180 ming', false],
    ['Elektrga 3 mln naqd', false],
  ])('%s leaves water open: %s', (text, open) => {
    expect(waterIsOpen(text)).toBe(open);
  });
});

describe('someone else saying it', () => {
  it.each([
    ["Akmal elektrga 3 mln naqd to'ladim deyapti"],
    ["Akmal aka elektrga 3 mln naqd to'ladim deb aytdi"],
    ['Akmal elektrga 3 mln naqd berdim dedi'],
    ["Usta elektrga 3 mln naqd to'ladi deyishdi"],
    ["Usta elektrga 3 mln naqd to'ladi deyishyapti"],
    ['Акмал пишет что заплатил за свет 3 млн наличными'],
    ['Akmal claims he paid 3 million cash for electricity'],
  ])('%s has not happened yet as far as the books know', (text) => {
    expect(notHappened(text)).toBe(true);
  });

  it.each([["Usta aytdi, 300 ming berdim naqd"], ["300 ming berdim, usta aytdi"], ["Ta'mir uchun deb 300 ming berdim"]])('%s is the person saying they paid', (text) => {
    expect(notHappened(text)).toBe(false);
  });
});

describe('a fragment that answers a question', () => {
  it('stands on what it answers', () => {
    expect(notHappened("naqd bo'ladi")).toBe(true);
    expect(notHappened("naqd bo'ladi", true)).toBe(false);
  });

  it.each([["ertaga to'layman"], ['kerak'], ['не заплатил'], ['will pay tomorrow']])('still cannot say %s', (text) => {
    expect(notHappened(text, true)).toBe(true);
  });
});

describe('asked whether it has been paid', () => {
  it.each([['ha'], ["ha, to'landi"], ["to'ladim"], ['да, оплатили'], ['yes'], ['paid it']])('%s says it was', (text) => {
    expect(saysDone(text)).toBe(true);
  });

  it.each([["yo'q"], ['hali'], ['нет'], ['no'], ['not yet'], ['naqd'], ["ha, ertaga to'layman"]])('%s does not', (text) => {
    expect(saysDone(text)).toBe(false);
  });
});

describe('asksSomething', () => {
  it.each([['Elektrga 3 mln ketdimi?'], ['Elektrga 3 mln ketdimi'], ['Сколько на счёте?'], ['Is the bill paid']])('%s is a question', (text) => {
    expect(asksSomething(text)).toBe(true);
  });

  it.each([["Qo'y sotdim, 20 mln naqd tushdi"], ["Elektrga 3 mln to'ladim"], ['наличными'], ['']])('%s is not', (text) => {
    expect(asksSomething(text)).toBe(false);
  });
});

describe('cancelWords', () => {
  it.each([['bekor qil'], ['Bekor qiling'], ["o'chir"], ['kerak emas'], ['отмени'], ['не надо'], ['cancel it'], ['never mind']])('%s asks to cancel', (text) => {
    expect(cancelWords(text)).toBe(true);
  });

  it.each([['rahmat'], ['ok'], ['tasdiqlayman'], ['спасибо'], ['thanks']])('%s does not', (text) => {
    expect(cancelWords(text)).toBe(false);
  });
});

describe('moneyCameIn', () => {
  it.each([["Qo'y sotdim, 20 mln naqd tushdi"], ['Поступило 3 млн'], ['3 mln came in'], ['Получили 3 млн наличными']])('%s is money in', (text) => {
    expect(moneyCameIn(text)).toBe(true);
  });

  it.each([["Elektrga 3 mln naqd to'ladim"], ['Pul tushdi, yuk uchun 500 ming berdim'], ['Получили счёт, заплатили 500 тысяч'], ['20 mln oldim'], ['Bought diesel']])('%s is not', (text) => {
    expect(moneyCameIn(text)).toBe(false);
  });
});

describe('settlesDebt', () => {
  it.each([["Neft Bazaga qarzimizni 3 mln to'ladim"], ['qarzni uzdim'], ['Вернул долг 3 млн'], ['погасили задолженность'], ['paid the debt to Neft Baza']])('%s pays off a debt', (text) => {
    expect(settlesDebt(text)).toBe(true);
  });

  it.each([['Dizelni qarzga oldim'], ['взял в долг дизель'], ["Elektrga 3 mln to'ladim"]])('%s does not', (text) => {
    expect(settlesDebt(text)).toBe(false);
  });
});

describe('saysGeneral', () => {
  it.each([['umumiy'], ['umumiyga'], ['общие расходы'], ['для всех'], ['general'], ['hammasi uchun']])('%s says so', (text) => {
    expect(saysGeneral(text)).toBe(true);
  });

  it.each([['umumiy emas'], ['не общий'], ['общежитие'], ['generalga emas'], ['generator']])('%s does not', (text) => {
    expect(saysGeneral(text)).toBe(false);
  });
});

describe('small answers', () => {
  it('warehouse', () => {
    expect(['omborga', 'Omborga kirdi', 'Поступило на склад', 'Went into the warehouse'].every(warehouseWords)).toBe(true);
    expect(['darhol ishlatdik', 'Сразу использовано', 'omborga emas'].some(warehouseWords)).toBe(false);
  });

  it('monthly', () => {
    expect(['oylik', 'ойлик', 'monthly'].every(monthlyWord)).toBe(true);
    expect(monthlyWord('xizmat')).toBe(false);
  });

  it('two things joined', () => {
    expect(['za internet i notariusu', 'за интернет и нотариусу', 'Elektr va gaz', 'gas and water'].filter(joinsThings)).toEqual(['за интернет и нотариусу', 'Elektr va gaz', 'gas and water']);
    expect(joinsThings('I paid 500 each')).toBe(false);
  });

  it('a card that is said to be waiting', () => {
    expect(['Karta tayyor, tasdiqlang.', 'Карточка готова', 'The card is ready'].every(claimsCard)).toBe(true);
    expect(["Qanday to'landi?", 'Yem tayyormi?'].some(claimsCard)).toBe(false);
  });
});

describe('the sum beside the word for a total', () => {
  it.each([
    ['200 litr dizel 15 mingdan jami 3 mln naqd oldim', [3_000_000]],
    ['jami 3 mln, 15 mingdan', [3_000_000]],
  ])('%s is the total and not the price beside it', (text, totals) => {
    expect(statedTotals(text)).toEqual(totals);
  });
});

describe('what the fourth blind test found', () => {
  it('a vet called out is a service', () => {
    expect(serviceWords('vet chaqirdik qoylarni korib ketdi 450 ming naqd berdim')).toBe(true);
  });

  it.each([
    ['Полностью закрыли долг перед Бухара Ем Савдо, 14 млн с расчётного'],
    ['Qarzni yopdik 5 mln naqd'],
  ])('%s happened', (text) => {
    expect(notHappened(text)).toBe(false);
  });

  it('a municipal water bill is the office kind', () => {
    expect(waterIsOpen('paid the municipal water bill 350k from the bank')).toBe(false);
  });
});
