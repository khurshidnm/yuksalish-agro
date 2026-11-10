import { describe, expect, it } from 'vitest';
import { latinToCyrillic } from '../i18n/translit';
import {
  birthWords, careWords, dateEvidence, deathWords, fieldWorkWords, parseQuantities, placedQuantities, quantitiesOfTag, quoteFromWords, statedTags,
} from './record-words';

const toRussianKeyboard = (text: string) =>
  text.replace(/[қҚўЎғҒҳҲ]/g, (letter) => ({ қ: 'к', Қ: 'К', ў: 'у', Ў: 'У', ғ: 'г', Ғ: 'Г', ҳ: 'х', Ҳ: 'Х' })[letter]!);

/** One Uzbek phrase as it really arrives: any apostrophe or none, capitals, Cyrillic, a Russian keyboard. */
const spellings = (text: string) => [
  text,
  text.replace(/'/g, 'ʻ'),
  text.replace(/'/g, '’'),
  text.replace(/'/g, ''),
  text.toUpperCase(),
  latinToCyrillic(text),
  toRussianKeyboard(latinToCyrillic(text)),
];

const tagsOf = (text: string) => statedTags(text).map((tag) => tag.tag);
const sure = (text: string) => statedTags(text).filter((tag) => !tag.countLike).map((tag) => tag.digits);

describe('statedTags: which numbers name an animal', () => {
  it('reads the tag and leaves the weight alone, in every Uzbek spelling', () => {
    for (const form of spellings("1234-qo'y 46 kilo chiqdi")) {
      expect(statedTags(form), form).toMatchObject([{ digits: '1234', marked: true, countLike: false }]);
    }
  });

  it('does the same in Russian and English', () => {
    expect(sure('Овца номер 1234 весит 46 кг')).toEqual(['1234']);
    expect(sure('овцу № 1234 взвесили, 46 килограммов')).toEqual(['1234']);
    expect(sure('Sheep number 1234 weighed 46 kg')).toEqual(['1234']);
    expect(sure('tag 1234 came out at 46 kilos')).toEqual(['1234']);
  });

  it('never takes a quantity, money, a day or an hour for a tag', () => {
    expect(tagsOf('46 kilo chiqdi')).toEqual([]);
    expect(tagsOf('46 кг')).toEqual([]);
    expect(tagsOf('5 ml ivermektin qildim')).toEqual([]);
    expect(tagsOf("3 mln so'm to'ladim")).toEqual([]);
    expect(tagsOf('300 ming berdim')).toEqual([]);
    expect(tagsOf('5 noyabrda tortdim')).toEqual([]);
    expect(tagsOf('05.11.2026 da tortdim')).toEqual([]);
    expect(tagsOf('soat 5 da tortdim')).toEqual([]);
    expect(tagsOf('3 kun oldin')).toEqual([]);
    expect(tagsOf('10 ta, 20 bosh')).toEqual([]);
    expect(tagsOf('15 голов, 3 дня назад')).toEqual([]);
  });

  it('keeps the number of a herd or a field out, written any way', () => {
    for (const form of spellings("bugun 1-otarga 300 kilo beda berdim")) expect(tagsOf(form), form).toEqual([]);
    for (const form of spellings("3-dalani bugun sug'ordim")) expect(tagsOf(form), form).toEqual([]);
    expect(tagsOf('dala 3 ga 200 kilo selitra sepdim')).toEqual([]);
    expect(tagsOf('5-chi dalani haydadim')).toEqual([]);
    expect(tagsOf('поле 5 полил, отара 2 в порядке')).toEqual([]);
    expect(tagsOf('field 3 irrigated, herd 2 fed')).toEqual([]);
  });

  it('knows a marked tag: a sign, a word, letters, a leading zero, a case ending', () => {
    for (const form of spellings("bugun 0567 raqamli qo'y o'ldi, ichi ketgan")) {
      expect(statedTags(form), form).toMatchObject([{ digits: '0567', marked: true, countLike: false }]);
    }
    for (const form of spellings('0567 ga 5 ml ivermektin qildim')) expect(sure(form), form).toEqual(['0567']);
    expect(statedTags('№ 567 сдохла')).toMatchObject([{ digits: '567', marked: true }]);
    expect(statedTags('#567 died')).toMatchObject([{ digits: '567', marked: true }]);
    expect(statedTags('raqami 567 bugun tortildi')).toMatchObject([{ digits: '567', marked: true }]);
    expect(statedTags('бирка 567 пала')).toMatchObject([{ digits: '567', marked: true }]);
    expect(statedTags('567ni tortdim')).toMatchObject([{ digits: '567', marked: true }]);
  });

  it('keeps letters that are joined to the number, with a hyphen, a space-free join, in any case', () => {
    expect(tagsOf('YA-0567 46 kilo')).toEqual(['YA-0567']);
    expect(tagsOf('ya-0567 46 kilo')).toEqual(['YA-0567']);
    expect(tagsOf('YA0567 46 kilo')).toEqual(['YA-0567']);
    expect(statedTags('ya 0567 46 kilo')).toMatchObject([{ tag: '0567', digits: '0567' }]);
    expect(statedTags('raqami 05 67 46 kilo').map((tag) => tag.digits)).toEqual(['05', '67']);
  });

  it('marks a bare number before an animal as possibly a count', () => {
    for (const form of spellings("bugun 5 qo'y o'ldi")) expect(statedTags(form), form).toMatchObject([{ digits: '5', countLike: true }]);
    expect(statedTags('5 овец пало')).toMatchObject([{ countLike: true }]);
    expect(statedTags('5 sheep died')).toMatchObject([{ countLike: true }]);
    expect(statedTags("5-chi qo'y o'ldi")).toMatchObject([{ digits: '5', countLike: false, marked: true }]);
  });

  it('finds each of two animals said in one sentence', () => {
    expect(sure("1234-qo'y 46 kilo, 1235-qo'y 48 kilo chiqdi")).toEqual(['1234', '1235']);
    expect(sure('№1234 и №1235 сдохли')).toEqual(['1234', '1235']);
  });
});

describe('quantitiesOfTag: a quantity backs one animal', () => {
  const kg = (text: string, digits: string) => {
    const tag = statedTags(text).find((found) => found.digits === digits)!;
    return quantitiesOfTag(text, tag, ['kg', 'g']).map((quantity) => quantity.qty);
  };

  it('gives one animal everything that was said', () => {
    for (const form of spellings("1234-qo'y 46 kilo chiqdi")) expect(kg(form, '1234'), form).toEqual([46]);
    expect(kg('46 кг, овца номер 1234', '1234')).toEqual([46]);
    expect(kg('sheep number 1234 weighed 46 kg', '1234')).toEqual([46]);
  });

  it('pairs two animals with two weights in the order they were said', () => {
    const text = "1234-qo'y 46 kilo, 1235-qo'y 48 kilo chiqdi";
    expect(kg(text, '1234')).toEqual([46]);
    expect(kg(text, '1235')).toEqual([48]);
    expect(kg('46 кг у № 1234, 48 кг у № 1235', '1234')).toEqual([46]);
    expect(kg('46 кг у № 1234, 48 кг у № 1235', '1235')).toEqual([48]);
  });

  it('does not share one weight between two animals', () => {
    for (const form of spellings("1234-qo'y va 1235-qo'y 46 kilo chiqdi")) {
      expect(kg(form, '1234'), form).toEqual([]);
      expect(kg(form, '1235'), form).toEqual([46]);
    }
    expect(kg('sheep number 1234 and number 1235 weighed 46 kg', '1234')).toEqual([]);
  });

  it('keeps millilitres apart from kilograms', () => {
    const text = '0567 ga 5 ml ivermektin qildim, 46 kilo edi';
    const tag = statedTags(text)[0];
    expect(quantitiesOfTag(text, tag, ['ml', 'l']).map((quantity) => quantity.qty)).toEqual([5]);
    expect(quantitiesOfTag(text, tag, ['kg']).map((quantity) => quantity.qty)).toEqual([46]);
  });

  it('reads the weight said straight after a tag that was said as a tag', () => {
    for (const form of spellings('YA-0567 46 kilo chiqdi')) expect(kg(form, '0567'), form).toEqual([46]);
    for (const form of spellings("0567 46 kilo bo'ldi")) expect(kg(form, '0567'), form).toEqual([46]);
    expect(kg('№567 46 кг', '567')).toEqual([46]);
    expect(kg('бирка 0567 46,5 кг', '0567')).toEqual([46.5]);
    expect(kg('tag 0567 46 kg', '0567')).toEqual([46]);
    expect(placedQuantities('YA-0567 46 kilo')).toEqual([{ qty: 46, unit: 'kilo', raw: '46 kilo', start: 8 }]);
    const two = 'YA-0567 46 kilo, YA-0568 48 kilo';
    expect(kg(two, '0567')).toEqual([46]);
    expect(kg(two, '0568')).toEqual([48]);
  });

  it('still asks when a bare number stands before the weight: it may be a range', () => {
    expect(kg('1234 46 kilo chiqdi', '1234')).toEqual([]);
    expect(placedQuantities('40 50 kilo beda')).toEqual([]);
  });

  it('leaves what parseQuantities finds unchanged, and adds the place', () => {
    const text = '1-otarga 300 kilo beda berdim';
    expect(parseQuantities(text)).toEqual([{ qty: 300, unit: 'kilo', raw: '300 kilo' }]);
    expect(placedQuantities(text)).toEqual([{ qty: 300, unit: 'kilo', raw: '300 kilo', start: 9 }]);
    expect(placedQuantities('taxminan 300 kilo')).toEqual([]);
  });
});

describe('deathWords', () => {
  it('hears a death in all four scripts', () => {
    for (const form of spellings("bugun 0567 raqamli qo'y o'ldi, ichi ketgan")) expect(deathWords(form), form).toBe(true);
    for (const form of spellings("0567 nobud bo'ldi")) expect(deathWords(form), form).toBe(true);
    for (const text of ['Овца № 567 сдохла', '567 пала ночью', 'ewe 567 died last night', 'found 567 dead']) expect(deathWords(text), text).toBe(true);
  });

  it('hears none where there is none', () => {
    for (const text of ['0567 46 kilo chiqdi', '0567 kasal', 'Овца № 567 не сдохла', 'ewe 567 is sick', '567 did not die']) {
      expect(deathWords(text), text).toBe(false);
    }
  });
});

describe('quoteFromWords: a name or a cause in the person\'s own words', () => {
  it('returns the wording the person used', () => {
    expect(quoteFromWords(["bugun 0567 raqamli qo'y o'ldi, Ichi ketgan"], 'ichi ketgan')).toBe('Ichi ketgan');
    expect(quoteFromWords([latinToCyrillic("0567 o'ldi, ichi ketgan")], 'ichi ketgan')).toBe(latinToCyrillic('ichi ketgan'));
    expect(quoteFromWords(['Овца 567 сдохла, вздутие живота'], 'вздутие живота')).toBe('вздутие живота');
    expect(quoteFromWords(['ewe 567 died of bloat'], 'Bloat')).toBe('bloat');
  });

  it('returns nothing for words the person never said', () => {
    expect(quoteFromWords(["0567 o'ldi, ichi ketgan"], 'diareya')).toBeNull();
    expect(quoteFromWords(["0567 o'ldi, ichi ketgan"], 'ketgan ichi')).toBeNull();
    expect(quoteFromWords(['Овца 567 сдохла'], 'вздутие')).toBeNull();
    expect(quoteFromWords(['ewe 567 died'], 'bloat')).toBeNull();
    expect(quoteFromWords(['ewe 567 died'], '')).toBeNull();
  });
});

describe('careWords', () => {
  it('tells a vaccination and a deworming from a treatment', () => {
    for (const form of spellings('1-otarni bugun emladim')) expect(careWords(form), form).toBe('vaccination');
    for (const form of spellings('1-otarga gijja dori berdim')) expect(careWords(form), form).toBe('deworming');
    for (const form of spellings('0567 ga 5 ml ivermektin qildim')) expect(careWords(form), form).toBe('treatment');
    expect(careWords('Отару 1 вакцинировали')).toBe('vaccination');
    expect(careWords('сделали прививку 567')).toBe('vaccination');
    expect(careWords('дали от глистов')).toBe('deworming');
    expect(careWords('vaccinated herd 1')).toBe('vaccination');
    expect(careWords('dewormed herd 1')).toBe('deworming');
    expect(careWords('gave 567 5 ml of oxytetracycline')).toBe('treatment');
  });
});

describe('birthWords: lambs as they were said', () => {
  it('reads twins with one of each sex, in every Uzbek spelling', () => {
    for (const form of spellings("0567 egiz tug'di, bitta erkak bitta urg'ochi")) {
      expect(birthWords(form), form).toEqual({ born: true, total: 2, male: 1, female: 1, dead: 0 });
    }
  });

  it('reads Russian and English', () => {
    expect(birthWords('Овца 567 окотилась двойней, один баранчик и одна ярочка')).toEqual({ born: true, total: 2, male: 1, female: 1, dead: 0 });
    expect(birthWords('ewe 567 lambed twins, one male and one female')).toEqual({ born: true, total: 2, male: 1, female: 1, dead: 0 });
    expect(birthWords('ewe 567 lambed, 2 ewe lambs')).toEqual({ born: true, total: null, male: 0, female: 2, dead: 0 });
  });

  it('counts the dead and leaves unknown what was not said', () => {
    expect(birthWords("0567 tug'di, 2 ta erkak, bittasi o'lik")).toEqual({ born: true, total: null, male: 2, female: 0, dead: 1 });
    expect(birthWords("0567 qo'zilab berdi")).toEqual({ born: true, total: null, male: 0, female: 0, dead: 0 });
    expect(birthWords('окотилась тройней, один мёртвый')).toEqual({ born: true, total: 3, male: 0, female: 0, dead: 1 });
    expect(birthWords('0567 46 kilo chiqdi').born).toBe(false);
    expect(birthWords('ewe 567 has not lambed').born).toBe(false);
  });
});

describe('fieldWorkWords', () => {
  it('names the work in all four scripts', () => {
    for (const form of spellings("3-dalani bugun sug'ordim")) expect(fieldWorkWords(form), form).toEqual(['irrigation']);
    for (const form of spellings('5-dalaga 200 kilo selitra sepdim')) expect(fieldWorkWords(form), form).toEqual(['fertilizing']);
    for (const form of spellings('2-dalani haydadim')) expect(fieldWorkWords(form), form).toEqual(['tillage']);
    for (const form of spellings("1-dalaga bug'doy ekdim")) expect(fieldWorkWords(form), form).toEqual(['sowing']);
    expect(fieldWorkWords('Поле 3 полили')).toEqual(['irrigation']);
    expect(fieldWorkWords('внёс 200 кг селитры на поле 5')).toEqual(['fertilizing']);
    expect(fieldWorkWords('вспахали поле 2')).toEqual(['tillage']);
    expect(fieldWorkWords('irrigated field 3 today')).toEqual(['irrigation']);
    expect(fieldWorkWords('spread 200 kg of nitrate on field 5')).toEqual(['fertilizing']);
    expect(fieldWorkWords('sprayed field 2 against aphids')).toEqual(['protection']);
  });

  it('names nothing it was not told, and both when two were said', () => {
    expect(fieldWorkWords('3-dalada edim')).toEqual([]);
    expect(fieldWorkWords("3-dalani haydab sug'ordim").sort()).toEqual(['irrigation', 'tillage']);
  });
});

describe('dates of a farm record lean on the same evidence as money', () => {
  it('reads yesterday in all four scripts', () => {
    for (const form of spellings("kecha 1234-qo'y 46 kilo chiqdi")) expect(dateEvidence(form, '2026-11-10').dates, form).toEqual(['2026-11-09']);
    expect(dateEvidence('вчера овца 1234 весила 46 кг', '2026-11-10').dates).toEqual(['2026-11-09']);
    expect(dateEvidence('yesterday sheep 1234 weighed 46 kg', '2026-11-10').dates).toEqual(['2026-11-09']);
  });
});
