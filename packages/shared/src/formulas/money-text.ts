/**
 * Finds the amounts of money a person actually wrote or said. The assistant may only record an
 * amount that this code found, so a model cannot invent one (docs/assistant.md, principle 3).
 *
 * It reads Uzbek Latin and Cyrillic, Russian and English, typed or transcribed from a voice note, with
 * digits, spoken numbers, scale words and shorthand. Every word is compared whole, after `fold`, so
 * "somon" (straw) is never so'm and "рубашки" is never roubles. A figure that may not be a plain total
 * is flagged rather than dropped or guessed at: a price per unit, a figure taken back, a range, a rate.
 * A false alarm costs one question, while a miss can put a wrong card in front of a tired person.
 */
import { APOSTROPHES, fold, hasPhrase, unitOf, wordList, wordSet, type Phrase } from './units';

export type MoneyCurrency = 'UZS' | 'USD' | 'EUR' | 'RUB';

export interface MoneyMention {
  amount: number;
  /** Null when no currency was stated. */
  currency: MoneyCurrency | null;
  /** The text as written. */
  raw: string;
  /** A plain number with no scale or currency, such as "500": it may not mean so'm at all. */
  bare: boolean;
  /** Offsets into the text as given. */
  start: number;
  end: number;
  /**
   * A price per unit, not a total: "tonnasi 2 mln", "boshiga 2 mln", "15 mingdan", "по 15 тысяч",
   * "15 thousand per litre". The canonical unit when known (units.ts: 't', 'l', 'kg', 'head'), 'bag' for
   * packaging, which converts to nothing, else 'unit'.
   */
  perUnit: string | null;
  /** The person took it back: "3 mln emas, 4 mln", "не 3, а 4", "not 3 but 4". */
  negated: boolean;
  /** Part of a range or a choice, approximate, or with a minus sign: "3-4 mln", "3 yoki 4 mln", "taxminan 3 mln". */
  uncertain: boolean;
  /** An exchange rate: "kurs 12 700", "1 dollar = 12 700 so'm", "200 dollar 12 700 dan". Never a record's amount. */
  rate: boolean;
  /** The foreign currency a rate was stated for, when the words say: "Evro kursi 14 000". */
  rateOf?: MoneyCurrency;
  /** A currency word this farm does not keep: tenge, yuan, манат. It must not become so'm. */
  unknownCurrency?: string;
}

// ─── Word lists, all compared after fold ────────────────────────────────────

const SCALES = new Map<string, number>(
  ([
    [1e3, 'ming*, thousand, thousands, тысяча, тысячи, тысячу, тысяч, тысячей, тысячам, тысячами, тысячах, тыс, тысч, тыщ, тыща, тыщи, тыщу, тыш, тышь, косарь, косаря, косарей'],
    [1e6, 'mln*, million*, millions, milyon*, miliyon*, millon*, миллион, миллиона, миллионов, миллиону, миллионы, миллионом, миллионах, лимон, лимона, лимонов, лимоны, лям, ляма, лямов, лямы, limon*, lyam*'],
    [1e9, 'mlrd*, milliard*, milyard*, billion, billions, миллиард, миллиарда, миллиардов, миллиарды'],
  ] as [number, string][]).flatMap(([value, source]) => [...wordSet(source)].map((key) => [key, value] as const)),
);
/** A scale that means "one of them" on its own: "миллион двести тысяч", "ming dollar". */
const SINGLE_SCALE = wordSet('ming, тысяча, тысячу, thousand, million, миллион, миллиард, milliard, billion');

const CURRENCIES = new Map<string, MoneyCurrency>(
  ([
    ['UZS', "so'm*, сумов, uzs"],
    ['USD', 'dollar*, dollor*, doller*, dalar*, dolr*, dollars, доллара, долларов, доллары, доллару, долларах, долларами, долларом, usd, долл, дол, бакс, бакса, баксов, баксы, baks, baksa, bucks'],
    ['EUR', 'evro*, euro, euros, eur'],
    ['RUB', 'rubl*, рубля, рублей, рублям, рублях, рублями, рублёв, рублев, rublei, руб, rub, ruble, rubles, rouble, roubles'],
  ] as [MoneyCurrency, string][]).flatMap(([code, source]) => [...wordSet(source)].map((key) => [key, code] as const)),
);
export const isMoneyCurrency = (value: unknown): value is MoneyCurrency => typeof value === 'string' && ['UZS', 'USD', 'EUR', 'RUB'].includes(value);

/** Written in front of the number as well as after it: "USD 200", "usd200". */
const CURRENCY_CODES = new Map<string, MoneyCurrency>([['usd', 'USD'], ['eur', 'EUR'], ['rub', 'RUB'], ['uzs', 'UZS']]);
const SYMBOLS = new Map<string, MoneyCurrency>([['$', 'USD'], ['€', 'EUR'], ['₽', 'RUB']]);
const OTHER_SYMBOLS = new Set(['£', '¥', '₸', '₺', '₴', '₩', '₹', '₼', '₾']);
const FOREIGN_CODES = new Set(['usd', 'eur', 'rub']);
const COUNTRY_OF_DOLLAR = wordSet('aqsh, сша, us, american, американских, американский');

const OTHER_CURRENCIES = wordSet(`
  tenge, tenga, yuan, юань, юаня, юаней, манат, манатов, манаты, manat*, lira*, лиры, лир, shmol*, ko'k*, сомони, somoni,
  funt*, фунта, фунтов, pound, pounds, dirham*, дирхам, дирхамов, dirhams, yen, иена, иен, йена, йен, won, вон, франк, франков, franc, francs,
  злотых, zloty, гривна, гривны, гривен, драм, драмов, лари, lari, rial*, riyal*, риал, риала, риалов, риял, рияла, риялов, тугрик, тугрика, тугриков, tugrik*, сомов,
  динар, динара, динаров, dinar*, рупий, рупия, rupiya*, шекель, шекелей, крон, тг, тнг, gbp, kzt, cny, rmb, try, aed, kgs, tjs, tmt, jpy, krw, uah, byn, gel, amd, chf, cad, aud, sar, inr`);

/** Stock is often counted in these, and none of them has a fixed weight. Only "qop": "kop" is "ko'p", many. */
const PACKAGING_SOURCE = `meshok*, мешок, мешка, мешков, мешки, bog', bog'i, bog'iga, quti*, karobka*, коробка, коробки, коробок, yashik*, ящик, ящика, ящиков,
  pachka*, пачка, пачки, пачек, shisha*, бутылка, бутылки, бутылок, bochka*, бочка, бочки, бочек, kanistr*, канистра, канистры, канистр,
  ampula*, ампула, ампулы, ампул, paket*, пакет, пакета, пакетов, rulon*, рулон, рулона, рулонов, bag, bags, sack, sacks, box, boxes,
  bottle, bottles, barrel, barrels, canister, canisters`;
export const PACKAGING = new Set([...wordSet('qop*').values()].filter((key) => key.startsWith('q')).concat([...wordSet(PACKAGING_SOURCE)]));

/** Counted in thousands too: "10 ming km". Not time, whose words read as the purpose of an amount: "500 ming oylik". */
const LARGE_COUNTS = wordSet(`
  km, metr, kub, kubometr, gektar, sotix, kishi, nafar, marta, kvt, kw, kwh, квтч, метр, метра, метров, куб, кубов, кубометр, кубометра, кубометров,
  гектар, гектара, гектаров, человек, людей, раз, раза, hectare, hectares, meter, meters, metre, metres, people, persons, times, m, м`);
/** Followed by one of these, a small number counts something else: time, land, people, times. */
const OTHER_COUNTS = new Set([...LARGE_COUNTS, ...wordSet(`
  kun*, kunlik, soat*, hafta*, oy*, yil*, yilgi, daqiqa*, minut*, gektar*, sotix*, km*, metr*, kub*, kubometr*, kishi*, nafar*, marta*,
  sonli, raqamli, nomerli, moto, motosoat*, dala*, yosh*, день, дня, дней, час, часа, часов, неделя, недели, недель, неделю,
  месяц, месяца, месяцев, месяцы, год, года, году, лет, мин, минут, минуты, мото, мотосоат, day, days, hour, hours, week, weeks, month, months, year, years, minute, minutes`)]);
/** "bosh agronom" is the chief agronomist, and no count of heads. */
const CHIEFS = wordSet("agronom*, hisobchi*, buxgalter*, muhandis*, mexanik*, zootexnik*, vrach*, shifokor*, veterinar*, direktor*, ofis*, bino*");

const PERCENT = wordSet('foiz*, процент, процента, процентов, проценты, процентах, percent, percents, pct, prosent*');
const ORDINAL_ENDINGS = wordSet('chi, nchi, inchi, st, nd, rd, th, й, го, я, е, х, ти, ый, ой, ая, ое');

/** A number after one of these is a name: "Dala 3", "Kamaz 5511". */
const NAMED_BY_NUMBER = wordSet('dala*, pivot*, kamaz*, mtz*, ttz*, юмз, зил, уаз, маз, belarus*, brigada*, blok*, uchastka*, участок, поле, sklad*, склад, ombor*, field, brigade');
/** The same as they are written on a plate, with no case ending: a number after these can be any length. */
const ON_A_PLATE = wordSet('dala, pivot, kamaz, mtz, ttz, юмз, зил, уаз, маз, belarus, brigada, blok, uchastka, участок, поле, sklad, склад, ombor, field, brigade');
/** A number after one of these identifies a document or a person. Only these forms: "Telefonga 30000" and "schetdan 1500000" are money. */
const ID_WORDS = wordSet(`
  faktura, fakturasi, schet, schyot, счёт, счет, счёту, счету, фактура, фактуры, invoice, inn, stir, инн, tel, тел, телефон, телефона, telefon, telefoni, nomer, nomeri,
  номер, номера, raqam, raqami, number, shartnoma, shartnomasi, dogovor, договор, договора, договору, contract, nakladnoy, накладная, накладной, chek, чек, чека, чеку, receipt,
  kvitansiya, kvitansiyasi, квитанция, квитанции, квитанцию, akt, akti, акт, акта, акту, zakaz, заказ, заказа, заказу, buyurtma, buyurtmasi, order, id, kod, kodi, код, кода,
  tranzaksiya, tranzaksiyasi, транзакция, транзакции, транзакцию, transaction, probeg, пробег, mileage, imei`);
/** "на счёт 1500000" says where the money went, so the number after it is the money. */
const ACCOUNT_ID = wordSet('schet, schyot, счёт, счет');
const INTO = wordSet('на, в, to, into');

const YARIM = wordSet('yarim');
const HALF = wordSet('yarim, пол, половина, половину, half');
const ONE_AND_HALF = wordSet('полтора, полторы, полутора');
const UZBEK_ONES = wordSet("bir, ikki, uch, to'rt, besh, olti, yetti, sakkiz, to'qqiz");
const HUNDRED = wordSet('yuz*, hundred, hundreds');

const NUMBER_WORDS = new Map<string, number>(
  ([
    [1, 'bir, один, одна, одну, одного, одной, one'], [2, 'ikki, два, две, двух, двум, two'], [3, 'uch, три, трех, трёх, трем, трём, three'],
    [4, "to'rt, четыре, четырех, четырёх, four"], [5, 'besh, пять, пяти, five'], [6, 'olti, шесть, шести, six'],
    [7, 'yetti, семь, семи, seven'], [8, 'sakkiz, восемь, восьми, eight'], [9, "to'qqiz, девять, девяти, nine"],
    [10, "o'n, десять, десяти, ten"], [11, 'одиннадцать, одиннадцати, eleven'], [12, 'двенадцать, двенадцати, twelve'],
    [13, 'тринадцать, тринадцати, thirteen'], [14, 'четырнадцать, четырнадцати, fourteen'], [15, 'пятнадцать, пятнадцати, fifteen'],
    [16, 'шестнадцать, шестнадцати, sixteen'], [17, 'семнадцать, семнадцати, seventeen'], [18, 'восемнадцать, восемнадцати, eighteen'],
    [19, 'девятнадцать, девятнадцати, nineteen'], [20, 'yigirma, двадцать, двадцати, twenty'], [30, "o'ttiz, тридцать, тридцати, thirty"],
    [40, 'qirq, сорок, сорока, forty, fourty'], [50, 'ellik, пятьдесят, пятидесяти, fifty'], [60, 'oltmish, шестьдесят, шестидесяти, sixty'],
    [70, 'yetmish, семьдесят, семидесяти, seventy'], [80, 'sakson, восемьдесят, восьмидесяти, eighty'], [90, "to'qson, девяносто, девяноста, ninety"],
    [100, 'сто, ста, sto'], [200, 'двести, двухсот'], [300, 'триста, трехсот, трёхсот'], [400, 'четыреста, четырехсот, четырёхсот'],
    [500, 'пятьсот, пятисот'], [600, 'шестьсот, шестисот'], [700, 'семьсот, семисот'], [800, 'восемьсот, восьмисот'], [900, 'девятьсот, девятисот'],
  ] as [number, string][]).flatMap(([value, source]) => [...wordSet(source)].map((key) => [key, value] as const)),
);
/** "uchta", "o'nta": a number that has already said it counts things. */
const COUNTED_NUMBERS = new Map<string, number>([
  ...[...NUMBER_WORDS].filter(([, value]) => value < 100).map(([key, value]) => [`${key}ta`, value] as const),
  ...[...wordSet("to'rtta")].map((key) => [key, 4] as const),
  ...[...wordSet('yuzta')].map((key) => [key, 100] as const),
]);

const JOINERS = wordSet('va, u, и, and');
const CHOICE_WORDS = wordSet("yoki, yo, или, либо, or");
const RANGE_STARTS = wordSet('от, from, between, между');
const RANGE_MIDDLES = wordSet('до, to, and, и, va');
/** Enough on its own: "3 to 4 million". The others need a start word, as "3 mln va 200 ming" is a sum. */
const UP_TO = wordSet('до, to');
const DASHES = new Set(['-', '–', '—']);
const RANGE_MARKS = new Set([...DASHES, '~', '≈']);
const ENDINGS_APART = wordSet('ga, ka, da, dan, ni, ning, lik, li, gacha, cha, lar');
const NOT_BEFORE = wordSet('не, not, вместо');
const INSTEAD = wordList('instead of');
const CORRECTIONS = wordList(`
  emas, yo'q, нет, no, nope, вернее, точнее, aslida, aniqrog'i, to'g'rirog'i, to'g'risi, adashdim, adashibman, xato, ошибся, ошиблась,
  оговорился, оговорилась, ошибка, неправильно, kechirasiz, uzr, desam, hozir aytaman, ya'ni, noto'g'ri, o'rniga, извините, извини, простите, прости, пардон, то есть, тоесть, в смысле, стоп, stop,
  sorry, rather, actually, correction, mistake, wrong, oops, i mean, i meant, wait, make that, scratch that`);
const MINUS_WORDS = wordSet('minus, минус');
export const APPROX_BEFORE = wordSet(`
  около, примерно, приблизительно, почти, порядка, свыше, более, менее, больше, меньше, до, минимум, максимум, taxminan, taqriban, qariyb, salkam, deyarli, deyarlik,
  kamida, maksimum, minimum, necha, несколько, about, around, approximately, approx, roughly, almost, nearly, over, under, than, several, some, like, circa`);
const APPROX_LEADS = wordList("где то, в районе, в пределах, ko'pi bilan, at least, at most, up to");
const APPROX_TAILS = wordList('с лишним, с хвостиком, с копейками, с небольшим, с чем то, где то, give or take, or thereabouts, or so, or more, or less');
/** The person is not sure of what stands next to this. */
export const HEDGES = wordSet("shekilli, chog'i, balki, balkim, ehtimol, aftidan, menimcha, o'ylayman, наверное, наверно, возможно, вроде, кажется, может, похоже, видимо, думаю, maybe, probably, perhaps, guess, think");
const APPROX_AFTER = wordSet("atrof*, chamasi, chamali, ortiq, ko'proq, kamroq, oshiq, yaqin, plus");
/** After "-dan", these compare with the amount: "3 mln dan ko'p" is more than 3 mln, not 3 mln each. */
const COMPARED = wordSet("ko'p, ko'proq, kam, kamroq, ortiq, oshiq, oshiqroq, oshdi, oshgan");
const RATE_WORDS = wordSet('kurs*, курс, курса, курсу, курсе, курсом, rate, rates');
/** How far a rate can stand from its rate word: "курс ЦБ на сегодня 12 700". */
const RATE_REACH = 3;
/** No rate the books hold comes near this, so a figure past it is money: "Haydovchilar kursi 3 mln" is a course for drivers. */
const RATE_LIMIT = 40_000;
/** A bare number this size beside a foreign amount can only be its rate: "200 dollar 12700". */
const BARE_RATE_FLOOR = 1_000;
const RATE_PER = wordSet('за, per, a');
const ACCOUNT_WORDS = wordSet('seyf*, kassa*, hisob*, karta*, bank*, сейф, сейфа, сейфе, касса, кассы, кассе, счёт, счёта, счета, счету, карта, карты, карте, банка, банке, safe, account');

const EACH_BEFORE = wordSet('по, each, каждый, каждая, каждое, каждому, каждую, at');
const EACH_AFTER = wordSet('each, apiece, каждый, каждая, каждое, каждому, каждую');
const EVERY = wordSet('har, каждый, каждая, каждое, каждому, каждую, each, every');
const HAR = fold('har');
/** What a price can be for besides a unit: one of the things counted, or the land. */
const ITEM_WORDS = wordSet("biri, biriga, bittasi, bittasiga, tasi, qo'yi, qo'yiga, qo'zisi, qo'zisiga, единицу, единица, item, unit, gektar, gektari, gektariga, gektarga, гектар, гектара, hectare, soatiga, kuniga, oyiga, yiliga, haftasiga");
/** "tonnasi", "qopi": the ending itself says one of them. */
const OWN_FORM = /(?:si|[^aeiou]i)(?:ga)?$/;
/** Enough of a word to be a unit after an amount: not the "г" of "г. Бухара", nor "to'y", a wedding, which folds to the word for a bale. */
const WORD_UNIT = /^(?!toy$).{2,}$/;
const PERIOD_WORDS = wordSet('месяц, день, час, неделю, год, month, day, hour, week, year');
/** "oy boshi" is the start of the month, and no price per head. */
const PERIOD_STARTS = wordSet('oy, hafta, yil, mavsum');
const PER_AFTER = wordSet('за, per, a, на, с, в');
const PRICE_WORDS = wordSet('narx*, цена, цену, цены, price');
const PRICE_FILLERS = wordSet('uchun, si, narx*, цена, цену, цены, price, is, was, стоит, стоил, стоила, стоило, обошелся, обошёлся, обошлась, обошлось, в, turadi, turibdi, costs, cost');
const EACH_OF = wordSet('za, har, на, с, per');

export const MONTHS = new Map<string, number>(
  ([
    [1, 'yanvar*, январь, января, январе, january, jan'], [2, 'fevral*, февраль, февраля, феврале, february, feb'],
    [3, 'mart*, март, марта, марте, march, mar'], [4, 'aprel*, апрель, апреля, апреле, april, apr'],
    [5, 'may*, май, мая, мае'], [6, 'iyun*, июнь, июня, июне, june'], [7, 'iyul*, июль, июля, июле, july, jul'],
    [8, 'avgust*, август, августа, августе, august, aug'], [9, 'sentabr*, sentyabr*, сентябрь, сентября, сентябре, september, sep, sept'],
    [10, 'oktabr*, oktyabr*, октябрь, октября, октябре, october, oct'], [11, 'noyabr*, ноябрь, ноября, ноябре, november, nov'],
    [12, 'dekabr*, декабрь, декабря, декабре, december, dec'],
  ] as [number, string][]).flatMap(([month, source]) => [...wordSet(source)].map((key) => [key, month] as const)),
);

/** "2 марта" is the second of March, and "2 marta" is twice. */
export const monthOf = (piece: Piece | undefined): number | undefined => {
  if (piece?.kind !== 'word') return undefined;
  return piece.key === 'marta' && /[a-z]/i.test(piece.raw) ? undefined : MONTHS.get(piece.key);
};

// ─── Reading a text into pieces ─────────────────────────────────────────────

const SPACES = ' \\t\\u00A0\\u2009\\u202F';
const DIGIT_FORMS = [
  `\\d{1,3}(?:[${APOSTROPHES}]\\d{3})+(?!\\d)`, // 1'500'000
  `\\d{1,3}(?:[${SPACES}]+\\d{3})+(?!\\d)(?:[.,]\\d+)?`, // 1 500 000,50
  `\\d{1,3}(?:[.,]\\d{3})+[${SPACES}]+000(?!\\d)`, // 3.000 000
  '\\d{1,3}(?:\\.\\d{3})+(?![\\d.])(?:,\\d+)?', // 1.500.000,50
  '\\d{1,3}(?:,\\d{3})+(?![\\d,])(?:\\.\\d+)?', // 1,500,000.50
  '\\d+(?:[.,]\\d+)?',
  '(?<![\\p{L}\\d.,])[.,]\\d+', // .5 mln
].join('|');
const PIECE = new RegExp(`(?<number>${DIGIT_FORMS})|(?<word>[\\p{L}\\p{M}${APOSTROPHES}]+)|(?<mark>[$€₽£¥₸₺₴₩₹₼₾%+~≈=/@\\n−–—-])`, 'gu');

export interface Piece {
  kind: 'number' | 'word' | 'mark';
  raw: string;
  /** The folded word, empty for anything else. */
  key: string;
  start: number;
  end: number;
  /** Its place in the text's pieces. */
  index: number;
}

/** Written like a model or a series: "T-28", "ГАЗ-53", "AA 1234567". */
const CAPITALS = /^\p{Lu}{1,5}$/u;

/** "MTZ-82 300 ming", "T-28 200 ming", "Dala 3 200 ming": the first group of the digits ends a name. */
function endsAName(pieces: Piece[], at: number): boolean {
  const before = pieces[at - 1];
  if (before?.raw !== '-') return before?.kind === 'word' && ON_A_PLATE.has(before.key);
  const name = pieces[at - 2];
  if (name?.kind !== 'word') return false;
  const hyphenated = name.end === before.start && before.end === pieces[at].start;
  return ON_A_PLATE.has(name.key) || (hyphenated && CAPITALS.test(name.raw));
}

/** "$200 300 ming": a sign on the first group, and a scale that only fits the last. */
const endsASignedAmount = (pieces: Piece[], at: number) => {
  const before = pieces[at - 1];
  return before !== undefined && (SYMBOLS.has(before.raw) || FOREIGN_CODES.has(before.key)) && SCALES.has(pieces[at + 1]?.key ?? '');
};

/** A number written in groups stands for two things when its first group already belongs to what comes before. */
function splitTakenGroups(pieces: Piece[]): Piece[] {
  return pieces.flatMap((piece, at) => {
    const group = /^(\d{1,3})\s+/.exec(piece.raw);
    if (piece.kind !== 'number' || !group || !(endsAName(pieces, at) || endsASignedAmount(pieces, at))) return [piece];
    const middle = piece.start + group[0].length;
    return [
      { ...piece, raw: group[1], end: piece.start + group[1].length },
      { ...piece, raw: piece.raw.slice(group[0].length), start: middle },
    ];
  });
}

export class Scan {
  readonly pieces: Piece[];
  /** Where a number stands in front of a stock unit, worked out once because prices ask for it at every figure. */
  private stockCounts?: Set<number>;

  constructor(readonly text: string) {
    const pieces: Piece[] = [];
    for (const match of text.matchAll(PIECE)) {
      const { number, word } = match.groups!;
      const kind = number !== undefined ? 'number' : word !== undefined ? 'word' : 'mark';
      const key = word !== undefined ? fold(word) : '';
      if (kind === 'word' && key === '') continue;
      pieces.push({ kind, raw: match[0], key, start: match.index, end: match.index + match[0].length, index: 0 });
    }
    this.pieces = splitTakenGroups(pieces).map((piece, index) => ({ ...piece, index }));
  }

  key(i: number): string {
    return this.pieces[i]?.key ?? '';
  }

  mark(i: number): string {
    const piece = this.pieces[i];
    return piece?.kind === 'mark' ? piece.raw : '';
  }

  /** The text between this piece and the one before it. */
  gap(i: number): string {
    const [before, piece] = [this.pieces[i - 1], this.pieces[i]];
    return before && piece ? this.text.slice(before.end, piece.start) : '';
  }

  /** Only spaces before this piece, on the same line. */
  joined(i: number): boolean {
    return /^[ \t\u00A0\u2009\u202F]*$/.test(this.gap(i));
  }

  /** Nothing at all before this piece. */
  touching(i: number): boolean {
    return i > 0 && this.gap(i) === '';
  }

  /** Whether the text counts stock anywhere but at this piece. */
  countsStockElsewhere(at: number): boolean {
    this.stockCounts ??= new Set(this.pieces.flatMap((_, i) => (numberBefore(this, i) !== null && isStockUnit(this, i + 1) ? [i] : [])));
    return this.stockCounts.size > (this.stockCounts.has(at) ? 1 : 0);
  }
}

/** Patterns that hold digits but never an amount. They are blanked first, keeping every position. */
const NOT_AMOUNTS = [
  /(?<!\d)\+?998[\s-]?\(?\d{2}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}(?!\d)/g, // a phone with its country code
  /(?<![\d.,])\+?[78][ -]?\(?\d{3}\)?[ -]?\d{3}[ -]?\d{2}[ -]?\d{2}(?!\d)(?<!000)/g, // +7 916 123 45 67
  /(?<![\d.,])\(?\d{2}\)?[ -]\d{3}[ -]\d{2}[ -]\d{2}(?!\d)/g, // 90 123 45 67
  /(?<![\d.,])\(?\d{2}\)?[ -]?\d{3}[ -]?\d{4}(?!\d)(?<!000)/g, // 90 1234567, 90 123 4567
  /(?<!\d)\d{4}(?:[ -]\d{4}){3}(?!\d)/g, // a card number
  /\d{13,}/g, // an account number
  /(?<!\d)\d{9}(?!\d)(?<!000)/g, // a tax id or a phone: nine digits that are not a round figure
  /(?<!\d)(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?!\d)/g, // 20261104
  /(?<![\d.,])\d{4}[-.]\d{2}[-.]\d{2}(?!\d)/g, // 2026-11-04
  /(?<![\d.,])\d{1,2}[./-]\d{1,2}[./-]\d{2,4}(?!\d)/g, // 12.05.2026
  /(?<![\d.,])\d{1,2} \d{1,2} (?:19|20)\d{2}(?!\d)/g, // 12 05 2026
  /(?<![\d.,])\d{1,2}\/\d{1,2}(?!\d)/g, // 12/05
  /\d{1,2}:\d{2}(?::\d{2})?(?!\d)/g, // 14:30
  /[№#]\s*\d+/g,
];

export function blankNonAmounts(text: string): string {
  return NOT_AMOUNTS.reduce((result, pattern) => result.replace(pattern, (found) => ' '.repeat(found.length)), text);
}

// ─── Numbers ────────────────────────────────────────────────────────────────

/** A separator is decimal unless it groups thousands. "1.200 mln" is 1.2 million, "1.200 ming" is 1200 of them. */
function digitValue(raw: string, followingScale: number): number {
  const groups = raw.split(/\D+/);
  const thousands = groups.length > 1 && !['', '0'].includes(groups[0]) && groups.slice(1).every((group) => group.length === 3);
  if (thousands && (groups.length > 2 || followingScale < 1e6)) return Number(groups.join(''));
  const compact = raw.replace(/\s/g, '');
  const lastDot = compact.lastIndexOf('.');
  const lastComma = compact.lastIndexOf(',');
  if (lastDot < 0 && lastComma < 0) return Number(compact);
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? '.' : ',';
    const group = decimal === '.' ? ',' : '.';
    return Number(compact.split(group).join('').replace(decimal, '.'));
  }
  const separator = lastDot >= 0 ? '.' : ',';
  const parts = compact.split(separator);
  return Number(parts.length > 2 ? parts.join('') : parts.join('.'));
}

interface Head {
  value: number;
  next: number;
  spoken: boolean;
  counted?: boolean;
}

/**
 * Words that fold like a number and here are not one: "эти" (these), "торт тысячу" (a cake, a thousand), "он" (he),
 * English "on", and "un" (flour), which a Russian keyboard also writes for "o'n".
 */
function notANumber(s: Scan, at: number): boolean {
  const next = s.key(at + 1);
  const counts = OTHER_COUNTS.has(next);
  switch (s.pieces[at].raw.toLowerCase()) {
    case 'эти':
      return true;
    case 'торт':
      return next !== 'ming' && SCALES.get(next) === 1e3;
    case 'он':
      return !UZBEK_ONES.has(next) && next !== 'ming' && !counts;
    case 'on':
      return !UZBEK_ONES.has(next) && !SCALES.has(next) && !isCountWord(s, at + 1);
    case 'un':
    case 'ун':
      return !counts && !SCALES.has(next) && !(UZBEK_ONES.has(next) && SCALES.has(s.key(at + 2)));
    default:
      return false;
  }
}

/** A spoken number below a thousand: "ikki yuz ellik besh", "двести пятнадцать", "two hundred and fifty". */
function readSpoken(s: Scan, at: number): Head | null {
  if (notANumber(s, at)) return null;
  let i = at;
  let value = 0;
  const first = NUMBER_WORDS.get(s.key(i));
  if (HUNDRED.has(s.key(i))) {
    value = 100;
    i += 1;
  } else if (first !== undefined && first < 10 && HUNDRED.has(s.key(i + 1)) && s.joined(i + 1)) {
    value = first * 100;
    i += 2;
  } else if (first !== undefined && first >= 100) {
    value = first;
    i += 1;
  }
  if (value > 0 && s.key(i) === 'and' && NUMBER_WORDS.has(s.key(i + 1))) i += 1;
  const tens = NUMBER_WORDS.get(s.key(i));
  if (tens !== undefined && tens >= 10 && tens < 100 && (i === at || s.joined(i))) {
    value += tens;
    i += 1;
  }
  const hyphen = s.mark(i) === '-' && s.touching(i) && value >= 20 ? 1 : 0;
  const unit = NUMBER_WORDS.get(s.key(i + hyphen));
  if (unit !== undefined && unit < 10 && (i === at || (value % 10 === 0 && s.joined(i)))) {
    value += unit;
    i += 1 + hyphen;
  }
  return i > at ? { value, next: i, spoken: true } : null;
}

/** Where the words after a half end, 0 if there is no half here: "yarim", "с половиной", "and a half". */
function halfAt(s: Scan, at: number): number {
  if (YARIM.has(s.key(at)) && s.joined(at)) return at + 1;
  if (s.key(at) === fold('с') && s.key(at + 1) === fold('половиной')) return at + 2;
  if (JOINERS.has(s.key(at)) && HALF.has(s.key(at + 1)) && !SCALES.has(s.key(at + 2))) return at + 2;
  return s.key(at) === 'and' && s.key(at + 1) === 'a' && HALF.has(s.key(at + 2)) ? at + 3 : 0;
}

/** "uch yarim", "два с половиной", "two and a half". */
function withHalf(s: Scan, head: Head): Head {
  const end = halfAt(s, head.next);
  return end ? { ...head, value: head.value + 0.5, next: end } : head;
}

/** The number in front of a scale word, if there is one. */
function readHead(s: Scan, at: number): Head | null {
  const piece = s.pieces[at];
  if (!piece) return null;
  if (piece.kind === 'number') {
    const value = digitValue(piece.raw, scaleAt(s, at + 1, true)?.value ?? 1);
    if (Number.isNaN(value)) return null;
    if (value < 10 && HUNDRED.has(s.key(at + 1)) && s.joined(at + 1)) {
      const rest = s.pieces[at + 2];
      const tens = rest?.kind === 'number' && s.joined(at + 2) && /^\d{1,2}$/.test(rest.raw) ? Number(rest.raw) : 0;
      return withHalf(s, { value: value * 100 + tens, next: tens ? at + 3 : at + 2, spoken: false });
    }
    return withHalf(s, { value, next: at + 1, spoken: false });
  }
  if (piece.kind !== 'word') return null;
  if (ONE_AND_HALF.has(piece.key)) return { value: 1.5, next: at + 1, spoken: true };
  if (piece.key === 'a') {
    if (HALF.has(s.key(at + 1))) return { value: 0.5, next: at + 2, spoken: true };
    if (HUNDRED.has(s.key(at + 1))) return { value: 100, next: at + 2, spoken: true };
    return SCALES.has(s.key(at + 1)) ? { value: 1, next: at + 1, spoken: true } : null;
  }
  if (HALF.has(piece.key)) return { value: 0.5, next: s.key(at + 1) === 'a' || s.mark(at + 1) === '-' ? at + 2 : at + 1, spoken: true };
  const counted = COUNTED_NUMBERS.get(piece.key);
  if (counted !== undefined) return { value: counted, next: at + 1, spoken: true, counted: true };
  const spoken = readSpoken(s, at);
  return spoken ? withHalf(s, spoken) : null;
}

interface ScaleWord {
  value: number;
  next: number;
  /** "mingdan" */
  each?: boolean;
  /** "mingcha", "minggacha" */
  approx?: boolean;
  /** "mingta" */
  counted?: boolean;
  /** "т.р", "т.с": the scale and the currency in one abbreviation. */
  currency?: MoneyCurrency;
}

function scaleAt(s: Scan, at: number, afterNumber: boolean): ScaleWord | null {
  const piece = s.pieces[at];
  if (piece?.kind !== 'word' || (afterNumber && !s.joined(at))) return null;
  const { key, raw } = piece;
  const value = SCALES.get(key);
  if (value) {
    const approx = SCALES.has(key.replace(/(gacha|cha)$/, '')) && key !== key.replace(/(gacha|cha)$/, '');
    return { value, next: at + 1, each: key.endsWith('dan'), approx, counted: false };
  }
  if (key.endsWith('ta') && SCALES.has(key.slice(0, -2))) return { value: SCALES.get(key.slice(0, -2))!, next: at + 1, counted: true };
  if (!afterNumber) return null;

  const touching = s.touching(at);
  const abbreviation = /^т\.?\s?(руб|сум|[рс])(?![\p{L}])\.?/iu.exec(s.text.slice(piece.start, piece.start + 9));
  if (abbreviation) {
    const stop = piece.start + abbreviation[0].length;
    let next = at + 1;
    while (s.pieces[next] && s.pieces[next].end <= stop) next += 1;
    return { value: 1e3, next, currency: abbreviation[1].toLowerCase().startsWith('р') ? 'RUB' : 'UZS' };
  }
  if (key === 'k' && (touching || /k/i.test(raw))) return { value: 1e3, next: at + 1 };
  if (key === 'm' && touching && /^m$/i.test(raw)) return { value: 1e6, next: at + 1 };
  // Attached and in the hundreds, "300т" is thousands. "2т" and "2 т" are tonnes.
  if (touching && /^т$/i.test(raw) && Number.parseFloat(s.pieces[at - 1].raw) >= 100) return { value: 1e3, next: at + 1 };
  return null;
}

const isChief = (s: Scan, at: number) => s.key(at) === 'bosh' && CHIEFS.has(s.key(at + 1));

export function isStockUnit(s: Scan, at: number): boolean {
  const key = s.key(at);
  return key !== '' && !isChief(s, at) && (unitOf(key) !== null || PACKAGING.has(key));
}

/** Counts something, so a number in front of it is not money. */
export function isCountWord(s: Scan, at: number): boolean {
  return isStockUnit(s, at) || OTHER_COUNTS.has(s.key(at));
}

export const isPercent = (s: Scan, at: number) => s.mark(at) === '%' || PERCENT.has(s.key(at));

/** A scale or currency word: part of a stated amount, whatever the sentence is about. */
export const isAmountWord = (key: string) => SCALES.has(key) || CURRENCIES.has(key);

/** The currency a word names, however it was written: "so'm", "сум", "доллар". */
export const currencyOf = (word: string): MoneyCurrency | null => CURRENCIES.get(fold(word)) ?? null;

/** The one currency these words name, with no figure needed: "dollar edi". Two of them settle nothing. */
export function currencySaid(text: string): MoneyCurrency | null {
  const named = new Set(new Scan(text).pieces.flatMap((piece) => CURRENCIES.get(piece.key) ?? []));
  return named.size === 1 ? [...named][0] : null;
}

/** After a small number, a mark or a word that shows it is not the rest of the amount in front of it. */
function separateFigure(s: Scan, at: number, head: Head): boolean {
  if (['-', '/'].includes(s.mark(at)) || isPercent(s, at) || monthOf(s.pieces[at]) !== undefined) return true;
  // "5 ming 3 ta" counts something else, while "2 ming 500 litr" and "ikki ming besh yuz litr" are one number.
  return isCountWord(s, at) && !head.spoken && head.value < 100;
}

/** A second record after the first: "3 mln va 200 ming tushlikka", "и 200 тысяч на обед". */
function purposeFollows(s: Scan, at: number): boolean {
  const key = s.key(at);
  return /(ga|ka|qa)$/.test(key) || ['uchun', 'na', 'za', 'for'].includes(key) || s.key(at + 1) === 'uchun';
}

export interface Figure {
  value: number;
  first: number;
  next: number;
  /** The smallest scale word in it, 1 for none. */
  scale: number;
  spoken: boolean;
  each: boolean;
  approx: boolean;
  /** The figure itself says it counts things: "uchta", "3 mingta". */
  counted: boolean;
  /** "ming" with nothing around it: "ming rahmat". */
  lone: boolean;
  currency?: MoneyCurrency;
  /** Read as thousands, this could still be tonnes: "300т". */
  tonnes?: number;
}

/** One whole amount from this piece on: "3 mln 500 ming", "миллион двести", "ikki yarim million", "2,5". */
export function readFigure(s: Scan, at: number): Figure | null {
  const figure: Figure = { value: 0, first: at, next: at, scale: 1, spoken: true, each: false, approx: false, counted: false, lone: false };
  const key = s.key(at);
  // One word: "полмиллиона", and "полляма", where the fold has merged the two l.
  const merged = key.startsWith('pol') ? (SCALES.get(key.slice(3)) ?? SCALES.get(key.slice(2))) : undefined;
  if (merged) return { ...figure, value: merged / 2, next: at + 1, scale: merged };

  let i = at;
  let limit = Infinity;
  for (;;) {
    const head = readHead(s, i);
    const scale = scaleAt(s, head ? head.next : i, head !== null);
    const single = !head && SINGLE_SCALE.has(s.key(i));
    if (scale && scale.value < limit && (head || single)) {
      figure.value += (head?.value ?? 1) * scale.value;
      figure.spoken &&= head?.spoken ?? true;
      figure.scale = scale.value;
      figure.each = scale.each ?? false;
      figure.approx ||= scale.approx ?? false;
      figure.counted = scale.counted ?? false;
      figure.currency ??= scale.currency;
      figure.lone = single && limit === Infinity && scale.value === 1e3;
      if (head && !scale.currency && /^т$/i.test(s.pieces[head.next].raw)) figure.tonnes = head.value;
      limit = scale.value;
      i = scale.next;
      if (figure.each || figure.approx || figure.counted || scale.currency) break;
      const half = halfAt(s, i);
      if (half && !isCountWord(s, half)) {
        figure.value += scale.value / 2;
        i = half;
        break;
      }
      const dotted = /^\.[ \t ]*$/.test(s.gap(i));
      if (!dotted && !s.joined(i)) break;
      const joiner = JOINERS.has(s.key(i)) ? 1 : 0;
      if (dotted || joiner) {
        const after = readHead(s, i + joiner);
        const part = after && scaleAt(s, after.next, true);
        if (!part || part.value >= limit || purposeFollows(s, part.next)) break;
      }
      i += joiner;
      continue;
    }
    if (limit === Infinity) {
      if (!head) return null;
      figure.value = head.value;
      figure.spoken = head.spoken;
      figure.counted = head.counted ?? false;
      i = head.next;
      break;
    }
    if (head && s.joined(i) && !scale && !separateFigure(s, head.next, head)) {
      const whole = Number.isInteger(head.value) && head.value < 1000;
      if (limit === 1e3 && whole) {
        figure.value += head.value;
        i = head.next;
      } else if (limit >= 1e6 && head.spoken && whole && head.value >= 100 && !isCountWord(s, head.next)) {
        // The word "ming" dropped in speech: "ikki million uch yuz", "миллион двести". Not "ikki million uch yuz litr".
        figure.value += head.value * 1e3;
        i = head.next;
      }
    }
    break;
  }
  figure.lone &&= i === at + 1;
  return { ...figure, value: Math.round(figure.value * 100) / 100, next: i };
}

// ─── What the words around a number make of it ──────────────────────────────

/**
 * What a price is for: the canonical unit, 'bag' for packaging, or 'unit' for one of whatever was counted.
 * A price per bag stays 'bag', because a bag has no fixed weight and it must not be applied to tonnes.
 */
function priceUnit(key: string): string | null {
  if (key === '') return null;
  return unitOf(key) ?? (PACKAGING.has(key) ? 'bag' : ITEM_WORDS.has(key) ? 'unit' : null);
}

/** The number ending at this piece, if one does. Only "is it one" matters, so "uch yuz" need not be added up. */
function numberBefore(s: Scan, at: number): number | null {
  const piece = s.pieces[at];
  if (piece?.kind === 'number') return Number.parseFloat(piece.raw.replace(',', '.'));
  const key = s.key(at);
  return NUMBER_WORDS.get(key) ?? (HUNDRED.has(key) || SCALES.has(key) || YARIM.has(key) ? 100 : null);
}

/** "tonnasi 2 mln", "по 15 тысяч", "тонна по 2 млн", "bir tonnasi 2 mln", "har bir qop 40 ming", "литр стоит 15 тысяч", "500 kg 1 kg 3 ming". */
function perUnitBefore(s: Scan, first: number): string | null {
  let i = first - 1;
  if (SYMBOLS.has(s.mark(i))) i -= 1;
  const priceWord = PRICE_WORDS.has(s.key(i));
  let filled = false;
  while (PRICE_FILLERS.has(s.key(i)) || DASHES.has(s.mark(i)) || s.mark(i) === '=') {
    filled ||= s.key(i) !== '';
    i -= 1;
  }
  const each = EACH_BEFORE.has(s.key(i)) || s.mark(i) === '@';
  if (each) i -= 1;
  const unit = PERIOD_STARTS.has(s.key(i - 1)) ? null : priceUnit(s.key(i));
  if (unit) {
    const count = numberBefore(s, i - 1);
    if (count === null) return unit;
    if (count === 1 && (filled || EACH_OF.has(s.key(i - 2)) || OWN_FORM.test(s.key(i)) || s.countsStockElsewhere(i - 1))) return unit;
  }
  if (each || EVERY.has(s.key(i - 1)) || (s.key(i - 1) === 'bir' && s.key(i - 2) === HAR)) return 'unit';
  // "10 qop kepak oldim, bir qop kepak 40 ming": the word in between says of what.
  const stock = priceUnit(s.key(i - 1));
  if (stock && numberBefore(s, i - 2) === 1 && s.countsStockElsewhere(i - 2)) return stock;
  return priceWord && s.countsStockElsewhere(-1) ? 'unit' : null;
}

/** "15 тысяч за литр", "$5 each", "3000/kg", "2 mln boshiga", "2 mln tonnasi", "2 млн голова", "2 mln har biri". */
function perUnitAfter(s: Scan, at: number, figure: Figure, named: boolean): { unit: string; next: number } | null {
  const key = s.key(at);
  if (s.mark(at) === '/') {
    const unit = priceUnit(s.key(at + 1));
    return unit ? { unit, next: at + 2 } : null;
  }
  if (EACH_AFTER.has(key)) return { unit: 'unit', next: at + 1 };
  if (key === HAR && ITEM_WORDS.has(s.key(at + 1))) return { unit: 'unit', next: at + 2 };
  if (PER_AFTER.has(key)) {
    const i = numberBefore(s, at + 1) === 1 ? at + 2 : at + 1;
    const unit = priceUnit(s.key(i)) ?? (PERIOD_WORDS.has(s.key(i)) ? 'unit' : null);
    return unit ? { unit, next: i + 1 } : null;
  }
  const unit = isChief(s, at) || !WORD_UNIT.test(key) ? null : priceUnit(key);
  if (!unit) return null;
  // After millions or a currency a unit can only be what the price is for. After thousands it may be the quantity: "2 ming litr".
  const owned = key.endsWith('iga') || figure.scale >= 1e6 || named;
  return owned || (figure.scale === 1e3 && (OWN_FORM.test(key) || key.endsWith('ga'))) ? { unit, next: at + 1 } : null;
}

function currencyBefore(s: Scan, first: number): MoneyCurrency | null {
  const piece = s.pieces[first - 1];
  if (!piece || !s.joined(first)) return null;
  return SYMBOLS.get(piece.raw) ?? CURRENCY_CODES.get(piece.key) ?? null;
}

interface CurrencyWord {
  code: MoneyCurrency | null;
  unknown?: string;
  next: number;
  each: boolean;
}

function currencyAfter(s: Scan, at: number, scaled: boolean): CurrencyWord | null {
  const i = COUNTRY_OF_DOLLAR.has(s.key(at)) && CURRENCIES.get(s.key(at + 1)) === 'USD' ? at + 1 : at;
  const piece = s.pieces[i];
  if (!piece || !/^\.?[ \t   ]*$/.test(s.gap(at))) return null;
  if (piece.kind === 'mark') {
    const code = SYMBOLS.get(piece.raw);
    // "300 ming $200": the sign is written on the number after it.
    if (code && s.pieces[i + 1]?.kind === 'number' && s.touching(i + 1) && !s.touching(i)) return null;
    if (code) return { code, next: i + 1, each: false };
    return OTHER_SYMBOLS.has(piece.raw) ? { code: null, unknown: piece.raw, next: i + 1, each: false } : null;
  }
  if (piece.kind !== 'word') return null;
  if (/^у\.?\s?е(?![\p{L}])/iu.test(s.text.slice(piece.start, piece.start + 5))) {
    return { code: 'USD', next: s.key(i) === 'u' ? i + 2 : i + 1, each: false };
  }
  if (/^р$/i.test(piece.raw)) return { code: 'RUB', next: i + 1, each: false };
  const code = CURRENCIES.get(piece.key);
  // "3 mln dollar seyfdan" names an account: nobody spends three million dollars from the safe.
  if (code && code !== 'UZS' && ACCOUNT_WORDS.has(s.key(i + 1)) && (scaled || /^\p{Lu}\p{Ll}/u.test(piece.raw))) return null;
  if (code) return { code, next: i + 1, each: piece.key.endsWith('dan') };
  return OTHER_CURRENCIES.has(piece.key) ? { code: null, unknown: piece.raw, next: i + 1, each: false } : null;
}

/** A number that is a name or an ordinal: small, and joined to or following a word that names something. */
const LABEL_LIMIT = 10_000;

function isLabel(s: Scan, figure: Figure): boolean {
  const { first, next, value } = figure;
  const before = s.pieces[first - 1];
  if (before?.kind === 'word' && s.touching(first)) return true;
  if (monthOf(before) !== undefined && (value <= 31 || (value >= 1900 && value < 2100))) return true;
  if (before?.kind === 'word' && ID_WORDS.has(before.key) && !(ACCOUNT_ID.has(before.key) && INTO.has(s.key(first - 2)))) return true;
  if (s.mark(first - 1) === '-' && s.touching(first) && ID_WORDS.has(s.key(first - 2))) return true;
  const named = before?.kind === 'word' && (ON_A_PLATE.has(before.key) || (before.raw.length > 1 && CAPITALS.test(before.raw)));
  if (named && value % 100 !== 0) return true; // "Kamaz 65115", "AA 1234567"
  if (value >= LABEL_LIMIT) return false;
  if (s.mark(first - 1) === '-' && s.touching(first) && s.touching(first - 1) && s.pieces[first - 2]?.kind === 'word') return true;
  if (s.mark(next) === '-' && s.touching(next) && s.touching(next + 1) && s.pieces[next + 1]?.kind === 'word') return true;
  return named || (before?.kind === 'word' && NAMED_BY_NUMBER.has(before.key));
}

const isDayMonth = (raw: string) => {
  const match = /^(\d{1,2})\.(\d{2})$/.exec(raw);
  return match !== null && Number(match[1]) >= 1 && Number(match[1]) <= 31 && Number(match[2]) >= 1 && Number(match[2]) <= 12;
};

/** A list entry ending right before this piece, through any hyphen: "где-то 3 млн". */
function entryEndsAt(s: Scan, at: number, list: Phrase[]): boolean {
  return list.some((phrase) => {
    let i = at - 1;
    return [...phrase].reverse().every((keys) => {
      if (s.mark(i) === '-') i -= 1;
      i -= 1;
      return keys.has(s.key(i + 1));
    });
  });
}

/** A list entry starting at this piece, through any hyphen: "3 млн с чем-то". */
function entryStartsAt(s: Scan, at: number, list: Phrase[]): boolean {
  return list.some((phrase) => {
    let i = at;
    return phrase.every((keys) => {
      if (s.mark(i) === '-') i += 1;
      i += 1;
      return keys.has(s.key(i - 1));
    });
  });
}

const CLAUSE_BREAK = /[,;.!?\n]/;
/** How many pieces around a figure a hedge reaches: "3 mln ekan shekilli". */
const HEDGE_REACH = 3;

function hedgedNear(s: Scan, first: number, after: number): boolean {
  for (let i = first - 1; i >= first - HEDGE_REACH && !CLAUSE_BREAK.test(s.gap(i + 1)); i -= 1) {
    if (HEDGES.has(s.key(i))) return true;
  }
  for (let i = after; i < after + HEDGE_REACH && !CLAUSE_BREAK.test(s.gap(i)); i += 1) {
    if (HEDGES.has(s.key(i))) return true;
  }
  return false;
}

/** The words around a figure say it is not exact. */
export function isApproximate(s: Scan, first: number, after: number): boolean {
  if (APPROX_BEFORE.has(s.key(first - 1)) || ['~', '≈'].includes(s.mark(first - 1))) return true;
  if (APPROX_AFTER.has(s.key(after)) || s.mark(after) === '+' || hedgedNear(s, first, after)) return true;
  if (COMPARED.has(s.key(after)) && s.key(after - 1).endsWith('dan')) return true;
  return entryEndsAt(s, first, APPROX_LEADS) || entryStartsAt(s, after, APPROX_TAILS);
}

const isNumberAt = (s: Scan, at: number) => s.pieces[at]?.kind === 'number' || (NUMBER_WORDS.has(s.key(at)) && !notANumber(s, at));

const DOTS = /^\s*(?:\.{2,}|…)\s*$/;

/** "2-3", "2 yoki 3", "от 2 до 3", "ikki uch", "два-три", "2..3": the number at `at` closes a range or a choice. */
export function closesRange(s: Scan, at: number): boolean {
  const linked = RANGE_MARKS.has(s.mark(at - 1)) || CHOICE_WORDS.has(s.key(at - 1)) || UP_TO.has(s.key(at - 1));
  const before = linked ? at - 2 : at - 1;
  return isNumberAt(s, before) && (linked || s.joined(at) || DOTS.test(s.gap(at)));
}

/** How many pieces a correction takes to reach the number it brings: "3 tonna, yo'q, sorry, 4". */
const CORRECTION_REACH = 4;

/** The first number in the few pieces from here on, or -1. */
export function numberAfter(s: Scan, from: number): number {
  for (let i = from; i < from + CORRECTION_REACH; i += 1) {
    if (isNumberAt(s, i)) return i;
  }
  return -1;
}

/** "bir tonnasi 2 mln", "1 kg uchun 3 ming", "500 kg 1 kg 3 ming": one unit named to give its price, which is no quantity. */
export function isPriceBasis(s: Scan, unit: number): boolean {
  if (numberBefore(s, unit - 1) !== 1) return false;
  if (OWN_FORM.test(s.key(unit)) || ['uchun', 'si'].includes(s.key(unit + 1))) return true;
  const price = s.mark(unit + 1) === '=' || DASHES.has(s.mark(unit + 1)) ? unit + 2 : unit + 1;
  return s.countsStockElsewhere(unit - 1) && (isNumberAt(s, price) || isNumberAt(s, price + 1));
}

/** The person took the figure back, in the words on it. */
export const takenBack = (s: Scan, first: number, after: number) => NOT_BEFORE.has(s.key(first - 1)) || s.key(after) === 'emas' || entryEndsAt(s, first, INSTEAD);

function hasMinus(s: Scan, first: number): boolean {
  if (MINUS_WORDS.has(s.key(first - 1)) || s.mark(first - 1) === '−') return true;
  return s.mark(first - 1) === '-' && s.touching(first) && !s.touching(first - 1);
}

interface Found extends Omit<MoneyMention, 'raw' | 'start' | 'end'> {
  first: number;
  next: number;
  scale: number;
  lastNumber: number;
  /** A number in words with no scale or currency: kept only until ranges are settled, never a mention. */
  spokenOnly: boolean;
  /** "3 dan", the start of "3 dan 4 gacha". */
  fromEnding: boolean;
  upTo: boolean;
  /** "12700 per dollar" */
  perCurrency?: MoneyCurrency;
  /** The "1 dollar" of a rate, which is no amount. */
  rateBase?: boolean;
}

/** Whether the figure counts something. Past the small numbers, only stock and what else comes in thousands. */
function countsSomething(s: Scan, figure: Figure, at: number): boolean {
  if (figure.scale === 1 && figure.value < LABEL_LIMIT) return isCountWord(s, at);
  return figure.scale <= 1e3 && (isStockUnit(s, at) || LARGE_COUNTS.has(s.key(at)));
}

/** `taken` is where the mention before ended: a sign or a code up to there is already spoken for. */
function readMention(s: Scan, figure: Figure, taken: number): Found | null {
  const { first } = figure;
  const plain = figure.scale === 1;
  const free = first - 1 >= taken;
  const before = free ? currencyBefore(s, first) : null;
  let i = figure.next;
  let perUnit: string | null = figure.each ? 'unit' : null;
  let approx = figure.approx;
  let fromEnding = false;
  let upTo = /gacha$/.test(s.key(i - 1));

  const apart = s.mark(i) === '-' && s.touching(i) && s.touching(i + 1) ? i + 1 : i;
  if (ENDINGS_APART.has(s.key(apart)) && s.joined(apart)) {
    const ending = s.key(apart);
    if (ending === 'ga' && plain && figure.value < LABEL_LIMIT) return null;
    i = apart + 1;
    if (ending === 'dan') {
      perUnit = 'unit';
      fromEnding = true;
    }
    if (ending === 'gacha') upTo = true;
    if (ending === 'cha' || ending === 'gacha' || ending === 'lar') approx = true;
  }

  const signBefore = free && s.joined(first) && OTHER_SYMBOLS.has(s.pieces[first - 1]?.raw) ? s.pieces[first - 1].raw : undefined;
  const after: CurrencyWord | null = signBefore
    ? { code: null, unknown: signBefore, next: i, each: false }
    : before || figure.currency
      ? null
      : currencyAfter(s, i, !plain);
  if (after) {
    i = after.next;
    if (after.each) perUnit = 'unit';
  }
  if (perUnit && COMPARED.has(s.key(i))) {
    perUnit = null;
    approx = true;
  }
  const stated = before ?? figure.currency ?? after?.code ?? null;
  const named = stated !== null || after?.unknown !== undefined;
  if (figure.lone && !named) return null;

  const priced = perUnitAfter(s, i, figure, named);
  if (priced) {
    perUnit = priced.unit;
    i = priced.next;
  }
  const perCurrency = RATE_PER.has(s.key(i)) ? CURRENCIES.get(s.key(i + 1)) : undefined;
  if (perCurrency) i += 2;

  if (!named) {
    if (isPercent(s, i) || figure.counted) return null;
    if (!priced && countsSomething(s, figure, i)) return null;
    if (plain) {
      const ordinal = ORDINAL_ENDINGS.has(s.key(i)) && (s.touching(i) || (s.mark(i - 1) === '-' && s.touching(i - 1)));
      const hyphenOrdinal = s.mark(i) === '-' && s.touching(i) && ORDINAL_ENDINGS.has(s.key(i + 1));
      if (ordinal || hyphenOrdinal || monthOf(s.pieces[i]) !== undefined || isDayMonth(s.pieces[first].raw)) return null;
      if (!figure.spoken && isLabel(s, figure)) return null;
    }
  }
  // A unit said before the figure outranks the plain "each" of "-dan": "tonnasi 2 mln so'mdan" is per tonne.
  if (!priced) perUnit = perUnitBefore(s, first) ?? perUnit;

  const unknownCurrency = after?.unknown;
  return {
    amount: figure.value,
    currency: stated,
    bare: plain && !named,
    perUnit,
    negated: takenBack(s, first, i),
    uncertain: approx || hasMinus(s, first) || isApproximate(s, first, i),
    rate: false,
    ...(unknownCurrency ? { unknownCurrency } : {}),
    first,
    next: i,
    scale: figure.scale,
    lastNumber: figure.next - 1,
    spokenOnly: plain && figure.spoken && !named,
    fromEnding,
    upTo,
    ...(perCurrency ? { perCurrency } : {}),
  };
}

const isForeign = (f: Found) => f.currency !== null && f.currency !== 'UZS';
const couldBeRate = (f: Found) => !isForeign(f) && !f.unknownCurrency && f.amount > 1 && f.amount < RATE_LIMIT;

function setRate(f: Found, of: MoneyCurrency | null | undefined) {
  f.rate = true;
  f.perUnit = null;
  if (of && of !== 'UZS') f.rateOf = of;
}

/** The rate word this figure follows in its clause, or -1. */
function rateWordBefore(s: Scan, first: number): number {
  for (let i = first - 1; i >= 0 && i >= first - 1 - RATE_REACH; i -= 1) {
    if (CLAUSE_BREAK.test(s.gap(i + 1))) return -1;
    if (monthOf(s.pieces[i]) !== undefined) i -= s.mark(i - 1) === '-' ? 2 : 1; // "курс на 1 ноября 12 700"
    else if (s.pieces[i].kind === 'number') return -1;
    if (RATE_WORDS.has(s.key(i))) return i;
    if (s.key(i).endsWith('ga') && !CURRENCIES.has(s.key(i))) return -1; // "kurs baland elektrga 20 ming"
  }
  return -1;
}

/** "Evro kursi 14 000", "курс доллара 12 700": whose rate it is, from the words at the rate word. */
function currencyOfRate(s: Scan, word: number, first: number): MoneyCurrency | undefined {
  for (let i = word - 1; i < first; i += 1) {
    const code = CURRENCIES.get(s.key(i));
    if (code) return code;
  }
  return undefined;
}

/** "dollariga 12 700", "за доллар 12 700", "per dollar 12700", "dollarni 12 700 dan", "доллар по 12 700". */
function rateUnitBefore(s: Scan, f: Found): MoneyCurrency | undefined {
  const at = EACH_BEFORE.has(s.key(f.first - 1)) ? f.first - 2 : f.first - 1;
  const key = s.key(at);
  const code = CURRENCIES.get(key);
  if (code === undefined || code === 'UZS') return undefined;
  return key.endsWith('ga') || f.perUnit === 'unit' || RATE_PER.has(s.key(at - 1)) ? code : undefined;
}

/** "1 dollar = 12 700", "kurs 1$ 12700", "1 dollar uchun 12 700". */
const linkedAsRate = (s: Scan, one: Found, rate: Found) =>
  !CLAUSE_BREAK.test(s.gap(rate.first)) && s.pieces.slice(one.next, rate.first).every((piece) => piece.key === 'uchun' || piece.raw === '=' || DASHES.has(piece.raw));

/** "200 dollar 12700 dan", "200 долларов по 12700", "200 dollar 12700". */
function beside(s: Scan, amount: Found, rate: Found): boolean {
  if (!isForeign(amount)) return false;
  const apart = rate.first - amount.next;
  return rate.perUnit === 'unit' ? apart <= 1 : rate.bare && rate.amount >= BARE_RATE_FLOOR && apart === 0 && s.joined(rate.first);
}

/** Which figures are exchange rates, and whose. This comes after all figures are read, as a rate word can point either way. */
function markRates(s: Scan, found: Found[]) {
  found.forEach((f, k) => {
    if (!couldBeRate(f)) return;
    const [before, next] = [found[k - 1], found[k + 1]];
    const unit = f.perCurrency ?? rateUnitBefore(s, f);
    const word = rateWordBefore(s, f.first);
    if (unit) {
      setRate(f, unit);
    } else if (before?.amount === 1 && isForeign(before) && linkedAsRate(s, before, f)) {
      before.rateBase = true;
      setRate(f, before.currency);
    } else if (word >= 0) {
      setRate(f, currencyOfRate(s, word, f.first));
    } else if (RATE_WORDS.has(s.key(f.next)) && !(next && couldBeRate(next))) {
      setRate(f, null);
    } else if (before && beside(s, before, f)) {
      setRate(f, before.currency);
    }
  });
}

/** How the words between two figures relate them: a range or choice, a correction, or nothing. */
export function linkBetween(s: Scan, from: number, to: number): 'range' | 'correction' | null {
  const between = s.pieces.slice(from, to);
  const words = between.filter((piece) => piece.kind === 'word' && piece.raw.toLowerCase() !== 'но'); // "но" folds to "no", and is only "but"
  const marks = between.filter((piece) => piece.kind === 'mark').map((piece) => piece.raw);
  if (marks.includes('\n')) return null;
  if (words.length === 0 && marks.length === 1 && RANGE_MARKS.has(marks[0])) return 'range';
  if (between.length === 0 && DOTS.test(s.gap(to))) return 'range';
  if (words.length === 1 && CHOICE_WORDS.has(words[0].key)) return 'range';
  if (words.length === 1 && words[0].raw.toLowerCase() === 'ой') return 'correction'; // "ой" alone: it is also the Uzbek for month.
  return words.length <= 3 && hasPhrase(words.map((word) => word.key), CORRECTIONS) ? 'correction' : null;
}

/** How neighbouring figures qualify each other: ranges, choices and corrections. */
function settle(s: Scan, found: Found[]): Found[] {
  for (let k = 0; k + 1 < found.length; k += 1) {
    const [a, b] = [found[k], found[k + 1]];
    if (a.rateBase) continue;
    const link = linkBetween(s, a.next, b.first);
    const between = s.pieces.slice(a.next, b.first);
    const words = between.filter((piece) => piece.kind === 'word').map((piece) => piece.key);
    const sameLine = !between.some((piece) => piece.raw === '\n');
    const middle = sameLine && words.length === 1 ? words[0] : '';

    const fromTo = RANGE_MIDDLES.has(middle) && RANGE_STARTS.has(s.key(a.first - 1));
    const toOnly = UP_TO.has(middle) && (b.scale >= a.scale || middle === fold('до'));
    const danGacha = sameLine && between.length === 0 && a.fromEnding && b.upTo;
    const spokenPair = between.length === 0 && a.spokenOnly && s.joined(b.first) && s.pieces[b.first].kind === 'word';
    if (a.rate && couldBeRate(b) && link !== null) setRate(b, a.rateOf);
    if (link === 'range' || fromTo || toOnly || danGacha || spokenPair) {
      a.uncertain = true;
      b.uncertain = true;
      if (danGacha) a.perUnit = null;
      if (a.scale === 1 && b.scale > 1) {
        a.amount *= b.scale;
        a.bare = false;
        a.currency ??= b.currency;
        a.spokenOnly = false;
      }
      continue;
    }

    if (link === 'correction') a.negated = true;
    // "не три миллиона а четыре": the corrected figure keeps the scale of the one it replaces.
    if (a.negated && a.scale > 1 && b.scale === 1 && b.amount < 1_000 && words.length <= 1) {
      b.amount *= a.scale;
      b.scale = a.scale;
      b.bare = false;
      b.spokenOnly = false;
      b.currency ??= a.currency;
    }

    // "3 mln 500": the rest of the amount or a second one. Either way the words do not settle it.
    if (between.length === 0 && s.joined(b.first) && a.scale >= 1e6 && b.scale === 1 && !b.currency && !b.unknownCurrency) {
      a.uncertain = true;
      b.uncertain = true;
    }
  }
  return found;
}

/** Every amount of money in the text, in order. */
export function parseMoneyMentions(input: string): MoneyMention[] {
  const s = new Scan(blankNonAmounts(input));
  const found: Found[] = [];
  let taken = 0;
  for (let i = 0; i < s.pieces.length; ) {
    const figure = readFigure(s, i);
    if (!figure) {
      i += 1;
      continue;
    }
    const mention = readMention(s, figure, taken);
    if (mention) {
      found.push(mention);
      taken = mention.next;
    }
    i = Math.max(i + 1, mention?.next ?? figure.next);
  }
  markRates(s, found);
  return settle(s, found)
    .filter((f) => !f.spokenOnly && !f.rateBase)
    .map(({ first, lastNumber, amount, currency, bare, perUnit, negated, uncertain, rate, rateOf, unknownCurrency }) => {
      const [start, end] = [s.pieces[first].start, s.pieces[lastNumber].end];
      return {
        amount, currency, raw: input.slice(start, end), bare, start, end, perUnit, negated, uncertain, rate,
        ...(rateOf ? { rateOf } : {}),
        ...(unknownCurrency ? { unknownCurrency } : {}),
      };
    });
}

/** Differences below this are floating point, not money. */
const TIYIN = 0.005;

/**
 * The newest usable mention of this amount. Pass mentions newest first. A negated, uncertain or rate
 * mention never matches, and it also cancels the same figure in anything older. With `opts.perUnit` only a
 * price per unit matches, and otherwise only a total. When two mentions share the number but differ in
 * currency, the one matching `opts.currency` wins, then one that states none. Exact to the tiyin.
 */
export function findMention(
  mentions: MoneyMention[],
  amount: number,
  opts: { currency?: string | null; perUnit?: boolean } = {},
): MoneyMention | null {
  const wanted = opts.currency?.toUpperCase();
  const same = (m: MoneyMention) => Math.abs(m.amount - amount) < TIYIN && !m.rate;
  const unsaid = mentions.findIndex((m) => same(m) && (m.negated || m.uncertain) && (!wanted || !m.currency || m.currency === wanted));
  const standing = unsaid < 0 ? mentions : mentions.slice(0, unsaid);
  const usable = standing.filter((m) => same(m) && !m.negated && !m.uncertain && Boolean(m.perUnit) === Boolean(opts.perUnit));
  const match = wanted ? (usable.find((m) => m.currency === wanted) ?? usable.find((m) => m.currency === null)) : undefined;
  return match ?? usable[0] ?? null;
}
