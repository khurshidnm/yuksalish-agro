import { PRODUCT_NAME } from '../brand';

/**
 * Uzbek Latin → Cyrillic transliteration. The Cyrillic UI is derived from the Latin
 * dictionaries at load time, so the two scripts can never drift apart.
 */

const KEEP_WORDS = new Set(['Excel', 'Keeping', 'Google', 'Chrome', 'Safari', 'Didox', 'Claude', 'iOS', 'Android', 'Email', 'Webhook', 'MediaMTX', 'pH', 'Feedipedia', 'Copernicus', 'Sentinel', 'Norway']);

/** Uzbek acronyms, which unlike foreign ones change script. */
const ACRONYMS: Record<string, string> = { STIR: 'СТИР', MFO: 'МФО' };

/** Loanword stems the letters alone get wrong. Any ending follows: kompyuterda → компьютерда. */
const STEMS: [string, string][] = [
  ['vaksin', 'вакцин'],
  ['kompyuter', 'компьютер'],
  ['obyekt', 'объект'],
];

/** Words whose regular transliteration is wrong. Key is lower case Latin. */
const OVERRIDES: Record<string, string> = {
  telegram: 'телеграм',
  yanvar: 'январь',
  fevral: 'февраль',
  aprel: 'апрель',
  iyun: 'июнь',
  iyul: 'июль',
  sentabr: 'сентябрь',
  oktabr: 'октябрь',
  noyabr: 'ноябрь',
  dekabr: 'декабрь',
  ketsin: 'кетсин',
  ketsa: 'кетса',
  // "sh" written across a morpheme boundary
  ishoq: 'исҳоқ',
};

const LETTERS: Record<string, string> = {
  a: 'а', b: 'б', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'ҳ', i: 'и', j: 'ж', k: 'к', l: 'л', m: 'м',
  n: 'н', o: 'о', p: 'п', q: 'қ', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', x: 'х', y: 'й', z: 'з',
  c: 'с', w: 'в',
};

const APOSTROPHE = /[ʻʼ‘’'`]/;
const VOWELS = 'aeiouAEIOU';

function matchCase(source: string, target: string): string {
  if (source === source.toUpperCase() && source !== source.toLowerCase()) return target.toUpperCase();
  if (source[0] === source[0].toUpperCase() && source[0] !== source[0].toLowerCase()) {
    return target[0].toUpperCase() + target.slice(1);
  }
  return target;
}

function transliterateWord(word: string): string {
  const override = OVERRIDES[word.toLowerCase()];
  if (override) return matchCase(word, override);

  let out = '';
  let i = 0;
  while (i < word.length) {
    const ch = word[i];
    const next = word[i + 1] ?? '';
    const lower = ch.toLowerCase();
    const nextLower = next.toLowerCase();
    const prev = word[i - 1] ?? '';
    const atWordStart = i === 0;
    const afterVowel = prev !== '' && VOWELS.includes(prev);

    if ((lower === 'o' || lower === 'g') && next && APOSTROPHE.test(next)) {
      out += ch === lower ? (lower === 'o' ? 'ў' : 'ғ') : lower === 'o' ? 'Ў' : 'Ғ';
      i += 2;
      continue;
    }
    if (lower === 's' && nextLower === 'h') {
      out += ch === lower ? 'ш' : 'Ш';
      i += 2;
      continue;
    }
    if (lower === 'c' && nextLower === 'h') {
      out += ch === lower ? 'ч' : 'Ч';
      i += 2;
      continue;
    }
    if (lower === 'y' && 'oaue'.includes(nextLower) && nextLower !== '') {
      const map: Record<string, string> = { o: 'ё', u: 'ю', a: 'я', e: 'е' };
      // "yo'" is й + ў, as in "yo'l".
      const afterNext = word[i + 2] ?? '';
      if (!(nextLower === 'o' && APOSTROPHE.test(afterNext))) {
        const letter = map[nextLower];
        out += ch === lower ? letter : letter.toUpperCase();
        i += 2;
        continue;
      }
    }
    // Loanwords: ratsion → рацион, operatsiya → операция, litsenziya → лицензия. Not the Uzbek endings
    // -siz and -sin after a t: internetsiz → интернетсиз, yetsin → етсин. Meditsina is a loanword.
    const suffix = /^(siz|sin(?![ao]))/.test(word.slice(i + 1).toLowerCase());
    if (lower === 't' && nextLower === 's' && 'ie'.includes((word[i + 2] ?? '').toLowerCase()) && word[i + 2] && !suffix) {
      out += ch === lower ? 'ц' : 'Ц';
      i += 2;
      continue;
    }
    if (lower === 'e' && (atWordStart || afterVowel)) {
      out += ch === lower ? 'э' : 'Э';
      i += 1;
      continue;
    }
    if (APOSTROPHE.test(ch)) {
      // Only inside a word: an apostrophe used as a quote mark stays as it is.
      out += prev && next && /\p{L}/u.test(prev) && /\p{L}/u.test(next) ? 'ъ' : ch;
      i += 1;
      continue;
    }
    const mapped = LETTERS[lower];
    if (mapped) out += ch === lower ? mapped : mapped.toUpperCase();
    else out += ch;
    i += 1;
  }
  return out;
}

const WORD = /[\p{L}ʻʼ‘’'`]+/gu;
/** Placeholders, tags and addresses, and after a space or bracket a path (/api/docs) or a file type (.xlsx). */
const PROTECTED = /(\{\{[^}]*\}\}|<[^>]+>|https?:\/\/\S+|(?<=^|[\s(])\/[a-z][\w/-]*|(?<=[\s(])\.[a-z]{3,4}\b)/g;

/** Transliterate text, leaving i18n placeholders, tags, URLs, acronyms and brands untouched. */
export function latinToCyrillic(text: string): string {
  // The product name is a brand, written the same way in every script.
  return text.split(PRODUCT_NAME).map(transliterateText).join(PRODUCT_NAME);
}

function transliterateText(text: string): string {
  return text
    .split(PROTECTED)
    .map((part, index) => {
      if (index % 2 === 1) return part; // captured protected fragment
      return part.replace(WORD, (word) => {
        if (KEEP_WORDS.has(word)) return word;
        if (ACRONYMS[word]) return ACRONYMS[word];
        const isAcronym = word.length > 1 && word === word.toUpperCase() && /[A-Z]/.test(word);
        if (isAcronym) return word;
        // PDF'ga: the acronym stays, its ending changes script.
        const ending = /^([A-Z]{2,})(['ʻʼ‘’`])(\p{L}+)$/u.exec(word);
        if (ending) return `${ending[1]}${ending[2]}${transliterateWord(ending[3])}`;
        const stem = STEMS.find(([latin]) => word.toLowerCase().startsWith(latin));
        if (stem) {
          const cyrillic = word[0] === word[0].toLowerCase() ? stem[1] : stem[1][0].toUpperCase() + stem[1].slice(1);
          return cyrillic + transliterateWord(word.slice(stem[0].length));
        }
        return transliterateWord(word);
      });
    })
    .join('');
}

/** Apply `fn` to every string in a nested dictionary. */
export function mapStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === 'string') return fn(value) as T;
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)])) as T;
  }
  return value;
}
