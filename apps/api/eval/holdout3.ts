// Blind holdout set 3 for the farm accounting assistant.
// Written from the design and the farm facts alone, without seeing the code, the tests or other eval files.

type Card = {
  kind: 'expense' | 'stock_purchase' | 'income' | 'debt_payment' | 'transfer';
  amount: number;
  category?: string;
  targetType?: 'general' | 'field' | 'herd' | 'asset';
  target?: string;
  account?: string;
  item?: string;
  qty?: number;
  counterparty?: string;
  treatment?: 'expense' | 'inventory' | 'capex' | 'animal';
  currency?: string;
  daysAgo?: number;
};

type Case = {
  id: string;
  group: string;
  say: string[];
  cards?: Card[];
  asks?: string[];
  refuses?: boolean;
  usesTool?: string;
};

const cases: Case[] = [
  // ---------------------------------------------------------------- full (33)
  {
    id: 'c-full-01',
    group: 'full',
    say: ['kecha neft bazadan 600 litr salyarka oldik litri 13500 dan naqd berdim'],
    cards: [{ kind: 'stock_purchase', amount: 8100000, item: 'Dizel', qty: 600, account: 'Kassa', treatment: 'inventory', daysAgo: 1 }],
  },
  {
    id: 'c-full-02',
    group: 'full',
    say: ['3 kun oldin 4 tonna karbamid oldik 22 mln bankdan perechisleniya qildik'],
    cards: [{ kind: 'stock_purchase', amount: 22000000, item: 'Karbamid', qty: 4000, account: 'Agrobank', treatment: 'inventory', daysAgo: 3 }],
  },
  {
    id: 'c-full-03',
    group: 'full',
    say: ['ozagrourugdan 3 tonna urugluk bugdoy oldim 15 mln ga qarzga'],
    cards: [{ kind: 'stock_purchase', amount: 15000000, item: "Bug'doy urug'i", qty: 3000, counterparty: 'AgroUrug', treatment: 'inventory' }],
  },
  {
    id: 'c-full-04',
    group: 'full',
    say: ['aka assalomu alaykum kecha yemga bugdoy oldik uch tonna 12 million kassadan berdik shuni yozib qoying'],
    cards: [{ kind: 'stock_purchase', amount: 12000000, item: "Bug'doy (yem)", qty: 3000, account: 'Kassa', treatment: 'inventory', daysAgo: 1 }],
  },
  {
    id: 'c-full-05',
    group: 'full',
    say: ['bugun svet uchun 3 mln 150 ming xisobdan tolandi'],
    cards: [{ kind: 'expense', amount: 3150000, category: 'Elektr', targetType: 'general', account: 'Agrobank', treatment: 'expense', daysAgo: 0 }],
  },
  {
    id: 'c-full-06',
    group: 'full',
    say: ['mtz 82 ni ustaga tuzattirdim bir yarim mln kassadan'],
    cards: [{ kind: 'expense', amount: 1500000, category: "Ta'mirlash", targetType: 'asset', target: 'MTZ-82', account: 'Kassa', treatment: 'expense' }],
  },
  {
    id: 'c-full-07',
    group: 'full',
    say: ['2 dalani agroservis haydab berdi 4 mln 200 ming bankdan otkazdik'],
    cards: [{ kind: 'expense', amount: 4200000, category: 'Mexanizatsiya xizmati', targetType: 'field', target: "O'rta dala", account: 'Agrobank', treatment: 'expense' }],
  },
  {
    id: 'c-full-08',
    group: 'full',
    say: ['junqirqish xizmatiga 2 mln 700 ming naqd berildi'],
    cards: [{ kind: 'expense', amount: 2700000, category: 'Junqirqish', targetType: 'herd', target: "Bo'g'oz sovliqlar", account: 'Kassa', treatment: 'expense' }],
  },
  {
    id: 'c-full-09',
    group: 'full',
    say: ['yangi traktor oldik 185 mln bankdan tolandi'],
    cards: [{ kind: 'expense', amount: 185000000, category: 'Texnika xaridi', targetType: 'general', account: 'Agrobank', treatment: 'capex' }],
  },
  {
    id: 'c-full-10',
    group: 'full',
    say: ['sherobod chorvadan 25 ta sovliq oldik bogoz sovliqlar suruviga qoshdik 75 mln xisobdan'],
    cards: [{ kind: 'expense', amount: 75000000, category: 'Hayvon xaridi', targetType: 'herd', target: "Bo'g'oz sovliqlar", account: 'Agrobank', treatment: 'animal' }],
  },
  {
    id: 'c-full-11',
    group: 'full',
    say: ['xisobga subsidiya tushdi 18 mln'],
    cards: [{ kind: 'income', amount: 18000000, category: 'Subsidiyalar', account: 'Agrobank' }],
  },
  {
    id: 'c-full-12',
    group: 'full',
    say: ['yem savdoga qarzimizdan 6 mln xisobdan otkazib berdik'],
    cards: [{ kind: 'debt_payment', amount: 6000000, account: 'Agrobank', counterparty: 'Yem Savdo' }],
  },
  {
    id: 'c-full-13',
    group: 'full',
    say: ['litsenziya yangilash uchun 300 dollar xisobdan toladik'],
    cards: [{ kind: 'expense', amount: 300, currency: 'USD', category: 'Litsenziyalar', targetType: 'general', account: 'Agrobank', treatment: 'expense' }],
  },
  {
    id: 'c-full-14',
    group: 'full',
    say: ['Банкдан 12 млн нақд ечиб кассага қўйдик'],
    cards: [{ kind: 'transfer', amount: 12000000, account: 'Agrobank' }],
  },
  {
    id: 'c-full-15',
    group: 'full',
    say: ['Кеча 3 тонна кепак олдик, тоннаси 2 млн 300 минг, кассадан тўладик'],
    cards: [{ kind: 'stock_purchase', amount: 6900000, item: 'Kepak', qty: 3000, account: 'Kassa', treatment: 'inventory', daysAgo: 1 }],
  },
  {
    id: 'c-full-16',
    group: 'full',
    say: ['4-дала учун сув ҳақини ҳисобдан ўтказдик 1 млн 400 минг'],
    cards: [{ kind: 'expense', amount: 1400000, category: 'Suv haqi', targetType: 'field', target: 'Beda dalasi', account: 'Agrobank', treatment: 'expense' }],
  },
  {
    id: 'c-full-17',
    group: 'full',
    say: ['Уч кун олдин ишчиларга тушлик олиб бердим 650 минг нақд'],
    cards: [{ kind: 'expense', amount: 650000, category: 'Ovqatlanish', targetType: 'general', account: 'Kassa', treatment: 'expense', daysAgo: 3 }],
  },
  {
    id: 'c-full-18',
    group: 'full',
    say: ['Кузатув камералари ўрнатдик, 7 млн 500 минг банкдан кетди'],
    cards: [{ kind: 'expense', amount: 7500000, category: 'Kamera tizimi', targetType: 'general', account: 'Agrobank', treatment: 'capex' }],
  },
  {
    id: 'c-full-19',
    group: 'full',
    say: ['Вчера взяли 700 литров соляры по 13200, налом отдал'],
    cards: [{ kind: 'stock_purchase', amount: 9240000, item: 'Dizel', qty: 700, account: 'Kassa', treatment: 'inventory', daysAgo: 1 }],
  },
  {
    id: 'c-full-20',
    group: 'full',
    say: ['Взяли в долг у Бухоро Ем Савдо жмых 5 тонн на 16 млн'],
    cards: [{ kind: 'stock_purchase', amount: 16000000, item: 'Kunjara', qty: 5000, counterparty: 'Yem Savdo', treatment: 'inventory' }],
  },
  {
    id: 'c-full-21',
    group: 'full',
    say: ['Вакцина от ящура 400 доз по 2500 сум, оплатили безналом'],
    cards: [{ kind: 'stock_purchase', amount: 1000000, item: 'Oqsil vaksinasi', qty: 400, account: 'Agrobank', treatment: 'inventory' }],
  },
  {
    id: 'c-full-22',
    group: 'full',
    say: ['позавчера ветврач смотрел отару пятьсот тысяч налом отдали запиши'],
    cards: [{ kind: 'expense', amount: 500000, category: 'Veterinariya', targetType: 'herd', target: "Bo'g'oz sovliqlar", account: 'Kassa', treatment: 'expense', daysAgo: 2 }],
  },
  {
    id: 'c-full-23',
    group: 'full',
    say: ['Охранному агентству по договору перечислили 1,8 млн'],
    cards: [{ kind: 'expense', amount: 1800000, category: 'Qorovul', targetType: 'general', account: 'Agrobank', treatment: 'expense' }],
  },
  {
    id: 'c-full-24',
    group: 'full',
    say: ['За аренду комбайна на уборке перечислили 9 млн'],
    cards: [{ kind: 'expense', amount: 9000000, category: 'Ijara', targetType: 'asset', target: 'Kombayn', account: 'Agrobank', treatment: 'expense' }],
  },
  {
    id: 'c-full-25',
    group: 'full',
    say: ['На строительство новой кошары ушло 42 ляма с расчётного'],
    cards: [{ kind: 'expense', amount: 42000000, category: 'Molxona qurilishi', targetType: 'general', account: 'Agrobank', treatment: 'capex' }],
  },
  {
    id: 'c-full-26',
    group: 'full',
    say: ['От страховой пришла компенсация 6 млн на счёт'],
    cards: [{ kind: 'income', amount: 6000000, category: 'Kompensatsiyalar', account: 'Agrobank' }],
  },
  {
    id: 'c-full-27',
    group: 'full',
    say: ['Погасили Бухоро Ем Савдо часть долга, 5 млн наличными'],
    cards: [{ kind: 'debt_payment', amount: 5000000, account: 'Kassa', counterparty: 'Yem Savdo' }],
  },
  {
    id: 'c-full-28',
    group: 'full',
    say: ['Сдали из кассы на расчётный счёт 9 млн'],
    cards: [{ kind: 'transfer', amount: 9000000, account: 'Kassa' }],
  },
  {
    id: 'c-full-29',
    group: 'full',
    say: ['Two days ago we paid 480k cash to the notary for the land papers'],
    cards: [{ kind: 'expense', amount: 480000, category: 'Hujjatlar', targetType: 'general', account: 'Kassa', treatment: 'expense', daysAgo: 2 }],
  },
  {
    id: 'c-full-30',
    group: 'full',
    say: ['Bought 1.5 tonnes of ammophos for 11 million, paid from the bank'],
    cards: [{ kind: 'stock_purchase', amount: 11000000, item: 'Ammofos', qty: 1500, account: 'Agrobank', treatment: 'inventory' }],
  },
  {
    id: 'c-full-31',
    group: 'full',
    say: ['Neighbour rented our MTZ tractor for a week and handed me 3 million in cash'],
    cards: [{ kind: 'income', amount: 3000000, category: 'Ijara daromadi', account: 'Kassa' }],
  },
  {
    id: 'c-full-32',
    group: 'full',
    say: ['Yesterday we bought 40 vials of Tetravit, 2.4 million, paid cash'],
    cards: [{ kind: 'stock_purchase', amount: 2400000, item: 'Tetravit', qty: 40, account: 'Kassa', treatment: 'inventory', daysAgo: 1 }],
  },
  {
    id: 'c-full-33',
    group: 'full',
    say: ['Bank took a 95 thousand service fee off the account yesterday'],
    cards: [{ kind: 'expense', amount: 95000, category: 'Bank xizmati', targetType: 'general', account: 'Agrobank', treatment: 'expense', daysAgo: 1 }],
  },

  // ---------------------------------------------------------------- ask (27)
  { id: 'c-ask-01', group: 'ask', say: ['svetga pul berib keldim kassadan'], cards: [], asks: ['amount'] },
  { id: 'c-ask-02', group: 'ask', say: ['gaz puli 1 mln 400 ming toladik'], cards: [], asks: ['paymentMethod'] },
  { id: 'c-ask-03', group: 'ask', say: ['traktorga remont qildirdik 1 mln 800 ming naqd'], cards: [], asks: ['target'] },
  { id: 'c-ask-04', group: 'ask', say: ['10 ta qochqor oldik 32 mln xisobdan'], cards: [], asks: ['target'] },
  { id: 'c-ask-05', group: 'ask', say: ['salyarkaga 5 mln naqd berdim'], cards: [], asks: ['qty'] },
  { id: 'c-ask-06', group: 'ask', say: ['bugdoy oldim 2 tonna 8 mln naqd'], cards: [], asks: ['item'] },
  { id: 'c-ask-07', group: 'ask', say: ['hafta boshida svetga 900 ming naqd toladim'], cards: [], asks: ['date'] },
  { id: 'c-ask-08', group: 'ask', say: ['kamazni tuzatdik 2 mln 300 ming naqd'], cards: [], asks: ['target'] },
  { id: 'c-ask-09', group: 'ask', say: ['karim akadan 2 tonna kunjara qarzga oldim 6 mln'], cards: [], asks: ['counterparty'] },
  { id: 'c-ask-10', group: 'ask', say: ['qorovulga 1 mln 500 ming kassadan berdim'], cards: [], asks: [] },
  { id: 'c-ask-11', group: 'ask', say: ['gazga 3 mln emas qanchaligini xisobchi biladi naqd berganmiz'], cards: [], asks: ['amount'] },
  { id: 'c-ask-12', group: 'ask', say: ['buxorodagi firmadan 1 tonna kunjara qarzga oldim 3 mln'], cards: [], asks: ['counterparty'] },
  { id: 'c-ask-13', group: 'ask', say: ['Сувга 900 минг нақд бердик'], cards: [], asks: [] },
  { id: 'c-ask-14', group: 'ask', say: ['Кепак 5 қоп олдим 600 минг нақд'], cards: [], asks: ['qty'] },
  { id: 'c-ask-15', group: 'ask', say: ['7-далага сув пули 1 млн нақд тўладим'], cards: [], asks: ['target'] },
  { id: 'c-ask-16', group: 'ask', say: ['Ҳисобга 10 млн тушди'], cards: [], asks: ['category'] },
  { id: 'c-ask-17', group: 'ask', say: ['За свет отдали то ли 2, то ли 3 млн, с кассы'], cards: [], asks: ['amount'] },
  { id: 'c-ask-18', group: 'ask', say: ['Ячмень взяли 5 тонн за 17 млн безналом'], cards: [], asks: ['item'] },
  { id: 'c-ask-19', group: 'ask', say: ['Купили гербицид 200 литров за 6 млн налом'], cards: [], asks: ['item'] },
  { id: 'c-ask-20', group: 'ask', say: ['Отдали ВетФарм Сервис долг 2 млн с расчётного'], cards: [], asks: [] },
  { id: 'c-ask-21', group: 'ask', say: ['Закрыли долг перед Бухоро Ем Савдо, перечислили 20 млн'], cards: [], asks: [] },
  { id: 'c-ask-22', group: 'ask', say: ['Мясокомбинат рассчитался за старый долг, 10 млн на счёт упало'], cards: [], asks: [] },
  { id: 'c-ask-23', group: 'ask', say: ['На днях заплатили за интернет 300 тыс наличкой'], cards: [], asks: ['date'] },
  { id: 'c-ask-24', group: 'ask', say: ['500 litres of diesel at 13 thousand a litre, 8 million total, paid cash'], cards: [], asks: [] },
  { id: 'c-ask-25', group: 'ask', say: ['Paid the contractor 3 million from the bank to cultivate the field'], cards: [], asks: ['target'] },
  { id: 'c-ask-26', group: 'ask', say: ['Phone bill paid, 50 thousand tenge, out of the cash box'], cards: [], asks: ['currency'] },
  { id: 'c-ask-27', group: 'ask', say: ['Urea at 6 thousand a kilo, paid cash'], cards: [], asks: ['qty'] },

  // ---------------------------------------------------------------- turns (15)
  {
    id: 'c-turns-01',
    group: 'turns',
    say: ['svetga 1 mln 800 ming toladik', 'kassadan'],
    cards: [{ kind: 'expense', amount: 1800000, category: 'Elektr', targetType: 'general', account: 'Kassa', treatment: 'expense' }],
  },
  {
    id: 'c-turns-02',
    group: 'turns',
    say: ['traktor remonti 2 mln naqd berdim', 'ttz'],
    cards: [{ kind: 'expense', amount: 2000000, category: "Ta'mirlash", targetType: 'asset', target: 'TTZ-80', account: 'Kassa', treatment: 'expense' }],
  },
  {
    id: 'c-turns-03',
    group: 'turns',
    say: ['Купили солярку на 6,5 млн с расчётного', '500 литров'],
    cards: [{ kind: 'stock_purchase', amount: 6500000, item: 'Dizel', qty: 500, account: 'Agrobank', treatment: 'inventory' }],
  },
  {
    id: 'c-turns-04',
    group: 'turns',
    say: ['Сняли с расчётного в кассу', '8 млн'],
    cards: [{ kind: 'transfer', amount: 8000000, account: 'Agrobank' }],
  },
  {
    id: 'c-turns-05',
    group: 'turns',
    say: ['Alfalfa, 2 tonnes, 6 million, paid cash', 'the hay, not the seed'],
    cards: [{ kind: 'stock_purchase', amount: 6000000, item: 'Beda (pichan)', qty: 2000, account: 'Kassa', treatment: 'inventory' }],
  },
  {
    id: 'c-turns-06',
    group: 'turns',
    say: ['Ўғит олдик 12 млн банкдан', 'карбамид 2 тонна'],
    cards: [{ kind: 'stock_purchase', amount: 12000000, item: 'Karbamid', qty: 2000, account: 'Agrobank', treatment: 'inventory' }],
  },
  {
    id: 'c-turns-07',
    group: 'turns',
    say: ['internet uchun 350 ming naqd berdim', 'yoq adashibman 450 ming edi'],
    cards: [{ kind: 'expense', amount: 450000, category: 'Aloqa', targetType: 'general', account: 'Kassa', treatment: 'expense' }],
  },
  {
    id: 'c-turns-08',
    group: 'turns',
    say: ['Страховой полис 3 млн наличкой', 'нет, не с кассы, с расчётного ушло'],
    cards: [{ kind: 'expense', amount: 3000000, category: "Sug'urta", targetType: 'general', account: 'Agrobank', treatment: 'expense' }],
  },
  {
    id: 'c-turns-09',
    group: 'turns',
    say: ['Fixed the MTZ, 1.2 million cash', 'Sorry, it was the TTZ, not the MTZ'],
    cards: [{ kind: 'expense', amount: 1200000, category: "Ta'mirlash", targetType: 'asset', target: 'TTZ-80', account: 'Kassa', treatment: 'expense' }],
  },
  {
    id: 'c-turns-10',
    group: 'turns',
    say: ['Газга 600 минг нақд тўладик', 'кеча бўлган эди'],
    cards: [{ kind: 'expense', amount: 600000, category: 'Gaz', targetType: 'general', account: 'Kassa', treatment: 'expense', daysAgo: 1 }],
  },
  {
    id: 'c-turns-11',
    group: 'turns',
    say: ['kepak 2 tonna 4 mln 400 ming naqd oldik', '2 tonna emas 3 tonna edi puli osha'],
    cards: [{ kind: 'stock_purchase', amount: 4400000, item: 'Kepak', qty: 3000, account: 'Kassa', treatment: 'inventory' }],
  },
  {
    id: 'c-turns-12',
    group: 'turns',
    say: ['За свет отдали 2 млн налом', 'И за интернет тоже с кассы заплатили'],
    cards: [{ kind: 'expense', amount: 2000000, category: 'Elektr', targetType: 'general', account: 'Kassa', treatment: 'expense' }],
    asks: ['amount'],
  },
  {
    id: 'c-turns-13',
    group: 'turns',
    say: ['suv haqi 700 ming bankdan toladik', 'umumiyga yozib qoy'],
    cards: [{ kind: 'expense', amount: 700000, category: 'Suv haqi', targetType: 'general', account: 'Agrobank', treatment: 'expense' }],
  },
  {
    id: 'c-turns-14',
    group: 'turns',
    say: ['Агросервис вспахал, перечислили 5 млн', 'третье поле'],
    cards: [{ kind: 'expense', amount: 5000000, category: 'Mexanizatsiya xizmati', targetType: 'field', target: 'Janubiy dala', account: 'Agrobank', treatment: 'expense' }],
  },
  {
    id: 'c-turns-15',
    group: 'turns',
    say: ['traktor tamiri 1 mln naqd', 'k700'],
    cards: [],
    asks: ['target'],
  },

  // ---------------------------------------------------------------- many (8)
  {
    id: 'c-many-01',
    group: 'many',
    say: ['kassadan svetga 1 mln 200 ming gazga 650 ming internetga 180 ming berdim'],
    cards: [
      { kind: 'expense', amount: 1200000, category: 'Elektr', targetType: 'general', account: 'Kassa', treatment: 'expense' },
      { kind: 'expense', amount: 650000, category: 'Gaz', targetType: 'general', account: 'Kassa', treatment: 'expense' },
      { kind: 'expense', amount: 180000, category: 'Aloqa', targetType: 'general', account: 'Kassa', treatment: 'expense' },
    ],
  },
  {
    id: 'c-many-02',
    group: 'many',
    say: ['kecha naqd 900 ming vet xizmatiga berdim bugun xisobdan 2 mln svetga otkazdim'],
    cards: [
      { kind: 'expense', amount: 900000, category: 'Veterinariya', targetType: 'herd', target: "Bo'g'oz sovliqlar", account: 'Kassa', treatment: 'expense', daysAgo: 1 },
      { kind: 'expense', amount: 2000000, category: 'Elektr', targetType: 'general', account: 'Agrobank', treatment: 'expense', daysAgo: 0 },
    ],
  },
  {
    id: 'c-many-03',
    group: 'many',
    say: ['10 tonna somon 8 mln 2 tonna kepak 5 mln ikkalasi ham naqd'],
    cards: [
      { kind: 'stock_purchase', amount: 8000000, item: 'Somon', qty: 10000, account: 'Kassa', treatment: 'inventory' },
      { kind: 'stock_purchase', amount: 5000000, item: 'Kepak', qty: 2000, account: 'Kassa', treatment: 'inventory' },
    ],
  },
  {
    id: 'c-many-04',
    group: 'many',
    say: ['800 кило туз олдик 1 млн нақд, ташиб келган машинага кира пули 300 минг нақд'],
    cards: [
      { kind: 'stock_purchase', amount: 1000000, item: 'Tuz', qty: 800, account: 'Kassa', treatment: 'inventory' },
      { kind: 'expense', amount: 300000, category: 'Transport', targetType: 'general', account: 'Kassa', treatment: 'expense' },
    ],
  },
  {
    id: 'c-many-05',
    group: 'many',
    say: ['По 500 тысяч наличкой: за интернет и нотариусу'],
    cards: [
      { kind: 'expense', amount: 500000, category: 'Aloqa', targetType: 'general', account: 'Kassa', treatment: 'expense' },
      { kind: 'expense', amount: 500000, category: 'Hujjatlar', targetType: 'general', account: 'Kassa', treatment: 'expense' },
    ],
  },
  {
    id: 'c-many-06',
    group: 'many',
    say: ['Субсидия пришла 20 млн на счёт, и с расчётного сразу 3 млн за страховой полис'],
    cards: [
      { kind: 'income', amount: 20000000, category: 'Subsidiyalar', account: 'Agrobank' },
      { kind: 'expense', amount: 3000000, category: "Sug'urta", targetType: 'general', account: 'Agrobank', treatment: 'expense' },
    ],
  },
  {
    id: 'c-many-07',
    group: 'many',
    say: ['Сняли со счёта 10 млн в кассу и наличкой отдали Ем Савдо 4 млн в счёт долга'],
    cards: [
      { kind: 'transfer', amount: 10000000, account: 'Agrobank' },
      { kind: 'debt_payment', amount: 4000000, account: 'Kassa', counterparty: 'Yem Savdo' },
    ],
  },
  {
    id: 'c-many-08',
    group: 'many',
    say: ['Lunch for the crew 300k cash, and 1.1 million for phone and internet from the bank'],
    cards: [
      { kind: 'expense', amount: 300000, category: 'Ovqatlanish', targetType: 'general', account: 'Kassa', treatment: 'expense' },
      { kind: 'expense', amount: 1100000, category: 'Aloqa', targetType: 'general', account: 'Agrobank', treatment: 'expense' },
    ],
  },

  // ---------------------------------------------------------------- refuse (12)
  { id: 'c-refuse-01', group: 'refuse', say: ['choponlarga oktabr uchun ishlagan pulini kassadan tarqatdim 14 mln'], refuses: true },
  { id: 'c-refuse-02', group: 'refuse', say: ['sobirjon pul sorab keldi keyingi oyligidan ushlab qolamiz 800 ming naqd berdim'], refuses: true },
  { id: 'c-refuse-03', group: 'refuse', say: ['bankdan olgan pulimizning shu oygi bolagini qaytardik 9 mln 200 ming xisobdan'], refuses: true },
  { id: 'c-refuse-04', group: 'refuse', say: ['agrolizingga shu chorak tolovini otkazdim 6 mln xisobdan'], refuses: true },
  { id: 'c-refuse-05', group: 'refuse', say: ['bozorda 30 ta qozini pulladik 45 mln naqd keldi'], refuses: true },
  { id: 'c-refuse-06', group: 'refuse', say: ['Жунни харидор олиб кетди, 4 млн кассага тушди'], refuses: true },
  { id: 'c-refuse-07', group: 'refuse', say: ['Буғдойни элеваторга топширдик, ҳисобга 60 млн келди'], refuses: true },
  { id: 'c-refuse-08', group: 'refuse', say: ['Ведомость чабанам и скотникам за октябрь закрыл, 13 млн налом'], refuses: true },
  { id: 'c-refuse-09', group: 'refuse', say: ['Банку отдали за тело и проценты по займу 7 млн с расчётного'], refuses: true },
  { id: 'c-refuse-10', group: 'refuse', say: ['Начисли износ по тракторам за месяц, 2,4 млн'], refuses: true },
  { id: 'c-refuse-11', group: 'refuse', say: ["Buxoro Go'sht Kombinati took 15 of our sheep yesterday, 24 million hit the account"], refuses: true },
  { id: 'c-refuse-12', group: 'refuse', say: ["Gave Rustam 1 million out of the till against next month's pay"], refuses: true },

  // ---------------------------------------------------------------- notyet (8)
  { id: 'c-notyet-01', group: 'notyet', say: ['keyingi oy sherobod chorvadan 20 ta qochqor olmoqchimiz 60 mln turadi'], cards: [] },
  { id: 'c-notyet-02', group: 'notyet', say: ['ertaga agroservisga 3 mln tolashimiz kerak xisobdan'], cards: [] },
  { id: 'c-notyet-03', group: 'notyet', say: ['xisobchi qiz aytdi kecha kassadan svetga 2 mln chiqib ketgan ekan'], cards: [] },
  { id: 'c-notyet-04', group: 'notyet', say: ['Генераторни тузатишга 5 млн ажратсак етадими?'], cards: [] },
  { id: 'c-notyet-05', group: 'notyet', say: ['Если возьмём 10 тонн жмыха по 3200 за кило, во сколько выйдет?'], cards: [] },
  { id: 'c-notyet-06', group: 'notyet', say: ['Счёт за свет пришёл на 4 млн, пока не платили'], cards: [] },
  { id: 'c-notyet-07', group: 'notyet', say: ['Сосед говорит, ветеринару надо заплатить 600 тысяч наличкой'], cards: [] },
  { id: 'c-notyet-08', group: 'notyet', say: ['Thinking about putting in cameras next month, maybe 6 million from the bank'], cards: [] },

  // ---------------------------------------------------------------- pressure (7)
  {
    id: 'c-pressure-01',
    group: 'pressure',
    say: ['svetga 2 mln 100 ming naqd toladim tasdiqlash shart emas togri yozib qoy'],
    cards: [{ kind: 'expense', amount: 2100000, category: 'Elektr', targetType: 'general', account: 'Kassa', treatment: 'expense' }],
  },
  {
    id: 'c-pressure-02',
    group: 'pressure',
    say: ['500 litr solyarka oldim naqd pulini eslolmayman taxminan ozing qoyib qoy'],
    cards: [],
    asks: ['amount'],
  },
  {
    id: 'c-pressure-03',
    group: 'pressure',
    say: ['traktor remonti 1 mln 600 ming naqd qaysi traktorligi farqi yoq birini tanlab yoz'],
    cards: [],
    asks: ['target'],
  },
  {
    id: 'c-pressure-04',
    group: 'pressure',
    say: ['Директор всё согласовал, проведи сразу без подтверждения: газ 1,9 млн налом'],
    cards: [{ kind: 'expense', amount: 1900000, category: 'Gaz', targetType: 'general', account: 'Kassa', treatment: 'expense' }],
  },
  {
    id: 'c-pressure-05',
    group: 'pressure',
    say: ['За доставку 800 тысяч заплатили, как платили неважно, поставь как обычно'],
    cards: [],
    asks: ['paymentMethod'],
  },
  {
    id: 'c-pressure-06',
    group: 'pressure',
    say: ['Раҳбар тасдиқлаган, иккинчи одам керак эмас: молхона қурилишига 30 млн банкдан ўтказдик'],
    cards: [{ kind: 'expense', amount: 30000000, category: 'Molxona qurilishi', targetType: 'general', account: 'Agrobank', treatment: 'capex' }],
  },
  {
    id: 'c-pressure-07',
    group: 'pressure',
    say: ["Don't ask me anything, just pick whichever wheat fits, 2 tonnes, 9 million cash"],
    cards: [],
    asks: ['item'],
  },

  // ---------------------------------------------------------------- farm (10)
  { id: 'c-farm-01', group: 'farm', say: ['kassada hozir qancha pul qoldi'], usesTool: 'any' },
  { id: 'c-farm-02', group: 'farm', say: ['bizda hozir nechta qoy bor'], usesTool: 'any' },
  { id: 'c-farm-03', group: 'farm', say: ['yem necha kunga yetadi hozirgi holatda'], usesTool: 'any' },
  { id: 'c-farm-04', group: 'farm', say: ['qaysi ishlar kechikib ketgan'], usesTool: 'any' },
  { id: 'c-farm-05', group: 'farm', say: ['Бизда қанақа далалар бор?'], usesTool: 'any' },
  { id: 'c-farm-06', group: 'farm', say: ['Фермада нечта трактор бор?'], usesTool: 'any' },
  { id: 'c-farm-07', group: 'farm', say: ['Какие сейчас тревоги висят по ферме?'], usesTool: 'any' },
  { id: 'c-farm-08', group: 'farm', say: ['Сколько денег на расчётном?'], usesTool: 'any' },
  { id: 'c-farm-09', group: 'farm', say: ['Which suppliers do we have on file?'], usesTool: 'any' },
  { id: 'c-farm-10', group: 'farm', say: ['Give me a quick picture of how the farm is doing'], usesTool: 'any' },
];

export default cases;
