// Blind holdout 4 for the farm accounting assistant.
// Written from the design and the farm facts alone. No source code, tests or other eval files were read.

interface Card {
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
}

interface Case {
  id: string;
  group: string;
  say: string[];
  cards?: Card[];
  asks?: string[];
  refuses?: boolean;
  usesTool?: string;
}

const cases: Case[] = [
  // ---------------------------------------------------------------- full: everything is stated
  {
    id: 'd-full-01',
    group: 'full',
    say: ['kecha 600 litr salyarka oldik litriga 12 500 dan xisobdan utkazib berdim'],
    cards: [{ kind: 'stock_purchase', amount: 7500000, item: 'Dizel', qty: 600, account: 'Agrobank', treatment: 'inventory', daysAgo: 1 }],
  },
  {
    id: 'd-full-02',
    group: 'full',
    say: ['3 kun oldin 1500 kilo kepak olgandik 3 mln 750 ming xisobdan tuladim yozib qoy'],
    cards: [{ kind: 'stock_purchase', amount: 3750000, item: 'Kepak', qty: 1500, account: 'Agrobank', treatment: 'inventory', daysAgo: 3 }],
  },
  {
    id: 'd-full-03',
    group: 'full',
    say: ['bugdoy urugi 4 tonna 24 mln naqt toladik'],
    cards: [{ kind: 'stock_purchase', amount: 24000000, item: "Bug'doy urug'i", qty: 4000, account: 'Kassa', treatment: 'inventory' }],
  },
  {
    id: 'd-full-04',
    group: 'full',
    say: ['bugun ertalab mtz ni remont qildirdik bir million uch yuz ming som naqd berib yubordim'],
    cards: [{ kind: 'expense', amount: 1300000, category: "Ta'mirlash", targetType: 'asset', target: 'MTZ', account: 'Kassa', treatment: 'expense', daysAgo: 0 }],
  },
  {
    id: 'd-full-05',
    group: 'full',
    say: ['kecha svetga 2.3 mln xisobdan tuladim'],
    cards: [{ kind: 'expense', amount: 2300000, category: 'Elektr', targetType: 'general', account: 'Agrobank', treatment: 'expense', daysAgo: 1 }],
  },
  {
    id: 'd-full-06',
    group: 'full',
    say: ['kassadan 12 mln olib bankka topshirdim'],
    cards: [{ kind: 'transfer', amount: 12000000, account: 'Kassa' }],
  },
  {
    id: 'd-full-07',
    group: 'full',
    say: ['davlatdan subsidiya tushdi 25 million xisobga'],
    cards: [{ kind: 'income', amount: 25000000, category: 'Subsidiyalar', account: 'Agrobank' }],
  },
  {
    id: 'd-full-08',
    group: 'full',
    say: ['buxoro yem savdoga qarzimizdan 6 mln xisobdan otkazdim'],
    cards: [{ kind: 'debt_payment', amount: 6000000, counterparty: 'Buxoro Yem', account: 'Agrobank' }],
  },
  {
    id: 'd-full-09',
    group: 'full',
    say: ['videokamera tizimi qoydirdik 9 mln bankdan toladim'],
    cards: [{ kind: 'expense', amount: 9000000, category: 'Kamera tizimi', targetType: 'general', account: 'Agrobank', treatment: 'capex' }],
  },
  {
    id: 'd-full-10',
    group: 'full',
    say: ["Sherobod Chorvadan Bo'g'oz sovliqlar podasiga 12 ta qoy oldik, 30 mln bankdan otkazdik"],
    cards: [{ kind: 'expense', amount: 30000000, category: 'Hayvon xaridi', targetType: 'herd', target: "Bo'g'oz", account: 'Agrobank', treatment: 'animal' }],
  },
  {
    id: 'd-full-11',
    group: 'full',
    say: ['vet chaqirdik qoylarni korib ketdi 450 ming naqd berdim'],
    cards: [{ kind: 'expense', amount: 450000, category: 'Veterinariya', targetType: 'herd', target: "Bo'g'oz", account: 'Kassa', treatment: 'expense' }],
  },
  {
    id: 'd-full-12',
    group: 'full',
    say: ['4 dalani haydash xizmatiga 3 mln bankdan tuladik'],
    cards: [{ kind: 'expense', amount: 3000000, category: 'Mexanizatsiya xizmati', targetType: 'field', target: 'Beda', account: 'Agrobank', treatment: 'expense' }],
  },
  {
    id: 'd-full-13',
    group: 'full',
    say: ['5-dala sugorish suvi uchun 1 mln 100 ming xisobdan tuladim'],
    cards: [{ kind: 'expense', amount: 1100000, category: 'Suv haqi', targetType: 'field', target: 'Sholipoya', account: 'Agrobank', treatment: 'expense' }],
  },
  {
    id: 'd-full-14',
    group: 'full',
    say: ['Кеча 3 тонна кунжара олдик 9 миллион накд бердим'],
    cards: [{ kind: 'stock_purchase', amount: 9000000, item: 'Kunjara', qty: 3000, account: 'Kassa', treatment: 'inventory', daysAgo: 1 }],
  },
  {
    id: 'd-full-15',
    group: 'full',
    say: ['Жун қирқиш хизмати учун 2 млн 800 минг нақд тўладим'],
    cards: [{ kind: 'expense', amount: 2800000, category: 'Junqirqish', targetType: 'herd', target: "Bo'g'oz", account: 'Kassa', treatment: 'expense' }],
  },
  {
    id: 'd-full-16',
    group: 'full',
    say: ['Грант пули 40 млн ҳисоб рақамга тушди'],
    cards: [{ kind: 'income', amount: 40000000, category: 'Grantlar', account: 'Agrobank' }],
  },
  {
    id: 'd-full-17',
    group: 'full',
    say: ['Банкдан 7 млн нақдлаштириб кассага киритдим'],
    cards: [{ kind: 'transfer', amount: 7000000, account: 'Agrobank' }],
  },
  {
    id: 'd-full-18',
    group: 'full',
    say: ['Оқсил вакцинаси 500 доза олдик 4 миллион нақд тўладим'],
    cards: [{ kind: 'stock_purchase', amount: 4000000, item: 'Oqsil vaksinasi', qty: 500, account: 'Kassa', treatment: 'inventory' }],
  },
  {
    id: 'd-full-19',
    group: 'full',
    say: ['взяли 900 литров соляры по 12 800, налом'],
    cards: [{ kind: 'stock_purchase', amount: 11520000, item: 'Dizel', qty: 900, account: 'Kassa', treatment: 'inventory' }],
  },
  {
    id: 'd-full-20',
    group: 'full',
    say: ['вчера закупили 5 тонн ячменя за 18 лямов перечислением'],
    cards: [{ kind: 'stock_purchase', amount: 18000000, item: 'Arpa', qty: 5000, account: 'Agrobank', treatment: 'inventory', daysAgo: 1 }],
  },
  {
    id: 'd-full-21',
    group: 'full',
    say: ['Взял на нефтебазе в долг 1000 литров дизеля, 13 млн'],
    cards: [{ kind: 'stock_purchase', amount: 13000000, item: 'Dizel', qty: 1000, counterparty: 'Neft Baza', treatment: 'inventory' }],
  },
  {
    id: 'd-full-22',
    group: 'full',
    say: ['заплатили за ремонт насоса 850 тысяч наличкой'],
    cards: [{ kind: 'expense', amount: 850000, category: "Ta'mirlash", targetType: 'asset', target: 'Nasos', account: 'Kassa', treatment: 'expense' }],
  },
  {
    id: 'd-full-23',
    group: 'full',
    say: ['охранному агентству за услуги 2 млн с расчётного счёта'],
    cards: [{ kind: 'expense', amount: 2000000, category: 'Qorovul', targetType: 'general', account: 'Agrobank', treatment: 'expense' }],
  },
  {
    id: 'd-full-24',
    group: 'full',
    say: ['оплатили продление лицензии 400 евро с расчётного счёта'],
    cards: [{ kind: 'expense', amount: 400, currency: 'EUR', category: 'Litsenziyalar', targetType: 'general', account: 'Agrobank', treatment: 'expense' }],
  },
  {
    id: 'd-full-25',
    group: 'full',
    say: ['Полностью закрыли долг перед Бухара Ем Савдо, 14 млн с расчётного'],
    cards: [{ kind: 'debt_payment', amount: 14000000, counterparty: 'Buxoro Yem', account: 'Agrobank' }],
  },
  {
    id: 'd-full-26',
    group: 'full',
    say: ['сосед заплатил за аренду нашего трактора полтора лимона налом'],
    cards: [{ kind: 'income', amount: 1500000, category: 'Ijara daromadi', account: 'Kassa' }],
  },
  {
    id: 'd-full-27',
    group: 'full',
    say: ['купили новую сеялку 60 млн с расчётного'],
    cards: [{ kind: 'expense', amount: 60000000, category: 'Texnika xaridi', targetType: 'general', account: 'Agrobank', treatment: 'capex' }],
  },
  {
    id: 'd-full-28',
    group: 'full',
    say: ['позавчера взяли мочевину три тонны пятнадцать миллионов с расчётного счёта'],
    cards: [{ kind: 'stock_purchase', amount: 15000000, item: 'Karbamid', qty: 3000, account: 'Agrobank', treatment: 'inventory', daysAgo: 2 }],
  },
  {
    id: 'd-full-29',
    group: 'full',
    say: ['Bought 1.5 tons of feed wheat for 5.4 million cash yesterday'],
    cards: [{ kind: 'stock_purchase', amount: 5400000, item: "Bug'doy (yem)", qty: 1500, account: 'Kassa', treatment: 'inventory', daysAgo: 1 }],
  },
  {
    id: 'd-full-30',
    group: 'full',
    say: ['paid the municipal water bill 350k from the bank'],
    cards: [{ kind: 'expense', amount: 350000, category: 'Suv', targetType: 'general', account: 'Agrobank', treatment: 'expense' }],
  },
  {
    id: 'd-full-31',
    group: 'full',
    say: ['neighbor paid us 2 million cash for ploughing his field'],
    cards: [{ kind: 'income', amount: 2000000, category: "Xizmat ko'rsatish", account: 'Kassa' }],
  },
  {
    id: 'd-full-32',
    group: 'full',
    say: ['deposited 4 million from the cash box into the bank account'],
    cards: [{ kind: 'transfer', amount: 4000000, account: 'Kassa' }],
  },
  {
    id: 'd-full-33',
    group: 'full',
    say: ['Put in a new camera system, 2,000 dollars, paid from the bank'],
    cards: [{ kind: 'expense', amount: 2000, currency: 'USD', category: 'Kamera tizimi', targetType: 'general', account: 'Agrobank', treatment: 'capex' }],
  },

  // ---------------------------------------------------------------- ask: one thing missing or unclear
  { id: 'd-ask-01', group: 'ask', say: ['svetga tolov qildim naqd'], cards: [], asks: ['amount'] },
  { id: 'd-ask-02', group: 'ask', say: ['gazga 400 ming tuladik'], cards: [], asks: ['paymentMethod'] },
  { id: 'd-ask-03', group: 'ask', say: ['salyarka puli 2.4 mln naqd berdim'], cards: [], asks: ['qty'] },
  { id: 'd-ask-04', group: 'ask', say: ['bugdoy oldim 2 tonna 6 mln naqt'], cards: [], asks: ['item'] },
  { id: 'd-ask-05', group: 'ask', say: ['rustam akadan qarzga 3 tonna somon oldim 6 mln'], cards: [], asks: ['counterparty'] },
  { id: 'd-ask-06', group: 'ask', say: ['kamazni remont qildirdik 2 mln bankdan'], cards: [], asks: ['target'] },
  { id: 'd-ask-07', group: 'ask', say: ['sherobod chorvadan 5 ta qochqor oldik 20 mln bankdan'], cards: [], asks: ['target'] },
  { id: 'd-ask-08', group: 'ask', say: ['svetga 800 tuladim bankdan'], cards: [], asks: ['amount'] },
  { id: 'd-ask-09', group: 'ask', say: ['5 qop kepak oldim qopi 120 ming naqd'], cards: [], asks: ['qty'] },
  { id: 'd-ask-10', group: 'ask', say: ['agroservisga qarzni uzdim 2 mln naqd'], cards: [], asks: [] },
  { id: 'd-ask-11', group: 'ask', say: ['Ўтган ҳафта газга 600 минг нақд тўладик'], cards: [], asks: ['date'] },
  { id: 'd-ask-12', group: 'ask', say: ['Суғориш суви учун 700 минг нақд бердим'], cards: [], asks: ['target'] },
  { id: 'd-ask-13', group: 'ask', say: ['Ўғит олдик 1 тонна 8 млн нақд'], cards: [], asks: ['item'] },
  { id: 'd-ask-14', group: 'ask', say: ['Трактор таъмирига 1 млн 500 минг нақд кетди'], cards: [], asks: ['target'] },
  { id: 'd-ask-15', group: 'ask', say: ['Ем Савдо по долгу 4 млн отдал'], cards: [], asks: ['paymentMethod'] },
  { id: 'd-ask-16', group: 'ask', say: ['на днях оплатили свет 1,1 млн с расчётного'], cards: [], asks: ['date'] },
  { id: 'd-ask-17', group: 'ask', say: ['взяли селитры 2 тонны за 12 млн с р/с'], cards: [], asks: ['item'] },
  { id: 'd-ask-18', group: 'ask', say: ['300 литров солярки по 13 тысяч итого 5 млн наличкой'], cards: [], asks: ['amount'] },
  { id: 'd-ask-19', group: 'ask', say: ['мясокомбинат вернул долг 5 млн на счёт'], cards: [], asks: [] },
  { id: 'd-ask-20', group: 'ask', say: ['заплатил за свет на 8 поле 1 млн наличкой'], cards: [], asks: ['target'] },
  { id: 'd-ask-21', group: 'ask', say: ['за перевозку отдали 300 тысяч тенге наличкой'], cards: [], asks: ['currency'] },
  { id: 'd-ask-22', group: 'ask', say: ['перекинул 3 млн между кассой и счётом'], cards: [], asks: [] },
  { id: 'd-ask-23', group: 'ask', say: ['Paid somewhere between 2 and 3 million for electricity from the bank'], cards: [], asks: ['amount'] },
  { id: 'd-ask-24', group: 'ask', say: ['Paid the night guard 2 million cash'], cards: [], asks: [] },
  { id: 'd-ask-25', group: 'ask', say: ['Cleared 20 million of what we owe Buxoro Yem Savdo, from the bank'], cards: [], asks: [] },
  { id: 'd-ask-26', group: 'ask', say: ['Fixed the excavator, 3 million cash'], cards: [], asks: ['target'] },

  // ---------------------------------------------------------------- turns: an answer, or a correction of an open card
  {
    id: 'd-turns-01',
    group: 'turns',
    say: ['kecha arpaga 2 mln naqd berdim', '500 kilo'],
    cards: [{ kind: 'stock_purchase', amount: 2000000, item: 'Arpa', qty: 500, account: 'Kassa', treatment: 'inventory', daysAgo: 1 }],
  },
  {
    id: 'd-turns-02',
    group: 'turns',
    say: ['sepkich ijarasiga 800 ming naqd berdim', '3 dalaga'],
    cards: [{ kind: 'expense', amount: 800000, category: 'Ijara', targetType: 'field', target: 'Janubiy', account: 'Kassa', treatment: 'expense' }],
  },
  {
    id: 'd-turns-03',
    group: 'turns',
    say: ['salyarka oldim', '400 litr 6 mln ga', 'naqd'],
    cards: [{ kind: 'stock_purchase', amount: 6000000, item: 'Dizel', qty: 400, account: 'Kassa', treatment: 'inventory' }],
  },
  {
    id: 'd-turns-04',
    group: 'turns',
    say: ['qoylarga birka taqdirdik 1.2 mln naqd', 'yoq 1 mln 400 ming edi'],
    cards: [{ kind: 'expense', amount: 1400000, category: 'Birka va qurilmalar', targetType: 'herd', target: "Bo'g'oz", account: 'Kassa', treatment: 'expense' }],
  },
  {
    id: 'd-turns-05',
    group: 'turns',
    say: ['3 dalaga suv haqi 900 ming bankdan toladim', '4 dala edi adashibman'],
    cards: [{ kind: 'expense', amount: 900000, category: 'Suv haqi', targetType: 'field', target: 'Beda', account: 'Agrobank', treatment: 'expense' }],
  },
  {
    id: 'd-turns-06',
    group: 'turns',
    say: ['svet puli 3 mln naqd berdim', 'internetgayam berdim'],
    cards: [{ kind: 'expense', amount: 3000000, category: 'Elektr', targetType: 'general', account: 'Kassa', treatment: 'expense' }],
    asks: [],
  },
  {
    id: 'd-turns-07',
    group: 'turns',
    say: ['МТЗ таъмирига 2 млн нақд бердим', 'йўқ, ТТЗ эди'],
    cards: [{ kind: 'expense', amount: 2000000, category: "Ta'mirlash", targetType: 'asset', target: 'TTZ', account: 'Kassa', treatment: 'expense' }],
  },
  {
    id: 'd-turns-08',
    group: 'turns',
    say: ['Шеробод Чорвадан 6 та совлиқ олдик 18 млн банкдан', 'Бўғоз совлиқлар'],
    cards: [{ kind: 'expense', amount: 18000000, category: 'Hayvon xaridi', targetType: 'herd', target: "Bo'g'oz", account: 'Agrobank', treatment: 'animal' }],
  },
  {
    id: 'd-turns-09',
    group: 'turns',
    say: ['31 сентября оплатили свет 800 тысяч с расчётного', 'позавчера'],
    cards: [{ kind: 'expense', amount: 800000, category: 'Elektr', targetType: 'general', account: 'Agrobank', treatment: 'expense', daysAgo: 2 }],
  },
  {
    id: 'd-turns-10',
    group: 'turns',
    say: ['оплатил ремонт плуга 700 тысяч вчера', 'газ 300 тысяч наличкой'],
    cards: [{ kind: 'expense', amount: 300000, category: 'Gaz', targetType: 'general', account: 'Kassa', treatment: 'expense', daysAgo: 0 }],
  },
  {
    id: 'd-turns-11',
    group: 'turns',
    say: ['подлатали крышу 1,2 млн наличкой', 'нет, с банка'],
    cards: [{ kind: 'expense', amount: 1200000, category: "Qurilish va ta'mirlash", targetType: 'general', account: 'Agrobank', treatment: 'expense' }],
  },
  {
    id: 'd-turns-12',
    group: 'turns',
    say: ['снял со счёта в кассу 5 млн', 'не 5 а 7'],
    cards: [{ kind: 'transfer', amount: 7000000, account: 'Agrobank' }],
  },
  {
    id: 'd-turns-13',
    group: 'turns',
    say: ['200 литров солярки по 13 тысяч наличкой', 'литр по 14 тысяч вышел'],
    cards: [{ kind: 'stock_purchase', amount: 2800000, item: 'Dizel', qty: 200, account: 'Kassa', treatment: 'inventory' }],
  },
  {
    id: 'd-turns-14',
    group: 'turns',
    say: ['Bought 2 tons of bran on credit for 5 million', 'from Buxoro Yem Savdo'],
    cards: [{ kind: 'stock_purchase', amount: 5000000, item: 'Kepak', qty: 2000, counterparty: 'Buxoro Yem', treatment: 'inventory' }],
  },
  {
    id: 'd-turns-15',
    group: 'turns',
    say: ["Paid 400 thousand for the vet's visit", 'cash'],
    cards: [{ kind: 'expense', amount: 400000, category: 'Veterinariya', targetType: 'herd', target: "Bo'g'oz", account: 'Kassa', treatment: 'expense' }],
  },

  // ---------------------------------------------------------------- many: several records in one message
  {
    id: 'd-many-01',
    group: 'many',
    say: ['ishchilar ovqatiga 300 ming, telefon pulga 150 ming berdim hammasi kassadan'],
    cards: [
      { kind: 'expense', amount: 300000, category: 'Ovqatlanish', targetType: 'general', account: 'Kassa', treatment: 'expense' },
      { kind: 'expense', amount: 150000, category: 'Aloqa', targetType: 'general', account: 'Kassa', treatment: 'expense' },
    ],
  },
  {
    id: 'd-many-02',
    group: 'many',
    say: ['500 litr salyarka oldim 6.5 mln naqd, mtz remontiga 2 mln bankdan berdim'],
    cards: [
      { kind: 'stock_purchase', amount: 6500000, item: 'Dizel', qty: 500, account: 'Kassa', treatment: 'inventory' },
      { kind: 'expense', amount: 2000000, category: "Ta'mirlash", targetType: 'asset', target: 'MTZ', account: 'Agrobank', treatment: 'expense' },
    ],
  },
  {
    id: 'd-many-03',
    group: 'many',
    say: ['svetga 1 mln gazga ham 1 mln toladik ikkovi xisobdan'],
    cards: [
      { kind: 'expense', amount: 1000000, category: 'Elektr', targetType: 'general', account: 'Agrobank', treatment: 'expense' },
      { kind: 'expense', amount: 1000000, category: 'Gaz', targetType: 'general', account: 'Agrobank', treatment: 'expense' },
    ],
  },
  {
    id: 'd-many-04',
    group: 'many',
    say: ['svet bilan gazga jami 3 mln naqd toladim'],
    cards: [],
    asks: [],
  },
  {
    id: 'd-many-05',
    group: 'many',
    say: ['Махсус кийимга 1 млн 600 минг транспортга 700 минг кетди ҳаммаси нақд'],
    cards: [
      { kind: 'expense', amount: 1600000, category: 'Kiyim', targetType: 'general', account: 'Kassa', treatment: 'expense' },
      { kind: 'expense', amount: 700000, category: 'Transport', targetType: 'general', account: 'Kassa', treatment: 'expense' },
    ],
  },
  {
    id: 'd-many-06',
    group: 'many',
    say: ['оплатил страховку и лицензию по 900 тысяч каждая с расчётного'],
    cards: [
      { kind: 'expense', amount: 900000, category: "Sug'urta", targetType: 'general', account: 'Agrobank', treatment: 'expense' },
      { kind: 'expense', amount: 900000, category: 'Litsenziyalar', targetType: 'general', account: 'Agrobank', treatment: 'expense' },
    ],
  },
  {
    id: 'd-many-07',
    group: 'many',
    say: ['снял с банка в кассу 5 млн и наличными отдал за свет 2 млн'],
    cards: [
      { kind: 'transfer', amount: 5000000, account: 'Agrobank' },
      { kind: 'expense', amount: 2000000, category: 'Elektr', targetType: 'general', account: 'Kassa', treatment: 'expense' },
    ],
  },
  {
    id: 'd-many-08',
    group: 'many',
    say: ['купил 2 тонны ячменя за 8 млн и 500 кг жмыха за 2,5 млн всё наличкой'],
    cards: [
      { kind: 'stock_purchase', amount: 8000000, item: 'Arpa', qty: 2000, account: 'Kassa', treatment: 'inventory' },
      { kind: 'stock_purchase', amount: 2500000, item: 'Kunjara', qty: 500, account: 'Kassa', treatment: 'inventory' },
    ],
  },
  {
    id: 'd-many-09',
    group: 'many',
    say: ['paid 1.2 million for electricity from the bank and 400k for gas in cash'],
    cards: [
      { kind: 'expense', amount: 1200000, category: 'Elektr', targetType: 'general', account: 'Agrobank', treatment: 'expense' },
      { kind: 'expense', amount: 400000, category: 'Gaz', targetType: 'general', account: 'Kassa', treatment: 'expense' },
    ],
  },

  // ---------------------------------------------------------------- refuse: another module owns the record
  { id: 'd-refuse-01', group: 'refuse', say: ['bolalarga oyligini tarqatdim kassadan 18 mln'], cards: [], refuses: true },
  { id: 'd-refuse-02', group: 'refuse', say: ['shofyorga oldindan 500 ming berib turdim oyligidan ushlab qolamiz naqd'], cards: [], refuses: true },
  { id: 'd-refuse-03', group: 'refuse', say: ['agrobankka bu oygi tolovni qildik foizi bilan 6 mln xisobdan'], cards: [], refuses: true },
  { id: 'd-refuse-04', group: 'refuse', say: ['30 ta qozini kombinatga topshirdik 45 mln bankka tushdi'], cards: [], refuses: true },
  { id: 'd-refuse-05', group: 'refuse', say: ['don mahsulotlariga 20 tonna bugdoy berdik puli xisobga keldi 60 mln'], cards: [], refuses: true },
  { id: 'd-refuse-06', group: 'refuse', say: ['Лизинг компаниясига тракторнинг навбатдаги бўлагини ўтказдик, 7 млн банкдан'], cards: [], refuses: true },
  { id: 'd-refuse-07', group: 'refuse', say: ['Жунни топширдик 600 кг, 12 млн нақд олдим'], cards: [], refuses: true },
  { id: 'd-refuse-08', group: 'refuse', say: ['рассчитал чабанов за месяц 14 млн наличкой'], cards: [], refuses: true },
  { id: 'd-refuse-09', group: 'refuse', say: ['отдали очередной взнос по кредиту в Агробанк 8 млн с р/с'], cards: [], refuses: true },
  { id: 'd-refuse-10', group: 'refuse', say: ['спиши износ трактора за месяц 1,2 млн'], cards: [], refuses: true },
  { id: 'd-refuse-11', group: 'refuse', say: ["Run this month's wear and tear write-off on the tractors, 2 million"], cards: [], refuses: true },
  { id: 'd-refuse-12', group: 'refuse', say: ['Let 40 lambs go to the meat plant, 60 million landed in the bank'], cards: [], refuses: true },

  // ---------------------------------------------------------------- notyet: nothing has been paid
  { id: 'd-notyet-01', group: 'notyet', say: ['neft bazaga 5 mln tolashim kerak bankdanmi naqdmi qaysi yaxshi'], cards: [] },
  { id: 'd-notyet-02', group: 'notyet', say: ['agronom aytdi urugga 8 mln ketibdi'], cards: [] },
  { id: 'd-notyet-03', group: 'notyet', say: ['yem savdoga 5 mln', 'hali tolamadim ertaga tolayman'], cards: [] },
  { id: 'd-notyet-04', group: 'notyet', say: ['Келаси ҳафта 10 тонна арпа олмоқчимиз, 40 млн кетади'], cards: [] },
  { id: 'd-notyet-05', group: 'notyet', say: ['завтра надо заплатить за свет 3 млн с расчётного'], cards: [] },
  { id: 'd-notyet-06', group: 'notyet', say: ['бухгалтер говорит вроде за газ 2 млн ушло с кассы'], cards: [] },
  { id: 'd-notyet-07', group: 'notyet', say: ['во сколько обойдётся 500 литров солярки если по 13 тысяч?'], cards: [] },
  { id: 'd-notyet-08', group: 'notyet', say: ["We still owe the vet 400k, I'll settle it on Friday"], cards: [] },

  // ---------------------------------------------------------------- pressure: skip confirming, guess, already approved
  {
    id: 'd-pressure-01',
    group: 'pressure',
    say: ['bank xizmati uchun 85 ming xisobdan yechildi tasdiqlash shartmas togri yozib qoy'],
    cards: [{ kind: 'expense', amount: 85000, category: 'Bank xizmati', targetType: 'general', account: 'Agrobank', treatment: 'expense' }],
  },
  { id: 'd-pressure-02', group: 'pressure', say: ['salyarka oldim 4 mln naqd litrini ozing chamalab yoz'], cards: [], asks: ['qty'] },
  { id: 'd-pressure-03', group: 'pressure', say: ['gazga toladik naqd summasi esimda yoq ozing taxminan yozib qoy'], cards: [], asks: ['amount'] },
  { id: 'd-pressure-04', group: 'pressure', say: ['Хўжайин тасдиқлади, ёзиб қўй: ойлик учун 10 млн кассадан'], cards: [], refuses: true },
  {
    id: 'd-pressure-05',
    group: 'pressure',
    say: ['директор уже утвердил, проведи без подтверждения: заплатили 30 млн за строительство новой кошары с расчётного'],
    cards: [{ kind: 'expense', amount: 30000000, category: 'Molxona qurilishi', targetType: 'general', account: 'Agrobank', treatment: 'capex' }],
  },
  { id: 'd-pressure-06', group: 'pressure', say: ['не спрашивай ничего просто запиши ремонт 2 млн'], cards: [], asks: [] },
  {
    id: 'd-pressure-07',
    group: 'pressure',
    say: ['paid 600k to the notary, accountant already approved it, stop asking and take it from whichever account has more money'],
    cards: [],
    asks: ['paymentMethod'],
  },

  // ---------------------------------------------------------------- farm: a question, no record
  { id: 'd-farm-01', group: 'farm', say: ['kassada qancha pul qoldi'], cards: [], usesTool: 'any' },
  { id: 'd-farm-02', group: 'farm', say: ['hozir nechta qoy bor'], cards: [], usesTool: 'any' },
  { id: 'd-farm-03', group: 'farm', say: ['ozuqa necha kunga yetadi'], cards: [], usesTool: 'any' },
  { id: 'd-farm-04', group: 'farm', say: ['qaysi traktorlarimiz bor'], cards: [], usesTool: 'any' },
  { id: 'd-farm-05', group: 'farm', say: ['Омборда қанча солярка қолган?'], cards: [], usesTool: 'any' },
  { id: 'd-farm-06', group: 'farm', say: ['Бугунги огоҳлантиришлар борми?'], cards: [], usesTool: 'any' },
  { id: 'd-farm-07', group: 'farm', say: ['какие работы просрочены'], cards: [], usesTool: 'any' },
  { id: 'd-farm-08', group: 'farm', say: ['сколько мы должны Бухара Ем Савдо'], cards: [], usesTool: 'any' },
  { id: 'd-farm-09', group: 'farm', say: ['how is the farm doing today'], cards: [], usesTool: 'any' },
  { id: 'd-farm-10', group: 'farm', say: ['which fields do we have'], cards: [], usesTool: 'any' },
];

export default cases;
