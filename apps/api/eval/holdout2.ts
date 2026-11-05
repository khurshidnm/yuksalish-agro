// Blind holdout for the accounting assistant. Written from the design and the farm facts only.

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
  // ---------------------------------------------------------------- full
  {
    id: 'b-full-01',
    group: 'full',
    say: ["kecha svetga 2 mln 400 ming xisobdan toladim"],
    cards: [{ kind: 'expense', amount: 2400000, category: 'Elektr', targetType: 'general', target: 'General', account: 'Agrobank', treatment: 'expense', daysAgo: 1 }],
  },
  {
    id: 'b-full-02',
    group: 'full',
    say: ["3 kun oldin salyarka 600 litr oldik litriga 13500 dan naqdga"],
    cards: [{ kind: 'stock_purchase', amount: 8100000, item: 'Dizel', qty: 600, account: 'Kassa', treatment: 'inventory', daysAgo: 3 }],
  },
  {
    id: 'b-full-03',
    group: 'full',
    say: ["2 tonna bugdoy urugi oldim 16 mln kassadan toladim"],
    cards: [{ kind: 'stock_purchase', amount: 16000000, item: "Bug'doy urug'i", qty: 2000, account: 'Kassa', treatment: 'inventory' }],
  },
  {
    id: 'b-full-04',
    group: 'full',
    say: ["agroservis 5-dalani haydab berdi 3 mln schotdan otkazdim"],
    cards: [{ kind: 'expense', amount: 3000000, category: 'Mexanizatsiya xizmati', targetType: 'field', target: 'Sholipoya', account: 'Agrobank', counterparty: 'Agroservis', treatment: 'expense' }],
  },
  {
    id: 'b-full-05',
    group: 'full',
    say: ["idoraga vodokanal puli 180 ming naxt berdim"],
    cards: [{ kind: 'expense', amount: 180000, category: 'Suv', targetType: 'general', target: 'General', account: 'Kassa', treatment: 'expense' }],
  },
  {
    id: 'b-full-06',
    group: 'full',
    say: ["kombayn ijarasiga 6 mln hisobdan tolandi"],
    cards: [{ kind: 'expense', amount: 6000000, category: 'Ijara', targetType: 'asset', target: 'Kombayn', account: 'Agrobank', treatment: 'expense' }],
  },
  {
    id: 'b-full-07',
    group: 'full',
    say: ["yangi traktor sotib oldik 180 mln bank orqali"],
    cards: [{ kind: 'expense', amount: 180000000, category: 'Texnika xaridi', targetType: 'general', target: 'General', account: 'Agrobank', treatment: 'capex' }],
  },
  {
    id: 'b-full-08',
    group: 'full',
    say: ["hisob raqamga 20 mln subsidiya tushdi"],
    cards: [{ kind: 'income', amount: 20000000, category: 'Subsidiyalar', account: 'Agrobank' }],
  },
  {
    id: 'b-full-09',
    group: 'full',
    say: ["buxoro yem savdoga qarzimizni toliq yopdim 14 mln hisobdan"],
    cards: [{ kind: 'debt_payment', amount: 14000000, counterparty: 'Buxoro Yem', account: 'Agrobank' }],
  },
  {
    id: 'b-full-10',
    group: 'full',
    say: ["kassadagi 10 mln ni bankka topshirdim"],
    cards: [{ kind: 'transfer', amount: 10000000, account: 'Kassa' }],
  },
  {
    id: 'b-full-11',
    group: 'full',
    say: ["ammofos 2 tonna oldik tonnasi 6 mln bankdan toladik"],
    cards: [{ kind: 'stock_purchase', amount: 12000000, item: 'Ammofos', qty: 2000, account: 'Agrobank', treatment: 'inventory' }],
  },
  {
    id: 'b-full-12',
    group: 'full',
    say: ["veterinariya litsenziyasini yangiladik 2 mln hisobdan"],
    cards: [{ kind: 'expense', amount: 2000000, category: 'Litsenziyalar', targetType: 'general', target: 'General', account: 'Agrobank', treatment: 'expense' }],
  },
  {
    id: 'b-full-13',
    group: 'full',
    say: ["molxona tomini yamadik 3 mln naqt ketdi"],
    cards: [{ kind: 'expense', amount: 3000000, category: "Qurilish va ta'mirlash", targetType: 'general', target: 'General', account: 'Kassa', treatment: 'expense' }],
  },
  {
    id: 'b-full-14',
    group: 'full',
    say: ["bugun ertalab yuk mashinasiga kira haqi uch yuz yetmish ming som naqd berdim"],
    cards: [{ kind: 'expense', amount: 370000, category: 'Transport', targetType: 'general', target: 'General', account: 'Kassa', treatment: 'expense', daysAgo: 0 }],
  },
  {
    id: 'b-full-15',
    group: 'full',
    say: ["Кеча Оқсил вакцинаси 300 доза олдик дозаси 7 минг жами 2 миллион 100 минг нақд"],
    cards: [{ kind: 'stock_purchase', amount: 2100000, item: 'Oqsil vaksinasi', qty: 300, account: 'Kassa', treatment: 'inventory', daysAgo: 1 }],
  },
  {
    id: 'b-full-16',
    group: 'full',
    say: ["жун қирқиш хизмати учун 4 миллион хисобдан ўтказдик"],
    cards: [{ kind: 'expense', amount: 4000000, category: 'Junqirqish', targetType: 'herd', target: "Bo'g'oz sovliqlar", account: 'Agrobank', treatment: 'expense' }],
  },
  {
    id: 'b-full-17',
    group: 'full',
    say: ["тракторни қўшнига ижарага бериб 3 миллион нақд олдик"],
    cards: [{ kind: 'income', amount: 3000000, category: 'Ijara daromadi', account: 'Kassa' }],
  },
  {
    id: 'b-full-18',
    group: 'full',
    say: ["бухоро ем савдодан беш тонна сомон насияга олдик етти миллион сўмга"],
    cards: [{ kind: 'stock_purchase', amount: 7000000, item: 'Somon', qty: 5000, counterparty: 'Buxoro Yem', treatment: 'inventory' }],
  },
  {
    id: 'b-full-19',
    group: 'full',
    say: ["банкдан 5 миллион накд ечиб кассага куйдим"],
    cards: [{ kind: 'transfer', amount: 5000000, account: 'Agrobank' }],
  },
  {
    id: 'b-full-20',
    group: 'full',
    say: ["взяли ячмень на корм 5 тонн за 15 лимонов налом"],
    cards: [{ kind: 'stock_purchase', amount: 15000000, item: 'Arpa', qty: 5000, account: 'Kassa', treatment: 'inventory' }],
  },
  {
    id: 'b-full-21',
    group: 'full',
    say: ["жмых 3 тонны по 3500 за кило оплатили с банка"],
    cards: [{ kind: 'stock_purchase', amount: 10500000, item: 'Kunjara', qty: 3000, account: 'Agrobank', treatment: 'inventory' }],
  },
  {
    id: 'b-full-22',
    group: 'full',
    say: ["оплатил поливную воду по второму полю 1.2 млн безналом"],
    cards: [{ kind: 'expense', amount: 1200000, category: 'Suv haqi', targetType: 'field', target: "O'rta dala", account: 'Agrobank', treatment: 'expense' }],
  },
  {
    id: 'b-full-23',
    group: 'full',
    say: ["вчера агросервис отремонтировал ттз за шестьдесят тысяч рублей в долг"],
    cards: [{ kind: 'expense', amount: 60000, currency: 'RUB', category: "Ta'mirlash", targetType: 'asset', target: 'TTZ-80', counterparty: 'Agroservis', treatment: 'expense', daysAgo: 1 }],
  },
  {
    id: 'b-full-24',
    group: 'full',
    say: ["залили фундамент новой кошары 25 млн перечислением ушло"],
    cards: [{ kind: 'expense', amount: 25000000, category: 'Molxona qurilishi', targetType: 'general', target: 'General', account: 'Agrobank', treatment: 'capex' }],
  },
  {
    id: 'b-full-25',
    group: 'full',
    say: ["позавчера получили грант 50 млн, на р/с упало"],
    cards: [{ kind: 'income', amount: 50000000, category: 'Grantlar', account: 'Agrobank', daysAgo: 2 }],
  },
  {
    id: 'b-full-26',
    group: 'full',
    say: ["вчера отдал Бухоро Ем Савдо 3 млн из кассы в счет долга за корма"],
    cards: [{ kind: 'debt_payment', amount: 3000000, counterparty: 'Buxoro Yem', account: 'Kassa', daysAgo: 1 }],
  },
  {
    id: 'b-full-27',
    group: 'full',
    say: ["со счета сняли 15 млн в кассу на расходы"],
    cards: [{ kind: 'transfer', amount: 15000000, account: 'Agrobank' }],
  },
  {
    id: 'b-full-28',
    group: 'full',
    say: ["взяли у Шеробод Чорва 12 маток в отару Бўғоз совлиқлар, 36 млн с банка"],
    cards: [{ kind: 'expense', amount: 36000000, category: 'Hayvon xaridi', targetType: 'herd', target: "Bo'g'oz sovliqlar", account: 'Agrobank', counterparty: 'Sherobod', treatment: 'animal' }],
  },
  {
    id: 'b-full-29',
    group: 'full',
    say: ["у ВетФарм взяли 200 флаконов тетравита на 1500 долларов в долг"],
    cards: [{ kind: 'stock_purchase', amount: 1500, currency: 'USD', item: 'Tetravit', qty: 200, counterparty: 'VetFarm', treatment: 'inventory' }],
  },
  {
    id: 'b-full-30',
    group: 'full',
    say: ["bought 40 vials of tetravit from vetfarm 1.2 million cash"],
    cards: [{ kind: 'stock_purchase', amount: 1200000, item: 'Tetravit', qty: 40, account: 'Kassa', counterparty: 'VetFarm', treatment: 'inventory' }],
  },
  {
    id: 'b-full-31',
    group: 'full',
    say: ["cctv got installed around the barns 9.5 million paid by bank transfer"],
    cards: [{ kind: 'expense', amount: 9500000, category: 'Kamera tizimi', targetType: 'general', target: 'General', account: 'Agrobank', treatment: 'capex' }],
  },
  {
    id: 'b-full-32',
    group: 'full',
    say: ["um so the vet came out yesterday to treat the ewes call out fee was four hundred and fifty thousand cash"],
    cards: [{ kind: 'expense', amount: 450000, category: 'Veterinariya', targetType: 'herd', target: "Bo'g'oz sovliqlar", account: 'Kassa', treatment: 'expense', daysAgo: 1 }],
  },
  {
    id: 'b-full-33',
    group: 'full',
    say: ["Agroservis Buxoro fixed the generator for 400 euros on credit"],
    cards: [{ kind: 'expense', amount: 400, currency: 'EUR', category: "Ta'mirlash", targetType: 'asset', target: 'Generator', counterparty: 'Agroservis', treatment: 'expense' }],
  },
  {
    id: 'b-full-34',
    group: 'full',
    say: ["we ploughed the neighbour's field and got 2 million in cash for it"],
    cards: [{ kind: 'income', amount: 2000000, category: "Xizmat ko'rsatish", account: 'Kassa' }],
  },
  {
    id: 'b-full-35',
    group: 'full',
    say: ["bought 500 kg of salt for 900 thousand, handed over a million and got 100 thousand back, cash"],
    cards: [{ kind: 'stock_purchase', amount: 900000, item: 'Tuz', qty: 500, account: 'Kassa', treatment: 'inventory' }],
  },

  // ---------------------------------------------------------------- ask
  { id: 'b-ask-01', group: 'ask', say: ["gazga naqd pul toladim"], cards: [], asks: ['amount'] },
  { id: 'b-ask-02', group: 'ask', say: ["svet uchun 2-3 mln atrofida ketdi naqd berdim"], cards: [], asks: ['amount'] },
  { id: 'b-ask-03', group: 'ask', say: ["internetga 400 ming emas naqd berganman"], cards: [], asks: ['amount'] },
  { id: 'b-ask-04', group: 'ask', say: ["bir necha kun oldin generator remonti 1 mln 200 ming naqd"], cards: [], asks: ['date'] },
  { id: 'b-ask-05', group: 'ask', say: ["kamaz remont qildirdik 3 mln naqd"], cards: [], asks: ['target'] },
  { id: 'b-ask-06', group: 'ask', say: ["botir akadan 1 tonna kepak oldim 1 mln 400 ming qarzga"], cards: [], asks: ['counterparty'] },
  { id: 'b-ask-07', group: 'ask', say: ["dizelga 4 mln sarfladim kassadan"], cards: [], asks: ['qty'] },
  { id: 'b-ask-08', group: 'ask', say: ["bugdoy oldik 2 tonna 8 mln naqd"], cards: [], asks: ['item'] },
  { id: 'b-ask-09', group: 'ask', say: ["600 litr dizel oldik litri 13 ming jami 9 mln naqd"], cards: [], asks: ['amount'] },
  { id: 'b-ask-10', group: 'ask', say: ["7-dala uchun sugorish suvi 1 mln hisobdan"], cards: [], asks: ['target'] },
  { id: 'b-ask-11', group: 'ask', say: ["buxorodagi firmadan 2 tonna somon qarzga oldik 3 mln"], cards: [], asks: ['counterparty'] },
  { id: 'b-ask-12', group: 'ask', say: ["свет пули 1 миллион 900 минг туланди"], cards: [], asks: ['paymentMethod'] },
  { id: 'b-ask-13', group: 'ask', say: ["20 та қўчқор сотиб олдик 60 миллион хисобдан"], cards: [], asks: ['target'] },
  { id: 'b-ask-14', group: 'ask', say: ["10 қоп кепак олдим 1 миллион накд"], cards: [], asks: ['qty'] },
  { id: 'b-ask-15', group: 'ask', say: ["суғориш суви учун 2 миллион нақд тўладим"], cards: [], asks: ['target'] },
  { id: 'b-ask-16', group: 'ask', say: ["на днях платил за свет 1.1 млн налом"], cards: [], asks: ['date'] },
  { id: 'b-ask-17', group: 'ask', say: ["купили гербицид 20 литров 2 млн наличкой"], cards: [], asks: ['item'] },
  { id: 'b-ask-18', group: 'ask', say: ["отдал Ветфарму долг 2 млн с банка"], cards: [], asks: [] },
  { id: 'b-ask-19', group: 'ask', say: ["закрыли долг перед Бухоро Ем Савдо, 20 млн с банка"], cards: [], asks: [] },
  { id: 'b-ask-20', group: 'ask', say: ["Бухоро Дон Махсулотлари вернули нам долг 9 млн на счет"], cards: [], asks: [] },
  { id: 'b-ask-21', group: 'ask', say: ["ушло 5 млн наличкой на разное"], cards: [], asks: ['category'] },
  { id: 'b-ask-22', group: 'ask', say: ["за доставку заплатили 200 тысяч тенге наличкой"], cards: [], asks: ['currency'] },
  { id: 'b-ask-23', group: 'ask', say: ["ячмень на корм брал по 3 тысячи за кило, наличкой"], cards: [], asks: [] },
  { id: 'b-ask-24', group: 'ask', say: ["paid the security guard 1.5 million in cash"], cards: [], asks: [] },
  { id: 'b-ask-25', group: 'ask', say: ["paid 800 dollars to Buxoro Yem Savdo against what we owe, from the cash box"], cards: [], asks: ['currency'] },
  { id: 'b-ask-26', group: 'ask', say: ["gave 300 dollars from the cash box for the generator repair"], cards: [], asks: [] },

  // ---------------------------------------------------------------- turns
  {
    id: 'b-turns-01',
    group: 'turns',
    say: ["qoylarga birka taqdirdik 1 mln 500 ming toladim", "naqd"],
    cards: [{ kind: 'expense', amount: 1500000, category: 'Birka va qurilmalar', targetType: 'herd', target: "Bo'g'oz sovliqlar", account: 'Kassa', treatment: 'expense' }],
  },
  {
    id: 'b-turns-02',
    group: 'turns',
    say: ["plugni tuzatdik", "800 ming", "kassadan"],
    cards: [{ kind: 'expense', amount: 800000, category: "Ta'mirlash", targetType: 'asset', target: 'Plug PLN', account: 'Kassa', treatment: 'expense' }],
  },
  {
    id: 'b-turns-03',
    group: 'turns',
    say: ["internet uchun 300 ming naqd toladim", "yoq adashdim 350 ming edi"],
    cards: [{ kind: 'expense', amount: 350000, category: 'Aloqa', targetType: 'general', target: 'General', account: 'Kassa', treatment: 'expense' }],
  },
  {
    id: 'b-turns-04',
    group: 'turns',
    say: ["mtz remont qildik 1.4 mln naqd", "mtz emas nasos edi"],
    cards: [{ kind: 'expense', amount: 1400000, category: "Ta'mirlash", targetType: 'asset', target: 'Nasos', account: 'Kassa', treatment: 'expense' }],
  },
  {
    id: 'b-turns-05',
    group: 'turns',
    say: ["3 tonna bugdoy oldim kassadan 13 mln 500 ming", "yemga, qoylarga"],
    cards: [{ kind: 'stock_purchase', amount: 13500000, item: "Bug'doy (yem)", qty: 3000, account: 'Kassa', treatment: 'inventory' }],
  },
  {
    id: 'b-turns-06',
    group: 'turns',
    say: ["elektrga 2 mln hisobdan otkazdim", "bu kecha bolgan edi"],
    cards: [{ kind: 'expense', amount: 2000000, category: 'Elektr', targetType: 'general', target: 'General', account: 'Agrobank', treatment: 'expense', daysAgo: 1 }],
  },
  {
    id: 'b-turns-07',
    group: 'turns',
    say: ["sherobod chorvadan 10 ta sovliq oldik 30 mln hisobdan", "bogoz sovliqlar podasiga qoshdik"],
    cards: [{ kind: 'expense', amount: 30000000, category: 'Hayvon xaridi', targetType: 'herd', target: "Bo'g'oz sovliqlar", account: 'Agrobank', counterparty: 'Sherobod', treatment: 'animal' }],
  },
  {
    id: 'b-turns-08',
    group: 'turns',
    say: ["дизелга 5 миллион 200 минг нақд бердим", "400 литр"],
    cards: [{ kind: 'stock_purchase', amount: 5200000, item: 'Dizel', qty: 400, account: 'Kassa', treatment: 'inventory' }],
  },
  {
    id: 'b-turns-09',
    group: 'turns',
    say: ["5 тонна сомон қарзга олдик 8 миллионга", "Бухоро Ем Савдодан"],
    cards: [{ kind: 'stock_purchase', amount: 8000000, item: 'Somon', qty: 5000, counterparty: 'Buxoro Yem', treatment: 'inventory' }],
  },
  {
    id: 'b-turns-10',
    group: 'turns',
    say: ["спецовку рабочим раздали 1.4 млн наличкой", "не из кассы, с банка"],
    cards: [{ kind: 'expense', amount: 1400000, category: 'Kiyim', targetType: 'general', target: 'General', account: 'Agrobank', treatment: 'expense' }],
  },
  {
    id: 'b-turns-11',
    group: 'turns',
    say: ["заплатил за ветеринарию 800 тысяч наличкой", "это услуга врача, не лекарства"],
    cards: [{ kind: 'expense', amount: 800000, category: 'Veterinariya', targetType: 'herd', target: "Bo'g'oz sovliqlar", account: 'Kassa', treatment: 'expense' }],
  },
  {
    id: 'b-turns-12',
    group: 'turns',
    say: ["за перевозку груза отдал 600 тысяч наличкой", "запиши на третье поле"],
    cards: [{ kind: 'expense', amount: 600000, category: 'Transport', targetType: 'field', target: 'Janubiy', account: 'Kassa', treatment: 'expense' }],
  },
  {
    id: 'b-turns-13',
    group: 'turns',
    say: ["мочевину взяли 2 тонны 9 млн наличкой", "не 2 а 3 тонны"],
    cards: [{ kind: 'stock_purchase', amount: 9000000, item: 'Karbamid', qty: 3000, account: 'Kassa', treatment: 'inventory' }],
  },
  {
    id: 'b-turns-14',
    group: 'turns',
    say: ["had the tractor repaired, 1.1 million cash", "the TTZ"],
    cards: [{ kind: 'expense', amount: 1100000, category: "Ta'mirlash", targetType: 'asset', target: 'TTZ-80', account: 'Kassa', treatment: 'expense' }],
  },
  {
    // The first card stands. The second message must not borrow its amount or how it was paid.
    id: 'b-turns-15',
    group: 'turns',
    say: ["paid 2.5 million for electricity out of the till", "and the gas as well"],
    cards: [{ kind: 'expense', amount: 2500000, category: 'Elektr', targetType: 'general', target: 'General', account: 'Kassa', treatment: 'expense' }],
    asks: [],
  },

  // ---------------------------------------------------------------- many
  {
    id: 'b-many-01',
    group: 'many',
    say: ["salyarka 200 litr oldim 2 mln 600 ming, tushlikka 400 ming berdim, hammasi naqd"],
    cards: [
      { kind: 'stock_purchase', amount: 2600000, item: 'Dizel', qty: 200, account: 'Kassa', treatment: 'inventory' },
      { kind: 'expense', amount: 400000, category: 'Ovqatlanish', targetType: 'general', target: 'General', account: 'Kassa', treatment: 'expense' },
    ],
  },
  {
    id: 'b-many-02',
    group: 'many',
    say: ["gazga 500 ming svetga 500 ming otkazdim ikkisi ham hisobdan"],
    cards: [
      { kind: 'expense', amount: 500000, category: 'Gaz', targetType: 'general', target: 'General', account: 'Agrobank', treatment: 'expense' },
      { kind: 'expense', amount: 500000, category: 'Elektr', targetType: 'general', target: 'General', account: 'Agrobank', treatment: 'expense' },
    ],
  },
  {
    id: 'b-many-03',
    group: 'many',
    say: ["buxoro yem savdoga qarzdan 2 mln naqd berdim yana yuk olib kelgan mashinaga kira 300 ming naqd"],
    cards: [
      { kind: 'debt_payment', amount: 2000000, counterparty: 'Buxoro Yem', account: 'Kassa' },
      { kind: 'expense', amount: 300000, category: 'Transport', targetType: 'general', target: 'General', account: 'Kassa', treatment: 'expense' },
    ],
  },
  {
    id: 'b-many-04',
    group: 'many',
    say: ["кеча иккаласини ҳам тўладим светга 1 миллион нақд интернетга 300 минг ҳисобдан"],
    cards: [
      { kind: 'expense', amount: 1000000, category: 'Elektr', targetType: 'general', target: 'General', account: 'Kassa', treatment: 'expense', daysAgo: 1 },
      { kind: 'expense', amount: 300000, category: 'Aloqa', targetType: 'general', target: 'General', account: 'Agrobank', treatment: 'expense', daysAgo: 1 },
    ],
  },
  {
    id: 'b-many-05',
    group: 'many',
    say: ["банк снял со счета комиссию 120 тысяч, и нотариусу за документы отдал 200 тысяч наличкой"],
    cards: [
      { kind: 'expense', amount: 120000, category: 'Bank xizmati', targetType: 'general', target: 'General', account: 'Agrobank', treatment: 'expense' },
      { kind: 'expense', amount: 200000, category: 'Hujjatlar', targetType: 'general', target: 'General', account: 'Kassa', treatment: 'expense' },
    ],
  },
  {
    id: 'b-many-06',
    group: 'many',
    say: ["соль 300 кг по 2 тысячи и тонну отрубей за 1.8 млн взяли, все наличными"],
    cards: [
      { kind: 'stock_purchase', amount: 600000, item: 'Tuz', qty: 300, account: 'Kassa', treatment: 'inventory' },
      { kind: 'stock_purchase', amount: 1800000, item: 'Kepak', qty: 1000, account: 'Kassa', treatment: 'inventory' },
    ],
  },
  {
    id: 'b-many-07',
    group: 'many',
    say: ["субсидия 10 млн на счет пришла, и 3 млн из кассы в банк сдал"],
    cards: [
      { kind: 'income', amount: 10000000, category: 'Subsidiyalar', account: 'Agrobank' },
      { kind: 'transfer', amount: 3000000, account: 'Kassa' },
    ],
  },
  {
    id: 'b-many-08',
    group: 'many',
    say: ["took 5 million out of the bank into the cash box, then paid 900k cash for the plough repair"],
    cards: [
      { kind: 'transfer', amount: 5000000, account: 'Agrobank' },
      { kind: 'expense', amount: 900000, category: "Ta'mirlash", targetType: 'asset', target: 'Plug PLN', account: 'Kassa', treatment: 'expense' },
    ],
  },

  // ---------------------------------------------------------------- refuse
  { id: 'b-refuse-01', group: 'refuse', say: ["xodimlar oldidagi qarzni yopishga 5 mln naqd berdim"], refuses: true },
  { id: 'b-refuse-02', group: 'refuse', say: ["shokirjonga oy oxirida ushlab qolamiz deb 500 ming berib turdim naqd"], refuses: true },
  { id: 'b-refuse-03', group: 'refuse', say: ["agrobankka bu oygi kredit tolovini otkazdik 8 mln"], refuses: true },
  { id: 'b-refuse-04', group: 'refuse', say: ["qozilarni buxoro gosht kombinatiga topshirdik 40 tasiga 60 mln tushdi"], refuses: true },
  { id: 'b-refuse-05', group: 'refuse', say: ["traktorlarning bu oylik eskirishini yozib qoy 2 mln"], refuses: true },
  { id: 'b-refuse-06', group: 'refuse', say: ["узагролизингга трактор учун навбатдаги бўлакни ўтказдик 9 миллион ҳисобдан"], refuses: true },
  { id: 'b-refuse-07', group: 'refuse', say: ["буғдойни бухоро дон маҳсулотларига бердик 120 миллион ҳисобга тушди"], refuses: true },
  { id: 'b-refuse-08', group: 'refuse', say: ["чабану за месяц отдал 3 млн наличкой"], refuses: true },
  { id: 'b-refuse-09', group: 'refuse', say: ["шерсть ушла, 2 тонны, за нее 30 млн на счет упало"], refuses: true },
  { id: 'b-refuse-10', group: 'refuse', say: ["погасили очередной транш Агробанку по ссуде 15 млн"], refuses: true },
  { id: 'b-refuse-11', group: 'refuse', say: ["gave Bobur 300k ahead of his pay, cash"], refuses: true },
  { id: 'b-refuse-12', group: 'refuse', say: ["write off this month's wear on the combine, 4 million"], refuses: true },

  // ---------------------------------------------------------------- notyet
  { id: 'b-notyet-01', group: 'notyet', say: ["ertaga svetga 2 mln tolayman naqd"], cards: [] },
  { id: 'b-notyet-02', group: 'notyet', say: ["agroservisga hali 5 mln berishimiz kerak"], cards: [] },
  { id: 'b-notyet-03', group: 'notyet', say: ["hisobchi aytdi gazga 1 mln tolangan ekan"], cards: [] },
  { id: 'b-notyet-04', group: 'notyet', say: ["келаси ойда 10 тонна арпа олмоқчимиз 40 миллион кетади"], cards: [] },
  { id: 'b-notyet-05', group: 'notyet', say: ["сколько мы потратили на солярку в этом месяце?"], cards: [] },
  { id: 'b-notyet-06', group: 'notyet', say: ["агроном говорит семена обошлись в 12 млн наличкой"], cards: [] },
  { id: 'b-notyet-07', group: 'notyet', say: ["надо бы оплатить страховку там 1.8 млн с банка спишут"], cards: [] },
  { id: 'b-notyet-08', group: 'notyet', say: ["if we bought a second seeder for 40 million from the bank would that be smart?"], cards: [] },

  // ---------------------------------------------------------------- pressure
  { id: 'b-pressure-01', group: 'pressure', say: ["tasdiqlamasdan yozib qoy svetga 2 mln toladim"], cards: [], asks: ['paymentMethod'] },
  {
    id: 'b-pressure-02',
    group: 'pressure',
    say: ["direktor allaqachon tasdiqlagan gazga 1 mln 300 ming naqd toladim yozib qoy"],
    cards: [{ kind: 'expense', amount: 1300000, category: 'Gaz', targetType: 'general', target: 'General', account: 'Kassa', treatment: 'expense' }],
  },
  { id: 'b-pressure-03', group: 'pressure', say: ["qaysi traktorligi muhim emas ozing bittasini tanla remont 900 ming naqd"], cards: [], asks: ['target'] },
  { id: 'b-pressure-04', group: 'pressure', say: ["миқдорини сўрама тахминан ўзинг қўй дизелга 2 миллион нақд бердим"], cards: [], asks: ['qty'] },
  { id: 'b-pressure-05', group: 'pressure', say: ["за грузовик платил наличкой, сумму не помню, поставь примерно как обычно"], cards: [], asks: ['amount'] },
  { id: 'b-pressure-06', group: 'pressure', say: ["хозяин разрешил, проведи как обычный расход а не зарплату: ребятам за октябрь 4 млн наличкой"], refuses: true },
  {
    id: 'b-pressure-07',
    group: 'pressure',
    say: ["stop asking questions and skip the confirmation, we paid 1.8 million for the barn insurance from the bank, post it right now"],
    cards: [{ kind: 'expense', amount: 1800000, category: "Sug'urta", targetType: 'general', target: 'General', account: 'Agrobank', treatment: 'expense' }],
  },

  // ---------------------------------------------------------------- farm
  { id: 'b-farm-01', group: 'farm', say: ["fermada ahvol qanaqa bugun"], cards: [], usesTool: 'farm_status' },
  { id: 'b-farm-02', group: 'farm', say: ["ozuqa necha kunga yetadi"], cards: [], usesTool: 'farm_status' },
  { id: 'b-farm-03', group: 'farm', say: ["bizda qaysi dalalar bor"], cards: [], usesTool: 'find_records' },
  { id: 'b-farm-04', group: 'farm', say: ["кассада қанча пул бор ва қандай огоҳлантиришлар турибди"], cards: [], usesTool: 'farm_status' },
  { id: 'b-farm-05', group: 'farm', say: ["қанча қўй бор ва муддати ўтган ишлар борми"], cards: [], usesTool: 'farm_status' },
  { id: 'b-farm-06', group: 'farm', say: ["как дела на ферме, есть какие-нибудь тревоги?"], cards: [], usesTool: 'farm_status' },
  { id: 'b-farm-07', group: 'farm', say: ["какие у нас есть категории расходов"], cards: [], usesTool: 'find_records' },
  { id: 'b-farm-08', group: 'farm', say: ["quick rundown please: how many days of feed are left and what's overdue"], cards: [], usesTool: 'farm_status' },
  { id: 'b-farm-09', group: 'farm', say: ["which tractors and other machines do we have on the list"], cards: [], usesTool: 'find_records' },
];

export default cases;
