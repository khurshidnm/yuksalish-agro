import type { I18nName } from '../db/schema';

const n = (uz: string, ru: string, en: string): I18nName => ({ uz, ru, en });

/** One counterparty holds the wages owed. They are paid from the payroll run, which knows what each person gets. */
export const PAYROLL_COUNTERPARTY = 'Xodimlar (ish haqi)';

export const DEFAULT_DIVISIONS = [
  { key: 'crops', name: "Dehqonchilik" },
  { key: 'livestock', name: "Qo'ychilik" },
  { key: 'machinery', name: 'Mexanizatsiya' },
  { key: 'admin', name: 'Boshqaruv' },
];

export const DEFAULT_SPECIES = [
  { key: 'sheep', name: n("Qo'y", 'Овца', 'Sheep'), gestationDays: 150, gestationMinDays: 145, gestationMaxDays: 152 },
  { key: 'goat', name: n('Echki', 'Коза', 'Goat'), gestationDays: 150, gestationMinDays: 145, gestationMaxDays: 155 },
  { key: 'cattle', name: n('Qoramol', 'Крупный рогатый скот', 'Cattle'), gestationDays: 283, gestationMinDays: 279, gestationMaxDays: 292 },
  { key: 'horse', name: n('Ot', 'Лошадь', 'Horse'), gestationDays: 340, gestationMinDays: 320, gestationMaxDays: 370 },
  { key: 'poultry', name: n('Parranda', 'Птица', 'Poultry'), gestationDays: 21, gestationMinDays: 20, gestationMaxDays: 22 },
];

export const DEFAULT_BREEDS: { species: string; key: string; name: I18nName }[] = [
  { species: 'sheep', key: 'hisori', name: n('Hisori', 'Гиссарская', 'Hissar') },
  { species: 'sheep', key: 'jaydari', name: n('Jaydari', 'Местная', 'Jaydari') },
  { species: 'sheep', key: 'qorakol', name: n("Qorako'l", 'Каракульская', 'Karakul') },
  { species: 'sheep', key: 'edilbay', name: n('Edilbay', 'Эдильбаевская', 'Edilbay') },
  { species: 'goat', key: 'local_goat', name: n('Mahalliy echki', 'Местная коза', 'Local goat') },
  { species: 'cattle', key: 'simmental', name: n('Simmental', 'Симментальская', 'Simmental') },
  { species: 'cattle', key: 'holstein', name: n('Golshteyn', 'Голштинская', 'Holstein') },
];

export const DEFAULT_CROPS: { key: string; name: I18nName; isFeed: boolean }[] = [
  { key: 'wheat', name: n("Bug'doy", 'Пшеница', 'Wheat'), isFeed: false },
  { key: 'barley', name: n('Arpa', 'Ячмень', 'Barley'), isFeed: true },
  { key: 'rice', name: n('Sholi', 'Рис', 'Rice'), isFeed: false },
  { key: 'alfalfa', name: n('Beda', 'Люцерна', 'Alfalfa'), isFeed: true },
  { key: 'corn', name: n("Makkajo'xori", 'Кукуруза', 'Corn'), isFeed: true },
  { key: 'cotton', name: n('Paxta', 'Хлопок', 'Cotton'), isFeed: false },
];

type Category = { kind: 'expense' | 'income'; group: string; key: string; name: I18nName };

const expense = (group: string, key: string, uz: string, ru: string, en: string): Category => ({
  kind: 'expense',
  group,
  key,
  name: n(uz, ru, en),
});
const income = (group: string, key: string, uz: string, ru: string, en: string): Category => ({
  kind: 'income',
  group,
  key,
  name: n(uz, ru, en),
});

/** Spec 10.1 and 10.2. Keys are stable; code may look categories up by key. */
export const DEFAULT_CATEGORIES: Category[] = [
  expense('livestock', 'animal_purchase', 'Hayvon xaridi', 'Покупка животных', 'Animal purchase'),
  expense('livestock', 'feed', 'Ozuqa', 'Корма', 'Feed'),
  expense('livestock', 'veterinary', 'Veterinariya', 'Ветеринария', 'Veterinary'),
  expense('livestock', 'tags_devices', 'Birka va qurilmalar', 'Бирки и устройства', 'Tags and devices'),
  expense('livestock', 'shearing', 'Junqirqish', 'Стрижка', 'Shearing'),
  expense('crops', 'seed', "Urug'", 'Семена', 'Seed'),
  expense('crops', 'fertilizer', "O'g'it", 'Удобрения', 'Fertilizer'),
  expense('crops', 'crop_protection', 'Himoya vositalari', 'Средства защиты', 'Crop protection'),
  expense('crops', 'water', 'Suv haqi', 'Плата за воду', 'Water fee'),
  expense('crops', 'mechanization_service', 'Mexanizatsiya xizmati', 'Услуги механизации', 'Machinery services'),
  expense('labor', 'salary', 'Ish haqi', 'Заработная плата', 'Salaries'),
  expense('labor', 'bonus', 'Ustamalar', 'Надбавки', 'Bonuses'),
  expense('labor', 'payroll_tax', 'Soliqlar', 'Налоги', 'Payroll taxes'),
  expense('labor', 'meals', 'Ovqatlanish', 'Питание', 'Meals'),
  expense('labor', 'clothing', 'Kiyim', 'Спецодежда', 'Workwear'),
  expense('labor', 'casual_labour', 'Kunlik ishchilar haqi', 'Оплата подённых работников', 'Day labour'),
  expense('machinery', 'fuel', "Yoqilg'i", 'Топливо', 'Fuel'),
  expense('machinery', 'repair', "Ta'mirlash", 'Ремонт', 'Repairs'),
  expense('machinery', 'spare_parts', 'Ehtiyot qismlar', 'Запчасти', 'Spare parts'),
  expense('machinery', 'depreciation', 'Amortizatsiya', 'Амортизация', 'Depreciation'),
  expense('machinery', 'equipment_rent', 'Ijara', 'Аренда', 'Equipment rental'),
  expense('infrastructure', 'electricity', 'Elektr', 'Электроэнергия', 'Electricity'),
  expense('infrastructure', 'gas', 'Gaz', 'Газ', 'Gas'),
  expense('infrastructure', 'utility_water', 'Suv', 'Вода', 'Water'),
  expense('infrastructure', 'construction_repair', "Qurilish va ta'mirlash", 'Строительство и ремонт', 'Construction and repair'),
  expense('infrastructure', 'security_guard', 'Qorovul', 'Охрана', 'Security'),
  expense('admin', 'communication', 'Aloqa', 'Связь', 'Communication'),
  expense('admin', 'transport', 'Transport', 'Транспорт', 'Transport'),
  expense('admin', 'paperwork', 'Hujjatlar', 'Документы', 'Paperwork'),
  expense('admin', 'licenses', 'Litsenziyalar', 'Лицензии', 'Licenses'),
  expense('admin', 'bank_fees', 'Bank xizmati', 'Банковские услуги', 'Bank fees'),
  expense('financial', 'loan_interest', 'Kredit foizlari', 'Проценты по кредиту', 'Loan interest'),
  expense('financial', 'insurance', "Sug'urta", 'Страхование', 'Insurance'),
  expense('financial', 'leasing', "Lizing to'lovlari", 'Лизинговые платежи', 'Leasing payments'),
  expense('financial', 'cash_shortage', 'Kassa kamomadi', 'Недостача в кассе', 'Cash shortage'),
  expense('investment', 'barn_construction', 'Molxona qurilishi', 'Строительство кошары', 'Barn construction'),
  expense('investment', 'machinery_purchase', 'Texnika xaridi', 'Покупка техники', 'Machinery purchase'),
  expense('investment', 'camera_system', 'Kamera tizimi', 'Система камер', 'Camera system'),
  expense('investment', 'land_purchase', 'Yer xaridi', 'Покупка земли', 'Land purchase'),
  income('livestock_sales', 'lamb_sales', "Qo'zilar sotuvi", 'Продажа ягнят', 'Lamb sales'),
  income('livestock_sales', 'sheep_sales', "Qo'ylar sotuvi", 'Продажа овец', 'Sheep sales'),
  income('product_sales', 'meat_sales', "Go'sht sotuvi", 'Продажа мяса', 'Meat sales'),
  income('product_sales', 'wool_sales', 'Jun sotuvi', 'Продажа шерсти', 'Wool sales'),
  income('crop_sales', 'grain_sales', 'Don sotuvi', 'Продажа зерна', 'Grain sales'),
  income('crop_sales', 'alfalfa_sales', 'Beda sotuvi', 'Продажа люцерны', 'Alfalfa sales'),
  income('breeding_sales', 'breeding_stock_sales', 'Nasldor hayvonlar sotuvi', 'Продажа племенных животных', 'Breeding stock sales'),
  income('subsidy', 'subsidies', 'Subsidiyalar', 'Субсидии', 'Subsidies'),
  income('subsidy', 'compensations', 'Kompensatsiyalar', 'Компенсации', 'Compensations'),
  income('subsidy', 'grants', 'Grantlar', 'Гранты', 'Grants'),
  income('other_income', 'services_income', "Xizmat ko'rsatish", 'Услуги', 'Services'),
  income('other_income', 'rent_income', 'Ijara daromadi', 'Доход от аренды', 'Rental income'),
  income('other_income', 'other', 'Boshqa daromadlar', 'Прочие доходы', 'Other income'),
  income('other_income', 'cash_surplus', 'Kassa ortiqchasi', 'Излишек в кассе', 'Cash surplus'),
];
