/**
 * What a new password must be. It has no dependencies, because the migration checks the first
 * admin's password before the API's configuration exists. Existing passwords are never rechecked.
 */
export const MIN_PASSWORD_LENGTH = 10;

/** bcrypt ignores everything after this, so a longer password would only look stronger. */
export const MAX_PASSWORD_BYTES = 72;

export type PasswordProblem = 'PASSWORD_TOO_SHORT' | 'PASSWORD_TOO_LONG' | 'PASSWORD_TOO_COMMON' | 'PASSWORD_CONTAINS_PHONE';

/** Common on any list, plus what people here reach for: the app, the farm, places and family words. */
const COMMON_WORDS = new Set(
  `password passw0rd passcode pass admin administrator root user login welcome letmein changeme secret master
  access default guest test demo qwerty qwertyuiop qwertyui asdfgh asdfghjkl zxcvbn zxcvbnm ytrewq iloveyou
  loveyou love lovely football baseball basketball soccer hockey superman batman spiderman dragon monkey shadow
  sunshine princess michael charlie jordan liverpool arsenal chelsea barcelona realmadrid samsung iphone nokia
  google yandex telegram computer internet whatever freedom starwars mustang trustno trustnoone hello hellothere
  abc abcd abcde abcdef abcdefg abcdefgh abcdefghij
  parol parolim parolcha mening menikiman salom salomlar assalom assalomu dunyo vatan onam otam oilam ukam akam
  opam bolam sevgi sevaman muhabbat bismillah allah alloh inshaalloh
  yuksalish yuksalishagro yuksalishferma agro agroferma agropanel ferma fermer dehqon hisori qoy qoylar chorva bogdorchilik
  uzbekistan uzbek ozbekiston ozbek ozbegim toshkent tashkent samarqand samarkand buxoro bukhara qashqadaryo
  surxondaryo termiz qarshi navoiy jizzax sirdaryo andijon fargona namangan xorazm urganch qorovulbozor
  пароль парольпароль йцукен йцукенг йцукенгшщз фывапролд админ привет любовь ташкент узбекистан`.split(/\s+/),
);

/** Whole passwords no word-and-number rule would catch. */
const COMMON_PASSWORDS = new Set([
  '1q2w3e4r5t',
  '1q2w3e4r5t6y',
  'q1w2e3r4t5',
  'q1w2e3r4t5y6',
  '1qaz2wsx3edc',
  '1qazxsw23edc',
  'qazwsxedc',
  'qazwsxedcrfv',
  'zaq12wsxcde3',
  'q2w3e4r5t6',
  '1a2b3c4d5e',
  'a1b2c3d4e5',
  'a1s2d3f4g5',
  '1234qwer',
  '1234qwerty',
  'qwer1234',
  'qwerty1234',
  'asdf1234',
  'zxcv1234',
  '123456789a',
  'a123456789',
  '123456789q',
  'q123456789',
  '123456qwerty',
  'qwerty123456',
]);

/** Walking along a row of the keyboard or counting, in either direction. */
const SEQUENCES = ['0123456789', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm', 'abcdefghijklmnopqrstuvwxyz', 'йцукенгшщзхъ', 'фывапролджэ', 'ячсмитьбю'];

const LEET: Record<string, string> = { '@': 'a', '4': 'a', '0': 'o', '1': 'i', '!': 'i', '3': 'e', '$': 's', '5': 's', '7': 't' };

const reversed = (text: string) => [...text].reverse().join('');

function isSequence(text: string): boolean {
  if (text.length < 4) return false;
  return SEQUENCES.some((row) => {
    const loop = row + row;
    return loop.includes(text) || reversed(loop).includes(text);
  });
}

/** The word left once the numbers and marks people add to meet a rule are gone. */
function coreWord(lower: string): string {
  return lower.replace(/^[^\p{L}]+/u, '').replace(/[^\p{L}]+$/u, '');
}

function isCommon(password: string): boolean {
  const plain = password.toLowerCase().replace(/[\s'`’ʻʼ_.-]/g, '');
  const core = coreWord(plain);
  const unleet = [...core].map((ch) => LEET[ch] ?? ch).join('');
  if (COMMON_PASSWORDS.has(plain) || [plain, core, unleet].some((word) => COMMON_WORDS.has(word))) return true;
  // Few different characters, a short piece repeated, or a walk along the keyboard.
  if (new Set(plain).size <= 3 || /^(.+?)\1+$/.test(plain)) return true;
  const digits = plain.replace(/\D/g, '');
  return isSequence(plain) || isSequence(core) || (isSequence(digits) && plain.length - digits.length <= 2);
}

/** Null when the password may be used. `phone` is the account's own number. */
export function passwordProblem(password: string, phone?: string): PasswordProblem | null {
  if ([...password].length < MIN_PASSWORD_LENGTH) return 'PASSWORD_TOO_SHORT';
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) return 'PASSWORD_TOO_LONG';
  const digits = password.replace(/\D/g, '');
  if (phone && digits.includes(phone.replace(/\D/g, '').slice(-9))) return 'PASSWORD_CONTAINS_PHONE';
  return isCommon(password) ? 'PASSWORD_TOO_COMMON' : null;
}
